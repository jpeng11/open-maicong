# G75 V2 reset protocol evidence

Inspected 2026-09-12. Public SDK source: https://www.mchose.com.cn/cizhou/CZ_SHARED_DATA/main.348b62de2cbadb6bbe3e.js (readable local reference /tmp/maicong-cz-readable.js). Reference assets are not shipped. No physical reset was performed.

## Wire operation

GLW channel restoreFactorySettings at readable lines 22782–22812 calls _simpleSendCommand(238, 0, [scope]). scope is 255 for all/null, otherwise the numeric profile index. Wrapper at 35890 forwards to the same channel. Standard framed packet builder applies. Do not use QHW restore/notifyReset methods from other device classes.

## User scope

Official mechanical UI (1833 chunk, iF component) offers reset-active versus reset-all. Active uses profile.activeIndex, not the currently selected local editing profile. It calls resetGlobalKeys before restoreFactorySettings; the semantics of that helper and post-reset storage restoration must be traced before declaring parity.

## Completion and unsolicited reports

GLW handleMessage at readable lines 19835–19900 emits reset for input starting A2, or FA FB FF. It also reports profile change on A1 (index byte2), pre-notification on A4, and config update on A3. Ordinary AA command acknowledgments are not themselves a reset-completion notification. The UI provider in 2233 chunk waits for reset and uses an 8-second fallback reload.

## Implementation requirements

- Explicit user-facing choice and confirmation that names active profile or all profiles, and offers export first. Implement the control without performing a physical reset during development.
- Validate scope, serialize with all HID operations, bind identity and generation, and resolve active scope from fresh base data within the operation.
- Never retry an uncertain destructive command automatically. A lost ACK can follow a successful reset; report uncertainty and allow read-only reconnect/inspection.
- Invalidate stale configuration caches/drafts after reset notification, timeout, disconnect, or uncertain result. Do not accidentally reapply pre-reset data.
- Preserve physical verification as outstanding until explicitly authorized and observed. Mock command tests do not establish reset firmware behavior or exact erased regions.
- Trace official post-reset global-key and local-storage handling before completing the feature.

## Additional provider trace

In 2233 chunk the GLW provider handleResetActive calls restoreCustomParamStorage(profileIndex). handleResetAll clears custom parameter storage for all profiles, several local storage keys, and runs the initialization helper er before reloading. The UI resetGlobalKeys helper e3 identifies keys with isKeyItemGlobalKey, constructs default bindings for every layer, and delegates to spreadUserKeysToAllProfiles. Thus a faithful reset flow includes global binding/storage handling; implementing only CMD238 would leave part of the official workflow missing. Exact relevant global keys and initialization effects still require a scoped trace.

## Additional initialization trace

In public UI chunk `2233-7ba109b328b2b69b.js`, the relevant **async** `er(e,t,n)` begins at byte offset 234225 (do not confuse it with the synchronous lighting decoder named `er`). It reads base/profile capabilities, selects shared 8192-byte macros for G75 V2, reads per-profile feature support, synchronizes macro metadata by `macroUpdatedAt`, synchronizes names by `profileNameUpdatedAt`, initializes default onboard names when the timestamp is zero, and reloads default keys. These may perform writes; this helper is not merely a UI reload. Its local macro fallback can restore prior browser macros when device macros are empty, so a standalone reset must deliberately avoid accidentally restoring pre-reset user data.

The global-key predicate in the same chunk reads `Y[index].isGlobalKey` from the rendered key model. Determining which G75 V2 entries carry that flag remains necessary before reproducing the pre-reset global-key step. No reset or configuration writes were performed during this trace.

The downloaded G75 V2 layout module `/tmp/maicong-cz-layout-g75_v2.js` has no explicit `isGlobalKey` properties. The layout export applies an identity transform. The common key-model builder still needs inspection for injected global flags before concluding that resetGlobalKeys is a no-op for this device.

## G75 global-key scope resolved

The actual web UI G75 layout is chunk3497, module53497, at https://www.mchose.com.cn/cizhou/_next/static/chunks/3497.a41d76142000c8a3.js (9018 bytes; saved reference only). It has no isGlobalKey entries and ends with the identity transform e=>e. The provider key-model path at chunk2233 byte415350 uses module57637 export aj, which only filters existing layout entries by hidden tabs; it does not inject flags. The predicate then reads each entry.isGlobalKey directly. Therefore resetGlobalKeys selects an empty set for this G75 layout and its t.length>0 guard prevents spread writes. The optional RTDoubleClick companion can only extend an already-selected global key, so it does not change the empty result.

