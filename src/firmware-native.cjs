'use strict';

const { spawn } = require('node:child_process');
const firmware = require('./firmware-protocol.cjs');

const MAC_COMMANDS = Object.freeze({
  ioreg: '/usr/sbin/ioreg',
  plutil: '/usr/bin/plutil'
});

const DEFAULT_NATIVE_TIMEOUTS = Object.freeze({
  commandMs: 3500,
  enumerateMs: 3500,
  openMs: 3500,
  writeMs: 5000,
  identityMs: 10000,
  pollMs: 100
});

class NativeFirmwareError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'NativeFirmwareError';
    Object.assign(this, details);
  }
}

function mergeTimeouts(overrides = {}) {
  const result = { ...DEFAULT_NATIVE_TIMEOUTS };
  for (const key of Object.keys(DEFAULT_NATIVE_TIMEOUTS)) {
    if (Number.isFinite(overrides[key]) && overrides[key] >= 0) result[key] = overrides[key];
  }
  return result;
}

function realClock() {
  return {
    now: () => Date.now(),
    setTimeout: (handler, delay) => setTimeout(handler, delay),
    clearTimeout: timer => clearTimeout(timer)
  };
}

function normalizeText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function firstPresent(record, names) {
  if (!record || typeof record !== 'object') return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name)) return record[name];
  }
  return undefined;
}

function parseDescriptorNumber(value) {
  const parsed = firmware.parseTopologyNumber(value);
  return parsed !== null && parsed <= 0xFFFF ? parsed : null;
}

function parseRegistryInteger(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^[0-9]+$/.test(text) && !/^0x[0-9a-f]+$/i.test(text)) return null;
  let parsed;
  try {
    parsed = BigInt(text);
  } catch {
    return null;
  }
  return parsed >= 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
}

function parseDevSrvsId(path) {
  if (typeof path !== 'string') return null;
  const match = path.match(/(?:^|[/:])DevSrvsID:([^/:]+)/);
  return match ? parseRegistryInteger(match[1]) : null;
}

function registryEntriesFromJson(root) {
  const entries = [];
  const visited = new Set();

  function visit(value) {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const registryEntryId = parseRegistryInteger(firstPresent(value, [
      'IORegistryEntryID', 'registryEntryId', 'registryEntryID'
    ]));
    const locationId = firmware.parseTopologyNumber(firstPresent(value, [
      'LocationID', 'locationID', 'locationId', 'usbLocation', 'usbLocationId'
    ]));
    const vendorId = parseDescriptorNumber(firstPresent(value, [
      'VendorID', 'idVendor', 'vendorId', 'USB Vendor ID'
    ]));
    const productId = parseDescriptorNumber(firstPresent(value, [
      'ProductID', 'idProduct', 'productId', 'USB Product ID'
    ]));
    const usagePage = parseDescriptorNumber(firstPresent(value, [
      'PrimaryUsagePage', 'UsagePage', 'usagePage'
    ]));
    const usage = parseDescriptorNumber(firstPresent(value, [
      'PrimaryUsage', 'Usage', 'usage'
    ]));
    const interfaceNumber = Number.isInteger(firstPresent(value, ['InterfaceNumber', 'interface']))
      ? firstPresent(value, ['InterfaceNumber', 'interface'])
      : null;

    if (registryEntryId !== null || locationId !== null || vendorId !== null || productId !== null) {
      entries.push({
        registryEntryId,
        locationId,
        vendorId,
        productId,
        usagePage,
        usage,
        interface: interfaceNumber,
        serialNumber: normalizeText(firstPresent(value, [
          'USB Serial Number', 'USB Serial Number String', 'kUSBSerialNumberString',
          'SerialNumber', 'serialNumber', 'serial'
        ])),
        raw: value
      });
    }

    for (const child of Object.values(value)) visit(child);
  }

  visit(root);
  return entries;
}

function parseIoregJson(root) {
  return registryEntriesFromJson(root);
}

function registryDescriptorMatches(device, registry) {
  if (!registry || registry.vendorId === null || registry.productId === null
    || registry.usagePage === null || registry.usage === null) return false;
  if (registry.vendorId !== device.vendorId || registry.productId !== device.productId) return false;
  if (registry.usagePage !== device.usagePage) return false;
  const deviceUsage = device.usage === undefined || device.usage === null ? firmware.NORMAL_USAGE : device.usage;
  if (registry.usage !== deviceUsage) return false;
  if (registry.interface !== null && registry.interface !== device.interface) return false;
  return true;
}

