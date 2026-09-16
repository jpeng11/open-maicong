## 2026-09-13 Advanced release — 406 tests

Packaged the Advanced function/list/tester layout, all-layer clear, strict CB metadata preservation, reciprocal SOCD cleanup, serialized local shared-table planning, and revision-owned post-save adoption. Final reset-harness correction passes the current transport epoch at both synthetic reconnects; reload assertions verify completion, hydration and generation advancement.

- Final unit suite exit0: 406 passed, 44 suites, 0 failures; 2239.338333 ms.
- Final full mock UI exit0: Renderer integration against mock memory passed. Source: /tmp/maicong-luna-reset-review.log, terminal CLI session67934 exit0. Actual A2 Advanced and delayed-keymap reset regressions retained.
- Arm64 build exit0. All27srcfiles byte-match ASAR. ZIP825entries integrity passed; hdiutil DMG checksum valid; workspace copies SHA256-match stage.
- Native exact-package read-only launch recognized G75 V2 receiver3837:3033, battery100%, MCU1.14/RF1.30, active/edit1 layer2. Advanced tab and screenshot inspected; app quit. No physical mutations. The knob label is visibly compressed and remains a visual fidelity gap.
- DMG SHA256: ac329caf6f0551a03d02972306b9aa14ee6987f612986e474fcc126b03098642
- ZIP SHA256: b8b7508ad45bddc509d01f4ceb387a2e0ba98bb4070e7effe2c42f4cfff4ce5d
- Full hub parity and physical mutation proof remain incomplete. App unsigned/unnotarized. AGY reserved.

## 2026-09-13 Advanced local queue correction

This increment fixes serialized local Advanced planning for shared MT/TGL tables and CB membership. The worker now snapshots shared state after its predecessor completes, preserves request identity and slot-revision ownership, adopts tables only after a successful local profile save, and rolls back owned bindings when that save returns or throws an error. Hydrated local layers are isolated from the last-valid snapshot so later failed drafts cannot mutate persisted state by alias.

- `rtk npm test`: exit 0 — 406 passed, 44 suites, 0 failures, 2239.338333 ms.
- `rtk npm run test:mock-ui`: exit 0 — `Renderer integration against mock memory passed.` The run includes queued distinct MT definitions, sequential CB membership, clear→apply ordering, local-save failure honesty, delayed profile-switch draining, an actual unsolicited A2 reset notification, newer ordinary drafts, and zero-HID assertions.
- Final review follow-up corrected the remaining synthetic reconnect omission: both mock `installTestAdapter` reconnects now pass `transport.resetEpoch` into the renderer harness before a profile reload; reload checks require settled load, connected identity, keymap hydration, and edit-generation advancement.
- No package/build was produced and no physical keyboard was accessed. Full web-hub parity remains unfinished.

## 2026-09-13 Performance autosave release — 394 tests

Performance controls now save individual fields automatically: supported-rate radios, sleep commit, Never Sleep, Mac mode/Win lock and combo. Per-field failure ownership and delayed-read merge fixes passed isolated source probes and integrated regressions.

- Final unit suite: 394 pass, 44 suites, 0 failures, 2437.237708 ms.
- Full Electron mock UI: exit 0, 113.470485 s (06:13:47–06:15:40 UTC). Includes prior Key Config and profile workflows.
- Arm64 DMG/ZIP build exit 0; all 26 src files byte-match packaged ASAR. ZIP 825 entries integrity verified; hdiutil DMG checksum valid; copied artifacts hash-match stage.
- Native read-only QA launched the exact staged app, detected receiver 3837:3033, battery100%, MCU1.14/RF1.30. Performance screenshot confirmed two-column layout, 1/2/4/8 kHz radios, sleep3min, Mac selection, disabled Win lock. Only tab navigation was used; no setting mutations. App quit afterward.
- DMG SHA256: 6c75e705c1bb60eb84729e45011dde7a30f9b0b0d3b0ea5f984916684eb38972
- ZIP SHA256: 32c7bd18df63edbf4384d8908160f6da60bc831edf0806c8f8221c8bc07882db
- Full hub parity, physical setting writes and rate reconnect remain unverified/incomplete. AGY reserved. App unsigned/unnotarized.

## 2026-09-13 — Key Config release (379 tests)

Packaged drag assignment, clipboard content identity, shortcut recorder, restore defaults, serialized saves, per-key revision ownership, stale-session rejection, and local snapshot safeguards. Full unit suite: 379 passed. Full mock UI: completed exit 0 (112.424709s). These checks do not prove physical writes or full web-hub parity.

