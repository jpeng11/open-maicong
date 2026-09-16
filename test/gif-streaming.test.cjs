const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const protocol = require('../src/protocol.cjs');
const transport = require('../src/transport.cjs');
const gifLibrary = require('../src/gif-library.cjs');
const stillLibrary = require('../src/still-library.cjs');
const { MockGlwMemoryDevice } = require('./mock-glw-memory.cjs');
const { buildSimpleGif } = require('./gif-fixture.cjs');

function attachMock(mock, serial = 'GIF-A') {
  transport.disconnect();
  transport.device = mock;
  transport.needsReconnect = false;
  transport.statusError = null;
  transport.lastState.connected = true;
  transport.lastState.activeProfileIndex = 0;
  transport.lastState.device = {
    vendorId: 14391,
    productId: 12339,
    serialNumber: serial,
    path: `mock://g75v2/${serial}`,
    interface: 1,
    mock: true
  };
  if (typeof mock.on === 'function') transport._bindDeviceListeners(mock);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitDispatchIdle(maxMs = 400) {
  const start = Date.now();
  while (transport._streamDispatchInFlight) {
    if (Date.now() - start > maxMs) break;
    await sleep(5);
  }
}

function countCmd(mock, cmd) {
  return mock.writtenBuffers.filter((b) => b[2] === cmd).length;
}

describe('GIF / Lighting Streaming Protocol Packets', () => {
  it('splits 384-byte G75 main range into 8 54-byte packets with exact offsets and 330 overlap tail', () => {
    // 384 bytes (128 keys * 3 bytes RGB)
    const rawBytes = Buffer.alloc(384);
    for (let i = 0; i < 384; i++) {
      rawBytes[i] = (i + 1) & 0xFF;
    }

    const packets = protocol.buildStreamingPackets(rawBytes, {
      command: protocol.COMMANDS.STREAM_MAIN,
      profileIndex: 0,
      rangeStart: 0
    });

    assert.strictEqual(packets.length, 8, '384 bytes must produce exactly 8 packets');

    // Expected packet offsets:
    // P0: 0, P1: 54, P2: 108, P3: 162, P4: 216, P5: 270, P6: 324, P7: 330 (overlap tail 384 - 54)
    const expectedOffsets = [0, 54, 108, 162, 216, 270, 324, 330];

    for (let i = 0; i < packets.length; i++) {
      const pkt = packets[i];
      assert.strictEqual(pkt.length, protocol.WRITE_BUFFER_SIZE); // 65 bytes
      assert.strictEqual(pkt[0], 0, 'Report ID must be 0');
      assert.strictEqual(pkt[1], protocol.FLAG_REQUEST, 'Flag must be 0x55');
      assert.strictEqual(pkt[2], protocol.COMMANDS.STREAM_MAIN, 'Command must be 221 (0xDD)');
      assert.strictEqual(pkt[5], 54, 'Every packet must have size 54');

      const offset = pkt[6] | (pkt[7] << 8);
      assert.strictEqual(offset, expectedOffsets[i], `Packet ${i} offset must be ${expectedOffsets[i]}`);

      // Verify payload data matches rawBytes at that offset
      const payload = pkt.subarray(9, 9 + 54);
      const expectedSlice = rawBytes.subarray(expectedOffsets[i], expectedOffsets[i] + 54);
      assert.deepStrictEqual(payload, expectedSlice, `Packet ${i} payload must match slice at offset ${expectedOffsets[i]}`);

      // Verify checksum
      const descriptor = [54, offset & 0xFF, (offset >> 8) & 0xFF, 0];
      const expectedChecksum = protocol.calculateChecksum([...descriptor, ...Array.from(payload)]);
      assert.strictEqual(pkt[4], expectedChecksum, `Packet ${i} checksum must be valid`);
    }
  });

  it('matches the exact documented example: 60-byte range starting at offset 30 yields 54-byte payloads at offsets 30 and 36', () => {
    const rawBytes = Buffer.alloc(60);
    for (let i = 0; i < 60; i++) rawBytes[i] = i;

    const packets = protocol.buildStreamingPackets(rawBytes, {
      command: protocol.COMMANDS.STREAM_MAIN,
      profileIndex: 0,
      rangeStart: 30
    });

    assert.strictEqual(packets.length, 2);

    // Packet 0: offset 30, size 54, slice(0, 54)
    assert.strictEqual(packets[0][6] | (packets[0][7] << 8), 30);
    assert.strictEqual(packets[0][5], 54);
    assert.deepStrictEqual(packets[0].subarray(9, 9 + 54), rawBytes.subarray(0, 54));

    // Packet 1: offset 30 + (60 - 54) = 36, size 54, slice(6, 60)
    assert.strictEqual(packets[1][6] | (packets[1][7] << 8), 36);
    assert.strictEqual(packets[1][5], 54);
    assert.deepStrictEqual(packets[1].subarray(9, 9 + 54), rawBytes.subarray(6, 60));
  });

  it('handles small ranges <= 54 bytes at their real length without overlap', () => {
    const singleKey = Buffer.from([255, 0, 128]); // 3 bytes
    const packets = protocol.buildStreamingPackets(singleKey, {
      command: protocol.COMMANDS.STREAM_MAIN,
      profileIndex: 0,
      rangeStart: 12
    });

    assert.strictEqual(packets.length, 1);
    assert.strictEqual(packets[0][6] | (packets[0][7] << 8), 12);
    assert.strictEqual(packets[0][5], 3);
    assert.deepStrictEqual(packets[0].subarray(9, 9 + 3), singleKey);
  });

  it('accounts for profile index in target offset calculation', () => {
    const bytes = Buffer.alloc(54, 42);
    // Profile 2 with totalLightAreaSize 512: offset = 2 * 512 + 0 = 1024
    const packets = protocol.buildStreamingPackets(bytes, {
      command: protocol.COMMANDS.STREAM_MAIN,
      profileIndex: 2,
      rangeStart: 0
    });

    assert.strictEqual(packets.length, 1);
    assert.strictEqual(packets[0][6] | (packets[0][7] << 8), 1024);
  });

  it('covers all 128 G75 main color indexes including 113..127; does not invent a 113 cutoff', () => {
    const rawBytes = Buffer.alloc(384, 0);
    rawBytes[113 * 3] = 7;
    rawBytes[113 * 3 + 1] = 8;
    rawBytes[113 * 3 + 2] = 9;
    rawBytes[127 * 3] = 10;
    const packets = protocol.buildStreamingPackets(rawBytes, {
      command: protocol.COMMANDS.STREAM_MAIN,
      profileIndex: 0,
      rangeStart: 0
    });
    const last = packets[packets.length - 1];
    const lastOffset = last[6] | (last[7] << 8);
    assert.strictEqual(lastOffset, 330);
    assert.strictEqual(last[9 + (339 - 330)], 7);
    assert.strictEqual(last[9 + (381 - 330)], 10);
    assert.equal(packets.some((pkt) => pkt[2] === protocol.COMMANDS.STREAM_SIDE), false);
  });

  it('never emits side streaming opcodes from the G75 main builder', () => {
    const packets = protocol.buildStreamingPackets(Buffer.alloc(54, 7), {
      command: protocol.COMMANDS.STREAM_MAIN,
      profileIndex: 0,
      rangeStart: 0
    });
    assert.ok(packets.every((pkt) => pkt[2] === protocol.COMMANDS.STREAM_MAIN));
    assert.equal(packets.some((pkt) => pkt[2] === protocol.COMMANDS.STREAM_SIDE || pkt[2] === protocol.COMMANDS.STREAM_SIDE2), false);
  });
});

describe('GIF host streaming transport (mocked HID, no physical writes)', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maicong-gif-hw-'));
    transport.disconnect();
    transport.gifLibraryPath = path.join(tmp, 'gif-library.json');
    transport.stillLibraryPath = path.join(tmp, 'still-library.json');
    transport.lightingMemoryPath = path.join(tmp, 'lighting-memory.json');
  });
  afterEach(() => {
    transport.disconnect();
    transport.gifLibraryPath = null;
    transport.stillLibraryPath = null;
    transport.lightingMemoryPath = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('selectGif writes custom0 name at 840, streams CMD 221 only, and leaves side FUNC unchanged', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.func[8] = 6;
    mock.func[24] = 3;
    attachMock(mock);
    const gif = buildSimpleGif({
      width: 2,
      height: 2,
      frames: [{ delay: 10, pixels: [1, 1, 1, 1] }]
    });
    const imported = await transport.importGifFile(gif, 'Wave');
    assert.equal(imported.success, true, imported.error);
    const before221 = countCmd(mock, protocol.COMMANDS.STREAM_MAIN);
    const select = await transport.selectGif(0, imported.item.key, { applyCustom0: true });
    assert.equal(select.success, true, select.error);
    assert.equal(mock.func[8], 0);
    assert.equal(mock.func[24], 3, 'GIF select must not copy into side effect');
    const region = mock.custom.subarray(stillLibrary.selectedLightOffset(0), stillLibrary.selectedLightOffset(0) + 56);
    assert.deepEqual(stillLibrary.decodeSelectedLightEffect(region).pair, ['gif', 'Wave']);
    assert.ok(countCmd(mock, protocol.COMMANDS.STREAM_MAIN) > before221);
    assert.equal(countCmd(mock, protocol.COMMANDS.STREAM_SIDE), 0);
    assert.equal(countCmd(mock, protocol.COMMANDS.STREAM_SIDE2), 0);
    transport.abortAllMusicColor();
  });

  it('queryStatus does not start GIF streaming or write CMD 221', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    const before = mock.writtenBuffers.length;
    await transport.queryStatus();
    assert.equal(countCmd(mock, protocol.COMMANDS.STREAM_MAIN), 0);
    assert.equal(transport.lastState.isStreaming, false);
    assert.ok(mock.writtenBuffers.length >= before);
    assert.equal(mock.writtenBuffers.some((b) => b[2] === protocol.COMMANDS.SET_FUNC_CONFIG), false);
  });

  it('pause/resume/stop and disconnect cancel queued frames immediately', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    const gif = buildSimpleGif({
      width: 2,
      height: 2,
      frames: [
        { delay: 20, pixels: [1, 1, 1, 1] },
        { delay: 20, pixels: [2, 2, 2, 2] }
      ]
    });
    const imported = await transport.importGifFile(gif, 'Pulse');
    const select = await transport.selectGif(0, imported.item.key);
    assert.equal(select.success, true, select.error);
    assert.equal(transport.lastState.isStreaming, true);
    const paused = transport.setGifPlayback('pause');
    assert.equal(paused.playing, false);
    assert.equal(transport.lastState.isStreaming, false);
    const resumed = transport.setGifPlayback('resume');
    assert.equal(resumed.playing, true);
    transport.setGifPlayback('stop');
    assert.equal(transport.gifPlayer, null);
    assert.equal(transport.lastState.isStreaming, false);

    const replay = transport.setGifPlayback('play');
    assert.equal(replay.success, true, replay.error);
    assert.ok(transport.gifPlayer);
    assert.equal(transport.lastState.isStreaming, true);

    const gen = transport.streamGeneration;
    transport.disconnect();
    assert.ok(transport.streamGeneration !== gen || transport.gifPlayer == null);
    assert.equal(transport.gifPlayer, null);
  });

  it('pause cancels in-flight 20ms-paced CMD 221 packets; resume validates active profile', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    transport.streamPaceMs = 20;
    const gif = buildSimpleGif({
      width: 2,
      height: 2,
      frames: [{ delay: 80, pixels: [1, 1, 1, 1] }]
    });
    const imported = await transport.importGifFile(gif, 'Pace');
    const select = await transport.selectGif(0, imported.item.key);
    assert.equal(select.success, true, select.error);
    await sleep(8);
    const paused = transport.setGifPlayback('pause');
    assert.equal(paused.success, true);
    const n = countCmd(mock, protocol.COMMANDS.STREAM_MAIN);
    await sleep(140);
    assert.ok(
      countCmd(mock, protocol.COMMANDS.STREAM_MAIN) - n <= 1,
      'pause must cancel remaining paced stream packets'
    );

    transport.isStandby = true;
    const blocked = transport.setGifPlayback('resume');
    assert.equal(blocked.success, false);
    transport.isStandby = false;

    transport.lastState.activeProfileIndex = 2;
    const otherProfile = transport.setGifPlayback('resume');
    assert.equal(otherProfile.success, false);
    transport.lastState.activeProfileIndex = 0;

    const resumed = transport.setGifPlayback('resume');
    assert.equal(resumed.success, true, resumed.error);
    assert.equal(transport.lastState.isStreaming, true);
    transport.abortAllMusicColor();
  });

  it('paces successive CMD 221 packets by the vendor 20ms unsafe completion, without ACK wait', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    transport.streamPaceMs = 20;
    const gif = buildSimpleGif({
      width: 2,
      height: 2,
      frames: [{ delay: 400, pixels: [1, 1, 1, 1] }]
    });
    const imported = await transport.importGifFile(gif, 'Tick');
    const times = [];
    const origWrite = mock.write.bind(mock);
    mock.write = (buf) => {
      if (buf[2] === protocol.COMMANDS.STREAM_MAIN) times.push(Date.now());
      return origWrite(buf);
    };
    const select = await transport.selectGif(0, imported.item.key);
    assert.equal(select.success, true, select.error);
    await sleep(130);
    transport.abortAllMusicColor();
    assert.ok(times.length >= 3, `expected several paced 221 writes, got ${times.length}`);
    const gap = times[1] - times[0];
    assert.ok(gap >= 15, `expected ~20ms pacing, gap=${gap}`);
    assert.equal(transport.needsReconnect, false);
    assert.equal(countCmd(mock, protocol.COMMANDS.STREAM_SIDE), 0);
  });

  it('paces 20ms across a two-frame pending queue, not only inside one frame', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    transport.streamPaceMs = 20;
    const gif = buildSimpleGif({
      width: 2,
      height: 2,
      frames: [{ delay: 400, pixels: [1, 1, 1, 1] }]
    });
    const imported = await transport.importGifFile(gif, 'Queue');
    const select = await transport.selectGif(0, imported.item.key);
    assert.equal(select.success, true, select.error);
    transport.gifPlayer.pause();
    await waitDispatchIdle();

    const timesA = [];
    const timesB = [];
    const origWrite = mock.write.bind(mock);
    mock.write = (buf) => {
      if (buf[2] === protocol.COMMANDS.STREAM_MAIN) {
        if (buf[9] === 255 && buf[11] === 0) timesA.push(Date.now());
        if (buf[9] === 0 && buf[11] === 255) timesB.push(Date.now());
      }
      return origWrite(buf);
    };

    const red = new Array(128).fill('#FF0000');
    const blue = new Array(128).fill('#0000FF');
    transport.streamFrame(red);
    transport.streamFrame(blue);
    assert.ok(transport.latestPendingStreamFrame, 'second frame must sit in the one-slot pending queue');
    assert.equal(transport.latestPendingStreamFrame.options.epoch, transport.resetEpoch);
    assert.equal(transport.latestPendingStreamFrame.options.resetEpoch, transport.latestPendingStreamFrame.options.epoch);
    assert.equal(transport.latestPendingStreamFrame.options.devGen, transport.generation);

    await sleep(280);
    transport.abortAllMusicColor();
    assert.ok(timesA.length >= 8, `frame A should send a full 384-byte split, got ${timesA.length}`);
    assert.ok(timesB.length >= 1, `frame B should flush after A, got ${timesB.length}`);
    const gap = timesB[0] - timesA[timesA.length - 1];
    assert.ok(gap >= 15, `last packet of A and first of B must keep 20ms unsafe completion, gap=${gap}`);
  });

  it('preserves queued epoch/devGen and does not replay after resetEpoch advances', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    transport.streamPaceMs = 0;
    const gif = buildSimpleGif({
      width: 2,
      height: 2,
      frames: [{ delay: 400, pixels: [1, 1, 1, 1] }]
    });
    const imported = await transport.importGifFile(gif, 'Epoch');
    const select = await transport.selectGif(0, imported.item.key);
    assert.equal(select.success, true, select.error);
    transport.gifPlayer.pause();
    await waitDispatchIdle();

    transport._streamDispatchInFlight = true;
    transport._streamDispatchOwner = transport.streamGeneration;
    const epochAtQueue = transport.resetEpoch;
    transport.streamFrame(new Array(128).fill('#00FF00'));
    assert.ok(transport.latestPendingStreamFrame);
    assert.equal(transport.latestPendingStreamFrame.options.epoch, epochAtQueue);
    assert.equal(transport.latestPendingStreamFrame.options.resetEpoch, epochAtQueue);
    assert.equal(transport.latestPendingStreamFrame.options.devGen, transport.generation);

    transport.resetEpoch += 1;
    transport._gifStreamEpoch = transport.resetEpoch;
    transport._streamDispatchInFlight = false;
    transport._streamDispatchOwner = null;
    const before = countCmd(mock, protocol.COMMANDS.STREAM_MAIN);
    transport._flushPendingStreamFrame();
    await sleep(20);
    assert.equal(
      countCmd(mock, protocol.COMMANDS.STREAM_MAIN),
      before,
      'queued epoch must be preserved; a later resetEpoch must not be substituted on replay'
    );
    transport.abortAllMusicColor();
  });

  it('restart during pacing does not let a stale dispatcher steal ownership or pending data', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    transport.streamPaceMs = 20;
    const gif = buildSimpleGif({
      width: 2,
      height: 2,
      frames: [{ delay: 400, pixels: [1, 1, 1, 1] }]
    });
    const imported = await transport.importGifFile(gif, 'Restart');
    const select = await transport.selectGif(0, imported.item.key);
    assert.equal(select.success, true, select.error);
    await sleep(8);
    const oldGen = transport.streamGeneration;
    const oldOwner = transport._streamDispatchOwner;
    const stopped = transport.setGifPlayback('stop');
    assert.equal(stopped.success, true);
    const played = transport.setGifPlayback('play');
    assert.equal(played.success, true, played.error);
    assert.notEqual(transport.streamGeneration, oldGen);
    await sleep(30);
    assert.notEqual(transport._streamDispatchOwner, oldOwner);
    if (transport._streamDispatchInFlight) {
      assert.equal(transport._streamDispatchOwner, transport.streamGeneration);
    }
    assert.ok(transport.gifPlayer);
    assert.equal(transport.lastState.isStreaming, true);
    const n = countCmd(mock, protocol.COMMANDS.STREAM_MAIN);
    await sleep(50);
    assert.ok(
      countCmd(mock, protocol.COMMANDS.STREAM_MAIN) >= n,
      'new generation must keep writing after restart during pacing'
    );
    transport.abortAllMusicColor();
  });

  it('drops late stream callbacks after the active profile changes without a player restart', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    transport.streamPaceMs = 0;
    const gif = buildSimpleGif({
      width: 2,
      height: 2,
      frames: [{ delay: 30, pixels: [1, 1, 1, 1] }]
    });
    const imported = await transport.importGifFile(gif, 'Late');
    const select = await transport.selectGif(0, imported.item.key);
    assert.equal(select.success, true, select.error);
    await sleep(15);
    const n = countCmd(mock, protocol.COMMANDS.STREAM_MAIN);
    transport.lastState.activeProfileIndex = 1;
    await sleep(80);
    assert.equal(
      countCmd(mock, protocol.COMMANDS.STREAM_MAIN),
      n,
      'late frames must not write after the active profile changes'
    );
    transport.abortAllMusicColor();
  });

  it('switching profile or effect cancels streaming; selecting a still restores static colors', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.func[8] = 0;
    mock.func[24] = 2;
    attachMock(mock);
    const gif = buildSimpleGif({
      width: 2,
      height: 2,
      frames: [{ delay: 10, pixels: [1, 1, 1, 1] }]
    });
    const imported = await transport.importGifFile(gif, 'Spin');
    const selected = await transport.selectGif(0, imported.item.key);
    assert.equal(selected.success, true, selected.error);
    assert.ok(transport.gifPlayer);
    const switched = await transport.switchProfile(1);
    assert.equal(switched.success, true, switched.error);
    assert.equal(transport.gifPlayer, null);
    assert.equal(transport.lastState.isStreaming, false);

    const back = await transport.switchProfile(0);
    assert.equal(back.success, true, back.error);
    const selectedAgain = await transport.selectGif(0, imported.item.key);
    assert.equal(selectedAgain.success, true, selectedAgain.error);
    assert.ok(transport.gifPlayer);
    const lighting = await transport.applyLighting({ effect: 6 }, 0);
    assert.equal(lighting.success, true, lighting.error);
    assert.equal(transport.gifPlayer, null);
    assert.equal(mock.func[24], 2);

    mock.func[8] = 0;
    const still = await transport.createStill('Solid');
    assert.equal(still.success, true, still.error);
    const gifAgain = await transport.selectGif(0, imported.item.key);
    assert.equal(gifAgain.success, true, gifAgain.error);
    const stillSelect = await transport.selectStill(0, still.key);
    assert.equal(stillSelect.success, true, stillSelect.error);
    assert.equal(transport.gifPlayer, null);
  });

  it('selectGif on a non-active profile writes the name and does not stream', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    transport.lastState.activeProfileIndex = 0;
    transport.editTarget = { profileIndex: 1, layer: null };
    const gif = buildSimpleGif({
      width: 2,
      height: 2,
      frames: [{ delay: 10, pixels: [1, 1, 1, 1] }]
    });
    const imported = await transport.importGifFile(gif, 'Quiet');
    const before = countCmd(mock, protocol.COMMANDS.STREAM_MAIN);
    const select = await transport.selectGif(1, imported.item.key);
    assert.equal(select.success, true, select.error);
    assert.equal(transport.gifPlayer, null);
    assert.equal(countCmd(mock, protocol.COMMANDS.STREAM_MAIN), before);
    const region = mock.custom.subarray(stillLibrary.selectedLightOffset(1), stillLibrary.selectedLightOffset(1) + 56);
    assert.deepEqual(stillLibrary.decodeSelectedLightEffect(region).pair, ['gif', 'Quiet']);
  });

  it('corrupt GIF library files are preserved and aliases stay 301/302/1', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    fs.writeFileSync(transport.gifLibraryPath, '{ nope', 'utf8');
    const created = await transport.createGif('Nope');
    assert.equal(created.success, false);
    assert.equal(fs.readFileSync(transport.gifLibraryPath, 'utf8'), '{ nope');

    fs.unlinkSync(transport.gifLibraryPath);
    const mapped = gifLibrary.mapRgbaFrameToKeyColors(
      Uint8ClampedArray.from(new Array(100 * 100 * 4).fill(0).map((_, i) => (i % 4 === 3 ? 255 : i % 4 === 0 ? 12 : 0))),
      100,
      100
    );
    assert.equal(mapped.some((e) => e.code === 0 || e.code === 255), false);
    assert.ok(mapped.some((e) => e.code === 301));
    assert.ok(mapped.some((e) => e.code === 302));
    assert.ok(mapped.some((e) => e.code === 1));
  });
});
