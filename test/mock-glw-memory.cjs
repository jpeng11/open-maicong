/**
 * In-memory GLW HID adapter for mocked tests.
 * Never opens a real HID handle. Writes persist unless dropCommands is set.
 */
const protocol = require('../src/protocol.cjs');

const READ_REGION = {
  [protocol.COMMANDS.GET_INFO]: 'info',
  [protocol.COMMANDS.GET_BASE]: 'base',
  [protocol.COMMANDS.GET_FUNC_CONFIG]: 'func',
  [protocol.COMMANDS.GET_DEFAULT_KEY_MATRIX]: 'defaultKeys',
  [protocol.COMMANDS.GET_USER_KEY_MATRIX]: 'userKeys',
  [protocol.COMMANDS.GET_KEY_COLOR]: 'colors',
  [protocol.COMMANDS.GET_MACROS]: 'macros',
  [protocol.COMMANDS.GET_KEY_EXTRAS]: 'extras',
  [protocol.COMMANDS.GET_MT_KEYS]: 'mt',
  [protocol.COMMANDS.GET_TGL_KEYS]: 'tgl',
  [protocol.COMMANDS.GET_CUSTOM_PARAM]: 'custom'
};

const WRITE_REGION = {
  [protocol.COMMANDS.SET_FUNC_CONFIG]: 'func',
  [protocol.COMMANDS.SET_USER_KEY_MATRIX]: 'userKeys',
  [protocol.COMMANDS.SET_KEY_COLOR]: 'colors',
  [protocol.COMMANDS.SET_MACROS]: 'macros',
  [protocol.COMMANDS.SET_BASE]: 'base',
  [protocol.COMMANDS.SET_KEY_EXTRAS]: 'extras',
  [protocol.COMMANDS.SET_MT_KEYS]: 'mt',
  [protocol.COMMANDS.SET_TGL_KEYS]: 'tgl',
  [protocol.COMMANDS.SET_CUSTOM_PARAM]: 'custom'
};

function makeResetNotificationBuffer(kind = 'a2') {
  const buf = Buffer.alloc(64, 0);
  if (kind === 'fafbff') {
    buf[0] = 0xFA;
    buf[1] = 0xFB;
    buf[2] = 0xFF;
  } else {
    buf[0] = 0xA2;
  }
  return buf;
}

function makeReplyBuffer({ command, status = 0, offset = 0, data = [] }) {
  const buf = Buffer.alloc(64, 0);
  buf[0] = protocol.FLAG_RESPONSE;
  buf[1] = command;
  buf[2] = status;
  buf[4] = data.length;
  buf[5] = offset & 0xFF;
  buf[6] = (offset >> 8) & 0xFF;
  buf[7] = 0;
  const payload = Array.isArray(data) ? data : Array.from(data);
  for (let i = 0; i < payload.length; i++) buf[8 + i] = payload[i];
  buf[3] = protocol.calculateChecksum([payload.length, offset & 0xFF, (offset >> 8) & 0xFF, 0, ...payload]);
  return buf;
}

class MockGlwMemoryDevice {
  constructor(options = {}) {
    this.listeners = {};
    this.writtenBuffers = [];
    this.closed = false;
    this.dropCommands = new Set(options.dropCommands || []);
    this.failCommands = new Set(options.failCommands || []);
    this.failWriteOffsets = new Set(options.failWriteOffsets || []);
    this.dropWriteOffsets = new Set(options.dropWriteOffsets || []);
    this.replyDelayMs = options.replyDelayMs || 0;
    this.delayCommands = new Map();
    this.delayOnceCommands = new Map();
    this.omitAckCommands = new Set(options.omitAckCommands || []);
    this.resetNotifyMode = options.resetNotifyMode || 'after-ack';
    this.resetNotifyKind = options.resetNotifyKind || 'a2';
    this.resetNotifyDelayMs = options.resetNotifyDelayMs || 0;
    this.info = Buffer.alloc(56, 0);
    this.base = Buffer.alloc(56, 0);
    this.func = Buffer.alloc(64 * 4, 0);
    this.userKeys = Buffer.alloc(4 * 4 * 512, 0);
    this.defaultKeys = Buffer.alloc(4 * 512, 0);
    this.colors = Buffer.alloc(4 * 512, 0);
    this.macros = Buffer.alloc(8192, 0);
    this.mt = Buffer.alloc(4 * 256, 0);
    this.tgl = Buffer.alloc(4 * 128, 0);
    this.extras = Buffer.alloc(4 * 1024, 0);
    this.custom = Buffer.alloc(4 * 1024, 0);
    if (options.seed !== false) this.seedFromFixtures();
  }

