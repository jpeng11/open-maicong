# G75 V2 Key Config workflows (static source trace)

Inspected 2026-09-12. Vendor assets were read as text only and were not executed or shipped. No physical keymap writes were performed.

## Sources

| File | What was traced |
| :--- | :--- |
| `/tmp/maicong-cz-ui/1833-29e749719b751fa6.js` | Palette drag `t3`, keyboard drop `tx`, assign wrapper `tB`, macro extra tab `tW`, layer/restore `ix`, recorder `tI` |
| `/tmp/maicong-cz-ui/2233-7ba109b328b2b69b.js` | `changeKeyConfigs` `eQ`, reset walker `e1`/`e2`/`e5`, spread `e0`, `isAdvancedKey` `J`, `createMacroKeyEntity` |
| `/tmp/maicong-cz-readable.js` | `Hs`/`L` advanced predicate at ~1971278; `setUserKeys` CMD 9 |
| `/tmp/maicong-vendor-en.json` | `102` drag hint, `199` restore, `181`/`182` confirms, `111`/`112`/`113` Record/Pause/Resume, `20`/`21`/`24` Copy/Paste/Cut |

## Drag assignment

Palette `t3` `onDragStart` (1833 ~302957): if `isPreview`, `preventDefault` and return. Otherwise `setDraggingData({ source: "keyCode", payload: getKeyFromCode(code) })`. Keyboard keys are not the drag source.

Drop `tx` (1833 ~464370): `preventDefault`, read `getDraggingData("keyCode").payload`, and only if `currentTab === "keyCode"` call `tB([{ userKey, index }], { updateType: "auto", fillAllLayer: isKeyItemGlobalKey })`. Drop uses in-memory draggingData, not `dataTransfer` bytes.

Macro extra tab `tW`: empty macros are not draggable and click returns. Payload is `createMacroKeyEntity(macroIndex, playbackType)` = `{ type: 112, code1, code2 }`.

This app: palette items are `draggable` except in local preview. Keyboard keys accept drop via the same in-memory `{ source: "keyCode" }` payload. Click assign remains.

## Persistence (auto-save)

2233 `e0`/`eQ`: after updating `userKeys`, `"localstorage" === type` sets `postSet: null` (no HID). Onboard `keyboard` profiles call `O.setUserKeys` (CMD 9) per changed layer.

G75 layout has no `isGlobalKey` entries, so `fillAllLayer` / `spreadUserKeysToAllProfiles` is a no-op for ordinary keys.

This app: onboard assign/drop/paste/cut/restore writes CMD 9 immediately (generation/reset guarded). Local preview calls `saveLocalProfileDraft` and reports `hardwareWrites: 0`. Local snapshots merge previous `advanced`, `lightingMemory`, `selectedLightEffect`, `customParam`, and `macroMetadata` so GIF/advanced data are not dropped.

Each staged slot gets a monotonic edit revision. Slot revs and save identity (generation, reset epoch, profile, edit source) are captured at enqueue, not after the save-gate wait. `res.planned` hydrates a slot only when that captured revision is still current, so a delayed A ACK cannot overwrite a newer same-slot B (including ABA and migrated 112/MT/TGL indexes). Dirty clears only for revisions that actually persisted. A local full snapshot writes owned matching slots as current and keeps last-valid persisted entries for other dirty slots, so a rejected macro paste is not saved by an unrelated key. Layer re-read keeps dirty slots. Reset/profile invalidation clears revisions; queued work with a stale captured identity returns without restoring editors.

## Restore defaults (Key Config, not factory CMD 238)

`ix` (1833 ~441599): Restore (`199`) is disabled unless `isSomeKeyChanged` and not editing an advanced key. Confirm uses `181` on Key Config (`182` is Advanced-tab clear-all; out of this pass).

`e5` (2233): for **all four layers**, reset positions where `!isAdvancedKey` (Key Config tab). `Hs`/`L` (readable ~1971278): types `144..149` are definite advanced; type-16 chords are `"maybe"` and are advanced only if listed as CB. Defaults are **layer-specific** `defaultKeys[layer][index]`. Orphan MT/TGL table bytes are not cleared here.

