/**
 * Maicong Studio — G75 V2 Standalone Renderer
 * 100% Offline, Native GLW Protocol Interface
 */

const api = window.maicongApi;
const I18n = window.MaicongI18n;

function t(key, vars) {
  return I18n && typeof I18n.t === 'function' ? I18n.t(key, vars) : (vars && vars.default) || key;
}

function refreshLocaleUi() {
  if (I18n && typeof I18n.apply === 'function') I18n.apply(document);
  renderEditTargetBar();
  renderProfileLibrary();
  if (typeof renderLightingControls === 'function') renderLightingControls();
  if (typeof renderDashboard === 'function') renderDashboard();
}
const MacroDraft = window.MaicongMacroDraft;
const LightingAutosave = window.MaicongLightingAutosave;
const PerformanceAutosave = window.MaicongPerformanceAutosave;
const KeyConfig = window.MaicongKeyConfig;
const keymapSaveGate = KeyConfig.createSaveGate();
const settingsSaveGate = KeyConfig.createSaveGate();

// Application State
const state = {
  activeTab: 'dashboard',
  activeProfile: 0,
  editingProfile: 0,
  activeLayer: 0,
  editGeneration: 0,
  userChoseLayer: false,
  didInitLayerFromMacMode: false,
  selectedKeyId: 'k_esc',
  selectedKey: null,
  activeMacroSlot: 0,
  paletteCategory: 'Standard Keys',
  device: null,
  connected: false,
  battery: { batteryLevel: null, isCharging: false },
  info: null,
  base: { activeProfile: 0, profileCount: 3, profileOrder: [0, 1, 2, 3] },
  lighting: {
    effect: 0,
    brightness: 100,
    speed: 4, // 0..4
    direction: 0,
    customColorDisabled: false,
    hexColor: '#00E5FF',
    sideEffect: 1,
    sideBrightness: 80,
    sideSpeed: 4,
    sideHexColor: '#00E5FF',
    calibrationRgb: { r: 255, g: 255, b: 255 }
  },
  settings: {
    sleepTime: 6, // 6 = 180 seconds (3 min)
    sleepMode: 0, // 0 = sleep enabled, 1 = never sleep
    debounceLevel: 2,
    macMode: 2, // Default hardware baseline is 2 (Profile 0, Mac mode)
    lockWin: false,
    reporteRate: 4, // 4 = 1kHz
    tickRate: 0,
    reportRate24G: 1,
    rollerType: 0
  },
  lightingDraftDirty: false,
  lightingEdited: {},
  lightingOpInFlight: false,
  lightingOpSeq: 0,
  lightingHydrateLocked: false,
  lightingSaveStatus: 'idle',
  lightingSaveError: null,
  lightingSaveBlocked: false,
  lightingMemoryBlocked: false,
  lightingMemoryError: null,
  lightingSaveTimer: null,
  lightingSaveQueued: false,
  lightingSaveWorkerBusy: false,
  lightingLastFlushAt: 0,
  lightingPrefQueued: null,
  lightingPrefInFlight: false,
  lightingReadQueued: false,
  lightingReadInFlight: false,
  lightingPrefOpSeq: 0,
  lightingCalQueued: null,
  lightingCalInFlight: false,
  lightMemory: null,
  lightMemoryPref: null,
  settingsDraftDirty: false,
  settingsEdited: {},
  settingsFieldRevs: {},
  settingsPersistedRevs: {},
  settingsSaveStatus: 'idle',
  settingsSaveError: null,
  settingsSaveBlocked: false,
  settingsSaveQueued: false,
  settingsOpSeq: 0,
  settingsOpInFlight: false,
  settingsReadInFlight: false,
  settingsFieldErrors: {},
  sleepSliderDraft: null,
  layout: null,
  // Layer keymaps mapped by slot: { [layer]: { [slot]: { type, code1, code2, code, label } } }
  layerKeymaps: { 0: {}, 1: {}, 2: {}, 3: {} },
  // Per-key RGB colors mapped by slot: { [slot]: '#RRGGBB' }
  stagedKeyColors: {},
  changedKeyColors: {},
  stagedMacros: [],
  importedProfileData: null,
  isRecordingMacro: false,
  macroLastEventTime: 0,
  macroRecordingSlot: null,
  macroPressed: {},
  macroMeta: null,
  macroSelectedActionIndex: null,
  macroClipboard: [],
  harness: false,
  hasReadLighting: false,
  hasReadSettings: false,
  hasReadKeymap: { 0: false, 1: false, 2: false, 3: false },
  hasReadKeyColors: false,
  hasReadMacros: false,
  loadInFlight: false,
  loadReadActive: 0,
  loadReadOverlap: false,
  loadStartedWhileWorkerBusy: false,
  localMacroNames: {},
  cbEditorTarget: null,
  cbDraft: { modifier: null, regular: null },
  resetEpoch: 0,
  configUncertain: false,
  resetReview: null,
  resetDialogOpen: false,
  resetCommitInFlight: false,
  resetDialogOpener: null,
  appBinds: [],
  firmwareStatus: null,
  firmwareDialogOpen: false,
  firmwareCommitInFlight: false,
  firmwareDialogOpener: null,
  lastUnsolicitedResetKey: null,
  lightingScope: 'main',
  mainLightTab: 'normal',
  stillLibrary: {
    items: [],
    count: 0,
    max: 20,
    remaining: 20,
    selectedKey: null,
    selectedPair: ['still', ''],
    error: null
  },
  selectedStillKey: null,
  selectedLightEffect: ['still', ''],
  stillEditTimer: null,
  stillEditSeq: 0,
  stillDirtyKey: null,
  lightingStillQueue: [],
  stillNameDialogMode: null,
  stillNameDialogKey: null,
  stillNameDialogOpener: null,
  gifLibrary: {
    items: [],
    count: 0,
    max: 20,
    remaining: 20,
    selectedKey: null,
    selectedPair: ['gif', ''],
    error: null
  },
  selectedGifKey: null,
  lightingGifQueue: [],
  gifNameDialogMode: null,
  gifNameDialogKey: null,
  gifNameDialogOpener: null,
  gifEditor: null,
  gifEditorPreviewTimer: null,
  gifEditorPreviewIndex: 0,
  isStreaming: false,
  profileLibrary: {
    onboard: [],
    local: [],
    remaining: 16,
    max: 20,
    error: null
  },
  profileNames: ['Default Onboard', 'Default Onboard2', 'Default Onboard3', 'Default Onboard4'],
  editSource: { kind: 'onboard', profileIndex: 0 },
  profileBusy: false,
  profileNameDialogMode: null,
  profileNameDialogKey: null,
  keyClipboard: null,
  keyDragging: null,
  keyRecorder: null,
  keymapDirty: false,
  keymapSaveInFlight: false,
  keymapSaveQueued: false,
  keymapSaveStatus: 'idle',
  keymapSaveError: null,
  keymapSlotRevs: {},
  keymapSlotPersisted: {},
  localPreviewData: null,
  keymapResetDialogOpen: false,
  keymapResetOpener: null,
  cbKeyIndexList: [[], [], [], []],
  advancedKind: 'mt',
  advancedDeleteConfirmId: '',
  advancedClearDialogOpen: false,
  advancedClearOpener: null,
  advancedClearCaptured: null,
  bindingTestPress: [],
  bindingTestRelease: [],
  bindingTestTimer: null,
  bindingTestListening: false
};

// UI Elements
const els = {
  tabs: document.querySelectorAll('.tab'),
  panels: {
    dashboard: document.getElementById('panel-dashboard'),
    keymap: document.getElementById('panel-keymap'),
    lighting: document.getElementById('panel-lighting'),
    macros: document.getElementById('panel-macros'),
    advanced: document.getElementById('panel-advanced'),
    settings: document.getElementById('panel-settings'),
    profiles: document.getElementById('panel-profiles'),
    others: document.getElementById('panel-others'),
    guide: document.getElementById('panel-guide')
  },
  connectionPill: document.getElementById('device-connection-pill'),
  deviceStatusText: document.getElementById('device-status-text'),
  batteryStatText: document.getElementById('battery-stat-text'),
  profileStatText: document.getElementById('profile-stat-text'),
  toast: document.getElementById('toast-banner'),
  toastMsg: document.getElementById('toast-message'),
  toastIcon: document.getElementById('toast-icon')
};

// Helper to manage disabled state of Apply buttons
function updateApplyButtonsState() {
  const loading = Boolean(state.loadInFlight);
  const readLightingBtn = document.getElementById('btn-read-lighting');
  if (readLightingBtn) {
    readLightingBtn.disabled = !state.connected || state.loadInFlight || state.lightingReadInFlight;
  }
  const applyLightingBtn = document.getElementById('btn-apply-lighting');
  if (applyLightingBtn) applyLightingBtn.disabled = !canEditLighting();

  const applySettingsBtn = document.getElementById('btn-apply-settings');
  if (applySettingsBtn) {
    applySettingsBtn.hidden = true;
    applySettingsBtn.disabled = true;
  }
  const retrySettingsBtn = document.getElementById('btn-retry-settings-save');
  if (retrySettingsBtn) {
    const showRetry = Boolean(
      state.hasReadSettings
      && PerformanceAutosave.hasDirty(state.settingsEdited)
      && (
        state.settingsSaveBlocked
        || state.settingsSaveStatus === 'error'
        || state.settingsSaveStatus === 'unsaved'
      )
    );
    retrySettingsBtn.hidden = !showRetry;
    retrySettingsBtn.disabled = !showRetry || loading;
  }
  const readSettingsBtn = document.querySelector('[data-action="read-settings"]');
  if (readSettingsBtn) {
    readSettingsBtn.disabled = !state.connected || state.loadInFlight || state.settingsReadInFlight;
  }

  const applyKeymapBtn = document.getElementById('btn-apply-keymap');
  if (applyKeymapBtn) applyKeymapBtn.disabled = loading || !state.hasReadKeymap[state.activeLayer];
  updateRestoreDefaultsButton();
  renderKeyRecorder();

  const applyKeyColorsBtn = document.getElementById('btn-apply-key-colors');
  if (applyKeyColorsBtn) {
    applyKeyColorsBtn.disabled = loading || (!state.hasReadKeyColors && Object.keys(state.changedKeyColors).length === 0);
  }

  const applyMacrosBtn = document.getElementById('btn-apply-macros');
  if (applyMacrosBtn) applyMacrosBtn.disabled = loading || !state.hasReadMacros;

  const applyAdv = document.getElementById('btn-apply-advanced');
  if (applyAdv) applyAdv.disabled = loading;
  const applyCal = document.getElementById('btn-apply-calibration');
  if (applyCal) {
    applyCal.disabled = !canEditLighting() || state.lightingReadInFlight || state.lightingCalInFlight;
  }
  const retryBtn = document.getElementById('btn-retry-lighting-save');
  if (retryBtn) {
    const showRetry = Boolean(
      state.hasReadLighting
      && (state.lightingSaveBlocked || state.lightingMemoryBlocked)
      && !state.lightingReadInFlight
    );
    retryBtn.hidden = !showRetry;
    retryBtn.disabled = !showRetry;
  }
}

function resetCbEditorCache() {
  state.cbEditorTarget = null;
}

function invalidateMacroBank() {
  state.hasReadMacros = false;
  updateApplyButtonsState();
}

function invalidateEditorSnapshots() {
  state.hasReadLighting = false;
  state.hasReadSettings = false;
  state.hasReadKeymap = { 0: false, 1: false, 2: false, 3: false };
  state.hasReadKeyColors = false;
  state.layerKeymaps = { 0: {}, 1: {}, 2: {}, 3: {} };
  adoptCbKeyIndexList(KeyConfig.emptyCbKeyIndexList());
  state.advancedDeleteConfirmId = '';
  state.bindingTestPress = [];
  state.bindingTestRelease = [];
  stopAdvancedBindingTester();
  state.stagedKeyColors = {};
  state.changedKeyColors = {};
  abortLightingScheduler();
  abortSettingsScheduler();
  haltKeyRecorder();
  state.keymapDirty = false;
  state.keymapSaveQueued = false;
  state.keymapSaveStatus = 'idle';
  state.keymapSaveError = null;
  KeyConfig.clearSlotRevs(state.keymapSlotRevs, state.keymapSlotPersisted);
  state.keyDragging = null;
  renderKeymapSaveStatus();
  state.lightingDraftDirty = false;
  state.lightingEdited = {};
  state.lightingOpInFlight = false;
  state.lightingOpSeq += 1;
  state.lightingHydrateLocked = true;
  state.lightingSaveStatus = 'idle';
  state.lightingSaveError = null;
  state.lightingSaveBlocked = false;
  state.lightingMemoryBlocked = false;
  state.lightingMemoryError = null;
  state.lightMemory = null;
  state.settingsDraftDirty = false;
  state.settingsEdited = {};
  state.settingsSaveStatus = 'idle';
  state.settingsSaveError = null;
  state.settingsSaveBlocked = false;
  state.settingsSaveQueued = false;
  state.settingsOpInFlight = false;
  state.settingsReadInFlight = false;
  state.settingsFieldErrors = {};
  state.settingsOpSeq += 1;
  state.sleepSliderDraft = null;
  PerformanceAutosave.clearFieldRevs(state.settingsFieldRevs, state.settingsPersistedRevs);
  state.advancedRead = null;
  resetCbEditorCache();
  invalidateMacroBank();
  renderSettingsControls();
  renderLightingControls();
}

function ensureMacroMeta() {
  if (!state.macroMeta || !Array.isArray(state.macroMeta.slots)) {
    state.macroMeta = MacroDraft.defaultMetadata();
  }
  return state.macroMeta;
}

function slotMeta(index) {
  const meta = ensureMacroMeta();
  if (!meta.slots[index]) meta.slots[index] = MacroDraft.defaultSlotMeta();
  return meta.slots[index];
}

async function persistMacroMetadata() {
  const meta = ensureMacroMeta();
  if (!api.setMacroMetadata) return;
  try {
    const res = await api.setMacroMetadata(meta);
    if (res && res.success === false) {
      showToast(`Failed to save macro metadata: ${res.error}`, 'error', 4000);
    }
  } catch (err) {
    showToast(`Failed to save macro metadata: ${err.message}`, 'error', 4000);
  }
}

function rememberMacroNames(slots) {
  if (!Array.isArray(slots)) return;
  ensureMacroMeta();
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s || typeof s.name !== 'string') continue;
    const id = Number.isInteger(s.id) ? s.id : i;
    state.localMacroNames[id] = s.name;
    slotMeta(id).name = MacroDraft.sanitizeName(s.name);
  }
}

function applyLocalMacroNames(slots) {
  if (!Array.isArray(slots)) return slots;
  ensureMacroMeta();
  return slots.map((s) => {
    const id = s.id;
    const local = state.localMacroNames[id];
    const stored = slotMeta(id).name;
    const name = local !== undefined ? local : (stored || s.name);
    return { ...s, name };
  });
}

function applyImportedMacroMetadata(data) {
  if (!data) return;
  if (data.macroMetadata) {
    const parsed = MacroDraft.parseStoredMetadata(data.macroMetadata);
    state.macroMeta = parsed.meta;
  }
  if (Array.isArray(data.macros)) rememberMacroNames(data.macros);
  persistMacroMetadata();
}

function requestStillCurrent(captured) {
  if (!captured) return false;
  if (captured.gen !== state.editGeneration) return false;
  if (typeof captured.resetEpoch === 'number' && captured.resetEpoch !== state.resetEpoch) return false;
  if (captured.profile !== undefined && captured.profile !== state.editingProfile) return false;
  if (captured.layer !== undefined && captured.layer !== state.activeLayer) return false;
  return true;
}

// Toast Notification
let toastTimer = null;
function showToast(message, type = 'info', duration = 3000) {
  if (!els.toast || !els.toastMsg) return;
  clearTimeout(toastTimer);

  if (els.toastIcon) {
    els.toastIcon.textContent = '';
    els.toastIcon.className = 'toast-icon';
  }
  els.toastMsg.textContent = message;
  els.toast.className = `toast-banner ${type}`;
  els.toast.hidden = false;

  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, duration);
}

// Tab Switching
function switchTab(tabId) {
  if (!els.panels[tabId]) return;
  state.activeTab = tabId;
  syncAdvancedBindingTester();

  els.tabs.forEach(tab => {
    const isActive = tab.dataset.tab === tabId;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });

  Object.entries(els.panels).forEach(([id, panel]) => {
    if (panel) panel.hidden = id !== tabId;
  });

  renderKeyboard();
  if (tabId === 'lighting') renderLightingControls();
  if (tabId === 'others') void refreshFirmwarePanel();
}

// Global Event Delegation for buttons
document.addEventListener('click', async event => {
  const btn = event.target.closest('[data-action]');
  if (!btn || btn.disabled) return;

  const action = btn.dataset.action;

  if (action === 'set-tab') {
    if (btn.dataset.tab !== 'macros' && state.isRecordingMacro) {
      haltMacroRecording('tab-change');
    }
    if (btn.dataset.tab !== 'keymap') haltKeyRecorder('tab-change');
    switchTab(btn.dataset.tab);
  } else if (action === 'set-locale') {
    await handleSetLocale(btn.dataset.locale);
  } else if (action === 'scan') {
    await scanHardware();
  } else if (action === 'refresh-status') {
    await refreshTelemetry();
  } else if (action === 'switch-profile') {
    const profile = parseInt(btn.dataset.profile, 10);
    await handleSwitchProfile(profile);
  } else if (action === 'load-edit-target') {
    await handleLoadEditTarget();
  } else if (action === 'activate-edit-profile') {
    await handleActivateEditProfile();
  } else if (action === 'enable-fourth-profile') {
    await handleEnableFourthProfile();
  } else if (action === 'create-local-profile') {
    openProfileNameDialog('create');
  } else if (action === 'import-official-profile') {
    await handleImportOfficialProfile();
  } else if (action === 'export-official-profile') {
    await handleExportOfficialProfile(btn.dataset.key, btn.dataset.kind, btn.dataset.profile);
  } else if (action === 'copy-onboard-local') {
    await handleCopyOnboardToLocal(parseInt(btn.dataset.profile, 10));
  } else if (action === 'rename-profile') {
    openProfileNameDialog('rename', btn.dataset.key, btn.dataset.kind, btn.dataset.profile, btn.dataset.name);
  } else if (action === 'delete-local-profile') {
    await handleDeleteLocalProfile(btn.dataset.key);
  } else if (action === 'delete-onboard-profile') {
    await handleDeleteOnboardProfile(btn.dataset.key);
  } else if (action === 'bind-profile-app') {
    await handleBindProfileApp(parseInt(btn.dataset.profile, 10));
  } else if (action === 'unbind-profile-app') {
    await handleUnbindProfileApp(parseInt(btn.dataset.profile, 10));
  } else if (action === 'app-bind-delete-cancel') {
    closeAppBindDeleteDialog(false);
  } else if (action === 'app-bind-delete-confirm') {
    closeAppBindDeleteDialog(true);
  } else if (action === 'move-local-onboard') {
    await handleMoveLocalToOnboard(btn.dataset.key, btn.dataset.target || null, btn.dataset.activate !== 'false');
  } else if (action === 'move-onboard-local') {
    await handleMoveOnboardToLocal(btn.dataset.key);
  } else if (action === 'load-local-preview') {
    await handleLoadLocalPreview(btn.dataset.key);
  } else if (action === 'profile-name-cancel') {
    closeProfileNameDialog();
  } else if (action === 'profile-name-confirm') {
    await confirmProfileNameDialog();
  } else if (action === 'read-advanced') {
    await handleReadAdvanced();
  } else if (action === 'apply-advanced') {
    await handleApplyAdvanced();
  } else if (action === 'remove-advanced') {
    await handleRemoveAdvanced();
  } else if (action === 'adv-type') {
    setAdvancedKind(btn.dataset.kind);
  } else if (action === 'clear-all-advanced') {
    openAdvancedClearDialog();
  } else if (action === 'advanced-clear-cancel') {
    closeAdvancedClearDialog();
  } else if (action === 'advanced-clear-confirm') {
    void confirmAdvancedClearDialog();
  } else if (action === 'apply-calibration') {
    await handleApplyCalibration();
  } else if (action === 'set-layer') {
    const layer = parseInt(btn.dataset.layer, 10);
    setKeyLayer(layer);
  } else if (action === 'read-layer') {
    await handleReadLayer();
  } else if (action === 'apply-keymap') {
    await handleApplyKeymap();
  } else if (action === 'reset-layer' || action === 'restore-defaults') {
    openKeymapResetDialog();
  } else if (action === 'keymap-reset-cancel') {
    closeKeymapResetDialog();
  } else if (action === 'keymap-reset-confirm') {
    void confirmKeymapResetDialog();
  } else if (action === 'copy-key') {
    handleCopyKey();
  } else if (action === 'cut-key') {
    void handleCutKey();
  } else if (action === 'paste-key') {
    void handlePasteKey();
  } else if (action === 'toggle-key-record') {
    toggleKeyRecorder();
  } else if (action === 'read-lighting') {
    await handleReadLighting();
  } else if (action === 'apply-lighting' || action === 'retry-lighting-save') {
    handleRetryLightingSave();
  } else if (action === 'read-key-colors') {
    await handleReadKeyColors();
  } else if (action === 'apply-key-colors') {
    await handleApplyKeyColors();
  } else if (action === 'set-selected-key-color') {
    handleSetSelectedKeyColor();
  } else if (action === 'fill-all-key-colors') {
    handleFillAllKeyColors();
  } else if (action === 'clear-all-key-colors') {
    handleClearAllKeyColors();
  } else if (action === 'set-direction') {
    setLightingDirection(parseInt(btn.dataset.dir, 10));
  } else if (action === 'set-light-memory-fallback') {
    await handleSetLightMemoryFallback(btn.dataset.fallback);
  } else if (action === 'set-light-scope') {
    setLightingScope(btn.dataset.scope);
  } else if (action === 'set-main-light-tab') {
    setMainLightTab(btn.dataset.tab);
  } else if (action === 'select-custom-lighting') {
    setMainLightTab('local');
  } else if (action === 'create-still') {
    openStillNameDialog('create');
  } else if (action === 'rename-still') {
    openStillNameDialog('rename', btn.dataset.key);
  } else if (action === 'delete-still') {
    void handleDeleteStill(btn.dataset.key);
  } else if (action === 'select-still') {
    void handleSelectStill(btn.dataset.key);
  } else if (action === 'still-name-cancel') {
    closeStillNameDialog();
  } else if (action === 'still-name-confirm') {
    void confirmStillNameDialog();
  } else if (action === 'import-gif') {
    document.getElementById('gif-file-input')?.click();
  } else if (action === 'select-gif') {
    void handleSelectGif(btn.dataset.key);
  } else if (action === 'rename-gif') {
    openGifNameDialog('rename', btn.dataset.key);
  } else if (action === 'edit-gif') {
    void openGifEditor(btn.dataset.key);
  } else if (action === 'delete-gif') {
    void handleDeleteGif(btn.dataset.key);
  } else if (action === 'gif-name-cancel') {
    closeGifNameDialog();
  } else if (action === 'gif-name-confirm') {
    void confirmGifNameDialog();
  } else if (action === 'toggle-gif-playback') {
    void handleGifPlayback(state.isStreaming ? 'pause' : 'play');
  } else if (action === 'stop-gif-playback') {
    void handleGifPlayback('stop');
  } else if (action === 'gif-prev-frame') {
    shiftGifEditorFrame(-1);
  } else if (action === 'gif-next-frame') {
    shiftGifEditorFrame(1);
  } else if (action === 'gif-add-frame') {
    addGifEditorFrame();
  } else if (action === 'gif-del-frame') {
    deleteGifEditorFrame();
  } else if (action === 'gif-preview-toggle') {
    toggleGifEditorPreview();
  } else if (action === 'gif-fill-all') {
    paintGifEditorAll(false);
  } else if (action === 'gif-clear-all') {
    paintGifEditorAll(true);
  } else if (action === 'gif-editor-cancel') {
    closeGifEditor();
  } else if (action === 'gif-editor-save') {
    void saveGifEditor();
  } else if (action === 'select-light-effect') {
    selectMainEffect(parseInt(btn.dataset.effect, 10));
  } else if (action === 'select-side-effect') {
    selectSideEffect(parseInt(btn.dataset.effect, 10));
  } else if (action === 'read-macros') {
    await handleReadMacros();
  } else if (action === 'apply-macros') {
    await handleApplyMacros();
  } else if (action === 'clear-macro-slot') {
    handleClearMacroSlot();
  } else if (action === 'add-macro-action') {
    handleAddMacroAction();
  } else if (action === 'remove-macro-action') {
    const idx = btn.dataset.index !== undefined
      ? parseInt(btn.dataset.index, 10)
      : state.macroSelectedActionIndex;
    handleRemoveMacroAction(idx);
  } else if (action === 'copy-macro-actions') {
    handleCopyMacroActions();
  } else if (action === 'paste-macro-actions') {
    handlePasteMacroActions();
  } else if (action === 'insert-macro-action') {
    handleInsertMacroAction();
  } else if (action === 'replace-macro-action') {
    handleReplaceMacroAction();
  } else if (action === 'move-macro-action-up') {
    handleMoveMacroAction(-1);
  } else if (action === 'move-macro-action-down') {
    handleMoveMacroAction(1);
  } else if (action === 'edit-macro-action-kind') {
    handleToggleMacroActionKind();
  } else if (action === 'assign-macro-to-key' || action === 'assign-macro-key') {
    handleAssignMacroToSelectedKey();
  } else if (action === 'toggle-macro-recording') {
    toggleMacroRecording();
  } else if (action === 'read-settings') {
    await handleReadSettings();
  } else if (action === 'apply-settings') {
    await handleRetrySettingsSave();
  } else if (action === 'retry-settings-save') {
    await handleRetrySettingsSave();
  } else if (action === 'set-os-mode') {
    setOsMode(btn.dataset.mode);
  } else if (action === 'export-profile') {
    await handleExportProfile();
  } else if (action === 'import-profile') {
    await handleImportProfile();
  } else if (action === 'apply-imported-profile') {
    await handleApplyImportedProfile();
  } else if (action === 'reset-active') {
    await openResetReview('active');
  } else if (action === 'reset-all') {
    await openResetReview('all');
  } else if (action === 'reset-dialog-cancel') {
    closeResetDialog();
  } else if (action === 'reset-dialog-confirm') {
    await confirmResetDialog();
  } else if (action === 'reset-dialog-export') {
    await exportFromResetDialog();
  } else if (action === 'firmware-choose-package') {
    await handleChooseFirmwarePackage();
  } else if (action === 'firmware-review') {
    await openFirmwareReview();
  } else if (action === 'firmware-dialog-cancel') {
    closeFirmwareDialog();
  } else if (action === 'firmware-dialog-confirm') {
    await confirmFirmwareDialog();
  }
});

// Color swatch presets
document.addEventListener('click', event => {
  const swatch = event.target.closest('.color-dot');
  if (!swatch || swatch.disabled || !swatch.dataset.color) return;
  const color = swatch.dataset.color;
  const colorInput = document.getElementById('light-color-input');
  const pickerOn = Boolean(
    colorInput
    && !colorInput.disabled
    && canEditLighting()
    && state.lightingScope !== 'side'
    && currentLightingCaps().color
    && !state.lighting.customColorDisabled
  );
  if (pickerOn) {
    const hexInput = document.getElementById('light-color-hex');
    colorInput.value = color;
    if (hexInput) hexInput.value = color;
    stageLightingEdit({ hexColor: color });
  }
  const customPanel = document.getElementById('custom-lighting-panel');
  if (customPanel && !customPanel.hidden && canEditKeyColors()) {
    const perKeyInput = document.getElementById('perkey-color-input');
    const perKeyHex = document.getElementById('perkey-color-hex');
    if (perKeyInput) perKeyInput.value = color;
    if (perKeyHex) perKeyHex.value = color;
  }
});

// Keyboard navigation shortcuts
document.addEventListener('keydown', event => {
  if (state.resetDialogOpen && event.key === 'Escape') {
    event.preventDefault();
    if (!state.resetCommitInFlight) closeResetDialog();
    return;
  }
  if (document.getElementById('app-bind-delete-dialog') && !document.getElementById('app-bind-delete-dialog').hidden && event.key === 'Escape') {
    event.preventDefault();
    closeAppBindDeleteDialog(false);
    return;
  }
  if (state.firmwareDialogOpen && event.key === 'Escape') {
    event.preventDefault();
    if (!state.firmwareCommitInFlight) closeFirmwareDialog();
    return;
  }
  if (state.advancedClearDialogOpen && event.key === 'Escape') {
    event.preventDefault();
    closeAdvancedClearDialog();
    return;
  }
  if (state.advancedDeleteConfirmId && event.key === 'Escape') {
    event.preventDefault();
    state.advancedDeleteConfirmId = '';
    renderAdvancedBindingList();
    return;
  }
  const stillDialog = document.getElementById('still-name-dialog');
  if (stillDialog && !stillDialog.hidden) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeStillNameDialog();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      void confirmStillNameDialog();
      return;
    }
  }
  const gifNameDialog = document.getElementById('gif-name-dialog');
  if (gifNameDialog && !gifNameDialog.hidden) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeGifNameDialog();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      void confirmGifNameDialog();
      return;
    }
  }
  const gifEditorDialog = document.getElementById('gif-editor-dialog');
  if (gifEditorDialog && !gifEditorDialog.hidden && event.key === 'Escape') {
    event.preventDefault();
    closeGifEditor();
    return;
  }
  if (state.resetDialogOpen && event.key === 'Tab') {
    trapResetDialogFocus(event);
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key >= '1' && event.key <= '7') {
    event.preventDefault();
    const tabOrder = ['dashboard', 'keymap', 'lighting', 'macros', 'settings', 'profiles', 'guide'];
    const idx = parseInt(event.key, 10) - 1;
    if (tabOrder[idx]) switchTab(tabOrder[idx]);
  }
});

/**
 * Scan for MCHOSE hardware
 */
async function scanHardware() {
  showToast('Scanning USB bus for MCHOSE hardware…', 'info', 2000);
  try {
    const res = await api.scan();
    if (res && res.state) {
      state.lightingHydrateLocked = false;
      updateFromDeviceState(res.state);
      if (res.state.connected) {
        showToast('Connected to MCHOSE G75 V2 via 2.4GHz receiver!', 'success');
      } else {
        showToast('No MCHOSE device connected. Operating in offline staging mode.', 'warning');
      }
    }
  } catch (err) {
    showToast(`Scan error: ${err.message}`, 'error');
  }
}

/**
 * Refresh read-only telemetry
 */
async function refreshTelemetry() {
  try {
    const newState = await api.queryStatus();
    if (newState) {
      state.lightingHydrateLocked = false;
      updateFromDeviceState(newState);
      showToast('Telemetry refreshed from hardware.', 'success');
    }
  } catch (err) {
    showToast(`Failed to refresh telemetry: ${err.message}`, 'error');
  }
}

/**
 * Update UI state from backend device state
 */
function supersedeEditorGeneration() {
  state.editGeneration += 1;
  state.loadInFlight = false;
}

function applyResetInvalidation(reason) {
  if (state.isRecordingMacro) haltMacroRecording(reason || 'reset');
  haltKeyRecorder(reason || 'reset');
  supersedeEditorGeneration();
  state.stagedMacros = [];
  state.importedProfileData = null;
  const preview = document.getElementById('imported-profile-preview');
  if (preview) preview.hidden = true;
  invalidateEditorSnapshots();
  if (state.resetDialogOpen && !state.resetCommitInFlight) closeResetDialog();
  updateApplyButtonsState();
}

function updateFromDeviceState(devState) {
  const wasConnected = state.connected;
  state.connected = Boolean(devState.connected);
  if (wasConnected && !state.connected) {
    if (state.isRecordingMacro) haltMacroRecording('disconnect');
    haltKeyRecorder('disconnect');
    supersedeEditorGeneration();
    invalidateEditorSnapshots();
    updateApplyButtonsState();
  }
  let skipHydrate = false;
  if (typeof devState.resetEpoch === 'number' && devState.resetEpoch !== state.resetEpoch) {
    const prevEpoch = state.resetEpoch;
    state.resetEpoch = devState.resetEpoch;
    if (prevEpoch !== 0) {
      applyResetInvalidation('reset-epoch');
      skipHydrate = true;
    }
  }
  const wasUncertain = state.configUncertain;
  state.configUncertain = Boolean(devState.configUncertain);
  if (state.configUncertain && !wasUncertain) {
    applyResetInvalidation('reset-uncertain');
    skipHydrate = true;
  }
  if (skipHydrate && devState.lastResetOutcome && devState.lastResetOutcome.unsolicited) {
    const key = `${state.resetEpoch}:${devState.lastResetOutcome.notificationKind || 'unsolicited'}`;
    if (state.lastUnsolicitedResetKey !== key) {
      state.lastUnsolicitedResetKey = key;
      showToast('The keyboard reported a factory reset. Local drafts were discarded. Read the keyboard before editing.', 'warning', 6000);
    }
  }
  if (Array.isArray(devState.appBinds)) state.appBinds = devState.appBinds;
  state.device = devState.device;
  state.info = devState.info;
  state.battery = devState.battery || { batteryLevel: null, isCharging: false };
  state.base = devState.base || state.base;
  if (devState.activeProfileIndex !== undefined) {
    state.activeProfile = devState.activeProfileIndex;
  }

  state.needsReconnect = Boolean(devState.needsReconnect);
  state.statusError = devState.statusError || null;
  state.readSuccess = devState.readSuccess !== false;

  if (!skipHydrate && !state.didInitLayerFromMacMode && devState.settings && typeof devState.settings.macMode === 'number') {
    const osBits = devState.settings.macMode & 3;
    state.activeLayer = osBits === 2 ? 2 : 0;
    state.didInitLayerFromMacMode = true;
    document.querySelectorAll('[data-action="set-layer"]').forEach((b) => {
      b.classList.toggle('active', parseInt(b.dataset.layer, 10) === state.activeLayer);
    });
  }

  if (
    !skipHydrate
    && state.connected
    && !state.lightingHydrateLocked
    && devState.lighting
    && !state.loadInFlight
    && !state.lightingOpInFlight
    && !state.lightingDraftDirty
    && state.editingProfile === state.activeProfile
  ) {
    state.lighting = { ...state.lighting, ...devState.lighting };
    state.hasReadLighting = true;
  }
  if (!state.connected) {
    state.hasReadSettings = false;
  } else if (!skipHydrate && devState.readSuccess !== false && devState.settings && !state.loadInFlight && !state.settingsDraftDirty && !PerformanceAutosave.hasDirty(state.settingsEdited) && !state.settingsReadInFlight && settingsSaveGate.pending === 0 && state.editingProfile === state.activeProfile) {
    state.settings = { ...state.settings, ...devState.settings };
    state.hasReadSettings = true;
  }
  updateApplyButtonsState();
  renderEditTargetBar();
  renderSettingsControls();
  if (!wasConnected && state.connected) {
    void refreshLightingMemoryPref();
    void refreshStillLibrary();
    void refreshGifLibrary();
  } else {
    renderLightingMemoryPref();
  }
  if (devState.stillLibrary) {
    const opts = {};
    if (
      !state.loadInFlight
      && !state.lightingHydrateLocked
      && state.hasReadLighting
      && Array.isArray(devState.selectedLightEffect)
    ) {
      opts.confirmedPair = devState.selectedLightEffect;
    }
    adoptStillLibrary(devState.stillLibrary, opts);
  }
  if (devState.gifLibrary) {
    const opts = {};
    if (
      !state.loadInFlight
      && !state.lightingHydrateLocked
      && state.hasReadLighting
      && Array.isArray(devState.selectedLightEffect)
    ) {
      opts.confirmedPair = devState.selectedLightEffect;
    }
    adoptGifLibrary(devState.gifLibrary, opts);
  }
  if (typeof devState.isStreaming === 'boolean') {
    state.isStreaming = devState.isStreaming;
  }
  if (devState.profileLibrary) {
    state.profileLibrary = devState.profileLibrary;
  }
  if (Array.isArray(devState.profileNames)) {
    state.profileNames = devState.profileNames;
  }
  if (devState.editSource && !isLocalPreview()) {
    state.editSource = devState.editSource;
  }

  renderProfileLibrary();

  // Update top titlebar pill
  if (els.connectionPill && els.deviceStatusText) {
    const fullId = state.device
      ? `${state.device.product} (${state.device.hexVendorId}:${state.device.hexProductId})`
      : 'MCHOSE G75 V2';
    els.connectionPill.title = fullId;
    if (state.needsReconnect) {
      els.connectionPill.className = 'connection-pill reconnecting';
      els.deviceStatusText.textContent = t('status.timeout');
    } else if (state.connected && state.device) {
      els.connectionPill.className = 'connection-pill connected';
      els.deviceStatusText.textContent = state.device.isReceiver ? t('status.receiver') : t('status.usb');
    } else {
      els.connectionPill.className = 'connection-pill disconnected';
      els.deviceStatusText.textContent = t('status.offline');
    }
  }

  // Update top battery stat
  if (els.batteryStatText) {
    if (state.connected && state.battery.batteryLevel !== null) {
      const chg = state.battery.isCharging ? ' charging' : '';
      els.batteryStatText.textContent = `${state.battery.batteryLevel}%${chg}`;
    } else {
      els.batteryStatText.textContent = '--%';
    }
  }

  // Update top profile stat
  if (els.profileStatText) {
    els.profileStatText.textContent = t('sidebar.hwEdit', { hw: state.activeProfile + 1, edit: state.editingProfile + 1 });
  }

  // Update Dashboard Tab
  renderDashboard();

  // Sync Lighting Controls
  renderLightingControls();

  // Sync Settings Controls
  renderSettingsControls();

  // Refresh keyboard display
  renderKeyboard();
}

/**
 * Render Dashboard tab
 */
function renderDashboard() {
  const dashProduct = document.getElementById('dash-product');
  const dashTransport = document.getElementById('dash-transport');
  const dashVidPid = document.getElementById('dash-vidpid');
  const dashDongle = document.getElementById('dash-dongle');
  const dashFw = document.getElementById('dash-fw');
  const dashRfFw = document.getElementById('dash-rffw');
  const batteryBar = document.getElementById('battery-bar');
  const batteryLargeText = document.getElementById('battery-large-text');
  const chargingBadge = document.getElementById('charging-badge');

  const productName = state.device?.product || 'MCHOSE G75 V2';
  if (dashProduct) {
    dashProduct.textContent = productName;
  }
  const sidebarName = document.getElementById('sidebar-device-name');
  if (sidebarName) {
    sidebarName.textContent = 'G75 V2';
    sidebarName.title = productName;
  }
  if (dashTransport) {
    if (state.needsReconnect) {
      dashTransport.textContent = 'Connection Timeout (Click Scan to Reconnect)';
    } else {
      dashTransport.textContent = state.connected
        ? (state.device?.isReceiver ? '2.4GHz Wireless Receiver' : 'USB-C Cable')
        : t('status.notConnected');
    }
  }
  if (dashVidPid) {
    dashVidPid.textContent = state.device ? `${state.device.hexVendorId} : ${state.device.hexProductId}` : '-- : --';
  }
  if (dashDongle) {
    dashDongle.textContent = state.info?.dongleInfo || (state.connected ? 'Querying…' : 'Disconnected');
  }
  const dashBuildDate = document.getElementById('dash-builddate');
  if (dashBuildDate) {
    dashBuildDate.textContent = state.info?.buildDate || '--';
  }
  if (dashFw) {
    dashFw.textContent = state.info?.firmwareVersion || '--';
  }
  if (dashRfFw) {
    dashRfFw.textContent = state.info?.rfFirmwareVersion || '--';
  }

  // Battery gauge: only display real values if telemetry has been read (Item 6)
  const batLevel = state.battery.batteryLevel !== null ? state.battery.batteryLevel : 0;
  if (batteryBar) {
    batteryBar.style.width = state.battery.batteryLevel !== null ? `${batLevel}%` : '0%';
    batteryBar.style.backgroundColor = batLevel <= 20 ? 'var(--accent-red)' : (batLevel <= 40 ? 'var(--accent-amber)' : 'var(--accent-green)');
  }
  if (batteryLargeText) {
    batteryLargeText.textContent = state.battery.batteryLevel !== null ? `${state.battery.batteryLevel}%` : '--%';
  }
  if (chargingBadge) {
    chargingBadge.textContent = state.battery.batteryLevel !== null
      ? (state.battery.isCharging ? 'Charging ⚡' : 'Discharging')
      : 'No Telemetry';
    chargingBadge.className = state.battery.isCharging ? 'badge badge-success' : 'badge badge-subtle';
  }

  renderProfileLibrary();
}

function isLocalPreview() {
  return Boolean(state.editSource && state.editSource.kind === 'local');
}

function localizeProfileName(value, index) {
  const text = String(value == null ? '' : value);
  const localized = text.replace(/i18n<([^>]+)>/g, (full, key) => (
    key === 'defaultOnboard' ? 'Default Onboard' : full
  ));
  if (localized.trim()) return localized;
  if (Number.isInteger(index) && index >= 0) {
    return index === 0 ? 'Default Onboard' : `Default Onboard${index + 1}`;
  }
  return localized;
}

function onboardName(index) {
  const names = state.profileNames || [];
  return localizeProfileName(names[index], index) || `Profile ${index + 1}`;
}

function setProfileBusy(busy, message) {
  state.profileBusy = Boolean(busy);
  const progress = document.getElementById('profile-library-progress');
  const text = document.getElementById('profile-library-progress-text');
  const status = document.getElementById('profile-library-status');
  if (progress) progress.hidden = !busy;
  if (text && message) text.textContent = message;
  if (status && !busy && message) status.textContent = '';
}

function renderProfileLibrary() {
  const onboardRoot = document.getElementById('onboard-profile-list');
  const localRoot = document.getElementById('local-profile-list');
  const cap = document.getElementById('profile-library-capacity');
  const freeSlot = document.getElementById('profile-free-slot');
  const lib = state.profileLibrary || {};
  const count = (state.base && state.base.profileCount) || 0;
  const remaining = lib.remaining != null ? lib.remaining : Math.max(0, 20 - count - ((lib.local && lib.local.length) || 0));
  if (cap) cap.textContent = `${count + ((lib.local && lib.local.length) || 0)}/20 · ${remaining} left`;
  const names = state.profileNames || [];
  const sel = document.getElementById('edit-profile-select');
  if (sel) {
    for (let i = 0; i < 4; i++) {
      const opt = sel.options[i];
      if (opt) opt.textContent = localizeProfileName(names[i], i) || `Profile ${i + 1}`;
    }
  }
  if (onboardRoot) {
    onboardRoot.replaceChildren();
    for (let i = 0; i < 4; i++) {
      const enabled = i < count;
      const isActive = i === state.activeProfile;
      const bind = (state.appBinds || []).find((row) => row.profileIndex === i) || null;
      const card = document.createElement('div');
      card.className = 'profile-card' + (isActive ? ' active' : '') + (!enabled ? ' disabled' : '');
      card.dataset.profile = String(i);
      card.dataset.key = `KeyboardProfile@keyboard@${i}`;
      card.dataset.drop = 'onboard';
      const title = enabled ? onboardName(i) : `${onboardName(i)} (Not enabled)`;
      card.innerHTML = `
        <div class="profile-card-top">
          <span class="profile-num">${String(i + 1).padStart(2, '0')}</span>
          <span class="profile-tag"${isActive ? '' : ' hidden'}>Active</span>
        </div>
        <div class="profile-title">${escapeHtml(title)}</div>
        <p class="profile-desc">${enabled ? (bind
          ? escapeHtml(t('profile.linkedTo', { name: bind.displayName || bind.bundleId }))
          : t('profile.onboardDesc'))
          : t('profile.notEnabledDesc')}</p>
        <div class="profile-card-actions">
          <button class="action-btn select-profile-btn" data-action="switch-profile" data-profile="${i}" ${!enabled || isActive ? 'disabled' : ''}>${isActive ? t('profile.active') : (enabled ? t('profile.activate') : t('profile.notEnabled'))}</button>
          ${enabled ? `<button class="action-btn" data-action="copy-onboard-local" data-profile="${i}">${t('profile.copy')}</button>
          <button class="action-btn" data-action="rename-profile" data-kind="keyboard" data-key="KeyboardProfile@keyboard@${i}" data-profile="${i}" data-name="${escapeAttr(onboardName(i))}">${t('profile.rename')}</button>
          <button class="action-btn" data-action="export-official-profile" data-kind="keyboard" data-profile="${i}">${t('profile.export')}</button>
          ${bind
            ? `<button class="action-btn" data-action="unbind-profile-app" data-profile="${i}">${t('profile.unlinkApp')}</button>`
            : `<button class="action-btn" data-action="bind-profile-app" data-profile="${i}">${t('profile.linkApp')}</button>`}` : ''}
          ${enabled && count > 1 ? `<button class="action-btn" data-action="move-onboard-local" data-key="KeyboardProfile@keyboard@${i}">${t('profile.moveCustom')}</button>
          <button class="action-btn" data-action="delete-onboard-profile" data-key="KeyboardProfile@keyboard@${i}">${t('profile.delete')}</button>` : ''}
          ${!enabled ? `<button class="action-btn" data-action="enable-fourth-profile">${t('profile.enable4')}</button>` : ''}
        </div>`;
      attachOnboardDrop(card, `KeyboardProfile@keyboard@${i}`, enabled);
      onboardRoot.appendChild(card);
    }
  }
  if (freeSlot) {
    freeSlot.hidden = count >= 4;
    attachOnboardDrop(freeSlot, null, true);
  }
  if (localRoot) {
    localRoot.replaceChildren();
    const items = (lib.local || lib.items || []).filter((item) => item && item.type === 'localstorage' || item && item.key);
    const localItems = (lib.local && lib.local.length) ? lib.local : (lib.items || []);
    for (const item of localItems) {
      const card = document.createElement('div');
      const preview = isLocalPreview() && state.editSource.key === item.key;
      card.className = 'profile-card' + (preview ? ' preview' : '');
      card.draggable = true;
      card.dataset.key = item.key;
      card.innerHTML = `
        <div class="profile-card-top">
          <span class="profile-num">Local</span>
          <span class="profile-tag"${preview ? '' : ' hidden'}>Preview</span>
        </div>
        <div class="profile-title">${escapeHtml(localizeProfileName(item.name))}</div>
        <p class="profile-desc">${t('profile.localDesc')}</p>
        <div class="profile-card-actions">
          <button class="action-btn" data-action="load-local-preview" data-key="${escapeAttr(item.key)}">${t('profile.loadPreview')}</button>
          <button class="action-btn" data-action="move-local-onboard" data-key="${escapeAttr(item.key)}" data-activate="true">${t('profile.moveOnboard')}</button>
          <button class="action-btn" data-action="rename-profile" data-kind="local" data-key="${escapeAttr(item.key)}" data-name="${escapeAttr(localizeProfileName(item.name))}">${t('profile.rename')}</button>
          <button class="action-btn" data-action="export-official-profile" data-kind="local" data-key="${escapeAttr(item.key)}">${t('profile.export')}</button>
          <button class="action-btn" data-action="delete-local-profile" data-key="${escapeAttr(item.key)}">${t('profile.delete')}</button>
        </div>`;
      card.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('text/maicong-profile', item.key);
        ev.dataTransfer.effectAllowed = 'move';
      });
      localRoot.appendChild(card);
    }
  }
  const status = document.getElementById('profile-library-status');
  if (status) {
    status.textContent = lib.error || (isLocalPreview() ? 'Previewing a custom profile. Keyboard hardware is not being written.' : '');
    status.hidden = !status.textContent;
  }
  const enableBtn = document.getElementById('btn-enable-fourth');
  if (enableBtn) enableBtn.disabled = count >= 4;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function attachOnboardDrop(el, targetKey, enabled) {
  if (!el) return;
  el.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    el.classList.remove('drag-over');
    const sourceKey = ev.dataTransfer.getData('text/maicong-profile');
    if (!sourceKey) return;
    await handleMoveLocalToOnboard(sourceKey, enabled ? targetKey : null, true);
  });
}

/**
 * Handle Onboard Profile Switch
 */
async function handleSwitchProfile(profileIndex) {
  if (isLocalPreview()) {
    state.editSource = { kind: 'onboard', profileIndex };
    await api.setEditSource({ kind: 'onboard', profileIndex });
  }
  showToast(`Switching keyboard to Profile ${profileIndex + 1}…`, 'info');
  try {
    const res = await api.switchProfile(profileIndex);
    if (res.success) {
      state.activeProfile = profileIndex;
      showToast(`Active profile set to Profile ${profileIndex + 1}`, 'success');
      renderDashboard();
    } else {
      showToast(`Failed to switch profile: ${res.error}`, 'error');
    }
  } catch (err) {
    showToast(`Error switching profile: ${err.message}`, 'error');
  }
}

function openProfileNameDialog(mode, key, kind, profile, currentName) {
  state.profileNameDialogMode = mode;
  state.profileNameDialogKey = key || null;
  state.profileNameDialogKind = kind || 'local';
  state.profileNameDialogProfile = profile;
  const dialog = document.getElementById('profile-name-dialog');
  const title = document.getElementById('profile-name-title');
  const input = document.getElementById('profile-name-input');
  const err = document.getElementById('profile-name-error');
  if (title) title.textContent = mode === 'rename' ? 'Rename' : 'Create configuration';
  if (input) input.value = currentName || (mode === 'create' ? 'New configuration 1' : '');
  if (err) err.hidden = true;
  if (dialog) dialog.hidden = false;
  if (input) input.focus();
}

function closeProfileNameDialog() {
  const dialog = document.getElementById('profile-name-dialog');
  if (dialog) dialog.hidden = true;
  state.profileNameDialogMode = null;
}

async function confirmProfileNameDialog() {
  const input = document.getElementById('profile-name-input');
  const err = document.getElementById('profile-name-error');
  const name = (input && input.value) || '';
  try {
    if (state.profileNameDialogMode === 'rename') {
      const res = await api.renameProfile({
        key: state.profileNameDialogKey,
        kind: state.profileNameDialogKind,
        profileIndex: state.profileNameDialogProfile != null ? parseInt(state.profileNameDialogProfile, 10) : undefined,
        name
      });
      if (!res.success) {
        if (err) { err.hidden = false; err.textContent = res.error; }
        return;
      }
      if (res.profileLibrary) state.profileLibrary = res.profileLibrary;
      showToast('Configuration renamed', 'success');
    } else {
      const res = await api.createLocalProfile(name);
      if (!res.success) {
        if (err) { err.hidden = false; err.textContent = res.error; }
        return;
      }
      if (res.profileLibrary) state.profileLibrary = res.profileLibrary;
      showToast('Custom configuration created', 'success');
    }
    closeProfileNameDialog();
    renderProfileLibrary();
  } catch (e) {
    if (err) { err.hidden = false; err.textContent = e.message; }
  }
}

async function flushLightingThen(label) {
  if (
    !state.hasReadLighting
    && !state.lightingSaveWorkerBusy
    && !state.lightingDraftDirty
    && !state.lightingOpInFlight
  ) {
    return true;
  }
  const captured = {
    gen: state.editGeneration,
    resetEpoch: state.resetEpoch,
    profile: state.editingProfile
  };
  if (typeof waitForLightingWorkerQuiet === 'function') {
    const quiet = await waitForLightingWorkerQuiet(captured);
    if (!quiet) {
      showToast('Still saving lighting. Profile change did not start.', 'warning');
      return false;
    }
  }
  if (typeof waitForKeymapWorkerQuiet === 'function') {
    const keymapQuiet = await waitForKeymapWorkerQuiet(captured);
    if (!keymapQuiet) {
      showToast('Still saving key bindings. Profile change did not start.', 'warning');
      return false;
    }
  }
  if (typeof waitForSettingsWorkerQuiet === 'function') {
    const settingsQuiet = await waitForSettingsWorkerQuiet(captured);
    if (!settingsQuiet) {
      showToast('Still saving performance settings. Profile change did not start.', 'warning');
      return false;
    }
  }
  if (state.settingsSaveStatus === 'error' || state.settingsDraftDirty || PerformanceAutosave.hasDirty(state.settingsEdited)) {
    showToast(state.settingsSaveError || 'Unsaved performance settings could not be saved. Profile change did not start.', 'error');
    return false;
  }
  return true;
}

async function handleCopyOnboardToLocal(profileIndex) {
  showToast('Copying onboard configuration to custom…', 'info');
  const res = await api.copyOnboardToLocal({ profileIndex });
  if (!res.success) {
    showToast(res.error || 'Copy failed', 'error');
    return;
  }
  if (res.profileLibrary) state.profileLibrary = res.profileLibrary;
  renderProfileLibrary();
  showToast('Copied to custom profiles. Keyboard was not changed.', 'success');
}

async function handleDeleteLocalProfile(key) {
  const res = await api.deleteLocalProfile(key);
  if (!res.success) {
    showToast(res.error || 'Delete failed', 'error');
    return;
  }
  if (isLocalPreview() && state.editSource.key === key) {
    state.editSource = { kind: 'onboard', profileIndex: state.activeProfile };
  }
  if (res.profileLibrary) state.profileLibrary = res.profileLibrary;
  renderProfileLibrary();
  showToast('Custom configuration deleted', 'success');
}

function appBindForProfile(profileIndex) {
  return (state.appBinds || []).find((row) => row.profileIndex === profileIndex) || null;
}

function closeAppBindDeleteDialog(confirmed) {
  const dialog = document.getElementById('app-bind-delete-dialog');
  if (dialog) dialog.hidden = true;
  const waiter = state.appBindDeleteWaiter;
  state.appBindDeleteWaiter = null;
  if (waiter) waiter(Boolean(confirmed));
}

function openAppBindDeleteDialog(bind) {
  const dialog = document.getElementById('app-bind-delete-dialog');
  const body = document.getElementById('app-bind-delete-body');
  if (body) {
    body.textContent = 'This onboard profile is linked to a game/app. Deleting it will also remove the link. Delete?';
  }
  if (dialog) dialog.hidden = false;
  const confirmBtn = document.getElementById('btn-app-bind-delete-confirm');
  if (confirmBtn) confirmBtn.focus();
  return new Promise((resolve) => {
    state.appBindDeleteWaiter = resolve;
  });
}

async function handleBindProfileApp(profileIndex) {
  if (!Number.isInteger(profileIndex)) return;
  const res = await api.bindProfileApp({ profileIndex });
  if (res && res.canceled) return;
  if (!res || !res.success) {
    showToast(res && res.error ? res.error : 'Could not link that app', 'error');
    return;
  }
  state.appBinds = res.binds || [];
  renderProfileLibrary();
  showToast(`Linked ${res.bind && res.bind.displayName ? res.bind.displayName : 'app'} to this onboard profile.`, 'success');
}

async function handleUnbindProfileApp(profileIndex) {
  const res = await api.unbindProfileApp(profileIndex);
  if (!res || !res.success) {
    showToast(res && res.error ? res.error : 'Could not unlink', 'error');
    return;
  }
  state.appBinds = res.binds || [];
  renderProfileLibrary();
  if (res.changed) showToast('This onboard profile has been unlinked from the game/app.', 'info');
}

async function handleDeleteOnboardProfile(key) {
  const idx = Number(String(key || '').split('@').pop());
  const bind = appBindForProfile(idx);
  if (bind) {
    const ok = await openAppBindDeleteDialog(bind);
    if (!ok) return;
  }
  if (!(await flushLightingThen())) return;
  setProfileBusy(true, 'Updating onboard profiles…');
  try {
    const res = await api.deleteOnboardProfile(key);
    if (!res.success) {
      showToast(res.error || 'Delete failed', 'error');
      return;
    }
    if (res.profileLibrary) state.profileLibrary = res.profileLibrary;
    if (Array.isArray(res.binds)) state.appBinds = res.binds;
    else if (res.autoUnbound) state.appBinds = (state.appBinds || []).filter((row) => row.profileIndex !== idx);
    renderProfileLibrary();
    showToast(res.hardwareRollback === false && res.error ? res.error : 'Onboard profile removed', res.success ? 'success' : 'error');
  } finally {
    setProfileBusy(false);
  }
}

async function handleMoveLocalToOnboard(sourceKey, targetKey, activate) {
  if (!(await flushLightingThen())) return;
  setProfileBusy(true, 'Writing configuration to onboard, please wait…');
  try {
    const res = await api.moveLocalToOnboard({ sourceKey, targetKey: targetKey || null, activate });
    if (!res.success) {
      showToast(res.error || 'Could not write onboard', 'error');
      return;
    }
    if (res.profileLibrary) state.profileLibrary = res.profileLibrary;
    state.editSource = { kind: 'onboard', profileIndex: state.activeProfile };
    renderProfileLibrary();
    showToast('Custom profile written to onboard', 'success');
  } finally {
    setProfileBusy(false);
  }
}

async function handleMoveOnboardToLocal(sourceKey) {
  if (!(await flushLightingThen())) return;
  setProfileBusy(true, 'Moving onboard configuration to custom…');
  try {
    const res = await api.moveOnboardToLocal({ sourceKey });
    if (!res.success) {
      showToast(res.error || 'Move failed', 'error');
      return;
    }
    if (res.profileLibrary) state.profileLibrary = res.profileLibrary;
    if (res.autoUnbound) {
      const idx = Number(String(sourceKey || '').split('@').pop());
      state.appBinds = (state.appBinds || []).filter((row) => row.profileIndex !== idx);
      showToast('This onboard profile has been unlinked from the game/app.', 'info');
    }
    renderProfileLibrary();
    showToast('Moved to custom profiles', 'success');
  } finally {
    setProfileBusy(false);
  }
}

function hydrateFromSnapshot(data) {
  if (!data) return;
  if (isLocalPreview()) state.advancedRead = null;
  if (data.lighting) {
    state.lighting = { ...state.lighting, ...data.lighting };
    state.hasReadLighting = true;
    state.lightingDraftDirty = false;
    state.lightingEdited = {};
  }
  if (data.settings) {
    state.settings = { ...state.settings, ...data.settings };
    state.hasReadSettings = true;
    state.settingsDraftDirty = false;
    state.settingsEdited = {};
    state.settingsSaveStatus = 'idle';
    state.settingsSaveError = null;
    state.settingsSaveBlocked = false;
    state.settingsFieldErrors = {};
    state.sleepSliderDraft = null;
    PerformanceAutosave.clearFieldRevs(state.settingsFieldRevs, state.settingsPersistedRevs);
  }
  if (data.layers || data.keymaps) {
    const layers = data.layers || data.keymaps;
    for (let l = 0; l < 4; l++) {
      const layer = Array.isArray(layers) ? layers[l] : layers[String(l)];
      if (layer) {
        const isolated = {};
        for (const raw of Object.keys(layer)) {
          const tuple = layer[raw];
          isolated[raw] = Array.isArray(tuple)
            ? tuple.slice()
            : (tuple && typeof tuple === 'object' ? { ...tuple } : tuple);
        }
        state.layerKeymaps[l] = isolated;
        state.hasReadKeymap[l] = true;
      }
    }
    KeyConfig.clearSlotRevs(state.keymapSlotRevs, state.keymapSlotPersisted);
    state.keymapDirty = false;
    state.keymapSaveStatus = 'idle';
    state.keymapSaveError = null;
  }
  if (isLocalPreview()) {
    state.localPreviewData = data;
  }
  if (data.customParam && Array.isArray(data.customParam.cbKeyIndexList)) {
    adoptCbKeyIndexList(data.customParam.cbKeyIndexList);
  }
  if (data.advanced && typeof data.advanced === 'object') {
    state.advancedRead = {
      success: true,
      raw: advancedSectionFromRaw(data.advanced)
    };
  }
  if (data.perKeyRgb) {
    state.stagedKeyColors = { ...data.perKeyRgb };
    state.hasReadKeyColors = true;
  }
  if (Array.isArray(data.macros)) {
    state.stagedMacros = data.macros;
    state.hasReadMacros = true;
  }
  if (Array.isArray(data.selectedLightEffect)) state.selectedLightEffect = data.selectedLightEffect.slice();
  renderLightingControls();
  renderSettingsControls();
  renderKeyboard();
  renderMacros();
  renderAdvancedPanel();
  updateApplyButtonsState();
}

function advancedSectionFromRaw(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of ['mt', 'tgl', 'keyExtras']) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}

function customParamRawFromAdvanced(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  return raw.customParam !== undefined ? raw.customParam : undefined;
}

function snapshotFromEditor(slotRevs, layer, settingsOwnedRevs, advancedOverrides) {
  const prevLayers = (state.localPreviewData && state.localPreviewData.layers) || {};
  const layers = slotRevs
    ? KeyConfig.layersForLocalPersist(
      state.layerKeymaps,
      prevLayers,
      state.keymapSlotRevs,
      state.keymapSlotPersisted,
      slotRevs,
      layer
    )
    : {
      0: state.layerKeymaps[0] || {},
      1: state.layerKeymaps[1] || {},
      2: state.layerKeymaps[2] || {},
      3: state.layerKeymaps[3] || {}
    };
  const prevSettings = (state.localPreviewData && state.localPreviewData.settings) || {};
  const advancedRaw = Object.assign(
    {},
    (state.localPreviewData && state.localPreviewData.advanced) || {},
    (state.advancedRead && state.advancedRead.raw) || {},
    advancedOverrides && advancedOverrides.advanced && typeof advancedOverrides.advanced === 'object'
      ? advancedOverrides.advanced
      : {}
  );
  const customParam = Object.assign(
    {},
    (state.localPreviewData && state.localPreviewData.customParam) || {},
    advancedOverrides && advancedOverrides.customParam && typeof advancedOverrides.customParam === 'object'
      ? advancedOverrides.customParam
      : {},
    { cbKeyIndexList: KeyConfig.copyCbKeyIndexList(state.cbKeyIndexList) }
  );
  const customRaw = customParam.raw !== undefined
    ? customParam.raw
    : (advancedOverrides && advancedOverrides.customParamRaw !== undefined
      ? advancedOverrides.customParamRaw
      : customParamRawFromAdvanced(advancedRaw));
  if (customRaw !== undefined) customParam.raw = customRaw;
  const editor = {
    app: 'Maicong Studio',
    model: 'MCHOSE G75 V2',
    protocol: 'GLW',
    version: '2.0.0',
    lighting: { ...state.lighting },
    settings: PerformanceAutosave.settingsForLocalPersist(
      state.settings,
      prevSettings,
      state.settingsFieldRevs,
      state.settingsPersistedRevs,
      settingsOwnedRevs
    ),
    layers,
    perKeyRgb: { ...state.stagedKeyColors },
    macros: Array.isArray(state.stagedMacros) ? state.stagedMacros : [],
    selectedLightEffect: Array.isArray(state.selectedLightEffect) ? state.selectedLightEffect.slice() : ['still', ''],
    macroMetadata: state.macroMeta || undefined,
    customParam,
    advanced: advancedSectionFromRaw(advancedRaw)
  };
  return KeyConfig.mergeLocalSnapshot(state.localPreviewData, editor);
}

async function persistLocalDraft(slotRevs, layer, settingsOwnedRevs, advancedOverrides) {
  if (!isLocalPreview()) return { success: true, hardwareWrites: 0 };
  const data = snapshotFromEditor(slotRevs, layer, settingsOwnedRevs, advancedOverrides);
  const snapshotRevs = slotRevs
    ? (layer == null || Object.keys(slotRevs).some((key) => String(key).includes(':'))
      ? KeyConfig.ownedSnapshotRevKeys(state.keymapSlotRevs, slotRevs)
      : KeyConfig.ownedSnapshotRevs(state.keymapSlotRevs, slotRevs, layer))
    : Object.assign({}, state.keymapSlotRevs);
  if (state.harness && window.__maicongHarness && window.__maicongHarness.failNextLocalDraft) {
    window.__maicongHarness.failNextLocalDraft = false;
    return {
      success: false,
      hardwareWrites: 0,
      error: 'Harness-injected local profile save failure',
      snapshotRevs
    };
  }
  const res = await api.saveLocalProfileDraft({ key: state.editSource.key, data });
  if (res.profileLibrary) state.profileLibrary = res.profileLibrary;
  if (res.success && res.item && res.item.data) state.localPreviewData = res.item.data;
  return Object.assign({}, res, { snapshotRevs });
}

async function handleLoadLocalPreview(key) {
  if (!(await prepareProfileSwitch())) return { success: false, blocked: true };
  haltMacroRecording('edit-target');
  haltKeyRecorder('edit-target');
  abortLightingScheduler();
  abortSettingsScheduler();
  const captured = { gen: state.editGeneration, resetEpoch: state.resetEpoch, profile: state.editingProfile };
  const res = await api.loadLocalProfilePreview(key);
  if (!loadRequestCurrent(captured)) return;
  if (!res.success) {
    showToast(res.error || 'Could not load custom profile', 'error');
    return;
  }
  state.editSource = { kind: 'local', key };
  state.editGeneration += 1;
  hydrateFromSnapshot(res.item && res.item.data);
  renderProfileLibrary();
  showToast('Previewing custom profile. The keyboard was not written.', 'success');
}

async function handleImportOfficialProfile() {
  const res = await api.importOfficialProfile();
  if (res.canceled) return;
  if (!res.success) {
    showToast(res.error || 'Import failed', 'error');
    return;
  }
  if (res.profileLibrary) state.profileLibrary = res.profileLibrary;
  renderProfileLibrary();
  showToast('Imported as a custom profile. Keyboard was not written.', 'success');
}

async function handleExportOfficialProfile(key, kind, profile) {
  const spec = {};
  if (kind === 'local' && key) spec.key = key;
  if (kind === 'keyboard' && profile != null) spec.profileIndex = parseInt(profile, 10);
  const res = await api.exportOfficialProfile(spec);
  if (res.canceled) return;
  if (!res.success) {
    showToast(res.error || 'Export failed', 'error');
    return;
  }
  showToast('Official profile JSON exported', 'success');
}

/**
 * Render Interactive Keyboard Layout
 * Uses exact physical coordinates (scale 42) from vendor definition.
 * Uses accessible button elements for keyboard accessibility (AX tree support).
 */
function renderKeyboard() {
  const keymapContainer = document.getElementById('keyboard-keys-container');
  const lightingContainer = document.getElementById('lighting-keys-container');
  const advancedContainer = document.getElementById('advanced-keys-container');
  if (!state.layout || !state.layout.keys) return;

  const SCALE = 42;

  function populateContainer(container, keysList, idPrefix) {
    if (!container) return;
    container.replaceChildren();

    for (const key of keysList) {
      const keyEl = document.createElement('button');
      keyEl.type = 'button';
      keyEl.className = 'kb-key';
      keyEl.id = idPrefix ? `${idPrefix}${key.id}` : key.id;
      keyEl.dataset.keyId = key.id;
      keyEl.dataset.slot = String(key.slot);
      keyEl.setAttribute('aria-label', `${key.name} (Slot ${key.slot})`);

      if (key.isKnob) {
        keyEl.classList.add('knob-key');
      }
      if (key.isLightingZone) {
        keyEl.classList.add('space-zone');
      }

      // Exact pixel coordinates
      const leftPx = Math.round(key.x * SCALE);
      const topPx = Math.round(key.y * SCALE);
      let widthPx = Math.max(16, Math.round((key.w || 1) * SCALE - 4));
      let heightPx = Math.max(16, Math.round((key.h || 1) * SCALE - 4));

      if (key.isKnob) {
        widthPx = Math.max(8, Math.round((key.w || 0.2857) * SCALE));
        heightPx = Math.max(16, Math.round((key.h || 0.75) * SCALE));
      }

      keyEl.style.left = `${leftPx}px`;
      keyEl.style.top = `${topPx}px`;
      keyEl.style.width = `${widthPx}px`;
      keyEl.style.height = `${heightPx}px`;

      const isLightingMode = idPrefix === 'light_';
      const customColor = state.stagedKeyColors[key.slot];
      if (customColor && customColor !== '#000000') {
        keyEl.style.borderColor = customColor;
        keyEl.style.boxShadow = `0 0 6px ${customColor}`;
        if (isLightingMode) {
          keyEl.style.backgroundColor = customColor;
          keyEl.style.color = '#000000';
        }
      }

      const labelSpan = document.createElement('span');
      labelSpan.className = 'key-label';

      if (isLightingMode) {
        labelSpan.textContent = key.name;
      } else {
        const assigned = state.layerKeymaps[state.activeLayer]?.[key.slot];
        labelSpan.textContent = assigned?.label || key.name;
      }
      keyEl.append(labelSpan);

      if (customColor && customColor !== '#000000' && !isLightingMode) {
        const dot = document.createElement('span');
        dot.className = 'key-color-dot';
        dot.style.backgroundColor = customColor;
        keyEl.append(dot);
      }

      if (key.id === state.selectedKeyId) {
        keyEl.classList.add('selected');
      }

      keyEl.addEventListener('click', () => {
        selectKey(key);
        if (isLightingMode) {
          const colorInput = document.getElementById('perkey-color-input');
          const color = colorInput?.value || '#00E5FF';
          state.stagedKeyColors[key.slot] = color;
          state.changedKeyColors[key.slot] = color;
          renderKeyboard();
          scheduleStillColorPersist();
        }
      });

      if (!isLightingMode && idPrefix !== 'adv_') {
        keyEl.addEventListener('dragover', (ev) => {
          const payload = KeyConfig.readDragPayload(state.keyDragging, 'keyCode');
          if (!payload.ok) return;
          ev.preventDefault();
          keyEl.classList.add('dragover');
        });
        keyEl.addEventListener('dragleave', () => {
          keyEl.classList.remove('dragover');
        });
        keyEl.addEventListener('drop', (ev) => {
          ev.preventDefault();
          keyEl.classList.remove('dragover');
          const payload = KeyConfig.readDragPayload(state.keyDragging, 'keyCode');
          state.keyDragging = null;
          if (!payload.ok) {
            showToast(payload.error, 'warning');
            return;
          }
          selectKey(key);
          void commitBinding(payload.tuple, bindingLabel(payload.tuple));
        });
      }

      container.append(keyEl);
    }
  }

  populateContainer(keymapContainer, state.layout.keys, '');
  if (lightingContainer) {
    const lightingKeys = state.layout.lightingEntries || state.layout.keys;
    populateContainer(lightingContainer, lightingKeys, 'light_');
  }
  if (advancedContainer) {
    populateContainer(advancedContainer, state.layout.keys, 'adv_');
  }

  // Update selected key inspector
  const currentKey = state.layout.keys.find(k => k.id === state.selectedKeyId) || state.layout.keys[0];
  selectKey(currentKey);
}

/**
 * Select key on visual keyboard
 */
function selectKey(key) {
  if (!key) return;
  state.selectedKeyId = key.id;
  state.selectedKey = key;

  document.querySelectorAll('.kb-key').forEach(k => {
    k.classList.toggle('selected', k.id === key.id);
  });

  const box = document.getElementById('inspector-key-box');
  const nameEl = document.getElementById('inspector-key-name');
  const infoEl = document.getElementById('inspector-key-info');
  const assignedEl = document.getElementById('inspector-assigned-info');

  const assigned = state.layerKeymaps[state.activeLayer]?.[key.slot];
  let displayLabel = assigned?.label || key.name;
  if (assigned && assigned.type === 112) {
    displayLabel = assigned.label || `M${(assigned.code1 || 0) + 1}`;
  }
  const customColor = state.stagedKeyColors[key.slot];

  if (box) {
    box.textContent = displayLabel;
    if (customColor && customColor !== '#000000') {
      box.style.borderColor = customColor;
      box.style.color = customColor;
    } else {
      box.style.borderColor = 'var(--theme-color)';
      box.style.color = 'var(--theme-color)';
    }
  }

  if (nameEl) nameEl.textContent = key.name + (key.isKnob ? ' (Rotary Knob)' : '');
  if (infoEl) {
    infoEl.textContent = key.isKnob
      ? 'Knob press can be remapped. The wheel is left unchanged.'
      : (key.id === 'k_fn' ? 'Fn is not available for advanced bindings.' : '');
  }
  if (assignedEl) {
    if (assigned) {
      if (assigned.type === 112) {
        const modeLabel = assigned.code2 === 1 ? 'Play Once' : (assigned.code2 === 255 ? 'Toggle Repeat' : 'Repeat Held');
        assignedEl.textContent = `Assigned: Macro ${assigned.code1 + 1} (${modeLabel})`;
      } else if (assigned.type === 16 && assigned.code1 > 0) {
        assignedEl.textContent = `Assigned: Chord ${assigned.label}`;
      } else {
        assignedEl.textContent = `Assigned: ${assigned.label} (Code: ${assigned.code || assigned.code2})`;
      }
    } else {
      assignedEl.textContent = 'Default Mapping';
    }
  }
  renderAdvancedPanel();
}

/**
 * Assign a macro slot to currently selected key.
 * Strictly uses [112, slotIndex, playbackType] format.
 */
function assignMacroToSelected(slotIndex) {
  if (!state.selectedKey) {
    showToast('Please select a key on the visual keyboard first.', 'warning');
    return;
  }
  if (state.loadInFlight || !state.hasReadKeymap[state.activeLayer]) {
    showToast(`Layer ${state.activeLayer} must be read from keyboard before editing.`, 'warning');
    return;
  }
  const macroSlot = state.stagedMacros[slotIndex] || { type: 0 };
  const playbackType = macroSlot.type !== undefined ? macroSlot.type : 0;
  if (!state.layerKeymaps[state.activeLayer]) {
    state.layerKeymaps[state.activeLayer] = {};
  }
  void commitBinding({ type: 112, code1: slotIndex, code2: playbackType }, `M${slotIndex + 1}`);
}

function attachPaletteDrag(el, tuple) {
  const made = KeyConfig.makeDragPayload(tuple);
  if (!made.ok) return;
  el.draggable = !isLocalPreview();
  el.addEventListener('dragstart', (ev) => {
    if (isLocalPreview()) {
      ev.preventDefault();
      return;
    }
    state.keyDragging = made.data;
    try {
      ev.dataTransfer.setData('application/x-maicong-keycode', JSON.stringify(made.data));
      ev.dataTransfer.effectAllowed = 'copy';
    } catch {
      /* Electron still uses in-memory draggingData */
    }
  });
  el.addEventListener('dragend', () => {
    state.keyDragging = null;
    document.querySelectorAll('.kb-key.dragover').forEach((n) => n.classList.remove('dragover'));
  });
}

function getActiveRemapCategories() {
  const activeLayer = state.activeLayer || 0;
  if (state.layout?.layerRemapCategories && state.layout.layerRemapCategories[activeLayer]) {
    return state.layout.layerRemapCategories[activeLayer];
  }
  return state.layout?.remapCategories || null;
}

/**
 * Render Remap Palette Categories and Keys
 */
function renderPalette() {
  const tabsContainer = document.getElementById('palette-category-tabs');
  const keysContainer = document.getElementById('palette-keys-container');
  const activeCategories = getActiveRemapCategories();
  if (!tabsContainer || !keysContainer || !activeCategories) return;

  tabsContainer.replaceChildren();
  const categories = ['Macros', ...Object.keys(activeCategories)];

  if (!categories.includes(state.paletteCategory)) {
    state.paletteCategory = categories[1] || 'Basic';
  }

  for (const cat of categories) {
    const tabBtn = document.createElement('button');
    tabBtn.className = `palette-cat-btn ${cat === state.paletteCategory ? 'active' : ''}`;
    tabBtn.textContent = cat;
    tabBtn.dataset.category = cat;
    tabBtn.addEventListener('click', () => {
      state.paletteCategory = cat;
      renderPalette();
    });
    tabsContainer.append(tabBtn);
  }

  keysContainer.replaceChildren();

  if (state.paletteCategory === 'Macros') {
    for (let i = 0; i < 16; i++) {
      const slot = state.stagedMacros[i] || { type: 0 };
      const mBtn = document.createElement('button');
      mBtn.className = 'palette-key-btn';
      mBtn.textContent = `M${i + 1}`;
      mBtn.title = `Macro ${i + 1} (Type: ${slot.type || 0})`;
      mBtn.dataset.type = '112';
      mBtn.dataset.code1 = String(i);
      mBtn.dataset.code2 = String(slot.type || 0);
      mBtn.dataset.label = `M${i + 1}`;
      mBtn.addEventListener('click', () => {
        assignMacroToSelected(i);
      });
      attachPaletteDrag(mBtn, { type: 112, code1: i, code2: slot.type || 0, label: `M${i + 1}` });
      keysContainer.append(mBtn);
    }
    return;
  }

  const categoryKeys = activeCategories[state.paletteCategory] || [];

  for (const item of categoryKeys) {
    const keyBtn = document.createElement('button');
    keyBtn.className = 'palette-key-btn';
    keyBtn.textContent = item.label;
    keyBtn.title = `Code: ${item.code}`;

    const bType = item.type !== undefined ? item.type : (item.code === 0 ? 0 : 16);
    const bCode1 = item.code1 !== undefined ? item.code1 : (item.code >= 224 && item.code <= 231 ? (1 << (item.code - 224)) : 0);
    const bCode2 = item.code2 !== undefined ? item.code2 : (item.code >= 224 && item.code <= 231 ? 0 : (item.code || 0));

    keyBtn.dataset.type = String(bType);
    keyBtn.dataset.code1 = String(bCode1);
    keyBtn.dataset.code2 = String(bCode2);
    keyBtn.dataset.label = item.label;

    keyBtn.addEventListener('click', () => {
      assignKeyToSelected(item);
    });
    attachPaletteDrag(keyBtn, {
      type: bType,
      code1: bCode1,
      code2: bCode2,
      label: item.label
    });

    keysContainer.append(keyBtn);
  }
}

/**
 * Assign a key from palette to currently selected key.
 * Supports standard [16, 0, HIDusage], modifier-only [16, mask, 0], and modifier chords [16, mask, HIDusage].
 */
function assignKeyToSelected(remapItem) {
  if (!state.selectedKey) return;
  if (state.loadInFlight || !state.hasReadKeymap[state.activeLayer]) {
    showToast(`Layer ${state.activeLayer} must be read from keyboard before editing.`, 'warning');
    return;
  }

  // Explicit confirmation for Factory Reset key binding (draft UI protection)
  if (remapItem.type === 240 && remapItem.code1 === 8) {
    const ok = window.confirm(
      "Assign 'Factory Reset (Hold 3s)' to this key?\n\n" +
      "Holding this key for 3 seconds on hardware will restore keyboard factory settings."
    );
    if (!ok) {
      showToast('Reset key assignment cancelled.', 'info');
      return;
    }
  }

  if (!state.layerKeymaps[state.activeLayer]) {
    state.layerKeymaps[state.activeLayer] = {};
  }

  let type = 16;
  let code1 = 0;
  let code2 = remapItem.code !== undefined ? remapItem.code : 0;
  let label = remapItem.label;

  if (remapItem.type === 0 || (remapItem.type === 16 && remapItem.code1 === 0 && (remapItem.code2 === 0 || remapItem.code === 0) && remapItem.label === 'Clear') || (remapItem.code === 0 && remapItem.code1 === 0 && remapItem.type === undefined)) {
    // Disabled / clear key: [16, 0, 0] or [0, 0, 0]
    type = remapItem.type !== undefined ? remapItem.type : 16;
    code1 = 0;
    code2 = 0;
    label = remapItem.label || 'Clear';
  } else if (remapItem.type === 32) {
    // Mouse button: [32, buttonMask, 0]
    type = 32;
    code1 = remapItem.code1 !== undefined ? remapItem.code1 : (remapItem.code || 1);
    code2 = 0;
    label = remapItem.label;
  } else if (remapItem.type === 33) {
    // Mouse wheel: [33, 0, direction]
    type = 33;
    code1 = 0;
    code2 = remapItem.code2 !== undefined ? remapItem.code2 : (remapItem.code || 1);
    label = remapItem.label;
  } else if (remapItem.type === 48) {
    // Media consumer key: [48, consumerUsage, 0]
    type = 48;
    code1 = remapItem.code1 !== undefined ? remapItem.code1 : remapItem.code;
    code2 = remapItem.code2 !== undefined ? remapItem.code2 : 0;
    label = remapItem.label;
  } else if (remapItem.type === 64) {
    // System control key: [64, usage, 0]
    type = 64;
    code1 = remapItem.code1 !== undefined ? remapItem.code1 : (remapItem.code || 1);
    code2 = 0;
    label = remapItem.label;
  } else if (remapItem.type === 240) {
    // Lighting / Extra / Fn key
    if (remapItem.code === 255 || remapItem.code1 === 255) {
      type = 240;
      code1 = 255;
      const isMac = (state.activeLayer >= 2) || (state.settings && (state.settings.macMode % 4 === 2));
      code2 = remapItem.code2 !== undefined ? remapItem.code2 : (isMac ? 3 : 1);
      label = 'FN Layer';
    } else {
      type = 240;
      code1 = remapItem.code1 !== undefined ? remapItem.code1 : (remapItem.code || 0);
      code2 = remapItem.code2 !== undefined ? remapItem.code2 : 0;
      label = remapItem.label;
    }
  } else if (remapItem.code === 255) {
    type = 240;
    code1 = 255;
    const isMac = (state.activeLayer >= 2) || (state.settings && (state.settings.macMode % 4 === 2));
    code2 = isMac ? 3 : 1;
    label = 'FN Layer';
  } else {
    // Standard key (type 16) or chord
    type = 16;
    let baseCode1 = remapItem.code1 !== undefined ? remapItem.code1 : 0;
    let baseCode2 = remapItem.code2 !== undefined ? remapItem.code2 : (remapItem.code || 0);

    if (remapItem.code >= 224 && remapItem.code <= 231 && remapItem.code1 === undefined) {
      baseCode1 = 1 << (remapItem.code - 224);
      baseCode2 = 0;
    }

    let modifierMask = 0;
    const chordParts = [];
    if (document.getElementById('chord-ctrl')?.checked) { modifierMask |= 1; chordParts.push('Ctrl'); }
    if (document.getElementById('chord-shift')?.checked) { modifierMask |= 2; chordParts.push('Shift'); }
    if (document.getElementById('chord-alt')?.checked) { modifierMask |= 4; chordParts.push('Alt'); }
    if (document.getElementById('chord-gui')?.checked) { modifierMask |= 8; chordParts.push('Win'); }

    if (modifierMask > 0 && baseCode2 > 0) {
      code1 = baseCode1 | modifierMask;
      code2 = baseCode2;
      chordParts.push(remapItem.label);
      label = chordParts.join('+');
    } else {
      code1 = baseCode1;
      code2 = baseCode2;
      label = remapItem.label;
    }
  }

  void commitBinding({ type, code1, code2 }, label);
}

/**
 * Set active key layer (0..3)
 */
function setKeyLayer(layer) {
  state.activeLayer = layer;
  state.userChoseLayer = true;
  document.querySelectorAll('.toggle-btn[data-action="set-layer"]').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.layer, 10) === layer);
  });
  renderKeyboard();
  renderPalette();
  if (state.selectedKey) {
    selectKey(state.selectedKey);
  }
  updateApplyButtonsState();
}

/**
 * Handle Read Layer from Keyboard
 */
async function handleReadLayer() {
  const captured = { gen: state.editGeneration, resetEpoch: state.resetEpoch, profile: state.editingProfile, layer: state.activeLayer };
  showToast(`Reading Layer ${captured.layer} from keyboard…`, 'info');
  try {
    const res = await api.readLayer(captured.profile, captured.layer, false);
    if (!requestStillCurrent(captured)) return;
    if (res.success && Array.isArray(res.keys)) {
      showToast(`Successfully read Layer ${captured.layer}`, 'success');
      const physical = new Set((state.layout?.keys || []).map((k) => k.slot));
      const newLayerMap = {};

      for (const k of res.keys) {
        if (!physical.has(k.index)) continue;
        const layoutKey = state.layout?.keys.find(pk => pk.slot === k.index);
        let displayLabel = k.label || layoutKey?.name || 'Key';

        const activeCategories = getActiveRemapCategories();
        if (activeCategories) {
          for (const cat of Object.values(activeCategories)) {
            const match = cat.find(item => {
              if (item.type !== undefined) {
                const iC1 = item.code1 !== undefined ? item.code1 : 0;
                const iC2 = item.code2 !== undefined ? item.code2 : (item.code || 0);
                return item.type === k.type && iC1 === k.code1 && iC2 === k.code2;
              }
              if (k.type === 16) {
                if (k.code1 === 0 && item.code === k.code2) return true;
                if (k.code2 === 0 && item.code >= 224 && (1 << (item.code - 224)) === k.code1) return true;
              }
              return false;
            });
            if (match) {
              displayLabel = match.label;
              break;
            }
          }
        }

        newLayerMap[k.index] = {
          slot: k.index,
          type: k.type,
          code1: k.code1,
          code2: k.code2,
          code: k.code !== undefined ? k.code : (k.code2 || k.code1 || 0),
          label: displayLabel
        };
      }
      state.layerKeymaps[captured.layer] = KeyConfig.mergeLayerHydration(
        state.layerKeymaps[captured.layer],
        newLayerMap,
        state.keymapSlotRevs,
        state.keymapSlotPersisted,
        captured.layer
      );
      state.hasReadKeymap[captured.layer] = true;
      state.keymapDirty = KeyConfig.hasUnpersistedSlotRevs(state.keymapSlotRevs, state.keymapSlotPersisted);
      resetCbEditorCache();
      renderKeyboard();
      if (state.selectedKey) {
        selectKey(state.selectedKey);
      }
      updateApplyButtonsState();
    } else {
      state.hasReadKeymap[captured.layer] = false;
      updateApplyButtonsState();
      showToast(`Failed to read layer: ${res.error}`, 'error');
    }
  } catch (err) {
    if (!requestStillCurrent(captured)) return;
    state.hasReadKeymap[captured.layer] = false;
    updateApplyButtonsState();
    showToast(`Error reading layer: ${err.message}`, 'error');
  }
}

/**
 * Handle Apply Keymap to Keyboard
 * Writes remapped slots using verified [16, modifierMask, HIDusage] tuples.
 */
async function handleApplyKeymap() {
  if (isLocalPreview()) {
    const res = await persistLocalDraft();
    showToast(res.success ? 'Saved to custom profile (keyboard not written).' : res.error, res.success ? 'success' : 'error');
    return;
  }
  if (state.loadInFlight || !state.hasReadKeymap[state.activeLayer]) return;
  const captured = { gen: state.editGeneration, resetEpoch: state.resetEpoch, profile: state.editingProfile, layer: state.activeLayer };
  const quiet = await waitForKeymapWorkerQuiet(captured);
  if (!quiet) return;
  const currentLayerMap = state.layerKeymaps[captured.layer] || {};
  const entries = Object.entries(currentLayerMap);

  if (entries.length === 0) {
    showToast('No modified keys to write for this layer.', 'info');
    return;
  }

  showToast(`Applying ${entries.length} remapped key(s) to Layer ${state.activeLayer}…`, 'info');

  const physical = new Set((state.layout?.keys || []).map((k) => k.slot));
  const updates = [];
  for (const [slotStr, remap] of entries) {
    const slot = parseInt(slotStr, 10);
    if (!physical.has(slot)) continue;
    if (remap.type === undefined || remap.code1 === undefined || remap.code2 === undefined) continue;
    if (remap.type === 145 || remap.type === 146 || remap.type === 148) continue;
    updates.push({
      slot,
      type: remap.type,
      code1: remap.code1,
      code2: remap.code2
    });
  }

  try {
    const res = await api.applyKeymap(captured.profile, captured.layer, updates);
    if (!requestStillCurrent(captured)) return;
    if (res.success) {
      showToast(`Successfully applied ${updates.length} keys to Layer ${captured.layer} on edit-target Profile ${captured.profile + 1}!`, 'success');
    } else {
      showToast(`Failed to apply keymap: ${res.error}`, 'error');
    }
  } catch (err) {
    if (!requestStillCurrent(captured)) return;
    showToast(`Error applying keymap: ${err.message}`, 'error');
  }
}

function defaultLayersFromLayout() {
  return (state.layout && state.layout.defaultLayers) || { 0: {}, 1: {}, 2: {}, 3: {} };
}

function physicalSlotsList() {
  return (state.layout?.keys || []).map((k) => k.slot);
}

function cbSlotsForLayer(layer) {
  const list = new Set();
  const fromState = state.cbKeyIndexList && state.cbKeyIndexList[layer];
  if (Array.isArray(fromState)) {
    for (const slot of fromState) {
      if (Number.isInteger(slot)) list.add(slot);
    }
  }
  const custom = state.localPreviewData && state.localPreviewData.customParam;
  const rows = custom && Array.isArray(custom.cbKeyIndexList) ? custom.cbKeyIndexList[layer] : null;
  if (Array.isArray(rows)) {
    for (const slot of rows) {
      if (Number.isInteger(slot)) list.add(slot);
    }
  }
  return list;
}

function adoptCbKeyIndexList(list) {
  state.cbKeyIndexList = KeyConfig.copyCbKeyIndexList(list);
}

function currentProfileSource() {
  if (isLocalPreview()) return { kind: 'local', key: state.editSource.key };
  return { kind: 'onboard', profileIndex: state.editingProfile };
}

function bytesFromHexOrList(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw.slice();
  if (typeof raw === 'string') {
    if (raw.length % 2 !== 0) return null;
    const out = [];
    for (let i = 0; i < raw.length; i += 2) {
      const n = parseInt(raw.slice(i, i + 2), 16);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      out.push(n);
    }
    return out;
  }
  if (typeof raw.length === 'number') {
    const out = [];
    for (let i = 0; i < raw.length; i++) out.push(raw[i] & 255);
    return out;
  }
  return null;
}

function tableBufferForType(type) {
  const key = type === 146 ? 'mt' : 'tgl';
  let raw = null;
  if (isLocalPreview() && state.localPreviewData && state.localPreviewData.advanced) {
    raw = state.localPreviewData.advanced[key];
  } else if (state.advancedRead && state.advancedRead.raw) {
    raw = state.advancedRead.raw[key];
  }
  return bytesFromHexOrList(raw);
}

function destClipboardContext() {
  const slots = Array.isArray(state.stagedMacros) ? state.stagedMacros : [];
  return {
    macros: slots.map((slot) => ({
      type: slot && Number.isInteger(slot.type) ? slot.type : 0,
      bodyKey: MacroDraft && typeof MacroDraft.getNormalizedBodyKey === 'function'
        ? MacroDraft.getNormalizedBodyKey((slot && slot.actions) || [])
        : ''
    })),
    mtTable: tableBufferForType(146),
    tglTable: tableBufferForType(145)
  };
}

function clipboardExtrasFor(tuple) {
  if (!tuple || !KeyConfig.isReferenceBinding(tuple)) return { extras: {} };
  if (tuple.type === 112) {
    const slot = Array.isArray(state.stagedMacros) ? state.stagedMacros[tuple.code1] : null;
    const actions = slot && Array.isArray(slot.actions) ? slot.actions : [];
    const bodyKey = MacroDraft && typeof MacroDraft.getNormalizedBodyKey === 'function'
      ? MacroDraft.getNormalizedBodyKey(actions)
      : '';
    if (!bodyKey) {
      return { error: 'Macro clipboard requires playback type and action identity' };
    }
    const playbackType = Number.isInteger(slot && slot.type) ? slot.type : tuple.code2;
    return { extras: { macro: { playbackType, bodyKey } } };
  }
  const table = tableBufferForType(tuple.type);
  const size = KeyConfig.tableEntrySize(tuple.type);
  const bytes = KeyConfig.readTableEntryBytes(table, tuple.code1, size);
  if (!bytes) {
    return { error: 'Advanced clipboard requires table content bytes' };
  }
  return { extras: { tableBytes: bytes } };
}

async function prepareProfileSwitch() {
  const drained = await keymapSaveGate.drain(20000);
  if (!drained) {
    showToast('Still saving key bindings. Load for editing did not start.', 'warning');
    return false;
  }
  if (state.keymapSaveStatus === 'error' || state.keymapDirty) {
    showToast(state.keymapSaveError || 'Unsaved key bindings could not be saved. Load for editing did not start.', 'error');
    return false;
  }
  const settingsDrained = await settingsSaveGate.drain(20000);
  if (!settingsDrained) {
    showToast('Still saving performance settings. Load for editing did not start.', 'warning');
    return false;
  }
  if (state.settingsSaveStatus === 'error' || state.settingsDraftDirty || PerformanceAutosave.hasDirty(state.settingsEdited)) {
    showToast(state.settingsSaveError || 'Unsaved performance settings could not be saved. Load for editing did not start.', 'error');
    return false;
  }
  return true;
}

function bindingLabel(tuple) {
  if (!tuple) return '';
  if (tuple.label) return tuple.label;
  const cats = getActiveRemapCategories();
  if (cats) {
    for (const cat of Object.values(cats)) {
      const match = cat.find((item) => {
        const iC1 = item.code1 !== undefined ? item.code1 : 0;
        const iC2 = item.code2 !== undefined ? item.code2 : (item.code || 0);
        const type = item.type !== undefined ? item.type : 16;
        return type === tuple.type && iC1 === tuple.code1 && iC2 === tuple.code2;
      });
      if (match) return match.label;
    }
  }
  if (tuple.type === 112) return `M${(tuple.code1 || 0) + 1}`;
  if (tuple.type === 16 && tuple.code1 > 0 && tuple.code2 > 0) return `Chord ${tuple.code1}+${tuple.code2}`;
  return tuple.label || 'Key';
}

function stageBinding(slot, tuple, label) {
  if (!state.layerKeymaps[state.activeLayer]) state.layerKeymaps[state.activeLayer] = {};
  state.layerKeymaps[state.activeLayer][slot] = {
    slot,
    type: tuple.type,
    code1: tuple.code1,
    code2: tuple.code2,
    code: tuple.code2 || tuple.code1,
    label: label || bindingLabel(tuple)
  };
  KeyConfig.bumpSlotRev(state.keymapSlotRevs, state.activeLayer, slot);
}

function renderKeymapSaveStatus() {
  const el = document.getElementById('keymap-save-status');
  if (!el) return;
  const status = state.keymapSaveStatus || 'idle';
  if (status === 'saving') el.textContent = 'Saving…';
  else if (status === 'saved') el.textContent = isLocalPreview() ? 'Saved on this Mac' : 'Saved';
  else if (status === 'error') el.textContent = state.keymapSaveError || 'Couldn’t save';
  else el.textContent = '';
}

function updateRestoreDefaultsButton() {
  const btn = document.getElementById('btn-restore-defaults');
  if (!btn) return;
  const anyRead = Object.values(state.hasReadKeymap).some(Boolean);
  btn.disabled = Boolean(state.loadInFlight) || !anyRead
    || !KeyConfig.isSomeKeyChanged(state.layerKeymaps, defaultLayersFromLayout(), cbSlotsForLayer, physicalSlotsList());
}

function haltKeyRecorder(reason) {
  if (!KeyConfig) return;
  state.keyRecorder = KeyConfig.pauseRecorder(state.keyRecorder || KeyConfig.emptyRecorder());
  renderKeyRecorder();
  if (reason) {
    /* pause only; vendor tI has no cancel */
  }
}

function renderKeyRecorder() {
  if (!KeyConfig) return;
  if (!state.keyRecorder) state.keyRecorder = KeyConfig.emptyRecorder();
  const btn = document.getElementById('btn-key-record');
  const code = KeyConfig.recorderLabel(state.keyRecorder);
  if (btn) {
    btn.textContent = code === '112' ? 'Pause' : (code === '113' ? 'Resume' : 'Record');
    btn.disabled = Boolean(state.loadInFlight) || !state.hasReadKeymap[state.activeLayer] || !state.selectedKey;
  }
  const box = document.getElementById('key-record-capture');
  if (box) {
    if (state.keyRecorder.active) box.textContent = 'Recording. Press modifiers then a key.';
    else if (state.keyRecorder.hid || state.keyRecorder.mask) box.textContent = 'Paused. Resume to replace the chord.';
    else box.textContent = 'Click here, then Record. Pause and Resume use the same button. There is no Cancel control.';
  }
}

function toggleKeyRecorder() {
  if (!KeyConfig) return;
  if (state.loadInFlight || !state.hasReadKeymap[state.activeLayer]) {
    showToast(`Layer ${state.activeLayer} must be read from keyboard before editing.`, 'warning');
    return;
  }
  state.keyRecorder = KeyConfig.toggleRecorder(state.keyRecorder || KeyConfig.emptyRecorder());
  renderKeyRecorder();
  const box = document.getElementById('key-record-capture');
  if (state.keyRecorder.active && box) box.focus();
}

function keyRecordCaptureFocused() {
  return document.activeElement === document.getElementById('key-record-capture');
}

function handleKeyRecordEvent(event, isDown) {
  if (!KeyConfig || !state.keyRecorder || !state.keyRecorder.active) return;
  if (!keyRecordCaptureFocused()) return;
  if (event.repeat) return;
  const hid = event.code && DOM_KEY_TO_HID[event.code];
  if (!hid) return;
  event.preventDefault();
  const result = KeyConfig.applyRecorderKey(state.keyRecorder, hid, isDown);
  state.keyRecorder = result.rec;
  renderKeyRecorder();
  if (result.complete) {
    void commitBinding(result.complete, bindingLabel(result.complete));
  }
}

async function waitForKeymapWorkerQuiet(captured, maxMs = 20000) {
  const started = Date.now();
  while (keymapSaveGate.pending > 0) {
    if (Date.now() - started >= maxMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (captured) return loadRequestCurrent(captured);
  return true;
}

function finishKeymapSave(success, layer, slotRevs, error, snapshotRevs) {
  if (success) {
    if (snapshotRevs) {
      KeyConfig.markRevSnapshotPersisted(state.keymapSlotPersisted, snapshotRevs, state.keymapSlotRevs);
    } else {
      KeyConfig.markSlotsPersisted(state.keymapSlotPersisted, layer, slotRevs, state.keymapSlotRevs);
    }
    state.keymapSaveError = null;
  } else if (error) {
    state.keymapSaveError = error;
  }
  state.keymapDirty = KeyConfig.hasUnpersistedSlotRevs(state.keymapSlotRevs, state.keymapSlotPersisted);
  if (!success) state.keymapSaveStatus = 'error';
  else if (state.keymapDirty) state.keymapSaveStatus = 'saving';
  else state.keymapSaveStatus = 'saved';
  renderKeymapSaveStatus();
}

function saveRequestCurrent(captured) {
  return KeyConfig.saveIdentityMatches(captured, {
    gen: state.editGeneration,
    resetEpoch: state.resetEpoch,
    profile: state.editingProfile,
    source: currentProfileSource()
  });
}

async function persistBindingUpdatesNow(layer, updates, options, slotRevs, captured) {
  if (!saveRequestCurrent(captured)) return { success: false, stale: true };
  if (!updates || updates.length === 0) return { success: true, hardwareWrites: 0 };
  const ownedNow = KeyConfig.ownedSnapshotRevs(state.keymapSlotRevs, slotRevs, layer);
  if (Object.keys(ownedNow).length === 0) {
    finishKeymapSave(true, layer, slotRevs, null, ownedNow);
    return { success: true, hardwareWrites: 0, skippedStaleRev: true };
  }
  let planned = updates;
  if (isLocalPreview() && options && Array.isArray(options.expectedMacroRefs) && options.expectedMacroRefs.length) {
    const resolved = KeyConfig.resolveExpectedMacroUpdates(
      updates,
      destClipboardContext().macros,
      options.expectedMacroRefs
    );
    if (!resolved.ok) {
      finishKeymapSave(false, layer, slotRevs, resolved.error || 'Couldn’t save');
      return {
        success: false,
        error: resolved.error,
        rejectStage: 'localPersist',
        want: resolved.want,
        have: resolved.have
      };
    }
    planned = resolved.planned;
    const applied = KeyConfig.applyPlannedIfCurrent(
      state.layerKeymaps[layer],
      planned,
      state.keymapSlotRevs,
      slotRevs,
      layer
    );
    if (applied.length) renderKeyboard();
  }
  state.keymapSaveStatus = 'saving';
  renderKeymapSaveStatus();
  try {
    if (isLocalPreview()) {
      const res = await persistLocalDraft(slotRevs, layer);
      if (!saveRequestCurrent(captured)) return { success: false, stale: true };
      if (!res.success) {
        finishKeymapSave(false, layer, slotRevs, res.error || 'Couldn’t save');
        return res;
      }
      finishKeymapSave(true, layer, slotRevs, null, res.snapshotRevs);
      return { success: true, hardwareWrites: 0 };
    }
    const res = await api.applyKeymap(captured.profile, layer, planned, options);
    if (!saveRequestCurrent(captured)) return { success: false, stale: true };
    if (!res.success) {
      finishKeymapSave(false, layer, slotRevs, res.error || 'Couldn’t save');
      return res;
    }
    const applied = KeyConfig.applyPlannedIfCurrent(
      state.layerKeymaps[layer],
      Array.isArray(res.planned) ? res.planned : planned,
      state.keymapSlotRevs,
      slotRevs,
      layer
    );
    if (applied.length) renderKeyboard();
    finishKeymapSave(true, layer, slotRevs);
    return res;
  } catch (err) {
    if (!saveRequestCurrent(captured)) return { success: false, stale: true };
    finishKeymapSave(false, layer, slotRevs, err.message);
    return { success: false, error: err.message };
  }
}

function persistBindingUpdates(layer, updates, options) {
  const slotRevs = KeyConfig.captureSlotRevs(state.keymapSlotRevs, layer, updates);
  const captured = KeyConfig.captureSaveIdentity(
    currentProfileSource(),
    state.editGeneration,
    state.resetEpoch,
    state.editingProfile
  );
  return keymapSaveGate.enqueue(() => persistBindingUpdatesNow(layer, updates, options, slotRevs, captured));
}

async function commitBinding(tuple, label, options) {
  if (!state.selectedKey) {
    showToast('Please select a key on the visual keyboard first.', 'warning');
    return { success: false };
  }
  if (state.loadInFlight || !state.hasReadKeymap[state.activeLayer]) {
    showToast(`Layer ${state.activeLayer} must be read from keyboard before editing.`, 'warning');
    return { success: false };
  }
  const slot = state.selectedKey.slot;
  stageBinding(slot, tuple, label);
  renderKeyboard();
  selectKey(state.selectedKey);
  updateApplyButtonsState();
  updateRestoreDefaultsButton();
  state.keymapDirty = true;
  const res = await persistBindingUpdates(state.activeLayer, [{
    slot,
    type: tuple.type,
    code1: tuple.code1,
    code2: tuple.code2
  }], options);
  if (res.stale) return res;
  if (!res.success) showToast(res.error || 'Couldn’t save key', 'error');
  else if (isLocalPreview()) showToast('Saved to custom profile (keyboard not written).', 'success');
  return res;
}

function handleCopyKey() {
  if (!state.selectedKey) return;
  const assigned = state.layerKeymaps[state.activeLayer]?.[state.selectedKey.slot];
  if (!assigned) {
    showToast('Nothing to copy on this key.', 'info');
    return;
  }
  const extrasRes = clipboardExtrasFor(assigned);
  if (extrasRes.error) {
    showToast(extrasRes.error, 'warning');
    return;
  }
  const copied = KeyConfig.copyBinding(assigned, currentProfileSource(), extrasRes.extras);
  if (!copied.ok) {
    showToast(copied.error, 'warning');
    return;
  }
  state.keyClipboard = copied.clip;
  showToast('Copied key binding.', 'success');
}

async function handleCutKey() {
  if (!state.selectedKey) return;
  if (state.loadInFlight || !state.hasReadKeymap[state.activeLayer]) {
    showToast(`Layer ${state.activeLayer} must be read from keyboard before editing.`, 'warning');
    return;
  }
  const slot = state.selectedKey.slot;
  const assigned = state.layerKeymaps[state.activeLayer]?.[slot];
  const extrasRes = clipboardExtrasFor(assigned || {});
  if (extrasRes.error) {
    showToast(extrasRes.error, 'warning');
    return;
  }
  const cut = KeyConfig.cutBinding(
    { ...(assigned || {}), slot, source: currentProfileSource() },
    cbSlotsForLayer(state.activeLayer),
    extrasRes.extras
  );
  if (!cut.ok) {
    showToast(cut.error, 'warning');
    return;
  }
  state.keyClipboard = cut.clip;
  const def = defaultLayersFromLayout()[state.activeLayer]?.[slot];
  if (!def) {
    showToast('Default tuple unavailable for this key.', 'error');
    return { success: false, error: 'Default tuple unavailable for this key.' };
  }
  return commitBinding(def, bindingLabel(def));
}

async function handlePasteKey() {
  const pasted = KeyConfig.pasteBinding(
    state.keyClipboard,
    currentProfileSource(),
    state.layerKeymaps,
    destClipboardContext()
  );
  if (!pasted.ok) {
    showToast(pasted.error || 'Clipboard is not a key binding.', 'warning');
    return {
      success: false,
      error: pasted.error || 'Clipboard is not a key binding.',
      rejectStage: pasted.rejectStage || 'pasteBinding',
      want: pasted.want,
      have: pasted.have
    };
  }
  const options = {};
  if (pasted.sharedAdvanced && pasted.expectedRef) {
    options.allowSharedAdvancedRefs = true;
    options.expectedRefs = [pasted.expectedRef];
  }
  if (pasted.expectedMacro) {
    options.expectedMacroRefs = [{
      type: pasted.expectedMacro.type,
      index: pasted.expectedMacro.index,
      playbackType: pasted.expectedMacro.playbackType,
      bodyKey: pasted.expectedMacro.bodyKey,
      slot: state.selectedKey ? state.selectedKey.slot : undefined
    }];
  }
  return commitBinding(
    pasted.tuple,
    bindingLabel(pasted.tuple),
    Object.keys(options).length ? options : undefined
  );
}

function openKeymapResetDialog() {
  if (state.loadInFlight) return;
  const anyRead = Object.values(state.hasReadKeymap).some(Boolean);
  if (!anyRead) {
    showToast('Read a layer before restoring defaults.', 'warning');
    return;
  }
  if (!KeyConfig.isSomeKeyChanged(state.layerKeymaps, defaultLayersFromLayout(), cbSlotsForLayer, physicalSlotsList())) {
    showToast('No remapped keys to restore.', 'info');
    return;
  }
  const dialog = document.getElementById('keymap-reset-dialog');
  if (!dialog) return;
  state.keymapResetDialogOpen = true;
  state.keymapResetOpener = document.activeElement;
  dialog.hidden = false;
  document.getElementById('btn-keymap-reset-confirm')?.focus();
}

function closeKeymapResetDialog() {
  const dialog = document.getElementById('keymap-reset-dialog');
  if (dialog) dialog.hidden = true;
  state.keymapResetDialogOpen = false;
  if (state.keymapResetOpener && typeof state.keymapResetOpener.focus === 'function') {
    state.keymapResetOpener.focus();
  }
  state.keymapResetOpener = null;
}

async function confirmKeymapResetDialog() {
  closeKeymapResetDialog();
  const defaults = defaultLayersFromLayout();
  const slots = physicalSlotsList();
  const captured = { gen: state.editGeneration, resetEpoch: state.resetEpoch, profile: state.editingProfile };
  for (let layer = 0; layer < 4; layer++) {
    if (!state.hasReadKeymap[layer] && !isLocalPreview() && state.connected) {
      const res = await api.readLayer(captured.profile, layer, false);
      if (!requestStillCurrent(captured)) return;
      if (res.success && Array.isArray(res.keys)) {
        const physical = new Set(slots);
        const map = {};
        for (const k of res.keys) {
          if (!physical.has(k.index)) continue;
          map[k.index] = { slot: k.index, type: k.type, code1: k.code1, code2: k.code2, code: k.code2 || k.code1, label: k.label };
        }
        state.layerKeymaps[layer] = map;
        state.hasReadKeymap[layer] = true;
      } else {
        showToast(`Could not read layer ${layer} before restore: ${res.error || 'read failed'}`, 'error');
        return;
      }
    }
    if (!state.hasReadKeymap[layer]) continue;
    const cbSlots = cbSlotsForLayer(layer);
    const plan = KeyConfig.resetUpdatesForLayer(layer, state.layerKeymaps[layer], defaults[layer], cbSlots, slots);
    for (const update of plan.updates) {
      const def = defaults[layer][update.slot];
      if (!state.layerKeymaps[layer]) state.layerKeymaps[layer] = {};
      state.layerKeymaps[layer][update.slot] = {
        slot: update.slot,
        type: update.type,
        code1: update.code1,
        code2: update.code2,
        code: update.code2 || update.code1,
        label: bindingLabel(def || update)
      };
      KeyConfig.bumpSlotRev(state.keymapSlotRevs, layer, update.slot);
    }
    if (plan.updates.length) {
      const res = await persistBindingUpdates(layer, plan.updates);
      if (!res.success) {
        showToast(res.error || `Failed restoring layer ${layer}`, 'error');
        return;
      }
    }
  }
  renderKeyboard();
  updateRestoreDefaultsButton();
  showToast('Restored ordinary key defaults. Advanced bindings were left in place.', 'success');
}

/**
 * Reset Layer staging to default (legacy action alias)
 */
function handleResetLayer() {
  openKeymapResetDialog();
}

function canStartLightingRead() {
  return Boolean(state.connected && !state.loadInFlight && !state.lightingReadInFlight);
}

function canEditLighting() {
  return Boolean(state.connected && !state.loadInFlight && state.hasReadLighting && !state.lightingReadInFlight);
}

function abortLightingScheduler() {
  if (state.lightingSaveTimer) {
    clearTimeout(state.lightingSaveTimer);
    state.lightingSaveTimer = null;
  }
  if (state.stillEditTimer) {
    clearTimeout(state.stillEditTimer);
    state.stillEditTimer = null;
  }
  state.lightingSaveQueued = false;
  state.lightingPrefQueued = null;
  state.lightingPrefInFlight = false;
  state.lightingReadQueued = false;
  state.lightingCalQueued = null;
  state.lightingCalInFlight = false;
  state.lightingStillQueue = [];
  state.stillDirtyKey = null;
  state.stillEditSeq += 1;
  state.lightingLastFlushAt = 0;
  state.lightingOpSeq += 1;
  state.lightingPrefOpSeq += 1;
  state.lightingOpInFlight = false;
  state.lightingReadInFlight = false;
  if (state.lightingSaveStatus === 'saving') state.lightingSaveStatus = 'idle';
}

function loadRequestCurrent(captured) {
  if (!captured) return false;
  if (!state.connected) return false;
  if (captured.gen !== state.editGeneration) return false;
  if (typeof captured.resetEpoch === 'number' && captured.resetEpoch !== state.resetEpoch) return false;
  return true;
}

async function waitForLightingWorkerQuiet(captured, maxMs = 20000) {
  const started = Date.now();
  while (state.lightingSaveWorkerBusy) {
    if (!loadRequestCurrent(captured)) return false;
    if (Date.now() - started >= maxMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return loadRequestCurrent(captured);
}

function beginLightingOp() {
  if (!state.connected || state.loadInFlight) return null;
  state.lightingOpSeq += 1;
  state.lightingOpInFlight = true;
  const captured = {
    gen: state.editGeneration,
    resetEpoch: state.resetEpoch,
    profile: state.editingProfile,
    seq: state.lightingOpSeq
  };
  updateApplyButtonsState();
  return captured;
}

function finishLightingOp(captured) {
  if (
    !captured
    || captured.seq !== state.lightingOpSeq
    || captured.gen !== state.editGeneration
    || captured.resetEpoch !== state.resetEpoch
    || captured.profile !== state.editingProfile
  ) {
    return false;
  }
  state.lightingOpInFlight = false;
  return true;
}

function canEditKeyColors() {
  return Boolean(state.connected && !state.loadInFlight && state.hasReadKeyColors);
}

function stageLightingEdit(fields) {
  if (!canEditLighting() || !fields || typeof fields !== 'object') return false;
  Object.assign(state.lighting, fields);
  state.lightingEdited = LightingAutosave.markEdited(state.lightingEdited, fields);
  state.lightingDraftDirty = true;
  state.lightingSaveBlocked = false;
  state.lightingSaveStatus = 'saving';
  state.lightingSaveError = null;
  scheduleLightingSave(LightingAutosave.coalesceWait(fields, Date.now(), state.lightingLastFlushAt));
  updateApplyButtonsState();
  renderLightingSaveStatus();
  return true;
}

function buildLightingApplyPatch() {
  return LightingAutosave.buildPatch(
    state.lightingEdited,
    state.lighting,
    findMainEffect,
    findSideEffect
  );
}

function lightingSaveIdentity() {
  return LightingAutosave.identitySnapshot(state);
}

function lightingSaveIdentityCurrent(captured) {
  return LightingAutosave.identityMatches(captured, state);
}

function scheduleLightingSave(delayMs) {
  if (!canEditLighting()) return;
  const delay = Number.isInteger(delayMs) ? delayMs : 0;
  if (state.lightingSaveTimer) {
    clearTimeout(state.lightingSaveTimer);
    state.lightingSaveTimer = null;
  }
  if (delay > 0) {
    state.lightingSaveTimer = setTimeout(() => {
      state.lightingSaveTimer = null;
      state.lightingSaveQueued = true;
      void runLightingSaveWorker();
    }, delay);
    return;
  }
  state.lightingSaveQueued = true;
  void runLightingSaveWorker();
}

function renderLightingSaveStatus() {
  const el = document.getElementById('lighting-save-status');
  if (!el) return;
  const status = state.lightingSaveStatus || 'idle';
  el.dataset.state = status;
  if (status === 'saving') el.textContent = 'Saving…';
  else if (status === 'saved') el.textContent = state.lightingMemoryBlocked ? 'Saved' : 'Saved';
  else if (status === 'unsaved') el.textContent = 'Not saved';
  else if (status === 'error') el.textContent = 'Couldn’t save';
  else el.textContent = '';
  updateApplyButtonsState();
}

function lightingFuncCanAutosave() {
  return canEditLighting() && !state.lightingSaveBlocked && state.lightingSaveStatus !== 'error';
}

async function runLightingSaveWorker() {
  if (isLocalPreview()) {
    state.lightingDraftDirty = false;
    await persistLocalDraft();
    return;
  }
  if (state.lightingSaveWorkerBusy) return;
  state.lightingSaveWorkerBusy = true;
  try {
    while (state.connected) {
      if (state.lightingCalQueued || state.lightingPrefQueued || state.lightingReadQueued) {
        if (state.lightingSaveTimer) {
          clearTimeout(state.lightingSaveTimer);
          state.lightingSaveTimer = null;
          state.lightingSaveQueued = true;
        }
      }
      if (state.lightingCalQueued) {
        if (LightingAutosave.hasDirty(state.lightingEdited) && lightingFuncCanAutosave()) {
          const saved = await runQueuedLightingSave();
          if (!saved) break;
          continue;
        }
        await runQueuedLightingCalibration();
        continue;
      }
      if (state.lightingPrefQueued) {
        if (LightingAutosave.hasDirty(state.lightingEdited) && lightingFuncCanAutosave()) {
          const saved = await runQueuedLightingSave();
          if (!saved) break;
          continue;
        }
        await runQueuedLightingPref();
        continue;
      }
      if (state.lightingReadQueued) {
        if (LightingAutosave.hasDirty(state.lightingEdited) && lightingFuncCanAutosave()) {
          const saved = await runQueuedLightingSave();
          if (!saved) break;
          continue;
        }
        await runQueuedLightingRead();
        continue;
      }
      if (stillQueuePending()) {
        if (LightingAutosave.hasDirty(state.lightingEdited) && lightingFuncCanAutosave()) {
          const saved = await runQueuedLightingSave();
          if (!saved) break;
          continue;
        }
        await runQueuedStillOp();
        continue;
      }
      if (gifQueuePending()) {
        if (LightingAutosave.hasDirty(state.lightingEdited) && lightingFuncCanAutosave()) {
          const saved = await runQueuedLightingSave();
          if (!saved) break;
          continue;
        }
        await runQueuedGifOp();
        continue;
      }
      if (state.lightingSaveTimer) break;
      if (
        (state.lightingSaveQueued || LightingAutosave.hasDirty(state.lightingEdited))
        && lightingFuncCanAutosave()
      ) {
        const saved = await runQueuedLightingSave();
        if (!saved) break;
        continue;
      }
      break;
    }
  } finally {
    state.lightingSaveWorkerBusy = false;
    if (
      state.connected
      && !state.loadInFlight
      && !state.lightingSaveTimer
      && (
        state.lightingCalQueued
        || state.lightingPrefQueued
        || state.lightingReadQueued
        || stillQueuePending()
        || gifQueuePending()
        || (state.lightingSaveQueued && lightingFuncCanAutosave())
      )
    ) {
      void runLightingSaveWorker();
    }
  }
}

async function runQueuedLightingSave() {
  state.lightingSaveQueued = false;
  if (state.lightingSaveTimer) return true;
  if (!canEditLighting()) return false;
  const patch = buildLightingApplyPatch();
  if (Object.keys(patch).length === 0) {
    state.lightingEdited = {};
    state.lightingDraftDirty = false;
    if (state.lightingSaveStatus === 'saving') {
      state.lightingSaveStatus = 'idle';
      renderLightingSaveStatus();
    }
    return true;
  }
  const captured = lightingSaveIdentity();
  captured.seq = ++state.lightingOpSeq;
  captured.patch = { ...patch };
  state.lightingLastFlushAt = Date.now();
  state.lightingOpInFlight = true;
  state.lightingSaveStatus = 'saving';
  renderLightingSaveStatus();
  let res;
  try {
    res = await api.applyLighting(patch, captured.profile, {
      persistMemory: !state.lightingMemoryBlocked
    });
  } catch (err) {
    res = { success: false, error: err.message || String(err) };
  }
  if (!lightingSaveIdentityCurrent(captured) || captured.seq !== state.lightingOpSeq) {
    return false;
  }
  state.lightingOpInFlight = false;
  if (!res || !res.success) {
    state.hasReadLighting = false;
    state.lightingDraftDirty = true;
    state.lightingSaveBlocked = true;
    state.lightingSaveStatus = 'error';
    state.lightingSaveError = (res && res.error) || 'Lighting save failed';
    renderLightingSaveStatus();
    renderLightingControls();
    showToast(`Couldn’t save lighting: ${state.lightingSaveError}`, 'error');
    return false;
  }
  state.lightingEdited = LightingAutosave.settleEdited(state.lightingEdited, captured.patch, state.lighting);
  state.lightingDraftDirty = LightingAutosave.hasDirty(state.lightingEdited);
  state.lightingHydrateLocked = false;
  if (res.lightMemory) adoptLightMemory(res.lightMemory);
  if (res.memorySaveFailed) {
    state.lightingMemoryBlocked = true;
    state.lightingMemoryError = res.memoryError || 'Effect memory could not be saved';
    showToast(`Lighting saved. Effect memory could not be saved: ${state.lightingMemoryError}`, 'warning', 8000);
  }
  if (state.lightingDraftDirty) {
    state.lightingSaveStatus = 'saving';
    state.lightingSaveQueued = true;
  } else {
    state.lightingSaveStatus = 'saved';
    state.lightingSaveError = null;
  }
  renderLightingSaveStatus();
  return true;
}

async function runQueuedLightingPref() {
  const fallback = state.lightingPrefQueued;
  if (fallback !== 'hardware' && fallback !== 'local') {
    state.lightingPrefQueued = null;
    return;
  }
  const captured = lightingSaveIdentity();
  captured.seq = state.lightingPrefOpSeq;
  if (!api.setLightingMemoryPreference) {
    state.lightingPrefQueued = null;
    return;
  }
  state.lightingPrefInFlight = true;
  state.lightingPrefQueued = null;
  try {
    let res;
    try {
      res = await api.setLightingMemoryPreference({ fallback });
    } catch (err) {
      res = { success: false, error: err.message || String(err) };
    }
    if (!lightingSaveIdentityCurrent(captured) || captured.seq !== state.lightingPrefOpSeq) return;
    if (!res || !res.success) {
      showToast((res && res.error) || 'Could not change remembered-effect storage.', 'error');
      let pref = null;
      try {
        pref = await api.getLightingMemoryPreference();
      } catch {
        pref = null;
      }
      if (!lightingSaveIdentityCurrent(captured) || captured.seq !== state.lightingPrefOpSeq) return;
      state.lightMemoryPref = pref;
      renderLightingMemoryPref();
      return;
    }
    state.lightingMemoryBlocked = false;
    state.lightingMemoryError = null;
    let pref = null;
    try {
      pref = await api.getLightingMemoryPreference();
    } catch {
      pref = null;
    }
    if (!lightingSaveIdentityCurrent(captured) || captured.seq !== state.lightingPrefOpSeq) return;
    state.lightMemoryPref = pref;
    renderLightingMemoryPref();
    if (!state.hasReadLighting) return;
    try {
      const memRes = await api.readFuncConfig(captured.profile);
      if (!lightingSaveIdentityCurrent(captured) || captured.seq !== state.lightingPrefOpSeq) return;
      if (memRes && memRes.lightMemory) adoptLightMemory(memRes.lightMemory);
    } catch {
      // keep drafts; memory hydrate is best-effort
    }
  } finally {
    if (captured.seq === state.lightingPrefOpSeq) state.lightingPrefInFlight = false;
  }
}

async function runQueuedLightingRead() {
  if (!state.connected || state.loadInFlight) {
    state.lightingReadQueued = false;
    return;
  }
  const captured = lightingSaveIdentity();
  captured.seq = ++state.lightingOpSeq;
  state.lightingOpInFlight = true;
  state.lightingReadInFlight = true;
  state.lightingReadQueued = false;
  updateApplyButtonsState();
  renderLightingControls();
  showToast('Reading lighting settings from keyboard…', 'info');
  try {
    let res;
    try {
      res = await api.readFuncConfig(captured.profile);
    } catch (err) {
      res = { success: false, error: err.message || String(err) };
    }
    if (!lightingSaveIdentityCurrent(captured) || captured.seq !== state.lightingOpSeq) return;
    if (res.success && res.lighting) {
      state.hasReadLighting = true;
      state.lightingHydrateLocked = false;
      if (!state.lightingDraftDirty) {
        state.lighting = { ...state.lighting, ...res.lighting };
        state.lightingEdited = {};
        state.lightingSaveBlocked = false;
        state.lightingSaveStatus = 'idle';
        state.lightingSaveError = null;
      } else if (LightingAutosave.desiredMatchesDevice(buildLightingApplyPatch(), res.lighting)) {
        state.lighting = { ...state.lighting, ...res.lighting };
        state.lightingEdited = {};
        state.lightingDraftDirty = false;
        state.lightingSaveBlocked = false;
        state.lightingSaveStatus = 'idle';
        state.lightingSaveError = null;
      } else {
        state.lightingSaveBlocked = true;
        state.lightingSaveStatus = 'unsaved';
      }
      adoptLightMemory(res.lightMemory || { success: false, backend: 'unavailable', store: { main: [], side: [], side2: [] } });
      if (res.stillLibrary || res.gifLibrary || Array.isArray(res.selectedLightEffect)) {
        adoptStillLibrary(res.stillLibrary, {
          confirmedPair: res.selectedLightEffect,
          syncUiToConfirmed: true
        });
        adoptGifLibrary(res.gifLibrary, {
          confirmedPair: res.selectedLightEffect,
          syncUiToConfirmed: true
        });
        if (state.lighting.effect === 0 && (state.selectedStillKey || state.selectedGifKey)) state.mainLightTab = 'local';
      }
      updateApplyButtonsState();
      renderLightingControls();
      renderLightingSaveStatus();
      showToast(
        state.lightingDraftDirty
          ? 'Device lighting read. Unsaved edits were kept.'
          : 'Lighting configuration refreshed from edit-target profile.',
        'success'
      );
    } else {
      if (!state.lightingDraftDirty) state.hasReadLighting = false;
      updateApplyButtonsState();
      renderLightingControls();
      showToast(`Failed to read lighting: ${res.error || 'unknown error'}`, 'error');
    }
  } finally {
    if (captured.seq === state.lightingOpSeq) {
      state.lightingOpInFlight = false;
      state.lightingReadInFlight = false;
      updateApplyButtonsState();
      renderLightingControls();
    }
  }
}

async function runQueuedLightingCalibration() {
  const rgb = state.lightingCalQueued;
  if (!rgb || !state.hasReadLighting || !state.connected || state.loadInFlight) {
    state.lightingCalQueued = null;
    return;
  }
  const captured = lightingSaveIdentity();
  captured.seq = ++state.lightingOpSeq;
  state.lightingOpInFlight = true;
  state.lightingCalInFlight = true;
  state.lightingReadInFlight = true;
  state.lightingCalQueued = null;
  updateApplyButtonsState();
  renderLightingControls();
  let res;
  try {
    try {
      res = await api.applyLighting({ calibrationRgb: rgb }, captured.profile);
    } catch (err) {
      res = { success: false, error: err.message || String(err) };
    }
    if (!lightingSaveIdentityCurrent(captured) || captured.seq !== state.lightingOpSeq) return;
    if (!res || !res.success) {
      state.hasReadLighting = false;
      state.lightingDraftDirty = true;
      state.lightingSaveBlocked = true;
      state.lightingSaveStatus = 'error';
      updateApplyButtonsState();
      renderLightingControls();
      showToast(`Calibration apply failed: ${res.error || 'unknown error'}`, 'error');
      return;
    }
    state.lighting.calibrationRgb = { r: rgb.r, g: rgb.g, b: rgb.b };
    updateApplyButtonsState();
    renderLightingControls();
    showToast('LED white balance applied.', 'success');
  } finally {
    if (captured.seq === state.lightingOpSeq) {
      state.lightingOpInFlight = false;
      state.lightingCalInFlight = false;
      state.lightingReadInFlight = false;
      updateApplyButtonsState();
      renderLightingControls();
    }
  }
}

function lightingCatalog() {
  return {
    main: Array.isArray(state.layout?.lightEffects) ? state.layout.lightEffects : [],
    side: Array.isArray(state.layout?.sideLightEffects) ? state.layout.sideLightEffects : [],
    mainPresetOrder: Array.isArray(state.layout?.lightEffectPresetOrder) ? state.layout.lightEffectPresetOrder : [],
    sideOrder: Array.isArray(state.layout?.sideLightDisplayOrder) ? state.layout.sideLightDisplayOrder : [1, 2, 3, 4],
    directionPairs: state.layout?.lightDirectionPairs || {}
  };
}

function findMainEffect(id) {
  return lightingCatalog().main.find((e) => e.id === id) || null;
}

function findSideEffect(id) {
  return lightingCatalog().side.find((e) => e.id === id) || null;
}

function currentLightingCaps() {
  if (state.lightingScope === 'side') {
    const e = findSideEffect(state.lighting.sideEffect);
    if (!e) return { known: false, brightness: false, speed: false, color: false, direction: null, name: null };
    return { known: true, brightness: e.brightness, speed: e.speed, color: e.color, direction: e.direction || null, name: e.name };
  }
  const e = findMainEffect(state.lighting.effect);
  if (!e) return { known: false, brightness: false, speed: false, color: false, direction: null, name: null };
  const gifSelected = Array.isArray(state.selectedLightEffect) && state.selectedLightEffect[0] === 'gif';
  return {
    known: true,
    brightness: e.brightness,
    speed: e.speed,
    color: gifSelected ? false : e.color,
    direction: e.direction || null,
    name: e.name
  };
}

function setGroupAvailable(groupId, inputIds, available) {
  const group = document.getElementById(groupId);
  if (group) group.hidden = !available;
  for (const id of inputIds) {
    const el = document.getElementById(id);
    if (el) el.disabled = !available;
  }
}

function fillEffectGrid(container, effects, selectedId, action, editable) {
  if (!container) return;
  if (container.childElementCount !== effects.length) {
    container.textContent = '';
    container.setAttribute('role', 'group');
    for (const eff of effects) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'effect-tile';
      btn.dataset.action = action;
      btn.dataset.effect = String(eff.id);
      btn.textContent = t(
        action === 'select-side-effect' ? `effect.side.${eff.id}` : `effect.${eff.id}`,
        { default: eff.name }
      );
      container.append(btn);
    }
  } else {
    Array.from(container.children).forEach((btn, i) => {
      const eff = effects[i];
      btn.dataset.effect = String(eff.id);
      btn.textContent = t(
        action === 'select-side-effect' ? `effect.side.${eff.id}` : `effect.${eff.id}`,
        { default: eff.name }
      );
    });
  }
  Array.from(container.children).forEach((btn) => {
    const id = parseInt(btn.dataset.effect, 10);
    const selected = Number.isInteger(selectedId) && id === selectedId;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
    btn.disabled = !editable;
  });
}

function setLightingScope(scope) {
  const next = scope === 'side' ? 'side' : 'main';
  if (state.lightingScope === next) return;
  state.lightingScope = next;
  renderLightingControls();
}

function lightingMemoryStore() {
  return (state.lightMemory && state.lightMemory.store) || { main: [], side: [], side2: [] };
}

function restoreMainFromMemory(id) {
  const rec = (lightingMemoryStore().main || []).find((r) => r.effect === id);
  const brightness = Math.max(0, Math.min(100, (rec && rec.brightness) || state.lighting.brightness || 100));
  const fields = { effect: id, brightness };
  if (rec) {
    if (Number.isInteger(rec.speed)) fields.speed = Math.max(0, Math.min(4, rec.speed));
    if (rec.direction !== undefined) fields.direction = rec.direction ? 1 : 0;
    if (rec.customColorDisabled !== undefined) fields.customColorDisabled = Boolean(rec.customColorDisabled);
    if (rec.hexColor) fields.hexColor = rec.hexColor;
  }
  return fields;
}

function restoreSideFromMemory(id) {
  const rec = (lightingMemoryStore().side || []).find((r) => r.sideEffect === id);
  const sideBrightness = Math.max(
    0,
    Math.min(100, (rec && rec.sideBrightness) || state.lighting.sideBrightness || 100)
  );
  const fields = { sideEffect: id, sideBrightness };
  if (rec) {
    if (Number.isInteger(rec.sideSpeed)) fields.sideSpeed = Math.max(0, Math.min(4, rec.sideSpeed));
    if (rec.sideCustomColorDisabled !== undefined) {
      fields.sideCustomColorDisabled = Boolean(rec.sideCustomColorDisabled);
    }
    if (rec.sideHexColor) fields.sideHexColor = rec.sideHexColor;
  }
  return fields;
}

async function refreshLightingMemoryPref() {
  if (!api.getLightingMemoryPreference) return;
  const captured = lightingSaveIdentity();
  captured.seq = state.lightingPrefOpSeq;
  let pref = null;
  try {
    pref = await api.getLightingMemoryPreference();
  } catch {
    pref = null;
  }
  if (!lightingSaveIdentityCurrent(captured) || captured.seq !== state.lightingPrefOpSeq) return;
  state.lightMemoryPref = pref;
  renderLightingMemoryPref();
}

function renderLightingMemoryPref() {
  const pref = state.lightMemoryPref || {};
  const local = pref.fallback === 'local';
  const hw = document.getElementById('light-mem-keyboard');
  const mac = document.getElementById('light-mem-mac');
  const hint = document.getElementById('lighting-memory-hint');
  if (hw) {
    hw.classList.toggle('active', !local);
    hw.setAttribute('aria-pressed', String(!local));
    hw.disabled = !state.connected || state.lightingReadInFlight;
  }
  if (mac) {
    mac.classList.toggle('active', local);
    mac.setAttribute('aria-pressed', String(local));
    mac.disabled = !state.connected || state.lightingReadInFlight;
  }
  if (hint) {
    let text = pref.hint || 'On the keyboard. A successful read does not prove writes.';
    if (pref.recovered && pref.error) {
      text = `Local lighting-memory file could not be read. The existing file was left unchanged. ${text}`;
    }
    hint.textContent = text;
  }
}

async function handleSetLightMemoryFallback(fallback) {
  if (!state.connected || !api.setLightingMemoryPreference) return;
  if (fallback !== 'hardware' && fallback !== 'local') return;
  state.lightingPrefQueued = fallback;
  state.lightingPrefOpSeq += 1;
  void runLightingSaveWorker();
}

function adoptLightMemory(memory) {
  if (!memory || typeof memory !== 'object') return;
  const ok = memory.success !== false && memory.store;
  state.lightMemory = {
    backend: memory.backend || null,
    reason: memory.reason || null,
    success: ok,
    persisted: Boolean(ok && memory.persisted !== false),
    store: ok ? (memory.store || { main: [], side: [], side2: [] }) : { main: [], side: [], side2: [] }
  };
}

function stillQueuePending() {
  return Array.isArray(state.lightingStillQueue) && state.lightingStillQueue.length > 0;
}

function stillIdentitySnapshot() {
  return lightingSaveIdentity();
}

function stillIdentityCurrent(captured) {
  return lightingSaveIdentityCurrent(captured);
}

function matchStillKeyByName(name) {
  const found = stillItems().find((item) => item.name === (name || ''));
  return found ? found.key : null;
}

function adoptStillLibrary(snap, options) {
  const opts = Array.isArray(options)
    ? { confirmedPair: options }
    : (options && typeof options === 'object' ? options : {});
  if (snap && typeof snap === 'object') {
    const items = Array.isArray(snap.items) ? snap.items : [];
    state.stillLibrary = {
      items,
      count: snap.count || items.length,
      max: snap.max || 20,
      remaining: snap.remaining != null ? snap.remaining : Math.max(0, 20 - items.length),
      selectedKey: snap.selectedKey || null,
      selectedPair: Array.isArray(snap.selectedPair) ? snap.selectedPair.slice() : ['still', ''],
      error: snap.error || null,
      unwritable: Boolean(snap.unwritable)
    };
  }
  if (Array.isArray(opts.confirmedPair)) {
    state.selectedLightEffect = [opts.confirmedPair[0] || 'still', opts.confirmedPair[1] || ''];
    if (state.stillLibrary) {
      state.stillLibrary.selectedPair = state.selectedLightEffect.slice();
      state.stillLibrary.selectedKey = matchStillKeyByName(state.selectedLightEffect[1]);
    }
  }
  if (opts.desiredKey) {
    state.selectedStillKey = opts.desiredKey;
  } else if (opts.syncUiToConfirmed) {
    state.selectedStillKey = matchStillKeyByName((state.selectedLightEffect && state.selectedLightEffect[1]) || '');
  }
  if (opts.clearMissingDesired && state.selectedStillKey && !stillItems().some((item) => item.key === state.selectedStillKey)) {
    state.selectedStillKey = null;
  }
}

function adoptLocalStillResult(res, captured, extra = {}) {
  const identityOk = stillIdentityCurrent(captured);
  const localSaved = Boolean(res && (res.localSaved || (res.success && res.stillLibrary)));
  if (localSaved && res.stillLibrary) {
    if (identityOk) {
      adoptStillLibrary(res.stillLibrary, {
        confirmedPair: Array.isArray(res.selectedLightEffect) ? res.selectedLightEffect : undefined,
        desiredKey: extra.desiredKey,
        clearMissingDesired: extra.clearMissingDesired
      });
    } else if (state.connected && captured.gen === state.editGeneration && captured.resetEpoch === state.resetEpoch) {
      adoptStillLibrary(res.stillLibrary);
    }
  }
  return identityOk;
}

async function refreshStillLibrary() {
  if (!api.getStillLibrary) return;
  const captured = stillIdentitySnapshot();
  try {
    const snap = await api.getStillLibrary();
    if (!stillIdentityCurrent(captured)) return;
    adoptStillLibrary(snap, { syncUiToConfirmed: !state.selectedStillKey });
    renderStillLibrary();
  } catch {
    // keep last snapshot
  }
}

function setMainLightTab(tab) {
  const next = tab === 'local' ? 'local' : 'normal';
  state.mainLightTab = next;
  if (next === 'local') state.lightingScope = 'main';
  renderLightingControls();
}

function stillItems() {
  return (state.stillLibrary && Array.isArray(state.stillLibrary.items)) ? state.stillLibrary.items : [];
}

function selectedStillItem() {
  const key = state.selectedStillKey;
  if (!key) return null;
  return stillItems().find((item) => item.key === key) || null;
}

function cancelStillEditTimer() {
  if (state.stillEditTimer) {
    clearTimeout(state.stillEditTimer);
    state.stillEditTimer = null;
  }
  state.stillEditSeq += 1;
}

function snapshotStillColors() {
  return { ...state.stagedKeyColors };
}

function enqueueStillOp(op) {
  if (!op || !op.op) return;
  if (!Array.isArray(state.lightingStillQueue)) state.lightingStillQueue = [];
  if (op.op === 'frames') {
    const idx = state.lightingStillQueue.findIndex((row) => row.op === 'frames' && row.key === op.key);
    if (idx >= 0) state.lightingStillQueue[idx] = op;
    else state.lightingStillQueue.push(op);
  } else if (op.op === 'select') {
    state.lightingStillQueue = state.lightingStillQueue.filter((row) => row.op !== 'select');
    state.lightingStillQueue.push(op);
  } else {
    state.lightingStillQueue.push(op);
  }
  void runLightingSaveWorker();
}

function enqueueDirtyStillFrames(options = {}) {
  const key = options.key || state.stillDirtyKey;
  if (!key) return false;
  const colors = options.colors || snapshotStillColors();
  if (state.stillDirtyKey === key) state.stillDirtyKey = null;
  enqueueStillOp({
    op: 'frames',
    key,
    colors,
    applyDevice: options.applyDevice !== false,
    gen: state.editGeneration,
    resetEpoch: state.resetEpoch,
    profile: state.editingProfile,
    connected: Boolean(state.connected)
  });
  return true;
}

function scheduleStillColorPersist() {
  if (!state.selectedStillKey || state.mainLightTab !== 'local') return;
  if (!canEditLighting()) return;
  state.stillDirtyKey = state.selectedStillKey;
  const key = state.selectedStillKey;
  const seq = ++state.stillEditSeq;
  if (state.stillEditTimer) clearTimeout(state.stillEditTimer);
  state.stillEditTimer = setTimeout(() => {
    state.stillEditTimer = null;
    if (seq !== state.stillEditSeq) return;
    if (state.stillDirtyKey !== key) return;
    enqueueDirtyStillFrames({ key });
  }, 300);
}

async function runQueuedStillOp() {
  const queued = Array.isArray(state.lightingStillQueue) ? state.lightingStillQueue.shift() : null;
  if (!queued) return;
  if (!state.connected || state.loadInFlight) return;
  if (queued.op === 'frames') {
    if (queued.gen !== state.editGeneration || queued.resetEpoch !== state.resetEpoch) return;
    const identityOk = stillIdentityCurrent(queued);
    const applyDevice = Boolean(queued.applyDevice) && identityOk && state.selectedStillKey === queued.key;
    const captured = stillIdentitySnapshot();
    captured.seq = ++state.lightingOpSeq;
    state.lightingOpInFlight = true;
    let res;
    try {
      res = await api.updateStillFrames({
        key: queued.key,
        colors: queued.colors,
        profileIndex: queued.profile,
        applyDevice,
        expectedKey: queued.key
      });
    } catch (err) {
      res = { success: false, error: err.message || String(err) };
    }
    if (!stillIdentityCurrent(captured) || captured.seq !== state.lightingOpSeq) return;
    state.lightingOpInFlight = false;
    if (res && res.stillLibrary) adoptStillLibrary(res.stillLibrary);
    if (!res || !res.success) {
      showToast(`Couldn’t save still colors: ${(res && res.error) || 'unknown error'}`, 'error');
      renderStillLibrary();
      return;
    }
    renderStillLibrary();
    return;
  }
  if (queued.op !== 'select') return;
  if (!stillIdentityCurrent(queued)) return;
  if (state.selectedStillKey !== queued.key) return;
  const captured = stillIdentitySnapshot();
  captured.seq = ++state.lightingOpSeq;
  state.lightingOpInFlight = true;
  let res;
  try {
    res = await api.selectStill({
      key: queued.key,
      profileIndex: captured.profile,
      applyCustom0: false
    });
  } catch (err) {
    res = { success: false, error: err.message || String(err) };
  }
  if (!stillIdentityCurrent(captured) || captured.seq !== state.lightingOpSeq) return;
  state.lightingOpInFlight = false;
  if (res && res.stillLibrary) {
    adoptStillLibrary(res.stillLibrary, {
      confirmedPair: Array.isArray(res.pair)
        ? res.pair
        : (Array.isArray(res.selectedLightEffect) ? res.selectedLightEffect : undefined)
    });
  } else if (res && Array.isArray(res.pair)) {
    adoptStillLibrary(null, { confirmedPair: res.pair });
  }
  if (!res || !res.success) {
    showToast(`Couldn’t select still: ${(res && res.error) || 'unknown error'}`, 'error');
    renderLightingControls();
    return;
  }
  renderLightingControls();
}

function openStillNameDialog(mode, key) {
  if (!canEditLighting()) return;
  const dialog = document.getElementById('still-name-dialog');
  const input = document.getElementById('still-name-input');
  const title = document.getElementById('still-name-title');
  const confirm = document.getElementById('btn-still-name-confirm');
  const err = document.getElementById('still-name-error');
  if (!dialog || !input) return;
  state.stillNameDialogMode = mode;
  state.stillNameDialogKey = key || null;
  state.stillNameDialogOpener = document.activeElement;
  if (title) title.textContent = mode === 'rename' ? 'Rename' : 'Add Static';
  if (confirm) confirm.textContent = mode === 'rename' ? 'Rename' : 'Add';
  const item = key ? stillItems().find((entry) => entry.key === key) : null;
  input.value = item ? item.name : '';
  if (err) {
    err.hidden = true;
    err.textContent = '';
  }
  dialog.hidden = false;
  input.focus();
  input.select();
}

function closeStillNameDialog() {
  const dialog = document.getElementById('still-name-dialog');
  if (dialog) dialog.hidden = true;
  const opener = state.stillNameDialogOpener;
  state.stillNameDialogMode = null;
  state.stillNameDialogKey = null;
  state.stillNameDialogOpener = null;
  if (opener && typeof opener.focus === 'function') opener.focus();
}

async function confirmStillNameDialog() {
  const input = document.getElementById('still-name-input');
  const err = document.getElementById('still-name-error');
  const name = input ? input.value : '';
  const mode = state.stillNameDialogMode;
  const key = state.stillNameDialogKey;
  const pre = stillIdentitySnapshot();
  const quiet = await waitForLightingWorkerQuiet(pre);
  if (!quiet || !stillIdentityCurrent(pre)) return;
  if (state.stillNameDialogMode !== mode || (mode === 'rename' && state.stillNameDialogKey !== key)) return;
  const captured = stillIdentitySnapshot();
  let res;
  try {
    if (mode === 'rename' && key) {
      res = await api.renameStill({ key, name });
    } else {
      res = await api.createStill(name);
    }
  } catch (error) {
    res = { success: false, error: error.message || String(error) };
  }
  const identityOk = adoptLocalStillResult(res, captured);
  const localSaved = Boolean(res && res.localSaved);
  if (mode === 'rename' && localSaved && !res.success) {
    closeStillNameDialog();
    if (identityOk) {
      showToast((res && res.error) || 'Still was renamed locally. The selected name on the keyboard could not be updated.', 'error', 8000);
      renderLightingControls();
    }
    return;
  }
  if (!res || !res.success) {
    if (err) {
      err.hidden = false;
      err.textContent = (res && res.error) || 'Couldn’t save the still name';
    }
    if (identityOk) {
      showToast(`Couldn’t ${mode === 'rename' ? 'rename' : 'create'} still: ${(res && res.error) || 'unknown error'}`, 'error');
    }
    return;
  }
  if (!identityOk) {
    closeStillNameDialog();
    return;
  }
  closeStillNameDialog();
  if (mode !== 'rename' && res.key) {
    await handleSelectStill(res.key);
  } else {
    renderLightingControls();
  }
}

async function handleSelectStill(key) {
  if (!canEditLighting() || !key) return;
  const prev = state.selectedStillKey;
  cancelStillEditTimer();
  if (prev && prev !== key && state.stillDirtyKey === prev) {
    enqueueDirtyStillFrames({ key: prev, colors: snapshotStillColors(), applyDevice: true });
  }
  state.lightingScope = 'main';
  state.mainLightTab = 'local';
  state.selectedStillKey = key;
  state.selectedGifKey = null;
  const item = stillItems().find((entry) => entry.key === key);
  const lighting = (state.layout && state.layout.lightingEntries) || [];
  for (const zone of lighting) state.stagedKeyColors[zone.slot] = '#000000';
  if (item && item.data) {
    Object.assign(state.stagedKeyColors, stillFrameColors(item));
  }
  if (!stageLightingEdit(restoreMainFromMemory(0))) {
    renderLightingControls();
    return;
  }
  enqueueStillOp({
    op: 'select',
    key,
    gen: state.editGeneration,
    resetEpoch: state.resetEpoch,
    profile: state.editingProfile,
    connected: Boolean(state.connected)
  });
  renderLightingControls();
  renderKeyboard();
}

function stillFrameColors(item) {
  const data = item && item.data && Array.isArray(item.data.frames) ? item.data.frames[0] : null;
  const entries = Array.isArray(data && data.data) ? data.data : [];
  const map = {};
  const lighting = (state.layout && state.layout.lightingEntries) || [];
  const byCode = new Map();
  for (const key of lighting) byCode.set(key.code, key.slot);
  byCode.set(301, 45);
  byCode.set(302, 61);
  byCode.set(1, 85);
  for (const entry of entries) {
    const slot = byCode.get(entry.code);
    if (slot === undefined) continue;
    map[slot] = entry.selectColor || entry.color;
  }
  return map;
}

async function handleDeleteStill(key) {
  if (!canEditLighting() || !key) return;
  const wasSelected = state.selectedStillKey === key;
  const activeKey = state.selectedStillKey;
  if (wasSelected) cancelStillEditTimer();
  if (state.stillDirtyKey === key) state.stillDirtyKey = null;
  state.lightingStillQueue = (state.lightingStillQueue || []).filter((op) => op.key !== key);
  const pre = stillIdentitySnapshot();
  const quiet = await waitForLightingWorkerQuiet(pre);
  if (!quiet || !stillIdentityCurrent(pre) || !canEditLighting()) return;
  const captured = stillIdentitySnapshot();
  let res;
  try {
    res = await api.deleteStill({
      key,
      activeKey,
      profileIndex: captured.profile
    });
  } catch (err) {
    res = { success: false, error: err.message || String(err) };
  }
  const identityOk = adoptLocalStillResult(res, captured, { clearMissingDesired: wasSelected });
  const localSaved = Boolean(res && res.localSaved);
  if (!identityOk) return;
  if (!res || !res.success) {
    showToast(
      (res && res.error) || (localSaved
        ? 'Still was deleted locally. The selected name on the keyboard could not be updated.'
        : 'Couldn’t delete still'),
      'error',
      localSaved ? 8000 : 3000
    );
    renderLightingControls();
    return;
  }
  if (wasSelected) {
    if (res.replacement && res.replacement.key) {
      await handleSelectStill(res.replacement.key);
      return;
    }
    state.selectedStillKey = null;
  }
  renderLightingControls();
}

function renderStillLibrary() {
  const list = document.getElementById('still-library-list');
  const count = document.getElementById('still-library-count');
  const createBtn = document.getElementById('btn-still-create');
  const status = document.getElementById('still-library-status');
  const items = stillItems();
  const remaining = state.stillLibrary ? state.stillLibrary.remaining : Math.max(0, 20 - items.length);
  const err = (state.stillLibrary && state.stillLibrary.error) || '';
  if (count) count.textContent = `${items.length}/20`;
  if (createBtn) createBtn.disabled = !canEditLighting() || remaining <= 0;
  if (status) {
    status.textContent = err;
    status.hidden = !err;
    status.dataset.state = err ? 'error' : '';
  }
  if (!list) return;
  list.replaceChildren();
  const editable = canEditLighting();
  for (const item of items) {
    const wrap = document.createElement('div');
    wrap.className = 'still-tile-wrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'effect-tile still-tile';
    btn.dataset.action = 'select-still';
    btn.dataset.key = item.key;
    btn.textContent = item.name;
    const selected = state.selectedStillKey === item.key;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
    btn.disabled = !editable;
    const actions = document.createElement('div');
    actions.className = 'still-tile-actions';
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.dataset.action = 'rename-still';
    rename.dataset.key = item.key;
    rename.textContent = 'Rename';
    rename.disabled = !editable;
    const del = document.createElement('button');
    del.type = 'button';
    del.dataset.action = 'delete-still';
    del.dataset.key = item.key;
    del.textContent = 'Delete Effect';
    del.disabled = !editable;
    actions.append(rename, del);
    wrap.append(btn, actions);
    list.append(wrap);
  }
}

function gifItems() {
  return (state.gifLibrary && Array.isArray(state.gifLibrary.items)) ? state.gifLibrary.items : [];
}

function selectedGifItem() {
  const key = state.selectedGifKey;
  if (!key) return null;
  return gifItems().find((item) => item.key === key) || null;
}

function gifQueuePending() {
  return Array.isArray(state.lightingGifQueue) && state.lightingGifQueue.length > 0;
}

function matchGifKeyByName(name) {
  const found = gifItems().find((item) => item.name === (name || ''));
  return found ? found.key : null;
}

function adoptGifLibrary(snap, options) {
  const opts = Array.isArray(options)
    ? { confirmedPair: options }
    : (options && typeof options === 'object' ? options : {});
  if (snap && typeof snap === 'object') {
    const items = Array.isArray(snap.items) ? snap.items : [];
    state.gifLibrary = {
      items,
      count: snap.count || items.length,
      max: snap.max || 20,
      remaining: snap.remaining != null ? snap.remaining : Math.max(0, 20 - items.length),
      selectedKey: snap.selectedKey || null,
      selectedPair: Array.isArray(snap.selectedPair) ? snap.selectedPair.slice() : ['gif', ''],
      error: snap.error || null,
      unwritable: Boolean(snap.unwritable)
    };
  }
  if (Array.isArray(opts.confirmedPair)) {
    state.selectedLightEffect = [opts.confirmedPair[0] || 'still', opts.confirmedPair[1] || ''];
    if (state.gifLibrary) {
      if (state.selectedLightEffect[0] === 'gif') {
        state.gifLibrary.selectedPair = state.selectedLightEffect.slice();
        state.gifLibrary.selectedKey = matchGifKeyByName(state.selectedLightEffect[1]);
      } else {
        state.gifLibrary.selectedPair = ['gif', ''];
        state.gifLibrary.selectedKey = null;
      }
    }
  }
  if (opts.desiredKey) {
    state.selectedGifKey = opts.desiredKey;
  } else if (opts.syncUiToConfirmed) {
    state.selectedGifKey = state.selectedLightEffect && state.selectedLightEffect[0] === 'gif'
      ? matchGifKeyByName(state.selectedLightEffect[1] || '')
      : null;
  }
  if (opts.clearMissingDesired && state.selectedGifKey && !gifItems().some((item) => item.key === state.selectedGifKey)) {
    state.selectedGifKey = null;
  }
}

function adoptLocalGifResult(res, captured, extra = {}) {
  const identityOk = stillIdentityCurrent(captured);
  const localSaved = Boolean(res && (res.localSaved || (res.success && res.gifLibrary)));
  if (localSaved && res.gifLibrary) {
    if (identityOk) {
      adoptGifLibrary(res.gifLibrary, {
        confirmedPair: Array.isArray(res.selectedLightEffect) ? res.selectedLightEffect : undefined,
        desiredKey: extra.desiredKey,
        clearMissingDesired: extra.clearMissingDesired
      });
    } else if (state.connected && captured.gen === state.editGeneration && captured.resetEpoch === state.resetEpoch) {
      adoptGifLibrary(res.gifLibrary);
    }
  }
  return identityOk;
}

async function refreshGifLibrary() {
  if (!api.getGifLibrary) return;
  const captured = stillIdentitySnapshot();
  try {
    const snap = await api.getGifLibrary();
    if (!stillIdentityCurrent(captured)) return;
    adoptGifLibrary(snap, { syncUiToConfirmed: !state.selectedGifKey });
    renderGifLibrary();
  } catch {
    // keep last snapshot
  }
}

function enqueueGifOp(op) {
  if (!op || !op.op) return;
  if (!Array.isArray(state.lightingGifQueue)) state.lightingGifQueue = [];
  if (op.op === 'select') {
    state.lightingGifQueue = state.lightingGifQueue.filter((row) => row.op !== 'select');
  }
  state.lightingGifQueue.push(op);
  void runLightingSaveWorker();
}

async function runQueuedGifOp() {
  const queued = Array.isArray(state.lightingGifQueue) ? state.lightingGifQueue.shift() : null;
  if (!queued) return;
  if (!state.connected || state.loadInFlight) return;
  if (queued.op !== 'select') return;
  if (!stillIdentityCurrent(queued)) return;
  if (state.selectedGifKey !== queued.key) return;
  const captured = stillIdentitySnapshot();
  captured.seq = ++state.lightingOpSeq;
  state.lightingOpInFlight = true;
  let res;
  try {
    res = await api.selectGif({
      key: queued.key,
      profileIndex: captured.profile,
      applyCustom0: false
    });
  } catch (err) {
    res = { success: false, error: err.message || String(err) };
  }
  if (!stillIdentityCurrent(captured) || captured.seq !== state.lightingOpSeq) return;
  state.lightingOpInFlight = false;
  if (res && res.gifLibrary) {
    adoptGifLibrary(res.gifLibrary, {
      confirmedPair: Array.isArray(res.pair)
        ? res.pair
        : (Array.isArray(res.selectedLightEffect) ? res.selectedLightEffect : undefined)
    });
  } else if (res && Array.isArray(res.pair)) {
    adoptGifLibrary(null, { confirmedPair: res.pair });
  }
  if (typeof res.isStreaming === 'boolean') state.isStreaming = res.isStreaming;
  else if (res && res.success) state.isStreaming = true;
  if (!res || !res.success) {
    showToast(`Couldn’t select GIF: ${(res && res.error) || 'unknown error'}`, 'error');
    renderLightingControls();
    return;
  }
  renderLightingControls();
}

async function handleSelectGif(key) {
  if (!canEditLighting() || !key) return;
  cancelStillEditTimer();
  if (state.stillDirtyKey) enqueueDirtyStillFrames({ key: state.stillDirtyKey, colors: snapshotStillColors(), applyDevice: true });
  state.lightingScope = 'main';
  state.mainLightTab = 'local';
  state.selectedGifKey = key;
  state.selectedStillKey = null;
  if (!stageLightingEdit(restoreMainFromMemory(0))) {
    renderLightingControls();
    return;
  }
  enqueueGifOp({
    op: 'select',
    key,
    gen: state.editGeneration,
    resetEpoch: state.resetEpoch,
    profile: state.editingProfile,
    connected: Boolean(state.connected)
  });
  renderLightingControls();
}

function openGifNameDialog(mode, key) {
  if (!canEditLighting()) return;
  const dialog = document.getElementById('gif-name-dialog');
  const input = document.getElementById('gif-name-input');
  const title = document.getElementById('gif-name-title');
  const confirm = document.getElementById('btn-gif-name-confirm');
  const err = document.getElementById('gif-name-error');
  if (!dialog || !input) return;
  state.gifNameDialogMode = mode;
  state.gifNameDialogKey = key || null;
  state.gifNameDialogOpener = document.activeElement;
  if (title) title.textContent = mode === 'rename' ? 'Rename GIF' : 'Name GIF';
  if (confirm) confirm.textContent = mode === 'rename' ? 'Rename' : 'Save';
  const item = key ? gifItems().find((entry) => entry.key === key) : null;
  input.value = item ? item.name : '';
  if (err) {
    err.hidden = true;
    err.textContent = '';
  }
  dialog.hidden = false;
  input.focus();
  input.select();
}

function closeGifNameDialog() {
  const dialog = document.getElementById('gif-name-dialog');
  if (dialog) dialog.hidden = true;
  const opener = state.gifNameDialogOpener;
  state.gifNameDialogMode = null;
  state.gifNameDialogKey = null;
  state.gifNameDialogOpener = null;
  if (opener && typeof opener.focus === 'function') opener.focus();
}

async function confirmGifNameDialog() {
  const input = document.getElementById('gif-name-input');
  const err = document.getElementById('gif-name-error');
  const name = input ? input.value : '';
  const mode = state.gifNameDialogMode;
  const key = state.gifNameDialogKey;
  const pre = stillIdentitySnapshot();
  const quiet = await waitForLightingWorkerQuiet(pre);
  if (!quiet || !stillIdentityCurrent(pre)) return;
  if (state.gifNameDialogMode !== mode || (mode === 'rename' && state.gifNameDialogKey !== key)) return;
  const captured = stillIdentitySnapshot();
  let res;
  try {
    res = await api.renameGif({ key, name });
  } catch (error) {
    res = { success: false, error: error.message || String(error) };
  }
  const identityOk = adoptLocalGifResult(res, captured);
  const localSaved = Boolean(res && res.localSaved);
  if (localSaved && !res.success) {
    closeGifNameDialog();
    if (identityOk) {
      showToast((res && res.error) || 'GIF was renamed locally. The selected name on the keyboard could not be updated.', 'error', 8000);
      renderLightingControls();
    }
    return;
  }
  if (!res || !res.success) {
    if (err) {
      err.hidden = false;
      err.textContent = (res && res.error) || 'Couldn’t save the GIF name';
    }
    if (identityOk) {
      showToast(`Couldn’t rename GIF: ${(res && res.error) || 'unknown error'}`, 'error');
    }
    return;
  }
  closeGifNameDialog();
  if (identityOk) renderLightingControls();
}

async function handleDeleteGif(key) {
  if (!canEditLighting() || !key) return;
  const wasSelected = state.selectedGifKey === key;
  const activeKey = state.selectedGifKey;
  state.lightingGifQueue = (state.lightingGifQueue || []).filter((op) => op.key !== key);
  const pre = stillIdentitySnapshot();
  const quiet = await waitForLightingWorkerQuiet(pre);
  if (!quiet || !stillIdentityCurrent(pre) || !canEditLighting()) return;
  const captured = stillIdentitySnapshot();
  let res;
  try {
    res = await api.deleteGif({
      key,
      activeKey,
      profileIndex: captured.profile
    });
  } catch (err) {
    res = { success: false, error: err.message || String(err) };
  }
  const identityOk = adoptLocalGifResult(res, captured, { clearMissingDesired: wasSelected });
  const localSaved = Boolean(res && res.localSaved);
  if (!identityOk) return;
  if (!res || !res.success) {
    showToast(
      (res && res.error) || (localSaved
        ? 'GIF was deleted locally. The selected name on the keyboard could not be updated.'
        : 'Couldn’t delete GIF'),
      'error',
      localSaved ? 8000 : 3000
    );
    renderLightingControls();
    return;
  }
  if (wasSelected) {
    if (res.replacement && res.replacement.key) {
      await handleSelectGif(res.replacement.key);
      return;
    }
    state.selectedGifKey = null;
    state.isStreaming = false;
  }
  renderLightingControls();
}

async function handleImportGifFile(file) {
  if (!canEditLighting() || !file) return;
  if (file.size > 5 * 1024 * 1024) {
    showToast('GIF file size exceeds 5MB limit', 'error');
    return;
  }
  const pre = stillIdentitySnapshot();
  const quiet = await waitForLightingWorkerQuiet(pre);
  if (!quiet || !stillIdentityCurrent(pre) || !canEditLighting()) return;
  const captured = stillIdentitySnapshot();
  let res;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = String(file.name || 'GIF').replace(/\.[Gg][Ii][Ff]$/, '');
    res = await api.importGif({ name, buffer: Array.from(bytes) });
  } catch (err) {
    res = { success: false, error: err.message || String(err) };
  }
  if (!stillIdentityCurrent(captured)) return;
  if (res && res.gifLibrary) adoptGifLibrary(res.gifLibrary);
  if (!res || !res.success) {
    showToast(`Couldn’t import GIF: ${(res && res.error) || 'unknown error'}`, 'error');
    renderLightingControls();
    return;
  }
  showToast(`Imported ${(res.item && res.item.name) || 'GIF'}`, 'success');
  if (res.item && res.item.key) {
    await handleSelectGif(res.item.key);
    void openGifEditor(res.item.key);
  } else {
    renderLightingControls();
  }
}

async function handleGifPlayback(action) {
  if (!canEditLighting()) return;
  let res;
  try {
    res = await api.setGifPlayback(action);
  } catch (err) {
    res = { success: false, error: err.message || String(err) };
  }
  if (res && typeof res.playing === 'boolean') state.isStreaming = res.playing;
  if (!res || !res.success) {
    showToast((res && res.error) || 'GIF playback could not be updated', 'error');
  }
  renderGifLibrary();
}

function lightingFrameSlots() {
  return (state.layout && state.layout.lightingEntries) || [];
}

function gifFrameToSlotMap(frame) {
  const map = {};
  const byCode = new Map();
  for (const key of lightingFrameSlots()) byCode.set(key.code, key.slot);
  byCode.set(301, 45);
  byCode.set(302, 61);
  byCode.set(1, 85);
  const data = frame && Array.isArray(frame.data) ? frame.data : [];
  for (const entry of data) {
    const slot = byCode.get(entry.code);
    if (slot === undefined) continue;
    map[slot] = String(entry.selectColor || entry.color || '#000000').toUpperCase();
  }
  return map;
}

function slotMapToGifFrame(map, duration) {
  const data = [];
  const seen = new Set();
  for (const key of lightingFrameSlots()) {
    let code = key.code;
    if (key.slot === 45) code = 301;
    else if (key.slot === 61) code = 302;
    else if (key.slot === 85) code = 1;
    if (seen.has(code)) continue;
    const hex = map[key.slot];
    if (!hex || hex === '#000000') continue;
    seen.add(code);
    data.push({ code, name: key.name, selectColor: hex });
  }
  return { duration: Number.isFinite(duration) ? duration : 100, data };
}

function stopGifEditorPreview() {
  if (state.gifEditorPreviewTimer) {
    clearTimeout(state.gifEditorPreviewTimer);
    state.gifEditorPreviewTimer = null;
  }
}

function renderGifEditor() {
  const editor = state.gifEditor;
  if (!editor) return;
  const info = document.getElementById('gif-frame-info');
  const duration = document.getElementById('gif-frame-duration');
  const name = document.getElementById('gif-edit-name');
  const grid = document.getElementById('gif-editor-key-grid');
  const err = document.getElementById('gif-editor-error');
  const previewBtn = document.getElementById('btn-gif-preview-toggle');
  if (name && document.activeElement !== name) name.value = editor.name;
  if (info) info.textContent = `Frame ${editor.index + 1} / ${editor.frames.length}`;
  const frame = editor.frames[editor.index] || { duration: 100, data: [] };
  if (duration && document.activeElement !== duration) duration.value = String(frame.duration || 100);
  if (previewBtn) previewBtn.textContent = state.gifEditorPreviewTimer ? 'Stop Preview' : 'Preview';
  if (err) {
    err.hidden = !editor.error;
    err.textContent = editor.error || '';
  }
  if (!grid) return;
  const colors = gifFrameToSlotMap(frame);
  if (grid.childElementCount !== lightingFrameSlots().length) {
    grid.replaceChildren();
    for (const key of lightingFrameSlots()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gif-key-btn';
      btn.dataset.slot = String(key.slot);
      btn.title = key.name;
      btn.textContent = (key.name || '').slice(0, 3);
      btn.addEventListener('click', () => {
        if (!state.gifEditor) return;
        const color = document.getElementById('gif-paint-color')?.value || '#00e5ff';
        const current = state.gifEditor.frames[state.gifEditor.index];
        const map = gifFrameToSlotMap(current);
        map[key.slot] = color.toUpperCase();
        state.gifEditor.frames[state.gifEditor.index] = slotMapToGifFrame(map, current.duration);
        renderGifEditor();
      });
      grid.append(btn);
    }
  }
  Array.from(grid.children).forEach((btn) => {
    const slot = Number(btn.dataset.slot);
    btn.style.background = colors[slot] || '#000000';
  });
}

function openGifEditor(key) {
  const item = gifItems().find((entry) => entry.key === key);
  if (!item) return;
  stopGifEditorPreview();
  const frames = Array.isArray(item.data && item.data.frames) && item.data.frames.length
    ? item.data.frames.map((frame) => ({
      duration: frame.duration != null ? frame.duration : 100,
      data: Array.isArray(frame.data) ? frame.data.map((entry) => ({ ...entry })) : []
    }))
    : [{ duration: 100, data: [] }];
  state.gifEditor = {
    key: item.key,
    name: item.name,
    index: 0,
    frames,
    error: null
  };
  const dialog = document.getElementById('gif-editor-dialog');
  if (dialog) dialog.hidden = false;
  renderGifEditor();
}

function closeGifEditor() {
  stopGifEditorPreview();
  const dialog = document.getElementById('gif-editor-dialog');
  if (dialog) dialog.hidden = true;
  state.gifEditor = null;
}

function readGifEditorDuration() {
  const durationEl = document.getElementById('gif-frame-duration');
  let duration = durationEl ? parseInt(durationEl.value, 10) : 100;
  if (!Number.isFinite(duration) || duration < 16) duration = 16;
  if (duration > 2000) duration = 2000;
  return duration;
}

function commitGifEditorDuration() {
  if (!state.gifEditor) return;
  const frame = state.gifEditor.frames[state.gifEditor.index];
  if (frame) frame.duration = readGifEditorDuration();
}

function shiftGifEditorFrame(delta) {
  if (!state.gifEditor) return;
  commitGifEditorDuration();
  const next = state.gifEditor.index + delta;
  if (next < 0 || next >= state.gifEditor.frames.length) return;
  state.gifEditor.index = next;
  renderGifEditor();
}

function addGifEditorFrame() {
  if (!state.gifEditor) return;
  if (state.gifEditor.frames.length >= 128) {
    state.gifEditor.error = 'GIF frames exceed 128';
    renderGifEditor();
    return;
  }
  commitGifEditorDuration();
  const current = state.gifEditor.frames[state.gifEditor.index];
  const copy = {
    duration: current && current.duration != null ? current.duration : 100,
    data: current && Array.isArray(current.data) ? current.data.map((entry) => ({ ...entry })) : []
  };
  state.gifEditor.frames.splice(state.gifEditor.index + 1, 0, copy);
  state.gifEditor.index += 1;
  renderGifEditor();
}

function deleteGifEditorFrame() {
  if (!state.gifEditor || state.gifEditor.frames.length <= 1) return;
  state.gifEditor.frames.splice(state.gifEditor.index, 1);
  if (state.gifEditor.index >= state.gifEditor.frames.length) {
    state.gifEditor.index = state.gifEditor.frames.length - 1;
  }
  renderGifEditor();
}

function paintGifEditorAll(clear) {
  if (!state.gifEditor) return;
  const color = clear ? '#000000' : (document.getElementById('gif-paint-color')?.value || '#00e5ff');
  const map = {};
  if (!clear) {
    for (const key of lightingFrameSlots()) map[key.slot] = color.toUpperCase();
  }
  const current = state.gifEditor.frames[state.gifEditor.index];
  state.gifEditor.frames[state.gifEditor.index] = slotMapToGifFrame(map, current && current.duration);
  renderGifEditor();
}

function toggleGifEditorPreview() {
  if (!state.gifEditor) return;
  if (state.gifEditorPreviewTimer) {
    stopGifEditorPreview();
    renderGifEditor();
    return;
  }
  commitGifEditorDuration();
  const tick = () => {
    if (!state.gifEditor) return;
    const frame = state.gifEditor.frames[state.gifEditor.index];
    let dur = frame && frame.duration != null ? frame.duration : 100;
    if (dur < 30) dur = 30;
    state.gifEditorPreviewTimer = setTimeout(() => {
      if (!state.gifEditor) return;
      state.gifEditor.index = (state.gifEditor.index + 1) % state.gifEditor.frames.length;
      renderGifEditor();
      tick();
    }, dur);
  };
  renderGifEditor();
  tick();
}

async function saveGifEditor() {
  if (!state.gifEditor || !canEditLighting()) return;
  stopGifEditorPreview();
  commitGifEditorDuration();
  const nameEl = document.getElementById('gif-edit-name');
  const name = nameEl ? nameEl.value : state.gifEditor.name;
  const captured = stillIdentitySnapshot();
  let res;
  try {
    res = await api.updateGif({
      key: state.gifEditor.key,
      updates: {
        name,
        data: {
          dataScope: 'LightingEffectProfile',
          type: 'gif',
          isPreset: false,
          frames: state.gifEditor.frames
        }
      }
    });
  } catch (err) {
    res = { success: false, error: err.message || String(err) };
  }
  if (!stillIdentityCurrent(captured)) return;
  if (res && res.gifLibrary) adoptGifLibrary(res.gifLibrary);
  if (!res || !res.success) {
    if (state.gifEditor) state.gifEditor.error = (res && res.error) || 'Couldn’t save GIF';
    renderGifEditor();
    showToast(`Couldn’t save GIF: ${(res && res.error) || 'unknown error'}`, 'error');
    return;
  }
  closeGifEditor();
  renderLightingControls();
  showToast('GIF animation saved', 'success');
}

function renderGifLibrary() {
  const list = document.getElementById('gif-library-list');
  const count = document.getElementById('gif-library-count');
  const importBtn = document.getElementById('btn-gif-import');
  const status = document.getElementById('gif-library-status');
  const playBtn = document.getElementById('btn-gif-play-pause');
  const stopBtn = document.getElementById('btn-gif-stop');
  const playStatus = document.getElementById('gif-playback-status');
  const items = gifItems();
  const remaining = state.gifLibrary ? state.gifLibrary.remaining : Math.max(0, 20 - items.length);
  const err = (state.gifLibrary && state.gifLibrary.error) || '';
  if (count) count.textContent = `${items.length}/20`;
  if (importBtn) importBtn.disabled = !canEditLighting() || remaining <= 0;
  if (status) {
    status.textContent = err;
    status.hidden = !err;
    status.dataset.state = err ? 'error' : '';
  }
  const selected = selectedGifItem();
  const canPlay = canEditLighting() && Boolean(selected) && state.editingProfile === state.activeProfile && !isLocalPreview();
  if (playBtn) {
    playBtn.disabled = !canPlay;
    playBtn.textContent = state.isStreaming ? 'Pause' : 'Play';
  }
  if (stopBtn) stopBtn.disabled = !canPlay || (!state.isStreaming && !selected);
  if (playStatus) {
    if (!selected) playStatus.textContent = 'No GIF selected';
    else if (state.editingProfile !== state.activeProfile) playStatus.textContent = 'Playback uses the active onboard profile';
    else if (state.isStreaming) playStatus.textContent = `Streaming ${selected.name}`;
    else playStatus.textContent = `${selected.name} paused`;
  }
  if (!list) return;
  list.replaceChildren();
  const editable = canEditLighting();
  for (const item of items) {
    const wrap = document.createElement('div');
    wrap.className = 'gif-tile-wrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'effect-tile gif-tile';
    btn.dataset.action = 'select-gif';
    btn.dataset.key = item.key;
    const label = document.createElement('span');
    label.textContent = item.name;
    const meta = document.createElement('span');
    meta.className = 'gif-tile-meta';
    meta.textContent = `${item.frameCount || (item.data && item.data.frames ? item.data.frames.length : 0)} frames`;
    btn.append(label, meta);
    const isSelected = state.selectedGifKey === item.key;
    btn.classList.toggle('active', isSelected);
    btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    btn.disabled = !editable;
    const actions = document.createElement('div');
    actions.className = 'gif-tile-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.dataset.action = 'edit-gif';
    edit.dataset.key = item.key;
    edit.textContent = 'Edit';
    edit.disabled = !editable;
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.dataset.action = 'rename-gif';
    rename.dataset.key = item.key;
    rename.textContent = 'Rename';
    rename.disabled = !editable;
    const del = document.createElement('button');
    del.type = 'button';
    del.dataset.action = 'delete-gif';
    del.dataset.key = item.key;
    del.textContent = 'Delete';
    del.disabled = !editable;
    actions.append(edit, rename, del);
    wrap.append(btn, actions);
    list.append(wrap);
  }
}

function selectCustomLighting() {
  setMainLightTab('local');
}

function selectMainEffect(id) {
  if (!canEditLighting()) return;
  if (!Number.isInteger(id) || !findMainEffect(id)) return;
  state.lightingScope = 'main';
  state.mainLightTab = 'normal';
  if (!stageLightingEdit(restoreMainFromMemory(id))) return;
  renderLightingControls();
}

function selectSideEffect(id) {
  if (!canEditLighting()) return;
  if (!Number.isInteger(id) || !findSideEffect(id)) return;
  state.lightingScope = 'side';
  if (!stageLightingEdit(restoreSideFromMemory(id))) return;
  renderLightingControls();
}

/**
 * Render Lighting Controls
 */
function renderLightingControls() {
  const cat = lightingCatalog();
  const mainPresets = cat.mainPresetOrder
    .map((id) => findMainEffect(id))
    .filter(Boolean);
  const sidePresets = cat.sideOrder
    .map((id) => findSideEffect(id))
    .filter(Boolean);

  const editable = canEditLighting();
  const mainGrid = document.getElementById('main-effect-grid');
  const sideGrid = document.getElementById('side-effect-grid');
  const scopeMain = state.lightingScope !== 'side';
  if (mainGrid) mainGrid.hidden = !scopeMain;
  if (sideGrid) sideGrid.hidden = scopeMain;
  const mainSelected = scopeMain && findMainEffect(state.lighting.effect) && state.lighting.effect !== 0
    ? state.lighting.effect
    : null;
  const sideSelected = !scopeMain && findSideEffect(state.lighting.sideEffect)
    ? state.lighting.sideEffect
    : null;
  fillEffectGrid(mainGrid, mainPresets, mainSelected, 'select-light-effect', editable && scopeMain);
  fillEffectGrid(sideGrid, sidePresets, sideSelected, 'select-side-effect', editable && !scopeMain);

  const mainTab = document.getElementById('light-scope-main');
  const sideTab = document.getElementById('light-scope-side');
  if (mainTab) {
    mainTab.classList.toggle('active', scopeMain);
    mainTab.setAttribute('aria-selected', String(scopeMain));
  }
  if (sideTab) {
    sideTab.classList.toggle('active', !scopeMain);
    sideTab.setAttribute('aria-selected', String(!scopeMain));
  }

  const caps = currentLightingCaps();
  const localTab = scopeMain && state.mainLightTab === 'local';
  const selectedStill = selectedStillItem();
  const selectedGif = selectedGifItem();
  const isCustom = localTab && Boolean(selectedStill) && !selectedGif && state.lighting.effect === 0 && caps.known;
  const customBtn = document.getElementById('btn-custom-lighting');
  const customHint = document.getElementById('custom-lighting-hint');
  const customPanel = document.getElementById('custom-lighting-panel');
  const mainTabs = document.getElementById('lighting-main-tabs');
  const stillSection = document.getElementById('still-library-section');
  const gifSection = document.getElementById('gif-library-section');
  const gifHint = document.getElementById('gif-library-hint');
  const normalTab = document.getElementById('light-main-tab-normal');
  if (mainTabs) mainTabs.hidden = !scopeMain;
  if (normalTab) {
    normalTab.classList.toggle('active', scopeMain && !localTab);
    normalTab.setAttribute('aria-selected', String(scopeMain && !localTab));
    normalTab.disabled = !editable || !scopeMain;
  }
  if (customBtn) {
    customBtn.hidden = !scopeMain;
    customBtn.classList.toggle('active', localTab);
    customBtn.setAttribute('aria-pressed', localTab ? 'true' : 'false');
    customBtn.setAttribute('aria-selected', String(localTab));
    customBtn.disabled = !editable || !scopeMain;
  }
  if (customHint) customHint.hidden = !scopeMain;
  if (stillSection) stillSection.hidden = !localTab;
  if (gifSection) gifSection.hidden = !localTab;
  if (gifHint) gifHint.hidden = true;
  if (mainGrid) mainGrid.hidden = !scopeMain || localTab;
  if (customPanel) customPanel.hidden = !isCustom;
  renderStillLibrary();
  renderGifLibrary();

  const unrecognized = document.getElementById('lighting-unrecognized');
  if (unrecognized) unrecognized.hidden = caps.known;

  setGroupAvailable('main-brightness-group', ['light-brightness-slider'], editable && scopeMain && caps.known && caps.brightness);
  setGroupAvailable('main-speed-group', ['light-speed-slider'], editable && scopeMain && caps.known && caps.speed);
  setGroupAvailable('main-direction-group', ['btn-dir-left', 'btn-dir-right'], editable && scopeMain && caps.known && Boolean(caps.direction));
  setGroupAvailable('side-brightness-group', ['side-brightness-slider'], editable && !scopeMain && caps.known && caps.brightness);
  setGroupAvailable('side-speed-group', ['side-speed-slider'], editable && !scopeMain && caps.known && caps.speed);

  const mainColorGroup = document.getElementById('main-color-group');
  const sideColorGroup = document.getElementById('side-color-group');
  if (mainColorGroup) mainColorGroup.hidden = !(scopeMain && caps.known && caps.color);
  if (sideColorGroup) sideColorGroup.hidden = !(!scopeMain && caps.known && caps.color);
  const mainToggleOn = editable && scopeMain && caps.known && caps.color;
  const sideToggleOn = editable && !scopeMain && caps.known && caps.color;
  const mainPickerOn = mainToggleOn && !state.lighting.customColorDisabled;
  const sidePickerOn = sideToggleOn && !state.lighting.sideCustomColorDisabled;
  const mainToggle = document.getElementById('light-custom-color-toggle');
  const sideToggle = document.getElementById('side-custom-color-toggle');
  if (mainToggle) mainToggle.disabled = !mainToggleOn;
  if (sideToggle) sideToggle.disabled = !sideToggleOn;
  for (const id of ['light-color-input', 'light-color-hex']) {
    const el = document.getElementById(id);
    if (el) el.disabled = !mainPickerOn;
  }
  for (const id of ['side-color-input', 'side-color-hex']) {
    const el = document.getElementById(id);
    if (el) el.disabled = !sidePickerOn;
  }
  document.querySelectorAll('#main-color-group .color-dot').forEach((dot) => {
    dot.disabled = !mainPickerOn;
  });

  const brightnessSlider = document.getElementById('light-brightness-slider');
  const brightnessVal = document.getElementById('light-brightness-val');
  const speedSlider = document.getElementById('light-speed-slider');
  const speedVal = document.getElementById('light-speed-val');
  const colorInput = document.getElementById('light-color-input');
  const colorHex = document.getElementById('light-color-hex');
  const sideBrightnessSlider = document.getElementById('side-brightness-slider');
  const sideBrightnessVal = document.getElementById('side-brightness-val');
  const sideSpeedSlider = document.getElementById('side-speed-slider');
  const sideSpeedVal = document.getElementById('side-speed-val');
  const sideColorInput = document.getElementById('side-color-input');
  const sideColorHex = document.getElementById('side-color-hex');

  if (brightnessSlider) brightnessSlider.value = state.lighting.brightness !== undefined ? state.lighting.brightness : 100;
  if (brightnessVal) brightnessVal.textContent = `${state.lighting.brightness ?? 100}%`;
  if (speedSlider) speedSlider.value = state.lighting.speed !== undefined ? state.lighting.speed : 4;
  if (speedVal) speedVal.textContent = String(state.lighting.speed !== undefined ? state.lighting.speed : 4);
  if (colorInput) colorInput.value = state.lighting.hexColor || '#00E5FF';
  if (colorHex) colorHex.value = state.lighting.hexColor || '#00E5FF';
  if (sideBrightnessSlider) sideBrightnessSlider.value = state.lighting.sideBrightness !== undefined ? state.lighting.sideBrightness : 80;
  if (sideBrightnessVal) sideBrightnessVal.textContent = `${state.lighting.sideBrightness ?? 80}%`;
  if (sideSpeedSlider) sideSpeedSlider.value = state.lighting.sideSpeed !== undefined ? state.lighting.sideSpeed : 4;
  if (sideSpeedVal) sideSpeedVal.textContent = String(state.lighting.sideSpeed !== undefined ? state.lighting.sideSpeed : 4);
  if (sideColorInput) sideColorInput.value = state.lighting.sideHexColor || '#00E5FF';
  if (sideColorHex) sideColorHex.value = state.lighting.sideHexColor || '#00E5FF';

  const customToggle = document.getElementById('light-custom-color-toggle');
  if (customToggle) customToggle.checked = !state.lighting.customColorDisabled;
  const sideCustomToggle = document.getElementById('side-custom-color-toggle');
  if (sideCustomToggle) sideCustomToggle.checked = !state.lighting.sideCustomColorDisabled;

  const pair = caps.direction ? cat.directionPairs[caps.direction] : null;
  const leftBtn = document.getElementById('btn-dir-left');
  const rightBtn = document.getElementById('btn-dir-right');
  if (pair && leftBtn) leftBtn.textContent = pair[0] || pair['0'] || leftBtn.textContent;
  if (pair && rightBtn) rightBtn.textContent = pair[1] || pair['1'] || rightBtn.textContent;
  setLightingDirection(state.lighting.direction || 0, false);

  const cal = state.lighting.calibrationRgb || { r: 255, g: 255, b: 255 };
  for (const ch of ['r', 'g', 'b']) {
    const slider = document.getElementById(`cal-${ch}`);
    const val = document.getElementById(`cal-${ch}-val`);
    if (slider) {
      slider.value = String(cal[ch]);
      slider.disabled = !editable;
    }
    if (val) val.textContent = String(cal[ch]);
  }
  const calBtn = document.getElementById('btn-apply-calibration');
  if (calBtn) calBtn.disabled = !editable;
  const paintBtns = ['set-selected-key-color', 'fill-all-key-colors', 'clear-all-key-colors', 'read-key-colors'];
  document.querySelectorAll('#custom-lighting-panel [data-action]').forEach((btn) => {
    if (paintBtns.includes(btn.dataset.action) && btn.dataset.action !== 'read-key-colors') {
      btn.disabled = !canEditKeyColors();
    }
  });
  renderLightingMemoryPref();
  renderLightingSaveStatus();
}

function setLightingDirection(dir, updateState = true) {
  const leftBtn = document.getElementById('btn-dir-left');
  const rightBtn = document.getElementById('btn-dir-right');
  if (updateState) {
    if (!canEditLighting()) return;
    if ((leftBtn && leftBtn.disabled) || (rightBtn && rightBtn.disabled)) return;
    if (!stageLightingEdit({ direction: dir ? 1 : 0 })) return;
  }
  if (leftBtn) {
    leftBtn.classList.toggle('active', dir === 0);
    leftBtn.setAttribute('aria-pressed', dir === 0 ? 'true' : 'false');
  }
  if (rightBtn) {
    rightBtn.classList.toggle('active', dir === 1);
    rightBtn.setAttribute('aria-pressed', dir === 1 ? 'true' : 'false');
  }
}

function attachLightingListeners() {
  const brightnessSlider = document.getElementById('light-brightness-slider');
  const speedSlider = document.getElementById('light-speed-slider');
  const colorInput = document.getElementById('light-color-input');
  const colorHex = document.getElementById('light-color-hex');
  const customToggle = document.getElementById('light-custom-color-toggle');

  const sideBrightnessSlider = document.getElementById('side-brightness-slider');
  const sideSpeedSlider = document.getElementById('side-speed-slider');
  const sideColorInput = document.getElementById('side-color-input');
  const sideColorHex = document.getElementById('side-color-hex');
  const sideCustomToggle = document.getElementById('side-custom-color-toggle');

  if (brightnessSlider) brightnessSlider.addEventListener('input', () => {
    if (brightnessSlider.disabled || !canEditLighting()) return;
    if (!stageLightingEdit({ brightness: parseInt(brightnessSlider.value, 10) })) return;
    const val = document.getElementById('light-brightness-val');
    if (val) val.textContent = `${state.lighting.brightness}%`;
  });
  if (speedSlider) speedSlider.addEventListener('input', () => {
    if (speedSlider.disabled || !canEditLighting()) return;
    if (!stageLightingEdit({ speed: parseInt(speedSlider.value, 10) })) return;
    const val = document.getElementById('light-speed-val');
    if (val) val.textContent = String(state.lighting.speed);
  });
  if (customToggle) customToggle.addEventListener('change', () => {
    if (customToggle.disabled || !canEditLighting()) return;
    if (!currentLightingCaps().color || state.lightingScope === 'side') return;
    if (!stageLightingEdit({ customColorDisabled: !customToggle.checked })) return;
    renderLightingControls();
  });
  if (colorInput) colorInput.addEventListener('input', () => {
    if (colorInput.disabled || !canEditLighting() || state.lighting.customColorDisabled) return;
    if (!currentLightingCaps().color || state.lightingScope === 'side') return;
    if (!stageLightingEdit({ hexColor: colorInput.value })) return;
    if (colorHex) colorHex.value = colorInput.value;
  });
  if (colorHex) colorHex.addEventListener('change', () => {
    if (colorHex.disabled || !canEditLighting() || state.lighting.customColorDisabled) return;
    if (!currentLightingCaps().color || state.lightingScope === 'side') return;
    if (!/^#[0-9A-Fa-f]{6}$/.test(colorHex.value)) return;
    if (!stageLightingEdit({ hexColor: colorHex.value })) return;
    if (colorInput) colorInput.value = colorHex.value;
  });

  if (sideBrightnessSlider) sideBrightnessSlider.addEventListener('input', () => {
    if (sideBrightnessSlider.disabled || !canEditLighting()) return;
    if (!stageLightingEdit({ sideBrightness: parseInt(sideBrightnessSlider.value, 10) })) return;
    const val = document.getElementById('side-brightness-val');
    if (val) val.textContent = `${state.lighting.sideBrightness}%`;
  });
  if (sideSpeedSlider) sideSpeedSlider.addEventListener('input', () => {
    if (sideSpeedSlider.disabled || !canEditLighting()) return;
    if (!stageLightingEdit({ sideSpeed: parseInt(sideSpeedSlider.value, 10) })) return;
    const val = document.getElementById('side-speed-val');
    if (val) val.textContent = String(state.lighting.sideSpeed);
  });
  if (sideCustomToggle) sideCustomToggle.addEventListener('change', () => {
    if (sideCustomToggle.disabled || !canEditLighting()) return;
    if (!currentLightingCaps().color || state.lightingScope !== 'side') return;
    if (!stageLightingEdit({ sideCustomColorDisabled: !sideCustomToggle.checked })) return;
    renderLightingControls();
  });
  if (sideColorInput) sideColorInput.addEventListener('input', () => {
    if (sideColorInput.disabled || !canEditLighting() || state.lighting.sideCustomColorDisabled) return;
    if (!currentLightingCaps().color || state.lightingScope !== 'side') return;
    if (!stageLightingEdit({ sideHexColor: sideColorInput.value })) return;
    if (sideColorHex) sideColorHex.value = sideColorInput.value;
  });
  if (sideColorHex) sideColorHex.addEventListener('change', () => {
    if (sideColorHex.disabled || !canEditLighting() || state.lighting.sideCustomColorDisabled) return;
    if (!currentLightingCaps().color || state.lightingScope !== 'side') return;
    if (!/^#[0-9A-Fa-f]{6}$/.test(sideColorHex.value)) return;
    if (!stageLightingEdit({ sideHexColor: sideColorHex.value })) return;
    if (sideColorInput) sideColorInput.value = sideColorHex.value;
  });

  const gifFile = document.getElementById('gif-file-input');
  if (gifFile) {
    gifFile.addEventListener('change', () => {
      const file = gifFile.files && gifFile.files[0];
      gifFile.value = '';
      if (file) void handleImportGifFile(file);
    });
  }
  const gifDuration = document.getElementById('gif-frame-duration');
  if (gifDuration) {
    gifDuration.addEventListener('change', () => {
      commitGifEditorDuration();
    });
  }
}

/**
 * Handle Read Lighting from Device
 */
async function handleReadLighting() {
  if (!state.connected || state.loadInFlight) return;
  state.lightingReadQueued = true;
  void runLightingSaveWorker();
}

function handleApplyLighting() {
  handleRetryLightingSave();
}

function handleRetryLightingSave() {
  if (!state.connected || state.loadInFlight || !state.hasReadLighting) return;
  const retryMemory = state.lightingMemoryBlocked;
  state.lightingSaveBlocked = false;
  state.lightingMemoryBlocked = false;
  state.lightingMemoryError = null;
  state.lightingSaveError = null;
  state.lightingSaveStatus = 'saving';
  if (!LightingAutosave.hasDirty(state.lightingEdited) && retryMemory) {
    const fields = {};
    if (Number.isInteger(state.lighting.brightness)) fields.brightness = state.lighting.brightness;
    else if (findMainEffect(state.lighting.effect)) fields.effect = state.lighting.effect;
    if (Object.keys(fields).length) {
      state.lightingEdited = LightingAutosave.markEdited(state.lightingEdited, fields);
      state.lightingDraftDirty = true;
    }
  }
  renderLightingSaveStatus();
  scheduleLightingSave(0);
}

/**
 * Handle Read Per-Key Colors from Device (CMD 10)
 */
async function handleReadKeyColors() {
  const captured = { gen: state.editGeneration, resetEpoch: state.resetEpoch, profile: state.editingProfile };
  showToast('Reading per-key RGB colors from keyboard (CMD 10)…', 'info');
  try {
    const res = await api.readKeyColors(captured.profile);
    if (!requestStillCurrent(captured)) return;
    if (res.success && Array.isArray(res.colors)) {
      for (const c of res.colors) {
        state.stagedKeyColors[c.index] = c.hex;
      }
      state.hasReadKeyColors = true;
      updateApplyButtonsState();
      renderKeyboard();
      showToast(`Read ${res.colors.length} per-key RGB color slots from hardware!`, 'success');
    } else {
      state.hasReadKeyColors = false;
      updateApplyButtonsState();
      showToast(`Failed to read per-key RGB: ${res.error}`, 'error');
    }
  } catch (err) {
    if (!requestStillCurrent(captured)) return;
    showToast(`Error reading per-key RGB: ${err.message}`, 'error');
  }
}

/**
 * Handle Apply Per-Key Colors to Device (CMD 11)
 * Sends changed patches only (Item 10) to preserve split space zones (45, 53, 61) and unedited keys.
 */
async function handleApplyKeyColors() {
  if (isLocalPreview()) {
    const res = await persistLocalDraft();
    showToast(res.success ? 'Saved to custom profile (keyboard not written).' : res.error, res.success ? 'success' : 'error');
    return;
  }
  if (state.loadInFlight) return;
  const captured = { gen: state.editGeneration, resetEpoch: state.resetEpoch, profile: state.editingProfile };
  const patches = Object.keys(state.changedKeyColors).length > 0 ? state.changedKeyColors : state.stagedKeyColors;
  if (Object.keys(patches).length === 0) {
    showToast('No key color changes to apply.', 'info');
    return;
  }
  showToast('Uploading per-key RGB colors to keyboard flash (CMD 11)…', 'info');
  try {
    const res = await api.applyKeyColors(captured.profile, patches);
    if (!requestStillCurrent(captured)) return;
    if (res.success) {
      state.changedKeyColors = {};
      state.hasReadKeyColors = true;
      updateApplyButtonsState();
      showToast('Per-key RGB colors successfully uploaded and verified!', 'success');
    } else {
      showToast(`Failed to apply per-key RGB: ${res.error}`, 'error');
    }
  } catch (err) {
    if (!requestStillCurrent(captured)) return;
    showToast(`Error applying per-key RGB: ${err.message}`, 'error');
  }
}

function handleSetSelectedKeyColor() {
  if (!canEditKeyColors()) return;
  if (!state.selectedKey) {
    showToast('Please select a key on the visual keyboard first.', 'warning');
    return;
  }
  const colorInput = document.getElementById('perkey-color-input');
  const color = colorInput?.value || '#00E5FF';
  state.stagedKeyColors[state.selectedKey.slot] = color;
  state.changedKeyColors[state.selectedKey.slot] = color;
  updateApplyButtonsState();
  renderKeyboard();
  scheduleStillColorPersist();
  showToast(`Painted ${state.selectedKey.name} (Slot ${state.selectedKey.slot}) with ${color}`, 'info', 1500);
}

function handleFillAllKeyColors() {
  if (!canEditKeyColors()) return;
  const colorInput = document.getElementById('perkey-color-input');
  const color = colorInput?.value || '#00E5FF';
  const entries = state.layout?.lightingEntries || state.layout?.keys || [];
  for (const k of entries) {
    state.stagedKeyColors[k.slot] = color;
    state.changedKeyColors[k.slot] = color;
  }
  updateApplyButtonsState();
  renderKeyboard();
  scheduleStillColorPersist();
  showToast(`Filled all keys with ${color}`, 'info', 1500);
}

function handleClearAllKeyColors() {
  if (!canEditKeyColors()) return;
  const entries = state.layout?.lightingEntries || state.layout?.keys || [];
  for (const k of entries) {
    state.stagedKeyColors[k.slot] = '#000000';
    state.changedKeyColors[k.slot] = '#000000';
  }
  updateApplyButtonsState();
  renderKeyboard();
  scheduleStillColorPersist();
  showToast('Cleared all keys to black (#000000)', 'info', 1500);
}

function ensureMacroSlotsDisplay() {
  if (state.stagedMacros.length === 0) {
    state.stagedMacros = MacroDraft.emptySlots();
  }
}

function ensureMacrosEditable() {
  if (state.loadInFlight) {
    showToast('Wait for the current device read to finish before editing macros.', 'warning');
    return false;
  }
  if (!state.hasReadMacros) {
    showToast('Read macros from the keyboard before editing. Drafts start from the shared 16-slot memory.', 'warning');
    return false;
  }
  if (state.isRecordingMacro) pauseMacroRecording('edit');
  return true;
}

function recordingSlotIndex() {
  if (Number.isInteger(state.macroRecordingSlot)) return state.macroRecordingSlot;
  return state.activeMacroSlot;
}

function captureSurface() {
  return document.getElementById('macro-capture-surface');
}

function captureIsFocused() {
  const el = captureSurface();
  if (!el) return false;
  const active = document.activeElement;
  return active === el || (el.contains && el.contains(active));
}

function activeRecordPrefs() {
  const m = slotMeta(recordingSlotIndex());
  return {
    enableDefaultDelay: Boolean(m.enableDefaultDelay),
    defaultDelay: m.defaultDelay
  };
}

function syncMacroRecordControls() {
  const recBtn = document.getElementById('btn-record-macro');
  const badge = document.getElementById('macro-recording-badge');
  const slot = state.stagedMacros[state.activeMacroSlot];
  const count = slot?.actions?.length || 0;
  if (recBtn) {
    if (state.isRecordingMacro) {
      recBtn.textContent = 'Pause';
      recBtn.classList.remove('warning-subtle');
      recBtn.classList.add('danger-subtle');
    } else {
      recBtn.textContent = count > 0 ? 'Resume' : 'Record';
      recBtn.classList.remove('danger-subtle');
      recBtn.classList.add('warning-subtle');
    }
  }
  if (badge) {
    badge.hidden = !state.isRecordingMacro;
    badge.textContent = 'Recording…';
  }
  const cap = captureSurface();
  if (cap) cap.hidden = !state.isRecordingMacro;
  const toolbar = document.querySelector('.macro-edit-toolbar');
  if (toolbar) toolbar.dataset.recording = state.isRecordingMacro ? 'true' : 'false';
  const prefs = slotMeta(state.activeMacroSlot);
  const delayCheck = document.getElementById('macro-standard-delay');
  const delayMs = document.getElementById('macro-standard-delay-ms');
  if (delayCheck) {
    delayCheck.checked = Boolean(prefs.enableDefaultDelay);
    delayCheck.disabled = state.isRecordingMacro;
  }
  if (delayMs && document.activeElement !== delayMs) {
    delayMs.value = String(prefs.defaultDelay);
    delayMs.disabled = !prefs.enableDefaultDelay || state.isRecordingMacro;
  }
  fillMacroPaletteSelects();
}

/**
 * Render Hardware Macro Studio
 */
function renderMacros() {
  const slotsList = document.getElementById('macro-slots-list');
  const keySelect = document.getElementById('macro-new-key');
  if (!slotsList) return;

  ensureMacroSlotsDisplay();

  slotsList.replaceChildren();
  state.stagedMacros.forEach((slot, idx) => {
    const btn = document.createElement('button');
    btn.className = `macro-slot-btn ${idx === state.activeMacroSlot ? 'active' : ''}`;
    const count = slot.actions ? slot.actions.length : 0;
    const num = document.createElement('span');
    num.className = 'slot-num';
    num.textContent = String(idx + 1).padStart(2, '0');
    const name = document.createElement('span');
    name.className = 'slot-name';
    name.textContent = slot.name || `Macro ${idx + 1}`;
    const badge = document.createElement('span');
    badge.className = 'slot-count badge badge-subtle';
    badge.textContent = String(count);
    btn.append(num, name, badge);
    btn.addEventListener('click', () => {
      if (state.isRecordingMacro) haltMacroRecording('slot-change');
      persistActiveSlotPrefsFromControls();
      state.activeMacroSlot = idx;
      state.macroSelectedActionIndex = null;
      renderMacros();
    });
    slotsList.append(btn);
  });

  fillMacroPaletteSelects();

  const nameInput = document.getElementById('macro-name-input');
  const slot = state.stagedMacros[state.activeMacroSlot];
  if (nameInput && slot && document.activeElement !== nameInput) {
    nameInput.value = slot.name || `Macro ${slot.id + 1}`;
  }

  syncMacroRecordControls();
  renderMacroActions();
}

/**
 * Render Actions for currently active macro slot
 */
function renderMacroActions() {
  const title = document.getElementById('macro-editor-title');
  const tbody = document.getElementById('macro-actions-tbody');
  const emptyState = document.getElementById('macro-empty-state');
  if (!tbody || !emptyState) return;

  const slot = state.stagedMacros[state.activeMacroSlot];
  if (title) title.textContent = `${slot.name || `Macro ${slot.id + 1}`}`;

  const playbackSelect = document.getElementById('macro-playback-type');
  if (playbackSelect && slot) {
    playbackSelect.value = String(slot.type !== undefined ? slot.type : 0);
    playbackSelect.disabled = state.isRecordingMacro;
  }

  const focusDelayIdx = document.activeElement?.classList?.contains('macro-delay-input')
    ? parseInt(document.activeElement.dataset.index, 10)
    : NaN;

  tbody.replaceChildren();

  if (!slot.actions || slot.actions.length === 0) {
    emptyState.hidden = false;
    return;
  }

  emptyState.hidden = true;

  slot.actions.forEach((act, idx) => {
    const tr = document.createElement('tr');
    if (idx === state.macroSelectedActionIndex) tr.className = 'selected';
    tr.addEventListener('click', (ev) => {
      if (ev.target && ev.target.closest('input, select, button')) return;
      state.macroSelectedActionIndex = idx;
      renderMacroActions();
    });

    const tdIdx = document.createElement('td');
    tdIdx.textContent = String(idx + 1);

    const tdType = document.createElement('td');
    const typeBadge = document.createElement('span');
    typeBadge.className = `action-type-badge ${act.action}`;
    typeBadge.textContent = act.action.toUpperCase();
    tdType.append(typeBadge);

    const tdKey = document.createElement('td');
    tdKey.textContent = getActionKeyLabel(act);

    const tdDelay = document.createElement('td');
    const delayInput = document.createElement('input');
    delayInput.type = 'number';
    delayInput.className = 'form-input inline macro-delay-input';
    delayInput.min = '0';
    delayInput.max = '65535';
    delayInput.value = String(act.delay || 0);
    delayInput.dataset.index = String(idx);
    delayInput.addEventListener('click', (ev) => ev.stopPropagation());
    delayInput.addEventListener('change', () => {
      if (!ensureMacrosEditable()) return;
      const next = parseInt(delayInput.value, 10);
      if (!Number.isInteger(next) || next < 0 || next > 65535) {
        delayInput.value = String(act.delay || 0);
        return;
      }
      const slot = state.stagedMacros[state.activeMacroSlot];
      if (!slot || !slot.actions) return;
      const candidate = MacroDraft.deepCopyActions(slot.actions);
      candidate[idx].delay = next;
      if (!MacroDraft.canMutateSlot(state.stagedMacros, state.activeMacroSlot, candidate)) {
        delayInput.value = String(act.delay || 0);
        showToast('Changing delay would exceed the 8192-byte macro region.', 'error');
        return;
      }
      act.delay = next;
      state.macroSelectedActionIndex = idx;
      updateApplyButtonsState();
    });
    tdDelay.append(delayInput);

    tr.append(tdIdx, tdType, tdKey, tdDelay);
    tbody.append(tr);
    if (idx === focusDelayIdx) delayInput.focus();
  });
}

function fillMacroPaletteSelects() {
  const typeSelect = document.getElementById('macro-new-type');
  const keySelect = document.getElementById('macro-new-key');
  if (!keySelect) return;
  const kind = typeSelect?.value || 'keydown';
  const mouse = kind === 'mousedown' || kind === 'mouseup';
  const current = keySelect.value;
  keySelect.replaceChildren();
  if (mouse) {
    for (const b of MacroDraft.MACRO_MOUSE_BUTTONS) {
      const opt = document.createElement('option');
      opt.value = String(b.code);
      opt.textContent = b.label;
      keySelect.append(opt);
    }
  } else if (state.layout?.remapCategories) {
    const activeCategories = getActiveRemapCategories() || state.layout.remapCategories;
    const allRemapKeys = Object.values(activeCategories).flat();
    const seenCodes = new Set();
    for (const k of allRemapKeys) {
      if (!MacroDraft.isMacroKeyboardItem(k)) continue;
      if (seenCodes.has(k.code)) continue;
      seenCodes.add(k.code);
      const opt = document.createElement('option');
      opt.value = String(k.code);
      opt.textContent = k.label;
      keySelect.append(opt);
    }
  }
  if (current && Array.from(keySelect.options).some((o) => o.value === current)) {
    keySelect.value = current;
  }
}

function getActionKeyLabel(act) {
  if (act.action === 'mousedown' || act.action === 'mouseup') {
    return MacroDraft.mouseLabel(act.code);
  }

  // Look up key label from layout categories
  const activeCategories = getActiveRemapCategories() || state.layout?.remapCategories;
  if (activeCategories) {
    for (const cat of Object.values(activeCategories)) {
      const match = cat.find(k => k.code === act.code);
      if (match) return match.label;
    }
  }
  return `Key ${act.code}`;
}

function appendMacroActions(slot, incoming) {
  if (!slot) return false;
  if (!Array.isArray(slot.actions)) slot.actions = [];
  const candidate = slot.actions.concat(incoming);
  if (!MacroDraft.canMutateSlot(state.stagedMacros, state.activeMacroSlot, candidate)) {
    showToast('Macro storage is full (8192-byte shared region).', 'error');
    return false;
  }
  for (let i = 0; i < incoming.length; i++) {
    slot.actions.push(incoming[i]);
  }
  return true;
}

function persistActiveSlotPrefsFromControls() {
  const m = slotMeta(state.activeMacroSlot);
  const delayCheck = document.getElementById('macro-standard-delay');
  const delayMs = document.getElementById('macro-standard-delay-ms');
  if (delayCheck) m.enableDefaultDelay = delayCheck.checked;
  if (delayMs) m.defaultDelay = MacroDraft.clampMacroDelay(delayMs.value);
  const nameInput = document.getElementById('macro-name-input');
  if (nameInput) {
    m.name = MacroDraft.sanitizeName(nameInput.value);
    state.localMacroNames[state.activeMacroSlot] = m.name;
    const slot = state.stagedMacros[state.activeMacroSlot];
    if (slot) slot.name = m.name;
  }
  persistMacroMetadata();
}

/**
 * Add Action to active macro slot
 */
function handleAddMacroAction() {
  if (!ensureMacrosEditable()) return;
  const typeSelect = document.getElementById('macro-new-type');
  const keySelect = document.getElementById('macro-new-key');
  const delayInput = document.getElementById('macro-new-delay');

  const actionType = typeSelect?.value || 'keypress';
  const code = parseInt(keySelect?.value || '4', 10);
  const delay = MacroDraft.clampMacroDelay(delayInput?.value || '20');

  const slot = state.stagedMacros[state.activeMacroSlot];
  if (!slot) return;

  const res = MacroDraft.buildMacroActionsFromSelection({ actionType, code, delay });
  if (!res.valid) {
    showToast(res.error, 'warning');
    return;
  }

  if (!appendMacroActions(slot, res.actions)) return;
  state.macroSelectedActionIndex = slot.actions.length - 1;
  updateApplyButtonsState();
  renderMacros();
  showToast(`Added action to Macro ${state.activeMacroSlot + 1}`, 'info', 1500);
}

function handleRemoveMacroAction(idx) {
  if (!ensureMacrosEditable()) return;
  const slot = state.stagedMacros[state.activeMacroSlot];
  if (!slot || !slot.actions) return;
  const at = Number.isInteger(idx) ? idx : state.macroSelectedActionIndex;
  if (!Number.isInteger(at) || at < 0 || at >= slot.actions.length) {
    showToast('Select an action to delete.', 'warning');
    return;
  }
  const candidate = slot.actions.slice();
  candidate.splice(at, 1);
  if (!MacroDraft.canMutateSlot(state.stagedMacros, state.activeMacroSlot, candidate)) {
    showToast('Deleting action would exceed the 8192-byte macro region due to diverging shared slots.', 'error');
    return;
  }
  slot.actions = candidate;
  state.macroSelectedActionIndex = slot.actions.length === 0
    ? null
    : Math.min(at, slot.actions.length - 1);
  updateApplyButtonsState();
  renderMacros();
}

function handleClearMacroSlot() {
  if (!ensureMacrosEditable()) return;
  if (state.isRecordingMacro) haltMacroRecording('reset');
  const slot = state.stagedMacros[state.activeMacroSlot];
  if (!slot) return;
  if (!window.confirm('Reset? Recorded actions on this macro will be deleted.')) return;
  slot.actions = [];
  state.macroSelectedActionIndex = null;
  updateApplyButtonsState();
  renderMacros();
  showToast(`Reset Macro ${state.activeMacroSlot + 1}`, 'info', 1500);
}

function handleCopyMacroActions() {
  if (!ensureMacrosEditable()) return;
  const slot = state.stagedMacros[state.activeMacroSlot];
  if (!slot || !slot.actions || slot.actions.length === 0) {
    showToast('Nothing to copy.', 'warning');
    return;
  }
  const idx = state.macroSelectedActionIndex;
  const source = Number.isInteger(idx) && slot.actions[idx]
    ? [slot.actions[idx]]
    : slot.actions;
  state.macroClipboard = MacroDraft.deepCopyActions(source);
  showToast(`Copied ${state.macroClipboard.length} action(s).`, 'info', 1500);
}

function handlePasteMacroActions() {
  if (!ensureMacrosEditable()) return;
  const copies = MacroDraft.deepCopyActions(state.macroClipboard);
  if (copies.length === 0) {
    showToast('Clipboard is empty.', 'warning');
    return;
  }
  const slot = state.stagedMacros[state.activeMacroSlot];
  if (!slot) return;
  const currentActions = Array.isArray(slot.actions) ? slot.actions : [];
  const at = Number.isInteger(state.macroSelectedActionIndex)
    ? state.macroSelectedActionIndex + 1
    : currentActions.length;
  const candidate = currentActions.slice();
  candidate.splice(at, 0, ...copies);
  if (!MacroDraft.canMutateSlot(state.stagedMacros, state.activeMacroSlot, candidate)) {
    showToast('Paste would exceed the 8192-byte macro region.', 'error');
    return;
  }
  slot.actions = candidate;
  state.macroSelectedActionIndex = at + copies.length - 1;
  updateApplyButtonsState();
  renderMacros();
  showToast(`Pasted ${copies.length} action(s).`, 'info', 1500);
}

function handleInsertMacroAction() {
  if (!ensureMacrosEditable()) return;
  const slot = state.stagedMacros[state.activeMacroSlot];
  if (!slot) return;
  const typeSelect = document.getElementById('macro-new-type');
  const keySelect = document.getElementById('macro-new-key');
  const delayInput = document.getElementById('macro-new-delay');
  const prefs = slotMeta(state.activeMacroSlot);

  const actionType = typeSelect?.value || 'keypress';
  const code = parseInt(keySelect?.value || '4', 10);
  const delay = delayInput?.value
    ? MacroDraft.clampMacroDelay(delayInput.value)
    : (prefs.enableDefaultDelay ? MacroDraft.clampMacroDelay(prefs.defaultDelay) : MacroDraft.MIN_DELAY);

  const res = MacroDraft.buildMacroActionsFromSelection({ actionType, code, delay });
  if (!res.valid) {
    showToast(res.error, 'warning');
    return;
  }

  const currentActions = Array.isArray(slot.actions) ? slot.actions : [];
  const at = Number.isInteger(state.macroSelectedActionIndex)
    ? state.macroSelectedActionIndex + 1
    : currentActions.length;
  const candidate = currentActions.slice();
  candidate.splice(at, 0, ...res.actions);

  if (!MacroDraft.canMutateSlot(state.stagedMacros, state.activeMacroSlot, candidate)) {
    showToast('Macro storage is full (8192-byte shared region).', 'error');
    return;
  }
  slot.actions = candidate;
  state.macroSelectedActionIndex = at + res.actions.length - 1;
  updateApplyButtonsState();
  renderMacros();
  showToast(`Inserted action into Macro ${state.activeMacroSlot + 1}`, 'info', 1500);
}

function handleMoveMacroAction(delta) {
  if (!ensureMacrosEditable()) return;
  const slot = state.stagedMacros[state.activeMacroSlot];
  const idx = state.macroSelectedActionIndex;
  if (!slot || !slot.actions || !Number.isInteger(idx)) {
    showToast('Select an action to reorder.', 'warning');
    return;
  }
  const next = idx + delta;
  if (next < 0 || next >= slot.actions.length) return;
  const candidate = slot.actions.slice();
  const [item] = candidate.splice(idx, 1);
  candidate.splice(next, 0, item);
  if (!MacroDraft.canMutateSlot(state.stagedMacros, state.activeMacroSlot, candidate)) {
    showToast('Reordering action would exceed the 8192-byte macro region due to diverging shared slots.', 'error');
    return;
  }
  slot.actions = candidate;
  state.macroSelectedActionIndex = next;
  updateApplyButtonsState();
  renderMacros();
}

function handleReplaceMacroAction() {
  if (!ensureMacrosEditable()) return;
  const slot = state.stagedMacros[state.activeMacroSlot];
  const idx = state.macroSelectedActionIndex;
  if (!slot || !slot.actions || !Number.isInteger(idx) || !slot.actions[idx]) {
    showToast('Select an action to replace.', 'warning');
    return;
  }
  const typeSelect = document.getElementById('macro-new-type');
  const keySelect = document.getElementById('macro-new-key');
  const actionType = typeSelect?.value || 'keypress';
  const code = parseInt(keySelect?.value || '4', 10);

  const candidate = MacroDraft.deepCopyActions(slot.actions);
  const replaced = MacroDraft.replaceActionAtIndex(candidate, idx, { actionType, code });
  if (!replaced) {
    if (actionType === 'mousedown' || actionType === 'mouseup') {
      showToast('Invalid mouse button selected.', 'warning');
    } else if (actionType === 'keydown' || actionType === 'keyup' || actionType === 'keypress') {
      showToast('Invalid keyboard key selected.', 'warning');
    } else {
      showToast('Invalid action type.', 'warning');
    }
    return;
  }

  if (!MacroDraft.canMutateSlot(state.stagedMacros, state.activeMacroSlot, candidate)) {
    showToast('Replacing action would exceed the 8192-byte macro region.', 'error');
    return;
  }

  slot.actions = candidate;
  updateApplyButtonsState();
  renderMacros();
  showToast(`Replaced action ${idx + 1}.`, 'info', 1500);
}

function handleToggleMacroActionKind() {
  if (!ensureMacrosEditable()) return;
  const slot = state.stagedMacros[state.activeMacroSlot];
  const idx = state.macroSelectedActionIndex;
  if (!slot || !slot.actions || !Number.isInteger(idx) || !slot.actions[idx]) {
    showToast('Select an action to edit.', 'warning');
    return;
  }
  const candidate = MacroDraft.deepCopyActions(slot.actions);
  const act = candidate[idx];
  if (act.action === 'keydown') act.action = 'keyup';
  else if (act.action === 'keyup') act.action = 'keydown';
  else if (act.action === 'mousedown') act.action = 'mouseup';
  else if (act.action === 'mouseup') act.action = 'mousedown';
  if (!MacroDraft.canMutateSlot(state.stagedMacros, state.activeMacroSlot, candidate)) {
    showToast('Modifying action would exceed the 8192-byte macro region due to diverging shared slots.', 'error');
    return;
  }
  slot.actions = candidate;
  updateApplyButtonsState();
  renderMacros();
}

/**
 * Assign active macro slot to selected key in Keymap tab
 */
function handleAssignMacroToSelectedKey() {
  if (!state.selectedKey) {
    showToast('Please select a physical key on the Keymap tab first.', 'warning');
    return;
  }
  assignMacroToSelected(state.activeMacroSlot);
}

/**
 * DOM KeyboardEvent.code to USB HID Usage Page 0x07 Mapping.
 * Shared from MacroDraft (vendor 2233 module 94222).
 */
const DOM_KEY_TO_HID = MacroDraft.DOM_KEY_TO_HID;

/**
 * Toggle interactive macro recording.
 * Hub tI: Record (empty) / Pause (recording) / Resume (has actions).
 */
function toggleMacroRecording() {
  if (state.isRecordingMacro) {
    pauseMacroRecording('pause');
  } else {
    startMacroRecording();
  }
}

function startMacroRecording() {
  if (state.loadInFlight || !state.hasReadMacros) {
    ensureMacrosEditable();
    return;
  }
  persistActiveSlotPrefsFromControls();
  state.isRecordingMacro = true;
  state.macroRecordingSlot = state.activeMacroSlot;
  state.macroPressed = {};
  state.macroLastEventTime = Date.now();
  syncMacroRecordControls();
  const cap = captureSurface();
  if (cap) {
    cap.hidden = false;
    cap.focus({ preventScroll: true });
  }
  showToast(`Recording into Macro ${state.macroRecordingSlot + 1}. Use the capture box.`, 'warning', 3500);
}

function flushMacroHeldInputs() {
  const extras = MacroDraft.flushHeldInputs(state.macroPressed);
  if (extras.length === 0) {
    state.macroPressed = {};
    return;
  }
  const slotIdx = recordingSlotIndex();
  const slot = state.stagedMacros[slotIdx];
  if (!slot) return;
  if (!Array.isArray(slot.actions)) slot.actions = [];

  const now = Date.now();
  const prefs = activeRecordPrefs();

  // Prospective candidate incl updated trailing delay and real releases before modifying state
  const candidate = MacroDraft.deepCopyActions(slot.actions);
  if (candidate.length > 0 && typeof state.macroLastEventTime === 'number') {
    candidate[candidate.length - 1].delay = MacroDraft.recordedDelay({
      enableDefaultDelay: prefs.enableDefaultDelay,
      defaultDelay: prefs.defaultDelay,
      now,
      lastEventTime: state.macroLastEventTime
    });
  }
  for (let i = 0; i < extras.length; i++) {
    candidate.push({
      action: extras[i].action,
      code: extras[i].code,
      delay: extras[i].delay || 0
    });
  }

  // Preflight check candidate before modifying draft state
  if (!MacroDraft.canMutateSlot(state.stagedMacros, slotIdx, candidate, 0)) {
    showToast('Not enough macro space to release held keys.', 'error');
    return;
  }

  // Commit atomically only after check
  slot.actions = candidate;
  state.macroPressed = {};
  state.macroLastEventTime = now;
  state.macroSelectedActionIndex = slot.actions.length - 1;
  updateApplyButtonsState();
}

function pauseMacroRecording(reason) {
  if (!state.isRecordingMacro) return;
  flushMacroHeldInputs();
  state.isRecordingMacro = false;
  state.macroLastEventTime = Date.now();
  const cap = captureSurface();
  if (cap) cap.hidden = true;
  renderMacros();
  updateApplyButtonsState();
  const slot = state.stagedMacros[recordingSlotIndex()];
  const count = slot?.actions?.length || 0;
  const why = reason && reason !== 'pause' ? ` (${reason})` : '';
  showToast(`Paused recording${why}. Macro ${recordingSlotIndex() + 1} has ${count} action(s).`, 'success');
}

function haltMacroRecording(reason) {
  if (state.isRecordingMacro) pauseMacroRecording(reason);
  state.macroRecordingSlot = null;
  state.macroPressed = {};
}

function recordCaptureEvent({ isDown, code, pressId, actionDown, actionUp, event }) {
  if (MacroDraft.shouldIgnoreRecordEvent(event, {
    recording: state.isRecordingMacro,
    focused: captureIsFocused()
  })) return false;
  const slotIdx = recordingSlotIndex();
  const slot = state.stagedMacros[slotIdx];
  if (!slot) return false;
  if (!Array.isArray(slot.actions)) slot.actions = [];

  const held = MacroDraft.heldCount(state.macroPressed);
  if (isDown) {
    if (state.macroPressed[pressId]) return false;
  } else {
    if (!state.macroPressed[pressId]) return false;
  }

  const now = Date.now();
  const prefs = activeRecordPrefs();

  // Build prospective ACTUAL candidate incl trailing delay adjustment plus actual new event
  const candidate = MacroDraft.deepCopyActions(slot.actions);
  MacroDraft.applyTrailingRecordedEvent(candidate, {
    action: isDown ? actionDown : actionUp,
    code,
    now,
    lastEventTime: state.macroLastEventTime,
    enableDefaultDelay: prefs.enableDefaultDelay,
    defaultDelay: prefs.defaultDelay
  });

  // Remaining release budget: if down, this key will need release plus existing held keys (held + 1).
  // If up, this key is released, leaving held - 1 pending releases.
  const remainingReleases = isDown ? (held + 1) : Math.max(0, held - 1);

  if (!MacroDraft.canMutateSlot(state.stagedMacros, slotIdx, candidate, remainingReleases)) {
    if (isDown) {
      showToast('Macro storage needs room for a matching release.', 'error');
    } else {
      showToast('Macro storage is full (8192-byte shared region).', 'error');
    }
    return false;
  }

  // Atomically commit candidate and update state only after preflight check passes
  event.preventDefault();
  event.stopPropagation();
  slot.actions = candidate;
  if (isDown) state.macroPressed[pressId] = true;
  else delete state.macroPressed[pressId];
  state.macroLastEventTime = now;
  state.macroSelectedActionIndex = slot.actions.length - 1;
  if (!state.isRecordingMacro) renderMacroActions();
  syncMacroRecordControls();
  updateApplyButtonsState();
  return true;
}

function hidFromKeyEvent(event) {
  if (event.code && DOM_KEY_TO_HID[event.code]) return DOM_KEY_TO_HID[event.code];
  if (event.key && event.key.length === 1) {
    const letter = `Key${event.key.toUpperCase()}`;
    if (DOM_KEY_TO_HID[letter]) return DOM_KEY_TO_HID[letter];
  }
  return null;
}

function handleMacroKeyDown(event) {
  const hidCode = hidFromKeyEvent(event);
  if (!hidCode) return;
  recordCaptureEvent({
    isDown: true,
    code: hidCode,
    pressId: MacroDraft.pressKey(hidCode),
    actionDown: 'keydown',
    actionUp: 'keyup',
    event
  });
}

function handleMacroKeyUp(event) {
  const hidCode = hidFromKeyEvent(event);
  if (!hidCode) return;
  recordCaptureEvent({
    isDown: false,
    code: hidCode,
    pressId: MacroDraft.pressKey(hidCode),
    actionDown: 'keydown',
    actionUp: 'keyup',
    event
  });
}

function handleMacroMouseDown(event) {
  const code = MacroDraft.mouseCodeFromDomButton(event.button);
  if (code == null) return;
  recordCaptureEvent({
    isDown: true,
    code,
    pressId: MacroDraft.pressMouse(code),
    actionDown: 'mousedown',
    actionUp: 'mouseup',
    event
  });
}

function handleMacroMouseUp(event) {
  const code = MacroDraft.mouseCodeFromDomButton(event.button);
  if (code == null) return;
  recordCaptureEvent({
    isDown: false,
    code,
    pressId: MacroDraft.pressMouse(code),
    actionDown: 'mousedown',
    actionUp: 'mouseup',
    event
  });
}

function attachMacroListeners() {
  const playbackSelect = document.getElementById('macro-playback-type');
  if (playbackSelect) {
    playbackSelect.addEventListener('change', () => {
      if (!ensureMacrosEditable()) {
        const slot = state.stagedMacros[state.activeMacroSlot];
        playbackSelect.value = String(slot?.type || 0);
        return;
      }
      const slot = state.stagedMacros[state.activeMacroSlot];
      if (slot) {
        const next = parseInt(playbackSelect.value, 10);
        if (next === 0 || next === 1 || next === 255) {
          slot.type = next;
          updateApplyButtonsState();
        }
      }
    });
  }
  const nameInput = document.getElementById('macro-name-input');
  if (nameInput) {
    nameInput.addEventListener('input', () => {
      const slot = state.stagedMacros[state.activeMacroSlot];
      const name = MacroDraft.sanitizeName(nameInput.value);
      slotMeta(state.activeMacroSlot).name = name;
      state.localMacroNames[state.activeMacroSlot] = name;
      if (slot) slot.name = name;
      const title = document.getElementById('macro-editor-title');
      if (title) title.textContent = name || `Macro ${state.activeMacroSlot + 1}`;
      const nameEls = document.querySelectorAll('#macro-slots-list .slot-name');
      if (nameEls[state.activeMacroSlot]) {
        nameEls[state.activeMacroSlot].textContent = name || `Macro ${state.activeMacroSlot + 1}`;
      }
      persistMacroMetadata();
    });
  }
  const delayCheck = document.getElementById('macro-standard-delay');
  const delayMs = document.getElementById('macro-standard-delay-ms');
  if (delayCheck) {
    delayCheck.addEventListener('change', () => {
      if (state.isRecordingMacro) {
        delayCheck.checked = Boolean(slotMeta(state.activeMacroSlot).enableDefaultDelay);
        return;
      }
      slotMeta(state.activeMacroSlot).enableDefaultDelay = delayCheck.checked;
      persistMacroMetadata();
      syncMacroRecordControls();
    });
  }
  if (delayMs) {
    delayMs.addEventListener('change', () => {
      if (state.isRecordingMacro) return;
      slotMeta(state.activeMacroSlot).defaultDelay = MacroDraft.clampMacroDelay(delayMs.value);
      delayMs.value = String(slotMeta(state.activeMacroSlot).defaultDelay);
      persistMacroMetadata();
    });
  }
  const typeSelect = document.getElementById('macro-new-type');
  if (typeSelect) {
    typeSelect.addEventListener('change', () => fillMacroPaletteSelects());
  }

  const cap = captureSurface();
  if (cap) {
    cap.addEventListener('keydown', handleMacroKeyDown);
    cap.addEventListener('keyup', handleMacroKeyUp);
    cap.addEventListener('mousedown', handleMacroMouseDown);
    cap.addEventListener('mouseup', handleMacroMouseUp);
    cap.addEventListener('contextmenu', (e) => {
      if (state.isRecordingMacro) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
  }
  window.addEventListener('blur', () => {
    if (state.isRecordingMacro) pauseMacroRecording('blur');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.isRecordingMacro) pauseMacroRecording('hidden');
  });
}

/**
 * Handle Read Macros from Keyboard
 */
async function handleReadMacros() {
  haltMacroRecording('read');
  const captured = { gen: state.editGeneration, resetEpoch: state.resetEpoch };
  showToast('Reading hardware macros from keyboard (CMD 12, 8192 bytes)…', 'info');
  try {
    const res = await api.readMacros();
    if (!requestStillCurrent(captured)) return;
    if (res.success && Array.isArray(res.macros)) {
      state.stagedMacros = applyLocalMacroNames(res.macros);
      state.hasReadMacros = true;
      updateApplyButtonsState();
      renderMacros();
      showToast('Macros successfully read from hardware. Names stay on this computer.', 'success');
    } else {
      invalidateMacroBank();
      showToast(`Failed to read macros: ${res.error}`, 'error');
    }
  } catch (err) {
    if (!requestStillCurrent(captured)) return;
    invalidateMacroBank();
    showToast(`Error reading macros: ${err.message}`, 'error');
  }
}

/**
 * Handle Apply Macros to Keyboard
 */
async function handleApplyMacros() {
  if (isLocalPreview()) {
    haltMacroRecording('apply');
    const res = await persistLocalDraft();
    showToast(res.success ? 'Saved to custom profile (keyboard not written).' : res.error, res.success ? 'success' : 'error');
    return;
  }
  haltMacroRecording('apply');
  if (state.loadInFlight || !state.hasReadMacros) return;
  const captured = { gen: state.editGeneration, resetEpoch: state.resetEpoch };
  persistActiveSlotPrefsFromControls();
  rememberMacroNames(state.stagedMacros);
  persistMacroMetadata();
  const snapshot = MacroDraft.hardwareMacroSlots(state.stagedMacros);
  if (MacroDraft.calculateMacroBankBytes(snapshot) > MacroDraft.SHARED_MACRO_SIZE) {
    showToast('Macro storage is full (8192-byte shared region).', 'error');
    return;
  }
  showToast('Uploading macros to keyboard flash storage (CMD 13, 8192 bytes)…', 'info');
  try {
    const res = await api.applyMacros(snapshot);
    if (!requestStillCurrent(captured)) return;
    if (res.success) {
      showToast('Macros uploaded. Playback-mode changes also update existing key bindings. Names stay in this app only.', 'success');
    } else {
      showToast(formatPartialFailure(res), 'error', 8000);
    }
  } catch (err) {
    if (!requestStillCurrent(captured)) return;
    showToast(`Error uploading macros: ${err.message}`, 'error');
  }
}

function canEditSettings() {
  return Boolean(state.connected && !state.loadInFlight && state.hasReadSettings);
}

function isSupportedReportRate(rate) {
  return PerformanceAutosave.isSupportedReportRate(rate);
}

function formatSleepDurationLabel(sleepTime) {
  return PerformanceAutosave.formatSleepDurationLabel(sleepTime);
}

function formatSleepLabel(sleepTime, neverSleep) {
  return PerformanceAutosave.formatSleepLabel(sleepTime, neverSleep);
}

function sleepSliderThumbMinutes(sleepTime) {
  return PerformanceAutosave.sleepSliderThumbMinutes(sleepTime);
}

function abortSettingsScheduler() {
  state.settingsSaveQueued = false;
  state.settingsOpInFlight = false;
  state.settingsReadInFlight = false;
  state.settingsOpSeq += 1;
  state.sleepSliderDraft = null;
  if (state.settingsSaveStatus === 'saving') state.settingsSaveStatus = 'idle';
}

function settingsSaveIdentity() {
  return PerformanceAutosave.captureSaveIdentity(
    currentProfileSource(),
    state.editGeneration,
    state.resetEpoch,
    state.editingProfile
  );
}

function settingsSaveIdentityCurrent(captured) {
  return PerformanceAutosave.saveIdentityMatches(captured, {
    gen: state.editGeneration,
    resetEpoch: state.resetEpoch,
    profile: state.editingProfile,
    source: currentProfileSource(),
    connected: Boolean(state.connected)
  });
}

async function waitForSettingsWorkerQuiet(captured, maxMs = 20000) {
  const started = Date.now();
  while (settingsSaveGate.pending > 0) {
    if (captured && !loadRequestCurrent(captured)) return false;
    if (Date.now() - started >= maxMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (captured) return loadRequestCurrent(captured);
  return true;
}

function renderSettingsSaveStatus() {
  const el = document.getElementById('settings-save-status');
  if (el) {
    const status = state.settingsSaveStatus || 'idle';
    el.dataset.state = status;
    if (status === 'saving') el.textContent = 'Saving…';
    else if (status === 'saved') el.textContent = isLocalPreview() ? 'Saved on this Mac' : 'Saved';
    else if (status === 'unsaved') el.textContent = 'Not saved';
    else if (status === 'error') el.textContent = state.settingsSaveError || 'Couldn’t save';
    else el.textContent = '';
  }
  updateApplyButtonsState();
}

function finishSettingsSave(success, capturedRevs, error) {
  if (success) {
    PerformanceAutosave.markFieldsPersisted(state.settingsPersistedRevs, capturedRevs, state.settingsFieldRevs);
    state.settingsFieldErrors = PerformanceAutosave.clearFieldErrors(
      state.settingsFieldErrors,
      capturedRevs,
      state.settingsFieldRevs
    );
  } else if (error) {
    state.settingsFieldErrors = PerformanceAutosave.markFieldErrors(
      state.settingsFieldErrors,
      capturedRevs,
      state.settingsFieldRevs,
      error
    );
  }
  state.settingsFieldErrors = PerformanceAutosave.remainingFieldErrors(
    state.settingsFieldErrors,
    state.settingsFieldRevs,
    state.settingsPersistedRevs
  );
  state.settingsDraftDirty = PerformanceAutosave.hasUnpersistedFieldRevs(
    state.settingsFieldRevs,
    state.settingsPersistedRevs
  ) || PerformanceAutosave.hasDirty(state.settingsEdited);
  const leftover = PerformanceAutosave.firstFieldError(state.settingsFieldErrors);
  state.settingsSaveError = leftover;
  state.settingsSaveBlocked = Boolean(leftover);
}

function applySettingsSaveStatus() {
  state.settingsDraftDirty = PerformanceAutosave.hasUnpersistedFieldRevs(
    state.settingsFieldRevs,
    state.settingsPersistedRevs
  ) || PerformanceAutosave.hasDirty(state.settingsEdited);
  const leftover = PerformanceAutosave.firstFieldError(state.settingsFieldErrors);
  state.settingsSaveError = leftover;
  state.settingsSaveBlocked = Boolean(leftover);
  state.settingsSaveStatus = PerformanceAutosave.computeSaveStatus(
    settingsSaveGate.pending,
    Boolean(leftover),
    state.settingsDraftDirty
  );
  renderSettingsSaveStatus();
}

function persistSettingsPatch(fields) {
  if (!fields || typeof fields !== 'object') return Promise.resolve({ success: true, hardwareWrites: 0 });
  const keys = Object.keys(fields);
  if (keys.length === 0) return Promise.resolve({ success: true, hardwareWrites: 0 });
  Object.assign(state.settings, fields);
  for (const key of keys) {
    PerformanceAutosave.bumpFieldRev(state.settingsFieldRevs, key);
    if (state.settingsFieldErrors) delete state.settingsFieldErrors[key];
  }
  state.settingsEdited = PerformanceAutosave.markEdited(state.settingsEdited, fields);
  state.settingsDraftDirty = true;
  state.settingsFieldErrors = PerformanceAutosave.remainingFieldErrors(
    state.settingsFieldErrors,
    state.settingsFieldRevs,
    state.settingsPersistedRevs
  );
  const leftover = PerformanceAutosave.firstFieldError(state.settingsFieldErrors);
  state.settingsSaveError = leftover;
  state.settingsSaveBlocked = Boolean(leftover);
  state.settingsSaveStatus = 'saving';
  const capturedRevs = PerformanceAutosave.captureFieldRevs(state.settingsFieldRevs, keys);
  const captured = settingsSaveIdentity();
  const patch = PerformanceAutosave.buildPatch(state.settingsEdited, state.settings, capturedRevs, state.settingsFieldRevs);
  renderSettingsControls();
  renderSettingsSaveStatus();
  const job = settingsSaveGate.enqueue(() => persistSettingsPatchNow(patch, capturedRevs, captured));
  void job.finally(() => {
    applySettingsSaveStatus();
  });
  return job;
}

async function persistSettingsPatchNow(patch, capturedRevs, captured) {
  state.settingsOpInFlight = true;
  try {
    if (!settingsSaveIdentityCurrent(captured)) return { success: false, stale: true };
    const send = {};
    for (const key of Object.keys(patch || {})) {
      if (PerformanceAutosave.fieldRevMatches(state.settingsFieldRevs, capturedRevs, key)) {
        send[key] = patch[key];
      }
    }
    const sentRevs = PerformanceAutosave.ownedSentRevs(state.settingsFieldRevs, capturedRevs, send);
    if (Object.keys(sentRevs).length === 0) {
      finishSettingsSave(true, sentRevs);
      return { success: true, hardwareWrites: 0, skippedStaleRev: true };
    }
    state.settingsSaveStatus = 'saving';
    renderSettingsSaveStatus();
    try {
      if (isLocalPreview()) {
        const res = await persistLocalDraft(null, null, sentRevs);
        if (!settingsSaveIdentityCurrent(captured)) return { success: false, stale: true };
        if (!res.success) {
          finishSettingsSave(false, sentRevs, res.error || 'Couldn’t save');
          return res;
        }
        state.settingsEdited = PerformanceAutosave.settleEdited(
          state.settingsEdited,
          send,
          state.settings,
          capturedRevs,
          state.settingsFieldRevs
        );
        finishSettingsSave(true, PerformanceAutosave.ownedSentRevs(state.settingsFieldRevs, capturedRevs, send));
        return { success: true, hardwareWrites: 0 };
      }
      const res = await api.applySettings(send, captured.profile);
      if (!settingsSaveIdentityCurrent(captured)) return { success: false, stale: true };
      if (!res || !res.success) {
        finishSettingsSave(false, sentRevs, (res && res.error) || 'Couldn’t save');
        showToast(`Couldn’t save settings: ${(res && res.error) || 'unknown error'}`, 'error');
        renderSettingsControls();
        return res || { success: false, error: 'Couldn’t save' };
      }
      state.settingsEdited = PerformanceAutosave.settleEdited(
        state.settingsEdited,
        send,
        state.settings,
        capturedRevs,
        state.settingsFieldRevs
      );
      finishSettingsSave(true, PerformanceAutosave.ownedSentRevs(state.settingsFieldRevs, capturedRevs, send));
      renderSettingsControls();
      return res;
    } catch (err) {
      if (!settingsSaveIdentityCurrent(captured)) return { success: false, stale: true };
      finishSettingsSave(false, sentRevs, err.message);
      showToast(`Couldn’t save settings: ${err.message}`, 'error');
      renderSettingsControls();
      return { success: false, error: err.message };
    }
  } finally {
    state.settingsOpInFlight = false;
  }
}

async function handleRetrySettingsSave() {
  if (!canEditSettings()) return;
  if (!PerformanceAutosave.hasDirty(state.settingsEdited)) return;
  const fields = PerformanceAutosave.buildPatch(
    state.settingsEdited,
    state.settings,
    state.settingsFieldRevs,
    state.settingsFieldRevs
  );
  if (Object.keys(fields).length === 0) return;
  await persistSettingsPatch(fields);
}

/**
 * Render Settings Controls
 */
function renderSettingsControls() {
  const sleepSlider = document.getElementById('setting-sleep-time');
  const sleepVal = document.getElementById('setting-sleep-time-val');
  const neverSleepCheck = document.getElementById('setting-never-sleep');
  const pollingGroup = document.getElementById('setting-polling-rate');
  const pollingHint = document.getElementById('setting-polling-rate-hint');
  const lockWinCheck = document.getElementById('setting-lock-win');
  const lockWinHint = document.getElementById('setting-lock-win-hint');
  const lockWinContainer = document.getElementById('setting-lock-win-container');
  const keyComboCheck = document.getElementById('setting-key-combo');
  const winBtn = document.getElementById('btn-mode-win');
  const macBtn = document.getElementById('btn-mode-mac');

  const editable = canEditSettings();
  const isNeverSleep = (state.settings.sleepMode === 1);
  const isMac = ((state.settings.macMode & 3) === 2);

  if (pollingGroup) {
    pollingGroup.disabled = !editable;
    const currentRate = state.settings.reporteRate;
    const radios = pollingGroup.querySelectorAll('input[name="setting-polling-rate"]');
    radios.forEach((radio) => {
      radio.disabled = !editable;
      radio.checked = isSupportedReportRate(currentRate) && radio.value === String(currentRate);
    });
  }
  if (pollingHint) {
    const currentRate = state.settings.reporteRate;
    if (editable && currentRate !== undefined && currentRate !== null && !isSupportedReportRate(currentRate)) {
      pollingHint.textContent = 'The keyboard returned an unrecognized polling rate. It will be preserved unless you choose a rate above.';
    } else {
      pollingHint.textContent = 'Higher keyboard polling rate reduces input delay.';
    }
  }

  if (neverSleepCheck) {
    neverSleepCheck.disabled = !editable;
    neverSleepCheck.checked = isNeverSleep;
  }
  if (sleepSlider) {
    sleepSlider.disabled = !editable;
    const dragging = document.activeElement === sleepSlider;
    const draft = dragging || state.sleepSliderDraft != null
      ? (state.sleepSliderDraft != null ? state.sleepSliderDraft : parseInt(sleepSlider.value, 10))
      : null;
    if (!dragging) {
      sleepSlider.value = String(draft != null ? draft : sleepSliderThumbMinutes(state.settings.sleepTime));
    }
    if (sleepVal) {
      if (draft != null && Number.isInteger(draft)) {
        sleepVal.textContent = isNeverSleep && !dragging ? formatSleepLabel(state.settings.sleepTime, true) : `${draft} min`;
      } else {
        sleepVal.textContent = formatSleepLabel(state.settings.sleepTime, isNeverSleep);
      }
    }
  }

  if (lockWinCheck) {
    lockWinCheck.disabled = !editable || isMac;
    lockWinCheck.checked = Boolean(state.settings.lockWin);
    if (lockWinContainer) {
      lockWinContainer.classList.toggle('disabled', !editable || isMac);
    }
  }
  if (lockWinHint) {
    if (isMac) {
      lockWinHint.textContent = 'Mac mode is enabled. Win key lock is unavailable.';
      lockWinHint.style.color = 'var(--text-secondary)';
    } else {
      lockWinHint.textContent = 'After turning it on, the Win key will be locked and cannot be used to prevent accidental touches during the game.';
      lockWinHint.style.color = '';
    }
  }

  if (winBtn) {
    winBtn.disabled = !editable;
    winBtn.classList.toggle('active', !isMac);
  }
  if (macBtn) {
    macBtn.disabled = !editable;
    macBtn.classList.toggle('active', isMac);
  }

  if (keyComboCheck) {
    keyComboCheck.disabled = !editable;
    keyComboCheck.checked = (state.settings.debounceLevel !== undefined && state.settings.debounceLevel >= 1);
  }
  renderSettingsSaveStatus();
}

function setOsMode(mode, updateState = true) {
  const isMac = (mode === 'mac');
  if (updateState) {
    if (!canEditSettings()) {
      renderSettingsControls();
      return;
    }
    const targetMode = isMac ? 2 : 0;
    const currentMode = (state.settings.macMode & 3);
    if (currentMode === targetMode && !(isMac && state.settings.lockWin)) {
      renderSettingsControls();
      return;
    }
    void persistSettingsPatch(PerformanceAutosave.macModePatch(isMac));
    return;
  }
  renderSettingsControls();
}

function attachSettingsListeners() {
  const sleepSlider = document.getElementById('setting-sleep-time');
  const neverSleepCheck = document.getElementById('setting-never-sleep');
  const pollingGroup = document.getElementById('setting-polling-rate');
  const lockWinCheck = document.getElementById('setting-lock-win');
  const keyComboCheck = document.getElementById('setting-key-combo');

  if (pollingGroup) {
    pollingGroup.addEventListener('change', (event) => {
      const input = event.target;
      if (!input || input.name !== 'setting-polling-rate') return;
      if (!canEditSettings()) {
        renderSettingsControls();
        return;
      }
      const newRate = parseInt(input.value, 10);
      if (isSupportedReportRate(newRate) && state.settings.reporteRate !== newRate) {
        void persistSettingsPatch({ reporteRate: newRate });
        return;
      }
      renderSettingsControls();
    });
  }

  const onSleepDraft = () => {
    if (!canEditSettings()) {
      state.sleepSliderDraft = null;
      renderSettingsControls();
      return;
    }
    const mins = parseInt(sleepSlider.value, 10);
    if (!Number.isInteger(mins) || mins < 1 || mins > 30) {
      renderSettingsControls();
      return;
    }
    state.sleepSliderDraft = mins;
    const sleepVal = document.getElementById('setting-sleep-time-val');
    if (sleepVal) sleepVal.textContent = `${mins} min`;
  };
  const onSleepCommit = () => {
    if (!canEditSettings()) {
      state.sleepSliderDraft = null;
      renderSettingsControls();
      return;
    }
    const mins = parseInt(sleepSlider.value, 10);
    state.sleepSliderDraft = null;
    if (!Number.isInteger(mins) || mins < 1 || mins > 30) {
      renderSettingsControls();
      return;
    }
    if (!PerformanceAutosave.shouldCommitSleep(mins, state.settings)) {
      renderSettingsControls();
      return;
    }
    void persistSettingsPatch(PerformanceAutosave.sleepCommitPatch(mins, state.settings));
  };
  if (sleepSlider) {
    sleepSlider.addEventListener('input', onSleepDraft);
    sleepSlider.addEventListener('change', onSleepCommit);
  }

  if (neverSleepCheck) {
    neverSleepCheck.addEventListener('change', () => {
      if (!canEditSettings()) {
        renderSettingsControls();
        return;
      }
      const newMode = neverSleepCheck.checked ? 1 : 0;
      if (state.settings.sleepMode !== newMode) {
        void persistSettingsPatch(PerformanceAutosave.neverSleepPatch(newMode === 1));
        return;
      }
      renderSettingsControls();
    });
  }

  if (lockWinCheck) {
    lockWinCheck.addEventListener('change', () => {
      const isMac = ((state.settings.macMode & 3) === 2);
      if (!canEditSettings() || isMac) {
        renderSettingsControls();
        return;
      }
      const newLock = Boolean(lockWinCheck.checked);
      if (Boolean(state.settings.lockWin) !== newLock) {
        void persistSettingsPatch({ lockWin: newLock });
        return;
      }
      renderSettingsControls();
    });
  }

  if (keyComboCheck) {
    keyComboCheck.addEventListener('change', () => {
      if (!canEditSettings()) {
        renderSettingsControls();
        return;
      }
      const isCurrentlyEnabled = (state.settings.debounceLevel !== undefined && state.settings.debounceLevel >= 1);
      const wantEnabled = keyComboCheck.checked;
      if (wantEnabled !== isCurrentlyEnabled) {
        void persistSettingsPatch(PerformanceAutosave.comboPatch(wantEnabled));
        return;
      }
      renderSettingsControls();
    });
  }
}

/**
 * Handle Read Settings
 */
async function handleReadSettings() {
  if (!state.connected || state.loadInFlight || state.settingsReadInFlight) return;
  const pre = {
    gen: state.editGeneration,
    resetEpoch: state.resetEpoch,
    profile: state.editingProfile
  };
  const drained = await settingsSaveGate.drain(20000);
  if (!loadRequestCurrent(pre)) return;
  if (!drained) {
    showToast('Still saving performance settings. Read did not start.', 'warning');
    return;
  }
  if (state.settingsReadInFlight) return;
  const captured = { gen: state.editGeneration, resetEpoch: state.resetEpoch, profile: state.editingProfile };
  state.settingsReadInFlight = true;
  updateApplyButtonsState();
  const job = settingsSaveGate.enqueue(() => readSettingsNow(captured));
  void job.finally(() => {
    if (captured.gen === state.editGeneration && captured.resetEpoch === state.resetEpoch) {
      state.settingsReadInFlight = false;
    }
    applySettingsSaveStatus();
    updateApplyButtonsState();
    renderSettingsControls();
  });
  return job;
}

async function readSettingsNow(captured) {
  if (!requestStillCurrent(captured) || !loadRequestCurrent(captured)) return;
  const readRevs = Object.assign({}, state.settingsFieldRevs);
  showToast('Reading settings from keyboard…', 'info');
  try {
    const res = await api.readFuncConfig(captured.profile);
    if (!requestStillCurrent(captured)) return;
    const newer = PerformanceAutosave.hasNewerFieldRevs(state.settingsFieldRevs, readRevs);
    if (res && res.success && res.settings) {
      const merged = PerformanceAutosave.mergeReadSettings(
        state.settings,
        res.settings,
        state.settingsFieldRevs,
        readRevs
      );
      state.settings = merged.settings;
      PerformanceAutosave.clearAppliedFieldState(
        state.settingsFieldRevs,
        state.settingsPersistedRevs,
        state.settingsEdited,
        state.settingsFieldErrors,
        merged.applied
      );
      if (merged.skipped.length === 0 && !newer) {
        state.settingsDraftDirty = false;
        state.settingsEdited = {};
        state.settingsSaveBlocked = false;
        state.settingsSaveStatus = 'idle';
        state.settingsSaveError = null;
        state.settingsFieldErrors = {};
        state.sleepSliderDraft = null;
        PerformanceAutosave.clearFieldRevs(state.settingsFieldRevs, state.settingsPersistedRevs);
      } else if (!merged.skipped.includes('sleepTime')) {
        state.sleepSliderDraft = null;
      }
      state.hasReadSettings = true;
      updateApplyButtonsState();
      renderSettingsControls();
      if (merged.skipped.length) {
        showToast('Settings refreshed. Newer edits were kept.', 'success');
      } else {
        showToast('Settings refreshed from edit-target profile.', 'success');
      }
    } else if (newer) {
      updateApplyButtonsState();
      renderSettingsControls();
      showToast(`Failed to read settings: ${(res && res.error) || 'unknown error'}`, 'error');
    } else {
      state.hasReadSettings = false;
      updateApplyButtonsState();
      renderSettingsControls();
      showToast(`Failed to read settings: ${(res && res.error) || 'unknown error'}`, 'error');
    }
  } catch (err) {
    if (!requestStillCurrent(captured)) return;
    const newer = PerformanceAutosave.hasNewerFieldRevs(state.settingsFieldRevs, readRevs);
    if (!newer) state.hasReadSettings = false;
    updateApplyButtonsState();
    renderSettingsControls();
    showToast(`Failed to read settings: ${err.message}`, 'error');
  }
}

/**
 * Export Profile to JSON
 * Saves all 4 layers, per-key RGB, lighting, settings, and macros.
 */
function resetDialogElements() {
  return {
    dialog: document.getElementById('reset-confirm-dialog'),
    title: document.getElementById('reset-dialog-title'),
    body: document.getElementById('reset-dialog-body'),
    exportNote: document.getElementById('reset-dialog-export-note'),
    confirm: document.getElementById('btn-reset-confirm'),
    cancel: document.getElementById('btn-reset-cancel'),
    exportBtn: document.getElementById('btn-reset-export')
  };
}

function resetDialogFocusables() {
  const { dialog } = resetDialogElements();
  if (!dialog) return [];
  return Array.from(dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((el) => !el.disabled && el.offsetParent !== null);
}

function trapResetDialogFocus(event) {
  const nodes = resetDialogFocusables();
  if (nodes.length === 0) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function syncResetChrome() {
  const busy = Boolean(state.resetCommitInFlight);
  const open = Boolean(state.resetDialogOpen);
  const { dialog, confirm, cancel, exportBtn } = resetDialogElements();
  const activeBtn = document.getElementById('btn-reset-active');
  const allBtn = document.getElementById('btn-reset-all');
  if (dialog) {
    if (busy) dialog.setAttribute('aria-busy', 'true');
    else dialog.removeAttribute('aria-busy');
  }
  if (confirm) confirm.disabled = busy;
  if (cancel) cancel.disabled = busy;
  if (exportBtn) exportBtn.disabled = busy;
  if (activeBtn) activeBtn.disabled = busy || open;
  if (allBtn) allBtn.disabled = busy || open;
}

function closeResetDialog() {
  if (state.resetCommitInFlight) return;
  const { dialog } = resetDialogElements();
  state.resetDialogOpen = false;
  state.resetReview = null;
  if (dialog) {
    dialog.hidden = true;
    dialog.removeAttribute('aria-busy');
  }
  const opener = state.resetDialogOpener;
  state.resetDialogOpener = null;
  syncResetChrome();
  if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
    opener.focus();
  }
}

async function openResetReview(scope) {
  if (state.resetCommitInFlight || state.resetDialogOpen) return;
  if (!state.connected) {
    showToast('Cannot reset: keyboard is not connected', 'warning');
    return;
  }
  if (!api.prepareFactoryReset) {
    showToast('Factory reset is unavailable in this build', 'error');
    return;
  }
  const opener = document.activeElement;
  const fallbackOpener = document.getElementById(scope === 'all' ? 'btn-reset-all' : 'btn-reset-active');
  showToast('Reading the profile currently active on the keyboard…', 'info');
  try {
    const review = await api.prepareFactoryReset(scope);
    if (!review || !review.success) {
      showToast(`Cannot prepare reset: ${review && review.error ? review.error : 'unknown error'}`, 'error');
      return;
    }
    state.resetReview = review;
    state.resetDialogOpener = (opener && opener.id && document.contains(opener)) ? opener : fallbackOpener;
    const { dialog, title, body, exportNote, cancel, confirm } = resetDialogElements();
    const activeLabel = `Profile ${review.activeProfileIndex + 1}`;
    const editLabel = `Profile ${review.editingProfileIndex + 1}`;
    if (title) {
      title.textContent = scope === 'all'
        ? 'Reset all onboard profiles?'
        : `Reset active profile (${activeLabel})?`;
    }
    const lines = [];
    if (scope === 'all') {
      lines.push(`This will reset every onboard profile, including ${activeLabel} which is currently active on the keyboard. Local drafts will be discarded.`);
    } else {
      lines.push(`This will reset ${activeLabel}, the profile currently active on the keyboard. Local drafts will be discarded.`);
    }
    if (scope === 'active' && review.editingDiffersFromActive) {
      lines.push(`You are editing ${editLabel}, which is not the reset target.`);
    }
    lines.push('Cancel leaves the keyboard unchanged.');
    if (body) body.textContent = lines.join(' ');
    if (exportNote) {
      exportNote.textContent = scope === 'all'
        ? 'Export saves one onboard profile per file, not the whole keyboard. Export each profile separately if you need copies of all of them.'
        : 'Export saves this one profile only. It is not a backup of the whole keyboard.';
    }
    if (confirm) confirm.textContent = scope === 'all' ? 'Reset all profiles' : `Reset ${activeLabel}`;
    if (dialog) dialog.hidden = false;
    state.resetDialogOpen = true;
    syncResetChrome();
    if (cancel) cancel.focus();
  } catch (err) {
    showToast(`Failed to prepare reset: ${err.message}`, 'error');
  }
}

async function exportFromResetDialog() {
  if (state.resetCommitInFlight) return;
  const review = state.resetReview;
  if (!review) return;
  const target = Number.isInteger(review.activeProfileIndex) ? review.activeProfileIndex : state.editingProfile;
  showToast(`Exporting Profile ${target + 1} only — not a backup of the whole keyboard.`, 'info');
  await handleExportProfile(target);
}

async function confirmResetDialog() {
  if (state.resetCommitInFlight) return;
  const review = state.resetReview;
  if (!review || !api.commitFactoryReset) {
    closeResetDialog();
    return;
  }
  state.resetCommitInFlight = true;
  syncResetChrome();
  try {
    if (state.harness && window.__maicongHarness && window.__maicongHarness.rejectNextCommitFactoryReset) {
      window.__maicongHarness.rejectNextCommitFactoryReset = false;
      await Promise.resolve();
      throw new Error('simulated IPC rejection');
    }
    const res = await api.commitFactoryReset({
      scope: review.scope,
      expectedActiveProfileIndex: review.activeProfileIndex,
      expectedIdentity: review.identity,
      expectedGeneration: review.generation,
      expectedResetEpoch: review.resetEpoch
    });
    if (res && res.dispatched) {
      applyResetInvalidation('factory-reset');
    }
    state.resetCommitInFlight = false;
    closeResetDialog();
    if (res && res.success) {
      let msg = review.scope === 'all'
        ? 'All onboard profiles were reset. Local drafts were discarded. Read the keyboard before editing.'
        : `Profile ${review.activeProfileIndex + 1} was reset. Local drafts were discarded. Read the keyboard before editing.`;
      if (res.localCleanup === 'failed' || res.metadataError) {
        msg += ` ${res.localCleanupHint || 'Saved macro names on this computer could not be cleared. You can rename them here.'}`;
        showToast(msg, 'warning', 8000);
      } else {
        if (res.metadataCleared) msg += ' Saved macro names on this computer were cleared.';
        showToast(msg, 'success', 6000);
      }
    } else if (res && res.uncertain) {
      showToast(
        'The reset may have already happened, but this app could not confirm it. Do not try again automatically. Reconnect and read the keyboard; do not put the old settings back.',
        'warning',
        8000
      );
    } else {
      showToast(`Factory reset did not run: ${res && res.error ? res.error : 'unknown error'}`, 'error', 6000);
    }
  } catch (err) {
    applyResetInvalidation('factory-reset-ipc-error');
    state.resetCommitInFlight = false;
    closeResetDialog();
    showToast(
      `The reset result is unconfirmed: ${err.message}. Do not try again automatically. Read the keyboard; do not put the old settings back.`,
      'error',
      8000
    );
  } finally {
    state.resetCommitInFlight = false;
    syncResetChrome();
  }
}

function firmwareDialogElements() {
  return {
    dialog: document.getElementById('firmware-review-dialog'),
    title: document.getElementById('firmware-review-title'),
    body: document.getElementById('firmware-review-body'),
    hash: document.getElementById('firmware-review-hash'),
    size: document.getElementById('firmware-review-size'),
    boot: document.getElementById('firmware-review-boot'),
    mode: document.getElementById('firmware-review-mode-rule'),
    cancel: document.getElementById('btn-firmware-cancel'),
    confirm: document.getElementById('btn-firmware-confirm')
  };
}

function syncFirmwareChrome() {
  const busy = Boolean(state.firmwareCommitInFlight);
  const open = Boolean(state.firmwareDialogOpen);
  const choose = document.getElementById('btn-firmware-choose');
  const reviewBtn = document.getElementById('btn-firmware-review');
  const { dialog, cancel, confirm } = firmwareDialogElements();
  if (dialog) {
    if (busy) dialog.setAttribute('aria-busy', 'true');
    else dialog.removeAttribute('aria-busy');
  }
  if (cancel) cancel.disabled = busy;
  if (confirm) confirm.disabled = busy;
  if (choose) choose.disabled = busy || open;
  if (reviewBtn) reviewBtn.disabled = busy || open;
}

function formatFirmwareBoot(boot) {
  if (!boot) return '';
  const vid = Number(boot.vendorId).toString(16).padStart(4, '0');
  const pid = Number(boot.productId).toString(16).padStart(4, '0');
  return `Boot identity VID 0x${vid} PID 0x${pid} usagePage ${boot.usagePage} usage ${boot.usage}`;
}

function renderFirmwarePanel(status) {
  state.firmwareStatus = status || state.firmwareStatus;
  const info = status || {};
  const versions = info.versions || {};
  const mcu = document.getElementById('firmware-mcu-version');
  const rf = document.getElementById('firmware-rf-version');
  const target = document.getElementById('firmware-target-label');
  const pkg = document.getElementById('firmware-package-name');
  const mode = document.getElementById('firmware-mode-rule');
  const statusEl = document.getElementById('firmware-status');
  const progress = document.getElementById('firmware-progress');
  if (mcu) mcu.textContent = versions.firmwareVersion || state.info?.firmwareVersion || '--';
  if (rf) rf.textContent = versions.rfFirmwareVersion || state.info?.rfFirmwareVersion || '--';
  if (target) {
    if (!info.connected) target.textContent = 'Connect a G75 V2';
    else if (info.target && info.target.kind === 'keyboard') target.textContent = 'Keyboard MCU (wired USB)';
    else if (info.target && info.target.kind === 'receiver') target.textContent = 'Receiver RF (2.4G)';
    else target.textContent = info.targetError || 'Unknown target';
  }
  if (pkg) {
    pkg.textContent = info.selectedPackage
      ? `${info.selectedPackage.fileName} (${info.selectedPackage.size} bytes)`
      : 'None selected';
  }
  if (mode) mode.textContent = info.modeRule ? info.modeRule.error : '';
  if (statusEl) {
    if (info.lastOutcome && info.lastOutcome.success) {
      statusEl.textContent = 'Firmware update finished. Version readback and configuration restore were verified in this app. Physical flash remains unproven.';
    } else if (info.lastOutcome && info.lastOutcome.error) {
      statusEl.textContent = info.lastOutcome.error;
    } else if (info.inProgress) {
      statusEl.textContent = 'Firmware update is running.';
    } else {
      statusEl.textContent = '';
    }
  }
  if (progress) {
    const events = info.progress || [];
    const last = events.length ? events[events.length - 1] : null;
    if (last && last.message) {
      progress.hidden = false;
      progress.textContent = last.message;
    } else if (!info.inProgress) {
      progress.hidden = true;
    }
  }
}

async function refreshFirmwarePanel() {
  if (!api.firmwareStatus) return;
  try {
    const status = await api.firmwareStatus();
    renderFirmwarePanel(status);
  } catch (err) {
    const statusEl = document.getElementById('firmware-status');
    if (statusEl) statusEl.textContent = err.message || String(err);
  }
}

async function handleChooseFirmwarePackage(spec) {
  if (state.firmwareCommitInFlight || state.firmwareDialogOpen) return;
  if (!api.chooseFirmwarePackage) {
    showToast('Firmware update is unavailable in this build', 'error');
    return;
  }
  try {
    const picked = await api.chooseFirmwarePackage(spec || {});
    if (picked && picked.canceled) return;
    if (!picked || !picked.success) {
      showToast(`Cannot use that firmware package: ${picked && picked.error ? picked.error : 'unknown error'}`, 'error');
      await refreshFirmwarePanel();
      return;
    }
    showToast(`Selected ${picked.fileName} (${picked.size} bytes). Review before updating.`, 'info');
    await refreshFirmwarePanel();
  } catch (err) {
    showToast(`Failed to choose firmware package: ${err.message}`, 'error');
  }
}

function closeFirmwareDialog() {
  if (state.firmwareCommitInFlight) return;
  const { dialog } = firmwareDialogElements();
  state.firmwareDialogOpen = false;
  if (dialog) {
    dialog.hidden = true;
    dialog.removeAttribute('aria-busy');
  }
  const opener = state.firmwareDialogOpener;
  state.firmwareDialogOpener = null;
  syncFirmwareChrome();
  if (typeof api.dismissFirmwareReview === 'function') {
    void api.dismissFirmwareReview();
  }
  if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
    opener.focus();
  }
}

async function openFirmwareReview() {
  if (state.firmwareCommitInFlight || state.firmwareDialogOpen) return;
  if (!state.connected && typeof api.getState === 'function') {
    try {
      const fresh = await api.getState();
      if (fresh) updateFromDeviceState(fresh);
    } catch {}
  }
  if (!state.connected) {
    showToast('Cannot update firmware: keyboard is not connected', 'warning');
    return;
  }
  if (!api.reviewFirmware) {
    showToast('Firmware update is unavailable in this build', 'error');
    return;
  }
  const opener = document.activeElement;
  const fallbackOpener = document.getElementById('btn-firmware-review');
  showToast('Reviewing the connected device and firmware package…', 'info');
  try {
    const review = await api.reviewFirmware();
    await refreshFirmwarePanel();
    if (!review || !review.success) {
      showToast(`Cannot review firmware: ${review && review.error ? review.error : 'unknown error'}`, 'error');
      return;
    }
    state.firmwareDialogOpener = (opener && opener.id && document.contains(opener)) ? opener : fallbackOpener;
    const { dialog, title, body, hash, size, boot, mode, cancel } = firmwareDialogElements();
    const kindLabel = review.target && review.target.kind === 'keyboard' ? 'keyboard MCU' : 'receiver RF';
    if (title) title.textContent = `Review ${kindLabel} firmware update`;
    const current = review.currentVersion || {};
    const pkg = review.package || {};
    if (body) {
      body.textContent = `This will update the connected ${kindLabel} from MCU ${current.firmwareVersion || '--'} / RF ${current.rfFirmwareVersion || '--'} to catalog ${pkg.version || '--'} (${pkg.fileName || 'package'}).`;
    }
    if (hash) hash.textContent = `SHA-256 ${pkg.sha256 || '--'}`;
    if (size) size.textContent = `Size ${pkg.size || '--'} bytes (full file, header preserved)`;
    if (boot) boot.textContent = formatFirmwareBoot(review.boot);
    if (mode) mode.textContent = review.modeRule ? review.modeRule.error : '';
    if (dialog) dialog.hidden = false;
    state.firmwareDialogOpen = true;
    syncFirmwareChrome();
    if (cancel) cancel.focus();
  } catch (err) {
    showToast(`Failed to review firmware: ${err.message}`, 'error');
  }
}

async function confirmFirmwareDialog() {
  if (state.firmwareCommitInFlight) return;
  if (!api.startFirmware) {
    closeFirmwareDialog();
    return;
  }
  state.firmwareCommitInFlight = true;
  syncFirmwareChrome();
  try {
    const res = await api.startFirmware({ confirmed: true });
    state.firmwareCommitInFlight = false;
    closeFirmwareDialog();
    await refreshFirmwarePanel();
    if (res && res.success && res.fullUpdaterSuccess) {
      showToast('Firmware update finished. Version readback and restore were verified in this app. Physical flash remains unproven.', 'success', 8000);
    } else if (res && res.reason === 'cancelled') {
      showToast(`Firmware update cancelled: ${res.error || 'cancelled'}.`, 'warning', 6000);
    } else {
      showToast(`Firmware update did not succeed: ${res && res.error ? res.error : 'unknown error'}`, 'error', 8000);
    }
  } catch (err) {
    state.firmwareCommitInFlight = false;
    closeFirmwareDialog();
    await refreshFirmwarePanel();
    showToast(`Firmware update result is unconfirmed: ${err.message}. Do not retry an uncertain erase.`, 'error', 8000);
  } finally {
    state.firmwareCommitInFlight = false;
    syncFirmwareChrome();
  }
}

async function handleExportProfile(profileIndex = state.editingProfile) {
  if (!state.connected) {
    showToast('Cannot export profile: keyboard is not connected', 'warning');
    return;
  }
  const target = Number.isInteger(profileIndex) ? profileIndex : state.editingProfile;
  showToast('Reading fresh profile from hardware…', 'info');
  try {
    const res = await api.exportProfile(target);
    if (res.success && res.filePath) {
      showToast(`Profile ${target + 1} exported to ${res.filePath}. This file is one profile, not an all-device backup.`, 'success', 5000);
    } else if (!res.canceled) {
      showToast(`Export error: ${res.error}`, 'error');
    }
  } catch (err) {
    showToast(`Error exporting profile: ${err.message}`, 'error');
  }
}

/**
 * Import Profile from JSON
 * Stages preview ONLY. Does NOT write to device automatically.
 */
async function handleImportProfile() {
  haltMacroRecording('import');
  showToast('Opening import file dialog…', 'info');
  try {
    const res = await api.importProfile();
    if (res.success && res.data) {
      const data = res.data;

      // Basic schema validation
      if (typeof data !== 'object') {
        showToast('Invalid profile: root is not an object', 'error');
        return;
      }

      state.importedProfileData = data;
      const previewCard = document.getElementById('imported-profile-preview');
      const jsonPre = document.getElementById('imported-profile-json');

      const summary = {
        model: data.model || 'MCHOSE G75 V2',
        exportedAt: data.exportedAt || 'Unknown',
        hasLighting: Boolean(data.lighting),
        hasPerKeyRgb: Boolean(data.perKeyRgb),
        hasSettings: Boolean(data.settings),
        layersCount: data.keymaps ? Object.keys(data.keymaps).length : (data.layers ? Object.keys(data.layers).length : 0),
        macrosCount: Array.isArray(data.macros) ? data.macros.length : 0,
        hasAdvanced: Boolean(data.advanced),
        atomic: false
      };

      if (jsonPre) jsonPre.textContent = JSON.stringify({ summary, details: data }, null, 2);
      if (previewCard) previewCard.hidden = false;
      applyImportedMacroMetadata(data);

      showToast('Profile preview staged! Click "Apply Imported Profile to Device" to write.', 'success');
    } else if (!res.canceled) {
      showToast(`Import error: ${res.error}`, 'error');
    }
  } catch (err) {
    showToast(`Error importing profile: ${err.message}`, 'error');
  }
}

/**
 * Apply Imported Profile with atomic hardware transaction and staging
 */
async function handleApplyImportedProfile() {
  if (!state.importedProfileData) return;
  haltMacroRecording('import-apply');
  const data = state.importedProfileData;

  showToast('Applying imported profile…', 'info');

  // If connected, write to hardware via single atomic transaction with generation protection
  if (state.connected) {
    showToast('Writing imported profile (serialized, not atomic)…', 'info');
    try {
      const res = await api.applyProfile(data, state.editingProfile);
      if (!res.success) {
        const partial = formatPartialFailure(res);
        const errEl = document.getElementById('import-partial-error');
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent = partial;
        }
        showToast(partial, 'error', 8000);
        return;
      }
      const errEl = document.getElementById('import-partial-error');
      if (errEl) errEl.hidden = true;
      showToast('Imported profile applied to edit-target with per-section readback.', 'success', 5000);
    } catch (err) {
      showToast(`Failed to apply profile: ${err.message}`, 'error', 7000);
      return;
    }
  } else {
    showToast('Imported profile staged offline across all components. Connect keyboard to write to hardware.', 'info', 4000);
  }

  // Update local staging
  if (data.lighting) {
    state.lighting = { ...state.lighting, ...data.lighting };
    state.lightingEdited = {};
    state.lightingDraftDirty = false;
    state.lightingHydrateLocked = false;
    state.hasReadLighting = true;
  }
  if (data.lightingMemory) {
    adoptLightMemory({
      success: true,
      backend: 'import',
      store: {
        main: data.lightingMemory.main || [],
        side: data.lightingMemory.side || [],
        side2: data.lightingMemory.side2 || []
      },
      persisted: true
    });
  }
  if (data.perKeyRgb) {
    state.stagedKeyColors = { ...state.stagedKeyColors, ...data.perKeyRgb };
    state.hasReadKeyColors = true;
  }
  if (data.settings) {
    const isMac = (data.settings.macMode !== undefined ? (data.settings.macMode % 4) === 2 : false);
    state.settings = {
      ...state.settings,
      ...data.settings,
      // Preserve destination profile association in macMode
      macMode: isMac ? 2 : 0
    };
    state.hasReadSettings = true;
  }

  const importedKeymaps = data.layers || data.keymaps;
  if (importedKeymaps && typeof importedKeymaps === 'object') {
    for (const [lStr, km] of Object.entries(importedKeymaps)) {
      const l = parseInt(lStr, 10);
      if (Number.isInteger(l) && l >= 0 && l <= 3) {
        state.layerKeymaps[l] = km;
        state.hasReadKeymap[l] = true;
      }
    }
  }

  if (Array.isArray(data.macros)) {
    applyImportedMacroMetadata(data);
    state.stagedMacros = applyLocalMacroNames(data.macros);
    state.hasReadMacros = true;
  }

  renderDashboard();
  renderLightingControls();
  renderSettingsControls();
  renderKeyboard();
  renderMacros();
  updateApplyButtonsState();
}

function formatPartialFailure(res) {
  const completed = Array.isArray(res.completedSections) && res.completedSections.length
    ? ` completed: ${res.completedSections.join(', ')}.`
    : '';
  const failed = res.failedSection ? ` failed section: ${res.failedSection}.` : '';
  const uncertain = res.uncertain ? ' Write was acknowledged but readback did not match (uncertain device state).' : '';
  return `${res.error || 'Operation failed'}.${completed}${failed}${uncertain} This restore is not atomic.`;
}

function renderEditTargetBar() {
  const hw = document.getElementById('hardware-active-label');
  const ed = document.getElementById('editing-label');
  const sel = document.getElementById('edit-profile-select');
  if (hw) hw.textContent = t('sidebar.hardwareActive', { n: state.activeProfile + 1 });
  if (ed) ed.textContent = `${t('sidebar.editing', { n: state.editingProfile + 1 })} · Layer ${state.activeLayer}`;
  if (sel && String(sel.value) !== String(state.editingProfile)) {
    sel.value = String(state.editingProfile);
  }
  const enableBtn = document.getElementById('btn-enable-fourth');
  if (enableBtn) {
    const count = state.base?.profileCount || 3;
    enableBtn.disabled = count >= 4;
  }
}

async function handleLoadEditTarget() {
  const sel = document.getElementById('edit-profile-select');
  const profile = parseInt(sel?.value || '0', 10);
  if (!(await prepareProfileSwitch())) {
    if (sel) sel.value = String(state.editingProfile);
    return { success: false, blocked: true };
  }
  state.editSource = { kind: 'onboard', profileIndex: Number.isInteger(profile) ? profile : 0 };
  state.localPreviewData = null;
  if (typeof api.setEditSource === 'function') {
    await api.setEditSource({ kind: 'onboard', profileIndex: state.editSource.profileIndex });
  }
  haltMacroRecording('edit-target');
  haltKeyRecorder('edit-target');
  const captured = {
    gen: ++state.editGeneration,
    resetEpoch: state.resetEpoch,
    profile,
    layer: state.activeLayer
  };
  state.loadInFlight = true;
  abortLightingScheduler();
  abortSettingsScheduler();
  updateApplyButtonsState();
  renderLightingControls();
  return runLoadEditTarget(captured);
}

async function runLoadEditTarget(captured) {
  try {
    const quiet = await waitForLightingWorkerQuiet(captured);
    if (!quiet) {
      if (loadRequestCurrent(captured) && state.lightingSaveWorkerBusy) {
        showToast('Still saving lighting. Load for editing did not start.', 'warning');
      }
      return;
    }
    const keymapQuiet = await waitForKeymapWorkerQuiet(captured);
    if (!keymapQuiet) {
      if (loadRequestCurrent(captured) && keymapSaveGate.pending > 0) {
        showToast('Still saving key bindings. Load for editing did not start.', 'warning');
      }
      return;
    }
    const settingsQuiet = await waitForSettingsWorkerQuiet(captured);
    if (!settingsQuiet) {
      if (loadRequestCurrent(captured) && settingsSaveGate.pending > 0) {
        showToast('Still saving performance settings. Load for editing did not start.', 'warning');
      }
      return;
    }
    await api.setEditTarget(captured.profile, captured.layer);
    if (!loadRequestCurrent(captured)) return;
    state.editingProfile = captured.profile;
    state.editSource = { kind: 'onboard', profileIndex: captured.profile };
    if (typeof api.setEditSource === 'function') {
      void api.setEditSource({ kind: 'onboard', profileIndex: captured.profile, layer: captured.layer });
    }
    invalidateEditorSnapshots();
    updateApplyButtonsState();
    renderSettingsControls();
    renderEditTargetBar();
    showToast(`Loading Profile ${captured.profile + 1} for editing (does not activate hardware)…`, 'info');
    const readWaitStarted = Date.now();
    while (state.loadReadActive > 0 && loadRequestCurrent(captured)) {
      if (Date.now() - readWaitStarted >= 20000) {
        showToast('Another profile is still loading. Load for editing did not start.', 'warning');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!loadRequestCurrent(captured)) return;
    if (state.lightingSaveWorkerBusy) state.loadStartedWhileWorkerBusy = true;
    state.loadReadActive += 1;
    if (state.loadReadActive > 1) state.loadReadOverlap = true;
    let funcRes;
    let layerRes;
    let colorsRes;
    let advRes;
    let macroRes;
    try {
      [funcRes, layerRes, colorsRes, advRes, macroRes] = await Promise.all([
        api.readFuncConfig(captured.profile),
        api.readLayer(captured.profile, captured.layer, false),
        api.readKeyColors(captured.profile),
        api.readAdvanced(captured.profile),
        api.readMacros()
      ]);
    } finally {
      state.loadReadActive = Math.max(0, state.loadReadActive - 1);
    }
    if (!loadRequestCurrent(captured) || !requestStillCurrent(captured)) return;
    const funcOk = Boolean(funcRes && funcRes.success);
    const layerOk = Boolean(layerRes && layerRes.success && Array.isArray(layerRes.keys));
    if (!funcOk || !layerOk) {
      const err = (!funcOk ? (funcRes && funcRes.error) : (layerRes && layerRes.error)) || 'required profile read failed';
      showToast(`Failed to load Profile ${captured.profile + 1} for editing: ${err}`, 'error');
      return;
    }
    if (funcRes.lighting) state.lighting = { ...state.lighting, ...funcRes.lighting };
    if (funcRes.lightMemory) adoptLightMemory(funcRes.lightMemory);
    if (funcRes.stillLibrary || funcRes.gifLibrary || Array.isArray(funcRes.selectedLightEffect)) {
      adoptStillLibrary(funcRes.stillLibrary, {
        confirmedPair: funcRes.selectedLightEffect,
        syncUiToConfirmed: true
      });
      adoptGifLibrary(funcRes.gifLibrary, {
        confirmedPair: funcRes.selectedLightEffect,
        syncUiToConfirmed: true
      });
      if (state.lighting.effect === 0 && (state.selectedStillKey || state.selectedGifKey)) state.mainLightTab = 'local';
    }
    if (funcRes.settings) {
      state.settings = { ...state.settings, ...funcRes.settings };
      if (!state.userChoseLayer) {
        state.activeLayer = (funcRes.settings.macMode & 3) === 2 ? 2 : 0;
      }
      state.hasReadSettings = true;
    } else {
      state.hasReadSettings = false;
    }
    state.lightingDraftDirty = false;
    state.lightingEdited = {};
    state.settingsDraftDirty = false;
    state.settingsEdited = {};
    state.settingsSaveStatus = 'idle';
    state.settingsSaveError = null;
    state.settingsSaveBlocked = false;
    state.settingsFieldErrors = {};
    state.sleepSliderDraft = null;
    PerformanceAutosave.clearFieldRevs(state.settingsFieldRevs, state.settingsPersistedRevs);
    state.lightingHydrateLocked = false;
    state.hasReadLighting = true;

    const physical = new Set((state.layout?.keys || []).map((k) => k.slot));
    const map = {};
    for (const k of layerRes.keys) {
      if (!physical.has(k.index)) continue;
      map[k.index] = k;
    }
    state.layerKeymaps[captured.layer] = map;
    state.hasReadKeymap[captured.layer] = true;
    if (colorsRes && colorsRes.success && Array.isArray(colorsRes.colors)) {
      for (const c of colorsRes.colors) {
        if (c && c.hex) state.stagedKeyColors[c.index] = c.hex;
      }
      state.hasReadKeyColors = true;
    }
    if (advRes && advRes.success) {
      state.advancedRead = advRes;
      if (advRes.customParam && Array.isArray(advRes.customParam.cbKeyIndexList)) {
        adoptCbKeyIndexList(advRes.customParam.cbKeyIndexList);
      }
    }
    if (macroRes && macroRes.success && Array.isArray(macroRes.macros)) {
      state.stagedMacros = applyLocalMacroNames(macroRes.macros);
      state.hasReadMacros = true;
    }
    renderLightingControls();
    renderSettingsControls();
    renderKeyboard();
    renderMacros();
    renderAdvancedPanel();
    renderEditTargetBar();
    showToast(`Editing Profile ${captured.profile + 1}. Hardware active profile unchanged.`, 'success');
  } catch (err) {
    if (!loadRequestCurrent(captured)) return;
    showToast(`Failed to load edit target: ${err.message}`, 'error');
  } finally {
    if (captured.gen === state.editGeneration) {
      state.loadInFlight = false;
      updateApplyButtonsState();
      renderSettingsControls();
      renderLightingControls();
    }
  }
}

async function handleActivateEditProfile() {
  if (isLocalPreview()) {
    await handleMoveLocalToOnboard(state.editSource.key, null, true);
    return;
  }
  await handleSwitchProfile(state.editingProfile);
}

async function handleEnableFourthProfile() {
  showToast('Enabling the fourth onboard profile…', 'info');
  try {
    const res = await api.enableProfiles(4);
    if (!res.success) {
      showToast(`Failed to enable 4th profile: ${res.error}`, 'error');
      return;
    }
    if (res.base) state.base = res.base;
    renderDashboard();
    renderEditTargetBar();
    showToast('Fourth onboard profile enabled. Select it as an edit target; it is not auto-activated.', 'success');
  } catch (err) {
    showToast(`Error enabling profile 4: ${err.message}`, 'error');
  }
}

function flattenRemapOptions() {
  const out = [];
  const activeCategories = getActiveRemapCategories() || state.layout?.remapCategories;
  if (!activeCategories) return out;
  for (const [cat, list] of Object.entries(activeCategories)) {
    for (const item of list) {
      out.push({
        label: `${cat}: ${item.label}`,
        type: item.type !== undefined ? item.type : (item.code === 0 ? 0 : 16),
        code1: item.code1 !== undefined ? item.code1 : (item.code >= 224 ? (1 << (item.code - 224)) : 0),
        code2: item.code2 !== undefined ? item.code2 : (item.code >= 224 ? 0 : item.code),
        disabledAdvanceTypes: item.disabledAdvanceTypes || []
      });
    }
  }
  return out;
}

function fillTupleSelect(selectEl, selectedTuple, mode) {
  if (!selectEl) return;
  const options = flattenRemapOptions();
  selectEl.replaceChildren();
  for (const opt of options) {
    if (mode === 'hot' && !(opt.type === 16 && opt.code1 > 0 && opt.code2 === 0)) continue;
    if (mode === 'normal' && !(opt.type === 16 && opt.code1 === 0 && opt.code2 > 0)) continue;
    if (mode === 'ordinary' && !(opt.type === 0 || opt.type === 16 || opt.type === 32 || opt.type === 33 || opt.type === 48 || opt.type === 64 || opt.type === 240)) continue;
    if (mode === 'tgl') {
      if (!(opt.type === 0 || opt.type === 16 || opt.type === 32 || opt.type === 33 || opt.type === 48 || opt.type === 64 || opt.type === 240)) continue;
      if (opt.disabledAdvanceTypes?.includes('tgl') || opt.type === 48 || (opt.type === 240 && (opt.code1 === 250 || opt.code1 === 255))) continue;
    }
    const el = document.createElement('option');
    el.value = `${opt.type},${opt.code1},${opt.code2}`;
    el.textContent = opt.label;
    if (selectedTuple && selectedTuple[0] === opt.type && selectedTuple[1] === opt.code1 && selectedTuple[2] === opt.code2) {
      el.selected = true;
    }
    selectEl.append(el);
  }
}

function remapShortLabel(type, code1, code2) {
  const hit = flattenRemapOptions().find((o) => o.type === type && o.code1 === code1 && o.code2 === code2);
  if (!hit) return null;
  const parts = String(hit.label).split(': ');
  return parts.length > 1 ? parts.slice(1).join(': ') : hit.label;
}

const MODIFIER_MASK_NAMES = [
  [1, 'Ctrl'],
  [2, 'Shift'],
  [4, 'Alt'],
  [8, 'Win'],
  [16, 'RCtrl'],
  [32, 'RShift'],
  [64, 'RAlt'],
  [128, 'RWin']
];

function modifierMaskLabel(mask) {
  const named = remapShortLabel(16, mask, 0);
  if (named) return named;
  if (!Number.isInteger(mask) || mask <= 0) return `modifier ${mask}`;
  const parts = [];
  for (const [bit, name] of MODIFIER_MASK_NAMES) {
    if (mask & bit) parts.push(name);
  }
  return parts.length ? parts.join(' + ') : `modifier ${mask}`;
}

function comboBindingLabel(assigned) {
  const mod = modifierMaskLabel(assigned.code1);
  const key = remapShortLabel(16, 0, assigned.code2) || `key ${assigned.code2}`;
  return `Current combo: ${mod} + ${key}`;
}

function ensureCbSelectOptions() {
  const modEl = document.getElementById('adv-cb-modifier');
  const regEl = document.getElementById('adv-cb-regular');
  if (modEl && modEl.options.length === 0) fillTupleSelect(modEl, null, 'hot');
  if (regEl && regEl.options.length === 0) fillTupleSelect(regEl, null, 'normal');
}

function ensureLoadedModifierOption(mask) {
  const modEl = document.getElementById('adv-cb-modifier');
  if (!modEl || !Number.isInteger(mask) || mask <= 0 || mask > 255) return;
  const value = `16,${mask},0`;
  for (const opt of modEl.options) {
    if (opt.value === value) return;
  }
  const el = document.createElement('option');
  el.value = value;
  el.textContent = `Modifiers & Controls: ${modifierMaskLabel(mask)}`;
  modEl.append(el);
}

function applyCbDraftToSelects() {
  const modEl = document.getElementById('adv-cb-modifier');
  const regEl = document.getElementById('adv-cb-regular');
  const draft = state.cbDraft;
  if (!draft || !modEl || !regEl) return;
  if (draft.modifier) {
    ensureLoadedModifierOption(draft.modifier[1]);
    modEl.value = `${draft.modifier[0]},${draft.modifier[1]},${draft.modifier[2]}`;
  }
  if (draft.regular) regEl.value = `${draft.regular[0]},${draft.regular[1]},${draft.regular[2]}`;
}

function captureCbDraftFromSelects() {
  const modEl = document.getElementById('adv-cb-modifier');
  const regEl = document.getElementById('adv-cb-regular');
  if (!modEl || !regEl || !modEl.value || !regEl.value) return;
  state.cbDraft = {
    modifier: parseTupleSelect(modEl),
    regular: parseTupleSelect(regEl)
  };
}

function cbEditorIdentity() {
  const slot = state.selectedKey ? state.selectedKey.slot : null;
  return `${state.editGeneration}:${state.editingProfile}:${state.activeLayer}:${slot}`;
}

function syncCbEditorSelects() {
  ensureCbSelectOptions();
  const targetKey = cbEditorIdentity();
  if (state.cbEditorTarget === targetKey) {
    applyCbDraftToSelects();
    return;
  }
  state.cbEditorTarget = targetKey;
  const slot = state.selectedKey ? state.selectedKey.slot : null;
  const assigned = Number.isInteger(slot) ? state.layerKeymaps[state.activeLayer]?.[slot] : null;
  const isCb = Boolean(assigned && assigned.type === 16 && assigned.code1 > 0 && assigned.code2 > 0);
  if (isCb) {
    state.cbDraft = {
      modifier: [16, assigned.code1, 0],
      regular: [16, 0, assigned.code2]
    };
  }
  applyCbDraftToSelects();
}

function parseTupleSelect(selectEl) {
  const parts = String(selectEl?.value || '16,0,4').split(',').map((n) => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function fillEligibleKeySelect(selectEl, selectedSlot) {
  if (!selectEl || !state.layout?.keys) return;
  const eligible = new Set(state.layout.eligibleAdvancedSlots || []);
  if (selectEl.options.length === 0) {
    for (const key of state.layout.keys) {
      if (!eligible.has(key.slot) || key.slot === 37 || key.slot === 85) continue;
      const opt = document.createElement('option');
      opt.value = String(key.slot);
      opt.textContent = key.name;
      selectEl.append(opt);
    }
  }
  if (Number.isInteger(selectedSlot) && eligible.has(selectedSlot) && selectedSlot !== 37 && selectedSlot !== 85) {
    selectEl.value = String(selectedSlot);
  }
}

const ADV_KIND_TITLES = {
  mt: 'Hold/Tap (MT)',
  tgl: 'Toggle switch (TGL)',
  socd: 'SOCD',
  cb: 'Key Combination (CB)'
};

function setAdvancedKind(kind) {
  if (!['mt', 'tgl', 'socd', 'cb'].includes(kind)) return;
  state.advancedKind = kind;
  const kindEl = document.getElementById('adv-kind');
  if (kindEl && kindEl.value !== kind) {
    kindEl.value = kind;
    kindEl.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    syncAdvancedKindUi();
  }
}

function syncAdvancedKindUi() {
  const kind = document.getElementById('adv-kind')?.value || state.advancedKind || 'mt';
  state.advancedKind = kind;
  const mt = document.getElementById('adv-mt-fields');
  const tgl = document.getElementById('adv-tgl-fields');
  const socd = document.getElementById('adv-socd-fields');
  const cb = document.getElementById('adv-cb-fields');
  if (mt) mt.hidden = kind !== 'mt';
  if (tgl) tgl.hidden = kind !== 'tgl';
  if (socd) socd.hidden = kind !== 'socd';
  if (cb) cb.hidden = kind !== 'cb';
  const label = document.getElementById('adv-kind-label');
  if (label) label.textContent = `Binding type: ${ADV_KIND_TITLES[kind] || kind}`;
  document.querySelectorAll('.adv-type-card').forEach((card) => {
    card.classList.toggle('selected', card.dataset.kind === kind);
  });
}

function defaultKeyName(slot) {
  const key = (state.layout?.keys || []).find((k) => k.slot === slot);
  return key ? key.name : `Key ${slot}`;
}

function loadAdvancedEditorFromBinding(item) {
  if (!item) return;
  if (Number.isInteger(item.layer) && item.layer !== state.activeLayer) {
    setKeyLayer(item.layer);
  }
  const key = (state.layout?.keys || []).find((k) => k.slot === item.slot);
  if (key) selectKey(key);
  setAdvancedKind(item.kind);
  const assigned = state.layerKeymaps[item.layer]?.[item.slot];
  if (item.kind === 'mt' && assigned) {
    const entry = state.advancedRead && Array.isArray(state.advancedRead.mt)
      ? state.advancedRead.mt[assigned.code1]
      : null;
    if (entry && entry.rawTap) fillTupleSelect(document.getElementById('adv-tap-select'), entry.rawTap, 'ordinary');
    if (entry && entry.rawHold) fillTupleSelect(document.getElementById('adv-hold-select'), entry.rawHold, 'ordinary');
    const delay = document.getElementById('adv-delay');
    const delayVal = document.getElementById('adv-delay-val');
    if (delay && Number.isInteger(assigned.code2)) {
      delay.value = String(assigned.code2 * 10);
      if (delayVal) delayVal.textContent = `${delay.value} ms`;
    }
  } else if (item.kind === 'tgl' && assigned) {
    const entry = state.advancedRead && Array.isArray(state.advancedRead.tgl)
      ? state.advancedRead.tgl[assigned.code1]
      : null;
    if (entry && entry.rawTarget) fillTupleSelect(document.getElementById('adv-target-select'), entry.rawTarget, 'tgl');
  } else if (item.kind === 'socd') {
    fillEligibleKeySelect(document.getElementById('adv-partner-select'), item.partnerSlot);
    const extras = state.advancedRead && Array.isArray(state.advancedRead.keyExtras)
      ? state.advancedRead.keyExtras[item.slot]
      : null;
    const pri = document.getElementById('adv-priority');
    if (pri && extras && Number.isInteger(extras.priority)) pri.value = String(extras.priority);
  } else if (item.kind === 'cb' && assigned) {
    state.cbDraft = {
      modifier: [16, assigned.code1, 0],
      regular: [16, 0, assigned.code2]
    };
    applyCbDraftToSelects();
  }
}

function renderAdvancedBindingList() {
  const listEl = document.getElementById('advanced-binding-list');
  const countEl = document.getElementById('advanced-binding-count');
  const emptyEl = document.getElementById('advanced-binding-empty');
  if (!listEl) return;
  const items = KeyConfig.collectAdvancedBindings(
    state.layerKeymaps,
    cbSlotsForLayer,
    physicalSlotsList()
  );
  if (countEl) countEl.textContent = `${items.length}/${KeyConfig.ADVANCED_LIST_CAP}`;
  if (emptyEl) emptyEl.hidden = items.length > 0;
  listEl.replaceChildren();
  const selectedSlot = state.selectedKey ? state.selectedKey.slot : null;
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'adv-binding-item';
    row.setAttribute('role', 'listitem');
    row.dataset.bindingId = item.id;
    if (item.layer === state.activeLayer && item.slot === selectedSlot) row.classList.add('selected');
    const keys = document.createElement('div');
    keys.className = 'adv-binding-keys';
    const cap1 = document.createElement('span');
    cap1.className = 'adv-binding-keycap';
    cap1.textContent = defaultKeyName(item.slot);
    keys.append(cap1);
    if (Number.isInteger(item.partnerSlot) && item.reciprocal !== false) {
      const cap2 = document.createElement('span');
      cap2.className = 'adv-binding-keycap';
      cap2.textContent = defaultKeyName(item.partnerSlot);
      keys.append(cap2);
    }
    const meta = document.createElement('div');
    meta.className = 'adv-binding-meta';
    const kind = document.createElement('span');
    kind.className = 'adv-binding-kind';
    kind.textContent = item.malformed ? `${(item.kind || '').toUpperCase()} (broken pair)` : (item.kind || '').toUpperCase();
    const layer = document.createElement('span');
    layer.className = 'adv-binding-layer';
    layer.textContent = KeyConfig.ADVANCED_LAYER_LABELS[item.layer] || `Layer ${item.layer}`;
    meta.append(kind, layer);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'adv-binding-delete';
    del.setAttribute('aria-label', `Delete ${item.kind} binding`);
    del.textContent = '×';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      state.advancedDeleteConfirmId = state.advancedDeleteConfirmId === item.id ? '' : item.id;
      renderAdvancedBindingList();
    });
    row.append(keys, meta, del);
    if (state.advancedDeleteConfirmId === item.id) {
      const tip = document.createElement('div');
      tip.className = 'adv-binding-confirm';
      const p = document.createElement('p');
      p.textContent = 'Are you sure you want to delete this advanced key?';
      const actions = document.createElement('div');
      actions.className = 'adv-binding-confirm-actions';
      const yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'action-btn danger-subtle';
      yes.textContent = 'Delete';
      yes.addEventListener('click', (ev) => {
        ev.stopPropagation();
        state.advancedDeleteConfirmId = '';
        void handleRemoveAdvancedAt(item.layer, item.slot);
      });
      const no = document.createElement('button');
      no.type = 'button';
      no.className = 'action-btn';
      no.textContent = 'Cancel';
      no.addEventListener('click', (ev) => {
        ev.stopPropagation();
        state.advancedDeleteConfirmId = '';
        renderAdvancedBindingList();
      });
      actions.append(yes, no);
      tip.append(p, actions);
      row.append(tip);
    }
    row.addEventListener('click', () => {
      state.advancedDeleteConfirmId = '';
      loadAdvancedEditorFromBinding(item);
    });
    listEl.append(row);
  }
}

function renderBindingTestLists() {
  const now = Date.now();
  state.bindingTestPress = KeyConfig.pruneBindingTestEvents(state.bindingTestPress, now);
  state.bindingTestRelease = KeyConfig.pruneBindingTestEvents(state.bindingTestRelease, now);
  const fill = (id, items) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.replaceChildren();
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'adv-test-chip';
      li.textContent = bindingTestLabel(item.code);
      el.append(li);
    }
  };
  fill('adv-test-press', state.bindingTestPress);
  fill('adv-test-release', state.bindingTestRelease);
}

function bindingTestLabel(code) {
  const hid = parseInt(code, 10);
  if (Number.isInteger(hid) && hid > 0) {
    const named = remapShortLabel(16, 0, hid);
    if (named) return named;
  }
  return String(code);
}

function advancedToCodeInfo(event) {
  const hid = event && event.code && DOM_KEY_TO_HID[event.code];
  if (!hid) return null;
  return { keyCode: hid };
}

function onAdvancedBindingTestKey(event, isDown) {
  if (state.activeTab !== 'advanced') return;
  const code = KeyConfig.toBindingTestCode(event, advancedToCodeInfo);
  if (code == null) return;
  const now = Date.now();
  if (isDown) {
    state.bindingTestPress = KeyConfig.pushBindingTestEvent(
      state.bindingTestPress,
      code,
      now,
      KeyConfig.BINDING_TEST_MAX,
      KeyConfig.BINDING_TEST_EXPIRE_MS
    );
  } else {
    state.bindingTestRelease = KeyConfig.pushBindingTestEvent(
      state.bindingTestRelease,
      code,
      now,
      KeyConfig.BINDING_TEST_MAX,
      KeyConfig.BINDING_TEST_EXPIRE_MS
    );
  }
  renderBindingTestLists();
}

function startAdvancedBindingTester() {
  if (state.bindingTestListening) return;
  state.bindingTestKeyDown = (event) => onAdvancedBindingTestKey(event, true);
  state.bindingTestKeyUp = (event) => onAdvancedBindingTestKey(event, false);
  document.addEventListener('keydown', state.bindingTestKeyDown);
  document.addEventListener('keyup', state.bindingTestKeyUp);
  state.bindingTestListening = true;
  if (state.bindingTestTimer) clearInterval(state.bindingTestTimer);
  state.bindingTestTimer = setInterval(() => renderBindingTestLists(), 250);
}

function stopAdvancedBindingTester() {
  if (state.bindingTestKeyDown) document.removeEventListener('keydown', state.bindingTestKeyDown);
  if (state.bindingTestKeyUp) document.removeEventListener('keyup', state.bindingTestKeyUp);
  state.bindingTestKeyDown = null;
  state.bindingTestKeyUp = null;
  state.bindingTestListening = false;
  if (state.bindingTestTimer) {
    clearInterval(state.bindingTestTimer);
    state.bindingTestTimer = null;
  }
}

function syncAdvancedBindingTester() {
  if (state.activeTab === 'advanced') startAdvancedBindingTester();
  else stopAdvancedBindingTester();
}

function renderAdvancedPanel() {
  fillTupleSelect(document.getElementById('adv-tap-select'), null, 'ordinary');
  fillTupleSelect(document.getElementById('adv-hold-select'), null, 'ordinary');
  fillTupleSelect(document.getElementById('adv-target-select'), null, 'tgl');
  syncCbEditorSelects();
  const selectedSlot = state.selectedKey ? state.selectedKey.slot : null;
  fillEligibleKeySelect(document.getElementById('adv-key-select'), selectedSlot);
  fillEligibleKeySelect(document.getElementById('adv-partner-select'), null);
  syncAdvancedKindUi();
  const info = document.getElementById('advanced-selected-info');
  if (info) {
    if (state.selectedKey) {
      info.textContent = `${state.selectedKey.name} · Profile ${state.editingProfile + 1} · Layer ${state.activeLayer}`;
    } else {
      info.textContent = 'Choose a physical key here or on the Key Mapping tab.';
    }
  }
  const bindEl = document.getElementById('advanced-current-binding');
  const assigned = state.selectedKey ? state.layerKeymaps[state.activeLayer]?.[state.selectedKey.slot] : null;
  if (bindEl) {
    if (assigned && (assigned.type === 145 || assigned.type === 146 || assigned.type === 148)) {
      bindEl.textContent = `Current: type ${assigned.type} code1 ${assigned.code1} code2 ${assigned.code2}`;
    } else if (assigned && assigned.type === 16 && assigned.code1 > 0 && assigned.code2 > 0) {
      bindEl.textContent = comboBindingLabel(assigned);
    } else {
      bindEl.textContent = 'No advanced binding on this key.';
    }
  }
  const usage = document.getElementById('advanced-table-usage');
  if (usage && state.advancedRead?.references) {
    const mt = state.advancedRead.references.mt;
    const tgl = state.advancedRead.references.tgl;
    const mtN = mt && typeof mt.size === 'number' ? mt.size : (Array.isArray(mt) ? mt.length : (mt ? Object.keys(mt).length : 0));
    const tglN = tgl && typeof tgl.size === 'number' ? tgl.size : (Array.isArray(tgl) ? tgl.length : (tgl ? Object.keys(tgl).length : 0));
    usage.textContent = `MT ${mtN}/32 · TGL ${tglN}/32 referenced (shared across all 4 layers)`;
  }
  renderAdvancedBindingList();
  renderBindingTestLists();
  syncAdvancedBindingTester();
}

async function handleReadAdvanced() {
  const captured = { gen: state.editGeneration, resetEpoch: state.resetEpoch, profile: state.editingProfile };
  try {
    const res = await api.readAdvanced(captured.profile);
    if (!requestStillCurrent(captured)) return;
    if (!res.success) {
      showToast(`Failed to read advanced tables: ${res.error}`, 'error');
      return;
    }
    state.advancedRead = res;
    if (res.customParam && Array.isArray(res.customParam.cbKeyIndexList)) {
      adoptCbKeyIndexList(res.customParam.cbKeyIndexList);
    }
    renderAdvancedPanel();
    showToast('Advanced tables read for edit-target profile.', 'success');
  } catch (err) {
    if (!requestStillCurrent(captured)) return;
    showToast(`Error reading advanced: ${err.message}`, 'error');
  }
}

async function handleApplyAdvanced() {
  if (isLocalPreview()) {
    const res = await applyAdvancedLocally();
    showToast(
      res.success ? 'Saved to custom profile (keyboard not written).' : (res.error || 'Couldn’t save'),
      res.success ? 'success' : (res.stale ? 'warning' : 'error')
    );
    return res;
  }
  if (state.loadInFlight) return;
  if (!state.selectedKey) {
    showToast('Select an eligible physical key first.', 'warning');
    return;
  }
  const captured = { gen: state.editGeneration, resetEpoch: state.resetEpoch, profile: state.editingProfile, layer: state.activeLayer };
  const spec = buildAdvancedSpecFromEditor(captured.profile, captured.layer, state.selectedKey.slot);
  const errEl = document.getElementById('advanced-error');
  try {
    const res = await api.applyAdvanced(spec);
    if (!requestStillCurrent(captured)) return;
    if (!res.success) {
      const msg = formatPartialFailure(res);
      if (errEl) { errEl.hidden = false; errEl.textContent = msg; }
      showToast(msg, 'error', 8000);
      return;
    }
    if (errEl) errEl.hidden = true;
    await handleReadLayer();
    await handleReadAdvanced();
    if (!requestStillCurrent(captured)) return;
    showToast('Advanced binding applied.', 'success');
  } catch (err) {
    if (!requestStillCurrent(captured)) return;
    showToast(`Advanced apply failed: ${err.message}`, 'error');
  }
}

function stageLocalTuple(layer, slot, tuple) {
  if (!state.layerKeymaps[layer]) state.layerKeymaps[layer] = {};
  state.layerKeymaps[layer][slot] = {
    slot,
    type: tuple.type,
    code1: tuple.code1,
    code2: tuple.code2,
    code: tuple.code2 || tuple.code1,
    label: bindingLabel(tuple)
  };
  KeyConfig.bumpSlotRev(state.keymapSlotRevs, layer, slot);
}

function currentLocalAdvancedSnapshot() {
  const prev = state.localPreviewData || {};
  const advancedRaw = Object.assign(
    {},
    prev.advanced || {},
    (state.advancedRead && state.advancedRead.raw) || {}
  );
  const customParam = Object.assign(
    {},
    prev.customParam || {},
    { cbKeyIndexList: KeyConfig.copyCbKeyIndexList(state.cbKeyIndexList) }
  );
  const customParamRaw = customParam.raw !== undefined
    ? customParam.raw
    : customParamRawFromAdvanced(advancedRaw);
  return {
    layers: {
      0: state.layerKeymaps[0] || {},
      1: state.layerKeymaps[1] || {},
      2: state.layerKeymaps[2] || {},
      3: state.layerKeymaps[3] || {}
    },
    advanced: advancedRaw,
    customParam,
    customParamRaw
  };
}

function currentAdvancedSaveIdentity() {
  return {
    gen: state.editGeneration,
    resetEpoch: state.resetEpoch,
    profile: state.editingProfile,
    source: currentProfileSource()
  };
}

function adoptLocalAdvancedTables(res) {
  if (res.customParam && Array.isArray(res.customParam.cbKeyIndexList)) {
    adoptCbKeyIndexList(res.customParam.cbKeyIndexList);
  } else if (res.nextCbList) {
    adoptCbKeyIndexList(res.nextCbList);
  }
  if (res.advanced || res.raw) {
    const sourceRaw = res.raw || res.advanced || {};
    const raw = advancedSectionFromRaw(sourceRaw);
    const customRaw = customParamRawFromAdvanced(sourceRaw);
    const nextCustomParam = Object.assign(
      {},
      (state.localPreviewData && state.localPreviewData.customParam) || {},
      res.customParam || {}
    );
    if (customRaw !== undefined) nextCustomParam.raw = customRaw;
    state.advancedRead = {
      success: true,
      mt: res.mt,
      tgl: res.tgl,
      keyExtras: res.keyExtras,
      customParam: res.customParam || state.advancedRead?.customParam,
      raw,
      references: res.references
    };
    if (!state.localPreviewData) state.localPreviewData = {};
    state.localPreviewData.advanced = Object.assign({}, state.localPreviewData.advanced || {}, raw);
    state.localPreviewData.customParam = nextCustomParam;
  }
}

function guessedAdvancedChangedSlots(spec) {
  const out = [{ layer: spec.layer, slot: spec.slot }];
  if (spec.kind === 'socd' && Number.isInteger(spec.partnerSlot)) {
    out.push({ layer: spec.layer, slot: spec.partnerSlot });
  }
  const current = state.layerKeymaps[spec.layer] && state.layerKeymaps[spec.layer][spec.slot];
  if (current && current.type === 148 && Number.isInteger(current.code2)) {
    out.push({ layer: spec.layer, slot: current.code2 });
  }
  return out;
}

function capturedAdvancedSlots(spec) {
  const out = guessedAdvancedChangedSlots(spec);
  for (const slot of physicalSlotsList()) out.push({ layer: spec.layer, slot });
  return out;
}

async function maybeDelayLocalAdvanced() {
  const ms = state.harness && window.__maicongHarness && Number(window.__maicongHarness.delayAdvancedLocalMs);
  if (Number.isInteger(ms) && ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function finishOwnedLocalAdvanced(res, capturedKeys) {
  const changedSlots = Array.isArray(res.changedSlots) && res.changedSlots.length
    ? res.changedSlots
    : (res.plannedBindings || []).map((b) => ({ layer: b.layer, slot: b.slot }));
  if (KeyConfig.unplannedAdvancedRevChanged(
    state.keymapSlotRevs,
    capturedKeys,
    changedSlots,
    state.layerKeymaps,
    cbSlotsForLayer
  )) {
    return { ok: false, stale: true, error: 'A newer advanced edit made this local save incoherent' };
  }
  if (changedSlots.length === 0) {
    return { ok: true, applied: [], ownedKeys: capturedKeys, previous: [] };
  }
  const previous = changedSlots.map((item) => {
    const currentLayer = state.layerKeymaps[item.layer] || state.layerKeymaps[String(item.layer)] || {};
    const tuple = currentLayer[item.slot] || currentLayer[String(item.slot)];
    return {
      layer: item.layer,
      slot: item.slot,
      tuple: tuple ? { ...tuple } : null
    };
  });
  const merged = KeyConfig.mergeOwnedAdvancedBindings(
    state.layerKeymaps,
    res.layers,
    changedSlots,
    state.keymapSlotRevs,
    capturedKeys
  );
  if (!merged.ok) return merged;
  for (const item of merged.applied) {
    const tuple = merged.maps[item.layer][item.slot];
    if (tuple && !tuple.label) tuple.label = bindingLabel(tuple);
  }
  state.layerKeymaps = merged.maps;
  return { ok: true, applied: merged.applied, ownedKeys: capturedKeys, previous };
}

function rollbackOwnedLocalAdvanced(finished, capturedKeys) {
  if (!finished || !Array.isArray(finished.previous)) return;
  const next = {
    0: Object.assign({}, state.layerKeymaps[0] || state.layerKeymaps['0']),
    1: Object.assign({}, state.layerKeymaps[1] || state.layerKeymaps['1']),
    2: Object.assign({}, state.layerKeymaps[2] || state.layerKeymaps['2']),
    3: Object.assign({}, state.layerKeymaps[3] || state.layerKeymaps['3'])
  };
  for (const item of finished.previous) {
    const key = KeyConfig.slotRevKey(item.layer, item.slot);
    if ((state.keymapSlotRevs[key] || 0) !== (capturedKeys[key] || 0)) continue;
    if (!next[item.layer]) next[item.layer] = {};
    if (item.tuple) next[item.layer][item.slot] = { ...item.tuple };
    else delete next[item.layer][item.slot];
  }
  state.layerKeymaps = next;
}

function buildAdvancedSpecFromEditor(profileIndex, layer, slot) {
  const kind = document.getElementById('adv-kind')?.value || state.advancedKind || 'mt';
  const spec = { profileIndex, layer, slot, kind };
  if (kind === 'mt') {
    spec.tapKey = parseTupleSelect(document.getElementById('adv-tap-select'));
    spec.holdKey = parseTupleSelect(document.getElementById('adv-hold-select'));
    spec.delayMs = parseInt(document.getElementById('adv-delay')?.value || '150', 10);
  } else if (kind === 'tgl') {
    spec.targetKey = parseTupleSelect(document.getElementById('adv-target-select'));
  } else if (kind === 'socd') {
    spec.partnerSlot = parseInt(document.getElementById('adv-partner-select')?.value || '19', 10);
    spec.priority = parseInt(document.getElementById('adv-priority')?.value || '0', 10);
  } else if (kind === 'cb') {
    captureCbDraftFromSelects();
    spec.modifierKey = parseTupleSelect(document.getElementById('adv-cb-modifier'));
    spec.regularKey = parseTupleSelect(document.getElementById('adv-cb-regular'));
  }
  return spec;
}

async function applyAdvancedLocally() {
  if (!state.selectedKey) {
    return { success: false, error: 'Select an eligible physical key first.', hardwareWrites: 0 };
  }
  const spec = buildAdvancedSpecFromEditor(0, state.activeLayer, state.selectedKey.slot);
  const captured = KeyConfig.captureSaveIdentity(
    currentProfileSource(),
    state.editGeneration,
    state.resetEpoch,
    state.editingProfile
  );
  const capturedKeys = Object.assign(
    {},
    state.keymapSlotRevs,
    KeyConfig.captureSlotRevKeys(state.keymapSlotRevs, capturedAdvancedSlots(spec))
  );
  return keymapSaveGate.enqueue(async () => {
    await maybeDelayLocalAdvanced();
    if (!KeyConfig.saveIdentityMatches(captured, currentAdvancedSaveIdentity())) {
      return { success: false, stale: true, hardwareWrites: 0, error: 'Edit target changed before the local advanced save finished' };
    }
    const snapshot = currentLocalAdvancedSnapshot();
    const res = await api.applyAdvancedLocal({ spec, snapshot });
    if (!KeyConfig.saveIdentityMatches(captured, currentAdvancedSaveIdentity())) {
      return { success: false, stale: true, hardwareWrites: 0, error: 'Edit target changed before the local advanced save finished' };
    }
    if (!res.success) return Object.assign({ hardwareWrites: 0 }, res);
    if (res.hardwareWrites) {
      return { success: false, hardwareWrites: res.hardwareWrites, error: 'Local preview must not write the keyboard.' };
    }
    const finished = finishOwnedLocalAdvanced(res, capturedKeys);
    if (!finished.ok) return Object.assign({ hardwareWrites: 0 }, finished);
    let persisted;
    try {
      persisted = await persistLocalDraft(
        finished.ownedKeys,
        null,
        undefined,
        {
          advanced: res.raw || res.advanced,
          customParam: res.customParam,
          customParamRaw: customParamRawFromAdvanced(res.raw || res.advanced)
        }
      );
    } catch (err) {
      rollbackOwnedLocalAdvanced(finished, capturedKeys);
      renderKeyboard();
      renderAdvancedPanel();
      return {
        success: false,
        hardwareWrites: 0,
        error: err && err.message ? err.message : String(err)
      };
    }
    if (!persisted.success) rollbackOwnedLocalAdvanced(finished, capturedKeys);
    else {
      adoptLocalAdvancedTables(res);
      KeyConfig.markRevSnapshotPersisted(state.keymapSlotPersisted, persisted.snapshotRevs, state.keymapSlotRevs);
    }
    renderKeyboard();
    renderAdvancedPanel();
    return Object.assign({ hardwareWrites: 0 }, persisted.success ? res : persisted);
  });
}

async function removeAdvancedLocally(layer, slot) {
  const current = state.layerKeymaps[layer]?.[slot];
  if (current && current.type === 148 && !KeyConfig.isReciprocalSocdBinding(state.layerKeymaps[layer], slot)) {
    return {
      success: false,
      error: `SOCD slot ${slot} partner ${current.code2} is missing, out of bounds, or not reciprocal. Refusing to mutate an unrelated key.`,
      hardwareWrites: 0
    };
  }
  const spec = { profileIndex: 0, layer, slot, kind: 'remove' };
  const captured = KeyConfig.captureSaveIdentity(
    currentProfileSource(),
    state.editGeneration,
    state.resetEpoch,
    state.editingProfile
  );
  const capturedKeys = Object.assign(
    {},
    state.keymapSlotRevs,
    KeyConfig.captureSlotRevKeys(state.keymapSlotRevs, capturedAdvancedSlots(spec))
  );
  return keymapSaveGate.enqueue(async () => {
    await maybeDelayLocalAdvanced();
    if (!KeyConfig.saveIdentityMatches(captured, currentAdvancedSaveIdentity())) {
      return { success: false, stale: true, hardwareWrites: 0, error: 'Edit target changed before the local advanced save finished' };
    }
    const snapshot = currentLocalAdvancedSnapshot();
    const res = await api.applyAdvancedLocal({ spec, snapshot });
    if (!KeyConfig.saveIdentityMatches(captured, currentAdvancedSaveIdentity())) {
      return { success: false, stale: true, hardwareWrites: 0, error: 'Edit target changed before the local advanced save finished' };
    }
    if (!res.success) return Object.assign({ hardwareWrites: 0 }, res);
    if (res.hardwareWrites) {
      return { success: false, hardwareWrites: res.hardwareWrites, error: 'Local preview must not write the keyboard.' };
    }
    const finished = finishOwnedLocalAdvanced(res, capturedKeys);
    if (!finished.ok) return Object.assign({ hardwareWrites: 0 }, finished);
    let persisted;
    try {
      persisted = await persistLocalDraft(
        finished.ownedKeys,
        null,
        undefined,
        {
          advanced: res.raw || res.advanced,
          customParam: res.customParam,
          customParamRaw: customParamRawFromAdvanced(res.raw || res.advanced)
        }
      );
    } catch (err) {
      rollbackOwnedLocalAdvanced(finished, capturedKeys);
      renderKeyboard();
      renderAdvancedPanel();
      return {
        success: false,
        hardwareWrites: 0,
        error: err && err.message ? err.message : String(err)
      };
    }
    if (!persisted.success) rollbackOwnedLocalAdvanced(finished, capturedKeys);
    else {
      adoptLocalAdvancedTables(res);
      KeyConfig.markRevSnapshotPersisted(state.keymapSlotPersisted, persisted.snapshotRevs, state.keymapSlotRevs);
    }
    renderKeyboard();
    renderAdvancedPanel();
    return Object.assign({ hardwareWrites: 0 }, persisted.success ? res : persisted);
  });
}

async function handleRemoveAdvanced() {
  if (!state.selectedKey) {
    showToast('Select a key first.', 'warning');
    return;
  }
  return handleRemoveAdvancedAt(state.activeLayer, state.selectedKey.slot);
}

async function handleRemoveAdvancedAt(layer, slot) {
  if (state.loadInFlight) return;
  if (isLocalPreview()) {
    const res = await removeAdvancedLocally(layer, slot);
    showToast(
      res.success ? 'Saved to custom profile (keyboard not written).' : (res.error || 'Couldn’t save'),
      res.success ? 'success' : (res.stale ? 'warning' : 'error')
    );
    return res;
  }
  const captured = { gen: state.editGeneration, resetEpoch: state.resetEpoch, profile: state.editingProfile };
  const errEl = document.getElementById('advanced-error');
  try {
    const res = await api.removeAdvanced(captured.profile, layer, slot);
    if (!requestStillCurrent(captured)) return;
    if (!res.success) {
      const msg = formatPartialFailure(res);
      if (errEl) { errEl.hidden = false; errEl.textContent = msg; }
      showToast(msg, 'error', 8000);
      return;
    }
    if (errEl) errEl.hidden = true;
    adoptCbKeyIndexList(KeyConfig.removeCbIndexes(state.cbKeyIndexList, layer, [slot]));
    if (layer !== state.activeLayer) setKeyLayer(layer);
    await handleReadLayer();
    await handleReadAdvanced();
    if (!requestStillCurrent(captured)) return;
    showToast('Advanced binding removed.', 'success');
  } catch (err) {
    if (!requestStillCurrent(captured)) return;
    showToast(`Advanced remove failed: ${err.message}`, 'error');
  }
}

function openAdvancedClearDialog() {
  if (state.loadInFlight) return;
  const dialog = document.getElementById('advanced-clear-dialog');
  if (!dialog) return;
  state.advancedClearDialogOpen = true;
  state.advancedClearOpener = document.activeElement;
  state.advancedClearCaptured = KeyConfig.captureSaveIdentity(
    currentProfileSource(),
    state.editGeneration,
    state.resetEpoch,
    state.editingProfile
  );
  dialog.hidden = false;
  document.getElementById('btn-advanced-clear-confirm')?.focus();
}

function closeAdvancedClearDialog() {
  const dialog = document.getElementById('advanced-clear-dialog');
  if (dialog) dialog.hidden = true;
  state.advancedClearDialogOpen = false;
  if (state.advancedClearOpener && typeof state.advancedClearOpener.focus === 'function') {
    state.advancedClearOpener.focus();
  }
  state.advancedClearOpener = null;
}

async function confirmAdvancedClearDialog() {
  const captured = state.advancedClearCaptured;
  closeAdvancedClearDialog();
  const current = {
    gen: state.editGeneration,
    resetEpoch: state.resetEpoch,
    profile: state.editingProfile,
    source: currentProfileSource()
  };
  if (!KeyConfig.saveIdentityMatches(captured, current)) {
    showToast('Edit target changed. Clear all was not applied.', 'warning');
    return;
  }
  await handleClearAllAdvanced(captured);
}

function clearAdvancedSlotRevsForLayer(layer) {
  const map = state.layerKeymaps[layer] || {};
  const cb = cbSlotsForLayer(layer);
  for (const raw of Object.keys(map)) {
    const slot = Number(raw);
    const tuple = map[slot] || map[raw];
    if (!tuple) continue;
    if (KeyConfig.isAdvancedBinding({ ...tuple, slot }, cb) || KeyConfig.isDefiniteAdvanced(tuple)) {
      delete state.keymapSlotRevs[KeyConfig.slotRevKey(layer, slot)];
      delete state.keymapSlotPersisted[KeyConfig.slotRevKey(layer, slot)];
    }
  }
}

async function handleClearAllAdvanced(identity) {
  if (state.loadInFlight) return;
  const captured = identity || {
    gen: state.editGeneration,
    resetEpoch: state.resetEpoch,
    profile: state.editingProfile,
    source: currentProfileSource()
  };
  const current = {
    gen: state.editGeneration,
    resetEpoch: state.resetEpoch,
    profile: state.editingProfile,
    source: currentProfileSource()
  };
  if (!KeyConfig.saveIdentityMatches(captured, current)) {
    showToast('Edit target changed. Clear all was not applied.', 'warning');
    return;
  }
  const slots = physicalSlotsList();
  const errEl = document.getElementById('advanced-error');

  if (isLocalPreview()) {
    const advancedItems = KeyConfig.collectAdvancedBindings(state.layerKeymaps, cbSlotsForLayer, physicalSlotsList());
    const likely = [];
    for (const item of advancedItems) {
      likely.push({ layer: item.layer, slot: item.slot });
      if (Number.isInteger(item.partnerSlot)) likely.push({ layer: item.layer, slot: item.partnerSlot });
    }
    const allPhysicalSlots = [];
    for (let lyr = 0; lyr < 4; lyr++) {
      for (const slot of slots) allPhysicalSlots.push({ layer: lyr, slot });
    }
    const capturedKeys = Object.assign(
      {},
      state.keymapSlotRevs,
      KeyConfig.captureSlotRevKeys(state.keymapSlotRevs, likely),
      KeyConfig.captureSlotRevKeys(state.keymapSlotRevs, allPhysicalSlots)
    );
    const queued = await keymapSaveGate.enqueue(async () => {
      await maybeDelayLocalAdvanced();
      if (!KeyConfig.saveIdentityMatches(captured, currentAdvancedSaveIdentity())) {
        return { success: false, stale: true, hardwareWrites: 0, error: 'Edit target changed before the local advanced save finished' };
      }
      const snapshot = currentLocalAdvancedSnapshot();
      const res = await api.clearAllAdvancedLocal({ snapshot });
      if (!KeyConfig.saveIdentityMatches(captured, currentAdvancedSaveIdentity())) {
        return { success: false, stale: true, hardwareWrites: 0, error: 'Edit target changed before the local advanced save finished' };
      }
      if (!res.success) return Object.assign({ hardwareWrites: 0 }, res);
      if (res.hardwareWrites) {
        return { success: false, hardwareWrites: res.hardwareWrites, error: 'Local preview must not write the keyboard.' };
      }
      const finished = finishOwnedLocalAdvanced(res, capturedKeys);
      if (!finished.ok) return Object.assign({ hardwareWrites: 0 }, finished);
      let persisted;
      try {
        persisted = await persistLocalDraft(
          finished.ownedKeys,
          null,
          undefined,
          {
            advanced: res.raw || res.advanced,
            customParam: res.customParam,
            customParamRaw: customParamRawFromAdvanced(res.raw || res.advanced)
          }
        );
      } catch (err) {
        rollbackOwnedLocalAdvanced(finished, capturedKeys);
        renderKeyboard();
        renderAdvancedPanel();
        return {
          success: false,
          hardwareWrites: 0,
          error: err && err.message ? err.message : String(err)
        };
      }
      if (!persisted.success) rollbackOwnedLocalAdvanced(finished, capturedKeys);
      else {
        adoptLocalAdvancedTables(res);
        KeyConfig.markRevSnapshotPersisted(state.keymapSlotPersisted, persisted.snapshotRevs, state.keymapSlotRevs);
      }
      return persisted.success ? res : persisted;
    });
    if (!queued.success) {
      showToast(queued.error || 'Couldn’t clear advanced keys', queued.stale ? 'warning' : 'error');
      return;
    }
    renderKeyboard();
    renderAdvancedPanel();
    showToast('Cleared advanced keys on this custom profile (keyboard not written).', 'success');
    return queued;
  }

  for (let layer = 0; layer < 4; layer++) {
    if (!state.hasReadKeymap[layer] && state.connected) {
      const res = await api.readLayer(captured.profile, layer, false);
      if (!requestStillCurrent(captured)) return;
      if (res.success && Array.isArray(res.keys)) {
        const physical = new Set(slots);
        const map = {};
        for (const k of res.keys) {
          if (!physical.has(k.index)) continue;
          map[k.index] = { slot: k.index, type: k.type, code1: k.code1, code2: k.code2, code: k.code2 || k.code1, label: k.label };
        }
        state.layerKeymaps[layer] = KeyConfig.mergeLayerHydration(
          state.layerKeymaps[layer],
          map,
          state.keymapSlotRevs,
          state.keymapSlotPersisted,
          layer
        );
        state.hasReadKeymap[layer] = true;
      } else {
        showToast(`Could not read layer ${layer} before clear-all: ${res.error || 'read failed'}`, 'error');
        return;
      }
    }
  }

  try {
    const res = await api.clearAllAdvanced({ profileIndex: captured.profile });
    if (!requestStillCurrent(captured)) return;
    if (!res.success) {
      const msg = formatPartialFailure(res);
      if (errEl) { errEl.hidden = false; errEl.textContent = msg; }
      showToast(msg, 'error', 8000);
      return;
    }
    if (errEl) errEl.hidden = true;
    for (let layer = 0; layer < 4; layer++) clearAdvancedSlotRevsForLayer(layer);
    for (let layer = 0; layer < 4; layer++) {
      if (!state.hasReadKeymap[layer]) continue;
      const reread = await api.readLayer(captured.profile, layer, false);
      if (!requestStillCurrent(captured)) return;
      if (reread.success && Array.isArray(reread.keys)) {
        const physical = new Set(slots);
        const map = {};
        for (const k of reread.keys) {
          if (!physical.has(k.index)) continue;
          map[k.index] = { slot: k.index, type: k.type, code1: k.code1, code2: k.code2, code: k.code2 || k.code1, label: k.label };
        }
        state.layerKeymaps[layer] = KeyConfig.mergeLayerHydration(
          state.layerKeymaps[layer],
          map,
          state.keymapSlotRevs,
          state.keymapSlotPersisted,
          layer
        );
      }
    }
    await handleReadAdvanced();
    if (!requestStillCurrent(captured)) return;
    renderKeyboard();
    showToast('Cleared advanced keys on all four layers. Ordinary remaps were left in place.', 'success');
  } catch (err) {
    if (!requestStillCurrent(captured)) return;
    showToast(`Advanced clear-all failed: ${err.message}`, 'error');
  }
}

function handleApplyCalibration() {
  if (!state.connected || state.loadInFlight || !state.hasReadLighting) return;
  if (state.lightingReadInFlight && !state.lightingCalInFlight) return;
  const r = parseInt(document.getElementById('cal-r')?.value || '255', 10);
  const g = parseInt(document.getElementById('cal-g')?.value || '255', 10);
  const b = parseInt(document.getElementById('cal-b')?.value || '255', 10);
  if (![r, g, b].every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return;
  state.lightingCalQueued = { r, g, b };
  if (state.lightingSaveTimer) {
    clearTimeout(state.lightingSaveTimer);
    state.lightingSaveTimer = null;
    state.lightingSaveQueued = true;
  }
  void runLightingSaveWorker();
}

function keymapShortcutTargetIsField(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return Boolean(el.isContentEditable);
}

function attachKeyConfigListeners() {
  if (!KeyConfig) return;
  document.addEventListener('keydown', (event) => {
    if (state.keymapResetDialogOpen && event.key === 'Escape') {
      event.preventDefault();
      closeKeymapResetDialog();
      return;
    }
    if (state.advancedClearDialogOpen && event.key === 'Escape') {
      event.preventDefault();
      closeAdvancedClearDialog();
      return;
    }
    if (state.advancedDeleteConfirmId && event.key === 'Escape') {
      event.preventDefault();
      state.advancedDeleteConfirmId = '';
      renderAdvancedBindingList();
      return;
    }
    handleKeyRecordEvent(event, true);
    if (state.keyRecorder && state.keyRecorder.active && keyRecordCaptureFocused()) return;
    if (state.activeTab !== 'keymap') return;
    if (keymapShortcutTargetIsField(event.target)) return;
    const meta = event.metaKey || event.ctrlKey;
    if (!meta) return;
    const key = String(event.key || '').toLowerCase();
    if (key === 'c') {
      event.preventDefault();
      handleCopyKey();
    } else if (key === 'x') {
      event.preventDefault();
      void handleCutKey();
    } else if (key === 'v') {
      event.preventDefault();
      void handlePasteKey();
    }
  });
  document.addEventListener('keyup', (event) => {
    handleKeyRecordEvent(event, false);
  });
  window.addEventListener('blur', () => {
    if (state.keyRecorder && state.keyRecorder.active) haltKeyRecorder('blur');
  });
}

function attachAdvancedListeners() {
  const kind = document.getElementById('adv-kind');
  if (kind) {
    kind.addEventListener('change', () => {
      syncAdvancedKindUi();
    });
  }
  const cbMod = document.getElementById('adv-cb-modifier');
  const cbReg = document.getElementById('adv-cb-regular');
  if (cbMod) cbMod.addEventListener('change', () => captureCbDraftFromSelects());
  if (cbReg) cbReg.addEventListener('change', () => captureCbDraftFromSelects());
  const keySel = document.getElementById('adv-key-select');
  if (keySel) {
    keySel.addEventListener('change', () => {
      const slot = parseInt(keySel.value, 10);
      const key = (state.layout?.keys || []).find((k) => k.slot === slot);
      if (!key || key.slot === 37 || key.slot === 85) return;
      selectKey(key);
    });
  }
  const delay = document.getElementById('adv-delay');
  const delayVal = document.getElementById('adv-delay-val');
  if (delay && delayVal) {
    delay.addEventListener('input', () => {
      delayVal.textContent = `${delay.value} ms`;
    });
  }
  for (const id of ['cal-r', 'cal-g', 'cal-b']) {
    const el = document.getElementById(id);
    const val = document.getElementById(`${id}-val`);
    if (el && val) {
      el.addEventListener('input', () => {
        if (el.disabled || !canEditLighting()) return;
        val.textContent = el.value;
      });
    }
  }
}

/**
 * Initialize application
 */
async function handleSetLocale(locale) {
  if (api.setLocale) {
    const res = await api.setLocale(locale);
    if (I18n && res && res.locale) I18n.setLocale(res.locale);
  } else if (I18n) {
    I18n.setLocale(locale);
  }
  refreshLocaleUi();
}

async function init() {
  if (api.getLocale) {
    try {
      const loc = await api.getLocale();
      if (I18n && loc && loc.locale) I18n.setLocale(loc.locale);
    } catch {}
  } else if (I18n) {
    I18n.setLocale('zh');
  }
  if (I18n && typeof I18n.apply === 'function') I18n.apply(document);
  if (typeof api.isHarness === 'function') {
    try { state.harness = Boolean(await api.isHarness()); } catch { state.harness = false; }
  }
  if (typeof api.getMacroMetadata === 'function') {
    try {
      const res = await api.getMacroMetadata();
      if (res && res.success && res.meta) state.macroMeta = MacroDraft.parseStoredMetadata(res.meta).meta;
    } catch {
      state.macroMeta = MacroDraft.defaultMetadata();
    }
  }
  if (!state.macroMeta) state.macroMeta = MacroDraft.defaultMetadata();
  installHarnessHooks();
  attachLightingListeners();
  attachSettingsListeners();
  attachKeyConfigListeners();
  updateApplyButtonsState();
  attachMacroListeners();
  attachAdvancedListeners();
  renderEditTargetBar();
  if (KeyConfig) state.keyRecorder = KeyConfig.emptyRecorder();

  // Load layout definitions
  try {
    state.layout = await api.getLayout();
    renderKeyboard();
    renderPalette();
    renderMacros();
    renderLightingControls();
    renderAdvancedPanel();
    renderEditTargetBar();
  } catch (err) {
    console.error('[Renderer] Failed to load layout:', err);
  }

  // Subscribe to live device state broadcasts
  api.onStateUpdate(devState => {
    updateFromDeviceState(devState);
  });

  // Subscribe to menu navigation
  api.onNavigateTab(tab => {
    switchTab(tab);
  });

  if (typeof api.onFirmwareProgress === 'function') {
    api.onFirmwareProgress((event) => {
      const progress = document.getElementById('firmware-progress');
      if (progress && event && event.message) {
        progress.hidden = false;
        progress.textContent = event.message;
      }
    });
  }

  // Initial scan and load
  await scanHardware();
  await refreshLightingMemoryPref();
}

function editorSnapshot() {
  try {
  return {
    connected: Boolean(state.connected),
    editingProfile: state.editingProfile,
    activeProfile: state.activeProfile,
    activeLayer: state.activeLayer,
    editGeneration: state.editGeneration,
    loadInFlight: state.loadInFlight,
    loadReadOverlap: Boolean(state.loadReadOverlap),
    loadStartedWhileWorkerBusy: Boolean(state.loadStartedWhileWorkerBusy),
    loadReadActive: Number(state.loadReadActive) || 0,
    hasReadLighting: state.hasReadLighting,
    hasReadSettings: state.hasReadSettings,
    hasReadKeymap: {
      0: Boolean(state.hasReadKeymap[0]),
      1: Boolean(state.hasReadKeymap[1]),
      2: Boolean(state.hasReadKeymap[2]),
      3: Boolean(state.hasReadKeymap[3])
    },
    hasReadKeyColors: state.hasReadKeyColors,
    hasReadMacros: state.hasReadMacros,
    lightingBrightness: state.lighting.brightness,
    lightingEffect: state.lighting.effect,
    macMode: state.settings.macMode,
    sleepTime: state.settings.sleepTime,
    sleepMode: state.settings.sleepMode,
    debounceLevel: state.settings.debounceLevel,
    keyComboEnabled: Boolean(state.settings.debounceLevel !== undefined && state.settings.debounceLevel >= 1),
    reporteRate: state.settings.reporteRate,
    lockWin: Boolean(state.settings.lockWin),
    winLockDisabled: Boolean(document.getElementById('setting-lock-win')?.disabled),
    sleepSliderDisabled: Boolean(document.getElementById('setting-sleep-time')?.disabled),
    sleepLabel: document.getElementById('setting-sleep-time-val')?.textContent || '',
    neverSleepChecked: Boolean(document.getElementById('setting-never-sleep')?.checked),
    pollingSelectedText: (() => {
      const checked = document.querySelector('#setting-polling-rate input[name="setting-polling-rate"]:checked');
      if (checked) return (checked.parentElement && checked.parentElement.textContent) ? checked.parentElement.textContent.trim() : checked.value;
      const rate = state.settings.reporteRate;
      if (rate !== undefined && rate !== null && !isSupportedReportRate(rate)) return `Unknown (${rate})`;
      return '';
    })(),
    pollingHint: document.getElementById('setting-polling-rate-hint')?.textContent || '',
    pollingGroupDisabled: Boolean(document.getElementById('setting-polling-rate')?.disabled),
    settingsDraftDirty: Boolean(state.settingsDraftDirty || PerformanceAutosave.hasDirty(state.settingsEdited)),
    settingsSaveStatus: state.settingsSaveStatus || 'idle',
    settingsSaveError: state.settingsSaveError || '',
    settingsSaveStatusText: document.getElementById('settings-save-status')?.textContent || '',
    settingsSaveBlocked: Boolean(state.settingsSaveBlocked),
    settingsSavePending: settingsSaveGate.pending,
    settingsOpInFlight: Boolean(state.settingsOpInFlight),
    settingsReadInFlight: Boolean(state.settingsReadInFlight),
    settingsRetryHidden: Boolean(document.getElementById('btn-retry-settings-save')?.hidden),
    settingsEditedKeys: Object.keys(state.settingsEdited || {}).sort(),
    settingsFieldRevs: Object.assign({}, state.settingsFieldRevs),
    settingsPersistedRevs: Object.assign({}, state.settingsPersistedRevs),
    settingsFieldErrors: Object.assign({}, state.settingsFieldErrors),
    canEditSettings: Boolean(state.connected && !state.loadInFlight && state.hasReadSettings),
    readSettingsDisabled: Boolean(document.querySelector('[data-action="read-settings"]')?.disabled),
    localPreviewSettings: (state.localPreviewData && state.localPreviewData.settings) || null,
    applyLightingDisabled: Boolean(document.getElementById('btn-apply-lighting')?.disabled),
    applySettingsDisabled: Boolean(document.getElementById('btn-apply-settings')?.disabled),
    applySettingsHidden: Boolean(document.getElementById('btn-apply-settings')?.hidden),
    applyKeymapDisabled: Boolean(document.getElementById('btn-apply-keymap')?.disabled),
    toast: document.getElementById('toast-message')?.textContent || '',
    toastType: document.getElementById('toast-banner')?.className || '',
    macroNames: (state.stagedMacros || []).map((s) => s.name),
    macroActionCounts: (state.stagedMacros || []).map((s) => (s.actions || []).length),
    isRecordingMacro: Boolean(state.isRecordingMacro),
    macroRecordingSlot: state.macroRecordingSlot,
    macroEnableDefaultDelay: Boolean(slotMeta(state.activeMacroSlot).enableDefaultDelay),
    macroDefaultDelay: slotMeta(state.activeMacroSlot).defaultDelay,
    macroSelectedActionIndex: state.macroSelectedActionIndex,
    macroClipboardCount: Array.isArray(state.macroClipboard) ? state.macroClipboard.length : 0,
    applyMacrosDisabled: Boolean(document.getElementById('btn-apply-macros')?.disabled),
    hasHarness: Boolean(window.__maicongHarness),
    captureFocused: captureIsFocused(),
    captureHidden: Boolean(document.getElementById('macro-capture-surface')?.hidden),
    paletteHasMedia: Boolean(document.getElementById('macro-new-key') && Array.from(document.getElementById('macro-new-key').options).some((o) => /Mute|Volume/.test(o.textContent || ''))),
    paletteHasFn: Boolean(document.getElementById('macro-new-key') && Array.from(document.getElementById('macro-new-key').options).some((o) => o.value === '255')),
    paletteHasMouse: Boolean(document.getElementById('macro-new-key') && Array.from(document.getElementById('macro-new-key').options).some((o) => /Mouse|Wheel/.test(o.textContent || ''))),
    paletteHasLighting: Boolean(document.getElementById('macro-new-key') && Array.from(document.getElementById('macro-new-key').options).some((o) => /Backlight|Side Light|RGB/.test(o.textContent || ''))),
    cbModHasNonModifiers: Boolean(document.getElementById('adv-cb-modifier') && Array.from(document.getElementById('adv-cb-modifier').options).some((o) => !o.value.startsWith('16,') || o.value.split(',')[1] === '0' || o.value.split(',')[2] !== '0')),
    cbRegHasNonStandard: Boolean(document.getElementById('adv-cb-regular') && Array.from(document.getElementById('adv-cb-regular').options).some((o) => !o.value.startsWith('16,') || o.value.split(',')[1] !== '0' || o.value.split(',')[2] === '0')),
    activeElementId: document.activeElement && document.activeElement.id ? document.activeElement.id : '',
    layer0KeyCount: Object.keys(state.layerKeymaps[0] || {}).length,
    layer2KeyCount: Object.keys(state.layerKeymaps[2] || {}).length,
    layer0Slot0: state.layerKeymaps[0] && state.layerKeymaps[0][0]
      ? [state.layerKeymaps[0][0].type, state.layerKeymaps[0][0].code1, state.layerKeymaps[0][0].code2]
      : null,
    layer0Slot11: state.layerKeymaps[0] && state.layerKeymaps[0][11]
      ? [state.layerKeymaps[0][11].type, state.layerKeymaps[0][11].code1, state.layerKeymaps[0][11].code2]
      : null,
    layer0Slot19: state.layerKeymaps[0] && state.layerKeymaps[0][19]
      ? [state.layerKeymaps[0][19].type, state.layerKeymaps[0][19].code1, state.layerKeymaps[0][19].code2]
      : null,
    localLayer0Slot19: (() => {
      const layers = state.localPreviewData && state.localPreviewData.layers;
      const row = layers && (layers[0] || layers['0']);
      const t = row && (row[19] || row['19']);
      return t ? [t.type, t.code1, t.code2] : null;
    })(),
    keyClipboardKind: state.keyClipboard && state.keyClipboard.kind,
    keyClipboardType: state.keyClipboard && state.keyClipboard.binding && state.keyClipboard.binding.type,
    keyDraggingSource: state.keyDragging && state.keyDragging.source,
    keyRecorderActive: Boolean(state.keyRecorder && state.keyRecorder.active),
    keyRecorderLabel: KeyConfig && state.keyRecorder ? KeyConfig.recorderLabel(state.keyRecorder) : '111',
    keyRecordCaptureFocused: Boolean(document.activeElement && document.activeElement.id === 'key-record-capture'),
    restoreDefaultsDisabled: Boolean(document.getElementById('btn-restore-defaults')?.disabled),
    keymapSaveStatus: state.keymapSaveStatus || 'idle',
    keymapSaveError: state.keymapSaveError || '',
    keymapDirty: Boolean(state.keymapDirty),
    keymapSaveInFlight: keymapSaveGate.pending > 0,
    keymapSavePending: keymapSaveGate.pending,
    localPreviewHasGif: Boolean(state.localPreviewData && Array.isArray(state.localPreviewData.selectedLightEffect) && state.localPreviewData.selectedLightEffect[0] === 'gif'),
    localPreviewAdvanced: Boolean(state.localPreviewData && state.localPreviewData.advanced),
    advancedMtHex: String(
      (state.localPreviewData && state.localPreviewData.advanced && state.localPreviewData.advanced.mt)
      || (state.advancedRead && state.advancedRead.raw && state.advancedRead.raw.mt)
      || ''
    ),
    advancedTglHex: String(
      (state.localPreviewData && state.localPreviewData.advanced && state.localPreviewData.advanced.tgl)
      || (state.advancedRead && state.advancedRead.raw && state.advancedRead.raw.tgl)
      || ''
    ),
    advancedCustomParamHex: String(
      (state.localPreviewData && state.localPreviewData.customParam && state.localPreviewData.customParam.raw)
      || (state.advancedRead && state.advancedRead.raw && state.advancedRead.raw.customParam)
      || ''
    ),
    keymapResetDialogHidden: Boolean(document.getElementById('keymap-reset-dialog')?.hidden),
    resetDialogHidden: Boolean(document.getElementById('reset-confirm-dialog')?.hidden),
    resetDialogTitle: document.getElementById('reset-dialog-title')?.textContent || '',
    resetDialogBody: document.getElementById('reset-dialog-body')?.textContent || '',
    resetDialogExportNote: document.getElementById('reset-dialog-export-note')?.textContent || '',
    resetConfirmDisabled: Boolean(document.getElementById('btn-reset-confirm')?.disabled),
    resetCancelDisabled: Boolean(document.getElementById('btn-reset-cancel')?.disabled),
    resetExportDisabled: Boolean(document.getElementById('btn-reset-export')?.disabled),
    resetActiveDisabled: Boolean(document.getElementById('btn-reset-active')?.disabled),
    resetAllDisabled: Boolean(document.getElementById('btn-reset-all')?.disabled),
    resetCommitInFlight: Boolean(state.resetCommitInFlight),
    applyKeyColorsDisabled: Boolean(document.getElementById('btn-apply-key-colors')?.disabled),
    applyAdvancedDisabled: Boolean(document.getElementById('btn-apply-advanced')?.disabled),
    hasReadKeyColors: Boolean(state.hasReadKeyColors),
    hasAdvancedRead: Boolean(state.advancedRead),
    advancedKind: document.getElementById('adv-kind')?.value || state.advancedKind || '',
    advancedBindingCount: (document.getElementById('advanced-binding-list')?.children || []).length,
    advancedBindingCountLabel: document.getElementById('advanced-binding-count')?.textContent || '',
    advancedTypeCards: Array.from(document.querySelectorAll('.adv-type-card')).map((el) => el.dataset.kind),
    hasDksTypeCard: Boolean(document.getElementById('adv-type-dks')),
    hasSimultaneousSocd: Boolean(document.getElementById('adv-socd-simultaneous')),
    advancedHubCols: document.querySelectorAll('#advanced-hub-grid .advanced-hub-col').length,
    bindingTestPress: (state.bindingTestPress || []).map((e) => e.code),
    bindingTestRelease: (state.bindingTestRelease || []).map((e) => e.code),
    advancedClearDialogHidden: Boolean(document.getElementById('advanced-clear-dialog')?.hidden),
    advancedClearCapturedProfile: state.advancedClearCaptured ? state.advancedClearCaptured.profile : null,
    advancedDeleteConfirmOpen: Boolean(state.advancedDeleteConfirmId),
    cbKeyIndexList: KeyConfig.copyCbKeyIndexList(state.cbKeyIndexList),
    cbEditorTarget: state.cbEditorTarget,
    resetEpoch: state.resetEpoch,
    configUncertain: Boolean(state.configUncertain),
    lightingScope: state.lightingScope,
    lightingEffect: state.lighting.effect,
    lightingSpeed: state.lighting.speed,
    lightingDirection: state.lighting.direction,
    lightingHex: state.lighting.hexColor,
    lightingCustomColorDisabled: Boolean(state.lighting.customColorDisabled),
    lightingDraftDirty: Boolean(state.lightingDraftDirty),
    lightingOpInFlight: Boolean(state.lightingOpInFlight),
    lightingHydrateLocked: Boolean(state.lightingHydrateLocked),
    lightingSaveStatus: state.lightingSaveStatus || 'idle',
    lightingSaveError: state.lightingSaveError || '',
    lightingSaveStatusText: document.getElementById('lighting-save-status')?.textContent || '',
    lightingApplyHidden: Boolean(document.getElementById('btn-apply-lighting')?.hidden),
    lightingSaveBlocked: Boolean(state.lightingSaveBlocked),
    lightingMemoryBlocked: Boolean(state.lightingMemoryBlocked),
    lightingCalInFlight: Boolean(state.lightingCalInFlight),
    lightingCalQueued: Boolean(state.lightingCalQueued),
    lightingPrefQueued: state.lightingPrefQueued || '',
    lightingReadQueued: Boolean(state.lightingReadQueued),
    lightingRetryHidden: Boolean(document.getElementById('btn-retry-lighting-save')?.hidden),
    lightingPrefInFlight: Boolean(state.lightingPrefInFlight),
    lightingReadInFlight: Boolean(state.lightingReadInFlight),
    lightingSaveWorkerBusy: Boolean(state.lightingSaveWorkerBusy),
    lightMemoryBackend: state.lightMemory ? state.lightMemory.backend : null,
    lightMemoryFallback: (state.lightMemoryPref && state.lightMemoryPref.fallback) || 'hardware',
    lightMemoryIdentityKind: (state.lightMemoryPref && state.lightMemoryPref.identityKind) || '',
    lightMemoryDurable: Boolean(state.lightMemoryPref && state.lightMemoryPref.durable),
    lightMemoryRecovered: Boolean(state.lightMemoryPref && state.lightMemoryPref.recovered),
    lightMemoryUnwritable: Boolean(state.lightMemoryPref && state.lightMemoryPref.unwritable),
    lightMemKeyboardPressed: document.getElementById('light-mem-keyboard')?.getAttribute('aria-pressed') || '',
    lightMemMacPressed: document.getElementById('light-mem-mac')?.getAttribute('aria-pressed') || '',
    lightMemoryHint: document.getElementById('lighting-memory-hint')?.textContent || '',
    lightMemoryMainEffects: ((state.lightMemory && state.lightMemory.store && state.lightMemory.store.main) || [])
      .map((r) => r.effect),
    lightMemorySideEffects: ((state.lightMemory && state.lightMemory.store && state.lightMemory.store.side) || [])
      .map((r) => r.sideEffect),
    lightingSideBrightness: state.lighting.sideBrightness,
    readLightingDisabled: Boolean(document.getElementById('btn-read-lighting')?.disabled),
    applyCalibrationDisabled: Boolean(document.getElementById('btn-apply-calibration')?.disabled),
    sideEffect: state.lighting.sideEffect,
    sideCustomColorDisabled: Boolean(state.lighting.sideCustomColorDisabled),
    mainPresetCount: document.querySelectorAll('#main-effect-grid .effect-tile').length,
    sidePresetCount: document.querySelectorAll('#side-effect-grid .effect-tile').length,
    mainPresetLabels: Array.from(document.querySelectorAll('#main-effect-grid .effect-tile')).map((el) => el.textContent.trim()),
    sidePresetLabels: Array.from(document.querySelectorAll('#side-effect-grid .effect-tile')).map((el) => el.textContent.trim()),
    customLightingActive: Boolean(document.getElementById('btn-custom-lighting')?.classList.contains('active')),
    customPanelHidden: Boolean(document.getElementById('custom-lighting-panel')?.hidden),
    unrecognizedHidden: Boolean(document.getElementById('lighting-unrecognized')?.hidden),
    mainSpeedHidden: Boolean(document.getElementById('main-speed-group')?.hidden),
    mainBrightnessHidden: Boolean(document.getElementById('main-brightness-group')?.hidden),
    mainDirectionHidden: Boolean(document.getElementById('main-direction-group')?.hidden),
    mainColorDisabled: Boolean(document.getElementById('light-color-input')?.disabled),
    sideSpeedHidden: Boolean(document.getElementById('side-speed-group')?.hidden),
    sideBrightnessHidden: Boolean(document.getElementById('side-brightness-group')?.hidden),
    sideColorDisabled: Boolean(document.getElementById('side-color-input')?.disabled),
    sideToggleDisabled: Boolean(document.getElementById('side-custom-color-toggle')?.disabled),
    dir0Label: document.getElementById('btn-dir-left')?.textContent || '',
    dir1Label: document.getElementById('btn-dir-right')?.textContent || '',
    selectedMainTile: (Array.from(document.querySelectorAll('#main-effect-grid .effect-tile.active'))[0]?.textContent || '').trim(),
    selectedMainAriaPressed: document.querySelector('#main-effect-grid .effect-tile.active')?.getAttribute('aria-pressed') || '',
    mainPressedCount: document.querySelectorAll('#main-effect-grid .effect-tile[aria-pressed="true"]').length,
    selectedSideTile: (Array.from(document.querySelectorAll('#side-effect-grid .effect-tile.active'))[0]?.textContent || '').trim(),
    selectedSideAriaPressed: document.querySelector('#side-effect-grid .effect-tile.active')?.getAttribute('aria-pressed') || '',
    sidePressedCount: document.querySelectorAll('#side-effect-grid .effect-tile[aria-pressed="true"]').length,
    lightingWorkspaceOverflow: (() => {
      const pane = document.querySelector('#panel-lighting .lighting-workspace');
      if (!pane) return true;
      return pane.scrollWidth > pane.clientWidth + 2;
    })(),
    lightingTileDisabled: Boolean(document.querySelector('#main-effect-grid .effect-tile')?.disabled),
    customLightingDisabled: Boolean(document.getElementById('btn-custom-lighting')?.disabled),
    customAriaPressed: document.getElementById('btn-custom-lighting')?.getAttribute('aria-pressed') || '',
    mainLightTab: state.mainLightTab,
    stillCount: stillItems().length,
    stillNames: stillItems().map((item) => item.name),
    selectedStillKey: state.selectedStillKey || '',
    selectedStillName: (selectedStillItem() && selectedStillItem().name) || '',
    selectedLightEffect: Array.isArray(state.selectedLightEffect) ? state.selectedLightEffect.slice() : ['still', ''],
    stillSectionHidden: Boolean(document.getElementById('still-library-section')?.hidden),
    gifHint: document.getElementById('gif-library-hint')?.textContent || '',
    cloudTabPresent: Boolean(document.querySelector('[data-tab="cloud"]')),
    stillCreateDisabled: Boolean(document.getElementById('btn-still-create')?.disabled),
    stillLibraryError: (state.stillLibrary && state.stillLibrary.error) || '',
    stillLibraryStatus: document.getElementById('still-library-status')?.textContent || '',
    lightingStillQueued: stillQueuePending(),
    stillEditPending: Boolean(state.stillEditTimer || state.stillDirtyKey),
    stillDirtyKey: state.stillDirtyKey || '',
    stillLibrarySelectedKey: (state.stillLibrary && state.stillLibrary.selectedKey) || '',
    stagedSlot0Color: String(state.stagedKeyColors[0] || '').toUpperCase(),
    stillFramesByName: (() => {
      const out = {};
      for (const item of stillItems()) {
        const frame = item && item.data && Array.isArray(item.data.frames) ? item.data.frames[0] : null;
        const data = Array.isArray(frame && frame.data) ? frame.data : [];
        out[item.name] = data.map((entry) => ({
          code: entry.code,
          selectColor: String(entry.selectColor || entry.color || '').toUpperCase()
        }));
      }
      return out;
    })(),
    stillNameDialogHidden: Boolean(document.getElementById('still-name-dialog')?.hidden),
    gifSectionHidden: Boolean(document.getElementById('gif-library-section')?.hidden),
    gifCount: gifItems().length,
    gifNames: gifItems().map((item) => item.name),
    selectedGifKey: state.selectedGifKey || '',
    selectedGifName: (selectedGifItem() && selectedGifItem().name) || '',
    gifLibraryError: (state.gifLibrary && state.gifLibrary.error) || '',
    gifLibraryStatus: document.getElementById('gif-library-status')?.textContent || '',
    gifPlaybackStatus: document.getElementById('gif-playback-status')?.textContent || '',
    gifPlayLabel: document.getElementById('btn-gif-play-pause')?.textContent || '',
    gifPlayDisabled: Boolean(document.getElementById('btn-gif-play-pause')?.disabled),
    gifStopDisabled: Boolean(document.getElementById('btn-gif-stop')?.disabled),
    gifImportDisabled: Boolean(document.getElementById('btn-gif-import')?.disabled),
    gifNameDialogHidden: Boolean(document.getElementById('gif-name-dialog')?.hidden),
    gifEditorHidden: Boolean(document.getElementById('gif-editor-dialog')?.hidden),
    gifEditorFrame: state.gifEditor ? state.gifEditor.index + 1 : 0,
    gifEditorFrameCount: state.gifEditor ? state.gifEditor.frames.length : 0,
    gifEditorName: state.gifEditor ? state.gifEditor.name : '',
    gifFramesByName: (() => {
      const out = {};
      for (const item of gifItems()) {
        const frames = item && item.data && Array.isArray(item.data.frames) ? item.data.frames : [];
        out[item.name] = frames.map((frame) => ({
          duration: frame.duration,
          data: Array.isArray(frame.data)
            ? frame.data.map((entry) => ({
              code: entry.code,
              selectColor: String(entry.selectColor || entry.color || '').toUpperCase()
            }))
            : []
        }));
      }
      return out;
    })(),
    isStreaming: Boolean(state.isStreaming),
    profileLibraryCount: ((state.profileLibrary && state.profileLibrary.local) || []).length,
    profileLibraryRemaining: state.profileLibrary && state.profileLibrary.remaining,
    profileLibraryError: (state.profileLibrary && state.profileLibrary.error) || '',
    profileLibraryStatus: document.getElementById('profile-library-status')?.textContent || '',
    profileProgressHidden: Boolean(document.getElementById('profile-library-progress')?.hidden),
    tabLightingLabel: document.querySelector('#tab-lighting .tab-label')?.textContent?.trim() || '',
    tabOthersLabel: document.querySelector('#tab-others .tab-label')?.textContent?.trim() || '',
    localeZhActive: Boolean(document.getElementById('lang-zh')?.classList.contains('active')),
    localeEnActive: Boolean(document.getElementById('lang-en')?.classList.contains('active')),
    onboardTitles: Array.from(document.querySelectorAll('#onboard-profile-list .profile-title')).map((el) => el.textContent.trim()),
    onboardDescs: Array.from(document.querySelectorAll('#onboard-profile-list .profile-desc')).map((el) => el.textContent.trim()),
    appBindLabels: (state.appBinds || []).map((row) => `${row.profileIndex}:${row.bundleId}`),
    appBindButtonLabels: Array.from(document.querySelectorAll('#onboard-profile-list [data-action="bind-profile-app"], #onboard-profile-list [data-action="unbind-profile-app"]')).map((el) => el.textContent.trim()),
    appBindDeleteHidden: Boolean(document.getElementById('app-bind-delete-dialog')?.hidden),
    appBindDeleteBody: document.getElementById('app-bind-delete-body')?.textContent || '',
    localTitles: Array.from(document.querySelectorAll('#local-profile-list .profile-title')).map((el) => el.textContent.trim()),
    editProfileOptions: Array.from(document.getElementById('edit-profile-select')?.options || []).map((el) => el.textContent.trim()),
    profileNameInput: document.getElementById('profile-name-input')?.value || '',
    localKeys: Array.from(document.querySelectorAll('#local-profile-list .profile-card')).map((el) => el.dataset.key || ''),
    localPreview: Boolean(isLocalPreview()),
    editSourceKind: state.editSource && state.editSource.kind,
    editSourceKey: (state.editSource && state.editSource.key) || '',
    profileNameDialogHidden: Boolean(document.getElementById('profile-name-dialog')?.hidden),
    profileFreeSlotHidden: Boolean(document.getElementById('profile-free-slot')?.hidden),
    profileCapacityText: document.getElementById('profile-library-capacity')?.textContent || '',
    lightingGifQueued: gifQueuePending(),
    lightingToggleDisabled: Boolean(document.getElementById('light-custom-color-toggle')?.disabled),
    lightingPickerDisabled: Boolean(document.getElementById('light-color-input')?.disabled),
    lightingEditedKeys: Object.keys(state.lightingEdited || {}).sort(),
    canEditLighting: Boolean(state.connected && !state.loadInFlight && state.hasReadLighting && !state.lightingReadInFlight),
    canStartLightingRead: Boolean(state.connected && !state.loadInFlight && !state.lightingReadInFlight),
    othersSubtitle: document.querySelector('#panel-others .subtitle')?.textContent || '',
    firmwareCardText: document.querySelector('#panel-others .dash-card .card-desc')?.textContent || '',
    firmwareMcuVersion: document.getElementById('firmware-mcu-version')?.textContent || '',
    firmwareRfVersion: document.getElementById('firmware-rf-version')?.textContent || '',
    firmwareTargetLabel: document.getElementById('firmware-target-label')?.textContent || '',
    firmwarePackageName: document.getElementById('firmware-package-name')?.textContent || '',
    firmwareModeRule: document.getElementById('firmware-mode-rule')?.textContent || '',
    firmwareStatusText: document.getElementById('firmware-status')?.textContent || '',
    firmwareProgressText: document.getElementById('firmware-progress')?.textContent || '',
    firmwareProgressHidden: Boolean(document.getElementById('firmware-progress')?.hidden),
    firmwareChooseDisabled: Boolean(document.getElementById('btn-firmware-choose')?.disabled),
    firmwareReviewDisabled: Boolean(document.getElementById('btn-firmware-review')?.disabled),
    firmwareDialogHidden: Boolean(document.getElementById('firmware-review-dialog')?.hidden),
    firmwareDialogTitle: document.getElementById('firmware-review-title')?.textContent || '',
    firmwareDialogBody: document.getElementById('firmware-review-body')?.textContent || '',
    firmwareDialogHash: document.getElementById('firmware-review-hash')?.textContent || '',
    firmwareDialogSize: document.getElementById('firmware-review-size')?.textContent || '',
    firmwareDialogBoot: document.getElementById('firmware-review-boot')?.textContent || '',
    firmwareDialogMode: document.getElementById('firmware-review-mode-rule')?.textContent || '',
    firmwareConfirmDisabled: Boolean(document.getElementById('btn-firmware-confirm')?.disabled),
    firmwareCancelDisabled: Boolean(document.getElementById('btn-firmware-cancel')?.disabled),
    firmwareCommitInFlight: Boolean(state.firmwareCommitInFlight),
    firmwareNativeWriteCount: Number(state.firmwareStatus && state.firmwareStatus.nativeWriteCount) || 0,
    firmwareNativeWritePhases: (state.firmwareStatus && state.firmwareStatus.nativeWritePhases) || [],
    firmwareLastOutcomeSuccess: Boolean(state.firmwareStatus && state.firmwareStatus.lastOutcome && state.firmwareStatus.lastOutcome.success),
    firmwareLastOutcomeReason: (state.firmwareStatus && state.firmwareStatus.lastOutcome && state.firmwareStatus.lastOutcome.reason) || '',
    guideFirmwareRow: (() => {
      const rows = Array.from(document.querySelectorAll('#panel-guide table.matrix-table tbody tr'));
      const row = rows.find((el) => /Firmware Flashing/i.test(el.textContent || ''));
      return row ? row.textContent : '';
    })()
  };
  } catch (err) {
    return { snapshotError: String(err && err.stack ? err.stack : err) };
  }
}
window.__maicongEditorSnapshot = editorSnapshot;

function installHarnessHooks() {
  if (!state.harness) return;
  window.__maicongHarness = {
    getActions(slot) {
      const s = state.stagedMacros[slot];
      return s && Array.isArray(s.actions) ? MacroDraft.deepCopyActions(s.actions) : [];
    },
    fillSlotActions(slot, count) {
      ensureMacroSlotsDisplay();
      if (!state.stagedMacros[slot]) return false;
      const n = Math.max(0, count);
      const acts = [];
      for (let i = 0; i < n; i++) acts.push({ action: 'keydown', code: 4, delay: 5 });
      state.stagedMacros[slot].actions = acts;
      renderMacros();
      return true;
    },
    applyStagedMacros() {
      const snapshot = MacroDraft.hardwareMacroSlots(state.stagedMacros);
      return api.applyMacros(snapshot);
    },
    applyDeviceMacros(slots) {
      return api.applyMacros(slots);
    },
    setSlotActions(slot, actions) {
      ensureMacroSlotsDisplay();
      if (!state.stagedMacros[slot]) return false;
      state.stagedMacros[slot].actions = MacroDraft.deepCopyActions(actions);
      renderMacros();
      return true;
    },
    setSlotPlayback(slot, type) {
      ensureMacroSlotsDisplay();
      if (!state.stagedMacros[slot]) return false;
      state.stagedMacros[slot].type = type;
      renderMacros();
      return true;
    },
    macroIdentities() {
      return destClipboardContext().macros.map((slot, i) => ({
        i,
        type: slot && Number.isInteger(slot.type) ? slot.type : 0,
        bodyKey: slot && typeof slot.bodyKey === 'string' ? slot.bodyKey : ''
      })).filter((slot) => slot.bodyKey);
    },
    rejectNextCommitFactoryReset: false,
    failNextLocalDraft: false,
    resetLoadGuards() {
      state.loadReadOverlap = false;
      state.loadStartedWhileWorkerBusy = false;
      state.loadReadActive = 0;
      return true;
    },
    invalidateEditors(reason, resetEpoch) {
      if (Number.isInteger(resetEpoch)) state.resetEpoch = resetEpoch;
      applyResetInvalidation(reason || 'harness');
      updateApplyButtonsState();
      renderLightingControls();
      return true;
    },
    pruneBindingTests(now) {
      const ts = Number.isFinite(now) ? now : Date.now();
      state.bindingTestPress = KeyConfig.pruneBindingTestEvents(state.bindingTestPress, ts);
      state.bindingTestRelease = KeyConfig.pruneBindingTestEvents(state.bindingTestRelease, ts);
      renderBindingTestLists();
      return {
        press: state.bindingTestPress.map((e) => e.code),
        release: state.bindingTestRelease.map((e) => e.code)
      };
    },
    pushBindingTest(kind, code, now) {
      const ts = Number.isFinite(now) ? now : Date.now();
      if (kind === 'release') {
        state.bindingTestRelease = KeyConfig.pushBindingTestEvent(
          state.bindingTestRelease, code, ts, KeyConfig.BINDING_TEST_MAX, KeyConfig.BINDING_TEST_EXPIRE_MS
        );
      } else {
        state.bindingTestPress = KeyConfig.pushBindingTestEvent(
          state.bindingTestPress, code, ts, KeyConfig.BINDING_TEST_MAX, KeyConfig.BINDING_TEST_EXPIRE_MS
        );
      }
      renderBindingTestLists();
      return true;
    },
    setLighting(partial) {
      if (!partial || typeof partial !== 'object') return false;
      Object.assign(state.lighting, partial);
      renderLightingControls();
      updateApplyButtonsState();
      return true;
    },
    renderLighting() {
      renderLightingControls();
    },
    retrySettingsSave() {
      return handleRetrySettingsSave();
    },
    setDeviceConnected(connected, resetEpoch) {
      updateFromDeviceState({
        connected: Boolean(connected),
        device: state.device,
        lighting: state.lighting,
        settings: state.settings,
        activeProfileIndex: state.activeProfile,
        resetEpoch: Number.isInteger(resetEpoch) ? resetEpoch : state.resetEpoch,
        configUncertain: state.configUncertain,
        readSuccess: Boolean(connected)
      });
      return Boolean(state.connected);
    },
    copySelectedKey() {
      handleCopyKey();
      return Boolean(state.keyClipboard);
    },
    pasteSelectedKey() {
      return handlePasteKey();
    },
    cutSelectedKey() {
      return handleCutKey();
    },
    loadOnboardProfile(profile) {
      const sel = document.getElementById('edit-profile-select');
      if (sel) sel.value = String(profile);
      return handleLoadEditTarget();
    },
    chooseFirmwarePackage(spec) {
      return handleChooseFirmwarePackage(spec);
    },
    bindProfileApp(profileIndex, spec) {
      return (async () => {
        const res = await api.bindProfileApp({ profileIndex, ...(spec || {}) });
        if (res && res.success) {
          state.appBinds = res.binds || [];
          renderProfileLibrary();
        }
        return res;
      })();
    },
    setMockFrontmost(spec) {
      return api.setMockFrontmost(spec);
    },
    unbindProfileApp(profileIndex) {
      return (async () => {
        const res = await api.unbindProfileApp(profileIndex);
        if (res && res.success) {
          state.appBinds = res.binds || [];
          renderProfileLibrary();
        }
        return res;
      })();
    },
    dropKeycodeOnSlot(slot, tuple) {
      const key = (state.layout?.keys || []).find((k) => k.slot === slot);
      if (!key) return Promise.resolve({ success: false, error: 'No physical key for slot' });
      const made = KeyConfig.makeDragPayload(tuple);
      if (!made.ok) return Promise.resolve({ success: false, error: made.error });
      state.keyDragging = made.data;
      selectKey(key);
      return commitBinding(made.data.payload, bindingLabel(made.data.payload));
    },
    applyAdvanced() {
      return handleApplyAdvanced();
    },
    clearAllAdvanced() {
      return handleClearAllAdvanced();
    },
    loadLocalPreview(key) {
      return handleLoadLocalPreview(key);
    },
    setKeyClipboard(raw) {
      const parsed = KeyConfig.parseClipboard(raw);
      state.keyClipboard = parsed.ok ? parsed.clip : raw;
      return parsed.ok;
    },
    async importGif(name, bytes) {
      const res = await api.importGif({
        name,
        buffer: Array.isArray(bytes) ? bytes : Array.from(bytes || [])
      });
      if (res && res.gifLibrary) adoptGifLibrary(res.gifLibrary);
      if (res && res.item && res.item.key) {
        state.selectedGifKey = res.item.key;
        renderLightingControls();
      }
      return res;
    }
  };
}

// Start app
void init();
