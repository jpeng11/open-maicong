const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const autosave = require('../src/lighting-autosave.cjs');

describe('Lighting autosave revision helper', () => {
  test('discrete effect edits flush immediately; sliders coalesce', () => {
    assert.equal(autosave.coalesceDelay({ effect: 6, brightness: 80 }), 0);
    assert.equal(autosave.coalesceDelay({ brightness: 40 }), autosave.COALESCE_MS);
    assert.equal(autosave.coalesceDelay({ sideBrightness: 33, sideSpeed: 2 }), autosave.COALESCE_MS);
    assert.equal(autosave.coalesceDelay({ hexColor: '#FF0000' }), autosave.COALESCE_MS);
    assert.equal(autosave.coalesceDelay({ customColorDisabled: true }), 0);
    assert.equal(autosave.coalesceDelay({ direction: 1 }), 0);
  });

  test('settleEdited keeps fields that changed during the in-flight save', () => {
    const sent = { brightness: 40, speed: 2 };
    const remaining = autosave.settleEdited(
      { brightness: true, speed: true, effect: true },
      sent,
      { brightness: 10, speed: 2, effect: 6 }
    );
    assert.equal(remaining.brightness, true);
    assert.equal(remaining.speed, undefined);
    assert.equal(remaining.effect, true);
  });

  test('identity mismatch after reconnect or profile change is stale', () => {
    const captured = autosave.identitySnapshot({
      editGeneration: 1, resetEpoch: 2, editingProfile: 0, connected: true
    });
    assert.equal(autosave.identityMatches(captured, {
      editGeneration: 1, resetEpoch: 2, editingProfile: 0, connected: true
    }), true);
    assert.equal(autosave.identityMatches(captured, {
      editGeneration: 2, resetEpoch: 2, editingProfile: 0, connected: true
    }), false);
    assert.equal(autosave.identityMatches(captured, {
      editGeneration: 1, resetEpoch: 3, editingProfile: 0, connected: true
    }), false);
    assert.equal(autosave.identityMatches(captured, {
      editGeneration: 1, resetEpoch: 2, editingProfile: 2, connected: true
    }), false);
    assert.equal(autosave.identityMatches(captured, {
      editGeneration: 1, resetEpoch: 2, editingProfile: 0, connected: false
    }), false);
  });

  test('buildPatch omits unknown effect ids and unedited fields', () => {
    const lighting = {
      effect: 99, brightness: 40, speed: 3, direction: 1,
      sideEffect: 2, sideBrightness: 33
    };
    const edited = { effect: true, brightness: true, sideEffect: true, sideBrightness: true };
    const patch = autosave.buildPatch(
      edited,
      lighting,
      (id) => (id === 6 ? { id: 6 } : null),
      (id) => (id === 2 ? { id: 2 } : null)
    );
    assert.equal(patch.effect, undefined);
    assert.equal(patch.brightness, 40);
    assert.equal(patch.sideEffect, 2);
    assert.equal(patch.sideBrightness, 33);
    assert.equal(patch.speed, undefined);
  });

  test('markEdited merges without dropping earlier dirty keys', () => {
    const next = autosave.markEdited({ brightness: true }, { effect: 4 });
    assert.equal(next.brightness, true);
    assert.equal(next.effect, true);
  });

  test('coalesceWait uses trailing delay then cadence remaining time', () => {
    const now = 1000;
    assert.equal(autosave.coalesceWait({ brightness: 10 }, now, 0), autosave.COALESCE_MS);
    assert.equal(autosave.coalesceWait({ effect: 6 }, now, 0), 0);
    assert.equal(autosave.coalesceWait({ brightness: 10 }, now, now - autosave.COALESCE_MS), 0);
    assert.equal(autosave.coalesceWait({ brightness: 10 }, now, now - 30), autosave.COALESCE_MS - 30);
  });

  test('desiredMatchesDevice compares the sent patch against device lighting', () => {
    assert.equal(autosave.desiredMatchesDevice({ brightness: 40 }, { brightness: 40, effect: 6 }), true);
    assert.equal(autosave.desiredMatchesDevice({ brightness: 40 }, { brightness: 22 }), false);
    assert.equal(autosave.desiredMatchesDevice({ direction: 1 }, { direction: 1 }), true);
  });
});
