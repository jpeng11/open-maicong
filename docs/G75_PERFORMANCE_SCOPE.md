# G75 V2 performance controls

Static vendor evidence inspected 2026-09-12. Public UI chunk 1833-29e749719b751fa6.js function iG (local excerpt /tmp/maicong-performance-source.txt), provider chunk 2233-7ba109b328b2b69b.js, SDK /tmp/maicong-cz-readable.js. Assets are reference-only, not executed or shipped.

G75 mechanical + featLianji selects iG layout et: left Polling Rate and Sleep; right Win Lock, Mac Mode, Key Combo Mode. Auto-check/travelCheck, RT/stability are not in this mechanical layout. SDK lines 46835–46880 sets G75 isMechanical, featRate8K true, featLianji true. G75 catalog featSupport.SafelyUpdateReportRate=true, with no 16K/32K support. iV offers wire values 4=1k,3=2k,2=4k,1=8k. The generic rate warning is hidden when SafelyUpdateReportRate=true; do not add an unsupported warning or higher rates.

Sleep control is slider min60,max1800,step60 seconds; displays minutes. Stored sleepTime units30seconds. Provider ej passes seconds/30. Never sleep maps sleepMode1/0 and display0 when enabled. Preserve previously read raw sleepTime unless the user changes it (older 30-second values must not silently round during unrelated edits).

Key combo mode reads debounceLevel>=1; provider eF writes enabled7 or disabled0. Other raw levels remain readable and must be preserved until the user toggles the control.

Win Lock is disabled on Mac layer (iG isMacModeLayer), with tooltip translation890. Provider eU switches macMode to OS layer2 or0 and, when enabling Mac, calls eV(false), clearing Win Lock. The standalone editable target must stage both fields together, preserve read state until explicit edit, and avoid writing the physical device during development.

The official provider uses automatic field updates. The app currently uses explicit read/apply staging; this interaction difference remains outstanding and must not be claimed as exact parity. Rate reconnect behavior and physical writes are also not verified by this scope.

## SDK field behavior

Chunk2233 GLW setSleepTime at byte140200 updates BOTH sleepTime and sleepMode:0. The iG slider is not disabled by Never Sleep; it displays0 and a user slider change resumes timed sleep. Therefore keep the slider usable after a successful read even when Never Sleep is on, and stage sleepMode0 whenever the user changes its time. The earlier phrase disabled/0 in implementation briefing should be interpreted as display0, not disabling the slider.

GLW setReportRate at byte140671 merges reporteRate onto parsed funcConfig. Helper es at byte157124 with updateReportRate=true rewrites byte4 from unchanged tickRate plus new rate, and byte38 from unchanged report_rate_2_4G. No extra update flag is set. Existing mutateSettings preserving byte4 high nibble and byte38 matches this operation. Safe-update capability suppresses generic warning for G75; physical reconnect behavior remains untested.

## App implementation (mock-tested)

Two-column Settings layout matches iG `et` at the 1080×740 minimum and at the default 1320×900 window: left Polling Rate and Sleep, right Win Lock, Mac Mode, and Key Combo. Rate is a horizontal 1/2/4/8 kHz radio group. G75 `SafelyUpdateReportRate` is treated as true: no generic rate warning and no 16 kHz / 32 kHz options. The global Apply control is hidden; each control saves on its own through a serialized per-field worker.

Sleep label reports the stored `sleepTime` in real units (30 s for wire 1, 2.5 min for wire 5, integer minutes when even). The 1..30 minute slider thumb may clamp, but an untouched raw value is not rewritten. Sleep writes on commit only (`change` / `onChangeCommitted`), not while dragging. Never Sleep shows `0 min` and keeps the slider enabled after a successful read; moving the slider stages `sleepMode` 0 (GLW `setSleepTime`) and unchecks Never Sleep. The checkbox still writes `sleepMode` 1/0 without changing `sleepTime`.

Key combo reads `debounceLevel >= 1` and writes 7 or 0 only on an explicit toggle. Mac mode stages `lockWin` false and disables the Win Lock control. Unread, disconnect, in-flight load, and failed reads without a newer draft clear `hasReadSettings` and disable the controls; UI events cannot manufacture provenance. A failed field save keeps the editor enabled, keeps that field dirty, and shows Retry. An unrelated successful field save does not clear that error or leave status stuck on Saving. A delayed Read merges only fields whose revision still matches the snapshot taken at dispatch; newer edits and a failed read that races a newer draft are kept. Unknown `reporteRate` nibbles are shown as `Unknown (n)` and omitted from field saves so they are not rewritten to 1 kHz; choosing 1/2/4/8 kHz then includes that nibble.

Local custom-profile preview persists settings to disk with zero HID, keeps unowned dirty values at last-valid, and profile Load drains the worker then refuses a switch while settings are dirty or in error. `canEditSettings` and save identity still require `connected`, including while previewing a local profile — that is the existing product contract, not fully offline local edit.

An explicit Read from Device remains for recovery; it is not a claim of exact vendor-automatic parity. Physical HID writes, polling-rate reconnect behavior, and full app hub parity are not claimed.
