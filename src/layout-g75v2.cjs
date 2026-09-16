/**
 * MCHOSE G75 V2 Keyboard Physical Layout & Matrix Definition
 * Exact 82 physical elements (81 keys + 1 rotary knob).
 * Geometry matches the public G75 V2 layout. Immutable CMD7 defaults ship in
 * src/data/default-layers.json (packaged). Never fall back to Win-layer tuples.
 */

// Vendor display order including Custom (effect 0). Preset grid is this list without 0.
const LIGHT_EFFECT_DISPLAY_ORDER = [0, 6, 7, 8, 9, 4, 1, 5, 3, 2, 11, 12, 10, 18, 19, 20, 21, 22, 14, 13, 15, 16, 17];
const LIGHT_EFFECT_PRESET_ORDER = LIGHT_EFFECT_DISPLAY_ORDER.filter((id) => id !== 0);
const SIDE_LIGHT_DISPLAY_ORDER = [1, 2, 3, 4];

const LIGHT_DIRECTION_PAIRS = {
  row: { 0: 'Left to Right', 1: 'Right to Left' },
  col: { 0: 'From top to bottom', 1: 'From bottom to top' },
  spiral: { 0: 'From the inside out', 1: 'From the outside in' },
  clock: { 0: 'Rotate counterclockwise', 1: 'Rotate clockwise' }
};

function lightCaps(name, kinds, brightness, speed, color, direction) {
  return { name, kinds, brightness, speed, color, direction };
}

// 23 official main effect IDs 0..22. Names are hub English locale, not SDK symbols.
const LIGHT_EFFECTS = [
  { id: 0, key: 'light-0', ...lightCaps('Custom', ['still', 'gif'], true, false, true, null) },
  { id: 1, key: 'light-1', ...lightCaps('RainbowCycle', ['normal'], true, true, false, null) },
  { id: 2, key: 'light-2', ...lightCaps('Linear Grad', ['normal'], true, false, true, null) },
  { id: 3, key: 'light-3', ...lightCaps('Constant On', ['normal'], true, false, true, null) },
  { id: 4, key: 'light-4', ...lightCaps('Breath', ['normal'], true, true, true, null) },
  { id: 5, key: 'light-5', ...lightCaps('Disco', ['normal'], true, true, false, null) },
  { id: 6, key: 'light-6', ...lightCaps('Horiz Wave', ['normal'], true, true, true, 'row') },
  { id: 7, key: 'light-7', ...lightCaps('Vert Wave', ['normal'], true, true, true, 'col') },
  { id: 8, key: 'light-8', ...lightCaps('Center Spread', ['normal'], true, true, true, 'spiral') },
  { id: 9, key: 'light-9', ...lightCaps('Star Twinkle', ['normal'], true, true, true, null) },
  { id: 10, key: 'light-10', ...lightCaps('Center Spin', ['normal'], true, true, true, 'clock') },
  { id: 11, key: 'light-11', ...lightCaps('Bottom Up', ['normal'], true, true, true, null) },
  { id: 12, key: 'light-12', ...lightCaps('Recip Rebound', ['normal'], true, true, true, null) },
  { id: 13, key: 'light-13', ...lightCaps('Key Ripple', ['normal'], true, true, true, null) },
  { id: 14, key: 'light-14', ...lightCaps('Solid Ripple', ['normal'], true, true, true, null) },
  { id: 15, key: 'light-15', ...lightCaps('Key Trail', ['normal'], true, true, true, null) },
  { id: 16, key: 'light-16', ...lightCaps('Key Firework', ['normal'], true, true, true, null) },
  { id: 17, key: 'light-17', ...lightCaps('Key Beam', ['normal'], true, true, true, null) },
  { id: 18, key: 'light-18', ...lightCaps('Diag Flow', ['normal'], true, true, true, null) },
  { id: 19, key: 'light-19', ...lightCaps('Laser Rain', ['normal'], true, true, true, null) },
  { id: 20, key: 'light-20', ...lightCaps('Dot Twinkle', ['normal'], true, true, true, null) },
  { id: 21, key: 'light-21', ...lightCaps('Fireworks', ['normal'], true, true, true, null) },
  { id: 22, key: 'light-22', ...lightCaps('Triangle Bounce', ['normal'], true, true, true, null) }
];

const SIDE_LIGHT_EFFECTS = [
  { id: 1, key: 'side-light-neon-1', name: 'RainbowCycle', brightness: true, speed: true, color: false, direction: null },
  { id: 2, key: 'side-light-constant-on-2', name: 'Constant On', brightness: true, speed: false, color: true, direction: null },
  { id: 3, key: 'side-light-breathing-3', name: 'Breath', brightness: true, speed: true, color: true, direction: null },
  { id: 4, key: 'side-light-off-4', name: 'Off', brightness: false, speed: false, color: false, direction: null }
];

function getLightEffectById(id) {
  return LIGHT_EFFECTS.find((e) => e.id === id) || null;
}

function getSideLightEffectById(id) {
  return SIDE_LIGHT_EFFECTS.find((e) => e.id === id) || null;
}

function getMainPresetEffects() {
  return LIGHT_EFFECT_PRESET_ORDER.map((id) => getLightEffectById(id)).filter(Boolean);
}

function getSidePresetEffects() {
  return SIDE_LIGHT_DISPLAY_ORDER.map((id) => getSideLightEffectById(id)).filter(Boolean);
}

function getDirectionPair(family) {
  return family && LIGHT_DIRECTION_PAIRS[family] ? LIGHT_DIRECTION_PAIRS[family] : null;
}

