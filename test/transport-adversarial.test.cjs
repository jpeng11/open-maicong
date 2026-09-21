const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const transport = require('../src/transport.cjs');
const protocol = require('../src/protocol.cjs');
const validators = require('../src/schema-validators.cjs');
const { MockGlwMemoryDevice } = require('./mock-glw-memory.cjs');

// Load baseline from reproducible fixtures for mock responses
const baseline = require('./fixtures/readonly-baseline.json');

/**
 * Mock HID device helper that intercepts writes and emits data events
 */
class MockHIDDevice {
  constructor() {
    this.listeners = {};
    this.writtenBuffers = [];
    this.customResponder = null;
    this.closed = false;
  }

  on(event, handler) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }

  emit(event, data) {
    if (this.closed) return;
    const handlers = this.listeners[event] || [];
    for (const h of handlers) h(data);
  }

  write(buf) {
    if (this.closed) throw new Error('Device is closed');
    this.writtenBuffers.push(Buffer.from(buf));

    if (this.customResponder) {
      this.customResponder(buf, this);
    }
  }

  close() {
    this.closed = true;
    this.listeners = {};
  }
}

/**
 * Helper to construct valid 64-byte GLW reply buffer
 */
function makeReplyBuffer({ command, status = 0, offset = 0, data = [] }) {
  const buf = Buffer.alloc(64, 0);
  buf[0] = protocol.FLAG_RESPONSE; // 0xAA
  buf[1] = command;
  buf[2] = status;
  buf[4] = data.length;
  buf[5] = offset & 0xFF;
  buf[6] = (offset >> 8) & 0xFF;
  buf[7] = 0; // reserved = 0

  const payload = Array.isArray(data) ? data : Array.from(data);
  for (let i = 0; i < payload.length; i++) {
    buf[8 + i] = payload[i];
  }

  const checksumParticipants = [payload.length, offset & 0xFF, (offset >> 8) & 0xFF, 0, ...payload];
  buf[3] = protocol.calculateChecksum(checksumParticipants);
  return buf;
}

/**
 * Helper to attach mock device to transport
 */
function attachMockDevice(mock) {
  transport.device = mock;
  transport.lastState.connected = true;
  transport.needsReconnect = false;
  mock.on('data', data => transport.handleIncomingData(data));
}

