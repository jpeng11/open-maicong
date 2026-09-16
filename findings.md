# Findings: G75 Advanced list / tester / clear-all (static vendor)

Vendor JS was read as text only. Not executed.

## UI (1833)

- `l6` three columns: type cards (`l5` mechanical: SOCD `l0`, MT `lY`, TGL `l1`, CB `lO`; DKS/RS/LT gated out), binding list `t.length/40` (`l8`), tester `l9`.
- `l8`: defaultKeys[0] labels + layer, click `lc(index1,layer)`, delete tooltip `confirmDeleteAdvanceKey` then `lu` → `removeAdvanceKey`.
- `l9`: document keydown/keyup, two lists, newest first, max 100, expire 4000ms; `toCodeInfo` keyCode, catch fallback `event.code||event.key`. App-focused, no HID.
- `lJ` radios 0..3 only (563–570). `l0` index1/index2/priority and reciprocal type 148. No 571/572 control. Translations 571/572 unused in this component.

## Clear-all (2233)

- `e5` walks four layers, Advanced tab resets `h(t,e)` (isAdvancedKey). Not CMD 238.
- `e1` replaces with `defaultKeys[layer][index]`, removes matching `cbKeyIndexList` entries, SOCD `priority:0` via `updateTriggerKeyRangeValue`, then `es`/`setUserKeys`.
- `e5` does **not** call `eo`/`setAdvancedKeys`. `ez`/`removeAdvanceKey` *does* compact raw advancedKeys via `m.Sb` then `eo`.
- Downstream `setUserKeys` is CMD 9 `setUserKeyMatrix` only. No MT/TGL table compact on clear-all. Orphan table bytes may remain.

## customParam

- Offset 280 length 56: `[rtPress, rtRelease, rtSmart, 255, ...layer:[len, ...indexes]]`. Layer len must be `<40` on parse. Profile names are offset 336 length 280 (no overlap).

# Findings: G75 Performance autosave (static vendor)

Vendor JS was read as text only. Not executed.

## iG layout (1833 function iG, byte 514595)

Mechanical + `featLianji` selects `et`:
- left: report-rate card `F` + sleep card `V`
- right: Win-lock `U` + Mac-mode `B` + combo `Z`
Travel calibration / RT-smart / stability are other layouts, not G75 mechanical additions.

Rate: `$.Ee` `row:true`, `onChange` → `changeReportRate(parseInt(value))`. Options `iZ.HO(iV,iW)`. G75 `featRate8K` wired catalog: `1k=4, 2k=3, 4k=2, 8k=1`. No 16k/32k. `SafelyUpdateReportRate` hides `reportRateWarning`. `H=!isKeyboardProfile && !ProfileReportRate` disables rate (onboard keyboard: enabled).

Sleep: slider min 60 max 1800 step 60 seconds; display minutes. Draft `onChange` only; `onChangeCommitted` → `changeSleepTime`. Display `sleepMode==1 ? 0 : A/60`. Never Sleep `toggleNeverSleep(!R)`. Slider not disabled by Never Sleep.

Combo: `debounceLevel>=1`; toggle writes 7/0.

Win lock: disabled when `isMacModeLayer`; tooltip 890.

Mac: `toggleMacMode`. No global Apply; each control calls its handler.

## Provider handlers (2233)

Return map byte 462281:
`changeReportRate:eR, changeSleepTime:ej, toggleNeverSleep:eB, toggleKeyComboMode:eF, toggleLockWin:eV, toggleMacMode:eU`

```
eR: q(Z, rate)
ej: el(Z, seconds/30)
eB: er(Z, enabled?1:0)          // sleepMode only
eF: $(Z, enabled?7:0)           // debounceLevel
eV: J(Z, enabled?1:0)           // lockWin
eU: ee(Z, Z==-1 ? enabled?2:0 : enabled?Z*F$+2:Z*F$), then if enabling Mac await eV(false)
```

SDK (same chunk): `setReportRate` patches `{reporteRate}` with `updateReportRate:true` (byte 4 low nibble + byte 38 preserved). `setSleepTime` patches `{sleepTime, sleepMode:0}`. `setMacMode` patches `{macMode, lockWin:0 when Mac}`. `setDebounce` `{debounceLevel}`. `setLockWinKey` `{lockWin}`. Each is getFuncConfig → patch named fields → setFuncConfig. Untouched bytes stay.

## App reference

Key Config: capture slot revs at enqueue; hydrate/persist only if captured rev still matches; local snapshot keeps last-valid for unowned dirty slots; reset/profile identity rejects queued work before local or HID.

Lighting: serialized worker, identity snapshot, settleEdited, local-preview persist with zero HID, profile Load drains then refuses dirty/error.

## Root-review bugs (fixed this pass)

1. `finishSettingsSave(true)` cleared global error/blocked then reported `saving` whenever any field rev was still dirty. Failed rate + successful sleep hid Retry and stuck on Saving. Stale skip with empty owned revs did the same. Fix: `settingsFieldErrors` per field; `ownedSentRevs` only; `computeSaveStatus(pending, hasError, dirty)` so idle leftover dirty is `error`/`unsaved`, not `saving`.

2. `handleReadSettings` assigned the whole `res.settings` and cleared all revs after `api.readFuncConfig`. A newer sleep/rate edit after dispatch was wiped. Fix: enqueue the read on `settingsSaveGate`, snapshot revs at worker start, `mergeReadSettings` skips bumped fields; failed read with newer revs keeps `hasReadSettings` and the draft.

3. Paired Mac+lockWin and sleepTime+sleepMode: persist only keys actually in `send`. Last user action in same-turn UI tests lands; unsent paired fields are not marked persisted.

4. Local preview still requires `connected` (`canEditSettings` + `saveIdentityMatches`). Existing contract; not claimed as fully offline local edit.

GET_FUNC_CONFIG mock delays for the delayed-read UI test must stay under the 800 ms `readFuncConfig` timeout (used 500 ms). A 1400 ms delay sets `needsReconnect` and fails the follow-up save.
