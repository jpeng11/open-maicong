/**
 * Performance autosave: per-field revisions, identity, and sparse patches.
 * Renderer owns the serialized worker; this helper is identity/patch only.
 * Vendor JS is never executed.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MaicongPerformanceAutosave = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const FIELDS = Object.freeze([
    'reporteRate', 'sleepTime', 'sleepMode', 'debounceLevel', 'macMode', 'lockWin'
  ]);
  const PASSTHROUGH = Object.freeze([
    'tickRate', 'reportRate24G', 'rollerType'
  ]);

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function isSupportedReportRate(rate) {
    return rate === 1 || rate === 2 || rate === 3 || rate === 4;
  }

  function sleepSliderThumbMinutes(sleepTime) {
    if (!Number.isFinite(sleepTime)) return 3;
    const rounded = Math.round(sleepTime / 2);
    return Math.max(1, Math.min(30, rounded < 1 ? 1 : rounded));
  }

  function formatSleepDurationLabel(sleepTime) {
    if (!Number.isFinite(sleepTime)) return '—';
    const seconds = sleepTime * 30;
    if (seconds < 60) {
      if (seconds === 0) return '0 min';
      return `${seconds} s`;
    }
    const minutes = seconds / 60;
    if (Number.isInteger(minutes)) return `${minutes} min`;
    const tenths = Math.round(minutes * 10) / 10;
    return `${tenths} min`;
  }

  function formatSleepLabel(sleepTime, neverSleep) {
    if (neverSleep) return '0 min';
    return formatSleepDurationLabel(sleepTime);
  }

  function shouldCommitSleep(minutes, settings) {
    const src = settings && typeof settings === 'object' ? settings : {};
    if (src.sleepMode === 1) return true;
    return minutes !== sleepSliderThumbMinutes(src.sleepTime);
  }

  function sleepCommitPatch(minutes, settings) {
    const mins = Number.isInteger(minutes) ? minutes : parseInt(minutes, 10);
    return {
      sleepTime: mins * 2,
      sleepMode: 0
    };
  }

  function neverSleepPatch(enabled) {
    return { sleepMode: enabled ? 1 : 0 };
  }

  function macModePatch(enableMac) {
    if (enableMac) return { macMode: 2, lockWin: false };
    return { macMode: 0 };
  }

  function comboPatch(enabled) {
    return { debounceLevel: enabled ? 7 : 0 };
  }

  function bumpFieldRev(store, field) {
    const next = (store[field] || 0) + 1;
    store[field] = next;
    return next;
  }

  function getFieldRev(store, field) {
    return (store && store[field]) || 0;
  }

  function captureFieldRevs(store, fields) {
    const captured = {};
    const list = Array.isArray(fields) ? fields : Object.keys(fields || {});
    for (const field of list) {
      if (!FIELDS.includes(field)) continue;
      captured[field] = getFieldRev(store, field);
    }
    return captured;
  }

  function fieldRevMatches(store, captured, field) {
    if (!captured || !Object.prototype.hasOwnProperty.call(captured, field)) return false;
    return getFieldRev(store, field) === captured[field];
  }

  function markFieldsPersisted(persisted, captured, store) {
    if (!captured || !persisted) return;
    for (const field of Object.keys(captured)) {
      if (getFieldRev(store, field) === captured[field]) persisted[field] = captured[field];
    }
  }

  function hasUnpersistedFieldRevs(store, persisted) {
    const keys = new Set([...Object.keys(store || {}), ...Object.keys(persisted || {})]);
    for (const key of keys) {
      if ((store[key] || 0) !== (persisted[key] || 0)) return true;
    }
    return false;
  }

  function fieldIsDirty(store, persisted, field) {
    return getFieldRev(store, field) !== ((persisted && persisted[field]) || 0);
  }

  function clearFieldRevs(store, persisted) {
    Object.keys(store || {}).forEach((key) => { delete store[key]; });
    Object.keys(persisted || {}).forEach((key) => { delete persisted[key]; });
  }

  function profileIdentity(source) {
    if (!source || typeof source !== 'object') return null;
    if (source.kind === 'local') return { kind: 'local', key: source.key };
    if (source.kind === 'onboard') return { kind: 'onboard', profileIndex: source.profileIndex };
    return { kind: source.kind };
  }

  function sameProfile(a, b) {
    if (!a || !b) return false;
    if (a.kind !== b.kind) return false;
    if (a.kind === 'local') return a.key === b.key;
    if (a.kind === 'onboard') return a.profileIndex === b.profileIndex;
    return true;
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
    if (current.connected === false) return false;
    if (captured.gen !== current.gen) return false;
    if (captured.resetEpoch !== current.resetEpoch) return false;
    if (captured.profile !== undefined && captured.profile !== current.profile) return false;
    if (captured.source) return sameProfile(captured.source, current.source);
    return true;
  }

  function identitySnapshot(state) {
    const src = state && typeof state === 'object' ? state : {};
    return {
      gen: src.editGeneration,
      resetEpoch: src.resetEpoch,
      profile: src.editingProfile,
      connected: Boolean(src.connected),
      source: profileIdentity(src.editSource)
    };
  }

  function identityMatches(captured, state) {
    if (!captured || !state) return false;
    return saveIdentityMatches(captured, {
      gen: state.editGeneration,
      resetEpoch: state.resetEpoch,
      profile: state.editingProfile,
      connected: Boolean(state.connected),
      source: profileIdentity(state.editSource)
    });
  }

  function markEdited(edited, fields) {
    const next = Object.assign({}, edited && typeof edited === 'object' ? edited : {});
    for (const key of Object.keys(fields || {})) {
      if (FIELDS.includes(key)) next[key] = true;
    }
    return next;
  }

  function hasDirty(edited) {
    return Boolean(edited && typeof edited === 'object' && Object.keys(edited).length > 0);
  }

  function valuesMatch(field, a, b) {
    if (field === 'lockWin') return Boolean(a) === Boolean(b);
    if (field === 'sleepMode') return (a ? 1 : 0) === (b ? 1 : 0);
    if (field === 'macMode') return (Number(a) & 3) === (Number(b) & 3);
    return a === b;
  }

  function normalizePatchValue(field, value) {
    if (field === 'lockWin') return Boolean(value);
    if (field === 'sleepMode') return value ? 1 : 0;
    if (field === 'macMode') return (Number(value) & 3) === 2 ? 2 : 0;
    return value;
  }

  function buildPatch(edited, settings, capturedRevs, store) {
    const marks = edited && typeof edited === 'object' ? edited : {};
    const src = settings && typeof settings === 'object' ? settings : {};
    const patch = {};
    for (const field of FIELDS) {
      if (!marks[field]) continue;
      if (capturedRevs && !fieldRevMatches(store, capturedRevs, field)) continue;
      if (field === 'reporteRate' && !isSupportedReportRate(src.reporteRate)) continue;
      if (src[field] === undefined) continue;
      patch[field] = normalizePatchValue(field, src[field]);
    }
    return patch;
  }

  function applyPatchIfCurrent(settings, patch, store, captured) {
    if (!settings || !patch) return [];
    const applied = [];
    for (const field of Object.keys(patch)) {
      if (!fieldRevMatches(store, captured, field)) continue;
      settings[field] = patch[field];
      applied.push(field);
    }
    return applied;
  }

  function settleEdited(edited, sentPatch, currentSettings, capturedRevs, store) {
    const next = Object.assign({}, edited && typeof edited === 'object' ? edited : {});
    const lighting = currentSettings && typeof currentSettings === 'object' ? currentSettings : {};
    for (const key of Object.keys(sentPatch || {})) {
      if (capturedRevs && !fieldRevMatches(store, capturedRevs, key)) continue;
      if (valuesMatch(key, lighting[key], sentPatch[key])) delete next[key];
    }
    return next;
  }

  function settingsForLocalPersist(current, previous, store, persisted, ownedRevs) {
    const cur = current && typeof current === 'object' ? current : {};
    const prev = previous && typeof previous === 'object' ? previous : {};
    const out = {};
    for (const field of PASSTHROUGH) {
      if (cur[field] !== undefined) out[field] = cur[field];
      else if (prev[field] !== undefined) out[field] = prev[field];
    }
    for (const field of FIELDS) {
      const owned = Boolean(ownedRevs) && fieldRevMatches(store, ownedRevs, field);
      const dirty = fieldIsDirty(store, persisted, field);
      if (owned || !dirty) {
        if (cur[field] !== undefined) out[field] = cur[field];
        else if (prev[field] !== undefined) out[field] = prev[field];
      } else if (prev[field] !== undefined) {
        out[field] = prev[field];
      }
    }
    return out;
  }

  function desiredMatchesDevice(patch, device) {
    const sent = patch && typeof patch === 'object' ? patch : {};
    const src = device && typeof device === 'object' ? device : {};
    for (const key of Object.keys(sent)) {
      if (!valuesMatch(key, src[key], sent[key])) return false;
    }
    return true;
  }

  function ownedFieldRevs(store, captured) {
    const out = {};
    if (!captured) return out;
    for (const field of Object.keys(captured)) {
      if (!fieldRevMatches(store, captured, field)) continue;
      out[field] = captured[field];
    }
    return out;
  }

  function ownedSentRevs(store, captured, send) {
    const out = {};
    if (!send || !captured) return out;
    for (const field of Object.keys(send)) {
      if (!fieldRevMatches(store, captured, field)) continue;
      out[field] = captured[field];
    }
    return out;
  }

  function hasNewerFieldRevs(store, snapshotRevs) {
    const keys = new Set([
      ...Object.keys(store || {}),
      ...Object.keys(snapshotRevs || {})
    ]);
    for (const key of keys) {
      if (!FIELDS.includes(key)) continue;
      if (getFieldRev(store, key) !== getFieldRev(snapshotRevs, key)) return true;
    }
    return false;
  }

  function mergeReadSettings(current, incoming, store, snapshotRevs) {
    const cur = current && typeof current === 'object' ? current : {};
    const src = incoming && typeof incoming === 'object' ? incoming : {};
    const out = Object.assign({}, cur);
    const applied = [];
    const skipped = [];
    const seen = new Set();
    const keys = [...FIELDS, ...PASSTHROUGH, ...Object.keys(src)];
    for (const field of keys) {
      if (seen.has(field)) continue;
      seen.add(field);
      if (src[field] === undefined) continue;
      if (FIELDS.includes(field) && getFieldRev(store, field) !== getFieldRev(snapshotRevs, field)) {
        skipped.push(field);
        continue;
      }
      out[field] = src[field];
      applied.push(field);
    }
    return { settings: out, applied, skipped };
  }

  function clearAppliedFieldState(store, persisted, edited, errors, applied) {
    const list = Array.isArray(applied) ? applied : [];
    for (const field of list) {
      if (!FIELDS.includes(field)) continue;
      if (store) delete store[field];
      if (persisted) delete persisted[field];
      if (edited) delete edited[field];
      if (errors) delete errors[field];
    }
  }

  function markFieldErrors(errors, captured, store, message) {
    const next = Object.assign({}, errors && typeof errors === 'object' ? errors : {});
    if (!captured || !message) return next;
    for (const field of Object.keys(captured)) {
      if (!FIELDS.includes(field)) continue;
      if (!fieldRevMatches(store, captured, field)) continue;
      next[field] = message;
    }
    return next;
  }

  function clearFieldErrors(errors, captured, store) {
    const next = Object.assign({}, errors && typeof errors === 'object' ? errors : {});
    if (!captured) return next;
    for (const field of Object.keys(captured)) {
      if (store && !fieldRevMatches(store, captured, field)) continue;
      delete next[field];
    }
    return next;
  }

  function remainingFieldErrors(errors, store, persisted) {
    const next = {};
    const src = errors && typeof errors === 'object' ? errors : {};
    for (const field of Object.keys(src)) {
      if (fieldIsDirty(store, persisted, field)) next[field] = src[field];
    }
    return next;
  }

  function firstFieldError(errors) {
    if (!errors || typeof errors !== 'object') return null;
    for (const field of FIELDS) {
      if (errors[field]) return errors[field];
    }
    const keys = Object.keys(errors);
    return keys.length ? errors[keys[0]] : null;
  }

  function computeSaveStatus(pending, hasError, dirty) {
    const n = Number(pending) || 0;
    if (n > 0) return 'saving';
    if (hasError) return 'error';
    if (dirty) return 'unsaved';
    return 'saved';
  }

  return {
    FIELDS,
    PASSTHROUGH,
    isSupportedReportRate,
    sleepSliderThumbMinutes,
    formatSleepDurationLabel,
    formatSleepLabel,
    shouldCommitSleep,
    sleepCommitPatch,
    neverSleepPatch,
    macModePatch,
    comboPatch,
    bumpFieldRev,
    getFieldRev,
    captureFieldRevs,
    fieldRevMatches,
    markFieldsPersisted,
    hasUnpersistedFieldRevs,
    fieldIsDirty,
    clearFieldRevs,
    captureSaveIdentity,
    saveIdentityMatches,
    identitySnapshot,
    identityMatches,
    markEdited,
    hasDirty,
    buildPatch,
    applyPatchIfCurrent,
    settleEdited,
    settingsForLocalPersist,
    desiredMatchesDevice,
    ownedFieldRevs,
    ownedSentRevs,
    hasNewerFieldRevs,
    mergeReadSettings,
    clearAppliedFieldState,
    markFieldErrors,
    clearFieldErrors,
    remainingFieldErrors,
    firstFieldError,
    computeSaveStatus,
    normalizePatchValue
  };
});