// Exact G75 eG Tuple Sets (Reverse-engineered from hub chunk 1833 eG() and verified English display tables)
const G75_PALETTE_SETS = {
  basic104: [
  {
    "type": 16,
    "code1": 0,
    "code2": 4,
    "code": 4,
    "label": "A"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 5,
    "code": 5,
    "label": "B"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 6,
    "code": 6,
    "label": "C"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 7,
    "code": 7,
    "label": "D"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 8,
    "code": 8,
    "label": "E"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 9,
    "code": 9,
    "label": "F"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 10,
    "code": 10,
    "label": "G"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 11,
    "code": 11,
    "label": "H"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 12,
    "code": 12,
    "label": "I"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 13,
    "code": 13,
    "label": "J"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 14,
    "code": 14,
    "label": "K"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 15,
    "code": 15,
    "label": "L"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 16,
    "code": 16,
    "label": "M"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 17,
    "code": 17,
    "label": "N"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 18,
    "code": 18,
    "label": "O"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 19,
    "code": 19,
    "label": "P"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 20,
    "code": 20,
    "label": "Q"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 21,
    "code": 21,
    "label": "R"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 22,
    "code": 22,
    "label": "S"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 23,
    "code": 23,
    "label": "T"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 24,
    "code": 24,
    "label": "U"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 25,
    "code": 25,
    "label": "V"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 26,
    "code": 26,
    "label": "W"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 27,
    "code": 27,
    "label": "X"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 28,
    "code": 28,
    "label": "Y"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 29,
    "code": 29,
    "label": "Z"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 30,
    "code": 30,
    "label": "1 !"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 31,
    "code": 31,
    "label": "2 @"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 32,
    "code": 32,
    "label": "3 #"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 33,
    "code": 33,
    "label": "4 $"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 34,
    "code": 34,
    "label": "5 %"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 35,
    "code": 35,
    "label": "6 ^"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 36,
    "code": 36,
    "label": "7 &"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 37,
    "code": 37,
    "label": "8 *"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 38,
    "code": 38,
    "label": "9 ("
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 39,
    "code": 39,
    "label": "0 )"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 53,
    "code": 53,
    "label": "` ~"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 45,
    "code": 45,
    "label": "- _"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 46,
    "code": 46,
    "label": "= +"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 47,
    "code": 47,
    "label": "[ {"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 48,
    "code": 48,
    "label": "] }"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 49,
    "code": 49,
    "label": "\\ |"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 51,
    "code": 51,
    "label": "; :"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 52,
    "code": 52,
    "label": "' \""
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 54,
    "code": 54,
    "label": ", <"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 55,
    "code": 55,
    "label": ". >"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 56,
    "code": 56,
    "label": "/ ?"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 41,
    "code": 41,
    "label": "Esc"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 43,
    "code": 43,
    "label": "Tab"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 57,
    "code": 57,
    "label": "Caps Lock"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 0,
    "code": 227,
    "label": "Left GUI / Win"
  },
  {
    "type": 16,
    "code1": 128,
    "code2": 0,
    "code": 231,
    "label": "Right GUI / Win"
  },
  {
    "type": 16,
    "code1": 4,
    "code2": 0,
    "code": 226,
    "label": "Left Alt / Option"
  },
  {
    "type": 16,
    "code1": 1,
    "code2": 0,
    "code": 224,
    "label": "Left Ctrl"
  },
  {
    "type": 16,
    "code1": 2,
    "code2": 0,
    "code": 225,
    "label": "Left Shift"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 42,
    "code": 42,
    "label": "Backspace"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 40,
    "code": 40,
    "label": "Enter"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 44,
    "code": 44,
    "label": "Space"
  },
  {
    "type": 16,
    "code1": 64,
    "code2": 0,
    "code": 230,
    "label": "Right Alt / Option"
  },
  {
    "type": 16,
    "code1": 16,
    "code2": 0,
    "code": 228,
    "label": "Right Ctrl"
  },
  {
    "type": 16,
    "code1": 32,
    "code2": 0,
    "code": 229,
    "label": "Right Shift"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 70,
    "code": 70,
    "label": "Print Screen"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 71,
    "code": 71,
    "label": "Scroll Lock"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 72,
    "code": 72,
    "label": "Pause"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 73,
    "code": 73,
    "label": "Insert"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 76,
    "code": 76,
    "label": "Delete"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 74,
    "code": 74,
    "label": "Home"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 77,
    "code": 77,
    "label": "End"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 75,
    "code": 75,
    "label": "PgUp"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 78,
    "code": 78,
    "label": "PgDn"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 82,
    "code": 82,
    "label": "Up ↑"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 81,
    "code": 81,
    "label": "Down ↓"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 80,
    "code": 80,
    "label": "Left ←"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 79,
    "code": 79,
    "label": "Right →"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 58,
    "code": 58,
    "label": "F1"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 59,
    "code": 59,
    "label": "F2"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 60,
    "code": 60,
    "label": "F3"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 61,
    "code": 61,
    "label": "F4"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 62,
    "code": 62,
    "label": "F5"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 63,
    "code": 63,
    "label": "F6"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 64,
    "code": 64,
    "label": "F7"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 65,
    "code": 65,
    "label": "F8"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 66,
    "code": 66,
    "label": "F9"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 67,
    "code": 67,
    "label": "F10"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 68,
    "code": 68,
    "label": "F11"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 69,
    "code": 69,
    "label": "F12"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 83,
    "code": 83,
    "label": "Num Lock"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 98,
    "code": 98,
    "label": "Num 0"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 89,
    "code": 89,
    "label": "Num 1"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 90,
    "code": 90,
    "label": "Num 2"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 91,
    "code": 91,
    "label": "Num 3"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 92,
    "code": 92,
    "label": "Num 4"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 93,
    "code": 93,
    "label": "Num 5"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 94,
    "code": 94,
    "label": "Num 6"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 95,
    "code": 95,
    "label": "Num 7"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 96,
    "code": 96,
    "label": "Num 8"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 97,
    "code": 97,
    "label": "Num 9"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 87,
    "code": 87,
    "label": "Num +"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 86,
    "code": 86,
    "label": "Num -"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 85,
    "code": 85,
    "label": "Num *"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 84,
    "code": 84,
    "label": "Num /"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 99,
    "code": 99,
    "label": "Num ."
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 88,
    "code": 88,
    "label": "Num Enter"
  },
  {
    "type": 16,
    "code1": 0,
    "code2": 101,
    "code": 101,
    "label": "Menu / App"
  }
],
  mouse7: [
  {
    "type": 32,
    "code1": 1,
    "code2": 0,
    "code": 1,
    "label": "Left mouse button"
  },
  {
    "type": 32,
    "code1": 2,
    "code2": 0,
    "code": 2,
    "label": "Right mouse button"
  },
  {
    "type": 32,
    "code1": 4,
    "code2": 0,
    "code": 4,
    "label": "Middle mouse button"
  },
  {
    "type": 32,
    "code1": 16,
    "code2": 0,
    "code": 16,
    "label": "Mouse forward"
  },
  {
    "type": 32,
    "code1": 8,
    "code2": 0,
    "code": 8,
    "label": "Mouse backward"
  },
  {
    "type": 33,
    "code1": 0,
    "code2": 1,
    "code": 1,
    "label": "Wheel up"
  },
  {
    "type": 33,
    "code1": 0,
    "code2": 255,
    "code": 255,
    "label": "Wheel down"
  }
],
  media7: [
  {
    "type": 48,
    "code1": 205,
    "code2": 0,
    "code": 205,
    "label": "Play / Pause",
    "disabledAdvanceTypes": [
      "tgl"
    ]
  },
  {
    "type": 48,
    "code1": 226,
    "code2": 0,
    "code": 226,
    "label": "Mute",
    "disabledAdvanceTypes": [
      "tgl"
    ]
  },
  {
    "type": 48,
    "code1": 183,
    "code2": 0,
    "code": 183,
    "label": "Stop",
    "disabledAdvanceTypes": [
      "tgl"
    ]
  },
  {
    "type": 48,
    "code1": 182,
    "code2": 0,
    "code": 182,
    "label": "Prev Track",
    "disabledAdvanceTypes": [
      "tgl"
    ]
  },
  {
    "type": 48,
    "code1": 181,
    "code2": 0,
    "code": 181,
    "label": "Next Track",
    "disabledAdvanceTypes": [
      "tgl"
    ]
  },
  {
    "type": 48,
    "code1": 233,
    "code2": 0,
    "code": 233,
    "label": "Volume Up",
    "disabledAdvanceTypes": [
      "tgl"
    ]
  },
  {
    "type": 48,
    "code1": 234,
    "code2": 0,
    "code": 234,
    "label": "Volume Down",
    "disabledAdvanceTypes": [
      "tgl"
    ]
  }
],
  mainLighting9: [
  {
    "type": 240,
    "code1": 47,
    "code2": 0,
    "code": 47,
    "label": "Backlight Mode Switch→"
  },
  {
    "type": 240,
    "code1": 46,
    "code2": 0,
    "code": 46,
    "label": "Backlight Mode Switch←"
  },
  {
    "type": 240,
    "code1": 50,
    "code2": 0,
    "code": 50,
    "label": "Backlight brightness +"
  },
  {
    "type": 240,
    "code1": 51,
    "code2": 0,
    "code": 51,
    "label": "Backlight brightness -"
  },
  {
    "type": 240,
    "code1": 54,
    "code2": 0,
    "code": 54,
    "label": "Backlight speed +"
  },
  {
    "type": 240,
    "code1": 55,
    "code2": 0,
    "code": 55,
    "label": "Backlight speed -"
  },
  {
    "type": 240,
    "code1": 61,
    "code2": 0,
    "code": 61,
    "label": "Switch backlight color→"
  },
  {
    "type": 240,
    "code1": 60,
    "code2": 0,
    "code": 60,
    "label": "Switch backlight color←"
  },
  {
    "type": 240,
    "code1": 53,
    "code2": 0,
    "code": 53,
    "label": "Toggle keyboard backlight"
  }
],
  sideLighting8: [
  {
    "type": 240,
    "code1": 160,
    "code2": 0,
    "code": 160,
    "label": "Switch indicator mode"
  },
  {
    "type": 240,
    "code1": 21,
    "code2": 0,
    "code": 21,
    "label": "Indicator brightness +"
  },
  {
    "type": 240,
    "code1": 22,
    "code2": 0,
    "code": 22,
    "label": "Indicator brightness -"
  },
  {
    "type": 240,
    "code1": 24,
    "code2": 0,
    "code": 24,
    "label": "Indicator speed +"
  },
  {
    "type": 240,
    "code1": 23,
    "code2": 0,
    "code": 23,
    "label": "Indicator speed -"
  },
  {
    "type": 240,
    "code1": 25,
    "code2": 0,
    "code": 25,
    "label": "Indicator Speed Switch"
  },
  {
    "type": 240,
    "code1": 26,
    "code2": 0,
    "code": 26,
    "label": "Switch indicator color"
  },
  {
    "type": 240,
    "code1": 28,
    "code2": 0,
    "code": 28,
    "label": "Indicator On/Off"
  }
],
  windowsExtra47: [
  {
    "type": 16,
    "code1": 1,
    "code2": 45,
    "code": 45,
    "label": "Zoom out"
  },
  {
    "type": 16,
    "code1": 1,
    "code2": 46,
    "code": 46,
    "label": "Zoom in"
  },
  {
    "type": 16,
    "code1": 1,
    "code2": 39,
    "code": 39,
    "label": "Reset"
  },
  {
    "type": 16,
    "code1": 1,
    "code2": 28,
    "code": 28,
    "label": "Restore"
  },
  {
    "type": 16,
    "code1": 1,
    "code2": 29,
    "code": 29,
    "label": "Undo"
  },
  {
    "type": 16,
    "code1": 1,
    "code2": 4,
    "code": 4,
    "label": "Select all"
  },
  {
    "type": 16,
    "code1": 1,
    "code2": 17,
    "code": 17,
    "label": "Create"
  },
  {
    "type": 16,
    "code1": 1,
    "code2": 6,
    "code": 6,
    "label": "Copy"
  },
  {
    "type": 16,
    "code1": 1,
    "code2": 27,
    "code": 27,
    "label": "Cut"
  },
  {
    "type": 16,
    "code1": 1,
    "code2": 25,
    "code": 25,
    "label": "Paste"
  },
  {
    "type": 16,
    "code1": 1,
    "code2": 22,
    "code": 22,
    "label": "Save"
  },
  {
    "type": 16,
    "code1": 1,
    "code2": 18,
    "code": 18,
    "label": "Open"
  },
  {
    "type": 16,
    "code1": 1,
    "code2": 23,
    "code": 23,
    "label": "New Item"
  },
  {
    "type": 16,
    "code1": 1,
    "code2": 26,
    "code": 26,
    "label": "Close item"
  },
  {
    "type": 16,
    "code1": 4,
    "code2": 80,
    "code": 80,
    "label": "Back (keyboard)"
  },
  {
    "type": 16,
    "code1": 4,
    "code2": 79,
    "code": 79,
    "label": "Forward (keyboard)"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 43,
    "code": 43,
    "label": "switch window"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 7,
    "code": 7,
    "label": "Show desktop"
  },
  {
    "type": 16,
    "code1": 9,
    "code2": 88,
    "code": 88,
    "label": "Open navigation"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 23,
    "code": 23,
    "label": "Cycle taskbar Apps"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 4,
    "code": 4,
    "label": "Action center"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 8,
    "code": 8,
    "label": "File Explorer"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 12,
    "code": 12,
    "label": "Windows settings center"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 15,
    "code": 15,
    "label": "Lock computer"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 14,
    "code": 14,
    "label": "Cast screen to other devices"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 5,
    "code": 5,
    "label": "Jump to tray"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 10,
    "code": 10,
    "label": "Start Xbox game bar"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 21,
    "code": 21,
    "label": "Run"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 22,
    "code": 22,
    "label": "Search"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 24,
    "code": 24,
    "label": "Display settings"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 27,
    "code": 27,
    "label": "Simple menu"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 55,
    "code": 55,
    "label": "Emoji box"
  },
  {
    "type": 16,
    "code1": 1,
    "code2": 41,
    "code": 41,
    "label": "Start menu"
  },
  {
    "type": 16,
    "code1": 4,
    "code2": 43,
    "code": 43,
    "label": "Taskbar"
  },
  {
    "type": 16,
    "code1": 4,
    "code2": 61,
    "code": 61,
    "label": "Close window"
  },
  {
    "type": 16,
    "code1": 4,
    "code2": 41,
    "code": 41,
    "label": "Switch to next App"
  },
  {
    "type": 48,
    "code1": 35,
    "code2": 2,
    "code": 2,
    "label": "Browser homepage"
  },
  {
    "type": 48,
    "code1": 146,
    "code2": 1,
    "code": 1,
    "label": "Calculator"
  },
  {
    "type": 48,
    "code1": 138,
    "code2": 1,
    "code": 1,
    "label": "Mail"
  },
  {
    "type": 48,
    "code1": 148,
    "code2": 1,
    "code": 1,
    "label": "My computer"
  },
  {
    "type": 48,
    "code1": 42,
    "code2": 2,
    "code": 2,
    "label": "Favorites"
  },
  {
    "type": 16,
    "code1": 5,
    "code2": 76,
    "code": 76,
    "label": "Windows security screen"
  },
  {
    "type": 16,
    "code1": 3,
    "code2": 41,
    "code": 41,
    "label": "Task Manager"
  },
  {
    "type": 48,
    "code1": 111,
    "code2": 0,
    "code": 111,
    "label": "Screen brightness +"
  },
  {
    "type": 48,
    "code1": 112,
    "code2": 0,
    "code": 112,
    "label": "Screen brightness -"
  },
  {
    "type": 48,
    "code1": 33,
    "code2": 2,
    "code": 2,
    "label": "Search (Web)"
  },
  {
    "type": 48,
    "code1": 39,
    "code2": 2,
    "code": 2,
    "label": "Refresh (web page)"
  }
],
  macExtra32: [
  {
    "type": 16,
    "code1": 8,
    "code2": 45,
    "code": 45,
    "label": "Zoom out"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 46,
    "code": 46,
    "label": "Zoom in"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 39,
    "code": 39,
    "label": "Actual Size"
  },
  {
    "type": 16,
    "code1": 10,
    "code2": 29,
    "code": 29,
    "label": "Redo"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 29,
    "code": 29,
    "label": "Undo"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 4,
    "code": 4,
    "label": "Action center"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 17,
    "code": 17,
    "label": "New file/window"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 6,
    "code": 6,
    "label": "Copy"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 27,
    "code": 27,
    "label": "Simple menu"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 25,
    "code": 25,
    "label": "Paste"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 22,
    "code": 22,
    "label": "Search"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 18,
    "code": 18,
    "label": "Open file"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 23,
    "code": 23,
    "label": "Cycle taskbar Apps"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 26,
    "code": 26,
    "label": "Close current tab/window"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 47,
    "code": 47,
    "label": "Go back/up one level"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 48,
    "code": 48,
    "label": "Go to next page"
  },
  {
    "type": 16,
    "code1": 12,
    "code2": 7,
    "code": 7,
    "label": "Show/hide Dock"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 62,
    "code": 62,
    "label": "VoiceOver"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 43,
    "code": 43,
    "label": "switch window"
  },
  {
    "type": 16,
    "code1": 12,
    "code2": 44,
    "code": 44,
    "label": "Open Finder"
  },
  {
    "type": 16,
    "code1": 9,
    "code2": 20,
    "code": 20,
    "label": "Lock screen"
  },
  {
    "type": 240,
    "code1": 81,
    "code2": 0,
    "code": 81,
    "label": "Search"
  },
  {
    "type": 16,
    "code1": 9,
    "code2": 44,
    "code": 44,
    "label": "Emoji & Symbols"
  },
  {
    "type": 16,
    "code1": 1,
    "code2": 82,
    "code": 82,
    "label": "Mission Control"
  },
  {
    "type": 16,
    "code1": 10,
    "code2": 11,
    "code": 11,
    "label": "Browser homepage"
  },
  {
    "type": 16,
    "code1": 10,
    "code2": 6,
    "code": 6,
    "label": "Go to home directory"
  },
  {
    "type": 16,
    "code1": 12,
    "code2": 5,
    "code": 5,
    "label": "Show bookmarks (Safari)"
  },
  {
    "type": 16,
    "code1": 12,
    "code2": 41,
    "code": 41,
    "label": "Force Quit"
  },
  {
    "type": 48,
    "code1": 111,
    "code2": 0,
    "code": 111,
    "label": "Screen brightness +"
  },
  {
    "type": 48,
    "code1": 112,
    "code2": 0,
    "code": 112,
    "label": "Screen brightness -"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 9,
    "code": 9,
    "label": "Find/Address Bar"
  },
  {
    "type": 16,
    "code1": 8,
    "code2": 21,
    "code": 21,
    "label": "Run"
  }
],
  switchProfile: { type: 240, code1: 250, code2: 0, code: 250, label: 'Switch Profile', disabledAdvanceTypes: ['tgl'] },
  clear: { type: 16, code1: 0, code2: 0, code: 0, label: 'Clear' },
  fnWin: { type: 240, code1: 255, code2: 1, code: 255, label: 'FN Layer', disabledAdvanceTypes: ['dks', 'tgl', 'rs', 'socd', 'lt', 'cb'] },
  fnMac: { type: 240, code1: 255, code2: 3, code: 255, label: 'FN Layer', disabledAdvanceTypes: ['dks', 'tgl', 'rs', 'socd', 'lt', 'cb'] }
};

