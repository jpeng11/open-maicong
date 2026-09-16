const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const transport = require('../src/transport.cjs');
const protocol = require('../src/protocol.cjs');
const draft = require('../src/macro-draft.js');
const macroMetadata = require('../src/macro-metadata.cjs');
const { MockGlwMemoryDevice, makeReplyBuffer } = require('./mock-glw-memory.cjs');

const RESET_TIMEOUTS = { ackTimeoutMs: 200, notificationTimeoutMs: 80 };

function attachResetMock(mock) {
  transport.disconnect();
  transport.device = mock;
  transport.needsReconnect = false;
  transport.statusError = null;
  transport.configUncertain = false;
  transport.resetInFlight = false;
  transport.lastState.connected = true;
  transport.lastState.device = {
    vendorId: 14391,
    productId: 12339,
    hexVendorId: '0x3837',
    hexProductId: '0x3033',
    product: 'MCHOSE G75 V2 (Mock)',
    manufacturer: 'MCHOSE',
    serialNumber: 'MOCK-SN',
    path: 'mock://g75v2',
    interface: 1,
    isReceiver: true,
    mock: true
  };
  transport._bindDeviceListeners(mock);
}

function resetWrites(mock) {
  return mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.FACTORY_RESET);
}

function observeResetDispatch(mock) {
  const origWrite = mock.write.bind(mock);
  let count = 0;
  const packets = [];
  mock.write = function observeWrite(buf) {
    if (buf && buf[2] === protocol.COMMANDS.FACTORY_RESET) {
      count += 1;
      packets.push(Buffer.from(buf));
    }
    return origWrite(buf);
  };
  return {
    count: () => count,
    packets: () => packets.slice()
  };
}

function makeA2Note() {
  const buf = Buffer.alloc(64, 0);
  buf[0] = 0xA2;
  return buf;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs = 400) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(5);
  }
  return predicate();
}

function assertExactResetPacket(buf, scopeByte) {
  assert.ok(buf, 'CMD 238 packet must exist');
  assert.strictEqual(buf.length, 65);
  assert.strictEqual(buf[0], 0);
  assert.strictEqual(buf[1], protocol.FLAG_REQUEST);
  assert.strictEqual(buf[2], protocol.COMMANDS.FACTORY_RESET);
  assert.strictEqual(buf[3], 0);
  assert.strictEqual(buf[5], 1, 'size must be 1');
  assert.strictEqual(buf[6], 0, 'offsetLo must be 0');
  assert.strictEqual(buf[7], 0, 'offsetHi must be 0');
  assert.strictEqual(buf[8], 0);
  assert.strictEqual(buf[9], scopeByte);
  const checksum = protocol.calculateChecksum([1, 0, 0, 0, scopeByte]);
  assert.strictEqual(buf[4], checksum);
}

async function reviewAndCommit(mock, scope, extra = {}) {
  const review = await transport.prepareFactoryReset({ scope });
  assert.strictEqual(review.success, true, review.error);
  const result = await transport.commitFactoryReset({
    scope,
    expectedActiveProfileIndex: review.activeProfileIndex,
    expectedIdentity: review.identity,
    expectedGeneration: review.generation,
    expectedResetEpoch: review.resetEpoch,
    ...RESET_TIMEOUTS,
    ...extra
  });
  return { review, result, packets: resetWrites(mock) };
}

