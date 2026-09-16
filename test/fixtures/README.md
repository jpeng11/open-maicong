# Test Fixtures & Protocol Provenance

This directory contains reproducible test fixtures captured from physical keyboard hardware over USB/HID endpoints:

- **`readonly-baseline.json`**: Captured state of an attached MCHOSE G75 V2 2.4G Receiver (VID `0x3837` / `14391`, PID `0x3033` / `12339`) using read-only GLW commands:
  - CMD 4 (GET_BASE) 56-byte onboard profile configuration
  - CMD 5 (GET_FUNC_CONFIG) 64-byte lighting, battery, and timing configuration
  - CMD 7/8 (GET_KEY_MATRIX) 4-layer key tuples across Win and Mac profiles
  - CMD 10 (GET_KEY_COLOR) 384-byte per-key RGB matrix
  - CMD 12 (GET_MACROS) 8192-byte shared macro flash memory
- **`default-matrix.hex`**: Captured default key matrix returned by hardware command CMD 7.
- **`default-layers.json`**: CMD 7 read-only capture of all 4 default layers (384 bytes each) used as immutable SOCD/MT pair fixtures.
- **`advanced-baseline.json`**: CMD 164/166/160 read-only capture: 256-byte MT table (zeros), 128-byte TGL table (zeros), 1024-byte key extras (`a9004f0000000000` repeated). All checksums valid; no mutation.
- **`profile-configs.json`**: CMD 5 read-only 64-byte funcConfig for profiles 0..3 (inactive profiles 1..3 have `macMode` byte 1 = 0 until explicitly written).
- **`info-reply.json`**: Real wire replies for CMD 3 (GET_INFO) demonstrating the verified hardware exception where the device echoes the request's checksum (`0x38` for size 56, `0x26` for size 38) over a 38-byte payload.
- **`maicong-g75-palette-reference.json`**: Independently extracted reference palette packed 24-bit tuples from vendor G75 configuration (`windowsExtra` 47, `macExtra` 32, `basic` 104, `mouse` 7, `mainLighting` 9, `sideLighting` 8) used for unconditional 24-bit decomposition testing.

### Attribution & Cleanliness
- These fixtures contain only raw protocol byte snapshots and JSON structured data.
- No proprietary vendor JavaScript, reverse-engineered binaries, or copyrighted bundle files are included.
- All unit tests run against these local repository fixtures without any external `/tmp` file dependency.
