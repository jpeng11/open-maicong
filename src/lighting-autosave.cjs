/**
 * Lighting autosave revisions: desired vs confirmed dirty fields.
 * Renderer owns the serialized worker; this helper is identity/patch only.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MaicongLightingAutosave = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const COALESCE_MS = 80;
  const CONTINUOUS_FIELDS = new Set([
    'brightness',
    'speed',
    'hexColor',
    'sideBrightness',
    'sideSpeed',
    'sideHexColor'
  ]);

  function isContinuousOnly(fields) {
    const keys = Object.keys(fields || {});
    if (keys.length === 0) return false;
    return keys.every((k) => CONTINUOUS_FIELDS.has(k));
  }

  function coalesceDelay(fields) {
    return isContinuousOnly(fields) ? COALESCE_MS : 0;
  }

  function coalesceWait(fields, now, lastFlushAt, coalesceMs = COALESCE_MS) {
    if (!isContinuousOnly(fields)) return 0;
    const last = Number(lastFlushAt) || 0;
    if (!last) return coalesceMs;
    const elapsed = Number(now) - last;
    if (!Number.isFinite(elapsed) || elapsed >= coalesceMs) return 0;
    return coalesceMs - elapsed;
  }

  function desiredMatchesDevice(patch, deviceLighting) {
    const sent = patch && typeof patch === 'object' ? patch : {};
    const device = deviceLighting && typeof deviceLighting === 'object' ? deviceLighting : {};
    for (const key of Object.keys(sent)) {
      if (key === 'direction') {
        if ((device.direction ? 1 : 0) !== (sent.direction ? 1 : 0)) return false;
        continue;
      }
      if (sent[key] !== device[key]) return false;
    }
    return true;
  }

  function markEdited(edited, fields) {
    const next = Object.assign({}, edited && typeof edited === 'object' ? edited : {});
    for (const key of Object.keys(fields || {})) next[key] = true;
    return next;
  }

  function valuesMatch(a, b) {
    return a === b;
  }

  function settleEdited(edited, sentPatch, currentLighting) {
    const next = Object.assign({}, edited && typeof edited === 'object' ? edited : {});
    const lighting = currentLighting && typeof currentLighting === 'object' ? currentLighting : {};
    for (const key of Object.keys(sentPatch || {})) {
      if (valuesMatch(lighting[key], sentPatch[key])) delete next[key];
    }
    return next;
  }

  function identitySnapshot(state) {
    const src = state && typeof state === 'object' ? state : {};
    return {
      gen: src.editGeneration,
      resetEpoch: src.resetEpoch,
      profile: src.editingProfile,
      connected: Boolean(src.connected)
    };
  }

  function identityMatches(captured, state) {
    if (!captured || !state) return false;
    if (!state.connected) return false;
    return captured.gen === state.editGeneration
      && captured.resetEpoch === state.resetEpoch
      && captured.profile === state.editingProfile
      && captured.connected === Boolean(state.connected);
  }

  function buildPatch(edited, lighting, findMainEffect, findSideEffect) {
    const marks = edited && typeof edited === 'object' ? edited : {};
    const src = lighting && typeof lighting === 'object' ? lighting : {};
    const patch = {};
    const mainKnown = typeof findMainEffect === 'function' ? Boolean(findMainEffect(src.effect)) : true;
    const sideKnown = typeof findSideEffect === 'function' ? Boolean(findSideEffect(src.sideEffect)) : true;
    if (marks.effect && mainKnown) patch.effect = src.effect;
    if (marks.brightness && Number.isInteger(src.brightness)) patch.brightness = src.brightness;
    if (marks.speed && Number.isInteger(src.speed)) patch.speed = src.speed;
    if (marks.direction) patch.direction = src.direction ? 1 : 0;
    if (marks.customColorDisabled) patch.customColorDisabled = Boolean(src.customColorDisabled);
    if (marks.hexColor) patch.hexColor = src.hexColor;
    if (marks.sideEffect && sideKnown) patch.sideEffect = src.sideEffect;
    if (marks.sideBrightness && Number.isInteger(src.sideBrightness)) patch.sideBrightness = src.sideBrightness;
    if (marks.sideSpeed && Number.isInteger(src.sideSpeed)) patch.sideSpeed = src.sideSpeed;
    if (marks.sideCustomColorDisabled) patch.sideCustomColorDisabled = Boolean(src.sideCustomColorDisabled);
    if (marks.sideHexColor) patch.sideHexColor = src.sideHexColor;
    return patch;
  }

  function hasDirty(edited) {
    return Boolean(edited && typeof edited === 'object' && Object.keys(edited).length > 0);
  }

  return {
    COALESCE_MS,
    CONTINUOUS_FIELDS,
    isContinuousOnly,
    coalesceDelay,
    coalesceWait,
    desiredMatchesDevice,
    markEdited,
    settleEdited,
    identitySnapshot,
    identityMatches,
    buildPatch,
    hasDirty
  };
});