describe('Factory reset protocol framing and unsolicited notifications', () => {
  test('CMD 238 encode is offset 0 size 1 with active index or 255', () => {
    assert.strictEqual(protocol.COMMANDS.FACTORY_RESET, 238);
    assert.strictEqual(protocol.RESET_SCOPE_ALL, 255);
    assert.strictEqual(protocol.resolveFactoryResetScopeByte('all', 0), 255);
    assert.strictEqual(protocol.resolveFactoryResetScopeByte('active', 2), 2);
    assert.throws(() => protocol.resolveFactoryResetScopeByte('active', 4), RangeError);
    assert.throws(() => protocol.resolveFactoryResetScopeByte('profile-0', 0), TypeError);

    const active = protocol.encodePacket({
      command: protocol.COMMANDS.FACTORY_RESET,
      offset: 0,
      size: 1,
      data: [0]
    });
    assertExactResetPacket(active, 0);

    const all = protocol.encodePacket({
      command: protocol.COMMANDS.FACTORY_RESET,
      offset: 0,
      size: 1,
      data: [255]
    });
    assertExactResetPacket(all, 255);
  });

  test('A2 and FA FB FF are reset notifications; AA ACK and A1/A3/A4 are not', () => {
    const a2 = Buffer.alloc(64, 0);
    a2[0] = 0xA2;
    const noteA2 = protocol.decodeResetNotification(a2);
    assert.ok(noteA2);
    assert.strictEqual(noteA2.type, 'reset');
    assert.strictEqual(noteA2.kind, 'a2');

    const fa = Buffer.alloc(64, 0);
    fa[0] = 0xFA;
    fa[1] = 0xFB;
    fa[2] = 0xFF;
    const noteFa = protocol.decodeResetNotification(fa);
    assert.ok(noteFa);
    assert.strictEqual(noteFa.kind, 'fafbff');

    const prefixed = Buffer.alloc(65, 0);
    prefixed[1] = 0xA2;
    assert.ok(protocol.decodeResetNotification(prefixed));

    const ack = makeReplyBuffer({ command: 238, offset: 0, data: [] });
    assert.strictEqual(protocol.decodeResetNotification(ack), null);
    assert.ok(protocol.decodePacket(ack));

    for (const lead of [0xA1, 0xA3, 0xA4]) {
      const other = Buffer.alloc(64, 0);
      other[0] = lead;
      assert.strictEqual(protocol.decodeResetNotification(other), null, `0x${lead.toString(16)} must not count as reset`);
    }
  });
});

