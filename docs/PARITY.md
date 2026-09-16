# G75 V2 mechanical hub parity inventory

**Objective:** full 1:1 functionality with the official MCHOSE G75 V2 **mechanical** web hub, not UI resemblance. This document is an evidence-based inventory. It does **not** treat deliberate omissions as parity achieved.

Living inventory. Implementation of Advanced CB combo landed in a later pass; this file records status, not a claim of full hub parity. No vendor webhub connection. Unit/mock tests do **not** prove physical mutations.

**Inventory qualifications**

- Native `node-hid` / IOKit versus browser WebHID is the **same device function** on a different host stack, not missing G75 functionality.
- Cloud / share / official libraries are **unresolved product scope**, not a permanent exclusion. Offline CSP currently blocks them; that can change.
- Hub **translation strings alone** do not prove a control exists on G75 V2 firmware. Macro **names** are local extended storage (`docs/MACRO_METADATA.md`), not CMD 12/13 bytes.

**Verification policy used below**

| Tag | Meaning |
| :--- | :--- |
| Live read | Observed on a real G75 V2 receiver (packaged app, MCU FW 1.14 / RF 1.30). Read-only. |
| Mock write | Exercised against in-memory GLW (`npm test` / `npm run test:mock-ui`). Not a physical EEPROM proof. |
| Unproven write | Wire path exists or is stubbed; no validated live mutation. |
| None | Not implemented. |

---

## Evidence sources

| Source | Path | What it is |
| :--- | :--- | :--- |
| Hub G75 workspace | `/tmp/maicong-cz-ui/1833-29e749719b751fa6.js` | Official G75 configurator chunk. Tabs in `iX()`, performance `iG()`, Other `iF()`, advanced kinds `l5`/`lY`/`l1`/`l0`/`lO`, lighting mount `iR.ZP`. File is one line; cite **function names**. |
| Shared protocol | `/tmp/maicong-cz-readable.js` | `CZ_SHARED_DATA` webpack. `restoreFactorySettings` is near **line 22782** and sends command **238**. `isHotKey` / `mergeCBKey` are at **byte offsets** ~1971309–1972375 (pretty-printed `function I` / `D`), not line numbers. Lighting effect map ≈ line 3830+. Special keycodes (factory-reset key, battery, switch-profile). |
| English copy | `/tmp/maicong-vendor-en.json` | Hub i18n. Tab titles `50`–`55`, layers `120`–`123`, advanced `501`–`606`, macros `821`–`827`, factory `690`–`735`, firmware `710`–`742` / `upgradeTip.*`, profiles `864`–`870`. |
| Hub CSS / connect | `/tmp/maicong-web-design/` | Theme tokens and connect chrome; not wire protocol. |
| This app | `src/protocol.cjs`, `src/transport.cjs`, `src/layout-g75v2.cjs`, `src/renderer.js`, `src/index.html`, `src/schema-validators.cjs` | Implemented GLW surface. |

Magnetic-only hub surface (Trigger tab, DKS type 144, RS type 147, LT, Rapid Trigger, travel calibration, switch libraries) is **listed as magnetic-only**. G75 V2 mechanical `isMechanical` hides it in `iX()` / `l5()`. It is still **not** “parity achieved”; it is **not a G75 V2 mechanical requirement**.

---

## Official G75 V2 mechanical hub surface

`iX()` in `1833-29e749719b751fa6.js` (mechanical omits Trigger):

| Hub tab | i18n | Component | App analogue |
| :--- | :--- | :--- | :--- |
| Lighting | `50` | `iR.ZP` | Lighting tab |
| Key Config | `52` | keymap editor (`tQ` mount) | Key settings |
| Advanced key | `53` | `l6` / `l5` | Advanced keys |
| Performance | `54` | `iG` | Performance |
| Others | `55` | `iF` | Present: active/all factory reset with confirmation. Firmware review/confirm/cancel is user-operable from a local official package; physical flash is unproven. |
| Trigger | `51` | `iY` | Magnetic-only; hub omits for mechanical |

Hub chrome also includes: 320px device/profile rail (`rB`/`re`/`rw`), 4 onboard profiles, custom/cloud/official libraries, drag-to-activate, firmware badge on Other.

App chrome: device/profile rail + horizontal tabs (Lighting, Key settings, Advanced, Performance, Macros, Overview, Backup, Guide). Macros are a first-class app tab; hub folds shortcut-record into Key Config (`remapKey.macro`).

---

## Inventory

Legend for **Status**: `MATCH` (same idea, remaining write-proof gap), `GAP-SEMANTIC`, `GAP-MISSING`. Magnetic-only rows use `MAGNETIC-ONLY`.

### 1. Device connection and modes

