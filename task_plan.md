# Task Plan: G75 V2 Advanced-tab list / tester / clear-all

## Goal
Bounded Advanced-tab parity pass: hub three-column UI (SOCD/MT/TGL/CB cards, aggregate bound-key list with count/40, edit + per-item delete confirm, focused-app keydown/keyup tester), then clear-all across four layers using layer-specific defaults after tracing setUserKeys. Preserve ordinary remaps, shared MT/TGL tables, reserved bytes, CB metadata, SOCD extras except cleared-slot priority 0. Not factory CMD 238. No simultaneous-SOCD control (lJ/l0 only priorities 0..3). Mock only. Do not claim full hub parity.

## Current Phase
Phase 1 — in progress.

## Phases

### Phase 1: Vendor trace + existing patterns
- [x] Static read of 1833 `iG` layout `et` (mechanical + featLianji)
- [x] Static read of 2233 `eR`/`ej`/`eB`/`eF`/`eV`/`eU` and SDK `setReportRate`/`setSleepTime`/`setMacMode`/`setDebounce`/`setLockWinKey`
- [x] Inspect Key Config slot-rev ownership and lighting serialized worker
- **Status:** complete

### Phase 2: Performance autosave helper
- [x] Field revisions, identity, patch build, settle, local-persist merge, sleep commit, Mac+lockWin coupling
- [x] Unit tests including ABA and failure dirty
- [x] Field-error ownership, idle-vs-pending status, sent-only persist, read-merge (root-review bugs)
- **Status:** complete

### Phase 3: Renderer + UI
- [x] Radios, two-column cards, commit-only slider, hide Apply
- [x] Fix unrelated success wiping failed-field error/retry and sticky `saving`
- [x] Fix delayed `handleReadSettings` wiping newer edits/revs
- [x] Serialized per-field saves, reset/generation guards, local-preview zero HID, profile-switch drain
- **Status:** complete

### Phase 4: Mock UI + docs + evidence
- [x] UI regressions: failed A + successful B, stale skip, coupled Mac/sleep, delayed read, local persist/drain
- [x] Run unit + full mock UI to terminal completion
- [x] Honest remaining limitations in PARITY / G75_PERFORMANCE_SCOPE
- [x] Evidence `/tmp/maicong-performance-implementation-evidence.md`
- **Status:** complete

## Constraints
No AGY, no subagents, no vendor execution, no webhub, no physical HID, no reset/flash/pairing/permission changes, no packaging. CSP `connect-src 'none'`. Shell via `rtk`. Unit suite this pass: 394 passed (was 388 helper-stage).

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Delayed-read mock used 1400ms GET vs 800ms readFuncConfig timeout → reconnect, save `error` | 1 | Drop GET delay to 500ms |
| Official import HID assert 173≠0 because extra local copy made later `localTitles>=2` return before copy finished | 2 | Delete copied local after the preview test; wait for title count +1 on copy |
