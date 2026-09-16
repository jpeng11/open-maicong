const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const autosave = require('../src/performance-autosave.cjs');

describe('Performance autosave revision helper', () => {
  test('supported G75 rates are 4/3/2/1 and unknown nibbles are omitted from patches', () => {
    assert.equal(autosave.isSupportedReportRate(4), true);
    assert.equal(autosave.isSupportedReportRate(3), true);
    assert.equal(autosave.isSupportedReportRate(2), true);
    assert.equal(autosave.isSupportedReportRate(1), true);
    assert.equal(autosave.isSupportedReportRate(5), false);
    assert.equal(autosave.isSupportedReportRate(0), false);
    const edited = autosave.markEdited({}, { reporteRate: 5, sleepTime: 8 });
    const patch = autosave.buildPatch(
      edited,
      { reporteRate: 5, sleepTime: 8, sleepMode: 0 },
      { reporteRate: 1, sleepTime: 1 },
      { reporteRate: 1, sleepTime: 1 }
    );
    assert.equal(patch.reporteRate, undefined);
    assert.equal(patch.sleepTime, 8);
  });

  test('sleep commit writes wire minutes*2 and sleepMode 0; never-sleep toggle is sleepMode only', () => {
    assert.deepEqual(
      autosave.sleepCommitPatch(4, { sleepTime: 6, sleepMode: 1 }),
      { sleepTime: 8, sleepMode: 0 }
    );
    assert.equal(autosave.shouldCommitSleep(3, { sleepTime: 5, sleepMode: 0 }), false);
    assert.equal(autosave.shouldCommitSleep(3, { sleepTime: 5, sleepMode: 1 }), true);
    assert.equal(autosave.shouldCommitSleep(10, { sleepTime: 5, sleepMode: 0 }), true);
    assert.deepEqual(autosave.neverSleepPatch(true), { sleepMode: 1 });
    assert.deepEqual(autosave.neverSleepPatch(false), { sleepMode: 0 });
  });

  test('Mac enable stages lockWin false; combo writes 7 or 0', () => {
    assert.deepEqual(autosave.macModePatch(true), { macMode: 2, lockWin: false });
    assert.deepEqual(autosave.macModePatch(false), { macMode: 0 });
    assert.deepEqual(autosave.comboPatch(true), { debounceLevel: 7 });
    assert.deepEqual(autosave.comboPatch(false), { debounceLevel: 0 });
  });

  test('field revision ownership hydrates matching edits and preserves newer drafts including ABA', () => {
    const revs = {};
    const persisted = {};
    const settings = { reporteRate: 4, sleepTime: 6, sleepMode: 0, debounceLevel: 7, macMode: 0, lockWin: false };

    assert.equal(autosave.bumpFieldRev(revs, 'reporteRate'), 1);
    settings.reporteRate = 2;
    const capturedA = autosave.captureFieldRevs(revs, ['reporteRate']);
    assert.equal(capturedA.reporteRate, 1);

    assert.equal(autosave.bumpFieldRev(revs, 'reporteRate'), 2);
    settings.reporteRate = 1;
    const skipped = autosave.applyPatchIfCurrent(
      settings,
      { reporteRate: 2 },
      revs,
      capturedA
    );
    assert.deepEqual(skipped, []);
    assert.equal(settings.reporteRate, 1, 'older ACK must not overwrite a newer same-field draft');

    autosave.markFieldsPersisted(persisted, capturedA, revs);
    assert.equal(autosave.hasUnpersistedFieldRevs(revs, persisted), true, 'unpersisted B remains dirty after stale A');

    autosave.bumpFieldRev(revs, 'reporteRate');
    settings.reporteRate = 2;
    assert.deepEqual(
      autosave.applyPatchIfCurrent(settings, { reporteRate: 2 }, revs, capturedA),
      [],
      'ABA: A again must not own the third revision'
    );
    assert.equal(autosave.getFieldRev(revs, 'reporteRate'), 3);

    autosave.bumpFieldRev(revs, 'sleepTime');
    const capturedSleepOld = autosave.captureFieldRevs(revs, ['sleepTime']);
    autosave.bumpFieldRev(revs, 'sleepTime');
    settings.sleepTime = 30;
    assert.deepEqual(
      autosave.applyPatchIfCurrent(settings, { sleepTime: 8 }, revs, capturedSleepOld),
      []
    );
    const capturedSleep = autosave.captureFieldRevs(revs, ['sleepTime']);
    const appliedSleep = autosave.applyPatchIfCurrent(
      settings,
      { sleepTime: 30 },
      revs,
      capturedSleep
    );
    assert.deepEqual(appliedSleep, ['sleepTime']);
    autosave.markFieldsPersisted(persisted, capturedSleep, revs);
    assert.equal(autosave.hasUnpersistedFieldRevs(revs, persisted), true);

    const capturedFinal = autosave.captureFieldRevs(revs, ['reporteRate']);
    autosave.applyPatchIfCurrent(settings, { reporteRate: 3 }, revs, capturedFinal);
    assert.equal(settings.reporteRate, 3);
    autosave.markFieldsPersisted(persisted, capturedFinal, revs);
    assert.equal(autosave.hasUnpersistedFieldRevs(revs, persisted), false);
  });

  test('settleEdited keeps fields that moved during the in-flight save', () => {
    const revs = { reporteRate: 2, sleepTime: 1 };
    const remaining = autosave.settleEdited(
      { reporteRate: true, sleepTime: true, debounceLevel: true },
      { reporteRate: 2, sleepTime: 8 },
      { reporteRate: 1, sleepTime: 8, debounceLevel: 7 },
      { reporteRate: 1, sleepTime: 1 },
      revs
    );
    assert.equal(remaining.reporteRate, true);
    assert.equal(remaining.sleepTime, undefined);
    assert.equal(remaining.debounceLevel, true);
  });

  test('identity mismatch after reconnect, reset, profile, or source change is stale', () => {
    const captured = autosave.captureSaveIdentity(
      { kind: 'onboard', profileIndex: 0 },
      1,
      2,
      0
    );
    assert.equal(autosave.saveIdentityMatches(captured, {
      gen: 1, resetEpoch: 2, profile: 0, source: { kind: 'onboard', profileIndex: 0 }, connected: true
    }), true);
    assert.equal(autosave.saveIdentityMatches(captured, {
      gen: 2, resetEpoch: 2, profile: 0, source: { kind: 'onboard', profileIndex: 0 }, connected: true
    }), false);
    assert.equal(autosave.saveIdentityMatches(captured, {
      gen: 1, resetEpoch: 3, profile: 0, source: { kind: 'onboard', profileIndex: 0 }, connected: true
    }), false);
    assert.equal(autosave.saveIdentityMatches(captured, {
      gen: 1, resetEpoch: 2, profile: 1, source: { kind: 'onboard', profileIndex: 1 }, connected: true
    }), false);
    assert.equal(autosave.saveIdentityMatches(captured, {
      gen: 1, resetEpoch: 2, profile: 0, source: { kind: 'local', key: 'x' }, connected: true
    }), false);
    assert.equal(autosave.saveIdentityMatches(captured, {
      gen: 1, resetEpoch: 2, profile: 0, source: { kind: 'onboard', profileIndex: 0 }, connected: false
    }), false);
  });

  test('local persist writes owned or clean fields and keeps last-valid unowned dirty values', () => {
    const revs = { reporteRate: 2, sleepTime: 1 };
    const persisted = { sleepTime: 1 };
    const previous = { reporteRate: 4, sleepTime: 6, sleepMode: 0, tickRate: 1, reportRate24G: 9, rollerType: 3 };
    const current = { reporteRate: 1, sleepTime: 6, sleepMode: 0, tickRate: 1, reportRate24G: 9, rollerType: 3 };
    const owned = { reporteRate: 1 };
    const merged = autosave.settingsForLocalPersist(current, previous, revs, persisted, owned);
    assert.equal(merged.reporteRate, 4, 'unowned dirty rate keeps last-valid');
    assert.equal(merged.sleepTime, 6, 'clean sleep uses current');
    assert.equal(merged.reportRate24G, 9, 'unedited protocol bytes travel with the snapshot');
    const ownedNow = { reporteRate: 2 };
    const mergedOwned = autosave.settingsForLocalPersist(current, previous, revs, persisted, ownedNow);
    assert.equal(mergedOwned.reporteRate, 1);
  });

  test('failed save leaves captured fields dirty until a matching persist', () => {
    const revs = {};
    const persisted = {};
    autosave.bumpFieldRev(revs, 'lockWin');
    const captured = autosave.captureFieldRevs(revs, ['lockWin']);
    assert.equal(autosave.hasUnpersistedFieldRevs(revs, persisted), true);
    autosave.bumpFieldRev(revs, 'lockWin');
    autosave.markFieldsPersisted(persisted, captured, revs);
    assert.equal(autosave.hasUnpersistedFieldRevs(revs, persisted), true, 'failed A must not clear newer dirty lockWin');
    const capturedB = autosave.captureFieldRevs(revs, ['lockWin']);
    autosave.markFieldsPersisted(persisted, capturedB, revs);
    assert.equal(autosave.hasUnpersistedFieldRevs(revs, persisted), false);
  });

  test('sleep labels report raw units and clamp the thumb without rewriting', () => {
    assert.equal(autosave.formatSleepDurationLabel(1), '30 s');
    assert.equal(autosave.formatSleepDurationLabel(5), '2.5 min');
    assert.equal(autosave.formatSleepLabel(6, true), '0 min');
    assert.equal(autosave.sleepSliderThumbMinutes(1), 1);
    assert.equal(autosave.sleepSliderThumbMinutes(5), 3);
    assert.equal(autosave.sleepSliderThumbMinutes(60), 30);
  });

  test('unrelated successful field persist keeps failed-field error; idle dirty is error not saving', () => {
    const revs = { reporteRate: 1, sleepTime: 1 };
    const persisted = {};
    let errors = { reporteRate: 'Rate save failed' };
    autosave.markFieldsPersisted(persisted, { sleepTime: 1 }, revs);
    errors = autosave.clearFieldErrors(errors, { sleepTime: 1 }, revs);
    errors = autosave.remainingFieldErrors(errors, revs, persisted);
    assert.equal(errors.reporteRate, 'Rate save failed');
    assert.equal(errors.sleepTime, undefined);
    assert.equal(persisted.sleepTime, 1);
    assert.equal(persisted.reporteRate, undefined);
    assert.equal(autosave.hasUnpersistedFieldRevs(revs, persisted), true);
    assert.equal(autosave.firstFieldError(errors), 'Rate save failed');
    assert.equal(autosave.computeSaveStatus(0, true, true), 'error');
    assert.equal(autosave.computeSaveStatus(1, true, true), 'saving');
    assert.notEqual(autosave.computeSaveStatus(0, true, true), 'saving');
  });

  test('stale skip with empty sent revs does not persist or clear unrelated error', () => {
    const revs = { reporteRate: 2, sleepTime: 1 };
    const persisted = {};
    let errors = { reporteRate: 'Rate save failed' };
    const capturedSleep = { sleepTime: 1 };
    const sent = autosave.ownedSentRevs(revs, capturedSleep, {});
    assert.deepEqual(sent, {});
    autosave.markFieldsPersisted(persisted, sent, revs);
    errors = autosave.clearFieldErrors(errors, sent, revs);
    errors = autosave.remainingFieldErrors(errors, revs, persisted);
    assert.equal(errors.reporteRate, 'Rate save failed');
    assert.equal(Object.keys(persisted).length, 0);
    assert.equal(autosave.computeSaveStatus(0, true, true), 'error');
  });

  test('paired patch marks only actually sent fields persisted', () => {
    const revs = { sleepTime: 1, sleepMode: 2, macMode: 2, lockWin: 1 };
    const sleepCaptured = { sleepTime: 1, sleepMode: 1 };
    const sleepSent = autosave.ownedSentRevs(revs, sleepCaptured, { sleepTime: 8 });
    assert.deepEqual(sleepSent, { sleepTime: 1 });
    const persisted = {};
    autosave.markFieldsPersisted(persisted, sleepSent, revs);
    assert.equal(persisted.sleepTime, 1);
    assert.equal(persisted.sleepMode, undefined, 'superseded sleepMode must not be marked persisted');
    assert.equal(autosave.hasUnpersistedFieldRevs(revs, persisted), true);

    const macCaptured = { macMode: 1, lockWin: 1 };
    const macSent = autosave.ownedSentRevs(revs, macCaptured, { lockWin: false });
    assert.deepEqual(macSent, { lockWin: 1 });
    autosave.markFieldsPersisted(persisted, macSent, revs);
    assert.equal(persisted.lockWin, 1);
    assert.equal(persisted.macMode, undefined, 'superseded macMode must not be marked persisted');
  });

  test('mergeReadSettings keeps fields bumped after the snapshot and applies unchanged fields', () => {
    const settings = {
      sleepTime: 20, sleepMode: 0, reporteRate: 4, debounceLevel: 0, macMode: 0, lockWin: false, tickRate: 1
    };
    const incoming = {
      sleepTime: 6, sleepMode: 0, reporteRate: 4, debounceLevel: 7, macMode: 2, lockWin: false,
      tickRate: 1, reportRate24G: 9, rollerType: 3
    };
    const store = { sleepTime: 1 };
    const snapshot = {};
    const merged = autosave.mergeReadSettings(settings, incoming, store, snapshot);
    assert.equal(merged.settings.sleepTime, 20, 'newer sleep draft must survive delayed read');
    assert.ok(merged.skipped.includes('sleepTime'));
    assert.equal(merged.settings.debounceLevel, 7);
    assert.equal(merged.settings.macMode, 2);
    assert.equal(merged.settings.reportRate24G, 9);
    assert.equal(autosave.hasNewerFieldRevs(store, snapshot), true);
    assert.equal(autosave.hasNewerFieldRevs({ sleepTime: 1 }, { sleepTime: 1 }), false);
  });

  test('mergeReadSettings overwrites fields whose rev still matches the read snapshot', () => {
    const settings = {
      sleepTime: 20, reporteRate: 2, sleepMode: 0, debounceLevel: 0, macMode: 0, lockWin: false
    };
    const incoming = {
      sleepTime: 6, reporteRate: 4, sleepMode: 0, debounceLevel: 0, macMode: 0, lockWin: false
    };
    const store = { sleepTime: 1, reporteRate: 1 };
    const snapshot = { sleepTime: 1, reporteRate: 1 };
    const merged = autosave.mergeReadSettings(settings, incoming, store, snapshot);
    assert.equal(merged.settings.sleepTime, 6);
    assert.equal(merged.settings.reporteRate, 4);
    assert.equal(merged.skipped.length, 0);
    const edited = { sleepTime: true, reporteRate: true };
    autosave.clearAppliedFieldState(store, {}, edited, { reporteRate: 'x' }, merged.applied);
    assert.equal(store.sleepTime, undefined);
    assert.equal(edited.sleepTime, undefined);
  });

  test('local source identity still requires connected (existing product contract)', () => {
    const captured = autosave.captureSaveIdentity({ kind: 'local', key: 'x' }, 1, 0, 0);
    assert.equal(autosave.saveIdentityMatches(captured, {
      gen: 1, resetEpoch: 0, profile: 0, source: { kind: 'local', key: 'x' }, connected: true
    }), true);
    assert.equal(autosave.saveIdentityMatches(captured, {
      gen: 1, resetEpoch: 0, profile: 0, source: { kind: 'local', key: 'x' }, connected: false
    }), false);
  });
});
