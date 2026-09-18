const { execFile } = require('node:child_process');

/**
 * Pure function to parse `ioreg -p IOUSB -l` output.
 * Extracts USB devices matching MCHOSE/Maicong hardware.
 *
 * @param {string} text - Raw output from ioreg
 * @returns {Array<Object>} List of detected MCHOSE devices
 */
function parseIoreg(text) {
  if (typeof text !== 'string') return [];
  const devices = [];
  const entries = text.split(/\+\-o\s+/);

  for (const entry of entries) {
    const vidMatch = entry.match(/"idVendor"\s*=\s*(\d+)/);
    const pidMatch = entry.match(/"idProduct"\s*=\s*(\d+)/);
    if (!vidMatch || !pidMatch) continue;

    const vendorId = parseInt(vidMatch[1], 10);
    const productId = parseInt(pidMatch[1], 10);

    const prodNameMatch = entry.match(/"(?:kUSBProductString|USB Product Name)"\s*=\s*"([^"]+)"/);
    const vendNameMatch = entry.match(/"(?:kUSBVendorString|USB Vendor Name)"\s*=\s*"([^"]+)"/);
    const serialMatch = entry.match(/"(?:kUSBSerialNumberString|USB Serial Number)"\s*=\s*"([^"]+)"/);
    const locationMatch = entry.match(/"locationID"\s*=\s*(\d+)/);
    const speedMatch = entry.match(/"UsbLinkSpeed"\s*=\s*(\d+)/);
    const bcdDeviceMatch = entry.match(/"bcdDevice"\s*=\s*(\d+)/);

    const nodeHeaderMatch = entry.match(/^([^\n@<]+)(?:@[0-9a-fA-F]+)?/);
    const nodeHeader = nodeHeaderMatch ? nodeHeaderMatch[1].trim() : '';

    const rawProductName = prodNameMatch ? prodNameMatch[1] : '';
    const rawVendorName = vendNameMatch ? vendNameMatch[1] : '';

    // Guard: Must match actual MCHOSE vendor ID or explicit name BEFORE applying display defaults
    const isMchose = vendorId === 14391 ||
      /mchose|maicong/i.test(rawVendorName) ||
      /mchose|maicong/i.test(rawProductName) ||
      /mchose|maicong/i.test(nodeHeader);

    if (!isMchose) continue;

    const productName = rawProductName || nodeHeader || 'MCHOSE Device';
    const vendorName = rawVendorName || 'MCHOSE';

    const isG75V2Receiver = (vendorId === 14391 && productId === 12339) ||
      (/G75.*V2/i.test(productName) && /2\.4G|dongle|receiver/i.test(productName));
    const isReceiver = isG75V2Receiver || /2\.4G|dongle|receiver/i.test(productName);

    const hexVendorId = '0x' + vendorId.toString(16).padStart(4, '0').toUpperCase();
    const hexProductId = '0x' + productId.toString(16).padStart(4, '0').toUpperCase();
    const locationId = locationMatch ? parseInt(locationMatch[1], 10) : null;
    const hexLocationId = locationId != null ? '0x' + locationId.toString(16).padStart(8, '0').toUpperCase() : null;

    devices.push({
      id: `${hexVendorId}:${hexProductId}:${serialMatch ? serialMatch[1] : (hexLocationId || '0')}`,
      vendorId,
      productId,
      hexVendorId,
      hexProductId,
      vendorName,
      productName,
      serialNumber: serialMatch ? serialMatch[1] : null,
      locationId,
      hexLocationId,
      speedBps: speedMatch ? parseInt(speedMatch[1], 10) : null,
      bcdDevice: bcdDeviceMatch ? parseInt(bcdDeviceMatch[1], 10) : null,
      isMchose: true,
      isReceiver,
      isG75V2Receiver,
      transport: isReceiver ? '2.4GHz Wireless Receiver' : 'USB Cable',
      statusText: 'Detected by macOS',
      badgeText: isG75V2Receiver ? 'Receiver detected' : (isReceiver ? 'Receiver detected' : 'USB Device'),
      advisory: isG75V2Receiver
        ? {
            headline: 'Receiver Connected',
            summary: 'Your G75 V2 receiver is connected via 2.4GHz wireless. Ready for offline configuration.',
            recommendedAction: 'Configure Device'
          }
        : {
            headline: 'Device Connected',
            summary: 'Your keyboard is connected via USB cable. Ready for offline configuration.',
            recommendedAction: 'Configure Device'
          }
    });
  }

  return devices;
}

let activeChildProcess = null;
let inFlightScan = null;

function runDetectDevices() {
  return new Promise(resolve => {
    if (process.platform !== 'darwin') {
      resolve([]);
      return;
    }

    activeChildProcess = execFile(
      '/usr/sbin/ioreg',
      ['-p', 'IOUSB', '-l'],
      { timeout: 3500, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        activeChildProcess = null;
        if (error || !stdout) {
          resolve([]);
          return;
        }
        try {
          resolve(parseIoreg(stdout));
        } catch {
          resolve([]);
        }
      }
    );
  });
}

/**
 * Scans macOS USB devices using `/usr/sbin/ioreg`.
 * Single in-flight scan concurrency limit to avoid overlapping subprocesses.
 *
 * @returns {Promise<Array<Object>>}
 */
function detectDevices() {
  if (inFlightScan) return inFlightScan;
  inFlightScan = runDetectDevices().finally(() => {
    inFlightScan = null;
  });
  return inFlightScan;
}

/**
 * Starts a background periodic watcher to detect hotplug events.
 *
 * @param {Function} onChange - Callback receiving (devices)
 * @param {number} [intervalMs=3500] - Polling interval
 * @returns {{ stop: Function, trigger: Function }}
 */
function startDeviceWatcher(onChange, intervalMs = 3500) {
  let timer = null;
  let lastFingerprint = '';
  let stopped = false;
  let isChecking = false;

  async function check() {
    if (stopped || isChecking) return;
    isChecking = true;
    try {
      const devices = await detectDevices();
      if (stopped) return;

      const fingerprint = devices.map(d => `${d.id}:${d.transport}`).sort().join('|');
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        try { onChange(devices); } catch {}
      }
    } catch {} finally {
      isChecking = false;
    }
  }

  timer = setInterval(check, intervalMs);
  void check();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (activeChildProcess) {
        try { activeChildProcess.kill('SIGKILL'); } catch {}
        activeChildProcess = null;
      }
    },
    trigger() {
      void check();
    }
  };
}

module.exports = { parseIoreg, detectDevices, startDeviceWatcher };
