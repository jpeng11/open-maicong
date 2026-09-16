# G75 V2 lighting scope evidence

Public vendor asset inspected statically; never executed or bundled. Local reference `/tmp/maicong-cz-layout-g75_v2.js` declares `name: g75_v2` and an unconditional lighting object. Its main effect list has exactly the 23 IDs 0 through 22 (in vendor display order); it does not include `light-23` (Sword Array). Its sideEffect list is exactly `side-light-neon-1`, `side-light-constant-on-2`, `side-light-breathing-3`, `side-light-off-4`, with sideLightType `indicator`. It does not include `side-light-follow-light-mode-0`.

The readable public SDK `/tmp/maicong-cz-readable.js` lines 4180–4232 resolves the model lighting definition and maps precisely its listed effect and sideEffect entries to controls. Generic table definitions at lines 3819–3834 describe backsync and Sword Array, and lines 3845–3851 map side-light-follow-light-mode-0 to value 0; their presence in the generic catalog does not add them to this model.

Consequently the existing 23 main / four side effect choices match the shipped G75 V2 layout evidence. Treat generic Sword Array and follow-main translations as other-model catalog entries, not established missing G75 controls. This static evidence does not establish live hardware write behavior or resolve GIF, music, cloud-library, or other independently gated capabilities.

## GIF capability nuance

Do not infer absence of the GIF workflow from G75 lacking GIFAbility. SDK readable9450..9460 defaults that flag false, but UI chunk1833 at bytes123539 and124979 chooses gifPlayWay `disabled` when GIFAbility is true and `local`/`proxy` when false. This indicates host playback versus hardware playback distinction. Standalone source now implements the host (`local`) path; it is not onboard GIFAbility storage. Do not mark it other-model merely from the flag.

## Effect-dependent controls (resolved from the actual UI)

SDK `main.348b62de2cbadb6bbe3e.js`, readable lines 3536–4020, joins catalog C capability flags with map A effect keys. G75 model restricts this to its declared 23 main and four side entries. UI chunk `1833-29e749719b751fa6.js`, component q at `directionName`, hides speed/brightness/direction unless the selected effect flag is true. Component $ disables the custom-color switch for effects with color=false. These flags are product UI behavior, not new wire commands.

| Effect key | Catalog entry | Brightness | Speed | Color | Direction family |
| :--- | :--- | :--- | :--- | :--- | :--- |
| light-0 | 0 | yes | no | yes | none |
| light-1 | auroramapping | yes | yes | no | none |
| light-2 | shadowsteps | yes | no | yes | none |
| light-3 | iconTranquility | yes | no | yes | none |
| light-4 | pulsation | yes | yes | yes | none |
| light-5 | flowerdance | yes | yes | no | none |
| light-6 | tidalrhythm | yes | yes | yes | row |
| light-7 | surgingtide | yes | yes | yes | col |
| light-8 | colorfulfountain | yes | yes | yes | spiral |
| light-9 | galaxyroaming | yes | yes | yes | none |
| light-10 | spiral | yes | yes | yes | clock |
| light-11 | surgerhythm | yes | yes | yes | none |
| light-12 | iconOcean | yes | yes | yes | none |
| light-13 | rippledance | yes | yes | yes | none |
| light-14 | ripple | yes | yes | yes | none |
| light-15 | instantflash | yes | yes | yes | none |
| light-16 | matrixshadows | yes | yes | yes | none |
| light-17 | melodypiano | yes | yes | yes | none |
| light-18 | flowdance | yes | yes | yes | none |
| light-19 | iconRaining | yes | yes | yes | none |
| light-20 | iconStars | yes | yes | yes | none |
| light-21 | iconFireworks | yes | yes | yes | none |
| light-22 | rippleflow | yes | yes | yes | none |
| side-light-neon-1 | iconNeon | yes | yes | no | none |
| side-light-constant-on-2 | constanton | yes | no | yes | none |
| side-light-breathing-3 | iconBreathing | yes | yes | yes | none |
| side-light-off-4 | iconOff | no | no | no | none |

