# G75 lighting effect memory and switching

Static inspection on 2026-09-12 of official SDK `main.348b62de2cbadb6bbe3e.js` and UI chunk2233. Source was read as text only; no device mutation or vendor code execution. This is a remaining functional-parity requirement separate from effect-tile appearance.

## UI behavior

Chunk2233 hook containing `setLightValueStruct:T,lightValueStore:K` defines q to remember lighting values. Each nonzero-brightness main/side/current-side2 record is moved to the front of its scope list, keyed by effect ID. Zero brightness does not replace the remembered nonzero brightness. Unsupported side scopes are emptied. The normalized record lists are persisted only when changed.

Effect switches X/Y merge the current config with the stored record for the chosen effect and then explicit selection fields. For a numeric main-effect selection, brightness becomes remembered brightness OR current brightness OR100. Side follows the same rule. Thus selecting an effect when current brightness is zero normally turns it on again; simply staging a new ID while retaining brightness0 does not match the hub. General lighting-setting updates J write the config and optionally update remembered records.

For actual Custom static, the force-disable-speed/color flag is false; it becomes true for GIF playback or the synthetic Off state. The catalog remains sufficient for still custom color capability. Standalone GIF selection disables the main custom-color control while a GIF is the selected library item.

## Storage format and path

SDK lines20964–21027: `getLightStoredValue(profile)` reads custom data offset728 length112; setter writes the same range. Marker is10 ASCII bytes `<light@v2>` (no NUL separator). Getter toLightStoredValue strips that marker or returns null.

Lines34788–34994: after marker, three count bytes encode main, side, side2 record counts. Each record is6 bytes: effect ID, red, green, blue, flags, brightness. Flags: speed in high nibble; main direction in bits1–3; customColorDisabled in bit0. G75 direction values are only0/1. Side records omit direction. Preserve unknown/reserved bytes when adding hardware write support rather than copying generic serializer quirks.

Helper Le at38423 deduplicates each scope by effect (first occurrence wins), then takes records round-robin main/side/side2 until16 total records. Serialized size for16 is109 bytes, fitting the112-byte region. This is not a persistent cache for every one of23 effects simultaneously.

Channel constructor defaults max_custom_param_size1024. getCustomData/setCustomData (20681/20755) normally use CMD241/242 at profile*1024+offset for offsets below this size. If supportCustomParam is false and a local custom store is available, the same operations use local storage instead. Offsets beyond the limit use extended local storage. Lighting memory at728 is therefore not automatically the same extended-only storage path as macro names.

The vendor support detector writes56 random0/1 bytes to custom offset968, then reads them back; on mismatch it selects local storage keyed by firmware versions. Do NOT reproduce this mutating probe during startup/read-only discovery. A future implementation needs explicit validated handling of hardware support and local fallback, without pretending a successful read proves writes are supported. Write support remains unverified; no CMD242 has been sent during this research.

## Other custom lighting metadata

Selected main library effect uses custom JSON offset840 length56; default pair is `["still", ""]`. Setter normalizes still to an empty first string and preserves the selected library **name** (UI2233 `N()` / channel `setSelectedLightEffect`). Getter `n[0]||"still"`, `n[1]||""`. Decode stops at 0xFF padding (`decodeJSONBytes`). Side metadata starts896 length56 and is not written for G75 (no side customEffectValue). These selection identifiers are distinct from the live FUNC effect ID. Native still select writes this region only on explicit create/select/rename/delete, never on queryStatus/connect. Physical CMD242 remains unproven.

Implementation follow-up: implement per-profile/per-scope remembered values and effect-switch restore behavior with honest storage provenance; preserve nonzero memories when temporarily switching lights off; validate duplicate handling,16-record round-robin capacity, unknown records and profile identity. Coordinate reset/import/export behavior and never auto-restore discarded settings after a reset.

## Read-only receiver observation

At 2026-09-12 13:30 UTC, the existing transport successfully read CMD241 offset728 length112 from the uniquely matched G75 V2 2.4 GHz receiver (VID3837/PID3033, interface1). All112 bytes were zero, so there was no `<light@v2>` marker or saved lighting record in this region. Evidence: `/tmp/maicong-lighting-custom-read.json`. This establishes a successful read of this range only; it does not validate CMD242 writes, other profile offsets, or the vendor support detector. No mutating probe or configuration write was performed.


### Explicit marker-byte check

`Buffer.from("<light@v2>")` yields `[60,108,105,103,104,116,64,118,50,62]`, length **10**. SDK getter uses that array length and serializer concatenates counts immediately after it. Counts occupy10/11/12, records start13, and16 records use109 bytes. There is no additional NUL separator. A temporary research correction claiming nine bytes was incorrect and has been removed after direct byte enumeration. Use this literal byte sequence as the independent fixture prefix.
