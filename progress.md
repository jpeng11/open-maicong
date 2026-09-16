# Progress Log

## Session: 2026-09-13 (Advanced list / tester / clear-all)

### Phase 1: Vendor trace
- **Status:** in progress
- Static 1833 l6/l8/l9/l5/lJ/l0 and 2233 e1/e2/e5/ez/setUserKeys. No vendor execution.

## Session: 2026-09-13 (Performance autosave finish + root-review bugs)

### Phase 1: Vendor trace
- **Status:** complete
- Static iG `et` and 2233 eR/ej/eB/eF/eV/eU + SDK field patches. No vendor execution.

### Phase 2: Helper TDD
- **Status:** complete
- `src/performance-autosave.cjs` plus field-error ownership, `computeSaveStatus`, `ownedSentRevs`, `mergeReadSettings`.
- Unit: 394 passed / 0 failed (final `rtk proxy npm test`, 2437 ms).

### Phase 3: Renderer
- **Status:** complete
- Per-field errors; persist only sent revs; status from pending vs idle dirty; Read enqueued on settings gate and merge-by-rev.
- Global Apply remains hidden. Direct radios/toggles. Sleep commit-only.

### Phase 4: Mock UI + docs
- **Status:** complete
- Full mock UI: `rtk proxy npm run test:mock-ui` exit 0 in 113.47 s.
- Evidence: `/tmp/maicong-performance-implementation-evidence.md`
- Docs: `docs/G75_PERFORMANCE_SCOPE.md`, `docs/PARITY.md` updated honestly.

## Errors
- GET delay 1400ms exceeded 800ms read timeout → 500ms.
- Extra local copy poisoned later `localTitles.length >= 2` → delete copy; wait for count+1.