describe('Factory reset transport (mocked memory, never physical HID)', () => {
  beforeEach(() => {
    transport.disconnect();
  });

  afterEach(() => {
    transport.onStateChange = null;
    transport.disconnect();
  });

  test('offline prepare and commit fail closed with zero writes', async () => {
    const prep = await transport.prepareFactoryReset({ scope: 'active' });
    assert.strictEqual(prep.success, false);
    assert.match(prep.error, /not connected/i);

    const commit = await transport.commitFactoryReset({
      scope: 'all',
      expectedActiveProfileIndex: 0,
      expectedIdentity: { path: 'x' },
      expectedGeneration: 1,
      expectedResetEpoch: 0,
      ...RESET_TIMEOUTS
    });
    assert.strictEqual(commit.success, false);
    assert.notStrictEqual(commit.uncertain, true);
  });

  test('prepare is read-only; cancellation path never sends CMD 238', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    transport.setEditTarget(2, 0);

    const review = await transport.prepareFactoryReset({ scope: 'active' });
    assert.strictEqual(review.success, true);
    assert.strictEqual(review.activeProfileIndex, 0);
    assert.strictEqual(review.editingProfileIndex, 2);
    assert.strictEqual(review.editingDiffersFromActive, true);
    assert.strictEqual(review.wireScope, 0);
    assert.strictEqual(review.exportIsSingleProfile, true);
    assert.match(review.exportWarning, /not .*all-device backup|not a full-device backup|one profile/i);
    assert.strictEqual(resetWrites(mock).length, 0);
    assert.ok(mock.wroteCommand(protocol.COMMANDS.GET_BASE));
    assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.FACTORY_RESET), false);
  });

  test('active reset packet uses freshly read active index, not the editing profile', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    transport.setEditTarget(2, 0);
    mock.resetNotifyMode = 'after-ack';

    const { review, result, packets } = await reviewAndCommit(mock, 'active');
    assert.strictEqual(review.editingProfileIndex, 2);
    assert.strictEqual(review.activeProfileIndex, 0);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.uncertain, false);
    assert.strictEqual(packets.length, 1);
    assertExactResetPacket(packets[0], 0);
  });

  test('all-profiles packet is exactly data[255]', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    mock.resetNotifyMode = 'after-ack';
    mock.resetNotifyKind = 'fafbff';

    const { result, packets } = await reviewAndCommit(mock, 'all');
    assert.strictEqual(result.success, true);
    assert.strictEqual(packets.length, 1);
    assertExactResetPacket(packets[0], 255);
    assert.strictEqual(result.notificationKind, 'fafbff');
  });

  test('commit rejects a changed active target instead of resetting a different profile', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    const review = await transport.prepareFactoryReset({ scope: 'active' });
    assert.strictEqual(review.activeProfileIndex, 0);

    mock.base[0] = 1;
    const result = await transport.commitFactoryReset({
      scope: 'active',
      expectedActiveProfileIndex: review.activeProfileIndex,
      expectedIdentity: review.identity,
      expectedGeneration: review.generation,
      expectedResetEpoch: review.resetEpoch,
      ...RESET_TIMEOUTS
    });
    assert.strictEqual(result.success, false);
    assert.notStrictEqual(result.uncertain, true);
    assert.strictEqual(result.dispatched, false);
    assert.match(result.error, /active profile changed|stale target/i);
    assert.strictEqual(resetWrites(mock).length, 0);
  });

  test('commit rejects identity and generation swap without sending 238', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    const review = await transport.prepareFactoryReset({ scope: 'all' });

    transport.lastState.device = { ...transport.lastState.device, path: 'mock://other-device', serialNumber: 'OTHER' };
    const idReject = await transport.commitFactoryReset({
      scope: 'all',
      expectedActiveProfileIndex: review.activeProfileIndex,
      expectedIdentity: review.identity,
      expectedGeneration: review.generation,
      expectedResetEpoch: review.resetEpoch,
      ...RESET_TIMEOUTS
    });
    assert.strictEqual(idReject.success, false);
    assert.strictEqual(idReject.dispatched, false);
    assert.match(idReject.error, /identity/i);
    assert.strictEqual(resetWrites(mock).length, 0);

    transport.lastState.device.path = review.identity.path;
    transport.lastState.device.serialNumber = review.identity.serialNumber;
    transport.generation += 1;
    const genReject = await transport.commitFactoryReset({
      scope: 'all',
      expectedActiveProfileIndex: review.activeProfileIndex,
      expectedIdentity: review.identity,
      expectedGeneration: review.generation,
      expectedResetEpoch: review.resetEpoch,
      ...RESET_TIMEOUTS
    });
    assert.strictEqual(genReject.success, false);
    assert.strictEqual(genReject.dispatched, false);
    assert.match(genReject.error, /generation/i);
    assert.strictEqual(resetWrites(mock).length, 0);
  });

  test('notification-before-ACK is confirmed success; matching AA ACK alone is uncertain', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    mock.resetNotifyMode = 'before-ack';
    const before = await reviewAndCommit(mock, 'active');
    assert.strictEqual(before.result.success, true);
    assert.strictEqual(before.result.ack, true);
    assert.strictEqual(before.result.notification, true);
    assert.strictEqual(before.packets.length, 1);

    const mock2 = new MockGlwMemoryDevice();
    attachResetMock(mock2);
    mock2.resetNotifyMode = 'none';
    const ackOnly = await reviewAndCommit(mock2, 'active');
    assert.strictEqual(ackOnly.result.success, false);
    assert.strictEqual(ackOnly.result.uncertain, true);
    assert.strictEqual(ackOnly.result.ack, true);
    assert.strictEqual(ackOnly.result.notification, false);
    assert.match(ackOnly.result.error, /uncertain|notification|could not confirm/i);
    assert.strictEqual(ackOnly.packets.length, 1);
    assert.ok(transport.configUncertain);
    assert.strictEqual(transport._rawFuncConfig, null);
    assert.deepStrictEqual(transport.lastState.keymaps, {});
  });

  test('no automatic retry after ACK-only timeout, lost ACK, or disconnect', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    mock.resetNotifyMode = 'none';
    const ackOnly = await reviewAndCommit(mock, 'all');
    assert.strictEqual(ackOnly.result.uncertain, true);
    assert.strictEqual(resetWrites(mock).length, 1);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(resetWrites(mock).length, 1, 'must not retry after ACK-only timeout');

    const mockDrop = new MockGlwMemoryDevice();
    mockDrop.resetNotifyMode = 'none';
    mockDrop.omitAckCommands.add(protocol.COMMANDS.FACTORY_RESET);
    attachResetMock(mockDrop);
    const review = await transport.prepareFactoryReset({ scope: 'active' });
    const lostAck = await transport.commitFactoryReset({
      scope: 'active',
      expectedActiveProfileIndex: review.activeProfileIndex,
      expectedIdentity: review.identity,
      expectedGeneration: review.generation,
      expectedResetEpoch: review.resetEpoch,
      ...RESET_TIMEOUTS
    });
    assert.strictEqual(lostAck.success, false);
    assert.strictEqual(lostAck.uncertain, true);
    assert.strictEqual(lostAck.ack, false);
    assert.strictEqual(resetWrites(mockDrop).length, 1);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(resetWrites(mockDrop).length, 1, 'must not retry after lost ACK');

    const mockDisc = new MockGlwMemoryDevice();
    mockDisc.resetNotifyMode = 'after-ack';
    mockDisc.delayCommands.set(protocol.COMMANDS.FACTORY_RESET, 80);
    attachResetMock(mockDisc);
    const review2 = await transport.prepareFactoryReset({ scope: 'all' });
    const commitP = transport.commitFactoryReset({
      scope: 'all',
      expectedActiveProfileIndex: review2.activeProfileIndex,
      expectedIdentity: review2.identity,
      expectedGeneration: review2.generation,
      expectedResetEpoch: review2.resetEpoch,
      ackTimeoutMs: 300,
      notificationTimeoutMs: 300
    });
    await new Promise((r) => setTimeout(r, 15));
    transport.disconnect();
    const disc = await commitP;
    assert.strictEqual(disc.success, false);
    assert.ok(disc.uncertain || disc.aborted);
    const sent = resetWrites(mockDisc).length;
    assert.ok(sent <= 1);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(resetWrites(mockDisc).length, sent, 'must not retry after disconnect');
  });

  test('late notification after uncertain result is ignored and does not confirm success', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    mock.resetNotifyMode = 'late';
    mock.resetNotifyDelayMs = 50;

    const { result } = await reviewAndCommit(mock, 'all', { notificationTimeoutMs: 30, ackTimeoutMs: 200 });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.uncertain, true);
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(transport.configUncertain, true);
    assert.notStrictEqual(transport.lastResetOutcome && transport.lastResetOutcome.success, true);
    assert.strictEqual(resetWrites(mock).length, 1);
  });

  test('queued writes scheduled during reset are aborted and do not restore pre-reset data', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    mock.resetNotifyMode = 'after-ack';
    mock.delayCommands.set(protocol.COMMANDS.FACTORY_RESET, 40);

    const review = await transport.prepareFactoryReset({ scope: 'active' });
    const commitP = transport.commitFactoryReset({
      scope: 'active',
      expectedActiveProfileIndex: review.activeProfileIndex,
      expectedIdentity: review.identity,
      expectedGeneration: review.generation,
      expectedResetEpoch: review.resetEpoch,
      ackTimeoutMs: 300,
      notificationTimeoutMs: 300
    });
    const lightingP = transport.applyLighting({ brightness: 40, effect: 1 });
    const commitRes = await commitP;
    assert.strictEqual(commitRes.success, true);

    let lightingRes;
    try {
      lightingRes = await lightingP;
    } catch (err) {
      lightingRes = { success: false, error: err.message };
    }
    assert.strictEqual(lightingRes.success, false);
    assert.match(lightingRes.error || '', /invalidat|generation|abort|reset|disconnected/i);
    assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_FUNC_CONFIG), false);
  });

  test('unsolicited reset notification invalidates caches, bumps epoch, and broadcasts without counting as app success', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    await transport.queryStatus();
    assert.ok(transport.lastState.base || transport.lastState.lighting, 'queryStatus must populate caches before the unsolicited note');
    const epochBefore = transport.resetEpoch;
    let broadcasts = 0;
    transport.onStateChange = () => { broadcasts += 1; };
    try {
      mock.emit('data', makeA2Note());
      assert.ok(transport.resetEpoch > epochBefore);
      assert.equal(transport.lastState.lighting, null);
      assert.equal(transport.lastState.settings, null);
      assert.deepEqual(transport.lastState.keymaps, {});
      assert.equal(transport._rawFuncConfig, null);
      assert.ok(transport.configUncertain);
      assert.notEqual(transport.lastResetOutcome && transport.lastResetOutcome.success, true);
      assert.equal(transport.lastResetOutcome && transport.lastResetOutcome.unsolicited, true);
      assert.ok(broadcasts >= 1, 'renderer must be notified without a user click');
      assert.equal(resetWrites(mock).length, 0);
    } finally {
      transport.onStateChange = null;
    }
  });

  test('old-handle data and error events cannot confirm or disconnect a replacement reset', async () => {
    const origConnect = transport.connect;
    const origList = transport.listDevices;
    const origFind = transport.findControlInterface;
    const mock1 = new MockGlwMemoryDevice();
    transport.installTestAdapter(mock1);
    const oldData = (mock1.listeners.data || [])[0];
    const oldError = (mock1.listeners.error || [])[0];
    assert.ok(oldData, 'first handle must register a data listener');
    assert.ok(oldError, 'first handle must register an error listener');

    const mock2 = new MockGlwMemoryDevice();
    mock2.resetNotifyMode = 'none';
    mock2.delayCommands.set(protocol.COMMANDS.FACTORY_RESET, 40);
    transport.installTestAdapter(mock2);
    const observer = observeResetDispatch(mock2);
    try {
      const review = await transport.prepareFactoryReset({ scope: 'active' });
      assert.equal(review.success, true, review.error);
      const commitP = transport.commitFactoryReset({
        scope: 'active',
        expectedActiveProfileIndex: review.activeProfileIndex,
        expectedIdentity: review.identity,
        expectedGeneration: review.generation,
        expectedResetEpoch: review.resetEpoch,
        ...RESET_TIMEOUTS
      });
      assert.equal(await waitUntil(() => observer.count() >= 1), true, 'new handle must actually write CMD 238');
      oldData(makeA2Note());
      oldError(new Error('stale handle error'));
      const result = await commitP;
      assert.equal(observer.count(), 1);
      assert.equal(result.dispatched, true);
      assert.equal(result.notification, false);
      assert.equal(result.success, false);
      assert.equal(result.uncertain, true);
      assert.equal(transport.device, mock2, 'old handle error must not disconnect the replacement');
      assert.equal(transport.lastState.connected, true);
    } finally {
      transport.connect = origConnect;
      transport.listDevices = origList;
      transport.findControlInterface = origFind;
      transport.disconnect();
    }
  });

  test('notification before actual device.write does not confirm a later ACK-only reset', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    mock.resetNotifyMode = 'none';
    const review = await transport.prepareFactoryReset({ scope: 'active' });
    assert.equal(review.success, true, review.error);

    const origSend = transport.sendPacket.bind(transport);
    let releaseQueue;
    transport.sendPacket = (opts) => {
      if (opts && opts.command === protocol.COMMANDS.FACTORY_RESET) {
        transport.activeQueue = transport.activeQueue.then(() => new Promise((resolve) => {
          releaseQueue = resolve;
        }));
      }
      return origSend(opts);
    };
    const observer = observeResetDispatch(mock);
    try {
      const commitP = transport.commitFactoryReset({
        scope: 'active',
        expectedActiveProfileIndex: review.activeProfileIndex,
        expectedIdentity: review.identity,
        expectedGeneration: review.generation,
        expectedResetEpoch: review.resetEpoch,
        ...RESET_TIMEOUTS
      });
      assert.equal(await waitUntil(() => typeof releaseQueue === 'function'), true, 'reset sendPacket must wait on the queue');
      assert.equal(observer.count(), 0, 'write must still be queued');
      mock.emit('data', makeA2Note());
      assert.equal(observer.count(), 0);
      releaseQueue();
      const result = await commitP;
      assert.equal(observer.count(), 0, 'pre-dispatch unsolicited reset must not send CMD 238');
      assert.equal(result.dispatched, false);
      assert.equal(result.success, false);
      assert.notEqual(result.uncertain, true);
      assert.equal(resetWrites(mock).length, 0);
    } finally {
      transport.sendPacket = origSend;
    }
  });

  test('sendPacket refusal before HID write reports dispatched false and does not mark uncertain', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    const review = await transport.prepareFactoryReset({ scope: 'active' });
    const origSend = transport.sendPacket.bind(transport);
    let releaseQueue;
    transport.sendPacket = (opts) => {
      if (opts && opts.command === protocol.COMMANDS.FACTORY_RESET) {
        transport.activeQueue = transport.activeQueue.then(() => new Promise((resolve) => {
          releaseQueue = resolve;
        }));
      }
      return origSend(opts);
    };
    const observer = observeResetDispatch(mock);
    try {
      const commitP = transport.commitFactoryReset({
        scope: 'active',
        expectedActiveProfileIndex: review.activeProfileIndex,
        expectedIdentity: review.identity,
        expectedGeneration: review.generation,
        expectedResetEpoch: review.resetEpoch,
        ...RESET_TIMEOUTS
      });
      assert.equal(await waitUntil(() => typeof releaseQueue === 'function'), true);
      assert.equal(observer.count(), 0);
      transport.needsReconnect = true;
      releaseQueue();
      const result = await commitP;
      assert.equal(observer.count(), 0);
      assert.equal(result.dispatched, false);
      assert.notEqual(result.uncertain, true);
      assert.equal(result.success, false);
    } finally {
      transport.sendPacket = origSend;
    }
  });

  test('throw after the reset write still reports dispatched true from the observed packet', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    mock.resetNotifyMode = 'after-ack';
    const review = await transport.prepareFactoryReset({ scope: 'active' });
    const observer = observeResetDispatch(mock);
    const origInvalidate = transport._invalidateConfigCaches.bind(transport);
    transport._invalidateConfigCaches = () => {
      throw new Error('injected failure after write');
    };
    try {
      let result;
      try {
        result = await transport.commitFactoryReset({
          scope: 'active',
          expectedActiveProfileIndex: review.activeProfileIndex,
          expectedIdentity: review.identity,
          expectedGeneration: review.generation,
          expectedResetEpoch: review.resetEpoch,
          ...RESET_TIMEOUTS
        });
      } catch (err) {
        result = { success: false, error: err.message, thrown: true };
      }
      assert.equal(observer.count(), 1);
      assert.equal(result.dispatched, true);
      assert.equal(result.success, false);
      assert.equal(result.uncertain, true);
      assert.equal(result.thrown, undefined);
    } finally {
      transport._invalidateConfigCaches = origInvalidate;
    }
  });

  test('stale reset epoch after the transaction lock is rejected with no HID write', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    const review = await transport.prepareFactoryReset({ scope: 'active' });
    let unlock;
    const holder = transport.runTransaction(async () => {
      await new Promise((resolve) => { unlock = resolve; });
    });
    await sleep(10);
    const observer = observeResetDispatch(mock);
    const commitP = transport.commitFactoryReset({
      scope: 'active',
      expectedActiveProfileIndex: review.activeProfileIndex,
      expectedIdentity: review.identity,
      expectedGeneration: review.generation,
      expectedResetEpoch: review.resetEpoch,
      ...RESET_TIMEOUTS
    });
    await sleep(15);
    transport.resetEpoch += 1;
    unlock();
    const result = await commitP;
    await holder.catch(() => {});
    assert.equal(observer.count(), 0);
    assert.equal(result.dispatched, false);
    assert.notEqual(result.uncertain, true);
    assert.equal(result.success, false);
  });

  test('unsolicited note after the first config chunk stops later chunks and queued writes', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    await transport.queryStatus();
    assert.ok(transport._rawFuncConfig);

    mock.delayCommands.set(protocol.COMMANDS.SET_FUNC_CONFIG, 80);
    mock.writtenBuffers.length = 0;
    const lightingP = transport.applyLighting({ brightness: 40, effect: 1 });
    assert.equal(
      await waitUntil(() => mock.writtenBuffers.some((b) => b[2] === protocol.COMMANDS.SET_FUNC_CONFIG)),
      true,
      'first lighting chunk must actually write'
    );
    const writesAfterFirst = mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_FUNC_CONFIG).length;
    assert.equal(writesAfterFirst, 1);
    mock.emit('data', makeA2Note());
    let lightingRes;
    try {
      lightingRes = await lightingP;
    } catch (err) {
      lightingRes = { success: false, error: err.message };
    }
    assert.equal(lightingRes.success, false);
    assert.equal(
      mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_FUNC_CONFIG).length,
      1,
      'later lighting chunks must not write after unsolicited reset'
    );
    assert.equal(transport._rawFuncConfig, null);
    assert.equal(transport.lastState.lighting, null);
    assert.equal(resetWrites(mock).length, 0);
  });

  test('queued pre-reset packet never dispatches after unsolicited notification', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    await transport.queryStatus();
    mock.writtenBuffers.length = 0;

    const origSend = transport.sendPacket.bind(transport);
    let releaseQueue;
    transport.sendPacket = (opts) => {
      if (opts && opts.command === protocol.COMMANDS.SET_FUNC_CONFIG) {
        transport.activeQueue = transport.activeQueue.then(() => new Promise((resolve) => {
          releaseQueue = resolve;
        }));
      }
      return origSend(opts);
    };
    try {
      const lightingP = transport.applyLighting({ brightness: 40, effect: 1 });
      assert.equal(await waitUntil(() => typeof releaseQueue === 'function'), true);
      assert.equal(mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_FUNC_CONFIG).length, 0);
      mock.emit('data', makeA2Note());
      releaseQueue();
      let lightingRes;
      try {
        lightingRes = await lightingP;
      } catch (err) {
        lightingRes = { success: false, error: err.message };
      }
      assert.equal(lightingRes.success, false);
      assert.equal(mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_FUNC_CONFIG).length, 0);
    } finally {
      transport.sendPacket = origSend;
    }
  });

  test('in-flight read after unsolicited notification does not restore raw caches', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    await transport.queryStatus();
    assert.ok(transport._rawFuncConfig);
    mock.writtenBuffers.length = 0;
    mock.delayCommands.set(protocol.COMMANDS.GET_FUNC_CONFIG, 80);
    const readP = transport.queryStatus();
    assert.equal(
      await waitUntil(() => mock.writtenBuffers.some((b) => b[2] === protocol.COMMANDS.GET_FUNC_CONFIG)),
      true
    );
    mock.emit('data', makeA2Note());
    try {
      await readP;
    } catch {}
    assert.equal(transport._rawFuncConfig, null);
    assert.equal(transport.lastState.lighting, null);
    assert.equal(transport.lastState.settings, null);
  });

  test('post-write disconnect still reports dispatched true from lexical attempt state', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    mock.resetNotifyMode = 'after-ack';
    const review = await transport.prepareFactoryReset({ scope: 'active' });
    const observer = observeResetDispatch(mock);
    const origInvalidate = transport._invalidateConfigCaches.bind(transport);
    transport._invalidateConfigCaches = () => {
      transport.disconnect();
      throw new Error('injected failure after write');
    };
    try {
      const result = await transport.commitFactoryReset({
        scope: 'active',
        expectedActiveProfileIndex: review.activeProfileIndex,
        expectedIdentity: review.identity,
        expectedGeneration: review.generation,
        expectedResetEpoch: review.resetEpoch,
        ...RESET_TIMEOUTS
      });
      assert.equal(observer.count(), 1);
      assert.equal(result.dispatched, true);
      assert.equal(result.success, false);
      assert.equal(result.uncertain, true);
    } finally {
      transport._invalidateConfigCaches = origInvalidate;
    }
  });

  test('pre-write refusal after a prior successful dispatch stays dispatched false', async () => {
    const mock = new MockGlwMemoryDevice();
    attachResetMock(mock);
    mock.resetNotifyMode = 'after-ack';
    const first = await reviewAndCommit(mock, 'active');
    assert.equal(first.result.success, true);
    assert.equal(first.result.dispatched, true);

    const review = await transport.prepareFactoryReset({ scope: 'all' });
    assert.equal(review.success, true, review.error);
    const observer = observeResetDispatch(mock);
    transport.generation += 1;
    const second = await transport.commitFactoryReset({
      scope: 'all',
      expectedActiveProfileIndex: review.activeProfileIndex,
      expectedIdentity: review.identity,
      expectedGeneration: review.generation,
      expectedResetEpoch: review.resetEpoch,
      ...RESET_TIMEOUTS
    });
    assert.equal(observer.count(), 0);
    assert.equal(second.dispatched, false);
    assert.notEqual(second.uncertain, true);
    assert.equal(second.success, false);
  });
});

