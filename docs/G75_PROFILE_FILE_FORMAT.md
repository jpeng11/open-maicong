# Official profile-file envelope: G75 UI evidence

Static inspection of cached official UI chunk `/tmp/maicong-cz-ui/2233-7ba109b328b2b69b.js` on2026-09-12. Vendor code was read only, not executed. This is a remaining interoperability requirement; the app's existing backup JSON is not this format.

## Local export

Hook tw near byte385808 implements getExportData for a profile key. For a keyboard/onboard item, it reads the current device profile through eu with an alive/profile-index assertion; for a driver-local item, it uses the item's stored data. It obtains macros through ew and normalizes the profile item through e1. The returned envelope is:

- dataScope: KeyboardProfile
- type: the item's type (keyboard or localstorage)
- version:3
- vendorId, productId, productName
- identity: an object repeating vendorId, productId, productName
- exportedAt: Date.now()
- data: normalized item from e1, with its name replaced by translated/display name tc
- macros: result of ew

Hook tb serializes that envelope as pretty JSON (2-space indent), Blob MIME text/plain;charset=utf-8, and saves a .json filename made from prefix j + '-' + data.name. This path is ordinary UTF-8 JSON, not automatically a ZIP/compressed-content wrapper. Nested data normalization and macro schema still need tracing; do not guess them from the outer envelope.

## Local import

Hook tx near byte385291 reads the selected file as UTF-8 using FileReader, parses JSON, and calls handleImportData tC with destination localstorage. Import therefore first creates a driver-local profile; it is not an immediate write to the active keyboard. tC validation, version conversion and e1 normalization remain to inspect before implementing compatible files.

## Activation behavior visible beside export

Hook tE accepts only a localstorage source and a keyboard target (or an unused onboard slot). It reads the destination before writing. When replacing an existing onboard target, the outgoing onboard profile becomes a driver-local item at the source's prior position; when filling a free slot, the source local item is removed and a keyboard item is appended. Profile normalization eI and extra metadata ek are applied for the new profile indices. The write uses eh and reports progress, while ej updates profile-list state and optionally hardware-active index. This is a swap/preserve workflow rather than simply discarding the overwritten target.

These are source semantics, not a completed implementation or physical-write validation. Full profile-library work must preserve this behavior along with capacity, identity, shared macros and reset handling. Lighting still/GIF library file entry points are separate and remain unresolved by this profile-file trace.

## Import dispatch and names

Hook tC near384321 selects the modern branch when the object has version and data and version>=2. That branch compares the source vendorId/productId/productName through resolver o.l7 against the current device/model value D; it is not a simple raw PID equality check. Trace that resolver before defining wired/receiver interoperability. It passes the nested data and extra metadata into creation th.

The legacy branch requires GLWDeviceSDK, rejects a supplied productInfo.productName different from the current product display name, reads performance for the current hardware profile, and converts the old object through v.V$ using default keys plus precision/RT-related conversion context. It then overlays the converted performance on the current performance object. This generic migration includes magnetic context; implement only proven G75-compatible fields, preserving unrelated settings.

Imported names are deduplicated against the profile list by appending/incrementing a trailing '(n)' suffix. Name validation tu requires a nonempty translated/display name with length at least2 and at most q (the configured limit still needs tracing). Duplicate ordinary local names are rejected unless allowConflict applies. Creation th assigns a new unique key and profileIndex-1 for localstorage; it prepends local items and does not write hardware for that destination.

The vendor's broad version>=2 branch is evidence of dispatch, not sufficient validation for a native importer. No version-2 schema has been traced, and version-3 field expectations must not be applied to it. Project policy: accept official envelope version 3 only; reject version 2 as an unsupported legacy version until a sample is traced; reject version 1. Reject malformed/unsupported structures before device writes. Nested normalization e1 is supplied by $.PW and remains to inspect.


## Resolved export normalizer (additional static trace)