function getRemapCategories(layer = 0) {
  const l = Number.isInteger(layer) ? layer % 4 : 0;
  const isMac = l === 2 || l === 3;

  const basic = G75_PALETTE_SETS.basic104.slice();
  const mouse = G75_PALETTE_SETS.mouse7.slice();
  const media = isMac
    ? G75_PALETTE_SETS.media7.filter((k) => k.code1 !== 183)
    : G75_PALETTE_SETS.media7.slice();
  const mainLighting = G75_PALETTE_SETS.mainLighting9.slice();
  const sideLighting = G75_PALETTE_SETS.sideLighting8.slice();

  const extraShortcuts = isMac
    ? G75_PALETTE_SETS.macExtra32.slice()
    : G75_PALETTE_SETS.windowsExtra47.slice();

  const d = [G75_PALETTE_SETS.switchProfile, G75_PALETTE_SETS.clear];
  if (l === 0) {
    d.push(G75_PALETTE_SETS.fnWin);
  } else if (l === 2) {
    d.push(G75_PALETTE_SETS.fnMac);
  }

  const extended = extraShortcuts.concat(d);

  const categories = {
    'Basic': basic,
    'Mouse': mouse,
    'Media': media,
    'Main Lighting': mainLighting,
    'Side Lighting': sideLighting,
    'Extended': extended
  };

  // Backward compatibility non-enumerable aliases
  Object.defineProperty(categories, 'Lighting', {
    get() { return [...this['Main Lighting'], ...this['Side Lighting']]; },
    enumerable: false,
    configurable: true
  });
  Object.defineProperty(categories, 'Media & Audio', {
    get() { return this['Media']; },
    enumerable: false,
    configurable: true
  });
  Object.defineProperty(categories, 'Extended Func', {
    get() { return this['Extended']; },
    enumerable: false,
    configurable: true
  });
  Object.defineProperty(categories, 'Special & Extra', {
    get() { return this['Extended']; },
    enumerable: false,
    configurable: true
  });

  return categories;
}

