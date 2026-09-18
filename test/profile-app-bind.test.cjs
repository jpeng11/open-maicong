'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appBind = require('../src/profile-app-bind.cjs');
const { AppBindWatcher } = require('../src/profile-app-bind-watch.cjs');
const transport = require('../src/transport.cjs');
const { MockGlwMemoryDevice } = require('./mock-glw-memory.cjs');

const files = [];
afterEach(() => {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch {}
  }
  files.length = 0;
});

function tmpFile() {
  const p = path.join(os.tmpdir(), `maicong-app-bind-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  files.push(p);
  return p;
}

describe('profile app bind store', () => {
  test('setBind keeps one slot per app and one app per slot', () => {
    let binds = [];
    const first = appBind.setBind(binds, {
      profileIndex: 1,
      bundleId: 'com.valve.cs2',
      displayName: 'Counter-Strike 2'
    });
    assert.equal(first.valid, true, first.error);
    binds = first.binds;
    const moved = appBind.setBind(binds, {
      profileIndex: 2,
      bundleId: 'com.valve.cs2',
      displayName: 'CS2'
    });
    assert.equal(moved.valid, true, moved.error);
    assert.equal(moved.binds.length, 1);
    assert.equal(moved.binds[0].profileIndex, 2);
    const other = appBind.setBind(moved.binds, {
      profileIndex: 2,
      bundleId: 'com.riot.valorant',
      displayName: 'VALORANT'
    });
    assert.equal(other.valid, true, other.error);
    assert.equal(other.binds.length, 1);
    assert.equal(other.binds[0].bundleId, 'com.riot.valorant');
    assert.equal(appBind.bindForProfile(other.binds, 1), null);
  });

  test('persistence is per device key and refuses a corrupt file', () => {
    const file = tmpFile();
    const key = '14391:12339:sn:MOCK';
    const saved = appBind.setBind([], { profileIndex: 0, bundleId: 'com.mock.game', displayName: 'Mock Game' });
    appBind.writeDevice(file, key, saved.binds);
    const loaded = appBind.readDevice(file, key);
    assert.equal(loaded.ok, true, loaded.error);
    assert.equal(loaded.binds[0].bundleId, 'com.mock.game');
    assert.equal(appBind.readDevice(file, 'other-device').binds.length, 0);
    fs.writeFileSync(file, '{not-json', 'utf8');
    const bad = appBind.readDevice(file, key);
    assert.equal(bad.ok, false);
    assert.equal(bad.unwritable, true);
    assert.throws(() => appBind.writeDevice(file, key, saved.binds));
    assert.equal(fs.readFileSync(file, 'utf8'), '{not-json');
  });

  test('matchFrontmost is bundle-id based and parseLsappinfo reads macOS output', () => {
    const binds = appBind.setBind([], {
      profileIndex: 3,
      bundleId: 'com.apple.Safari',
      displayName: 'Safari'
    }).binds;
    assert.equal(appBind.matchFrontmost(binds, { bundleId: 'com.apple.Safari' }).profileIndex, 3);
    assert.equal(appBind.matchFrontmost(binds, { bundleId: 'com.apple.finder' }), null);
    const parsed = appBind.parseLsappinfo('"CFBundleIdentifier"="com.apple.Safari"\n"LSDisplayName"="Safari"\n');
    assert.equal(parsed.bundleId, 'com.apple.Safari');
    assert.equal(parsed.displayName, 'Safari');
    assert.equal(appBind.profileIndexFromOnboardKey('KeyboardProfile@keyboard@2'), 2);
    assert.equal(appBind.profileIndexFromOnboardKey('KeyboardProfile@localstorage@x'), null);
  });

  test('deleteBind reports whether a link existed', () => {
    const binds = appBind.setBind([], { profileIndex: 0, bundleId: 'com.mock.game' }).binds;
    const gone = appBind.deleteBind(binds, 0);
    assert.equal(gone.changed, true);
    assert.equal(gone.binds.length, 0);
    const noop = appBind.deleteBind(gone.binds, 0);
    assert.equal(noop.changed, false);
  });
});

describe('app bind watcher', () => {
  test('activates the bound onboard profile when that app is frontmost', async () => {
    const calls = [];
    const watcher = new AppBindWatcher({
      intervalMs: 20,
      getBinds: () => [{ profileIndex: 2, bundleId: 'com.mock.game', displayName: 'Mock Game' }],
      getActiveProfile: () => 0,
      isConnected: () => true,
      isBusy: () => false,
      getFrontmost: async () => ({ bundleId: 'com.mock.game', displayName: 'Mock Game' }),
      switchProfile: async (idx) => {
        calls.push(idx);
        return { success: true };
      }
    });
    const first = await watcher.tick();
    assert.equal(first.success, true, first.error);
    assert.equal(first.profileIndex, 2);
    assert.deepEqual(calls, [2]);
    const second = await watcher.tick();
    assert.equal(second.skipped, true);
    assert.deepEqual(calls, [2]);
  });

  test('does not switch when disconnected, busy, ignored, or already active', async () => {
    const calls = [];
    const state = { connected: false, busy: false, active: 1, front: { bundleId: 'com.mock.game' } };
    const watcher = new AppBindWatcher({
      ignoreBundleIds: ['dev.openmaicong.studio'],
      getBinds: () => [{ profileIndex: 1, bundleId: 'com.mock.game', displayName: 'Mock Game' }],
      getActiveProfile: () => state.active,
      isConnected: () => state.connected,
      isBusy: () => state.busy,
      getFrontmost: async () => state.front,
      switchProfile: async (idx) => {
        calls.push(idx);
        return { success: true };
      }
    });
    assert.equal((await watcher.tick()).reason, 'disconnected');
    state.connected = true;
    state.busy = true;
    assert.equal((await watcher.tick()).reason, 'device-busy');
    state.busy = false;
    state.front = { bundleId: 'dev.openmaicong.studio' };
    assert.equal((await watcher.tick()).reason, 'ignored-app');
    state.front = { bundleId: 'com.mock.game' };
    const already = await watcher.tick();
    assert.equal(already.alreadyActive, true);
    assert.equal(calls.length, 0);
  });

  test('stop() during getFrontmost or switchProfile abandons the tick', async () => {
    let releaseFront;
    let releaseSwitch;
    const switches = [];
    const watcher = new AppBindWatcher({
      intervalMs: 60_000,
      getBinds: () => [{ profileIndex: 2, bundleId: 'com.mock.game', displayName: 'Mock Game' }],
      getActiveProfile: () => 0,
      isConnected: () => true,
      isBusy: () => false,
      getFrontmost: () => new Promise((resolve) => { releaseFront = resolve; }),
      switchProfile: (idx) => {
        switches.push(idx);
        return new Promise((resolve) => { releaseSwitch = resolve; });
      }
    });

    watcher.start();
    const frontTick = watcher.tick();
    watcher.stop();
    releaseFront({ bundleId: 'com.mock.game', displayName: 'Mock Game' });
    const abandonedAtFront = await frontTick;
    assert.equal(abandonedAtFront.skipped, true);
    assert.equal(abandonedAtFront.reason, 'stopped');
    assert.equal(switches.length, 0);
    assert.equal(watcher.lastSwitch, null);

    releaseFront = undefined;
    releaseSwitch = undefined;
    watcher.start();
    const switchTick = watcher.tick();
    const frontReady = await new Promise((resolve) => {
      const start = Date.now();
      const poll = () => {
        if (typeof releaseFront === 'function') {
          resolve(true);
          return;
        }
        if (Date.now() - start > 400) {
          resolve(false);
          return;
        }
        setTimeout(poll, 5);
      };
      poll();
    });
    assert.equal(frontReady, true);
    releaseFront({ bundleId: 'com.mock.game', displayName: 'Mock Game' });
    const started = await new Promise((resolve) => {
      const start = Date.now();
      const poll = () => {
        if (typeof releaseSwitch === 'function') {
          resolve(true);
          return;
        }
        if (Date.now() - start > 400) {
          resolve(false);
          return;
        }
        setTimeout(poll, 5);
      };
      poll();
    });
    assert.equal(started, true);
    watcher.stop();
    releaseSwitch({ success: true });
    const abandonedAtSwitch = await switchTick;
    assert.equal(abandonedAtSwitch.skipped, true);
    assert.equal(abandonedAtSwitch.reason, 'stopped');
    assert.equal(watcher.lastSwitch, null);
  });
});

describe('transport app binds on the live device key', () => {
  let tmpDir;
  afterEach(() => {
    transport.disconnect();
    transport.profileAppBindPath = null;
    transport.profileLibraryPath = null;
    transport.stillLibraryPath = null;
    transport.gifLibraryPath = null;
    transport.lightingMemoryPath = null;
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      tmpDir = null;
    }
  });

  test('bind, query, and auto-unbind when the onboard slot is removed', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maicong-app-bind-hw-'));
    transport.profileLibraryPath = path.join(tmpDir, 'profile-library.json');
    transport.stillLibraryPath = path.join(tmpDir, 'still.json');
    transport.gifLibraryPath = path.join(tmpDir, 'gif.json');
    transport.lightingMemoryPath = path.join(tmpDir, 'lightmem.json');
    const file = tmpFile();
    transport.profileAppBindPath = file;
    const mock = new MockGlwMemoryDevice();
    transport.installTestAdapter(mock);
    await transport.queryStatus();
    const bound = transport.bindProfileApp({
      profileIndex: 0,
      bundleId: 'com.mock.game',
      displayName: 'Mock Game'
    });
    assert.equal(bound.success, true, bound.error);
    assert.equal(transport.listAppBinds().binds[0].bundleId, 'com.mock.game');
    const moved = await transport.moveOnboardToLocal('KeyboardProfile@keyboard@0');
    assert.equal(moved.success, true, moved.error);
    assert.equal(moved.autoUnbound, true);
    assert.equal(transport.listAppBinds().binds.length, 0);
  });

  test('listAppBinds cache updates on bind/unbind and misses on device change', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maicong-app-bind-cache-'));
    transport.profileLibraryPath = path.join(tmpDir, 'profile-library.json');
    transport.stillLibraryPath = path.join(tmpDir, 'still.json');
    transport.gifLibraryPath = path.join(tmpDir, 'gif.json');
    transport.lightingMemoryPath = path.join(tmpDir, 'lightmem.json');
    const file = tmpFile();
    transport.profileAppBindPath = file;
    const mock = new MockGlwMemoryDevice();
    transport.installTestAdapter(mock);
    await transport.queryStatus();

    const bound = transport.bindProfileApp({
      profileIndex: 1,
      bundleId: 'com.mock.game',
      displayName: 'Mock Game'
    });
    assert.equal(bound.success, true, bound.error);
    assert.equal(transport.listAppBinds().binds[0].bundleId, 'com.mock.game');

    const deviceKey = appBind.deviceStorageKey(transport.lastState.device);
    const other = appBind.setBind([], { profileIndex: 2, bundleId: 'com.other.game', displayName: 'Other' });
    appBind.writeDevice(file, deviceKey, other.binds);
    assert.equal(transport.listAppBinds().binds[0].bundleId, 'com.mock.game', 'warm cache must ignore an out-of-process file write');

    appBind.writeDevice(file, deviceKey, bound.binds);
    const unbound = transport.unbindProfileApp(1);
    assert.equal(unbound.success, true, unbound.error);
    assert.equal(unbound.changed, true);
    assert.equal(transport.listAppBinds().binds.length, 0);

    const rebound = transport.bindProfileApp({
      profileIndex: 0,
      bundleId: 'com.mock.game',
      displayName: 'Mock Game'
    });
    assert.equal(rebound.success, true, rebound.error);
    transport.lastState.device = { ...transport.lastState.device, serialNumber: 'OTHER-SN' };
    assert.equal(transport.listAppBinds().binds.length, 0, 'device-key change must miss the cache');
  });
});