| Hub control / action | Vendor evidence | App path | Status | Semantic gap | Verification needed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Connect keyboard | en `80`–`86`; web connect chrome | `detector.cjs` + `transport.connect` via node-hid nonExclusive | MATCH | Hub uses WebHID; app uses native HID. Same VID/PID/interface intent. Not a missing keyboard feature. | Live enumerate already used. |
| Show Wired vs 2.4G | en `wiredMode` / `wirelessMode`; `i7()` in 1833 | Sidebar status `2.4 GHz` / `USB` / `Offline`; Overview VID/PID | MATCH | No Bluetooth path on this SKU. | Live read of receiver vs wired. |
| Mac / Win mode | en `670`–`671`; `iG` `toggleMacMode` | Settings OS Mode → `applySettings({ macMode })` FUNC byte 1 | MATCH (writes unproven) | Hub ties default layer to Mac; app also maps `macMode&3` to initial layer. | Live read of byte 1; mock write only. |
| Preview vs onboard edit | en `unActiveProfileTip*`; `isPreview` in `iX`/`iG` | Load for editing vs Activate; local preview hydrates from disk | MATCH in source (mock-tested) | Load still does not `SET_BASE`. Custom items preview with zero HID. Drag local→onboard is tE. | Mock: load ≠ SET_BASE; local preview zero writes. Live activate unproven. |
| Game/app auto-bind profile | en `profile.autoUnbindTip`, `confirmDeleteBindConfig`; 1833 `eu` `COMMAND_GET_IS_BIND_EXE` / `COMMAND_DELETE_BIND_CONFIG` | Backup onboard cards: Link game/app, Unlink, delete confirm, auto-unbind on move/delete; host watcher activates the bound slot | MATCH in source (mock-tested; host-side, not GLW) | Hub bind table lives in the Windows parent process. This Mac stores bundle-id links per device and switches onboard via SET_BASE when that app is frontmost. No keyboard opcode. Physical auto-switch unproven. | Mock bind/confirm/unbind/frontmost switch. |
| Refresh / reconnect | en `refreshLabel`; connect header | Scan / Refresh | MATCH | | Live read. |

### 2. Onboard / local / cloud profiles

| Hub control / action | Vendor evidence | App path | Status | Semantic gap | Verification needed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 4 onboard slots | en `storedOnDevice`; `rw` profile list | Sidebar onboard list + enable 4th (`enableProfiles`) | MATCH (writes unproven) | Drag local onto a slot is tE. Activate/Load remain distinct. | Live read of profileCount/order; mock enable/switch/tE. |
| Copy onboard → new driver profile | en `864`; module 78072 copy path; `i18n<defaultOnboard>` + index; WD `/i18n<([^>]+)>/` | `copyOnboardToLocal` + `allocateLocalName` | MATCH in source (mock-tested) | Device-stored tokens `i18n<defaultOnboard>`/`2`/`3` display as `Default Onboard`/`2`/`3`. Raw tokens are preserved; query does not rewrite them. Local copies allocate unique 2–15 names from the translated seed and keep `extra.storedName`. User-created names stay 2–15. No startup name writes. | Literal token fixture; unit copy/tE preserve tokens; mock-ui sidebar/dropdown/rename dialog. |
| Custom/local library (ordinary cap 20) | module 78072 `tX`; en `870` is **stale six** | Sidebar custom list, atomic `profile-library.json` per device identity | MATCH in source (mock-tested) | Capacity is 20 ordinary onboard+local, not six. Cloud/official/Apex lists are still missing. | Unit capacity/corruption; mock create/rename/reorder. |
| Cloud / official / Apex libraries | en `EQ.resetCloud*`, share/like/favorite | none; CSP `connect-src 'none'` | GAP-MISSING (unresolved scope) | Not permanently excluded. Offline CSP currently blocks vendor network; product decision still open. | Do not implement against vendor cloud until scope is decided. |
| Share/import config **code** | en `shareCode*` | none | GAP-MISSING (unresolved scope) | Requires a service; i18n does not prove G75 uses it. | |
| Import / export file | en `15`/`16`; format doc version 3; SDK `se`/`le`/`ue`/`pe`/`ge` | Official v3 KeyboardProfile import creates a **local** item (zero HID) and converts `advancedKeys.mt/tgl` into native MT/TGL tables. Onboard official export serializes parsed native tables as `{clickKey,downKey}` / `{type,code1,code2}`. Native backup JSON on Backup tab retained. | MATCH in source for v3 lighting/layers/macros/MT/TGL + native backup (mock-tested) | Cloud share-codes and lighting-only envelopes remain missing. Official JSON has no keyExtras field; DKS is rejected on G75 mechanical. Nested malformed official/local objects fail closed (no replacement defaults). Consecutive official times are preserved as zero-code delays. Live apply unproven. | Independent v3 and MT/TGL fixtures; unit remap/type tests; mock import/apply/export. Physical EEPROM unproven. |
| Rename / delete onboard or custom | en `22`, `19`; `tf`/`tg`; `tu` 2–15 | Rename onboard (CMD 241/242 names) and local; delete with last-onboard guard | MATCH in source (mock-tested) | tg neighbor is right-then-left. Partial name replication is reported; no claimed multi-packet rollback. tE/tI/tk park 16-char defaults as unique local names without rewriting onboard originals. | Mock rename/delete; failed name slots; tE/tI/tk recovery. |
| Reset active vs reset all (factory) | en `resetActiveProfile`, `resetAllProfiles`; `iF` then `restoreFactorySettings` | Others tab + prepare/commit transport and IPC | MATCH (mock-tested; physical reset unverified) | Fresh hardware-active target; scope byte index/255; separate ACK and reset notification; no retry; old drafts and pending writes invalidated. Shared local macro metadata policy differs from vendor profile metadata. | See `docs/RESET_PROTOCOL.md`; unit and Electron confirm/cancel tests pass. |
| Write-to-onboard progress | en `writeKeyboardTip` | Sidebar progress + error text during tE/tI/tk/tg | MATCH in source (mock-tested) | Not a determinate percent of vendor packets. Partial hardware writes are exposed. | Mock activation flow. |

### 3. Lighting (mechanical)

Hub lighting tab is always mounted for non-preview (`iX` → `iR.ZP`). Libraries: `stillLightingEffects`, `gifLightingEffects`, side still, follow-main.