const REMAP_CATEGORIES = getRemapCategories(0);

/**
 * 82 Physical Elements for MCHOSE G75 V2:
 * 81 keys + 1 rotary knob.
 *
 * Each element has:
 * - id: unique string key ID
 * - name: human-readable label
 * - code: default HID usage code (or 3809 for knob, 255 for Fn)
 * - slot: exact immutable firmware matrix slot (0..111)
 * - x, y, w, h: physical layout coordinates matching vendor layout
 * - defaultTuple: [type, code1, code2]
 */
const G75_V2_KEYS = [
  // --- Row 0 (Function Row: 15 keys) ---
  { id: 'k_esc', name: 'Esc', code: 41, slot: 0, x: 0.48, y: 0.48, w: 1, h: 1, defaultTuple: [16, 0, 41] },
  { id: 'k_f1', name: 'F1', code: 58, slot: 8, x: 1.86, y: 0.48, w: 1, h: 1, defaultTuple: [16, 0, 58] },
  { id: 'k_f2', name: 'F2', code: 59, slot: 16, x: 2.95, y: 0.48, w: 1, h: 1, defaultTuple: [16, 0, 59] },
  { id: 'k_f3', name: 'F3', code: 60, slot: 24, x: 4.05, y: 0.48, w: 1, h: 1, defaultTuple: [16, 0, 60] },
  { id: 'k_f4', name: 'F4', code: 61, slot: 32, x: 5.14, y: 0.48, w: 1, h: 1, defaultTuple: [16, 0, 61] },
  { id: 'k_f5', name: 'F5', code: 62, slot: 40, x: 6.43, y: 0.48, w: 1, h: 1, defaultTuple: [16, 0, 62] },
  { id: 'k_f6', name: 'F6', code: 63, slot: 48, x: 7.52, y: 0.48, w: 1, h: 1, defaultTuple: [16, 0, 63] },
  { id: 'k_f7', name: 'F7', code: 64, slot: 56, x: 8.62, y: 0.48, w: 1, h: 1, defaultTuple: [16, 0, 64] },
  { id: 'k_f8', name: 'F8', code: 65, slot: 64, x: 9.71, y: 0.48, w: 1, h: 1, defaultTuple: [16, 0, 65] },
  { id: 'k_f9', name: 'F9', code: 66, slot: 72, x: 11.00, y: 0.48, w: 1, h: 1, defaultTuple: [16, 0, 66] },
  { id: 'k_f10', name: 'F10', code: 67, slot: 80, x: 12.10, y: 0.48, w: 1, h: 1, defaultTuple: [16, 0, 67] },
  { id: 'k_f11', name: 'F11', code: 68, slot: 88, x: 13.19, y: 0.48, w: 1, h: 1, defaultTuple: [16, 0, 68] },
  { id: 'k_f12', name: 'F12', code: 69, slot: 96, x: 14.29, y: 0.48, w: 1, h: 1, defaultTuple: [16, 0, 69] },
  { id: 'k_del', name: 'Delete', code: 76, slot: 6, x: 15.67, y: 0.48, w: 1, h: 1, defaultTuple: [16, 0, 76] },
  { id: 'k_home', name: 'Home', code: 74, slot: 14, x: 16.76, y: 0.48, w: 1, h: 1, defaultTuple: [16, 0, 74] },

  // --- Row 1 (Numbers Row: 15 keys) ---
  { id: 'k_grave', name: '` ~', code: 53, slot: 1, x: 0.48, y: 1.86, w: 1, h: 1, defaultTuple: [16, 0, 53] },
  { id: 'k_1', name: '1 !', code: 30, slot: 9, x: 1.57, y: 1.86, w: 1, h: 1, defaultTuple: [16, 0, 30] },
  { id: 'k_2', name: '2 @', code: 31, slot: 17, x: 2.67, y: 1.86, w: 1, h: 1, defaultTuple: [16, 0, 31] },
  { id: 'k_3', name: '3 #', code: 32, slot: 25, x: 3.76, y: 1.86, w: 1, h: 1, defaultTuple: [16, 0, 32] },
  { id: 'k_4', name: '4 $', code: 33, slot: 33, x: 4.86, y: 1.86, w: 1, h: 1, defaultTuple: [16, 0, 33] },
  { id: 'k_5', name: '5 %', code: 34, slot: 41, x: 5.95, y: 1.86, w: 1, h: 1, defaultTuple: [16, 0, 34] },
  { id: 'k_6', name: '6 ^', code: 35, slot: 49, x: 7.05, y: 1.86, w: 1, h: 1, defaultTuple: [16, 0, 35] },
  { id: 'k_7', name: '7 &', code: 36, slot: 57, x: 8.14, y: 1.86, w: 1, h: 1, defaultTuple: [16, 0, 36] },
  { id: 'k_8', name: '8 *', code: 37, slot: 65, x: 9.24, y: 1.86, w: 1, h: 1, defaultTuple: [16, 0, 37] },
  { id: 'k_9', name: '9 (', code: 38, slot: 73, x: 10.33, y: 1.86, w: 1, h: 1, defaultTuple: [16, 0, 38] },
  { id: 'k_0', name: '0 )', code: 39, slot: 81, x: 11.43, y: 1.86, w: 1, h: 1, defaultTuple: [16, 0, 39] },
  { id: 'k_minus', name: '- _', code: 45, slot: 89, x: 12.52, y: 1.86, w: 1, h: 1, defaultTuple: [16, 0, 45] },
  { id: 'k_equal', name: '= +', code: 46, slot: 97, x: 13.62, y: 1.86, w: 1, h: 1, defaultTuple: [16, 0, 46] },
  { id: 'k_bsp', name: 'Backspace', code: 42, slot: 105, x: 14.71, y: 1.86, w: 1.95, h: 1, defaultTuple: [16, 0, 42] },
  { id: 'k_end', name: 'End', code: 77, slot: 22, x: 16.76, y: 1.86, w: 1, h: 1, defaultTuple: [16, 0, 77] },

  // --- Row 2 (QWERTY Row: 15 keys) ---
  { id: 'k_tab', name: 'Tab', code: 43, slot: 2, x: 0.48, y: 2.95, w: 1.43, h: 1, defaultTuple: [16, 0, 43] },
  { id: 'k_q', name: 'Q', code: 20, slot: 10, x: 2.00, y: 2.95, w: 1, h: 1, defaultTuple: [16, 0, 20] },
  { id: 'k_w', name: 'W', code: 26, slot: 18, x: 3.10, y: 2.95, w: 1, h: 1, defaultTuple: [16, 0, 26] },
  { id: 'k_e', name: 'E', code: 8, slot: 26, x: 4.19, y: 2.95, w: 1, h: 1, defaultTuple: [16, 0, 8] },
  { id: 'k_r', name: 'R', code: 21, slot: 34, x: 5.29, y: 2.95, w: 1, h: 1, defaultTuple: [16, 0, 21] },
  { id: 'k_t', name: 'T', code: 23, slot: 42, x: 6.38, y: 2.95, w: 1, h: 1, defaultTuple: [16, 0, 23] },
  { id: 'k_y', name: 'Y', code: 28, slot: 50, x: 7.48, y: 2.95, w: 1, h: 1, defaultTuple: [16, 0, 28] },
  { id: 'k_u', name: 'U', code: 24, slot: 58, x: 8.57, y: 2.95, w: 1, h: 1, defaultTuple: [16, 0, 24] },
  { id: 'k_i', name: 'I', code: 12, slot: 66, x: 9.67, y: 2.95, w: 1, h: 1, defaultTuple: [16, 0, 12] },
  { id: 'k_o', name: 'O', code: 18, slot: 74, x: 10.76, y: 2.95, w: 1, h: 1, defaultTuple: [16, 0, 18] },
  { id: 'k_p', name: 'P', code: 19, slot: 82, x: 11.86, y: 2.95, w: 1, h: 1, defaultTuple: [16, 0, 19] },
  { id: 'k_lbracket', name: '[ {', code: 47, slot: 90, x: 12.95, y: 2.95, w: 1, h: 1, defaultTuple: [16, 0, 47] },
  { id: 'k_rbracket', name: '] }', code: 48, slot: 98, x: 14.05, y: 2.95, w: 1, h: 1, defaultTuple: [16, 0, 48] },
  { id: 'k_backslash', name: '\\ |', code: 49, slot: 106, x: 15.14, y: 2.95, w: 1.50, h: 1, defaultTuple: [16, 0, 49] },
  { id: 'k_pgup', name: 'PgUp', code: 75, slot: 30, x: 16.74, y: 2.95, w: 1.02, h: 1, defaultTuple: [16, 0, 75] },

  // --- Row 3 (ASDF Row: 14 keys) ---
  { id: 'k_caps', name: 'Caps', code: 57, slot: 3, x: 0.48, y: 4.05, w: 1.71, h: 1, defaultTuple: [16, 0, 57] },
  { id: 'k_a', name: 'A', code: 4, slot: 11, x: 2.29, y: 4.05, w: 1, h: 1, defaultTuple: [16, 0, 4] },
  { id: 'k_s', name: 'S', code: 22, slot: 19, x: 3.38, y: 4.05, w: 1, h: 1, defaultTuple: [16, 0, 22] },
  { id: 'k_d', name: 'D', code: 7, slot: 27, x: 4.48, y: 4.05, w: 1, h: 1, defaultTuple: [16, 0, 7] },
  { id: 'k_f', name: 'F', code: 9, slot: 35, x: 5.57, y: 4.05, w: 1, h: 1, defaultTuple: [16, 0, 9] },
  { id: 'k_g', name: 'G', code: 10, slot: 43, x: 6.67, y: 4.05, w: 1, h: 1, defaultTuple: [16, 0, 10] },
  { id: 'k_h', name: 'H', code: 11, slot: 51, x: 7.76, y: 4.05, w: 1, h: 1, defaultTuple: [16, 0, 11] },
  { id: 'k_j', name: 'J', code: 13, slot: 59, x: 8.86, y: 4.05, w: 1, h: 1, defaultTuple: [16, 0, 13] },
  { id: 'k_k', name: 'K', code: 14, slot: 67, x: 9.95, y: 4.05, w: 1, h: 1, defaultTuple: [16, 0, 14] },
  { id: 'k_l', name: 'L', code: 15, slot: 75, x: 11.05, y: 4.05, w: 1, h: 1, defaultTuple: [16, 0, 15] },
  { id: 'k_semicolon', name: '; :', code: 51, slot: 83, x: 12.14, y: 4.05, w: 1, h: 1, defaultTuple: [16, 0, 51] },
  { id: 'k_quote', name: '\' "', code: 52, slot: 91, x: 13.24, y: 4.05, w: 1, h: 1, defaultTuple: [16, 0, 52] },
  { id: 'k_enter', name: 'Enter', code: 40, slot: 107, x: 14.33, y: 4.05, w: 2.33, h: 1, defaultTuple: [16, 0, 40] },
  { id: 'k_pgdn', name: 'PgDn', code: 78, slot: 38, x: 16.76, y: 4.05, w: 1, h: 1, defaultTuple: [16, 0, 78] },

  // --- Row 4 (ZXCV Row: 13 keys + Knob) ---
  { id: 'k_lshift', name: 'Shift', code: 225, slot: 4, x: 0.48, y: 5.14, w: 2.19, h: 1, defaultTuple: [16, 2, 0] },
  { id: 'k_z', name: 'Z', code: 29, slot: 20, x: 2.76, y: 5.14, w: 1, h: 1, defaultTuple: [16, 0, 29] },
  { id: 'k_x', name: 'X', code: 27, slot: 28, x: 3.86, y: 5.14, w: 1, h: 1, defaultTuple: [16, 0, 27] },
  { id: 'k_c', name: 'C', code: 6, slot: 36, x: 4.95, y: 5.14, w: 1, h: 1, defaultTuple: [16, 0, 6] },
  { id: 'k_v', name: 'V', code: 25, slot: 44, x: 6.05, y: 5.14, w: 1, h: 1, defaultTuple: [16, 0, 25] },
  { id: 'k_b', name: 'B', code: 5, slot: 52, x: 7.14, y: 5.14, w: 1, h: 1, defaultTuple: [16, 0, 5] },
  { id: 'k_n', name: 'N', code: 17, slot: 60, x: 8.24, y: 5.14, w: 1, h: 1, defaultTuple: [16, 0, 17] },
  { id: 'k_m', name: 'M', code: 16, slot: 68, x: 9.33, y: 5.14, w: 1, h: 1, defaultTuple: [16, 0, 16] },
  { id: 'k_comma', name: ', <', code: 54, slot: 76, x: 10.43, y: 5.14, w: 1, h: 1, defaultTuple: [16, 0, 54] },
  { id: 'k_period', name: '. >', code: 55, slot: 84, x: 11.52, y: 5.14, w: 1, h: 1, defaultTuple: [16, 0, 55] },
  { id: 'k_slash', name: '/ ?', code: 56, slot: 92, x: 12.62, y: 5.14, w: 1, h: 1, defaultTuple: [16, 0, 56] },
  { id: 'k_rshift', name: 'Shift', code: 229, slot: 108, x: 13.71, y: 5.14, w: 1.86, h: 1, defaultTuple: [16, 32, 0] },
  { id: 'k_up', name: '↑', code: 82, slot: 86, x: 15.67, y: 5.14, w: 1, h: 1, defaultTuple: [16, 0, 82] },
  // Actual knob geometry from public layout source: x=18.0238095, y=5.2619048, w=0.2857142857142857, h=0.75
  { id: 'k_knob', name: 'Knob', code: 3809, slot: 37, x: 18.0238095, y: 5.2619048, w: 0.2857142857142857, h: 0.75, isKnob: true, defaultTuple: [48, 226, 0] },

  // --- Row 5 (Bottom Row: 9 keys) ---
  { id: 'k_lctrl', name: 'Ctrl', code: 224, slot: 5, x: 0.48, y: 6.24, w: 1.19, h: 1, defaultTuple: [16, 1, 0] },
  { id: 'k_lwin', name: 'Win', code: 227, slot: 13, x: 1.76, y: 6.24, w: 1.19, h: 1, defaultTuple: [16, 8, 0] },
  { id: 'k_lalt', name: 'Alt', code: 226, slot: 21, x: 3.05, y: 6.24, w: 1.19, h: 1, defaultTuple: [16, 4, 0] },
  { id: 'k_space', name: 'Space', code: 44, slot: 53, x: 4.33, y: 6.24, w: 6.81, h: 1, defaultTuple: [16, 0, 44] },
  { id: 'k_fn', name: 'FN', code: 255, slot: 85, x: 11.24, y: 6.24, w: 1.29, h: 1, defaultTuple: [240, 255, 1] },
  { id: 'k_rctrl', name: 'Ctrl', code: 228, slot: 101, x: 12.62, y: 6.24, w: 1.29, h: 1, defaultTuple: [16, 16, 0] },
  { id: 'k_left', name: '←', code: 80, slot: 109, x: 14.57, y: 6.24, w: 1, h: 1, defaultTuple: [16, 0, 80] },
  { id: 'k_down', name: '↓', code: 81, slot: 87, x: 15.67, y: 6.24, w: 1, h: 1, defaultTuple: [16, 0, 81] },
  { id: 'k_right', name: '→', code: 79, slot: 95, x: 16.76, y: 6.24, w: 1, h: 1, defaultTuple: [16, 0, 79] }
];