In cached `2233-7ba109b328b2b69b.js`, `$.PW` resolves through module 71216 → 97109 `p` → manufacturer dispatch 4917 `HO`. That dispatch selects module 68726 `T8` for `glw`, and module 29496 `EZ` for `qhw`. G75 uses the GLW path; do not copy QHW `keyByteList` serialization.

The GLW normalizer (`68726.C`) returns null when the item's data is null. Otherwise it returns the normalized profile fields directly, plus `name` and `extra`; it does not retain the original item's nested `data` wrapper. `extra` retains existing extra properties and overlays current `fw_ver`, wireless `rffw_ver` (or `"0"`), and the current identity tuple. The top-level export envelope's `data` therefore contains the normalized profile itself.

Without `allowSkip`, normalization composes: encode source profile to portable form using its profile index; decode/normalize against profile index -1; then encode again at -1. Portable GLW `userKeys` is an array of layer records shaped `{type:"diff-keys",dataV2:{...}}`; the deprecated `data` property becomes undefined and is omitted by JSON. The detailed dataV2 key identity and value schema still require tracing helpers W/X/Y/Z rather than assuming raw key indices. The decoder also accepts older diff records with `data` and ordinary arrays, filling defaults and applying key sanitization.

The GLW core (`82668.eo`) normalizes userKeys, advancedKeys, performance, triggerTravel, lightValueStore, light, customParam and selected light library fields. Local profile performance removes `profile`, resets debugMode and telemetry (battery, charging, work mode, report-rate readouts and tickRate), and normalizes macMode. This is not a byte-for-byte hardware dump. Lighting normalization blacks unavailable layout zones. Preset memory has its own normalizer. Exact omitted/default field semantics need fixture coverage before compatible import/export is implemented.

Module 25509 configures `MAX_PROFILE_NAME_LENGTH:15` for both manufacturers. Combined with the previously traced name validator, official profile names are 2–15 characters under that JavaScript length check. The GLW local structure checker expects performance, triggerTravel, userKeys, advancedKeys, light, customParam and lightValueStore, allowing selectedLightEffect/sideSelectedLightEffect/side2SelectedLightEffect plus separately declared common fields. This checker only warns about shape mismatch and is not a sufficient native import validator.

Native source now implements official version-3 KeyboardProfile import as a **local library item** (no HID on import) and export of that envelope from a local or onboard snapshot. That supported envelope is version 3; versions 1 and 2 are outside the accepted schema under the policy above. Nested `performance`/`light`/`userKeys`/`customParam`/`triggerTravel`/`advancedKeys` must be objects (userKeys exactly 4 layer objects); wrong types fail closed instead of synthesizing sleepTime 6 / brightness 100. Wired VID 14391 / PID 8225 and receiver VID 14391 / PID 12339 plus G75 V2 product name resolve to model 133; ambiguous PID 3033 identities are rejected. Physical writes remain unproven. Cloud share-codes are not implemented.


### Portable key identities and values

Further static tracing in module 82668 resolves W/F/X/Q/z/Y. The lookup is built from **allDefaultKeys[0]**, capped by the SDK key-count constant, and the keyCode-visible layout. Each position receives a storage string and an occurrence counter among positions with that same string. Keys may be `fn-key`, `side-light-key:relative@<offset>`, `rt-dbclick`, `code:<function code>`, or lowercase `0x<packed default key>`; absent/zero identities are skipped. Exact special-key predicates and the packed-key helper remain dependencies to verify against G75 fixtures.

`dataV2` maps each storage string to an array, indexed by occurrence. Serialization assigns at that occurrence index, so missing earlier occurrences can become JSON null holes. Deserialization retrieves `dataV2[storageKeyByte][occurrence]`. Import must use the factory/layout-derived lookup rather than interpreting the storage key as a physical key index.

The diff excludes visible layout positions marked `isGlobalKey`, removes assignments equal to the selected layer's defaults, and normalizes Fn-to-Fn comparisons by layer-count modulo. Module 91951 reexports `AE` from module 39164 in cached `1288-1bcb3e8a90c8a543.js`; that helper picks only `type`, `code3`, `code1`, and `code2`. Thus portable key values are key-code objects with these fields, not the native app's raw three-byte tuples or arbitrary display metadata. Their exact wire mapping must use the existing verified key codec, with unsupported types rejected before hardware writes.