| Hub control / action | Vendor evidence | App path | Status | Semantic gap | Verification needed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 23 built-in main effects 0–22 | G75 catalog and GLW resolver; `G75_LIGHTING_SCOPE.md` | 22 preset tiles plus Custom/Local still and GIF libraries | MATCH in source (mock-tested; not packaged) | Vendor order, names and selection states match. Local still create/select/rename/delete, 83-zone still edits, GIF import/edit/playback, and selectedLightEffect 241/242 offset 840/56 are implemented. Cloud/share/side still remain missing. | Apply/Read/white-balance share one request identity. Still and GIF library unit+mock UI tested. Physical CMD 242 / CMD 221 unproven. |
| Remembered effect settings | `G75_LIGHTING_PRESET_MEMORY.md`; CMD 241/242 offset `profile*1024+728` length112, ten-byte `<light@v2>` | Restore and persistence in source; unknown flag bits and side2 preserved | MATCH in source (mock-tested; not packaged) | Transient 241 failures are unavailable, not local success. Local fallback is explicit and serial-scoped. Malformed imports fail before writes. | Literal fixture flag preservation, malformed import zero-writes, identity/reset races. Physical CMD242 unproven. |
| Extra built-in `light-23` / sword array | Generic catalog; G75 V2 model lists exactly 0..22 (`docs/G75_LIGHTING_SCOPE.md`) | not exposed | OTHER-MODEL | Not in the shipped G75 V2 lighting definition. | Static model and resolver evidence. |
| Brightness 0–100 | en `256`; FUNC byte 9 | slider 0–100 | MATCH | | Live read; mock write. |
| Speed 0–4 | G75 catalog capability table in `G75_LIGHTING_SCOPE.md` | Slider0–4, effect-specific visibility and guards | MATCH in packaged release179 (mock-tested) | Hidden for main0,2,3 and side Constant On/Off. | Independent27-row fixture and rendered controls tested. |
| Direction | G75 GLW direction families in `G75_LIGHTING_SCOPE.md` | Four effect-specific label pairs, values0/1 | MATCH in packaged release179 (mock-tested) | Only main6,7,8,10 expose direction. | Independent fixture asserts labels and rendered capability visibility; physical writes unverified. |
| Solid custom color on/off + hex | FUNC customColorDisabled + RGB | checkbox + color + presets | MATCH | Hub also has **palette / still / GIF libraries**. | |
| Per-key custom static (effect 0) | CMD 10/11; hub still lighting + paint | 83-zone canvas bound to the selected local still; `applyKeyColors` plus 300ms library persist | MATCH in source (mock-tested; not packaged) | Hub share-codes remain missing. Native still persist uses colors2KeyColorFrame aliases 301/302/Fn1. | Mock still paint/select. Physical writes unproven. |
| GIF / custom animation library | `gifLightingEffects` in 1833; host GifJsonPlayer; CMD 221 | Local GIF library on Custom tab: import ≤5MiB, bounded decode, editor, play/pause/stop, selectedLightEffect `["gif", name]` at 840/56, host CMD 221 streaming | MATCH in source (mock-tested; not packaged) | Native image-to-key mapping samples G75 layout geometry with Te aliases 301/302/Fn1. It is **not** a traced 1:1 of vendor TRANSFORM_GIF. Host streaming uses profile argument 0, the vendor-resolved 128-index / 384-byte main range (no invented 113 cutoff), 54-byte RGB chunks with last-54 overlap, serial HID queue plus 20ms unsafe-completion pacing, no ACK. LZW requires a full pixel count and end code. Not persistent EEPROM. Cloud/share GIF files remain missing. | Unit decoder/library/packet tests and mock UI import/edit/play. Physical CMD 221 unproven. |
| Music / sound-reactive | en `200` “Sound - light phantasmagoria”; readable `abortAllMusicColor` cmds 220/221/223 | none | GAP-MISSING | Confirm G75 mechanical actually offers it. | |
| Side strip modes Neon/On/Breathing/Off | en side modes; `SIDE_LIGHT_EFFECTS` | side effect 1–4 | MATCH | | Live read bytes 24–31. |
| Side follow main / backlight sync | Generic catalog value 0; G75 V2 sideEffect list is only 1..4 (`docs/G75_LIGHTING_SCOPE.md`) | not exposed | OTHER-MODEL | Not in the shipped G75 V2 side-effect definition. | Static model and resolver evidence. |
| Side brightness/speed/color | FUNC 25–31 | sliders + color | MATCH | | |
| LED white balance RGB | FUNC 40–42 | calibration sliders + Apply | MATCH (writes unproven) | Hub may bury this; app is explicit. | Mock apply. |
| Share lighting code (GIF/still) | en `ShareCode.requireDataScopeGif/Still` | none | GAP-MISSING | Network. | |

### 4. Key bindings (Key Config)

