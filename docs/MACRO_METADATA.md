# G75 V2 macro metadata storage evidence

Reference: public GLW SDK `https://www.mchose.com.cn/cizhou/CZ_SHARED_DATA/main.348b62de2cbadb6bbe3e.js`, readable copy `/tmp/maicong-cz-readable.js`. Read-only static inspection; no vendor code executed, no physical writes.

- Lines 36835–36925: `getMacroProfileList` combines action memory from `getMacros` with `channel.getMacroState`. Metadata tuple is `[name, type, defaultDelay, enableDefaultDelay]`. `setMacroProfileList` writes actions then metadata separately.
- Lines 21384–21458: GLW `getMacroState` / `setMacroState` use custom JSON offset `max_custom_param_size + 0`, length 1120. Defaults are 16 tuples `["", 0, 50, true]`.
- Lines 20680–20796: `getCustomData` / `setCustomData` route any offset >= `max_custom_param_size` to `getExtendedCustomParamStorage`, subtracting that base. The normal HID opcodes 241/242 are only used for offsets below the base. Macro metadata therefore takes the extended-storage branch, not hardware custom data.
- Lines 19587–19635: extended store is requested under `extended-custom-param-storage`, size 12288.
- Lines 29612–29651: helper `S7` (exported as `R`) constructs `LocalCustomParamsStorage`, using `wrapStorageName(getDeviceType(vid,pid,productName))` as namespace. This is client metadata associated with the device type; it is not a name field inside CMD12/13 action memory.

## Implementation implications

Persistent local names and per-slot recording preferences match the observed GLW storage model. Do not add firmware name bytes. Existing `state.localMacroNames` is only an in-memory map, so app restart persistence remains a concrete parity gap. Persist validated metadata locally, handle malformed storage safely, preserve literal names, and keep exports/imports consistent. Keep fixed-delay preference metadata separate from physical action tuples. Playback still uses the authoritative macro header type when present.

This evidence resolves the inventory assumption about device-stored names: a translation string alone was insufficient; the actual GLW path uses client storage. It does not prove every other device family uses the same path.

## Timing convention to preserve

Public UI `t_` in chunk 1833 emits a `time` item *before* each newly detected action. The serializer helper `en` in chunk 2233 groups an `action` with the following `time` item and writes that delay into its four-byte packet. Thus elapsed time between successive recorded events belongs to the **previous action** in the physical tuple sequence. A renderer storing `action.delay` must not accidentally shift every interval onto the next action. Fixed-delay tests alone cannot reveal this shift; use unequal event intervals to verify recording serialization.

Delay bounds: UI chunk 1288 module `91972` exports `FL` from `a=5`; helper `NJ`/`et` clamps recording preferences to 5–65535 ms, default 50. Serializer uses `FL-1` (4) when no following delay is present. Current `encodeMacroAction` already preserves that minimum sentinel with `Math.max(MIN_MACRO_DELAY - 1, act.delay || 0)`; the timing review concerns which action receives an interval, not a new wire format.

## Mouse recording is enabled for G75 V2

Chunk 1288 G75V2 catalog entry (near byte 96625) does not override `EnableMouseMacro`; the feature resolver near byte 106535 defaults that flag to true when absent. Receiver spread inherits this feature configuration. Therefore mouse recording in `t_` is a G75 requirement, not merely a translated feature from another model. In chunk 2233 module 94222, table `J` maps DOM buttons 0/2/1/4/3 to macro codes 1/2/4/16/8 respectively (left/right/middle/forward/back). Keyboard media entries are explicitly `macroDisabled:true`. Keep capture in a focused dedicated area so clicking editor controls does not record those clicks.

## Remaining capacity parity item

Official `setMacros` near readable lines 36460–36524 reuses offsets for duplicate action bodies (lookup table `s[m]`, where body identity is derived from the macro action list), while playback remains per-slot header data. Current `serializeMacroRegion`, `validateMacroSlots`, and editor capacity helpers count every slot body independently and can reject a bank that fits when identical bodies share storage. Preserve full readback and strict preflight when implementing deduplicated storage; test identical bodies with different playback modes and a vendor-style shared-offset bank. This is a concrete remaining parity item, not proof that the macro feature is complete.
