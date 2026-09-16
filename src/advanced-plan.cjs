/**
 * Pure G75 mechanical advanced-binding planner.
 * Shared by HID transport and local-preview (zero HID) apply/clear.
 * Vendor JS is never executed.
 */
const protocol = require('./protocol.cjs');
const keyConfig = require('./key-config.cjs');
const {
  validateAdvancedBinding,
  validateClearAllAdvanced
} = require('./schema-validators.cjs');
const { getDefaultTuple, getComplementPriority } = require('./layout-g75v2.cjs');

function asSizedBuffer(raw, size, options = {}) {
  const allowEmpty = Boolean(options.allowEmpty);
  if (raw == null || raw === '') {
    return allowEmpty ? Buffer.alloc(size, 0) : null;
  }
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    if (raw.length !== size) return null;
    return Buffer.from(raw);
  }
  if (typeof raw === 'string') {
    if (raw.length % 2 !== 0) return null;
    const buf = Buffer.from(raw, 'hex');
    if (buf.length !== size) return null;
    return buf;
  }
  if (typeof raw.length === 'number') {
    if (raw.length !== size) return null;
    const out = Buffer.alloc(size, 0);
    for (let i = 0; i < size; i++) out[i] = raw[i] & 255;
    return out;
  }
  return null;
}

function resolveDefaultTuple(defaultLayers, layer, slot) {
  const buf = defaultLayers && defaultLayers[layer];
  if (buf && Number.isInteger(slot) && slot >= 0 && (slot * 3 + 2) < buf.length) {
    return [buf[slot * 3], buf[slot * 3 + 1], buf[slot * 3 + 2]];
  }
  return getDefaultTuple(layer, slot);
}

function isDefiniteAdvancedTuple(tuple) {
  return Boolean(tuple && tuple[0] >= 144 && tuple[0] <= 149);
}

function isListedCbTuple(tuple, slot, cbSlots) {
  return Boolean(
    tuple
    && tuple[0] === protocol.KEY_TYPES.STANDARD
    && tuple[1] > 0
    && tuple[2] > 0
    && cbSlots
    && cbSlots.has(slot)
  );
}

function cbListsEqual(a, b) {
  const left = keyConfig.copyCbKeyIndexList(a);
  const right = keyConfig.copyCbKeyIndexList(b);
  return JSON.stringify(left) === JSON.stringify(right);
}