// 3 Lighting-Only Split Space Zones (vendor layout index: 45, 53, 61)
const SPACE_LIGHTING_ZONES = [
  { id: 'k_space_l', name: 'Space (L)', code: 0, slot: 45, x: 4.333, y: 6.238, w: 2.27, h: 1, isLightingZone: true, isLightingOnly: true, background: 'part-left', defaultTuple: [16, 0, 0] },
  { id: 'k_space_c', name: 'Space (C)', code: 44, slot: 53, x: 6.603, y: 6.238, w: 2.27, h: 1, isLightingZone: true, isLightingOnly: true, background: 'part-center', defaultTuple: [16, 0, 44] },
  { id: 'k_space_r', name: 'Space (R)', code: 0, slot: 61, x: 8.873, y: 6.238, w: 2.27, h: 1, isLightingZone: true, isLightingOnly: true, background: 'part-right', defaultTuple: [16, 0, 0] }
];

// 83 addressable lighting entries:
// 82 physical elements minus space and knob (slot 37 has no LED) + 3 split space zones = 83 entries
const G75_V2_LIGHTING_ENTRIES = G75_V2_KEYS.filter(key => !key.isKnob).flatMap(key => {
  if (key.id === 'k_space') {
    return SPACE_LIGHTING_ZONES;
  }
  return [key];
});

