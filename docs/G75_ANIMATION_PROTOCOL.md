# G75 host-driven animation: source evidence

Static inspection of the official cached SDK `/tmp/maicong-cz-readable.js` on 2026-09-12. No vendor code was executed and no animation command was sent. This is protocol research plus the current standalone implementation status. Host GIF playback is implemented in source and mock-tested; physical streaming is unproven.

## Model and player

The G75 model has GIFAbility false, while custom effect0 supports still and GIF selection (see G75_LIGHTING_SCOPE.md). The SDK includes a host GifJsonPlayer around lines2730–2900. Its input frames contain colors and dur. Duration defaults to100ms, with minimum30ms and maximum tick300ms. A long frame is resent across multiple ticks; the frame index loops. Stop clears the timer and resets the frame index; pause cancels by incrementing a playback generation, and resume continues from the current frame. Standalone `GifPlayer` (`src/gif-player.cjs`) follows those tick rules (default missing library duration 16, player minimum 30ms, max tick 300ms, long-frame resend, pause generation, stop resets index). Transport binds the loop to `streamGeneration` plus device generation and reset epoch so stop, disconnect, profile switch, effect change, factory reset, and app quit cancel queued frames immediately.

The selection helper around lines2900–2995 checks getGIFAbility, active effect kinds and runtime scopes. For a device without onboard GIF ability, it may first update static colors (a still frame or black), then change the selected lighting library identifier. Do not substitute QHW onboard GIF commands/content storage for the G75 host path.

## GLW frame transport

Device setMusicKeyColors around lines33788–33888 resolves a frame through keyColorFrame2Colors using scopes and side-light modes, converts each returned color to RGB bytes, and calls channel.setMusicKeyColors with profile argument0. It optionally checks a playback locker before conversion. The exact G75 frame-coordinate mapping and runtime scope selection still need tracing before implementation.

Channel setMusicKeyColors around lines22133–22234 slices to usedLightAreaSize and splits colors by model ranges. Main ranges use CMD221, side CMD223, and second-side CMD220. Sorted ranges call _simpleSendCommand with offset profile*totalLightAreaSize + range.start, range bytes, chunkSize3, priority COULD_IGNORE, and unsafeAutoComplete delay20ms. totalLightAreaSize is512; usedLightAreaSize is3*maxLightKeyCount. departLightColors (22056) converts model color-index ranges to byte ranges by multiplying start/end by3. Do not assume a full512-byte frame or send second-side data on a model without that scope.

The command queue sendReport around23165–23195 explicitly resolves its promise with an empty result after the configured unsafeAutoComplete timer. Thus the vendor20ms completion is not an acknowledgement or verified frame display. Standalone streaming writes CMD 221 through the serial HID queue and waits that 20ms locally without installing a reply listener or treating timeout as reconnect. Streaming frames are not persistent configuration writes. G75 main coverage is the vendor-resolved 0..128 color-index span (384 bytes).

## Stop semantics

abortAllMusicColor around22812 cancels queued command objects matching221/223/220 through abortIf. It is a host queue cancellation operation, not a new wire stop opcode. abortAllKeysColor similarly cancels queued CMD11. Trace how the UI restores normal/static lighting when playback stops; do not invent a stop packet.

## Implementation status (GIF stage)

Standalone source now implements a local **GIF** library beside still (`src/gif-library.cjs`, `src/gif-decoder.cjs`, `src/gif-player.cjs`):