| Hub control / action | Vendor evidence | App path | Status | Semantic gap | Verification needed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 4 layers Win / WinFn / Mac / MacFn | en `120`–`123` | Layer 0–3 toggles + read/apply | MATCH | App labels match. | Live layer reads (incl. Fn consumer F1). Mock apply. |
| Click key then assign from palette | en `102`/`105` drag **or** click; 1833 `t3`/`tx` | click, palette click, and palette→key drag (`source:"keyCode"`) | MATCH in source (mock-tested) | Local preview blocks dragstart (hub `isPreview`). Drop uses in-memory payload like `tx`. Onboard auto-saves CMD 9; preview persists locally. Physical writes unproven. | Mock drag/drop; local preview zero HID. |
| Multi-select WASD / all / invert | chunk 1833 `iC`, guarded by trigger tab | not applicable | MAGNETIC-ONLY | These named controls belong to trigger editing, not G75 mechanical remapping. | See G75_SELECTION_SCOPE.md. |
| Global vs per-key lighting/settings | en `194`–`196` | N/A for remap; lighting is global + per-key paint | GAP-SEMANTIC | | |
| Copy / paste / cut keys | en `20`/`21`/`24` unused in G75 1833/2233 Key Config; `eQ` writes tuples as-is | Inspector Copy/Cut/Paste + Cmd/Ctrl-C/X/V | MATCH in source for clipboard rules (mock-tested) | **Not** a traced G75 context menu (those i18n keys are unused on this surface; 1833 copy icon is copyMacro). Reference bindings require a valid source (no onboard0 default). Macro `112` copies playback+body identity, carries slot+snapshot through IPC, and revalidates against a freshly read bank inside the serialized keymap transaction (local persist re-checks the editor bank once). Planned indexes hydrate only when that slot’s captured edit revision is still current (ABA-safe); a later same-slot draft is not overwritten by an older ACK, including migrated 112/145/146. Save identity is captured at enqueue. Local full-snapshot persist writes last-valid entries for unowned dirty slots so a rejected paste is not saved by an unrelated key. Same-profile MT/TGL paste snapshots table bytes and re-verifies them inside the same transaction; replaced entries, cross-profile tables, dangling indexes, and SOCD/magnetic types are rejected. Cut of advanced is refused. Malformed clipboard writes nothing. | Unit clipboard + overlapping SET_MACROS/applyKeymap + slot-rev ABA; mock queued first-packet barrier, delayed A-then-B, local persist race, reset queued B. |
| Restore defaults (layer / selection) | en `199`/`181`; 1833 `ix`; 2233 `e5`/`e1`; readable `Hs`/`L` | Restore defaults + confirm 181; all loaded layers; skip definite advanced | MATCH in source (mock-tested) | Hub walks four in-memory layers. App reads unread layers when connected, then restores ordinary keys to layer-specific CMD7 defaults. CB chords are skipped only when listed. Not factory CMD 238. Physical writes unproven. | Mock restore after remap; advanced skip unit-tested. |
| Basic / Mouse / Media / Lighting / Extended palettes | en `106`–`108`, `remapKey.*`, chunk 1833 `eG()` | Exact G75 `eG()` sets: Basic (104), Mouse (7), Media (7/6), Main Lighting (9), Side Lighting (8), Extended (layer-aware WinExtra47 or MacExtra32 + SwitchProfile + Clear + base Fn) | MATCH (mock-tested) | Visible palette aligns 1:1 with chunk 1833 `eG()` and layer-aware Extra sets. Generic reset/battery/pairing correctly omitted from visible palette while preserving raw decode compatibility. | Layer 0..3 palette tests pass (185/184/169/168 items). Mock UI apply & readback verified. |
| Macro assign from remap | en `remapKey.macro` | Macros tab + Assign to Selected Key (type 112) | MATCH | Hub in-palette; app separate tab. Playback type 0/1/255 aligned with en `821`/`825`/`823`. | Mock macro bind + mode propagate. |
| Media / consumer tuples | en media; `readable` consumer | Media type 48 (Volume Up/Down, Mute, Play/Pause, Next/Prev Track, Stop filtered on Mac) | MATCH | Exact consumer tuples `[48, code1, 0]` aligned with vendor tables. | Live Fn-layer `[48,112,0]` already observed. Mock apply verified. |
| Combo chord (modifier+key) as remap | type 16 + modifier mask | palette modifiers + staging | GAP-SEMANTIC | Hub also has dedicated Advanced **CB** (below). | |
| Shortcut **record** into a key (not macro slot) | en `111`/`112`/`113`; 1833 `tI` one button, no Cancel; extra tab `remapKey.macro` assigns type 112 | Key Config Record/Pause/Resume assigns `[16, mask, hid]` to the selected key; Macros palette still assigns 112 | MATCH in source for chord-into-key + macro drag/click (mock-tested) | Hub records into macro slots then drags 112. This control uses `tI` labels to write a type-16 chord onto the selected key from **held** modifiers (release rebuilds the mask; Ctrl-up then A is `[16,0,4]`, not Ctrl+A). No Cancel (vendor has none). Pause on blur/tab/disconnect/reset. Capture requires the Key Config box to be focused. | Mock Record/Pause/Resume + held Ctrl+A; unit tests modifier-up. |
| Disabled / clear key | en forbid/clear | Clear `[16,0,0]` & Disabled `[0,0,0]` | MATCH | Clear `[16,0,0]` and legacy Disabled `[0,0,0]` both decode safely. | Unit & mock tests. |

### 5. Advanced keys (mechanical)

`l5()` in 1833: if `isMechanical`, skip DKS (`l$` type 144), RS (`lX` type 147), LT (`lq`); always SOCD `l0` type 148, MT `lY` type 146, TGL `l1` type 145; mechanical-only CB `lO`.