function planApplyAdvancedBinding({
  spec,
  layerBuffers,
  mtBuf,
  tglBuf,
  extrasBuf,
  customBuf,
  defaultLayers,
  allowEmptyTables
}) {
  const val = validateAdvancedBinding(spec);
  if (!val.valid) {
    return { ok: false, error: `Invalid advanced binding: ${val.error}` };
  }
  const layer = spec.layer;
  const slot = spec.slot;
  if (!Array.isArray(layerBuffers) || layerBuffers.length !== 4) {
    return { ok: false, error: 'Advanced plan requires 4 layer buffers' };
  }
  const allowEmpty = Boolean(allowEmptyTables);
  const mt = asSizedBuffer(mtBuf, protocol.MT_TABLE_SIZE, { allowEmpty });
  const tgl = asSizedBuffer(tglBuf, protocol.TGL_TABLE_SIZE, { allowEmpty });
  const extras = asSizedBuffer(extrasBuf, protocol.KEY_EXTRAS_SIZE, { allowEmpty });
  const custom = asSizedBuffer(customBuf, protocol.CB_CUSTOM_PARAM_LENGTH, { allowEmpty });
  if (!mt || !tgl || !extras || !custom) {
    return { ok: false, error: 'Advanced tables or customParam region are incomplete' };
  }

  const parsedCustom = protocol.parseCbCustomParam(custom);
  const wouldMutateCustom = spec.kind === 'cb';
  if (!parsedCustom.ok && wouldMutateCustom) {
    return { ok: false, error: `Malformed advanced customParam: ${parsedCustom.error}` };
  }

  const layerBufs = layerBuffers.map((buf) => Buffer.from(buf));
  const targetLayer = layerBufs[layer];
  const current = protocol.readSlotTuple(targetLayer, slot);
  const incomingPartnerCurrent = (spec.kind === 'socd')
    ? protocol.readSlotTuple(targetLayer, spec.partnerSlot)
    : null;

  const plannedBindings = [];
  let plannedMt = null;
  let plannedTgl = null;
  let plannedExtras = null;
  let plannedCustom = null;
  const listedCb = new Set((parsedCustom.ok && parsedCustom.cbKeyIndexList[layer]) || []);
  const currentIsCb = parsedCustom.ok && isListedCbTuple(current, slot, listedCb);

  const restoreSlotToDefault = (lyr, sl) => {
    const def = resolveDefaultTuple(defaultLayers, lyr, sl);
    plannedBindings.push({ layer: lyr, slot: sl, type: def[0], code1: def[1], code2: def[2] });
    const off = sl * 3;
    layerBufs[lyr][off] = def[0];
    layerBufs[lyr][off + 1] = def[1];
    layerBufs[lyr][off + 2] = def[2];
  };

  const currentIsSocd = current && current[0] === protocol.KEY_TYPES.SOCD;
  const currentSocdReciprocal = currentIsSocd && protocol.isReciprocalSocd(targetLayer, slot);

  try {
    if (currentIsSocd && (spec.kind === 'remove' || spec.kind !== 'socd' || spec.partnerSlot !== current[2])) {
      if (!currentSocdReciprocal) {
        return {
          ok: false,
          error: `SOCD slot ${slot} partner ${current[2]} is missing, out of bounds, or not reciprocal. Refusing to mutate an unrelated key. Remap the malformed slot directly or repair the pair first.`
        };
      }
    }

    const plannedClears = [{ layer, slot }];
    if (currentIsSocd && currentSocdReciprocal && (spec.kind === 'remove' || spec.kind !== 'socd' || spec.partnerSlot !== current[2])) {
      plannedClears.push({ layer, slot: current[2] });
      restoreSlotToDefault(layer, current[2]);
    }
    if (spec.kind === 'socd' && incomingPartnerCurrent && incomingPartnerCurrent[0] === protocol.KEY_TYPES.SOCD) {
      if (incomingPartnerCurrent[2] !== slot) {
        return { ok: false, error: `Partner slot ${spec.partnerSlot} already belongs to a different SOCD pair with slot ${incomingPartnerCurrent[2]}. Remove that pair in Advanced first.` };
      }
      plannedClears.push({ layer, slot: spec.partnerSlot });
    } else if (spec.kind === 'socd') {
      plannedClears.push({ layer, slot: spec.partnerSlot });
    }

    const remainingRefs = protocol.referencesAfterClearing(layerBuffers, plannedClears);

    if (spec.kind === 'remove') {
      restoreSlotToDefault(layer, slot);
    } else if (spec.kind === 'mt') {
      const delayMs = spec.delayMs === undefined ? 150 : Math.floor(spec.delayMs / 10) * 10;
      const delaySteps = delayMs / 10;
      let tableIndex = null;
      const currentMtIndex = current && current[0] === protocol.KEY_TYPES.MT ? current[1] : null;
      if (currentMtIndex !== null && !remainingRefs.mt.has(currentMtIndex)) {
        tableIndex = currentMtIndex;
      } else {
        const free = protocol.allocateFreeIndices(remainingRefs.mt, 1);
        if (!free) {
          return { ok: false, error: 'No free MT table entries remain (32/32 referenced across all 4 layers)' };
        }
        tableIndex = free[0];
      }
      plannedMt = protocol.preserveReservedTail(
        protocol.serializeMtTable([{
          index: tableIndex,
          rawTap: val.tapKey,
          rawHold: val.holdKey
        }], mt),
        mt,
        protocol.MT_RESERVED_OFFSET
      );
      plannedBindings.push({ layer, slot, type: 146, code1: tableIndex, code2: delaySteps });
    } else if (spec.kind === 'tgl') {
      let tableIndex = null;
      const currentTglIndex = current && current[0] === protocol.KEY_TYPES.TGL ? current[1] : null;
      if (currentTglIndex !== null && !remainingRefs.tgl.has(currentTglIndex)) {
        tableIndex = currentTglIndex;
      } else {
        const free = protocol.allocateFreeIndices(remainingRefs.tgl, 1);
        if (!free) {
          return { ok: false, error: 'No free TGL table entries remain (32/32 referenced across all 4 layers)' };
        }
        tableIndex = free[0];
      }
      plannedTgl = protocol.preserveReservedTail(
        protocol.serializeTglTable([{
          index: tableIndex,
          rawTarget: val.targetKey
        }], tgl),
        tgl,
        protocol.TGL_RESERVED_OFFSET
      );
      plannedBindings.push({ layer, slot, type: 145, code1: tableIndex, code2: 0 });
    } else if (spec.kind === 'socd') {
      const partnerSlot = spec.partnerSlot;
      const free = protocol.allocateFreeIndices(remainingRefs.mt, 2);
      if (!free) {
        return { ok: false, error: 'No free MT table entries remain for an SOCD pair (need 2 unreferenced entries across all 4 layers)' };
      }
      const firstIdx = free[0];
      const secondIdx = free[1];
      const defA = resolveDefaultTuple(defaultLayers, layer, slot);
      const defB = resolveDefaultTuple(defaultLayers, layer, partnerSlot);
      plannedMt = protocol.preserveReservedTail(
        protocol.serializeMtTable([
          { index: firstIdx, rawTap: defA, rawHold: defB },
          { index: secondIdx, rawTap: defB, rawHold: defA }
        ], mt),
        mt,
        protocol.MT_RESERVED_OFFSET
      );
      plannedBindings.push({ layer, slot, type: 148, code1: firstIdx, code2: partnerSlot });
      plannedBindings.push({ layer, slot: partnerSlot, type: 148, code1: secondIdx, code2: slot });
    } else if (spec.kind === 'cb') {
      plannedBindings.push({
        layer,
        slot,
        type: val.tuple[0],
        code1: val.tuple[1],
        code2: val.tuple[2]
      });
    }

    const tearingDownSocd = currentIsSocd && currentSocdReciprocal
      && (spec.kind === 'remove' || spec.kind !== 'socd' || spec.partnerSlot !== current[2]);
    let extrasNext = Buffer.from(extras);
    let extrasDirty = false;
    if (tearingDownSocd) {
      extrasNext = protocol.mutateKeyExtrasPriority(extrasNext, slot, 0);
      extrasNext = protocol.mutateKeyExtrasPriority(extrasNext, current[2], 0);
      extrasDirty = true;
    }
    if (spec.kind === 'socd') {
      extrasNext = protocol.mutateKeyExtrasPriority(extrasNext, slot, spec.priority);
      extrasNext = protocol.mutateKeyExtrasPriority(extrasNext, spec.partnerSlot, getComplementPriority(spec.priority));
      extrasDirty = true;
    }
    if (extrasDirty && !protocol.buffersEqual(extrasNext, extras)) plannedExtras = extrasNext;

    if (parsedCustom.ok) {
      let nextCbList = keyConfig.copyCbKeyIndexList(parsedCustom.cbKeyIndexList);
      if (spec.kind === 'cb') {
        nextCbList = keyConfig.addCbIndex(nextCbList, layer, slot);
      } else if (currentIsCb) {
        nextCbList = keyConfig.removeCbIndexes(nextCbList, layer, [slot]);
      }
      if (!cbListsEqual(nextCbList, parsedCustom.cbKeyIndexList)) {
        plannedCustom = protocol.serializeCbCustomParam({
          ...parsedCustom,
          cbKeyIndexList: nextCbList
        }, custom);
      }
    } else if (currentIsCb || spec.kind === 'cb') {
      return { ok: false, error: `Malformed advanced customParam: ${parsedCustom.error}` };
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }

  const lastBySlot = new Map();
  for (const b of plannedBindings) lastBySlot.set(`${b.layer}:${b.slot}`, b);
  const byLayer = new Map();
  for (const b of lastBySlot.values()) {
    if (!byLayer.has(b.layer)) byLayer.set(b.layer, []);
    byLayer.get(b.layer).push(b);
    const off = b.slot * 3;
    layerBufs[b.layer][off] = b.type;
    layerBufs[b.layer][off + 1] = b.code1;
    layerBufs[b.layer][off + 2] = b.code2;
  }

  return {
    ok: true,
    plannedBindings: Array.from(lastBySlot.values()),
    byLayer,
    plannedMt,
    plannedTgl,
    plannedExtras,
    plannedCustom,
    layerBuffers: layerBufs,
    customParam: parsedCustom,
    mt: plannedMt || mt,
    tgl: plannedTgl || tgl,
    extras: plannedExtras || extras,
    custom: plannedCustom || custom
  };
}

function planClearAllAdvanced({
  layerBuffers,
  extrasBuf,
  customBuf,
  defaultLayers,
  allowEmptyTables
}) {
  const allowEmpty = Boolean(allowEmptyTables);
  const extras = asSizedBuffer(extrasBuf, protocol.KEY_EXTRAS_SIZE, { allowEmpty });
  const custom = asSizedBuffer(customBuf, protocol.CB_CUSTOM_PARAM_LENGTH, { allowEmpty });
  if (!Array.isArray(layerBuffers) || layerBuffers.length !== 4 || !extras || !custom) {
    return { ok: false, error: 'Clear-all plan requires 4 complete layer buffers, extras, and customParam' };
  }
  const parsedCustom = protocol.parseCbCustomParam(custom);
  if (!parsedCustom.ok) {
    return {
      ok: false,
      error: `Cannot clear all advanced keys: customParam CB membership is malformed (${parsedCustom.error}). Refusing to report success while unknown combo bindings may remain.`,
      customValid: false
    };
  }
  const layerBufs = layerBuffers.map((buf) => Buffer.from(buf));
  let extrasNext = Buffer.from(extras);
  let extrasChanged = false;
  let nextCbList = parsedCustom.ok
    ? keyConfig.copyCbKeyIndexList(parsedCustom.cbKeyIndexList)
    : keyConfig.emptyCbKeyIndexList();
  const plannedByLayer = new Map();
  const slotCount = Math.floor(protocol.USED_KEY_AREA_SIZE / 3);

  try {
    for (let lyr = 0; lyr < 4; lyr++) {
      const buf = layerBufs[lyr];
      const listedCb = new Set((parsedCustom.ok && nextCbList[lyr]) || []);
      const updates = [];
      const cbRemoved = [];
      for (let sl = 0; sl < slotCount; sl++) {
        const current = protocol.readSlotTuple(buf, sl);
        if (!current) continue;
        const isAdv = isDefiniteAdvancedTuple(current) || isListedCbTuple(current, sl, listedCb);
        if (!isAdv) continue;
        let def;
        try {
          def = resolveDefaultTuple(defaultLayers, lyr, sl);
        } catch (err) {
          return {
            ok: false,
            error: `Immutable default tuple unavailable for layer ${lyr} slot ${sl}: ${err.message}`
          };
        }
        if (current[0] === protocol.KEY_TYPES.SOCD) {
          extrasNext = protocol.mutateKeyExtrasPriority(extrasNext, sl, 0);
          extrasChanged = true;
        }
        if (isListedCbTuple(current, sl, listedCb)) cbRemoved.push(sl);
        if (current[0] === def[0] && current[1] === def[1] && current[2] === def[2]) continue;
        updates.push({ slot: sl, type: def[0], code1: def[1], code2: def[2] });
        const off = sl * 3;
        buf[off] = def[0];
        buf[off + 1] = def[1];
        buf[off + 2] = def[2];
      }
      if (cbRemoved.length) nextCbList = keyConfig.removeCbIndexes(nextCbList, lyr, cbRemoved);
      if (updates.length) plannedByLayer.set(lyr, updates);
    }

    let plannedCustom = null;
    if (parsedCustom.ok && !cbListsEqual(nextCbList, parsedCustom.cbKeyIndexList)) {
      plannedCustom = protocol.serializeCbCustomParam({
        ...parsedCustom,
        cbKeyIndexList: nextCbList
      }, custom);
    }

    const plannedExtras = extrasChanged && !protocol.buffersEqual(extrasNext, extras) ? extrasNext : null;
    return {
      ok: true,
      plannedByLayer,
      plannedExtras,
      plannedCustom,
      layerBuffers: layerBufs,
      extras: plannedExtras || extras,
      custom: plannedCustom || custom,
      customParam: parsedCustom,
      nextCbList
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function layerMapsToBuffers(layerMaps, defaultLayers) {
  const layers = [];
  for (let l = 0; l < 4; l++) {
    const buf = Buffer.alloc(protocol.USED_KEY_AREA_SIZE, 0);
    const map = (layerMaps && (layerMaps[l] || layerMaps[String(l)])) || {};
    const defBuf = defaultLayers && defaultLayers[l];
    if (defBuf && defBuf.length >= protocol.USED_KEY_AREA_SIZE) {
      Buffer.from(defBuf).copy(buf, 0, 0, protocol.USED_KEY_AREA_SIZE);
    }
    for (const raw of Object.keys(map)) {
      const slot = Number(raw);
      if (!Number.isInteger(slot) || slot < 0 || slot * 3 + 2 >= buf.length) continue;
      const t = map[slot] || map[raw];
      if (!t) continue;
      if (Array.isArray(t) && t.length >= 3) {
        buf[slot * 3] = t[0];
        buf[slot * 3 + 1] = t[1];
        buf[slot * 3 + 2] = t[2];
      } else if (t && typeof t === 'object') {
        buf[slot * 3] = t.type & 255;
        buf[slot * 3 + 1] = t.code1 & 255;
        buf[slot * 3 + 2] = t.code2 & 255;
      }
    }
    layers.push(buf);
  }
  return layers;
}

function applyBindingsToLayerMaps(layerMaps, bindings) {
  const next = {
    0: Object.assign({}, layerMaps && (layerMaps[0] || layerMaps['0'])),
    1: Object.assign({}, layerMaps && (layerMaps[1] || layerMaps['1'])),
    2: Object.assign({}, layerMaps && (layerMaps[2] || layerMaps['2'])),
    3: Object.assign({}, layerMaps && (layerMaps[3] || layerMaps['3']))
  };
  for (const b of bindings || []) {
    if (!next[b.layer]) next[b.layer] = {};
    next[b.layer][b.slot] = {
      slot: b.slot,
      type: b.type,
      code1: b.code1,
      code2: b.code2,
      code: b.code2 || b.code1
    };
  }
  return next;
}

function applyLayerUpdateMap(layerMaps, plannedByLayer) {
  const next = applyBindingsToLayerMaps(layerMaps, []);
  for (const [lyr, updates] of plannedByLayer.entries()) {
    if (!next[lyr]) next[lyr] = {};
    for (const u of updates) {
      next[lyr][u.slot] = {
        slot: u.slot,
        type: u.type,
        code1: u.code1,
        code2: u.code2,
        code: u.code2 || u.code1
      };
    }
  }
  return next;
}

function snapshotFromPlan(snapshot, plan, extraBindings) {
  const layers = extraBindings
    ? applyBindingsToLayerMaps(snapshot.layers, extraBindings)
    : applyLayerUpdateMap(snapshot.layers, plan.plannedByLayer || new Map());
  const parsed = protocol.parseCbCustomParam(plan.custom);
  return {
    layers,
    advanced: {
      mt: (plan.mt || asSizedBuffer(snapshot.advanced && snapshot.advanced.mt, protocol.MT_TABLE_SIZE)).toString('hex'),
      tgl: (plan.tgl || asSizedBuffer(snapshot.advanced && snapshot.advanced.tgl, protocol.TGL_TABLE_SIZE)).toString('hex'),
      keyExtras: plan.extras.toString('hex'),
      customParam: plan.custom.toString('hex')
    },
    customParam: {
      cbKeyIndexList: parsed.ok ? parsed.cbKeyIndexList : keyConfig.copyCbKeyIndexList(
        snapshot.customParam && snapshot.customParam.cbKeyIndexList
      ),
      raw: plan.custom.toString('hex')
    }
  };
}

function applyAdvancedToLocalSnapshot(snapshot, spec, defaultLayers) {
  const layers = layerMapsToBuffers(snapshot.layers, defaultLayers);
  const plan = planApplyAdvancedBinding({
    spec,
    layerBuffers: layers,
    mtBuf: snapshot.advanced && snapshot.advanced.mt,
    tglBuf: snapshot.advanced && snapshot.advanced.tgl,
    extrasBuf: snapshot.advanced && snapshot.advanced.keyExtras,
    customBuf: snapshot.customParamRaw
      || (snapshot.customParam && snapshot.customParam.raw)
      || (snapshot.advanced && snapshot.advanced.customParam),
    defaultLayers,
    allowEmptyTables: true
  });
  if (!plan.ok) {
    return { success: false, error: plan.error, hardwareWrites: 0 };
  }
  const out = snapshotFromPlan(snapshot, plan, plan.plannedBindings);
  return {
    success: true,
    hardwareWrites: 0,
    ...out,
    plannedBindings: plan.plannedBindings,
    changedSlots: (plan.plannedBindings || []).map((b) => ({ layer: b.layer, slot: b.slot })),
    mt: protocol.parseMtTable(plan.mt),
    tgl: protocol.parseTglTable(plan.tgl),
    keyExtras: protocol.parseKeyExtras(plan.extras),
    raw: out.advanced,
    references: (() => {
      const refs = protocol.collectAdvancedReferences(plan.layerBuffers);
      return { mt: Array.from(refs.mt), tgl: Array.from(refs.tgl) };
    })()
  };
}

function clearAllAdvancedOnLocalSnapshot(snapshot, defaultLayers) {
  const layers = layerMapsToBuffers(snapshot.layers, defaultLayers);
  const plan = planClearAllAdvanced({
    layerBuffers: layers,
    extrasBuf: snapshot.advanced && snapshot.advanced.keyExtras,
    customBuf: snapshot.customParamRaw
      || (snapshot.customParam && snapshot.customParam.raw)
      || (snapshot.advanced && snapshot.advanced.customParam),
    defaultLayers,
    allowEmptyTables: true
  });
  if (!plan.ok) {
    return { success: false, error: plan.error, hardwareWrites: 0 };
  }
  const out = snapshotFromPlan(snapshot, plan, null);
  const changedSlots = [];
  for (const [lyr, updates] of (plan.plannedByLayer || new Map()).entries()) {
    for (const u of updates) changedSlots.push({ layer: Number(lyr), slot: u.slot });
  }
  return {
    success: true,
    hardwareWrites: 0,
    factoryReset: false,
    changedSlots,
    ...out,
    mt: snapshot.advanced && snapshot.advanced.mt
      ? protocol.parseMtTable(asSizedBuffer(snapshot.advanced.mt, protocol.MT_TABLE_SIZE))
      : undefined,
    tgl: snapshot.advanced && snapshot.advanced.tgl
      ? protocol.parseTglTable(asSizedBuffer(snapshot.advanced.tgl, protocol.TGL_TABLE_SIZE))
      : undefined,
    keyExtras: protocol.parseKeyExtras(plan.extras),
    raw: out.advanced,
    nextCbList: plan.nextCbList
  };
}

module.exports = {
  asSizedBuffer,
  resolveDefaultTuple,
  planApplyAdvancedBinding,
  planClearAllAdvanced,
  layerMapsToBuffers,
  applyBindingsToLayerMaps,
  applyLayerUpdateMap,
  applyAdvancedToLocalSnapshot,
  clearAllAdvancedOnLocalSnapshot,
  validateAdvancedBinding,
  validateClearAllAdvanced
};