  seedFromFixtures() {
    const baseline = require('./fixtures/readonly-baseline.json');
    const advanced = require('./fixtures/advanced-baseline.json');
    const defaultLayers = require('./fixtures/default-layers.json');
    const profileConfigs = require('./fixtures/profile-configs.json');

    Buffer.from(baseline.base, 'hex').copy(this.base);
    Buffer.from(baseline.macros, 'hex').copy(this.macros);
    const infoReply = require('./fixtures/info-reply.json');
    Buffer.from(infoReply.query56.payloadHex, 'hex').copy(this.info);

    const mtHex = Buffer.from(advanced.mt, 'hex');
    const tglHex = Buffer.from(advanced.tgl, 'hex');
    const extrasHex = Buffer.from(advanced.keyExtras, 'hex');
    const rgbHex = Buffer.from(baseline.rgb, 'hex');

    for (let p = 0; p < 4; p++) {
      Buffer.from(profileConfigs[String(p)], 'hex').copy(this.func, p * 64);
      mtHex.copy(this.mt, p * 256);
      tglHex.copy(this.tgl, p * 128);
      extrasHex.copy(this.extras, p * 1024);
      rgbHex.copy(this.colors, p * 512);
      for (let l = 0; l < 4; l++) {
        const layer = Buffer.from(baseline.layers[l], 'hex');
        layer.copy(this.userKeys, (p * 4 + l) * 512);
        Buffer.from(defaultLayers[String(l)], 'hex').copy(this.defaultKeys, l * 512);
      }
    }
  }

  on(event, handler) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }

  emit(event, data) {
    if (this.closed) return;
    for (const h of this.listeners[event] || []) h(data);
  }

  _scheduleReply(fn, cmd) {
    let delay = this.replyDelayMs;
    if (this.delayOnceCommands.has(cmd)) {
      delay = this.delayOnceCommands.get(cmd);
      this.delayOnceCommands.delete(cmd);
    } else if (this.delayCommands.has(cmd)) {
      delay = this.delayCommands.get(cmd);
    }
    if (delay > 0) setTimeout(fn, delay);
    else setImmediate(fn);
  }

  write(buf) {
    if (this.closed) throw new Error('Device is closed');
    this.writtenBuffers.push(Buffer.from(buf));
    const cmd = buf[2];
    const size = buf[5];
    const offset = buf[6] | (buf[7] << 8);
    const payload = Buffer.from(buf.subarray(9, 9 + size));

    if (this.failCommands.has(cmd)) {
      this._scheduleReply(
        () => this.emit('data', makeReplyBuffer({ command: cmd, status: 1, offset, data: [] })),
        cmd
      );
      return;
    }

    const writeRegion = WRITE_REGION[cmd];
    if (writeRegion) {
      if (this.failWriteOffsets.has(offset)) {
        this._scheduleReply(
          () => this.emit('data', makeReplyBuffer({ command: cmd, status: 1, offset, data: [] })),
          cmd
        );
        return;
      }
      if (!this.dropCommands.has(cmd) && !this.dropWriteOffsets.has(offset)) {
        payload.copy(this[writeRegion], offset);
      }
      this._scheduleReply(() => this.emit('data', makeReplyBuffer({ command: cmd, offset, data: [] })), cmd);
      return;
    }

    if (cmd === protocol.COMMANDS.FACTORY_RESET) {
      const ackFn = () => {
        if (this.closed || this.omitAckCommands.has(cmd)) return;
        this.emit('data', makeReplyBuffer({ command: cmd, offset, data: [] }));
      };
      const notifyFn = () => {
        if (this.closed || this.resetNotifyMode === 'none') return;
        this.emit('data', makeResetNotificationBuffer(this.resetNotifyKind));
      };
      this._scheduleReply(() => {
        if (this.resetNotifyMode === 'before-ack') {
          notifyFn();
          ackFn();
        } else if (this.resetNotifyMode === 'late') {
          ackFn();
          setTimeout(notifyFn, this.resetNotifyDelayMs || 20);
        } else if (this.resetNotifyMode === 'none') {
          ackFn();
        } else {
          ackFn();
          notifyFn();
        }
      }, cmd);
      return;
    }

    const readRegion = READ_REGION[cmd];
    if (readRegion) {
      const region = this[readRegion];
      const chunk = Buffer.alloc(size, 0);
      if (offset < region.length) {
        region.copy(chunk, 0, offset, Math.min(offset + size, region.length));
      }
      this._scheduleReply(
        () => this.emit('data', makeReplyBuffer({ command: cmd, offset, data: Array.from(chunk) })),
        cmd
      );
    }
  }

  close() {
    this.closed = true;
    this.listeners = {};
  }

  reopen() {
    this.closed = false;
    this.listeners = {};
  }

  wroteCommand(command) {
    return this.writtenBuffers.some((b) => b[2] === command);
  }

  pokeUserKey(profileIndex, layer, slot, tuple) {
    const off = (profileIndex * 4 + layer) * 512 + slot * 3;
    this.userKeys[off] = tuple[0];
    this.userKeys[off + 1] = tuple[1];
    this.userKeys[off + 2] = tuple[2];
  }

  readUserKey(profileIndex, layer, slot) {
    const off = (profileIndex * 4 + layer) * 512 + slot * 3;
    return [this.userKeys[off], this.userKeys[off + 1], this.userKeys[off + 2]];
  }

  mtEntry(profileIndex, index) {
    const off = profileIndex * 256 + index * 6;
    return {
      tap: [this.mt[off], this.mt[off + 1], this.mt[off + 2]],
      hold: [this.mt[off + 3], this.mt[off + 4], this.mt[off + 5]]
    };
  }

  extrasByte1(profileIndex, slot) {
    return this.extras[profileIndex * 1024 + slot * 8 + 1];
  }
}

module.exports = { MockGlwMemoryDevice, makeReplyBuffer, makeResetNotificationBuffer };