function normalizeHidDevice(device) {
  if (!device || typeof device !== 'object' || typeof device.path !== 'string' || !device.path) return null;
  const vendorId = parseDescriptorNumber(device.vendorId);
  const productId = parseDescriptorNumber(device.productId);
  const interfaceNumber = Number.isInteger(device.interface) ? device.interface : null;
  const usagePage = parseDescriptorNumber(device.usagePage);
  const usage = device.usage === undefined || device.usage === null
    ? undefined
    : parseDescriptorNumber(device.usage);
  if (vendorId === null || productId === null || interfaceNumber === null || usagePage === null) return null;
  if (device.usage !== undefined && device.usage !== null && usage === null) return null;
  return {
    ...device,
    vendorId,
    productId,
    interface: interfaceNumber,
    usagePage,
    usage,
    serialNumber: normalizeText(device.serialNumber || device.serial)
  };
}

function topologyCandidateForDevice(device, registryEntries, target, mode, catalog) {
  const normalized = normalizeHidDevice(device);
  if (!normalized) return null;
  const registryId = parseDevSrvsId(normalized.path);
  if (registryId === null) return null;
  const registryMatches = registryEntries.filter(entry => entry.registryEntryId === registryId);
  if (registryMatches.length !== 1) return null;
  const registry = registryMatches[0];
  if (registry.locationId === null || !registryDescriptorMatches(normalized, registry)) return null;

  if (normalized.serialNumber && registry.serialNumber && normalized.serialNumber !== registry.serialNumber) {
    return null;
  }
  const identity = {
    ...normalized,
    serialNumber: normalized.serialNumber || registry.serialNumber || null,
    locationId: registry.locationId,
    registryEntryId: registry.registryEntryId,
    registryPath: normalized.path
  };
  const exact = mode === 'normal'
    ? firmware.matchesNormalIdentity(identity, target, catalog)
    : firmware.matchesBootIdentity(identity, target, catalog);
  if (!exact || !firmware.hasStableUsbLocation(identity)) return null;
  return { path: normalized.path, identity, registry };
}