describe('Factory reset local macro metadata policy', () => {
  test('all-profiles confirmed reset clears names and default-delay preferences', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-meta-'));
    const metaFile = path.join(tmpDir, 'macro-metadata.json');
    try {
      const filled = draft.defaultMetadata();
      filled.slots[0].name = 'My Macro';
      filled.slots[0].defaultDelay = 120;
      filled.slots[0].enableDefaultDelay = false;
      macroMetadata.saveMacroMetadata(filled, metaFile);

      const res = macroMetadata.applyConfirmedResetMetadata('all', { path: metaFile });
      assert.strictEqual(res.attempted, true);
      assert.strictEqual(res.cleared, true);
      const loaded = macroMetadata.loadMacroMetadata(metaFile);
      assert.strictEqual(loaded.meta.slots[0].name, '');
      assert.strictEqual(loaded.meta.slots[0].defaultDelay, 50);
      assert.strictEqual(loaded.meta.slots[0].enableDefaultDelay, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('active-profile reset does not wipe the shared global metadata bank', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-meta-active-'));
    const metaFile = path.join(tmpDir, 'macro-metadata.json');
    try {
      const filled = draft.defaultMetadata();
      filled.slots[3].name = 'Keep Me';
      filled.slots[3].defaultDelay = 80;
      macroMetadata.saveMacroMetadata(filled, metaFile);

      const res = macroMetadata.applyConfirmedResetMetadata('active', { path: metaFile });
      assert.strictEqual(res.attempted, false);
      assert.strictEqual(res.cleared, false);
      assert.strictEqual(res.skipped, true);
      assert.match(res.reason, /global bank|shared/i);
      const loaded = macroMetadata.loadMacroMetadata(metaFile);
      assert.strictEqual(loaded.meta.slots[3].name, 'Keep Me');
      assert.strictEqual(loaded.meta.slots[3].defaultDelay, 80);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('metadata disk failure is visible and does not throw away the existing file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-meta-fail-'));
    const metaFile = path.join(tmpDir, 'macro-metadata.json');
    try {
      const filled = draft.defaultMetadata();
      filled.slots[1].name = 'Safe';
      macroMetadata.saveMacroMetadata(filled, metaFile);
      const original = fs.readFileSync(metaFile, 'utf8');

      const res = macroMetadata.applyConfirmedResetMetadata('all', {
        path: path.join(metaFile, 'nested', 'macro-metadata.json')
      });
      assert.strictEqual(res.attempted, true);
      assert.strictEqual(res.cleared, false);
      assert.ok(res.error);
      assert.strictEqual(fs.readFileSync(metaFile, 'utf8'), original);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('metadata disk failure keeps hardware confirmed and does not ask for another hardware reset', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-meta-attach-'));
    const metaFile = path.join(tmpDir, 'macro-metadata.json');
    try {
      const filled = draft.defaultMetadata();
      filled.slots[2].name = 'Keep';
      macroMetadata.saveMacroMetadata(filled, metaFile);
      const hardware = {
        success: true,
        uncertain: false,
        dispatched: true,
        notification: true
      };
      const attached = macroMetadata.attachConfirmedResetMetadata(hardware, 'all', {
        path: path.join(metaFile, 'nested', 'macro-metadata.json')
      });
      assert.equal(attached.success, true);
      assert.equal(attached.hardwareStatus, 'confirmed');
      assert.equal(attached.localCleanup, 'failed');
      assert.ok(attached.metadataError);
      assert.match(String(attached.metadataError), /./);
      assert.doesNotMatch(
        `${attached.metadataError} ${attached.localCleanupHint || ''}`,
        /reset the keyboard again|try the factory reset again|send another reset/i
      );
      assert.equal(fs.readFileSync(metaFile, 'utf8').includes('Keep'), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