This resolves the pre-reset global-key gap for the inspected G75 build. Remaining reset implementation should preserve the explicit active/all scope, local metadata policy, generation invalidation and uncertain-completion behavior described above. Do not call the vendor initialization helper after reset: it can restore old macro data. Physical reset behavior remains untested.

## Implemented in this tree (mock-validated)

Standalone Others tab + accessible confirm dialog. Transport `prepareFactoryReset` / `commitFactoryReset`:

- CMD **238**, offset **0**, size **1**, data `[activeProfileIndex]` or `[255]`. Active index is `GET_BASE` `profileOrder[activeSlot]`, read fresh inside the commit transaction. The local edit-target is never the wire scope.
- Review/commit is bound to HID identity (path, VID/PID, serial, interface, firmware raw) and connection generation. A changed active profile or identity at commit is rejected; no packet is sent.
- Reset notifications `A2` and `FA FB FF` are decoded **outside** 0x55/0xAA framing. Observation is registered **before** dispatch. Notification-before-ACK is success when the ACK also arrives. AA ACK alone is **uncertain**, not confirmed. No-notification timeout is never success. No automatic retry after dispatch, lost ACK, or disconnect.
- After dispatch (confirmed or uncertain), config caches, drafts, and queued writes are invalidated via `resetEpoch` / `resetInFlight`. Fresh reads are required. Pre-reset user data is not restored. The vendor `er` initialization helper is not called.
- An unsolicited reset report (no in-flight app request, or a note observed before `device.write` started) is treated as connection invalidation: pending HID packets are cancelled, the current handle is closed, connection generation and `resetEpoch` advance, caches are cleared, and the renderer is broadcast without a user click. Already-running multi-chunk writes and queued pre-reset packets therefore cannot continue. It is not counted as a successful app-requested reset. A note correlated with an app request after `device.write` has started does not disconnect, so the ACK wait can still complete.
- HID `data`/`error` callbacks capture the handle and connection generation so a buffered event from a replaced handle cannot complete or disconnect a newer connection.
- `dispatched` is true only after the reset packet write is invoked. The per-attempt flag is lexical to that commit (not the singleton used to gate notification correlation), so disconnect or a later operation cannot rewrite history. `sendPacket` refusal before HID, a stale epoch after the lock or inside the packet queue gate, returns `dispatched: false` and is not uncertain. A throw after write keeps `dispatched: true` and is uncertain. The command is never retried. A pre-dispatch unsolicited note aborts CMD 238 with zero writes.
- **Macro metadata policy (app policy, not claimed vendor parity):** names and default-delay preferences are one global local bank. Confirmed **all-profiles** reset clears that file; disk failures are `hardwareStatus: confirmed` + `localCleanup: failed` and do not truncate an existing file or encourage another hardware reset. Confirmed **active-profile** reset preserves that shared bank. This is an explicit standalone-app choice, not evidence of firmware-isolated per-profile names.
- Export from the confirm dialog writes **one** onboard profile. Copy states that this is not an all-device backup.
- All mutation checks use in-memory GLW. **Physical factory reset has not been performed or verified.** Exact erased firmware regions remain unknown.

## Notification correlation limits

SDK handleMessage emits reset without a scope or request identifier for both A2 and FA FB FF. Only a reset notification observed from the same connected HID instance after this attempt actually dispatches can count toward the attempt. A notification seen before dispatch, on a replaced device handle, or after a completed/expired attempt cannot retroactively turn its result into success. A late notification may still invalidate that current device state as an unsolicited hardware reset.

HID data/error callbacks capture the open handle and connection generation. A buffered event from a closed old handle cannot reset or disconnect a newly connected keyboard. Cancel queued writes by changing the operation generation without allowing that cancellation to lose a notification already observed for the reset result. Observation is registered before `sendPacket`, but a note is accepted for the in-flight attempt only after `device.write` has started.

## Independent request vectors

For normal GLW 65-byte node-hid output reports (leading report ID0), reset payload length is1, offset0, reserved bytes0. Checksum is (1 + scope) &255. Profile index2 starts `00 55 EE 00 03 01 00 00 00 02`; all-profiles scope255 starts `00 55 EE 00 00 01 00 00 00 FF`. Remaining bytes are zero through byte64. These vectors are derived from the framing formula and static reset call, not captured physical reset traffic.