| Hub control / action | Vendor evidence | App path | Status | Semantic gap | Verification needed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| MT hold/tap + delay (default 150 ms) | `lY`; en `525`–`531`; userKeys type **146** | Advanced kind `mt`; `applyAdvancedBinding` | MATCH (writes unproven) | Hub list cap shown as `t.length/40`; app 32 MT entries + shared-table rules. Delay floors to 10 ms in transport. | Mock shared-table tests exist. Live unproven. |
| TGL | `l1`; en `580`–`581`; type **145** | kind `tgl` | MATCH | | Mock. |
| SOCD pair + 4 priorities | G75 l0/lJ in 1833; en 563–570 | kind socd + priority 0–3, reciprocal partner and priority cleanup | MATCH in source (mock-tested) | G75 call-site trace exposes four priorities; translation 571/572 alone does not establish a simultaneous toggle. Reserved and unrelated partner data are preserved. | Physical writes unproven; see G75_ADVANCED_RESET_SCOPE.md. |
| Key combination CB | `lO` in 1833; `readable.js` `isHotKey` / `isNormalKey` / `mergeCBKey` at **byte offsets** ~1971309–1972375 (`function I` / `T` / `D`) → `{ type: 16, code1: hot.code1, code2: normal.code2 }` | Advanced kind `cb`; `validateAdvancedBinding` + `applyAdvancedBinding`; UI modifier + regular selects | MATCH on ordinary keys (writes mock-tested) | Modifier-only exact `[16, mask, 0]` plus regular exact `[16, 0, hid]`. Physical **knob slot 37 remains excluded** until the hub function-key / G75 `gunlun` (roller) virtual mapping is verified (`G75Gunlun` in `2233-7ba109b328b2b69b.js`; function-key overlay in the same chunk). Do **not** claim exact full CB target coverage versus hub. Live mutation unproven. | Mock: extra tuple bytes rejected; Ctrl+A; CB over shared MT; editor draft survives rerender; selecting another key loads its existing combo. |
| Current bindings list + delete | l6/l8; confirm delete | Three-column Advanced view; aggregate 40-count list, layer labels, edit/focus and confirmed delete | MATCH in source (mock-tested) | Reciprocal SOCD display deduplicated; local operations preserve shared banks and newer drafts. | Native layout inspected; physical writes unproven. |
| Test your binding | l6 third pane l9; en 504/590–597 | Focused-window press/release tester; newest 100 events expire after four seconds | MATCH in source (mock-tested) | Displays host key events; not a physical firmware behavior proof. | Physical advanced behavior remains unverified. |
| Clear all advanced | G75 provider e5/e2 and e1 layer defaults | Confirmed all-four-layer clear using shared planner; local and onboard paths | MATCH in source (mock-tested) | Preserves ordinary mappings, reserved table tails and unknown custom bytes; malformed CB membership is rejected before writes. | Clear→apply queue, reset identity and local zero-HID regressions pass. Physical writes unproven. |
| DKS / RS / LT | `l$`/`lX`/`lq`; types 144/147 | omitted | MAGNETIC-ONLY | Hub `l5` already skips for `isMechanical`. | Do not add without G75 proof. |
| Fn / knob ineligible | hub defaultKeys / layout; G75 roller glyph `G75Gunlun` in `2233-7ba109b328b2b69b.js`; function-key overlay | 80 eligible; Fn and **physical knob slot 37** excluded | MATCH for Fn; **CB targets not fully qualified** | Knob stays out of CB/MT/TGL/SOCD until virtual roller / function-key `gunlun` mapping is verified. Hub may advertise CB on that function-key; this app does not claim the same target set yet. | Confirm G75 hub which physical/virtual index receives CB on the roller. |

### 6. Macros and recording

Hub: remap category Shortcut Record + named configs. App: 16 hardware slots CMD 12/13.

| Hub control / action | Vendor evidence | App path | Status | Semantic gap | Verification needed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 16 hardware slots | CMD 12/13; en macros | `readMacros` / `applyMacros` | MATCH | Drafts require a successful CMD 12 parse (`hasReadMacros`). Failed reread, disconnect, and edit-target invalidate the writable bank. Apply freezes a hardware-safe snapshot (no extra IPC keys). | Mock 8192-byte region. Live write unproven. |
| Hold to repeat | en `821`–`822`; `tC` values `0` / `255` / `1`; GLW bytes 34+i | playback `0` | MATCH | Official import accepts GLW hardware types **0, 1, 255**. QHW UI OneTime=2 maps to hardware 1 and is not a GLW official mode. Remap still treats unequal integer types as distinct. | Mode propagation across 112 bindings: mock. Official type 0/1/255 import unit tests. |
| Play once | en `825`–`826`; `tC` value `1` | playback `1` | MATCH | | |
| Toggle repeat | en `823`–`824`; `tC` value `255` | playback `255` | MATCH | | |
| Standard delay | `tC` `enableDefaultDelay` + `defaultDelay`; `NJ` clamp 5..65535 default 50 (`docs/MACRO_METADATA.md`); GLW defaults `["", 0, 50, true]` | per-slot checkbox + ms; local metadata file, not CMD 12/13 | MATCH on editor + local store | Trailing interval: `t_` time-then-action, `en` pairs action with **following** time. Fixed-delay stamps the previous action. | Unit: 100/230/570 → 130, 340. Mock: per-slot persist. |
| Record / Pause / Resume | `tI` 111/112/113; `t_` `active` + `e.repeat`; capture area after Record | Record/Pause/Resume; pin slot; pause on window blur, slot/tab/read/import/disconnect/apply; release-reservation prevents overflow | MATCH on mock-ui capture + pause | Capture is a focused box (not window-wide). No OS hook. Production does not bypass focus for untrusted events. Recorder reserves slots for key releases. | Mock: Record focus handoff; pause gap; orphan keyup ignored; release reservation. |
| Keyboard & mouse capture | Complete capture table from chunk 2233 module 94222 (`DOM_KEY_TO_HID` includes ContextMenu/Apps, Help, IntlRo/IntlYen, F13–F24, OS aliases, NumpadEqual/Comma); media entries `macroDisabled` omitted; mouse 0/2/1/4/3 → 1/2/4/16/8 | capture-area keydown/up & mousedown/up; palette items | MATCH | Production capture requires focus, ignores repeats and untrusted synthetic events without focus, pause flushes held inputs to avoid orphan events. | Mock-ui tests for representative keys & left click; unit tests for mapping. |
| Copy / paste / insert / replace / reorder / edit / delete | `tA` insert; `onSortEnd`; `changeActionItem` | row select, copy/paste (deep copy), Add/Insert/Replace honoring validated palette kind (mouse vs keyboard) with consistent keypress down+up pairing, up/down, toggle down/up, delay edit, delete; disabled while recording; prospective bank checks block overflow | MATCH for in-editor actions | Hub `copyMacro` copies a **whole slot**. App copies selected actions and supports in-place replacement and insertion of validated mouse and keyboard actions. Editing pauses capture first. | Mock paste to slot 1 + edit slot 0 isolation; mock and unit tests for Insert, Replace Selected, and prospective divergence checks. |
| Named macros + delay prefs | GLW `getMacroState` extended-custom-param-storage; `docs/MACRO_METADATA.md` | canonical `{ version: 1, slots: [16] }` schema in `macro-metadata.json`; atomic file swap; visible error toasts; profile export/import overlay | MATCH on local store | Not on-device flash. In-memory drafts survive disk errors. Rejects id fields, top-level arrays, and hardware action arrays. | Unit atomic save + isolated error tests; mock slot-switch + IPC validation. |
| Bank capacity & deduplication | readable lines 36460–36524 reuses offsets for duplicate action bodies; `docs/MACRO_METADATA.md` | Vendor-identical action-body deduplication in serializer (`src/protocol.cjs`), validator (`src/schema-validators.cjs`), capacity checks (`src/macro-draft.js`), and renderer edits/recordings; wire delay 0..4 normalization; prospective bank checks account for release reservation | MATCH (writes unproven) | Reuses body offsets across slots independently of playback header. Preserves reserved bytes 50..63 from existing buffers. Prospective bank-state check blocks divergence overflow fail-closed on every edit and recording event. | Unit normalization & boundary tests; adversarial transport zero-write & duplicate long macro writes; mock UI deduplicated apply & divergence rejection. Physical write unproven. |
| Reset recordings | `resetMacroActions` then `macroActions: []` on **current** macro | Reset current slot (confirm) | MATCH | Copy says “all recordings”; code clears the open macro only. | |