No official profile file has yet been round-tripped through the native app; these facts define the remaining compatibility implementation and fixture requirements.


### Exported macro list resolved

The profile export's `ew()` is context `loadMacro` (chunk2233 byte374204), implemented as `ea` near408162. It calls `C.getMacroProfileList(0)`, updates browser local storage and context, and returns the entire list. Thus export includes the loaded macro list rather than filtering to macros referenced by that one profile.

GLW SDK `getMacroProfileList` at36835 reads `getMacros(t)` and channel `getMacroState(t)`, then maps every state slot to `{macroIndex,macroActions,name,type,defaultDelay,enableDefaultDelay}`. `macroActions` and the preferred `type` come from the corresponding decoded hardware macro slot; name and delay preferences come from the state tuple `[name,type,defaultDelay,enableDefaultDelay]`, with state type used only if decoded type is nullish. `setMacroProfileList` writes macros then these state tuples. The nested macroActions codec and portable key references still need fixture mapping before official-profile import is implemented. Shared macro storage means import must account for other onboard profiles rather than silently replacing their referenced slots.

This static trace did not call the browser loader or perform its local-storage side effects.


### Modern import model matching resolved

Chunk1288 module83050 reexports `l7` as SDK `getDeviceType`. SDK `Fe` at9052 resolves catalog entry `Se` and returns its `type` (fallback101 when no entry). G75 V2 catalog at7585 identifies type133, wired VID0x3837/PID0x2021, and a spread receiver identity VID0x3837/PID0x3033/productName `MCHOSE G75 V2 2.4G`. Numeric JSON values for these are VID14391, wired PID8225, receiver PID12339. Hex strings must not accidentally be read as decimal3837/3033.

Identity resolution at8940–9001 handles shared receiver PID3033 by product-name matching among multiple MCHOSE models, then resolves catalog dictionaries. This explains why official profile import compares resolved model type rather than exact wired-versus-receiver PID equality: G75 wired and receiver profiles can map to the same model133. Do not import arbitrary PID3033 profiles as G75: product identity is necessary. Do not copy the vendor unknown-device fallback101 into a native import allowlist; accept only positively identified G75 V2 schemas and reject ambiguous identities before activation or writes.


### Nested macro action format resolved

Static SDK helpers `fe`/`he` at lines38023/38076 decode hardware macro bodies into the exported `macroActions` list. Each record is either `{type:"action",action:"keydown"|"keyup"|"mousedown"|"mouseup",code:<number>}` or `{type:"time",delay:<milliseconds>}`. These are alternating action/time records when a delay is retained; they are not portable remapping key objects or native raw action tuples.

The four-byte wire record is delay little-endian, flags, code. Flags bit7 ends the macro, bit6 means down, and low6 bits identify modifier1, keyboard2, mouse3 (zero produces no records). Modifier codes are one-hot bytes mapped to HID224–231; other keyboard and mouse codes remain the fourth byte. The decoded action is followed by its time record, then `ye` filters zero-code actions and delays below `MIN_MACRO_DELAY`5 (constant at45389). Invalid action kinds or modifier masks cause the vendor decoder to return an empty macro; a native importer should reject malformed input explicitly instead of silently erasing it.

Literal examples derived from that decoder, without executing vendor code:

- `[10,0,66,4]` → keydown HID4, then time10.
- `[4,0,130,4]` → keyup HID4 with end flag; time4 is omitted.
- `[5,0,193,2]` → keydown HID225 with end flag, then time5.
- `[20,0,195,1]` → mousedown code1 with end flag, then time20.

