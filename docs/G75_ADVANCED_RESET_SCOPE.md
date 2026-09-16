# G75 advanced-key clear-all scope

Static vendor UI evidence inspected 2026-09-12. No vendor code executed or shipped; no physical key or advanced table writes performed.

UI chunk1833 `ix` provides the layer buttons and restore/clear button. It calls context `resetAllKeys`, then closes its confirmation dialog; the dialog uses locale181 on Key settings and182 on Advanced keys. Advanced-key layer buttons disable odd Fn layers in this UI. The dialog text alone does not establish scope.

The GLW provider in chunk2233 implements `resetAllKeys:e5`. It iterates **all four layers** via `W()(u.F$).map`, passing each layer to e2 and filtering each position by current tab: Key settings resets positions that are not advanced (`!h(t,e)`), Advanced keys resets positions recognized as advanced (`h(t,e)`). It also filters global keys unless global editing is enabled; the actual G75 layout has no global-key flags (see RESET_PROTOCOL.md). Therefore a faithful advanced clear-all action concerns every advanced binding across four layers of the current profile, not merely the visible selected layer or one table. It is not factory CMD238.

Helper e2 forwards to e1 for the supplied layer. In e1, reset positions are replaced with the corresponding **layer-specific default key** (`i[layer][index]`), removed from that layer's customParam.cbKeyIndexList, and SOCD positions also schedule priority0 via the trigger metadata update. Then es writes the changed layer. Do not clear all raw key bytes, replace every layer from Win defaults, erase unrelated ordinary remaps, or mistake the global shared macro region for a per-profile advanced list.

The shared-reference and reserved-byte constraints remain enforced when deciding whether MT/TGL/extra records can be reused or cleared. Bulk reset must invalidate drafts and reject stale profile/connection state, report partial failures honestly, and never label an unconfirmed multi-write operation atomic. The hardware mutation path must be exercised only with mocks until explicitly authorized live testing.

## Advanced local queue correction — 2026-09-13

Local Advanced apply, remove, and clear operations now capture the requested spec, profile/source identity, reset epoch, and slot revisions before entering the serialized keymap save gate, but take the shared MT/TGL/extra/customParam snapshot inside the worker. A queued successor therefore plans from the predecessor’s adopted tables and CB membership instead of allocating a duplicate shared index. The result is merged only into the slots it named; newer ordinary drafts remain protected.

The local persistence boundary keeps the 56-byte CB region as top-level `customParam.raw` and keeps only `mt`, `tgl`, and `keyExtras` in the persisted `advanced` object. Advanced tables and bindings are adopted into the renderer only after the profile save succeeds. A returned or thrown local-save failure rolls back the owned binding changes and leaves the last-valid tables, CB metadata, and local snapshot unchanged.

The mock UI now covers two queued distinct MT definitions, sequential CB membership, clear→apply ordering, delayed profile-switch draining, an unsolicited A2 reset during a delayed local apply, newer ordinary edits, zero-HID local applies, and failed local-save honesty. It does not establish physical mutation safety or full web-hub parity; those remain outside this increment.

Final review follow-up: an authoritative mock exit1 was traced to the older key-config reconnect after reset-during-save, which reinstalled the mock transport but called `setDeviceConnected(true)` without its new `transport.resetEpoch`. The Advanced reconnect already supplied the epoch; the key-config reconnect now does too. The final reload assertions require completion, connected identity, keymap hydration, and a new edit generation.