- Import accepts case-insensitive `.gif` files ≤5,242,880 bytes. Decoding is native (not vendor TRANSFORM_GIF / OPEN_GIF_EDIT_DIALOG). The decoder bounds compressed size, canvas, frame count, and retained RGBA bytes before allocating frame copies; import maps each composited frame to 83 keys and discards the canvas.
- Disposal 2 restores the frame rect to the logical-screen background palette color. Transparency, disposal 1/3, and GIF delay (0–10ms → 100ms) are handled in the decoder. Library frames store `{duration,data:[{code,selectColor}]}`; UC-style conversion defaults missing duration to 16 before the player minimum of 30ms.
- Image-to-key mapping samples G75 lighting geometry and writes Te aliases space2/301, space3/302, Fn/1, and factory codes. Visual layout code 0/255 are not stored. This is a documented native mapping, not a claim that vendor TRANSFORM_GIF was reproduced.
- Selection writes FUNC custom 0 through the existing lighting autosave worker, CMD 11 black static colors, and selectedLightEffect `["gif", name]` at offset 840 length 56, preserving other custom-param bytes and independent side FUNC. Playback runs only for the active onboard profile.
- Host streaming sends CMD 221 only (no 223/220 on G75), profile argument 0, **128 color indexes / 384 bytes** (G75 catalog has no sideLightColorRange; do not invent a 113 cutoff), 54-byte RGB chunks with last-54 overlap. Packets share the serial HID `activeQueue` with a 20ms unsafe-completion gap after **every** chunk, including the last packet of a frame so a queued next frame is not written back-to-back. That timer is dispatch pacing, not an ACK, and does not set `needsReconnect`. A one-slot latest-frame queue stores canonical `{streamGen, epoch, devGen}` identity (not a replay that drops `epoch` for the live reset epoch). Stale dispatcher `finally` handlers must not clear a newer dispatch owner or overwrite newer pending data. Pause increments `streamGeneration` and cancels in-flight/pending stream writes while keeping the player; resume rechecks device, standby, reset epoch, and the active onboard profile. Stop destroys the player; Play after Stop restarts from the selected GIF when the editor is the active profile. `abortAllMusicColor` is host queue cancel, not a firmware stop opcode. Unplug/reset/quit cancel immediately. Local editor preview does not write.
- GIF LZW must emit the declared pixel count and a valid end-of-information code. Premature end, missing end, and overflow are rejected; the decoder does not zero-fill undeclared pixels.
- Cloud/share GIF files, side still, and music-reactive UI remain unimplemented. Physical CMD 221/242 are unproven. Do not invent opcodes.

## Remaining work

Local still and GIF libraries are implemented in source with mock tests; physical writes are unproven. Remaining: cloud/share file envelope, side still, music-reactive UI availability on G75. The generic method name setMusicKeyColors does not prove a microphone/music control is exposed. Do not invent opcodes.

## Frame mapping and runtime scopes (additional source trace)

GLW keyColorFrame2Colors around33698 initializes layer0 factory/default keys, then calls Oe (38681) with the device identity and feature context. It does not map animation using the user's current remapped key labels. Oe initializes maxLightKeyCount colors to the fallback color (default black). String frame entries address their array index directly. Object entries resolve against the model-aware Te key list by code first, then a case-insensitive name match, assigning selectColor when present or color otherwise. Missing matches leave the fallback. Side follow mode additionally maps main keys to side music-code identities using the model lightMap. Exact Te identity transformation must be preserved for file interoperability; raw USB HID codes alone are not yet proven equivalent.

Runtime scope resolver ne/re around37852 always starts with light. It adds sideLight/sideLight2 only when the currently selected side effect equals that model range's followEffectValue. It does not automatically mirror a main animation into every side strip. G75's exposed side catalog has no follow effect (see model scope evidence); preserve independent side behavior.

toLightColorRage around22968 partitions the complete color-index span at model side/side2 range boundaries, then filters by requested scopes. Main consists of the remaining ranges; side/side2 contain their own ranges. Both model range resolution and feature context matter. Do not derive packet coverage merely by counting visible keycaps.

## G75 frame aliases

Te around38593–38680 combines layer0 default keys with model-specific space aliases, adds an alias code1 for the default Fn key, then filters by requested lighting ranges. The G75 table at38506 adds space2/code301/index45 and space3/code302/index61. The ordinary space remains its default-key identity at index53. These synthetic301/302 identities are necessary to import separate left/right space colors; the current visual layout uses code0 for those two lighting-only zones and therefore cannot itself serve as the vendor frame-code lookup. Fn's frame alias code1 is likewise distinct from the visual key's code255. Resolve these aliases explicitly and keep them separate from remapping keycodes.

## Frame packet boundaries

