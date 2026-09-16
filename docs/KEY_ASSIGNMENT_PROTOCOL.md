# G75 V2 Key Assignment Protocol & Remap Palette Specification

This document defines the key assignment architecture, packed 24-bit decomposition, remap palette sets, layer gating, selector filtering, and legacy decoding compatibility for the MCHOSE G75 V2 keyboard.

---

## 1. Packed 24-Bit Decomposition Architecture

Vendor hub assets (`chunk 1833-29e749719b751fa6.js`, function `eG()`) encode palette entries as packed 24-bit integers (`val`). The runtime decomposes these values into GLW hardware 3-byte tuples `[type, code1, code2]`:

```javascript
let type = (val >> 16) & 0xff;
let code1 = (val >> 8) & 0xff;
let code2 = val & 0xff;
if (code1 === 255) {
  type = 240; // FN layer keycode override
}
```

### Types confirmed from static protocol evidence and simulated tests

Physical configuration writes have not been tested.
- `0`: Disabled (`[0, 0, 0]`)
- `16`: Standard Keyboard Key / Modifier / Shortcut Chord (`[16, modifierMask, hidUsage]`)
- `32`: Mouse Button (`[32, buttonMask, 0]`)
- `33`: Mouse Wheel (`[33, 0, direction]`) where direction `1` = Up, `255` = Down
- `48`: Media / Consumer Usage (`[48, usageLowByte, usageHighByte]`)
- `64`: System Power / Sleep / Wake (`[64, usage, 0]`)
- `112`: Macro Slot Trigger (`[112, slotIndex, playbackType]`)
- `145`: Toggle (TGL) (`[145, tableIndex, 0]`)
- `146`: Mod-Tap (MT) (`[146, tableIndex, delayMs / 10]`)
- `148`: Simultaneous Opposing Cardinal Direction (SOCD) (`[148, tableIndex, partnerSlot]`)
- `240`: Lighting Control, Switch Profile, and Fn Layer (`[240, code1, code2]`)

---

## 2. Exact G75 Palette Category Sets

Visible palette categories strictly reflect the reverse-engineered `eG()` definition for G75 V2 (which has `GLWRemapkableLightV2=false` and `sideLightType=indicator`):

### 1. `Basic` (104 items)
Contains standard HID keyboard keys (letters, numbers, function keys F1–F12, keypad, navigation) and single modifier keys (`Left Ctrl`, `Left Shift`, `Left Alt`, `Left Win`, `Right Ctrl`, `Right Shift`, `Right Alt`, `Right Win`).
- Standard keys have `type = 16`, `code1 = 0`, `code2 = hidUsage`.
- Single modifiers have `type = 16`, `code1 = modifierMask`, `code2 = 0`.

### 2. `Mouse` (7 items)
- Mouse Left: `[32, 1, 0]`
- Mouse Right: `[32, 2, 0]`
- Mouse Middle: `[32, 4, 0]`
- Mouse Back: `[32, 8, 0]`
- Mouse Forward: `[32, 16, 0]`
- Mouse Wheel Up: `[33, 0, 1]`
- Mouse Wheel Down: `[33, 0, 255]`

### 3. `Media` (7 items Windows, 6 items Mac)
Consumer audio controls:
- Volume Up (`[48, 233, 0]`)
- Volume Down (`[48, 234, 0]`)
- Mute (`[48, 226, 0]`)
- Play / Pause (`[48, 205, 0]`)
- Next Track (`[48, 181, 0]`)
- Prev Track (`[48, 182, 0]`)
- Stop (`[48, 183, 0]`) — dynamically filtered out on Mac layers (`layer % 4 === 2 || layer % 4 === 3`) per `eG()`.

### 4. `Main Lighting` (9 items)
Backlight controls (type 240):
- Backlight Mode + / - (`[240, 47, 0]`, `[240, 46, 0]`)
- Backlight Brightness + / - (`[240, 50, 0]`, `[240, 51, 0]`)
- Backlight Speed + / - (`[240, 54, 0]`, `[240, 55, 0]`)
- Backlight Color + / - (`[240, 61, 0]`, `[240, 60, 0]`)
- Backlight Toggle (`[240, 53, 0]`)

