const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('maicongApi', {
  getState: () => ipcRenderer.invoke('maicong:get-state'),
  getLocale: () => ipcRenderer.invoke('maicong:get-locale'),
  setLocale: (locale) => ipcRenderer.invoke('maicong:set-locale', locale),
  getLayout: () => ipcRenderer.invoke('maicong:get-layout'),
  scan: () => ipcRenderer.invoke('maicong:scan'),
  connect: (targetPath) => ipcRenderer.invoke('maicong:connect', targetPath),
  disconnect: () => ipcRenderer.invoke('maicong:disconnect'),
  queryStatus: () => ipcRenderer.invoke('maicong:query-status'),
  switchProfile: (profileIndex) => ipcRenderer.invoke('maicong:switch-profile', profileIndex),
  readLayer: (profileIndex, layer, isDefault) => ipcRenderer.invoke('maicong:read-layer', profileIndex, layer, isDefault),
  readMacros: () => ipcRenderer.invoke('maicong:read-macros'),
  readKeyColors: (profileIndex) => ipcRenderer.invoke('maicong:read-key-colors', profileIndex),
  applyLighting: (params, profileIndex, options) => ipcRenderer.invoke('maicong:apply-lighting', params, profileIndex, options),
  getLightingMemoryPreference: () => ipcRenderer.invoke('maicong:get-lighting-memory-preference'),
  setLightingMemoryPreference: (spec) => ipcRenderer.invoke('maicong:set-lighting-memory-preference', spec),
  getStillLibrary: () => ipcRenderer.invoke('maicong:get-still-library'),
  createStill: (name) => ipcRenderer.invoke('maicong:create-still', name),
  renameStill: (spec) => ipcRenderer.invoke('maicong:rename-still', spec),
  deleteStill: (spec) => ipcRenderer.invoke('maicong:delete-still', spec),
  updateStillFrames: (spec) => ipcRenderer.invoke('maicong:update-still-frames', spec),
  selectStill: (spec) => ipcRenderer.invoke('maicong:select-still', spec),
  getGifLibrary: () => ipcRenderer.invoke('maicong:get-gif-library'),
  createGif: (spec) => ipcRenderer.invoke('maicong:create-gif', spec),
  importGif: (spec) => ipcRenderer.invoke('maicong:import-gif', spec),
  renameGif: (spec) => ipcRenderer.invoke('maicong:rename-gif', spec),
  deleteGif: (spec) => ipcRenderer.invoke('maicong:delete-gif', spec),
  updateGif: (spec) => ipcRenderer.invoke('maicong:update-gif', spec),
  selectGif: (spec) => ipcRenderer.invoke('maicong:select-gif', spec),
  setGifPlayback: (action) => ipcRenderer.invoke('maicong:set-gif-playback', action),
  applySettings: (settings, profileIndex) => ipcRenderer.invoke('maicong:apply-settings', settings, profileIndex),
  applyKeymap: (profileIndex, layer, keyUpdates, options) => ipcRenderer.invoke('maicong:apply-keymap', profileIndex, layer, keyUpdates, options),
  applyKeyColors: (profileIndex, colors) => ipcRenderer.invoke('maicong:apply-key-colors', profileIndex, colors),
  applyMacros: (macros) => ipcRenderer.invoke('maicong:apply-macros', macros),
  isHarness: () => ipcRenderer.invoke('maicong:is-harness'),
  getMacroMetadata: () => ipcRenderer.invoke('maicong:get-macro-metadata'),
  setMacroMetadata: (meta) => ipcRenderer.invoke('maicong:set-macro-metadata', meta),
  exportProfile: (profileData) => ipcRenderer.invoke('maicong:export-profile', profileData),
  applyProfile: (profileData, profileIndex) => ipcRenderer.invoke('maicong:apply-profile', profileData, profileIndex),
  importProfile: () => ipcRenderer.invoke('maicong:import-profile'),
  getProfileLibrary: () => ipcRenderer.invoke('maicong:get-profile-library'),
  createLocalProfile: (name) => ipcRenderer.invoke('maicong:create-local-profile', name),
  copyOnboardToLocal: (spec) => ipcRenderer.invoke('maicong:copy-onboard-to-local', spec),
  renameProfile: (spec) => ipcRenderer.invoke('maicong:rename-profile', spec),
  deleteLocalProfile: (key) => ipcRenderer.invoke('maicong:delete-local-profile', key),
  deleteOnboardProfile: (key) => ipcRenderer.invoke('maicong:delete-onboard-profile', key),
  reorderProfiles: (keys) => ipcRenderer.invoke('maicong:reorder-profiles', keys),
  moveLocalToOnboard: (spec) => ipcRenderer.invoke('maicong:move-local-to-onboard', spec),
  copyOnboardToOnboard: (spec) => ipcRenderer.invoke('maicong:copy-onboard-to-onboard', spec),
  moveOnboardToLocal: (spec) => ipcRenderer.invoke('maicong:move-onboard-to-local', spec),
  listAppBinds: () => ipcRenderer.invoke('maicong:list-app-binds'),
  bindProfileApp: (spec) => ipcRenderer.invoke('maicong:bind-profile-app', spec),
  unbindProfileApp: (profileIndex) => ipcRenderer.invoke('maicong:unbind-profile-app', profileIndex),
  setMockFrontmost: (spec) => ipcRenderer.invoke('maicong:set-mock-frontmost', spec),
  loadLocalProfilePreview: (key) => ipcRenderer.invoke('maicong:load-local-profile-preview', key),
  saveLocalProfileDraft: (spec) => ipcRenderer.invoke('maicong:save-local-profile-draft', spec),
  importOfficialProfile: () => ipcRenderer.invoke('maicong:import-official-profile'),
  exportOfficialProfile: (spec) => ipcRenderer.invoke('maicong:export-official-profile', spec),
  setEditSource: (spec) => ipcRenderer.invoke('maicong:set-edit-source', spec),
  readFuncConfig: (profileIndex) => ipcRenderer.invoke('maicong:read-func-config', profileIndex),
  setEditTarget: (profileIndex, layer) => ipcRenderer.invoke('maicong:set-edit-target', profileIndex, layer),
  enableProfiles: (newCount) => ipcRenderer.invoke('maicong:enable-profiles', newCount),
  readAdvanced: (profileIndex) => ipcRenderer.invoke('maicong:read-advanced', profileIndex),
  applyAdvanced: (spec) => ipcRenderer.invoke('maicong:apply-advanced', spec),
  removeAdvanced: (profileIndex, layer, slot) => ipcRenderer.invoke('maicong:remove-advanced', profileIndex, layer, slot),
  clearAllAdvanced: (spec) => ipcRenderer.invoke('maicong:clear-all-advanced', spec),
  applyAdvancedLocal: (payload) => ipcRenderer.invoke('maicong:apply-advanced-local', payload),
  clearAllAdvancedLocal: (payload) => ipcRenderer.invoke('maicong:clear-all-advanced-local', payload),
  prepareFactoryReset: (scope) => ipcRenderer.invoke('maicong:prepare-factory-reset', scope),
  commitFactoryReset: (spec) => ipcRenderer.invoke('maicong:commit-factory-reset', spec),
  firmwareStatus: () => ipcRenderer.invoke('maicong:firmware-status'),
  chooseFirmwarePackage: (spec) => ipcRenderer.invoke('maicong:firmware-choose-package', spec),
  reviewFirmware: () => ipcRenderer.invoke('maicong:firmware-review'),
  startFirmware: (spec) => ipcRenderer.invoke('maicong:firmware-start', spec),
  cancelFirmware: (reason) => ipcRenderer.invoke('maicong:firmware-cancel', reason),
  dismissFirmwareReview: () => ipcRenderer.invoke('maicong:firmware-dismiss-review'),
  onStateUpdate: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('maicong:state-update', listener);
    return () => ipcRenderer.removeListener('maicong:state-update', listener);
  },
  onNavigateTab: (callback) => {
    const listener = (_event, tab) => callback(tab);
    ipcRenderer.on('maicong:navigate-tab', listener);
    return () => ipcRenderer.removeListener('maicong:navigate-tab', listener);
  },
  onGifFrame: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('maicong:gif-frame', listener);
    return () => ipcRenderer.removeListener('maicong:gif-frame', listener);
  },
  onFirmwareProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('maicong:firmware-progress', listener);
    return () => ipcRenderer.removeListener('maicong:firmware-progress', listener);
  }
});
