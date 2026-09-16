/**
 * G75 V2 mechanical Key Config helpers.
 * Drag payload, binding clipboard, one-key chord recorder, and restore-defaults
 * filters traced from hub chunks 1833/2233. Vendor JS is never executed.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MaicongKeyConfig = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CLIP_KIND = 'g75-key-binding';
  const CLIP_VERSION = 1;
  const DRAG_SOURCE = 'keyCode';
  const DEFINITE_ADVANCED = new Set([144, 145, 146, 147, 148, 149]);
  const ORDINARY_TYPES = new Set([0, 16, 32, 33, 48, 64, 112, 240]);
  const MODIFIER_HID = {
    224: 1,
    225: 2,
    226: 4,
    227: 8,
    228: 16,
    229: 32,
    230: 64,
    231: 128
  };

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function isUint8(value) {
    return Number.isInteger(value) && value >= 0 && value <= 255;
  }

  function tupleOf(value) {
    if (!isPlainObject(value)) return null;
    const type = value.type;
    const code1 = value.code1;
    const code2 = value.code2;
    if (!isUint8(type) || !isUint8(code1) || !isUint8(code2)) return null;
    return { type, code1, code2 };
  }

  function tuplesEqual(a, b) {
    return Boolean(a && b && a.type === b.type && a.code1 === b.code1 && a.code2 === b.code2);
  }

  function isDefiniteAdvanced(tuple) {
    return Boolean(tuple && DEFINITE_ADVANCED.has(tuple.type));
  }

  function isMaybeCb(tuple) {
    return Boolean(tuple && tuple.type === 16 && tuple.code1 > 0 && tuple.code2 > 0);
  }

  function isAdvancedBinding(tuple, cbSlots) {
    if (!tuple) return false;
    if (isDefiniteAdvanced(tuple)) return true;
    if (!isMaybeCb(tuple)) return false;
    if (!cbSlots || typeof cbSlots.has !== 'function') return false;
    return cbSlots.has(tuple.slot != null ? tuple.slot : tuple.index);
  }

  function isOrdinaryRemap(tuple) {
    return Boolean(tuple && ORDINARY_TYPES.has(tuple.type) && !isDefiniteAdvanced(tuple));
  }

  function makeDragPayload(tuple) {
    const t = tupleOf(tuple);
    if (!t) return { ok: false, error: 'Drag payload is not a GLW key tuple' };
    return {
      ok: true,
      data: {
        source: DRAG_SOURCE,
        payload: t
      }
    };
  }

  function readDragPayload(data, currentTab) {
    if (currentTab && currentTab !== 'keyCode' && currentTab !== 'keymap') {
      return { ok: false, error: 'Drop is only valid on Key Config' };
    }
    if (data == null) return { ok: false, error: 'No drag payload' };
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return { ok: false, error: 'Drag payload is not JSON' };
      }
    }
    if (!isPlainObject(data) || data.source !== DRAG_SOURCE) {
      return { ok: false, error: 'Drag source is not keyCode' };
    }
    const t = tupleOf(data.payload);
    if (!t) return { ok: false, error: 'Drag payload is not a GLW key tuple' };
    return { ok: true, tuple: t };
  }

  function isReferenceBinding(tuple) {
    return Boolean(tuple && (tuple.type === 112 || tuple.type === 145 || tuple.type === 146));
  }

  function parseProfileIdentity(source) {
    if (!isPlainObject(source)) {
      return { ok: false, error: 'Clipboard source is missing' };
    }
    if (source.kind === 'local') {
      if (typeof source.key !== 'string' || source.key.length === 0) {
        return { ok: false, error: 'Clipboard local source key is missing' };
      }
      return { ok: true, identity: { kind: 'local', key: source.key } };
    }
    if (source.kind === 'onboard') {
      if (!Number.isInteger(source.profileIndex) || source.profileIndex < 0 || source.profileIndex > 3) {
        return { ok: false, error: 'Clipboard onboard source profile is invalid' };
      }
      return { ok: true, identity: { kind: 'onboard', profileIndex: source.profileIndex } };
    }
    return { ok: false, error: 'Clipboard source kind is invalid' };
  }

  function profileIdentity(source) {
    const parsed = parseProfileIdentity(source);
    return parsed.ok ? parsed.identity : null;
  }

  function sameProfile(a, b) {
    if (!a || !b || a.kind !== b.kind) return false;
    if (a.kind === 'local') return a.key === b.key && Boolean(a.key);
    return a.profileIndex === b.profileIndex;
  }

  function sameMacroBank(a, b) {
    if (!a || !b) return false;
    if (a.kind === 'onboard' && b.kind === 'onboard') return true;
    return a.kind === 'local' && b.kind === 'local' && a.key === b.key;
  }

  function bytesEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if ((a[i] & 255) !== (b[i] & 255)) return false;
    }
    return true;
  }

  function copyBytes(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (let i = 0; i < list.length; i++) {
      if (!Number.isInteger(list[i]) || list[i] < 0 || list[i] > 255) return null;
      out.push(list[i]);
    }
    return out;
  }

  function tableEntrySize(type) {
    if (type === 146) return 6;
    if (type === 145) return 3;
    return 0;
  }

  function readTableEntryBytes(table, index, entrySize) {
    if (!table || !Number.isInteger(index) || index < 0 || !Number.isInteger(entrySize) || entrySize <= 0) {
      return null;
    }
    const off = index * entrySize;
    if (typeof table.length === 'number') {
      if (off + entrySize > table.length) return null;
      const out = [];
      for (let i = 0; i < entrySize; i++) out.push(table[off + i] & 255);
      return out;
    }
    return null;
  }

  function findMatchingTableIndex(table, expectedBytes, entrySize, preferIndex) {
    const expected = copyBytes(expectedBytes);
    if (!expected || expected.length !== entrySize) return -1;
    if (Number.isInteger(preferIndex) && preferIndex >= 0) {
      const at = readTableEntryBytes(table, preferIndex, entrySize);
      if (at && bytesEqual(at, expected)) return preferIndex;
    }
    if (!table || typeof table.length !== 'number') return -1;
    const count = Math.floor(table.length / entrySize);
    for (let i = 0; i < count; i++) {
      if (i === preferIndex) continue;
      const at = readTableEntryBytes(table, i, entrySize);
      if (at && bytesEqual(at, expected)) return i;
    }
    return -1;
  }

  function parseMacroSnapshot(raw) {
    if (!isPlainObject(raw)) return null;
    if (!Number.isInteger(raw.playbackType) || raw.playbackType < 0 || raw.playbackType > 255) return null;
    if (typeof raw.bodyKey !== 'string' || raw.bodyKey.length === 0) return null;
    return { playbackType: raw.playbackType, bodyKey: raw.bodyKey };
  }

  function findMatchingMacroIndex(slots, snapshot, preferIndex) {
    const snap = parseMacroSnapshot(snapshot);
    if (!snap || !Array.isArray(slots)) return -1;
    const matches = (slot) => {
      if (!slot || typeof slot !== 'object') return false;
      const type = Number.isInteger(slot.type) ? slot.type : 0;
      if (type !== snap.playbackType) return false;
      const key = typeof slot.bodyKey === 'string' ? slot.bodyKey : '';
      return key === snap.bodyKey;
    };
    if (Number.isInteger(preferIndex) && preferIndex >= 0 && preferIndex < slots.length && matches(slots[preferIndex])) {
      return preferIndex;
    }
    for (let i = 0; i < slots.length; i++) {
      if (i === preferIndex) continue;
      if (matches(slots[i])) return i;
    }
    return -1;
  }

  function serializeClipboard(binding, source, extras) {
    const t = tupleOf(binding);
    if (!t) return { ok: false, error: 'Clipboard binding is not a GLW key tuple' };
    const extra = extras && typeof extras === 'object' ? extras : {};
    const clip = {
      v: CLIP_VERSION,
      kind: CLIP_KIND,
      binding: t
    };
    if (isReferenceBinding(t)) {
      const parsed = parseProfileIdentity(source);
      if (!parsed.ok) return parsed;
      clip.source = parsed.identity;
      if (t.type === 112) {
        const macro = parseMacroSnapshot(extra.macro);
        if (!macro) return { ok: false, error: 'Macro clipboard requires playback type and action identity' };
        clip.macro = macro;
      } else {
        const size = tableEntrySize(t.type);
        const bytes = copyBytes(extra.tableBytes);
        if (!bytes || bytes.length !== size) {
          return { ok: false, error: 'Advanced clipboard requires table content bytes' };
        }
        clip.tableBytes = bytes;
      }
    } else {
      const parsed = parseProfileIdentity(source);
      if (parsed.ok) clip.source = parsed.identity;
    }
    return { ok: true, clip };
  }

  function parseClipboard(raw) {
    let data = raw;
    if (typeof raw === 'string') {
      try {
        data = JSON.parse(raw);
      } catch {
        return { ok: false, error: 'Clipboard is not JSON' };
      }
    }
    if (!isPlainObject(data)) return { ok: false, error: 'Clipboard is not an object' };
    if (data.v !== CLIP_VERSION || data.kind !== CLIP_KIND) {
      return { ok: false, error: 'Clipboard is not a G75 key binding' };
    }
    const t = tupleOf(data.binding);
    if (!t) return { ok: false, error: 'Clipboard binding is malformed' };
    const clip = { v: CLIP_VERSION, kind: CLIP_KIND, binding: t };
    if (isReferenceBinding(t)) {
      const parsed = parseProfileIdentity(data.source);
      if (!parsed.ok) return parsed;
      clip.source = parsed.identity;
      if (t.type === 112) {
        const macro = parseMacroSnapshot(data.macro);
        if (!macro) return { ok: false, error: 'Macro clipboard requires playback type and action identity' };
        clip.macro = macro;
      } else {
        const size = tableEntrySize(t.type);
        const bytes = copyBytes(data.tableBytes);
        if (!bytes || bytes.length !== size) {
          return { ok: false, error: 'Advanced clipboard requires table content bytes' };
        }
        clip.tableBytes = bytes;
      }
    } else if (data.source !== undefined) {
      const parsed = parseProfileIdentity(data.source);
      if (!parsed.ok) return parsed;
      clip.source = parsed.identity;
    }
    return { ok: true, clip };
  }

  function collectTableRefs(layerMaps) {
    const mt = new Set();
    const tgl = new Set();
    const maps = layerMaps && typeof layerMaps === 'object' ? layerMaps : {};
    for (let layer = 0; layer < 4; layer++) {
      const layerMap = maps[layer] || maps[String(layer)] || {};
      for (const def of Object.values(layerMap)) {
        const t = tupleOf(def);
        if (!t) continue;
        if (t.type === 146 || t.type === 148) mt.add(t.code1);
        else if (t.type === 145) tgl.add(t.code1);
        else if (t.type === 147 || t.type === 149) {
          mt.add(t.code1);
          tgl.add(t.code1);
        }
      }
    }
    return { mt, tgl };
  }

  function canShareAdvanced(binding, destLayers) {
    if (!binding) return false;
    const refs = collectTableRefs(destLayers);
    if (binding.type === 145) return refs.tgl.has(binding.code1);
    if (binding.type === 146) return refs.mt.has(binding.code1);
    return false;
  }

  function pasteBinding(clip, dest, destLayers, destContext) {
    const parsed = parseClipboard(clip);
    if (!parsed.ok) return parsed;
    const binding = parsed.clip.binding;
    const destParsed = parseProfileIdentity(dest);
    const ctx = destContext && typeof destContext === 'object' ? destContext : {};
    if (binding.type === 148 || binding.type === 144 || binding.type === 147 || binding.type === 149) {
      return { ok: false, error: 'SOCD and magnetic advanced bindings cannot be pasted from Key Config' };
    }
    if (binding.type === 112) {
      if (!destParsed.ok) return destParsed;
      const prefer = sameMacroBank(parsed.clip.source, destParsed.identity) ? binding.code1 : -1;
      const found = findMatchingMacroIndex(ctx.macros, parsed.clip.macro, prefer);
      if (found < 0) {
        return {
          ok: false,
          error: 'Macro content and playback type were not found in the destination bank',
          rejectStage: 'pasteBinding',
          want: parsed.clip.macro,
          have: summarizeMacroIdentities(ctx.macros)
        };
      }
      return {
        ok: true,
        tuple: { type: 112, code1: found, code2: parsed.clip.macro.playbackType },
        migrated: found !== binding.code1,
        expectedMacro: {
          type: 112,
          index: found,
          playbackType: parsed.clip.macro.playbackType,
          bodyKey: parsed.clip.macro.bodyKey
        }
      };
    }
    if (binding.type === 145 || binding.type === 146) {
      if (!destParsed.ok) return destParsed;
      if (!sameProfile(parsed.clip.source, destParsed.identity)) {
        return { ok: false, error: 'MT/TGL table indexes cannot be pasted across profiles' };
      }
      const size = tableEntrySize(binding.type);
      const table = binding.type === 146 ? ctx.mtTable : ctx.tglTable;
      const found = findMatchingTableIndex(table, parsed.clip.tableBytes, size, binding.code1);
      if (found < 0) {
        return { ok: false, error: 'MT/TGL table content no longer matches the copied binding' };
      }
      if (!canShareAdvanced({ type: binding.type, code1: found, code2: binding.code2 }, destLayers)) {
        return { ok: false, error: 'MT/TGL paste would write an unreferenced table index' };
      }
      return {
        ok: true,
        tuple: { type: binding.type, code1: found, code2: binding.code2 },
        sharedAdvanced: true,
        expectedRef: { type: binding.type, index: found, bytes: parsed.clip.tableBytes.slice() },
        migrated: found !== binding.code1
      };
    }
    if (!ORDINARY_TYPES.has(binding.type) && !DEFINITE_ADVANCED.has(binding.type)) {
      return { ok: false, error: 'Clipboard type is not a G75 remap tuple' };
    }
    return { ok: true, tuple: binding, sharedAdvanced: false };
  }

  function identitySlotsFromParsed(slots, bodyKeyFn) {
    const keyOf = typeof bodyKeyFn === 'function' ? bodyKeyFn : () => '';
    if (!Array.isArray(slots)) return [];
    return slots.map((slot) => ({
      type: slot && Number.isInteger(slot.type) ? slot.type : 0,
      bodyKey: slot && typeof slot.bodyKey === 'string' && slot.bodyKey.length
        ? slot.bodyKey
        : keyOf((slot && slot.actions) || [])
    }));
  }

  function summarizeMacroIdentities(macros) {
    if (!Array.isArray(macros)) return [];
    const out = [];
    for (let i = 0; i < macros.length; i++) {
      const slot = macros[i];
      const type = slot && Number.isInteger(slot.type) ? slot.type : 0;
      const bodyKey = slot && typeof slot.bodyKey === 'string' ? slot.bodyKey : '';
      if (!bodyKey) continue;
      out.push({ i, type, bodyKey });
    }
    return out;
  }

  function plannedMatchesMacroRef(item, ref) {
    if (!item || item.type !== 112) return false;
    if (Number.isInteger(ref.slot)) {
      const slot = item.slot !== undefined ? item.slot : item.index;
      return slot === ref.slot;
    }
    return item.code1 === ref.index;
  }

  function resolveExpectedMacroUpdates(planned, macros, refs) {
    if (!Array.isArray(refs) || refs.length === 0) {
      return { ok: true, planned: Array.isArray(planned) ? planned.map((u) => Object.assign({}, u)) : [] };
    }
    const out = Array.isArray(planned) ? planned.map((u) => Object.assign({}, u)) : [];
    const have = summarizeMacroIdentities(macros);
    for (const ref of refs) {
      if (!ref || ref.type !== 112) {
        return {
          ok: false,
          error: 'Macro paste is missing playback type and action identity',
          rejectStage: 'resolveExpectedMacroUpdates',
          want: ref || null,
          have
        };
      }
      const snap = parseMacroSnapshot(ref);
      if (!snap || !Number.isInteger(ref.index) || ref.index < 0) {
        return {
          ok: false,
          error: 'Macro paste is missing playback type and action identity',
          rejectStage: 'resolveExpectedMacroUpdates',
          want: ref,
          have
        };
      }
      const found = findMatchingMacroIndex(macros, snap, ref.index);
      const want = { playbackType: snap.playbackType, bodyKey: snap.bodyKey, index: ref.index, slot: ref.slot };
      if (found < 0) {
        return {
          ok: false,
          error: 'Macro content and playback type were not found in the destination bank',
          rejectStage: 'resolveExpectedMacroUpdates',
          want,
          have
        };
      }
      let matched = 0;
      for (const item of out) {
        if (plannedMatchesMacroRef(item, ref)) {
          item.code1 = found;
          item.code2 = snap.playbackType;
          matched += 1;
        }
      }
      if (matched < 1) {
        return {
          ok: false,
          error: 'Macro paste reference does not match a planned update',
          rejectStage: 'resolveExpectedMacroUpdates',
          want,
          have
        };
      }
    }
    return { ok: true, planned: out };
  }

  function createSaveGate() {
    let pending = 0;
    let tail = Promise.resolve();
    function enqueue(fn) {
      pending += 1;
      const run = tail.then(() => fn(), () => fn());
      tail = run.then(() => undefined, () => undefined);
      return run.finally(() => {
        pending -= 1;
      });
    }
    async function drain(maxMs) {
      const limit = Number.isInteger(maxMs) && maxMs >= 0 ? maxMs : 20000;
      const started = Date.now();
      while (pending > 0) {
        if (Date.now() - started >= limit) return false;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return true;
    }
    return {
      enqueue,
      drain,
      get pending() { return pending; }
    };
  }

  function slotRevKey(layer, slot) {
    return `${layer}:${slot}`;
  }

  function bumpSlotRev(store, layer, slot) {
    const key = slotRevKey(layer, slot);
    const next = (store[key] || 0) + 1;
    store[key] = next;
    return next;
  }

  function getSlotRev(store, layer, slot) {
    return store[slotRevKey(layer, slot)] || 0;
  }

  function captureSlotRevs(store, layer, updates) {
    const captured = {};
    if (!Array.isArray(updates)) return captured;
    for (const update of updates) {
      if (!update) continue;
      const slot = update.slot !== undefined ? update.slot : update.index;
      if (!Number.isInteger(slot)) continue;
      captured[slot] = getSlotRev(store, layer, slot);
    }
    return captured;
  }

  function slotRevMatches(store, captured, layer, slot) {
    if (!captured) return false;
    const hasKey = Object.prototype.hasOwnProperty.call(captured, slot)
      || Object.prototype.hasOwnProperty.call(captured, String(slot));
    if (!hasKey) return false;
    const expected = captured[slot] !== undefined ? captured[slot] : captured[String(slot)];
    return getSlotRev(store, layer, slot) === expected;
  }

  function markSlotsPersisted(persisted, layer, captured, store) {
    if (!captured) return;
    for (const raw of Object.keys(captured)) {
      const slot = Number(raw);
      if (!Number.isInteger(slot)) continue;
      if (getSlotRev(store, layer, slot) === captured[slot]) {
        persisted[slotRevKey(layer, slot)] = captured[slot];
      }
    }
  }

  function markRevSnapshotPersisted(persisted, snapshotRevs, store) {
    if (!snapshotRevs) return;
    for (const key of Object.keys(snapshotRevs)) {
      if ((store[key] || 0) === snapshotRevs[key]) persisted[key] = snapshotRevs[key];
    }
  }

  function hasUnpersistedSlotRevs(store, persisted) {
    const keys = new Set([...Object.keys(store || {}), ...Object.keys(persisted || {})]);
    for (const key of keys) {
      if ((store[key] || 0) !== (persisted[key] || 0)) return true;
    }
    return false;
  }

  function slotIsDirty(store, persisted, layer, slot) {
    return getSlotRev(store, layer, slot) !== ((persisted && persisted[slotRevKey(layer, slot)]) || 0);
  }

  function persistableTuple(tuple, slot) {
    if (!tuple || typeof tuple !== 'object') return null;
    const t = tupleOf(tuple);
    if (!t) return null;
    const out = {
      slot: Number.isInteger(slot) ? slot : (Number.isInteger(tuple.slot) ? tuple.slot : undefined),
      type: t.type,
      code1: t.code1,
      code2: t.code2,
      code: tuple.code !== undefined ? tuple.code : (t.code2 || t.code1)
    };
    if (tuple.label) out.label = tuple.label;
    return out;
  }

  function applyPlannedIfCurrent(layerMap, planned, store, captured, layer) {
    if (!layerMap || !Array.isArray(planned)) return [];
    const applied = [];
    for (const item of planned) {
      if (!item) continue;
      const slot = item.slot !== undefined ? item.slot : item.index;
      if (!Number.isInteger(slot)) continue;
      if (!slotRevMatches(store, captured, layer, slot)) continue;
      const staged = layerMap[slot] || layerMap[String(slot)];
      if (!staged) continue;
      staged.type = item.type;
      staged.code1 = item.code1;
      staged.code2 = item.code2;
      staged.code = item.code !== undefined ? item.code : (item.code2 || item.code1);
      applied.push(slot);
    }
    return applied;
  }

  function mergeLayerHydration(existing, incoming, store, persisted, layer) {
    const out = {};
    const existingMap = existing && typeof existing === 'object' ? existing : {};
    const incomingMap = incoming && typeof incoming === 'object' ? incoming : {};
    for (const raw of Object.keys(incomingMap)) {
      const slot = Number(raw);
      if (!Number.isInteger(slot)) continue;
      const incomingTuple = incomingMap[slot] || incomingMap[raw];
      if (slotIsDirty(store, persisted, layer, slot)) {
        const keep = existingMap[slot] || existingMap[String(slot)];
        out[slot] = keep || incomingTuple;
      } else {
        out[slot] = incomingTuple;
        if (store) delete store[slotRevKey(layer, slot)];
        if (persisted) delete persisted[slotRevKey(layer, slot)];
      }
    }
    for (const raw of Object.keys(existingMap)) {
      const slot = Number(raw);
      if (!Number.isInteger(slot) || out[slot] !== undefined) continue;
      if (slotIsDirty(store, persisted, layer, slot)) {
        out[slot] = existingMap[slot] || existingMap[raw];
      }
    }
    return out;
  }

  function ownedSnapshotRevs(store, captured, layer) {
    const out = {};
    if (!captured) return out;
    for (const raw of Object.keys(captured)) {
      const slot = Number(raw);
      if (!Number.isInteger(slot)) continue;
      if (!slotRevMatches(store, captured, layer, slot)) continue;
      out[slotRevKey(layer, slot)] = captured[slot] !== undefined ? captured[slot] : captured[raw];
    }
    return out;
  }

  function ownedRevsUseKeys(ownedRevs) {
    return Boolean(ownedRevs && Object.keys(ownedRevs).some((key) => String(key).includes(':')));
  }

  function slotOwnedByCaptured(store, ownedRevs, ownedLayer, layer, slot) {
    if (!ownedRevs) return false;
    if (ownedRevsUseKeys(ownedRevs)) {
      const key = slotRevKey(layer, slot);
      return Object.prototype.hasOwnProperty.call(ownedRevs, key) && (store[key] || 0) === ownedRevs[key];
    }
    return ownedLayer === layer && slotRevMatches(store, ownedRevs, layer, slot);
  }

  function captureSlotRevKeys(store, slots) {
    const captured = {};
    for (const item of slots || []) {
      if (!item || !Number.isInteger(item.layer) || !Number.isInteger(item.slot)) continue;
      captured[slotRevKey(item.layer, item.slot)] = getSlotRev(store, item.layer, item.slot);
    }
    return captured;
  }

  function ownedSnapshotRevKeys(store, capturedKeys) {
    const out = {};
    if (!capturedKeys) return out;
    for (const key of Object.keys(capturedKeys)) {
      if ((store[key] || 0) === capturedKeys[key]) out[key] = capturedKeys[key];
    }
    return out;
  }

  function mergeOwnedAdvancedBindings(currentMaps, incomingMaps, changedSlots, store, capturedKeys) {
    const changed = Array.isArray(changedSlots) ? changedSlots : [];
    if (changed.length === 0) {
      return { ok: false, error: 'Local advanced result did not name changed slots', applied: [] };
    }
    for (const item of changed) {
      if (!item || !Number.isInteger(item.layer) || !Number.isInteger(item.slot)) {
        return { ok: false, error: 'Local advanced result named an invalid slot', applied: [] };
      }
      const key = slotRevKey(item.layer, item.slot);
      if (!Object.prototype.hasOwnProperty.call(capturedKeys || {}, key)) {
        return { ok: false, stale: true, error: 'Local advanced result named a slot that was not captured', applied: [] };
      }
      if ((store[key] || 0) !== capturedKeys[key]) {
        return { ok: false, stale: true, error: 'A newer edit replaced this advanced key before the local save finished', applied: [] };
      }
    }
    const next = {
      0: Object.assign({}, currentMaps && (currentMaps[0] || currentMaps['0'])),
      1: Object.assign({}, currentMaps && (currentMaps[1] || currentMaps['1'])),
      2: Object.assign({}, currentMaps && (currentMaps[2] || currentMaps['2'])),
      3: Object.assign({}, currentMaps && (currentMaps[3] || currentMaps['3']))
    };
    const applied = [];
    for (const item of changed) {
      const incomingLayer = incomingMaps && (incomingMaps[item.layer] || incomingMaps[String(item.layer)]);
      const tuple = incomingLayer && (incomingLayer[item.slot] || incomingLayer[String(item.slot)]);
      if (!tuple) {
        return { ok: false, error: `Local advanced result missing layer ${item.layer} slot ${item.slot}`, applied: [] };
      }
      if (!next[item.layer]) next[item.layer] = {};
      next[item.layer][item.slot] = {
        slot: item.slot,
        type: tuple.type,
        code1: tuple.code1,
        code2: tuple.code2,
        code: tuple.code !== undefined ? tuple.code : (tuple.code2 || tuple.code1),
        label: tuple.label
      };
      applied.push(item);
    }
    return { ok: true, maps: next, applied };
  }

  function unplannedAdvancedRevChanged(store, capturedKeys, changedSlots, layerMaps, cbSlotsForLayer) {
    const planned = new Set((changedSlots || []).map((item) => slotRevKey(item.layer, item.slot)));
    const keys = new Set([...Object.keys(store || {}), ...Object.keys(capturedKeys || {})]);
    for (const key of keys) {
      if (planned.has(key)) continue;
      if ((store[key] || 0) === (capturedKeys[key] || 0)) continue;
      const parts = String(key).split(':');
      const layer = Number(parts[0]);
      const slot = Number(parts[1]);
      if (!Number.isInteger(layer) || !Number.isInteger(slot)) continue;
      const map = layerMaps && (layerMaps[layer] || layerMaps[String(layer)]);
      const tuple = map && (map[slot] || map[String(slot)]);
      const cbSlots = typeof cbSlotsForLayer === 'function' ? cbSlotsForLayer(layer) : cbSlotsForLayer;
      if (isAdvancedBinding({ ...(tuple || {}), slot }, cbSlots) || isDefiniteAdvanced(tuple)) {
        return true;
      }
    }
    return false;
  }

  function layersForLocalPersist(currentLayers, previousLayers, store, persisted, ownedRevs, ownedLayer) {
    const out = { 0: {}, 1: {}, 2: {}, 3: {} };
    const current = currentLayers && typeof currentLayers === 'object' ? currentLayers : {};
    const previous = previousLayers && typeof previousLayers === 'object' ? previousLayers : {};
    for (let layer = 0; layer < 4; layer++) {
      const cur = current[layer] || current[String(layer)] || {};
      const prev = previous[layer] || previous[String(layer)] || {};
      const slots = new Set([...Object.keys(cur), ...Object.keys(prev)]);
      for (const raw of slots) {
        const slot = Number(raw);
        if (!Number.isInteger(slot)) continue;
        const curT = persistableTuple(cur[slot] || cur[String(slot)], slot);
        const prevT = persistableTuple(prev[slot] || prev[String(slot)], slot);
        const owned = slotOwnedByCaptured(store, ownedRevs, ownedLayer, layer, slot);
        const dirty = slotIsDirty(store, persisted, layer, slot);
        if (owned || !dirty) {
          if (curT) out[layer][slot] = curT;
        } else if (prevT) {
          out[layer][slot] = prevT;
        }
      }
    }
    return out;
  }

  function captureSaveIdentity(source, gen, resetEpoch, profile) {
    return {
      gen,
      resetEpoch,
      profile,
      source: profileIdentity(source)
    };
  }

  function saveIdentityMatches(captured, current) {
    if (!captured || !current) return false;
    if (captured.gen !== current.gen) return false;
    if (captured.resetEpoch !== current.resetEpoch) return false;
    if (captured.profile !== undefined && captured.profile !== current.profile) return false;
    if (captured.source) return sameProfile(captured.source, current.source);
    return true;
  }

  function clearSlotRevs(store, persisted, layer) {
    if (layer === undefined || layer === null) {
      Object.keys(store || {}).forEach((key) => { delete store[key]; });
      Object.keys(persisted || {}).forEach((key) => { delete persisted[key]; });
      return;
    }
    const prefix = `${layer}:`;
    Object.keys(store || {}).forEach((key) => { if (key.startsWith(prefix)) delete store[key]; });
    Object.keys(persisted || {}).forEach((key) => { if (key.startsWith(prefix)) delete persisted[key]; });
  }

  function cutBinding(tuple, cbSlots, extras) {
    const t = tupleOf(tuple);
    if (!t) return { ok: false, error: 'Cut source is not a GLW key tuple' };
    if (isAdvancedBinding({ ...t, slot: tuple.slot }, cbSlots) || isDefiniteAdvanced(t)) {
      return { ok: false, error: 'Advanced bindings cannot be cut from Key Config' };
    }
    const copied = serializeClipboard(t, tuple.source || tuple, extras);
    if (!copied.ok) return copied;
    return { ok: true, clip: copied.clip, restoreDefault: true };
  }

  function copyBinding(tuple, source, extras) {
    return serializeClipboard(tuple, source, extras);
  }

  function layerSlotMap(layerMaps, layer) {
    const maps = layerMaps && typeof layerMaps === 'object' ? layerMaps : {};
    return maps[layer] || maps[String(layer)] || {};
  }

  function resetUpdatesForLayer(layer, layerMap, defaults, cbSlots, physicalSlots) {
    const updates = [];
    const skipped = [];
    const slots = physicalSlots && typeof physicalSlots[Symbol.iterator] === 'function'
      ? physicalSlots
      : Object.keys(layerMap || {}).map((s) => parseInt(s, 10));
    for (const slot of slots) {
      if (!Number.isInteger(slot)) continue;
      const current = tupleOf(layerMap && (layerMap[slot] || layerMap[String(slot)]));
      const advanced = isAdvancedBinding({ ...(current || {}), slot }, cbSlots) || isDefiniteAdvanced(current);
      if (advanced) {
        skipped.push(slot);
        continue;
      }
      const def = defaults && (defaults[slot] || defaults[String(slot)]);
      const defTuple = Array.isArray(def)
        ? { type: def[0], code1: def[1], code2: def[2] }
        : tupleOf(def);
      if (!defTuple) continue;
      if (current && tuplesEqual(current, defTuple)) continue;
      updates.push({ slot, type: defTuple.type, code1: defTuple.code1, code2: defTuple.code2 });
    }
    return { layer, updates, skipped };
  }

  function isSomeKeyChanged(layerMaps, defaultLayers, cbSlots, physicalSlots) {
    for (let layer = 0; layer < 4; layer++) {
      const map = layerSlotMap(layerMaps, layer);
      const defaults = layerSlotMap(defaultLayers, layer);
      const slots = typeof cbSlots === 'function' ? cbSlots(layer) : cbSlots;
      const plan = resetUpdatesForLayer(layer, map, defaults, slots, physicalSlots);
      if (plan.updates.length > 0) return true;
    }
    return false;
  }

  function mergeLocalSnapshot(previous, editor) {
    const prev = isPlainObject(previous) ? previous : {};
    const next = isPlainObject(editor) ? editor : {};
    const merged = Object.assign({}, prev, next);
    if (isPlainObject(prev.lighting) || isPlainObject(next.lighting)) {
      merged.lighting = Object.assign({}, prev.lighting || {}, next.lighting || {});
    }
    if (isPlainObject(prev.settings) || isPlainObject(next.settings)) {
      merged.settings = Object.assign({}, prev.settings || {}, next.settings || {});
    }
    if (next.layers) merged.layers = next.layers;
    else if (prev.layers) merged.layers = prev.layers;
    if (next.perKeyRgb) merged.perKeyRgb = next.perKeyRgb;
    else if (prev.perKeyRgb) merged.perKeyRgb = prev.perKeyRgb;
    if (next.macros) merged.macros = next.macros;
    else if (prev.macros) merged.macros = prev.macros;
    if (Array.isArray(next.selectedLightEffect)) merged.selectedLightEffect = next.selectedLightEffect.slice();
    else if (Array.isArray(prev.selectedLightEffect)) merged.selectedLightEffect = prev.selectedLightEffect.slice();
    if (next.advanced === undefined && prev.advanced !== undefined) merged.advanced = prev.advanced;
    if (next.lightingMemory === undefined && prev.lightingMemory !== undefined) merged.lightingMemory = prev.lightingMemory;
    if (next.macroMetadata === undefined && prev.macroMetadata !== undefined) merged.macroMetadata = prev.macroMetadata;
    if (next.customParam === undefined && prev.customParam !== undefined) merged.customParam = prev.customParam;
    if (next.triggerTravel === undefined && prev.triggerTravel !== undefined) merged.triggerTravel = prev.triggerTravel;
    return merged;
  }

  function modifierMaskForHid(hid) {
    return MODIFIER_HID[hid] || 0;
  }

  function isModifierHid(hid) {
    return Boolean(MODIFIER_HID[hid]);
  }

  function emptyRecorder() {
    return { active: false, mask: 0, hid: 0, held: {} };
  }

  function recorderLabel(rec) {
    if (!rec) return '111';
    if (rec.active) return '112';
    if (rec.mask > 0 || rec.hid > 0) return '113';
    return '111';
  }

  function toggleRecorder(rec) {
    const next = Object.assign(emptyRecorder(), rec || {});
    next.active = !next.active;
    if (next.active) next.held = {};
    return next;
  }

  function applyRecorderKey(rec, hid, isDown) {
    const next = Object.assign(emptyRecorder(), rec || {}, { held: Object.assign({}, rec && rec.held) });
    if (!next.active || !Number.isInteger(hid) || hid <= 0) {
      return { rec: next, complete: null };
    }
    if (!isDown) {
      delete next.held[hid];
      next.mask = 0;
      const heldIds = Object.keys(next.held);
      for (let i = 0; i < heldIds.length; i++) {
        next.mask |= modifierMaskForHid(Number(heldIds[i]));
      }
      return { rec: next, complete: null };
    }
    if (next.held[hid]) return { rec: next, complete: null };
    next.held[hid] = true;
    if (isModifierHid(hid)) {
      next.mask = (next.mask || 0) | modifierMaskForHid(hid);
      return { rec: next, complete: null };
    }
    next.hid = hid;
    const tuple = { type: 16, code1: next.mask || 0, code2: hid };
    next.active = false;
    next.held = {};
    return { rec: next, complete: tuple };
  }

  function pauseRecorder(rec) {
    const next = Object.assign(emptyRecorder(), rec || {});
    next.active = false;
    next.held = {};
    return next;
  }

  const ADVANCED_LIST_CAP = 40;
  const BINDING_TEST_MAX = 100;
  const BINDING_TEST_EXPIRE_MS = 4000;
  const ADVANCED_LAYER_LABELS = ['Win', 'WinFn', 'Mac', 'MacFn'];
  const ADVANCED_KIND_ORDER = { cb: 0, mt: 1, socd: 2, tgl: 3 };

  function emptyCbKeyIndexList() {
    return [[], [], [], []];
  }

  function copyCbKeyIndexList(list) {
    const src = Array.isArray(list) ? list : [];
    const out = emptyCbKeyIndexList();
    for (let layer = 0; layer < 4; layer++) {
      const row = src[layer];
      out[layer] = Array.isArray(row)
        ? row.filter((slot) => Number.isInteger(slot) && slot >= 0 && slot <= 255)
        : [];
    }
    return out;
  }

  function cbSlotsSet(cbSlots) {
    if (cbSlots && typeof cbSlots.has === 'function') return cbSlots;
    if (Array.isArray(cbSlots)) return new Set(cbSlots.filter((slot) => Number.isInteger(slot)));
    return new Set();
  }

  function addCbIndex(list, layer, slot) {
    const next = copyCbKeyIndexList(list);
    if (!Number.isInteger(layer) || layer < 0 || layer > 3) return next;
    if (!Number.isInteger(slot) || slot < 0 || slot > 255) return next;
    if (!next[layer].includes(slot)) next[layer].push(slot);
    return next;
  }

  function removeCbIndexes(list, layer, slots) {
    const next = copyCbKeyIndexList(list);
    if (!Number.isInteger(layer) || layer < 0 || layer > 3) return next;
    const drop = new Set(Array.isArray(slots) ? slots : [slots]);
    next[layer] = next[layer].filter((slot) => !drop.has(slot));
    return next;
  }

  function advancedKindOf(tuple, cbSlots) {
    if (!tuple) return null;
    if (tuple.type === 146) return 'mt';
    if (tuple.type === 145) return 'tgl';
    if (tuple.type === 148) return 'socd';
    if (isMaybeCb(tuple) && cbSlotsSet(cbSlots).has(tuple.slot != null ? tuple.slot : tuple.index)) {
      return 'cb';
    }
    return null;
  }

  function advancedBindingId(kind, layer, slot, partnerSlot, reciprocal) {
    if (kind === 'socd' && reciprocal) {
      const a = Math.min(slot, partnerSlot);
      const b = Math.max(slot, partnerSlot);
      return `${kind}@${layer}@${a}-${b}`;
    }
    if (kind === 'socd') return `${kind}@${layer}@${slot}!malformed`;
    return `${kind}@${layer}@${slot}`;
  }

  function isReciprocalSocdBinding(layerMap, slot) {
    const current = tupleOf(layerMap && (layerMap[slot] || layerMap[String(slot)]));
    if (!current || current.type !== 148) return false;
    const partner = current.code2;
    if (!Number.isInteger(partner) || partner === slot) return false;
    const other = tupleOf(layerMap && (layerMap[partner] || layerMap[String(partner)]));
    return Boolean(other && other.type === 148 && other.code2 === slot);
  }

  function collectAdvancedBindings(layerMaps, cbSlotsForLayer, physicalSlots) {
    const items = [];
    const seen = new Set();
    const slots = physicalSlots && typeof physicalSlots[Symbol.iterator] === 'function'
      ? physicalSlots
      : null;
    for (let layer = 0; layer < 4; layer++) {
      const map = layerSlotMap(layerMaps, layer);
      const cbSlots = typeof cbSlotsForLayer === 'function' ? cbSlotsForLayer(layer) : cbSlotsForLayer;
      const walk = slots
        || Object.keys(map || {}).map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n));
      for (const slot of walk) {
        if (!Number.isInteger(slot)) continue;
        const current = tupleOf(map && (map[slot] || map[String(slot)]));
        if (!current) continue;
        const kind = advancedKindOf({ ...current, slot }, cbSlots);
        if (!kind) continue;
        const partnerSlot = kind === 'socd' ? current.code2 : null;
        const reciprocal = kind === 'socd' ? isReciprocalSocdBinding(map, slot) : true;
        const id = advancedBindingId(kind, layer, slot, partnerSlot, reciprocal);
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({
          id,
          kind,
          layer,
          slot,
          partnerSlot: Number.isInteger(partnerSlot) ? partnerSlot : null,
          reciprocal,
          malformed: kind === 'socd' && !reciprocal,
          type: current.type,
          code1: current.code1,
          code2: current.code2
        });
      }
    }
    items.sort((a, b) => {
      if (a.layer !== b.layer) return a.layer - b.layer;
      const ka = ADVANCED_KIND_ORDER[a.kind] != null ? ADVANCED_KIND_ORDER[a.kind] : 9;
      const kb = ADVANCED_KIND_ORDER[b.kind] != null ? ADVANCED_KIND_ORDER[b.kind] : 9;
      if (ka !== kb) return ka - kb;
      if (a.slot !== b.slot) return a.slot - b.slot;
      return (a.partnerSlot == null ? -1 : a.partnerSlot) - (b.partnerSlot == null ? -1 : b.partnerSlot);
    });
    return items;
  }

  function advancedResetUpdatesForLayer(layer, layerMap, defaults, cbSlots, physicalSlots) {
    const updates = [];
    const skipped = [];
    const socdSlots = [];
    const cbSlotsRemoved = [];
    const slots = physicalSlots && typeof physicalSlots[Symbol.iterator] === 'function'
      ? physicalSlots
      : Object.keys(layerMap || {}).map((s) => parseInt(s, 10));
    for (const slot of slots) {
      if (!Number.isInteger(slot)) continue;
      const current = tupleOf(layerMap && (layerMap[slot] || layerMap[String(slot)]));
      const kind = advancedKindOf({ ...(current || {}), slot }, cbSlots);
      if (!kind) {
        skipped.push(slot);
        continue;
      }
      const def = defaults && (defaults[slot] || defaults[String(slot)]);
      const defTuple = Array.isArray(def)
        ? { type: def[0], code1: def[1], code2: def[2] }
        : tupleOf(def);
      if (!defTuple) {
        return {
          ok: false,
          error: `Immutable default tuple unavailable for layer ${layer} slot ${slot}`,
          missingSlot: slot,
          layer,
          updates,
          skipped,
          socdSlots,
          cbSlotsRemoved
        };
      }
      if (kind === 'socd') socdSlots.push(slot);
      if (kind === 'cb') cbSlotsRemoved.push(slot);
      if (current && tuplesEqual(current, defTuple)) continue;
      updates.push({ slot, type: defTuple.type, code1: defTuple.code1, code2: defTuple.code2 });
    }
    return { ok: true, layer, updates, skipped, socdSlots, cbSlotsRemoved };
  }

  function isSomeAdvancedChanged(layerMaps, defaultLayers, cbSlots, physicalSlots) {
    for (let layer = 0; layer < 4; layer++) {
      const map = layerSlotMap(layerMaps, layer);
      const defaults = layerSlotMap(defaultLayers, layer);
      const slots = typeof cbSlots === 'function' ? cbSlots(layer) : cbSlots;
      const plan = advancedResetUpdatesForLayer(layer, map, defaults, slots, physicalSlots);
      if (plan.updates.length > 0 || plan.cbSlotsRemoved.length > 0 || plan.socdSlots.length > 0) {
        return true;
      }
    }
    return false;
  }

  function toBindingTestCode(event, toCodeInfo) {
    try {
      const info = typeof toCodeInfo === 'function' ? toCodeInfo(event) : null;
      if (info == null || info.keyCode == null) return null;
      return String(info.keyCode);
    } catch {
      if (!event || typeof event !== 'object') return null;
      const fallback = event.code || event.key;
      return fallback == null || fallback === '' ? null : String(fallback);
    }
  }

  function pushBindingTestEvent(list, code, now, max, ttl) {
    if (code == null || code === '') return Array.isArray(list) ? list.slice() : [];
    const cap = Number.isInteger(max) && max > 0 ? max : BINDING_TEST_MAX;
    const life = Number.isInteger(ttl) && ttl > 0 ? ttl : BINDING_TEST_EXPIRE_MS;
    const ts = Number.isFinite(now) ? now : 0;
    const next = [{ code: String(code), expiresAt: ts + life }].concat(Array.isArray(list) ? list : []);
    return next.slice(0, cap);
  }

  function pruneBindingTestEvents(list, now) {
    const ts = Number.isFinite(now) ? now : 0;
    return (Array.isArray(list) ? list : []).filter((item) => item && item.expiresAt > ts);
  }

  return {
    CLIP_KIND,
    CLIP_VERSION,
    DRAG_SOURCE,
    DEFINITE_ADVANCED,
    ORDINARY_TYPES,
    MODIFIER_HID,
    isPlainObject,
    tupleOf,
    tuplesEqual,
    isDefiniteAdvanced,
    isMaybeCb,
    isAdvancedBinding,
    isOrdinaryRemap,
    makeDragPayload,
    readDragPayload,
    isReferenceBinding,
    parseProfileIdentity,
    profileIdentity,
    sameProfile,
    sameMacroBank,
    bytesEqual,
    copyBytes,
    tableEntrySize,
    readTableEntryBytes,
    findMatchingTableIndex,
    parseMacroSnapshot,
    findMatchingMacroIndex,
    serializeClipboard,
    parseClipboard,
    collectTableRefs,
    canShareAdvanced,
    pasteBinding,
    identitySlotsFromParsed,
    summarizeMacroIdentities,
    plannedMatchesMacroRef,
    resolveExpectedMacroUpdates,
    createSaveGate,
    slotRevKey,
    bumpSlotRev,
    getSlotRev,
    captureSlotRevs,
    slotRevMatches,
    markSlotsPersisted,
    markRevSnapshotPersisted,
    hasUnpersistedSlotRevs,
    slotIsDirty,
    persistableTuple,
    applyPlannedIfCurrent,
    mergeLayerHydration,
    ownedSnapshotRevs,
    ownedSnapshotRevKeys,
    captureSlotRevKeys,
    mergeOwnedAdvancedBindings,
    unplannedAdvancedRevChanged,
    layersForLocalPersist,
    captureSaveIdentity,
    saveIdentityMatches,
    clearSlotRevs,
    cutBinding,
    copyBinding,
    resetUpdatesForLayer,
    isSomeKeyChanged,
    mergeLocalSnapshot,
    modifierMaskForHid,
    isModifierHid,
    emptyRecorder,
    recorderLabel,
    toggleRecorder,
    applyRecorderKey,
    pauseRecorder,
    ADVANCED_LIST_CAP,
    BINDING_TEST_MAX,
    BINDING_TEST_EXPIRE_MS,
    ADVANCED_LAYER_LABELS,
    emptyCbKeyIndexList,
    copyCbKeyIndexList,
    addCbIndex,
    removeCbIndexes,
    advancedKindOf,
    advancedBindingId,
    isReciprocalSocdBinding,
    collectAdvancedBindings,
    advancedResetUpdatesForLayer,
    isSomeAdvancedChanged,
    toBindingTestCode,
    pushBindingTestEvent,
    pruneBindingTestEvents
  };
});