### 5. `Side Lighting` (8 items)
Indicator side lighting controls (type 240):
- Side Light Mode (`[240, 160, 0]`)
- Side Light Brightness + / - (`[240, 21, 0]`, `[240, 22, 0]`)
- Side Light Speed + / - (`[240, 24, 0]`, `[240, 23, 0]`)
- Side Light Color (`[240, 26, 0]`)
- Side Light On / Off (`[240, 28, 0]`)
- Indicator Speed Switch (`[240, 25, 0]`)

### 6. `Extended` (Layer-Specific)
Dynamic array composed of OS-specific shortcuts + special actions:
- **Windows Layers (0 & 1)**: `windowsExtra47` (47 verified Windows shortcuts like Copy, Paste, Cut, Undo, File Explorer, Task Manager, Run, Screen Brightness, etc.).
- **Mac Layers (2 & 3)**: `macExtra32` (32 verified macOS shortcuts like Spotlight, Mission Control, Launchpad, Siri, Force Quit, Screen Brightness, etc.).
- **Common Controls**:
  - `Switch Profile`: `[240, 250, 0]` (`disabledAdvanceTypes: ['tgl']`)
  - `Clear`: `[16, 0, 0]`
- **Base-Layer Fn Key**:
  - Layer 0: `[240, 255, 1]` (`disabledAdvanceTypes: ['dks', 'tgl', 'rs', 'socd', 'lt', 'cb']`)
  - Layer 2: `[240, 255, 3]` (`disabledAdvanceTypes: ['dks', 'tgl', 'rs', 'socd', 'lt', 'cb']`)
  - Layers 1 & 3 (Fn layers): Fn key is omitted per `eG()`.

---

## 3. Layer Count Matrix

| Layer | OS Mode | Layer Type | Basic | Mouse | Media | Main Light | Side Light | Extended | Total Palette Items |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **0** | Windows | Default | 104 | 7 | 7 | 9 | 8 | 50 | **185** |
| **1** | Windows | Fn | 104 | 7 | 7 | 9 | 8 | 49 | **184** |
| **2** | Mac | Default | 104 | 7 | 6 | 9 | 8 | 35 | **169** |
| **3** | Mac | Fn | 104 | 7 | 6 | 9 | 8 | 34 | **168** |

---

## 4. Selector Exclusions & Advanced Key Gating

### Macro Keyboard Selector (`isMacroKeyboardItem`)
Macro keyboard action builder allows standard keycodes and single modifier keys. It strictly excludes:
- Shortcut chords (`type === 16 && code1 > 0 && code2 > 0`)
- Mouse items (`type === 32 || type === 33`)
- Media keys (`type === 48`)
- Lighting controls (`type === 240`)
- Special commands (Switch Profile, Fn layer, Clear `[16, 0, 0]`)

### Combination Key (CB) Selectors
- **Modifier Selector (`adv-cb-modifier`, mode: `'hot'`)**: Only permits single modifier tuples (`type === 16 && code1 > 0 && code2 === 0`).
- **Regular Key Selector (`adv-cb-regular`, mode: `'normal'`)**: Only permits non-chord standard keys (`type === 16 && code1 === 0 && code2 > 0`).

### Ordinary Table & TGL Targets
`ORDINARY_TABLE_KEY_TYPES` includes `0, 16, 32, 33, 48, 64, 240`.
- Mouse buttons (`type 32`) and mouse wheel (`type 33`) are permitted in ordinary table targets (MT tap/hold, TGL targets).
- TGL target selector (`mode: 'tgl'`) excludes Media (`type 48`), Switch Profile (`[240, 250, 0]`), and Fn (`[240, 255, 1/3]`).

---

## 5. Backward Compatibility & Decode Guarantees

1. **Non-enumerable Category Getters**:
   Legacy code querying `REMAP_CATEGORIES['Lighting']`, `'Media & Audio'`, `'Extended Func'`, or `'Special & Extra'` receives valid arrays without duplicating tabs in the UI.
2. **Decode Preservation**:
   - `[0, 0, 0]` decodes to `Disabled`
   - `[16, 0, 0]` decodes to `Clear`
   - `[240, 250, 0]` decodes to `Switch Profile`
   - `[240, 255, 1]` and `[240, 255, 3]` decode to `FN Layer`
   - All 61 verified shortcut chords decode to human-readable labels (e.g. `Copy`, `Paste`, `Run`)
   - Existing onboard Fn defaults (including special hardware commands) decode safely without crash or loss.
3. **Safety Enforcement**:
   All hardware writes are strictly checked by `validateKeymapUpdates` and `validateAdvancedBinding` before any packet generation.