### 7. Performance

`iG()` in 1833. Mechanical layout still shows polling, debounce/combo, sleep, lock Win, Mac mode; RT-smart / stability / travel-check are feature-flagged (often magnetic).

| Hub control / action | Vendor evidence | App path | Status | Semantic gap | Verification needed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Polling rate | en `660`–`661`, `reportRateWarning`; `changeReportRate` | horizontal radios 1/2/4/8 kHz (`reporteRate` nibble), autosave on change | MATCH (mock-tested) | G75 V2 supports 1k/2k/4k/8k (rates 4, 3, 2, 1). SafelyUpdateReportRate suppresses generic warning; none is shown. Unknown nibbles are labeled `Unknown (n)` and omitted from field saves so they are not rewritten to 1 kHz. Global Apply is hidden. An explicit Read from Device remains for recovery. | Live read byte 4; mock write tested. Physical writes and rate-change reconnect unproven. |
| Debounce / “key combo mode” | en `664`–`665`; `iG` toggle `debounceLevel>=1` via `toggleKeyComboMode` | toggle reads `>=1`, writes `7`/`0` | MATCH (mock-tested) | Hub toggle maps debounceLevel >= 1; writes 7 (on) or 0 (off). Preserves raw intermediate debounce (1..6) on read until explicit user toggle. | Live read byte 7; mock write tested. |
| Sleep time | en `3050`–`3052`; slider **60–1800 s**, step 60 | slider 1..30 min (wire units 30s) + Never Sleep; commit-only write | MATCH (mock-tested) | Untouched raw `sleepTime` is labeled in real units (30 s, 2.5 min) without rounding the stored byte. Slider thumb may clamp to 1..30 min until the user adjusts. Unrelated field saves preserve the raw byte. | Live read bytes 35–36; mock write tested. Physical writes unproven. |
| Never sleep | `toggleNeverSleep` / `sleepMode`; GLW `setSleepTime` `{sleepTime, sleepMode:0}` | checkbox + enabled slider | MATCH (mock-tested) | Checkbox writes sleepMode 1/0 and preserves sleepTime. Display is 0 min while enabled; the slider stays usable. Changing the slider stages sleepMode 0 and unchecks Never Sleep. | Mock write tested. Physical writes unproven. |
| Lock Win | en `666`–`667`, `890` disabled in Mac | checkbox; disabled in Mac mode (translation 890) | MATCH (mock-tested) | Disabled in staged Mac mode; switching to Mac clears lockWin to false. | Mock write tested. |
| Mac mode | en `670` | OS Mode buttons | MATCH (mock-tested) | Switches layer and macMode byte 1; switching to Mac stages lockWin=false. | Live read byte 1; mock write tested. |
| Auto-check firmware | `toggleAutoCheck` / `travelCheck` field in `iG` (layout-dependent) | none | GAP-MISSING | Confirm whether G75 mechanical shows it. | |
| RT Smart / stability / bottom RT | en `662`–`663`; `featRTSmart` | none | MAGNETIC-ONLY unless G75 shows it | `isMechanical` still compiles those blocks behind flags. | Screenshot Other/Performance on G75. |
| Knob / roller type | FUNC byte 33 | preserved, no editor | GAP-MISSING vs hub if hub has a roller control | App intentionally does not edit. Hub `roller` hits are sparse in 1833. | Confirm G75 Other/Performance UI. |