Serializer `pe`/`ge` at38034/38124 pairs an action with an immediately following time, supports standalone time by a synthetic zero-code keyup, and sets the final-record bit. Empty actions encode `[0,0,128,0]`. Delays below5 serialize as4, matching the existing macro wire normalization. Native import now follows that pairing: consecutive or leading times become `{action:'keyup', code:0, delay}` and export as standalone `{type:'time'}`. Playback type is stored at hardware bytes 34+i. Hub `tC` / en `821`/`823`/`825` use GLW types **0, 1, 255**. QHW `UI_MACRO_TYPE_DICT` `{0:0, 2:1, 1:255}` maps UI OneTime=2 to hardware 1; official GLW import accepts 0/1/255 and rejects type 2. Remap still treats unequal integer types as distinct so equal bodies with different playback are not aliases. Names stay on native slots; `defaultDelay`/`enableDefaultDelay` stay in `macroMetadata`. Duplicate or out-of-range `macroIndex` values are rejected.

### Official advancedKeys (MT/TGL)

SDK `getMtKeyInfo`/`se`/`le` (readable.js 36117–38015) decode each 6-byte MT row as `{clickKey, downKey}` 3-byte tuples. `getTglKeyInfo`/`ue` (36217–38018) decode each 3-byte TGL row as `{type, code1, code2}`. Table index is the array index (max 32). Keymap type 146 is `[146, tableIndex, delayMs/10]`; type 145 is `[145, tableIndex, 0]`. Multiple keys may share one `code1`. G75 mechanical import rejects populated DKS. Native storage is `advanced.mt`/`advanced.tgl` hex (or `{index, tapKey/holdKey|targetKey}` entries) consumed by `applyProfile`/`serializeMtTable`. Official export of an onboard snapshot parses those native tables; it does not round-trip an opaque `officialAdvanced` blob. Official JSON has no keyExtras field. Physical EEPROM writes remain unproven.


### Packed portable-key identity predicates resolved

Static chunk1288 module91951 supplies the helpers used by chunk2233 module82668.F. `tz` is `f`: `(type << 16 | code1 << 8 | code2) & 0xffffff`. Therefore a normal HID4 factory tuple `{type:16,code1:0,code2:4}` produces storage identity `0x100004`, not `0x040010` or a physical index. `code3` is absent from the packed identity even though the portable value picker retains it.

`X`/`S` detects Fn as type240/code1=255 (code2 supplies layer information). `Bk`/`R` detects side-light placeholders when type,code1,code2 are all equal and at least240; their identity is relative to the first such placeholder in factory layer0. `Yb`/`A` detects ordinary unmodified HID keys as type16/code1=0/code2>0; these bypass the layout function-key override. Other keys may resolve through visible layout function-key code, subject to its `available` list. `$p`/`O` checks equality with `91972.q2`, resolved in chunk1288 to `KC_SwitchProfile`. Module91951 maps it to decimal15792640 (`0xf0fa00`), or type240/code1=250/code2=0. A visible function-key with code0 immediately following that factory tuple becomes `rt-dbclick`. The special name alone does not prove that G75 has such a factory-layout position; check the G75 defaults and layout before including that identity.

`F` counts repeated identities in physical-index order; dataV2 values therefore need the identity plus occurrence, not only the packed key. These are static schema findings only. The native importer/exporter remains unimplemented and must use independent factory-layout fixtures for Fn, ordinary keys, duplicate positions and side placeholders before claiming compatibility.


### Captured G75 factory lookup cross-check

The repository's `src/data/default-layers.json` identifies its source as GLW CMD7 GET_DEFAULT_KEY_MATRIX. Its layer0 has384 bytes/128 tuples. Independent read-only parsing finds HID4 at index11 (`0x100004`), Fn `[240,255,1]` at85 (`fn-key`), and equal-byte side placeholders `[240,240,240]` at113–127 (relative identities0–14). There is no `[240,250,0]` switch-profile tuple in this captured layer0, so the preceding-key condition for `rt-dbclick` cannot match this baseline. This check applies to the captured defaults, not every future firmware revision; imported identities must be resolved against the relevant verified model defaults. No HID calls were made for this check.