This app: Restore defaults confirms with the 181 copy, restores ordinary keys on every **loaded** layer (unread layers are read first when connected), skips definite advanced and listed CB slots, then auto-saves. It is not factory reset.

## Shortcut record into one key

Hub Key Config extra tab is `remapKey.macro` (existing recorded macros dragged onto a key). The Record/Pause/Resume control lives on the macro editor `tI` (1833 ~276935): one button, `111` Record if empty, `112` Pause while recording, `113` Resume when paused with content. Click toggles `isRecording`. **No Cancel control.**

This pass also records a **type-16 chord** onto the selected Key Config key (PARITY gap “record into a key, not a macro slot”). Labels match `tI`. Pause on blur/tab/disconnect/reset. Completing a non-modifier key (with optional **currently held** modifiers) assigns `[16, mask, hid]` and pauses. Releasing a modifier rebuilds the mask from keys still held; it is not sticky after release. Vendor `tI` has no Cancel; none is shown.

## Copy / paste / cut bindings

en `20`/`21`/`24` exist. G75 Key Config chunks 1833/2233 do **not** call those strings for keymap. `icon-copy_linear` in 1833 is **copyMacro** (whole macro slot). Mouse Extra shortcuts use `mouse.copy`/`cut`/`paste` as remap labels, not clipboard commands.

This app implements an in-memory Key Config clipboard because the pass asked for copy/paste/cut with fail-closed table rules. It is **not** claimed as a traced G75 context menu.

Rules (aligned with `eQ` writing tuples as-is, plus fail-closed tables):

- Ordinary types `0/16/32/33/48/64/112/240`: copy the tuple. Reference-bearing `112/145/146` require a valid clipboard source (no default to onboard profile 0).
- Macro `112`: copy stores playback type plus normalized action-body identity. Paste searches the destination bank for that content and carries that snapshot through IPC with the destination key slot. Onboard `applyKeymap` re-reads the device bank inside the serialized transaction and migrates by slot identity (not a previously remapped index) or rejects before CMD 9. The editor then adopts the planned written tuple so the UI matches the device. Local persist re-checks the live editor bank once; it does not double-resolve through transport. Null/wrong-type expected refs are rejected. Indexes are never reused when content/playback do not match.
- MT `146` / TGL `145`: paste only on the **same** profile/local item. Copy stores table-entry bytes. Paste (and `applyKeymap` shared-ref) re-reads tables inside the serialized transport transaction, matches those bytes, and only then writes a currently referenced index. Replaced table entries, cross-profile tables, and dangling indexes are rejected. No table-byte rewrite.
- SOCD `148` and magnetic `144/147/149`: reject paste and cut from Key Config.
- Cut of ordinary keys copies then restores the layer default. Advanced cut is rejected.
- Malformed JSON/objects and missing source on reference bindings are rejected; no slot is written.

Autosave: onboard assign/drop/paste/cut/restore writes CMD 9 on a serialized save gate. Local preview persists the snapshot on the same gate (`hardwareWrites: 0`). There is no renderer `Promise.race` timeout that clears ownership while IPC may still write. Profile Load drains pending saves first; a timed-out save or a failed/dirty edit is reported and the switch is refused. Reset/disconnect do not zero the pending counter; a late completion must not restore editors. Per-slot revision ownership is required in addition to the profile/generation check: hydrate and dirty-clear only the revisions that persist.

## Magnetic-only (not implemented)

WASD / Select All / Invert live in `iC` and are invoked only when `currentTab === "trigger"` (`docs/G75_SELECTION_SCOPE.md`). Not part of mechanical Key Config.

## Remaining gaps

- Physical CMD 9 / advanced table writes unproven.
- Hub always holds four layers in memory; this app reads unread layers on restore when connected.
- Copy/paste/cut is an app clipboard, not a traced G75 menu.
- One-key chord recorder is an app control using `tI` labels; hub records into macro slots then assigns type 112.
- Firmware, cloud libraries, and full hub parity remain open.
