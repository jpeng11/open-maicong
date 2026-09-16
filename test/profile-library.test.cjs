const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const library = require('../src/profile-library.cjs');
const ops = require('../src/profile-ops.cjs');

function tmpFile() {
  return path.join(os.tmpdir(), `maicong-profile-lib-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
}

const files = [];
afterEach(() => {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch {}
  }
  files.length = 0;
});

describe('local profile library persistence', () => {
  test('create prepends, capacity is 20 including onboard, corruption refuses writes', () => {
    const created = library.createFromDefaults([], 'AB', 4);
    assert.equal(created.valid, true, created.error);
    assert.equal(created.items[0].type, 'localstorage');
    assert.equal(created.items[0].profileIndex, -1);
    const cap = library.checkCapacity(4, 16, 1);
    assert.equal(cap.valid, false);
    assert.equal(library.ordinaryRemaining(4, 0), 16);
    const file = tmpFile();
    files.push(file);
    library.writeDevice(file, '14391:12339:sn:A', created.items, { identityKind: 'serial' });
    fs.writeFileSync(file, '{not-json', 'utf8');
    const loaded = library.readDevice(file, '14391:12339:sn:A');
    assert.equal(loaded.ok, false);
    assert.equal(loaded.unwritable, true);
    assert.throws(() => library.writeDevice(file, '14391:12339:sn:A', created.items));
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw, '{not-json');
  });

  test('malformed imported local data does not become defaults or erase valid records', () => {
    const file = tmpFile();
    files.push(file);
    const good = library.createFromDefaults([], 'GoodName', 3);
    library.writeDevice(file, 'dev', good.items);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.devices.dev.items.push({ key: 'nope', name: 'X', type: 'localstorage', profileIndex: -1, data: null });
    fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
    const loaded = library.readDevice(file, 'dev');
    assert.equal(loaded.ok, false);
    assert.equal(loaded.unwritable, true);
    assert.throws(() => library.writeDevice(file, 'dev', good.items));
    const still = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(still.devices.dev.items[0].name, 'GoodName');
  });

  test('null snapshot data is rejected instead of becoming factory defaults', () => {
    const file = tmpFile();
    files.push(file);
    const good = library.createFromDefaults([], 'GoodName', 3);
    library.writeDevice(file, 'dev', good.items);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const key = doc.devices.dev.items[0].key;
    doc.devices.dev.items[0] = {
      key,
      name: 'GoodName',
      type: 'localstorage',
      profileIndex: -1,
      data: null
    };
    fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
    const loaded = library.readDevice(file, 'dev');
    assert.equal(loaded.ok, false);
    assert.equal(loaded.unwritable, true);
    assert.throws(() => library.writeDevice(file, 'dev', good.items));
    const still = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(still.devices.dev.items[0].data, null);
    assert.equal(library.validateNativeSnapshot(null).valid, false);
  });

  test('malformed nested stored lighting is not replaced with defaults', () => {
    const file = tmpFile();
    files.push(file);
    const good = library.createFromDefaults([], 'GoodName', 3);
    library.writeDevice(file, 'dev', good.items);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.devices.dev.items[0].data.lighting = 42;
    fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
    const loaded = library.readDevice(file, 'dev');
    assert.equal(loaded.ok, false);
    assert.equal(loaded.unwritable, true);
    assert.throws(() => library.writeDevice(file, 'dev', good.items));
    const still = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(still.devices.dev.items[0].data.lighting, 42);
    assert.equal(still.devices.dev.items[0].name, 'GoodName');
    const nested = library.validateNativeSnapshot({
      model: 'MCHOSE G75 V2',
      protocol: 'GLW',
      lighting: 42,
      settings: { sleepTime: 6, reporteRate: 4 },
      layers: good.items[0].data.layers
    });
    assert.equal(nested.valid, false);
  });

  test('copy of every default onboard label becomes a unique 2..15 local name', () => {
    const namesMod = require('../src/profile-names.cjs');
    let items = [];
    const onboard = [0, 1, 2, 3].map((i) => ({ name: namesMod.defaultOnboardName(i) }));
    for (let slot = 0; slot < 4; slot++) {
      const copied = library.copyOnboardToLocal(
        items,
        namesMod.defaultOnboardName(slot),
        library.defaultNativeSnapshot(),
        { confirmShareFailed: false },
        4,
        onboard
      );
      assert.equal(copied.valid, true, copied.error);
      assert.ok(copied.item.name.length >= 2 && copied.item.name.length <= 15, copied.item.name);
      if (namesMod.defaultOnboardName(slot).length > 15) {
        assert.equal(copied.item.extra.displayName, namesMod.defaultOnboardName(slot));
      }
      items = copied.items;
    }
    const localNames = items.map((item) => item.name);
    assert.equal(new Set(localNames).size, 4);
  });
});

describe('source-traced list transitions', () => {
  function seed() {
    return {
      list: [
        { key: 'KeyboardProfile@keyboard@0', type: 'keyboard', name: 'Default Onboard', profileIndex: 0 },
        { key: 'KeyboardProfile@keyboard@1', type: 'keyboard', name: 'Default Onboard2', profileIndex: 1 },
        { key: 'KeyboardProfile@keyboard@2', type: 'keyboard', name: 'Default Onboard3', profileIndex: 2 },
        { key: 'loc1', type: 'localstorage', name: 'CustomAB', profileIndex: -1, data: { lighting: { effect: 3 } } }
      ],
      order: [2, 0, 1, 3],
      length: 3,
      activeIndex: 2
    };
  }

  test('tE free slot uses order[length] not the lowest unused index', () => {
    const plan = ops.planLocalToOnboard(seed(), 'loc1', null, { activate: true });
    assert.equal(plan.valid, true, plan.error);
    assert.equal(plan.targetSlot, 3);
    assert.equal(plan.length, 4);
    assert.equal(plan.list.some((i) => i.type === 'localstorage' && i.name === 'CustomAB'), false);
  });

  test('tE replacing a used slot parks outgoing data in the source local position', () => {
    const plan = ops.planLocalToOnboard(seed(), 'loc1', 'KeyboardProfile@keyboard@1', {
      activate: false,
      outgoingData: { lighting: { effect: 9 } }
    });
    assert.equal(plan.valid, true, plan.error);
    assert.equal(plan.targetSlot, 1);
    const parked = plan.list[plan.list.findIndex((i) => i.key === plan.outgoingLocalKey)];
    assert.equal(parked.type, 'localstorage');
    assert.ok(parked.name.length >= 2 && parked.name.length <= 15, parked.name);
    assert.equal(parked.extra.displayName, 'Default Onboard2');
    assert.equal(parked.data.lighting.effect, 9);
    const kb = plan.list.find((i) => i.profileIndex === 1);
    assert.equal(kb.name, 'CustomAB');
  });

  test('tI copy preserves source onboard and appends outgoing as local', () => {
    const plan = ops.planOnboardCopy(seed(), 'KeyboardProfile@keyboard@0', 'KeyboardProfile@keyboard@2', {
      sourceData: { lighting: { effect: 1 } },
      outgoingData: { lighting: { effect: 2 } }
    });
    assert.equal(plan.valid, true, plan.error);
    assert.equal(plan.preserveSourceSlot, 0);
    assert.equal(plan.list.filter((i) => i.type === 'keyboard' && i.profileIndex === 0).length, 1);
    const local = plan.list.find((i) => i.key === plan.outgoingLocalKey);
    assert.ok(local.name.length >= 2 && local.name.length <= 15, local.name);
    assert.equal(local.extra.displayName, 'Default Onboard3');
  });

  test('tk parks a 16-character default onboard name as a valid unique local name', () => {
    const state = seed();
    const plan = ops.planOnboardToLocal(state, 'KeyboardProfile@keyboard@1');
    assert.equal(plan.valid, true, plan.error);
    const local = plan.list.find((i) => i.key === plan.outgoingLocalKey);
    assert.equal(local.type, 'localstorage');
    assert.ok(local.name.length >= 2 && local.name.length <= 15, local.name);
    assert.equal(local.extra.displayName, 'Default Onboard2');
    assert.equal(plan.list.some((i) => i.type === 'keyboard' && i.profileIndex === 1), false);
  });

  test('tk refuses to move the last onboard profile', () => {
    const last = {
      list: [{ key: 'KeyboardProfile@keyboard@0', type: 'keyboard', name: 'Only', profileIndex: 0 }],
      order: [0, 1, 2, 3],
      length: 1,
      activeIndex: 0
    };
    const plan = ops.planOnboardToLocal(last, 'KeyboardProfile@keyboard@0');
    assert.equal(plan.valid, false);
  });

  test('tg delete-active picks the right-then-left neighbor', () => {
    const state = seed();
    const plan = ops.planDelete(state, 'KeyboardProfile@keyboard@2');
    assert.equal(plan.valid, true, plan.error);
    assert.equal(plan.removedActive, true);
    assert.equal(plan.nextActiveIndex, 1);
  });

  test('tL leaves unspecified keys after specified keys and rederives onboard order', () => {
    const plan = ops.planReorder(seed(), ['loc1', 'KeyboardProfile@keyboard@1']);
    assert.equal(plan.valid, true);
    assert.equal(plan.list[0].key, 'loc1');
    assert.equal(plan.list[1].key, 'KeyboardProfile@keyboard@1');
    assert.equal(plan.order[0], 1);
  });

  test('neighbor helper firstLeft false prefers the right side', () => {
    const list = ['a', 'b', 'c', 'd'];
    const idx = ops.neighborIndex(list, (v) => v === 'd' || v === 'a', 2, { firstLeft: false });
    assert.equal(list[idx], 'd');
  });
});
