/**
 * Macro editor draft helpers (hub tC / t_ recording semantics).
 * CMD 12/13 stores combined { action, code, delay } 4-byte items.
 * Names / defaultDelay / enableDefaultDelay are local extended storage, not firmware.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MaicongMacroDraft = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MIN_DELAY = 5;
  const MAX_DELAY = 65535;
  const PARSE_FALLBACK = 50;
  const SHARED_MACRO_SIZE = 8192;
  const HEADER_BYTES = 68;
  const ACTION_BYTES = 4;
  const MAX_SLOTS = 16;
  const NAME_MAX = 64;
  const META_VERSION = 1;
  const UI_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'LABEL']);

  /** DOM MouseEvent.button → hub table J macro codes (chunk 2233 module 94222). */
  const DOM_BUTTON_TO_MACRO = { 0: 1, 1: 4, 2: 2, 3: 8, 4: 16 };
  const MACRO_MOUSE_BUTTONS = [
    { code: 1, label: 'Left Button' },
    { code: 2, label: 'Right Button' },
    { code: 4, label: 'Middle Button' },
    { code: 16, label: 'Forward Button' },
    { code: 8, label: 'Back Button' }
  ];

  /**
   * DOM KeyboardEvent.code to USB HID Usage Page 0x07 Mapping.
   * Derived from vendor chunk 2233 module 94222 capture table.
   * Excludes media entries which are explicitly macroDisabled.
   */
  const DOM_KEY_TO_HID = {
    Digit1: 30, Digit2: 31, Digit3: 32, Digit4: 33, Digit5: 34,
    Digit6: 35, Digit7: 36, Digit8: 37, Digit9: 38, Digit0: 39,
    KeyA: 4, KeyB: 5, KeyC: 6, KeyD: 7, KeyE: 8, KeyF: 9, KeyG: 10, KeyH: 11,
    KeyI: 12, KeyJ: 13, KeyK: 14, KeyL: 15, KeyM: 16, KeyN: 17, KeyO: 18,
    KeyP: 19, KeyQ: 20, KeyR: 21, KeyS: 22, KeyT: 23, KeyU: 24, KeyV: 25,
    KeyW: 26, KeyX: 27, KeyY: 28, KeyZ: 29,
    Comma: 54, Period: 55, Semicolon: 51, Quote: 52, BracketLeft: 47, BracketRight: 48,
    Backquote: 53, Slash: 56, Backspace: 42, Backslash: 49, Minus: 45, Equal: 46,
    IntlRo: 135, IntlYen: 137,
    AltLeft: 226, AltRight: 230,
    CapsLock: 57,
    ControlLeft: 224, ControlRight: 228,
    MetaLeft: 227, MetaRight: 231,
    OSLeft: 227, OSRight: 231,
    ShiftLeft: 225, ShiftRight: 229,
    ContextMenu: 101, Apps: 101,
    Enter: 40, Space: 44, Tab: 43,
    Delete: 76, End: 77,
    Help: 117,
    Home: 74, Insert: 73, PageDown: 78, PageUp: 75,
    ArrowDown: 81, ArrowLeft: 80, ArrowRight: 79, ArrowUp: 82,
    Escape: 41, PrintScreen: 70, ScrollLock: 71, Pause: 72,
    F1: 58, F2: 59, F3: 60, F4: 61, F5: 62, F6: 63,
    F7: 64, F8: 65, F9: 66, F10: 67, F11: 68, F12: 69,
    F13: 104, F14: 105, F15: 106, F16: 107, F17: 108, F18: 109,
    F19: 110, F20: 111, F21: 112, F22: 113, F23: 114, F24: 115,
    NumLock: 83,
    Numpad0: 98, Numpad1: 89, Numpad2: 90, Numpad3: 91, Numpad4: 92,
    Numpad5: 93, Numpad6: 94, Numpad7: 95, Numpad8: 96, Numpad9: 97,
    NumpadAdd: 87, NumpadComma: 54, NumpadDecimal: 99, NumpadDivide: 84,
    NumpadEnter: 88, NumpadEqual: 103, NumpadMultiply: 85, NumpadSubtract: 86
  };

  function parseDelayNumber(value) {
    const n = parseInt(value === undefined || value === null ? '' : String(value), 10);
    return n !== n ? PARSE_FALLBACK : n;
  }

  function clampMacroDelay(value, minBound) {
    const min = minBound === undefined || minBound === null ? MIN_DELAY : minBound;
    const n = parseDelayNumber(value);
    if (n < min) return min;
    if (n > MAX_DELAY) return MAX_DELAY;
    return n;
  }

  function recordedDelay(opts) {
    const enable = Boolean(opts && opts.enableDefaultDelay);
    const now = opts && typeof opts.now === 'number' ? opts.now : 0;
    const last = opts && typeof opts.lastEventTime === 'number' ? opts.lastEventTime : now;
    if (enable) return clampMacroDelay(opts.defaultDelay);
    return clampMacroDelay(now - last);
  }

  /**
   * t_ emits time then the new action; serializer en pairs an action with the
   * FOLLOWING time. Stamp the previous action with this interval, then append
   * the new event with delay 0 (encode uses FL-1 when no follower exists).
   */
  function applyTrailingRecordedEvent(actions, spec) {
    if (!Array.isArray(actions) || !spec) return { lastEventTime: spec && spec.now };
    const now = spec.now;
    if (actions.length > 0 && typeof spec.lastEventTime === 'number') {
      actions[actions.length - 1].delay = recordedDelay({
        enableDefaultDelay: spec.enableDefaultDelay,
        defaultDelay: spec.defaultDelay,
        now,
        lastEventTime: spec.lastEventTime
      });
    }
    actions.push({
      action: spec.action,
      code: spec.code,
      delay: 0
    });
    return { lastEventTime: now };
  }

  function isUiControlTarget(target) {
    let el = target;
    if (el && el.nodeType === 3) el = el.parentElement;
    while (el && el !== el.document && el !== el.window) {
      const tag = el.tagName;
      if (tag && UI_TAGS.has(tag)) return true;
      if (el.getAttribute && el.getAttribute('data-skip-macro-record') !== null) return true;
      el = el.parentElement;
    }
    return false;
  }

  function shouldIgnoreRecordEvent(event, opts) {
    if (!opts || !opts.recording) return true;
    if (!opts.focused) return true;
    if (event && event.repeat) return true;
    if (event && isUiControlTarget(event.target)) return true;
    return false;
  }

  function totalActionCount(slots) {
    if (!Array.isArray(slots)) return 0;
    let n = 0;
    for (let i = 0; i < slots.length; i++) {
      const acts = slots[i] && slots[i].actions;
      if (Array.isArray(acts)) n += acts.length;
    }
    return n;
  }

  function capacityBytes(actionCount) {
    return HEADER_BYTES + ACTION_BYTES * actionCount;
  }

  function maxActionCount() {
    return Math.floor((SHARED_MACRO_SIZE - HEADER_BYTES) / ACTION_BYTES);
  }

  /**
   * Encodes an action into 4-byte wire representation with delay normalization.
   */
  function encodeMacroAction(act, isEnd = false) {
    const delay = Math.max(MIN_DELAY - 1, (act && act.delay) || 0);
    const delayLo = delay & 0xFF;
    const delayHi = (delay >> 8) & 0xFF;

    let kind = 2; // Default: Standard HID
    let codeByte = (act && act.code) || 0;

    if (act && act.code >= 224 && act.code <= 231) {
      kind = 1; // Modifier
      codeByte = 1 << (act.code & 15);
    } else if (act && (act.action === 'mousedown' || act.action === 'mouseup')) {
      kind = 3; // Mouse
    }

    const isDown = Boolean(act && (act.action === 'keydown' || act.action === 'mousedown'));
    const flags = (kind & 63) | (isDown ? 64 : 0) | (isEnd ? 128 : 0);

    return [delayLo, delayHi, flags, codeByte];
  }

  /**
   * Generates a unique normalized hex representation of an action body.
   * delay 0..4 is normalized to 4, modifier codes bitmasked, terminator flag on last action.
   */
  function getNormalizedBodyKey(actions) {
    if (!Array.isArray(actions) || actions.length === 0) return '';
    const len = actions.length;
    const parts = new Array(len);
    for (let i = 0; i < len; i++) {
      const isEnd = (i === len - 1);
      const [b0, b1, b2, b3] = encodeMacroAction(actions[i], isEnd);
      parts[i] = (
        (b0 < 16 ? '0' : '') + b0.toString(16) +
        (b1 < 16 ? '0' : '') + b1.toString(16) +
        (b2 < 16 ? '0' : '') + b2.toString(16) +
        (b3 < 16 ? '0' : '') + b3.toString(16)
      );
    }
    return parts.join('');
  }

  /**
   * Computes the total byte footprint of the 16-slot macro bank with vendor-identical deduplication.
   */
  function calculateMacroBankBytes(slots) {
    if (!Array.isArray(slots)) return HEADER_BYTES;
    const seenBodies = new Set();
    let totalBytes = HEADER_BYTES; // 68 bytes (64-byte header + 4-byte empty marker)
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const actions = s && Array.isArray(s.actions) ? s.actions : [];
      if (actions.length === 0) continue;
      const key = getNormalizedBodyKey(actions);
      if (!seenBodies.has(key)) {
        seenBodies.add(key);
        totalBytes += actions.length * ACTION_BYTES;
      }
    }
    return totalBytes;
  }

  /**
   * Prospective bank-state check.
   * Tests if assigning candidateActions to slots[slotIndex] with extraReservedCount pending releases
   * fits within SHARED_MACRO_SIZE (8192 bytes).
   *
   * When extraReservedCount > 0, pending future releases reserve a distinct active body against
   * unique other bodies without fabricating dummy actions (avoiding collision with valid imported
   * macros and delay arithmetic wrapping > 65535).
   *
   * When extraReservedCount === 0, prospective deduplicated bank state is evaluated directly.
   */
  function canMutateSlot(slots, slotIndex, candidateActions, extraReservedCount = 0) {
    if (!Array.isArray(slots)) return false;
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || (slots.length > 0 && slotIndex >= slots.length)) {
      return false;
    }
    const targetActions = Array.isArray(candidateActions) ? candidateActions : [];
    const reserveCount = Math.max(0, Number.isInteger(extraReservedCount) ? extraReservedCount : 0);

    if (reserveCount > 0) {
      // Pending future releases reserve a distinct active body against unique other bodies.
      const seenOtherBodies = new Set();
      let otherBytes = 0;
      for (let i = 0; i < slots.length; i++) {
        if (i === slotIndex) continue;
        const s = slots[i];
        const acts = s && Array.isArray(s.actions) ? s.actions : [];
        if (acts.length === 0) continue;
        const key = getNormalizedBodyKey(acts);
        if (!seenOtherBodies.has(key)) {
          seenOtherBodies.add(key);
          otherBytes += acts.length * ACTION_BYTES;
        }
      }
      const targetActionCount = targetActions.length + reserveCount;
      const targetBytes = targetActionCount * ACTION_BYTES;
      const totalBytes = HEADER_BYTES + otherBytes + targetBytes;
      return totalBytes <= SHARED_MACRO_SIZE;
    }

    const prospectiveSlots = new Array(slots.length);
    for (let i = 0; i < slots.length; i++) {
      if (i === slotIndex) {
        prospectiveSlots[i] = { actions: targetActions };
      } else {
        prospectiveSlots[i] = slots[i];
      }
    }
    const bytes = calculateMacroBankBytes(prospectiveSlots);
    return bytes <= SHARED_MACRO_SIZE;
  }

  function canAddActions(slots, addCount = 1, slotIndex = 0) {
    if (!Array.isArray(slots)) return false;
    const targetSlot = slots[slotIndex] || { actions: [] };
    const currentActions = Array.isArray(targetSlot.actions) ? targetSlot.actions : [];
    const count = Math.max(0, Number.isInteger(addCount) ? addCount : 1);
    return canMutateSlot(slots, slotIndex, currentActions, count);
  }

  function canRecordDown(slots, heldCount = 0, slotIndex = 0) {
    if (!Array.isArray(slots)) return false;
    const targetSlot = slots[slotIndex] || { actions: [] };
    const currentActions = Array.isArray(targetSlot.actions) ? targetSlot.actions : [];
    const held = Math.max(0, Number.isInteger(heldCount) ? heldCount : 0);
    return canMutateSlot(slots, slotIndex, currentActions, held + 2);
  }

  function canFlushHeld(slots, heldCount = 0, slotIndex = 0) {
    if (!Array.isArray(slots)) return false;
    const targetSlot = slots[slotIndex] || { actions: [] };
    const currentActions = Array.isArray(targetSlot.actions) ? targetSlot.actions : [];
    const held = Math.max(0, Number.isInteger(heldCount) ? heldCount : 0);
    return canMutateSlot(slots, slotIndex, currentActions, held);
  }

  function deepCopyActions(actions) {
    if (!Array.isArray(actions)) return [];
    const out = [];
    for (let i = 0; i < actions.length; i++) {
      const act = actions[i];
      if (!act || typeof act !== 'object') continue;
      out.push({
        action: act.action,
        code: act.code,
        delay: act.delay
      });
    }
    return out;
  }

  function heldCount(pressed) {
    if (!pressed || typeof pressed !== 'object') return 0;
    let n = 0;
    for (const k of Object.keys(pressed)) {
      if (pressed[k]) n += 1;
    }
    return n;
  }

  function pressKey(code) {
    return `k:${code}`;
  }

  function pressMouse(code) {
    return `m:${code}`;
  }

  function flushHeldInputs(pressed) {
    const out = [];
    if (!pressed || typeof pressed !== 'object') return out;
    for (const key of Object.keys(pressed)) {
      if (!pressed[key]) continue;
      const sep = key.indexOf(':');
      if (sep < 0) continue;
      const kind = key.slice(0, sep);
      const code = parseInt(key.slice(sep + 1), 10);
      if (!Number.isInteger(code)) continue;
      out.push({
        action: kind === 'm' ? 'mouseup' : 'keyup',
        code,
        delay: 0
      });
    }
    return out;
  }

  function emptySlots() {
    const slots = [];
    for (let i = 0; i < MAX_SLOTS; i++) {
      slots.push({ id: i, name: `Macro ${i + 1}`, type: 0, actions: [] });
    }
    return slots;
  }

  function isMacroKeyboardItem(item) {
    if (!item || typeof item !== 'object') return false;
    // Allowlist: only standard keyboard items (type 16 or undefined)
    if (item.type !== undefined && item.type !== 16) return false;
    // Exclude chord tuples (type 16 with both code1 > 0 and code2 > 0)
    if (item.code1 > 0 && item.code2 > 0) return false;
    const code = item.code !== undefined ? item.code : (item.code2 || item.code1);
    if (!Number.isInteger(code) || code < 4 || code === 255) return false;
    if (code > 231) return false;
    return true;
  }

  function mouseCodeFromDomButton(button) {
    if (!Object.prototype.hasOwnProperty.call(DOM_BUTTON_TO_MACRO, button)) return null;
    return DOM_BUTTON_TO_MACRO[button];
  }

  /**
   * Validates and constructs action(s) from UI dropdown selections.
   * Honors keypress pair behavior (keydown + keyup), validates mouse vs keyboard palette.
   */
  function buildMacroActionsFromSelection(spec) {
    if (!spec || typeof spec !== 'object') {
      return { valid: false, error: 'Invalid action parameters.' };
    }
    const actionType = spec.actionType || spec.action;
    const code = spec.code;
    const delay = clampMacroDelay(spec.delay !== undefined ? spec.delay : 20);

    if (actionType === 'mousedown' || actionType === 'mouseup') {
      const validMouse = MACRO_MOUSE_BUTTONS.some((b) => b.code === code);
      if (!validMouse) {
        return { valid: false, error: 'Invalid mouse button selected.' };
      }
      return {
        valid: true,
        actions: [{ action: actionType, code, delay }]
      };
    }

    if (actionType === 'keydown' || actionType === 'keyup') {
      if (!isMacroKeyboardItem({ code })) {
        return { valid: false, error: 'Invalid keyboard key selected.' };
      }
      return {
        valid: true,
        actions: [{ action: actionType, code, delay }]
      };
    }

    if (actionType === 'keypress') {
      if (!isMacroKeyboardItem({ code })) {
        return { valid: false, error: 'Invalid keyboard key selected.' };
      }
      return {
        valid: true,
        actions: [
          { action: 'keydown', code, delay },
          { action: 'keyup', code, delay: MIN_DELAY }
        ]
      };
    }

    return { valid: false, error: 'Invalid action type.' };
  }

  function replaceActionAtIndex(actions, index, spec) {
    if (!Array.isArray(actions) || !Number.isInteger(index) || index < 0 || index >= actions.length) {
      return null;
    }
    const target = actions[index];
    if (!target || typeof target !== 'object' || !spec || typeof spec !== 'object') return null;
    const actionType = spec.actionType || spec.action;
    const code = spec.code;
    if (!Number.isInteger(code)) return null;

    let newKind = actionType;
    if (actionType === 'keypress') {
      newKind = (target.action === 'keyup' || target.action === 'keydown') ? target.action : 'keydown';
    }

    if (newKind === 'mousedown' || newKind === 'mouseup') {
      const validMouse = MACRO_MOUSE_BUTTONS.some((b) => b.code === code);
      if (!validMouse) return null;
    } else if (newKind === 'keydown' || newKind === 'keyup') {
      if (!isMacroKeyboardItem({ code })) return null;
    } else {
      return null;
    }

    const replaced = {
      action: newKind,
      code,
      delay: target.delay
    };
    actions[index] = replaced;
    return replaced;
  }

  function mouseLabel(code) {
    const hit = MACRO_MOUSE_BUTTONS.find((b) => b.code === code);
    return hit ? hit.label : `Mouse ${code}`;
  }

  function sanitizeName(name) {
    if (typeof name !== 'string') return '';
    return name.length > NAME_MAX ? name.slice(0, NAME_MAX) : name;
  }

  function defaultSlotMeta() {
    return { name: '', defaultDelay: PARSE_FALLBACK, enableDefaultDelay: true };
  }

  function defaultMetadata() {
    const slots = [];
    for (let i = 0; i < MAX_SLOTS; i++) slots.push(defaultSlotMeta());
    return { version: META_VERSION, slots };
  }

  function sanitizeSlotMeta(raw) {
    const d = defaultSlotMeta();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return d;
    d.name = sanitizeName(raw.name);
    if (raw.defaultDelay !== undefined) d.defaultDelay = clampMacroDelay(raw.defaultDelay);
    if (typeof raw.enableDefaultDelay === 'boolean') d.enableDefaultDelay = raw.enableDefaultDelay;
    return d;
  }

  function parseStoredMetadata(raw) {
    let data = raw;
    if (typeof raw === 'string') {
      try {
        data = JSON.parse(raw);
      } catch {
        return { meta: defaultMetadata(), recovered: true };
      }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { meta: defaultMetadata(), recovered: true };
    }
    const src = Array.isArray(data.slots) ? data.slots : [];
    const slots = [];
    for (let i = 0; i < MAX_SLOTS; i++) {
      slots.push(sanitizeSlotMeta(src[i]));
    }
    const recovered = src.length !== MAX_SLOTS || data.version !== META_VERSION;
    return { meta: { version: META_VERSION, slots }, recovered };
  }

  function serializeMetadata(meta) {
    const parsed = parseStoredMetadata(meta);
    const slots = parsed.meta.slots.map((s) => ({
      name: s.name,
      defaultDelay: s.defaultDelay,
      enableDefaultDelay: s.enableDefaultDelay
    }));
    return JSON.stringify({ version: META_VERSION, slots });
  }

  function hardwareMacroSlots(slots) {
    if (!Array.isArray(slots)) return [];
    return slots.map((s, i) => ({
      id: Number.isInteger(s.id) ? s.id : i,
      name: typeof s.name === 'string' ? sanitizeName(s.name) : undefined,
      type: s.type,
      actions: deepCopyActions(s.actions)
    }));
  }

  return {
    MIN_DELAY,
    MAX_DELAY,
    PARSE_FALLBACK,
    SHARED_MACRO_SIZE,
    HEADER_BYTES,
    ACTION_BYTES,
    MAX_SLOTS,
    NAME_MAX,
    META_VERSION,
    DOM_BUTTON_TO_MACRO,
    MACRO_MOUSE_BUTTONS,
    parseDelayNumber,
    clampMacroDelay,
    recordedDelay,
    applyTrailingRecordedEvent,
    isUiControlTarget,
    shouldIgnoreRecordEvent,
    totalActionCount,
    capacityBytes,
    maxActionCount,
    canAddActions,
    canRecordDown,
    canFlushHeld,
    deepCopyActions,
    heldCount,
    pressKey,
    pressMouse,
    flushHeldInputs,
    emptySlots,
    isMacroKeyboardItem,
    mouseCodeFromDomButton,
    mouseLabel,
    sanitizeName,
    defaultSlotMeta,
    defaultMetadata,
    parseStoredMetadata,
    serializeMetadata,
    hardwareMacroSlots,
    DOM_KEY_TO_HID,
    replaceActionAtIndex,
    encodeMacroAction,
    getNormalizedBodyKey,
    calculateMacroBankBytes,
    canMutateSlot,
    buildMacroActionsFromSelection
  };
});