### 8. Other tab: firmware and factory reset

`iF()` is the hub **Others** page.

| Hub control / action | Vendor evidence | App path | Status | Semantic gap | Verification needed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Keyboard FW version + upgrade | en `713`–`720`, `upgradeTip.requireConnectWire`; `iF` download/`pcUpdate`, boot-device flow en `1008` | Others tab: MCU version, wired-only target, local official package, review/confirm/cancel | MATCH in source (mock-tested; physical flash unproven) | Hub downloads `pcUpdate`. App requires a user-chosen file that matches the official catalog size/SHA-256. Boot packets are the traced flag-response updater. Physical boot descriptors and live flash remain unverified. | Mock review/cancel/confirm; unit hash/identity/restore. Live flash not required. |
| Receiver FW version + upgrade | en `740`–`742`, `upgradeTip.requireConnectWireless` | Others tab: RF version, 2.4G-only target, same review/confirm flow | MATCH in source (mock-tested; physical flash unproven) | 2.4G mode required. Same catalog-bound package rules as keyboard. | Same. |
| Download upgrade package | `iF` `pcUpdate` URL click | User-chosen local file; CSP `connect-src 'none'` | GAP-SEMANTIC | Offline stand-in for hub CDN download. File must still match the official catalog. | |
| Factory restore active / all | en `730`–`735`; `iF` → `restoreFactorySettings` | Others tab → `prepareFactoryReset` / `commitFactoryReset` | MATCH (mock-tested) | Wire: CMD **238** offset 0 size 1, data `[activeIndex]` or `255`. Active index from fresh GET_BASE, not the edit target. G75 `resetGlobalKeys` is a no-op. Vendor `er` init helper is **not** called. ACK alone is uncertain; `A2` / `FA FB FF` required to confirm. Local macro-name bank is an app policy (clear on confirmed all-profiles only), not claimed vendor metadata parity. Physical reset untested. | Live EEPROM/flash erase not observed. |
| Reset cloud/official library items | en `EQ.resetCloud*` | n/a | GAP-MISSING | Network libraries. | |

### 9. Device-mode and system extras in remap

| Hub control / action | Vendor evidence | App path | Status | Semantic gap | Verification needed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Bind key to factory reset | Generic registry only; absent from G75 `eG()` | omitted; existing tuples remain readable | NOT A G75 PALETTE GAP | See G75_KEY_GATING.md. | Physical writes untested. |
| Bind key to show battery | Generic registry only; absent from G75 `eG()` | omitted; existing tuples remain readable | NOT A G75 PALETTE GAP | See G75_KEY_GATING.md. | |
| Bind key to switch onboard | G75 `eG()` common controls | Extended: Switch Profile | MATCH (mock-tested) | Tuple [240,250,0]. | Physical writes untested. |
| Bind key to Win lock | Generic registry only; absent from G75 `eG()` | Settings toggle; existing key tuples readable | NOT A G75 PALETTE GAP | See G75_KEY_GATING.md. | |
| Mouse buttons / wheel as key | G75 `eG()` mouse set | Mouse category, 7 choices | MATCH (mock-tested) | Buttons type32; wheel type33. | Electron selection, simulated apply and reread passed. |

---

## Magnetic-only (not G75 V2 mechanical requirements)

Hub still contains these; `iX`/`l5` hide them when `isMechanical`:

- Trigger tab, Rapid Trigger, actuation/reset mm, dead zones, switch calibration, FPS/Extreme presets (`en` `365`–`427`, `510` DKS).
- DKS type 144, RS type 147, LT.

**Do not implement from magnetic docs.** If a live G75 hub build ever shows one of these, reclassify.

---

## App-only surfaces (not hub 1:1, not credit for omitted hub features)

| App surface | Notes |
| :--- | :--- |
| Overview / Guide tabs | Diagnostics + honesty matrix. Hub puts version/upgrade on Other. |
| Backup JSON | Native GLW backup JSON remains; official v3 KeyboardProfile is a separate import that creates a local library item. |
| Explicit Load for editing | Safer than hub preview; still a workflow difference. |
| Offline CSP | Blocks cloud/share/firmware CDN by design — **gaps remain gaps**. |

---

## Concrete gaps (G75 mechanical 1:1)

Highest user-visible holes versus the official mechanical hub:

