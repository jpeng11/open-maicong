# G75 profile library operations: static evidence

Research for the remaining native profile library, from cached official chunk `2233-7ba109b328b2b69b.js` module78072 and `maicong-cz-readable.js`. Vendor code was read, not executed. This is not implemented behavior or hardware validation. See `G75_PROFILE_FILE_FORMAT.md` for portable data.

## Library transitions

- `tf` renames ordinary profiles through list persistence; official/cloud encoded names instead use `extra.displayName`. `tu` validates translated/display names and rejects conflicting ordinary names.
- `tg` removes requested entries, retaining at least one onboard profile. If the active entry is removed, it selects another onboard entry using the neighbor helper, then updates active index and forces synchronization. Deleting a list entry is not a factory-reset opcode.
- `tE` moves a local profile to an onboard target. Replacing a used slot first reads the outgoing hardware profile and swaps it into the source local position. Filling a free slot removes the local source and appends the new onboard entry. The slot is `order[length]`, not necessarily the lowest numeric unused index. Both new entries get fresh keys. The optional activation argument defaults to the multi-profile interaction capability.
- `tI` copies one onboard profile onto another distinct onboard target. It reads both, preserves the source onboard entry, and appends the outgoing target as a new local profile. This differs from the local-to-onboard swap. Activation defaults true.
- `tk` moves an onboard entry to local storage. Without a local target it reads hardware, removes the onboard entry, appends a new local entry, and requires another onboard entry to remain. With a local target it delegates to `tE` with activation false and reverses the returned source/destination keys.
- `tL` changes list order based on keys, leaving unspecified entries after specified entries. Persistence derives onboard order from the resulting list.

## List persistence and failure semantics

`ej` serializes mutations, normalizes each profile and extra metadata, and removes duplicate keys. It derives hardware length, names indexed by physical profile index, and an order containing used slots before unused slots. At least one onboard entry is required. It chooses a valid active slot if the requested one disappeared. It optimistically publishes the list, then awaits the operation's `beforeSet` (including profile writes), extended storage persistence, and hardware profile configuration. On failure it restores the prior UI list; this is not proof that earlier hardware writes rolled back. The native implementation must expose partial writes and retain recoverable outgoing data rather than claim transaction atomicity.

Module60908 `ec` updates changed base configuration and names separately, then reloads. Active-index changes include a one-second lock/delay for GLW. Its `es` loader reads base and profile names and synthesizes default names for active entries. **That vendor loader can write missing names on load. Do not copy startup writes into the native read-only connection path.**

## Profile-name wire storage

GLW channel `setProfileNames` / `getProfileNames` at SDK lines21268/21296 use custom JSON at relative offset336, length280. The SDK wrapper at35237 writes the names, then updates `profileNameUpdatedAt` in feature-support metadata. `setProfileNamesToAll` at35278 reads `maxKeyboardProfileLength` and writes every physical slot using one timestamp. `getProfileNames` delegates to the channel; the UI reads slot0.

The custom JSON encoder at20863 fills the region with255, overlays UTF-8 JSON bytes, and writes a length of `min(56*ceil((encodedLength+1)/56), regionLength)`. It silently truncates oversized data; a native implementation should instead reject oversized names before writes. The feature-support region at21325 is offset616/56. `Re`/`Pe` at38938 encode/decode `[macroUpdatedAt, profileNameUpdatedAt, browserId + "_" + browserIdExpiredAt.toString(36)]`. `updateFeatureSupport` reads the current object and merges the patch before encoding; preserve macro timestamp and browser ownership rather than resetting them. These reads and writes use each physical profile's custom region, not one global region. Tests must cover failed writes in later slots without falsely confirming all names, unchanged connection behavior, and reset/disconnect identity invalidation.

Empty names display `i18n<defaultOnboard>` concatenated with `index+1` except slot 0 (readable.js 12233). Packaged-device custom JSON may store those tokens literally. Display uses WD `replace(/i18n<([^>]+)>/g, t(key))` so `i18n<defaultOnboard>2` becomes English `Default Onboard2`; the suffix after `>` is not part of the key. Arbitrary user strings without that token are unchanged. Native keeps raw stored tokens, does not write names on query, and allocates local 2–15 names from the translated seed (`extra.storedName` holds the token). `tu` / `MAX_PROFILE_NAME_LENGTH` 15 still apply to user-created ordinary names.

## Remaining evidence and implementation requirements

The maximum profile count comes from `91972.Xf`, which reexports `s=20` in chunk1288. Module60908 exposes that as `maxProfileLength`. Module78072 computes ordinary-local remaining capacity (`tX`) as20 minus ordinary-local onboard entries minus ordinary-local driver entries; it separately computes raw total-list remaining capacity (`tQ`) and cloud capacity (`t$`). The English translation870 still says six configurations, but that string does not establish the current runtime limit. The inventory's six-item label is therefore stale evidence, not an implementation requirement. Follow the actual operation's capacity guard and count onboard ordinary profiles as well as driver-local entries; with four ordinary onboard entries, the ordinary-local remaining capacity is16.

Native implementation (source, mock-tested, not physical validation): sidebar library, CMD 241/242 names at 336/280 plus feature-support 616/56 without vendor `es` startup writes, tE/tI/tk/tg/tL, official version-3 KeyboardProfile import that creates a local item only and converts official MT/TGL into native hardware tables on later tE apply. Malformed nested official and local snapshots are refused; existing files are left unchanged. Cloud sync in these handlers remains unimplemented.

Capacity must be checked before transitions that preserve an outgoing target. Test nontrivial slot order, deletion of active and last onboard entries, local/onboard swaps, onboard-copy preservation, failed partial writes, macro references shared with untouched profiles, and names across all slots. Cloud synchronization in these handlers is a separate missing function; local persistence is not cloud parity.