// All 85 entries matching the public G75 V2 layout (82 physical + 3 lighting-only space zones)
// (82 physical elements including unified space + 3 lighting-only space zones = 85 entries)
const G75_V2_LAYOUT_ENTRIES = [
  ...G75_V2_KEYS.slice(0, 76), // keys before space
  G75_V2_KEYS[76],             // unified space (hidden: ['light'])
  ...SPACE_LIGHTING_ZONES,     // 3 lighting zones (Light1, Space, Light3)
  ...G75_V2_KEYS.slice(77)     // keys after space
];

// Set of immutable valid physical slot indices (82 entries)
const VALID_PHYSICAL_SLOTS = new Set(G75_V2_KEYS.map(k => k.slot));

// Set of valid lighting slot indices (83 entries, excluding knob 37)
const VALID_LIGHTING_SLOTS = new Set(G75_V2_LIGHTING_ENTRIES.map(k => k.slot));

// Eligible physical keys for advanced MT / TGL / SOCD assignment:
// Excludes BOTH Fn (slot 85) and Rotary Knob (slot 37) -> exactly 80 eligible physical keys
const ELIGIBLE_ADVANCED_SLOTS = new Set([...VALID_PHYSICAL_SLOTS].filter(slot => slot !== 37 && slot !== 85));

