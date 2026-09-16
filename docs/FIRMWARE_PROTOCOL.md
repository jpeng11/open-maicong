# G75 V2 firmware research

Inspected 2026-09-12. No boot-mode entry, erasure, or flashing was performed. Downloaded reference binaries remain in /tmp and are not included in the application.

## Official catalog

Public SDK main.348b62de2cbadb6bbe3e.js readable lines 7590–7670 maps normal wired PID 0x2021 to boot PID 0x2022; receiver normal PID 0x3033 to boot PID 0x2010 with product name MCHOSE G75 V2 2.4G. Vendor ID is 0x3837. Normal control usagePage1/usage0, boot usagePage0xFF00/usage1. SDK advertises fwVersion114 and rfFwVersion130.

- https://cdn.mchose.com.cn/configCenter/static/binaries/update_G75V2.e824620b_dca8d0990778.bin
  - Size: 264408 bytes
  - SHA-256: b6b2a6abc0a682b3511049789d70c646268491c11aa65f0700120c42805b43f1
  - First 32 bytes: `373821201401aabb000000000000000000000000000000000000000000000000`
- https://cdn.mchose.com.cn/configCenter/static/binaries/update_G75V2_RF.e553557a_d8d9002e3131.bin
  - Size: 121032 bytes
  - SHA-256: 06fc8728f1b098e08386f18950ee4f8db8b4de0d3cd1adce285989c4d568e5fb
  - First 32 bytes: `373833301801aabb000000000000000000000000000000000000000000000000`

## Transfer evidence

GLW SDK lines 22520–22781: boot entry raw payload [95,6,0,82,1,0,0,0,81,0,170,187]; erase [129,7,vidLo,vidHi,pidLo,pidHi,0]; send chunks use opcode128, length, LE32 offset, data (32 bytes per chunk); verify chunks same with opcode130; end [131,1,0,0,0]; success [132,1,0,0,0]. These are flag-response packets, not the normal 55/AA configuration frames. Packet report padding/ID and response matching are traced below; the actual boot report descriptor remains unobserved.

The public 1288 chunk getUpdateFile downloads raw bytes unchanged. The 2233 GLW updater gets the file based on boot identity, erases, sends, verifies, ends, reports success, waits for normal-device reconnection, initializes device-global data and can restore backup. That full sequence is required; a send-only implementation is not parity.

## Outstanding evidence

- Source framing, flag-response matching and boot identity used for erase are resolved below. Confirm actual boot report descriptors and response behavior before claiming physical verification.
- Establish firmware header semantics. The receiver blob starts 373833301801AABB while the advertised RF version is130. Do not equate byte4–5 directly to the displayed RF version without evidence.
- Prove backup/restore scope and failure reporting. No swallowed erase or verification failures, no implicit retry after an uncertain erase.
- Bind normal-to-boot-to-normal identity to the same physical device across reconnect; do not flash a similarly named receiver automatically.
- Implement reviewable version/file/target presentation and an explicit destructive-action confirmation. Physical flashing remains unverified until the user authorizes a concrete operation.

## Flag-response framing and completion trace

SDK module39318 imports its base queue item xT from87033. _sendFlagResPacket (lines20253–20295) constructs flag item ee with raw data and maximum priority. ee defaults retryMax2; it does not wrap the payload in55/AA configuration framing. Base queue item defaults packetLength64/reportId0 (30550–30583), zero-pads raw data to64 bytes and calls HID sendReport(0,data) (30694–30765). A native node-hid writer therefore requires report-ID0 prefix plus64 bytes, subject to confirming actual boot interface report descriptors.

Flag item _isMatch (23351–23398) accepts first payload bytes00 00, rejects00 01 with receive flag1, and ignores reports whose first byte is nonzero. It does not match an opcode/offset, so firmware transfers must remain strictly serialized and identity-bound. SDK autoCompleteDelay resolves without a reply for enterBoot/end/success at16ms and erase at5000ms; these timers are not evidence of device completion. A standalone updater must report timeout/uncertainty honestly and use verified chunk comparison plus return-to-normal identity as completion evidence. Do not copy the SDK generic retry defaults onto uncertain erase commands.

No boot entry, erase, transfer or firmware verification command was sent during this source trace.

## Updater call-site details

Actual UI GLW updater in chunk2233 around byte239844 first verifies the connected object is boot/Upgrader mode, resolves its catalog update URL, then calls o.eraseRom(), o.sendRomData(file), o.checkRomData(file), endRom and succRom. Wrapper eraseRom at byte147660 forwards this.hidDevice.vendorId/productId, so the erase identity is the connected boot interface (G75 keyboard PID2022 or receiver2010), not the normal-mode PID used in the firmware header.

