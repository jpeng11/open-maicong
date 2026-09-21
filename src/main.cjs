const { app, BrowserWindow, ipcMain, Menu, dialog, shell, Tray, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const transport = require('./transport.cjs');
const detector = require('./detector.cjs');
const validators = require('./schema-validators.cjs');
const macroMetadata = require('./macro-metadata.cjs');
const {
  G75_V2_KEYS,
  G75_V2_LIGHTING_ENTRIES,
  SPACE_LIGHTING_ZONES,
  REMAP_CATEGORIES,
  getRemapCategories,
  LIGHT_EFFECTS,
  SIDE_LIGHT_EFFECTS,
  LIGHT_EFFECT_DISPLAY_ORDER,
  LIGHT_EFFECT_PRESET_ORDER,
  SIDE_LIGHT_DISPLAY_ORDER,
  LIGHT_DIRECTION_PAIRS,
  VALID_PHYSICAL_SLOTS,
  ELIGIBLE_ADVANCED_SLOTS,
  SOCD_PRIORITIES,
  getDefaultTuple,
  getDefaultLayersData
} = require('./layout-g75v2.cjs');
const advancedPlan = require('./advanced-plan.cjs');
const { FirmwareSession } = require('./firmware-session.cjs');
const i18n = require('./i18n.js');
const { AppBindWatcher } = require('./profile-app-bind-watch.cjs');
const appBind = require('./profile-app-bind.cjs');

let win = null;
let deviceWatcher = null;
let firmwareSession = null;
let appBindWatcher = null;
let tray = null;
let isQuitting = false;

const smoke = process.argv.includes('--smoke-test');
const mockUiTest = process.argv.includes('--mock-ui-test');
const isDevHarness = (smoke || mockUiTest) && !app.isPackaged;
const isDev = !app.isPackaged && !smoke && !mockUiTest;
if (smoke || mockUiTest) {
  app.setPath('userData', path.join(app.getPath('temp'), `maicong-harness-${process.pid}`));
} else if (isDev) {
  app.setPath('userData', path.join(app.getPath('appData'), 'open-maicong-dev'));
}

function migrateLegacyUserData() {
  if (!app.isPackaged) return;
  try {
    const targetDir = app.getPath('userData');
    const appData = app.getPath('appData');
    const legacyDirs = [
      path.join(appData, 'Maicong Studio'),
      path.join(appData, 'open-maicong')
    ];
    const files = [
      'locale.json',
      'profile-library.json',
      'profile-app-binds.json',
      'macro-metadata.json',
      'lighting-memory.json',
      'still-library.json',
      'gif-library.json'
    ];
    for (const legacyDir of legacyDirs) {
      if (legacyDir === targetDir || !fs.existsSync(legacyDir)) continue;
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      for (const file of files) {
        const src = path.join(legacyDir, file);
        const dst = path.join(targetDir, file);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          try {
            fs.copyFileSync(src, dst);
          } catch {}
        }
      }
    }
  } catch {}
}

function getCompleteState() {
  const tState = transport.lastState;
  return {
    connected: tState.connected,
    device: tState.device,
    info: tState.info,
    base: tState.base,
    battery: tState.battery,
    firmware: tState.info ? tState.info.firmwareVersion : 'Unknown',
    rfFirmware: tState.info ? tState.info.rfFirmwareVersion : 'Unknown',
    buildDate: tState.info ? tState.info.buildDate : '',
    dongleInfo: tState.info ? tState.info.dongleInfo : '',
    activeProfileIndex: tState.activeProfileIndex,
    isStandby: transport.isStandby,
    needsReconnect: transport.needsReconnect,
    statusError: transport.statusError || tState.statusError || null,
    readSuccess: transport.lastReadSuccess !== false && tState.readSuccess !== false,
    lighting: tState.lighting,
    settings: tState.settings,
    keymaps: tState.keymaps,
    keyColors: tState.keyColors,
    macros: tState.macros,
    editTarget: transport.editTarget ? { ...transport.editTarget } : { profileIndex: 0, layer: null },
    resetEpoch: transport.resetEpoch,
    configUncertain: Boolean(transport.configUncertain),
    lastResetOutcome: transport.lastResetOutcome,
    resetInFlight: Boolean(transport.resetInFlight),
    selectedLightEffect: tState.selectedLightEffect || ['still', ''],
    stillLibrary: tState.stillLibrary || null,
    gifLibrary: tState.gifLibrary || null,
    isStreaming: Boolean(tState.isStreaming),
    profileLibrary: tState.profileLibrary || null,
    profileNames: tState.profileNames || null,
    profileNamesSource: tState.profileNamesSource || 'default',
    editSource: tState.editSource || { kind: 'onboard', profileIndex: tState.activeProfileIndex || 0 },
    appBinds: Array.isArray(tState.appBinds) ? tState.appBinds : []
  };
}

transport.onStateChange = () => {
  broadcastState();
};

transport.onGifFrame = (data) => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('maicong:gif-frame', data);
  }
};

function broadcastState() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('maicong:state-update', getCompleteState());
  }
}

function isFirmwareWriteInFlight() {
  if (typeof transport.isFirmwareExclusive === 'function' && transport.isFirmwareExclusive()) {
    return true;
  }
  // Resume never takes exclusive transport ownership until the device is
  // back in normal mode, so the session operation is the only in-flight
  // signal during bootloader erase/write.
  return Boolean(firmwareSession && firmwareSession.isUpdateInFlight());
}

// Mid-flash the HID handle must stay open; closing it mid-write can brick the keyboard.
function showFirmwareQuitWarning() {
  const options = {
    type: 'warning',
    buttons: [i18n.t('dialog.ok', { default: 'OK' })],
    defaultId: 0,
    title: i18n.t('dialog.quitBlockedTitle', { default: 'Cannot quit during firmware update' }),
    message: i18n.t('dialog.quitBlockedTitle', { default: 'Cannot quit during firmware update' }),
    detail: i18n.t('dialog.quitBlockedBody', {
      default: 'Quitting now closes the USB connection in the middle of a firmware write and can permanently brick the keyboard. Wait for the update to finish, then quit.'
    })
  };
  if (win && !win.isDestroyed()) {
    void dialog.showMessageBox(win, options);
  } else {
    void dialog.showMessageBox(options);
  }
}

