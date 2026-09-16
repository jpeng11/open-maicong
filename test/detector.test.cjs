const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseIoreg } = require('../src/detector.cjs');

const SAMPLE_G75V2_RECEIVER = `
+-o Root  <class IORegistryEntry, id 0x100000100, retain 30>
  +-o AppleUSBXHCI@00000000  <class AppleUSBXHCI, id 0x100000210, retain 45>
    +-o MCHOSE G75 V2 2.4G@02400000  <class IOUSBHostDevice, id 0x10008b65a, registered, matched, active, busy 0 (2778 ms), retain 112>
        {
          "kUSBSerialNumberString" = "0F888B5A04DC0F888B5A04DC"
          "bDeviceClass" = 0
          "UsbLinkSpeed" = 480000000
          "bDeviceSubClass" = 0
          "iSerialNumber" = 3
          "iProduct" = 2
          "USB Serial Number" = "0F888B5A04DC0F888B5A04DC"
          "USB Vendor Name" = "MCHOSE"
          "USBSpeed" = 3
          "bNumConfigurations" = 1
          "kUSBProductString" = "MCHOSE G75 V2 2.4G"
          "kUSBVendorString" = "MCHOSE"
          "USB Product Name" = "MCHOSE G75 V2 2.4G"
          "iManufacturer" = 1
          "idVendor" = 14391
          "Device Speed" = 2
          "kUSBCurrentConfiguration" = 1
          "idProduct" = 12339
          "bcdDevice" = 304
          "locationID" = 37748736
          "bcdUSB" = 512
        }
`;

const SAMPLE_WIRED_KEYBOARD = `
+-o Root  <class IORegistryEntry, id 0x100000100, retain 30>
  +-o MCHOSE G75 V2@01100000  <class IOUSBHostDevice, id 0x10008b999, retain 50>
      {
        "kUSBSerialNumberString" = "MCG75V2WIRED001"
        "USB Vendor Name" = "MCHOSE"
        "USB Product Name" = "MCHOSE G75 V2"
        "idVendor" = 14391
        "idProduct" = 16400
        "locationID" = 17825792
        "UsbLinkSpeed" = 12000000
      }
`;

const SAMPLE_GENERIC_UNKNOWN = `
+-o Root  <class IORegistryEntry, id 0x100000100, retain 30>
  +-o Generic Flash Drive@03100000  <class IOUSBHostDevice, id 0x10008b111, retain 20>
      {
        "idVendor" = 8901
        "idProduct" = 4321
        "locationID" = 51380224
      }
`;

const SAMPLE_NON_MCHOSE = `
+-o Root  <class IORegistryEntry, id 0x100000100, retain 30>
  +-o Apple Internal Keyboard / Trackpad@01000000  <class IOUSBHostDevice, id 0x100000300, retain 20>
      {
        "USB Vendor Name" = "Apple Inc."
        "USB Product Name" = "Apple Internal Keyboard / Trackpad"
        "idVendor" = 1452
        "idProduct" = 636
      }
  +-o USB Receiver@02000000  <class IOUSBHostDevice, id 0x100000400, retain 20>
      {
        "USB Vendor Name" = "Logitech"
        "USB Product Name" = "USB Receiver"
        "idVendor" = 1133
        "idProduct" = 50487
      }
`;

describe('Hardware Detector & IOKit Enumeration', () => {
  test('accurately identifies MCHOSE G75 V2 2.4G receiver matching official WebHID filter', () => {
    const devices = parseIoreg(SAMPLE_G75V2_RECEIVER);
    assert.strictEqual(devices.length, 1);

    const dev = devices[0];
    assert.strictEqual(dev.vendorId, 14391);
    assert.strictEqual(dev.productId, 12339);
    assert.strictEqual(dev.hexVendorId, '0x3837');
    assert.strictEqual(dev.hexProductId, '0x3033');
    assert.strictEqual(dev.vendorName, 'MCHOSE');
    assert.strictEqual(dev.productName, 'MCHOSE G75 V2 2.4G');
    assert.strictEqual(dev.serialNumber, '0F888B5A04DC0F888B5A04DC');
    assert.strictEqual(dev.locationId, 37748736);
    assert.strictEqual(dev.hexLocationId, '0x02400000');
    assert.strictEqual(dev.speedBps, 480000000);
    assert.strictEqual(dev.bcdDevice, 304);
    assert.strictEqual(dev.isMchose, true);
    assert.strictEqual(dev.isReceiver, true);
    assert.strictEqual(dev.isG75V2Receiver, true);

    // Verified: simplified customer advisory and detected status
    assert.strictEqual(dev.statusText, 'Detected by macOS');
    assert.strictEqual(dev.badgeText, 'Receiver detected');
    assert.strictEqual(dev.advisory.headline, 'Receiver Connected');
    assert.match(dev.advisory.summary, /Your G75 V2 receiver is connected/i);
    assert.match(dev.advisory.summary, /Ready for offline configuration/i);
    // Ensure no false negative claims
    assert.strictEqual(dev.advisory.summary.includes('unsupported'), false);
    assert.strictEqual(dev.advisory.summary.includes('must wired'), false);
  });

  test('identifies wired MCHOSE keyboards without making false blanket claims', () => {
    const devices = parseIoreg(SAMPLE_WIRED_KEYBOARD);
    assert.strictEqual(devices.length, 1);

    const dev = devices[0];
    assert.strictEqual(dev.vendorId, 14391);
    assert.strictEqual(dev.productId, 16400);
    assert.strictEqual(dev.isReceiver, false);
    assert.strictEqual(dev.isG75V2Receiver, false);
    assert.strictEqual(dev.transport, 'USB Cable');
    assert.strictEqual(dev.statusText, 'Detected by macOS');
    assert.match(dev.advisory.summary, /Ready for offline configuration/i);
  });

  test('regression: generic unknown device without vendor string is excluded, not defaulted to MCHOSE', () => {
    const devices = parseIoreg(SAMPLE_GENERIC_UNKNOWN);
    assert.strictEqual(devices.length, 0);
  });

  test('ignores non-MCHOSE USB peripherals (Apple keyboard, Logitech mouse)', () => {
    const devices = parseIoreg(SAMPLE_NON_MCHOSE);
    assert.strictEqual(devices.length, 0);
  });

  test('gracefully handles empty or malformed inputs', () => {
    assert.deepStrictEqual(parseIoreg(''), []);
    assert.deepStrictEqual(parseIoreg(null), []);
    assert.deepStrictEqual(parseIoreg(undefined), []);
    assert.deepStrictEqual(parseIoreg('random garbage text with no matching usb entries'), []);
  });
});