// Map slot to physical key definition
const KEY_BY_SLOT = new Map(G75_V2_KEYS.map(k => [k.slot, k]));

// Map key ID to physical key definition
const KEY_BY_ID = new Map(G75_V2_KEYS.map(k => [k.id, k]));

// SOCD Priority Modes verified from vendor locales
const SOCD_PRIORITIES = [
  { id: 0, name: 'Last Input Priority', desc: 'Takes the last pressed key as the current input' },
  { id: 1, name: 'Absolute Priority (Key 1)', desc: 'Key 1 always takes priority over Key 2' },
  { id: 2, name: 'Absolute Priority (Key 2)', desc: 'Key 2 always takes priority over Key 1' },
  { id: 3, name: 'Cancel Mode', desc: 'Releases both keys when pressed together' }
];

/**
 * Priority on partner complements 1 <-> 2, 0 stays 0, 3 stays 3.
 */
function getComplementPriority(priority) {
  if (priority === 1) return 2;
  if (priority === 2) return 1;
  return priority;
}

// Immutable default layers: packaged capture under src/data (NOT test/fixtures).
let defaultLayersDataCache = undefined;
function getDefaultLayersData() {
  if (defaultLayersDataCache !== undefined) return defaultLayersDataCache;
  const fs = require('node:fs');
  const path = require('node:path');
  const bundledPath = path.join(__dirname, 'data', 'default-layers.json');
  try {
    const raw = JSON.parse(fs.readFileSync(bundledPath, 'utf8'));
    if (!raw || raw.model !== 'MCHOSE G75 V2' || raw.usedBytes !== 384 || !raw.layers) {
      defaultLayersDataCache = null;
      return defaultLayersDataCache;
    }
    const layers = {};
    for (let l = 0; l < 4; l++) {
      const hex = raw.layers[String(l)];
      if (typeof hex !== 'string' || hex.length !== 768) {
        defaultLayersDataCache = null;
        return defaultLayersDataCache;
      }
      layers[l] = Buffer.from(hex, 'hex');
    }
    defaultLayersDataCache = layers;
  } catch {
    defaultLayersDataCache = null;
  }
  return defaultLayersDataCache;
}

