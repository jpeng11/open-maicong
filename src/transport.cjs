const HID = require('node-hid');
const protocol = require('./protocol.cjs');
const {
  VALID_PHYSICAL_SLOTS,
  VALID_LIGHTING_SLOTS,
  ELIGIBLE_ADVANCED_SLOTS,
  getDefaultTuple
} = require('./layout-g75v2.cjs');
const {
  validateLightingParams,
  validateSettingsParams,
  validateKeymapUpdates,
  validateKeyColors,
  validateMacroSlots,
  validateProfileSchema,
  validateAdvancedBinding,
  validateClearAllAdvanced
} = require('./schema-validators.cjs');
const lightingMemory = require('./lighting-memory.cjs');
const stillLibrary = require('./still-library.cjs');
const gifLibrary = require('./gif-library.cjs');
const { GifPlayer } = require('./gif-player.cjs');
const profileNames = require('./profile-names.cjs');
const profileLibrary = require('./profile-library.cjs');
const profileAppBind = require('./profile-app-bind.cjs');
const profileOps = require('./profile-ops.cjs');
const profileFile = require('./profile-file.cjs');
const keyConfig = require('./key-config.cjs');
const advancedPlan = require('./advanced-plan.cjs');

// MCHOSE G75 V2 Hardware IDs
const MCHOSE_VID = 14391; // 0x3837
const G75_V2_RECEIVER_PID = 12339; // 0x3033
const G75_V2_WIRED_PID = 8225; // 0x2021
const STREAM_UNSAFE_COMPLETE_MS = 20;
const G75_STREAM_MAIN_KEYS = 128;
const G75_STREAM_MAIN_BYTES = G75_STREAM_MAIN_KEYS * 3;

/**
 * Predicate to check if a device descriptor is an exact GLW control interface.
 * Strictly checks:
 * - VID: 14391 (0x3837)
 * - PID: 12339 (Receiver) or 8225 (Wired)
 * - interface: 1
 * - usagePage: 1
 * - usage: 0 or undefined (node-hid on macOS drops usage 0 to undefined)
 */
function isExactControlInterface(d) {
  if (!d) return false;
  const isVid = d.vendorId === MCHOSE_VID;
  const isPid = d.productId === G75_V2_RECEIVER_PID || d.productId === G75_V2_WIRED_PID;
  const isInterface1 = d.interface === 1;
  const isUsagePage1 = d.usagePage === 1;
  const isUsage0OrUndef = d.usage === 0 || d.usage === undefined;

  return isVid && isPid && isInterface1 && isUsagePage1 && isUsage0OrUndef;
}

class DeviceTransport {
  constructor() {
    this.device = null;
    this.deviceInfo = null;
    this.generation = 0; // Monotonically increasing connection generation
    this.activeQueue = Promise.resolve();
    this.transactionLock = Promise.resolve();
    this.responseListeners = new Set();
    this.isStandby = false;
    this.needsReconnect = false;
    this.statusError = null;
    this.lastReadSuccess = false;
    this._pendingInFlight = new Set();
    this.resetEpoch = 0;
    this.resetNotificationListeners = new Set();
    this.resetInFlight = false;
    this._resetDispatchStarted = false;
    this.configUncertain = false;
    this.lastResetOutcome = null;
    this.onStateChange = null;
    this._lightMemoryHardwareOk = null;
    this._lightMemoryCache = null;
    this.lightMemoryFallback = 'hardware';
    this.lightingMemoryPath = null;
    this.stillLibraryPath = null;
    this.gifLibraryPath = null;
    this.profileLibraryPath = null;
    this.profileAppBindPath = null;
    this.streamPaceMs = STREAM_UNSAFE_COMPLETE_MS;

    // Internal raw cached snapshots from verified reads
    this._rawBase = null;
    this._rawFuncConfig = null;
    this._rawMacroRegion = null;
    this._rawKeyColors = null;

    // Last known state
    this.resetState();
  }

  /**
   * Reset local state on disconnect. No stale/fake cached values.
   */
  resetState() {
    this.lastState = {
      connected: false,
      device: null,
      info: null,
      base: null,
      battery: {
        batteryLevel: null,
        isCharging: false
      },
      lighting: null,
      settings: null,
      currentLayer: 0,
      activeProfileIndex: 0,
      keymaps: {},
      keyColors: null,
      macros: [],
      selectedLightEffect: ['still', ''],
      stillLibrary: stillLibrary.snapshot([]),
      gifLibrary: gifLibrary.emptySnapshot(),
      isStreaming: false,
      appBinds: [],
      appBindsError: null,
      profileLibrary: profileLibrary.snapshot([], []),
      profileNames: profileNames.displayNamesFromStored([], 4),
      profileNamesStored: ['', '', '', ''],
      profileNamesSource: 'default',
      editSource: { kind: 'onboard', profileIndex: 0 }
    };
    this._rawBase = null;
    this._rawFuncConfig = null;
    this._rawMacroRegion = null;
    this._rawKeyColors = null;
    this._rawMt = null;
    this._rawTgl = null;
    this._rawExtras = null;
    this._lightMemoryHardwareOk = null;
    this._lightMemoryCache = null;
    this.lightMemoryFallback = 'hardware';
    this.editTarget = { profileIndex: 0, layer: null };
    this.editSource = { kind: 'onboard', profileIndex: 0 };
    this._selectedLightEffectByProfile = {};
    this.streamGeneration = 0;
    this.gifPlayer = null;
    this._gifStreamItem = null;
    this._gifStreamProfile = null;
    this._gifStreamDevGen = null;
    this._gifStreamEpoch = null;
    this._streamDispatchInFlight = false;
    this._streamDispatchOwner = null;
    this.latestPendingStreamFrame = null;
    this._streamPaceTimer = null;
    this._streamPaceResolve = null;
    this._transactionInFlight = false;
    // Firmware exclusive ownership is intentionally NOT cleared here. A
    // disconnect during an in-progress update must keep the owner token so
    // connectFirmwareNormal / releaseFirmwareOwnership can finish the handoff.
    this.onGifFrame = null;
  }

  _lightingMemoryFile() {
    return this.lightingMemoryPath || lightingMemory.defaultLocalPath();
  }

  _stillLibraryFile() {
    return this.stillLibraryPath || stillLibrary.defaultLocalPath();
  }

  _gifLibraryFile() {
    return this.gifLibraryPath || gifLibrary.defaultLocalPath();
  }

  _profileLibraryFile() {
    return this.profileLibraryPath || profileLibrary.defaultLocalPath();
  }

  _profileAppBindFile() {
    return this.profileAppBindPath || profileAppBind.defaultLocalPath();
  }

  listAppBinds() {
    const loaded = profileAppBind.readDevice(this._profileAppBindFile(), this._profileDeviceKey());
    this.lastState.appBinds = loaded.ok ? loaded.binds : [];
    this.lastState.appBindsError = loaded.ok ? null : (loaded.error || 'App binds unreadable');
    return {
      success: loaded.ok,
      binds: loaded.ok ? loaded.binds : [],
      error: loaded.ok ? null : loaded.error
    };
  }

  bindProfileApp(spec = {}) {
    const loaded = profileAppBind.readDevice(this._profileAppBindFile(), this._profileDeviceKey());
    if (!loaded.ok) return { success: false, error: loaded.error, unwritable: true };
    const next = profileAppBind.setBind(loaded.binds, spec);
    if (!next.valid) return { success: false, error: next.error };
    try {
      profileAppBind.writeDevice(this._profileAppBindFile(), this._profileDeviceKey(), next.binds);
    } catch (err) {
      return { success: false, error: err.message, unwritable: true };
    }
    this.lastState.appBinds = next.binds;
    this._notifyStateChange();
    return { success: true, bind: next.bind, binds: next.binds };
  }

  unbindProfileApp(profileIndex, options = {}) {
    const loaded = profileAppBind.readDevice(this._profileAppBindFile(), this._profileDeviceKey());
    if (!loaded.ok) return { success: false, error: loaded.error, unwritable: true };
    const next = profileAppBind.deleteBind(loaded.binds, profileIndex);
    if (!next.valid) return { success: false, error: next.error };
    if (next.changed) {
      try {
        profileAppBind.writeDevice(this._profileAppBindFile(), this._profileDeviceKey(), next.binds);
      } catch (err) {
        return { success: false, error: err.message, unwritable: true };
      }
    }
    this.lastState.appBinds = next.binds;
    if (next.changed) this._notifyStateChange();
    return {
      success: true,
      changed: next.changed,
      removed: next.removed,
      binds: next.binds,
      autoUnbound: Boolean(options.autoUnbound)
    };
  }

  _releaseAppBindForOnboardKey(key, options = {}) {
    const idx = profileAppBind.profileIndexFromOnboardKey(key);
    if (idx == null) return { success: true, changed: false };
    return this.unbindProfileApp(idx, options);
  }

  _stillIdentity() {
    return stillLibrary.deviceIdentity(this.lastState.device || {});
  }

  _profileIdentity() {
    return profileLibrary.deviceIdentity(this.lastState.device || {});
  }

  _profileDeviceKey() {
    return profileLibrary.deviceStorageKey(this.lastState.device || {});
  }

  _profileStillCurrent(startGen, startEpoch) {
    return Boolean(this.device)
      && this.generation === startGen
      && this.resetEpoch === startEpoch
      && !this.needsReconnect;
  }

  isFirmwareExclusive() {
    return Boolean(this._firmwareExclusive);
  }

  _firmwareOwnerAllowed(ownerToken = null) {
    return !this._firmwareExclusive || this._firmwareExclusive.token === ownerToken;
  }

  _firmwareOwnershipError() {
    return 'Firmware updater owns the device transport';
  }

  _loadProfileLibrary(extra = {}) {
    const key = this._profileDeviceKey();
    const loaded = profileLibrary.readDevice(this._profileLibraryFile(), key);
    const base = this.lastState.base || { activeProfile: 0, profileCount: 0, profileOrder: [0, 1, 2, 3] };
    const nameList = this.lastState.profileNames || profileNames.displayNamesFromStored(this.lastState.profileNamesStored, 4);
    const hw = profileOps.listFromHardware(
      base,
      nameList,
      loaded.ok ? loaded.items : [],
      this.lastState.profileNamesStored
    );
    const snap = profileLibrary.snapshot(hw.list.filter((i) => i.type === 'keyboard'), loaded.ok ? loaded.items : [], {
      error: extra.error || loaded.error || null,
      unwritable: Boolean(extra.unwritable || loaded.unwritable),
      recovered: Boolean(extra.recovered || loaded.recovered),
      recoveryCount: (loaded.recovery || []).length,
      names: nameList,
      namesSource: this.lastState.profileNamesSource || 'default',
      order: hw.order,
      length: hw.length,
      activeIndex: hw.activeIndex,
      list: hw.list
    });
    this.lastState.profileLibrary = snap;
    this.listAppBinds();
    return { loaded, snap, hw };
  }

  _toApplyPayload(data) {
    if (!data || typeof data !== 'object') return data;
    const payload = {
      app: data.app || 'Maicong Studio',
      model: data.model || 'MCHOSE G75 V2',
      protocol: 'GLW',
      version: data.version || '2.0.0',
      lighting: data.lighting,
      settings: data.settings,
      layers: data.layers,
      perKeyRgb: data.perKeyRgb || {},
      macros: Array.isArray(data.macros) ? data.macros : []
    };
    if (data.advanced) payload.advanced = data.advanced;
    if (data.lightingMemory) payload.lightingMemory = data.lightingMemory;
    if (data.macroMetadata) payload.macroMetadata = data.macroMetadata;
    return payload;
  }

  _loadGifLibrary(extra = {}) {
    const key = gifLibrary.deviceStorageKey(this.lastState.device || {});
    const file = this._gifLibraryFile();
    const snap = gifLibrary.snapshot(key, file);
    if (extra.error) snap.error = extra.error;
    if (extra.unwritable !== undefined) snap.unwritable = Boolean(extra.unwritable);
    const pair = this.lastState.selectedLightEffect;
    if (Array.isArray(pair) && pair[0] === 'gif') {
      const item = (snap.items || []).find((entry) => entry.name === pair[1]);
      snap.selectedPair = pair.slice();
      snap.selectedKey = item ? item.key : null;
    } else {
      snap.selectedPair = ['gif', ''];
      snap.selectedKey = null;
    }
    this.lastState.gifLibrary = snap;
    return snap;
  }

  _loadStillLibrary(extra = {}) {
    const key = stillLibrary.deviceStorageKey(this.lastState.device || {});
    const loaded = stillLibrary.readDeviceItems(this._stillLibraryFile(), key);
    const pair = this.lastState.selectedLightEffect || ['still', ''];
    const snap = stillLibrary.snapshot(loaded.ok ? loaded.items : [], pair, {
      error: extra.error || (loaded.ok ? null : loaded.error),
      unwritable: Boolean(loaded.unwritable) || Boolean(extra.unwritable),
      selectedOnDevice: Boolean(extra.selectedOnDevice),
      recovered: Boolean(loaded.recovered),
      model: stillLibrary.MODEL
    });
    this.lastState.stillLibrary = snap;
    return { ...loaded, snapshot: snap };
  }

  _currentEditProfile() {
    const idx = this.editTarget && this.editTarget.profileIndex;
    return Number.isInteger(idx) ? idx : 0;
  }

  _isEditorProfile(profileIndex) {
    return profileIndex === this._currentEditProfile();
  }

  _publishSelectedPair(profileIndex, pair) {
    if (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 3) return;
    const next = Array.isArray(pair) ? [pair[0] || 'still', pair[1] || ''] : ['still', ''];
    this._selectedLightEffectByProfile[profileIndex] = next.slice();
    if (this._isEditorProfile(profileIndex)) {
      this.lastState.selectedLightEffect = next.slice();
    }
  }

  _lightingDeviceKey() {
    return lightingMemory.deviceStorageKey(this.lastState.device || {});
  }

  _lightingIdentity() {
    return lightingMemory.deviceIdentity(this.lastState.device || {});
  }

  _loadLightMemoryPreference() {
    const id = this._lightingIdentity();
    const pref = lightingMemory.readDeviceFallback(this._lightingMemoryFile(), id.key);
    this.lightMemoryFallback = pref.fallback === 'local' ? 'local' : 'hardware';
    this._lightMemoryPref = {
      fallback: this.lightMemoryFallback,
      identityKind: id.kind,
      durable: id.durable,
      deviceKey: id.key,
      recovered: Boolean(pref.recovered),
      unwritable: Boolean(pref.unwritable),
      error: pref.error || null,
      hint: lightingMemory.describeMemoryIdentity(this.lastState.device || {}, this.lightMemoryFallback)
    };
    return this._lightMemoryPref;
  }

  getLightMemoryPreference() {
    const id = this._lightingIdentity();
    const fallback = this.lightMemoryFallback === 'local' ? 'local' : 'hardware';
    const stored = lightingMemory.readDeviceFallback(this._lightingMemoryFile(), id.key);
    return {
      fallback,
      identityKind: id.kind,
      durable: id.durable,
      deviceKey: id.key,
      serialPresent: id.kind === 'serial',
      recovered: Boolean(stored.recovered),
      unwritable: Boolean(stored.unwritable),
      error: stored.error || null,
      persisted: !stored.recovered && stored.fallback === fallback,
      hint: lightingMemory.describeMemoryIdentity(this.lastState.device || {}, fallback)
    };
  }

  setLightMemoryFallback(fallback) {
    if (fallback !== 'hardware' && fallback !== 'local') {
      return { success: false, error: 'fallback must be hardware or local' };
    }
    if (!this.device || !this.lastState.device) {
      return { success: false, error: 'Device not connected' };
    }
    const captured = this._captureMemoryGuard();
    const id = this._lightingIdentity();
    if (captured.deviceKey !== id.key) {
      return { success: false, error: 'Lighting memory identity changed before saving the preference' };
    }
    try {
      lightingMemory.writeDeviceFallback(this._lightingMemoryFile(), captured.deviceKey, fallback, id);
    } catch (err) {
      return {
        success: false,
        error: err.message || String(err),
        fallback: this.lightMemoryFallback === 'local' ? 'local' : 'hardware',
        persisted: false,
        identityKind: id.kind,
        durable: id.durable,
        deviceKey: captured.deviceKey,
        hint: lightingMemory.describeMemoryIdentity(this.lastState.device || {}, this.lightMemoryFallback)
      };
    }
    if (!this._memoryGuardCurrent(captured)) {
      return { success: false, error: 'Lighting memory identity changed while saving the preference' };
    }
    this.lightMemoryFallback = fallback;
    this._lightMemoryCache = null;
    return {
      success: true,
      fallback,
      persisted: true,
      identityKind: id.kind,
      durable: id.durable,
      deviceKey: captured.deviceKey,
      serialPresent: id.kind === 'serial',
      hint: lightingMemory.describeMemoryIdentity(this.lastState.device || {}, fallback)
    };
  }

  _captureMemoryGuard() {
    return {
      gen: this.generation,
      resetEpoch: this.resetEpoch,
      deviceKey: this._lightingDeviceKey(),
      path: this.lastState.device && this.lastState.device.path,
      fallback: this.lightMemoryFallback === 'local' ? 'local' : 'hardware'
    };
  }

  _memoryGuardCurrent(captured) {
    if (!captured) return false;
    if (!this.device || this.generation !== captured.gen) return false;
    if (this.resetEpoch !== captured.resetEpoch) return false;
    if (captured.deviceKey !== this._lightingDeviceKey()) return false;
    return true;
  }

  /**
   * Enumerate connected MCHOSE HID devices matching exact control interface.
   */
  listDevices() {
    try {
      const allDevices = HID.devices();
      return allDevices.filter(d => isExactControlInterface(d));
    } catch (err) {
      console.error('[Transport] Failed to enumerate HID devices:', err);
      return [];
    }
  }

  /**
   * Filter and identify the exact GLW configuration interface.
   * Strictly matches exact control interface; NO generic or loose fallbacks.
   */
  findControlInterface(devices) {
    if (!devices || devices.length === 0) return null;
    return devices.find(d => isExactControlInterface(d)) || null;
  }

  /**
   * Open connection to the keyboard or receiver using nonexclusive mode.
   * Nonexclusive mode ensures normal macOS keyboard input remains uninterrupted.
   * Never auto-redirects an invalid requested targetPath to a different device.
   */
  connect(targetPath = null, options = {}) {
    const ownerToken = options && options.firmwareOwner ? options.firmwareOwner : null;
    if (!this._firmwareOwnerAllowed(ownerToken)) {
      return { success: false, error: this._firmwareOwnershipError(), updaterOwned: true };
    }
    this.disconnect({ firmwareOwner: ownerToken });

    const devices = this.listDevices();
    let target = null;

    if (targetPath) {
      target = devices.find(d => d.path === targetPath && isExactControlInterface(d));
      if (!target) {
        this.resetState();
        return { success: false, error: `Requested device path not found or does not match exact control interface: ${targetPath}` };
      }
    } else {
      target = this.findControlInterface(devices);
    }

    if (!target || !target.path) {
      this.resetState();
      return { success: false, error: 'No compatible MCHOSE GLW control interface found' };
    }

    try {
      // Open with nonExclusive: true on macOS
      this.device = new HID.HID(target.path, { nonExclusive: true });
      this.deviceInfo = target;
      this.generation++;
      this.needsReconnect = false;
      this.statusError = null;
      this.lastState.connected = true;
      this.lastState.device = {
        vendorId: target.vendorId,
        productId: target.productId,
        hexVendorId: '0x' + target.vendorId.toString(16).toUpperCase().padStart(4, '0'),
        hexProductId: '0x' + target.productId.toString(16).toUpperCase().padStart(4, '0'),
        product: target.product || 'MCHOSE G75 V2',
        manufacturer: target.manufacturer || 'MCHOSE',
        serialNumber: target.serialNumber || null,
        path: target.path,
        interface: target.interface,
        usagePage: target.usagePage,
        usage: target.usage,
        isReceiver: target.productId === G75_V2_RECEIVER_PID
      };
      this.firmwareTopologyIdentity = null;
      this._firmwareTopologyPromise = this.attachFirmwareTopology().catch((err) => ({
        valid: false,
        reason: 'topology-error',
        error: err && err.message ? err.message : String(err)
      }));

      this._bindDeviceListeners(this.device);
      this._loadLightMemoryPreference();

      return { success: true, device: this.lastState.device };
    } catch (err) {
      console.error('[Transport] Failed to open HID device:', err);
      this.device = null;
      this.deviceInfo = null;
      this.resetState();
      return { success: false, error: err.message };
    }
  }

  /**
   * Disconnect cleanly.
   * Increments generation, cancels in-flight timers and settles pending promises immediately,
   * clears pending listeners, and resets cached state.
   */
  disconnect(options = {}) {
    const ownerToken = options && options.firmwareOwner ? options.firmwareOwner : null;
    if (!this._firmwareOwnerAllowed(ownerToken)) return false;
    this.abortAllMusicColor();
    this.generation++;
    this.resetEpoch++;
    this.resetInFlight = false;
    this._resetDispatchStarted = false;
    this.configUncertain = false;
    this.lastResetOutcome = null;
    this.resetNotificationListeners.clear();

    // Settle all in-flight pending operations immediately so pending timers cannot fire later
    for (const pending of this._pendingInFlight) {
      try {
        if (pending.timer) clearTimeout(pending.timer);
        if (pending.cancel) pending.cancel();
      } catch {}
    }
    this._pendingInFlight.clear();

    if (this.device) {
      try {
        this.device.close();
      } catch {}
      this.device = null;
    }
    this.deviceInfo = null;
    this.responseListeners.clear();
    this.needsReconnect = false;
    this.statusError = null;
    if (!this._firmwareExclusive) {
      this.firmwareTopologyIdentity = null;
      this._firmwareTopologyPromise = null;
    }
    this.resetState();
    return true;
  }

  /**
   * Correlate ioreg LocationID onto the currently open node-hid control
   * handle. Ordinary config IO does not wait for this; firmware review does.
   * Missing or ambiguous topology is not invented.
   */
  async attachFirmwareTopology(options = {}) {
    const native = require('./firmware-native.cjs');
    const result = await native.attachLiveHandleTopology(this, {
      catalog: options.catalog,
      processRunner: options.processRunner || this.topologyProcessRunner,
      registry: options.registry,
      timeoutMs: options.timeoutMs
    });
    if (result && result.valid) this._notifyStateChange();
    return result;
  }