function readFrontmostApp() {
  return new Promise((resolve) => {
    execFile('/usr/bin/lsappinfo', ['info', '-only', 'name,bundleid', 'front'], { timeout: 800 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(appBind.parseLsappinfo(String(stdout || '')));
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    title: isDev ? 'Open Maicong (Dev)' : 'Open Maicong',
    width: 1320,
    height: 900,
    minWidth: 1080,
    minHeight: 740,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#e6e7ed',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  const appPageUrl = pathToFileURL(path.join(__dirname, 'index.html')).toString();
  win.webContents.on('will-navigate', (event, url) => {
    if (url === appPageUrl) return;
    event.preventDefault();
    if (url.startsWith('https:') || url.startsWith('http:')) {
      void shell.openExternal(url);
    }
  });

  if (isDev) {
    console.log('[Dev] Running in live development mode. Auto-reloading on src/ changes.');
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if ((input.key.toLowerCase() === 'r' && (input.meta || input.control)) || input.key === 'F5') {
        event.preventDefault();
        win.webContents.reload();
      }
      if ((input.key.toLowerCase() === 'i' && (input.meta || input.control) && input.alt) || input.key === 'F12') {
        event.preventDefault();
        win.webContents.toggleDevTools();
      }
    });

    let reloadTimer = null;
    try {
      const watcher = fs.watch(__dirname, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        if (!filename.endsWith('.js') && !filename.endsWith('.cjs') && !filename.endsWith('.html') && !filename.endsWith('.css')) return;
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          if (win && !win.isDestroyed()) {
            console.log(`[Dev] Live reload triggered by change in ${filename}`);
            win.webContents.reload();
          }
        }, 150);
      });
      win.on('closed', () => {
        watcher.close();
      });
    } catch (err) {
      console.warn('[Dev] File watcher could not be started:', err.message);
    }
  }

  if (isDevHarness) {
    win.webContents.on('console-message', (details) => {
      console.log(`[Renderer] [${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error('[Renderer Gone]', details);
    });
  }

  win.on('close', (event) => {
    if (isFirmwareWriteInFlight()) {
      event.preventDefault();
      showFirmwareQuitWarning();
      return;
    }
    if (!isQuitting && !isDevHarness) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

// IPC Handlers with Narrow Input Validation
function localeFilePath() {
  return path.join(app.getPath('userData'), 'locale.json');
}

function readStoredLocale() {
  if (isDevHarness) return 'en';
  try {
    const raw = fs.readFileSync(localeFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return i18n.normalizeLocale(parsed && parsed.locale);
  } catch {
    return i18n.DEFAULT_LOCALE;
  }
}

function writeStoredLocale(locale) {
  const next = i18n.normalizeLocale(locale);
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(localeFilePath(), JSON.stringify({ locale: next }), 'utf8');
    return { locale: next, persisted: true };
  } catch {
    return { locale: next, persisted: false };
  }
}

ipcMain.handle('maicong:get-locale', () => {
  const locale = i18n.getLocale();
  return { success: true, locale };
});

ipcMain.handle('maicong:set-locale', (_event, locale) => {
  const stored = isDevHarness
    ? { locale: i18n.normalizeLocale(locale), persisted: false }
    : writeStoredLocale(locale);
  i18n.setLocale(stored.locale);
  setupAppMenu();
  setupTrayMenu();
  return { success: true, locale: stored.locale, persisted: stored.persisted };
});

ipcMain.handle('maicong:get-state', () => {
  return getCompleteState();
});

ipcMain.handle('maicong:get-layout', () => {
  const defaultLayers = { 0: {}, 1: {}, 2: {}, 3: {} };
  for (let layer = 0; layer < 4; layer++) {
    for (const slot of VALID_PHYSICAL_SLOTS) {
      const tuple = getDefaultTuple(layer, slot);
      defaultLayers[layer][slot] = { type: tuple[0], code1: tuple[1], code2: tuple[2] };
    }
  }
  return {
    keys: G75_V2_KEYS,
    lightingEntries: G75_V2_LIGHTING_ENTRIES,
    spaceLightingZones: SPACE_LIGHTING_ZONES,
    remapCategories: REMAP_CATEGORIES,
    layerRemapCategories: {
      0: getRemapCategories(0),
      1: getRemapCategories(1),
      2: getRemapCategories(2),
      3: getRemapCategories(3)
    },
    lightEffects: LIGHT_EFFECTS,
    sideLightEffects: SIDE_LIGHT_EFFECTS,
    lightEffectDisplayOrder: LIGHT_EFFECT_DISPLAY_ORDER,
    lightEffectPresetOrder: LIGHT_EFFECT_PRESET_ORDER,
    sideLightDisplayOrder: SIDE_LIGHT_DISPLAY_ORDER,
    lightDirectionPairs: LIGHT_DIRECTION_PAIRS,
    socdPriorities: SOCD_PRIORITIES,
    eligibleAdvancedSlots: Array.from(ELIGIBLE_ADVANCED_SLOTS),
    defaultLayers
  };
});

function firmwareWriteInFlightError() {
  return i18n.t('firmware.reasonBusy', { default: 'A firmware update is already in progress' });
}

ipcMain.handle('maicong:scan', async () => {
  if (mockUiTest && !app.isPackaged) {
    return { ioregDevices: [], hidDevices: [], state: getCompleteState(), mock: true };
  }
  if (isFirmwareWriteInFlight()) {
    return {
      ioregDevices: [],
      hidDevices: typeof transport.listDevices === 'function' ? transport.listDevices() : [],
      state: getCompleteState(),
      blocked: true,
      reason: 'firmware-update',
      error: firmwareWriteInFlightError()
    };
  }
  const ioregDevices = await detector.detectDevices();
  const hidDevices = transport.listDevices();

  if ((!transport.device || transport.needsReconnect) && hidDevices.length > 0) {
    if (transport.needsReconnect) {
      transport.disconnect();
    }
    const connectRes = transport.connect();
    if (connectRes.success) {
      const status = await transport.queryStatus();
      if (!status || !status.readSuccess || status.needsReconnect || transport.needsReconnect) {
        transport.disconnect();
      }
    }
    broadcastState();
  }

  return {
    ioregDevices,
    hidDevices,
    state: getCompleteState()
  };
});

ipcMain.handle('maicong:connect', async (_event, targetPath) => {
  if (isFirmwareWriteInFlight()) {
    return {
      success: false,
      error: firmwareWriteInFlightError(),
      reason: 'firmware-update',
      blocked: true
    };
  }
  if (targetPath && typeof targetPath !== 'string') {
    return { success: false, error: 'Invalid targetPath' };
  }
  const res = transport.connect(targetPath);
  if (res.success) {
    const status = await transport.queryStatus();
    if (!status || !status.readSuccess || status.needsReconnect || transport.needsReconnect) {
      transport.disconnect();
      broadcastState();
      return {
        success: false,
        error: (status && status.statusError) || transport.statusError || 'Handshake failed: keyboard connection timed out'
      };
    }
  }
  broadcastState();
  return res;
});

ipcMain.handle('maicong:disconnect', () => {
  if (isFirmwareWriteInFlight()) {
    return {
      success: false,
      error: firmwareWriteInFlightError(),
      reason: 'firmware-update',
      blocked: true
    };
  }
  transport.disconnect();
  broadcastState();
  return { success: true };
});

ipcMain.handle('maicong:query-status', async () => {
  const state = await transport.queryStatus();
  broadcastState();
  return state;
});

ipcMain.handle('maicong:switch-profile', async (_event, profileIndex) => {
  if (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 3) {
    return { success: false, error: 'Invalid profile index (must be 0..3)' };
  }
  const res = await transport.switchProfile(profileIndex);
  if (res.success) {
    await transport.queryStatus();
  }
  broadcastState();
  return res;
});

ipcMain.handle('maicong:read-layer', async (_event, profileIndex, layer, isDefault) => {
  const p = Number.isInteger(profileIndex) ? profileIndex : 0;
  const l = Number.isInteger(layer) ? layer : 0;
  if (p < 0 || p > 3 || l < 0 || l > 3) {
    return { success: false, error: 'Invalid layer or profile index' };
  }
  const res = await transport.readLayer(p, l, Boolean(isDefault));
  broadcastState();
  return res;
});

ipcMain.handle('maicong:read-key-colors', async (_event, profileIndex) => {
  const p = Number.isInteger(profileIndex) ? profileIndex : 0;
  if (p < 0 || p > 3) {
    return { success: false, error: 'Invalid profile index' };
  }
  const res = await transport.readKeyColors(p);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:read-macros', async () => {
  const res = await transport.readMacros();
  broadcastState();
  return res;
});

ipcMain.handle('maicong:get-lighting-memory-preference', async () => {
  const delay = Number(transport.lightMemoryPrefDelayMs) || 0;
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return transport.getLightMemoryPreference();
});

ipcMain.handle('maicong:set-lighting-memory-preference', async (_event, spec) => {
  if (!spec || typeof spec !== 'object') {
    return { success: false, error: 'Invalid lighting memory preference' };
  }
  if (spec.fallback !== 'hardware' && spec.fallback !== 'local') {
    return { success: false, error: 'fallback must be hardware or local' };
  }
  return transport.setLightMemoryFallback(spec.fallback);
});

ipcMain.handle('maicong:get-still-library', async () => {
  return transport.getStillLibrary();
});

ipcMain.handle('maicong:create-still', async (_event, name) => {
  if (typeof name !== 'string') {
    return { success: false, error: 'Still name must be a string' };
  }
  const res = await transport.createStill(name);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:rename-still', async (_event, spec) => {
  if (!spec || typeof spec !== 'object' || typeof spec.key !== 'string' || typeof spec.name !== 'string') {
    return { success: false, error: 'Still rename requires key and name' };
  }
  const res = await transport.renameStill(spec.key, spec.name);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:delete-still', async (_event, spec) => {
  if (!spec || typeof spec !== 'object' || typeof spec.key !== 'string') {
    return { success: false, error: 'Still delete requires a key' };
  }
  const res = await transport.deleteStill(spec.key, {
    activeKey: typeof spec.activeKey === 'string' ? spec.activeKey : undefined,
    profileIndex: spec.profileIndex
  });
  broadcastState();
  return res;
});

ipcMain.handle('maicong:update-still-frames', async (_event, spec) => {
  if (!spec || typeof spec !== 'object' || typeof spec.key !== 'string' || !spec.colors || typeof spec.colors !== 'object') {
    return { success: false, error: 'Still frame update requires key and colors' };
  }
  const res = await transport.updateStillFrames(spec.key, spec.colors, {
    profileIndex: spec.profileIndex,
    applyDevice: spec.applyDevice !== false,
    expectedKey: spec.expectedKey
  });
  broadcastState();
  return res;
});

ipcMain.handle('maicong:select-still', async (_event, spec) => {
  if (!spec || typeof spec !== 'object' || typeof spec.key !== 'string') {
    return { success: false, error: 'Still select requires a key' };
  }
  const p = spec.profileIndex !== undefined ? spec.profileIndex : null;
  if (p !== null && (!Number.isInteger(p) || p < 0 || p > 3)) {
    return { success: false, error: 'Invalid profile index' };
  }
  const res = await transport.selectStill(
    p === null ? transport.editTarget.profileIndex : p,
    spec.key,
    {
      applyCustom0: spec.applyCustom0 === true,
      lightingPatch: spec.lightingPatch && typeof spec.lightingPatch === 'object' ? spec.lightingPatch : undefined,
      persistMemory: spec.persistMemory
    }
  );
  broadcastState();
  return res;
});

ipcMain.handle('maicong:get-gif-library', async () => {
  return transport.getGifLibrary();
});

ipcMain.handle('maicong:create-gif', async (_event, spec) => {
  if (!spec || typeof spec !== 'object' || typeof spec.name !== 'string') {
    return { success: false, error: 'GIF create requires a name' };
  }
  const res = await transport.createGif(spec.name, spec.data, spec.extra);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:import-gif', async (_event, spec) => {
  let buf = null;
  let name = spec && typeof spec.name === 'string' ? spec.name : null;

  if (spec && spec.buffer) {
    let raw = spec.buffer;
    if (Buffer.isBuffer(raw)) {
      buf = raw;
    } else if (Array.isArray(raw)) {
      buf = Buffer.from(raw);
    } else if (raw && raw.type === 'Buffer' && Array.isArray(raw.data)) {
      buf = Buffer.from(raw.data);
    } else if (raw && raw.data && Array.isArray(raw.data)) {
      buf = Buffer.from(raw.data);
    } else if (ArrayBuffer.isView(raw)) {
      buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    } else if (raw instanceof ArrayBuffer) {
      buf = Buffer.from(raw);
    }
    if (buf && buf.length > 5 * 1024 * 1024) {
      return { success: false, error: 'GIF file size exceeds 5MB limit' };
    }
  } else {
    if (!win) return { success: false, error: 'No active window' };
    const opened = await dialog.showOpenDialog(win, {
      title: 'Import GIF Animation',
      filters: [{ name: 'GIF Animation', extensions: ['gif'] }],
      properties: ['openFile']
    });
    if (opened.canceled || opened.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    const targetFile = opened.filePaths[0];
    try {
      const stat = fs.statSync(targetFile);
      if (stat.size > 5 * 1024 * 1024) {
        return { success: false, error: 'GIF file size exceeds 5MB limit' };
      }
      buf = fs.readFileSync(targetFile);
      if (!name) {
        name = path.basename(targetFile, path.extname(targetFile));
      }
    } catch (err) {
      return { success: false, error: err.message || 'Failed to read GIF file' };
    }
  }

  if (!buf) {
    return { success: false, error: 'No GIF data provided' };
  }

  const res = await transport.importGifFile(buf, name);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:rename-gif', async (_event, spec) => {
  if (!spec || typeof spec !== 'object' || typeof spec.key !== 'string' || typeof spec.name !== 'string') {
    return { success: false, error: 'GIF rename requires key and name' };
  }
  const res = await transport.renameGif(spec.key, spec.name);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:delete-gif', async (_event, spec) => {
  if (!spec || typeof spec !== 'object' || typeof spec.key !== 'string') {
    return { success: false, error: 'GIF delete requires a key' };
  }
  const res = await transport.deleteGif(spec.key, {
    activeKey: typeof spec.activeKey === 'string' ? spec.activeKey : undefined,
    profileIndex: spec.profileIndex
  });
  broadcastState();
  return res;
});

ipcMain.handle('maicong:update-gif', async (_event, spec) => {
  if (!spec || typeof spec !== 'object' || typeof spec.key !== 'string' || !spec.updates) {
    return { success: false, error: 'GIF update requires key and updates' };
  }
  const res = await transport.updateGif(spec.key, spec.updates);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:select-gif', async (_event, spec) => {
  if (!spec || typeof spec !== 'object' || typeof spec.key !== 'string') {
    return { success: false, error: 'GIF select requires a key' };
  }
  const p = spec.profileIndex !== undefined ? spec.profileIndex : null;
  if (p !== null && (!Number.isInteger(p) || p < 0 || p > 3)) {
    return { success: false, error: 'Invalid profile index' };
  }
  const res = await transport.selectGif(
    p === null ? transport.editTarget.profileIndex : p,
    spec.key,
    {
      applyCustom0: spec.applyCustom0 === true,
      lightingPatch: spec.lightingPatch && typeof spec.lightingPatch === 'object' ? spec.lightingPatch : undefined,
      persistMemory: spec.persistMemory
    }
  );
  broadcastState();
  return res;
});

ipcMain.handle('maicong:set-gif-playback', async (_event, action) => {
  if (typeof action !== 'string') {
    return { success: false, error: 'Action must be a string' };
  }
  const res = transport.setGifPlayback(action);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:apply-lighting', async (_event, params, profileIndex, options) => {
  if (!params || typeof params !== 'object') {
    return { success: false, error: 'Invalid lighting parameters object' };
  }
  const val = validators.validateLightingParams(params);
  if (!val.valid) {
    return { success: false, error: val.error };
  }
  const p = profileIndex !== undefined ? profileIndex : null;
  if (p !== null && (!Number.isInteger(p) || p < 0 || p > 3)) {
    return { success: false, error: 'Invalid profile index' };
  }
  const opts = options && typeof options === 'object' ? options : {};
  const res = await transport.applyLighting(params, p, opts);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:apply-settings', async (_event, settings, profileIndex) => {
  if (!settings || typeof settings !== 'object') {
    return { success: false, error: 'Invalid settings object' };
  }
  const val = validators.validateSettingsParams(settings);
  if (!val.valid) {
    return { success: false, error: val.error };
  }
  const p = profileIndex !== undefined ? profileIndex : null;
  if (p !== null && (!Number.isInteger(p) || p < 0 || p > 3)) {
    return { success: false, error: 'Invalid profile index' };
  }
  const res = await transport.applySettings(settings, p);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:apply-keymap', async (_event, profileIndex, layer, keyUpdates, options) => {
  if (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 3) {
    return { success: false, error: 'Invalid profile index' };
  }
  if (!Number.isInteger(layer) || layer < 0 || layer > 3) {
    return { success: false, error: 'Invalid layer' };
  }
  if (!Array.isArray(keyUpdates)) {
    return { success: false, error: 'keyUpdates must be an array' };
  }

  const val = validators.validateKeymapUpdates(keyUpdates);
  if (!val.valid) {
    return { success: false, error: val.error };
  }

  // Validate every update slot against physical keys
  for (const u of keyUpdates) {
    const slot = u.slot !== undefined ? u.slot : u.index;
    if (!VALID_PHYSICAL_SLOTS.has(slot)) {
      return { success: false, error: `Invalid key slot: ${slot}. Non-physical slots cannot be modified.` };
    }
  }

  const res = await transport.applyKeymap(profileIndex, layer, keyUpdates, options && typeof options === 'object' ? options : undefined);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:apply-key-colors', async (_event, profileIndex, colors) => {
  if (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 3) {
    return { success: false, error: 'Invalid profile index' };
  }
  if (!colors || typeof colors !== 'object') {
    return { success: false, error: 'Invalid key colors' };
  }
  const val = validators.validateKeyColors(colors);
  if (!val.valid) {
    return { success: false, error: val.error };
  }
  const res = await transport.applyKeyColors(profileIndex, colors);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:apply-macros', async (_event, macros) => {
  if (!Array.isArray(macros) || macros.length > 16) {
    return { success: false, error: 'Invalid macros: must be array with at most 16 slots' };
  }
  const val = validators.validateMacroSlots(macros);
  if (!val.valid) {
    return { success: false, error: val.error };
  }
  const res = await transport.applyMacros(macros);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:is-harness', async () => isDevHarness);

ipcMain.handle('maicong:get-macro-metadata', async () => {
  const { meta, recovered } = macroMetadata.loadMacroMetadata();
  return { success: true, meta, recovered: Boolean(recovered) };
});

ipcMain.handle('maicong:set-macro-metadata', async (_event, incoming) => {
  try {
    const val = validators.validateMacroMetadata(incoming);
    if (!val.valid) {
      return { success: false, error: val.error };
    }
    const saved = macroMetadata.saveMacroMetadata(incoming);
    return { success: true, meta: saved };
  } catch (err) {
    return { success: false, error: err.message || 'Failed to save macro metadata' };
  }
});

ipcMain.handle('maicong:export-profile', async (_event, profileIndex) => {
  if (!win) return { success: false, error: 'No active window' };

  let targetProfile = 0;
  if (Number.isInteger(profileIndex)) {
    targetProfile = profileIndex;
  } else if (profileIndex && Number.isInteger(profileIndex.profileIndex)) {
    targetProfile = profileIndex.profileIndex;
  } else if (transport.lastState && Number.isInteger(transport.lastState.activeProfileIndex)) {
    targetProfile = transport.lastState.activeProfileIndex;
  }
  if (targetProfile < 0 || targetProfile > 3) targetProfile = 0;

  if (!transport.device || transport.needsReconnect) {
    return { success: false, error: 'Device not connected or requires reconnect' };
  }

  // Fresh atomic backend read transaction projecting verified physical slots
  const exportRes = await transport.exportProfile(targetProfile);
  if (!exportRes.success || !exportRes.data) {
    return { success: false, error: exportRes.error || 'Failed to export fresh profile from hardware' };
  }

  let filePath;
  if (mockUiTest && !app.isPackaged) {
    const artifacts = path.join(__dirname, '..', 'test-artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    filePath = path.join(artifacts, `mock-ui-export-profile-${targetProfile}.json`);
  } else {
    const save = await dialog.showSaveDialog(win, {
      title: 'Export Keyboard Profile',
      defaultPath: `mchose-g75v2-profile-${targetProfile + 1}.json`,
      filters: [{ name: 'JSON Profile', extensions: ['json'] }]
    });
    if (save.canceled || !save.filePath) return { success: false, canceled: true };
    filePath = save.filePath;
  }

  try {
    const { meta } = macroMetadata.loadMacroMetadata();
    const overlaid = macroMetadata.overlayExportMacros(exportRes.data.macros, meta);
    const data = {
      ...exportRes.data,
      macros: overlaid.macros,
      macroMetadata: overlaid.macroMetadata
    };
    const schema = validators.validateProfileSchema(data);
    if (!schema.valid) {
      return { success: false, error: schema.error };
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { success: true, filePath, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('maicong:apply-profile', async (_event, profileData, profileIndex) => {
  if (!profileData || typeof profileData !== 'object') {
    return { success: false, error: 'Invalid profile data' };
  }
  const p = profileIndex !== undefined ? profileIndex : null;
  if (p !== null && (!Number.isInteger(p) || p < 0 || p > 3)) {
    return { success: false, error: 'Invalid profile index' };
  }
  const res = await transport.applyProfile(profileData, p);
  if (res.success) {
    await transport.queryStatus();
  }
  broadcastState();
  return res;
});

ipcMain.handle('maicong:set-edit-target', (_event, profileIndex, layer) => {
  const res = transport.setEditTarget(profileIndex, layer === undefined ? null : layer);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:enable-profiles', async (_event, newCount) => {
  const count = newCount === undefined ? 4 : newCount;
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    return { success: false, error: 'Profile count must be integer 1..4' };
  }
  const res = await transport.enableProfiles(count);
  if (res.success) {
    await transport.queryStatus();
  }
  broadcastState();
  return res;
});

ipcMain.handle('maicong:read-func-config', async (_event, profileIndex) => {
  const p = Number.isInteger(profileIndex) ? profileIndex : 0;
  if (p < 0 || p > 3) {
    return { success: false, error: 'Invalid profile index' };
  }
  return transport.readFuncConfig(p);
});

ipcMain.handle('maicong:read-advanced', async (_event, profileIndex) => {
  const p = Number.isInteger(profileIndex) ? profileIndex : 0;
  if (p < 0 || p > 3) {
    return { success: false, error: 'Invalid profile index' };
  }
  const res = await transport.readAdvanced(p);
  return res;
});

ipcMain.handle('maicong:apply-advanced', async (_event, spec) => {
  if (!spec || typeof spec !== 'object') {
    return { success: false, error: 'Invalid advanced binding spec' };
  }
  const val = validators.validateAdvancedBinding(spec);
  if (!val.valid) {
    return { success: false, error: val.error };
  }
  const res = await transport.applyAdvancedBinding(spec);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:remove-advanced', async (_event, profileIndex, layer, slot) => {
  if (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 3) {
    return { success: false, error: 'Invalid profile index' };
  }
  if (!Number.isInteger(layer) || layer < 0 || layer > 3) {
    return { success: false, error: 'Invalid layer' };
  }
  if (!Number.isInteger(slot)) {
    return { success: false, error: 'Invalid slot' };
  }
  const res = await transport.removeAdvancedBinding(profileIndex, layer, slot);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:clear-all-advanced', async (_event, spec) => {
  if (!spec || typeof spec !== 'object') {
    return { success: false, error: 'Invalid clear-all advanced spec' };
  }
  const val = validators.validateClearAllAdvanced(spec);
  if (!val.valid) {
    return { success: false, error: val.error };
  }
  const res = await transport.clearAllAdvancedBindings(spec);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:apply-advanced-local', async (_event, payload) => {
  if (!payload || typeof payload !== 'object' || !payload.spec || !payload.snapshot) {
    return { success: false, error: 'Invalid local advanced payload', hardwareWrites: 0 };
  }
  const val = validators.validateAdvancedBinding(payload.spec);
  if (!val.valid) {
    return { success: false, error: val.error, hardwareWrites: 0 };
  }
  const defaults = getDefaultLayersData();
  return advancedPlan.applyAdvancedToLocalSnapshot(payload.snapshot, payload.spec, defaults);
});

ipcMain.handle('maicong:clear-all-advanced-local', async (_event, payload) => {
  if (!payload || typeof payload !== 'object' || !payload.snapshot) {
    return { success: false, error: 'Invalid local clear-all payload', hardwareWrites: 0 };
  }
  const defaults = getDefaultLayersData();
  return advancedPlan.clearAllAdvancedOnLocalSnapshot(payload.snapshot, defaults);
});

ipcMain.handle('maicong:prepare-factory-reset', async (_event, scope) => {
  if (scope !== 'active' && scope !== 'all') {
    return { success: false, error: 'scope must be "active" or "all"' };
  }
  const res = await transport.prepareFactoryReset({ scope });
  broadcastState();
  return res;
});

ipcMain.handle('maicong:commit-factory-reset', async (_event, spec) => {
  if (!spec || typeof spec !== 'object') {
    return { success: false, error: 'Invalid reset spec', dispatched: false };
  }
  if (spec.scope !== 'active' && spec.scope !== 'all') {
    return { success: false, error: 'scope must be "active" or "all"', dispatched: false };
  }
  const res = await transport.commitFactoryReset({
    scope: spec.scope,
    expectedActiveProfileIndex: spec.expectedActiveProfileIndex,
    expectedIdentity: spec.expectedIdentity,
    expectedGeneration: spec.expectedGeneration,
    expectedResetEpoch: spec.expectedResetEpoch
  });
  if (res && res.success) {
    macroMetadata.attachConfirmedResetMetadata(res, spec.scope);
    const idx = Number.isInteger(res.activeProfileIndex) ? res.activeProfileIndex : null;
    transport.clearLightingMemoryFallback(spec.scope, idx);
  }
  broadcastState();
  return res;
});

function broadcastFirmwareProgress(event) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('maicong:firmware-progress', event);
  }
}

function ensureFirmwareSession() {
  if (firmwareSession) return firmwareSession;
  const options = {
    transport,
    backupDir: app.getPath('userData'),
    onProgress: broadcastFirmwareProgress,
    chooseFile: async () => {
      if (!win) return { canceled: true };
      const opened = await dialog.showOpenDialog(win, {
        title: 'Choose official G75 V2 firmware package',
        filters: [
          { name: 'Firmware package', extensions: ['bin'] },
          { name: 'All files', extensions: ['*'] }
        ],
        properties: ['openFile']
      });
      if (opened.canceled || opened.filePaths.length === 0) return { canceled: true };
      return { canceled: false, filePath: opened.filePaths[0] };
    }
  };
  if (mockUiTest && !app.isPackaged) {
    const mockFw = require(path.join(__dirname, '..', 'test', 'mock-firmware-io.cjs'));
    const artifacts = path.join(__dirname, '..', 'test-artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    const receiverPath = path.join(artifacts, 'mock-ui-firmware-receiver.bin');
    const mismatchPath = path.join(artifacts, 'mock-ui-firmware-mismatch.bin');
    fs.writeFileSync(receiverPath, mockFw.RECEIVER_BYTES);
    fs.writeFileSync(mismatchPath, mockFw.MISMATCH_BYTES);
    options.catalog = mockFw.createMockUiCatalog();
    options.nativeIoFactory = (nativeOptions = {}) => {
      const firmwareBackup = require('./firmware-backup.cjs');
      const identity = nativeOptions.reviewedIdentity || firmwareBackup.currentDeviceIdentity(transport);
      const targetKey = nativeOptions.target || 'receiver';
      return new mockFw.MockNativeFirmwareIo({
        normalIdentity: identity,
        bootIdentity: mockFw.bootIdentityFromNormal(identity, targetKey),
        returnedNormalIdentity: identity,
        onFlashed() {
          const hid = global.__maicongMockHid;
          if (!hid || !hid.info || hid.info.length < 4) return;
          const after = targetKey === 'keyboard'
            ? mockFw.KEYBOARD_INFO_AFTER
            : mockFw.RECEIVER_INFO_AFTER;
          const raw = targetKey === 'keyboard' ? after.rawFirmwareVersion : after.rawRfFirmwareVersion;
          const offset = targetKey === 'keyboard' ? 0 : 2;
          hid.info[offset] = raw & 0xFF;
          hid.info[offset + 1] = (raw >> 8) & 0xFF;
        }
      });
    };
    options.chooseFile = async (spec = {}) => {
      const fixture = spec && spec.fixture === 'mismatch' ? mismatchPath : receiverPath;
      return { canceled: false, filePath: fixture };
    };
    transport.backupFirmwareConfiguration = async (backupOptions = {}) => ({
      success: true,
      persisted: true,
      readyForUpdate: true,
      filePath: backupOptions.filePath,
      backupRetained: true,
      backup: { schema: 'mock-ui-firmware' }
    });
    transport.restoreFirmwareConfiguration = async () => ({
      success: true,
      restorationVerified: true,
      backupRetained: true
    });
  }
  firmwareSession = new FirmwareSession(options);
  return firmwareSession;
}

ipcMain.handle('maicong:firmware-status', async () => {
  return ensureFirmwareSession().status();
});

ipcMain.handle('maicong:firmware-choose-package', async (_event, spec) => {
  const session = ensureFirmwareSession();
  if (mockUiTest && !app.isPackaged) {
    const mockFw = require(path.join(__dirname, '..', 'test', 'mock-firmware-io.cjs'));
    const artifacts = path.join(__dirname, '..', 'test-artifacts');
    const filePath = spec && spec.fixture === 'mismatch'
      ? path.join(artifacts, 'mock-ui-firmware-mismatch.bin')
      : path.join(artifacts, 'mock-ui-firmware-receiver.bin');
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(artifacts, { recursive: true });
      fs.writeFileSync(
        filePath,
        spec && spec.fixture === 'mismatch' ? mockFw.MISMATCH_BYTES : mockFw.RECEIVER_BYTES
      );
    }
    return session.selectPackageFile(filePath);
  }
  return session.choosePackage();
});

ipcMain.handle('maicong:firmware-review', async () => {
  return ensureFirmwareSession().review();
});

ipcMain.handle('maicong:firmware-start', async (_event, spec) => {
  const confirmed = Boolean(spec && (spec.confirmed === true || spec.confirm === true || spec.confirmation === true));
  return ensureFirmwareSession().confirmStart({ confirmed });
});

ipcMain.handle('maicong:firmware-cancel', async (_event, reason) => {
  return ensureFirmwareSession().cancel(reason);
});

ipcMain.handle('maicong:firmware-dismiss-review', async () => {
  return ensureFirmwareSession().dismissReview();
});

ipcMain.handle('maicong:firmware-interrupted-status', async () => {
  return ensureFirmwareSession().interruptedUpdateStatus();
});

ipcMain.handle('maicong:firmware-resume', async (_event, spec) => {
  if (spec != null && (typeof spec !== 'object' || Array.isArray(spec))) {
    return { success: false, error: 'Invalid firmware resume specification' };
  }
  const confirmed = Boolean(spec && (spec.confirmed === true || spec.confirm === true || spec.confirmation === true));
  return ensureFirmwareSession().resumeInterruptedUpdate({
    confirmed,
    allowDifferentPackage: Boolean(spec && spec.allowDifferentPackage === true),
    filePath: spec && typeof spec.filePath === 'string' ? spec.filePath : undefined,
    backupPath: spec && typeof spec.backupPath === 'string' ? spec.backupPath : undefined,
    drainTimeoutMs: spec && Number.isFinite(spec.drainTimeoutMs) ? spec.drainTimeoutMs : undefined
  });
});

ipcMain.handle('maicong:firmware-discard-interrupted', async () => {
  return ensureFirmwareSession().discardInterruptedUpdate();
});

ipcMain.handle('maicong:import-profile', async () => {
  if (!win) return { success: false, error: 'No active window' };
  let targetFile;
  if (mockUiTest && !app.isPackaged) {
    targetFile = path.join(__dirname, '..', 'test-artifacts', 'mock-ui-export-profile-0.json');
    if (!fs.existsSync(targetFile)) {
      return { success: false, error: 'No mock export file to import' };
    }
  } else {
    const opened = await dialog.showOpenDialog(win, {
      title: 'Import Keyboard Profile',
      filters: [{ name: 'JSON Profile', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (opened.canceled || opened.filePaths.length === 0) return { success: false, canceled: true };
    targetFile = opened.filePaths[0];
  }

  try {
    const stat = fs.statSync(targetFile);

    // Strict 1MB size limit to prevent IPC / memory exhaustion
    if (stat.size > 1024 * 1024) {
      return { success: false, error: 'File size exceeds 1MB limit' };
    }

    const content = fs.readFileSync(targetFile, 'utf8');
    const parsed = JSON.parse(content);

    // Basic schema sanity check
    if (!parsed || typeof parsed !== 'object') {
      return { success: false, error: 'Invalid JSON file content' };
    }

    // Prevalidate full schema before returning preview
    const val = validators.validateProfileSchema(parsed);
    if (!val.valid) {
      return { success: false, error: `Invalid profile schema: ${val.error}` };
    }

    return {
      success: true,
      data: parsed,
      filePath: targetFile
    };
  } catch (err) {
    return { success: false, error: `Failed to import profile: ${err.message}` };
  }
});

ipcMain.handle('maicong:get-profile-library', async () => {
  return transport.getProfileLibrary();
});

ipcMain.handle('maicong:create-local-profile', async (_event, name) => {
  const res = await transport.createLocalProfile(name);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:copy-onboard-to-local', async (_event, spec) => {
  const profileIndex = spec && Number.isInteger(spec.profileIndex) ? spec.profileIndex : 0;
  const res = await transport.copyOnboardToLocal(profileIndex, spec && spec.name);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:rename-profile', async (_event, spec) => {
  if (!spec || typeof spec !== 'object') return { success: false, error: 'Invalid rename spec' };
  const res = await transport.renameProfile(spec);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:delete-local-profile', async (_event, key) => {
  if (typeof key !== 'string') return { success: false, error: 'Invalid profile key' };
  const res = await transport.deleteLocalProfile(key);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:delete-onboard-profile', async (_event, key) => {
  if (typeof key !== 'string') return { success: false, error: 'Invalid profile key' };
  const res = await transport.deleteOnboardProfile(key);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:reorder-profiles', async (_event, keys) => {
  if (!Array.isArray(keys)) return { success: false, error: 'Reorder keys must be an array' };
  const res = await transport.reorderProfiles(keys);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:move-local-to-onboard', async (_event, spec) => {
  if (!spec || typeof spec.sourceKey !== 'string') return { success: false, error: 'Invalid move spec' };
  const res = await transport.moveLocalToOnboard(spec.sourceKey, spec.targetKey || null, { activate: spec.activate !== false });
  broadcastState();
  return res;
});

ipcMain.handle('maicong:copy-onboard-to-onboard', async (_event, spec) => {
  if (!spec || typeof spec.sourceKey !== 'string' || typeof spec.targetKey !== 'string') {
    return { success: false, error: 'Invalid onboard copy spec' };
  }
  const res = await transport.copyOnboardToOnboard(spec.sourceKey, spec.targetKey, { activate: spec.activate !== false });
  broadcastState();
  return res;
});

ipcMain.handle('maicong:move-onboard-to-local', async (_event, spec) => {
  if (!spec || typeof spec.sourceKey !== 'string') return { success: false, error: 'Invalid move spec' };
  const res = await transport.moveOnboardToLocal(spec.sourceKey, spec.localTargetKey);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:list-app-binds', async () => {
  return transport.listAppBinds();
});

ipcMain.handle('maicong:bind-profile-app', async (_event, spec) => {
  if (!spec || !Number.isInteger(spec.profileIndex)) {
    return { success: false, error: 'profileIndex must be 0..3' };
  }
  if (spec.appPath !== undefined
    && (typeof spec.appPath !== 'string' || !path.isAbsolute(spec.appPath) || !spec.appPath.endsWith('.app'))) {
    return { success: false, error: 'appPath must be an absolute path to a .app bundle' };
  }
  let payload = {
    profileIndex: spec.profileIndex,
    bundleId: spec.bundleId,
    displayName: spec.displayName,
    appPath: spec.appPath
  };
  if (!payload.bundleId) {
    if (mockUiTest && !app.isPackaged) {
      payload.bundleId = 'com.mock.game';
      payload.displayName = 'Mock Game';
      payload.appPath = '/Applications/Mock Game.app';
    } else {
      if (!win) return { success: false, error: 'No active window' };
      const opened = await dialog.showOpenDialog(win, {
        title: 'Choose a game or app to bind',
        defaultPath: '/Applications',
        properties: ['openFile'],
        filters: [{ name: 'Applications', extensions: ['app'] }]
      });
      if (opened.canceled || opened.filePaths.length === 0) return { success: false, canceled: true };
      payload.appPath = opened.filePaths[0];
      payload.displayName = path.basename(payload.appPath, '.app');
      payload.bundleId = spec.bundleId || payload.displayName.replace(/\s+/g, '.').toLowerCase();
      try {
        const plist = path.join(payload.appPath, 'Contents', 'Info.plist');
        if (fs.existsSync(plist)) {
          const { execFileSync } = require('node:child_process');
          const id = execFileSync('/usr/bin/defaults', ['read', plist, 'CFBundleIdentifier'], { encoding: 'utf8', timeout: 1500 }).trim();
          if (id) payload.bundleId = id;
          const name = execFileSync('/usr/bin/defaults', ['read', plist, 'CFBundleName'], { encoding: 'utf8', timeout: 1500 }).trim();
          if (name) payload.displayName = name;
        }
      } catch {
        // Keep path-derived id; bind validation still requires a bundle-shaped id.
      }
    }
  }
  const res = transport.bindProfileApp(payload);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:unbind-profile-app', async (_event, profileIndex) => {
  const res = transport.unbindProfileApp(profileIndex);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:set-mock-frontmost', async (_event, spec) => {
  if (!(mockUiTest && !app.isPackaged)) {
    return { success: false, error: 'Mock frontmost is only available in the unpackaged harness' };
  }
  global.__maicongMockFrontmost = spec && spec.bundleId
    ? { bundleId: String(spec.bundleId), displayName: spec.displayName || String(spec.bundleId) }
    : null;
  if (appBindWatcher) await appBindWatcher.tick();
  broadcastState();
  return { success: true, frontmost: global.__maicongMockFrontmost, lastSwitch: appBindWatcher && appBindWatcher.lastSwitch };
});

ipcMain.handle('maicong:load-local-profile-preview', async (_event, key) => {
  if (typeof key !== 'string') return { success: false, error: 'Invalid profile key' };
  const res = transport.loadLocalProfilePreview(key);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:save-local-profile-draft', async (_event, spec) => {
  if (!spec || typeof spec.key !== 'string' || !spec.data) {
    return { success: false, error: 'Invalid local draft' };
  }
  const res = await transport.saveLocalProfileDraft(spec.key, spec.data);
  broadcastState();
  return res;
});

ipcMain.handle('maicong:set-edit-source', async (_event, spec) => {
  const res = transport.setEditSource(spec || {});
  broadcastState();
  return res;
});

ipcMain.handle('maicong:import-official-profile', async () => {
  if (!win) return { success: false, error: 'No active window' };
  let targetFile;
  if (mockUiTest && !app.isPackaged) {
    targetFile = path.join(__dirname, '..', 'test-artifacts', 'mock-ui-official-import.json');
    if (!fs.existsSync(targetFile)) {
      return { success: false, error: 'No mock official import file' };
    }
  } else {
    const opened = await dialog.showOpenDialog(win, {
      title: 'Import official keyboard profile',
      filters: [{ name: 'JSON Profile', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (opened.canceled || opened.filePaths.length === 0) return { success: false, canceled: true };
    targetFile = opened.filePaths[0];
  }
  try {
    const stat = fs.statSync(targetFile);
    if (stat.size > 1024 * 1024) return { success: false, error: 'File size exceeds 1MB limit' };
    const parsed = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    const before = transport.lastState && transport.lastState.connected
      ? (transport.device && transport.device.writtenBuffers ? transport.device.writtenBuffers.length : null)
      : null;
    void before;
    const res = await transport.importOfficialProfile(parsed);
    broadcastState();
    return res;
  } catch (err) {
    return { success: false, error: err.message || 'Official import failed' };
  }
});

ipcMain.handle('maicong:export-official-profile', async (_event, spec) => {
  if (!win) return { success: false, error: 'No active window' };
  const exported = await transport.exportOfficialProfile(spec || {});
  if (!exported.success) return exported;
  let filePath;
  const name = (exported.data && exported.data.data && exported.data.data.name) || 'profile';
  if (mockUiTest && !app.isPackaged) {
    const artifacts = path.join(__dirname, '..', 'test-artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    filePath = path.join(artifacts, `mock-ui-official-export.json`);
  } else {
    const save = await dialog.showSaveDialog(win, {
      title: 'Export official keyboard profile',
      defaultPath: `${name}.json`,
      filters: [{ name: 'JSON Profile', extensions: ['json'] }]
    });
    if (save.canceled || !save.filePath) return { success: false, canceled: true };
    filePath = save.filePath;
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(exported.data, null, 2), 'utf8');
    return { success: true, filePath, data: exported.data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

function showMainWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
  } else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function compareSemver(v1, v2) {
  const p1 = String(v1 || '').split('.').map((x) => parseInt(x, 10) || 0);
  const p2 = String(v2 || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

function fetchLatestRelease() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/jpeng11/open-maicong/releases/latest',
      method: 'GET',
      headers: {
        'User-Agent': 'Open-Maicong-App',
        'Accept': 'application/vnd.github.v3+json'
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        return resolve({ success: false, error: `GitHub API returned HTTP ${res.statusCode}`, currentVersion: app.getVersion() });
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const tagName = String(parsed.tag_name || '').trim();
          const cleanTag = tagName.replace(/^v/, '');
          const currentVersion = app.getVersion();
          const hasUpdate = compareSemver(cleanTag, currentVersion) > 0;

          const assets = Array.isArray(parsed.assets) ? parsed.assets : [];
          const dmgAsset = assets.find((a) => a && typeof a.name === 'string' && a.name.endsWith('.dmg'))
            || assets.find((a) => a && typeof a.name === 'string' && a.name.endsWith('.zip'));

          const downloadUrl = (dmgAsset && dmgAsset.browser_download_url) || parsed.html_url || 'https://github.com/jpeng11/open-maicong/releases/latest';

          resolve({
            success: true,
            hasUpdate,
            currentVersion,
            latestVersion: cleanTag || currentVersion,
            tagName: tagName || `v${cleanTag}`,
            releaseName: parsed.name || tagName,
            releaseNotes: parsed.body || '',
            releaseUrl: parsed.html_url || 'https://github.com/jpeng11/open-maicong/releases/latest',
            downloadUrl
          });
        } catch (err) {
          resolve({ success: false, error: `Failed to parse release: ${err.message}`, currentVersion: app.getVersion() });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ success: false, error: err.message, currentVersion: app.getVersion() });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Connection timed out', currentVersion: app.getVersion() });
    });

    req.end();
  });
}

async function checkAppUpdateInteractive() {
  showMainWindow();
  const res = await fetchLatestRelease();
  if (!res.success) {
    dialog.showMessageBox(win, {
      type: 'warning',
      title: i18n.t('update.dialogErrorTitle', { default: 'Update Check Failed' }),
      message: i18n.t('update.dialogErrorTitle', { default: 'Update Check Failed' }),
      detail: i18n.t('update.dialogErrorMessage', { error: res.error, default: `Unable to check for updates: ${res.error}` }),
      buttons: [i18n.t('dialog.ok', { default: 'OK' })]
    });
    return;
  }

  if (res.hasUpdate) {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'info',
      title: i18n.t('update.dialogTitle', { default: 'Update Available' }),
      message: i18n.t('update.dialogMessage', { latest: res.latestVersion, default: `A new version of Open Maicong is available (v${res.latestVersion})` }),
      detail: i18n.t('update.dialogDetail', { current: res.currentVersion, default: `Current version: v${res.currentVersion}\n\nWould you like to download it now?` }),
      buttons: [
        i18n.t('update.dialogDownload', { default: 'Download Update' }),
        i18n.t('update.dialogLater', { default: 'Later' })
      ],
      defaultId: 0,
      cancelId: 1
    });
    if (choice === 0 && res.downloadUrl) {
      void shell.openExternal(res.downloadUrl);
    }
  } else {
    dialog.showMessageBox(win, {
      type: 'info',
      title: i18n.t('update.dialogUpToDateTitle', { default: 'Up to Date' }),
      message: i18n.t('update.dialogUpToDateMessage', { current: res.currentVersion, default: `Open Maicong is up to date (v${res.currentVersion}).` }),
      buttons: [i18n.t('dialog.ok', { default: 'OK' })]
    });
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: i18n.t('tray.showWindow', { default: 'Show Main Window' }),
      accelerator: 'CmdOrCtrl+M',
      click: () => {
        showMainWindow();
      }
    },
    { type: 'separator' },
    {
      label: i18n.t('tray.settings', { default: 'Settings...' }),
      accelerator: 'CmdOrCtrl+,',
      click: () => {
        showMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('maicong:navigate-tab', 'settings');
        }
      }
    },
    {
      label: i18n.t('tray.about', { default: 'About Open Maicong' }),
      click: () => {
        showMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('maicong:navigate-tab', 'guide');
        }
      }
    },
    {
      label: i18n.t('tray.checkUpdates', { default: 'Check for Updates...' }),
      accelerator: 'CmdOrCtrl+U',
      click: () => {
        void checkAppUpdateInteractive();
      }
    },
    { type: 'separator' },
    {
      label: i18n.t('tray.quit', { default: 'Quit Open Maicong' }),
      accelerator: 'CmdOrCtrl+Q',
      click: () => {
        if (isFirmwareWriteInFlight()) {
          showFirmwareQuitWarning();
          return;
        }
        isQuitting = true;
        app.quit();
      }
    }
  ]);
}

function setupTray() {
  if (tray) return;
  const icon1x = path.join(__dirname, 'assets', 'trayTemplate.png');
  const icon2x = path.join(__dirname, 'assets', 'trayTemplate@2x.png');
  let trayImage;
  if (fs.existsSync(icon1x)) {
    trayImage = nativeImage.createFromPath(icon1x);
    if (fs.existsSync(icon2x)) {
      trayImage.addRepresentation({
        scaleFactor: 2.0,
        buffer: fs.readFileSync(icon2x)
      });
    }
    trayImage.setTemplateImage(true);
  } else {
    trayImage = nativeImage.createEmpty();
  }

  tray = new Tray(trayImage);
  tray.setToolTip('Open Maicong');
  tray.setContextMenu(buildTrayMenu());

  tray.on('click', () => {
    showMainWindow();
  });
  tray.on('double-click', () => {
    showMainWindow();
  });
}

function setupTrayMenu() {
  if (tray) {
    tray.setContextMenu(buildTrayMenu());
  }
}

ipcMain.handle('maicong:check-app-update', async () => {
  return fetchLatestRelease();
});

ipcMain.handle('maicong:download-app-update', async (_event, url) => {
  if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
    void shell.openExternal(url);
    return { success: true };
  }
  return { success: false, error: 'Invalid download URL' };
});

function setupAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: 'Open Maicong',
      submenu: [
        {
          label: i18n.t('menu.about'),
          click: () => {
            dialog.showMessageBox(win, {
              title: i18n.t('menu.about'),
              message: 'Open Maicong',
              detail: i18n.t('menu.aboutDetail', { version: app.getVersion() })
            });
          }
        },
        {
          label: i18n.t('tray.checkUpdates', { default: 'Check for Updates...' }),
          accelerator: 'CmdOrCtrl+U',
          click: () => {
            void checkAppUpdateInteractive();
          }
        },
        { type: 'separator' },
        {
          label: i18n.t('tray.settings', { default: 'Settings...' }),
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            showMainWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send('maicong:navigate-tab', 'settings');
            }
          }
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: i18n.t('tray.quit', { default: 'Quit Open Maicong' }),
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            if (isFirmwareWriteInFlight()) {
              showFirmwareQuitWarning();
              return;
            }
            isQuitting = true;
            app.quit();
          }
        }
      ]
    }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: i18n.t('menu.guide'),
          click: () => {
            showMainWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send('maicong:navigate-tab', 'guide');
            }
          }
        },
        {
          label: i18n.t('tray.checkUpdates', { default: 'Check for Updates...' }),
          click: () => {
            void checkAppUpdateInteractive();
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Node's default unhandled-rejection mode is throw, so rejections land here too.
process.on('uncaughtException', (err) => {
  console.error('[Fatal] Uncaught exception in main process:', err);
  try {
    // Mid-flash the HID handle must stay untouched; the OS reclaims it on exit.
    if (!isFirmwareWriteInFlight()) transport.disconnect();
  } catch {
    // Cleanup must not mask the original error.
  }
  if (app.isReady()) {
    dialog.showErrorBox('Open Maicong encountered an unexpected error', String((err && err.stack) || err));
  }
  process.exit(1);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    migrateLegacyUserData();
    i18n.setLocale(readStoredLocale());
    setupAppMenu();
    if (!isDevHarness) {
      setupTray();
    }

    if (mockUiTest && !app.isPackaged) {
      const { MockGlwMemoryDevice } = require(path.join(__dirname, '..', 'test', 'mock-glw-memory.cjs'));
      const profileNames = require('./profile-names.cjs');
      const tokenNames = require(path.join(__dirname, '..', 'test', 'fixtures', 'profile-names-i18n-default-onboard.json'));
      const mockHid = new MockGlwMemoryDevice();
      profileNames.seedDeviceProfileNames(mockHid, tokenNames.stored);
      transport.installTestAdapter(mockHid);
      global.__maicongMockHid = mockHid;
      await transport.queryStatus();
    }

    global.__maicongMockFrontmost = mockUiTest && !app.isPackaged ? null : global.__maicongMockFrontmost;
    appBindWatcher = new AppBindWatcher({
      intervalMs: mockUiTest && !app.isPackaged ? 40 : 1000,
      ignoreBundleIds: ['dev.openmaicong.studio', 'com.github.Electron', 'Electron'],
      getBinds: () => (transport.listAppBinds().binds || []),
      getActiveProfile: () => {
        const base = transport.lastState && transport.lastState.base;
        if (base && Number.isInteger(base.activeProfile)) return base.activeProfile;
        return Number.isInteger(transport.lastState.activeProfileIndex)
          ? transport.lastState.activeProfileIndex
          : null;
      },
      isConnected: () => Boolean(transport.lastState && transport.lastState.connected),
      isBusy: () => Boolean(isFirmwareWriteInFlight() || transport.resetInFlight),
      getFrontmost: mockUiTest && !app.isPackaged
        ? async () => global.__maicongMockFrontmost
        : readFrontmostApp,
      switchProfile: async (idx) => {
        const res = await transport.switchProfile(idx);
        broadcastState();
        return res;
      }
    });
    appBindWatcher.start();

    createWindow();

    if (!isDevHarness) {
      deviceWatcher = detector.startDeviceWatcher(async () => {
        if (isFirmwareWriteInFlight()) {
          // The updater owns the normal/boot transition.  Detector callbacks
          // are not awaited by the watcher, so this gate must live here as
          // well as in transport.connect()/queryStatus().
          broadcastState();
          return;
        }
        if (!transport.device || transport.needsReconnect) {
          if (transport.needsReconnect) {
            transport.disconnect();
          }
          const connectRes = transport.connect();
          if (connectRes.success) {
            const status = await transport.queryStatus();
            if (!status || !status.readSuccess || status.needsReconnect || transport.needsReconnect) {
              transport.disconnect();
            }
          }
        }
        broadcastState();
      }, 3000);
    }

    app.on('activate', () => {
      showMainWindow();
    });

    if (mockUiTest && !app.isPackaged) {
      (async () => {
        let mockTimer = null;
        try {
          const mockUiRunner = require(path.join(__dirname, '..', 'test', 'mock-ui-integration.cjs'));
          const timeoutPromise = new Promise((_, reject) => {
            mockTimer = setTimeout(() => reject(new Error('Mock UI verification timed out after 180000ms')), 180000);
          });
          await Promise.race([
            mockUiRunner.run({
              app,
              getWindow: () => win,
              getState: getCompleteState,
              getMock: () => global.__maicongMockHid
            }),
            timeoutPromise
          ]);
          if (mockTimer) clearTimeout(mockTimer);
          transport.disconnect();
          console.log('[MockUI] Renderer integration against mock memory passed.');
          app.exit(0);
        } catch (err) {
          if (mockTimer) clearTimeout(mockTimer);
          transport.disconnect();
          console.error('[MockUI] Renderer integration failed:', err);
          app.exit(1);
        }
      })();
    } else if (smoke && !app.isPackaged) {
      const smokeRunner = require(path.join(__dirname, '..', 'test', 'smoke.cjs'));
      (async () => {
        let smokeTimer = null;
        try {
          const timeoutPromise = new Promise((_, reject) => {
            smokeTimer = setTimeout(() => reject(new Error('Smoke verification timed out after 15000ms')), 15000);
          });
          await Promise.race([
            smokeRunner.run({
              app,
              getWindow: () => win,
              getState: getCompleteState
            }),
            timeoutPromise
          ]);
          if (smokeTimer) clearTimeout(smokeTimer);
          deviceWatcher?.stop();
          transport.disconnect();
          console.log('[Smoke] Standalone macOS verification passed cleanly.');
          app.exit(0);
        } catch (err) {
          if (smokeTimer) clearTimeout(smokeTimer);
          deviceWatcher?.stop();
          transport.disconnect();
          console.error('[Smoke] Standalone verification failed:', err);
          app.exit(1);
        }
      })();
    }
  }).catch((err) => {
    console.error('[Startup] Failed to initialize Open Maicong:', err);
    try {
      if (!isFirmwareWriteInFlight()) transport.disconnect();
    } catch {
      // Startup is already aborting; cleanup must not throw again.
    }
    dialog.showErrorBox('Open Maicong failed to start', String((err && err.stack) || err));
    app.exit(1);
  });

  app.on('before-quit', (event) => {
    if (isFirmwareWriteInFlight()) {
      event.preventDefault();
      showFirmwareQuitWarning();
      return;
    }
    isQuitting = true;
    deviceWatcher?.stop();
    if (appBindWatcher) appBindWatcher.stop();
    if (tray) {
      tray.destroy();
      tray = null;
    }
    transport.disconnect();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || isDevHarness) {
      app.quit();
    }
  });
}