Apple Silicon build completed exit 0. All 25 packaged source files match the workspace. ZIP integrity verified (825 entries); hdiutil verified DMG. Native app opened from the new staging bundle: receiver 0x3837:0x3033, battery100%, MCU1.14, RF1.30, active/edit profile1, layer2. Key Config tab and screenshot inspected; no physical settings changed. App quit afterward.

Artifacts copied to dist and SHA256 readback matched:

- 8fe406a05d7fd8c9204d7618417b4d276e0e6f1862264e4faad32cbf0de1080e  Maicong Studio-0.1.0-arm64.dmg
- c2bc846fc70ca5368c8c74b94cb7e0b2ab7fa02665b1e0f52826e436f47b5eba  Maicong Studio-0.1.0-arm64-mac.zip

# Profile library release validation — 362 tests

Native local profile library, official v3 import/export, MT/TGL table conversion, macro timing/type preservation, valid local default names and translated stored profile tokens.

- Full unit suite: 362 passed; full mock UI terminal exit 0, 108.99728 seconds.
- Root independently reproduced and verified fixes for consecutive macro delays, malformed settings and playback-type deduplication.
- Packaged arm64 build exit 0; all 24 src files match app.asar; ZIP 825 entries integrity checked; hdiutil DMG verification passed. Delivered copies match stage SHA-256; see dist/SHA256SUMS.
- Native read-only QA of exact packaged app: G75 V2 2.4 GHz receiver 0x3837:0x3033, battery100%, MCU1.14/RF1.30, active Profile1, translated Default Onboard/2/3 labels and dropdown. Screenshot inspected. App quit after inspection. No keyboard configuration changes performed.
- App remains unsigned/unnotarized. Physical writes for newly implemented profile operations remain unproven. Cloud/share/firmware and full web-hub parity remain incomplete.

# GIF library release validation — 309 tests

Standalone arm64 macOS release built from the corrected GIF implementation. Full web hub parity remains incomplete.

- Unit suite:309 passed. Final mock UI run completed exit0 (108.012976s).
- Build exited0. All19 packaged source files byte-match the tested workspace; test files excluded. ZIP825 entries valid; DMG hdiutil verification passed.
- Native packaged app read-only inspection: G75 V2 receiver3837:3033, MCU1.14/RF1.30, battery100%, active Profile1. Lighting Custom shows Static0/20 and GIF0/20 with Import GIF and correctly disabled Play/Stop. Layout visually inspected after scrolling. App quit after inspection. No physical configuration writes or GIF streaming performed.
- GIF import/editor/playback tested against mocks; physical CMD221/242 unproven. Native geometry mapping is not a traced TRANSFORM_GIF clone. Profile ecosystem, firmware, cloud/share and other inventory gaps remain.
- DMG SHA256:61a856b39989c1408cfe461b2c99db51fc5466a578ab1393f78fe0e78429fcb9
- ZIP SHA256:b13eaf07251bf1b6dc4d6537c1608830b6772e55fcee1fb404bb14d622d3ad65

## Previous validation history

# Maicong Studio 0.1.0 validation

Validated on 2026-09-12 on Apple Silicon macOS.

## Current package: local static lighting library

252 unit tests across30 suites and the full Electron mock UI suite passed. Grok's final UI run exited0 in101.34s; AGY independently reviewed the code and reran both suites successfully. Tests cover create/select/rename/delete,20-item capacity,2–15-character names, split-space301/302 and Fn1 aliases, malformed-file preservation, validation before normalization, partial242 failures, per-profile confirmed names, delayed paint/switch, and stale responses after disconnect/Load.

The arm64 package built successfully. All16 bundled source files match the tested workspace byte for byte, with no tests bundled. All825 ZIP entries and hdiutil DMG validation passed. Native packaged launch read the real G75 V2 receiver0x3837:0x3033, MCU1.14/RF1.30, battery100%. Lighting showed Key Firework, and the Custom tab displayed Static Lighting0/20 and Add Static with the83-zone canvas. No effect was created, selected, painted or written during native QA. A create-dialog inspection was interrupted by a UI focus change and is not claimed as native verification; dialog behavior is covered by mock UI.

Artifact SHA-256:
- DMG: `9648b8cf49915103945b7d138ae1841e20f712ef5050bc31c94d05f73cfc5d69`
- ZIP: `a008b4728b9e1aaaea6d857ec8b2ad1cf633cf665f4f6ac5e2d277eba0db074a`

The app remains unsigned and unnotarized. GIF playback/editor, full profile ecosystem, cloud/share/official libraries and firmware update remain incomplete. Physical configuration writes remain unverified. This release does not establish full webhub parity.

## Previous package: lighting autosave and effect memory

