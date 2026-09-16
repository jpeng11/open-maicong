/**
 * Local extended-storage for G75 macro names and standard-delay preferences.
 * Not firmware CMD 12/13. See docs/MACRO_METADATA.md.
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const draft = require('./macro-draft.js');

function metadataPath() {
  return path.join(app.getPath('userData'), 'macro-metadata.json');
}

function loadMacroMetadata(customPath = null) {
  try {
    const file = customPath || metadataPath();
    const raw = fs.readFileSync(file, 'utf8');
    return draft.parseStoredMetadata(raw);
  } catch {
    return { meta: draft.defaultMetadata(), recovered: true };
  }
}

function saveMacroMetadata(meta, customPath = null) {
  const parsed = draft.parseStoredMetadata(meta);
  const target = customPath || metadataPath();
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.macro-metadata-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmp, draft.serializeMetadata(parsed.meta), 'utf8');
    fs.renameSync(tmp, target);
    return parsed.meta;
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // ignore tmp cleanup error
    }
    throw err;
  }
}

/**
 * Local macro names/default-delay preferences are one global bank, not per profile.
 * Full-device reset may clear them only after a confirmed reset. Active-profile reset
 * must not wipe shared metadata without evidence that firmware isolated those names.
 */
function applyConfirmedResetMetadata(scope, options = {}) {
  if (scope !== 'all') {
    return {
      attempted: false,
      cleared: false,
      skipped: true,
      reason: 'Macro metadata is one global bank shared by all profiles. Active-profile reset does not clear local names or default-delay preferences.'
    };
  }
  const meta = draft.defaultMetadata();
  try {
    if (typeof options.save === 'function') {
      options.save(meta, options.path);
    } else {
      saveMacroMetadata(meta, options.path || null);
    }
    return { attempted: true, cleared: true, meta };
  } catch (err) {
    return {
      attempted: true,
      cleared: false,
      error: err.message || String(err)
    };
  }
}

/**
 * Attach local metadata cleanup to a confirmed hardware reset result.
 * Disk failure does not retract hardware success or encourage another reset.
 */
function attachConfirmedResetMetadata(resetResult, scope, options = {}) {
  if (!resetResult || !resetResult.success) return resetResult;
  resetResult.hardwareStatus = 'confirmed';
  const metaRes = applyConfirmedResetMetadata(scope, options);
  resetResult.metadataCleared = Boolean(metaRes.cleared);
  resetResult.metadataSkipped = Boolean(metaRes.skipped);
  if (metaRes.reason) resetResult.metadataReason = metaRes.reason;
  if (metaRes.error) {
    resetResult.metadataError = metaRes.error;
    resetResult.metadataCleared = false;
    resetResult.localCleanup = 'failed';
    resetResult.localCleanupHint = 'Saved macro names on this computer could not be cleared. You can rename them here.';
  } else if (metaRes.cleared) {
    resetResult.localCleanup = 'cleared';
  } else if (metaRes.skipped) {
    resetResult.localCleanup = 'skipped';
  }
  return resetResult;
}

function overlayExportMacros(macros, meta) {
  const parsed = draft.parseStoredMetadata(meta);
  const slots = parsed.meta.slots;
  if (!Array.isArray(macros)) return { macros: [], macroMetadata: { version: 1, slots } };
  const out = macros.map((m, i) => {
    const name = slots[i] && typeof slots[i].name === 'string' ? slots[i].name : (m && m.name);
    return { ...m, name };
  });
  return { macros: out, macroMetadata: { version: 1, slots } };
}

module.exports = {
  metadataPath,
  loadMacroMetadata,
  saveMacroMetadata,
  applyConfirmedResetMetadata,
  attachConfirmedResetMetadata,
  overlayExportMacros
};