describe('Adversarial Mocked Transport & Safety Verification', () => {
  beforeEach(() => {
    transport.disconnect();
  });

  afterEach(() => {
    transport.disconnect();
  });

  test('1. Disconnect and offline safety: all mutation operations fail honestly (never fake success)', async () => {
    assert.strictEqual(transport.device, null);

    // Profile switch offline
    const profRes = await transport.switchProfile(1);
    assert.strictEqual(profRes.success, false);
    assert.strictEqual(profRes.savedOffline, undefined);
    assert.match(profRes.error, /not connected/i);

    // Lighting offline
    const lightRes = await transport.applyLighting({ brightness: 50 });
    assert.strictEqual(lightRes.success, false);
    assert.strictEqual(lightRes.savedOffline, undefined);
    assert.match(lightRes.error, /not connected/i);

    // Settings offline
    const setRes = await transport.applySettings({ sleepTime: 10 });
    assert.strictEqual(setRes.success, false);
    assert.strictEqual(setRes.savedOffline, undefined);
    assert.match(setRes.error, /not connected/i);

    // Keymap offline
    const keyRes = await transport.applyKeymap(0, 0, [{ slot: 0, type: 16, code1: 0, code2: 41 }]);
    assert.strictEqual(keyRes.success, false);
    assert.strictEqual(keyRes.savedOffline, undefined);
    assert.match(keyRes.error, /not connected/i);

    // Macros offline
    const macroRes = await transport.applyMacros([]);
    assert.strictEqual(macroRes.success, false);
    assert.strictEqual(macroRes.savedOffline, undefined);
    assert.match(macroRes.error, /not connected/i);

    // Per-key RGB offline
    const rgbRes = await transport.applyKeyColors(0, {});
    assert.strictEqual(rgbRes.success, false);
    assert.match(rgbRes.error, /not connected/i);

    const advRes = await transport.applyAdvancedBinding({
      profileIndex: 0, layer: 0, slot: 11, kind: 'tgl', targetKey: [16, 0, 4]
    });
    assert.strictEqual(advRes.success, false);
    assert.match(advRes.error, /not connected/i);

    const enableRes = await transport.enableProfiles(4);
    assert.strictEqual(enableRes.success, false);
    assert.match(enableRes.error, /not connected/i);
  });

  test('2. Checksum corruption rejection: sendPacket fails if reply checksum is invalid', async () => {
    const mock = new MockHIDDevice();
    mock.customResponder = (writtenBuf, dev) => {
      // Return packet with deliberately corrupted checksum
      const cmd = writtenBuf[2];
      const reply = makeReplyBuffer({ command: cmd, offset: 0, data: [1, 2, 3] });
      reply[3] = (reply[3] + 1) & 0xFF; // Corrupt checksum
      setImmediate(() => dev.emit('data', reply));
    };

    attachMockDevice(mock);

    const res = await transport.sendPacket({ command: 4, offset: 0, size: 56 });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.checksumValid, false);
    assert.match(res.error, /checksum mismatch/i);
  });

  test('3. Nonzero reserved byte rejection: sendPacket fails if reserved byte 7 is nonzero', async () => {
    const mock = new MockHIDDevice();
    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      const reply = makeReplyBuffer({ command: cmd, offset: 0, data: [1, 2, 3] });
      reply[7] = 0x55; // Nonzero reserved byte
      // Recalculate checksum so checksum is valid, but reserved is bad
      reply[3] = protocol.calculateChecksum([3, 0, 0, 0, 1, 2, 3]);
      setImmediate(() => dev.emit('data', reply));
    };

    attachMockDevice(mock);

    const res = await transport.sendPacket({ command: 4, offset: 0, size: 56 });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /reserved byte/i);
  });

  test('4. No-write-on-read-failure: failed read aborts mutation and prevents destructive zero writes', async () => {
    const mock = new MockHIDDevice();
    let writeAttempts = 0;

    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      if (cmd === protocol.COMMANDS.GET_BASE) {
        // Return status error on read
        const reply = makeReplyBuffer({ command: cmd, status: 1, offset: 0, data: [] });
        setImmediate(() => dev.emit('data', reply));
      } else if (cmd === protocol.COMMANDS.SET_BASE) {
        writeAttempts++;
      }
    };

    attachMockDevice(mock);

    const res = await transport.switchProfile(1);
    assert.strictEqual(res.success, false);
    assert.match(res.error, /failed to read/i);
    // Verified: zero write packets were sent!
    assert.strictEqual(writeAttempts, 0);
  });

  test('5. Readback verification failure: detects mismatch between written and readback data', async () => {
    const mock = new MockHIDDevice();
    const baseBytes = Buffer.from(baseline.base, 'hex');

    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      if (cmd === protocol.COMMANDS.GET_BASE) {
        // Return original base (activeProfile = 0) even after write attempt (simulating hardware write failure)
        const reply = makeReplyBuffer({ command: cmd, offset: 0, data: Array.from(baseBytes) });
        setImmediate(() => dev.emit('data', reply));
      } else if (cmd === protocol.COMMANDS.SET_BASE) {
        // Acknowledge write with status 0
        const reply = makeReplyBuffer({ command: cmd, status: 0, offset: 0, data: [] });
        setImmediate(() => dev.emit('data', reply));
      }
    };

    attachMockDevice(mock);

    // Switch to profile 1
    const res = await transport.switchProfile(1);
    assert.strictEqual(res.success, false);
    assert.match(res.error, /readback mismatch/i);
  });

  test('6. Non-physical reserved slot rejection: applyKeymap refuses to write to reserved matrix slots', async () => {
    const mock = new MockHIDDevice();
    attachMockDevice(mock);

    // Slot 7 is a reserved non-physical slot in the default matrix (not in the 82 physical keys)
    const res = await transport.applyKeymap(0, 0, [
      { slot: 7, type: 16, code1: 0, code2: 71 }
    ]);

    assert.strictEqual(res.success, false);
    assert.match(res.error, /non-physical slot: 7/i);
    // Ensure no HID write was dispatched
    assert.strictEqual(mock.writtenBuffers.length, 0);
  });

  test('7. Macro storage overflow rejection: refuses to write macro actions exceeding 4096 bytes', async () => {
    const mock = new MockHIDDevice();
    const macroBytes = Buffer.from(baseline.macros, 'hex');

    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      const offset = writtenBuf[6] | (writtenBuf[7] << 8);
      const size = writtenBuf[5];
      if (cmd === protocol.COMMANDS.GET_MACROS) {
        const chunk = macroBytes.subarray(offset, offset + size);
        const reply = makeReplyBuffer({ command: cmd, offset, data: Array.from(chunk) });
        setImmediate(() => dev.emit('data', reply));
      }
    };

    attachMockDevice(mock);

    // Build 1500 actions (6,000 bytes > 4096)
    const giantActions = [];
    for (let i = 0; i < 1500; i++) {
      giantActions.push({ action: 'keydown', code: 4, delay: 20 });
    }

    const slots = [
      { id: 0, name: 'Overflow Macro', type: 0, actions: giantActions }
    ];

    const res = await transport.applyMacros(slots);
    assert.strictEqual(res.success, false);
    assert.match(res.error, /capacity exceeded/i);
    assert.strictEqual(mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_MACROS).length, 0, 'overflow must dispatch zero HID writes');
  });

  test('7b. Genuine unique overcapacity across multiple slots rejected with zero HID writes', async () => {
    const mock = new MockHIDDevice();
    const macroBytes = Buffer.from(baseline.macros, 'hex');

    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      const offset = writtenBuf[6] | (writtenBuf[7] << 8);
      const size = writtenBuf[5];
      if (cmd === protocol.COMMANDS.GET_MACROS) {
        const chunk = macroBytes.subarray(offset, offset + size);
        const reply = makeReplyBuffer({ command: cmd, offset, data: Array.from(chunk) });
        setImmediate(() => dev.emit('data', reply));
      }
    };

    attachMockDevice(mock);

    // Slot 0 has 600 unique actions; Slot 1 has 600 DIFFERENT unique actions -> 1200 total unique > 1007
    const acts0 = Array.from({ length: 600 }, (_, i) => ({ action: 'keydown', code: 4 + (i % 20), delay: 20 + i }));
    const acts1 = Array.from({ length: 600 }, (_, i) => ({ action: 'keyup', code: 5 + (i % 20), delay: 100 + i }));

    const slots = [
      { id: 0, type: 0, actions: acts0 },
      { id: 1, type: 1, actions: acts1 }
    ];

    const res = await transport.applyMacros(slots);
    assert.strictEqual(res.success, false);
    assert.match(res.error, /capacity exceeded/i);
    assert.strictEqual(mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_MACROS).length, 0, 'genuine unique overflow must dispatch 0 SET_MACROS writes');
  });

  test('7c. Duplicate long macros with different playback share offsets accepted and written successfully', async () => {
    const mock = new MockHIDDevice();
    let currentMacroBytes = Buffer.from(baseline.macros, 'hex');

    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      const offset = writtenBuf[6] | (writtenBuf[7] << 8);
      const size = writtenBuf[5];
      if (cmd === protocol.COMMANDS.GET_MACROS) {
        const chunk = currentMacroBytes.subarray(offset, offset + size);
        const reply = makeReplyBuffer({ command: cmd, offset, data: Array.from(chunk) });
        setImmediate(() => dev.emit('data', reply));
      } else if (cmd === protocol.COMMANDS.SET_MACROS) {
        const data = writtenBuf.subarray(9, 9 + size);
        data.copy(currentMacroBytes, offset);
        const reply = makeReplyBuffer({ command: cmd, offset, data: Array.from(data) });
        setImmediate(() => dev.emit('data', reply));
      } else if (cmd === protocol.COMMANDS.GET_USER_KEY_MATRIX) {
        const reply = makeReplyBuffer({ command: cmd, offset, data: new Array(size).fill(0) });
        setImmediate(() => dev.emit('data', reply));
      }
    };

    attachMockDevice(mock);

    // Duplicate 700-action macro in slot 0 (type 0) and slot 1 (type 1) -> 1400 actions total, but only 700 unique
    const duplicateActions = Array.from({ length: 700 }, (_, i) => ({
      action: i % 2 === 0 ? 'keydown' : 'keyup',
      code: 4 + (i % 15),
      delay: 30
    }));

    const slots = [
      { id: 0, type: 0, actions: duplicateActions },
      { id: 1, type: 1, actions: duplicateActions }
    ];

    const res = await transport.applyMacros(slots);
    assert.strictEqual(res.success, true, res.error);
    const writes = mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_MACROS);
    assert.ok(writes.length > 0, 'successful deduplicated apply must dispatch SET_MACROS writes');

    // Verify written buffer reuses offset 68 for both slot 0 and slot 1
    const off0 = currentMacroBytes[0] | (currentMacroBytes[1] << 8);
    const off1 = currentMacroBytes[2] | (currentMacroBytes[3] << 8);
    assert.strictEqual(off0, 68);
    assert.strictEqual(off1, 68);
    assert.strictEqual(currentMacroBytes[34], 0, 'slot 0 playback type 0');
    assert.strictEqual(currentMacroBytes[35], 1, 'slot 1 playback type 1');
  });

  test('8. Transaction preservation: sequential execution under transactionLock prevents race conditions', async () => {
    const mock = new MockHIDDevice();
    const baseBytes = Buffer.from(baseline.base, 'hex');
    let currentProfile = 0;
    const executionOrder = [];

    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      if (cmd === protocol.COMMANDS.GET_BASE) {
        const copy = Buffer.from(baseBytes);
        copy[0] = currentProfile; // Active slot matches currentProfile
        const reply = makeReplyBuffer({ command: cmd, offset: 0, data: Array.from(copy) });
        setImmediate(() => dev.emit('data', reply));
      } else if (cmd === protocol.COMMANDS.SET_BASE) {
        currentProfile = writtenBuf[9]; // Updated slot
        executionOrder.push(currentProfile);
        const reply = makeReplyBuffer({ command: cmd, status: 0, offset: 0, data: [] });
        setImmediate(() => dev.emit('data', reply));
      }
    };

    attachMockDevice(mock);

    // Launch two profile switches concurrently
    const p1 = transport.switchProfile(1);
    const p2 = transport.switchProfile(2);

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(r1.success, true);
    assert.strictEqual(r2.success, true);
    assert.strictEqual(executionOrder.length, 2);
    // Profile switches executed sequentially without race conditions
    assert.strictEqual(executionOrder[0], 1);
    assert.strictEqual(executionOrder[1], 2);
    assert.strictEqual(transport.lastState.activeProfileIndex, 2);
  });

  test('9. Timeout handling: sets needsReconnect and rejects late replies', async () => {
    const mock = new MockHIDDevice();
    let capturedReply = null;

    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      capturedReply = makeReplyBuffer({ command: cmd, offset: 0, data: [1, 2, 3] });
      // Intentionally do NOT reply before timeout
    };

    attachMockDevice(mock);

    // Send with very short timeout
    const res = await transport.sendPacket({ command: 4, offset: 0, size: 56, timeoutMs: 50 });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.timeout, true);
    assert.strictEqual(transport.needsReconnect, true);

    // Emit delayed late reply after timeout
    if (capturedReply) {
      mock.emit('data', capturedReply);
    }

    // Subsequent command must immediately reject because transport needs reconnect
    const res2 = await transport.sendPacket({ command: 4, offset: 0, size: 56, timeoutMs: 50 });
    assert.strictEqual(res2.success, false);
    assert.match(res2.error, /requires reconnect/i);
  });

  test('10. Readback verification failure on unchanged memory: lighting brightness', async () => {
    const mock = new MockHIDDevice();
    const funcBytes = Buffer.from(baseline.config, 'hex');

    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      const offset = writtenBuf[6] | (writtenBuf[7] << 8);
      const size = writtenBuf[5];
      if (cmd === protocol.COMMANDS.GET_FUNC_CONFIG) {
        // Return original unchanged funcConfig (brightness still original value)
        const chunk = funcBytes.subarray(offset, offset + size);
        const reply = makeReplyBuffer({ command: cmd, offset, data: Array.from(chunk) });
        setImmediate(() => dev.emit('data', reply));
      } else if (cmd === protocol.COMMANDS.SET_FUNC_CONFIG) {
        // ACK with success status 0, simulating hardware that accepted packet but dropped write
        const reply = makeReplyBuffer({ command: cmd, status: 0, offset, data: [] });
        setImmediate(() => dev.emit('data', reply));
      }
    };

    attachMockDevice(mock);

    const res = await transport.applyLighting({ brightness: 25 }, 0);
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Lighting readback mismatch at byte 9/i);
  });

  test('11. Readback verification failure on unchanged memory: lighting color', async () => {
    const mock = new MockHIDDevice();
    const funcBytes = Buffer.from(baseline.config, 'hex');

    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      const offset = writtenBuf[6] | (writtenBuf[7] << 8);
      const size = writtenBuf[5];
      if (cmd === protocol.COMMANDS.GET_FUNC_CONFIG) {
        // Return original unchanged funcConfig
        const chunk = funcBytes.subarray(offset, offset + size);
        const reply = makeReplyBuffer({ command: cmd, offset, data: Array.from(chunk) });
        setImmediate(() => dev.emit('data', reply));
      } else if (cmd === protocol.COMMANDS.SET_FUNC_CONFIG) {
        // ACK with status 0
        const reply = makeReplyBuffer({ command: cmd, status: 0, offset, data: [] });
        setImmediate(() => dev.emit('data', reply));
      }
    };

    attachMockDevice(mock);

    const res = await transport.applyLighting({ hexColor: '#FF5500' }, 0);
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Lighting readback mismatch/i);
  });

  test('12. Readback verification failure on unchanged memory: settings polling rate', async () => {
    const mock = new MockHIDDevice();
    const funcBytes = Buffer.from(baseline.config, 'hex');

    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      const offset = writtenBuf[6] | (writtenBuf[7] << 8);
      const size = writtenBuf[5];
      if (cmd === protocol.COMMANDS.GET_FUNC_CONFIG) {
        const chunk = funcBytes.subarray(offset, offset + size);
        const reply = makeReplyBuffer({ command: cmd, offset, data: Array.from(chunk) });
        setImmediate(() => dev.emit('data', reply));
      } else if (cmd === protocol.COMMANDS.SET_FUNC_CONFIG) {
        const reply = makeReplyBuffer({ command: cmd, status: 0, offset, data: [] });
        setImmediate(() => dev.emit('data', reply));
      }
    };

    attachMockDevice(mock);

    // Baseline funcConfig byte 4 has low nibble 1 (8kHz). Request 4 (1kHz).
    const res = await transport.applySettings({ reporteRate: 4 }, 0);
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Settings readback mismatch at byte 4/i);
  });

  test('13. Readback verification failure on unchanged memory: settings sleepTime', async () => {
    const mock = new MockHIDDevice();
    const funcBytes = Buffer.from(baseline.config, 'hex');

    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      const offset = writtenBuf[6] | (writtenBuf[7] << 8);
      const size = writtenBuf[5];
      if (cmd === protocol.COMMANDS.GET_FUNC_CONFIG) {
        const chunk = funcBytes.subarray(offset, offset + size);
        const reply = makeReplyBuffer({ command: cmd, offset, data: Array.from(chunk) });
        setImmediate(() => dev.emit('data', reply));
      } else if (cmd === protocol.COMMANDS.SET_FUNC_CONFIG) {
        const reply = makeReplyBuffer({ command: cmd, status: 0, offset, data: [] });
        setImmediate(() => dev.emit('data', reply));
      }
    };

    attachMockDevice(mock);

    // Baseline sleepTime is 6 (3 min). Request 20 (10 min).
    const res = await transport.applySettings({ sleepTime: 20 }, 0);
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Settings readback mismatch at byte 35/i);
  });

  test('14. Readback verification failure on unchanged memory: per-key RGB', async () => {
    const mock = new MockHIDDevice();
    const keyColorBytes = Buffer.from(baseline.rgb, 'hex');

    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      const offset = writtenBuf[6] | (writtenBuf[7] << 8);
      const size = writtenBuf[5];
      if (cmd === protocol.COMMANDS.GET_KEY_COLOR) {
        // Return original unchanged key colors
        const chunk = keyColorBytes.subarray(offset, offset + size);
        const reply = makeReplyBuffer({ command: cmd, offset, data: Array.from(chunk) });
        setImmediate(() => dev.emit('data', reply));
      } else if (cmd === protocol.COMMANDS.SET_KEY_COLOR) {
        // ACK with status 0
        const reply = makeReplyBuffer({ command: cmd, status: 0, offset, data: [] });
        setImmediate(() => dev.emit('data', reply));
      }
    };

    attachMockDevice(mock);

    const res = await transport.applyKeyColors(0, { 0: '#FF00FF' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Key colors readback mismatch/i);
  });

  test('15. Readback verification failure on unchanged memory: macros', async () => {
    const mock = new MockHIDDevice();
    const macroBytes = Buffer.from(baseline.macros, 'hex');

    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      const offset = writtenBuf[6] | (writtenBuf[7] << 8);
      const size = writtenBuf[5];
      if (cmd === protocol.COMMANDS.GET_MACROS) {
        // Return original unchanged macros
        const chunk = macroBytes.subarray(offset, offset + size);
        const reply = makeReplyBuffer({ command: cmd, offset, data: Array.from(chunk) });
        setImmediate(() => dev.emit('data', reply));
      } else if (cmd === protocol.COMMANDS.SET_MACROS) {
        // ACK with status 0
        const reply = makeReplyBuffer({ command: cmd, status: 0, offset, data: [] });
        setImmediate(() => dev.emit('data', reply));
      }
    };

    attachMockDevice(mock);

    const slots = protocol.parseMacroRegion(macroBytes);
    slots[0].actions.push({ action: 'keydown', code: 4, delay: 20 });
    slots[0].actions.push({ action: 'keyup', code: 4, delay: 20 });

    const res = await transport.applyMacros(slots);
    assert.strictEqual(res.success, false);
    assert.match(res.error, /readback mismatch/i);
  });

  test('16. Incomplete reads block mutation: partial key colors read aborts write', async () => {
    const mock = new MockHIDDevice();
    let writeAttempts = 0;

    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      if (cmd === protocol.COMMANDS.GET_KEY_COLOR) {
        // Return only first chunk then error on second chunk
        const offset = writtenBuf[6] | (writtenBuf[7] << 8);
        if (offset === 0) {
          const reply = makeReplyBuffer({ command: cmd, offset: 0, data: new Array(56).fill(0) });
          setImmediate(() => dev.emit('data', reply));
        } else {
          const reply = makeReplyBuffer({ command: cmd, status: 1, offset, data: [] });
          setImmediate(() => dev.emit('data', reply));
        }
      } else if (cmd === protocol.COMMANDS.SET_KEY_COLOR) {
        writeAttempts++;
      }
    };

    attachMockDevice(mock);

    const res = await transport.applyKeyColors(0, { 0: '#FF0000' });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /failed to read complete/i);
    // Verified: zero write packets were sent!
    assert.strictEqual(writeAttempts, 0);
  });

  test('17. Incomplete reads block mutation: partial macro read aborts write', async () => {
    const mock = new MockHIDDevice();
    let writeAttempts = 0;

    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      if (cmd === protocol.COMMANDS.GET_MACROS) {
        const offset = writtenBuf[6] | (writtenBuf[7] << 8);
        if (offset < 200) {
          const reply = makeReplyBuffer({ command: cmd, offset, data: new Array(56).fill(0) });
          setImmediate(() => dev.emit('data', reply));
        } else {
          const reply = makeReplyBuffer({ command: cmd, status: 1, offset, data: [] });
          setImmediate(() => dev.emit('data', reply));
        }
      } else if (cmd === protocol.COMMANDS.SET_MACROS) {
        writeAttempts++;
      }
    };

    attachMockDevice(mock);

    const res = await transport.applyMacros([
      { id: 0, name: 'Macro 1', type: 0, actions: [{ action: 'keydown', code: 4, delay: 20 }] }
    ]);
    assert.strictEqual(res.success, false);
    assert.match(res.error, /failed to read complete/i);
    // Verified: zero write packets were sent!
    assert.strictEqual(writeAttempts, 0);
  });

  test('18. Reconnect between read and write aborts transaction and dispatches 0 writes to replacement', async () => {
    const mock1 = new MockHIDDevice();
    const mock2 = new MockHIDDevice();
    const funcBytes = Buffer.from(baseline.config, 'hex');

    // Mock 1 responds to read, then immediately simulates a disconnect/reconnect event
    mock1.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      const offset = writtenBuf[6] | (writtenBuf[7] << 8);
      const size = writtenBuf[5];
      if (cmd === protocol.COMMANDS.GET_FUNC_CONFIG) {
        const chunk = funcBytes.subarray(offset, offset + size);
        const reply = makeReplyBuffer({ command: cmd, offset, data: Array.from(chunk) });
        setImmediate(() => {
          dev.emit('data', reply);
          // If this is the last chunk of the read (offset 56), simulate disconnect & attach mock2
          if (offset === 56) {
            transport.disconnect();
            attachMockDevice(mock2);
          }
        });
      }
    };

    attachMockDevice(mock1);

    const res = await transport.applyLighting({ brightness: 40 }, 0);
    assert.strictEqual(res.success, false);
    assert.match(res.error, /reconnected or disconnected/i);

    // Verified: 0 write packets were sent to replacement device mock2!
    assert.strictEqual(mock2.writtenBuffers.length, 0);
  });

  test('19. Mid-chunk reconnect during multi-chunk write aborts immediately and dispatches 0 writes to replacement', async () => {
    const mock1 = new MockHIDDevice();
    const mock2 = new MockHIDDevice();

    mock1.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      const offset = writtenBuf[6] | (writtenBuf[7] << 8);
      const size = writtenBuf[5];

      // Respond to first chunk, then disconnect and attach mock2
      const reply = makeReplyBuffer({ command: cmd, offset, data: [] });
      setImmediate(() => {
        dev.emit('data', reply);
        if (offset === 0) {
          transport.disconnect();
          attachMockDevice(mock2);
        }
      });
    };

    attachMockDevice(mock1);

    const twoChunkBuffer = Buffer.alloc(112, 0x5A);
    const res = await transport.writeRange(protocol.COMMANDS.SET_FUNC_CONFIG, 0, twoChunkBuffer);

    assert.strictEqual(res.success, false);
    // Verified: Exactly 1 write sent to mock1, and ZERO writes sent to mock2!
    assert.strictEqual(mock1.writtenBuffers.length, 1);
    assert.strictEqual(mock2.writtenBuffers.length, 0, 'No subsequent packet may be sent to replacement device handle');
  });

  test('20. In-flight disconnect settles pending promises immediately and does not poison new connection via timer', async () => {
    const mock1 = new MockHIDDevice();
    const mock2 = new MockHIDDevice();

    attachMockDevice(mock1);

    // Launch a pending request with a 200ms timeout
    const pendingPromise = transport.sendPacket({
      command: protocol.COMMANDS.GET_BASE,
      offset: 0,
      size: 56,
      timeoutMs: 200
    });

    // Disconnect almost immediately (5ms)
    await new Promise(r => setTimeout(r, 5));
    transport.disconnect();

    // The pending promise MUST settle promptly without waiting for 200ms timeout
    const settleResult = await pendingPromise;
    assert.strictEqual(settleResult.success, false);
    assert.strictEqual(settleResult.timeout, false);

    // Connect replacement device
    attachMockDevice(mock2);
    assert.strictEqual(transport.needsReconnect, false);

    // Wait past the original 200ms timeout to ensure stale timer does not poison new connection
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(transport.needsReconnect, false, 'Late timer must not set needsReconnect on new connection');
  });

  test('21. CMD 3 request-matched checksum in sendPacket: request for 56 must not accept 38-echo', async () => {
    const mock = new MockHIDDevice();

    // Device returns echo checksum 0x26 (38) when query was 56
    // Hardware payload has real non-zero bytes so calculated payload checksum != 0x26
    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      if (cmd === protocol.COMMANDS.GET_INFO) {
        const buf = Buffer.alloc(64, 0);
        buf[0] = protocol.FLAG_RESPONSE;
        buf[1] = cmd;
        buf[2] = 0; // status
        buf[3] = 0x26; // Echoed 38-checksum (valid for size 38 query, but WRONG for size 56 query)
        buf[4] = 38; // returned size 38
        buf[5] = 0;
        buf[6] = 0;
        buf[7] = 0;
        buf[8] = 0x14; // FW low byte
        buf[9] = 0x01; // FW high byte
        setImmediate(() => dev.emit('data', buf));
      }
    };

    attachMockDevice(mock);

    const res = await transport.sendPacket({
      command: protocol.COMMANDS.GET_INFO,
      offset: 0,
      size: 56,
      timeoutMs: 300
    });

    assert.strictEqual(res.success, false, 'Request for size 56 must reject 38-echo');
    assert.match(res.error, /checksum/i);
  });

  test('22. Recovery: timeout sets needsReconnect, safe reconnect clears it and fresh query succeeds without retrying writes', async () => {
    const mock = new MockHIDDevice();

    attachMockDevice(mock);

    // 1. Trigger timeout
    const timeoutRes = await transport.sendPacket({
      command: protocol.COMMANDS.GET_BASE,
      offset: 0,
      size: 56,
      timeoutMs: 20
    });

    assert.strictEqual(timeoutRes.success, false);
    assert.strictEqual(timeoutRes.timeout, true);
    assert.strictEqual(transport.needsReconnect, true);

    // Subsequent write or send must be rejected while needsReconnect is true
    const blockedRes = await transport.sendPacket({
      command: protocol.COMMANDS.GET_BASE,
      offset: 0,
      size: 56
    });
    assert.strictEqual(blockedRes.success, false);
    assert.match(blockedRes.error, /requires reconnect/i);

    // 2. Perform safe reconnect (reconnect clears needsReconnect and resets state)
    transport.disconnect();
    const mockRecovered = new MockHIDDevice();
    const baseBytes = Buffer.from(baseline.base, 'hex');

    mockRecovered.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      const offset = writtenBuf[6] | (writtenBuf[7] << 8);
      const size = writtenBuf[5];
      if (cmd === protocol.COMMANDS.GET_INFO) {
        const reply = makeReplyBuffer({ command: cmd, offset, data: new Array(size).fill(0) });
        setImmediate(() => dev.emit('data', reply));
      } else if (cmd === protocol.COMMANDS.GET_BASE) {
        const chunk = baseBytes.subarray(offset, offset + size);
        const reply = makeReplyBuffer({ command: cmd, offset, data: Array.from(chunk) });
        setImmediate(() => dev.emit('data', reply));
      } else if (cmd === protocol.COMMANDS.GET_FUNC_CONFIG || cmd === protocol.COMMANDS.GET_CUSTOM_PARAM) {
        const reply = makeReplyBuffer({ command: cmd, offset, data: new Array(size).fill(0) });
        setImmediate(() => dev.emit('data', reply));
      }
    };

    attachMockDevice(mockRecovered);
    assert.strictEqual(transport.needsReconnect, false);

    // 3. Read fresh queryStatus
    const statusRes = await transport.queryStatus();
    assert.strictEqual(statusRes.connected, true);
    assert.notStrictEqual(statusRes.base, null);
    assert.strictEqual(statusRes.base.activeProfile, 0);

    // Zero configuration writes occurred
    assert.strictEqual(mockRecovered.writtenBuffers.every(b => b[2] === protocol.COMMANDS.GET_BASE || b[2] === protocol.COMMANDS.GET_INFO || b[2] === protocol.COMMANDS.GET_FUNC_CONFIG || b[2] === protocol.COMMANDS.GET_CUSTOM_PARAM), true);
  });

  test('23. Canonical key colors serialization accepts both slot and index without dropping', () => {
    // Array with 'slot'
    const colorsSlot = [{ slot: 11, hex: '#FF0000' }];
    const bufSlot = protocol.serializeKeyColors(colorsSlot);
    assert.strictEqual(bufSlot[11 * 3], 255);
    assert.strictEqual(bufSlot[11 * 3 + 1], 0);
    assert.strictEqual(bufSlot[11 * 3 + 2], 0);

    // Array with 'index'
    const colorsIndex = [{ index: 11, hex: '#FF0000' }];
    const bufIndex = protocol.serializeKeyColors(colorsIndex);
    assert.strictEqual(bufIndex[11 * 3], 255);

    // Object with '11'
    const colorsObj = { 11: '#FF0000' };
    const bufObj = protocol.serializeKeyColors(colorsObj);
    assert.strictEqual(bufObj[11 * 3], 255);
  });

  test('24. exportProfile reads physical slots only, generates valid schema, and rejects reserved slots', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMockDevice(mock);

    const res = await transport.exportProfile(0);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data.model, 'MCHOSE G75 V2');
    assert.strictEqual(res.data.protocol, 'GLW');
    assert.strictEqual(res.data.version, '2.0.0');

    // Verify exactly 82 physical slots per layer (excluding reserved 82..127)
    for (let l = 0; l < 4; l++) {
      const layerMap = res.data.layers[String(l)];
      assert.ok(layerMap, `Layer ${l} must exist`);
      assert.strictEqual(Object.keys(layerMap).length, 82, `Layer ${l} must contain exactly 82 physical slots`);
      // Reserved/unmapped slots (like 112, 120, 127) must not be exported
      assert.strictEqual(layerMap['112'], undefined);
      assert.strictEqual(layerMap['120'], undefined);
      assert.strictEqual(layerMap['127'], undefined);
    }

    // Verify exactly 83 lighting slots (knob slot 37 excluded from lighting: 80 physical keys + 3 split space zones)
    assert.strictEqual(Object.keys(res.data.perKeyRgb).length, 83);
    assert.strictEqual(res.data.perKeyRgb['37'], undefined);
    assert.ok(res.data.lighting.calibrationRgb);
    assert.ok(res.data.advanced);
    assert.strictEqual(res.data.advanced.mt.length, 512);
    assert.strictEqual(res.data.settings.macMode, 2);

    // Verify full profile schema validates cleanly
    const schemaValidation = validators.validateProfileSchema(res.data);
    assert.strictEqual(schemaValidation.valid, true, `Exported profile must pass strict schema validator: ${schemaValidation.error}`);
  });

  test('25. applyProfile prevalidates schema before ANY write and rejects invalid profiles fail-closed', async () => {
    const mock = new MockHIDDevice();
    attachMockDevice(mock);

    // 1. Invalid schema with garbage keys
    const invalidRes1 = await transport.applyProfile({ unexpected: 'not a backup' });
    assert.strictEqual(invalidRes1.success, false);
    assert.match(invalidRes1.error, /invalid profile schema/i);
    assert.strictEqual(mock.writtenBuffers.length, 0, 'Zero writes sent on invalid schema');

    // 2. Invalid schema with invalid layer key
    const invalidRes2 = await transport.applyProfile({
      model: 'MCHOSE G75 V2',
      protocol: 'GLW',
      version: '2.0.0',
      lighting: { effect: 0 },
      settings: { macMode: 2 },
      layers: { '0junk': null },
      perKeyRgb: {},
      macros: []
    });
    assert.strictEqual(invalidRes2.success, false);
    assert.match(invalidRes2.error, /invalid profile schema/i);
    assert.strictEqual(mock.writtenBuffers.length, 0, 'Zero writes sent on non-canonical layer key');
  });

  test('26. Short read replies are rejected: readRange fails instead of returning truncated data', async () => {
    const mock = new MockHIDDevice();

    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      if (cmd === protocol.COMMANDS.GET_USER_KEY_MATRIX) {
        // Answer every read with 8 valid bytes regardless of the requested size
        const offset = writtenBuf[6] | (writtenBuf[7] << 8);
        const reply = makeReplyBuffer({ command: cmd, offset, data: new Array(8).fill(0) });
        setImmediate(() => dev.emit('data', reply));
      }
    };

    attachMockDevice(mock);

    const res = await transport.readRange(protocol.COMMANDS.GET_USER_KEY_MATRIX, 0, 384);
    assert.strictEqual(res.success, false);
    assert.match(res.error, /size mismatch|incomplete/i);
    assert.strictEqual(res.data, undefined, 'truncated buffer must not be reported as data');

    const layer = await transport.readLayer(0, 0);
    assert.strictEqual(layer.success, false);
    assert.match(layer.error, /size mismatch|incomplete/i);
  });

  test('27. GET_INFO offset 0 still accepts the verified 38-byte reply to a 56-byte request', async () => {
    const mock = new MockHIDDevice();
    const infoFixture = require('./fixtures/info-reply.json');
    const payload = Buffer.from(infoFixture.query56.payloadHex, 'hex').subarray(0, 38);
    assert.strictEqual(payload.length, 38);

    mock.customResponder = (writtenBuf, dev) => {
      const cmd = writtenBuf[2];
      if (cmd === protocol.COMMANDS.GET_INFO) {
        const reply = makeReplyBuffer({ command: cmd, offset: 0, data: Array.from(payload) });
        setImmediate(() => dev.emit('data', reply));
      }
    };

    attachMockDevice(mock);

    const res = await transport.readRange(protocol.COMMANDS.GET_INFO, 0, 56);
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(res.data.length, 38);
  });

  test('28. GET_INFO request-descriptor echo is checksumEchoed and cannot mint identity', async () => {
    const infoFixture = require('./fixtures/info-reply.json');
    const payload = Buffer.from(infoFixture.query56.payloadHex, 'hex').subarray(0, 38);
    const calculated = protocol.calculateChecksum([payload.length, 0, 0, 0, ...payload]);
    assert.notEqual(calculated, 0x38, 'fixture payload must take the echo exception, not a real checksum');

    function echoReply() {
      const buf = Buffer.alloc(64, 0);
      buf[0] = protocol.FLAG_RESPONSE;
      buf[1] = protocol.COMMANDS.GET_INFO;
      buf[2] = 0;
      buf[3] = 0x38;
      buf[4] = 38;
      for (let i = 0; i < payload.length; i++) buf[8 + i] = payload[i];
      return buf;
    }

    const mock = new MockHIDDevice();
    mock.customResponder = (writtenBuf, dev) => {
      if (writtenBuf[2] === protocol.COMMANDS.GET_INFO) {
        setImmediate(() => dev.emit('data', echoReply()));
      }
    };
    attachMockDevice(mock);
    transport.lastState.device = {
      vendorId: 14391,
      productId: 12339,
      serialNumber: 'ECHO-SN',
      path: 'mock://echo',
      interface: 1
    };

    const pkt = await transport.sendPacket({
      command: protocol.COMMANDS.GET_INFO,
      offset: 0,
      size: 56,
      timeoutMs: 300
    });
    assert.strictEqual(pkt.success, true, pkt.error);
    assert.strictEqual(pkt.checksumEchoed, true);
    assert.strictEqual(pkt.packet.checksumEchoed, true);

    const info = await transport.readFirmwareInfo();
    assert.strictEqual(info.success, true, info.error);
    assert.strictEqual(info.checksumEchoed, true);
    assert.strictEqual(info.identity, null);

    const parsed = protocol.parseInfo(payload);
    assert.equal(transport._fullIdentity(parsed, { checksumEchoed: true }), null);
    const trusted = transport._fullIdentity(parsed);
    assert.equal(trusted.firmwareRaw, 0x0114);
    assert.equal(trusted.rfFirmwareRaw, 0x0130);

    const prep = await transport.prepareFactoryReset({ scope: 'active' });
    assert.strictEqual(prep.success, false);
    assert.match(prep.error, /echo|untrusted|checksum/i);
    assert.equal(prep.identity, undefined);
  });

  test('29. echoed GET_INFO is retried before _fullIdentity is derived', async () => {
    const mock = new MockGlwMemoryDevice();
    let infoReads = 0;
    const origWrite = mock.write.bind(mock);
    mock.write = function echoThenTrust(buf) {
      if (buf[2] === protocol.COMMANDS.GET_INFO) {
        infoReads += 1;
        if (infoReads === 1) {
          this.writtenBuffers.push(Buffer.from(buf));
          const payload = this.info.subarray(0, 38);
          const reply = Buffer.alloc(64, 0);
          reply[0] = protocol.FLAG_RESPONSE;
          reply[1] = protocol.COMMANDS.GET_INFO;
          reply[3] = 0x38;
          reply[4] = 38;
          for (let i = 0; i < payload.length; i++) reply[8 + i] = payload[i];
          setImmediate(() => this.emit('data', reply));
          return;
        }
      }
      return origWrite(buf);
    };
    transport.installTestAdapter(mock);
    const prep = await transport.prepareFactoryReset({ scope: 'active' });
    assert.strictEqual(prep.success, true, prep.error);
    assert.ok(prep.identity);
    assert.equal(prep.identity.firmwareRaw, 0x0114);
    assert.ok(infoReads >= 2, 'identity must come from a retried non-echoed GET_INFO');
  });

  test('30. queryStatus isolates required handshake from optional name fetch and preserves timeout reconnect safety', async () => {
    // 1. Explicit error status on optional GET_CUSTOM_PARAM falls back to defaults without breaking connection
    const mockOptionalFail = new MockGlwMemoryDevice();
    mockOptionalFail.failCommands.add(protocol.COMMANDS.GET_CUSTOM_PARAM);
    transport.installTestAdapter(mockOptionalFail);
    assert.strictEqual(transport.needsReconnect, false);

    const optionalStatus = await transport.queryStatus();
    assert.strictEqual(optionalStatus.readSuccess, true, 'queryStatus must succeed when optional GET_CUSTOM_PARAM returns error status');
    assert.strictEqual(optionalStatus.needsReconnect, false, 'explicit failure on optional command must not set needsReconnect');
    assert.strictEqual(transport.needsReconnect, false, 'transport.needsReconnect must stay false');
    assert.strictEqual(transport.statusError, null, 'transport.statusError must be null');
    assert.strictEqual(transport.lastState.profileNamesSource, 'default');
    assert.ok(optionalStatus.lighting, 'funcConfig must still be read when optional names fails');
    assert.ok(optionalStatus.settings, 'settings must still be read when optional names fails');

    // 2. Required command (GET_BASE) timeout marks needsReconnect and preserves failure path
    transport.disconnect();
    const mockRequiredDrop = new MockGlwMemoryDevice();
    mockRequiredDrop.delayCommands.set(protocol.COMMANDS.GET_BASE, 2000);
    transport.installTestAdapter(mockRequiredDrop);
    const requiredStatus = await transport.queryStatus();
    assert.strictEqual(requiredStatus.readSuccess, false, 'queryStatus must fail when required GET_BASE times out');
    assert.strictEqual(requiredStatus.needsReconnect, true, 'required timeout must mark needsReconnect');
    assert.strictEqual(transport.needsReconnect, true);
    assert.notStrictEqual(transport.statusError, null, 'statusError must not be cleared when required read times out');

    // 3. Wire timeout on optional command also enforces safe reconnect to prevent late matching responses poisoning queue
    transport.disconnect();
    const mockOptionalTimeout = new MockGlwMemoryDevice();
    mockOptionalTimeout.delayCommands.set(protocol.COMMANDS.GET_CUSTOM_PARAM, 2000);
    transport.installTestAdapter(mockOptionalTimeout);
    const optTimeoutStatus = await transport.queryStatus();
    assert.strictEqual(optTimeoutStatus.readSuccess, false, 'wire timeout on optional command must fail safe to prevent queue poisoning');
    assert.strictEqual(optTimeoutStatus.needsReconnect, true, 'wire timeout on optional command must set needsReconnect');
    assert.strictEqual(transport.needsReconnect, true);
    assert.notStrictEqual(transport.statusError, null, 'statusError must be set on optional timeout');
  });

  test('31. Physical safety alias protection: SET_MACROS bounded to 4096 bytes protects profile 0 colors and keylayers in aliasMode', async () => {
    const mock = new MockGlwMemoryDevice({ aliasMode: true });
    attachMockDevice(mock);

    // Initial state check: mock memory is seeded and synced
    const initialColors = Buffer.from(mock.colors);
    const initialUserKeys = Buffer.from(mock.userKeys);
    assert.ok(initialColors.subarray(0, 2048).equals(mock.macros.subarray(4096, 6144)), 'mock aliasMode: profile 0 colors mirrored at macros 4096..6143');
    assert.ok(initialUserKeys.subarray(0, 2048).equals(mock.macros.subarray(6144, 8192)), 'mock aliasMode: profile 0 userKeys mirrored at macros 6144..8191');

    // 1. Direct macro upload (applyMacros) preserves colors and all keylayers
    const safeActions = [
      { action: 'keydown', code: 4, delay: 10 },
      { action: 'keyup', code: 4, delay: 20 }
    ];
    const macroRes = await transport.applyMacros([
      { id: 0, type: 0, actions: safeActions }
    ]);
    assert.strictEqual(macroRes.success, true, 'applyMacros must succeed');
    const macroWrites = mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_MACROS);
    assert.ok(macroWrites.length > 0, 'SET_MACROS writes dispatched');
    for (const b of macroWrites) {
      const off = b[6] | (b[7] << 8);
      const sz = b[5];
      assert.ok(off + sz <= protocol.MACRO_WRITABLE_LIMIT, `SET_MACROS write at [${off}..${off + sz}] exceeded safe limit ${protocol.MACRO_WRITABLE_LIMIT}`);
    }
    assert.ok(mock.colors.equals(initialColors), 'direct applyMacros must preserve colors');
    assert.ok(mock.userKeys.equals(initialUserKeys), 'direct applyMacros must preserve all keylayers');

    // 2. applyProfile changing both a key and color along with a macro:
    // Under aliasMode, writing 8192 bytes via SET_MACROS would replay the stale macro read (captured before key/color updates)
    // over the newly written colors and keys. With the 4096-byte bound, fresh key and color are retained.
    mock.writtenBuffers.length = 0;
    const exported = await transport.exportProfile(0);
    assert.strictEqual(exported.success, true, exported.error);
    const profileData = exported.data;

    // Mutate color for slot 11
    profileData.perKeyRgb['11'] = '#123456';
    // Mutate key for layer 0, slot 1
    profileData.layers['0']['1'] = { type: 16, code1: 0, code2: 5 };
    // Mutate macro slot 1
    profileData.macros[1] = {
      id: 1,
      type: 1,
      actions: [{ action: 'keydown', code: 6, delay: 15 }]
    };

    const applyProfRes = await transport.applyProfile(profileData, 0);
    assert.strictEqual(applyProfRes.success, true, applyProfRes.error);

    // Verify written SET_MACROS commands did not touch 4096..8191
    const profMacroWrites = mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_MACROS);
    for (const b of profMacroWrites) {
      const off = b[6] | (b[7] << 8);
      const sz = b[5];
      assert.ok(off + sz <= protocol.MACRO_WRITABLE_LIMIT, `SET_MACROS in applyProfile at [${off}..${off + sz}] exceeded safe limit ${protocol.MACRO_WRITABLE_LIMIT}`);
    }

    // Read back colors and keys from hardware (mock) to verify imported values are retained
    const colorReadRes = await transport.readRange(protocol.COMMANDS.GET_KEY_COLOR, 0, 384);
    assert.strictEqual(colorReadRes.success, true);
    assert.strictEqual(colorReadRes.data[33], 0x12, 'Slot 11 Red color retained');
    assert.strictEqual(colorReadRes.data[34], 0x34, 'Slot 11 Green color retained');
    assert.strictEqual(colorReadRes.data[35], 0x56, 'Slot 11 Blue color retained');

    const keyReadRes = await transport.readRange(protocol.COMMANDS.GET_USER_KEY_MATRIX, 0, 512);
    assert.strictEqual(keyReadRes.success, true);
    assert.strictEqual(keyReadRes.data[3], 16, 'Layer 0 slot 1 type retained');
    assert.strictEqual(keyReadRes.data[4], 0, 'Layer 0 slot 1 code1 retained');
    assert.strictEqual(keyReadRes.data[5], 5, 'Layer 0 slot 1 code2 retained');

    // 3. Oversized unique macro rejects before ANY HID writes
    mock.writtenBuffers.length = 0;
    const giantUniqueActions = Array.from({ length: 1008 }, (_, i) => ({
      action: 'keydown',
      code: 4 + (i % 20),
      delay: 10 + i
    }));
    const overRes = await transport.applyMacros([
      { id: 0, type: 0, actions: giantUniqueActions }
    ]);
    assert.strictEqual(overRes.success, false, 'oversized unique macro must be rejected');
    assert.match(overRes.error, /capacity exceeded/i);
    assert.strictEqual(mock.writtenBuffers.length, 0, 'oversized unique macro must dispatch zero HID writes');
  });
});