  /**
   * Acquire an exclusive firmware-update owner without opening another HID
   * handle.  The current normal handle remains available for the complete
   * pre-boot backup; queued/in-flight ordinary work is cancelled and the
   * queue barriers are drained before the owner is returned.
   *
   * The caller must pass the returned token to every intentional transport
   * operation.  Other configuration, stream, disconnect, and reconnect calls
   * fail closed while the token is live.
   */
  async acquireFirmwareOwnership(expectedIdentity = null, options = {}) {
    if (this._firmwareExclusive) {
      return { success: false, error: 'Firmware updater already owns the device transport', updaterOwned: true };
    }
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'A connected normal transport is required before firmware handoff' };
    }

    const firmwareBackup = require('./firmware-backup.cjs');
    const topology = expectedIdentity || this.firmwareTopologyIdentity || null;
    const currentIdentity = firmwareBackup.currentDeviceIdentity(this, topology);
    const valid = firmwareBackup.validateNormalIdentity(currentIdentity);
    if (!valid.valid) {
      return { success: false, error: valid.error || 'Current normal device identity is not reviewable' };
    }
    if (expectedIdentity && !firmwareBackup.identitiesMatch(expectedIdentity, currentIdentity)) {
      return { success: false, error: 'Reviewed firmware identity changed before exclusive handoff', stale: true };
    }

    const token = {
      kind: 'firmware-transport-owner',
      sequence: ++this._firmwareOwnerSequence
    };
    const priorTransactionLock = this.transactionLock;
    const priorActiveQueue = this.activeQueue;
    this._firmwareExclusive = { token, identity: { ...currentIdentity } };

    this.abortAllMusicColor();
    // Settle packet waiters immediately.  Their original transaction bodies
    // still observe the owner gate on any later send and cannot continue with
    // configuration writes.
    for (const pending of this._pendingInFlight) {
      try { if (pending.cancel) pending.cancel(); } catch {}
    }
    this.responseListeners.clear();

    const drainTimeoutMs = Number.isFinite(options.drainTimeoutMs) && options.drainTimeoutMs >= 0
      ? options.drainTimeoutMs : 1500;
    let timer = null;
    const timeoutMarker = {};
    try {
      const drained = await Promise.race([
        Promise.all([
          Promise.resolve(priorTransactionLock).catch(() => {}),
          Promise.resolve(priorActiveQueue).catch(() => {})
        ]),
        new Promise(resolve => {
          timer = setTimeout(() => resolve(timeoutMarker), drainTimeoutMs);
        })
      ]);
      if (drained === timeoutMarker) {
        this.disconnect({ firmwareOwner: token });
        this._firmwareExclusive = null;
        return {
          success: false,
          error: 'Normal transport queue did not drain before firmware handoff deadline',
          reason: 'handoff-timeout'
        };
      }
    } finally {
      if (timer) clearTimeout(timer);
    }

    // Stale queue tails may still settle after their cancellation.  New owner
    // work starts from clean barriers, while their old send steps remain
    // owner-gated and therefore cannot dispatch.
    this.transactionLock = Promise.resolve();
    this.activeQueue = Promise.resolve();
    return {
      success: true,
      token,
      identity: { ...currentIdentity },
      generation: this.generation,
      resetEpoch: this.resetEpoch
    };
  }

  releaseFirmwareOwnership(ownerToken) {
    if (!this._firmwareExclusive) return { success: true, released: false };
    if (this._firmwareExclusive.token !== ownerToken) {
      return { success: false, error: 'Firmware transport ownership token does not match' };
    }
    this._firmwareExclusive = null;
    return { success: true, released: true };
  }

  closeFirmwareNormalHandle(ownerToken) {
    if (!this._firmwareExclusive || this._firmwareExclusive.token !== ownerToken) {
      return { success: false, error: 'Firmware transport ownership token does not match' };
    }
    this.disconnect({ firmwareOwner: ownerToken });
    return { success: true, disconnected: true };
  }

  /**
   * Reconnect the exact normal path already proven by the native topology
   * adapter.  The owner gate is intentionally required; ordinary watcher
   * reconnects cannot steal the handle during an update.
   */
  connectFirmwareNormal(identity, ownerToken) {
    if (!this._firmwareExclusive || this._firmwareExclusive.token !== ownerToken) {
      return { success: false, error: 'Firmware transport ownership token does not match' };
    }
    if (!identity || typeof identity.path !== 'string' || !identity.path) {
      return { success: false, error: 'Verified normal identity has no exact HID path' };
    }
    const result = this.connect(identity.path, { firmwareOwner: ownerToken });
    if (!result || !result.success) return result || { success: false, error: 'Normal reconnect failed' };

    const firmwareBackup = require('./firmware-backup.cjs');
    const current = firmwareBackup.currentDeviceIdentity(this, identity);
    if (!firmwareBackup.identitiesMatch(identity, current)) {
      this.disconnect({ firmwareOwner: ownerToken });
      return { success: false, error: 'Reconnected normal handle did not match the verified firmware identity', stale: true };
    }
    this.firmwareTopologyIdentity = { ...identity, path: current.path || identity.path };
    return { ...result, identity: current };
  }

  /**
   * Strict read-only MCU/RF version query used both by review and by the
   * post-update completion gate.  It reads the real GET_INFO packet and never
   * derives a version from a firmware package header.
   */
  async readFirmwareInfo(options = {}) {
    const ownerToken = options.ownerToken || null;
    if (!this._firmwareOwnerAllowed(ownerToken)) {
      return { success: false, error: this._firmwareOwnershipError(), updaterOwned: true };
    }
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    const expectedIdentity = options.identity || this.firmwareTopologyIdentity || null;
    return this.runTransaction(async (startGen) => {
      const startEpoch = this.resetEpoch;
      const result = await this.readRange(
        protocol.COMMANDS.GET_INFO,
        0,
        56,
        Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 1000,
        startGen,
        ownerToken
      );
      if (!result || !result.success || !result.data || result.data.length !== 56) {
        return { success: false, error: (result && result.error) || 'Complete firmware-info read failed' };
      }
      if (!this.device || this.generation !== startGen || this.resetEpoch !== startEpoch || this.needsReconnect) {
        return { success: false, error: 'Device identity changed during firmware-info read', stale: true };
      }
      const info = protocol.parseInfo(result.data);
      if (!info) return { success: false, error: 'Firmware-info payload is malformed' };
      let identity = null;
      if (expectedIdentity) {
        const firmwareBackup = require('./firmware-backup.cjs');
        identity = firmwareBackup.currentDeviceIdentity(this, expectedIdentity);
        if (!firmwareBackup.validateNormalIdentity(identity).valid
          || !firmwareBackup.identitiesMatch(expectedIdentity, identity)) {
          return { success: false, error: 'Firmware-info read is not bound to the reviewed normal identity', stale: true };
        }
      }
      return { success: true, info, raw: Buffer.from(result.data), identity };
    }, { ownerToken });
  }

  /**
   * Bind data/error listeners to a specific HID handle and connection generation.
   * Buffered events from a replaced handle must not act on the new connection.
   */
  _bindDeviceListeners(device) {
    if (!device || typeof device.on !== 'function') return;
    const handle = device;
    const connectGen = this.generation;
    device.on('data', (data) => {
      if (this.device !== handle || this.generation !== connectGen) return;
      this.handleIncomingData(data);
    });
    device.on('error', (err) => {
      if (this.device !== handle || this.generation !== connectGen) return;
      console.warn('[Transport] HID device error:', err && err.message ? err.message : err);
      this.disconnect();
    });
  }

  _notifyStateChange() {
    if (typeof this.onStateChange !== 'function') return;
    try {
      this.onStateChange();
    } catch (err) {
      console.error('[Transport] onStateChange error:', err);
    }
  }

  /**
   * Internal handler for incoming HID reports.
   */
  handleIncomingData(buffer) {
    try {
      const resetNote = protocol.decodeResetNotification(buffer);
      if (resetNote) {
        this._dispatchResetNotification(resetNote);
        return;
      }

      const packet = protocol.decodePacket(buffer);
      if (!packet) return;

      for (const listener of this.responseListeners) {
        try {
          listener(packet);
        } catch (e) {
          console.error('[Transport] Listener error:', e);
        }
      }
    } catch (err) {
      console.warn('[Transport] Error handling incoming data report:', err);
    }
  }

  /**
   * Execute an operation exclusively under the transaction lock with generation protection.
   * Disconnect/reconnect invalidates/rejects pending tasks immediately.
   */
  runTransaction(task, options = {}) {
    const ownerToken = options && options.ownerToken ? options.ownerToken : null;
    if (!this._firmwareOwnerAllowed(ownerToken)) {
      return Promise.reject(new Error(this._firmwareOwnershipError()));
    }
    const startGen = this.generation;
    const startEpoch = this.resetEpoch;
    const blockedByReset = this.resetInFlight;
    const next = this.transactionLock.then(async () => {
      if (
        !this._firmwareOwnerAllowed(ownerToken)
        ||
        blockedByReset
        || this.resetEpoch !== startEpoch
        || this.generation !== startGen
        || !this.device
      ) {
        throw new Error('Transaction aborted: device disconnected, generation changed, or configuration invalidated');
      }
      this._transactionInFlight = true;
      this._cancelStreamPace();
      try {
        return await task(startGen);
      } finally {
        this._transactionInFlight = false;
        this._flushPendingStreamFrame();
      }
    });
    this.transactionLock = next.catch(() => {});
    return next;
  }

  /**
   * Sends a GLW command packet and waits for matching reply.
   * Serialized into a strict single-flight Promise queue with generation checks.
   *
   * Validates:
   * - Packet checksum (rejects if packet.checksumValid is false, with request-matched echo for CMD 3)
   * - Packet status (rejects if packet.status !== 0)
   * - Reserved byte (rejects if packet.reservedValid is false)
   * - Generation preservation across entire send/reply roundtrip
   * - On timeout, marks needsReconnect and rejects late replies
   */
  sendPacket({ command, offset = 0, size, data = [], timeoutMs = 1200, expectedGen = null, onDispatch = null, expectedResetEpoch = null, ownerToken = null }) {
    const packetGen = expectedGen !== null ? expectedGen : this.generation;
    const packetEpoch = expectedResetEpoch !== null ? expectedResetEpoch : this.resetEpoch;
    if (!this._firmwareOwnerAllowed(ownerToken)) {
      return Promise.resolve({ success: false, error: this._firmwareOwnershipError(), blocked: true, timeout: false, dispatched: false });
    }
    if (!this.device || this.needsReconnect) {
      return Promise.resolve({ success: false, error: 'Device not connected or requires reconnect', timeout: false, dispatched: false });
    }
    if (this.generation !== packetGen) {
      return Promise.resolve({ success: false, error: 'Connection generation mismatch', timeout: false, aborted: true, dispatched: false });
    }
    if (this.resetEpoch !== packetEpoch) {
      return Promise.resolve({ success: false, error: 'Reset epoch mismatch; review is stale', timeout: false, aborted: true, dispatched: false });
    }

    const payloadData = Array.isArray(data) ? data : Array.from(data);
    const reqSize = size !== undefined ? size : payloadData.length;
    const offsetLo = offset & 0xFF;
    const offsetHi = (offset >> 8) & 0xFF;
    const expectedDescriptorChecksum = protocol.calculateChecksum([reqSize, offsetLo, offsetHi, 0]);

    return new Promise(resolve => {
      this.activeQueue = this.activeQueue.then(() => {
        return new Promise(stepResolve => {
          if (
            !this._firmwareOwnerAllowed(ownerToken)
            ||
            !this.device
            || this.needsReconnect
            || this.generation !== packetGen
            || this.resetEpoch !== packetEpoch
          ) {
            stepResolve();
            resolve({
              success: false,
              error: this.resetEpoch !== packetEpoch
                ? 'Reset epoch mismatch; review is stale'
                : 'Device not connected or generation changed',
              timeout: false,
              aborted: true,
              dispatched: false
            });
            return;
          }

          let timer = null;
          let completed = false;
          let inFlightRecord = null;
          let didDispatch = false;

          const finish = (result) => {
            if (completed) return;
            completed = true;
            if (timer) clearTimeout(timer);
            if (inFlightRecord) this._pendingInFlight.delete(inFlightRecord);
            this.responseListeners.delete(listener);
            stepResolve();
            resolve({ ...result, dispatched: didDispatch });
          };

          const cancel = () => {
            finish({ success: false, error: 'Device disconnected during packet transfer', timeout: false, aborted: true });
          };

          inFlightRecord = { cancel, get timer() { return timer; } };
          this._pendingInFlight.add(inFlightRecord);

          const listener = packet => {
            if (completed) return;
            if (this.generation !== packetGen || this.resetEpoch !== packetEpoch) {
              finish({ success: false, error: 'Connection generation changed during packet transfer', aborted: true, timeout: false });
              return;
            }

            // Match criteria: command, offset, and size
            const isMatch = (
              packet.command === command &&
              (packet.offset === offset || ((packet.offset & 0xFF) === offsetLo && ((packet.offset >> 8) & 0xFF) === offsetHi)) &&
              packet.size <= reqSize
            );

            if (!isMatch) return;

            // Strict validity checks
            let checksumValid = packet.checksumValid;

            // Request-matched GET_INFO CMD 3 offset 0 exception:
            // Query size 56 (expectedDescriptorChecksum = 0x38 = 56) expects replyChecksum 0x38
            // Query size 38 (expectedDescriptorChecksum = 0x26 = 38) expects replyChecksum 0x26
            if (!checksumValid && command === protocol.COMMANDS.GET_INFO && offset === 0 &&
                packet.command === protocol.COMMANDS.GET_INFO && packet.offset === 0 && packet.size === 38) {
              if (packet.replyChecksum === expectedDescriptorChecksum) {
                checksumValid = true;
              }
            }

            if (!checksumValid) {
              finish({ success: false, error: 'Packet reply checksum mismatch', checksumValid: false, packet, timeout: false });
              return;
            }

            if (!packet.reservedValid) {
              finish({ success: false, error: 'Packet reply nonzero reserved byte', packet, timeout: false });
              return;
            }

            if (packet.status !== 0) {
              finish({ success: false, error: `Device returned error status: ${packet.status}`, status: packet.status, packet, timeout: false });
              return;
            }

            this.isStandby = false;
            finish({ success: true, packet, timeout: false });
          };

          this.responseListeners.add(listener);

          timer = setTimeout(() => {
            this.isStandby = true;
            this.needsReconnect = true;
            this.statusError = 'Device response timeout (standby / needs reconnect)';
            finish({ success: false, timeout: true, error: 'Device response timeout (standby / needs reconnect)' });
          }, timeoutMs);

          try {
            const buffer = protocol.encodePacket({ command, offset, size: reqSize, data: payloadData });
            didDispatch = true;
            if (typeof onDispatch === 'function') {
              try { onDispatch(); } catch {}
            }
            this.device.write(buffer);
          } catch (writeErr) {
            finish({ success: false, error: writeErr.message, timeout: false });
          }
        });
      });
    });
  }

  /**
   * Reads a range of bytes by chunking into <= 56 byte requests.
   * Enforces immutable expected generation check before and after EVERY await.
   */
  async readRange(command, offset, totalSize, timeoutMs = 1200, expectedGen = null, ownerToken = null) {
    const targetGen = expectedGen !== null ? expectedGen : this.generation;
    if (!this._firmwareOwnerAllowed(ownerToken)) {
      return { success: false, error: this._firmwareOwnershipError(), blocked: true, dispatched: false };
    }
    if (!this.device || this.generation !== targetGen) {
      return { success: false, error: 'Device not connected or generation changed' };
    }

    const chunks = [];
    for (let i = 0; i < totalSize; i += protocol.CHUNK_SIZE) {
      if (this.generation !== targetGen || !this.device) {
        return { success: false, error: 'Device disconnected or generation changed during read', offset: offset + i };
      }
      const curSize = Math.min(protocol.CHUNK_SIZE, totalSize - i);
      const res = await this.sendPacket({
        command,
        offset: offset + i,
        size: curSize,
        timeoutMs,
        expectedGen: targetGen,
        ownerToken
      });

      if (this.generation !== targetGen || !this.device) {
        return { success: false, error: 'Device disconnected or generation changed during read', offset: offset + i };
      }
      if (!res.success || !res.packet) {
        return { success: false, error: res.error || 'Failed to read chunk', offset: offset + i };
      }
      chunks.push(res.packet.data);
    }

    const combined = Buffer.concat(chunks).subarray(0, totalSize);
    return { success: true, data: combined };
  }

  /**
   * Writes a range of bytes by chunking into <= 56 byte requests.
   * Enforces immutable expected generation check before and after EVERY await.
   */
  async writeRange(command, offset, buffer, timeoutMs = 1500, expectedGen = null, ownerToken = null) {
    const targetGen = expectedGen !== null ? expectedGen : this.generation;
    if (!this._firmwareOwnerAllowed(ownerToken)) {
      return { success: false, error: this._firmwareOwnershipError(), blocked: true, dispatched: false };
    }
    if (!this.device || this.generation !== targetGen) {
      return { success: false, error: 'Device not connected or generation changed' };
    }

    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    let dispatched = false;
    for (let i = 0; i < buf.length; i += protocol.CHUNK_SIZE) {
      if (this.generation !== targetGen || !this.device) {
        return { success: false, error: 'Device disconnected or generation changed during write', offset: offset + i, dispatched };
      }
      const chunk = buf.subarray(i, i + protocol.CHUNK_SIZE);
      const res = await this.sendPacket({
        command,
        offset: offset + i,
        size: chunk.length,
        data: Array.from(chunk),
        timeoutMs,
        expectedGen: targetGen,
        ownerToken
      });

      if (this.generation !== targetGen || !this.device) {
        return { success: false, error: 'Device disconnected or generation changed during write', offset: offset + i, dispatched: dispatched || Boolean(res.dispatched) };
      }
      dispatched = dispatched || Boolean(res.dispatched);
      if (!res.success) {
        return { success: false, error: res.error || 'Failed to write chunk', offset: offset + i, dispatched };
      }
    }
    return { success: true, dispatched };
  }

  /**
   * Read-only status query: reads device info (CMD 3), base (CMD 4), and funcConfig (CMD 5).
   * Safe to call; does not alter device settings.
   * Accurately tracks read success.
   */
  async queryStatus() {
    if (this._firmwareExclusive) {
      this.lastReadSuccess = false;
      return {
        ...this.lastState,
        connected: Boolean(this.device && !this.needsReconnect),
        unavailable: true,
        updaterOwned: true,
        readSuccess: false,
        needsReconnect: this.needsReconnect,
        statusError: this._firmwareOwnershipError()
      };
    }
    if (!this.device || this.needsReconnect) {
      this.lastReadSuccess = false;
      return {
        ...this.lastState,
        connected: Boolean(this.device && !this.needsReconnect),
        unavailable: true,
        readSuccess: false,
        needsReconnect: this.needsReconnect,
        statusError: this.statusError
      };
    }

    return this.runTransaction(async (startGen) => {
      const startEpoch = this.resetEpoch;
      const stillCurrent = () => this.device && this.generation === startGen && this.resetEpoch === startEpoch;
      let readAnySuccess = false;
      try {
        // 1. Read Device Info (CMD 3)
        const infoRes = await this.readRange(protocol.COMMANDS.GET_INFO, 0, 56, 800, startGen);
        if (!stillCurrent()) {
          return {
            ...this.lastState,
            readSuccess: false,
            aborted: true,
            needsReconnect: this.needsReconnect,
            statusError: this.statusError
          };
        }
        if (infoRes.success) {
          readAnySuccess = true;
          const parsedInfo = protocol.parseInfo(infoRes.data);
          if (parsedInfo) {
            this.lastState.info = parsedInfo;
          }
        }

        // 2. Read Base Info (CMD 4)
        const baseRes = await this.readRange(protocol.COMMANDS.GET_BASE, 0, 56, 800, startGen);
        if (!stillCurrent()) {
          return {
            ...this.lastState,
            readSuccess: false,
            aborted: true,
            needsReconnect: this.needsReconnect,
            statusError: this.statusError
          };
        }
        if (baseRes.success) {
          readAnySuccess = true;
          const parsedBase = protocol.parseBase(baseRes.data);
          if (parsedBase) {
            this.lastState.base = {
              activeProfile: parsedBase.activeProfile,
              activeSlot: parsedBase.activeSlot,
              profileCount: parsedBase.profileCount,
              profileOrder: parsedBase.profileOrder
            };
            this.lastState.activeProfileIndex = parsedBase.activeProfile;
            this._rawBase = parsedBase.rawBytes;
          }
        }

        const namesRes = await this.readRange(
          protocol.COMMANDS.GET_CUSTOM_PARAM,
          profileNames.namesOffset(0),
          profileNames.PROFILE_NAMES_LENGTH,
          800,
          startGen
        );
        if (!stillCurrent()) {
          return {
            ...this.lastState,
            readSuccess: false,
            aborted: true,
            needsReconnect: this.needsReconnect,
            statusError: this.statusError
          };
        }
        if (namesRes.success && namesRes.data && namesRes.data.length === profileNames.PROFILE_NAMES_LENGTH) {
          const decoded = profileNames.decodeProfileNames(namesRes.data);
          if (decoded.valid) {
            this._applyStoredProfileNames(decoded.stored, decoded.empty ? 'default' : 'hardware');
          }
        } else if (!this.lastState.profileNames) {
          this._applyStoredProfileNames(['', '', '', ''], 'default');
        }
        this._loadProfileLibrary();

        // 3. Read FuncConfig for active profile (CMD 5, 64 bytes)
        const activeProfile = this.lastState.activeProfileIndex || 0;
        const funcRes = await this.readRange(protocol.COMMANDS.GET_FUNC_CONFIG, 64 * activeProfile, 64, 800, startGen);
        if (!stillCurrent()) {
          return {
            ...this.lastState,
            readSuccess: false,
            aborted: true,
            needsReconnect: this.needsReconnect,
            statusError: this.statusError
          };
        }
        if (funcRes.success) {
          readAnySuccess = true;
          const parsedFunc = protocol.parseFuncConfig(funcRes.data);
          if (parsedFunc) {
            this.lastState.battery = {
              batteryLevel: parsedFunc.performance.batteryLevel,
              isCharging: parsedFunc.performance.isCharging
            };
            this.lastState.lighting = parsedFunc.lighting;
            this.lastState.settings = {
              sleepTime: parsedFunc.performance.sleepTime,
              sleepMode: parsedFunc.performance.sleepMode,
              debounceLevel: parsedFunc.performance.debounceLevel,
              macMode: parsedFunc.performance.macMode,
              lockWin: parsedFunc.performance.lockWin,
              reporteRate: parsedFunc.performance.reporteRate,
              tickRate: parsedFunc.performance.tickRate,
              reportRate24G: parsedFunc.performance.reportRate24G,
              rollerType: parsedFunc.performance.rollerType
            };
            this._rawFuncConfig = parsedFunc.rawBytes;
          }
        }
      } catch (err) {
        console.warn('[Transport] queryStatus encountered error:', err.message);
      }

      this.lastReadSuccess = readAnySuccess;
      if (readAnySuccess) {
        this.statusError = null;
      }
      return {
        ...this.lastState,
        readSuccess: readAnySuccess,
        needsReconnect: this.needsReconnect,
        statusError: this.statusError
      };
    });
  }

  /**
   * Reads a full keymap layer for a given profile (Layers 0..3).
   */
  async readLayer(profileIndex = 0, layer = 0, isDefault = false) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }

    const command = isDefault
      ? protocol.COMMANDS.GET_DEFAULT_KEY_MATRIX
      : protocol.COMMANDS.GET_USER_KEY_MATRIX;
    const offset = isDefault
      ? protocol.TOTAL_KEY_AREA_SIZE * layer
      : (profileIndex * protocol.MAX_LAYERS + layer) * protocol.TOTAL_KEY_AREA_SIZE;

    const res = await this.readRange(command, offset, protocol.USED_KEY_AREA_SIZE, 1000);
    if (!res.success) {
      return res;
    }

    const keys = protocol.parseKeyMatrix(res.data, layer);
    this.lastState.keymaps[layer] = keys;
    return { success: true, keys, layer };
  }

  /**
   * Reads per-key RGB colors for a profile (CMD 10).
   */
  async readKeyColors(profileIndex = 0) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }

    const offset = profileIndex * protocol.TOTAL_KEY_AREA_SIZE;
    const res = await this.readRange(protocol.COMMANDS.GET_KEY_COLOR, offset, protocol.USED_KEY_AREA_SIZE, 1000);
    if (!res.success) {
      return res;
    }

    this._rawKeyColors = res.data;
    const colors = protocol.parseKeyColors(res.data);
    this.lastState.keyColors = colors;
    return { success: true, colors };
  }

  /**
   * Reads the full shared macro region (CMD 12).
   */
  async readMacros() {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }

    const res = await this.readRange(protocol.COMMANDS.GET_MACROS, 0, protocol.SHARED_MACRO_SIZE, 1500);
    if (!res.success) {
      return res;
    }

    this._rawMacroRegion = res.data;
    try {
      const slots = protocol.parseMacroRegion(res.data);
      this.lastState.macros = slots;
      return { success: true, macros: slots };
    } catch (parseErr) {
      return { success: false, error: `Malformed macro region: ${parseErr.message}` };
    }
  }

  /**
   * Switches the active onboard profile (CMD 14).
   * Real write operation triggered ONLY on user action.
   * Verifies write with readback.
   */
  async switchProfile(profileIndex) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    this.abortAllMusicColor();

    if (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 3) {
      return { success: false, error: 'Invalid profile index: must be 0..3' };
    }

    return this.runTransaction(async (startGen) => {
      // 1. Read latest base config from device
      const baseRes = await this.readRange(protocol.COMMANDS.GET_BASE, 0, 56, 800, startGen);
      if (!baseRes.success || !baseRes.data || baseRes.data.length !== 56) {
        return { success: false, error: `Failed to read complete base configuration before switch: ${baseRes.error || 'incomplete read'}` };
      }
      this._rawBase = baseRes.data;

      // 2. Mutate base
      let mutated;
      try {
        mutated = protocol.mutateBase(this._rawBase, profileIndex);
      } catch (err) {
        return { success: false, error: err.message };
      }

      if (this.generation !== startGen || !this.device) {
        return { success: false, error: 'Device reconnected or disconnected during transaction; aborting write' };
      }

      // 3. Write mutated base
      const writeRes = await this.writeRange(protocol.COMMANDS.SET_BASE, 0, mutated, 1500, startGen);
      if (!writeRes.success) {
        return writeRes;
      }

      // 4. Readback verification
      const verifyRes = await this.readRange(protocol.COMMANDS.GET_BASE, 0, 56, 800, startGen);
      if (!verifyRes.success || !verifyRes.data || verifyRes.data.length !== 56) {
        return { success: false, error: `Write completed but base readback verification failed: ${verifyRes.error || 'incomplete read'}` };
      }

      const verifiedBase = protocol.parseBase(verifyRes.data);
      if (!verifiedBase || verifiedBase.activeProfile !== profileIndex) {
        return { success: false, error: `Readback mismatch: active profile is ${verifiedBase?.activeProfile}, expected ${profileIndex}` };
      }

      this._rawBase = verifyRes.data;
      this.lastState.activeProfileIndex = profileIndex;
      this.lastState.base = {
        activeProfile: verifiedBase.activeProfile,
        activeSlot: verifiedBase.activeSlot,
        profileCount: verifiedBase.profileCount,
        profileOrder: verifiedBase.profileOrder
      };

      return { success: true };
    });
  }

  /**
   * Applies lighting settings to device (CMD 6).
   */
  async applyLighting(lightingParams, profileIndex = null, options = {}) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }

    const val = validateLightingParams(lightingParams);
    if (!val.valid) {
      return { success: false, error: `Invalid lighting parameters: ${val.error}` };
    }

    const targetProfile = profileIndex !== null ? profileIndex : (this.lastState.activeProfileIndex || 0);
    if (!Number.isInteger(targetProfile) || targetProfile < 0 || targetProfile > 3) {
      return { success: false, error: 'Invalid profile index: must be 0..3' };
    }

    if (Number.isInteger(lightingParams.effect) && lightingParams.effect !== 0) {
      this.abortAllMusicColor();
    }

    return this.runTransaction(async (startGen) => {
      const memGuard = this._captureMemoryGuard();
      // 1. Read latest funcConfig for the profile
      const funcRes = await this.readRange(protocol.COMMANDS.GET_FUNC_CONFIG, 64 * targetProfile, 64, 800, startGen);
      if (this.generation !== startGen || !this.device) {
        return { success: false, error: 'Device reconnected or disconnected during transaction; aborting write' };
      }
      if (!funcRes.success || !funcRes.data || funcRes.data.length !== 64) {
        return { success: false, error: `Failed to read complete 64-byte funcConfig before applying lighting: ${funcRes.error || 'incomplete read'}` };
      }

      // 2. Mutate lighting
      let mutated;
      try {
        mutated = protocol.mutateLighting(funcRes.data, lightingParams);
      } catch (err) {
        return { success: false, error: err.message };
      }

      if (this.generation !== startGen || !this.device) {
        return { success: false, error: 'Device reconnected or disconnected during transaction; aborting write' };
      }

      // 3. Write mutated config
      const writeRes = await this.writeRange(protocol.COMMANDS.SET_FUNC_CONFIG, 64 * targetProfile, mutated, 1500, startGen);
      if (!writeRes.success) {
        return writeRes;
      }

      // 4. Strict Readback verification
      const verifyRes = await this.readRange(protocol.COMMANDS.GET_FUNC_CONFIG, 64 * targetProfile, 64, 800, startGen);
      if (!verifyRes.success || !verifyRes.data || verifyRes.data.length !== 64) {
        return { success: false, error: `Lighting written but readback verification failed: ${verifyRes.error || 'incomplete readback'}` };
      }

      for (let b = 0; b < 64; b++) {
        if (b === 32 || b === 34) continue;
        if (verifyRes.data[b] !== mutated[b]) {
          return {
            success: false,
            error: `Lighting readback mismatch at byte ${b}: expected 0x${mutated[b].toString(16).padStart(2, '0')}, read 0x${verifyRes.data[b].toString(16).padStart(2, '0')}`
          };
        }
      }

      const verifiedFunc = protocol.parseFuncConfig(verifyRes.data);
      this._rawFuncConfig = verifyRes.data;
      this.lastState.lighting = verifiedFunc.lighting;

      const persistMemory = !(options && options.persistMemory === false)
        && lightingMemory.shouldPersistLightingMemory(lightingParams);
      if (!persistMemory) {
        return { success: true, memorySkipped: Boolean(options && options.persistMemory === false) };
      }

      const memRead = await this._readLightMemoryInTransaction(targetProfile, startGen, memGuard);
      if (!this._memoryGuardCurrent(memGuard)) {
        return {
          success: true,
          lightingApplied: true,
          memorySaveFailed: true,
          memoryBackend: 'unavailable',
          memoryError: 'Lighting memory identity changed after FUNC apply',
          lightMemory: { success: false, backend: 'unavailable', store: lightingMemory.emptyStore(), persisted: false }
        };
      }
      if (!memRead.success) {
        return {
          success: true,
          lightingApplied: true,
          memorySaveFailed: true,
          memoryBackend: memRead.backend || 'unavailable',
          memoryError: memRead.error || 'lighting memory was not readable after FUNC apply',
          lightMemory: { success: false, backend: memRead.backend, store: lightingMemory.emptyStore(), persisted: false }
        };
      }
      const nextStore = lightingMemory.rememberLighting(memRead.store, verifiedFunc.lighting, {
        hasSide: true
      });
      const memWrite = await this._writeLightMemoryInTransaction(
        targetProfile,
        nextStore,
        startGen,
        memGuard,
        memRead.raw || null
      );
      if (!memWrite.success) {
        return {
          success: true,
          lightingApplied: true,
          memorySaveFailed: true,
          memoryBackend: memWrite.backend || null,
          memoryError: memWrite.error || 'lighting memory save failed',
          lightMemory: { success: false, backend: memWrite.backend, store: nextStore, persisted: false }
        };
      }
      return {
        success: true,
        lightMemory: {
          success: true,
          backend: memWrite.backend,
          reason: memWrite.reason,
          store: memWrite.store,
          persisted: true
        }
      };
    });
  }

  /**
   * Applies performance and device settings (CMD 6).
   */
  async applySettings(settingsParams, profileIndex = null) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }

    const val = validateSettingsParams(settingsParams);
    if (!val.valid) {
      return { success: false, error: `Invalid settings parameters: ${val.error}` };
    }

    const targetProfile = profileIndex !== null ? profileIndex : (this.lastState.activeProfileIndex || 0);
    if (!Number.isInteger(targetProfile) || targetProfile < 0 || targetProfile > 3) {
      return { success: false, error: 'Invalid profile index: must be 0..3' };
    }

    return this.runTransaction(async (startGen) => {
      // 1. Read latest funcConfig for the profile
      const funcRes = await this.readRange(protocol.COMMANDS.GET_FUNC_CONFIG, 64 * targetProfile, 64, 800, startGen);
      if (this.generation !== startGen || !this.device) {
        return { success: false, error: 'Device reconnected or disconnected during transaction; aborting write' };
      }
      if (!funcRes.success || !funcRes.data || funcRes.data.length !== 64) {
        return { success: false, error: `Failed to read complete 64-byte funcConfig before applying settings: ${funcRes.error || 'incomplete read'}` };
      }

      // 2. Mutate settings
      let mutated;
      try {
        mutated = protocol.mutateSettings(funcRes.data, settingsParams, targetProfile);
      } catch (err) {
        return { success: false, error: err.message };
      }

      if (this.generation !== startGen || !this.device) {
        return { success: false, error: 'Device reconnected or disconnected during transaction; aborting write' };
      }

      // 3. Write mutated config
      const writeRes = await this.writeRange(protocol.COMMANDS.SET_FUNC_CONFIG, 64 * targetProfile, mutated, 1500, startGen);
      if (!writeRes.success) {
        return writeRes;
      }

      // 4. Strict Readback verification
      const verifyRes = await this.readRange(protocol.COMMANDS.GET_FUNC_CONFIG, 64 * targetProfile, 64, 800, startGen);
      if (!verifyRes.success || !verifyRes.data || verifyRes.data.length !== 64) {
        return { success: false, error: `Settings written but readback verification failed: ${verifyRes.error || 'incomplete readback'}` };
      }

      for (let b = 0; b < 64; b++) {
        if (b === 32 || b === 34) continue;
        if (verifyRes.data[b] !== mutated[b]) {
          return {
            success: false,
            error: `Settings readback mismatch at byte ${b}: expected 0x${mutated[b].toString(16).padStart(2, '0')}, read 0x${verifyRes.data[b].toString(16).padStart(2, '0')}`
          };
        }
      }

      const verifiedFunc = protocol.parseFuncConfig(verifyRes.data);
      this._rawFuncConfig = verifyRes.data;
      this.lastState.settings = {
        sleepTime: verifiedFunc.performance.sleepTime,
        sleepMode: verifiedFunc.performance.sleepMode,
        debounceLevel: verifiedFunc.performance.debounceLevel,
        macMode: verifiedFunc.performance.macMode,
        lockWin: verifiedFunc.performance.lockWin,
        reporteRate: verifiedFunc.performance.reporteRate,
        tickRate: verifiedFunc.performance.tickRate,
        reportRate24G: verifiedFunc.performance.reportRate24G,
        rollerType: verifiedFunc.performance.rollerType
      };

      return { success: true };
    });
  }

  /**
   * Applies key remappings to device (CMD 9).
   * Shared MT/TGL paste uses allowSharedAdvancedRefs and never writes table bytes.
   */
  async applyKeymap(profileIndex, layer, keyUpdates, options) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }

    if (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 3) {
      return { success: false, error: 'Invalid profile index: must be 0..3' };
    }
    if (!Number.isInteger(layer) || layer < 0 || layer > 3) {
      return { success: false, error: 'Invalid layer: must be 0..3' };
    }

    const val = validateKeymapUpdates(keyUpdates);
    if (!val.valid) {
      return { success: false, error: `Invalid keymap updates: ${val.error}` };
    }

    if (!Array.isArray(keyUpdates) || keyUpdates.length === 0) {
      return { success: true, written: 0 };
    }

    const expectedRefs = options && Array.isArray(options.expectedRefs) ? options.expectedRefs : [];
    const expectedMacroRefs = options && Array.isArray(options.expectedMacroRefs) ? options.expectedMacroRefs : [];
    const allowShared = Boolean(options && options.allowSharedAdvancedRefs) && expectedRefs.length > 0;
    for (const update of keyUpdates) {
      if (update.type === 148) {
        return {
          success: false,
          error: 'MT/TGL/SOCD bindings must be saved or removed through the Advanced API, not generic remap'
        };
      }
      if ((update.type === 145 || update.type === 146) && !allowShared) {
        return {
          success: false,
          error: 'MT/TGL/SOCD bindings must be saved or removed through the Advanced API, not generic remap'
        };
      }
    }

    return this.runTransaction(async (startGen) => {
      let planned = keyUpdates.map((u) => ({
        slot: u.slot !== undefined ? u.slot : u.index,
        type: u.type,
        code1: u.code1,
        code2: u.code2
      }));
      if (expectedMacroRefs.length > 0) {
        const macroRes = await this.readRange(
          protocol.COMMANDS.GET_MACROS,
          0,
          protocol.SHARED_MACRO_SIZE,
          1500,
          startGen
        );
        if (!macroRes.success || !macroRes.data || macroRes.data.length !== protocol.SHARED_MACRO_SIZE) {
          return { success: false, error: `Failed to read macro bank before paste: ${macroRes.error || 'incomplete read'}` };
        }
        let parsedMacros;
        try {
          parsedMacros = protocol.parseMacroRegion(macroRes.data);
        } catch (err) {
          return { success: false, error: `Malformed macro region: ${err.message}` };
        }
        const identity = keyConfig.identitySlotsFromParsed(parsedMacros, protocol.getNormalizedBodyKey);
        const resolved = keyConfig.resolveExpectedMacroUpdates(planned, identity, expectedMacroRefs);
        if (!resolved.ok) {
          return {
            success: false,
            error: resolved.error,
            rejectStage: 'applyKeymap',
            want: resolved.want,
            have: resolved.have
          };
        }
        planned = resolved.planned;
      }
      if (allowShared) {
        const mtRes = await this.readRange(
          protocol.COMMANDS.GET_MT_KEYS,
          profileIndex * protocol.MT_TABLE_SIZE,
          protocol.MT_TABLE_SIZE,
          1000,
          startGen
        );
        if (!mtRes.success || !mtRes.data || mtRes.data.length !== protocol.MT_TABLE_SIZE) {
          return { success: false, error: `Failed to read MT table before shared paste: ${mtRes.error || 'incomplete read'}` };
        }
        const tglRes = await this.readRange(
          protocol.COMMANDS.GET_TGL_KEYS,
          profileIndex * protocol.TGL_TABLE_SIZE,
          protocol.TGL_TABLE_SIZE,
          1000,
          startGen
        );
        if (!tglRes.success || !tglRes.data || tglRes.data.length !== protocol.TGL_TABLE_SIZE) {
          return { success: false, error: `Failed to read TGL table before shared paste: ${tglRes.error || 'incomplete read'}` };
        }
        const layersRes = await this._readProfileLayers(profileIndex, startGen);
        if (!layersRes.success) return layersRes;
        const maps = { 0: {}, 1: {}, 2: {}, 3: {} };
        for (let l = 0; l < 4; l++) {
          const buf = layersRes.layers[l];
          const count = Math.floor(buf.length / 3);
          for (let slot = 0; slot < count; slot++) {
            maps[l][slot] = {
              type: buf[slot * 3],
              code1: buf[slot * 3 + 1],
              code2: buf[slot * 3 + 2]
            };
          }
        }
        for (const ref of expectedRefs) {
          if (!ref || (ref.type !== 145 && ref.type !== 146)) {
            return { success: false, error: 'Shared advanced paste is missing table content' };
          }
          const size = keyConfig.tableEntrySize(ref.type);
          const table = ref.type === 146 ? mtRes.data : tglRes.data;
          const found = keyConfig.findMatchingTableIndex(table, ref.bytes, size, ref.index);
          if (found < 0) {
            return { success: false, error: 'MT/TGL table content no longer matches the copied binding' };
          }
          if (!keyConfig.canShareAdvanced({ type: ref.type, code1: found, code2: 0 }, maps)) {
            return { success: false, error: 'MT/TGL paste would write an unreferenced table index' };
          }
          for (const item of planned) {
            if (item.type === ref.type && item.code1 === ref.index) item.code1 = found;
          }
        }
      }

      const baseOffset = (profileIndex * protocol.MAX_LAYERS + layer) * protocol.TOTAL_KEY_AREA_SIZE;

      // 1. Pre-read layer
      const preRes = await this.readRange(protocol.COMMANDS.GET_USER_KEY_MATRIX, baseOffset, protocol.USED_KEY_AREA_SIZE, 1000, startGen);
      if (!preRes.success || !preRes.data || preRes.data.length !== protocol.USED_KEY_AREA_SIZE) {
        return { success: false, error: `Failed to read existing keymap layer before write: ${preRes.error || 'incomplete read'}` };
      }

      if (this.generation !== startGen || !this.device) {
        return { success: false, error: 'Device reconnected or disconnected during transaction; aborting write' };
      }

      const defRes = await this.readRange(
        protocol.COMMANDS.GET_DEFAULT_KEY_MATRIX,
        layer * protocol.TOTAL_KEY_AREA_SIZE,
        protocol.USED_KEY_AREA_SIZE,
        1000,
        startGen
      );
      const defaultLayerBuf = (defRes.success && defRes.data && defRes.data.length === protocol.USED_KEY_AREA_SIZE)
        ? defRes.data
        : null;
      if (!defaultLayerBuf) {
        try {
          getDefaultTuple(layer, 0);
        } catch (err) {
          return { success: false, error: `Immutable defaults unavailable for SOCD guard: ${err.message}` };
        }
      }

      const socdGuard = this._guardSocdRemap(preRes.data, layer, planned, defaultLayerBuf);
      if (!socdGuard.ok) {
        return { success: false, error: socdGuard.error };
      }

      // 2. Write key updates (planned indexes after in-transaction table verify)
      for (const update of planned) {
        if (this.generation !== startGen || !this.device) {
          return { success: false, error: 'Device reconnected or disconnected during transaction; aborting write' };
        }

        const slot = update.slot !== undefined ? update.slot : update.index;
        const keyOffset = baseOffset + slot * 3;
        const keyData = [update.type, update.code1, update.code2];

        const writeRes = await this.sendPacket({
          command: protocol.COMMANDS.SET_USER_KEY_MATRIX,
          offset: keyOffset,
          size: 3,
          data: keyData,
          timeoutMs: 800,
          expectedGen: startGen
        });

        if (!writeRes.success) {
          return { success: false, error: writeRes.error, slot };
        }
      }

      if (this.generation !== startGen || !this.device) {
        return { success: false, error: 'Device reconnected or disconnected during transaction; aborting write' };
      }

      // 3. Readback verify layer
      const verifyRes = await this.readRange(
        protocol.COMMANDS.GET_USER_KEY_MATRIX,
        baseOffset,
        protocol.USED_KEY_AREA_SIZE,
        1000,
        startGen
      );

      if (!verifyRes.success || !verifyRes.data || verifyRes.data.length !== protocol.USED_KEY_AREA_SIZE) {
        return { success: false, error: `Keymap written but layer readback verification failed: ${verifyRes.error || 'incomplete readback'}` };
      }

      for (const update of planned) {
        const slot = update.slot !== undefined ? update.slot : update.index;
        const offset = slot * 3;
        const rType = verifyRes.data[offset];
        const rC1 = verifyRes.data[offset + 1];
        const rC2 = verifyRes.data[offset + 2];
        const expectedType = update.type;
        const expectedC1 = update.code1;
        const expectedC2 = update.code2;

        if (rType !== expectedType || rC1 !== expectedC1 || rC2 !== expectedC2) {
          return {
            success: false,
            error: `Readback mismatch at slot ${slot}: expected [${expectedType}, ${expectedC1}, ${expectedC2}], read [${rType}, ${rC1}, ${rC2}]`
          };
        }
      }

      const keys = protocol.parseKeyMatrix(verifyRes.data, layer);
      this.lastState.keymaps[layer] = keys;

      return { success: true, written: planned.length, planned };
    });
  }

  /**
   * Applies per-key RGB colors to device (CMD 11).
   */
  async applyKeyColors(profileIndex, colors) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }

    if (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 3) {
      return { success: false, error: 'Invalid profile index: must be 0..3' };
    }

    const val = validateKeyColors(colors);
    if (!val.valid) {
      return { success: false, error: `Invalid key colors: ${val.error}` };
    }

    return this.runTransaction(async (startGen) => {
      const offset = profileIndex * protocol.TOTAL_KEY_AREA_SIZE;

      // 1. Read existing colors
      const readRes = await this.readRange(protocol.COMMANDS.GET_KEY_COLOR, offset, protocol.USED_KEY_AREA_SIZE, 1000, startGen);
      if (!readRes.success || !readRes.data || readRes.data.length !== protocol.USED_KEY_AREA_SIZE) {
        return { success: false, error: `Failed to read complete key colors before write: ${readRes.error || 'incomplete read'}` };
      }

      // 2. Serialize updated colors
      const serialized = protocol.serializeKeyColors(colors, readRes.data);

      if (this.generation !== startGen || !this.device) {
        return { success: false, error: 'Device reconnected or disconnected during transaction; aborting write' };
      }

      // 3. Write with CMD 11
      const writeRes = await this.writeRange(protocol.COMMANDS.SET_KEY_COLOR, offset, serialized, 1500, startGen);
      if (!writeRes.success) {
        return writeRes;
      }

      // 4. Strict Readback verification
      const verifyRes = await this.readRange(protocol.COMMANDS.GET_KEY_COLOR, offset, protocol.USED_KEY_AREA_SIZE, 1000, startGen);
      if (!verifyRes.success || !verifyRes.data || verifyRes.data.length !== protocol.USED_KEY_AREA_SIZE) {
        return { success: false, error: `Key colors written but readback verification failed: ${verifyRes.error || 'incomplete readback'}` };
      }

      for (let b = 0; b < protocol.USED_KEY_AREA_SIZE; b++) {
        if (verifyRes.data[b] !== serialized[b]) {
          const slot = Math.floor(b / 3);
          return {
            success: false,
            error: `Key colors readback mismatch at byte ${b} (slot ${slot}): expected 0x${serialized[b].toString(16).padStart(2, '0')}, read 0x${verifyRes.data[b].toString(16).padStart(2, '0')}`
          };
        }
      }

      this._rawKeyColors = verifyRes.data;
      const parsedColors = protocol.parseKeyColors(verifyRes.data);
      this.lastState.keyColors = parsedColors;

      return { success: true };
    });
  }

  _genOk(startGen) {
    return Boolean(this.device) && this.generation === startGen && !this.needsReconnect;
  }

  _failPartial({ error, completedSections = [], failedSection = null, uncertain = false, extra = {} }) {
    return {
      success: false,
      error,
      completedSections,
      failedSection,
      uncertain,
      ...extra
    };
  }

  /**
   * Write a region then compare the full readback. `ignoreBytes` is a Set of local offsets
   * (used for live funcConfig bytes 32/34).
   */
  async _writeVerify(writeCommand, offset, buffer, startGen, options = {}) {
    const writeRes = await this.writeRange(
      writeCommand,
      offset,
      buffer,
      options.timeoutMs || 1500,
      startGen,
      options.ownerToken || null
    );
    if (!writeRes.success) {
      return this._failPartial({
        error: writeRes.error || 'Write failed',
        completedSections: options.completedSections || [],
        failedSection: options.section || null,
        uncertain: false,
        extra: { dispatched: Boolean(writeRes.dispatched) }
      });
    }
    if (!this._genOk(startGen)) {
      return this._failPartial({
        error: 'Device reconnected or disconnected during transaction; aborting write',
        completedSections: options.completedSections || [],
        failedSection: options.section || null,
        uncertain: true,
        extra: { dispatched: true }
      });
    }
    const readCommand = protocol.WRITE_TO_READ_COMMAND[writeCommand];
    if (readCommand === undefined) {
      return this._failPartial({
        error: `No readback command mapped for write opcode ${writeCommand}`,
        completedSections: options.completedSections || [],
        failedSection: options.section || null,
        uncertain: true,
        extra: { dispatched: true }
      });
    }
    const verifyRes = await this.readRange(
      readCommand,
      offset,
      buffer.length,
      options.timeoutMs || 1500,
      startGen,
      options.ownerToken || null
    );
    if (!verifyRes.success || !verifyRes.data || verifyRes.data.length !== buffer.length) {
      return this._failPartial({
        error: `${options.section || 'Region'} written but readback verification failed: ${verifyRes.error || 'incomplete readback'}`,
        completedSections: options.completedSections || [],
        failedSection: options.section || null,
        uncertain: true,
        extra: { dispatched: true }
      });
    }
    const ignore = options.ignoreBytes instanceof Set ? options.ignoreBytes : new Set();
    for (let b = 0; b < buffer.length; b++) {
      if (ignore.has(b)) continue;
      if (verifyRes.data[b] !== buffer[b]) {
        return this._failPartial({
          error: `${options.section || 'Region'} readback mismatch at byte ${b}: expected 0x${buffer[b].toString(16).padStart(2, '0')}, read 0x${verifyRes.data[b].toString(16).padStart(2, '0')}`,
          completedSections: options.completedSections || [],
          failedSection: options.section || null,
          uncertain: true,
          extra: { dispatched: true }
        });
      }
    }
    return { success: true, data: verifyRes.data, dispatched: true };
  }

  async _readUserLayer(profileIndex, layer, startGen) {
    const offset = protocol.userLayerOffset(profileIndex, layer);
    return this.readRange(protocol.COMMANDS.GET_USER_KEY_MATRIX, offset, protocol.USED_KEY_AREA_SIZE, 1000, startGen);
  }

  async _writeKeyTriples(profileIndex, layer, updates, startGen, options = {}) {
    const baseOffset = protocol.userLayerOffset(profileIndex, layer);
    for (const update of updates) {
      if (!this._genOk(startGen)) {
        return this._failPartial({
          error: 'Device reconnected or disconnected during transaction; aborting write',
          completedSections: options.completedSections || [],
          failedSection: options.section || 'binding',
          uncertain: false
        });
      }
      const slot = update.slot !== undefined ? update.slot : update.index;
      const writeRes = await this.sendPacket({
        command: protocol.COMMANDS.SET_USER_KEY_MATRIX,
        offset: baseOffset + slot * 3,
        size: 3,
        data: [update.type, update.code1, update.code2],
        timeoutMs: 800,
        expectedGen: startGen
      });
      if (!writeRes.success) {
        return this._failPartial({
          error: writeRes.error || `Failed to write key slot ${slot}`,
          completedSections: options.completedSections || [],
          failedSection: options.section || 'binding',
          uncertain: false,
          extra: { slot }
        });
      }
    }
    const verifyRes = await this.readRange(
      protocol.COMMANDS.GET_USER_KEY_MATRIX,
      baseOffset,
      protocol.USED_KEY_AREA_SIZE,
      1000,
      startGen
    );
    if (!verifyRes.success || !verifyRes.data || verifyRes.data.length !== protocol.USED_KEY_AREA_SIZE) {
      return this._failPartial({
        error: `Keymap written but layer readback verification failed: ${verifyRes.error || 'incomplete readback'}`,
        completedSections: options.completedSections || [],
        failedSection: options.section || 'binding',
        uncertain: true
      });
    }
    for (const update of updates) {
      const slot = update.slot !== undefined ? update.slot : update.index;
      const off = slot * 3;
      if (verifyRes.data[off] !== update.type ||
          verifyRes.data[off + 1] !== update.code1 ||
          verifyRes.data[off + 2] !== update.code2) {
        return this._failPartial({
          error: `Readback mismatch at slot ${slot}: expected [${update.type}, ${update.code1}, ${update.code2}], read [${verifyRes.data[off]}, ${verifyRes.data[off + 1]}, ${verifyRes.data[off + 2]}]`,
          completedSections: options.completedSections || [],
          failedSection: options.section || 'binding',
          uncertain: true
        });
      }
    }
    return { success: true, data: verifyRes.data };
  }

  _guardSocdRemap(layerBuf, layer, keyUpdates, defaultLayerBuf = null) {
    const updateMap = new Map();
    for (const u of keyUpdates) {
      const slot = u.slot !== undefined ? u.slot : u.index;
      updateMap.set(slot, u);
    }
    const seenPairs = new Set();
    const count = Math.floor(layerBuf.length / 3);
    for (let slot = 0; slot < count; slot++) {
      const type = layerBuf[slot * 3];
      if (type !== protocol.KEY_TYPES.SOCD) continue;
      if (!protocol.isReciprocalSocd(layerBuf, slot)) continue;
      const partner = layerBuf[slot * 3 + 2];
      const pairKey = slot < partner ? `${slot}:${partner}` : `${partner}:${slot}`;
      if (seenPairs.has(pairKey)) continue;
      if (!updateMap.has(slot) && !updateMap.has(partner)) continue;
      seenPairs.add(pairKey);
      if (!updateMap.has(slot) || !updateMap.has(partner)) {
        return {
          ok: false,
          error: `Slot ${slot} is part of an SOCD pair with slot ${partner}. Remove the pair in Advanced first (or restore both keys to their defaults together).`
        };
      }
      let defSlot;
      let defPartner;
      try {
        defSlot = this._resolveDefaultTuple(layer, slot, defaultLayerBuf ? { [layer]: defaultLayerBuf } : null);
        defPartner = this._resolveDefaultTuple(layer, partner, defaultLayerBuf ? { [layer]: defaultLayerBuf } : null);
      } catch (err) {
        return {
          ok: false,
          error: `Immutable default tuples unavailable for SOCD pair ${slot}/${partner}: ${err.message}`
        };
      }
      const uSlot = updateMap.get(slot);
      const uPartner = updateMap.get(partner);
      const slotDefault = uSlot.type === defSlot[0] && uSlot.code1 === defSlot[1] && uSlot.code2 === defSlot[2];
      const partnerDefault = uPartner.type === defPartner[0] && uPartner.code1 === defPartner[1] && uPartner.code2 === defPartner[2];
      if (uSlot.type === 148 || uPartner.type === 148 || !slotDefault || !partnerDefault) {
        return {
          ok: false,
          error: `SOCD pair ${slot}/${partner} cannot be rewritten via generic remap. Remove the pair in Advanced first.`
        };
      }
    }
    return { ok: true };
  }

  _parseLayerUpdates(rawLayer) {
    const updates = [];
    if (!rawLayer) return updates;
    if (Array.isArray(rawLayer)) {
      for (const u of rawLayer) {
        if (!u || typeof u !== 'object') continue;
        const slot = u.slot !== undefined ? u.slot : u.index;
        if (VALID_PHYSICAL_SLOTS.has(slot)) {
          updates.push({ slot, type: u.type, code1: u.code1, code2: u.code2 });
        }
      }
    } else if (typeof rawLayer === 'object') {
      for (const [slotStr, def] of Object.entries(rawLayer)) {
        const slot = Number(slotStr);
        if (VALID_PHYSICAL_SLOTS.has(slot) && def && typeof def === 'object') {
          updates.push({ slot, type: def.type, code1: def.code1, code2: def.code2 });
        }
      }
    }
    return updates;
  }

  _layersAreCompletePhysical(preparedLayers) {
    if (!preparedLayers || preparedLayers.length !== 4) return false;
    for (const { updates } of preparedLayers) {
      const slots = new Set(updates.map((u) => u.slot));
      if (slots.size !== VALID_PHYSICAL_SLOTS.size) return false;
      for (const s of VALID_PHYSICAL_SLOTS) {
        if (!slots.has(s)) return false;
      }
    }
    return true;
  }

  _mergeImportedTable({ kind, imported, device, mergedLayers, importTouch, entrySize, reservedOffset }) {
    const prepared = Buffer.from(device);
    const finalRefs = protocol.collectAdvancedReferences(mergedLayers);
    const ownersMap = kind === 'mt' ? finalRefs.mtOwners : finalRefs.tglOwners;
    const capacity = 32;
    for (let index = 0; index < capacity; index++) {
      const owners = ownersMap.get(index) || [];
      const hasUntouched = owners.some((o) => !importTouch[o.layer] || !importTouch[o.layer].has(o.slot));
      const off = index * entrySize;
      if (hasUntouched) {
        if (!protocol.tableSliceEqual(imported, device, off, entrySize)) {
          return {
            ok: false,
            error: `Import would overwrite ${kind.toUpperCase()} table index ${index} still referenced by an unimported key. Include all 4 physical keymap layers (82 keys each) when replacing advanced tables.`
          };
        }
        continue;
      }
      if (owners.length > 0) {
        imported.copy(prepared, off, off, off + entrySize);
      }
    }
    return { ok: true, buffer: protocol.preserveReservedTail(prepared, device, reservedOffset) };
  }

  async _readProfileLayers(profileIndex, startGen) {
    const layers = [];
    for (let l = 0; l < 4; l++) {
      if (!this._genOk(startGen)) {
        return { success: false, error: 'Device reconnected or disconnected during transaction; aborting write' };
      }
      const res = await this._readUserLayer(profileIndex, l, startGen);
      if (!res.success || !res.data || res.data.length !== protocol.USED_KEY_AREA_SIZE) {
        return { success: false, error: `Failed to read layer ${l} for profile ${profileIndex}: ${res.error || 'incomplete read'}` };
      }
      layers.push(res.data);
    }
    return { success: true, layers };
  }

  async _readDefaultLayers(startGen) {
    const layers = [];
    for (let l = 0; l < 4; l++) {
      if (!this._genOk(startGen)) {
        return { success: false, error: 'Device reconnected or disconnected during transaction; aborting write' };
      }
      const offset = l * protocol.TOTAL_KEY_AREA_SIZE;
      const res = await this.readRange(
        protocol.COMMANDS.GET_DEFAULT_KEY_MATRIX,
        offset,
        protocol.USED_KEY_AREA_SIZE,
        1000,
        startGen
      );
      if (!res.success || !res.data || res.data.length !== protocol.USED_KEY_AREA_SIZE) {
        return { success: false, error: `Failed to read immutable default layer ${l} (CMD 7): ${res.error || 'incomplete read'}` };
      }
      layers.push(res.data);
    }
    return { success: true, layers };
  }

  _resolveDefaultTuple(layer, slot, defaultLayers) {
    const buf = defaultLayers && defaultLayers[layer];
    if (buf && Number.isInteger(slot) && slot >= 0 && (slot * 3 + 2) < buf.length) {
      return [buf[slot * 3], buf[slot * 3 + 1], buf[slot * 3 + 2]];
    }
    return getDefaultTuple(layer, slot);
  }



  /**
   * Install an in-memory HID adapter for development mock-UI tests.
   * Never enumerates or opens node-hid. Packaged apps must not call this.
   */
  installTestAdapter(mockDevice, deviceMeta = {}) {
    if (this._firmwareExclusive) {
      return { success: false, error: this._firmwareOwnershipError(), updaterOwned: true };
    }
    this.disconnect();
    if (typeof mockDevice.reopen === 'function') mockDevice.reopen();
    this.device = mockDevice;
    this.needsReconnect = false;
    this.statusError = null;
    this.lastState.connected = true;
    this.lastState.device = {
      vendorId: 14391,
      productId: 12339,
      hexVendorId: '0x3837',
      hexProductId: '0x3033',
      product: deviceMeta.product || 'MCHOSE G75 V2 (Mock)',
      manufacturer: 'MCHOSE',
      serialNumber: deviceMeta.serialNumber || 'MOCK',
      path: 'mock://g75v2',
      interface: 1,
      usagePage: 1,
      usage: 0,
      locationId: deviceMeta.locationId != null ? deviceMeta.locationId : 0x02400000,
      registryEntryId: deviceMeta.registryEntryId != null ? deviceMeta.registryEntryId : 4295538287,
      registryPath: 'mock://g75v2',
      isReceiver: true,
      mock: true
    };
    this.deviceInfo = { ...this.lastState.device };
    this.firmwareTopologyIdentity = { ...this.lastState.device };
    this._bindDeviceListeners(mockDevice);
    this.listDevices = () => [];
    this.connect = (targetPath = null, options = {}) => {
      const ownerToken = options && options.firmwareOwner ? options.firmwareOwner : null;
      if (!this._firmwareOwnerAllowed(ownerToken)) {
        return { success: false, error: this._firmwareOwnershipError(), updaterOwned: true };
      }
      const expectedPath = (this.lastState.device && this.lastState.device.path) || 'mock://g75v2';
      if (targetPath && targetPath !== expectedPath) {
        return { success: false, error: `Requested device path not found: ${targetPath}` };
      }
      if (typeof mockDevice.reopen === 'function') mockDevice.reopen();
      this.device = mockDevice;
      this.needsReconnect = false;
      this.statusError = null;
      const preserved = this.firmwareTopologyIdentity || this.deviceInfo || this.lastState.device;
      if (preserved) {
        this.deviceInfo = { ...preserved };
        this.lastState.device = { ...preserved };
        this.firmwareTopologyIdentity = { ...preserved };
      }
      this.lastState.connected = true;
      this._bindDeviceListeners(mockDevice);
      return { success: true, device: this.lastState.device };
    };
    this.findControlInterface = () => null;
    this._loadLightMemoryPreference();
    this._loadStillLibrary();
    this._loadGifLibrary();
    this._loadProfileLibrary();
    this._notifyStateChange();
    return { success: true, device: this.lastState.device };
  }

  /**
   * Capture the complete onboard configuration for a firmware update.
   * The firmware-backup module owns the read plan and atomic persistence; this
   * wrapper intentionally does not enumerate, open, or mutate a device.
   */
  async backupFirmwareConfiguration(options = {}) {
    const firmwareBackup = require('./firmware-backup.cjs');
    return firmwareBackup.captureFirmwareBackup(this, options);
  }

  /**
   * Restore a validated complete firmware backup through the serialized
   * transport. Callers must suspend/drain the normal watcher and ensure this
   * transport owns the reviewed normal handle before invoking the method.
   */
  async restoreFirmwareConfiguration(source, options = {}) {
    const firmwareBackup = require('./firmware-backup.cjs');
    return firmwareBackup.restoreFirmwareBackup(this, source, options);
  }

  async _readLightMemoryInTransaction(profileIndex, startGen, captured = null) {
    const guard = captured || this._captureMemoryGuard();
    if (!this._memoryGuardCurrent(guard) || startGen !== this.generation) {
      return { success: false, backend: 'unavailable', error: 'Lighting memory identity changed before read' };
    }
    const useLocal = (guard.fallback || this.lightMemoryFallback) === 'local';
    if (useLocal) {
      try {
        const doc = lightingMemory.parseLocalDocument(this._lightingMemoryFile());
        if (!doc.ok) {
          return {
            success: false,
            backend: 'local',
            error: doc.error || 'Local lighting memory file is unreadable',
            recovered: true,
            unwritable: true,
            store: lightingMemory.emptyStore(),
            readProven: false
          };
        }
        const store = lightingMemory.readLocalProfile(this._lightingMemoryFile(), guard.deviceKey, profileIndex);
        if (!this._memoryGuardCurrent(guard)) {
          return { success: false, backend: 'unavailable', error: 'Lighting memory identity changed during local read' };
        }
        const result = { success: true, backend: 'local', reason: 'explicit-local-fallback', store, readProven: false };
        this._lightMemoryCache = { profile: profileIndex, deviceKey: guard.deviceKey, ...result };
        return result;
      } catch (err) {
        return { success: false, backend: 'local', error: err.message || String(err) };
      }
    }
    const offset = lightingMemory.lightingMemoryOffset(profileIndex);
    const hwRes = await this.readRange(
      protocol.COMMANDS.GET_CUSTOM_PARAM,
      offset,
      lightingMemory.LIGHT_MEMORY_LENGTH,
      800,
      startGen
    );
    if (!this._memoryGuardCurrent(guard) || startGen !== this.generation) {
      return { success: false, backend: 'unavailable', error: 'Lighting memory identity changed during hardware read' };
    }
    if (hwRes.success && hwRes.data && hwRes.data.length === lightingMemory.LIGHT_MEMORY_LENGTH) {
      this._lightMemoryHardwareOk = true;
      const parsed = lightingMemory.parseLightMemory(hwRes.data);
      if (!parsed.valid) {
        return {
          success: false,
          backend: 'hardware',
          error: parsed.error,
          store: lightingMemory.emptyStore(),
          readProven: true
        };
      }
      const result = {
        success: true,
        backend: 'hardware',
        empty: Boolean(parsed.empty),
        store: parsed.store,
        raw: parsed.raw,
        readProven: true
      };
      this._lightMemoryCache = { profile: profileIndex, deviceKey: guard.deviceKey, ...result };
      return result;
    }
    return {
      success: false,
      backend: 'unavailable',
      error: hwRes.error || 'incomplete custom-param read',
      store: lightingMemory.emptyStore(),
      readProven: false
    };
  }

  async _writeLightMemoryInTransaction(profileIndex, store, startGen, captured = null, priorBuf = null) {
    const guard = captured || this._captureMemoryGuard();
    const normalized = lightingMemory.normalizeLightMemory(store);
    if (!this._memoryGuardCurrent(guard) || startGen !== this.generation) {
      return { success: false, backend: 'unavailable', error: 'Lighting memory identity changed before write' };
    }
    const useLocal = (guard.fallback || this.lightMemoryFallback) === 'local';
    if (useLocal) {
      try {
        lightingMemory.writeLocalProfile(this._lightingMemoryFile(), guard.deviceKey, profileIndex, normalized);
        if (!this._memoryGuardCurrent(guard)) {
          return { success: false, backend: 'unavailable', error: 'Lighting memory identity changed during local write' };
        }
        this._lightMemoryCache = {
          profile: profileIndex,
          deviceKey: guard.deviceKey,
          success: true,
          backend: 'local',
          reason: 'explicit-local-fallback',
          store: normalized
        };
        return { success: true, backend: 'local', reason: 'explicit-local-fallback', store: normalized };
      } catch (err) {
        return { success: false, backend: 'local', error: err.message || String(err) };
      }
    }
    const offset = lightingMemory.lightingMemoryOffset(profileIndex);
    let prior = priorBuf;
    if (!prior) {
      const priorRes = await this.readRange(
        protocol.COMMANDS.GET_CUSTOM_PARAM,
        offset,
        lightingMemory.LIGHT_MEMORY_LENGTH,
        800,
        startGen
      );
      if (!this._memoryGuardCurrent(guard) || startGen !== this.generation) {
        return { success: false, backend: 'unavailable', error: 'Lighting memory identity changed during prior read' };
      }
      if (!priorRes.success || !priorRes.data || priorRes.data.length !== lightingMemory.LIGHT_MEMORY_LENGTH) {
        return {
          success: false,
          backend: 'unavailable',
          error: `Failed to read lighting memory before write: ${priorRes.error || 'incomplete read'}`
        };
      }
      prior = priorRes.data;
      this._lightMemoryHardwareOk = true;
    }
    const parsedPrior = lightingMemory.parseLightMemory(prior);
    if (!parsedPrior.valid) {
      return {
        success: false,
        backend: 'hardware',
        error: parsedPrior.error || 'malformed lighting memory prior; CMD 242 was not sent'
      };
    }
    const payload = lightingMemory.serializeLightMemory(normalized, prior);
    const writeRes = await this.writeRange(
      protocol.COMMANDS.SET_CUSTOM_PARAM,
      offset,
      payload,
      1500,
      startGen
    );
    if (!this._memoryGuardCurrent(guard) || startGen !== this.generation) {
      return { success: false, backend: 'unavailable', error: 'Lighting memory identity changed during hardware write' };
    }
    if (!writeRes.success) {
      return { success: false, backend: 'hardware', error: writeRes.error || 'lighting memory write failed' };
    }
    const verifyRes = await this.readRange(
      protocol.COMMANDS.GET_CUSTOM_PARAM,
      offset,
      lightingMemory.LIGHT_MEMORY_LENGTH,
      800,
      startGen
    );
    if (!this._memoryGuardCurrent(guard) || startGen !== this.generation) {
      return { success: false, backend: 'unavailable', error: 'Lighting memory identity changed during readback' };
    }
    if (!verifyRes.success || !verifyRes.data || verifyRes.data.length !== lightingMemory.LIGHT_MEMORY_LENGTH) {
      return {
        success: false,
        backend: 'hardware',
        error: `Lighting memory written but readback failed: ${verifyRes.error || 'incomplete readback'}`
      };
    }
    for (let i = 0; i < lightingMemory.LIGHT_MEMORY_LENGTH; i++) {
      if (verifyRes.data[i] !== payload[i]) {
        return {
          success: false,
          backend: 'hardware',
          error: `Lighting memory readback mismatch at byte ${i}`
        };
      }
    }
    this._lightMemoryCache = {
      profile: profileIndex,
      deviceKey: guard.deviceKey,
      success: true,
      backend: 'hardware',
      store: normalized,
      readProven: true
    };
    return { success: true, backend: 'hardware', store: normalized };
  }

  clearLightingMemoryFallback(scope, profileIndex = null) {
    try {
      const key = this._lightingDeviceKey();
      const device = this.lastState.device || {};
      if (scope === 'all') {
        lightingMemory.clearLocalProfiles(this._lightingMemoryFile(), key, null, device);
      } else {
        const idx = Number.isInteger(profileIndex) ? profileIndex : this.lastState.activeProfileIndex || 0;
        lightingMemory.clearLocalProfiles(this._lightingMemoryFile(), key, idx, device);
      }
    } catch {
      // local cleanup is best-effort; hardware confirmation is separate
    }
    this._lightMemoryCache = null;
  }

  async readFuncConfig(profileIndex = 0) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    if (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 3) {
      return { success: false, error: 'Invalid profile index: must be 0..3' };
    }
    return this.runTransaction(async (startGen) => {
      const funcRes = await this.readRange(protocol.COMMANDS.GET_FUNC_CONFIG, 64 * profileIndex, 64, 800, startGen);
      if (!funcRes.success || !funcRes.data || funcRes.data.length !== 64) {
        return { success: false, error: `Failed to read funcConfig: ${funcRes.error || 'incomplete read'}` };
      }
      const parsed = protocol.parseFuncConfig(funcRes.data);
      if (!parsed) return { success: false, error: 'Failed to parse funcConfig' };
      const memory = await this._readLightMemoryInTransaction(profileIndex, startGen, this._captureMemoryGuard());
      const selected = await this._readSelectedLightEffectInTransaction(profileIndex, startGen, this._captureMemoryGuard());
      if (selected.success) {
        this._publishSelectedPair(profileIndex, selected.pair);
      }
      this._loadStillLibrary({
        selectedOnDevice: Boolean(selected.success),
        error: selected.success ? null : selected.error
      });
      this._loadGifLibrary({
        error: selected.success ? null : selected.error
      });
      return {
        success: true,
        lighting: parsed.lighting,
        settings: {
          sleepTime: parsed.performance.sleepTime,
          sleepMode: parsed.performance.sleepMode,
          debounceLevel: parsed.performance.debounceLevel,
          macMode: parsed.performance.macMode,
          lockWin: parsed.performance.lockWin,
          reporteRate: parsed.performance.reporteRate,
          tickRate: parsed.performance.tickRate,
          reportRate24G: parsed.performance.reportRate24G,
          rollerType: parsed.performance.rollerType
        },
        lightMemory: memory,
        selectedLightEffect: selected.success ? selected.pair : ['still', ''],
        selectedLightEffectError: selected.success ? null : (selected.error || 'Selected lighting name was not readable'),
        stillLibrary: this.lastState.stillLibrary,
        gifLibrary: this.lastState.gifLibrary
      };
    });
  }

  getStillLibrary() {
    return this._loadStillLibrary().snapshot;
  }

  async createStill(name) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    const loaded = this._loadStillLibrary();
    if (!loaded.ok) {
      return { success: false, error: loaded.error || 'Still library file is unreadable', stillLibrary: loaded.snapshot };
    }
    const created = stillLibrary.createStill(loaded.items, name, stillLibrary.emptyStillData(), {
      lightScopeType: 'main',
      displayName: name
    });
    if (!created.valid) {
      return { success: false, error: created.error, stillLibrary: stillLibrary.snapshot(loaded.items, this.lastState.selectedLightEffect) };
    }
    try {
      stillLibrary.writeDeviceItems(this._stillLibraryFile(), this._lightingDeviceKey(), created.items, this._stillIdentity());
    } catch (err) {
      const snap = this._loadStillLibrary({ error: err.message || String(err) }).snapshot;
      return { success: false, error: err.message || String(err), stillLibrary: snap };
    }
    const snap = this._loadStillLibrary().snapshot;
    return { success: true, key: created.key, item: created.item, stillLibrary: snap };
  }

  async renameStill(key, name) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    const loaded = this._loadStillLibrary();
    if (!loaded.ok) {
      return { success: false, error: loaded.error || 'Still library file is unreadable', stillLibrary: loaded.snapshot };
    }
    const renamed = stillLibrary.renameStill(loaded.items, key, name);
    if (!renamed.valid) {
      return { success: false, error: renamed.error, stillLibrary: loaded.snapshot };
    }
    try {
      stillLibrary.writeDeviceItems(this._stillLibraryFile(), this._lightingDeviceKey(), renamed.items, this._stillIdentity());
    } catch (err) {
      return { success: false, error: err.message || String(err), stillLibrary: this._loadStillLibrary({ error: err.message }).snapshot };
    }
    const relink = await this._relinkSelectedName(['still', renamed.oldName], ['still', renamed.newName]);
    const deviceFailed = relink.some((row) => row.attempted && !row.success);
    const deviceError = deviceFailed ? 'Still was renamed locally. The selected name on the keyboard could not be updated.' : null;
    const snap = this._loadStillLibrary({
      selectedOnDevice: !deviceFailed,
      error: deviceError
    }).snapshot;
    return {
      success: !deviceFailed,
      localSaved: true,
      deviceUpdated: !deviceFailed,
      item: renamed.item,
      stillLibrary: snap,
      selectedNameUpdates: relink,
      selectedLightEffect: this.lastState.selectedLightEffect,
      error: deviceError
    };
  }

  async deleteStill(key, options = {}) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    const loaded = this._loadStillLibrary();
    if (!loaded.ok) {
      return { success: false, error: loaded.error || 'Still library file is unreadable', stillLibrary: loaded.snapshot };
    }
    const activeKey = options.activeKey || (this.lastState.stillLibrary && this.lastState.stillLibrary.selectedKey);
    const removed = stillLibrary.deleteStill(loaded.items, key, { isActive: Boolean(activeKey && activeKey === key) });
    if (!removed.valid) {
      return { success: false, error: removed.error, stillLibrary: loaded.snapshot };
    }
    try {
      stillLibrary.writeDeviceItems(this._stillLibraryFile(), this._lightingDeviceKey(), removed.items, this._stillIdentity());
    } catch (err) {
      return { success: false, error: err.message || String(err), stillLibrary: this._loadStillLibrary({ error: err.message }).snapshot };
    }
    let relink = [];
    if (removed.replacement.mode !== 'preserve') {
      const nextPair = removed.replacement.mode === 'replace'
        ? stillLibrary.selectedPairFromItem(removed.replacement.item)
        : ['still', ''];
      relink = await this._relinkSelectedName(stillLibrary.selectedPairFromItem(removed.deleted), nextPair);
    }
    const deviceFailed = relink.some((row) => row.attempted && !row.success);
    const deviceError = deviceFailed ? 'Still was deleted locally. The selected name on the keyboard could not be updated.' : null;
    const snap = this._loadStillLibrary({
      selectedOnDevice: !deviceFailed,
      error: deviceError
    }).snapshot;
    return {
      success: !deviceFailed,
      localSaved: true,
      deviceUpdated: !deviceFailed,
      stillLibrary: snap,
      replacement: removed.replacement.mode === 'replace' ? removed.replacement.item : null,
      selectedNameUpdates: relink,
      selectedLightEffect: this.lastState.selectedLightEffect,
      error: deviceError
    };
  }

  async updateStillFrames(key, colors, options = {}) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    if (options.expectedKey && options.expectedKey !== key) {
      return { success: false, error: 'Still color edit was cancelled because another still is selected' };
    }
    const loaded = this._loadStillLibrary();
    if (!loaded.ok) {
      return { success: false, error: loaded.error || 'Still library file is unreadable', stillLibrary: loaded.snapshot };
    }
    const frame = stillLibrary.colors2KeyColorFrame(colors, { colorFromScope: 'main' });
    const updated = stillLibrary.updateStillData(loaded.items, key, (data, extra) => ({
      data: { ...data, frames: [{ data: frame }] },
      extra
    }));
    if (!updated.valid) {
      return { success: false, error: updated.error, stillLibrary: loaded.snapshot };
    }
    try {
      stillLibrary.writeDeviceItems(this._stillLibraryFile(), this._lightingDeviceKey(), updated.items, this._stillIdentity());
    } catch (err) {
      return { success: false, error: err.message || String(err), stillLibrary: this._loadStillLibrary({ error: err.message }).snapshot };
    }
    const snap = this._loadStillLibrary().snapshot;
    let device = { success: true, skipped: true };
    if (options.applyDevice) {
      const profileIndex = Number.isInteger(options.profileIndex) ? options.profileIndex : (this.editTarget.profileIndex || 0);
      const colorMap = stillLibrary.stillDataToColorMap(updated.item.data);
      device = await this.applyKeyColors(profileIndex, colorMap);
    }
    return {
      success: device.success !== false,
      item: updated.item,
      stillLibrary: snap,
      device,
      error: device.success === false ? (device.error || 'Still colors were saved locally. Keyboard colors were not updated.') : null
    };
  }

  async selectStill(profileIndex, key, options = {}) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    if (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 3) {
      return { success: false, error: 'Invalid profile index: must be 0..3' };
    }
    const startGen = this.generation;
    const startEpoch = this.resetEpoch;
    const loaded = this._loadStillLibrary();
    const item = (loaded.items || []).find((entry) => entry.key === key);
    if (!item) {
      return { success: false, error: 'Still was not found', stillLibrary: loaded.snapshot };
    }
    this.abortAllMusicColor();
    const pair = stillLibrary.selectedPairFromItem(item);
    const colorMap = stillLibrary.stillDataToColorMap(item.data);
    let lighting = null;
    if (options.applyCustom0) {
      const patch = options.lightingPatch && typeof options.lightingPatch === 'object'
        ? options.lightingPatch
        : { effect: 0 };
      lighting = await this.applyLighting(patch, profileIndex, { persistMemory: options.persistMemory !== false });
      if (this.generation !== startGen || this.resetEpoch !== startEpoch || !this.device) {
        return { success: false, error: 'Device identity changed while selecting the still' };
      }
      if (!lighting.success) {
        return {
          success: false,
          error: lighting.error || 'Could not switch the keyboard to Custom lighting',
          lighting,
          stillLibrary: this._loadStillLibrary().snapshot
        };
      }
    }
    const colorsRes = await this.applyKeyColors(profileIndex, colorMap);
    if (this.generation !== startGen || this.resetEpoch !== startEpoch || !this.device) {
      return { success: false, error: 'Device identity changed while writing still colors' };
    }
    if (!colorsRes.success) {
      return {
        success: false,
        error: colorsRes.error || 'Still colors were not written',
        lighting,
        colors: colorsRes,
        stillLibrary: this._loadStillLibrary().snapshot
      };
    }
    const nameRes = await this.runTransaction(async (gen) => {
      return this._writeSelectedLightEffectInTransaction(profileIndex, pair, gen, this._captureMemoryGuard());
    });
    if (this.generation !== startGen || this.resetEpoch !== startEpoch || !this.device) {
      return {
        success: false,
        error: 'Device identity changed after writing the selected still name',
        lighting,
        colors: colorsRes,
        selectedLightEffect: this.lastState.selectedLightEffect,
        stillLibrary: this._loadStillLibrary().snapshot
      };
    }
    if (!nameRes.success) {
      return {
        success: false,
        error: nameRes.error || 'Selected still name was not written',
        lighting,
        colors: colorsRes,
        selectedLightEffect: this.lastState.selectedLightEffect,
        stillLibrary: this._loadStillLibrary().snapshot
      };
    }
    const snap = this._loadStillLibrary({
      selectedOnDevice: this._isEditorProfile(profileIndex)
    }).snapshot;
    return {
      success: true,
      item,
      pair,
      lighting,
      colors: colorsRes,
      selectedLightEffect: this.lastState.selectedLightEffect,
      stillLibrary: snap
    };
  }

  abortAllMusicColor() {
    this.streamGeneration++;
    this._cancelStreamPace();
    if (this.gifPlayer) {
      this.gifPlayer.stop();
      this.gifPlayer.destroy();
      this.gifPlayer = null;
    }
    this._gifStreamItem = null;
    this._gifStreamProfile = null;
    this._gifStreamDevGen = null;
    this._gifStreamEpoch = null;
    this.latestPendingStreamFrame = null;
    this._streamDispatchInFlight = false;
    this._streamDispatchOwner = null;
    this.lastState.isStreaming = false;
  }

  _cancelStreamPace() {
    if (this._streamPaceTimer) {
      clearTimeout(this._streamPaceTimer);
      this._streamPaceTimer = null;
    }
    const resolve = this._streamPaceResolve;
    this._streamPaceResolve = null;
    if (typeof resolve === 'function') resolve();
  }

  _streamBusy() {
    return Boolean(this._transactionInFlight || (this._pendingInFlight && this._pendingInFlight.size > 0));
  }

  _waitStreamPace() {
    const ms = Number.isFinite(this.streamPaceMs) ? Math.max(0, this.streamPaceMs) : STREAM_UNSAFE_COMPLETE_MS;
    if (ms === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        if (this._streamPaceResolve === done) {
          this._streamPaceResolve = null;
          this._streamPaceTimer = null;
        }
        resolve();
      };
      this._streamPaceResolve = done;
      this._streamPaceTimer = setTimeout(done, ms);
    });
  }

  _streamWriteCurrent(identity) {
    return Boolean(
      this.device
      && !this.needsReconnect
      && !this.isStandby
      && identity
      && this.streamGeneration === identity.streamGen
      && this.resetEpoch === identity.epoch
      && this.generation === identity.devGen
      && !this._transactionInFlight
      && this._streamCallbackCurrent()
    );
  }

  _activePairForProfile(profileIndex) {
    if (this._selectedLightEffectByProfile[profileIndex]) {
      return this._selectedLightEffectByProfile[profileIndex];
    }
    if (this._isEditorProfile(profileIndex) && Array.isArray(this.lastState.selectedLightEffect)) {
      return this.lastState.selectedLightEffect;
    }
    return null;
  }

  _streamCallbackCurrent() {
    if (
      !this.device
      || this.needsReconnect
      || this.isStandby
      || this._gifStreamDevGen !== this.generation
      || this._gifStreamEpoch !== this.resetEpoch
      || this._gifStreamProfile !== this.lastState.activeProfileIndex
      || !this._gifStreamItem
    ) {
      return false;
    }
    const pair = this._activePairForProfile(this._gifStreamProfile);
    return Boolean(pair && pair[0] === 'gif' && pair[1] === this._gifStreamItem.name);
  }

  _canStartGifOnActiveProfile() {
    if (!this.device || this.needsReconnect || this.isStandby) return false;
    if (this._currentEditProfile() !== this.lastState.activeProfileIndex) return false;
    const pair = this.lastState.selectedLightEffect;
    return Boolean(pair && pair[0] === 'gif' && pair[1]);
  }

  _normalizeStreamIdentity(options = {}) {
    const streamGen = options.streamGen !== undefined ? options.streamGen : this.streamGeneration;
    const epoch = options.epoch !== undefined
      ? options.epoch
      : (options.resetEpoch !== undefined ? options.resetEpoch : this.resetEpoch);
    const devGen = options.devGen !== undefined ? options.devGen : this.generation;
    return { streamGen, epoch, devGen, resetEpoch: epoch };
  }

  _queuePendingStreamFrame(frameColors, identity) {
    if (!this._streamWriteCurrent(identity)) return;
    this.latestPendingStreamFrame = {
      frameColors,
      options: this._normalizeStreamIdentity(identity)
    };
  }

  _flushPendingStreamFrame() {
    if (!this.latestPendingStreamFrame || this._streamBusy() || this._streamDispatchInFlight) return;
    const next = this.latestPendingStreamFrame;
    this.latestPendingStreamFrame = null;
    this.streamFrame(next.frameColors, this._normalizeStreamIdentity(next.options));
  }

  _selectedGifItem() {
    const pair = this.lastState.selectedLightEffect;
    if (!pair || pair[0] !== 'gif' || !pair[1]) return null;
    const snap = this.lastState.gifLibrary || this._loadGifLibrary();
    return (snap.items || []).find((entry) => entry.name === pair[1]) || null;
  }

  getGifLibrary() {
    return this._loadGifLibrary();
  }

  async createGif(name, data, extra) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    const res = gifLibrary.createGif(name, data, extra, undefined, this._lightingDeviceKey(), this._gifLibraryFile());
    const snap = this._loadGifLibrary();
    if (!res.success) {
      return { ...res, gifLibrary: snap };
    }
    return { ...res, gifLibrary: snap };
  }

  async importGifFile(buffer, name) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    let imported;
    try {
      imported = gifLibrary.importGifBuffer(buffer);
    } catch (err) {
      return { success: false, error: err.message || 'Failed to decode or map GIF', gifLibrary: this._loadGifLibrary() };
    }
    const current = this._loadGifLibrary();
    let resolvedName = name;
    try {
      resolvedName = gifLibrary.suggestImportedName(name, current.items || []);
    } catch (err) {
      return { success: false, error: err.message || 'Could not allocate a GIF name', gifLibrary: current };
    }
    const res = gifLibrary.createGif(resolvedName, imported, undefined, undefined, this._lightingDeviceKey(), this._gifLibraryFile());
    const snap = this._loadGifLibrary();
    return { ...res, gifLibrary: snap };
  }

  async renameGif(key, name) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    const renamed = gifLibrary.renameGif(key, name, this._lightingDeviceKey(), this._gifLibraryFile());
    if (!renamed.success) {
      return { ...renamed, gifLibrary: this._loadGifLibrary() };
    }
    const relink = await this._relinkSelectedName(['gif', renamed.prevName], ['gif', renamed.item.name]);
    const deviceFailed = relink.some((row) => row.attempted && !row.success);
    const deviceError = deviceFailed ? 'GIF was renamed locally. The selected name on the keyboard could not be updated.' : null;
    const snap = this._loadGifLibrary({ error: deviceError });
    return {
      success: !deviceFailed,
      localSaved: true,
      deviceUpdated: !deviceFailed,
      item: renamed.item,
      gifLibrary: snap,
      selectedNameUpdates: relink,
      selectedLightEffect: this.lastState.selectedLightEffect,
      error: deviceError
    };
  }

  async deleteGif(key, options = {}) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    const loaded = this._loadGifLibrary();
    const item = (loaded.items || []).find((entry) => entry.key === key);
    if (!item) {
      return { success: false, error: 'GIF library item not found', gifLibrary: loaded };
    }
    const selected = this.lastState.selectedLightEffect;
    const isSelected = Boolean(selected && selected[0] === 'gif' && selected[1] === item.name);
    if (isSelected) this.abortAllMusicColor();
    const activeKey = options.activeKey || null;
    const removed = gifLibrary.deleteGif(key, { activeKey }, this._lightingDeviceKey(), this._gifLibraryFile());
    if (!removed.success) {
      return { ...removed, gifLibrary: this._loadGifLibrary() };
    }

    let relink = [];
    if (activeKey === key || isSelected) {
      const nextPair = removed.replacement ? ['gif', removed.replacement.name] : ['gif', ''];
      relink = await this._relinkSelectedName(['gif', item.name], nextPair);
    }
    const deviceFailed = relink.some((row) => row.attempted && !row.success);
    const deviceError = deviceFailed ? 'GIF was deleted locally. The selected name on the keyboard could not be updated.' : null;
    const snap = this._loadGifLibrary({ error: deviceError });
    return {
      success: !deviceFailed,
      localSaved: true,
      deviceUpdated: !deviceFailed,
      gifLibrary: snap,
      replacement: removed.replacement,
      selectedNameUpdates: relink,
      selectedLightEffect: this.lastState.selectedLightEffect,
      error: deviceError
    };
  }

  async updateGif(key, updater) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    const res = gifLibrary.updateGifData(key, updater, this._lightingDeviceKey(), this._gifLibraryFile());
    const snap = this._loadGifLibrary();
    if (!res.success) {
      return { ...res, gifLibrary: snap };
    }
    const wasPlaying = Boolean(this.gifPlayer && this.gifPlayer.isPlaying);
    if (this.gifPlayer && this.lastState.selectedLightEffect && this.lastState.selectedLightEffect[1] === res.item.name) {
      this._gifStreamItem = res.item;
      this.gifPlayer.loadFrames(res.item.data.frames);
      if (wasPlaying) this.gifPlayer.start();
    }
    return { ...res, gifLibrary: snap };
  }

  async selectGif(profileIndex, key, options = {}) {
    if (this._firmwareExclusive) {
      return { success: false, error: this._firmwareOwnershipError(), updaterOwned: true };
    }
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    if (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 3) {
      return { success: false, error: 'Invalid profile index: must be 0..3' };
    }
    const startGen = this.generation;
    const startEpoch = this.resetEpoch;
    const loaded = this._loadGifLibrary();
    const item = (loaded.items || []).find((entry) => entry.key === key);
    if (!item) {
      return { success: false, error: 'GIF was not found', gifLibrary: loaded };
    }

    this.abortAllMusicColor();

    const pair = ['gif', item.name];
    let lighting = null;
    if (options.applyCustom0) {
      const patch = options.lightingPatch && typeof options.lightingPatch === 'object'
        ? options.lightingPatch
        : { effect: 0 };
      lighting = await this.applyLighting(patch, profileIndex, { persistMemory: options.persistMemory !== false });
      if (this.generation !== startGen || this.resetEpoch !== startEpoch || !this.device) {
        return { success: false, error: 'Device identity changed while selecting the GIF' };
      }
      if (!lighting.success) {
        return {
          success: false,
          error: lighting.error || 'Could not switch the keyboard to Custom lighting',
          lighting,
          gifLibrary: this._loadGifLibrary()
        };
      }
    }

    const blackMap = stillLibrary.stillDataToColorMap(stillLibrary.emptyStillData());
    const colorsRes = await this.applyKeyColors(profileIndex, blackMap);
    if (this.generation !== startGen || this.resetEpoch !== startEpoch || !this.device) {
      return { success: false, error: 'Device identity changed while clearing static colors' };
    }
    if (!colorsRes.success) {
      return {
        success: false,
        error: colorsRes.error || 'Static colors could not be cleared',
        lighting,
        colors: colorsRes,
        gifLibrary: this._loadGifLibrary()
      };
    }

    const nameRes = await this.runTransaction(async (gen) => {
      return this._writeSelectedLightEffectInTransaction(profileIndex, pair, gen, this._captureMemoryGuard());
    });
    if (this.generation !== startGen || this.resetEpoch !== startEpoch || !this.device) {
      return {
        success: false,
        error: 'Device identity changed after writing the selected GIF name',
        lighting,
        colors: colorsRes,
        selectedLightEffect: this.lastState.selectedLightEffect,
        gifLibrary: this._loadGifLibrary()
      };
    }
    if (!nameRes.success) {
      return {
        success: false,
        error: nameRes.error || 'Selected GIF name was not written',
        lighting,
        colors: colorsRes,
        selectedLightEffect: this.lastState.selectedLightEffect,
        gifLibrary: this._loadGifLibrary()
      };
    }

    const snap = this._loadGifLibrary();

    if (this.lastState.activeProfileIndex === profileIndex && !this.isStandby) {
      this._startGifStreaming(item);
    }

    return {
      success: true,
      item,
      pair,
      lighting,
      colors: colorsRes,
      selectedLightEffect: this.lastState.selectedLightEffect,
      gifLibrary: snap,
      isStreaming: Boolean(this.lastState.isStreaming)
    };
  }

  setGifPlayback(action) {
    if (this._firmwareExclusive) {
      return { success: false, error: this._firmwareOwnershipError(), updaterOwned: true };
    }
    if (action === 'pause') {
      if (!this.gifPlayer) return { success: false, error: 'No active GIF player' };
      this.streamGeneration++;
      this._cancelStreamPace();
      this.latestPendingStreamFrame = null;
      this.gifPlayer.pause();
      this.lastState.isStreaming = false;
      return { success: true, playing: false };
    }
    if (action === 'stop') {
      this.abortAllMusicColor();
      return { success: true, playing: false };
    }
    if (action === 'resume' || action === 'play') {
      if (this.gifPlayer) {
        if (!this._streamCallbackCurrent()) {
          this.abortAllMusicColor();
          return { success: false, error: 'GIF playback only runs on the active onboard profile' };
        }
        this.lastState.isStreaming = true;
        this.gifPlayer.resume();
        return { success: true, playing: true };
      }
      if (!this._canStartGifOnActiveProfile()) {
        return { success: false, error: 'GIF playback only runs on the active onboard profile' };
      }
      const item = this._selectedGifItem();
      if (!item) return { success: false, error: 'GIF was not found' };
      this._startGifStreaming(item);
      return { success: true, playing: Boolean(this.lastState.isStreaming) };
    }
    return { success: false, error: 'Unknown GIF playback action' };
  }

  _startGifStreaming(item) {
    this.abortAllMusicColor();
    if (!item || !item.data || !Array.isArray(item.data.frames) || this.isStandby || !this.device) {
      return;
    }
    this.streamGeneration++;
    this._gifStreamItem = item;
    this._gifStreamProfile = this.lastState.activeProfileIndex;
    this._gifStreamDevGen = this.generation;
    this._gifStreamEpoch = this.resetEpoch;
    const itemKey = item.key;

    this.gifPlayer = new GifPlayer({
      frames: item.data.frames,
      onFrame: (colors, frameIndex, totalFrames) => {
        if (!this._streamCallbackCurrent()) return;
        if (typeof this.onGifFrame === 'function') {
          this.onGifFrame({ key: itemKey, frameIndex, totalFrames, colors });
        }
        this.streamFrame(colors);
      }
    });

    this.lastState.isStreaming = true;
    this.gifPlayer.start();
  }

  streamFrame(frameColors, options = {}) {
    if (this._firmwareExclusive) return;
    const identity = this._normalizeStreamIdentity(options);

    if (!this._streamWriteCurrent(identity) || !this._streamCallbackCurrent()) {
      return;
    }

    if (this._streamBusy() || this._streamDispatchInFlight) {
      this._queuePendingStreamFrame(frameColors, identity);
      return;
    }

    const ownedGen = identity.streamGen;
    this._streamDispatchOwner = ownedGen;
    this._streamDispatchInFlight = true;
    void this._dispatchStreamFrame(frameColors, identity).finally(() => {
      if (this._streamDispatchOwner !== ownedGen) return;
      this._streamDispatchInFlight = false;
      this._streamDispatchOwner = null;
      if (
        this.latestPendingStreamFrame
        && this._streamWriteCurrent(this._normalizeStreamIdentity(this.latestPendingStreamFrame.options))
        && !this._streamBusy()
      ) {
        this._flushPendingStreamFrame();
      }
    });
  }

  async _dispatchStreamFrame(frameColors, identity) {
    const colorMap = stillLibrary.keyColorFrame2Colors(frameColors, { maxCount: G75_STREAM_MAIN_KEYS });
    const rawBytes = Buffer.alloc(G75_STREAM_MAIN_BYTES);
    for (let i = 0; i < G75_STREAM_MAIN_KEYS; i++) {
      const hex = colorMap[i] || '#000000';
      const num = parseInt(hex.slice(1), 16) || 0;
      rawBytes[i * 3] = (num >> 16) & 0xFF;
      rawBytes[i * 3 + 1] = (num >> 8) & 0xFF;
      rawBytes[i * 3 + 2] = num & 0xFF;
    }

    const packets = protocol.buildStreamingPackets(rawBytes, {
      command: protocol.COMMANDS.STREAM_MAIN,
      profileIndex: 0,
      rangeStart: 0
    });

    for (let i = 0; i < packets.length; i++) {
      if (!this._streamWriteCurrent(identity)) return;
      if (this._streamBusy()) {
        this._queuePendingStreamFrame(frameColors, identity);
        return;
      }
      const wrote = await this._serialStreamWrite(packets[i], identity);
      if (!wrote) return;
      await this._waitStreamPace();
    }
  }

  _serialStreamWrite(packet, identity) {
    return new Promise((resolve) => {
      this.activeQueue = this.activeQueue.then(() => {
        if (this._firmwareExclusive || !this._streamWriteCurrent(identity) || this._streamBusy()) {
          resolve(false);
          return;
        }
        try {
          this.device.write(packet);
          resolve(true);
        } catch {
          resolve(false);
        }
      }).catch(() => {
        resolve(false);
      });
    });
  }

  async _readSelectedLightEffectInTransaction(profileIndex, startGen, captured = null) {
    const guard = captured || this._captureMemoryGuard();
    if (!this._memoryGuardCurrent(guard) || startGen !== this.generation) {
      return { success: false, error: 'Selected lighting identity changed before read' };
    }
    const offset = stillLibrary.selectedLightOffset(profileIndex);
    const hwRes = await this.readRange(
      protocol.COMMANDS.GET_CUSTOM_PARAM,
      offset,
      stillLibrary.SELECTED_LIGHT_LENGTH,
      800,
      startGen
    );
    if (!this._memoryGuardCurrent(guard) || startGen !== this.generation) {
      return { success: false, error: 'Selected lighting identity changed during read' };
    }
    if (!hwRes.success || !hwRes.data || hwRes.data.length !== stillLibrary.SELECTED_LIGHT_LENGTH) {
      return { success: false, error: hwRes.error || 'Selected lighting name was not readable' };
    }
    const decoded = stillLibrary.decodeSelectedLightEffect(hwRes.data);
    return { success: true, pair: decoded.pair, raw: hwRes.data };
  }

  async _writeSelectedLightEffectInTransaction(profileIndex, pair, startGen, captured = null) {
    const guard = captured || this._captureMemoryGuard();
    if (!this._memoryGuardCurrent(guard) || startGen !== this.generation) {
      return { success: false, error: 'Selected lighting identity changed before write' };
    }
    const encoded = stillLibrary.encodeSelectedLightEffect(pair);
    if (!encoded.valid) return { success: false, error: encoded.error };
    const offset = stillLibrary.selectedLightOffset(profileIndex);
    const writeRes = await this.writeRange(
      protocol.COMMANDS.SET_CUSTOM_PARAM,
      offset,
      encoded.buffer,
      1500,
      startGen
    );
    if (!this._memoryGuardCurrent(guard) || startGen !== this.generation) {
      return { success: false, error: 'Selected lighting identity changed during write' };
    }
    if (!writeRes.success) {
      return { success: false, error: writeRes.error || 'Selected lighting name write failed' };
    }
    const verifyRes = await this.readRange(
      protocol.COMMANDS.GET_CUSTOM_PARAM,
      offset,
      stillLibrary.SELECTED_LIGHT_LENGTH,
      800,
      startGen
    );
    if (!this._memoryGuardCurrent(guard) || startGen !== this.generation) {
      return { success: false, error: 'Selected lighting identity changed after readback' };
    }
    if (!verifyRes.success || !verifyRes.data || verifyRes.data.length !== stillLibrary.SELECTED_LIGHT_LENGTH) {
      return { success: false, error: verifyRes.error || 'Selected lighting name readback failed' };
    }
    for (let i = 0; i < stillLibrary.SELECTED_LIGHT_LENGTH; i++) {
      if (verifyRes.data[i] !== encoded.buffer[i]) {
        return { success: false, error: `Selected lighting name readback mismatch at byte ${i}` };
      }
    }
    if (!this._memoryGuardCurrent(guard) || startGen !== this.generation) {
      return { success: false, error: 'Selected lighting identity changed after readback' };
    }
    this._publishSelectedPair(profileIndex, encoded.pair);
    return { success: true, pair: encoded.pair };
  }

  async _relinkSelectedName(oldPair, newPair) {
    if (!oldPair || !oldPair[1]) return [];
    const results = [];
    if (!this.device || this.needsReconnect) {
      return [{ attempted: true, success: false, error: 'Device not connected or requires reconnect' }];
    }
    return this.runTransaction(async (startGen) => {
      const guard = this._captureMemoryGuard();
      for (let profile = 0; profile < 4; profile++) {
        const read = await this._readSelectedLightEffectInTransaction(profile, startGen, guard);
        if (!read.success) {
          results.push({ profile, attempted: true, success: false, error: read.error });
          continue;
        }
        if (!stillLibrary.pairsEqual(read.pair, oldPair)) {
          results.push({ profile, attempted: false, success: true, pair: read.pair });
          continue;
        }
        const write = await this._writeSelectedLightEffectInTransaction(profile, newPair, startGen, guard);
        results.push({ profile, attempted: true, success: write.success, error: write.error, pair: newPair });
      }
      return results;
    });
  }

  /**
   * Local edit-target only. Never sends SET_BASE / never activates a hardware profile.
   */
  setEditTarget(profileIndex, layer = null) {
    if (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 3) {
      return { success: false, error: 'Invalid edit-target profile index: must be 0..3' };
    }
    if (layer !== null && layer !== undefined) {
      if (!Number.isInteger(layer) || layer < 0 || layer > 3) {
        return { success: false, error: 'Invalid edit-target layer: must be 0..3 or null' };
      }
    } else {
      layer = null;
    }
    this.editTarget = { profileIndex, layer };
    return {
      success: true,
      editTarget: { ...this.editTarget },
      activeProfileIndex: this.lastState.activeProfileIndex
    };
  }

  /**
   * Enable onboard profiles (default: all 4). Preserves active profile, order, and marker bytes 6..55.
   */
  async enableProfiles(newCount = 4) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    if (!Number.isInteger(newCount) || newCount < 1 || newCount > 4) {
      return { success: false, error: 'Profile count must be integer 1..4' };
    }

    return this.runTransaction(async (startGen) => {
      const baseRes = await this.readRange(protocol.COMMANDS.GET_BASE, 0, 56, 800, startGen);
      if (!baseRes.success || !baseRes.data || baseRes.data.length !== 56) {
        return { success: false, error: `Failed to read complete base configuration: ${baseRes.error || 'incomplete read'}` };
      }
      let mutated;
      try {
        mutated = protocol.enableProfileCount(baseRes.data, newCount);
      } catch (err) {
        return { success: false, error: err.message };
      }
      if (!this._genOk(startGen)) {
        return { success: false, error: 'Device reconnected or disconnected during transaction; aborting write' };
      }
      const verified = await this._writeVerify(protocol.COMMANDS.SET_BASE, 0, mutated, startGen, { section: 'base' });
      if (!verified.success) return verified;
      const parsed = protocol.parseBase(verified.data);
      if (!parsed || parsed.profileCount !== newCount) {
        return this._failPartial({
          error: `Profile-count readback mismatch: expected ${newCount}, got ${parsed && parsed.profileCount}`,
          failedSection: 'base',
          uncertain: true
        });
      }
      this._rawBase = verified.data;
      this.lastState.activeProfileIndex = parsed.activeProfile;
      this.lastState.base = {
        activeProfile: parsed.activeProfile,
        activeSlot: parsed.activeSlot,
        profileCount: parsed.profileCount,
        profileOrder: parsed.profileOrder
      };
      return { success: true, base: this.lastState.base };
    });
  }

  async readAdvanced(profileIndex = 0) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    if (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 3) {
      return { success: false, error: 'Invalid profile index: must be 0..3' };
    }
    return this.runTransaction(async (startGen) => {
      const mtRes = await this.readRange(protocol.COMMANDS.GET_MT_KEYS, profileIndex * protocol.MT_TABLE_SIZE, protocol.MT_TABLE_SIZE, 1000, startGen);
      if (!mtRes.success) return { success: false, error: `Failed to read MT table: ${mtRes.error}` };
      const tglRes = await this.readRange(protocol.COMMANDS.GET_TGL_KEYS, profileIndex * protocol.TGL_TABLE_SIZE, protocol.TGL_TABLE_SIZE, 1000, startGen);
      if (!tglRes.success) return { success: false, error: `Failed to read TGL table: ${tglRes.error}` };
      const extrasRes = await this.readRange(protocol.COMMANDS.GET_KEY_EXTRAS, profileIndex * protocol.KEY_EXTRAS_SIZE, protocol.KEY_EXTRAS_SIZE, 1000, startGen);
      if (!extrasRes.success) return { success: false, error: `Failed to read key extras: ${extrasRes.error}` };
      const customOffset = protocol.cbCustomParamOffset(profileIndex);
      const customRes = await this.readRange(
        protocol.COMMANDS.GET_CUSTOM_PARAM,
        customOffset,
        protocol.CB_CUSTOM_PARAM_LENGTH,
        800,
        startGen
      );
      if (!customRes.success || !customRes.data || customRes.data.length !== protocol.CB_CUSTOM_PARAM_LENGTH) {
        return { success: false, error: `Failed to read advanced customParam: ${customRes.error || 'incomplete read'}` };
      }
      const customParam = protocol.parseCbCustomParam(customRes.data);
      if (!customParam.ok) {
        customParam.cbKeyIndexList = protocol.emptyCbKeyIndexList();
      }
      const layersRes = await this._readProfileLayers(profileIndex, startGen);
      if (!layersRes.success) return layersRes;
      this._rawMt = mtRes.data;
      this._rawTgl = tglRes.data;
      this._rawExtras = extrasRes.data;
      return {
        success: true,
        profileIndex,
        mt: protocol.parseMtTable(mtRes.data),
        tgl: protocol.parseTglTable(tglRes.data),
        keyExtras: protocol.parseKeyExtras(extrasRes.data),
        customParam,
        raw: {
          mt: mtRes.data.toString('hex'),
          tgl: tglRes.data.toString('hex'),
          keyExtras: extrasRes.data.toString('hex'),
          customParam: customRes.data.toString('hex')
        },
        references: (() => {
          const refs = protocol.collectAdvancedReferences(layersRes.layers);
          return { mt: Array.from(refs.mt), tgl: Array.from(refs.tgl) };
        })()
      };
    });
  }

  /**
   * Apply or remove one advanced binding on an explicit profile/layer captured at click time.
   * Writes table data, full table readback, then bindings. Orphan table bytes are preserved.
   */
  async applyAdvancedBinding(spec) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    const val = validateAdvancedBinding(spec);
    if (!val.valid) {
      return { success: false, error: `Invalid advanced binding: ${val.error}` };
    }

    return this.runTransaction(async (startGen) => {
      const profileIndex = spec.profileIndex;
      const layer = spec.layer;
      const slot = spec.slot;
      const completedSections = [];

      const layersRes = await this._readProfileLayers(profileIndex, startGen);
      if (!layersRes.success) return layersRes;
      const defRes = await this._readDefaultLayers(startGen);
      let defaultLayers = null;
      if (defRes.success) {
        defaultLayers = defRes.layers;
      } else {
        try {
          getDefaultTuple(layer, slot);
        } catch (err) {
          return {
            success: false,
            error: `Failed to read immutable default layers (CMD 7) and bundled capture is missing: ${defRes.error || err.message}`
          };
        }
      }
      const mtRes = await this.readRange(protocol.COMMANDS.GET_MT_KEYS, profileIndex * protocol.MT_TABLE_SIZE, protocol.MT_TABLE_SIZE, 1000, startGen);
      if (!mtRes.success || !mtRes.data || mtRes.data.length !== protocol.MT_TABLE_SIZE) {
        return { success: false, error: `Failed to read MT table before mutation: ${mtRes.error || 'incomplete read'}` };
      }
      const tglRes = await this.readRange(protocol.COMMANDS.GET_TGL_KEYS, profileIndex * protocol.TGL_TABLE_SIZE, protocol.TGL_TABLE_SIZE, 1000, startGen);
      if (!tglRes.success || !tglRes.data || tglRes.data.length !== protocol.TGL_TABLE_SIZE) {
        return { success: false, error: `Failed to read TGL table before mutation: ${tglRes.error || 'incomplete read'}` };
      }
      const extrasRes = await this.readRange(protocol.COMMANDS.GET_KEY_EXTRAS, profileIndex * protocol.KEY_EXTRAS_SIZE, protocol.KEY_EXTRAS_SIZE, 1000, startGen);
      if (!extrasRes.success || !extrasRes.data || extrasRes.data.length !== protocol.KEY_EXTRAS_SIZE) {
        return { success: false, error: `Failed to read key extras before mutation: ${extrasRes.error || 'incomplete read'}` };
      }
      const customOffset = protocol.cbCustomParamOffset(profileIndex);
      const customRes = await this.readRange(
        protocol.COMMANDS.GET_CUSTOM_PARAM,
        customOffset,
        protocol.CB_CUSTOM_PARAM_LENGTH,
        800,
        startGen
      );
      if (!customRes.success || !customRes.data || customRes.data.length !== protocol.CB_CUSTOM_PARAM_LENGTH) {
        return { success: false, error: `Failed to read advanced customParam before mutation: ${customRes.error || 'incomplete read'}` };
      }
      if (!this._genOk(startGen)) {
        return { success: false, error: 'Device reconnected or disconnected during transaction; aborting write' };
      }

      const plan = advancedPlan.planApplyAdvancedBinding({
        spec,
        layerBuffers: layersRes.layers,
        mtBuf: mtRes.data,
        tglBuf: tglRes.data,
        extrasBuf: extrasRes.data,
        customBuf: customRes.data,
        defaultLayers
      });
      if (!plan.ok) {
        return { success: false, error: plan.error, completedSections: [] };
      }
      const plannedMt = plan.plannedMt;
      const plannedTgl = plan.plannedTgl;
      const plannedExtras = plan.plannedExtras;
      const plannedCustom = plan.plannedCustom;
      const byLayer = plan.byLayer;

      if (plannedMt) {
        const mtWrite = await this._writeVerify(
          protocol.COMMANDS.SET_MT_KEYS,
          profileIndex * protocol.MT_TABLE_SIZE,
          plannedMt,
          startGen,
          { section: 'mtTable', completedSections }
        );
        if (!mtWrite.success) return mtWrite;
        completedSections.push('mtTable');
        this._rawMt = mtWrite.data;
      }
      if (plannedTgl) {
        const tglWrite = await this._writeVerify(
          protocol.COMMANDS.SET_TGL_KEYS,
          profileIndex * protocol.TGL_TABLE_SIZE,
          plannedTgl,
          startGen,
          { section: 'tglTable', completedSections }
        );
        if (!tglWrite.success) return tglWrite;
        completedSections.push('tglTable');
        this._rawTgl = tglWrite.data;
      }
      if (plannedExtras) {
        const extrasWrite = await this._writeVerify(
          protocol.COMMANDS.SET_KEY_EXTRAS,
          profileIndex * protocol.KEY_EXTRAS_SIZE,
          plannedExtras,
          startGen,
          { section: 'keyExtras', completedSections }
        );
        if (!extrasWrite.success) return extrasWrite;
        completedSections.push('keyExtras');
        this._rawExtras = extrasWrite.data;
      }
      if (plannedCustom) {
        const customWrite = await this._writeVerify(
          protocol.COMMANDS.SET_CUSTOM_PARAM,
          customOffset,
          plannedCustom,
          startGen,
          { section: 'customParam', completedSections }
        );
        if (!customWrite.success) return customWrite;
        completedSections.push('customParam');
      }

      for (const [lyr, updates] of byLayer.entries()) {
        const bindWrite = await this._writeKeyTriples(profileIndex, lyr, updates, startGen, {
          section: 'binding',
          completedSections
        });
        if (!bindWrite.success) return bindWrite;
      }
      completedSections.push('binding');

      return { success: true, completedSections };
    });
  }

  async removeAdvancedBinding(profileIndex, layer, slot) {
    return this.applyAdvancedBinding({ profileIndex, layer, slot, kind: 'remove' });
  }

  /**
   * Advanced-tab clear-all: restore every advanced binding on all four layers of
   * one profile to layer-specific defaults. Writes user keys (CMD 9), optional
   * extras priority 0 for cleared SOCD slots, and matching cbKeyIndexList
   * removals. Does not compact MT/TGL tables, does not touch ordinary remaps,
   * reserved table tails, or factory CMD 238.
   */
  async clearAllAdvancedBindings(spec) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    const val = validateClearAllAdvanced(spec);
    if (!val.valid) {
      return { success: false, error: `Invalid clear-all advanced spec: ${val.error}` };
    }

    return this.runTransaction(async (startGen) => {
      const profileIndex = spec.profileIndex;
      const completedSections = [];

      const layersRes = await this._readProfileLayers(profileIndex, startGen);
      if (!layersRes.success) return layersRes;
      const defRes = await this._readDefaultLayers(startGen);
      let defaultLayers = null;
      if (defRes.success) {
        defaultLayers = defRes.layers;
      } else {
        try {
          getDefaultTuple(0, 0);
        } catch (err) {
          return {
            success: false,
            error: `Failed to read immutable default layers (CMD 7) and bundled capture is missing: ${defRes.error || err.message}`
          };
        }
      }
      const extrasRes = await this.readRange(
        protocol.COMMANDS.GET_KEY_EXTRAS,
        profileIndex * protocol.KEY_EXTRAS_SIZE,
        protocol.KEY_EXTRAS_SIZE,
        1000,
        startGen
      );
      if (!extrasRes.success || !extrasRes.data || extrasRes.data.length !== protocol.KEY_EXTRAS_SIZE) {
        return { success: false, error: `Failed to read key extras before clear-all: ${extrasRes.error || 'incomplete read'}` };
      }
      const customOffset = protocol.cbCustomParamOffset(profileIndex);
      const customRes = await this.readRange(
        protocol.COMMANDS.GET_CUSTOM_PARAM,
        customOffset,
        protocol.CB_CUSTOM_PARAM_LENGTH,
        800,
        startGen
      );
      if (!customRes.success || !customRes.data || customRes.data.length !== protocol.CB_CUSTOM_PARAM_LENGTH) {
        return { success: false, error: `Failed to read advanced customParam before clear-all: ${customRes.error || 'incomplete read'}` };
      }
      if (!this._genOk(startGen)) {
        return { success: false, error: 'Device reconnected or disconnected during transaction; aborting write' };
      }

      const plan = advancedPlan.planClearAllAdvanced({
        layerBuffers: layersRes.layers,
        extrasBuf: extrasRes.data,
        customBuf: customRes.data,
        defaultLayers
      });
      if (!plan.ok) {
        return { success: false, error: plan.error, completedSections: [] };
      }
      const plannedByLayer = plan.plannedByLayer;
      const plannedExtras = plan.plannedExtras;
      const plannedCustom = plan.plannedCustom;

      if (plannedExtras) {
        const extrasWrite = await this._writeVerify(
          protocol.COMMANDS.SET_KEY_EXTRAS,
          profileIndex * protocol.KEY_EXTRAS_SIZE,
          plannedExtras,
          startGen,
          { section: 'keyExtras', completedSections }
        );
        if (!extrasWrite.success) return extrasWrite;
        completedSections.push('keyExtras');
        this._rawExtras = extrasWrite.data;
      }

      if (plannedCustom) {
        const customWrite = await this._writeVerify(
          protocol.COMMANDS.SET_CUSTOM_PARAM,
          customOffset,
          plannedCustom,
          startGen,
          { section: 'customParam', completedSections }
        );
        if (!customWrite.success) return customWrite;
        completedSections.push('customParam');
      }

      for (const [lyr, updates] of plannedByLayer.entries()) {
        const bindWrite = await this._writeKeyTriples(profileIndex, lyr, updates, startGen, {
          section: `binding:${lyr}`,
          completedSections
        });
        if (!bindWrite.success) return bindWrite;
        completedSections.push(`binding:${lyr}`);
      }

      return {
        success: true,
        completedSections,
        clearedLayers: Array.from(plannedByLayer.keys()),
        factoryReset: false
      };
    });
  }

  /**
   * Applies macro definitions to device (CMD 13).
   * Playback-mode changes also rewrite every physical type-112 binding across 4 profiles × 4 layers.
   */
  async applyMacros(slots) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }

    const val = validateMacroSlots(slots);
    if (!val.valid) {
      return { success: false, error: `Invalid macro slots: ${val.error}` };
    }

    return this.runTransaction(async (startGen) => {
      const completedSections = [];
      const readRes = await this.readRange(protocol.COMMANDS.GET_MACROS, 0, protocol.SHARED_MACRO_SIZE, 1500, startGen);
      if (!readRes.success || !readRes.data || readRes.data.length !== protocol.SHARED_MACRO_SIZE) {
        return { success: false, error: `Failed to read complete 8192-byte macro region before write: ${readRes.error || 'incomplete read'}` };
      }

      let existingSlots;
      try {
        existingSlots = protocol.parseMacroRegion(readRes.data);
      } catch (err) {
        return { success: false, error: `Malformed macro region: ${err.message}` };
      }

      const updatesMap = new Map();
      if (Array.isArray(slots)) {
        for (let idx = 0; idx < slots.length; idx++) {
          const s = slots[idx];
          if (s && typeof s === 'object') {
            const slotId = s.id !== undefined ? s.id : idx;
            updatesMap.set(slotId, s);
          }
        }
      }

      const modeChanges = [];
      for (const [slotId, update] of updatesMap.entries()) {
        if (update.type === undefined) continue;
        const existing = existingSlots[slotId];
        const prevType = existing ? existing.type : 0;
        if (update.type !== prevType) {
          modeChanges.push({ slotId, newType: update.type });
        }
      }

      let bindingPlan = [];
      if (modeChanges.length > 0) {
        const changed = new Map(modeChanges.map((c) => [c.slotId, c.newType]));
        for (let p = 0; p < 4; p++) {
          for (let l = 0; l < 4; l++) {
            if (!this._genOk(startGen)) {
              return { success: false, error: 'Device reconnected or disconnected during transaction; aborting write' };
            }
            const layerRes = await this._readUserLayer(p, l, startGen);
            if (!layerRes.success || !layerRes.data || layerRes.data.length !== protocol.USED_KEY_AREA_SIZE) {
              return { success: false, error: `Failed to read profile ${p} layer ${l} before macro mode propagation: ${layerRes.error || 'incomplete read'}` };
            }
            const updates = [];
            for (const phys of VALID_PHYSICAL_SLOTS) {
              const off = phys * 3;
              if (layerRes.data[off] !== protocol.KEY_TYPES.MACRO) continue;
              const macroId = layerRes.data[off + 1];
              if (!changed.has(macroId)) continue;
              updates.push({
                slot: phys,
                type: 112,
                code1: macroId,
                code2: changed.get(macroId)
              });
            }
            if (updates.length > 0) {
              bindingPlan.push({ profileIndex: p, layer: l, updates });
            }
          }
        }
      }

      let serialized;
      try {
        serialized = protocol.serializeMacroRegion(slots, readRes.data);
      } catch (err) {
        return { success: false, error: err.message };
      }

      if (!this._genOk(startGen)) {
        return { success: false, error: 'Device reconnected or disconnected during transaction; aborting write' };
      }

      const macroWrite = await this._writeVerify(
        protocol.COMMANDS.SET_MACROS,
        0,
        serialized,
        startGen,
        { section: 'macros', completedSections, timeoutMs: 1500 }
      );
      if (!macroWrite.success) return macroWrite;
      completedSections.push('macros');
      this._rawMacroRegion = macroWrite.data;
      this.lastState.macros = protocol.parseMacroRegion(macroWrite.data);

      for (const plan of bindingPlan) {
        const bindWrite = await this._writeKeyTriples(plan.profileIndex, plan.layer, plan.updates, startGen, {
          section: 'macroBindings',
          completedSections
        });
        if (!bindWrite.success) return bindWrite;
      }
      if (bindingPlan.length > 0) completedSections.push('macroBindings');

      return { success: true, completedSections };
    });
  }

  /**
   * Export complete, strictly validated profile from fresh hardware reads.
   * Runs in a single transaction with generation protection.
   * Filters keymaps strictly to physical slots (82 keys) and perKeyRgb to physical LED slots (83 keys).
   * Fails closed if not connected or any read fails.
   */
  async exportProfile(profileIndex = null) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }

    const targetProfile = profileIndex !== null ? profileIndex : (this.lastState.activeProfileIndex || 0);
    if (!Number.isInteger(targetProfile) || targetProfile < 0 || targetProfile > 3) {
      return { success: false, error: 'Invalid profile index: must be 0..3' };
    }

    return this.runTransaction(async (startGen) => {
      // 1. Read FuncConfig (CMD 5) for target profile
      const funcRes = await this.readRange(protocol.COMMANDS.GET_FUNC_CONFIG, 64 * targetProfile, 64, 800, startGen);
      if (!funcRes.success || !funcRes.data || funcRes.data.length !== 64) {
        return { success: false, error: `Failed to read funcConfig for profile ${targetProfile}: ${funcRes.error || 'incomplete read'}` };
      }
      const parsedFunc = protocol.parseFuncConfig(funcRes.data);
      if (!parsedFunc) {
        return { success: false, error: 'Failed to parse funcConfig' };
      }

      // 2. Read all 4 layers (projecting only physical slots)
      const layers = {};
      for (let l = 0; l < 4; l++) {
        const baseOffset = (targetProfile * protocol.MAX_LAYERS + l) * protocol.TOTAL_KEY_AREA_SIZE;
        const layerRes = await this.readRange(protocol.COMMANDS.GET_USER_KEY_MATRIX, baseOffset, protocol.USED_KEY_AREA_SIZE, 1000, startGen);
        if (!layerRes.success || !layerRes.data || layerRes.data.length !== protocol.USED_KEY_AREA_SIZE) {
          return { success: false, error: `Failed to read layer ${l} for profile ${targetProfile}: ${layerRes.error || 'incomplete read'}` };
        }
        const layerKeys = protocol.parseKeyMatrix(layerRes.data, l);
        // Project ONLY the 82 physical slots
        const layerMap = {};
        for (const k of layerKeys) {
          if (VALID_PHYSICAL_SLOTS.has(k.index)) {
            layerMap[String(k.index)] = {
              type: k.type,
              code1: k.code1,
              code2: k.code2
            };
          }
        }
        layers[String(l)] = layerMap;
      }

      // 3. Read per-key RGB (projecting only physical lighting slots)
      const rgbOffset = targetProfile * protocol.TOTAL_KEY_AREA_SIZE;
      const rgbRes = await this.readRange(protocol.COMMANDS.GET_KEY_COLOR, rgbOffset, protocol.USED_KEY_AREA_SIZE, 1000, startGen);
      if (!rgbRes.success || !rgbRes.data || rgbRes.data.length !== protocol.USED_KEY_AREA_SIZE) {
        return { success: false, error: `Failed to read key colors for profile ${targetProfile}: ${rgbRes.error || 'incomplete read'}` };
      }
      const allColors = protocol.parseKeyColors(rgbRes.data);
      const perKeyRgb = {};
      for (const c of allColors) {
        if (VALID_LIGHTING_SLOTS.has(c.index)) {
          perKeyRgb[String(c.index)] = c.hex || '#000000';
        }
      }

      // 4. Read macros (shared 8192-byte region)
      const macroRes = await this.readRange(protocol.COMMANDS.GET_MACROS, 0, protocol.SHARED_MACRO_SIZE, 1500, startGen);
      if (!macroRes.success || !macroRes.data || macroRes.data.length !== protocol.SHARED_MACRO_SIZE) {
        return { success: false, error: `Failed to read macro region: ${macroRes.error || 'incomplete read'}` };
      }
      const macros = protocol.parseMacroRegion(macroRes.data);

      const mtRes = await this.readRange(protocol.COMMANDS.GET_MT_KEYS, targetProfile * protocol.MT_TABLE_SIZE, protocol.MT_TABLE_SIZE, 1000, startGen);
      if (!mtRes.success || !mtRes.data || mtRes.data.length !== protocol.MT_TABLE_SIZE) {
        return { success: false, error: `Failed to read MT table for profile ${targetProfile}: ${mtRes.error || 'incomplete read'}` };
      }
      const tglRes = await this.readRange(protocol.COMMANDS.GET_TGL_KEYS, targetProfile * protocol.TGL_TABLE_SIZE, protocol.TGL_TABLE_SIZE, 1000, startGen);
      if (!tglRes.success || !tglRes.data || tglRes.data.length !== protocol.TGL_TABLE_SIZE) {
        return { success: false, error: `Failed to read TGL table for profile ${targetProfile}: ${tglRes.error || 'incomplete read'}` };
      }
      const extrasRes = await this.readRange(protocol.COMMANDS.GET_KEY_EXTRAS, targetProfile * protocol.KEY_EXTRAS_SIZE, protocol.KEY_EXTRAS_SIZE, 1000, startGen);
      if (!extrasRes.success || !extrasRes.data || extrasRes.data.length !== protocol.KEY_EXTRAS_SIZE) {
        return { success: false, error: `Failed to read key extras for profile ${targetProfile}: ${extrasRes.error || 'incomplete read'}` };
      }

      const profilePayload = {
        app: 'Maicong Studio',
        model: 'MCHOSE G75 V2',
        protocol: 'GLW',
        version: '2.0.0',
        profileIndex: targetProfile,
        exportedAt: new Date().toISOString(),
        lighting: {
          effect: parsedFunc.lighting.effect,
          brightness: parsedFunc.lighting.brightness,
          speed: parsedFunc.lighting.speed,
          direction: parsedFunc.lighting.direction,
          customColorDisabled: parsedFunc.lighting.customColorDisabled,
          hexColor: parsedFunc.lighting.hexColor,
          sideEffect: parsedFunc.lighting.sideEffect,
          sideBrightness: parsedFunc.lighting.sideBrightness,
          sideSpeed: parsedFunc.lighting.sideSpeed,
          sideCustomColorDisabled: parsedFunc.lighting.sideCustomColorDisabled,
          sideHexColor: parsedFunc.lighting.sideHexColor,
          calibrationRgb: {
            r: parsedFunc.lighting.calibrationRgb.r,
            g: parsedFunc.lighting.calibrationRgb.g,
            b: parsedFunc.lighting.calibrationRgb.b
          }
        },
        settings: {
          sleepTime: parsedFunc.performance.sleepTime,
          sleepMode: parsedFunc.performance.sleepMode,
          debounceLevel: parsedFunc.performance.debounceLevel,
          macMode: parsedFunc.performance.macMode & 0x03,
          reporteRate: parsedFunc.performance.reporteRate,
          lockWin: parsedFunc.performance.lockWin,
          rollerType: parsedFunc.performance.rollerType
        },
        layers,
        perKeyRgb,
        macros,
        advanced: {
          mt: mtRes.data.toString('hex'),
          tgl: tglRes.data.toString('hex'),
          keyExtras: extrasRes.data.toString('hex')
        }
      };

      const mem = await this._readLightMemoryInTransaction(targetProfile, startGen);
      if (mem.success && mem.store) {
        profilePayload.lightingMemory = lightingMemory.exportLightingMemory(mem.store);
      }

      return { success: true, data: profilePayload };
    });
  }

  /**
   * Applies a complete profile. All reads and serialization complete before the first mutation.
   * Reports completedSections, failedSection, and uncertain when a later section fails.
   */
  async applyProfile(profileData, targetProfileIndex = null) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }

    const val = validateProfileSchema(profileData);
    if (!val.valid) {
      return { success: false, error: `Invalid profile schema: ${val.error}` };
    }

    const targetProfile = targetProfileIndex !== null
      ? targetProfileIndex
      : (profileData.profileIndex !== undefined ? profileData.profileIndex : (this.lastState.activeProfileIndex || 0));

    if (!Number.isInteger(targetProfile) || targetProfile < 0 || targetProfile > 3) {
      return { success: false, error: 'Invalid target profile index: must be 0..3' };
    }

    return this.runTransaction(async (startGen) => {
      const completedSections = [];

      const funcRes = await this.readRange(protocol.COMMANDS.GET_FUNC_CONFIG, 64 * targetProfile, 64, 800, startGen);
      if (!funcRes.success || !funcRes.data || funcRes.data.length !== 64) {
        return { success: false, error: `Failed to read funcConfig before applying profile: ${funcRes.error || 'incomplete read'}` };
      }

      let preparedFunc = Buffer.from(funcRes.data);
      if (profileData.lighting) {
        preparedFunc = protocol.mutateLighting(preparedFunc, profileData.lighting);
      }
      if (profileData.settings) {
        preparedFunc = protocol.mutateSettings(preparedFunc, profileData.settings, targetProfile);
      }

      const layersObj = profileData.layers !== undefined ? profileData.layers : profileData.keymaps;
      const hasMacros = Array.isArray(profileData.macros) && profileData.macros.length > 0;
      const needsTargetLayers = Boolean(layersObj) || Boolean(profileData.advanced) || hasMacros;

      let deviceLayers = null;
      let allProfileLayers = null;
      if (hasMacros) {
        allProfileLayers = [];
        for (let p = 0; p < 4; p++) {
          const r = await this._readProfileLayers(p, startGen);
          if (!r.success) return r;
          allProfileLayers.push(r.layers.map((b) => Buffer.from(b)));
        }
        deviceLayers = allProfileLayers[targetProfile];
      } else if (needsTargetLayers) {
        const layersRes = await this._readProfileLayers(targetProfile, startGen);
        if (!layersRes.success) return layersRes;
        deviceLayers = layersRes.layers.map((b) => Buffer.from(b));
      }

      const mergedLayers = deviceLayers ? deviceLayers.map((b) => Buffer.from(b)) : null;
      const importTouch = [new Set(), new Set(), new Set(), new Set()];
      const preparedLayers = [];
      let defaultLayers = null;
      if (layersObj && mergedLayers) {
        const defRes = await this._readDefaultLayers(startGen);
        if (defRes.success) {
          defaultLayers = defRes.layers;
        } else {
          try {
            getDefaultTuple(0, 0);
          } catch (err) {
            return {
              success: false,
              error: `Immutable defaults unavailable for SOCD import guard: ${defRes.error || err.message}`
            };
          }
        }
        for (let l = 0; l < 4; l++) {
          const rawLayer = Array.isArray(layersObj) ? layersObj[l] : layersObj[String(l)];
          const updates = this._parseLayerUpdates(rawLayer);
          const socdGuard = this._guardSocdRemap(
            mergedLayers[l],
            l,
            updates,
            defaultLayers ? defaultLayers[l] : null
          );
          if (!socdGuard.ok) {
            return { success: false, error: `Import layer ${l}: ${socdGuard.error}` };
          }
          for (const u of updates) {
            importTouch[l].add(u.slot);
            const off = u.slot * 3;
            mergedLayers[l][off] = u.type;
            mergedLayers[l][off + 1] = u.code1;
            mergedLayers[l][off + 2] = u.code2;
          }
          if (updates.length > 0) preparedLayers.push({ layer: l, updates });
        }
        for (let l = 0; l < 4; l++) {
          const buf = mergedLayers[l];
          const count = Math.floor(buf.length / 3);
          for (let slot = 0; slot < count; slot++) {
            if (buf[slot * 3] !== protocol.KEY_TYPES.SOCD) continue;
            if (!protocol.isReciprocalSocd(buf, slot)) {
              return { success: false, error: `Import would leave a non-reciprocal SOCD binding at layer ${l} slot ${slot}` };
            }
          }
        }
      }

      const completeFour = this._layersAreCompletePhysical(preparedLayers);

      let preparedRgb = null;
      if (profileData.perKeyRgb && Object.keys(profileData.perKeyRgb).length > 0) {
        const rgbOffset = targetProfile * protocol.TOTAL_KEY_AREA_SIZE;
        const rgbRes = await this.readRange(protocol.COMMANDS.GET_KEY_COLOR, rgbOffset, protocol.USED_KEY_AREA_SIZE, 1000, startGen);
        if (!rgbRes.success || !rgbRes.data || rgbRes.data.length !== protocol.USED_KEY_AREA_SIZE) {
          return { success: false, error: `Failed to read key colors before write: ${rgbRes.error || 'incomplete read'}` };
        }
        preparedRgb = protocol.serializeKeyColors(profileData.perKeyRgb, rgbRes.data);
      }

      let preparedMacros = null;
      let existingMacroSlots = null;
      if (hasMacros) {
        const macroRes = await this.readRange(protocol.COMMANDS.GET_MACROS, 0, protocol.SHARED_MACRO_SIZE, 1500, startGen);
        if (!macroRes.success || !macroRes.data || macroRes.data.length !== protocol.SHARED_MACRO_SIZE) {
          return { success: false, error: `Failed to read macro region before write: ${macroRes.error || 'incomplete read'}` };
        }
        try {
          existingMacroSlots = protocol.parseMacroRegion(macroRes.data);
          preparedMacros = protocol.serializeMacroRegion(profileData.macros, macroRes.data);
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      const macroBindingPlan = [];
      if (preparedMacros && existingMacroSlots) {
        const newSlots = protocol.parseMacroRegion(preparedMacros);
        const changed = new Map();
        for (let i = 0; i < protocol.MAX_MACRO_SLOTS; i++) {
          if (newSlots[i].type !== existingMacroSlots[i].type) {
            changed.set(i, newSlots[i].type);
          }
        }
        if (changed.size > 0 && allProfileLayers) {
          for (let p = 0; p < 4; p++) {
            for (let l = 0; l < 4; l++) {
              const buf = (p === targetProfile && mergedLayers) ? mergedLayers[l] : allProfileLayers[p][l];
              const updates = [];
              for (const phys of VALID_PHYSICAL_SLOTS) {
                const off = phys * 3;
                if (buf[off] !== protocol.KEY_TYPES.MACRO) continue;
                const id = buf[off + 1];
                if (!changed.has(id)) continue;
                if (p === targetProfile && importTouch[l].has(phys)) continue;
                updates.push({ slot: phys, type: 112, code1: id, code2: changed.get(id) });
              }
              if (updates.length > 0) {
                macroBindingPlan.push({ profileIndex: p, layer: l, updates });
              }
            }
          }
        }
      }

      let preparedMt = null;
      let preparedTgl = null;
      let preparedExtras = null;
      if (profileData.advanced) {
        const mtRes = await this.readRange(protocol.COMMANDS.GET_MT_KEYS, targetProfile * protocol.MT_TABLE_SIZE, protocol.MT_TABLE_SIZE, 1000, startGen);
        if (!mtRes.success || !mtRes.data || mtRes.data.length !== protocol.MT_TABLE_SIZE) {
          return { success: false, error: `Failed to read MT table before write: ${mtRes.error || 'incomplete read'}` };
        }
        const tglRes = await this.readRange(protocol.COMMANDS.GET_TGL_KEYS, targetProfile * protocol.TGL_TABLE_SIZE, protocol.TGL_TABLE_SIZE, 1000, startGen);
        if (!tglRes.success || !tglRes.data || tglRes.data.length !== protocol.TGL_TABLE_SIZE) {
          return { success: false, error: `Failed to read TGL table before write: ${tglRes.error || 'incomplete read'}` };
        }
        const extrasRes = await this.readRange(protocol.COMMANDS.GET_KEY_EXTRAS, targetProfile * protocol.KEY_EXTRAS_SIZE, protocol.KEY_EXTRAS_SIZE, 1000, startGen);
        if (!extrasRes.success || !extrasRes.data || extrasRes.data.length !== protocol.KEY_EXTRAS_SIZE) {
          return { success: false, error: `Failed to read key extras before write: ${extrasRes.error || 'incomplete read'}` };
        }

        const tableLayers = mergedLayers || deviceLayers;
        if (profileData.advanced.mt !== undefined) {
          const importedMt = typeof profileData.advanced.mt === 'string'
            ? Buffer.from(profileData.advanced.mt, 'hex')
            : protocol.serializeMtTable(profileData.advanced.mt, mtRes.data);
          if (completeFour) {
            preparedMt = protocol.preserveReservedTail(importedMt, mtRes.data, protocol.MT_RESERVED_OFFSET);
          } else if (tableLayers) {
            const merged = this._mergeImportedTable({
              kind: 'mt',
              imported: importedMt,
              device: mtRes.data,
              mergedLayers: tableLayers,
              importTouch,
              entrySize: protocol.MT_ENTRY_SIZE,
              reservedOffset: protocol.MT_RESERVED_OFFSET
            });
            if (!merged.ok) return { success: false, error: merged.error };
            preparedMt = merged.buffer;
          }
        }
        if (profileData.advanced.tgl !== undefined) {
          const importedTgl = typeof profileData.advanced.tgl === 'string'
            ? Buffer.from(profileData.advanced.tgl, 'hex')
            : protocol.serializeTglTable(profileData.advanced.tgl, tglRes.data);
          if (completeFour) {
            preparedTgl = protocol.preserveReservedTail(importedTgl, tglRes.data, protocol.TGL_RESERVED_OFFSET);
          } else if (tableLayers) {
            const merged = this._mergeImportedTable({
              kind: 'tgl',
              imported: importedTgl,
              device: tglRes.data,
              mergedLayers: tableLayers,
              importTouch,
              entrySize: protocol.TGL_ENTRY_SIZE,
              reservedOffset: protocol.TGL_RESERVED_OFFSET
            });
            if (!merged.ok) return { success: false, error: merged.error };
            preparedTgl = merged.buffer;
          }
        }

        let extrasBuf = Buffer.from(extrasRes.data);
        let extrasMutated = false;
        const extrasBySlot = new Map();
        if (typeof profileData.advanced.keyExtras === 'string') {
          for (const e of protocol.parseKeyExtras(Buffer.from(profileData.advanced.keyExtras, 'hex'))) {
            extrasBySlot.set(e.slot, e);
          }
        } else if (Array.isArray(profileData.advanced.keyExtras)) {
          for (const item of profileData.advanced.keyExtras) {
            const slot = item.slot !== undefined ? item.slot : item.index;
            extrasBySlot.set(slot, item);
          }
        }
        if (tableLayers) {
          for (let l = 0; l < 4; l++) {
            const buf = tableLayers[l];
            const count = Math.floor(buf.length / 3);
            for (let slot = 0; slot < count; slot++) {
              if (buf[slot * 3] !== protocol.KEY_TYPES.SOCD) continue;
              const item = extrasBySlot.get(slot);
              if (!item || item.priority === undefined) continue;
              extrasBuf = protocol.mutateKeyExtrasPriority(extrasBuf, slot, item.priority);
              extrasMutated = true;
            }
          }
        }
        preparedExtras = extrasMutated ? extrasBuf : null;
      }

      if (!this._genOk(startGen)) {
        return { success: false, error: 'Device reconnected or disconnected during transaction; aborting write' };
      }

      if (profileData.lighting || profileData.settings) {
        const funcWrite = await this._writeVerify(
          protocol.COMMANDS.SET_FUNC_CONFIG,
          64 * targetProfile,
          preparedFunc,
          startGen,
          { section: 'funcConfig', completedSections, ignoreBytes: new Set([32, 34]) }
        );
        if (!funcWrite.success) return funcWrite;
        if (profileData.lighting) completedSections.push('lighting');
        if (profileData.settings) completedSections.push('settings');
      }

      if (profileData.lightingMemory) {
        const importedMem = lightingMemory.validateImportedLightingMemory(profileData.lightingMemory);
        if (!importedMem.valid) {
          return this._failPartial({
            error: importedMem.error,
            completedSections,
            failedSection: 'lightingMemory'
          });
        }
        const memGuard = this._captureMemoryGuard();
        const memRead = await this._readLightMemoryInTransaction(targetProfile, startGen, memGuard);
        if (!memRead.success) {
          return this._failPartial({
            error: memRead.error || 'lighting memory prior was not usable; CMD 242 was not sent',
            completedSections,
            failedSection: 'lightingMemory'
          });
        }
        const memWrite = await this._writeLightMemoryInTransaction(
          targetProfile,
          importedMem.store,
          startGen,
          memGuard,
          memRead.raw || null
        );
        if (!memWrite.success) {
          return this._failPartial({
            error: memWrite.error || 'lighting memory write failed',
            completedSections,
            failedSection: 'lightingMemory'
          });
        }
        completedSections.push('lightingMemory');
      }

      if (preparedMt) {
        const mtWrite = await this._writeVerify(
          protocol.COMMANDS.SET_MT_KEYS,
          targetProfile * protocol.MT_TABLE_SIZE,
          preparedMt,
          startGen,
          { section: 'mtTable', completedSections }
        );
        if (!mtWrite.success) return mtWrite;
        completedSections.push('mtTable');
      }
      if (preparedTgl) {
        const tglWrite = await this._writeVerify(
          protocol.COMMANDS.SET_TGL_KEYS,
          targetProfile * protocol.TGL_TABLE_SIZE,
          preparedTgl,
          startGen,
          { section: 'tglTable', completedSections }
        );
        if (!tglWrite.success) return tglWrite;
        completedSections.push('tglTable');
      }
      if (preparedExtras) {
        const extrasWrite = await this._writeVerify(
          protocol.COMMANDS.SET_KEY_EXTRAS,
          targetProfile * protocol.KEY_EXTRAS_SIZE,
          preparedExtras,
          startGen,
          { section: 'keyExtras', completedSections }
        );
        if (!extrasWrite.success) return extrasWrite;
        completedSections.push('keyExtras');
      }

      for (const { layer, updates } of preparedLayers) {
        const layerWrite = await this._writeKeyTriples(targetProfile, layer, updates, startGen, {
          section: `layer${layer}`,
          completedSections
        });
        if (!layerWrite.success) return layerWrite;
        completedSections.push(`layer${layer}`);
      }

      if (preparedRgb) {
        const rgbWrite = await this._writeVerify(
          protocol.COMMANDS.SET_KEY_COLOR,
          targetProfile * protocol.TOTAL_KEY_AREA_SIZE,
          preparedRgb,
          startGen,
          { section: 'perKeyRgb', completedSections }
        );
        if (!rgbWrite.success) return rgbWrite;
        completedSections.push('perKeyRgb');
      }

      if (preparedMacros) {
        const macroWrite = await this._writeVerify(
          protocol.COMMANDS.SET_MACROS,
          0,
          preparedMacros,
          startGen,
          { section: 'macros', completedSections, timeoutMs: 1500 }
        );
        if (!macroWrite.success) return macroWrite;
        completedSections.push('macros');
        for (const plan of macroBindingPlan) {
          const bindWrite = await this._writeKeyTriples(plan.profileIndex, plan.layer, plan.updates, startGen, {
            section: 'macroBindings',
            completedSections
          });
          if (!bindWrite.success) return bindWrite;
        }
        if (macroBindingPlan.length > 0) completedSections.push('macroBindings');
      }

      return { success: true, completedSections };
    });
  }

  _dispatchResetNotification(note) {
    const correlated = Boolean(this.resetInFlight && this._resetDispatchStarted);
    for (const listener of this.resetNotificationListeners) {
      try {
        listener(note);
      } catch (err) {
        console.error('[Transport] Reset notification listener error:', err);
      }
    }
    if (correlated) return;
    this._abortStaleIoAfterUnsolicitedReset(note);
  }

  /**
   * Unsolicited hardware reset: abort in-flight and queued HID I/O by advancing
   * connection generation, cancelling pending packets, and closing this handle.
   * App-requested notes after device.write must not take this path so ACK wait survives.
   */
  _abortStaleIoAfterUnsolicitedReset(note) {
    this.abortAllMusicColor();
    this.generation++;
    this.resetEpoch++;
    this.resetInFlight = false;
    this._resetDispatchStarted = false;
    this.resetNotificationListeners.clear();

    for (const pending of this._pendingInFlight) {
      try {
        if (pending.timer) clearTimeout(pending.timer);
        if (pending.cancel) pending.cancel();
      } catch {}
    }
    this._pendingInFlight.clear();
    this.responseListeners.clear();

    const handle = this.device;
    this.device = null;
    if (handle) {
      try { handle.close(); } catch {}
    }
    this.deviceInfo = null;
    this.needsReconnect = true;
    this.statusError = 'The keyboard reported a factory reset that this app did not request';
    this.lastState.connected = false;
    this.clearLightingMemoryFallback('all');
    this._invalidateConfigCaches({ uncertain: true });
    this.configUncertain = true;
    this.lastResetOutcome = {
      success: false,
      uncertain: true,
      unsolicited: true,
      dispatched: false,
      notification: true,
      notificationKind: note && note.kind ? note.kind : null,
      error: 'The keyboard reported a factory reset that this app did not request'
    };
    this._notifyStateChange();
  }

  _deviceIdentity() {
    const d = this.lastState.device || {};
    return {
      path: d.path ?? null,
      vendorId: d.vendorId ?? null,
      productId: d.productId ?? null,
      serialNumber: d.serialNumber ?? null,
      interface: d.interface ?? null
    };
  }

  _fullIdentity(infoParsed) {
    return {
      ...this._deviceIdentity(),
      firmwareRaw: infoParsed && infoParsed.rawFirmwareVersion !== undefined
        ? infoParsed.rawFirmwareVersion
        : null,
      rfFirmwareRaw: infoParsed && infoParsed.rawRfFirmwareVersion !== undefined
        ? infoParsed.rawRfFirmwareVersion
        : null
    };
  }

  _identitiesMatch(expected, current) {
    if (!expected || !current) return false;
    if (
      expected.path !== current.path
      || expected.vendorId !== current.vendorId
      || expected.productId !== current.productId
      || expected.serialNumber !== current.serialNumber
      || expected.interface !== current.interface
    ) {
      return false;
    }
    if (
      expected.firmwareRaw != null
      && current.firmwareRaw != null
      && expected.firmwareRaw !== current.firmwareRaw
    ) {
      return false;
    }
    if (
      expected.rfFirmwareRaw != null
      && current.rfFirmwareRaw != null
      && expected.rfFirmwareRaw !== current.rfFirmwareRaw
    ) {
      return false;
    }
    return true;
  }

  _invalidateConfigCaches({ uncertain = false } = {}) {
    this._rawBase = null;
    this._rawFuncConfig = null;
    this._rawMacroRegion = null;
    this._rawKeyColors = null;
    this._rawMt = null;
    this._rawTgl = null;
    this._rawExtras = null;
    this.lastState.base = null;
    this.lastState.lighting = null;
    this.lastState.settings = null;
    this.lastState.keymaps = {};
    this.lastState.keyColors = null;
    this.lastState.macros = [];
    this.lastState.battery = { batteryLevel: null, isCharging: false };
    this.lastState.readSuccess = false;
    this.lastReadSuccess = false;
    this.configUncertain = Boolean(uncertain);
    this._lightMemoryCache = null;
    this.lastState.selectedLightEffect = ['still', ''];
    this._selectedLightEffectByProfile = {};
  }

  _waitUntil(predicate, timeoutMs) {
    if (predicate()) return Promise.resolve(true);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(predicate());
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (predicate()) {
          resolve(true);
          return;
        }
        if (Date.now() - start >= timeoutMs || !this.device) {
          resolve(predicate());
          return;
        }
        setTimeout(tick, 5);
      };
      tick();
    });
  }

  /**
   * Read-only review of the factory-reset target. Never sends CMD 238.
   * Active index is taken from a fresh GET_BASE, not the local edit target.
   */
  async prepareFactoryReset({ scope } = {}) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    if (scope !== 'active' && scope !== 'all') {
      return { success: false, error: 'scope must be "active" or "all"' };
    }

    try {
      return await this.runTransaction(async (startGen) => {
        let infoParsed = this.lastState.info || null;
        const infoRes = await this.readRange(protocol.COMMANDS.GET_INFO, 0, 56, 800, startGen);
        if (infoRes.success && infoRes.data) {
          const parsed = protocol.parseInfo(infoRes.data);
          if (parsed) {
            infoParsed = parsed;
            this.lastState.info = parsed;
          }
        }

        const baseRes = await this.readRange(protocol.COMMANDS.GET_BASE, 0, 56, 800, startGen);
        if (!baseRes.success || !baseRes.data || baseRes.data.length !== 56) {
          return { success: false, error: `Failed to read base configuration: ${baseRes.error || 'incomplete read'}` };
        }
        const parsedBase = protocol.parseBase(baseRes.data);
        if (!parsedBase) {
          return { success: false, error: 'Failed to parse base configuration' };
        }

        this._rawBase = parsedBase.rawBytes;
        this.lastState.base = {
          activeProfile: parsedBase.activeProfile,
          activeSlot: parsedBase.activeSlot,
          profileCount: parsedBase.profileCount,
          profileOrder: parsedBase.profileOrder
        };
        this.lastState.activeProfileIndex = parsedBase.activeProfile;

        let wireScope;
        try {
          wireScope = protocol.resolveFactoryResetScopeByte(scope, parsedBase.activeProfile);
        } catch (err) {
          return { success: false, error: err.message };
        }

        const editingProfileIndex = this.editTarget && Number.isInteger(this.editTarget.profileIndex)
          ? this.editTarget.profileIndex
          : parsedBase.activeProfile;

        return {
          success: true,
          scope,
          activeProfileIndex: parsedBase.activeProfile,
          activeSlot: parsedBase.activeSlot,
          profileCount: parsedBase.profileCount,
          editingProfileIndex,
          editingDiffersFromActive: editingProfileIndex !== parsedBase.activeProfile,
          identity: this._fullIdentity(infoParsed),
          generation: startGen,
          resetEpoch: this.resetEpoch,
          wireScope,
          exportIsSingleProfile: true,
          exportWarning: 'A single profile export is not a full-device backup. Export each onboard profile separately if you need more than the active profile.'
        };
      });
    } catch (err) {
      return { success: false, error: err.message || 'Failed to prepare factory reset' };
    }
  }

  /**
   * Commit a previously reviewed factory reset. Re-reads GET_BASE and rejects
   * stale identity / generation / active target instead of retargeting.
   * Registers reset-notification observation before dispatch. Never retries.
   */
  async commitFactoryReset(spec = {}) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect', dispatched: false };
    }
    if (!spec || (spec.scope !== 'active' && spec.scope !== 'all')) {
      return { success: false, error: 'scope must be "active" or "all"', dispatched: false };
    }
    if (this.generation !== spec.expectedGeneration) {
      return { success: false, error: 'Connection generation mismatch', dispatched: false };
    }
    if (this.resetEpoch !== spec.expectedResetEpoch) {
      return { success: false, error: 'Reset epoch mismatch; review is stale', dispatched: false };
    }
    if (!this._identitiesMatch(spec.expectedIdentity, this._fullIdentity(this.lastState.info))) {
      return { success: false, error: 'Hardware identity mismatch; refusing stale reset', dispatched: false };
    }

    const ackTimeoutMs = Number.isInteger(spec.ackTimeoutMs) ? spec.ackTimeoutMs : 1500;
    const notificationTimeoutMs = Number.isInteger(spec.notificationTimeoutMs)
      ? spec.notificationTimeoutMs
      : protocol.RESET_NOTIFICATION_TIMEOUT_MS;

    this.abortAllMusicColor();

    let attemptDispatched = false;
    try {
      return await this.runTransaction(async (startGen) => {
        if (this.generation !== spec.expectedGeneration || startGen !== spec.expectedGeneration) {
          return { success: false, error: 'Connection generation mismatch', dispatched: false };
        }
        if (this.resetEpoch !== spec.expectedResetEpoch) {
          return { success: false, error: 'Reset epoch mismatch; review is stale', dispatched: false };
        }
        if (!this._identitiesMatch(spec.expectedIdentity, this._fullIdentity(this.lastState.info))) {
          return { success: false, error: 'Hardware identity mismatch; refusing stale reset', dispatched: false };
        }

        const infoRes = await this.readRange(protocol.COMMANDS.GET_INFO, 0, 56, 800, startGen);
        if (this.resetEpoch !== spec.expectedResetEpoch) {
          return { success: false, error: 'Reset epoch mismatch; review is stale', dispatched: false };
        }
        if (infoRes.success && infoRes.data) {
          const parsedInfo = protocol.parseInfo(infoRes.data);
          if (parsedInfo) {
            this.lastState.info = parsedInfo;
            if (!this._identitiesMatch(spec.expectedIdentity, this._fullIdentity(parsedInfo))) {
              return { success: false, error: 'Hardware identity mismatch; refusing stale reset', dispatched: false };
            }
          }
        }

        const baseRes = await this.readRange(protocol.COMMANDS.GET_BASE, 0, 56, 800, startGen);
        if (this.resetEpoch !== spec.expectedResetEpoch) {
          return { success: false, error: 'Reset epoch mismatch; review is stale', dispatched: false };
        }
        if (!baseRes.success || !baseRes.data || baseRes.data.length !== 56) {
          return { success: false, error: `Failed to read base configuration: ${baseRes.error || 'incomplete read'}`, dispatched: false };
        }
        const parsedBase = protocol.parseBase(baseRes.data);
        if (!parsedBase) {
          return { success: false, error: 'Failed to parse base configuration', dispatched: false };
        }
        if (parsedBase.activeProfile !== spec.expectedActiveProfileIndex) {
          return {
            success: false,
            error: `Active profile changed (expected ${spec.expectedActiveProfileIndex}, now ${parsedBase.activeProfile}); stale target rejected`,
            dispatched: false
          };
        }

        let wireScope;
        try {
          wireScope = protocol.resolveFactoryResetScopeByte(spec.scope, parsedBase.activeProfile);
        } catch (err) {
          return { success: false, error: err.message, dispatched: false };
        }

        if (this.resetEpoch !== spec.expectedResetEpoch) {
          return { success: false, error: 'Reset epoch mismatch; review is stale', dispatched: false };
        }

        const dispatchEpoch = this.resetEpoch;
        this._resetDispatchStarted = false;
        let notified = false;
        let notificationKind = null;
        const onNote = (note) => {
          if (this.generation !== startGen) return;
          if (this.resetEpoch !== dispatchEpoch) return;
          if (!this._resetDispatchStarted) return;
          notified = true;
          notificationKind = note.kind;
        };

        this.resetNotificationListeners.add(onNote);
        this.resetInFlight = true;
        const startedAt = Date.now();
        let ackRes;
        try {
          ackRes = await this.sendPacket({
            command: protocol.COMMANDS.FACTORY_RESET,
            offset: 0,
            size: 1,
            data: [wireScope],
            timeoutMs: ackTimeoutMs,
            expectedGen: startGen,
            expectedResetEpoch: spec.expectedResetEpoch,
            onDispatch: () => {
              attemptDispatched = true;
              this._resetDispatchStarted = true;
            }
          });
          if (ackRes && ackRes.dispatched) {
            attemptDispatched = true;
            this._resetDispatchStarted = true;
          }

          if (!attemptDispatched) {
            return {
              success: false,
              uncertain: false,
              dispatched: false,
              aborted: Boolean(ackRes && ackRes.aborted),
              error: (ackRes && ackRes.error) || 'Factory reset command was not sent'
            };
          }

          this._invalidateConfigCaches({ uncertain: true });

          const elapsed = Date.now() - startedAt;
          const remaining = notificationTimeoutMs - elapsed;
          if (!notified) {
            await this._waitUntil(
              () => notified || this.generation !== startGen || !this.device,
              remaining
            );
          }
        } finally {
          this.resetNotificationListeners.delete(onNote);
          this.resetInFlight = false;
        }

        const ack = Boolean(ackRes && ackRes.success);
        const disconnected = !this.device || this.generation !== startGen;
        const aborted = Boolean((ackRes && ackRes.aborted) || disconnected);
        const confirmed = ack && notified && !disconnected;

        this.resetEpoch += 1;
        this._resetDispatchStarted = false;

        const outcome = {
          success: confirmed,
          uncertain: !confirmed,
          dispatched: true,
          aborted,
          ack,
          notification: notified,
          notificationKind: notified ? notificationKind : null,
          scope: spec.scope,
          wireScope,
          activeProfileIndex: parsedBase.activeProfile,
          error: confirmed
            ? undefined
            : (aborted
              ? (ackRes && ackRes.error) || 'Device disconnected during factory reset; result is uncertain'
              : (notified
                ? 'The keyboard may have been reset, but this app could not confirm it'
                : 'The reset command was sent, but this app could not confirm that the keyboard finished'))
        };
        if (confirmed) {
          this.configUncertain = false;
          outcome.error = undefined;
        } else {
          this.configUncertain = true;
          if (!ack && !disconnected) {
            this.needsReconnect = true;
            this.statusError = outcome.error;
          }
        }
        this.lastResetOutcome = outcome;
        this._notifyStateChange();
        return outcome;
      });
    } catch (err) {
      const dispatched = Boolean(attemptDispatched);
      this.resetInFlight = false;
      this._resetDispatchStarted = false;
      if (dispatched) {
        this.configUncertain = true;
        try {
          this._invalidateConfigCaches({ uncertain: true });
        } catch {}
        this.resetEpoch += 1;
        this._notifyStateChange();
      }
      const outcome = {
        success: false,
        uncertain: dispatched,
        dispatched,
        aborted: true,
        error: dispatched
          ? (err.message || 'Factory reset interrupted after the command was sent; result is uncertain')
          : (err.message || 'Factory reset aborted')
      };
      this.lastResetOutcome = outcome;
      return outcome;
    }
  }

  async _readCustomRegion(offset, length, startGen, startEpoch) {
    if (!this._profileStillCurrent(startGen, startEpoch)) {
      return { success: false, error: 'Device identity changed before custom-region read' };
    }
    const res = await this.readRange(protocol.COMMANDS.GET_CUSTOM_PARAM, offset, length, 800, startGen);
    if (!this._profileStillCurrent(startGen, startEpoch)) {
      return { success: false, error: 'Device identity changed during custom-region read' };
    }
    if (!res.success || !res.data || res.data.length !== length) {
      return { success: false, error: res.error || 'Custom-region read was incomplete' };
    }
    return { success: true, data: res.data };
  }

  async _writeCustomRegion(offset, buffer, startGen, startEpoch) {
    if (!this._profileStillCurrent(startGen, startEpoch)) {
      return { success: false, error: 'Device identity changed before custom-region write' };
    }
    const writeRes = await this.writeRange(
      protocol.COMMANDS.SET_CUSTOM_PARAM,
      offset,
      buffer,
      1500,
      startGen
    );
    if (!this._profileStillCurrent(startGen, startEpoch)) {
      return { success: false, error: 'Device identity changed during custom-region write' };
    }
    if (!writeRes.success) {
      return { success: false, error: writeRes.error || 'Custom-region write failed' };
    }
    const verify = await this._readCustomRegion(offset, buffer.length, startGen, startEpoch);
    if (!verify.success) {
      return { success: false, error: verify.error || 'Custom-region readback failed', uncertain: true };
    }
    for (let i = 0; i < buffer.length; i++) {
      if (verify.data[i] !== buffer[i]) {
        return { success: false, error: `Custom-region readback mismatch at byte ${i}`, uncertain: true };
      }
    }
    return { success: true, data: verify.data };
  }

  async _writeProfileNamesToAll(nameList, startGen, startEpoch) {
    const encoded = profileNames.encodeProfileNames(nameList);
    if (!encoded.valid) return { success: false, error: encoded.error, written: [], failed: [] };
    const timestamp = Date.now();
    const written = [];
    const failed = [];
    for (let slot = 0; slot < protocol.MAX_KEYBOARD_PROFILES; slot++) {
      if (!this._profileStillCurrent(startGen, startEpoch)) {
        failed.push({ slot, error: 'Device identity changed during name replication' });
        return {
          success: false,
          error: `Profile names written to slots [${written.join(', ')}] then identity changed before slot ${slot}`,
          written,
          failed,
          partial: true
        };
      }
      const fsRead = await this._readCustomRegion(
        profileNames.featureSupportOffset(slot),
        profileNames.FEATURE_SUPPORT_LENGTH,
        startGen,
        startEpoch
      );
      if (!fsRead.success) {
        failed.push({ slot, error: fsRead.error, section: 'featureSupport' });
        return {
          success: false,
          error: `Name replication stopped at slot ${slot}: ${fsRead.error}. Confirmed slots: [${written.join(', ')}]`,
          written,
          failed,
          partial: written.length > 0
        };
      }
      const decodedFs = profileNames.decodeFeatureSupport(fsRead.data);
      if (!decodedFs.valid) {
        failed.push({ slot, error: decodedFs.error, section: 'featureSupport' });
        return {
          success: false,
          error: `Name replication refused at slot ${slot}: ${decodedFs.error}. Feature-support was not overwritten. Confirmed slots: [${written.join(', ')}]`,
          written,
          failed,
          partial: written.length > 0
        };
      }
      const merged = profileNames.mergeFeatureSupport(decodedFs.support, { profileNameUpdatedAt: timestamp });
      if (!merged.valid) {
        failed.push({ slot, error: merged.error, section: 'featureSupport' });
        return { success: false, error: merged.error, written, failed, partial: written.length > 0 };
      }
      const nameWrite = await this._writeCustomRegion(
        profileNames.namesOffset(slot),
        encoded.buffer,
        startGen,
        startEpoch
      );
      if (!nameWrite.success) {
        failed.push({ slot, error: nameWrite.error, section: 'names' });
        return {
          success: false,
          error: `Name write failed at physical slot ${slot}: ${nameWrite.error}. Confirmed slots: [${written.join(', ')}]`,
          written,
          failed,
          partial: written.length > 0,
          uncertain: Boolean(nameWrite.uncertain)
        };
      }
      const fsWrite = await this._writeCustomRegion(
        profileNames.featureSupportOffset(slot),
        merged.buffer,
        startGen,
        startEpoch
      );
      if (!fsWrite.success) {
        failed.push({ slot, error: fsWrite.error, section: 'featureSupport' });
        return {
          success: false,
          error: `Names at slot ${slot} wrote, but feature-support timestamp failed: ${fsWrite.error}. Confirmed name slots: [${written.join(', ')}, ${slot}]`,
          written: written.concat(slot),
          failed,
          partial: true,
          uncertain: Boolean(fsWrite.uncertain)
        };
      }
      written.push(slot);
    }
    this._applyStoredProfileNames(nameList, 'hardware');
    return { success: true, written, failed, timestamp };
  }

  _applyStoredProfileNames(stored, source) {
    const padded = [];
    const src = Array.isArray(stored) ? stored : [];
    for (let i = 0; i < 4; i++) padded[i] = typeof src[i] === 'string' ? src[i] : '';
    this.lastState.profileNamesStored = padded;
    this.lastState.profileNames = profileNames.displayNamesFromStored(padded, 4);
    this.lastState.profileNamesSource = source || 'hardware';
  }

  _persistLocal(items, recovery) {
    const ident = this._profileIdentity();
    return profileLibrary.writeDevice(this._profileLibraryFile(), this._profileDeviceKey(), items, {
      identityKind: ident.kind,
      recovery
    });
  }

  _saveOutgoingRecovery(loaded, outgoingItem, reason) {
    const recovery = profileLibrary.prependRecovery(loaded.recovery || [], outgoingItem, reason);
    this._persistLocal(loaded.items || [], recovery);
    return recovery;
  }

  getProfileLibrary() {
    return this._loadProfileLibrary().snap;
  }

  async createLocalProfile(name) {
    const loaded = profileLibrary.readDevice(this._profileLibraryFile(), this._profileDeviceKey());
    if (!loaded.ok) {
      return { success: false, error: loaded.error, unwritable: true, profileLibrary: this._loadProfileLibrary({ error: loaded.error, unwritable: true }).snap };
    }
    const onboardCount = (this.lastState.base && this.lastState.base.profileCount) || 0;
    const existingNames = (this.lastState.profileNames || []).map((n) => ({ name: n }));
    const created = profileLibrary.createFromDefaults(loaded.items, name, onboardCount, existingNames);
    if (!created.valid) {
      return { success: false, error: created.error, profileLibrary: this._loadProfileLibrary().snap };
    }
    try {
      this._persistLocal(created.items, loaded.recovery);
    } catch (err) {
      return { success: false, error: err.message, profileLibrary: this._loadProfileLibrary({ error: err.message, unwritable: true }).snap };
    }
    const snap = this._loadProfileLibrary().snap;
    this._notifyStateChange();
    return { success: true, key: created.item.key, item: created.item, profileLibrary: snap, hardwareWrites: 0 };
  }

  async copyOnboardToLocal(profileIndex, name) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    if (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 3) {
      return { success: false, error: 'Invalid onboard profile index' };
    }
    const exported = await this.exportProfile(profileIndex);
    if (!exported.success) return exported;
    const loaded = profileLibrary.readDevice(this._profileLibraryFile(), this._profileDeviceKey());
    if (!loaded.ok) {
      return { success: false, error: loaded.error, unwritable: true, hardwareWrites: 0 };
    }
    const storedArr = this.lastState.profileNamesStored || [];
    const namesArr = this.lastState.profileNames || [];
    const copyName = name || storedArr[profileIndex] || namesArr[profileIndex] || `Profile ${profileIndex + 1}`;
    const onboardCount = (this.lastState.base && this.lastState.base.profileCount) || 0;
    const existingNames = (this.lastState.profileNames || []).map((n, i) => ({ name: n, key: i === profileIndex ? 'self' : `onboard:${i}` }));
    const copied = profileLibrary.copyOnboardToLocal(loaded.items, copyName, exported.data, { confirmShareFailed: false }, onboardCount, existingNames);
    if (!copied.valid) return { success: false, error: copied.error, hardwareWrites: 0 };
    try {
      this._persistLocal(copied.items, loaded.recovery);
    } catch (err) {
      return { success: false, error: err.message, hardwareWrites: 0 };
    }
    const snap = this._loadProfileLibrary().snap;
    this._notifyStateChange();
    return { success: true, key: copied.item.key, item: copied.item, profileLibrary: snap, hardwareWrites: 0 };
  }

  async renameProfile(spec = {}) {
    const key = spec.key;
    const name = spec.name;
    if (spec.kind === 'keyboard' || (typeof key === 'string' && key.startsWith('KeyboardProfile@keyboard@'))) {
      if (!this.device || this.needsReconnect) {
        return { success: false, error: 'Device not connected or requires reconnect' };
      }
      const slot = Number.isInteger(spec.profileIndex)
        ? spec.profileIndex
        : parseInt(String(key).split('@').pop(), 10);
      const loaded = profileLibrary.readDevice(this._profileLibraryFile(), this._profileDeviceKey());
      const existing = (this.lastState.profileNames || []).map((n, i) => ({ name: n, key: libraryOnboard(i) }));
      for (const item of loaded.items || []) existing.push({ name: item.name, key: item.key });
      const checked = profileNames.validateProfileName(name, { existing, ignoreKey: libraryOnboard(slot) });
      if (!checked.valid) return { success: false, error: checked.error };
      const nextNames = (this.lastState.profileNamesStored || ['', '', '', '']).slice();
      while (nextNames.length < 4) nextNames.push('');
      nextNames[slot] = checked.name;
      this.abortAllMusicColor();
      return this.runTransaction(async (startGen) => {
        const startEpoch = this.resetEpoch;
        const res = await this._writeProfileNamesToAll(nextNames, startGen, startEpoch);
        this._loadProfileLibrary();
        this._notifyStateChange();
        return res.success ? { ...res, profileLibrary: this.lastState.profileLibrary } : res;
      });
    }
    const loaded = profileLibrary.readDevice(this._profileLibraryFile(), this._profileDeviceKey());
    if (!loaded.ok) return { success: false, error: loaded.error, unwritable: true };
    const renamed = profileLibrary.renameItem(loaded.items, key, name, this.lastState.profileNames);
    if (!renamed.valid) return { success: false, error: renamed.error };
    try {
      this._persistLocal(renamed.items, loaded.recovery);
    } catch (err) {
      return { success: false, error: err.message };
    }
    const snap = this._loadProfileLibrary().snap;
    this._notifyStateChange();
    return { success: true, item: renamed.item, profileLibrary: snap, hardwareWrites: 0 };
  }

  async deleteLocalProfile(key) {
    const loaded = profileLibrary.readDevice(this._profileLibraryFile(), this._profileDeviceKey());
    if (!loaded.ok) return { success: false, error: loaded.error, unwritable: true };
    const removed = profileLibrary.deleteItem(loaded.items, key);
    if (!removed.valid) return { success: false, error: removed.error };
    try {
      this._persistLocal(removed.items, loaded.recovery);
    } catch (err) {
      return { success: false, error: err.message };
    }
    const snap = this._loadProfileLibrary().snap;
    this._notifyStateChange();
    return { success: true, profileLibrary: snap, hardwareWrites: 0 };
  }

  async reorderLocalProfiles(orderedKeys) {
    const loaded = profileLibrary.readDevice(this._profileLibraryFile(), this._profileDeviceKey());
    if (!loaded.ok) return { success: false, error: loaded.error, unwritable: true };
    const reordered = profileLibrary.reorderItems(loaded.items, orderedKeys);
    try {
      this._persistLocal(reordered.items, loaded.recovery);
    } catch (err) {
      return { success: false, error: err.message };
    }
    const snap = this._loadProfileLibrary().snap;
    this._notifyStateChange();
    return { success: true, profileLibrary: snap, hardwareWrites: 0 };
  }

  async saveLocalProfileDraft(key, data) {
    const loaded = profileLibrary.readDevice(this._profileLibraryFile(), this._profileDeviceKey());
    if (!loaded.ok) return { success: false, error: loaded.error, unwritable: true };
    const updated = profileLibrary.updateItemData(loaded.items, key, data);
    if (!updated.valid) return { success: false, error: updated.error };
    try {
      this._persistLocal(updated.items, loaded.recovery);
    } catch (err) {
      return { success: false, error: err.message };
    }
    const snap = this._loadProfileLibrary().snap;
    this._notifyStateChange();
    return { success: true, item: updated.item, profileLibrary: snap, hardwareWrites: 0 };
  }

  loadLocalProfilePreview(key) {
    const loaded = profileLibrary.readDevice(this._profileLibraryFile(), this._profileDeviceKey());
    if (!loaded.ok) return { success: false, error: loaded.error, unwritable: true };
    const item = (loaded.items || []).find((row) => row.key === key);
    if (!item) return { success: false, error: 'Profile was not found' };
    this.editSource = { kind: 'local', key };
    this.lastState.editSource = { kind: 'local', key };
    this._notifyStateChange();
    return { success: true, item, hardwareWrites: 0, preview: true };
  }

  async importOfficialProfile(raw) {
    const inspected = profileFile.inspectOfficialEnvelope(raw);
    if (!inspected.valid) return { success: false, error: inspected.error, hardwareWrites: 0 };
    const loaded = profileLibrary.readDevice(this._profileLibraryFile(), this._profileDeviceKey());
    if (!loaded.ok) return { success: false, error: loaded.error, unwritable: true, hardwareWrites: 0 };
    const onboardCount = (this.lastState.base && this.lastState.base.profileCount) || 0;
    const existingNames = (this.lastState.profileNames || []).map((n) => ({ name: n }));
    const created = profileLibrary.copyOnboardToLocal(
      loaded.items,
      inspected.name,
      inspected.native,
      inspected.extra,
      onboardCount,
      existingNames
    );
    if (!created.valid) return { success: false, error: created.error, hardwareWrites: 0 };
    try {
      this._persistLocal(created.items, loaded.recovery);
    } catch (err) {
      return { success: false, error: err.message, hardwareWrites: 0 };
    }
    const snap = this._loadProfileLibrary().snap;
    this._notifyStateChange();
    return { success: true, key: created.item.key, item: created.item, profileLibrary: snap, hardwareWrites: 0 };
  }

  async exportOfficialProfile(spec = {}) {
    let item = spec.item;
    if (!item && spec.key) {
      const loaded = profileLibrary.readDevice(this._profileLibraryFile(), this._profileDeviceKey());
      item = (loaded.items || []).find((row) => row.key === spec.key);
    }
    if (!item && Number.isInteger(spec.profileIndex)) {
      const exported = await this.exportProfile(spec.profileIndex);
      if (!exported.success) return exported;
      item = {
        name: (this.lastState.profileNames || [])[spec.profileIndex] || `Profile ${spec.profileIndex + 1}`,
        type: 'keyboard',
        data: exported.data
      };
    }
    if (!item) return { success: false, error: 'Nothing to export' };
    const device = this.lastState.device || {};
    const envelope = profileFile.exportOfficialEnvelope(item, {
      receiver: Boolean(device.isReceiver || device.productId === G75_V2_RECEIVER_PID),
      identity: {
        vendorId: device.vendorId || profileFile.G75_VID,
        productId: device.productId || profileFile.G75_WIRED_PID,
        productName: device.productName || (device.isReceiver ? profileFile.G75_RECEIVER_NAME : profileFile.G75_WIRED_NAME)
      },
      fw_ver: this.lastState.info && this.lastState.info.firmwareVersion,
      rffw_ver: this.lastState.info && this.lastState.info.rfFirmwareVersion
    });
    if (!envelope.valid) return { success: false, error: envelope.error };
    return { success: true, data: envelope.envelope };
  }

  async _prepareLibraryWriteData(data, targetSlot, startGen, startEpoch) {
    const payload = this._toApplyPayload(data);
    if (!Array.isArray(payload.macros) || payload.macros.length === 0) {
      return { success: true, payload };
    }
    const currentMacros = await this.readRange(protocol.COMMANDS.GET_MACROS, 0, protocol.SHARED_MACRO_SIZE, 1500, startGen);
    if (!this._profileStillCurrent(startGen, startEpoch)) {
      return { success: false, error: 'Device identity changed while reading macros' };
    }
    if (!currentMacros.success) return { success: false, error: currentMacros.error };
    let parsed;
    try {
      parsed = protocol.parseMacroRegion(currentMacros.data);
    } catch (err) {
      return { success: false, error: err.message };
    }
    const otherLayers = [];
    for (let p = 0; p < 4; p++) {
      if (p === targetSlot) continue;
      const layersRes = await this._readProfileLayers(p, startGen);
      if (!this._profileStillCurrent(startGen, startEpoch)) {
        return { success: false, error: 'Device identity changed while reading other profiles for macro remap' };
      }
      if (!layersRes.success) return layersRes;
      const maps = {};
      for (let l = 0; l < 4; l++) {
        const parsedLayer = protocol.parseKeyMatrix(layersRes.layers[l], l);
        const map = {};
        for (const k of parsedLayer) {
          map[String(k.index)] = { type: k.type, code1: k.code1, code2: k.code2 };
        }
        maps[String(l)] = map;
      }
      otherLayers.push(maps);
    }
    const reserved = profileFile.collectLayerMacroSlots(otherLayers);
    const plan = profileFile.planMacroRemap(payload.macros, parsed, reserved);
    if (!plan.valid) return plan;
    payload.macros = plan.slots;
    payload.layers = profileFile.rewriteMacroBindings(payload.layers, plan.remap, plan.slots);
    if (payload.macroMetadata) {
      payload.macroMetadata = profileFile.remapMacroMetadata(payload.macroMetadata, plan.remap);
    }
    return { success: true, payload, remap: plan.remap };
  }

  async _applyBaseConfig(spec, startGen, startEpoch) {
    const baseRes = await this.readRange(protocol.COMMANDS.GET_BASE, 0, 56, 800, startGen);
    if (!this._profileStillCurrent(startGen, startEpoch)) {
      return { success: false, error: 'Device identity changed before SET_BASE' };
    }
    if (!baseRes.success || !baseRes.data) {
      return { success: false, error: baseRes.error || 'Failed to read base before profile list update' };
    }
    let mutated;
    try {
      mutated = protocol.mutateBaseConfig(baseRes.data, spec);
    } catch (err) {
      return { success: false, error: err.message };
    }
    const verified = await this._writeVerify(protocol.COMMANDS.SET_BASE, 0, mutated, startGen, { section: 'base' });
    if (!verified.success) return verified;
    const parsed = protocol.parseBase(verified.data);
    this._rawBase = verified.data;
    this.lastState.activeProfileIndex = parsed.activeProfile;
    this.lastState.base = {
      activeProfile: parsed.activeProfile,
      activeSlot: parsed.activeSlot,
      profileCount: parsed.profileCount,
      profileOrder: parsed.profileOrder
    };
    return { success: true, base: this.lastState.base };
  }

  async _executeHardwarePlan(plan) {
    if (!this.device || this.needsReconnect) {
      return { success: false, error: 'Device not connected or requires reconnect' };
    }
    const startGen = this.generation;
    const startEpoch = this.resetEpoch;
    const wasPlaying = Boolean(this.gifPlayer && this.gifPlayer.isPlaying);
    const gifName = this.lastState.selectedLightEffect && this.lastState.selectedLightEffect[0] === 'gif'
      ? this.lastState.selectedLightEffect[1]
      : null;
    this.abortAllMusicColor();
    const completedSections = [];
    const loaded = profileLibrary.readDevice(this._profileLibraryFile(), this._profileDeviceKey());
    if (!loaded.ok) {
      return { success: false, error: loaded.error, unwritable: true };
    }

    if (plan.preserveOutgoing && plan.outgoingLocalKey) {
      const outgoingItem = plan.list.find((item) => item.key === plan.outgoingLocalKey);
      if (outgoingItem && outgoingItem.needsHardwareRead) {
        const slot = Number.isInteger(plan.targetSlot) ? plan.targetSlot : plan.removedSlot;
        const exported = await this.exportProfile(slot);
        if (!this._profileStillCurrent(startGen, startEpoch)) {
          return { success: false, error: 'Device identity changed while saving the outgoing onboard profile' };
        }
        if (!exported.success) return exported;
        outgoingItem.data = exported.data;
        outgoingItem.needsHardwareRead = false;
      }
      try {
        loaded.recovery = this._saveOutgoingRecovery(loaded, outgoingItem, 'outgoing-onboard');
      } catch (err) {
        return { success: false, error: `Outgoing profile could not be saved locally before hardware write: ${err.message}` };
      }
    }

    if (plan.writeProfile && plan.writeProfile.data) {
      const prepared = await this._prepareLibraryWriteData(plan.writeProfile.data, plan.writeProfile.slot, startGen, startEpoch);
      if (!prepared.success) return prepared;
      if (!this._profileStillCurrent(startGen, startEpoch)) {
        return { success: false, error: 'Device identity changed before profile write' };
      }
      const applyRes = await this.applyProfile(prepared.payload, plan.writeProfile.slot);
      if (!this._profileStillCurrent(startGen, startEpoch)) {
        return {
          success: false,
          error: 'Device identity changed during profile write. Outgoing data was kept in local recovery.',
          recoveryRetained: Boolean(plan.preserveOutgoing),
          completedSections: applyRes && applyRes.completedSections,
          uncertain: true,
          hardwareRollback: false
        };
      }
      if (!applyRes.success) {
        return {
          success: false,
          error: applyRes.error || 'Profile write failed',
          completedSections: applyRes.completedSections,
          failedSection: applyRes.failedSection,
          uncertain: applyRes.uncertain,
          recoveryRetained: Boolean(plan.preserveOutgoing),
          hardwareRollback: false
        };
      }
      completedSections.push('profile');
    }

    const localItems = plan.list.filter((item) => item.type === profileLibrary.LOCAL_TYPE).map((item) => {
      const copy = { ...item };
      delete copy.needsHardwareRead;
      return copy;
    });
    try {
      this._persistLocal(localItems, loaded.recovery);
    } catch (err) {
      return {
        success: false,
        error: `Could not persist the local profile list: ${err.message}`,
        completedSections,
        hardwareRollback: false
      };
    }
    completedSections.push('local');

    return this.runTransaction(async (gen) => {
      if (gen !== startGen || this.resetEpoch !== startEpoch) {
        return { success: false, error: 'Device identity changed before name/base update', completedSections, hardwareRollback: false };
      }
      const namesRes = await this._writeProfileNamesToAll(plan.names, gen, startEpoch);
      if (!namesRes.success) {
        return {
          success: false,
          error: namesRes.error,
          completedSections,
          failedSection: 'names',
          partial: namesRes.partial,
          writtenNameSlots: namesRes.written,
          recoveryRetained: Boolean(plan.preserveOutgoing),
          hardwareRollback: false
        };
      }
      completedSections.push('names');

      if (plan.length !== undefined && plan.order) {
        const active = Number.isInteger(plan.activate)
          ? plan.activate
          : (this.lastState.activeProfileIndex || (plan.keyboard[0] && plan.keyboard[0].profileIndex));
        const baseRes = await this._applyBaseConfig({
          profileCount: plan.length,
          profileOrder: plan.order,
          activeProfile: Number.isInteger(active) ? active : plan.keyboard[0].profileIndex
        }, gen, startEpoch);
        if (!baseRes.success) {
          return {
            success: false,
            error: baseRes.error,
            completedSections,
            failedSection: 'base',
            recoveryRetained: Boolean(plan.preserveOutgoing),
            hardwareRollback: false
          };
        }
        completedSections.push('base');
      }

      this._loadProfileLibrary();
      const active = this.lastState.activeProfileIndex;
      this.editSource = { kind: 'onboard', profileIndex: Number.isInteger(active) ? active : 0 };
      this.lastState.editSource = this.editSource;
      if (wasPlaying && gifName) {
        const gifSnap = this._loadGifLibrary();
        const gifItem = (gifSnap.items || []).find((g) => g.name === gifName);
        if (gifItem && this.lastState.activeProfileIndex === (this.lastState.base && this.lastState.base.activeProfile)) {
          try {
            this._startGifStreaming(gifItem);
          } catch {
            // GIF restart is best-effort after a confirmed profile write
          }
        }
      }
      this._notifyStateChange();
      return {
        success: true,
        completedSections,
        profileLibrary: this.lastState.profileLibrary,
        hardwareRollback: false
      };
    });
  }

  _currentListState() {
    const loaded = this._loadProfileLibrary();
    const base = this.lastState.base || { profileOrder: [0, 1, 2, 3], profileCount: 0, activeProfile: 0 };
    return {
      list: loaded.hw.list,
      order: base.profileOrder,
      length: base.profileCount,
      activeIndex: base.activeProfile
    };
  }

  async moveLocalToOnboard(sourceKey, targetKey, options = {}) {
    const state = this._currentListState();
    const plan = profileOps.planLocalToOnboard(state, sourceKey, targetKey || null, options);
    if (!plan.valid) return { success: false, error: plan.error };
    return this._executeHardwarePlan(plan, options);
  }

  async copyOnboardToOnboard(sourceKey, targetKey, options = {}) {
    const state = this._currentListState();
    const source = (state.list || []).find((item) => item.key === sourceKey);
    if (!source || !Number.isInteger(source.profileIndex)) {
      return { success: false, error: 'Onboard profile was not found' };
    }
    const srcExport = await this.exportProfile(source.profileIndex);
    if (!srcExport.success) return srcExport;
    const plan = profileOps.planOnboardCopy(state, sourceKey, targetKey, { ...options, sourceData: srcExport.data });
    if (!plan.valid) return { success: false, error: plan.error };
    return this._executeHardwarePlan(plan, options);
  }

  async moveOnboardToLocal(sourceKey, localTargetKey) {
    const state = this._currentListState();
    const plan = profileOps.planOnboardToLocal(state, sourceKey, localTargetKey);
    if (!plan.valid) return { success: false, error: plan.error };
    const res = await this._executeHardwarePlan(plan);
    if (res && res.success) {
      const unbound = this._releaseAppBindForOnboardKey(sourceKey, { autoUnbound: true });
      if (unbound.changed) {
        res.autoUnbound = true;
        res.removedAppBind = unbound.removed;
        res.binds = unbound.binds;
      }
    }
    return res;
  }

  async deleteOnboardProfile(key) {
    const state = this._currentListState();
    const plan = profileOps.planDelete(state, key);
    if (!plan.valid) return { success: false, error: plan.error };
    const res = await this._executeHardwarePlan(plan);
    if (res && res.success) {
      const unbound = this._releaseAppBindForOnboardKey(key, { autoUnbound: true });
      if (unbound.changed) {
        res.autoUnbound = true;
        res.removedAppBind = unbound.removed;
        res.binds = unbound.binds;
      }
    }
    return res;
  }

  async reorderProfiles(orderedKeys) {
    const state = this._currentListState();
    const plan = profileOps.planReorder(state, orderedKeys);
    if (!plan.valid) return { success: false, error: plan.error };
    const hasOnboardShift = plan.order.some((v, i) => v !== (state.order || [])[i]) || plan.length !== state.length;
    if (!hasOnboardShift) {
      return this.reorderLocalProfiles(orderedKeys);
    }
    return this._executeHardwarePlan(plan);
  }

  setEditSource(spec = {}) {
    if (spec.kind === 'local' && typeof spec.key === 'string') {
      this.editSource = { kind: 'local', key: spec.key };
      this.lastState.editSource = this.editSource;
      return { success: true, editSource: { ...this.editSource }, hardwareWrites: 0 };
    }
    const profileIndex = Number.isInteger(spec.profileIndex) ? spec.profileIndex : 0;
    const res = this.setEditTarget(profileIndex, spec.layer);
    this.editSource = { kind: 'onboard', profileIndex };
    this.lastState.editSource = this.editSource;
    return res.success ? { ...res, editSource: { ...this.editSource } } : res;
  }
}

function libraryOnboard(slot) {
  return profileLibrary.onboardKey(slot);
}

module.exports = new DeviceTransport();
