/**
 * Source-traced profile list transitions from hub module 78072:
 * tE local-to-onboard, tI onboard copy, tk onboard-to-local, tg delete, tL reorder.
 * Pure planners: no HID. Hardware execution lives in transport.
 */

const library = require('./profile-library.cjs');
const names = require('./profile-names.cjs');

function clampIndex(n, lo, hi) {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function neighborIndex(list, predicate, fromIndex, options = {}) {
  const firstLeft = options.firstLeft !== false;
  if (!Array.isArray(list) || list.length === 0) return -1;
  const a = clampIndex(fromIndex, 0, list.length - 1);
  const span = Math.max(list.length - 1 - a, a) + 1;
  const ok = (idx) => idx >= 0 && idx < list.length && predicate(list[idx], idx, list);
  for (let e = 0; e < span; e++) {
    const left = a - e;
    const right = a + e;
    const first = firstLeft ? left : right;
    const second = firstLeft ? right : left;
    if (ok(first)) return first;
    if (first !== second && ok(second)) return second;
  }
  return -1;
}

function deriveOrder(keyboardItems, previousOrder) {
  const prev = Array.isArray(previousOrder) && previousOrder.length === 4
    ? previousOrder.slice()
    : [0, 1, 2, 3];
  const used = keyboardItems.map((item) => item.profileIndex);
  return prev.slice().sort((a, b) => {
    const ia = used.indexOf(a);
    const ib = used.indexOf(b);
    return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
  });
}

function namesFromKeyboard(keyboardItems, length = 4) {
  const out = [];
  for (let i = 0; i < length; i++) {
    const hit = keyboardItems.find((item) => item.profileIndex === i);
    if (!hit) {
      out.push('');
      continue;
    }
    if (hit.storedName !== undefined && hit.storedName !== null) {
      out.push(hit.storedName);
    } else {
      out.push(hit.name || '');
    }
  }
  return out;
}

function assertMinOnboard(keyboardItems) {
  if (!keyboardItems.length) {
    return { valid: false, error: 'At least one onboard profile must remain' };
  }
  return { valid: true };
}

function findByKey(list, key) {
  const index = list.findIndex((item) => item.key === key);
  if (index < 0) return null;
  return { index, item: list[index] };
}

function existingNamesForNewLocal(list, exceptKey) {
  return (list || [])
    .filter((item) => item && item.key !== exceptKey)
    .map((item) => ({ name: item.name, key: item.key }));
}

function parkedLocalFromOnboard(fromItem, list, exceptKey, options = {}) {
  const original = (fromItem && (fromItem.storedName || fromItem.name)) || '';
  const allocated = names.allocateLocalName(original, existingNamesForNewLocal(list, exceptKey));
  if (!allocated.valid) return allocated;
  return {
    valid: true,
    item: {
      key: library.createKey(),
      type: library.LOCAL_TYPE,
      name: allocated.name,
      profileIndex: -1,
      extra: names.extraWithPreservedOriginal(fromItem && fromItem.extra, allocated),
      data: options.data !== undefined ? options.data : (fromItem && fromItem.data) || null,
      needsHardwareRead: options.needsHardwareRead !== undefined
        ? options.needsHardwareRead
        : !options.data && !(fromItem && fromItem.data)
    }
  };
}

function planLocalToOnboard(state, sourceKey, targetKey, options = {}) {
  const list = (state.list || []).slice();
  const source = findByKey(list, sourceKey);
  if (!source) return { valid: false, error: 'Source profile was not found' };
  if (source.item.type !== library.LOCAL_TYPE) {
    return { valid: false, error: 'Only a custom profile can be moved onto onboard' };
  }
  const order = (state.order || [0, 1, 2, 3]).slice();
  const length = Number.isInteger(state.length) ? state.length : 0;
  const maxKb = library.MAX_KEYBOARD_PROFILES;
  const activate = options.activate !== false;
  let targetSlot;
  let outgoing = null;
  if (targetKey) {
    const target = findByKey(list, targetKey);
    if (!target) return { valid: false, error: 'Onboard target was not found' };
    if (target.item.type !== library.KEYBOARD_TYPE) {
      return { valid: false, error: 'Target must be an onboard profile' };
    }
    targetSlot = target.item.profileIndex;
    outgoing = target.item;
  } else {
    if (length >= maxKb) {
      return { valid: false, error: 'No available onboard config slots on this device' };
    }
    targetSlot = order[length];
    if (!Number.isInteger(targetSlot)) {
      return { valid: false, error: 'No free onboard slot is available in profile order' };
    }
  }

  const next = list.slice();
  const keyboardItem = {
    key: library.onboardKey(targetSlot),
    type: library.KEYBOARD_TYPE,
    name: source.item.name,
    storedName: source.item.name,
    profileIndex: targetSlot,
    extra: { ...(source.item.extra || {}), confirmShareFailed: false },
    data: source.item.data
  };
  if (!outgoing) {
    next.splice(source.index, 1);
    next.push(keyboardItem);
  } else {
    const target = findByKey(next, targetKey);
    next[target.index] = keyboardItem;
    const parked = parkedLocalFromOnboard(outgoing, next, source.item.key, {
      data: options.outgoingData || outgoing.data || null,
      needsHardwareRead: !options.outgoingData
    });
    if (!parked.valid) return parked;
    next[source.index] = parked.item;
  }

  const keyboard = next.filter((item) => item.type === library.KEYBOARD_TYPE);
  const local = next.filter((item) => item.type === library.LOCAL_TYPE);
  const cap = library.checkCapacity(keyboard.length, local.length, 0);
  if (!cap.valid) return cap;
  const newOrder = deriveOrder(keyboard, order);
  return {
    valid: true,
    list: next,
    keyboard,
    local,
    targetSlot,
    activate: activate ? targetSlot : null,
    order: newOrder,
    length: keyboard.length,
    names: namesFromKeyboard(keyboard),
    writeProfile: { slot: targetSlot, data: source.item.data },
    preserveOutgoing: Boolean(outgoing),
    outgoingLocalKey: outgoing ? next[source.index].key : null
  };
}

function planOnboardCopy(state, sourceKey, targetKey, options = {}) {
  const list = (state.list || []).slice();
  const source = findByKey(list, sourceKey);
  const target = findByKey(list, targetKey);
  if (!source || !target) return { valid: false, error: 'Onboard profile was not found' };
  if (sourceKey === targetKey) return { valid: false, error: 'Cannot replace a profile with itself' };
  if (source.item.type !== library.KEYBOARD_TYPE || target.item.type !== library.KEYBOARD_TYPE) {
    return { valid: false, error: 'Onboard copy requires two onboard profiles' };
  }
  const onboardCount = list.filter((item) => item.type === library.KEYBOARD_TYPE).length;
  const localCount = list.filter((item) => item.type === library.LOCAL_TYPE).length;
  const cap = library.checkCapacity(onboardCount, localCount, 1);
  if (!cap.valid) return cap;
  const targetSlot = target.item.profileIndex;
  const parked = parkedLocalFromOnboard(target.item, list, target.item.key, {
    data: options.outgoingData || target.item.data || null,
    needsHardwareRead: !options.outgoingData
  });
  if (!parked.valid) return parked;
  const outgoingLocal = parked.item;
  const next = list.slice();
  next[target.index] = {
    key: library.onboardKey(targetSlot),
    type: library.KEYBOARD_TYPE,
    name: source.item.name,
    storedName: source.item.storedName !== undefined && source.item.storedName !== null
      ? source.item.storedName
      : source.item.name,
    profileIndex: targetSlot,
    extra: { ...(source.item.extra || {}), confirmShareFailed: false },
    data: options.sourceData || source.item.data
  };
  next.push(outgoingLocal);
  const keyboard = next.filter((item) => item.type === library.KEYBOARD_TYPE);
  const activate = options.activate !== false;
  return {
    valid: true,
    list: next,
    keyboard,
    local: next.filter((item) => item.type === library.LOCAL_TYPE),
    targetSlot,
    activate: activate ? targetSlot : null,
    order: deriveOrder(keyboard, state.order),
    length: keyboard.length,
    names: namesFromKeyboard(keyboard),
    writeProfile: { slot: targetSlot, data: options.sourceData || source.item.data },
    preserveOutgoing: true,
    outgoingLocalKey: outgoingLocal.key,
    preserveSourceSlot: source.item.profileIndex
  };
}

function planOnboardToLocal(state, sourceKey, localTargetKey) {
  if (localTargetKey) {
    return planLocalToOnboard(state, localTargetKey, sourceKey, { activate: false });
  }
  const list = (state.list || []).slice();
  const source = findByKey(list, sourceKey);
  if (!source) return { valid: false, error: 'Onboard profile was not found' };
  if (source.item.type !== library.KEYBOARD_TYPE) {
    return { valid: false, error: 'Only an onboard profile can be moved to custom storage' };
  }
  const next = list.slice();
  const parked = parkedLocalFromOnboard(source.item, list, source.item.key, {
    data: source.item.data || null,
    needsHardwareRead: !source.item.data
  });
  if (!parked.valid) return parked;
  next.splice(source.index, 1);
  const localItem = parked.item;
  next.push(localItem);
  const keyboard = next.filter((item) => item.type === library.KEYBOARD_TYPE);
  const min = assertMinOnboard(keyboard);
  if (!min.valid) return min;
  const cap = library.checkCapacity(keyboard.length, next.filter((i) => i.type === library.LOCAL_TYPE).length, 0);
  if (!cap.valid) return cap;
  return {
    valid: true,
    list: next,
    keyboard,
    local: next.filter((item) => item.type === library.LOCAL_TYPE),
    order: deriveOrder(keyboard, state.order),
    length: keyboard.length,
    names: namesFromKeyboard(keyboard),
    activate: null,
    outgoingLocalKey: localItem.key,
    removedSlot: source.item.profileIndex,
    preserveOutgoing: true,
    writeProfile: null
  };
}

function planDelete(state, keysToDelete) {
  const remove = new Set(Array.isArray(keysToDelete) ? keysToDelete : [keysToDelete]);
  const list = state.list || [];
  const targets = list.filter((item) => remove.has(item.key));
  if (!targets.length) return { valid: false, error: 'No profile to delete' };
  const remaining = list.filter((item) => !remove.has(item.key));
  const keyboard = remaining.filter((item) => item.type === library.KEYBOARD_TYPE);
  const min = assertMinOnboard(keyboard);
  if (!min.valid) return min;
  const activeIndex = state.activeIndex;
  const removedActive = targets.find((item) => item.type === library.KEYBOARD_TYPE && item.profileIndex === activeIndex);
  let nextActive = activeIndex;
  if (removedActive) {
    const from = list.findIndex((item) => item.key === removedActive.key);
    const ni = neighborIndex(
      list,
      (item) => item.type === library.KEYBOARD_TYPE && item.profileIndex >= 0 && item.key !== removedActive.key,
      from,
      { firstLeft: false }
    );
    if (ni < 0) return { valid: false, error: 'Deleting that onboard profile would leave none' };
    nextActive = list[ni].profileIndex;
  }
  return {
    valid: true,
    list: remaining,
    keyboard,
    local: remaining.filter((item) => item.type === library.LOCAL_TYPE),
    order: deriveOrder(keyboard, state.order),
    length: keyboard.length,
    names: namesFromKeyboard(keyboard),
    activate: removedActive ? nextActive : null,
    nextActiveIndex: nextActive,
    removedActive: Boolean(removedActive),
    writeProfile: null
  };
}

function planReorder(state, orderedKeys) {
  const list = (state.list || []).slice();
  const rank = new Map((orderedKeys || []).map((k, i) => [k, i]));
  list.sort((a, b) => {
    const ia = rank.has(a.key) ? rank.get(a.key) : 9999;
    const ib = rank.has(b.key) ? rank.get(b.key) : 9999;
    return ia - ib;
  });
  const keyboard = list.filter((item) => item.type === library.KEYBOARD_TYPE);
  return {
    valid: true,
    list,
    keyboard,
    local: list.filter((item) => item.type === library.LOCAL_TYPE),
    order: deriveOrder(keyboard, state.order),
    length: keyboard.length,
    names: namesFromKeyboard(keyboard),
    activate: null,
    writeProfile: null
  };
}

function listFromHardware(base, nameList, localItems, storedList) {
  const order = (base && base.profileOrder) || [0, 1, 2, 3];
  const length = (base && base.profileCount) || 0;
  const active = base && Number.isInteger(base.activeProfile) ? base.activeProfile : order[0];
  const namesArr = Array.isArray(nameList) ? nameList : names.displayNamesFromStored([], 4);
  const storedArr = Array.isArray(storedList) ? storedList : [];
  const list = [];
  for (let i = 0; i < length; i++) {
    const profileIndex = order[i];
    const stored = typeof storedArr[profileIndex] === 'string' ? storedArr[profileIndex] : '';
    list.push({
      key: library.onboardKey(profileIndex),
      type: library.KEYBOARD_TYPE,
      name: namesArr[profileIndex] || names.defaultOnboardName(profileIndex),
      storedName: stored,
      profileIndex,
      extra: { confirmShareFailed: false }
    });
  }
  for (const item of localItems || []) list.push(item);
  return {
    list,
    order,
    length,
    activeIndex: active
  };
}

module.exports = {
  neighborIndex,
  deriveOrder,
  namesFromKeyboard,
  planLocalToOnboard,
  planOnboardCopy,
  planOnboardToLocal,
  planDelete,
  planReorder,
  listFromHardware
};
