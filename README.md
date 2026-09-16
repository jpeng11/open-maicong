# Maicong Studio (macOS Standalone Configurator)

An unofficial, standalone, 100% offline macOS keyboard configurator for **MCHOSE (迈从) G75 V2** keyboards, communicating over the reverse-engineered native **GLW hardware protocol** via `node-hid`.

Inspired by [OpenLogi](https://github.com/AprilNEA/OpenLogi), Maicong Studio replaces the remote web hub with a native macOS application that operates directly against USB HID endpoints with zero cloud dependence, zero telemetry, and zero remote network requests (`connect-src 'none'`).

The interface follows the official G75 web hub: a light gray canvas, a device/profile sidebar, and a rounded white workspace with horizontal feature tabs, blue controls, and a light keyboard preview. The UI is implemented locally; no vendor scripts, fonts, or remote pages are bundled or loaded.

---

## Hardware Capability & Parity Matrix

This matrix distinguishes between features **verified through live readback on physical hardware** versus features **implemented and validated through mocked unit & adversarial tests** (hardware mutation tests are strictly mocked to prevent accidental EEPROM corruption during development).

| Feature | Implementation Status | Wire Protocol / Channel | Verification & Technical Evidence |
| :--- | :---: | :--- | :--- |
| **2.4GHz Receiver Detection** | **Verified (Live Read)** | macOS IOKit USB / node-hid | Matches USB VID `14391` (`0x3837`), PID `12339` (`0x3033`), Interface `1`, UsagePage `1`, Usage `0` / `undefined`. |
| **Nonexclusive Mode** | **Verified (Live Read)** | `node-hid` with `{ nonExclusive: true }` | macOS standard typing input interfaces (Usage `6`) remain accessible while connected to configuration Interface `1`. |
| **Device & Firmware Identity** | **Verified (Live Read)** | GLW CMD `3` (`GET_INFO`) | Confirmed live read: MCU Firmware `1.14` (`0x0114`), RF Wireless Firmware `1.30` (`0x0130`), Dongle build date parsed from byte offset 6 (`null`/`Unknown` when absent; no synthetic identity fallbacks). |
| **Battery & Charging Telemetry** | **Verified (Live Read)** | GLW CMD `5` (`GET_FUNC_CONFIG`) byte `32` | Confirmed live read: `payload[32] & 127` = 100% battery, `(payload[32] >> 7) & 1` = charging flag. Real hardware telemetry; never simulated. |
| **Onboard Profile Query (1–3)** | **Verified (Live Read)** | GLW CMD `4` (`GET_BASE`) | Confirmed live read: 3 enabled hardware profiles (`profileCount: 3`), order `[0, 1, 2, 3]`. Enabling the fourth slot is implemented in the backend (`enableProfiles`) with mocked readback; it is not auto-run when selecting an edit target. |
| **Default Win Matrix Query** | **Verified (Live Read)** | GLW CMD `7` (`GET_SYS_KEY_MATRIX`) | Captured immutable default matrix (`test/fixtures/default-matrix.hex`): Esc=0, F1=8, A=11, Space=53, Fn=85, Knob=37. |
| **Profile Switching** | **Validated (Mocked Write)** | GLW CMD `14` (`SET_BASE`) | Validated via mocked transaction with readback verification. |
| **4-Layer Key Remapping** | **Validated (Mocked Write)** | GLW CMD `8` (read) / CMD `9` (write) | 4 layers: Win (0), Win+Fn (1), Mac (2), Mac+Fn (3). Verified GLW tuples: standard `[16, 0, HIDusage]`, modifier-only `[16, 1 << (usage - 224), 0]`, chords `[16, modifierMask, HIDusage]`, mouse buttons `[32, mask, 0]`, wheel `[33, 0, 1/255]`, media consumer keys `[48, usageLowByte, usageHighByte]`, rotary knob `[48, 226, 0]`, layer-aware Fn (`[240, 255, 1]` Win / `[240, 255, 3]` Mac), and clear `[16, 0, 0]` (legacy disabled `[0, 0, 0]` remains readable). The G75-specific palettes contain 185/184/169/168 choices on Win/Win Fn/Mac/Mac Fn, excluding macro slots. Non-physical slots strictly rejected. |
| **Hardware Macros (16 Slots)** | **Validated (Mocked Write)** | GLW CMD `12` (read) / CMD `13` (write) | Shared 8192-byte flash memory with identical action-body sharing across slots. Record/pause/resume keyboard and mouse input, standard delay, copy/paste, insert, replace, reorder, and edit steps. Names and per-slot delay preferences persist locally and travel with profile exports; they are not firmware bytes. Validated with explicit terminator checks, 4-byte action chunks, preflight capacity validation, and full 8192-byte readback comparison. Macro key binding is `[112, slotIndex, playbackType]`. Changing playback mode rewrites every physical type-112 binding across 4 profiles × 4 layers in the same transaction; action-only edits do not rewrite keys. |
| **RGB Backlight (23 Effects)** | **Validated (Mocked Write)** | GLW CMD `5` (read) / CMD `6` (write 64B) | Model keeps IDs 0–22. Lighting UI shows **22** official preset tiles in hub order plus a separate **Custom lighting** entry (effect 0). Capability flags hide speed/brightness/direction and disable color when unsupported. GLW direction pairs. Unknown IDs stay unrecognized. Ordinary effect/slider/color edits save automatically (sliders coalesce; white-balance stays an explicit Apply). Readback verifies all 64 bytes. Switching a main/side effect restores the last remembered settings for that profile (remembered brightness OR current OR 100). |
| **Lighting effect memory** | **Validated (Mocked Write)** | GLW CMD `241`/`242` at `profile*1024+728`, 112 bytes, marker `<light@v2>` | 6-byte records, first-occurrence dedup, 16-record round-robin. All-zero/markerless reads are empty hardware stores, not “unsupported”. A successful 241 proves that region is readable only. Transient 241 failures are `unavailable` and do not become local success. **On keyboard** vs **This Mac** is an explicit Lighting-tab preference (IPC `get/setLightingMemoryPreference`); it is not chosen automatically from a failed 241 or a failed 242. Serial-scoped keys are durable; HID-path keys are not claimed stable across reconnects. Corrupt local files stay on disk until repaired. Malformed hardware priors reject before CMD 242. A failed 242 after a successful 241 is reported without rolling back FUNC. No mutating support probe. Hardware 242 remains unproven. Autosave of ordinary lighting fields is a later stage. |
| **Side Indicator Strip** | **Validated (Mocked Write)** | GLW CMD `5` / `6` (bytes `24..31`) | Four tiles: RainbowCycle, Constant On, Breath, Off. Brightness/speed/color gated per catalog. |
| **Per-Key RGB Lighting** | **Validated (Mocked Write)** | GLW CMD `10` (read) / CMD `11` (write) | 384-byte RGB area. Addressable lighting is **83** slots (knob slot 37 has no LED; split space 45/53/61). Slot 37 is not editable; its existing bytes are preserved. Full 384-byte readback of the prepared buffer. |
| **Main Polling Rate (1k/2k/4k/8k)**| **Validated (Mocked Write)** | GLW CMD `5` / `6` byte `4` low nibble | Verified vendor enum: `4` = 1000 Hz, `3` = 2000 Hz, `2` = 4000 Hz, `1` = 8000 Hz (G75 `featRate8K: true`). High nibble (`tickRate`) preserved. |
| **RF Wireless Report Rate** | **Raw Pass-through** | GLW CMD `5` / `6` byte `38` | Raw byte 38 (`reportRate24G`) preserved exactly as read from device. Value mapping is not exposed in vendor performance UI and is not guessed. |
| **Debounce / Key Combo** | **Validated (Mocked Write)** | GLW CMD `5` / `6` byte `7` | G75 V2 mechanical model (`featLianji: true`) uses a discrete key combo / debounce toggle: `0` (Off) or `7` (On). Fabricated millisecond values (e.g. 0–10ms) are not used. |
| **Sleep Timeout & Never Sleep** | **Validated (Mocked Write)** | GLW CMD `5` / `6` bytes `35` / `36` | `sleepTime` at byte 35 (units of 30 seconds) is shown as-read (30 s, 2.5 min, integer minutes) and is not rounded until the user moves the slider. `sleepMode` at byte 36 (`1` = never sleep, `0` = sleep enabled). Never Sleep displays 0 min and leaves the slider enabled; a slider change stages `sleepMode` 0 (GLW `setSleepTime`). |
| **OS Mode (Win / Mac)** | **Validated (Mocked Write)** | GLW CMD `5` / `6` byte `1` low nibble | Canonical export stores `macMode & 0x03` (0 = Win, 2 = Mac). Writes reconstruct `profileIndex * 4 + (mac ? 2 : 0)`. Inactive captured configs keep byte 1 = 0 until changed. |
| **Win / Cmd Key Lock** | **Validated (Mocked Write)** | GLW CMD `5` / `6` byte `6` bit 0 | Boolean flag toggling GUI/Windows key lock. |
| **Profile Export / Import** | **Validated (Mocked Write)** | Native macOS file dialogs (JSON) | Schema is preflighted and every section is serialized before the first mutation. Writes are generation-guarded with per-section readback. This is **not atomic**: a later section can fail after earlier sections have already been written. Failures report `completedSections`, `failedSection`, and `uncertain` when a write was ACKed but readback did not match. Keymap verification compares edited triples only, not the unused 512-byte pad. |
| **Firmware Flashing** | **User-operable in-app / physical flash unproven** | Traced flag-response updater | Others tab: show MCU and RF versions; keyboard upgrade only in wired USB; receiver upgrade only in 2.4G. Choose a local official package that matches catalog size/SHA-256; review; explicit confirm. Sequence: backup → boot → erase → send → verify → same-device return → version readback → restore. Cancel sends zero flash writes. Uncertain erase is not retried. Package is not downloaded. Physical boot descriptors and live flash remain unverified. |
| **Factory Reset** | **Validated (Mocked Write)** | GLW CMD `238` offset 0, data `[activeIndex]` or `[255]` | Others tab: reset the hardware-active profile vs all profiles, with review/confirm and optional one-profile export (not an all-device backup). Active target is freshly read from GET_BASE inside the transaction; stale identity/generation/active index/reset epoch is rejected. Completion requires a reset notification (`A2` or `FA FB FF`); a matching AA ACK alone is uncertain. Unsolicited reset reports abort in-flight and queued HID I/O (connection generation advances, handle closed), invalidate caches and the renderer without a user click, and are not counted as an app-requested success. No automatic retry. Local macro names are one global bank and are cleared only on confirmed all-profile reset (app policy, not claimed vendor metadata parity). Physical reset has not been tested. |
| **Advanced Combo (CB)** | **Validated (Mocked Write)** | Ordinary type-16 chord via CMD `9` | Dedicated modifier + regular-key editor. Uses the advanced transaction to preserve shared bindings when replacing MT/TGL/SOCD. Physical writes and roller CB behavior remain unverified. |
| **Advanced Features (MT, TGL, SOCD)** | **Validated (Mocked Write)** | CMD `164`/`165` MT, `166`/`167` TGL, `160`/`161` extras | Shared tables scan all 4 layers with reference counts; an index is reused only when no remaining binding points at it. Import merges onto live layers, preserves reserved MT/TGL tails and extras bytes except SOCD priority nibbles, and refuses table replacement that would clobber unimported keys. Advanced tab in the renderer. RS/LT/DKS magnetic features are not exposed. |
| **Analog Rapid Trigger** | **Unsupported** | N/A (Mechanical Hardware) | G75 V2 is a traditional mechanical keyboard. Analog Hall-effect rapid trigger and actuation calibration are not applicable. |
| **Wired USB-C control** | **Implemented, physically untested** | PID `0x2021` / `8225` | Same GLW control-interface match as the receiver. No live wired smoke in this tree. |
| **LED white balance** | **Validated (Mocked Write)** | FUNC bytes 40..42 | Optional `{r,g,b}` 0..255 on lighting apply/export. G75 V2 reports `lightCalibration`; this is not magnetic switch calibration. |

**Honest remaining limitations**
- Knob wheel `rollerType` (byte 33) is preserved raw. No public UI mapping to volume/brightness was found; only the knob *press* (slot 37) is a normal remap.
- Firmware update is offered on the Others tab from a user-chosen official package (mock-validated). Physical flash has not been tested. Factory reset is mock-validated only; physical reset has not been tested and is never auto-retried.
- Wired USB-C is implemented in code and physically untested. Live HID mutation is not part of `npm test`.
- `npm run test:mock-ui` drives the real renderer against in-memory GLW only (`--mock-ui-test`, unpackaged). The packaged app never loads that harness.
- macOS 13+ is the Electron 44 minimum. Unsigned Apple Silicon DMG and ZIP have been built; the packaged app has been opened for read-only verification against a live 2.4 GHz receiver (MCU FW 1.14, RF 1.30). No live hardware writes were performed in that check.

---

## Technical Architecture & Wire Framing

```
+--------------------------------------------------------------------------------+
|                         Maicong Studio (macOS App)                             |
|                                                                                |
|  +--------------------------------------------------------------------------+  |
|  | Renderer UI (Context Isolated, Sandbox Enabled, connect-src 'none')      |  |
|  | - Proportional visual 75% keyboard geometry (82 accessible buttons)      |  |
|  | - 4-Layer key remapping with modifier chord checkboxes (Ctrl/Shift/Alt/Cmd)|
|  | - 16-slot macro timeline, playback mode selector, and scoped recorder   |  |
|  | - Solid/rainbow lighting toggles and per-key RGB patch painter          |  |
|  | - Hardware settings (1k-8k polling, 0/7 debounce, sleep, Mac mode)       |  |
|  | - Staged JSON profile export & granular import restore                   |  |
|  +-------------------------------------+------------------------------------+  |
|                                        | Typed IPC (window.maicongApi)         |
|  +-------------------------------------v------------------------------------+  |
|  | Main Process (Electron 44)                                               |  |
|  | - Schema validators preflighting all payloads before dispatch            |  |
|  | - USB IOKit hotplug device watcher (detector.cjs)                        |  |
|  | - GLW Hardware Protocol Engine & Checksum verification (protocol.cjs)    |  |
|  | - Single-flight mutex, generation-guarded transport (transport.cjs)     |  |
|  | - Native node-hid handle with { nonExclusive: true }                     |  |
|  +-------------------------------------+------------------------------------+  |
+----------------------------------------|---------------------------------------+
                                         | Output report ID 0 (Buffer 65)
                                         v
                         macOS IOHIDDevice Subsystem
                  MCHOSE G75 V2 2.4G Receiver (VID 0x3837 PID 0x3033)
                   Config Interface: PrimaryUsagePage 1, Usage 0 / undefined
```

### Wire Protocol Details

1. **Outgoing Packets (65 bytes via `device.write`)**:
   - `Buffer[0]`: `0` (macOS unnumbered output report ID prefix)
   - `Buffer[1]`: `0x55` (GLW request magic header)
   - `Buffer[2]`: `command` (Opcode: `3` info, `4` base, `5`/`6` funcConfig, `7`/`8`/`9` keymap, `10`/`11` RGB, `12`/`13` macros)
   - `Buffer[3]`: `0` (Subcommand / Reserved)
   - `Buffer[4]`: `checksum` = `sum([size, offsetLo, offsetHi, 0, ...data]) & 0xFF`
   - `Buffer[5]`: `size` (Payload length, max 56 bytes per packet)
   - `Buffer[6]`: `offsetLo` (`offset & 0xFF`)
   - `Buffer[7]`: `offsetHi` (`(offset >> 8) & 0xFF`)
   - `Buffer[8]`: `0` (Reserved)
   - `Buffer[9..64]`: Data payload (for write operations) or zero-padded (for read queries)

2. **Incoming Reports (64 bytes via `device.on('data')`)**:
   - `Buffer[0]`: `0xAA` (GLW response magic header)
   - `Buffer[1]`: `command` (Echoed opcode)
   - `Buffer[2]`: `status` (`0` = success)
   - `Buffer[3]`: `checksum` (Calculated modular sum of payload descriptor bytes)
   - `Buffer[4]`: `size` (Returned payload length)
   - `Buffer[5]`: `offsetLo`
   - `Buffer[6]`: `offsetHi`
   - `Buffer[7]`: `0` (Must be zero; non-zero reserved byte rejected)
   - `Buffer[8..(8 + size)]`: Payload data

3. **Hardware Checksum Exception for CMD 3 (`GET_INFO`)**:
   - In standard commands (CMD 4, 5, 8, 10, 12), incoming `Buffer[3]` is the modular sum of payload descriptor bytes.
   - For CMD 3 (`GET_INFO`), the hardware echoes the **request checksum** rather than calculating the checksum of the response payload:
     - Query with requested size 56 returns `0x38` (56 decimal).
     - Query with requested size 38 returns `0x26` (38 decimal).
   - The transport decoder handles this via a strictly scoped exception for CMD 3 offset 0 while maintaining full checksum verification on all other protocol commands.

4. **Safety & Transport Guards**:
   - **Connection Generation Guard**: Every connect/reconnect increments an integer generation counter. In-flight transactions verify the generation before and after writes; any disconnect immediately aborts queued writes and dispatches zero packets to replacement devices.
   - **Readback Verification**: Lighting, settings, RGB, macros, and advanced tables compare the written region on readback (funcConfig skips live bytes 32 and 34). Keymap verification compares the edited 3-byte triples only. ACK replies with unchanged memory fail closed and set `uncertain` when the write was accepted.
   - **Partial Read Abortion**: If a pre-mutation read returns incomplete data (e.g. fewer than 384 bytes for RGB or 8192 bytes for macros), mutation is aborted with zero writes sent.

---

## Getting Started

### System Requirements
- **macOS 13.0 (Ventura) or later** (Apple Silicon arm64 or Intel x64). Confirmed requirement per Electron 44 Info.plist (`LSMinimumSystemVersion: 13.0`).
- **Node.js 22.12+** and **npm** (development/build only; the packaged app needs neither)
- MCHOSE G75 V2 keyboard connected via 2.4GHz USB receiver or USB-C wired cable

### Installation & Development

```bash
# From the project directory
npm install

# Run automated tests (unit, schema, layout geometry, & adversarial mock tests)
npm test

# Renderer integration against in-memory GLW (never opens HID)
npm run test:mock-ui

# Run smoke verification (headless Electron UI & layout check)
npm run smoke

# Launch application
npm start
```

### Packaging for macOS

Unsigned Apple Silicon `.dmg` and `.zip` are produced with electron-builder (`build.mac.identity` is `null`). The packaged app has been opened and read-verified; it is not Apple-signed.

`node-gyp` fails when the project path contains spaces (for example a volume named with a space). Copy the tree to a space-free directory first, excluding build outputs, then package from there:

```bash
# Generate native macOS app icon (.icns)
npm run icon

rsync -a --exclude /dist/ --exclude /test-artifacts/ ./ /path/to/space-free-staging/
cd /path/to/space-free-staging
npm install
npm run pack    # .app
npm run dist    # DMG and ZIP
```

---

## Safety & Offline Design

- **Nonexclusive HID Handle**: Uses `{ nonExclusive: true }` on configuration Interface 1. Standard macOS typing input interfaces (Usage 6) remain open and unblocked. No typing latency guarantees are made, as system performance depends on OS scheduling and host USB controllers.
- **Strictly Offline**: The Content Security Policy enforces `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'`. No remote requests, telemetry, or analytics exist.
- **Fail-Closed Validation**: All IPC payloads and imported JSON files are preflighted by strict schema validators before any transport dispatch. Out-of-bounds numbers, invalid hex codes, and non-physical key slots are rejected immediately without silent truncation or clamping.

---

## License & Disclaimer

MIT License.

This is an independent community project and is **not** affiliated with, sponsored by, or endorsed by MCHOSE (迈从). MCHOSE is a trademark of its respective owner.