221 unit tests passed across25 suites; full Electron mock UI exited0. Coverage adds per-effect memory byte preservation and strict import validation, explicit device/local persistence, ordinary lighting autosave cadence, memory-warning isolation, Read/Retry recovery, queued calibration/preferences, stale getter protection, and Load serialization across delayed writes, repeated requests, reset and disconnect.

The valid delayed-save regression uses two1400ms replies, keeping individual packets within their1500ms timeout while holding the worker beyond2500ms. Load subsequently reads the selected profile and does not write its configuration. A20s drain timeout prevents Load from starting.

Built arm64 DMG/ZIP successfully. All15 bundled source files match the tested workspace byte for byte; no test directory is bundled. All825 ZIP entries and the DMG integrity check passed.

Native verification of this package connected to G75 V2 receiver0x3837:0x3033, MCU1.14/RF1.30, battery100%. Read from Device restored lighting with enabled controls. Main showed Key Firework, brightness100%, speed4 and disabled solid color; Side showed Breath, brightness100%, speed4 and enabled red color. Remembered effects displayed On keyboard/This Mac. No lighting preset, slider, memory preference, activation, reset or firmware mutation was performed. Ordinary lighting controls now autosave, so prior local-draft-only native checks below apply only to older packages.

Previous artifact SHA-256:
- DMG: `a0dd0057fc6adc399e2b397c540d7deb394c0b74a1318cda50290872dc8d295c`
- ZIP: `7b41f54945b15b61e9e3c1278310af56c8fbe6b2e06ea066f467b946e1a810a3`

Full webhub parity remains incomplete; see docs/PARITY.md. Hardware mutation behavior remains unverified.

## Historical verification before autosave

- Previous lighting release: full unit suite179/179 and full Electron mock UI exited0. Independent fixtures cover23 main effects (22 preset tiles plus Custom),4 side effects, four direction label families, color capability/switch gating, unknown effect preservation through field-patch Apply+reread, failed-read/apply/disconnect/reset guards, delayed Read/Apply/white-balance request identity, and stale-broadcast invalidation. Layout regression scrolls to and selects final effect17 at1080×740 and1320×900, checking pane, outer workspace and viewport clipping. The grid row now shrinks so lower effects are reachable.

- 179 unit and adversarial tests passed across 21 suites, with no failures or skips, including factory-reset packet scope, stale-target/identity/generation/epoch rejection, ACK-only uncertainty, notification-before/after ACK, unsolicited connection abort that stops later multi-chunk writes and queued packets, old-handle data/error isolation, pre-dispatch abort of CMD 238, accurate dispatched outcomes (lexical per-attempt flag, refusal vs throw-after-write vs post-write disconnect), disconnect/no-retry, late notification not confirming success, queued-write invalidation, and macro-metadata policy (confirmed hardware / failed local cleanup).
- Electron mock UI integration passed, covering profile/layer races, CB and advanced edits, malformed imports, macro metadata, recording focus, mouse actions, pause/resume, action insertion/replacement, release reservation, shared-offset capacity, divergence rejection, real rendered palette assertions across all 4 layers (L0: 185, L1: 184, L2: 169, L3: 168 items), representative key selections (Mouse, Wheel, Main light, Side light, Win/Mac shortcuts) with wire apply and reread verification, keymap edit provenance enforcement (failed read/disconnect strictly blocks Apply and writes without manufacturing hasReadKeymap), atomic layer replacement ([0, 0, 0] Disabled and [16, 0, 0] Clear without stale leftovers), full-tuple consumer label decoding, and Others-tab factory reset against mock memory (cancel/Escape send no CMD 238; active copy names Profile 1 and mentions editing only when it differs; all-profile copy never says the editing profile is excluded; changed active while the dialog is open is rejected; commit disables export/cancel/reentry; rejected commit IPC invalidates editors and does not claim the reset did not run; unsolicited reset invalidates settings/lighting/keymap/macros/advanced without a click and stale lighting completion cannot restore them; active confirm uses hardware-active index 0 while editing profile 3; all-profiles confirm sends 255).
- Macro names and standard-delay preferences use canonical local metadata, atomic replacement and visible save failures. They are excluded from hardware macro bytes.
- Identical normalized action bodies share memory offsets independently of playback mode. Prospective edit and recording checks protect the 8192-byte bank; pending releases use a separate capacity budget without fabricated actions. Untouched header and tail bytes remain preserved.
- The standalone packaged app connected to the attached G75 V2 2.4 GHz receiver (VID 0x3837, PID 0x3033), read MCU 1.14 / RF 1.30 / battery 100%, and read the physical macro bank.
- Native UI verification: Record focused the capture area; a local A keystroke produced KEYDOWN A at standard delay 50 ms and KEYUP A at delay 0. Pause showed two actions and Resume. Rereading the device discarded the local test draft and restored the original empty slot.
- No physical configuration writes, activation, reset, pairing or firmware flashing were performed. Mutating protocol checks use simulated memory with readback verification.

