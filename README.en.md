# Maicong Studio

[简体中文](./README.md) | **English**

A macOS configuration app for the MCHOSE G75 V2 mechanical keyboard. Official software is limited to Windows and a web hub; this project provides a standalone Mac app to configure your keyboard locally without cloud services or network access.

> Independent community project. Not affiliated with, sponsored by, or endorsed by MCHOSE (迈从). MCHOSE is a registered trademark of its owner.

## What it does

Available features for the G75 V2 mechanical keyboard:

| Area | What you can do |
| :--- | :--- |
| Lighting | Main effects 0-22, custom static images / GIFs, side lights 1-4, brightness / speed / direction / color controls, and white balance |
| Key settings | Four layers (Win, WinFn, Mac, MacFn), click or drag remapping, copy / cut / paste, shortcut recording, and default reset |
| Advanced keys | Mod-Tap (MT), Toggle (TGL), SOCD modes 0-3, key combos (CB), binding list, key tester, and clear all |
| Performance | Polling rates (1 / 2 / 4 / 8 kHz), sleep timer (1-30 minutes or never sleep), repeat keys, Win key lock, and Mac / Win mode switching |
| Macros | 16 onboard slots, record / pause / resume, and loop repeat settings (0 / 1 / 255) |
| Profiles | 4 onboard slots, separate edit-loading and hardware activation, local library storing up to 20 profiles, and official KeyboardProfile v3 import/export |
| Others | Factory reset (active slot or all slots), and firmware updates using official binary packages with size and SHA-256 verification |
| App auto-bind | Associate onboard profiles with macOS apps so profiles switch automatically when an app is frontmost |
| Language | Interface language toggle (中文 / EN) in the title bar, defaulting to Chinese and remembering your preference |

Features exclusive to magnetic switches (such as Rapid Trigger, DKS, and travel calibration) are not supported because the G75 V2 uses mechanical switches.

Because the app operates completely offline under a `connect-src 'none'` Content Security Policy, online features such as cloud profile sharing, CDN firmware downloads, and audio-reactive lighting are not included.

## Requirements

- macOS 13 Ventura or later (Apple Silicon or Intel)
- MCHOSE G75 V2 keyboard connected via the 2.4 GHz receiver or USB-C cable
- Node.js 22.12+ and npm for development and building from source

## Install and open

### Homebrew (recommended, Apple Silicon)

```bash
brew install --cask jpeng11/open-maicong/maicong-studio
```

This taps [`jpeng11/homebrew-open-maicong`](https://github.com/jpeng11/homebrew-open-maicong) and installs the cask. The package is an ad-hoc signed Apple Silicon 0.1.0 build without an Apple Developer ID; the cask clears Gatekeeper quarantine during installation. If macOS still blocks launch, open System Settings > Privacy & Security > Open Anyway.

Intel users can run from source or build locally using `npm run dist` on an Intel Mac, where electron-builder packages for the host architecture.

```bash
brew upgrade --cask maicong-studio          # upgrade
brew uninstall --cask maicong-studio        # uninstall
brew uninstall --cask --zap maicong-studio  # uninstall and delete local data
```

Once installed:

```bash
open -a "Maicong Studio"
```

You can also launch Maicong Studio from Launchpad or Spotlight. The application bundle is `/Applications/Maicong Studio.app`.

### Disk image

Download `Maicong-Studio-*-arm64.dmg` from [GitHub Releases](https://github.com/jpeng11/open-maicong/releases) and drag the app into your Applications folder. Local builds are written to `dist/` (ignored by git).

> Pre-built releases may lag behind the main branch. To run the latest code, execute `npm start` in the repository directory.

## Run from source

```bash
cd "/path/to/open-maicong"
npm install
npm start
```

Common developer commands:

```bash
npm test              # unit tests
npm run test:mock-ui  # UI with in-memory simulated keyboard (does not touch HID devices)
npm run smoke         # offline window smoke test
npm run dist          # build DMG and ZIP packages (ensure path has no spaces)
```

If your project path contains spaces (for example, on a volume named `Extreme SSD`), `node-gyp` or electron-builder may fail. Copy the repository to a space-free directory before packaging. See the [developer notes](./docs/DEVELOPER.md).

## How to use it

1. Plug in the 2.4 GHz receiver or connect via USB-C, then launch the app. The sidebar will indicate connection status.
2. Toggle between 中文 and EN in the title bar. Daily launches default to Chinese, and your selection is saved locally.
3. Loading a profile for editing loads configuration data into the editor without altering the active profile on the keyboard. Click Activate to apply that profile to hardware.
4. Lighting and key adjustments save automatically to the active edit slot. Activating profiles, enabling the 4th onboard slot, performing factory resets, and upgrading firmware require explicit confirmation.
5. Firmware updates: keyboard MCU firmware updates over wired USB, while receiver RF firmware updates over 2.4 GHz wireless. After selecting an official `.bin` file, verify the displayed file size and SHA-256 hash before confirming; canceling sends no erase commands to the device.
6. Automatic app profile binding is configured on the onboard cards under the Backup tab. Link any `.app` bundle, and the keyboard switches to that onboard profile whenever the application becomes active.

## Device safety and verification

- Device configuration uses a non-exclusive HID handle (`nonExclusive`), so regular typing input remains functional.
- The app operates offline with no telemetry, network requests, or account logins.
- All payloads undergo schema and range validation before transmission; malformed requests are rejected.
- Read operations have been confirmed on a physical 2.4 GHz receiver running MCU 1.14 / RF 1.30.
- Write operations (key mapping, lighting, macros, profile activation, factory reset, and firmware flashing) have been validated using the in-memory mock device, but have not undergone destructive physical testing on production hardware. Export a backup profile before modifying device configuration.

For a full feature breakdown, consult [PARITY](./docs/PARITY.md). For communication protocol and packaging details, see the [developer notes](./docs/DEVELOPER.md).

## License

Distributed under the [MIT](./LICENSE) license. Copyright © 2026 Open Maicong Contributors.
