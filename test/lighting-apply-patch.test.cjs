const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const transport = require('../src/transport.cjs');
const protocol = require('../src/protocol.cjs');
const { MockGlwMemoryDevice } = require('./mock-glw-memory.cjs');

function attachMock(mock) {
  transport.disconnect();
  transport.device = mock;
  transport.needsReconnect = false;
  transport.statusError = null;
  transport.lastState.connected = true;
  transport.lastState.device = {
    vendorId: 14391,
    productId: 12339,
    path: 'mock://g75v2',
    interface: 1,
    mock: true
  };
  if (typeof mock.on === 'function') {
    transport._bindDeviceListeners(mock);
  }
}

describe('Lighting apply field patches preserve unknown effect IDs', () => {
  beforeEach(() => {
    transport.disconnect();
  });
  afterEach(() => {
    transport.disconnect();
  });

  test('unknown main effect 99 survives a side-brightness patch apply and readback', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    mock.func[8] = 99;
    mock.func[10] = 99;
    mock.func[24] = 2;
    mock.func[25] = 80;
    const res = await transport.applyLighting({ sideBrightness: 41 }, 0);
    assert.equal(res.success, true, res.error);
    assert.equal(mock.func[8], 99, 'main effect byte must stay unknown 99');
    assert.equal(mock.func[10], 99, 'unedited main speed byte must stay even if parser would clamp');
    assert.equal(mock.func[24], 2);
    assert.equal(mock.func[25], 41);
    const read = await transport.readFuncConfig(0);
    assert.equal(read.success, true);
    assert.equal(read.lighting.effect, 99);
    assert.equal(read.lighting.sideBrightness, 41);
  });

  test('unknown side effect survives a main brightness patch apply and readback', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    mock.func[8] = 6;
    mock.func[9] = 100;
    mock.func[24] = 9;
    mock.func[26] = 99;
    const res = await transport.applyLighting({ brightness: 55 }, 0);
    assert.equal(res.success, true, res.error);
    assert.equal(mock.func[24], 9, 'side effect byte must stay unknown 9');
    assert.equal(mock.func[26], 99, 'unedited side speed byte must stay even if parser would clamp');
    assert.equal(mock.func[8], 6);
    assert.equal(mock.func[9], 55);
    const read = await transport.readFuncConfig(0);
    assert.equal(read.success, true);
    assert.equal(read.lighting.sideEffect, 9);
    assert.equal(read.lighting.brightness, 55);
  });

  test('full payload with unknown effect 99 is still rejected by the validator path', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    mock.func[8] = 99;
    const res = await transport.applyLighting({
      effect: 99,
      brightness: 40,
      sideBrightness: 20
    }, 0);
    assert.equal(res.success, false);
    assert.match(res.error || '', /effect/i);
    assert.equal(mock.func[8], 99);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_FUNC_CONFIG), false);
  });
});