function resolveTopologyCandidates({ hidDevices, registry, target, catalog = firmware.OFFICIAL_CATALOG, mode }) {
  const canonicalTarget = firmware.resolveTarget(target, catalog);
  if (!canonicalTarget || !Array.isArray(hidDevices) || !Array.isArray(registry)) return [];
  if (mode !== 'normal' && mode !== 'boot') return [];
  const candidates = [];
  for (const device of hidDevices) {
    const candidate = topologyCandidateForDevice(device, registry, canonicalTarget, mode, catalog);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function resolveUniqueTopologyCandidate(options) {
  const candidates = resolveTopologyCandidates(options);
  if (candidates.length !== 1) {
    return {
      valid: false,
      reason: candidates.length === 0 ? 'no-candidate' : 'ambiguous-identity',
      candidateCount: candidates.length,
      candidates
    };
  }
  return { valid: true, candidate: candidates[0], candidates };
}

function liveHandleDescriptor(device) {
  if (!device || typeof device !== 'object') return null;
  const path = device.path == null ? null : String(device.path);
  if (!path) return null;
  return {
    vendorId: device.vendorId,
    productId: device.productId,
    interface: device.interface,
    usagePage: device.usagePage,
    usage: device.usage,
    serialNumber: device.serialNumber == null ? device.serial : device.serialNumber,
    path
  };
}

/**
 * Bind a node-hid control handle (VID/PID/interface/usagePage/path/serial,
 * no LocationID) to the unique IORegistry LocationID for that same path.
 * Product names are ignored. Ambiguous or missing topology fails closed.
 */
async function correlateLiveHandleTopology(device, options = {}) {
  const catalog = options.catalog || firmware.OFFICIAL_CATALOG;
  const handle = liveHandleDescriptor(device);
  if (!handle) {
    return { valid: false, reason: 'no-candidate', error: 'Live HID handle has no path to correlate' };
  }
  const identified = firmware.identifyNormalTarget(handle, catalog);
  if (!identified.valid) {
    return { valid: false, reason: 'unsupported-target', error: identified.error };
  }
  let registry;
  try {
    registry = Array.isArray(options.registry) ? options.registry : await readMacTopology(options);
  } catch (error) {
    return {
      valid: false,
      reason: 'topology-error',
      error: error && error.message ? error.message : 'macOS USB topology could not be read'
    };
  }
  const resolved = resolveUniqueTopologyCandidate({
    hidDevices: [handle],
    registry,
    target: identified.target,
    catalog,
    mode: 'normal'
  });
  if (!resolved.valid) {
    return {
      valid: false,
      reason: resolved.reason,
      candidateCount: resolved.candidateCount,
      error: resolved.reason === 'ambiguous-identity'
        ? 'Live HID path matches more than one USB LocationID'
        : 'Live HID path has no unique USB LocationID topology evidence'
    };
  }
  return {
    valid: true,
    identity: resolved.candidate.identity,
    target: identified.target
  };
}

function applyCorrelatedTopology(transport, identity) {
  if (!transport || !identity || typeof identity !== 'object') return;
  transport.firmwareTopologyIdentity = { ...identity };
  if (transport.deviceInfo && typeof transport.deviceInfo === 'object') {
    transport.deviceInfo = {
      ...transport.deviceInfo,
      locationId: identity.locationId,
      registryEntryId: identity.registryEntryId,
      registryPath: identity.registryPath || identity.path,
      usagePage: transport.deviceInfo.usagePage ?? identity.usagePage,
      usage: transport.deviceInfo.usage ?? identity.usage
    };
  }
  if (transport.lastState && transport.lastState.device && typeof transport.lastState.device === 'object') {
    transport.lastState.device = {
      ...transport.lastState.device,
      locationId: identity.locationId,
      registryEntryId: identity.registryEntryId,
      registryPath: identity.registryPath || identity.path,
      usagePage: transport.lastState.device.usagePage ?? identity.usagePage,
      usage: transport.lastState.device.usage ?? identity.usage
    };
  }
}

async function attachLiveHandleTopology(transport, options = {}) {
  const live = (transport && transport.deviceInfo)
    || (transport && transport.lastState && transport.lastState.device)
    || options.device
    || null;
  const result = await correlateLiveHandleTopology(live, options);
  if (result.valid) applyCorrelatedTopology(transport, result.identity);
  return result;
}

function candidateMatchesAnchor(candidate, anchor) {
  return Boolean(candidate && firmware.sameDeviceIdentity(anchor, candidate.identity));
}

function appendOutput(chunks, currentLength, chunk, maxOutputBytes) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const nextLength = currentLength + buffer.length;
  if (nextLength > maxOutputBytes) {
    throw new NativeFirmwareError('macOS topology command output exceeded its bounded limit', {
      reason: 'output-limit'
    });
  }
  chunks.push(buffer);
  return nextLength;
}

/**
 * Shell-free bounded child-process execution used for ioreg/plutil. The
 * updater never invokes a shell and never accepts a command or URL from a
 * package. `input` is piped to plutil's stdin.
 */
function runSystemCommand(file, args, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const clock = options.clock || realClock();
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0
    ? options.timeoutMs : DEFAULT_NATIVE_TIMEOUTS.commandMs;
  const maxOutputBytes = Number.isInteger(options.maxOutputBytes) && options.maxOutputBytes > 0
    ? options.maxOutputBytes : 2 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(file, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }

    const stdout = [];
    const stderr = [];
    let outputLength = 0;
    let settled = false;
    let timer = null;

    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      if (timer) clock.clearTimeout(timer);
      if (error) reject(error);
      else resolve(output);
    };

    const stopFor = error => {
      try { child.kill('SIGKILL'); } catch {}
      finish(error);
    };

    const collect = (chunks, chunk) => {
      if (settled) return;
      try {
        outputLength = appendOutput(chunks, outputLength, chunk, maxOutputBytes);
      } catch (error) {
        stopFor(error);
      }
    };

    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', chunk => collect(stdout, chunk));
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', chunk => collect(stderr, chunk));
    if (typeof child.once === 'function') {
      child.once('error', error => finish(error));
      child.once('close', (code, signal) => {
        if (settled) return;
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString('utf8').trim();
          finish(new NativeFirmwareError(
            detail || `macOS topology command failed: ${file}`,
            { reason: 'command-error', code, signal }
          ));
          return;
        }
        finish(null, Buffer.concat(stdout).toString('utf8'));
      });
    }

    timer = clock.setTimeout(() => stopFor(new NativeFirmwareError(
      `Timed out running macOS topology command: ${file}`,
      { reason: 'timeout' }
    )), timeoutMs);

    if (child.stdin && typeof child.stdin.end === 'function') child.stdin.end(options.input || '');
  });
}