/**
 * Returns immutable default key tuple [type, code1, code2] for a layer and physical slot.
 * Fail-closed: never falls back to Win-layer KEY_BY_SLOT.defaultTuple.
 */
function getDefaultTuple(layer, slot) {
  const data = getDefaultLayersData();
  const buf = data && data[layer];
  if (buf && Number.isInteger(slot) && slot >= 0 && (slot * 3 + 2) < buf.length) {
    return [buf[slot * 3], buf[slot * 3 + 1], buf[slot * 3 + 2]];
  }
  throw new Error(
    `Immutable default tuple unavailable for layer ${layer} slot ${slot}. ` +
    'Bundled CMD7 capture is missing; no silent Win-layer fallback is permitted.'
  );
}

module.exports = {
  LIGHT_EFFECTS,
  SIDE_LIGHT_EFFECTS,
  LIGHT_EFFECT_DISPLAY_ORDER,
  LIGHT_EFFECT_PRESET_ORDER,
  SIDE_LIGHT_DISPLAY_ORDER,
  LIGHT_DIRECTION_PAIRS,
  getLightEffectById,
  getSideLightEffectById,
  getMainPresetEffects,
  getSidePresetEffects,
  getDirectionPair,
  REMAP_CATEGORIES,
  getRemapCategories,
  G75_PALETTE_SETS,
  G75_V2_KEYS,
  SPACE_LIGHTING_ZONES,
  G75_V2_LIGHTING_ENTRIES,
  G75_V2_LAYOUT_ENTRIES,
  VALID_PHYSICAL_SLOTS,
  VALID_LIGHTING_SLOTS,
  ELIGIBLE_ADVANCED_SLOTS,
  KEY_BY_SLOT,
  KEY_BY_ID,
  SOCD_PRIORITIES,
  getComplementPriority,
  getDefaultLayersData,
  getDefaultTuple
};