Provider chunk `2233-7ba109b328b2b69b.js` selects P for manufacturer `glw` (G75), rather than QHW A. Its LightDirectName pairs are row: translation261/value0 and262/value1; col:263/0 and264/1; spiral:265/0 and266/1; clock:267/0 and268/1. All are the existing two-value direction field, with effect-specific labels. This resolves the apparent “eight direction values” gap: eight translated labels describe four pairs, not eight values for every effect. QHW reverses col/clock mappings and must not be copied for G75.

Standalone UI in this tree: 22 main preset tiles in the order above (Custom is a separate entry, not a 23rd tile), four side tiles, GLW direction pairs, and capability gating that hides unsupported speed/brightness/direction and disables color when the catalog flag is false. Unknown firmware effect IDs stay selected as unrecognized and are not coerced by unrelated edits. Main Normal light / Custom tabs now host a local still library (create/select/rename/delete, 83-zone still edits, selectedLightEffect 241/242) and a local GIF library (import/edit/play, host CMD 221). Cloud, share-code, and side still libraries remain unimplemented; G75 has no side customEffectValue. This document records static source evidence; no live lighting writes were performed.

Verified English locale labels (`/tmp/maicong-vendor-en.json`):

| Family | Value 0 | Value 1 |
| :--- | :--- | :--- |
| row | Left to Right | Right to Left |
| col | From top to bottom | From bottom to top |
| spiral | From the inside out | From the outside in |
| clock | Rotate counterclockwise | Rotate clockwise |

Exact G75 main-effect display order: `0,6,7,8,9,4,1,5,3,2,11,12,10,18,19,20,21,22,14,13,15,16,17`. Side display order is `1,2,3,4`. Do not replace the vendor order with numerical sorting.

## Official English effect labels

The actual UI renders `t(effect.lang)`. The SDK symbolic property names (such as matrixshadows) are not the displayed English labels. The shipped English locale resolves these as follows; reference translation strings only for catalog entries already proven available on G75.

| Effect key | Locale key | English label |
| :--- | :--- | :--- |
| light-0 | 201 | Custom |
| light-1 | 202 | RainbowCycle |
| light-2 | 203 | Linear Grad |
| light-3 | 204 | Constant On |
| light-4 | 205 | Breath |
| light-5 | 206 | Disco |
| light-6 | 207 | Horiz Wave |
| light-7 | 208 | Vert Wave |
| light-8 | 209 | Center Spread |
| light-9 | 210 | Star Twinkle |
| light-10 | 211 | Center Spin |
| light-11 | 212 | Bottom Up |
| light-12 | 213 | Recip Rebound |
| light-13 | 214 | Key Ripple |
| light-14 | 215 | Solid Ripple |
| light-15 | 216 | Key Trail |
| light-16 | 217 | Key Firework |
| light-17 | 218 | Key Beam |
| light-18 | 219 | Diag Flow |
| light-19 | 220 | Laser Rain |
| light-20 | 223 | Dot Twinkle |
| light-21 | 224 | Fireworks |
| light-22 | 221 | Triangle Bounce |
| side-light-neon-1 | 2050 | RainbowCycle |
| side-light-constant-on-2 | 2051 | Constant On |
| side-light-breathing-3 | 2052 | Breath |
| side-light-off-4 | 225 | Off |

## Preset grid versus custom lighting

UI1833 e_ filters the main effect grid through `whichLightEffectType(value, "main").includes("normal")`. GLW provider2233 module70458 classifies effect0 as `["still","gif"]` and every other value as `["normal"]`. Thus the actual built-in main grid contains **22 tiles**, in the above order with0 removed. Custom static/animation is reached through the separate library/editor workflow, not a23rd ordinary preset tile. The G75 catalog does not set hasLightOffBtn; the SDK accessor defaults false, so the generic synthetic Off/-1 brightness-zero tile is not proven part of this model's main grid. Side Off remains actual ID4.

Custom is the Local still and GIF libraries, not a 23rd preset tile. Reproduce the22 built-in preset tiles and four side tiles exactly. Do not mislabel cloud/share as completed.