_simpleSendCommand (20188) uses the full-send path when no same-length dataBuffered is supplied. The streaming call supplies no dataBuffered. _simpleFullSendCommand (19957) computes payload capacity min(56, floor(56/chunkSize)*chunkSize): for RGB chunkSize3 this is54 bytes. A final short segment after the first packet is replaced by the last54 bytes of the range at offset rangeLength-54, overlapping the preceding segment rather than padding outside the range. Ranges shorter than54 are sent at their real length. Example: a60-byte range starting at byte offset30 yields54-byte payloads at offsets30 and36. A single3-byte range remains3 bytes. Use independent fixtures for exact offsets, RGB alignment and no out-of-scope bytes. These are source-derived expectations, not hardware captures.

## Library-to-player frame conversion

Module79922 exports UC=A (around2709). The library frame schema uses duration and data. UC maps duration to player dur, defaulting missing duration to16; the player then applies its minimum30ms tick (distinct from its100ms default for a falsy dur). Each data object becomes {code, color}, preferring selectColor when present. String data entries are filtered out by this library-to-player conversion even though the lower-level Oe mapper accepts indexed strings. Do not conflate the lower-level color mapper with the GIF library import schema. This also means names alone are not preserved by UC; code identities are the interoperability key for this player path. The adjacent xW=C helper maps colors to editor {code, selectColor} objects.

## Compressed content envelope (cloud/library boundary)

Shared module11440 (46259–46417) optionally wraps an object as {__compressBase64__: ...}. The value is a base64 ZIP using DEFLATE with one data.json entry containing JSON.stringify(object); the compressor returns the original object when the base64 form is not shorter. Decompression loads that entry, parses JSON and merges decompressed properties over the outer object after removing the wrapper key. Cloud/library resolver ua/da at18454 invokes this decoder on a.content before constructing the profile wrapper. Generic API compressContent/decompressContent around570–640 uses the same helpers, retaining selected outer metadata.

This proves a cloud/library content envelope, not a local file extension or complete export schema. A future importer should bound encoded size, decompressed data.json size, entry count and object schema before use; never extract arbitrary archive paths. Do not enable network access simply to support locally supplied compressed content. Local file export entry points still need tracing.

## Local library UI and GIF import boundary

Additional static trace of cached UI1833 on 2026-09-12:

- eR at byte108350 builds main Normal / Local / Cloud tabs. Local contains still, GIF and official/Apex sections. Side library mounting is conditional on customEffectValue != -1; G75 side catalog must remain the authority rather than this generic component.
- eC at byte93900 creates a local still object with `{dataScope:"LightingEffectProfile",type:"still",frames:[{data:[]}],isPreset:false}` through the model library cloneData/create path. The dialog validates a nonempty frames array, scope and type, and exposes name entry and optional share-code import. Its handleImportedFile explicitly rejects: it is not a raw image-file importer.
- Module82492 K around byte60538 has a GIF file handler accepting case-insensitive .gif names and size <=5242880 bytes. It calls parent TRANSFORM_GIF with deviceType2, model webdriverProductKey and ArrayBuffer, then converts the result through module50746 Yz. This bridge call is evidence of the desktop import path, not proof that an ordinary browser exposes or implements the parent transformer. The component also inspects isElectron. A native implementation needs its own GIF decoder and verified model image-to-key mapping; it cannot call the vendor parent bridge.
- Module50746 Yz=C in UI2233 byte19353 converts `{dur,colors:[{code,color}]}` into `{duration,data:[{code,selectColor}]}`. The resulting library content has dataScope LightingEffectProfile, type gif, isPreset false and frames. This directly confirms the reverse of the previously traced library-to-player conversion.
- GIF editing uses OPEN_GIF_EDIT_DIALOG/CLOSE_GIF_EDIT_DIALOG parent operations in the hub. Standalone implements a local frame editor (duration, paint, preview) instead of routing through that parent bridge. Do not describe a file picker alone as full GIF editor parity.
- The local menu capability resolver near UI1833 byte57200 distinguishes still rename from GIF editing; both can remove, with share-code enabled only for main. Cloud can remove/reset; official/Apex cannot rename/remove. These are menu capabilities, not permission to make network calls.

Standalone source now implements the local **still** library only (`src/still-library.cjs`):