async function readMacTopology(options = {}) {
  const processRunner = options.processRunner || runSystemCommand;
  const commandOptions = {
    timeoutMs: options.timeoutMs ?? DEFAULT_NATIVE_TIMEOUTS.commandMs,
    maxOutputBytes: options.maxOutputBytes,
    clock: options.clock,
    spawnImpl: options.spawnImpl
  };
  const plist = await processRunner(
    MAC_COMMANDS.ioreg,
    ['-a', '-r', '-c', 'IOHIDDevice'],
    commandOptions
  );
  const jsonText = await processRunner(
    MAC_COMMANDS.plutil,
    ['-convert', 'json', '-o', '-', '--', '-'],
    { ...commandOptions, input: plist }
  );
  let parsed;
  try {
    parsed = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
  } catch (error) {
    throw new NativeFirmwareError('plutil returned invalid topology JSON', {
      reason: 'topology-parse-error',
      cause: error
    });
  }
  return parseIoregJson(parsed);
}

function removeEventListener(target, event, handler) {
  if (!target) return;
  if (typeof target.off === 'function') target.off(event, handler);
  else if (typeof target.removeListener === 'function') target.removeListener(event, handler);
}

function closeHandle(handle) {
  if (!handle || typeof handle.close !== 'function') return Promise.resolve();
  try {
    return Promise.resolve(handle.close()).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/**
 * Native macOS IO adapter for FirmwareTransferCoordinator.
 *
 * Caller contract: obtain a fresh reviewed normal identity, suspend and drain
 * the existing configuration transport before calling openNormal(), and do
 * not use that transport while this adapter owns its handle. This class does
 * not discover or open anything in its constructor, does not take ownership
 * of global configuration handles, and only closes HIDAsync handles opened by
 * this instance. The caller must call cancel()/close() when abandoning a
 * coordinator identity wait.
 */
class NativeFirmwareIo {
  constructor(options = {}) {
    this.hid = options.hid || null;
    this.processRunner = options.processRunner || null;
    this.clock = options.clock || realClock();
    this.platform = options.platform || process.platform;
    this.catalog = options.catalog || firmware.OFFICIAL_CATALOG;
    this.targetRef = options.target || null;
    this.timeouts = mergeTimeouts(options.timeouts);
    this.nonExclusive = options.nonExclusive !== undefined ? Boolean(options.nonExclusive) : true;
    this.maxTopologyOutputBytes = options.maxTopologyOutputBytes || 2 * 1024 * 1024;
    this._closed = false;
    this._cancelled = false;
    this._cancelReason = null;
    this._operationGeneration = 0;
    this._cancellationWaiters = new Set();
    this._handle = null;
    this._handleIdentity = null;
    this._handleGeneration = 0;
    this._handleDataHandler = null;
    this._handleErrorHandler = null;
    this._dataBound = false;
    this._dataListeners = new Set();
    this._disconnectListeners = new Set();
  }

  _hidModule() {
    if (!this.hid) this.hid = require('node-hid');
    return this.hid;
  }

  _assertUsable() {
    if (this._closed) throw new NativeFirmwareError('Native firmware IO adapter is closed', { reason: 'closed' });
    if (this._cancelled) {
      throw new NativeFirmwareError(this._cancelReason || 'Native firmware IO adapter was cancelled', {
        reason: 'cancelled'
      });
    }
    if (this.platform !== 'darwin') {
      throw new NativeFirmwareError('Native firmware IO adapter requires macOS', { reason: 'unsupported-platform' });
    }
  }

  _invalidationPromise() {
    let rejecter;
    const promise = new Promise((_, reject) => {
      rejecter = reject;
      if (this._closed || this._cancelled) {
        reject(this._invalidationError());
      } else {
        this._cancellationWaiters.add(reject);
      }
    });
    return {
      promise,
      dispose: () => this._cancellationWaiters.delete(rejecter)
    };
  }

  _invalidationError() {
    return new NativeFirmwareError(
      this._cancelReason || (this._closed ? 'Native firmware IO adapter is closed' : 'Native firmware IO adapter was cancelled'),
      { reason: this._closed ? 'closed' : 'cancelled' }
    );
  }

  _invalidatePending(error) {
    for (const reject of this._cancellationWaiters) reject(error);
    this._cancellationWaiters.clear();
  }

  _now() {
    return typeof this.clock.now === 'function' ? this.clock.now() : Date.now();
  }

  _timeoutError(label) {
    return new NativeFirmwareError(`Timed out waiting for ${label}`, { reason: 'timeout' });
  }

  _timeoutFor(label, configuredMs, deadline) {
    const timeoutMs = Number.isFinite(configuredMs) && configuredMs >= 0 ? configuredMs : 0;
    if (deadline === undefined) return timeoutMs;
    const remaining = deadline - this._now();
    if (remaining <= 0) throw this._timeoutError(label);
    return Math.min(timeoutMs, remaining);
  }

  _invalidateOperation(generation) {
    if (this._operationGeneration === generation) this._operationGeneration += 1;
  }

  _operationIsCurrent(generation) {
    return generation === this._operationGeneration && !this._closed && !this._cancelled;
  }

  async _boundedCall(label, operation, timeoutMs, options = {}) {
    this._assertUsable();
    const generation = options.generation === undefined
      ? this._operationGeneration : options.generation;
    const deadline = options.deadline;
    const invalidation = this._invalidationPromise();
    const timeoutMarker = {};
    let timeoutId = null;
    const operationPromise = Promise.resolve().then(() => {
      // The initial _assertUsable() runs before the microtask. Recheck at the
      // actual invocation boundary so immediate cancel()/close() cannot still
      // enumerate, open, or write. A generation check also rejects stale work
      // from a timed-out or superseded native attempt.
      if (!this._operationIsCurrent(generation)) throw this._invalidationError();
      if (deadline !== undefined && this._now() >= deadline) throw this._timeoutError(label);
      this._assertUsable();
      return operation();
    });
    const timeoutPromise = new Promise(resolve => {
      timeoutId = this.clock.setTimeout(() => resolve(timeoutMarker), timeoutMs);
    });
    try {
      const result = await Promise.race([operationPromise, timeoutPromise, invalidation.promise]);
      if (result === timeoutMarker) {
        throw this._timeoutError(label);
      }
      return result;
    } finally {
      if (timeoutId) this.clock.clearTimeout(timeoutId);
      invalidation.dispose();
    }
  }

  _delay(delayMs) {
    const invalidation = this._invalidationPromise();
    let timerId = null;
    return new Promise((resolve, reject) => {
      timerId = this.clock.setTimeout(() => resolve(), delayMs);
      invalidation.promise.catch(reject);
    }).finally(() => {
      if (timerId) this.clock.clearTimeout(timerId);
      invalidation.dispose();
    });
  }

  _handleIsCurrent(handle, generation) {
    return !this._closed && !this._cancelled
      && this._handle === handle && this._handleGeneration === generation;
  }

  _unbindHandle(handle) {
    if (!handle) return;
    if (this._handleDataHandler) removeEventListener(handle, 'data', this._handleDataHandler);
    if (this._handleErrorHandler) removeEventListener(handle, 'error', this._handleErrorHandler);
    this._handleDataHandler = null;
    this._handleErrorHandler = null;
    this._dataBound = false;
  }

  _bindDataIfNeeded() {
    if (!this._handle || this._dataBound || this._dataListeners.size === 0) return;
    if (typeof this._handle.on !== 'function') return;
    const handle = this._handle;
    const generation = this._handleGeneration;
    this._handleDataHandler = data => {
      if (!this._handleIsCurrent(handle, generation)) return;
      for (const listener of this._dataListeners) {
        try { listener(data); } catch {}
      }
    };
    handle.on('data', this._handleDataHandler);
    this._dataBound = true;
  }

  _bindHandle(handle, identity) {
    if (!handle || typeof handle.on !== 'function') {
      throw new NativeFirmwareError('Opened HID handle is not an EventEmitter', { reason: 'io-error' });
    }
    this._handle = handle;
    this._handleIdentity = identity;
    this._handleGeneration += 1;
    const generation = this._handleGeneration;
    this._handleErrorHandler = error => {
      if (!this._handleIsCurrent(handle, generation)) return;
      const oldIdentity = this._handleIdentity;
      void this._retireCurrentHandle();
      for (const listener of this._disconnectListeners) {
        try { listener({ kind: 'disconnected', error, identity: oldIdentity }); } catch {}
      }
    };
    handle.on('error', this._handleErrorHandler);
    this._bindDataIfNeeded();
  }

  async _retireCurrentHandle() {
    const handle = this._handle;
    if (!handle) return;
    this._handle = null;
    this._handleIdentity = null;
    this._handleGeneration += 1;
    this._unbindHandle(handle);
    await closeHandle(handle);
  }

  isConnected() {
    return !this._closed && !this._cancelled && Boolean(this._handle);
  }

  // Read-only handoff hook for the coordinator. It reports only an identity
  // already established by openNormal()/waitForIdentity; it never enumerates
  // or opens a device implicitly.
  getIdentity() {
    return this._handleIdentity ? { ...this._handleIdentity } : null;
  }

  onData(listener) {
    if (typeof listener !== 'function') return () => {};
    this._dataListeners.add(listener);
    this._bindDataIfNeeded();
    return () => {
      this._dataListeners.delete(listener);
      if (this._dataListeners.size === 0 && this._handle && this._dataBound) {
        removeEventListener(this._handle, 'data', this._handleDataHandler);
        this._handleDataHandler = null;
        this._dataBound = false;
      }
    };
  }

  onDisconnect(listener) {
    if (typeof listener !== 'function') return () => {};
    this._disconnectListeners.add(listener);
    return () => this._disconnectListeners.delete(listener);
  }

  async _discover(target, mode, { deadline } = {}) {
    const hid = this._hidModule();
    if (!hid || typeof hid.devicesAsync !== 'function') {
      throw new NativeFirmwareError('node-hid devicesAsync() is unavailable', { reason: 'io-error' });
    }
    const generation = this._operationGeneration;
    const enumerateTimeout = this._timeoutFor('HID enumeration', this.timeouts.enumerateMs, deadline);
    const devices = await this._boundedCall(
      'HID enumeration',
      () => hid.devicesAsync(),
      enumerateTimeout,
      { generation, deadline }
    );
    const commandTimeout = this._timeoutFor('macOS IORegistry topology', this.timeouts.commandMs, deadline);
    const registry = await this._boundedCall(
      'macOS IORegistry topology',
      () => readMacTopology({
        processRunner: this.processRunner || undefined,
        timeoutMs: commandTimeout,
        maxOutputBytes: this.maxTopologyOutputBytes,
        clock: this.clock
      }),
      commandTimeout,
      { generation, deadline }
    );
    return resolveTopologyCandidates({
      hidDevices: devices,
      registry,
      target,
      catalog: this.catalog,
      mode
    });
  }

  async _openPath(candidate, target, mode, anchor, { deadline } = {}) {
    const hid = this._hidModule();
    if (!hid.HIDAsync || typeof hid.HIDAsync.open !== 'function') {
      throw new NativeFirmwareError('node-hid HIDAsync.open() is unavailable', { reason: 'io-error' });
    }
    const generation = this._operationGeneration;

    let handle;
    try {
      const openTimeout = this._timeoutFor('HID handle open', this.timeouts.openMs, deadline);
      const startOpen = () => {
        // Keep the actual HIDAsync.open() invocation behind both bounded-call
        // ownership checks. This closes the second microtask window between
        // starting an attempt and submitting it to node-hid.
        const openPromise = Promise.resolve().then(() => {
          if (!this._operationIsCurrent(generation)) throw this._invalidationError();
          return hid.HIDAsync.open(candidate.path, { nonExclusive: this.nonExclusive });
        });
        // Observe both outcomes. The rejection handler is intentional: the
        // bounded race observes the source promise, but a derived .then()
        // promise must not become an unhandled rejection on open failure.
        openPromise.then(
          openedHandle => {
            if (!this._operationIsCurrent(generation)) void closeHandle(openedHandle);
          },
          () => {}
        );
        return openPromise;
      };
      handle = await this._boundedCall(
        'HID handle open',
        startOpen,
        openTimeout,
        { generation, deadline }
      );
    } catch (error) {
      // A timeout retires the attempt itself. If HIDAsync.open() resolves
      // later, its success branch will see the new generation and close the
      // adapter-owned late handle.
      if (error && error.reason === 'timeout') this._invalidateOperation(generation);
      throw error instanceof NativeFirmwareError ? error : new NativeFirmwareError(
        error && error.message ? error.message : 'HID handle open failed',
        { reason: 'open-error', cause: error }
      );
    }
    if (generation !== this._operationGeneration || this._closed || this._cancelled) {
      await closeHandle(handle);
      throw this._invalidationError();
    }

    try {
      if (!handle || typeof handle.getDeviceInfo !== 'function') {
        throw new NativeFirmwareError('Opened HID handle lacks getDeviceInfo()', { reason: 'io-error' });
      }
      const infoTimeout = this._timeoutFor('opened HID identity read', this.timeouts.openMs, deadline);
      const info = await this._boundedCall(
        'opened HID identity read',
        () => handle.getDeviceInfo(),
        infoTimeout,
        { generation, deadline }
      );
      // Cancellation, close, timeout retirement, or another operation may
      // have invalidated the open while getDeviceInfo() was awaiting. Do not
      // bind listeners or publish identity after that await.
      if (!this._operationIsCurrent(generation)) throw this._invalidationError();
      const observed = normalizeHidDevice({ ...info, path: info && info.path ? info.path : candidate.path });
      if (!observed) throw new NativeFirmwareError('Opened HID handle returned incomplete identity', {
        reason: 'ambiguous-identity'
      });
      const exact = mode === 'normal'
        ? firmware.matchesNormalIdentity(observed, target, this.catalog)
        : firmware.matchesBootIdentity(observed, target, this.catalog);
      if (!exact || observed.path !== candidate.path) {
        throw new NativeFirmwareError('Opened HID handle is not the uniquely reviewed collection', {
          reason: 'ambiguous-identity'
        });
      }
      const observedSerial = normalizeText(observed.serialNumber);
      if (candidate.identity.serialNumber && observedSerial && candidate.identity.serialNumber !== observedSerial) {
        throw new NativeFirmwareError('Opened HID handle serial does not match topology evidence', {
          reason: 'ambiguous-identity'
        });
      }
      const identity = {
        ...candidate.identity,
        ...observed,
        path: candidate.path,
        serialNumber: candidate.identity.serialNumber || observedSerial || null,
        locationId: candidate.identity.locationId,
        registryEntryId: candidate.identity.registryEntryId
      };
      if (!firmware.sameDeviceIdentity(anchor, identity)) {
        throw new NativeFirmwareError('Opened HID handle cannot be bound to the same physical device', {
          reason: 'ambiguous-identity'
        });
      }
      this._bindHandle(handle, identity);
      return identity;
    } catch (error) {
      if (error && error.reason === 'timeout') this._invalidateOperation(generation);
      await closeHandle(handle);
      throw error;
    }
  }

  async openNormal({ target = this.targetRef, reviewedIdentity } = {}) {
    this._assertUsable();
    const canonicalTarget = firmware.resolveTarget(target, this.catalog);
    if (!canonicalTarget) {
      throw new NativeFirmwareError('Normal firmware target is not a known catalog identity', {
        reason: 'unsupported-target'
      });
    }
    if (!firmware.matchesNormalIdentity(reviewedIdentity, canonicalTarget, this.catalog)) {
      throw new NativeFirmwareError('Reviewed identity is not the exact normal G75 V2 collection', {
        reason: 'unsupported-target'
      });
    }
    if (!firmware.hasStableUsbLocation(reviewedIdentity)) {
      throw new NativeFirmwareError('Reviewed normal identity lacks a stable USB location', {
        reason: 'ambiguous-identity'
      });
    }
    const candidates = await this._discover(canonicalTarget, 'normal');
    const reviewedMatches = candidates.filter(candidate => candidateMatchesAnchor(candidate, reviewedIdentity));
    if (reviewedMatches.length !== 1) {
      throw new NativeFirmwareError(
        reviewedMatches.length === 0
          ? 'No unique reviewed normal HID collection was discovered'
          : `Ambiguous reviewed normal HID collection: ${reviewedMatches.length} candidates match`,
        { reason: reviewedMatches.length === 0 ? 'no-candidate' : 'ambiguous-identity', candidateCount: reviewedMatches.length }
      );
    }
    await this._retireCurrentHandle();
    this.targetRef = canonicalTarget.key;
    return this._openPath(reviewedMatches[0], canonicalTarget, 'normal', reviewedIdentity);
  }

  async waitForIdentity({ phase, expected, anchor, target = this.targetRef, timeoutMs = this.timeouts.identityMs } = {}) {
    this._assertUsable();
    const mode = phase === 'boot-confirmation' ? 'boot' : phase === 'normal-reconnect' ? 'normal' : null;
    if (!mode) throw new NativeFirmwareError(`Unsupported firmware identity phase: ${phase}`, { reason: 'identity-error' });
    const canonicalTarget = firmware.resolveTarget(target, this.catalog);
    if (!canonicalTarget || !firmware.hasStableUsbLocation(anchor)) {
      throw new NativeFirmwareError('Identity transition lacks a known target or stable anchor', {
        reason: 'ambiguous-identity'
      });
    }
    const requestedTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? timeoutMs : this.timeouts.identityMs;
    const started = this._now();
    const deadline = started + requestedTimeout;
    await this._retireCurrentHandle();

    while (true) {
      this._assertUsable();
      if (this._now() >= deadline) throw this._timeoutError(`${phase} identity rediscovery`);
      const candidates = await this._discover(canonicalTarget, mode, { deadline });
      const matching = candidates.filter(candidate => candidateMatchesAnchor(candidate, anchor));
      if (matching.length > 1) {
        throw new NativeFirmwareError(`Ambiguous ${phase} identity: ${matching.length} candidates match`, {
          reason: 'ambiguous-identity', candidateCount: matching.length
        });
      }
      if (matching.length === 1) {
        // The candidate was proven by fresh HID + IORegistry data before this
        // open. _openPath performs a second descriptor read and only then
        // installs the new handle's data/error listeners.
        return this._openPath(matching[0], canonicalTarget, mode, anchor, { deadline });
      }

      const now = this._now();
      const remaining = deadline - now;
      if (remaining <= 0) {
        throw new NativeFirmwareError(`Timed out waiting for ${phase} identity rediscovery`, {
          reason: 'timeout'
        });
      }
      await this._delay(Math.min(this.timeouts.pollMs, remaining));
    }
  }

  async write(packet) {
    this._assertUsable();
    if (!Buffer.isBuffer(packet) || packet.length !== firmware.WRITE_BUFFER_SIZE || packet[0] !== firmware.REPORT_ID) {
      throw new NativeFirmwareError('Firmware HID write must be exactly report ID 0 plus 64 bytes', {
        reason: 'invalid-packet', dispatched: false, dispatchStatus: 'no'
      });
    }
    const handle = this._handle;
    const generation = this._handleGeneration;
    if (!handle || typeof handle.write !== 'function') {
      throw new NativeFirmwareError('No adapter-owned HID handle is open', {
        reason: 'not-open', dispatched: false, dispatchStatus: 'no'
      });
    }
    let result;
    try {
      result = await this._boundedCall(
        'firmware HID write',
        () => handle.write(Buffer.from(packet)),
        this.timeouts.writeMs
      );
    } catch (error) {
      if (error && error.reason === 'timeout') void this._retireCurrentHandle();
      if (error instanceof NativeFirmwareError) throw error;
      if (error && error.dispatched === false) {
        throw new NativeFirmwareError(error.message || 'HID write was not dispatched', {
          reason: 'io-error', dispatched: false, dispatchStatus: 'no', cause: error
        });
      }
      throw new NativeFirmwareError(error && error.message ? error.message : 'HID write failed after an unknown submission state', {
        reason: 'io-error', dispatchStatus: 'unknown', cause: error
      });
    }
    if (!this._handleIsCurrent(handle, generation)) {
      throw new NativeFirmwareError('HID write completed after its handle was invalidated', {
        reason: 'uncertain', dispatchStatus: 'unknown'
      });
    }
    if (typeof result === 'number' && result !== firmware.WRITE_BUFFER_SIZE) {
      throw new NativeFirmwareError(`HID write returned ${result} bytes; full report dispatch is unconfirmed`, {
        reason: 'uncertain', dispatchStatus: 'unknown', bytesWritten: result
      });
    }
    return { dispatched: true, bytesWritten: result };
  }

  cancel(reason = 'Native firmware IO adapter cancelled') {
    if (this._cancelled || this._closed) return false;
    this._cancelled = true;
    this._cancelReason = String(reason || 'Native firmware IO adapter cancelled');
    this._operationGeneration += 1;
    this._invalidatePending(this._invalidationError());
    void this._retireCurrentHandle();
    return true;
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    this._operationGeneration += 1;
    this._invalidatePending(this._invalidationError());
    await this._retireCurrentHandle();
    this._dataListeners.clear();
    this._disconnectListeners.clear();
  }
}

module.exports = {
  MAC_COMMANDS,
  DEFAULT_NATIVE_TIMEOUTS,
  NativeFirmwareError,
  parseRegistryInteger,
  parseDevSrvsId,
  parseIoregJson,
  registryEntriesFromJson,
  resolveTopologyCandidates,
  resolveUniqueTopologyCandidate,
  liveHandleDescriptor,
  correlateLiveHandleTopology,
  applyCorrelatedTopology,
  attachLiveHandleTopology,
  runSystemCommand,
  readMacTopology,
  NativeFirmwareIo
};