1. **Firmware physical flash unproven.** Others tab can review a user-chosen official package (catalog size/hash, wired vs 2.4G target rules, backup → boot → erase → send → verify → return → version readback → restore) and cancel with zero writes. Mock/injected IO only. Hub CDN `pcUpdate` download remains deferred (`connect-src 'none'`).
2. **Factory reset physical behavior unknown:** CMD **238** + notification handling is implemented and mock-tested. Live erase regions, reboot, and receiver re-enumeration are unproven. Do not treat mock success as hardware proof.
3. **Profile ecosystem remaining:** game/app auto-bind is a host-side bundle-id table (mock-tested). Local library, onboard names (device-stored `i18n<defaultOnboard>` tokens display as `Default Onboard`/`2`/`3`; empty storage still translated locally; 16-char displays allocate unique 2–15 local names), tE/tI/tk/tg/tL, and official v3 file import/export (including MT/TGL table conversion) are implemented in source (mock-tested). Cloud/official/Apex **network** libraries and share-codes remain missing. Translation 870’s “six configurations” is stale; ordinary capacity is 20. Hardware name/profile writes are unproven on a physical keyboard. Do not treat green mock tests as physical parity.
4. **Lighting:** local still and GIF libraries are implemented in source (Normal/Custom tabs, still create/select/rename/delete, GIF import/edit/play, selectedLightEffect 241/242, 83-zone 300ms still persist, host CMD 221 GIF streaming). Cloud, share-code, and side still remain missing. Native GIF mapping is geometry-sampled, not a claimed vendor TRANSFORM_GIF clone. Automatic ordinary lighting field writes and per-effect memory remain implemented. Hardware 242/221 writes remain unproven. Music/share availability needs G75-specific tracing. G75 excludes side-follow-main and effect 23. See `G75_LIGHTING_SCOPE.md`, `G75_LIGHTING_PRESET_MEMORY.md`, and `G75_ANIMATION_PROTOCOL.md`.
5. **Key Config UX:** drag assignment, ordinary copy/paste/cut, one-key chord recording, and restore-defaults across loaded layers are implemented in source (mock-tested). Copy/paste/cut is an app clipboard, not a traced G75 menu. Macro/MT/TGL clipboard uses content snapshots (migrate or reject; never silent incompatible indexes). Macro paste revalidates body+playback inside the serialized keymap transaction. Autosave uses a serialized save gate with real IPC completion (no renderer `Promise.race` ownership clear). Planned tuples hydrate per-slot revision ownership captured at enqueue; dirty clears only for matching persisted revs. Profile Load drains pending saves and refuses a switch when dirty edits failed. Reset/disconnect invalidate queued identity before further local or HID work. WASD/all/invert remain magnetic Trigger-only. Physical CMD 9 unproven. Green mock is not physical EEPROM. See `docs/G75_KEY_CONFIG_WORKFLOWS.md`. This is not whole-project hub parity.
6. **Advanced:** three-column kind/list/tester UI and all-four-layer clear are implemented. Local MT/TGL/CB/SOCD use serialized fresh snapshots, revision ownership and post-persistence adoption. Actual A2 reset and both reconnect reload paths are mock-tested. G75 source exposes four SOCD priorities; generic simultaneous translations are not a proven G75 control. Knob/virtual function-key CB eligibility and physical writes remain unverified. Native keyboard diagram compresses the knob label; exact visual fidelity is unfinished.
7. **Macros:** 16-slot editor, pause/resume, validated Add/Insert/Replace honoring palette kinds and consistent keypress pairs, copy/paste, atomic canonical metadata persistence, recorder release-reservation, vendor-identical action-body deduplication (independent playback headers, wire delay 0..4 normalization, reserved bytes 50..63 preservation), and prospective bank-state preflight checks are implemented and mock/unit-tested. Physical writes remain unproven on live hardware.
8. **Performance:** two-column iG `et` cards, horizontal 1/2/4/8 kHz radios, commit-only sleep, Never Sleep resume, combo toggle, Mac/Win-lock coupling, and per-field autosave are implemented and mock-tested. Global Apply is hidden. An explicit Read from Device remains (recovery merge, not vendor-identical automatic write). Local preview still requires a connected device. Physical rate-change/reconnect behavior remains unverified.
9. **Physical writes** of every MATCH row remain **unproven** on hardware.

---

## Next implementation priorities

Order is “hub 1:1 for mechanical G75” plus “do not invent packets.”

| Pri | Work | Why | Constraint |
| ---: | :--- | :--- | :--- |
| 1 | Complete and verify the hub-style lighting controls, then package | Current source correction is in progress | Require real field-patch tests, all27 capability cases, and native visual QA. |
| 2 | Package and visually verify automatic lighting field writes | Source autosave and memory now pass unit/mock UI checks | Hardware mutation proof remains separate. Never run the vendor mutating support probe. |
| 3 | Cloud lighting library, share-code, and traced GIF file export envelope | Local still and GIF host playback are in source; cloud/share are not | Do not invent opcodes or an interchange format. Physical CMD 221 remains unproven. |
| 4 | Cloud/official/Apex profile libraries and share-codes | Local library and v3 files are in source; network libraries are not | Do not invent a cloud service. Ordinary capacity is 20, not six. |
| 5 | Key Config drag, clipboard, chord-record, restore-defaults | Implemented in source (mock-tested), including clipboard content snapshots, serialized autosave drain, and per-slot save-revision ownership. Remaining: physical CMD 9, traced G75 menu if a later hub build actually wires 20/21/24 | Do not add magnetic WASD/all/invert. Do not treat mock green as physical parity. |
| 6 | Advanced visual and hardware validation | Binding list/tester, clear and local queue semantics are implemented and mock-tested | Remaining: knob/virtual CB eligibility, knob diagram layout, physical mutations. See G75_ADVANCED_RESET_SCOPE.md. |
| 7 | Performance radio controls and automatic field writes | Implemented in source (mock-tested): radios, commit-only sleep, per-field autosave, failed-field retry ownership, delayed-read merge | Remaining: physical writes, rate reconnect, connected-required local preview, explicit Read recovery vs vendor auto-write. |
| 8 | Firmware updater live validation | Others UI is user-operable against injected IO | Physical boot descriptors, flag behavior, and EEPROM/flash remain unverified. Never silently retry an uncertain erase. |
| 9 | Hardware validation of implemented mutations | Mock tests are not physical proof | Use an explicit device-validation plan; no physical mutations have been performed during current development. |

---

## What tests do and do not prove

- `npm test` / `npm run test:mock-ui`: protocol framing, validators, in-memory GLW, renderer races. **Not** physical EEPROM/flash mutation.
- Packaged hardware sessions to date: **reads** (info, layers, advanced tables). **Not** Apply / Activate / Enable / factory reset / firmware.

End of inventory.