- Storage key semantics: module 91972 `D8(type, lightScopeType)` → `lightingEffectProfiles@still` for main still; native file is additionally isolated per device identity (`lighting-memory` serial/path keys) and model `g75_v2`.
- Capacity `maxProfileLength` **20** (`Xf=20`). Names trim, JavaScript length 2–15, `allowLocalNameConflict:false`. `create("localstorage", name, data)` prepends; `profileIndex:-1`; key prefix `LightingEffectProfile@still@`.
- cloneData keeps `dataScope`/`type`/`frames` and forces `isPreset:false`. User create frames are `[{data:[]}]` (eC); WASD white `getDefaultStillValue` is preset-only and is not used for local create.
- Yz/xW as traced: `Yz` player `{dur,colors}` → library `{duration,data:[{code,selectColor}]}`; `xW` `{code,color}` → `{code,selectColor}`; library-to-player default dur 16 and drops string entries.
- colors2KeyColorFrame / keyColorFrame2Colors use G75 Te aliases space2/code301/index45, space3/code302/index61, Fn alias code1. Visual layout code0 on those zones is not the frame key.
- Rename/delete follow e_ / eS / `removeEffectItem`: unique local names; deleting the **active** still retargets right-then-left neighbor or `["still",""]`; non-active delete preserves other profiles' selected names.
- e8 300ms still-edit persist plus cancellation so a stale timer cannot write a newly selected item. Selecting a still stages FUNC custom0 through the existing lighting autosave worker, then CMD11 static RGB and selectedLightEffect; side FUNC is not copied.
- Cloud, share-code, official/Apex, side still, and hub file import/export remain unimplemented. Local GIF import is native `.gif` decode plus geometry mapping, not a hub share-code envelope. eC `handleImportedFile` still rejects raw files for still create; do not invent an interchange format.

These observations plus the still and GIF implementations do not establish physical playback correctness. Native mapping is geometry-sampled rather than a traced TRANSFORM_GIF clone. Vendor code was not executed or shipped.

## Runtime playback ownership and still-edit persistence

UI1833 e2 around byte117200 starts local GIF streaming only for a nonnegative onboard profile index and gifPlayWay local. It acquires the DetailGifPlayer locker; each tick can update the preview, but hardware dispatch additionally checks active state and busy suppression. Scopes contain main plus only currently following side ranges. Cleanup cancels the player callback and locker; it does not emit a dedicated stop opcode.

The e9 mount around byte123539 chooses gifPlayWay disabled for GIFAbility devices, proxy when window.parent differs from window, and local otherwise. The proxy path listens to GIF_PLAYER_COLOR_UPDATE and validates selected effect type/name and device identity before updating preview colors. A rebuilt native app must own its scheduler instead of relying on the embedded parent path.

Still-color changes in e8 around byte119000 are persisted to the active local library item after a300ms timer, by colors2KeyColorFrame followed by updateData of frames:[{data:...}]. GIF items do not pass through this still-edit writer. Switching library identity cancels the timer through effect cleanup; equivalent native edits must not land in a newly selected item.

The e9 still hardware callback also checks current active data identity and uses a maxQueueLength1 queue. After recent streaming activity, its helper flushes queued colors and reasserts still colors through the existing flushLightColors path. The exact flushLightColors transport implementation still requires tracing before treating a stopped animation as restored persistent lighting.

### Resolved flush helper

UI2233 byte458758 eY is the flushLightColors helper exported at462589. With clearQueueing it awaits abortAllMusicColor (or experimentAbortAllMusicColor when delegate is true), swallowing cancellation errors. If colors are supplied, it then calls setMusicKeyColors (or experimentSetMusicKeyColors for delegate), forwarding locker, scopes and side modes. A string is expanded to the model color count. Null plus clearQueueing only cancels host queued streaming; it does not write black or issue a firmware stop command. The neighboring changeLightColors helper at457647 uses persistent all/single key-color paths separately. Consequently a native restore sequence must distinguish queue cancellation, persistent static color updates, and transient streaming reassertion; these are not interchangeable operations. Delegate implementation and physical firmware transition timing remain unverified.