- Performance verification: Electron exercised every sleep minute, Never Sleep slider resume, raw 30-second/2.5-minute display and preservation, unknown-rate preservation, combo 0/7 toggles, Mac-mode Win Lock clearing, failed-read/apply guards, and the two-column page at 1080×740 and 1320×900. Both test commands exited 0. Final copy-only edit simplified the unknown-rate explanation, and the full Electron mock integration rerun passed afterward.

## Distribution

Apple Silicon arm64, macOS 13 or later. Unsigned and unnotarized local build. The app includes its runtime and does not require Node.js or npm.

Builds are staged in a path without spaces because node-gyp fails under the original Extreme SSD path. The final DMG passed hdiutil verification, all 825 ZIP entries passed integrity checks, and all 13 shipped source/data files matched the project byte for byte. No test harness files were bundled. SHA-256 values are in dist/SHA256SUMS.

The final packaged macro page was visually checked at 1080×740 and a larger window size. The compact layout keeps the scrollable slot list beside the editor; toolbar controls wrap, and the Add Action row remains reachable by scrolling. The CSS-only final pass also reran all 135 unit tests successfully. The macro page was checked in the prior macro build. The earlier palette build was opened against the receiver and left on Key settings. Mouse and Mac Extended categories rendered correctly; staging A → Left mouse button changed the local inspector, and Read Layer restored A without applying any physical write. All four palettes and representative assignments were exercised against simulated hardware in Electron.

The earlier performance build was opened against the attached receiver: 8 kHz, 3-minute sleep, Mac mode, Win Lock disabled. A local Never Sleep draft showed 0 minutes; increasing the slider resumed timed sleep at 4 minutes. Read from Device discarded the draft and restored the original 3-minute setting. No Apply was clicked. Native visual checks passed at 1080×740 and a larger window; that build was left open on Performance. Its DMG/ZIP checks passed, and all 13 bundled source/data files matched the reviewed source.

The earlier factory-reset build was opened against the receiver and read MCU 1.14, RF 1.30 and battery 100%. Native Others-tab review verified: active reset names Profile 1 with matching edit target; after loading Profile 3 for editing only, active reset still names Profile 1 and explains the difference; all-profile reset includes every profile without excluding Profile 3. Cancel and Escape closed the modal and returned focus to their opener. No confirmation button was pressed. The edit target was restored to Profile 1, hardware-active Profile 1 remained unchanged, and the app was left on Others. Screenshots confirmed centered readable dialogs and the light hub styling. The 173-test source was byte-matched against the rebuilt archive before starting the subsequent lighting UI work.

The previous lighting package was opened against the receiver and read MCU1.14/RF1.30/battery100%. Native scroll gestures reached the final effect tile. Selecting Key Beam changed only the local draft; Read from Device restored the hardware Key Firework selection. Main and Side controls showed separate states and correct color-switch gating. No Apply was clicked. Hardware-active/edit target remain Profile1, Layer2; app left on Main lighting. Minimum/large layout coverage comes from Electron tests, with native scrolling additionally observed at the current window size.

Previous artifact SHA-256:
- DMG: `4bf2a8dbfc01b44d9dd4c842f795e87624b31690392091a70d4f7cf7d8e1b638`
- ZIP: `2add6c28c16f00276bc363832e58cabcd1256d73c3a11f728958afa7e8be4fe9`

## Limits

Wired USB is implemented but physically untested. Factory reset is implemented on the Others tab and mock-validated (CMD 238, notification completion, stale-target/epoch rejection, unsolicited invalidation); physical reset has not been performed. Firmware upgrades remain unsupported. This is not full web-hub parity. The runtime remains standalone and offline, without an embedded webhub. Model-specific lighting evidence is in docs/G75_LIGHTING_SCOPE.md. Still/GIF libraries, remembered per-effect settings, automatic field writes, profile libraries and firmware updating remain missing or incomplete. Animation transport research is in docs/G75_ANIMATION_PROTOCOL.md; it is not an implemented feature.

## Implementation models

Implementation used AGY Gemini 3.8 Flash High via CLI, with Grok 4.6 xhigh via CLI while AGY quota was exhausted. AGY resumed after quota became available and completed the macro and G75 palette review corrections. AGY implemented the performance cards, then exhausted its quota; Grok 4.6 xhigh completed the performance review and verification. Grok 4.6 completed this factory-reset review correction (transport dispatch/invalidation, renderer copy/lifecycle, mock-ui). Grok also implemented and corrected the current lighting controls, request ordering and scrolling. Luna was not needed.