sendRomData/checkRomData at byte61403 split the supplied complete file into32-byte chunks at offsets32*index. Check opcode130 resends the expected chunk for device-side comparison and expects the flag response; it is not a raw flash readback. No header stripping or version parsing is performed by this call path. The receiver header version discrepancy therefore remains unresolved; do not label its byte4–5 as the displayed RF firmware version.

The vendor UI catches and logs some erase/end/success failures. A native implementation must not swallow these failures or silently retry an uncertain erase. Its successful flow should still cover full-file transfer, every verification chunk, completion, same-device normal-mode rediscovery, read-only identity/version confirmation and explicit backup restoration as appropriate. Automatic initialization that can recreate old macro data must not be used implicitly.

## macOS USB topology evidence (read-only)

On the attached receiver, node-hid reports control path DevSrvsID:4295538287, interface1, usagePage1, usage omitted. Read-only ioreg -a -r -c IOHIDDevice reports the matching IORegistryEntryID4295538287, VID14391/PID12339, PrimaryUsagePage1/PrimaryUsage0 and LocationID37748736 (0x02400000). All six HID interfaces of this receiver share that LocationID; only one is the normal configuration collection. These numeric IDs are an observed example, never application constants.

This establishes a way to associate node-hid paths with macOS USB location metadata without opening an input collection. For a future updater, snapshot the registry entry corresponding to the normal control path, then require expected boot VID/PID/usage and the same USB location, with exactly one candidate, before proposing a boot target. Enumerating one matching product name is insufficient. A system ioreg plist can be converted with system plutil to JSON; a shell-free child-process pipeline avoids adding Python as a runtime requirement.

Location continuity across actual G75 boot transition has NOT been tested. It identifies a USB port/topology position, not cryptographic physical-device identity; serial identity (when available), a bounded transition window, exact collection matching and fail-closed ambiguity handling remain necessary. No boot-mode command was issued for this observation.


## Native implementation progress — 2026-09-13

Pure firmware packet/catalog/identity logic and the injectable serialized transfer coordinator now exist in src/firmware-protocol.cjs and src/firmware-transfer.cjs. Final preflight pass:26 firmware tests and432 project tests pass. Root separately verified forged target manifests are rejected, stable location survives registry re-enumeration, missing location produces zero boot-entry writes,0x02400000 parses37748736, pending write and initial identity lookup can be cancelled, and expected detach/attach succeeds in a mock with changing registry IDs. These are fixture results, not hardware proof.

Coordinator completion explicitly requires later version readback before full updater success. Native HID/topology adapter, configuration transport handoff, reviewed package workflow, backup/restore, IPC and Others UI are wired: the user chooses a local official package, reviews catalog size/hash/boot identity, then confirms. Physical boot descriptors, flag behavior and actual flash remain unverified.

Root static references: /tmp/maicong-firmware-backup-root-trace.md (module91569 backup/restore and er initialization effects); /tmp/maicong-firmware-packet-root-reference.md (independent raw packet examples). er can synchronize or recreate macros/names; it is not read-only initialization and must not be replayed blindly.

### Native adapter correction checkpoint

The native adapter and transfer coordinator now pass 42 focused firmware tests and 448 project tests across 49 suites (0 failures; full run 2365.907666 ms). Mock coverage includes cancellation before deferred dispatch, rejected-open promise handling, late-handle closure after open timeout, cancellation during device-info read, and one total rediscovery deadline. A separate root fake-handle probe confirmed immediate cancellation yields zero writes. These are host-side and mock results, not physical update verification. Backup/restore, exclusive handoff, Others UI review/confirm/cancel, and post-update version readback are implemented against injectable doubles. Release packaging and live flash remain incomplete.

### Backup/restore checkpoint

Firmware backup/restore now has five mocked-memory tests covering reordered enabled profiles, four-layer capture, semantic migration, reserved-byte preservation, malformed metadata rejection, stable USB-location continuity and retained backups after partial restoration. Full project run:453 tests/49 suites/0 failures,2494.621167 ms. Root separately verified that stale topology no longer masks a changed live serial (mismatch rejected, live serial preserved). No physical restoration was performed. Exclusive updater controller, Others UI, and post-update version confirmation are implemented against mocks. Packaging and live flash remain pending.
