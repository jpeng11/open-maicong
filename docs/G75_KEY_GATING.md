# G75 V2 key-palette visibility evidence

Static inspection of public hub assets; never executed or shipped.

- UI chunk `1833-29e749719b751fa6.js`, function `eG()` at byte223778: the actual GLW remap palette builder. Preceding arrays eB (Windows) and eQ (Mac) contain Extra shortcuts. `eU(layer)` is true for layer modulo4 equal2 or3. Exact bounded excerpts are saved to `/tmp/maicong-g75-palette-source.txt`.
- G75V2 catalog at byte96625 in chunk1288 explicitly sets GLWRemapkableLightV2=false. It has no hasLightScopeType override; SDK readable lines9469–9477 default absent flag to false. G75 layout has sideLightType=indicator, no sideLightType2. Therefore eG takes r=false,o=true,c=false lighting branch:9 main actions +8 first-side actions, no side2 and no V2 scoped-light commands.
- Mouse list exactly:2097408,2097664,2098176,2101248,2099200,2162689,2162943 (five buttons and wheel directions).
- Main lighting list:15740672,15740416,15741440,15741696,15742464,15742720,15744256,15744000,15742208.
- First side-light list:15769600,15734016,15734272,15734784,15734528,15735040,15735296,15735808. Display labels resolved by generic GLW display map and sideLightType=indicator, not guessed from variable names.
- Extra list is eB or eQ by layer, plus d: Switch Profile15792640 (disables TGL), Clear1048576, optional OpenHub only when OpenMHubAbility enabled, and FN15793921 on Win base0 /15793923 on Mac base2. Fn absent on Fn layers. These are actual UI lists, unlike the larger registry.
- Reset15730688, WinLock15729152 and Show Battery are present in general code tables but NOT in the inspected eG visible palette arrays. Do not call them missing palette controls or expose them solely from generic registry evidence. Existing onboard Fn defaults may still contain special tuples and must remain readable/preservable.

Implementation review must compare rendered G75 controls against eG, including complete layer-aware Extra shortcuts. Do not substitute newer protocol registry types (Mouse0, KeyboardNormal17, SwitchProfile51 etc at readable49330+) for GLW packed values. GLW packed parser at48696–48735 yields type highbyte,code1 middlebyte,code2 lowbyte, with code1=255 forcingtype240.
