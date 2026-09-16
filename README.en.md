# Maicong Studio

[简体中文](./README.md) | **English**

A native macOS hub for the MCHOSE **G75 V2 mechanical** keyboard. Official software covers Windows and the web hub only. This app talks to the keyboard on your Mac with no cloud, no account, and no outbound network.

> Independent community project. **Not affiliated with, sponsored by, or endorsed by MCHOSE (迈从).** MCHOSE is a trademark of its owner.

## What it does

Local control of the G75 V2 mechanical hub surface:

| Area | What you can do |
| :--- | :--- |
| Lighting | Main effects 0–22, custom still/GIF libraries, side lights 1–4, brightness / speed / direction / color, white-balance |
| Key settings | Win / WinFn / Mac / MacFn, click or drag assign, copy / cut / paste, shortcut record, restore defaults |
| Advanced keys | MT, TGL, SOCD (0–3), CB combos, binding list, tester, clear-all |
| Performance | 1 / 2 / 4 / 8 kHz, sleep 1–30 min, Never Sleep, key combo, Lock Win, Mac / Win mode |
| Macros | 16 hardware slots, Record / Pause / Resume, playback 0 / 1 / 255 |
| Profiles | 4 onboard slots, Activate vs Load-for-edit, local library cap 20, official KeyboardProfile v3 import/export |
| Others | Factory reset (active onboard vs all), firmware update from a user-chosen official package (size + SHA-256) |
| App auto-bind | Link an onboard profile to a Mac app; the slot activates when that app is frontmost |

Magnetic-only hub features (Rapid Trigger, DKS, travel calibration, and so on) are not part of G75 V2 mechanical and are not offered here.

Cloud / official / Apex libraries, share-codes, CDN firmware download, and music lighting are out of scope. The UI Content Security Policy is `connect-src 'none'`.

## Requirements

- macOS 13 Ventura or later (Apple Silicon or Intel)
- MCHOSE G75 V2 on the **2.4 GHz receiver** or **USB-C wired**
- Node.js 22.12+ and npm for development / packaging only

## Install and open

If it is already installed:

```bash
open -a "Maicong Studio"
```

Or search **Maicong Studio** in Launchpad / Spotlight. The bundle is `/Applications/Maicong Studio.app`.

From a package: open `dist/Maicong Studio-0.1.0-arm64.dmg` in this repo and drag the app into Applications.

The current build is **unsigned** Apple Silicon. If Gatekeeper blocks it: System Settings → Privacy & Security → Open Anyway.

> The packaged app can lag the source tree. For the latest code, run `npm start` in the project directory.

## Run from source

```bash
cd "/path/to/open-maicong"
npm install
npm start
```

Useful commands:

```bash
npm test              # unit tests
npm run test:mock-ui  # real renderer + in-memory keyboard (never opens HID)
npm run smoke         # offline window smoke
npm run dist          # DMG / ZIP (avoid spaces in the project path)
```

If the project path contains a space (for example a volume named `Extreme SSD`), `node-gyp` / electron-builder may fail. Copy the tree to a space-free path before packaging. See the [developer notes](./docs/DEVELOPER.md).

## How to use it

1. Plug in the 2.4 GHz receiver or USB-C and open the app. The sidebar should show connected.
2. **Load for editing** only fills the editor. **Activate** is what the keyboard actually uses.
3. Lighting and key edits autosave to the current edit target. Activate, enable the 4th profile, factory reset, and firmware update still need an explicit click.
4. Firmware: keyboard MCU in wired USB only; receiver RF in 2.4G only. Choose a local official `.bin`, review catalog size and hash, then confirm. Cancel sends no erase packets.
5. App auto-bind lives on Backup-tab onboard cards: link a `.app`; when it is frontmost this Mac activates that onboard slot.

## Safety and honesty

- Config HID is opened `nonExclusive` so normal typing stays available.
- No remote requests, telemetry, or accounts.
- Payloads are schema-checked; invalid input is rejected, not silently clipped.
- **Reads** have been checked on a live 2.4 GHz receiver (MCU 1.14 / RF 1.30).
- **Writes** (remap, lighting, macros, activate, factory reset, firmware flash) are proven against in-memory GLW. **They have not been destructive-tested on physical hardware.** Export a backup first.

Full inventory: [PARITY](./docs/PARITY.md). Protocol and packaging: [developer notes](./docs/DEVELOPER.md).

## License

[MIT](./LICENSE). Copyright © 2026 Open Maicong Contributors.
