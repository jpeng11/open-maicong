/**
 * Development-only mocked UI integration. Loaded solely when Electron is
 * launched with --mock-ui-test and !app.isPackaged. Never enumerates HID.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const protocol = require('../src/protocol.cjs');
const transport = require('../src/transport.cjs');
const firmwareBackup = require('../src/firmware-backup.cjs');
const lightingCapsExpected = require('./fixtures/g75-lighting-capabilities.json');
const { buildSimpleGif } = require('./gif-fixture.cjs');
const mockFw = require('./mock-firmware-io.cjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run({ app, getWindow, getMock }) {
  assert.strictEqual(app.isPackaged, false);
  const win = getWindow();
  assert.ok(win, 'window must exist');
  if (win.webContents.isLoading()) {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  }
  await sleep(400);

  const mock = getMock();
  assert.ok(mock, 'mock HID memory must be installed');
  assert.strictEqual(typeof mock.wroteCommand, 'function');

  async function snapshot() {
    return win.webContents.executeJavaScript('window.__maicongEditorSnapshot()');
  }

  async function waitLightingIdle() {
    let snap = await snapshot();
    for (let i = 0; i < 80; i++) {
      if (
        !snap.lightingOpInFlight
        && !snap.lightingPrefInFlight
        && !snap.lightingReadInFlight
        && !snap.lightingCalInFlight
        && !snap.lightingSaveWorkerBusy
        && !snap.loadInFlight
        && !snap.lightingCalQueued
        && !snap.lightingReadQueued
        && !snap.lightingPrefQueued
        && snap.lightingSaveStatus !== 'saving'
        && !snap.lightingStillQueued
        && !snap.stillEditPending
        && !snap.lightingGifQueued
        && (!snap.lightingDraftDirty || snap.lightingSaveBlocked)
      ) {
        return snap;
      }
      await sleep(50);
      snap = await snapshot();
    }
    return snap;
  }

  async function waitSettingsIdle() {
    return waitUntil(
      (s) => s.settingsSavePending === 0
        && s.settingsSaveStatus !== 'saving'
        && !s.loadInFlight
        && !s.settingsReadInFlight
        && !s.settingsOpInFlight,
      120,
      50
    );
  }

  async function setPollingRate(rate) {
    await win.webContents.executeJavaScript(`
      (() => {
        const r = document.querySelector('input[name="setting-polling-rate"][value="${rate}"]');
        if (!r) return false;
        r.checked = true;
        r.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
  }

  async function setSleepMinutes(mins, commit) {
    await win.webContents.executeJavaScript(`
      (() => {
        const s = document.getElementById('setting-sleep-time');
        s.value = '${mins}';
        s.dispatchEvent(new Event('input', { bubbles: true }));
        ${commit ? "s.dispatchEvent(new Event('change', { bubbles: true }));" : ''}
        return true;
      })()
    `);
  }

  async function waitUntil(check, loops = 80, stepMs = 100) {
    let snap = await snapshot();
    for (let i = 0; i < loops; i++) {
      if (check(snap)) return snap;
      await sleep(stepMs);
      snap = await snapshot();
    }
    return snap;
  }

  async function kickRenderer(code) {
    const kicked = await win.webContents.executeJavaScript(code);
    assert.equal(kicked, true, 'renderer kick must return immediately without waiting for HID IPC');
  }

  async function readKcOp() {
    return win.webContents.executeJavaScript('window.__kcOp || { done: false, res: null }');
  }

  async function kickOp(expr) {
    await kickRenderer(`
      (() => {
        window.__kcOp = { done: false, res: null };
        Promise.resolve(${expr})
          .then((res) => { window.__kcOp = { done: true, res }; })
          .catch((err) => {
            window.__kcOp = { done: true, res: { success: false, error: String(err && err.message || err) } };
          });
        return true;
      })()
    `);
  }

  async function waitOpDone(loops = 80, stepMs = 50) {
    for (let i = 0; i < loops; i++) {
      const op = await readKcOp();
      if (op && op.done) return op;
      await sleep(stepMs);
    }
    return readKcOp();
  }

  async function clickStillByName(name) {
    const clicked = await win.webContents.executeJavaScript(`
      (() => {
        const tiles = Array.from(document.querySelectorAll('#still-library-list [data-action="select-still"]'));
        const tile = tiles.find((el) => el.textContent.trim() === ${JSON.stringify(name)});
        if (!tile) return false;
        tile.click();
        return true;
      })()
    `);
    assert.equal(clicked, true, `still tile ${name} must exist`);
  }

  async function clickStillActionByName(action, name) {
    const clicked = await win.webContents.executeJavaScript(`
      (() => {
        const wraps = Array.from(document.querySelectorAll('#still-library-list .still-tile-wrap'));
        const wrap = wraps.find((el) => (
          el.querySelector('[data-action="select-still"]')?.textContent.trim() === ${JSON.stringify(name)}
        ));
        const btn = wrap && wrap.querySelector(${JSON.stringify(`[data-action="${action}"]`)});
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);
    assert.equal(clicked, true, `${action} for ${name} must exist`);
  }

  async function confirmStillName(name) {
    await win.webContents.executeJavaScript(`
      (() => {
        const input = document.getElementById('still-name-input');
        input.value = ${JSON.stringify(name)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btn-still-name-confirm')?.click();
      })()
    `);
  }

  function stillHasPaint(frames, code, hex) {
    return Array.isArray(frames) && frames.some((row) => row.code === code && row.selectColor === hex);
  }

  function countCommand(cmd) {
    return mock.writtenBuffers.filter((b) => b[2] === cmd).length;
  }

  function countCommandOffset(cmd, offset) {
    return mock.writtenBuffers.filter((b) => b[2] === cmd && (b[6] | (b[7] << 8)) === offset).length;
  }

  async function clickLoadProfile(profile) {
    await win.webContents.executeJavaScript(`
      document.getElementById('edit-profile-select').value = '${profile}';
      document.getElementById('btn-load-edit-target').click();
    `);
  }

  async function dispatchMainTile(effectId) {
    await win.webContents.executeJavaScript(`
      (() => {
        const t = document.querySelector('#main-effect-grid .effect-tile[data-effect="${effectId}"]');
        if (t) t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      })()
    `);
  }

  async function assertLightingSyntheticRejected(message) {
    const before = await snapshot();
    await dispatchMainTile(7);
    await sleep(20);
    const after = await snapshot();
    assert.strictEqual(after.lightingEffect, before.lightingEffect, message);
    assert.strictEqual(after.canEditLighting, false, `${message}: lighting must not be editable`);
  }

  const tokenTitles = await snapshot();
  const defaultOnboard0 = tokenTitles.localeZhActive ? '默认板载' : 'Default Onboard';
  const defaultOnboard2 = tokenTitles.localeZhActive ? '默认板载2' : 'Default Onboard2';
  const defaultOnboard3 = tokenTitles.localeZhActive ? '默认板载3' : 'Default Onboard3';
  assert.equal(tokenTitles.onboardTitles[0], defaultOnboard0);
  assert.equal(tokenTitles.onboardTitles[1], defaultOnboard2);
  assert.equal(tokenTitles.onboardTitles[2], defaultOnboard3);
  assert.ok(
    tokenTitles.onboardTitles.every((title) => !String(title).includes('i18n<')),
    'sidebar must not show raw i18n tokens'
  );
  assert.equal(tokenTitles.editProfileOptions[0], defaultOnboard0);
  assert.equal(tokenTitles.editProfileOptions[1], defaultOnboard2);
  assert.ok(
    tokenTitles.editProfileOptions.every((title) => !String(title).includes('i18n<')),
    'edit dropdown must not show raw i18n tokens'
  );
  await win.webContents.executeJavaScript(`
    document.querySelector('[data-action="rename-profile"][data-profile="1"]')?.click()
  `);
  const renameDialog = await waitUntil((s) => s.profileNameDialogHidden === false, 20, 50);
  assert.equal(renameDialog.profileNameInput, defaultOnboard2);
  assert.equal(renameDialog.profileNameInput.includes('i18n<'), false);
  await win.webContents.executeJavaScript('document.getElementById("btn-profile-name-cancel")?.click()');
  await waitUntil((s) => s.profileNameDialogHidden === true, 20, 50);

  const tabCount = await win.webContents.executeJavaScript(
    'document.querySelectorAll(".view-tabs .tab").length'
  );
  assert.strictEqual(tabCount, 9, 'nine feature tabs including Advanced and Others');

  await win.webContents.executeJavaScript('document.getElementById("lang-zh")?.click()');
  const zhTabs = await waitUntil((s) => s.tabLightingLabel === '灯光' && s.dashSubtitle === '连接、固件、电量和板载配置。', 20, 50);
  assert.equal(zhTabs.tabLightingLabel, '灯光');
  assert.equal(zhTabs.tabOthersLabel, '其他');
  assert.equal(zhTabs.dashSubtitle, '连接、固件、电量和板载配置。');
  assert.equal(zhTabs.keymapSubtitle, '支持四个图层：Windows、Windows + Fn、macOS 及 macOS + Fn。可拖拽或点击命令绑定按键。板载修改自动保存，本机预览仅保留在当前设备。');
  assert.equal(zhTabs.keymapSelectedTitle, '当前按键');
  assert.equal(zhTabs.lightingBrightnessLabel, '亮度');
  assert.equal(zhTabs.factoryResetTitle, '恢复出厂');
  assert.equal(zhTabs.backupTitle, '备份与配置');
  // backup.title is 备份与配置 / Backup & Profiles
  assert.equal(zhTabs.onboardTitles[0], '默认板载');
  assert.match(zhTabs.profileStatText, /键盘 \d+ · 编辑 \d+/);
  assert.equal(zhTabs.localeZhActive, true);
  await win.webContents.executeJavaScript('document.getElementById("btn-refresh")?.click()');
  const zhToast = await waitUntil((s) => s.toast === '已从硬件刷新遥测。', 40, 50);
  assert.equal(zhToast.toast, '已从硬件刷新遥测。');
  await win.webContents.executeJavaScript('document.getElementById("lang-en")?.click()');
  const enTabs = await waitUntil((s) => s.tabLightingLabel === 'Lighting' && s.dashSubtitle.startsWith('Connection, firmware'), 20, 50);
  assert.equal(enTabs.tabLightingLabel, 'Lighting');
  assert.equal(enTabs.dashSubtitle, 'Connection, firmware, battery, and onboard profiles.');
  assert.match(enTabs.keymapSubtitle, /Four layers: Windows, Windows \+ Fn, macOS, (?:and )?macOS \+ Fn/);
  assert.equal(enTabs.keymapSelectedTitle, 'Selected Key');
  assert.equal(enTabs.lightingBrightnessLabel, 'Brightness');
  assert.equal(enTabs.factoryResetTitle, 'Factory reset');
  assert.equal(enTabs.onboardTitles[0], 'Default Onboard');
  assert.match(enTabs.profileStatText, /HW \d+ · Edit \d+/);
  assert.equal(enTabs.localeEnActive, true);
  await win.webContents.executeJavaScript('document.getElementById("btn-refresh")?.click()');
  const enToast = await waitUntil((s) => s.toast === 'Telemetry refreshed from hardware.', 40, 50);
  assert.equal(enToast.toast, 'Telemetry refreshed from hardware.');

  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="set-tab"][data-tab="lighting"]\')?.click()'
  );
  await sleep(150);
  const ledCount = await win.webContents.executeJavaScript(
    'document.querySelectorAll("#lighting-keys-container button.kb-key").length'
  );
  assert.strictEqual(ledCount, 83);
  const memPref0 = await snapshot();
  assert.strictEqual(memPref0.lightMemoryFallback, 'hardware');
  assert.strictEqual(memPref0.lightMemoryIdentityKind, 'serial');
  assert.strictEqual(memPref0.lightMemoryDurable, true);
  assert.strictEqual(memPref0.lightMemKeyboardPressed, 'true');
  assert.strictEqual(memPref0.lightMemMacPressed, 'false');
  assert.match(memPref0.lightMemoryHint, /keyboard/i);
  assert.strictEqual(memPref0.lightingApplyHidden, true);
  assert.strictEqual(countCommand(protocol.COMMANDS.SET_FUNC_CONFIG), 0, 'opening Lighting must not write');

  const hiddenVis = await win.webContents.executeJavaScript(`
    (() => {
      const vis = (id) => {
        const el = document.getElementById(id);
        if (!el) return { missing: true };
        const cs = getComputedStyle(el);
        return {
          missing: false,
          hidden: Boolean(el.hidden),
          display: cs.display,
          attr: el.hasAttribute('hidden')
        };
      };
      return {
        toast: vis('toast-banner'),
        advanced: vis('panel-advanced'),
        tgl: vis('adv-tgl-fields'),
        socd: vis('adv-socd-fields'),
        importPreview: vis('imported-profile-preview'),
        recBadge: vis('macro-recording-badge'),
        cb: vis('adv-cb-fields'),
        resetDialog: vis('reset-confirm-dialog')
      };
    })()
  `);
  for (const [name, info] of Object.entries(hiddenVis)) {
    if (name === 'toast') continue;
    assert.equal(info.missing, false, `${name} element must exist`);
    assert.equal(info.hidden, true, `${name} starts hidden`);
    assert.equal(info.display, 'none', `${name} computed display must be none while hidden`);
  }

  const origBounds = win.getBounds();
  win.setSize(1080, 740);
  await sleep(250);
  const minLayout = await win.webContents.executeJavaScript(`
    (() => {
      const tabs = Array.from(document.querySelectorAll('.view-tabs .tab')).map((t) => {
        const r = t.getBoundingClientRect();
        return { tab: t.dataset.tab, w: r.width, h: r.height };
      });
      const stage = document.querySelector('#panel-lighting .keyboard-stage');
      const caseEl = document.querySelector('#panel-lighting .keyboard-case');
      const keys = Array.from(document.querySelectorAll('#lighting-keys-container button.kb-key'));
      const sr = stage.getBoundingClientRect();
      const cr = caseEl.getBoundingClientRect();
      let maxRight = 0;
      let maxBottom = 0;
      for (const k of keys) {
        const r = k.getBoundingClientRect();
        maxRight = Math.max(maxRight, r.right);
        maxBottom = Math.max(maxBottom, r.bottom);
      }
      return {
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        tabs,
        stageW: sr.width,
        caseW: cr.width,
        caseRight: cr.right,
        stageRight: sr.right,
        maxKeyRight: maxRight,
        maxKeyBottom: maxBottom,
        stageBottom: sr.bottom,
        keyCount: keys.length
      };
    })()
  `);
  assert.ok(minLayout.innerW <= 1080 + 32, 'min-width viewport should be near 1080');
  assert.strictEqual(minLayout.tabs.length, 9);
  for (const t of minLayout.tabs) {
    assert.ok(t.w > 8 && t.h > 8, `tab ${t.tab} must be visible at 1080`);
  }
  assert.strictEqual(minLayout.keyCount, 83);
  assert.ok(minLayout.caseW <= minLayout.stageW + 2, 'keyboard case must fit stage width (layout box, not only transform)');
  assert.ok(minLayout.maxKeyRight <= minLayout.stageRight + 2, 'keys must not clip past the keyboard stage');
  assert.ok(minLayout.maxKeyBottom <= minLayout.stageBottom + 2, 'keys must not clip below the keyboard stage');

  const lastMainId = lightingCapsExpected.mainPresetOrder[lightingCapsExpected.mainPresetOrder.length - 1];
  assert.strictEqual(lastMainId, 17);
  const lastMainName = lightingCapsExpected.main.find((r) => r.id === lastMainId).name;

  async function assertLightingEffectPaneReachable(label) {
    await win.webContents.executeJavaScript(`
      (() => {
        document.getElementById('light-scope-main')?.click();
        document.getElementById('light-main-tab-normal')?.click();
        const pane = document.querySelector('#lighting-pane-effects .lighting-pane-body');
        if (pane) pane.scrollTop = 0;
        const main = document.getElementById('main-content');
        if (main) main.scrollTop = 0;
      })()
    `);
    await sleep(40);
    const beforeScroll = await win.webContents.executeJavaScript(`
      (() => {
        const workspace = document.querySelector('#panel-lighting .lighting-workspace');
        const pane = document.querySelector('#lighting-pane-effects .lighting-pane-body');
        const custom = document.getElementById('btn-custom-lighting');
        const mainTab = document.getElementById('light-scope-main');
        const sideTab = document.getElementById('light-scope-side');
        const wr = workspace.getBoundingClientRect();
        const box = (el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height };
        };
        return {
          workspace: { top: wr.top, bottom: wr.bottom, left: wr.left, right: wr.right },
          custom: box(custom),
          mainTab: box(mainTab),
          sideTab: box(sideTab),
          innerH: window.innerHeight
        };
      })()
    `);
    assert.ok(beforeScroll.custom.w > 8 && beforeScroll.custom.h > 8, `${label}: Custom entry must be laid out`);
    assert.ok(beforeScroll.custom.bottom <= beforeScroll.workspace.bottom + 2, `${label}: Custom entry must sit inside the workspace`);
    assert.ok(beforeScroll.mainTab.w > 8 && beforeScroll.sideTab.w > 8, `${label}: Main/Side tabs must be laid out`);
    assert.ok(beforeScroll.mainTab.bottom <= beforeScroll.workspace.bottom + 2, `${label}: Main tab must sit inside the workspace`);
    assert.ok(beforeScroll.sideTab.bottom <= beforeScroll.workspace.bottom + 2, `${label}: Side tab must sit inside the workspace`);

    const scrolled = await win.webContents.executeJavaScript(`
      (() => {
        const workspace = document.querySelector('#panel-lighting .lighting-workspace');
        const pane = document.querySelector('#lighting-pane-effects .lighting-pane-body');
        const tile = document.querySelector('#main-effect-grid .effect-tile[data-effect="${lastMainId}"]');
        workspace.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const overflowing = pane.scrollHeight > pane.clientHeight + 2;
        if (overflowing) pane.scrollTop = pane.scrollHeight;
        const wr = workspace.getBoundingClientRect();
        const pr = pane.getBoundingClientRect();
        const tr = tile.getBoundingClientRect();
        return {
          overflowing,
          scrollTop: pane.scrollTop,
          scrollHeight: pane.scrollHeight,
          clientHeight: pane.clientHeight,
          workspace: { top: wr.top, bottom: wr.bottom, left: wr.left, right: wr.right },
          pane: { top: pr.top, bottom: pr.bottom, left: pr.left, right: pr.right },
          tile: { top: tr.top, bottom: tr.bottom, left: tr.left, right: tr.right, w: tr.width, h: tr.height },
          innerH: window.innerHeight,
          innerW: window.innerWidth
        };
      })()
    `);
    const clipNote = `${label} paneBottom=${scrolled.pane.bottom} workspaceBottom=${scrolled.workspace.bottom} tileBottom=${scrolled.tile.bottom} innerH=${scrolled.innerH} scrollTop=${scrolled.scrollTop} overflow=${scrolled.overflowing}`;
    assert.ok(scrolled.pane.bottom <= scrolled.workspace.bottom + 2, `${label}: effect pane must be bounded by the workspace clip (${clipNote})`);
    if (scrolled.overflowing) {
      assert.ok(scrolled.scrollTop > 0, `${label}: overflowing effect pane must actually scroll (${clipNote})`);
    }
    assert.ok(scrolled.tile.w > 8 && scrolled.tile.h > 8, `${label}: last effect tile must have size`);
    assert.ok(scrolled.tile.top >= scrolled.pane.top - 2, `${label}: last tile must not clip above the pane (${clipNote})`);
    assert.ok(scrolled.tile.bottom <= scrolled.pane.bottom + 2, `${label}: last tile must not clip below the pane (${clipNote})`);
    assert.ok(scrolled.tile.top >= scrolled.workspace.top - 2, `${label}: last tile must not clip above the workspace (${clipNote})`);
    assert.ok(scrolled.tile.bottom <= scrolled.workspace.bottom + 2, `${label}: last tile must not clip below the workspace (${clipNote})`);
    assert.ok(scrolled.tile.top >= -2, `${label}: last tile must be inside the viewport (${clipNote})`);
    assert.ok(scrolled.tile.bottom <= scrolled.innerH + 2, `${label}: last tile must not extend past the viewport (${clipNote})`);
    await win.webContents.executeJavaScript(
      `document.querySelector('#main-effect-grid .effect-tile[data-effect="${lastMainId}"]')?.click()`
    );
    await sleep(40);
    const afterClick = await snapshot();
    assert.strictEqual(afterClick.selectedMainTile, lastMainName, `${label}: last effect tile must be selectable after scroll`);
    assert.strictEqual(afterClick.lightingEffect, lastMainId);

    await win.webContents.executeJavaScript('document.getElementById("light-scope-side")?.click()');
    await sleep(40);
    const sideLayout = await win.webContents.executeJavaScript(`
      (() => {
        const workspace = document.querySelector('#panel-lighting .lighting-workspace');
        const pane = document.querySelector('#lighting-pane-effects .lighting-pane-body');
        const tile = document.querySelector('#side-effect-grid .effect-tile');
        const wr = workspace.getBoundingClientRect();
        const pr = pane.getBoundingClientRect();
        const tr = tile.getBoundingClientRect();
        return {
          paneBottom: pr.bottom,
          workspaceBottom: wr.bottom,
          tile: { top: tr.top, bottom: tr.bottom, w: tr.width, h: tr.height },
          innerH: window.innerHeight
        };
      })()
    `);
    assert.ok(sideLayout.paneBottom <= sideLayout.workspaceBottom + 2, `${label}: side pane must stay inside the workspace`);
    assert.ok(sideLayout.tile.w > 8 && sideLayout.tile.h > 8, `${label}: side tiles must be laid out`);
    assert.ok(sideLayout.tile.bottom <= sideLayout.workspaceBottom + 2, `${label}: side tiles must not clip the workspace`);
    assert.ok(sideLayout.tile.bottom <= sideLayout.innerH + 2, `${label}: side tiles must be in the viewport`);

    await win.webContents.executeJavaScript('document.getElementById("light-scope-main")?.click()');
    await sleep(20);
    await win.webContents.executeJavaScript('document.getElementById("btn-custom-lighting")?.click()');
    await sleep(40);
    const customLayout = await snapshot();
    assert.strictEqual(customLayout.stillSectionHidden, false, `${label}: Custom tab must show the still section`);
    const lowerControls = await win.webContents.executeJavaScript(`
      (() => {
        const main = document.getElementById('main-content');
        const cal = document.getElementById('btn-apply-calibration');
        const create = document.getElementById('btn-still-create');
        const still = document.getElementById('still-library-section');
        if (cal) cal.scrollIntoView();
        const cr = cal.getBoundingClientRect();
        const pr = create ? create.getBoundingClientRect() : { width: 0, height: 0, top: 0, bottom: 0 };
        const sr = still ? still.getBoundingClientRect() : { width: 0, height: 0, top: 0, bottom: 0 };
        return {
          mainScrollTop: main.scrollTop,
          cal: { top: cr.top, bottom: cr.bottom, w: cr.width, h: cr.height },
          create: { top: pr.top, bottom: pr.bottom, w: pr.width, h: pr.height },
          still: { top: sr.top, bottom: sr.bottom, w: sr.width, h: sr.height },
          innerH: window.innerHeight
        };
      })()
    `);
    assert.ok(lowerControls.cal.w > 8 && lowerControls.cal.h > 8, `${label}: white-balance apply must be laid out`);
    assert.ok(lowerControls.cal.top >= -2, `${label}: white-balance apply must enter the viewport`);
    assert.ok(lowerControls.cal.bottom <= lowerControls.innerH + 2, `${label}: white-balance apply must not clip the viewport`);
    assert.ok(lowerControls.create.w > 8 && lowerControls.create.h > 8, `${label}: Add Static must be laid out`);
    assert.ok(lowerControls.still.w > 8 && lowerControls.still.h > 8, `${label}: still section must be laid out`);
    await win.webContents.executeJavaScript(`
      (() => {
        document.getElementById('light-scope-main')?.click();
        document.getElementById('light-main-tab-normal')?.click();
        const pane = document.querySelector('#lighting-pane-effects .lighting-pane-body');
        if (pane) pane.scrollTop = 0;
        const main = document.getElementById('main-content');
        if (main) main.scrollTop = 0;
      })()
    `);
    await sleep(20);
  }

  await assertLightingEffectPaneReachable('1080x740');
  win.setSize(1320, 900);
  await sleep(250);
  await assertLightingEffectPaneReachable('1320x900');
  win.setSize(origBounds.width, origBounds.height);
  await sleep(150);

  const lightingUi = await snapshot();
  assert.strictEqual(lightingCapsExpected.main.length + lightingCapsExpected.side.length, 27, 'independent fixture has all 27 capability rows');
  assert.strictEqual(lightingUi.mainPresetCount, 22, 'main preset grid is 22 tiles');
  assert.strictEqual(lightingUi.sidePresetCount, 4, 'side grid is 4 tiles');
  assert.deepStrictEqual(lightingUi.mainPresetLabels, lightingCapsExpected.mainPresetOrder.map((id) => lightingCapsExpected.main.find((r) => r.id === id).name));
  assert.deepStrictEqual(lightingUi.sidePresetLabels, lightingCapsExpected.side.map((r) => r.name));
  assert.equal(lightingUi.mainPresetLabels.includes('Custom'), false);
  assert.strictEqual(lightingUi.hasReadLighting, true, 'queryStatus of the active profile is a valid lighting read');

  const speedBeforeCaps = lightingUi.lightingSpeed;
  async function ensureStillSelected(name) {
    await win.webContents.executeJavaScript('document.getElementById("btn-custom-lighting")?.click()');
    await sleep(20);
    let snap = await snapshot();
    if (!snap.stillNames.includes(name)) {
      await win.webContents.executeJavaScript('document.getElementById("btn-still-create")?.click()');
      await sleep(20);
      await win.webContents.executeJavaScript(`
        (() => {
          const input = document.getElementById('still-name-input');
          input.value = ${JSON.stringify(name)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.getElementById('btn-still-name-confirm')?.click();
        })()
      `);
      snap = await waitUntil((s) => s.stillNames.includes(name) && s.lightingEffect === 0, 80, 50);
    } else if (snap.selectedStillName !== name) {
      await win.webContents.executeJavaScript(`
        (() => {
          const tiles = Array.from(document.querySelectorAll('#still-library-list [data-action="select-still"]'));
          const tile = tiles.find((el) => el.textContent.trim() === ${JSON.stringify(name)});
          tile?.click();
        })()
      `);
    }
    return waitLightingIdle();
  }
  for (const row of lightingCapsExpected.main) {
    if (row.id === 0) {
      await ensureStillSelected('AA');
    } else {
      await win.webContents.executeJavaScript(
        `document.querySelector('#main-effect-grid .effect-tile[data-effect="${row.id}"]')?.click()`
      );
    }
    await sleep(15);
    const snap = await snapshot();
    assert.strictEqual(snap.lightingScope, 'main', `main scope for ${row.name}`);
    assert.strictEqual(snap.mainBrightnessHidden, !row.brightness, `${row.name} brightness hidden`);
    assert.strictEqual(snap.mainSpeedHidden, !row.speed, `${row.name} speed hidden`);
    assert.strictEqual(snap.mainDirectionHidden, !row.direction, `${row.name} direction hidden`);
    assert.strictEqual(snap.lightingToggleDisabled, !row.color, `${row.name} color toggle`);
    if (!row.color) {
      assert.strictEqual(snap.lightingPickerDisabled, true, `${row.name} picker off when color unsupported`);
    } else {
      assert.strictEqual(snap.lightingPickerDisabled, snap.lightingCustomColorDisabled, `${row.name} picker follows color switch`);
    }
    if (row.id === 0) {
      assert.strictEqual(snap.customPanelHidden, false, 'Custom panel shown for effect 0');
      assert.strictEqual(snap.customLightingActive, true);
      assert.strictEqual(snap.customAriaPressed, 'true');
      assert.strictEqual(snap.selectedMainTile, '');
      assert.strictEqual(snap.mainPressedCount, 0, 'Custom must not press a preset tile');
    } else {
      assert.strictEqual(snap.selectedMainTile, row.name, `selected tile ${row.name}`);
      assert.strictEqual(snap.selectedMainAriaPressed, 'true', `aria-pressed for ${row.name}`);
      assert.strictEqual(snap.mainPressedCount, 1, `exactly one pressed main tile for ${row.name}`);
      assert.strictEqual(snap.customLightingActive, false);
      assert.strictEqual(snap.customAriaPressed, 'false');
      assert.strictEqual(snap.customPanelHidden, true);
    }
    if (row.direction) {
      const pair = lightingCapsExpected.directionPairs[row.direction];
      assert.strictEqual(snap.dir0Label, pair['0'], `${row.name} dir 0`);
      assert.strictEqual(snap.dir1Label, pair['1'], `${row.name} dir 1`);
    }
    assert.strictEqual(snap.lightingSpeed, speedBeforeCaps, `${row.name} must not clobber raw speed on render/select`);
  }

  await win.webContents.executeJavaScript(
    'document.querySelector(\'#main-effect-grid .effect-tile[data-effect="1"]\')?.click()'
  );
  await sleep(20);
  const colorProbe = await win.webContents.executeJavaScript(`
    (() => {
      const before = window.__maicongEditorSnapshot().lightingHex;
      const c = document.getElementById('light-color-input');
      c.value = '#ff0000';
      c.dispatchEvent(new Event('input', { bubbles: true }));
      const after = window.__maicongEditorSnapshot().lightingHex;
      return { before, after, disabled: c.disabled };
    })()
  `);
  assert.strictEqual(colorProbe.disabled, true);
  assert.strictEqual(colorProbe.after, colorProbe.before, 'disabled color control must not change the draft');

  await win.webContents.executeJavaScript('document.getElementById("light-scope-side")?.click()');
  await sleep(20);
  const afterScopeOnly = await snapshot();
  assert.strictEqual(afterScopeOnly.lightingScope, 'side');
  assert.strictEqual(afterScopeOnly.lightingEffect, 1, 'scope switch must not change main effect');
  for (const row of lightingCapsExpected.side) {
    await win.webContents.executeJavaScript(
      `document.querySelector('#side-effect-grid .effect-tile[data-effect="${row.id}"]')?.click()`
    );
    await sleep(15);
    const snap = await snapshot();
    assert.strictEqual(snap.sideEffect, row.id, `side ${row.name} selected`);
    assert.strictEqual(snap.selectedSideTile, row.name, `side selected tile ${row.name}`);
    assert.strictEqual(snap.selectedSideAriaPressed, 'true', `side aria-pressed ${row.name}`);
    assert.strictEqual(snap.sidePressedCount, 1, `exactly one pressed side tile for ${row.name}`);
    assert.strictEqual(snap.sideBrightnessHidden, !row.brightness, `side ${row.name} brightness`);
    assert.strictEqual(snap.sideSpeedHidden, !row.speed, `side ${row.name} speed`);
    assert.strictEqual(snap.sideToggleDisabled, !row.color, `side ${row.name} color toggle`);
    if (!row.color) {
      assert.strictEqual(snap.sideColorDisabled, true, `side ${row.name} picker off when color unsupported`);
    } else {
      assert.strictEqual(snap.sideColorDisabled, snap.sideCustomColorDisabled, `side ${row.name} picker follows color switch`);
    }
    assert.strictEqual(snap.customPanelHidden, true);
    assert.strictEqual(snap.lightingEffect, 1, 'side edits must not copy into main effect');
  }

  await win.webContents.executeJavaScript('document.getElementById("light-scope-main")?.click()');
  await sleep(20);
  await waitLightingIdle();
  mock.delayCommands.set(protocol.COMMANDS.SET_FUNC_CONFIG, 400);
  await win.webContents.executeJavaScript(`
    (() => {
      const b = document.getElementById('light-brightness-slider');
      b.value = '67';
      b.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const beforeTelemetry = await snapshot();
  assert.strictEqual(beforeTelemetry.lightingDraftDirty, true);
  const dirtyEffect = beforeTelemetry.lightingEffect;
  mock.func[8] = 3;
  await win.webContents.executeJavaScript('document.getElementById("btn-refresh")?.click()');
  await sleep(120);
  const afterTelemetry = await snapshot();
  assert.strictEqual(afterTelemetry.lightingEffect, dirtyEffect, 'telemetry must not overwrite a dirty lighting draft');
  assert.strictEqual(afterTelemetry.lightingDraftDirty, true);
  assert.strictEqual(afterTelemetry.lightingBrightness, 67);
  mock.delayCommands.delete(protocol.COMMANDS.SET_FUNC_CONFIG);

  await waitLightingIdle();
  await win.webContents.executeJavaScript('document.getElementById("btn-read-lighting")?.click()');
  await waitLightingIdle();
  const setsBeforeWave = countCommand(protocol.COMMANDS.SET_FUNC_CONFIG);
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('light-scope-main')?.click();
      document.querySelector('#main-effect-grid .effect-tile[data-effect="6"]')?.click();
    })()
  `);
  const afterSelectWave = await snapshot();
  assert.strictEqual(afterSelectWave.lightingEffect, 6, 'Horiz Wave tile must stage before autosave');
  assert.strictEqual(afterSelectWave.lightingTileDisabled, false, 'tiles must be enabled after Read completes');
  await sleep(30);
  await win.webContents.executeJavaScript(`
    (() => {
      const b = document.getElementById('light-brightness-slider');
      b.value = '80';
      b.dispatchEvent(new Event('input', { bubbles: true }));
      const s = document.getElementById('light-speed-slider');
      s.value = '2';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const afterWaveEdit = await waitLightingIdle();
  assert.ok(countCommand(protocol.COMMANDS.SET_FUNC_CONFIG) > setsBeforeWave, 'effect/slider edits must write without Apply');
  assert.strictEqual(afterWaveEdit.lightingApplyHidden, true);
  await win.webContents.executeJavaScript('document.querySelector(\'#main-effect-grid .effect-tile[data-effect="4"]\')?.click()');
  await sleep(30);
  await win.webContents.executeJavaScript(`
    (() => {
      const b = document.getElementById('light-brightness-slider');
      b.value = '45';
      b.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const afterBreathMem = await waitLightingIdle();
  assert.ok(afterBreathMem.lightMemoryMainEffects.includes(4));
  assert.ok(afterBreathMem.lightMemoryMainEffects.includes(6));
  await win.webContents.executeJavaScript('document.querySelector(\'#main-effect-grid .effect-tile[data-effect="6"]\')?.click()');
  await sleep(30);
  const restoredWave = await snapshot();
  assert.strictEqual(restoredWave.lightingEffect, 6);
  assert.strictEqual(restoredWave.lightingBrightness, 80, 'A->B->A must restore remembered Horiz Wave brightness');
  assert.strictEqual(restoredWave.lightingSpeed, 2, 'A->B->A must restore remembered Horiz Wave speed');
  await waitLightingIdle();
  await win.webContents.executeJavaScript(`
    (() => {
      const b = document.getElementById('light-brightness-slider');
      b.value = '0';
      b.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await waitLightingIdle();
  await win.webContents.executeJavaScript('document.querySelector(\'#main-effect-grid .effect-tile[data-effect="6"]\')?.click()');
  await sleep(30);
  const zeroRestore = await snapshot();
  assert.strictEqual(zeroRestore.lightingBrightness, 80, 'brightness 0 must not erase remembered nonzero brightness');
  await waitLightingIdle();
  await win.webContents.executeJavaScript('document.getElementById("light-scope-side")?.click()');
  await sleep(20);
  await win.webContents.executeJavaScript('document.querySelector(\'#side-effect-grid .effect-tile[data-effect="2"]\')?.click()');
  await sleep(20);
  await win.webContents.executeJavaScript(`
    (() => {
      const b = document.getElementById('side-brightness-slider');
      b.value = '33';
      b.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const afterSideMem = await waitLightingIdle();
  assert.strictEqual(afterSideMem.lightingEffect, 6, 'side memory apply must not copy into main effect');
  await win.webContents.executeJavaScript('document.querySelector(\'#side-effect-grid .effect-tile[data-effect="4"]\')?.click()');
  await sleep(20);
  await win.webContents.executeJavaScript('document.querySelector(\'#side-effect-grid .effect-tile[data-effect="2"]\')?.click()');
  await sleep(20);
  const restoredSide = await snapshot();
  assert.strictEqual(restoredSide.sideEffect, 2);
  assert.strictEqual(restoredSide.lightingSideBrightness, 33, 'side Constant On brightness must restore independently');
  await waitLightingIdle();
  await win.webContents.executeJavaScript('document.getElementById("light-scope-main")?.click()');
  await sleep(20);

  await win.webContents.executeJavaScript('document.getElementById("btn-custom-lighting")?.click()');
  await sleep(20);
  const customTab = await snapshot();
  assert.strictEqual(customTab.mainLightTab, 'local');
  assert.strictEqual(customTab.stillSectionHidden, false);
  assert.strictEqual(customTab.gifSectionHidden, false, 'GIF library must be visible on the Custom tab');
  assert.equal(customTab.cloudTabPresent, false, 'do not fake a cloud lighting tab');
  assert.ok(customTab.stillNames.includes('AA'));
  await win.webContents.executeJavaScript('document.getElementById("btn-still-create")?.click()');
  await sleep(20);
  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.getElementById('still-name-input');
      input.value = 'A';
      document.getElementById('btn-still-name-confirm')?.click();
    })()
  `);
  await sleep(40);
  const tooShort = await snapshot();
  assert.equal(tooShort.stillNameDialogHidden, false, 'invalid name must remain visible');
  const nameErr = await win.webContents.executeJavaScript('document.getElementById("still-name-error")?.textContent || ""');
  assert.match(nameErr, /character|empty|name/i);
  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.getElementById('still-name-input');
      input.value = 'BB';
      document.getElementById('btn-still-name-confirm')?.click();
    })()
  `);
  const createdBB = await waitUntil((s) => s.stillNames.includes('BB'), 80, 50);
  assert.ok(createdBB.stillNames.includes('BB'));
  await waitLightingIdle();
  assert.strictEqual((await snapshot()).lightingEffect, 0);
  assert.strictEqual((await snapshot()).sideEffect, restoredSide.sideEffect, 'still select must not copy into side effect');
  const selectedOffset = 840;
  assert.ok(
    countCommandOffset(protocol.COMMANDS.SET_CUSTOM_PARAM, selectedOffset) > 0,
    'selecting a still must write selectedLightEffect at offset 840'
  );
  await win.webContents.executeJavaScript(`
    (() => {
      const tiles = Array.from(document.querySelectorAll('#still-library-list [data-action="rename-still"]'));
      const tile = tiles[0];
      tile?.click();
    })()
  `);
  await sleep(20);
  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.getElementById('still-name-input');
      input.value = 'B2';
      document.getElementById('btn-still-name-confirm')?.click();
    })()
  `);
  const renamed = await waitUntil((s) => s.stillNames.includes('B2') && s.stillNameDialogHidden, 80, 50);
  assert.ok(renamed.stillNames.includes('B2'));
  assert.equal(renamed.stillNames.includes('BB'), false, 'successful rename must replace the old displayed name');
  assert.strictEqual(renamed.selectedStillName, 'B2');
  assert.deepStrictEqual(renamed.selectedLightEffect, ['still', 'B2'], 'successful rename must adopt the confirmed device pair');
  const paintedStillKey = renamed.selectedStillKey;
  await waitLightingIdle();

  mock.delayCommands.set(protocol.COMMANDS.SET_KEY_COLOR, 400);
  await win.webContents.executeJavaScript(`
    (() => {
      const keys = Array.from(document.querySelectorAll('#lighting-keys-container button.kb-key'));
      keys[0]?.click();
    })()
  `);
  await sleep(350);
  await clickStillByName('AA');
  const afterDelayedSwitch = await waitUntil(
    (s) => s.selectedStillName === 'AA'
      && Array.isArray(s.selectedLightEffect)
      && s.selectedLightEffect[1] === 'AA'
      && !s.lightingSaveWorkerBusy
      && !s.lightingOpInFlight
      && !s.lightingStillQueued
      && !s.stillEditPending,
    160,
    50
  );
  mock.delayCommands.delete(protocol.COMMANDS.SET_KEY_COLOR);
  assert.strictEqual(afterDelayedSwitch.selectedStillName, 'AA', 'desired UI selection must stay on the still clicked during the delayed save');
  assert.strictEqual(afterDelayedSwitch.selectedStillKey === paintedStillKey, false, 'delayed old-item save must not restore the previous still key');
  assert.deepStrictEqual(afterDelayedSwitch.selectedLightEffect, ['still', 'AA']);
  assert.ok(
    stillHasPaint(afterDelayedSwitch.stillFramesByName.B2, 41, '#00E5FF'),
    'B2 must keep the Esc paint captured before the canvas was overwritten'
  );
  assert.equal(
    stillHasPaint(afterDelayedSwitch.stillFramesByName.AA, 41, '#00E5FF'),
    false,
    'AA must not receive B2’s delayed paint'
  );
  assert.strictEqual(afterDelayedSwitch.stagedSlot0Color, '#000000', 'final RGB must match the newly selected empty still');

  await waitLightingIdle();
  mock.failCommands.add(protocol.COMMANDS.SET_CUSTOM_PARAM);
  await clickStillActionByName('rename-still', 'AA');
  await sleep(20);
  await confirmStillName('A3');
  const failedRename = await waitUntil((s) => s.stillNames.includes('A3') && s.stillNameDialogHidden, 80, 50);
  mock.failCommands.delete(protocol.COMMANDS.SET_CUSTOM_PARAM);
  assert.ok(failedRename.stillNames.includes('A3'), 'failed 242 rename must still render the local name');
  assert.equal(failedRename.stillNames.includes('AA'), false, 'retry must not keep the pre-rename displayed name');
  assert.strictEqual(failedRename.selectedStillName, 'A3');
  assert.deepStrictEqual(failedRename.selectedLightEffect, ['still', 'AA'], 'failed 242 rename must keep the confirmed device pair');
  assert.match(failedRename.stillLibraryError, /renamed locally|could not be updated/i);
  assert.match(failedRename.stillLibraryStatus, /renamed locally|could not be updated/i);
  assert.match(failedRename.toast, /renamed locally|could not be updated/i);
  assert.match(failedRename.toastType, /error/);

  await clickStillByName('B2');
  const selectedB2 = await waitLightingIdle();
  assert.strictEqual(selectedB2.selectedStillName, 'B2');
  assert.deepStrictEqual(selectedB2.selectedLightEffect, ['still', 'B2']);

  mock.failCommands.add(protocol.COMMANDS.SET_CUSTOM_PARAM);
  await clickStillActionByName('delete-still', 'B2');
  const failedDelete = await waitUntil((s) => !s.stillNames.includes('B2'), 80, 50);
  mock.failCommands.delete(protocol.COMMANDS.SET_CUSTOM_PARAM);
  assert.equal(failedDelete.stillNames.includes('B2'), false, 'failed 242 delete must render the local removal');
  assert.ok(failedDelete.stillNames.includes('A3'));
  assert.deepStrictEqual(failedDelete.selectedLightEffect, ['still', 'B2'], 'failed 242 delete must keep the confirmed device pair');
  assert.notStrictEqual(failedDelete.selectedStillName, 'A3', 'partial delete must not auto-select the replacement');
  assert.strictEqual(failedDelete.selectedStillKey, '');
  assert.match(failedDelete.stillLibraryError, /deleted locally|could not be updated/i);
  assert.match(failedDelete.stillLibraryStatus, /deleted locally|could not be updated/i);
  assert.match(failedDelete.toast, /deleted locally|could not be updated/i);

  await clickStillByName('A3');
  const recoveredA3 = await waitLightingIdle();
  assert.strictEqual(recoveredA3.selectedStillName, 'A3');
  assert.deepStrictEqual(recoveredA3.selectedLightEffect, ['still', 'A3']);

  mock.delayCommands.set(protocol.COMMANDS.SET_CUSTOM_PARAM, 400);
  await clickStillActionByName('rename-still', 'A3');
  await sleep(20);
  await confirmStillName('A9');
  await sleep(80);
  await win.webContents.executeJavaScript('window.__maicongHarness.setDeviceConnected(false)');
  await sleep(500);
  mock.delayCommands.delete(protocol.COMMANDS.SET_CUSTOM_PARAM);
  const afterRenameDisconnect = await snapshot();
  assert.strictEqual(afterRenameDisconnect.hasReadLighting, false, 'disconnect during delayed rename must invalidate the editor');
  assert.notStrictEqual(afterRenameDisconnect.selectedLightEffect[1], 'A9', 'stale rename must not publish a new confirmed pair after disconnect');
  await win.webContents.executeJavaScript('window.__maicongHarness.setDeviceConnected(true)');
  await clickLoadProfile(0);
  const restoredAfterRename = await waitUntil(
    (s) => s.editingProfile === 0 && s.hasReadLighting && !s.loadInFlight && s.canEditLighting
  );
  assert.ok(restoredAfterRename.stillNames.includes('A9'), 'local rename completed before disconnect must remain on disk');

  await win.webContents.executeJavaScript('document.getElementById("btn-custom-lighting")?.click()');
  await sleep(20);
  await clickStillByName('A9');
  await waitLightingIdle();
  mock.delayCommands.set(protocol.COMMANDS.SET_CUSTOM_PARAM, 400);
  await clickStillActionByName('delete-still', 'A9');
  await sleep(80);
  await clickLoadProfile(1);
  const afterDeleteLoad = await waitUntil(
    (s) => s.editingProfile === 1 && s.hasReadLighting && !s.loadInFlight && !s.lightingSaveWorkerBusy,
    80,
    50
  );
  mock.delayCommands.delete(protocol.COMMANDS.SET_CUSTOM_PARAM);
  assert.strictEqual(afterDeleteLoad.editingProfile, 1);
  assert.equal(afterDeleteLoad.stillNames.includes('A9'), false, 'local delete completed before Load must remain applied');
  assert.notStrictEqual(afterDeleteLoad.selectedLightEffect[1], 'A9', 'stale delete must not publish the old profile pair onto the Load target');
  await clickLoadProfile(0);
  const restoredAfterDelete = await waitUntil(
    (s) => s.editingProfile === 0 && s.hasReadLighting && !s.loadInFlight && s.canEditLighting
  );
  assert.strictEqual(restoredAfterDelete.editingProfile, 0);
  assert.equal(restoredAfterDelete.stillNames.includes('A9'), false);

  await win.webContents.executeJavaScript('document.getElementById("btn-custom-lighting")?.click()');
  await sleep(20);
  const gifBytes = Array.from(buildSimpleGif({
    width: 2,
    height: 2,
    palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0]],
    frames: [
      { delay: 12, pixels: [1, 1, 1, 1] },
      { delay: 20, pixels: [2, 2, 2, 2] }
    ]
  }));
  const importedWave = await win.webContents.executeJavaScript(
    `window.__maicongHarness.importGif(${JSON.stringify('Wave')}, ${JSON.stringify(gifBytes)})`
  );
  assert.equal(importedWave.success, true, importedWave.error);
  await win.webContents.executeJavaScript(`
    (() => {
      const tiles = Array.from(document.querySelectorAll('#gif-library-list [data-action="select-gif"]'));
      const tile = tiles.find((el) => el.textContent.includes('Wave'));
      tile?.click();
    })()
  `);
  const selectedWave = await waitUntil(
    (s) => s.selectedGifName === 'Wave' && Array.isArray(s.selectedLightEffect) && s.selectedLightEffect[0] === 'gif',
    80,
    50
  );
  await waitLightingIdle();
  assert.strictEqual(selectedWave.gifSectionHidden, false);
  assert.ok(selectedWave.gifNames.includes('Wave'));
  assert.deepStrictEqual((await snapshot()).selectedLightEffect, ['gif', 'Wave']);
  assert.ok(
    countCommandOffset(protocol.COMMANDS.SET_CUSTOM_PARAM, selectedOffset) > 0,
    'selecting a GIF must write selectedLightEffect at offset 840'
  );
  const streamBeforePlay = countCommand(protocol.COMMANDS.STREAM_MAIN);
  await waitUntil((s) => s.isStreaming === true, 40, 50);
  assert.ok(countCommand(protocol.COMMANDS.STREAM_MAIN) >= streamBeforePlay);
  assert.equal(countCommand(protocol.COMMANDS.STREAM_SIDE), 0);
  assert.equal(countCommand(protocol.COMMANDS.STREAM_SIDE2), 0);

  await win.webContents.executeJavaScript('document.getElementById("btn-gif-play-pause")?.click()');
  const pausedGif = await waitUntil((s) => s.isStreaming === false, 40, 50);
  assert.strictEqual(pausedGif.isStreaming, false);
  assert.match(pausedGif.gifPlayLabel, /Play/i);
  await win.webContents.executeJavaScript('document.getElementById("btn-gif-play-pause")?.click()');
  const resumedGif = await waitUntil((s) => s.isStreaming === true, 40, 50);
  assert.strictEqual(resumedGif.isStreaming, true);
  await win.webContents.executeJavaScript('document.getElementById("btn-gif-stop")?.click()');
  const stoppedGif = await waitUntil((s) => s.isStreaming === false, 40, 50);
  assert.strictEqual(stoppedGif.isStreaming, false);

  await win.webContents.executeJavaScript(`
    (() => {
      const wraps = Array.from(document.querySelectorAll('#gif-library-list .gif-tile-wrap'));
      const wrap = wraps.find((el) => el.querySelector('[data-action="select-gif"]')?.textContent.includes('Wave'));
      wrap?.querySelector('[data-action="edit-gif"]')?.click();
    })()
  `);
  const editorOpen = await waitUntil((s) => s.gifEditorHidden === false, 40, 50);
  assert.strictEqual(editorOpen.gifEditorHidden, false);
  assert.ok(editorOpen.gifEditorFrameCount >= 2);
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('gif-paint-color').value = '#00ff00';
      document.getElementById('btn-gif-fill-all')?.click();
      document.getElementById('btn-gif-editor-save')?.click();
    })()
  `);
  const editorSaved = await waitUntil((s) => s.gifEditorHidden === true, 80, 50);
  assert.strictEqual(editorSaved.gifEditorHidden, true);
  const waveFrames = editorSaved.gifFramesByName.Wave;
  assert.ok(Array.isArray(waveFrames) && waveFrames[0].data.some((row) => row.selectColor === '#00FF00'));

  const gifBytes2 = Array.from(buildSimpleGif({
    width: 2,
    height: 2,
    palette: [[0, 0, 0], [0, 0, 255]],
    frames: [{ delay: 10, pixels: [1, 1, 1, 1] }]
  }));
  const importedPulse = await win.webContents.executeJavaScript(
    `window.__maicongHarness.importGif(${JSON.stringify('Pulse')}, ${JSON.stringify(gifBytes2)})`
  );
  assert.equal(importedPulse.success, true, importedPulse.error);
  await waitLightingIdle();
  mock.delayCommands.set(protocol.COMMANDS.SET_KEY_COLOR, 400);
  await win.webContents.executeJavaScript(`
    (() => {
      const tiles = Array.from(document.querySelectorAll('#gif-library-list [data-action="select-gif"]'));
      const tile = tiles.find((el) => el.textContent.includes('Wave'));
      tile?.click();
    })()
  `);
  await sleep(80);
  await win.webContents.executeJavaScript(`
    (() => {
      const tiles = Array.from(document.querySelectorAll('#gif-library-list [data-action="select-gif"]'));
      const tile = tiles.find((el) => el.textContent.includes('Pulse'));
      tile?.click();
    })()
  `);
  const afterGifSwitch = await waitUntil(
    (s) => s.selectedGifName === 'Pulse'
      && Array.isArray(s.selectedLightEffect)
      && s.selectedLightEffect[1] === 'Pulse'
      && !s.lightingSaveWorkerBusy
      && !s.lightingOpInFlight
      && !s.lightingGifQueued,
    160,
    50
  );
  mock.delayCommands.delete(protocol.COMMANDS.SET_KEY_COLOR);
  assert.strictEqual(afterGifSwitch.selectedGifName, 'Pulse', 'delayed GIF select must keep the later click');
  assert.deepStrictEqual(afterGifSwitch.selectedLightEffect, ['gif', 'Pulse']);

  await win.webContents.executeJavaScript(`
    (() => {
      const wraps = Array.from(document.querySelectorAll('#gif-library-list .gif-tile-wrap'));
      const wrap = wraps.find((el) => el.querySelector('[data-action="select-gif"]')?.textContent.includes('Pulse'));
      wrap?.querySelector('[data-action="delete-gif"]')?.click();
    })()
  `);
  const deletedPulse = await waitUntil((s) => !s.gifNames.includes('Pulse'), 80, 50);
  assert.equal(deletedPulse.gifNames.includes('Pulse'), false);
  assert.ok(deletedPulse.gifNames.includes('Wave'));
  await waitLightingIdle();
  await win.webContents.executeJavaScript('document.getElementById("btn-gif-stop")?.click()');
  await waitUntil((s) => s.isStreaming === false, 40, 50);
  await waitLightingIdle();
  await win.webContents.executeJavaScript('document.getElementById("light-main-tab-normal")?.click()');
  await sleep(20);

  const customBeforeMac = countCommand(protocol.COMMANDS.SET_CUSTOM_PARAM);
  await win.webContents.executeJavaScript('document.getElementById("light-mem-mac")?.click()');
  await waitLightingIdle();
  const macPref = await snapshot();
  assert.strictEqual(macPref.lightMemoryFallback, 'local', 'This Mac must be a production UI setter');
  assert.strictEqual(macPref.lightMemMacPressed, 'true');
  assert.strictEqual(macPref.lightMemKeyboardPressed, 'false');
  assert.match(macPref.lightMemoryHint, /this Mac/i);
  await win.webContents.executeJavaScript('document.querySelector(\'#main-effect-grid .effect-tile[data-effect="1"]\')?.click()');
  const afterMacApply = await waitLightingIdle();
  assert.strictEqual(afterMacApply.lightMemoryBackend, 'local');
  assert.strictEqual(
    countCommand(protocol.COMMANDS.SET_CUSTOM_PARAM),
    customBeforeMac,
    'This Mac must not send CMD 242'
  );
  await win.webContents.executeJavaScript('document.getElementById("light-mem-keyboard")?.click()');
  await waitLightingIdle();
  const backHw = await snapshot();
  assert.strictEqual(backHw.lightMemoryFallback, 'hardware');
  assert.strictEqual(backHw.lightMemKeyboardPressed, 'true');

  transport.lightMemoryPrefDelayMs = 400;
  await win.webContents.executeJavaScript('document.getElementById("light-mem-mac")?.click()');
  await sleep(80);
  await win.webContents.executeJavaScript('document.getElementById("light-mem-keyboard")?.click()');
  await waitLightingIdle();
  await sleep(450);
  transport.lightMemoryPrefDelayMs = 0;
  const afterPrefRace = await snapshot();
  assert.strictEqual(afterPrefRace.lightMemoryFallback, 'hardware', 'stale This Mac getter must not overwrite a later On keyboard choice');
  assert.strictEqual(afterPrefRace.lightMemKeyboardPressed, 'true');
  assert.strictEqual(afterPrefRace.lightMemMacPressed, 'false');

  transport.lightMemoryPrefDelayMs = 400;
  await win.webContents.executeJavaScript('document.getElementById("light-mem-mac")?.click()');
  await sleep(80);
  await win.webContents.executeJavaScript('window.__maicongHarness.setDeviceConnected(false)');
  await sleep(500);
  transport.lightMemoryPrefDelayMs = 0;
  const afterPrefDisconnect = await snapshot();
  assert.strictEqual(afterPrefDisconnect.lightMemoryFallback, 'hardware', 'stale This Mac getter must not assign after disconnect');
  await win.webContents.executeJavaScript('window.__maicongHarness.setDeviceConnected(true)');
  await sleep(40);
  await win.webContents.executeJavaScript('document.getElementById("btn-read-lighting")?.click()');
  await waitLightingIdle();
  await win.webContents.executeJavaScript('document.getElementById("light-mem-keyboard")?.click()');
  await waitLightingIdle();
  assert.strictEqual((await snapshot()).lightMemoryFallback, 'hardware');

  await win.webContents.executeJavaScript(
    'window.__maicongHarness.setLighting({ effect: 99, speed: 3, hexColor: "#abcdef" })'
  );
  const unknown = await snapshot();
  assert.strictEqual(unknown.lightingEffect, 99);
  assert.strictEqual(unknown.unrecognizedHidden, false);
  assert.strictEqual(unknown.selectedMainTile, '');
  assert.strictEqual(unknown.customLightingActive, false, 'unknown must not select Custom');
  assert.strictEqual(unknown.mainSpeedHidden, true);
  const unknownSpeed = unknown.lightingSpeed;
  await win.webContents.executeJavaScript(`
    (() => {
      const s = document.getElementById('light-speed-slider');
      s.value = '0';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const unknownAfter = await snapshot();
  assert.strictEqual(unknownAfter.lightingEffect, 99, 'unknown effect must not coerce when a disabled control is poked');
  assert.strictEqual(unknownAfter.lightingSpeed, unknownSpeed);

  mock.func[8] = 99;
  mock.func[10] = 99;
  mock.func[24] = 2;
  mock.func[25] = 80;
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="read-lighting"]\')?.click()');
  await sleep(700);
  const afterUnknownRead = await snapshot();
  assert.strictEqual(afterUnknownRead.lightingEffect, 99);
  assert.strictEqual(afterUnknownRead.hasReadLighting, true);
  assert.strictEqual(afterUnknownRead.selectedMainTile, '');
  assert.strictEqual(afterUnknownRead.customLightingActive, false);
  assert.strictEqual(afterUnknownRead.mainPressedCount, 0);
  await win.webContents.executeJavaScript('document.getElementById("light-scope-side")?.click()');
  await sleep(20);
  await win.webContents.executeJavaScript(`
    (() => {
      const s = document.getElementById('side-brightness-slider');
      s.value = '41';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  mock.writtenBuffers.length = 0;
  const afterUnknownSideSave = await waitLightingIdle();
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_FUNC_CONFIG));
  assert.strictEqual(mock.func[8], 99, 'side brightness save must not coerce unknown main 99');
  assert.strictEqual(mock.func[10], 99, 'unedited main speed byte must stay even if parser would clamp');
  assert.strictEqual(mock.func[25], 41);
  assert.strictEqual(afterUnknownSideSave.hasReadLighting, true);
  assert.strictEqual(afterUnknownSideSave.lightingEffect, 99);
  assert.strictEqual(afterUnknownSideSave.lightingDraftDirty, false);

  mock.func[8] = 6;
  mock.func[9] = 100;
  mock.func[10] = 1;
  mock.func[24] = 9;
  mock.func[26] = 99;
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="read-lighting"]\')?.click()');
  await waitLightingIdle();
  await win.webContents.executeJavaScript('document.getElementById("light-scope-main")?.click()');
  await sleep(20);
  await win.webContents.executeJavaScript(`
    (() => {
      const s = document.getElementById('light-brightness-slider');
      s.value = '55';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  mock.writtenBuffers.length = 0;
  const afterUnknownMainSave = await waitLightingIdle();
  assert.strictEqual(mock.func[24], 9, 'main brightness save must not coerce unknown side 9');
  assert.strictEqual(mock.func[26], 99, 'unedited side speed byte must stay even if parser would clamp');
  assert.strictEqual(mock.func[9], 55);
  assert.strictEqual(mock.func[8], 6);
  assert.strictEqual(afterUnknownMainSave.sideEffect, 9);
  assert.strictEqual(afterUnknownMainSave.hasReadLighting, true);

  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(`
    (() => {
      const s = document.getElementById('light-brightness-slider');
      s.value = '80';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.value = '45';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.value = '33';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const afterRapid = await waitLightingIdle();
  assert.strictEqual(afterRapid.lightingBrightness, 33);
  assert.strictEqual(mock.func[9], 33, 'rapid slider must flush the final value');
  const rapidSets = countCommand(protocol.COMMANDS.SET_FUNC_CONFIG);
  assert.ok(rapidSets >= 1 && rapidSets <= 4, `rapid slider must coalesce, not write every pointer event (${rapidSets})`);

  mock.writtenBuffers.length = 0;
  for (const value of [21, 31, 41, 51, 61]) {
    await win.webContents.executeJavaScript(`
      (() => {
        const s = document.getElementById('light-brightness-slider');
        s.value = '${value}';
        s.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
    await sleep(90);
  }
  const afterCadence = await waitLightingIdle();
  assert.strictEqual(afterCadence.lightingBrightness, 61);
  assert.strictEqual(mock.func[9], 61, 'long continuous input must flush the final slider value');
  assert.ok(
    countCommand(protocol.COMMANDS.SET_FUNC_CONFIG) >= 2,
    'long continuous input must write on a bounded cadence, not only after the pointer stops'
  );

  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(`
    (() => {
      const s = document.getElementById('light-brightness-slider');
      s.value = '72';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('cal-r').value = '10';
      document.getElementById('cal-g').value = '20';
      document.getElementById('cal-b').value = '30';
      ['cal-r', 'cal-g', 'cal-b'].forEach((id) => {
        document.getElementById(id).dispatchEvent(new Event('input', { bubbles: true }));
      });
      document.getElementById('btn-apply-calibration')?.click();
    })()
  `);
  const afterCalQueued = await waitLightingIdle();
  assert.strictEqual(afterCalQueued.lightingCalInFlight, false);
  assert.strictEqual(afterCalQueued.lightingDraftDirty, false);
  assert.strictEqual(afterCalQueued.lightingSaveStatus, 'saved');
  assert.strictEqual(mock.func[9], 72, 'coalesced brightness must flush before queued calibration');
  assert.strictEqual(mock.func[40], 10);
  assert.strictEqual(mock.func[41], 20);
  assert.strictEqual(mock.func[42], 30);

  mock.failCommands.add(protocol.COMMANDS.SET_CUSTOM_PARAM);
  mock.delayCommands.set(protocol.COMMANDS.SET_FUNC_CONFIG, 300);
  await win.webContents.executeJavaScript(`
    (() => {
      const s = document.getElementById('light-brightness-slider');
      s.value = '48';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(140);
  await win.webContents.executeJavaScript(`
    (() => {
      const s = document.getElementById('light-brightness-slider');
      s.value = '18';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const afterMemFail = await waitLightingIdle();
  mock.delayCommands.delete(protocol.COMMANDS.SET_FUNC_CONFIG);
  mock.failCommands.delete(protocol.COMMANDS.SET_CUSTOM_PARAM);
  assert.strictEqual(mock.func[9], 18, 'FUNC edits during a memory-failed save must still reach the device');
  assert.strictEqual(afterMemFail.lightingMemoryBlocked, true);
  assert.notEqual(afterMemFail.lightingSaveStatus, 'error');
  assert.strictEqual(afterMemFail.lightingSaveBlocked, false);
  assert.strictEqual(afterMemFail.lightingDraftDirty, false);
  const customAfterMemFail = countCommand(protocol.COMMANDS.SET_CUSTOM_PARAM);
  await win.webContents.executeJavaScript(`
    (() => {
      const s = document.getElementById('light-brightness-slider');
      s.value = '27';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await waitLightingIdle();
  assert.strictEqual(mock.func[9], 27);
  assert.strictEqual(
    countCommand(protocol.COMMANDS.SET_CUSTOM_PARAM),
    customAfterMemFail,
    'later FUNC autosaves must not automatically retry ambiguous CMD 242'
  );

  mock.delayCommands.set(protocol.COMMANDS.SET_FUNC_CONFIG, 350);
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(`
    (() => {
      const s = document.getElementById('light-brightness-slider');
      s.value = '40';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(140);
  const pendingApply = await snapshot();
  assert.strictEqual(pendingApply.lightingOpInFlight, true, 'autosave must hold a pending lighting request');
  assert.strictEqual(pendingApply.canEditLighting, true, 'sliders stay editable during save');
  assert.strictEqual(pendingApply.lightingTileDisabled, false);
  assert.strictEqual(pendingApply.applyCalibrationDisabled, false, 'white balance queues behind an in-flight save instead of bypassing it');
  assert.strictEqual(pendingApply.lightingBrightness, 40);
  await win.webContents.executeJavaScript(`
    (() => {
      const s = document.getElementById('light-brightness-slider');
      s.value = '10';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      const cal = document.getElementById('cal-r');
      if (cal) {
        cal.value = '1';
        cal.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.getElementById('btn-apply-calibration')?.click();
    })()
  `);
  await sleep(40);
  const duringApply = await snapshot();
  assert.strictEqual(duringApply.lightingBrightness, 10, 'input during delayed save must keep the latest desired value');
  assert.strictEqual(duringApply.lightingOpInFlight, true);
  const afterPendingApply = await waitLightingIdle();
  mock.delayCommands.delete(protocol.COMMANDS.SET_FUNC_CONFIG);
  assert.strictEqual(afterPendingApply.lightingOpInFlight, false);
  assert.strictEqual(afterPendingApply.canEditLighting, true);
  assert.strictEqual(afterPendingApply.lightingDraftDirty, false);
  assert.strictEqual(afterPendingApply.lightingBrightness, 10);
  assert.strictEqual(mock.func[9], 10, 'follow-up save must write the value entered during the delayed save');
  assert.strictEqual(mock.func[40], 1, 'queued calibration must apply after the ordinary save, not instead of it');

  mock.delayCommands.set(protocol.COMMANDS.GET_FUNC_CONFIG, 350);
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-read-lighting")?.click()');
  await sleep(80);
  const pendingRead = await snapshot();
  assert.strictEqual(pendingRead.lightingOpInFlight, true, 'Read must hold a pending lighting request');
  assert.strictEqual(pendingRead.canEditLighting, false);
  assert.strictEqual(pendingRead.readLightingDisabled, true, 'reentrant Read must be rejected');
  assert.strictEqual(pendingRead.applyLightingDisabled, true);
  const brightnessBeforeRead = pendingRead.lightingBrightness;
  await win.webContents.executeJavaScript(`
    (() => {
      const s = document.getElementById('light-brightness-slider');
      s.value = '12';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btn-read-lighting')?.click();
    })()
  `);
  await sleep(40);
  const duringRead = await snapshot();
  assert.strictEqual(duringRead.lightingBrightness, brightnessBeforeRead, 'edits during pending Read must not create a draft the Read would then overwrite');
  assert.strictEqual(countCommand(protocol.COMMANDS.SET_FUNC_CONFIG), 0, 'edits during pending Read must not write');
  const afterPendingRead = await waitLightingIdle();
  mock.delayCommands.delete(protocol.COMMANDS.GET_FUNC_CONFIG);
  assert.strictEqual(afterPendingRead.lightingOpInFlight, false);
  assert.strictEqual(afterPendingRead.canEditLighting, true);
  assert.strictEqual(afterPendingRead.hasReadLighting, true);

  mock.delayCommands.set(protocol.COMMANDS.SET_FUNC_CONFIG, 350);
  await win.webContents.executeJavaScript(`
    (() => {
      const s = document.getElementById('light-brightness-slider');
      s.value = '36';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(140);
  assert.strictEqual((await snapshot()).lightingOpInFlight, true);
  await win.webContents.executeJavaScript('window.__maicongHarness.setDeviceConnected(false)');
  await sleep(40);
  const disconnectPending = await snapshot();
  assert.strictEqual(disconnectPending.lightingOpInFlight, false, 'disconnect must drop the pending lighting request');
  assert.strictEqual(disconnectPending.hasReadLighting, false);
  assert.strictEqual(disconnectPending.canEditLighting, false);
  await sleep(800);
  mock.delayCommands.delete(protocol.COMMANDS.SET_FUNC_CONFIG);
  const staleDisconnect = await snapshot();
  assert.strictEqual(staleDisconnect.lightingOpInFlight, false, 'stale save completion must not unlock after disconnect');
  assert.strictEqual(staleDisconnect.hasReadLighting, false);
  await win.webContents.executeJavaScript('window.__maicongHarness.setDeviceConnected(true)');
  await sleep(40);
  await win.webContents.executeJavaScript('document.getElementById("btn-read-lighting")?.click()');
  await waitLightingIdle();
  const recoveredAfterDisconnect = await snapshot();
  assert.strictEqual(recoveredAfterDisconnect.hasReadLighting, true, 'Read must recover after disconnect plus stale save');
  assert.strictEqual(recoveredAfterDisconnect.lightingOpInFlight, false);
  assert.strictEqual(recoveredAfterDisconnect.canEditLighting, true);

  mock.failCommands.add(protocol.COMMANDS.SET_FUNC_CONFIG);
  await win.webContents.executeJavaScript(`
    (() => {
      const s = document.getElementById('light-brightness-slider');
      s.value = '30';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(900);
  mock.failCommands.delete(protocol.COMMANDS.SET_FUNC_CONFIG);
  const afterFailApply = await snapshot();
  assert.strictEqual(afterFailApply.hasReadLighting, false, 'failed save must clear lighting provenance');
  assert.strictEqual(afterFailApply.lightingOpInFlight, false, 'failed save must release the pending request so Read can recover');
  assert.strictEqual(afterFailApply.readLightingDisabled, false, 'Read must be available after a failed save');
  assert.strictEqual(afterFailApply.lightingDraftDirty, true, 'failed save must keep the draft so telemetry cannot restore it');
  assert.strictEqual(afterFailApply.lightingSaveStatus, 'error');
  assert.strictEqual(afterFailApply.lightingTileDisabled, true);
  assert.strictEqual(afterFailApply.lightingBrightness, 30);
  assert.strictEqual(afterFailApply.onboardProfileDirty, true, 'dirty draft must mark onboard profile as dirty');
  assert.strictEqual(afterFailApply.onboardEditingTags, 1, 'dirty onboard profile must show editing tag');
  assert.strictEqual(afterFailApply.onboardCancelEditButtons, 1, 'dirty onboard profile must expose cancel edit button');
  assert.strictEqual(afterFailApply.targetBarCancelEditHidden, false, 'dirty onboard profile must show cancel edit button in target bar');
  mock.func[9] = 55;
  await win.webContents.executeJavaScript('document.getElementById("btn-refresh")?.click()');
  await sleep(700);
  const afterFailTelemetry = await snapshot();
  assert.strictEqual(afterFailTelemetry.hasReadLighting, false, 'telemetry must not restore provenance after failed save');
  assert.strictEqual(afterFailTelemetry.lightingBrightness, 30, 'telemetry must not clobber the failed-save draft');
  await assertLightingSyntheticRejected('synthetic tile click after failed save must not stage');
  assert.ok(afterFailApply.lightingWorkspaceOverflow === false);
  assert.strictEqual(afterFailApply.lightingRetryHidden, true, 'Retry waits for a successful Read after a failed save');

  mock.func[9] = 55;
  await win.webContents.executeJavaScript('document.getElementById("btn-read-lighting")?.click()');
  await waitLightingIdle();
  const afterFailRecoverRead = await snapshot();
  assert.strictEqual(afterFailRecoverRead.hasReadLighting, true);
  assert.strictEqual(afterFailRecoverRead.lightingBrightness, 30, 'Read must keep the unsaved desired brightness');
  assert.strictEqual(afterFailRecoverRead.lightingSaveBlocked, true);
  assert.strictEqual(afterFailRecoverRead.lightingRetryHidden, false);
  assert.strictEqual(afterFailRecoverRead.lightingSaveStatus, 'unsaved');
  assert.strictEqual(afterFailRecoverRead.onboardProfileDirty, true, 'retained draft after read must keep onboard profile dirty');
  assert.strictEqual(afterFailRecoverRead.onboardEditingTags, 1, 'retained draft must keep editing tag visible');
  assert.strictEqual(afterFailRecoverRead.targetBarCancelEditHidden, false, 'retained draft must keep target bar cancel edit button visible');
  assert.strictEqual(mock.func[9], 55, 'Read must not automatically resend the failed draft');
  await win.webContents.executeJavaScript('document.getElementById("btn-retry-lighting-save")?.click()');
  await waitLightingIdle();
  assert.strictEqual(mock.func[9], 30, 'Retry must deliberately resend the kept desired value');
  const afterLightingRetry = await snapshot();
  assert.strictEqual(afterLightingRetry.lightingSaveBlocked, false);
  assert.strictEqual(afterLightingRetry.onboardProfileDirty, false, 'successful retry must clear onboard dirty state');
  assert.strictEqual(afterLightingRetry.onboardEditingTags, 0, 'clean onboard profile must not show editing tag');
  assert.strictEqual(afterLightingRetry.onboardCancelEditButtons, 0, 'clean onboard profile must not show cancel edit button');
  assert.strictEqual(afterLightingRetry.targetBarCancelEditHidden, true, 'clean onboard profile must hide cancel edit button in target bar');

  mock.failCommands.add(protocol.COMMANDS.GET_FUNC_CONFIG);
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="read-lighting"]\')?.click()');
  await sleep(700);
  mock.failCommands.delete(protocol.COMMANDS.GET_FUNC_CONFIG);
  const afterFailRead = await snapshot();
  assert.strictEqual(afterFailRead.hasReadLighting, false, 'failed lighting read must clear provenance');
  assert.strictEqual(afterFailRead.lightingOpInFlight, false, 'failed Read must release the pending request');
  assert.strictEqual(afterFailRead.lightingTileDisabled, true);
  await assertLightingSyntheticRejected('synthetic tile click after failed lighting read must not stage');

  await win.webContents.executeJavaScript('window.__maicongHarness.setDeviceConnected(false)');
  await sleep(40);
  const afterDisconnect = await snapshot();
  assert.strictEqual(afterDisconnect.hasReadLighting, false);
  assert.strictEqual(afterDisconnect.canEditLighting, false);
  await assertLightingSyntheticRejected('synthetic tile click after disconnect must not stage');
  await win.webContents.executeJavaScript('window.__maicongHarness.setDeviceConnected(true)');
  await sleep(40);
  await win.webContents.executeJavaScript('document.getElementById("btn-read-lighting")?.click()');
  const recoveredAfterUiDisconnect = await waitLightingIdle();
  assert.strictEqual(recoveredAfterUiDisconnect.hasReadLighting, true, 'explicit Read after reconnect must restore lighting provenance');

  mock.writtenBuffers.length = 0;
  mock.delayCommands.set(protocol.COMMANDS.SET_FUNC_CONFIG, 350);
  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelector('[data-action="set-tab"][data-tab="lighting"]')?.click();
      const s = document.getElementById('light-brightness-slider');
      if (s) {
        s.value = '42';
        s.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()
  `);
  await sleep(140);
  const pendingProfileSwitch = await snapshot();
  assert.strictEqual(pendingProfileSwitch.lightingOpInFlight, true);
  assert.strictEqual(pendingProfileSwitch.lightingBrightness, 42);
  await win.webContents.executeJavaScript(`
    document.querySelector('[data-action="set-layer"][data-layer="0"]')?.click();
    document.getElementById('edit-profile-select').value = '2';
    document.getElementById('btn-load-edit-target').click();
  `);
  let afterProfileSwitch = await snapshot();
  for (let i = 0; i < 40; i++) {
    if (afterProfileSwitch.editingProfile === 2 && afterProfileSwitch.hasReadLighting && !afterProfileSwitch.loadInFlight) {
      break;
    }
    await sleep(50);
    afterProfileSwitch = await snapshot();
  }
  mock.delayCommands.delete(protocol.COMMANDS.SET_FUNC_CONFIG);
  assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_BASE), false, 'edit selection must not SET_BASE');
  const editingLabel = await win.webContents.executeJavaScript(
    'document.getElementById("editing-label")?.textContent'
  );
  assert.match(editingLabel || '', /Profile 3/);
  assert.strictEqual(afterProfileSwitch.editingProfile, 2);
  assert.strictEqual(afterProfileSwitch.onboardProfileDirty, false, 'clean loaded profile 2 must not be dirty');
  assert.strictEqual(afterProfileSwitch.onboardEditingTags, 0, 'clean loaded profile 2 must not show editing tag');
  assert.strictEqual(afterProfileSwitch.onboardCancelEditButtons, 0, 'clean loaded profile 2 must not show cancel edit button');
  assert.strictEqual(afterProfileSwitch.targetBarCancelEditHidden, true, 'clean loaded profile 2 must hide cancel edit button in target bar');
  assert.strictEqual(afterProfileSwitch.bannerCancelEditHidden, true, 'clean loaded profile 2 must hide cancel edit button in top banner');
  assert.strictEqual(afterProfileSwitch.lightingOpInFlight, false, 'profile switch must drop the prior lighting request identity');
  assert.strictEqual(afterProfileSwitch.hasReadLighting, true);
  assert.strictEqual(afterProfileSwitch.canEditLighting, true, 'stale Apply completion must not leave lighting locked');
  assert.strictEqual(afterProfileSwitch.lightingTileDisabled, false, 'Load for editing must re-enable lighting tiles after drain');
  assert.strictEqual(afterProfileSwitch.lightingBrightness, 100, 'profile 2 read must not keep the in-flight profile 0 draft');
  assert.ok(countCommand(protocol.COMMANDS.SET_FUNC_CONFIG) <= 2, 'profile switch must not start a second lighting Apply');

  let toastAfterTimeout = null;
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    toastAfterTimeout = await win.webContents.executeJavaScript(`
      (() => {
        const el = document.getElementById('toast-banner');
        const cs = getComputedStyle(el);
        return { hidden: Boolean(el.hidden), display: cs.display, attr: el.hasAttribute('hidden') };
      })()
    `);
    if (toastAfterTimeout.hidden && toastAfterTimeout.display === 'none') break;
  }
  assert.equal(toastAfterTimeout.hidden, true, 'toast must set hidden after timeout');
  assert.equal(toastAfterTimeout.display, 'none', 'toast computed display must be none after timeout');

  const sidebarChrome = await win.webContents.executeJavaScript(`
    ({
      name: document.getElementById('sidebar-device-name')?.textContent || '',
      status: document.getElementById('device-status-text')?.textContent || ''
    })
  `);
  assert.equal(sidebarChrome.name.trim(), 'G75 V2');
  assert.match(sidebarChrome.status, /2\.4 GHz|USB|Offline|Timeout/);
  assert.doesNotMatch(sidebarChrome.status, /0x3837|VID/);

  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="set-tab"][data-tab="keymap"]\')?.click()'
  );
  await sleep(150);
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('k_a')?.click();
      const mediaTab = Array.from(document.querySelectorAll('#palette-category-tabs button'))
        .find(b => /Media/.test(b.textContent || ''));
      if (mediaTab) mediaTab.click();
    })()
  `);
  await sleep(200);
  await win.webContents.executeJavaScript(`
    (() => {
      const mute = Array.from(document.querySelectorAll('#palette-keys-container button'))
        .find(b => /Mute/.test(b.textContent || ''));
      if (mute) mute.click();
    })()
  `);
  await sleep(150);
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(
    'document.getElementById("btn-apply-keymap")?.click()'
  );
  await sleep(600);
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX));
  assert.deepStrictEqual(mock.readUserKey(2, 0, 11).slice(0, 1).concat(mock.readUserKey(2, 0, 11).slice(1)), mock.readUserKey(2, 0, 11));
  const aTuple = mock.readUserKey(2, 0, 11);
  assert.strictEqual(aTuple[0], 48);
  assert.strictEqual(aTuple[1], 226);

  // --- REAL Electron Rendered Palette Assertions for All 4 Layers (Review Item 2) ---
  const renderedPaletteSummary = await win.webContents.executeJavaScript(`
    (async () => {
      const results = {};
      const layerBtns = [0, 1, 2, 3];
      for (const l of layerBtns) {
        document.querySelector('[data-action="set-layer"][data-layer="' + l + '"]')?.click();
        await new Promise(r => setTimeout(r, 60));
        const catTabs = Array.from(document.querySelectorAll('#palette-category-tabs button.palette-cat-btn'))
          .map(b => b.dataset.category || b.textContent.trim());
        const layerCats = {};
        for (const cat of catTabs) {
          const tabBtn = Array.from(document.querySelectorAll('#palette-category-tabs button.palette-cat-btn'))
            .find(b => (b.dataset.category || b.textContent.trim()) === cat);
          if (tabBtn) tabBtn.click();
          await new Promise(r => setTimeout(r, 30));
          const keys = Array.from(document.querySelectorAll('#palette-keys-container button.palette-key-btn')).map(b => ({
            label: b.textContent.trim(),
            type: parseInt(b.dataset.type, 10),
            code1: parseInt(b.dataset.code1, 10),
            code2: parseInt(b.dataset.code2, 10)
          }));
          layerCats[cat] = keys;
        }
        results[l] = { tabs: catTabs, categories: layerCats };
      }
      return results;
    })()
  `);

  // Verify layer 0: Windows Default
  const l0 = renderedPaletteSummary[0].categories;
  assert.strictEqual(l0['Basic'].length, 104);
  assert.strictEqual(l0['Mouse'].length, 7);
  assert.ok(l0['Mouse'].some(k => k.label === 'Left mouse button' && k.type === 32 && k.code1 === 1 && k.code2 === 0));
  assert.ok(l0['Mouse'].some(k => k.label === 'Wheel up' && k.type === 33 && k.code1 === 0 && k.code2 === 1));
  assert.ok(l0['Mouse'].some(k => k.label === 'Wheel down' && k.type === 33 && k.code1 === 0 && k.code2 === 255));
  assert.strictEqual(l0['Media'].length, 7);
  assert.ok(l0['Media'].some(k => k.label === 'Play / Pause' && k.type === 48 && k.code1 === 205));
  assert.ok(l0['Media'].some(k => k.label === 'Mute' && k.type === 48 && k.code1 === 226));
  assert.ok(l0['Media'].some(k => k.label === 'Stop' && k.type === 48 && k.code1 === 183));
  assert.strictEqual(l0['Main Lighting'].length, 9);
  assert.ok(l0['Main Lighting'].some(k => k.label === 'Toggle keyboard backlight' && k.type === 240 && k.code1 === 53));
  assert.strictEqual(l0['Side Lighting'].length, 8);
  assert.ok(l0['Side Lighting'].some(k => k.label === 'Switch indicator mode' && k.type === 240 && k.code1 === 160));
  assert.strictEqual(l0['Extended'].length, 50);
  assert.ok(l0['Extended'].some(k => k.label === 'Copy' && k.type === 16 && k.code1 === 1 && k.code2 === 6));
  assert.ok(l0['Extended'].some(k => k.label === 'Switch Profile' && k.type === 240 && k.code1 === 250));
  assert.ok(l0['Extended'].some(k => k.label === 'Clear' && k.type === 16 && k.code1 === 0 && k.code2 === 0));
  assert.ok(l0['Extended'].some(k => k.label === 'FN Layer' && k.type === 240 && k.code1 === 255 && k.code2 === 1));
  const l0RenderedTotal = Object.keys(l0).filter(c => c !== 'Macros').reduce((sum, c) => sum + l0[c].length, 0);
  assert.strictEqual(l0RenderedTotal, 185, 'Layer 0 rendered palette must have exactly 185 items');

  // Verify layer 1: Windows Fn
  const l1 = renderedPaletteSummary[1].categories;
  assert.strictEqual(l1['Basic'].length, 104);
  assert.strictEqual(l1['Mouse'].length, 7);
  assert.strictEqual(l1['Media'].length, 7);
  assert.strictEqual(l1['Main Lighting'].length, 9);
  assert.strictEqual(l1['Side Lighting'].length, 8);
  assert.strictEqual(l1['Extended'].length, 49);
  assert.strictEqual(l1['Extended'].some(k => k.label === 'FN Layer'), false, 'Fn key must be omitted on Fn layer 1');
  const l1RenderedTotal = Object.keys(l1).filter(c => c !== 'Macros').reduce((sum, c) => sum + l1[c].length, 0);
  assert.strictEqual(l1RenderedTotal, 184, 'Layer 1 rendered palette must have exactly 184 items');

  // Verify layer 2: Mac Default
  const l2 = renderedPaletteSummary[2].categories;
  assert.strictEqual(l2['Basic'].length, 104);
  assert.strictEqual(l2['Mouse'].length, 7);
  assert.strictEqual(l2['Media'].length, 6, 'Media Stop (183) must be omitted on Mac layer 2');
  assert.strictEqual(l2['Media'].some(k => k.code1 === 183), false);
  assert.strictEqual(l2['Main Lighting'].length, 9);
  assert.strictEqual(l2['Side Lighting'].length, 8);
  assert.strictEqual(l2['Extended'].length, 35);
  assert.ok(l2['Extended'].some(k => k.label === 'FN Layer' && k.type === 240 && k.code1 === 255 && k.code2 === 3));
  const l2RenderedTotal = Object.keys(l2).filter(c => c !== 'Macros').reduce((sum, c) => sum + l2[c].length, 0);
  assert.strictEqual(l2RenderedTotal, 169, 'Layer 2 rendered palette must have exactly 169 items');

  // Verify layer 3: Mac Fn
  const l3 = renderedPaletteSummary[3].categories;
  assert.strictEqual(l3['Basic'].length, 104);
  assert.strictEqual(l3['Mouse'].length, 7);
  assert.strictEqual(l3['Media'].length, 6);
  assert.strictEqual(l3['Main Lighting'].length, 9);
  assert.strictEqual(l3['Side Lighting'].length, 8);
  assert.strictEqual(l3['Extended'].length, 34);
  assert.strictEqual(l3['Extended'].some(k => k.label === 'FN Layer'), false, 'Fn key must be omitted on Fn layer 3');
  const l3RenderedTotal = Object.keys(l3).filter(c => c !== 'Macros').reduce((sum, c) => sum + l3[c].length, 0);
  assert.strictEqual(l3RenderedTotal, 168, 'Layer 3 rendered palette must have exactly 168 items');

  // --- Representative Mouse/wheel/mainlight/sidelight/Win-Macshortcut Selection, Apply & Reread ---
  // Switch back to Layer 0
  await win.webContents.executeJavaScript(`
    document.querySelector('[data-action="set-layer"][data-layer="0"]')?.click();
  `);
  await sleep(100);

  // Representative Mouse button: assign Mouse Left [32, 1, 0] to slot 12 (Key E)
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('k_e')?.click();
      const mouseTab = Array.from(document.querySelectorAll('#palette-category-tabs button'))
        .find(b => (b.dataset.category || b.textContent.trim()) === 'Mouse');
      if (mouseTab) mouseTab.click();
    })()
  `);
  await sleep(100);
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = Array.from(document.querySelectorAll('#palette-keys-container button'))
        .find(b => b.textContent.trim() === 'Left mouse button');
      if (btn) btn.click();
    })()
  `);
  await sleep(100);
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-apply-keymap")?.click()');
  await sleep(600);
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX));
  assert.deepStrictEqual(mock.readUserKey(2, 0, 26), [32, 1, 0], 'Left mouse button must be written to mock hardware');

  // Representative Mouse wheel: assign Wheel up [33, 0, 1] to slot 34 (Key R)
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('k_r')?.click();
      const mouseTab = Array.from(document.querySelectorAll('#palette-category-tabs button'))
        .find(b => (b.dataset.category || b.textContent.trim()) === 'Mouse');
      if (mouseTab) mouseTab.click();
    })()
  `);
  await sleep(100);
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = Array.from(document.querySelectorAll('#palette-keys-container button'))
        .find(b => b.textContent.trim() === 'Wheel up');
      if (btn) btn.click();
    })()
  `);
  await sleep(100);
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-apply-keymap")?.click()');
  await sleep(600);
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX));
  assert.deepStrictEqual(mock.readUserKey(2, 0, 34), [33, 0, 1], 'Wheel up must be written to mock hardware');

  // Representative Main Lighting: assign Toggle keyboard backlight [240, 53, 0] to slot 42 (Key T)
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('k_t')?.click();
      const lightTab = Array.from(document.querySelectorAll('#palette-category-tabs button'))
        .find(b => (b.dataset.category || b.textContent.trim()) === 'Main Lighting');
      if (lightTab) lightTab.click();
    })()
  `);
  await sleep(100);
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = Array.from(document.querySelectorAll('#palette-keys-container button'))
        .find(b => b.textContent.trim() === 'Toggle keyboard backlight');
      if (btn) btn.click();
    })()
  `);
  await sleep(100);
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-apply-keymap")?.click()');
  await sleep(600);
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX));
  assert.deepStrictEqual(mock.readUserKey(2, 0, 42), [240, 53, 0], 'Toggle keyboard backlight must be written to mock hardware');

  // Representative Side Lighting: assign Switch indicator mode [240, 160, 0] to slot 50 (Key Y)
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('k_y')?.click();
      const sideTab = Array.from(document.querySelectorAll('#palette-category-tabs button'))
        .find(b => (b.dataset.category || b.textContent.trim()) === 'Side Lighting');
      if (sideTab) sideTab.click();
    })()
  `);
  await sleep(100);
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = Array.from(document.querySelectorAll('#palette-keys-container button'))
        .find(b => b.textContent.trim() === 'Switch indicator mode');
      if (btn) btn.click();
    })()
  `);
  await sleep(100);
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-apply-keymap")?.click()');
  await sleep(600);
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX));
  assert.deepStrictEqual(mock.readUserKey(2, 0, 50), [240, 160, 0], 'Switch indicator mode must be written to mock hardware');

  // Representative Windows shortcut: assign Copy [16, 1, 6] to slot 58 (Key U)
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('k_u')?.click();
      const extTab = Array.from(document.querySelectorAll('#palette-category-tabs button'))
        .find(b => (b.dataset.category || b.textContent.trim()) === 'Extended');
      if (extTab) extTab.click();
    })()
  `);
  await sleep(100);
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = Array.from(document.querySelectorAll('#palette-keys-container button'))
        .find(b => b.textContent.trim() === 'Copy');
      if (btn) btn.click();
    })()
  `);
  await sleep(100);
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-apply-keymap")?.click()');
  await sleep(600);
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX));
  assert.deepStrictEqual(mock.readUserKey(2, 0, 58), [16, 1, 6], 'Copy shortcut must be written to mock hardware');

  // Verify reread on Layer 0 confirms labels for all representative applied keys
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="read-layer"]\')?.click()');
  await sleep(600);
  const rereadL0Labels = await win.webContents.executeJavaScript(`
    (() => ({
      e: document.querySelector('#k_e .key-label')?.textContent.trim() || '',
      r: document.querySelector('#k_r .key-label')?.textContent.trim() || '',
      t: document.querySelector('#k_t .key-label')?.textContent.trim() || '',
      y: document.querySelector('#k_y .key-label')?.textContent.trim() || '',
      u: document.querySelector('#k_u .key-label')?.textContent.trim() || ''
    }))()
  `);
  assert.strictEqual(rereadL0Labels.e, 'Left mouse button');
  assert.strictEqual(rereadL0Labels.r, 'Wheel up');
  assert.strictEqual(rereadL0Labels.t, 'Toggle keyboard backlight');
  assert.strictEqual(rereadL0Labels.y, 'Switch indicator mode');
  assert.strictEqual(rereadL0Labels.u, 'Copy');

  // Representative Mac shortcut: switch to Layer 2, read layer, select Mission Control [16, 1, 82] to slot 66 (Key I)
  await win.webContents.executeJavaScript(`
    document.querySelector('[data-action="set-layer"][data-layer="2"]')?.click();
  `);
  await sleep(100);
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="read-layer"]\')?.click()');
  await sleep(600);
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('k_i')?.click();
      const extTab = Array.from(document.querySelectorAll('#palette-category-tabs button'))
        .find(b => (b.dataset.category || b.textContent.trim()) === 'Extended');
      if (extTab) extTab.click();
    })()
  `);
  await sleep(100);
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = Array.from(document.querySelectorAll('#palette-keys-container button'))
        .find(b => b.textContent.trim() === 'Mission Control');
      if (btn) btn.click();
    })()
  `);
  await sleep(100);
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-apply-keymap")?.click()');
  await sleep(600);
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX));
  assert.deepStrictEqual(mock.readUserKey(2, 2, 66), [16, 1, 82], 'Mission Control shortcut must be written to Layer 2 mock hardware');
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="read-layer"]\')?.click()');
  await sleep(600);
  const rereadL2Label = await win.webContents.executeJavaScript('document.querySelector("#k_i .key-label")?.textContent.trim()');
  assert.strictEqual(rereadL2Label, 'Mission Control');

  // --- Provenance Invalidation on Failed Read & Blocked Palette/Macro Re-enabling (Review Item 3) ---
  mock.failCommands.add(protocol.COMMANDS.GET_USER_KEY_MATRIX);
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="read-layer"]\')?.click()');
  await sleep(600);
  const provFailSnap = await win.webContents.executeJavaScript('window.__maicongEditorSnapshot()');
  assert.strictEqual(provFailSnap.hasReadKeymap[2], false, 'failed read must drop writable provenance on active layer');
  assert.strictEqual(provFailSnap.applyKeymapDisabled, true, 'Apply must be disabled after failed read');

  // Attempt to assign key from palette after failed read
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('k_i')?.click();
      const basicTab = Array.from(document.querySelectorAll('#palette-category-tabs button'))
        .find(b => (b.dataset.category || b.textContent.trim()) === 'Basic');
      if (basicTab) basicTab.click();
    })()
  `);
  await sleep(80);
  await win.webContents.executeJavaScript(`
    (() => {
      const aBtn = Array.from(document.querySelectorAll('#palette-keys-container button'))
        .find(b => b.textContent.trim() === 'A');
      if (aBtn) aBtn.click();
    })()
  `);
  await sleep(80);
  const afterPalAssignSnap = await win.webContents.executeJavaScript('window.__maicongEditorSnapshot()');
  assert.strictEqual(afterPalAssignSnap.hasReadKeymap[2], false, 'assignKeyToSelected must NOT manufacture hasReadKeymap=true');
  assert.strictEqual(afterPalAssignSnap.applyKeymapDisabled, true, 'Apply must remain disabled after palette click on unread layer');

  // Attempt to assign macro from palette after failed read
  await win.webContents.executeJavaScript(`
    (() => {
      const macroTab = Array.from(document.querySelectorAll('#palette-category-tabs button'))
        .find(b => (b.dataset.category || b.textContent.trim()) === 'Macros');
      if (macroTab) macroTab.click();
    })()
  `);
  await sleep(80);
  await win.webContents.executeJavaScript(`
    (() => {
      const m1Btn = Array.from(document.querySelectorAll('#palette-keys-container button'))
        .find(b => b.textContent.trim() === 'M1');
      if (m1Btn) m1Btn.click();
    })()
  `);
  await sleep(80);
  const afterMacroAssignSnap = await win.webContents.executeJavaScript('window.__maicongEditorSnapshot()');
  assert.strictEqual(afterMacroAssignSnap.hasReadKeymap[2], false, 'assignMacroToSelected must NOT manufacture hasReadKeymap=true');
  assert.strictEqual(afterMacroAssignSnap.applyKeymapDisabled, true, 'Apply must remain disabled after macro click on unread layer');

  // Verify apply cannot write to HID
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-apply-keymap")?.click()');
  await sleep(300);
  assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false, 'unprovenanced apply must dispatch zero HID writes');

  // Clear fail and restore Layer 2 provenance
  mock.failCommands.delete(protocol.COMMANDS.GET_USER_KEY_MATRIX);
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="read-layer"]\')?.click()');
  await sleep(600);
  const provRestoredSnap = await win.webContents.executeJavaScript('window.__maicongEditorSnapshot()');
  assert.strictEqual(provRestoredSnap.hasReadKeymap[2], true);

  // --- Atomic Layer Replacement with [0,0,0] Disabled and [16,0,0] Vendor Clear (Review Item 4) ---
  await win.webContents.executeJavaScript(`
    document.querySelector('[data-action="set-layer"][data-layer="0"]')?.click();
  `);
  await sleep(100);
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="read-layer"]\')?.click()');
  await sleep(600);

  // Poke mock hardware with [0, 0, 0] on slot 11 (Key A), then read layer
  mock.pokeUserKey(2, 0, 11, [0, 0, 0]);
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="read-layer"]\')?.click()');
  await sleep(600);
  const disabledKeyInfo = await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('k_a')?.click();
      return {
        label: document.querySelector('#k_a .key-label')?.textContent.trim() || '',
        box: document.getElementById('inspector-key-box')?.textContent.trim() || ''
      };
    })()
  `);
  assert.strictEqual(disabledKeyInfo.label, 'Disabled', 'old [0,0,0] must display Disabled on key label');
  assert.strictEqual(disabledKeyInfo.box, 'Disabled', 'old [0,0,0] must display Disabled in inspector box');

  // Poke mock hardware with [16, 0, 0] on slot 11 (Key A), then read layer
  mock.pokeUserKey(2, 0, 11, [16, 0, 0]);
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="read-layer"]\')?.click()');
  await sleep(600);
  const clearKeyInfo = await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('k_a')?.click();
      return {
        label: document.querySelector('#k_a .key-label')?.textContent.trim() || '',
        box: document.getElementById('inspector-key-box')?.textContent.trim() || ''
      };
    })()
  `);
  assert.strictEqual(clearKeyInfo.label, 'Clear', 'vendor clear [16,0,0] must display Clear on key label');
  assert.strictEqual(clearKeyInfo.box, 'Clear', 'vendor clear [16,0,0] must display Clear in inspector box');

  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="set-tab"][data-tab="macros"]\')?.click()'
  );
  await sleep(150);
  try {
    await win.webContents.executeJavaScript(`
      (() => {
        if (!window.MaicongMacroDraft) throw new Error('MaicongMacroDraft missing');
        const typeEl = document.getElementById('macro-new-type');
        if (!typeEl) throw new Error('macro-new-type missing');
        const sel = document.getElementById('macro-playback-type');
        if (sel) { sel.value = '255'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        typeEl.value = 'keydown';
        document.querySelector('[data-action="add-macro-action"]')?.click();
        return true;
      })()
    `);
  } catch (err) {
    throw new Error(`add-macro-action script: ${err.message}`);
  }
  await sleep(150);
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(
    'document.getElementById("btn-apply-macros")?.click()'
  );
  await sleep(1200);
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_MACROS));

  win.focus();
  let macrosReady;
  try {
    macrosReady = await win.webContents.executeJavaScript('window.__maicongEditorSnapshot()');
  } catch (err) {
    throw new Error(`macrosReady snapshot failed: ${err.message}`);
  }
  assert.equal(macrosReady.snapshotError, undefined, macrosReady.snapshotError || 'snapshot ok');
  assert.strictEqual(macrosReady.hasHarness, true, 'unpackaged mock-ui must install harness-only helpers');
  assert.strictEqual(macrosReady.hasReadMacros, true, 'edit-target load must mark macros read before drafts');
  assert.strictEqual(macrosReady.applyMacrosDisabled, false);
  assert.strictEqual(macrosReady.paletteHasMedia, false, 'macro key palette must omit media tuples');
  assert.strictEqual(macrosReady.paletteHasFn, false, 'macro key palette must omit Fn');

  await win.webContents.executeJavaScript(`
    document.querySelector('#macro-slots-list button:nth-child(1)')?.click();
    document.querySelector('[data-action="copy-macro-actions"]')?.click();
    document.querySelector('#macro-slots-list button:nth-child(2)')?.click();
    document.querySelector('[data-action="paste-macro-actions"]')?.click();
  `);
  await sleep(120);
  const pastedCounts = await win.webContents.executeJavaScript('window.__maicongEditorSnapshot()');
  assert.ok(pastedCounts.macroActionCounts[0] > 0);
  assert.strictEqual(pastedCounts.macroActionCounts[1], pastedCounts.macroActionCounts[0]);

  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelector('#macro-slots-list button:nth-child(1)')?.click();
      const chk = document.getElementById('macro-standard-delay');
      if (chk && chk.checked) { chk.checked = false; chk.dispatchEvent(new Event('change', { bubbles: true })); }
      document.getElementById('btn-record-macro')?.click();
    })()
  `);
  await sleep(80);
  const recFocus = await win.webContents.executeJavaScript('window.__maicongEditorSnapshot()');
  assert.strictEqual(recFocus.isRecordingMacro, true);
  assert.strictEqual(recFocus.activeElementId, 'macro-capture-surface', 'Record must move focus into the capture area');
  assert.strictEqual(recFocus.captureFocused, true);

  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' });
  await sleep(130);
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A' });
  await sleep(40);
  await win.webContents.executeJavaScript('document.getElementById("btn-record-macro")?.click()');
  await sleep(400);
  const pausedSnap = await win.webContents.executeJavaScript('window.__maicongEditorSnapshot()');
  assert.strictEqual(pausedSnap.isRecordingMacro, false);
  await win.webContents.executeJavaScript('document.getElementById("btn-record-macro")?.click()');
  await sleep(80);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B' });
  await sleep(40);
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'B' });
  await sleep(40);
  await win.webContents.executeJavaScript('document.getElementById("btn-record-macro")?.click()');
  const afterPause = await win.webContents.executeJavaScript('window.__maicongHarness.getActions(0)');
  const bDown = [...afterPause].reverse().find((a) => a.action === 'keydown' && a.code === 5);
  assert.ok(bDown, 'resume must record KeyB through the focused capture area');
  const aUp = afterPause.find((a) => a.action === 'keyup' && a.code === 4);
  if (aUp) assert.ok(aUp.delay < 250, `pause gap must not become the prior-action trailing delay, got ${aUp.delay}`);

  await win.webContents.executeJavaScript('document.getElementById("btn-record-macro")?.click()');
  await sleep(80);
  const capBox = await win.webContents.executeJavaScript(`
    (() => {
      const r = document.getElementById('macro-capture-surface').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()
  `);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: capBox.x, y: capBox.y, button: 'left', clickCount: 1 });
  await sleep(40);
  win.webContents.sendInputEvent({ type: 'mouseUp', x: capBox.x, y: capBox.y, button: 'left', clickCount: 1 });
  await sleep(40);
  await win.webContents.executeJavaScript('document.getElementById("btn-record-macro")?.click()');
  const withMouse = await win.webContents.executeJavaScript('window.__maicongHarness.getActions(0)');
  assert.ok(withMouse.some((a) => a.action === 'mousedown' && a.code === 1), 'left mouse button records macro code 1');
  assert.ok(withMouse.some((a) => a.action === 'mouseup' && a.code === 1));

  await win.webContents.executeJavaScript(`
    (() => {
      const rows = document.querySelectorAll('#macro-actions-tbody tr');
      if (rows[0]) rows[0].click();
      document.querySelector('[data-action="edit-macro-action-kind"]')?.click();
    })()
  `);
  await sleep(50);
  const afterEdit = await win.webContents.executeJavaScript(`
    (() => {
      const a0 = window.__maicongHarness.getActions(0);
      const a1 = window.__maicongHarness.getActions(1);
      return { first: a0[0], slot1: a1[0], n0: a0.length, n1: a1.length };
    })()
  `);
  assert.ok(afterEdit.first.action === 'keyup' || afterEdit.first.action === 'keydown');
  assert.strictEqual(afterEdit.n1, pastedCounts.macroActionCounts[1], 'editing slot 0 must not rewrite slot 1');

  // Test Replace Selected operation (review item 3)
  await win.webContents.executeJavaScript(`
    (() => {
      window.__maicongHarness.fillSlotActions(0, 0);
      const typeEl = document.getElementById('macro-new-type');
      const keyEl = document.getElementById('macro-new-key');
      const delayEl = document.getElementById('macro-new-delay');
      typeEl.value = 'keydown';
      keyEl.value = '4';
      delayEl.value = '50';
      document.querySelector('[data-action="add-macro-action"]')?.click();
      typeEl.value = 'keyup';
      keyEl.value = '5';
      delayEl.value = '100';
      document.querySelector('[data-action="add-macro-action"]')?.click();
      typeEl.value = 'keydown';
      keyEl.value = '6';
      delayEl.value = '200';
      document.querySelector('[data-action="add-macro-action"]')?.click();
    })()
  `);
  await sleep(100);
  const beforeReplace = await win.webContents.executeJavaScript('(() => window.__maicongHarness.getActions(0))()');
  assert.strictEqual(beforeReplace.length, 3);
  assert.strictEqual(beforeReplace[0].code, 4);
  assert.strictEqual(beforeReplace[1].code, 5);
  assert.strictEqual(beforeReplace[2].code, 6);
  assert.strictEqual(beforeReplace[1].delay, 100);

  // Select action 1 and replace it with KeyD (code 7)
  await win.webContents.executeJavaScript(`
    (() => {
      const rows = document.querySelectorAll('#macro-actions-tbody tr');
      if (rows[1]) rows[1].click();
      const keyEl = document.getElementById('macro-new-key');
      keyEl.value = '7';
      document.querySelector('[data-action="replace-macro-action"]')?.click();
    })()
  `);
  await sleep(80);
  const afterReplace = await win.webContents.executeJavaScript('(() => window.__maicongHarness.getActions(0))()');
  assert.strictEqual(afterReplace.length, 3, 'replace must preserve action count');
  assert.strictEqual(afterReplace[0].code, 4, 'surrounding action 0 code must be preserved');
  assert.strictEqual(afterReplace[0].delay, 50, 'surrounding action 0 delay must be preserved');
  assert.strictEqual(afterReplace[1].code, 7, 'action 1 code must be replaced with KeyD');
  assert.strictEqual(afterReplace[1].delay, 100, 'action 1 delay must be preserved during replace');
  assert.strictEqual(afterReplace[2].code, 6, 'surrounding action 2 code must be preserved');
  assert.strictEqual(afterReplace[2].delay, 200, 'surrounding action 2 delay must be preserved');

  // Review items 5 & 6: Insert mouse action honors selected kind/code and preserves surrounding actions
  await win.webContents.executeJavaScript(`
    (() => {
      const rows = document.querySelectorAll('#macro-actions-tbody tr');
      if (rows[0]) rows[0].click();
      const typeEl = document.getElementById('macro-new-type');
      typeEl.value = 'mousedown';
      typeEl.dispatchEvent(new Event('change', { bubbles: true }));
      const keyEl = document.getElementById('macro-new-key');
      keyEl.value = '2';
      const delayEl = document.getElementById('macro-new-delay');
      delayEl.value = '60';
      document.querySelector('[data-action="insert-macro-action"]')?.click();
    })()
  `);
  await sleep(80);
  const afterMouseInsert = await win.webContents.executeJavaScript('(() => window.__maicongHarness.getActions(0))()');
  assert.strictEqual(afterMouseInsert.length, 4, 'insert must add exactly one mouse action');
  assert.strictEqual(afterMouseInsert[0].code, 4, 'surrounding action 0 code preserved');
  assert.strictEqual(afterMouseInsert[0].delay, 50, 'surrounding action 0 delay preserved');
  assert.strictEqual(afterMouseInsert[1].action, 'mousedown', 'inserted action must have action mousedown');
  assert.strictEqual(afterMouseInsert[1].code, 2, 'inserted action must have mouse button code 2');
  assert.strictEqual(afterMouseInsert[1].delay, 60, 'inserted action must have specified delay 60');
  assert.strictEqual(afterMouseInsert[2].code, 7, 'surrounding action 2 code preserved');
  assert.strictEqual(afterMouseInsert[2].delay, 100, 'surrounding action 2 delay preserved');
  assert.strictEqual(afterMouseInsert[3].code, 6, 'surrounding action 3 code preserved');
  assert.strictEqual(afterMouseInsert[3].delay, 200, 'surrounding action 3 delay preserved');

  // Review items 5 & 6: Insert keypress pair inserts down + up pair in sequence
  await win.webContents.executeJavaScript(`
    (() => {
      const rows = document.querySelectorAll('#macro-actions-tbody tr');
      if (rows[1]) rows[1].click();
      const typeEl = document.getElementById('macro-new-type');
      typeEl.value = 'keypress';
      typeEl.dispatchEvent(new Event('change', { bubbles: true }));
      const keyEl = document.getElementById('macro-new-key');
      keyEl.value = '5';
      const delayEl = document.getElementById('macro-new-delay');
      delayEl.value = '80';
      document.querySelector('[data-action="insert-macro-action"]')?.click();
    })()
  `);
  await sleep(80);
  const afterKeypressInsert = await win.webContents.executeJavaScript('(() => window.__maicongHarness.getActions(0))()');
  assert.strictEqual(afterKeypressInsert.length, 6, 'insert keypress pair must add two actions');
  assert.strictEqual(afterKeypressInsert[0].code, 4);
  assert.strictEqual(afterKeypressInsert[1].action, 'mousedown');
  assert.strictEqual(afterKeypressInsert[1].code, 2);
  assert.strictEqual(afterKeypressInsert[2].action, 'keydown');
  assert.strictEqual(afterKeypressInsert[2].code, 5);
  assert.strictEqual(afterKeypressInsert[2].delay, 80);
  assert.strictEqual(afterKeypressInsert[3].action, 'keyup');
  assert.strictEqual(afterKeypressInsert[3].code, 5);
  assert.strictEqual(afterKeypressInsert[3].delay, 5, 'keypress pair release uses MIN_DELAY (5ms)');
  assert.strictEqual(afterKeypressInsert[4].code, 7);
  assert.strictEqual(afterKeypressInsert[5].code, 6);

  // Review item 7: Duplicate long macros deduplicate action bodies and apply successfully
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(`
    (() => {
      for (let s = 2; s < 16; s++) window.__maicongHarness.fillSlotActions(s, 0);
      window.__maicongHarness.fillSlotActions(0, 600);
      const shared = window.__maicongHarness.getActions(0);
      window.__maicongHarness.setSlotActions(1, shared);
      document.getElementById('btn-apply-macros')?.click();
    })()
  `);
  await sleep(600);
  assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_MACROS), true, 'duplicate long macros must fit deduplicated bank and write CMD 13');

  // Review item 8: Divergence overflow rejected by prospective check in UI
  const preDivergeCount = await win.webContents.executeJavaScript('(() => window.__maicongHarness.getActions(0).length)()');
  assert.strictEqual(preDivergeCount, 600);
  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelector('#macro-slots-list button:nth-child(1)')?.click();
      const rows = document.querySelectorAll('#macro-actions-tbody tr');
      if (rows[0]) rows[0].click();
      const typeEl = document.getElementById('macro-new-type');
      typeEl.value = 'keydown';
      typeEl.dispatchEvent(new Event('change', { bubbles: true }));
      const keyEl = document.getElementById('macro-new-key');
      keyEl.value = '4';
      document.querySelector('[data-action="insert-macro-action"]')?.click();
    })()
  `);
  await sleep(100);
  const postDivergeInsertCount = await win.webContents.executeJavaScript('(() => window.__maicongHarness.getActions(0).length)()');
  assert.strictEqual(postDivergeInsertCount, 600, 'divergent insert must be blocked when total deduplicated storage would overflow 4096 bytes');

  await win.webContents.executeJavaScript(`
    (() => {
      const delayInput = document.querySelector('#macro-actions-tbody tr td input.macro-action-delay-input');
      if (delayInput) {
        delayInput.value = '999';
        delayInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()
  `);
  await sleep(100);
  const slot0Actions = await win.webContents.executeJavaScript('(() => window.__maicongHarness.getActions(0))()');
  assert.strictEqual(slot0Actions[0].delay, 5, 'delay edit causing divergence overflow must be reverted');

  // Full-bank apply rejects capacity overflow without HID writes (review item 6)
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(`
    (() => {
      window.__maicongHarness.fillSlotActions(0, 1008);
      document.getElementById('btn-apply-macros')?.click();
    })()
  `);
  await sleep(400);
  assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_MACROS), false, 'capacity overflow must not write CMD 13');

  // Actual recorder capacity reserving ups, no orphan releases (review item 6)
  await win.webContents.executeJavaScript(`
    (() => {
      for (let s = 1; s < 16; s++) window.__maicongHarness.fillSlotActions(s, 0);
      window.__maicongHarness.fillSlotActions(0, 1005);
      document.getElementById('btn-record-macro')?.click();
    })()
  `);
  await sleep(80);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' });
  await sleep(40);
  const held = await win.webContents.executeJavaScript('(() => window.__maicongHarness.getActions(0).length)()');
  assert.strictEqual(held, 1006, 'KeyA down must record successfully into available capacity');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B' });
  await sleep(40);
  const heldBlocked = await win.webContents.executeJavaScript('(() => window.__maicongHarness.getActions(0).length)()');
  assert.strictEqual(heldBlocked, held, 'a second down must be rejected when a release slot is reserved');
  await win.webContents.executeJavaScript('(() => { document.getElementById("btn-record-macro")?.click(); })()');
  await sleep(80);
  const flushed = await win.webContents.executeJavaScript('(() => window.__maicongHarness.getActions(0))()');
  assert.ok(flushed.some((a) => a.action === 'keyup' && a.code === 4), 'pause must emit the reserved release');
  const afterFlush = flushed.length;
  assert.strictEqual(afterFlush, 1007, 'flushed actions must reach exact maximum capacity of 1007');
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A' });
  await sleep(40);
  const orphan = await win.webContents.executeJavaScript('(() => window.__maicongHarness.getActions(0).length)()');
  assert.strictEqual(orphan, afterFlush, 'orphan keyup after pause must be ignored');

  // Clear slot 0 actions back to clean state
  await win.webContents.executeJavaScript('(() => { window.__maicongHarness.fillSlotActions(0, 0); })()');

  mock.failCommands.add(protocol.COMMANDS.GET_MACROS);
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="read-macros"]\')?.click()'
  );
  await sleep(800);
  const failedRead = await win.webContents.executeJavaScript('window.__maicongEditorSnapshot()');
  assert.strictEqual(failedRead.hasReadMacros, false, 'failed reread must drop writable bank provenance');
  assert.strictEqual(failedRead.applyMacrosDisabled, true);
  const nameDuringFail = await win.webContents.executeJavaScript(`
    (() => {
      const before = window.__maicongEditorSnapshot().applyMacrosDisabled;
      const nameInput = document.getElementById('macro-name-input');
      nameInput.value = 'Should Not Enable Apply';
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-action="add-macro-action"]')?.click();
      return { before, after: window.__maicongEditorSnapshot().applyMacrosDisabled };
    })()
  `);
  assert.strictEqual(nameDuringFail.after, true, 'name edits must not re-enable Apply after a failed read');
  mock.failCommands.delete(protocol.COMMANDS.GET_MACROS);
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="read-macros"]\')?.click()'
  );
  await sleep(800);

  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelector('#macro-slots-list button:nth-child(1)')?.click();
      const nameInput = document.getElementById('macro-name-input');
      nameInput.value = 'Persist Slot One';
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#macro-slots-list button:nth-child(2)')?.click();
    })()
  `);
  await sleep(150);
  await win.webContents.executeJavaScript(
    'document.querySelector(\'#macro-slots-list button:nth-child(1)\')?.click()'
  );
  await sleep(80);
  const switched = await win.webContents.executeJavaScript(`
    (() => ({
      input: document.getElementById('macro-name-input')?.value || '',
      title: document.getElementById('macro-editor-title')?.textContent || ''
    }))()
  `);
  assert.match(switched.input, /Persist Slot One/);
  const storedMeta = await win.webContents.executeJavaScript(
    'window.maicongApi.getMacroMetadata()'
  );
  assert.strictEqual(storedMeta.success, true);
  assert.strictEqual(storedMeta.meta.slots[0].name, 'Persist Slot One');

  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="set-tab"][data-tab="lighting"]\')?.click()'
  );
  await sleep(150);
  await win.webContents.executeJavaScript(`
    (() => {
      const b = document.getElementById('light-brightness-slider');
      b.value = '40';
      b.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('cal-r').value = '200';
      document.getElementById('cal-r').dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  mock.writtenBuffers.length = 0;
  await waitLightingIdle();
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_FUNC_CONFIG), 'brightness edit must autosave without Apply');
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(`
    (() => {
      const r = document.getElementById('cal-r');
      r.value = '200';
      r.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btn-apply-calibration')?.click();
    })()
  `);
  await sleep(500);
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_FUNC_CONFIG));
  assert.strictEqual(mock.func[2 * 64 + 40], 200);

  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="set-tab"][data-tab="advanced"]\')?.click()'
  );
  await sleep(150);
  mock.writtenBuffers.length = 0;
  const advMeta = await win.webContents.executeJavaScript(`
    (() => {
      const sel = document.getElementById('adv-key-select');
      if (!sel) return { missing: true, count: 0, excluded: true, label: '' };
      return {
        missing: false,
        count: sel.options.length,
        excluded: Array.from(sel.options).some((o) => o.value === '37' || o.value === '85')
      };
    })()
  `);
  assert.strictEqual(advMeta.missing, false, 'advanced physical-key select must exist');
  assert.strictEqual(advMeta.count, 80, 'advanced physical-key select lists 80 eligible keys');
  assert.strictEqual(advMeta.excluded, false, 'Fn slot 85 and knob slot 37 must be excluded');
  await win.webContents.executeJavaScript(`
    (() => {
      const sel = document.getElementById('adv-key-select');
      if (!sel) throw new Error('adv-key-select missing');
      sel.value = '11';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(100);
  const advLabel = await win.webContents.executeJavaScript(
    'document.getElementById("advanced-selected-info") ? document.getElementById("advanced-selected-info").textContent : ""'
  );
  assert.match(advLabel, /\bA\b/);
  assert.match(advLabel, /Profile/);
  assert.strictEqual(mock.writtenBuffers.length, 0, 'choosing a key on Advanced must not write HID');
  await win.webContents.executeJavaScript(`
    (() => {
      const kind = document.getElementById('adv-kind');
      const mod = document.getElementById('adv-cb-modifier');
      const reg = document.getElementById('adv-cb-regular');
      if (!kind || !mod || !reg) throw new Error('CB editor controls missing');
      kind.value = 'cb';
      kind.dispatchEvent(new Event('change', { bubbles: true }));
      mod.value = '16,1,0';
      mod.dispatchEvent(new Event('change', { bubbles: true }));
      reg.value = '16,0,4';
      reg.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  const cbGroups = await win.webContents.executeJavaScript(`
    (() => {
      const vis = (id) => {
        const el = document.getElementById(id);
        const cs = getComputedStyle(el);
        return { hidden: Boolean(el.hidden), display: cs.display };
      };
      return { mt: vis('adv-mt-fields'), cb: vis('adv-cb-fields'), tgl: vis('adv-tgl-fields') };
    })()
  `);
  assert.equal(cbGroups.cb.hidden, false);
  assert.notEqual(cbGroups.cb.display, 'none');
  assert.equal(cbGroups.mt.hidden, true);
  assert.equal(cbGroups.mt.display, 'none');
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(
    'document.getElementById("btn-apply-advanced")?.click()'
  );
  await sleep(900);
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX));
  assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_MT_KEYS), false);
  assert.deepStrictEqual(mock.readUserKey(2, 0, 11), [16, 1, 4]);
  const comboLabel = await win.webContents.executeJavaScript(
    'document.getElementById("advanced-current-binding")?.textContent || ""'
  );
  assert.match(comboLabel, /Ctrl/i);
  assert.match(comboLabel, /\bA\b/);
  assert.doesNotMatch(comboLabel, /mask/);

  await win.webContents.executeJavaScript(`
    (() => {
      const mod = document.getElementById('adv-cb-modifier');
      if (!mod) throw new Error('adv-cb-modifier missing');
      mod.value = '16,2,0';
      mod.dispatchEvent(new Event('change', { bubbles: true }));
      return mod.value;
    })()
  `);
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="set-tab"][data-tab="lighting"]\')?.click()'
  );
  await sleep(150);
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="set-tab"][data-tab="advanced"]\')?.click()'
  );
  await sleep(150);
  const draftAfterRerender = await win.webContents.executeJavaScript(`
    ({
      mod: document.getElementById('adv-cb-modifier')?.value || '',
      reg: document.getElementById('adv-cb-regular')?.value || '',
      kind: document.getElementById('adv-kind')?.value || ''
    })
  `);
  assert.equal(draftAfterRerender.kind, 'cb');
  assert.equal(draftAfterRerender.mod, '16,2,0', 'unapplied CB draft must survive unrelated rerender');
  assert.equal(draftAfterRerender.reg, '16,0,4');

  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(
    'document.getElementById("btn-apply-advanced")?.click()'
  );
  await sleep(900);
  assert.deepStrictEqual(mock.readUserKey(2, 0, 11), [16, 2, 4]);

  await win.webContents.executeJavaScript(`
    (() => {
      const sel = document.getElementById('adv-key-select');
      const kind = document.getElementById('adv-kind');
      const mod = document.getElementById('adv-cb-modifier');
      const reg = document.getElementById('adv-cb-regular');
      if (!sel || !kind || !mod || !reg) throw new Error('CB editor controls missing');
      sel.value = '19';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      kind.value = 'cb';
      kind.dispatchEvent(new Event('change', { bubbles: true }));
      mod.value = '16,8,0';
      mod.dispatchEvent(new Event('change', { bubbles: true }));
      reg.value = '16,0,22';
      reg.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(
    'document.getElementById("btn-apply-advanced")?.click()'
  );
  await sleep(900);
  assert.deepStrictEqual(mock.readUserKey(2, 0, 19), [16, 8, 22]);

  await win.webContents.executeJavaScript(`
    (() => {
      const sel = document.getElementById('adv-key-select');
      if (!sel) throw new Error('adv-key-select missing');
      sel.value = '11';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    })()
  `);
  await sleep(100);
  const loadedA = await win.webContents.executeJavaScript(`
    ({
      mod: document.getElementById('adv-cb-modifier')?.value || '',
      reg: document.getElementById('adv-cb-regular')?.value || '',
      bind: document.getElementById('advanced-current-binding')?.textContent || ''
    })
  `);
  assert.equal(loadedA.mod, '16,2,0', 'switching to A must load its existing Shift+A combo');
  assert.equal(loadedA.reg, '16,0,4');
  assert.match(loadedA.bind, /Shift/i);
  assert.match(loadedA.bind, /\bA\b/);

  await win.webContents.executeJavaScript(`
    (() => {
      const sel = document.getElementById('adv-key-select');
      if (!sel) throw new Error('adv-key-select missing');
      sel.value = '19';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    })()
  `);
  await sleep(100);
  const loadedS = await win.webContents.executeJavaScript(`
    ({
      mod: document.getElementById('adv-cb-modifier')?.value || '',
      reg: document.getElementById('adv-cb-regular')?.value || ''
    })
  `);
  assert.equal(loadedS.mod, '16,8,0', 'switching to S must load its existing Win+S combo');
  assert.equal(loadedS.reg, '16,0,22');

  await win.webContents.executeJavaScript(`
    (() => {
      const sel = document.getElementById('adv-key-select');
      if (!sel) throw new Error('adv-key-select missing');
      sel.value = '11';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    })()
  `);
  await sleep(100);
  const beforeReread = await win.webContents.executeJavaScript(`
    ({
      mod: document.getElementById('adv-cb-modifier')?.value || '',
      reg: document.getElementById('adv-cb-regular')?.value || ''
    })
  `);
  assert.equal(beforeReread.mod, '16,2,0', 'A still shows Shift+A before explicit reread');
  assert.equal(beforeReread.reg, '16,0,4');

  mock.pokeUserKey(2, 0, 11, [16, 3, 4]);
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="read-layer"]\')?.click()'
  );
  await sleep(900);
  assert.deepStrictEqual(mock.readUserKey(2, 0, 11), [16, 3, 4]);
  const loadedCtrlShiftA = await win.webContents.executeJavaScript(`
    (() => {
      const mod = document.getElementById('adv-cb-modifier');
      if (!mod) throw new Error('adv-cb-modifier missing');
      const opt = Array.from(mod.options).find((o) => o.value === '16,3,0');
      return {
        mod: mod.value || '',
        reg: document.getElementById('adv-cb-regular')?.value || '',
        bind: document.getElementById('advanced-current-binding')?.textContent || '',
        optionText: opt ? opt.textContent : ''
      };
    })()
  `);
  assert.equal(loadedCtrlShiftA.mod, '16,3,0', 'same-key explicit reread must load Ctrl+Shift+A');
  assert.equal(loadedCtrlShiftA.reg, '16,0,4');
  assert.match(loadedCtrlShiftA.bind, /Ctrl/i);
  assert.match(loadedCtrlShiftA.bind, /Shift/i);
  assert.match(loadedCtrlShiftA.bind, /\bA\b/);
  assert.doesNotMatch(loadedCtrlShiftA.bind, /modifier 3/);
  assert.match(loadedCtrlShiftA.optionText, /Ctrl/i);
  assert.match(loadedCtrlShiftA.optionText, /Shift/i);

  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(
    'document.getElementById("btn-apply-advanced")?.click()'
  );
  await sleep(900);
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX));
  assert.deepStrictEqual(mock.readUserKey(2, 0, 11), [16, 3, 4], 'Apply must keep compound Ctrl+Shift+A');

  await win.webContents.executeJavaScript(`
    document.querySelector('[data-action="set-tab"][data-tab="keymap"]')?.click();
  `);
  await sleep(100);
  await win.webContents.executeJavaScript('document.getElementById("k_s")?.click()');
  await sleep(100);
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="set-tab"][data-tab="advanced"]\')?.click()'
  );
  await sleep(150);
  await win.webContents.executeJavaScript(`
    document.getElementById('adv-kind').value = 'tgl';
    document.getElementById('adv-kind').dispatchEvent(new Event('change', { bubbles: true }));
  `);
  const advGroups = await win.webContents.executeJavaScript(`
    (() => {
      const vis = (id) => {
        const el = document.getElementById(id);
        const cs = getComputedStyle(el);
        return { hidden: Boolean(el.hidden), display: cs.display };
      };
      return { mt: vis('adv-mt-fields'), tgl: vis('adv-tgl-fields'), socd: vis('adv-socd-fields') };
    })()
  `);
  assert.equal(advGroups.tgl.hidden, false);
  assert.notEqual(advGroups.tgl.display, 'none');
  assert.equal(advGroups.mt.hidden, true);
  assert.equal(advGroups.mt.display, 'none');
  assert.equal(advGroups.socd.hidden, true);
  assert.equal(advGroups.socd.display, 'none');

  // Verify visible advanced choices (Review Item 5)
  const advTargetOptions = await win.webContents.executeJavaScript(`
    (() => {
      const sel = document.getElementById('adv-target-select');
      if (!sel) return [];
      return Array.from(sel.options).map(o => ({
        value: o.value,
        text: o.textContent.trim()
      }));
    })()
  `);
  assert.ok(advTargetOptions.length > 0);
  assert.strictEqual(advTargetOptions.some(o => o.value.startsWith('48,')), false, 'TGL dropdown must NOT offer media tuples (type 48)');
  assert.strictEqual(advTargetOptions.some(o => o.value.startsWith('240,250,')), false, 'TGL dropdown must NOT offer SwitchProfile');
  assert.strictEqual(advTargetOptions.some(o => o.value.startsWith('240,255,')), false, 'TGL dropdown must NOT offer FN Layer');
  assert.ok(advTargetOptions.some(o => o.value.startsWith('32,')), 'TGL dropdown must offer supported mouse button tuples (type 32)');
  assert.ok(advTargetOptions.some(o => o.value.startsWith('33,')), 'TGL dropdown must offer supported mouse wheel tuples (type 33)');

  const advMtOptions = await win.webContents.executeJavaScript(`
    (() => {
      const sel = document.getElementById('adv-tap-select');
      if (!sel) return [];
      return Array.from(sel.options).map(o => o.value);
    })()
  `);
  assert.ok(advMtOptions.some(v => v.startsWith('32,')), 'MT tap dropdown must offer supported mouse button tuples (type 32)');
  assert.ok(advMtOptions.some(v => v.startsWith('33,')), 'MT tap dropdown must offer supported mouse wheel tuples (type 33)');

  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(
    'document.getElementById("btn-apply-advanced")?.click()'
  );
  await sleep(900);
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_TGL_KEYS));
  const sTuple = mock.readUserKey(2, 0, 19);
  assert.strictEqual(sTuple[0], 145);

  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(
    'document.getElementById("btn-remove-advanced")?.click()'
  );
  await sleep(900);
  assert.notStrictEqual(mock.readUserKey(2, 0, 19)[0], 145);

  console.log('[MockUI] advanced: hub three-column list, tester, delete confirm, clear-all');
  const hubLayout = await win.webContents.executeJavaScript(`
    (() => {
      const snap = window.__maicongEditorSnapshot();
      return {
        cols: snap.advancedHubCols,
        cards: snap.advancedTypeCards,
        dks: snap.hasDksTypeCard,
        simultaneous: snap.hasSimultaneousSocd,
        countLabel: snap.advancedBindingCountLabel
      };
    })()
  `);
  assert.equal(hubLayout.cols, 3, 'Advanced tab must be three columns');
  assert.deepEqual(hubLayout.cards, ['socd', 'mt', 'tgl', 'cb']);
  assert.equal(hubLayout.dks, false);
  assert.equal(hubLayout.simultaneous, false);
  assert.match(hubLayout.countLabel, /\/40$/);

  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('adv-type-mt')?.click();
      const sel = document.getElementById('adv-key-select');
      sel.value = '0';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await sleep(100);
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-apply-advanced")?.click()');
  await sleep(900);
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_MT_KEYS));
  const afterMtList = await snapshot();
  assert.ok(afterMtList.advancedBindingCount >= 1);
  assert.match(afterMtList.advancedBindingCountLabel, /\/40$/);

  await win.webContents.executeJavaScript(`
    (() => {
      const row = Array.from(document.querySelectorAll('#advanced-binding-list .adv-binding-item'))
        .find((el) => el.querySelector('.adv-binding-kind')?.textContent.trim() === 'MT');
      row?.click();
      return Boolean(row);
    })()
  `);
  await sleep(80);
  const loadedFromList = await snapshot();
  assert.equal(loadedFromList.advancedKind, 'mt');

  await win.webContents.executeJavaScript(`
    document.querySelector('#advanced-binding-list .adv-binding-delete')?.click()
  `);
  await sleep(50);
  const confirmOpen = await snapshot();
  assert.equal(confirmOpen.advancedDeleteConfirmOpen, true);
  await win.webContents.executeJavaScript(`
    document.querySelector('#advanced-binding-list .adv-binding-confirm .action-btn:not(.danger-subtle)')?.click()
  `);
  await sleep(50);
  const confirmClosed = await snapshot();
  assert.equal(confirmClosed.advancedDeleteConfirmOpen, false);

  await win.webContents.executeJavaScript(`
    (() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true }));
    })()
  `);
  await sleep(50);
  const tester = await snapshot();
  assert.ok(tester.bindingTestPress.length >= 1, 'press test must list newest keydown');
  assert.ok(tester.bindingTestRelease.length >= 1, 'release test must list keyup');

  const escBeforeClear = mock.readUserKey(2, 0, 0);
  assert.equal(escBeforeClear[0], 146);
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-clear-all-advanced")?.click()');
  await sleep(80);
  const clearDlg = await snapshot();
  assert.equal(clearDlg.advancedClearDialogHidden, false);
  await win.webContents.executeJavaScript('document.getElementById("btn-advanced-clear-confirm")?.click()');
  await sleep(1200);
  assert.equal(mock.wroteCommand(protocol.COMMANDS.FACTORY_RESET), false);
  assert.notEqual(mock.readUserKey(2, 0, 0)[0], 146);
  assert.notEqual(mock.readUserKey(2, 0, 11)[0], 145);

  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="set-tab"][data-tab="profiles"]\')?.click()'
  );
  await sleep(150);
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="export-profile"]\')?.click()'
  );
  await sleep(800);
  const exportPath = path.join(__dirname, '..', 'test-artifacts', 'mock-ui-export-profile-2.json');
  const exportPath0 = path.join(__dirname, '..', 'test-artifacts', 'mock-ui-export-profile-0.json');
  const exportedFile = fs.existsSync(exportPath) ? exportPath : exportPath0;
  assert.ok(fs.existsSync(exportedFile), 'export JSON must be written');
  const exported = JSON.parse(fs.readFileSync(exportedFile, 'utf8'));
  assert.ok(exported.advanced);
  exported.macros[0].name = '<script>x</script>';
  fs.writeFileSync(exportPath0, JSON.stringify(exported, null, 2));

  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="import-profile"]\')?.click()'
  );
  await sleep(400);
  const preview = await win.webContents.executeJavaScript(
    'document.getElementById("imported-profile-json")?.textContent || ""'
  );
  assert.match(preview, /hasAdvanced/);
  assert.match(preview, /atomic": false|atomic.: false/);
  const importPreviewVis = await win.webContents.executeJavaScript(`
    (() => {
      const el = document.getElementById('imported-profile-preview');
      const cs = getComputedStyle(el);
      return { hidden: Boolean(el.hidden), display: cs.display };
    })()
  `);
  assert.equal(importPreviewVis.hidden, false);
  assert.notEqual(importPreviewVis.display, 'none');

  const setCountBefore = mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_BASE).length;
  await win.webContents.executeJavaScript(
    'document.getElementById("edit-profile-select").value = "1"; document.getElementById("btn-load-edit-target").click();'
  );
  await sleep(900);
  const setCountAfter = mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_BASE).length;
  assert.strictEqual(setCountAfter, setCountBefore, 'switching edit profile must not SET_BASE');

  const loadedP1 = await snapshot();
  assert.strictEqual(loadedP1.editingProfile, 1);
  assert.strictEqual(loadedP1.activeProfile, 0);
  assert.strictEqual(loadedP1.macMode, 0, 'edit-target profile 1 macMode must not come from active profile 0');
  assert.strictEqual(loadedP1.lightingEffect, 6);
  assert.notStrictEqual(loadedP1.lightingEffect, 16);
  assert.strictEqual(loadedP1.hasReadLighting, true);
  assert.strictEqual(loadedP1.applyLightingDisabled, false);
  assert.strictEqual(loadedP1.macroNames[0], '<script>x</script>', 'imported macro names must stay literal after target load');

  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="set-tab"][data-tab="macros"]\')?.click()'
  );
  await sleep(150);
  await win.webContents.executeJavaScript(`
    (() => {
      const nameInput = document.getElementById('macro-name-input');
      nameInput.value = 'Literal Local Name';
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(100);
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="read-macros"]\')?.click()'
  );
  await sleep(800);
  const afterMacroRead = await snapshot();
  assert.strictEqual(afterMacroRead.macroNames[0], 'Literal Local Name');
  const slotNameText = await win.webContents.executeJavaScript(
    'document.querySelector("#macro-slots-list .slot-name")?.textContent'
  );
  assert.strictEqual(slotNameText, 'Literal Local Name');

  mock.func[64 + 9] = 40;
  await win.webContents.executeJavaScript(
    'document.getElementById("edit-profile-select").value = "1"; document.getElementById("btn-load-edit-target").click();'
  );
  await sleep(900);
  const brightP1 = await snapshot();
  assert.strictEqual(brightP1.lightingBrightness, 40);
  assert.strictEqual(brightP1.macMode, 0);

  mock.delayCommands.set(protocol.COMMANDS.GET_USER_KEY_MATRIX, 120);
  await win.webContents.executeJavaScript(`
    document.querySelector('[data-action="set-tab"][data-tab="keymap"]')?.click();
    document.querySelector('[data-action="set-layer"][data-layer="0"]')?.click();
    document.querySelector('[data-action="read-layer"]')?.click();
  `);
  await sleep(80);
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="set-layer"][data-layer="2"]\')?.click()'
  );
  await sleep(1400);
  mock.delayCommands.delete(protocol.COMMANDS.GET_USER_KEY_MATRIX);
  const afterLayerRace = await snapshot();
  assert.strictEqual(afterLayerRace.activeLayer, 2);
  assert.strictEqual(afterLayerRace.hasReadKeymap[2], false, 'delayed layer-0 read must not mark layer 2 as read');
  assert.strictEqual(afterLayerRace.applyKeymapDisabled, true);

  mock.delayCommands.set(protocol.COMMANDS.GET_FUNC_CONFIG, 200);
  await win.webContents.executeJavaScript(
    'document.getElementById("edit-profile-select").value = "0"; document.getElementById("btn-load-edit-target").click();'
  );
  await sleep(80);
  await win.webContents.executeJavaScript(
    'document.getElementById("edit-profile-select").value = "1"; document.getElementById("btn-load-edit-target").click();'
  );
  await sleep(2200);
  mock.delayCommands.delete(protocol.COMMANDS.GET_FUNC_CONFIG);
  const afterProfileRace = await snapshot();
  assert.strictEqual(afterProfileRace.editingProfile, 1);
  assert.strictEqual(afterProfileRace.activeProfile, 0);
  assert.strictEqual(afterProfileRace.lightingBrightness, 40, 'stale profile-0 funcConfig must not overwrite profile 1 brightness');
  assert.strictEqual(afterProfileRace.macMode, 0, 'stale profile-0 macMode must not overwrite profile 1');
  assert.strictEqual(afterProfileRace.lightingEffect, 6);
  assert.strictEqual(afterProfileRace.hasReadLighting, true);
  assert.strictEqual(afterProfileRace.applyLightingDisabled, false);
  assert.strictEqual(afterProfileRace.macroNames[0], 'Literal Local Name');

  mock.failCommands.add(protocol.COMMANDS.GET_FUNC_CONFIG);
  await win.webContents.executeJavaScript(
    'document.getElementById("edit-profile-select").value = "1"; document.getElementById("btn-load-edit-target").click();'
  );
  await sleep(900);
  mock.failCommands.delete(protocol.COMMANDS.GET_FUNC_CONFIG);
  const afterFail = await snapshot();
  assert.strictEqual(afterFail.hasReadLighting, false);
  assert.strictEqual(afterFail.hasReadSettings, false);
  assert.strictEqual(afterFail.applyLightingDisabled, true, 'failed funcConfig must not enable Apply');
  assert.strictEqual(afterFail.applySettingsDisabled, true);
  assert.match(afterFail.toastType, /error/);
  assert.match(afterFail.toast, /Failed to load/i);
  await assertLightingSyntheticRejected('synthetic tile click after failed profile load/read must not stage');

  // ==========================================
  // G75 Web Hub Parity: Performance Settings UI
  // ==========================================
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="set-tab"][data-tab="settings"]\')?.click()'
  );
  await sleep(200);

  async function measureSettingsColumns() {
    return win.webContents.executeJavaScript(`
      (() => {
        const grid = document.querySelector('#panel-settings .settings-cards-grid');
        const cols = Array.from(document.querySelectorAll('#panel-settings .settings-cards-grid > .settings-col'));
        if (!grid || cols.length < 2) return { missing: true, colCount: cols.length };
        const left = cols[0].getBoundingClientRect();
        const right = cols[1].getBoundingClientRect();
        const leftCards = Array.from(cols[0].querySelectorAll('.dash-card'));
        const rightCards = Array.from(cols[1].querySelectorAll('.dash-card'));
        const warning = Array.from(document.querySelectorAll('#panel-settings p, #panel-settings .field-hint, #panel-settings .capability-notice'))
          .map((el) => el.textContent || '')
          .join(' ');
        const radios = Array.from(document.querySelectorAll('#setting-polling-rate input[name="setting-polling-rate"]'));
        const radioBoxes = radios.map((el) => el.closest('label')?.getBoundingClientRect()).filter(Boolean);
        return {
          missing: false,
          innerW: window.innerWidth,
          innerH: window.innerHeight,
          colCount: cols.length,
          leftCardCount: leftCards.length,
          rightCardCount: rightCards.length,
          left: { x: left.left, y: left.top, r: left.right, b: left.bottom, w: left.width },
          right: { x: right.left, y: right.top, r: right.right, b: right.bottom, w: right.width },
          leftTitles: leftCards.map((c) => c.querySelector('h2')?.textContent || ''),
          rightTitles: rightCards.map((c) => c.querySelector('h2')?.textContent || ''),
          hasRate: Boolean(document.getElementById('setting-polling-rate')),
          hasSleep: Boolean(document.getElementById('setting-sleep-time')),
          hasWin: Boolean(document.getElementById('setting-lock-win')),
          hasMac: Boolean(document.getElementById('btn-mode-mac')),
          hasCombo: Boolean(document.getElementById('setting-key-combo')),
          radioCount: radios.length,
          radiosHorizontal: radioBoxes.length >= 2 && Math.abs(radioBoxes[0].y - radioBoxes[1].y) < 12,
          warning
        };
      })()
    `);
  }

  function assertTwoColumnPerformance(layout, label) {
    assert.equal(layout.missing, false, `${label}: settings columns must exist`);
    assert.strictEqual(layout.colCount, 2, `${label}: two performance columns`);
    assert.strictEqual(layout.leftCardCount, 2, `${label}: left Rate + Sleep cards`);
    assert.strictEqual(layout.rightCardCount, 3, `${label}: right WinLock + Mac + Combo cards`);
    assert.match(layout.leftTitles.join(' '), /Polling Rate/i);
    assert.match(layout.leftTitles.join(' '), /Sleep/i);
    assert.match(layout.rightTitles.join(' '), /Win Key Lock/i);
    assert.match(layout.rightTitles.join(' '), /Mac Mode/i);
    assert.match(layout.rightTitles.join(' '), /Key Combo/i);
    assert.ok(layout.hasRate && layout.hasSleep, `${label}: left Rate/Sleep`);
    assert.ok(layout.hasWin && layout.hasMac && layout.hasCombo, `${label}: right WinLock/Mac/Combo`);
    assert.ok(layout.left.r <= layout.right.x + 2, `${label}: left Rate/Sleep column must sit left of WinLock/Mac/Combo`);
    assert.ok(Math.abs(layout.left.y - layout.right.y) < 24, `${label}: columns must share a row`);
    assert.strictEqual(layout.radioCount, 4, `${label}: four supported-rate radios`);
    assert.equal(layout.radiosHorizontal, true, `${label}: polling radios must sit in a row`);
    assert.doesNotMatch(layout.warning, /reportRateWarning|16\s*kHz|32\s*kHz/i);
  }

  const layoutBounds = win.getBounds();
  win.setSize(1080, 740);
  await sleep(250);
  assertTwoColumnPerformance(await measureSettingsColumns(), '1080x740');
  win.setSize(1320, 900);
  await sleep(250);
  assertTwoColumnPerformance(await measureSettingsColumns(), '1320x900');
  win.setSize(layoutBounds.width, layoutBounds.height);
  await sleep(150);

  // 1. Assert unread guard & disabled state
  // Prior to successful read (since afterFail set hasReadSettings=false), all performance controls must be disabled
  const unreadSnap = await snapshot();
  assert.strictEqual(unreadSnap.hasReadSettings, false);
  assert.strictEqual(unreadSnap.applySettingsHidden, true);
  assert.strictEqual(unreadSnap.applySettingsDisabled, true);

  const unreadDomDisabled = await win.webContents.executeJavaScript(`
    (() => {
      return {
        polling: document.getElementById('setting-polling-rate')?.disabled,
        sleep: document.getElementById('setting-sleep-time')?.disabled,
        neverSleep: document.getElementById('setting-never-sleep')?.disabled,
        lockWin: document.getElementById('setting-lock-win')?.disabled,
        winBtn: document.getElementById('btn-mode-win')?.disabled,
        macBtn: document.getElementById('btn-mode-mac')?.disabled,
        combo: document.getElementById('setting-key-combo')?.disabled
      };
    })()
  `);
  for (const [ctrl, dis] of Object.entries(unreadDomDisabled)) {
    assert.strictEqual(dis, true, `${ctrl} must be disabled while unread`);
  }

  // Attempting to dispatch an edit event while unread must NOT manufacture hasReadSettings or stage dirty
  mock.writtenBuffers = [];
  await win.webContents.executeJavaScript(`
    (() => {
      const r = document.querySelector('input[name="setting-polling-rate"][value="2"]');
      if (r) {
        r.checked = true;
        r.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const s = document.getElementById('setting-sleep-time');
      if (s) {
        s.value = '10';
        s.dispatchEvent(new Event('input', { bubbles: true }));
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const mac = document.getElementById('btn-mode-mac');
      if (mac) mac.click();
    })()
  `);
  await sleep(100);
  const stillUnread = await snapshot();
  assert.strictEqual(stillUnread.hasReadSettings, false, 'UI event must not manufacture hasReadSettings');
  assert.strictEqual(stillUnread.settingsDraftDirty, false, 'No dirty draft when unread');
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_FUNC_CONFIG), false, 'unread edits must not HID-write');

  // 2. Successful read of settings
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="read-settings"]\')?.click()'
  );
  await sleep(800);
  const readSnap = await snapshot();
  assert.strictEqual(readSnap.hasReadSettings, true, 'read-settings must set hasReadSettings to true');
  assert.strictEqual(readSnap.applySettingsHidden, true, 'global Apply stays hidden');
  assert.strictEqual(readSnap.sleepSliderDisabled, false, 'controls enable after read');
  assert.strictEqual(readSnap.settingsDraftDirty, false);

  // 3. Ranges & intermediate minutes for sleep (1..30 min, wire units 2..60)
  // Draft on input only — no HID and no stored sleepTime rewrite
  mock.writtenBuffers = [];
  await setSleepMinutes(1, false);
  await sleep(50);
  const snap1mDraft = await snapshot();
  assert.notEqual(snap1mDraft.sleepTime, 2, 'input must not commit 1 minute');
  const val1mDraft = await win.webContents.executeJavaScript(
    'document.getElementById("setting-sleep-time-val")?.textContent'
  );
  assert.strictEqual(val1mDraft, '1 min');
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_FUNC_CONFIG), false, 'sleep input must not HID-write');

  await setSleepMinutes(1, true);
  const snap1m = await waitSettingsIdle();
  assert.strictEqual(snap1m.sleepTime, 2, '1 minute commit must write wire units 2 (2 * 30s)');
  assert.strictEqual(snap1m.settingsSaveStatus, 'saved');
  const val1mText = await win.webContents.executeJavaScript(
    'document.getElementById("setting-sleep-time-val")?.textContent'
  );
  assert.strictEqual(val1mText, '1 min');

  await setSleepMinutes(15, true);
  const snap15m = await waitSettingsIdle();
  assert.strictEqual(snap15m.sleepTime, 30, '15 minutes must write wire units 30');
  const val15mText = await win.webContents.executeJavaScript(
    'document.getElementById("setting-sleep-time-val")?.textContent'
  );
  assert.strictEqual(val15mText, '15 min');

  await setSleepMinutes(30, true);
  const snap30m = await waitSettingsIdle();
  assert.strictEqual(snap30m.sleepTime, 60, '30 minutes must write wire units 60');

  await win.webContents.executeJavaScript(`
    (() => {
      const ns = document.getElementById('setting-never-sleep');
      ns.checked = true;
      ns.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  const snapNeverOn = await waitSettingsIdle();
  assert.strictEqual(snapNeverOn.sleepMode, 1);
  assert.strictEqual(snapNeverOn.sleepTime, 60, 'Never Sleep must preserve underlying sleepTime');
  assert.strictEqual(snapNeverOn.sleepSliderDisabled, false, 'Sleep slider must stay usable when Never Sleep is on');
  assert.strictEqual(snapNeverOn.neverSleepChecked, true);
  assert.strictEqual(snapNeverOn.sleepLabel, '0 min', 'Never Sleep displays 0 min state');

  await win.webContents.executeJavaScript(`
    (() => {
      const ns = document.getElementById('setting-never-sleep');
      ns.checked = false;
      ns.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  const snapNeverOff = await waitSettingsIdle();
  assert.strictEqual(snapNeverOff.sleepMode, 0);
  assert.strictEqual(snapNeverOff.sleepTime, 60);
  assert.strictEqual(snapNeverOff.sleepSliderDisabled, false);
  assert.strictEqual(snapNeverOff.neverSleepChecked, false);
  assert.strictEqual(snapNeverOff.sleepLabel, '30 min');

  // 4. Raw nonstandard sleep & debounce preservation without silent rewrite
  // Seed mock memory for profile 1 with raw nonstandard sleepTime = 5 (150s) and debounceLevel = 2
  mock.func[64 + 35] = 5; // nonstandard sleep (5 * 30s)
  mock.func[64 + 7] = (mock.func[64 + 7] & 0x1F) | (2 << 5); // debounceLevel = 2
  mock.func[64 + 4] = (mock.func[64 + 4] & 0xF0) | 3; // reporteRate = 3 (2000 Hz)
  mock.func[64 + 36] = 0; // sleepMode = 0
  mock.func[64 + 6] = (mock.func[64 + 6] & 0xFE) | 0; // lockWin = 0
  mock.func[64 + 1] = (mock.func[64 + 1] & 0xF0) | (1 * 4 + 0); // profile 1, win mode

  // Read fresh from device
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="read-settings"]\')?.click()'
  );
  await sleep(800);
  const rawReadSnap = await snapshot();
  assert.strictEqual(rawReadSnap.sleepTime, 5, 'raw nonstandard sleepTime 5 must remain unchanged');
  assert.strictEqual(rawReadSnap.sleepLabel, '2.5 min', 'raw sleepTime 5 must display 2.5 min, not a rounded 3 min');
  assert.strictEqual(rawReadSnap.debounceLevel, 2, 'raw debounceLevel 2 must remain unchanged');
  assert.strictEqual(rawReadSnap.keyComboEnabled, true, 'key combo reads enabled (>=1)');
  assert.strictEqual(rawReadSnap.reporteRate, 3);
  assert.strictEqual(rawReadSnap.settingsDraftDirty, false, 'rendering must not mark dirty');
  const raw5Thumb = await win.webContents.executeJavaScript(
    'document.getElementById("setting-sleep-time")?.value'
  );
  assert.strictEqual(raw5Thumb, '3', 'slider thumb may clamp while stored sleepTime stays 5');
  mock.writtenBuffers = [];
  await setSleepMinutes(3, true);
  const restatedRaw5 = await waitSettingsIdle();
  assert.strictEqual(restatedRaw5.sleepTime, 5, 'restating the clamped thumb must not round sleepTime 5 to 6');
  assert.strictEqual(restatedRaw5.settingsDraftDirty, false, 'clamped-thumb restatement must not mark dirty');
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_FUNC_CONFIG), false, 'clamped restatement must not HID-write');

  // Key combo toggle OFF -> writes 0
  mock.writtenBuffers = [];
  await win.webContents.executeJavaScript(`
    (() => {
      const c = document.getElementById('setting-key-combo');
      c.checked = false;
      c.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  const comboOffSnap = await waitSettingsIdle();
  assert.strictEqual(comboOffSnap.debounceLevel, 0, 'toggling combo off writes debounceLevel 0');
  assert.strictEqual(comboOffSnap.keyComboEnabled, false);
  assert.strictEqual(comboOffSnap.sleepTime, 5, 'unrelated sleepTime 5 remains preserved');
  assert.strictEqual((mock.func[64 + 7] >> 5) & 7, 0, 'combo off HID-writes debounce 0');
  assert.strictEqual(mock.func[64 + 35], 5, 'combo write must not rewrite sleepTime 5');

  await win.webContents.executeJavaScript(`
    (() => {
      const c = document.getElementById('setting-key-combo');
      c.checked = true;
      c.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  const comboOnSnap = await waitSettingsIdle();
  assert.strictEqual(comboOnSnap.debounceLevel, 7, 'toggling combo on writes debounceLevel 7');
  assert.strictEqual(comboOnSnap.keyComboEnabled, true);

  // 5. Mac Mode clears Win Lock & disables Win Lock control
  // Stage Win Lock = true in Windows mode first
  assert.strictEqual(comboOnSnap.macMode & 3, 0, 'must be in Windows mode');
  assert.strictEqual(comboOnSnap.winLockDisabled, false);
  await win.webContents.executeJavaScript(`
    (() => {
      const w = document.getElementById('setting-lock-win');
      w.checked = true;
      w.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  const winLockedSnap = await waitSettingsIdle();
  assert.strictEqual(winLockedSnap.lockWin, true);
  assert.strictEqual(mock.func[64 + 6] & 1, 1, 'Win lock autosave writes bit 0');

  await win.webContents.executeJavaScript(
    'document.getElementById("btn-mode-mac")?.click()'
  );
  const macSnap = await waitSettingsIdle();
  assert.strictEqual(macSnap.macMode & 3, 2, 'switching to Mac writes macMode = 2');
  assert.strictEqual(macSnap.lockWin, false, 'switching to Mac must clear lockWin');
  assert.strictEqual(macSnap.winLockDisabled, true, 'Win Lock control must be disabled in Mac mode');
  assert.strictEqual(mock.func[64 + 6] & 1, 0, 'Mac mode must HID-clear Win lock');

  const macHintText = await win.webContents.executeJavaScript(
    'document.getElementById("setting-lock-win-hint")?.textContent'
  );
  assert.match(macHintText, /Mac mode is enabled/i, 'hint must display translation 890');

  // Attempting to toggle Win Lock in Mac mode is rejected
  await win.webContents.executeJavaScript(`
    (() => {
      const w = document.getElementById('setting-lock-win');
      w.checked = true;
      w.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await sleep(50);
  const stillMacSnap = await snapshot();
  assert.strictEqual(stillMacSnap.lockWin, false, 'Win Lock cannot be enabled while in Mac mode');

  // Switch back to Windows Mode -> re-enables Win Lock control, lockWin remains false
  await win.webContents.executeJavaScript(
    'document.getElementById("btn-mode-win")?.click()'
  );
  const winAgainSnap = await waitSettingsIdle();
  assert.strictEqual(winAgainSnap.macMode & 3, 0, 'switching to Win writes Windows mode');
  assert.strictEqual(winAgainSnap.winLockDisabled, false, 'Win Lock re-enabled in Win mode');
  assert.strictEqual(winAgainSnap.lockWin, false, 'lockWin remains false');

  // Individual autosaves already wrote; unrelated bytes stay on the wire
  const afterApplySnap = await snapshot();
  assert.strictEqual(afterApplySnap.hasReadSettings, true);
  assert.strictEqual(afterApplySnap.settingsDraftDirty, false);
  assert.strictEqual(afterApplySnap.applySettingsHidden, true);

  assert.strictEqual(mock.func[64 + 35], 5, 'mock memory byte 35 preserved');
  assert.strictEqual((mock.func[64 + 7] >> 5) & 7, 7, 'mock memory debounceLevel is 7');
  assert.strictEqual(mock.func[64 + 4] & 0x0F, 3, 'mock memory reporteRate is 3');
  assert.strictEqual(mock.func[64 + 6] & 1, 0, 'mock memory lockWin is 0');

  // 6b. Raw 30 s (sleepTime 1) is labeled accurately and not silently rounded to 1 min
  mock.func[64 + 35] = 1;
  mock.func[64 + 36] = 0;
  mock.func[64 + 4] = (mock.func[64 + 4] & 0xF0) | 3;
  mock.func[64 + 7] = (mock.func[64 + 7] & 0x1F) | (7 << 5);
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="read-settings"]\')?.click()'
  );
  await sleep(800);
  const raw30s = await snapshot();
  assert.strictEqual(raw30s.sleepTime, 1, 'raw sleepTime 1 (30 s) must remain 1');
  assert.strictEqual(raw30s.sleepLabel, '30 s', 'raw 30 s must not be labeled 1 min');
  assert.strictEqual(raw30s.settingsDraftDirty, false);
  const raw30sThumb = await win.webContents.executeJavaScript(
    'document.getElementById("setting-sleep-time")?.value'
  );
  assert.strictEqual(raw30sThumb, '1', 'slider thumb may clamp to 1 min for a 30 s value');
  mock.writtenBuffers = [];
  await setSleepMinutes(1, true);
  const restated30s = await waitSettingsIdle();
  assert.strictEqual(restated30s.sleepTime, 1, 'restating the 1 min thumb must not rewrite 30 s to 1 min');
  assert.strictEqual(restated30s.settingsDraftDirty, false);
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_FUNC_CONFIG), false, '30 s restatement must not HID-write');
  await win.webContents.executeJavaScript(`
    (() => {
      const c = document.getElementById('setting-key-combo');
      c.checked = false;
      c.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await waitSettingsIdle();
  assert.strictEqual((await snapshot()).sleepTime, 1, 'combo toggle must preserve raw 30 s');
  assert.strictEqual(mock.func[64 + 35], 1, 'combo autosave must keep sleepTime 1');
  assert.strictEqual((mock.func[64 + 7] >> 5) & 7, 0, 'combo off writes debounce 0');
  assert.strictEqual(mock.func[64 + 4] & 0x0F, 3, 'combo autosave must keep reporteRate 3');

  // 6c. Unknown polling nibble stays visible, is not shown as 1 kHz, and is omitted from Apply
  mock.func[64 + 4] = (mock.func[64 + 4] & 0xF0) | 5;
  mock.func[64 + 35] = 1;
  mock.func[64 + 7] = (mock.func[64 + 7] & 0x1F) | (2 << 5);
  mock.func[64 + 36] = 0;
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="read-settings"]\')?.click()'
  );
  await sleep(800);
  const unknownRateSnap = await snapshot();
  assert.strictEqual(unknownRateSnap.reporteRate, 5, 'unknown rate nibble must not normalize to 1 kHz (4)');
  assert.match(unknownRateSnap.pollingSelectedText, /Unknown \(5\)/);
  assert.match(unknownRateSnap.pollingHint, /unrecognized polling rate.*preserved/i);
  assert.doesNotMatch(unknownRateSnap.pollingHint, /16\s*kHz|32\s*kHz|reportRateWarning/i);
  assert.strictEqual(unknownRateSnap.sleepTime, 1);
  assert.strictEqual(unknownRateSnap.keyComboEnabled, true, 'debounce 2 still shows combo on');
  mock.writtenBuffers = [];
  await win.webContents.executeJavaScript(`
    (() => {
      const c = document.getElementById('setting-key-combo');
      c.checked = false;
      c.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  const afterUnknownApply = await waitSettingsIdle();
  assert.strictEqual(afterUnknownApply.hasReadSettings, true, 'other-field autosave must succeed while rate is unknown');
  assert.strictEqual(mock.func[64 + 4] & 0x0F, 5, 'unknown rate nibble must be preserved on combo autosave');
  assert.strictEqual(mock.func[64 + 35], 1, 'sleepTime 1 preserved beside unknown rate');
  assert.strictEqual((mock.func[64 + 7] >> 5) & 7, 0, 'explicit combo off writes 0 beside unknown rate');
  await setPollingRate(4);
  const switchedRate = await waitSettingsIdle();
  assert.strictEqual(switchedRate.reporteRate, 4, 'choosing 1 kHz must write reporteRate 4');
  assert.strictEqual(mock.func[64 + 4] & 0x0F, 4, 'supported rate autosave writes 1 kHz nibble');
  assert.strictEqual(mock.func[64 + 35], 1, 'rate switch must not rewrite sleepTime 1');

  // 6d. Slider change while Never Sleep is on resumes timed sleep (setSleepTime → sleepMode 0)
  mock.func[64 + 35] = 6;
  mock.func[64 + 36] = 1;
  mock.func[64 + 4] = (mock.func[64 + 4] & 0xF0) | 4;
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="read-settings"]\')?.click()'
  );
  await sleep(800);
  const neverSleepRead = await snapshot();
  assert.strictEqual(neverSleepRead.sleepMode, 1);
  assert.strictEqual(neverSleepRead.sleepTime, 6, 'Never Sleep read preserves raw sleepTime');
  assert.strictEqual(neverSleepRead.sleepSliderDisabled, false);
  assert.strictEqual(neverSleepRead.neverSleepChecked, true);
  assert.strictEqual(neverSleepRead.sleepLabel, '0 min');
  mock.writtenBuffers = [];
  await setSleepMinutes(4, false);
  await sleep(50);
  const resumedDraft = await snapshot();
  assert.strictEqual(resumedDraft.sleepMode, 1, 'sleep input must not clear Never Sleep until commit');
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_FUNC_CONFIG), false, 'sleep draft must not HID-write');
  await setSleepMinutes(4, true);
  const resumedSleep = await waitSettingsIdle();
  assert.strictEqual(resumedSleep.sleepMode, 0, 'slider commit must write sleepMode 0');
  assert.strictEqual(resumedSleep.neverSleepChecked, false, 'slider commit must uncheck Never Sleep');
  assert.strictEqual(resumedSleep.sleepTime, 8, 'slider 4 min writes wire units 8');
  assert.strictEqual(resumedSleep.sleepLabel, '4 min');
  assert.strictEqual(mock.func[64 + 36], 0, 'setSleepTime HID-writes sleepMode 0');
  assert.strictEqual(mock.func[64 + 35], 8);

  // 7. Failed autosave keeps dirty drafts; failed read still clears provenance
  mock.failCommands.add(protocol.COMMANDS.SET_FUNC_CONFIG);
  await setPollingRate(2);
  const afterUncertainApply = await waitSettingsIdle();
  mock.failCommands.delete(protocol.COMMANDS.SET_FUNC_CONFIG);
  assert.strictEqual(afterUncertainApply.hasReadSettings, true, 'failed autosave keeps a readable editor');
  assert.strictEqual(afterUncertainApply.settingsSaveStatus, 'error', 'failed autosave reports error');
  assert.strictEqual(afterUncertainApply.settingsDraftDirty, true, 'failed autosave keeps dirty fields');
  assert.strictEqual(afterUncertainApply.sleepSliderDisabled, false, 'failed autosave must not disable controls');
  assert.strictEqual(afterUncertainApply.reporteRate, 2, 'dirty rate draft remains 4 kHz');

  await win.webContents.executeJavaScript(`
    document.getElementById("edit-profile-select").value = "0";
    document.getElementById("btn-load-edit-target").click();
  `);
  await sleep(200);
  const blockedSwitch = await snapshot();
  assert.strictEqual(blockedSwitch.editingProfile, 1, 'failed dirty settings must refuse profile Load');
  assert.strictEqual(blockedSwitch.settingsDraftDirty, true);
  assert.strictEqual(blockedSwitch.reporteRate, 2);

  // Failed read must also clear hasReadSettings
  mock.failCommands.add(protocol.COMMANDS.GET_FUNC_CONFIG);
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="read-settings"]\')?.click()'
  );
  await sleep(900);
  mock.failCommands.delete(protocol.COMMANDS.GET_FUNC_CONFIG);
  const afterFailedRead = await snapshot();
  assert.strictEqual(afterFailedRead.hasReadSettings, false, 'failed read must clear hasReadSettings');
  assert.strictEqual(afterFailedRead.applySettingsDisabled, true);
  assert.strictEqual(afterFailedRead.sleepSliderDisabled, true, 'failed read must disable settings controls');

  // Recover by successful read
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="read-settings"]\')?.click()'
  );
  await sleep(800);
  assert.strictEqual((await snapshot()).hasReadSettings, true);
  assert.strictEqual((await snapshot()).settingsDraftDirty, false);

  // Serialized overlapping field saves: rate then combo, both land, other bytes stay
  mock.writtenBuffers = [];
  await setPollingRate(1);
  await win.webContents.executeJavaScript(`
    (() => {
      const c = document.getElementById('setting-key-combo');
      c.checked = true;
      c.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  const overlapped = await waitSettingsIdle();
  assert.strictEqual(overlapped.reporteRate, 1);
  assert.strictEqual(overlapped.debounceLevel, 7);
  assert.strictEqual(mock.func[64 + 4] & 0x0F, 1, 'overlapping rate save must land 8 kHz');
  assert.strictEqual((mock.func[64 + 7] >> 5) & 7, 7, 'overlapping combo save must land 7');
  const overlappedWrites = mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_FUNC_CONFIG);
  assert.ok(overlappedWrites.length >= 2, 'each field save is its own FUNC write');

  // Failed field A then unrelated successful B: error/retry stay with A; status is not sticky saving
  mock.failCommands.add(protocol.COMMANDS.SET_FUNC_CONFIG);
  await setPollingRate(2);
  const failedRate = await waitSettingsIdle();
  mock.failCommands.delete(protocol.COMMANDS.SET_FUNC_CONFIG);
  assert.strictEqual(failedRate.settingsSaveStatus, 'error', 'failed rate save reports error');
  assert.strictEqual(failedRate.settingsDraftDirty, true);
  assert.strictEqual(failedRate.reporteRate, 2);
  assert.strictEqual(failedRate.settingsRetryHidden, false, 'Retry is visible after the failed rate save');
  assert.ok(failedRate.settingsFieldErrors.reporteRate, 'rate owns the failure');
  await setSleepMinutes(5, true);
  const afterUnrelatedOk = await waitSettingsIdle();
  assert.strictEqual(afterUnrelatedOk.sleepTime, 10, 'unrelated sleep save must land');
  assert.strictEqual(afterUnrelatedOk.reporteRate, 2, 'failed rate draft remains');
  assert.strictEqual(afterUnrelatedOk.settingsDraftDirty, true);
  assert.strictEqual(afterUnrelatedOk.settingsSaveStatus, 'error', 'unrelated success must not hide the failed rate');
  assert.notStrictEqual(afterUnrelatedOk.settingsSaveStatus, 'saving', 'idle leftover dirty must not remain Saving…');
  assert.strictEqual(afterUnrelatedOk.settingsSavePending, 0);
  assert.strictEqual(afterUnrelatedOk.settingsRetryHidden, false, 'Retry stays visible for the failed rate');
  assert.ok(afterUnrelatedOk.settingsFieldErrors.reporteRate, 'rate error survives unrelated sleep success');
  assert.equal(afterUnrelatedOk.settingsFieldErrors.sleepTime, undefined, 'successful sleep must not keep a sleep error');
  await win.webContents.executeJavaScript(
    'document.getElementById("btn-retry-settings-save")?.click()'
  );
  const afterRateRetry = await waitSettingsIdle();
  assert.strictEqual(afterRateRetry.settingsSaveStatus, 'saved');
  assert.strictEqual(afterRateRetry.settingsDraftDirty, false);
  assert.strictEqual(afterRateRetry.reporteRate, 2);
  assert.strictEqual(mock.func[64 + 4] & 0x0F, 2);
  assert.strictEqual(afterRateRetry.settingsRetryHidden, true);

  // Stale skipped save: same-turn rate A then B; only B is written
  mock.writtenBuffers = [];
  await win.webContents.executeJavaScript(`
    (() => {
      const a = document.querySelector('input[name="setting-polling-rate"][value="4"]');
      const b = document.querySelector('input[name="setting-polling-rate"][value="1"]');
      if (a) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); }
      if (b) { b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); }
      return true;
    })()
  `);
  const staleRate = await waitSettingsIdle();
  assert.strictEqual(staleRate.reporteRate, 1, 'last same-turn rate must win');
  assert.strictEqual(mock.func[64 + 4] & 0x0F, 1);
  assert.strictEqual(staleRate.settingsSaveStatus, 'saved');
  assert.strictEqual(staleRate.settingsDraftDirty, false);
  const staleRateWrites = mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_FUNC_CONFIG);
  assert.ok(staleRateWrites.length >= 1, 'superseding rate still HID-writes');
  assert.ok(staleRateWrites.length <= 2, 'stale first rate should not both land as two lasting values');

  // Stale skip of sleep must not clear an unrelated failed rate
  mock.failCommands.add(protocol.COMMANDS.SET_FUNC_CONFIG);
  await setPollingRate(3);
  const failedRateAgain = await waitSettingsIdle();
  mock.failCommands.delete(protocol.COMMANDS.SET_FUNC_CONFIG);
  assert.strictEqual(failedRateAgain.settingsSaveStatus, 'error');
  await win.webContents.executeJavaScript(`
    (() => {
      const s = document.getElementById('setting-sleep-time');
      s.value = '6';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
      s.value = '12';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  const staleSkipKeepsError = await waitSettingsIdle();
  assert.strictEqual(staleSkipKeepsError.sleepTime, 24, 'last same-turn sleep commit must win');
  assert.strictEqual(staleSkipKeepsError.reporteRate, 3, 'failed rate remains');
  assert.strictEqual(staleSkipKeepsError.settingsSaveStatus, 'error');
  assert.strictEqual(staleSkipKeepsError.settingsRetryHidden, false);
  assert.ok(staleSkipKeepsError.settingsFieldErrors.reporteRate);
  await win.webContents.executeJavaScript(
    'document.getElementById("btn-retry-settings-save")?.click()'
  );
  const recoveredRate = await waitSettingsIdle();
  assert.strictEqual(recoveredRate.settingsSaveStatus, 'saved');
  assert.strictEqual(recoveredRate.reporteRate, 3);
  assert.strictEqual(mock.func[64 + 4] & 0x0F, 3);

  // Coupled Mac+WinLock: last user action wins; unsent paired fields are not treated as persisted
  await win.webContents.executeJavaScript(`
    (() => {
      const w = document.getElementById('setting-lock-win');
      w.checked = true;
      w.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('btn-mode-mac')?.click();
      document.getElementById('btn-mode-win')?.click();
      return true;
    })()
  `);
  const coupledMac = await waitSettingsIdle();
  assert.strictEqual(coupledMac.macMode & 3, 0, 'last OS-mode click is Windows');
  assert.strictEqual(coupledMac.lockWin, false, 'Mac-enable still cleared Win lock; Win click does not restore it');
  assert.strictEqual(coupledMac.winLockDisabled, false);
  assert.strictEqual(mock.func[64 + 6] & 1, 0);
  assert.strictEqual(coupledMac.settingsSaveStatus, 'saved');
  assert.strictEqual(coupledMac.settingsDraftDirty, false);

  // Coupled sleep commit + Never Sleep: last action owns sleepMode; sleepTime from the slider lands
  await win.webContents.executeJavaScript(`
    (() => {
      const s = document.getElementById('setting-sleep-time');
      s.value = '7';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
      const ns = document.getElementById('setting-never-sleep');
      ns.checked = true;
      ns.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  const coupledSleep = await waitSettingsIdle();
  assert.strictEqual(coupledSleep.sleepTime, 14, 'slider commit duration must land');
  assert.strictEqual(coupledSleep.sleepMode, 1, 'Never Sleep after the slider owns sleepMode');
  assert.strictEqual(coupledSleep.neverSleepChecked, true);
  assert.strictEqual(coupledSleep.sleepLabel, '0 min');
  assert.strictEqual(mock.func[64 + 35], 14);
  assert.strictEqual(mock.func[64 + 36], 1);
  assert.strictEqual(coupledSleep.settingsSaveStatus, 'saved');
  assert.strictEqual(coupledSleep.settingsDraftDirty, false);

  // Delayed read must not wipe a newer edit or its revisions
  mock.func[64 + 35] = 6;
  mock.func[64 + 36] = 0;
  mock.delayOnceCommands.set(protocol.COMMANDS.GET_FUNC_CONFIG, 500);
  const getsBeforeDelayedRead = mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.GET_FUNC_CONFIG).length;
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="read-settings"]\')?.click()'
  );
  let sawDelayedReadGet = false;
  for (let i = 0; i < 40; i++) {
    if (mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.GET_FUNC_CONFIG).length > getsBeforeDelayedRead) {
      sawDelayedReadGet = true;
      break;
    }
    await sleep(25);
  }
  assert.equal(sawDelayedReadGet, true, 'delayed read must dispatch GET_FUNC_CONFIG');
  await setSleepMinutes(20, true);
  const duringDelayedRead = await snapshot();
  assert.strictEqual(duringDelayedRead.sleepTime, 40, 'edit during delayed read must stage 20 min');
  assert.ok(duringDelayedRead.settingsFieldRevs.sleepTime > 0, 'newer sleep rev must exist before the read returns');
  const afterDelayedRead = await waitSettingsIdle();
  assert.strictEqual(afterDelayedRead.sleepTime, 40, 'delayed read must not restore device sleepTime 6 over the newer draft');
  assert.notStrictEqual(afterDelayedRead.sleepTime, 6);
  assert.strictEqual(afterDelayedRead.hasReadSettings, true);
  assert.strictEqual(afterDelayedRead.settingsSaveStatus, 'saved');
  assert.strictEqual(mock.func[64 + 35], 40, 'queued sleep save after delayed read must land');

  // Delayed failed read must keep a newer valid draft and leave controls enabled
  mock.delayOnceCommands.set(protocol.COMMANDS.GET_FUNC_CONFIG, 500);
  mock.failCommands.add(protocol.COMMANDS.GET_FUNC_CONFIG);
  const getsBeforeFailedRead = mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.GET_FUNC_CONFIG).length;
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="read-settings"]\')?.click()'
  );
  let sawFailedReadGet = false;
  for (let i = 0; i < 40; i++) {
    if (mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.GET_FUNC_CONFIG).length > getsBeforeFailedRead) {
      sawFailedReadGet = true;
      break;
    }
    await sleep(25);
  }
  assert.equal(sawFailedReadGet, true, 'failed delayed read must dispatch GET_FUNC_CONFIG');
  await setPollingRate(4);
  mock.failCommands.delete(protocol.COMMANDS.GET_FUNC_CONFIG);
  const afterFailedDelayedRead = await waitSettingsIdle();
  assert.strictEqual(afterFailedDelayedRead.hasReadSettings, true, 'newer draft must keep provenance after a failed delayed read');
  assert.strictEqual(afterFailedDelayedRead.reporteRate, 4);
  assert.strictEqual(afterFailedDelayedRead.sleepSliderDisabled, false);
  assert.strictEqual(afterFailedDelayedRead.canEditSettings, true);
  assert.strictEqual(mock.func[64 + 4] & 0x0F, 4, 'rate save queued behind the failed read must still land');

  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="read-settings"]\')?.click()'
  );
  await sleep(800);
  assert.strictEqual((await snapshot()).hasReadSettings, true);
  assert.strictEqual((await snapshot()).settingsDraftDirty, false);

  // Local preview: settings edits persist with zero HID
  mock.writtenBuffers = [];
  let copiedLocalForPreview = false;
  await win.webContents.executeJavaScript(`
    (() => {
      const card = document.querySelector('#local-profile-list .profile-card [data-action="load-local-preview"]');
      if (card) card.click();
    })()
  `);
  let previewSettings = await waitUntil((s) => s.localPreview === true, 40, 50);
  if (!previewSettings.localPreview) {
    const localsBeforeCopy = ((await snapshot()).localKeys || []).length;
    await win.webContents.executeJavaScript(
      'document.querySelector("#onboard-profile-list [data-action=\\"copy-onboard-local\\"]")?.click()'
    );
    await waitUntil((s) => ((s.localKeys || []).length > localsBeforeCopy), 80, 50);
    copiedLocalForPreview = true;
    await win.webContents.executeJavaScript(
      'document.querySelector("#local-profile-list .profile-card [data-action=\\"load-local-preview\\"]")?.click()'
    );
    previewSettings = await waitUntil((s) => s.localPreview === true, 40, 50);
  }
  if (previewSettings.localPreview) {
    mock.writtenBuffers = [];
    await win.webContents.executeJavaScript(
      'document.querySelector(\'[data-action="set-tab"][data-tab="settings"]\')?.click()'
    );
    await sleep(80);
    const localStart = await snapshot();
    const localTarget = localStart.reporteRate === 1 ? 2 : 1;
    const prevTick = localStart.localPreviewSettings && localStart.localPreviewSettings.tickRate;
    await setPollingRate(localTarget);
    const localSaved = await waitSettingsIdle();
    assert.strictEqual(localSaved.reporteRate, localTarget);
    assert.strictEqual(localSaved.settingsSaveStatus, 'saved');
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_FUNC_CONFIG), false, 'local preview settings must not HID-write');
    assert.ok(localSaved.localPreviewSettings, 'local snapshot must include settings');
    assert.strictEqual(localSaved.localPreviewSettings.reporteRate, localTarget);
    if (prevTick !== undefined && prevTick !== null) {
      assert.strictEqual(localSaved.localPreviewSettings.tickRate, prevTick, 'local persist must keep unedited protocol bytes');
    }
    const localKey = localSaved.editSourceKey;
    await win.webContents.executeJavaScript(`
      document.getElementById("edit-profile-select").value = "1";
      document.getElementById("btn-load-edit-target").click();
    `);
    const afterLocalDrain = await waitUntil((s) => s.editingProfile === 1 && s.localPreview !== true && s.hasReadSettings, 80, 50);
    assert.strictEqual(afterLocalDrain.localPreview, false, 'clean local settings must allow profile Load');
    if (localKey) {
      mock.writtenBuffers = [];
      await win.webContents.executeJavaScript(`
        (() => {
          const card = document.querySelector('#local-profile-list .profile-card[data-key="${localKey}"] [data-action="load-local-preview"]')
            || document.querySelector('#local-profile-list .profile-card [data-action="load-local-preview"]');
          if (card) card.click();
          return Boolean(card);
        })()
      `);
      const reloaded = await waitUntil((s) => s.localPreview === true && s.reporteRate === localTarget, 80, 50);
      assert.strictEqual(reloaded.localPreview, true);
      assert.strictEqual(reloaded.reporteRate, localTarget, 'reloaded local preview must keep the saved rate');
      assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_FUNC_CONFIG), false, 'reloading local preview must not HID-write');
      await win.webContents.executeJavaScript(`
        document.getElementById("edit-profile-select").value = "1";
        document.getElementById("btn-load-edit-target").click();
      `);
      await waitUntil((s) => s.editingProfile === 1 && s.localPreview !== true && s.hasReadSettings, 80, 50);
    }
    if (copiedLocalForPreview && localKey) {
      await win.webContents.executeJavaScript(`
        document.querySelector('#local-profile-list .profile-card[data-key="${localKey}"] [data-action="delete-local-profile"]')?.click()
      `);
      await waitUntil((s) => !(s.localKeys || []).includes(localKey), 40, 50);
    }
  }

  // 8. Target races: delayed read on profile 0 must not overwrite profile 1
  mock.delayCommands.set(protocol.COMMANDS.GET_FUNC_CONFIG, 200);
  await win.webContents.executeJavaScript(`
    document.getElementById("edit-profile-select").value = "0";
    document.getElementById("btn-load-edit-target").click();
  `);
  await sleep(80);
  await win.webContents.executeJavaScript(`
    document.getElementById("edit-profile-select").value = "1";
    document.getElementById("btn-load-edit-target").click();
  `);
  await sleep(2200);
  mock.delayCommands.delete(protocol.COMMANDS.GET_FUNC_CONFIG);
  const afterSettingsRace = await snapshot();
  assert.strictEqual(afterSettingsRace.editingProfile, 1);
  assert.strictEqual(afterSettingsRace.macMode & 3, 0, 'stale profile-0 macMode must not overwrite profile 1');
  assert.notStrictEqual(afterSettingsRace.macMode & 3, 2, 'stale profile-0 macMode 2 must not leak into profile 1');
  assert.strictEqual(afterSettingsRace.hasReadSettings, true);

  // Factory reset: cancel/Escape send no CMD 238; confirm uses hardware-active profile, not edit target.
  await win.webContents.executeJavaScript(`
    document.getElementById('edit-profile-select').value = '2';
    document.getElementById('btn-load-edit-target').click();
  `);
  await sleep(800);
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="set-tab"][data-tab="others"]\')?.click()'
  );
  await sleep(150);
  const othersVisible = await win.webContents.executeJavaScript(
    '!document.getElementById("panel-others")?.hidden'
  );
  assert.strictEqual(othersVisible, true, 'Others panel must open');

  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-reset-active")?.click()');
  await sleep(600);
  const resetOpen = await snapshot();
  assert.strictEqual(resetOpen.resetDialogHidden, false, 'reset dialog must open');
  assert.match(resetOpen.resetDialogTitle || '', /Profile 1/);
  assert.match(resetOpen.resetDialogBody || '', /Profile 1/);
  assert.match(resetOpen.resetDialogBody || '', /editing Profile 3/i);
  assert.doesNotMatch(resetOpen.resetDialogBody || '', /wire scope|ACK|238/i);
  assert.match(resetOpen.resetDialogExportNote || '', /not .*whole keyboard|not an all-device backup|rather than a full-device backup/i);
  assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.FACTORY_RESET), false, 'opening review must not send 238');

  await win.webContents.executeJavaScript('document.getElementById("btn-reset-cancel")?.click()');
  await sleep(200);
  const afterCancel = await snapshot();
  assert.strictEqual(afterCancel.resetDialogHidden, true, 'cancel must hide dialog');
  assert.strictEqual(afterCancel.activeElementId, 'btn-reset-active', 'cancel must restore focus to the opener');
  assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.FACTORY_RESET), false, 'cancel must not send 238');

  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-reset-active")?.click()');
  await sleep(600);
  await win.webContents.executeJavaScript(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  `);
  await sleep(150);
  const afterEscape = await snapshot();
  assert.strictEqual(afterEscape.resetDialogHidden, true, 'Escape before dispatch must close the dialog');
  assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.FACTORY_RESET), false, 'Escape must not send 238');

  await win.webContents.executeJavaScript(`
    document.getElementById('edit-profile-select').value = '0';
    document.getElementById('btn-load-edit-target').click();
  `);
  await sleep(800);
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-reset-active")?.click()');
  await sleep(600);
  const sameTarget = await snapshot();
  assert.strictEqual(sameTarget.resetDialogHidden, false);
  assert.match(sameTarget.resetDialogBody || '', /Profile 1/);
  assert.doesNotMatch(sameTarget.resetDialogBody || '', /not the profile currently selected for editing/i);
  assert.doesNotMatch(sameTarget.resetDialogBody || '', /You are editing/i);
  assert.doesNotMatch(sameTarget.resetDialogBody || '', /wire scope|ACK|238/i);
  await win.webContents.executeJavaScript('document.getElementById("btn-reset-cancel")?.click()');
  await sleep(150);

  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-reset-active")?.click()');
  await sleep(600);
  const origActiveSlot = mock.base[0];
  mock.base[0] = origActiveSlot === 0 ? 1 : 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-reset-confirm")?.click()');
  await sleep(700);
  assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.FACTORY_RESET), false, 'changed active while dialog open must not send 238');
  const afterStaleActive = await snapshot();
  assert.strictEqual(afterStaleActive.resetDialogHidden, true);
  mock.base[0] = origActiveSlot;

  await win.webContents.executeJavaScript(`
    document.getElementById('edit-profile-select').value = '2';
    document.getElementById('btn-load-edit-target').click();
  `);
  await sleep(800);
  mock.writtenBuffers.length = 0;
  mock.delayCommands.set(protocol.COMMANDS.FACTORY_RESET, 350);
  await win.webContents.executeJavaScript('document.getElementById("btn-reset-active")?.click()');
  await sleep(600);
  await win.webContents.executeJavaScript(`
    document.getElementById('btn-reset-confirm')?.click();
    document.getElementById('btn-reset-confirm')?.click();
  `);
  await sleep(80);
  const busySnap = await snapshot();
  assert.strictEqual(busySnap.resetDialogHidden, false, 'dialog stays open while commit runs');
  assert.strictEqual(busySnap.resetConfirmDisabled, true);
  assert.strictEqual(busySnap.resetCancelDisabled, true);
  assert.strictEqual(busySnap.resetExportDisabled, true);
  assert.strictEqual(busySnap.resetActiveDisabled, true);
  assert.strictEqual(busySnap.resetAllDisabled, true);
  await win.webContents.executeJavaScript(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  `);
  await sleep(50);
  assert.strictEqual((await snapshot()).resetDialogHidden, false, 'Escape during commit must not close');
  await sleep(700);
  mock.delayCommands.delete(protocol.COMMANDS.FACTORY_RESET);
  const activePkts = mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.FACTORY_RESET);
  assert.strictEqual(activePkts.length, 1, 'double confirm must send one reset packet');
  assert.strictEqual(activePkts[0][9], 0, 'active reset must use hardware-active index 0, not editing profile 2');
  const afterActiveReset = await snapshot();
  assert.strictEqual(afterActiveReset.resetDialogHidden, true);
  assert.strictEqual(afterActiveReset.hasReadSettings, false, 'confirmed reset must invalidate settings drafts');
  assert.strictEqual(afterActiveReset.hasReadLighting, false);
  assert.strictEqual(afterActiveReset.hasReadMacros, false);
  assert.strictEqual(afterActiveReset.hasReadKeyColors, false);
  assert.strictEqual(afterActiveReset.hasAdvancedRead, false);
  assert.strictEqual(afterActiveReset.applySettingsDisabled, true);
  assert.strictEqual(afterActiveReset.applyLightingDisabled, true);
  assert.strictEqual(afterActiveReset.applyKeymapDisabled, true);
  assert.strictEqual(afterActiveReset.applyMacrosDisabled, true);
  await assertLightingSyntheticRejected('synthetic tile click after confirmed reset must not stage');

  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-reset-all")?.click()');
  await sleep(600);
  const allOpen = await snapshot();
  assert.match(allOpen.resetDialogTitle || '', /all onboard profiles/i);
  assert.match(allOpen.resetDialogBody || '', /every onboard profile|all onboard profiles/i);
  assert.doesNotMatch(allOpen.resetDialogBody || '', /wire scope|ACK|238/i);
  assert.doesNotMatch(allOpen.resetDialogBody || '', /which is not the reset target|You are editing/i);
  await win.webContents.executeJavaScript('document.getElementById("btn-reset-export")?.click()');
  await sleep(700);
  const afterExport = await snapshot();
  assert.strictEqual(afterExport.resetDialogHidden, false, 'export must leave the review open');
  assert.strictEqual(afterExport.resetConfirmDisabled, false, 'export success must leave confirm usable');
  await win.webContents.executeJavaScript('document.getElementById("btn-reset-confirm")?.click()');
  await sleep(900);
  const allPkt = mock.writtenBuffers.find((b) => b[2] === protocol.COMMANDS.FACTORY_RESET);
  assert.ok(allPkt, 'confirming all-profile reset must send CMD 238');
  assert.strictEqual(allPkt[9], 255);

  await win.webContents.executeJavaScript(`
    document.getElementById('edit-profile-select').value = '0';
    document.getElementById('btn-load-edit-target').click();
  `);
  await sleep(900);
  const loadedEditors = await snapshot();
  assert.strictEqual(loadedEditors.hasReadSettings, true);
  assert.strictEqual(loadedEditors.hasReadLighting, true);
  assert.strictEqual(loadedEditors.hasReadMacros, true);
  assert.strictEqual(loadedEditors.hasReadKeyColors, true);
  assert.strictEqual(loadedEditors.hasAdvancedRead, true);

  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(`
    window.__maicongHarness.rejectNextCommitFactoryReset = true;
    document.getElementById('btn-reset-active')?.click();
  `);
  await sleep(600);
  await win.webContents.executeJavaScript('document.getElementById("btn-reset-confirm")?.click()');
  await sleep(400);
  const afterRejectedIpc = await snapshot();
  assert.strictEqual(afterRejectedIpc.resetDialogHidden, true);
  assert.strictEqual(afterRejectedIpc.hasReadSettings, false, 'rejected commit IPC must invalidate settings');
  assert.strictEqual(afterRejectedIpc.hasReadLighting, false);
  assert.strictEqual(afterRejectedIpc.applySettingsDisabled, true);
  assert.strictEqual(afterRejectedIpc.applyLightingDisabled, true);
  assert.doesNotMatch(afterRejectedIpc.toast || '', /did not run/i);
  assert.match(afterRejectedIpc.toast || '', /unconfirmed/i);
  assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.FACTORY_RESET), false);

  await waitLightingIdle();
  await win.webContents.executeJavaScript(`
    document.getElementById('edit-profile-select').value = '0';
    document.getElementById('btn-load-edit-target').click();
  `);
  let reloaded = null;
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    reloaded = await snapshot();
    if (reloaded.hasReadSettings) break;
  }
  assert.strictEqual(reloaded && reloaded.hasReadSettings, true, 'reload after rejected commit IPC must restore a fresh settings read');

  mock.func[9] = 100;
  mock.func[64 + 9] = 40;
  mock.func[128 + 9] = 77;
  await win.webContents.executeJavaScript(`
    window.__maicongHarness.resetLoadGuards();
    document.querySelector('[data-action="set-tab"][data-tab="lighting"]')?.click();
  `);
  mock.writtenBuffers.length = 0;
  mock.delayCommands.set(protocol.COMMANDS.SET_FUNC_CONFIG, 1400);
  await win.webContents.executeJavaScript(`
    (() => {
      const s = document.getElementById('light-brightness-slider');
      s.value = '19';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(140);
  const delayedPending = await snapshot();
  assert.strictEqual(delayedPending.lightingSaveWorkerBusy, true, 'delayed save must still be in the worker before Load');
  assert.strictEqual(delayedPending.lightingBrightness, 19);
  const setsProfile1Before = countCommandOffset(protocol.COMMANDS.SET_FUNC_CONFIG, 64);
  const loadStartedAt = Date.now();
  await clickLoadProfile(1);
  const afterDelayedLoad = await waitUntil(
    (s) => s.editingProfile === 1 && s.hasReadLighting && !s.loadInFlight && !s.lightingSaveWorkerBusy
  );
  assert.ok(
    Date.now() - loadStartedAt >= 2500,
    'Load must wait for a worker busy longer than the old 2500ms silent timeout'
  );
  mock.delayCommands.delete(protocol.COMMANDS.SET_FUNC_CONFIG);
  assert.strictEqual(afterDelayedLoad.editingProfile, 1, 'Load after >2500ms save must reach the selected profile');
  assert.strictEqual(
    mock.func[64 + 9],
    40,
    `profile 1 device brightness must stay 40 (got p1=${mock.func[64 + 9]} p0=${mock.func[9]} active=${afterDelayedLoad.activeProfile} startedBusy=${afterDelayedLoad.loadStartedWhileWorkerBusy})`
  );
  const funcOffsets = mock.writtenBuffers
    .filter((b) => b[2] === protocol.COMMANDS.GET_FUNC_CONFIG)
    .map((b) => b[6] | (b[7] << 8));
  assert.ok(
    funcOffsets.includes(64),
    `Load profile 1 must GET_FUNC at offset 64 (offsets=${funcOffsets.join(',')})`
  );
  assert.strictEqual(afterDelayedLoad.lightingBrightness, 40, 'Load must not keep the in-flight profile 0 draft or a silent-timeout race');
  assert.notStrictEqual(afterDelayedLoad.lightingBrightness, 19);
  assert.strictEqual(afterDelayedLoad.hasReadLighting, true);
  assert.strictEqual(afterDelayedLoad.canEditLighting, true);
  assert.strictEqual(afterDelayedLoad.lightingTileDisabled, false, 'final controls must be enabled after drain-then-load');
  assert.strictEqual(afterDelayedLoad.loadStartedWhileWorkerBusy, false, 'profile reads must not start while the lighting worker is still busy');
  assert.strictEqual(afterDelayedLoad.loadInFlight, false);
  assert.strictEqual(
    countCommandOffset(protocol.COMMANDS.SET_FUNC_CONFIG, 64),
    setsProfile1Before,
    'in-flight old-profile write must not retry or write the new Load profile'
  );

  await win.webContents.executeJavaScript('window.__maicongHarness.resetLoadGuards()');
  mock.delayCommands.set(protocol.COMMANDS.GET_FUNC_CONFIG, 400);
  await clickLoadProfile(0);
  await clickLoadProfile(2);
  const afterRapidLoad = await waitUntil(
    (s) => s.editingProfile === 2 && s.hasReadLighting && !s.loadInFlight && s.loadReadActive === 0
  );
  mock.delayCommands.delete(protocol.COMMANDS.GET_FUNC_CONFIG);
  assert.strictEqual(afterRapidLoad.editingProfile, 2, 'rapid repeated Load must keep the last selected profile');
  assert.strictEqual(afterRapidLoad.lightingBrightness, 77, 'superseded Load reads must not apply a stale profile');
  assert.strictEqual(afterRapidLoad.loadReadOverlap, false, 'rapid Load clicks must not overlap profile read sets');
  assert.strictEqual(afterRapidLoad.hasReadLighting, true);
  assert.strictEqual(afterRapidLoad.canEditLighting, true);
  assert.strictEqual(afterRapidLoad.lightingTileDisabled, false);
  assert.strictEqual(afterRapidLoad.loadInFlight, false);

  mock.delayCommands.set(protocol.COMMANDS.GET_FUNC_CONFIG, 400);
  await clickLoadProfile(1);
  await sleep(80);
  assert.strictEqual((await snapshot()).loadInFlight, true, 'Load must still be in flight when reset arrives');
  await win.webContents.executeJavaScript('window.__maicongHarness.invalidateEditors("test-reset")');
  const afterResetDuringLoad = await waitUntil((s) => !s.loadInFlight, 40, 50);
  mock.delayCommands.delete(protocol.COMMANDS.GET_FUNC_CONFIG);
  assert.strictEqual(afterResetDuringLoad.loadInFlight, false, 'reset must cancel an in-flight Load');
  assert.strictEqual(afterResetDuringLoad.hasReadLighting, false, 'reset must not leave a completed Load provenance');
  assert.strictEqual(afterResetDuringLoad.canEditLighting, false);
  await sleep(500);
  const staleAfterResetLoad = await snapshot();
  assert.strictEqual(staleAfterResetLoad.hasReadLighting, false, 'stale Load reads must not restore editors after reset');
  assert.strictEqual(staleAfterResetLoad.loadInFlight, false);

  mock.func[9] = 100;
  await clickLoadProfile(0);
  const loadedBeforeDisconnect = await waitUntil(
    (s) => s.editingProfile === 0 && s.hasReadLighting && !s.loadInFlight
  );
  assert.strictEqual(loadedBeforeDisconnect.hasReadLighting, true);
  mock.delayCommands.set(protocol.COMMANDS.GET_FUNC_CONFIG, 400);
  await clickLoadProfile(2);
  await sleep(80);
  assert.strictEqual((await snapshot()).loadInFlight, true, 'Load must still be in flight when disconnect arrives');
  await win.webContents.executeJavaScript('window.__maicongHarness.setDeviceConnected(false)');
  const afterDisconnectDuringLoad = await waitUntil((s) => !s.loadInFlight, 40, 50);
  mock.delayCommands.delete(protocol.COMMANDS.GET_FUNC_CONFIG);
  assert.strictEqual(afterDisconnectDuringLoad.loadInFlight, false, 'disconnect must cancel an in-flight Load');
  assert.strictEqual(afterDisconnectDuringLoad.hasReadLighting, false);
  assert.strictEqual(afterDisconnectDuringLoad.canEditLighting, false);
  await sleep(500);
  const staleAfterDisconnectLoad = await snapshot();
  assert.strictEqual(staleAfterDisconnectLoad.hasReadLighting, false, 'stale Load reads must not restore editors after disconnect');
  assert.strictEqual(staleAfterDisconnectLoad.loadInFlight, false);
  assert.strictEqual(staleAfterDisconnectLoad.canEditLighting, false);

  await win.webContents.executeJavaScript('window.__maicongHarness.setDeviceConnected(true)');
  await clickLoadProfile(0);
  const restoredAfterSerial = await waitUntil(
    (s) => s.editingProfile === 0 && s.hasReadLighting && !s.loadInFlight && s.canEditLighting
  );
  assert.strictEqual(restoredAfterSerial.hasReadLighting, true, 'Load must restore editors after serialization tests');
  assert.strictEqual(restoredAfterSerial.lightingTileDisabled, false);

  fs.mkdirSync(path.join(__dirname, '..', 'test-artifacts'), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, 'fixtures', 'official-keyboard-profile-v3.json'),
    path.join(__dirname, '..', 'test-artifacts', 'mock-ui-official-import.json')
  );

  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-create-local-profile")?.click()');
  await sleep(80);
  const nameOpen = await snapshot();
  assert.equal(nameOpen.profileNameDialogHidden, false);
  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.getElementById('profile-name-input');
      input.value = 'MockLocal';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btn-profile-name-confirm')?.click();
    })()
  `);
  const afterCreate = await waitUntil((s) => (s.localTitles || []).includes('MockLocal'), 40, 50);
  assert.ok((afterCreate.localTitles || []).includes('MockLocal'), 'create local must show in sidebar');
  assert.equal(mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_BASE).length, 0, 'create local must not SET_BASE');
  assert.equal(mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_FUNC_CONFIG).length, 0, 'create local must not write func');

  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(`
    (() => {
      const card = Array.from(document.querySelectorAll('#local-profile-list .profile-card'))
        .find((el) => el.querySelector('.profile-title')?.textContent.trim() === 'MockLocal');
      card?.querySelector('[data-action="rename-profile"]')?.click();
    })()
  `);
  await sleep(80);
  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.getElementById('profile-name-input');
      input.value = 'RenamedLoc';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btn-profile-name-confirm')?.click();
    })()
  `);
  const afterRename = await waitUntil((s) => (s.localTitles || []).includes('RenamedLoc'), 40, 50);
  assert.ok((afterRename.localTitles || []).includes('RenamedLoc'));
  assert.equal(mock.writtenBuffers.length, 0, 'rename local must not write HID');

  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(`
    (() => {
      const card = Array.from(document.querySelectorAll('#local-profile-list .profile-card'))
        .find((el) => el.querySelector('.profile-title')?.textContent.trim() === 'RenamedLoc');
      card?.querySelector('[data-action="load-local-preview"]')?.click();
    })()
  `);
  const previewSnap = await waitUntil((s) => s.localPreview === true, 40, 50);
  assert.equal(previewSnap.localPreview, true);
  assert.equal(previewSnap.editSourceKind, 'local');
  assert.equal(mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_BASE).length, 0, 'local preview must not SET_BASE');
  assert.equal(mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_FUNC_CONFIG).length, 0, 'local preview must not write lighting');

  const keysBefore = (previewSnap.localKeys || []).slice();
  if (keysBefore.length >= 1) {
    await win.webContents.executeJavaScript(`
      window.maicongApi.reorderProfiles(${JSON.stringify(keysBefore.slice().reverse())})
    `);
    await sleep(200);
  }

  mock.writtenBuffers.length = 0;
  const titlesBeforeCopy = ((await snapshot()).localTitles || []).length;
  await win.webContents.executeJavaScript(`
    document.querySelector('[data-action="copy-onboard-local"][data-profile="0"]')?.click()
  `);
  const afterCopy = await waitUntil((s) => (s.localTitles || []).length >= titlesBeforeCopy + 1, 80, 50);
  assert.ok((afterCopy.localTitles || []).length >= titlesBeforeCopy + 1, 'copy onboard must add a custom item');
  assert.equal(mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_FUNC_CONFIG).length, 0, 'copy onboard is a local copy');

  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-import-official-profile")?.click()');
  const afterImport = await waitUntil((s) => (s.localTitles || []).includes('Office'), 40, 50);
  assert.ok((afterImport.localTitles || []).includes('Office'), 'official import must create a local Office item');
  assert.equal(mock.writtenBuffers.length, 0, 'official import must write no HID');

  await win.webContents.executeJavaScript(`
    (() => {
      const card = Array.from(document.querySelectorAll('#local-profile-list .profile-card'))
        .find((el) => el.querySelector('.profile-title')?.textContent.trim() === 'Office');
      card?.querySelector('[data-action="export-official-profile"]')?.click();
    })()
  `);
  await sleep(400);
  assert.ok(
    fs.existsSync(path.join(__dirname, '..', 'test-artifacts', 'mock-ui-official-export.json')),
    'official export JSON must be written'
  );

  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript(`
    (() => {
      const card = Array.from(document.querySelectorAll('#local-profile-list .profile-card'))
        .find((el) => el.querySelector('.profile-title')?.textContent.trim() === 'RenamedLoc');
      card?.querySelector('[data-action="move-local-onboard"]')?.click();
    })()
  `);
  const afterActivate = await waitUntil((s) => (s.onboardTitles || []).some((t) => t.includes('RenamedLoc')), 50, 80);
  assert.ok((afterActivate.onboardTitles || []).some((t) => t.includes('RenamedLoc')), 'activation must show the name onboard');
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_CUSTOM_PARAM) || mock.wroteCommand(protocol.COMMANDS.SET_FUNC_CONFIG) || mock.wroteCommand(protocol.COMMANDS.SET_BASE));

  await win.webContents.executeJavaScript(`
    document.querySelector('[data-action="set-tab"][data-tab="lighting"]')?.click();
    document.getElementById('btn-custom-lighting')?.click();
  `);
  await sleep(200);
  const gifAfterProfiles = await snapshot();
  assert.equal(gifAfterProfiles.cloudTabPresent, false);
  assert.equal(gifAfterProfiles.gifImportDisabled, false, 'GIF import must remain available after profile library flows');
  assert.ok(gifAfterProfiles.gifSectionHidden === false || gifAfterProfiles.mainLightTab === 'local');

  await clickLoadProfile(0);
  const restoredForReset = await waitUntil(
    (s) => s.editingProfile === 0 && s.hasReadLighting && !s.loadInFlight && s.canEditLighting && s.localPreview !== true,
    80,
    50
  );
  assert.strictEqual(restoredForReset.hasReadLighting, true, 'Load must restore hardware editing after profile library flows');

  console.log('[MockUI] key-config: read layer');
  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelector('[data-action="set-tab"][data-tab="keymap"]')?.click();
      document.querySelector('[data-action="set-layer"][data-layer="0"]')?.click();
    })()
  `);
  await sleep(120);
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="read-layer"]\')?.click()');
  const keymapReady = await waitUntil((s) => s.hasReadKeymap && s.hasReadKeymap[0] && !s.loadInFlight, 80, 50);
  assert.equal(keymapReady.hasReadKeymap[0], true);

  mock.writtenBuffers.length = 0;
  console.log('[MockUI] key-config: drop');
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('k_a')?.click();
    })()
  `);
  await sleep(80);
  await kickOp('window.__maicongHarness.dropKeycodeOnSlot(11, { type: 32, code1: 1, code2: 0, label: "Left Mouse Button" })');
  const afterDrop = await waitUntil(
    (s) => s.keymapSavePending === 0 && Array.isArray(s.layer0Slot11) && s.layer0Slot11[0] === 32,
    80,
    50
  );
  const dropOp = await waitOpDone();
  assert.equal(dropOp.res && dropOp.res.success, true, dropOp.res && dropOp.res.error);
  assert.deepEqual(afterDrop.layer0Slot11, [32, 1, 0]);
  assert.equal(afterDrop.localPreview, false, 'drop target must be onboard');
  assert.equal(afterDrop.keymapSavePending, 0);
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), `onboard drop must auto-save CMD 9 (status=${afterDrop.keymapSaveStatus} err=${afterDrop.keymapSaveError} preview=${afterDrop.localPreview})`);

  console.log('[MockUI] key-config: overlapping delayed saves');
  mock.writtenBuffers.length = 0;
  mock.delayCommands.set(protocol.COMMANDS.SET_USER_KEY_MATRIX, 300);
  await kickRenderer(`
    (() => {
      window.__kcOp = { done: false, res: null };
      const a = window.__maicongHarness.dropKeycodeOnSlot(11, { type: 32, code1: 1, code2: 0, label: "Left Mouse Button" });
      const b = window.__maicongHarness.dropKeycodeOnSlot(19, { type: 33, code1: 0, code2: 1, label: "Wheel Up" });
      Promise.all([a, b]).then((res) => { window.__kcOp = { done: true, res }; }).catch((err) => {
        window.__kcOp = { done: true, res: { success: false, error: String(err && err.message || err) } };
      });
      return true;
    })()
  `);
  const afterOverlap = await waitUntil(
    (s) => s.keymapSavePending === 0 && Array.isArray(s.layer0Slot11) && s.layer0Slot11[0] === 32 && Array.isArray(s.layer0Slot19) && s.layer0Slot19[0] === 33,
    80,
    50
  );
  mock.delayCommands.delete(protocol.COMMANDS.SET_USER_KEY_MATRIX);
  const overlapOp = await waitOpDone();
  const overlap = overlapOp.res;
  assert.equal(overlap && overlap[0] && overlap[0].success, true, overlap && overlap[0] && overlap[0].error);
  assert.equal(overlap && overlap[1] && overlap[1].success, true, overlap && overlap[1] && overlap[1].error);
  assert.equal(countCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), 2, 'serialized overlapping saves must both complete CMD 9');
  assert.deepEqual(afterOverlap.layer0Slot11, [32, 1, 0]);
  assert.deepEqual(afterOverlap.layer0Slot19, [33, 0, 1]);
  assert.equal(afterOverlap.keymapSavePending, 0);

  console.log('[MockUI] key-config: delayed A success must not clobber B on same slot');
  mock.writtenBuffers.length = 0;
  mock.delayOnceCommands.set(protocol.COMMANDS.SET_USER_KEY_MATRIX, 400);
  await kickRenderer(`
    (() => {
      window.__kcOpA = { done: false, res: null };
      Promise.resolve(window.__maicongHarness.dropKeycodeOnSlot(11, { type: 32, code1: 1, code2: 0, label: "Left Mouse Button" }))
        .then((res) => { window.__kcOpA = { done: true, res }; })
        .catch((err) => { window.__kcOpA = { done: true, res: { success: false, error: String(err && err.message || err) } }; });
      return true;
    })()
  `);
  let sawFirstKeyWrite = false;
  for (let i = 0; i < 80; i++) {
    if (mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX)) {
      sawFirstKeyWrite = true;
      break;
    }
    await sleep(20);
  }
  assert.equal(sawFirstKeyWrite, true);
  await kickRenderer(`
    (() => {
      window.__kcOpB = { done: false, res: null };
      Promise.resolve(window.__maicongHarness.dropKeycodeOnSlot(11, { type: 33, code1: 0, code2: 1, label: "Wheel Up" }))
        .then((res) => { window.__kcOpB = { done: true, res }; })
        .catch((err) => { window.__kcOpB = { done: true, res: { success: false, error: String(err && err.message || err) } }; });
      return true;
    })()
  `);
  const stagedB = await snapshot();
  assert.deepEqual(stagedB.layer0Slot11, [33, 0, 1], 'B must be visible while A is still in flight');
  assert.ok(stagedB.keymapSavePending >= 1);
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="read-layer"]\')?.click()');
  const afterReadDuringB = await waitUntil(
    (s) => Array.isArray(s.layer0Slot11) && s.layer0Slot11[0] === 33 && s.hasReadKeymap && s.hasReadKeymap[0],
    80,
    50
  );
  assert.deepEqual(afterReadDuringB.layer0Slot11, [33, 0, 1], 'full layer read must not clobber newer dirty draft B');
  mock.failCommands.add(protocol.COMMANDS.SET_USER_KEY_MATRIX);
  let saveA = { done: false, res: null };
  for (let i = 0; i < 80; i++) {
    saveA = await win.webContents.executeJavaScript('window.__kcOpA || { done: false, res: null }');
    if (saveA.done) break;
    await sleep(50);
  }
  assert.equal(saveA.res && saveA.res.success, true, saveA.res && saveA.res.error);
  const afterA = await snapshot();
  assert.deepEqual(afterA.layer0Slot11, [33, 0, 1], 'A ACK must not overwrite newer same-slot draft B');
  let saveB = { done: false, res: null };
  for (let i = 0; i < 80; i++) {
    saveB = await win.webContents.executeJavaScript('window.__kcOpB || { done: false, res: null }');
    if (saveB.done) break;
    await sleep(50);
  }
  mock.failCommands.delete(protocol.COMMANDS.SET_USER_KEY_MATRIX);
  assert.equal(saveB.res && saveB.res.success, false, 'B save must fail as injected');
  const afterBFail = await snapshot();
  assert.deepEqual(afterBFail.layer0Slot11, [33, 0, 1], 'failed B must keep draft B, not restore A');
  assert.equal(afterBFail.keymapDirty, true, 'failed B must remain dirty');
  assert.equal(afterBFail.keymapSaveStatus, 'error');
  mock.writtenBuffers.length = 0;
  await kickOp('window.__maicongHarness.dropKeycodeOnSlot(11, { type: 32, code1: 1, code2: 0, label: "Left Mouse Button" })');
  const recoveredSlot = await waitUntil(
    (s) => s.keymapSavePending === 0 && Array.isArray(s.layer0Slot11) && s.layer0Slot11[0] === 32 && s.keymapDirty === false,
    80,
    50
  );
  assert.deepEqual(recoveredSlot.layer0Slot11, [32, 1, 0]);
  assert.equal(recoveredSlot.keymapDirty, false);

  console.log('[MockUI] key-config: profile switch drains pending save');
  mock.writtenBuffers.length = 0;
  mock.delayCommands.set(protocol.COMMANDS.SET_USER_KEY_MATRIX, 400);
  await kickRenderer(`
    (() => {
      window.__kcOp = { done: false, res: null };
      (async () => {
        const save = window.__maicongHarness.dropKeycodeOnSlot(11, { type: 48, code1: 226, code2: 0, label: "Left Alt" });
        await new Promise((resolve) => setTimeout(resolve, 80));
        const pending = window.__maicongEditorSnapshot().keymapSavePending;
        const load = window.__maicongHarness.loadOnboardProfile(1);
        const [saveRes, loadRes] = await Promise.all([save, load]);
        window.__kcOp = { done: true, res: { pending, saveRes, loadRes } };
      })().catch((err) => {
        window.__kcOp = { done: true, res: { pending: 0, saveRes: { success: false, error: String(err && err.message || err) } } };
      });
      return true;
    })()
  `);
  const afterSwitch = await waitUntil(
    (s) => s.editingProfile === 1 && s.hasReadLighting && !s.loadInFlight && s.canEditLighting,
    80,
    50
  );
  mock.delayCommands.delete(protocol.COMMANDS.SET_USER_KEY_MATRIX);
  const switchedOp = await waitOpDone();
  const keySwitched = switchedOp.res || {};
  assert.ok(keySwitched.pending >= 1, 'delayed save must still be pending when Load starts');
  assert.equal(keySwitched.saveRes && keySwitched.saveRes.success, true, keySwitched.saveRes && keySwitched.saveRes.error);
  assert.equal(afterSwitch.editingProfile, 1);
  assert.equal(afterSwitch.keymapDirty, false);
  await kickOp('window.__maicongHarness.loadOnboardProfile(0)');
  const backAfterSwitch = await waitUntil(
    (s) => s.editingProfile === 0 && s.hasReadKeymap && s.hasReadKeymap[0] && !s.loadInFlight,
    80,
    50
  );
  await waitOpDone();
  assert.equal(backAfterSwitch.editingProfile, 0);
  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelector('[data-action="set-tab"][data-tab="keymap"]')?.click();
      document.querySelector('[data-action="set-layer"][data-layer="0"]')?.click();
    })()
  `);

  console.log('[MockUI] key-config: failed save retains dirty and blocks profile switch');
  mock.failCommands.add(protocol.COMMANDS.SET_USER_KEY_MATRIX);
  await kickOp('window.__maicongHarness.dropKeycodeOnSlot(11, { type: 32, code1: 1, code2: 0, label: "Left Mouse Button" })');
  const failSnap = await waitUntil((s) => s.keymapSavePending === 0 && s.keymapSaveStatus === 'error', 80, 50);
  const failOp = await waitOpDone();
  assert.equal(failOp.res && failOp.res.success, false);
  assert.equal(failSnap.keymapDirty, true);
  assert.equal(failSnap.keymapSaveStatus, 'error');
  assert.equal(failSnap.editingProfile, 0);
  await kickOp('window.__maicongHarness.loadOnboardProfile(1)');
  const blockedOp = await waitOpDone();
  assert.equal(blockedOp.res && blockedOp.res.blocked, true);
  const stillOnFailed = await snapshot();
  assert.equal(stillOnFailed.editingProfile, 0);
  assert.equal(stillOnFailed.keymapDirty, true);
  mock.failCommands.delete(protocol.COMMANDS.SET_USER_KEY_MATRIX);
  await kickOp('window.__maicongHarness.dropKeycodeOnSlot(11, { type: 32, code1: 1, code2: 0, label: "Left Mouse Button" })');
  const afterRetry = await waitUntil((s) => s.keymapSavePending === 0 && s.keymapSaveStatus === 'saved', 80, 50);
  const retryOp = await waitOpDone();
  assert.equal(retryOp.res && retryOp.res.success, true, retryOp.res && retryOp.res.error);
  assert.equal(afterRetry.keymapDirty, false);
  assert.equal(afterRetry.keymapSaveStatus, 'saved');

  console.log('[MockUI] key-config: copy/paste');
  await win.webContents.executeJavaScript('window.__maicongHarness.copySelectedKey()');
  await sleep(40);
  await win.webContents.executeJavaScript('document.getElementById("k_s")?.click()');
  await sleep(40);
  mock.writtenBuffers.length = 0;
  await kickOp('window.__maicongHarness.pasteSelectedKey()');
  const afterPaste = await waitUntil(
    (s) => s.keymapSavePending === 0 && Array.isArray(s.layer0Slot19) && s.layer0Slot19[0] === 32,
    80,
    50
  );
  const pasteOp = await waitOpDone();
  assert.equal(pasteOp.res && pasteOp.res.success, true, pasteOp.res && pasteOp.res.error);
  assert.deepEqual(afterPaste.layer0Slot19, [32, 1, 0]);
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), 'paste must auto-save');

  const malformed = await win.webContents.executeJavaScript(`
    window.__maicongHarness.setKeyClipboard({ v: 9, kind: "nope", binding: { type: 16 } })
  `);
  assert.equal(malformed, false);
  mock.writtenBuffers.length = 0;
  await kickOp('window.__maicongHarness.pasteSelectedKey()');
  const malformedOp = await waitOpDone();
  assert.equal(malformedOp.res && malformedOp.res.success, false);
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false, 'malformed clipboard must not write');

  const missingSource = await win.webContents.executeJavaScript(`
    window.__maicongHarness.setKeyClipboard({
      v: 1,
      kind: "g75-key-binding",
      binding: { type: 146, code1: 2, code2: 15 },
      tableBytes: [16, 0, 4, 16, 1, 0]
    })
  `);
  assert.equal(missingSource, false);
  mock.writtenBuffers.length = 0;
  await kickOp('window.__maicongHarness.pasteSelectedKey()');
  const missingSourceOp = await waitOpDone();
  assert.equal(missingSourceOp.res && missingSourceOp.res.success, false);
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false, 'missing clipboard source must not write');

  console.log('[MockUI] key-config: stale macro and MT clipboard');
  const macroBody = await win.webContents.executeJavaScript(`
    (() => {
      window.__maicongHarness.fillSlotActions(0, 2);
      return window.MaicongMacroDraft.getNormalizedBodyKey(window.__maicongHarness.getActions(0));
    })()
  `);
  assert.ok(macroBody);
  const staleMacroSet = await win.webContents.executeJavaScript(`
    window.__maicongHarness.setKeyClipboard({
      v: 1,
      kind: "g75-key-binding",
      binding: { type: 112, code1: 0, code2: 0 },
      source: { kind: "onboard", profileIndex: 0 },
      macro: { playbackType: 0, bodyKey: ${JSON.stringify(macroBody)} }
    })
  `);
  assert.equal(staleMacroSet, true);
  await win.webContents.executeJavaScript('window.__maicongHarness.fillSlotActions(0, 9)');
  mock.writtenBuffers.length = 0;
  await kickOp('window.__maicongHarness.pasteSelectedKey()');
  const staleMacroOp = await waitOpDone();
  assert.equal(staleMacroOp.res && staleMacroOp.res.success, false);
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false, 'stale macro clipboard must not write');
  const afterStaleMacro = await snapshot();
  assert.notEqual(afterStaleMacro.layer0Slot19 && afterStaleMacro.layer0Slot19[0], 112);

  const staleMtSet = await win.webContents.executeJavaScript(`
    window.__maicongHarness.setKeyClipboard({
      v: 1,
      kind: "g75-key-binding",
      binding: { type: 146, code1: 3, code2: 15 },
      source: { kind: "onboard", profileIndex: 0 },
      tableBytes: [9, 9, 9, 9, 9, 9]
    })
  `);
  assert.equal(staleMtSet, true);
  mock.writtenBuffers.length = 0;
  await kickOp('window.__maicongHarness.pasteSelectedKey()');
  const staleMtOp = await waitOpDone();
  assert.equal(staleMtOp.res && staleMtOp.res.success, false);
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false, 'stale MT clipboard must not write');

  console.log('[MockUI] key-config: queued macro bank replacement');
  const queuedOrig = [
    { action: 'keydown', code: 4, delay: 20 },
    { action: 'keyup', code: 4, delay: 20 }
  ];
  const queuedOther = [
    { action: 'keydown', code: 7, delay: 20 },
    { action: 'keyup', code: 7, delay: 20 }
  ];
  const queuedBody = protocol.getNormalizedBodyKey(queuedOrig);
  assert.ok(queuedBody);
  const seedMacros = await transport.applyMacros([{ id: 0, type: 0, actions: queuedOrig }]);
  assert.equal(seedMacros.success, true, seedMacros.error);
  const queuedClip = await win.webContents.executeJavaScript(`
    (() => {
      window.__maicongHarness.setSlotActions(0, ${JSON.stringify(queuedOrig)});
      window.__maicongHarness.setSlotPlayback(0, 0);
      const bodyKey = window.MaicongMacroDraft.getNormalizedBodyKey(window.__maicongHarness.getActions(0));
      return window.__maicongHarness.setKeyClipboard({
        v: 1,
        kind: "g75-key-binding",
        binding: { type: 112, code1: 0, code2: 0 },
        source: { kind: "onboard", profileIndex: 0 },
        macro: { playbackType: 0, bodyKey }
      });
    })()
  `);
  assert.equal(queuedClip, true);
  const rendererMacros = await win.webContents.executeJavaScript('window.__maicongHarness.macroIdentities()');
  await win.webContents.executeJavaScript('document.getElementById("k_s")?.click()');
  mock.writtenBuffers.length = 0;
  mock.delayOnceCommands.set(protocol.COMMANDS.SET_MACROS, 800);
  const queuedMacroP = transport.applyMacros([
    { id: 0, type: 1, actions: queuedOther },
    { id: 1, type: 0, actions: queuedOrig }
  ]);
  let sawMacroWrite = false;
  for (let i = 0; i < 80; i++) {
    if (mock.wroteCommand(protocol.COMMANDS.SET_MACROS)) {
      sawMacroWrite = true;
      break;
    }
    await sleep(20);
  }
  assert.equal(sawMacroWrite, true, 'queued bank replacement must start SET_MACROS before paste');
  await kickOp('window.__maicongHarness.pasteSelectedKey()');
  const inflightSnap = await snapshot();
  assert.ok(
    inflightSnap.keymapSavePending >= 1,
    `paste must be queued while the first SET_MACROS packet is still in flight (pending=${inflightSnap.keymapSavePending} rendererMacros=${JSON.stringify(rendererMacros)})`
  );
  const queuedMacroRes = await queuedMacroP;
  assert.equal(queuedMacroRes.success, true, queuedMacroRes.error);
  const queuedPaste = await waitUntil(
    (s) => s.keymapSavePending === 0 && s.keymapSaveStatus !== 'saving',
    80,
    50
  );
  const queuedPasteOp = await waitOpDone();
  const afterQueued = await snapshot();
  assert.equal(
    queuedPasteOp.res && queuedPasteOp.res.success,
    true,
    `stage=${queuedPasteOp.res && queuedPasteOp.res.rejectStage} err=${queuedPasteOp.res && queuedPasteOp.res.error} want=${JSON.stringify(queuedPasteOp.res && queuedPasteOp.res.want)} have=${JSON.stringify(queuedPasteOp.res && queuedPasteOp.res.have)} renderer=${JSON.stringify(rendererMacros)} planned=${JSON.stringify(queuedPasteOp.res && queuedPasteOp.res.planned)}`
  );
  assert.deepEqual(
    afterQueued.layer0Slot19,
    [112, 1, 0],
    `queued bank replacement must migrate to matching body+playback, not reuse index 0 planned=${JSON.stringify(queuedPasteOp.res && queuedPasteOp.res.planned)} renderer=${JSON.stringify(rendererMacros)}`
  );
  assert.equal(queuedPaste.keymapSavePending, 0);

  await win.webContents.executeJavaScript('document.getElementById("k_a")?.click()');
  await sleep(40);
  mock.writtenBuffers.length = 0;
  await kickOp('window.__maicongHarness.cutSelectedKey()');
  const afterCut = await waitUntil(
    (s) => s.keymapSavePending === 0 && Array.isArray(s.layer0Slot11) && s.layer0Slot11[0] === 16 && s.layer0Slot11[2] === 4,
    80,
    50
  );
  const cutOp = await waitOpDone();
  assert.equal(cutOp.res && cutOp.res.success, true, cutOp.res && cutOp.res.error);
  assert.deepEqual(afterCut.layer0Slot11, [16, 0, 4]);
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), 'cut restores default with a write');

  console.log('[MockUI] key-config: recorder');
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('key-record-capture')?.focus();
      document.querySelector('[data-action="toggle-key-record"]')?.click();
    })()
  `);
  const recOn = await waitUntil((s) => s.keyRecorderActive === true, 20, 40);
  assert.equal(recOn.keyRecorderActive, true);
  assert.equal(recOn.keyRecorderLabel, '112');
  await win.webContents.executeJavaScript(`
    (() => {
      const box = document.getElementById('key-record-capture');
      box.focus();
      const down = new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', bubbles: true, cancelable: true });
      box.dispatchEvent(down);
      const a = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true });
      box.dispatchEvent(a);
    })()
  `);
  const recChord = await waitUntil((s) => Array.isArray(s.layer0Slot11) && s.layer0Slot11[0] === 16 && s.layer0Slot11[1] === 1, 40, 50);
  assert.deepEqual(recChord.layer0Slot11, [16, 1, 4]);
  assert.equal(recChord.keyRecorderActive, false);
  assert.equal(recChord.keyRecorderLabel, '113');
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="toggle-key-record"]\')?.click()');
  const recResume = await waitUntil((s) => s.keyRecorderActive === true, 20, 40);
  assert.equal(recResume.keyRecorderLabel, '112');
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="toggle-key-record"]\')?.click()');
  const recPaused = await waitUntil((s) => s.keyRecorderActive === false, 20, 40);
  assert.equal(recPaused.keyRecorderLabel, '113');

  console.log('[MockUI] key-config: restore defaults');
  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-restore-defaults")?.click()');
  await sleep(80);
  await win.webContents.executeJavaScript('document.getElementById("btn-keymap-reset-confirm")?.click()');
  const afterRestore = await waitUntil((s) => Array.isArray(s.layer0Slot11) && s.layer0Slot11[2] === 4 && s.keymapResetDialogHidden !== false, 40, 50);
  assert.deepEqual(afterRestore.layer0Slot11, [16, 0, 4]);
  assert.equal(afterRestore.keymapResetDialogHidden, true);

  console.log('[MockUI] key-config: local preview');
  await win.webContents.executeJavaScript(`
    (() => {
      const card = document.querySelector('#local-profile-list .profile-card [data-action="load-local-preview"]');
      if (card) card.click();
      else document.querySelector('[data-action="copy-onboard-local"]')?.click();
    })()
  `);
  await sleep(200);
  let keyPreviewSnap = await snapshot();
  if (!keyPreviewSnap.localPreview) {
    await win.webContents.executeJavaScript(`
      document.querySelector('#onboard-profile-list [data-action="copy-onboard-local"]')?.click()
    `);
    await sleep(250);
    await win.webContents.executeJavaScript(`
      document.querySelector('#local-profile-list .profile-card [data-action="load-local-preview"]')?.click()
    `);
    keyPreviewSnap = await waitUntil((s) => s.localPreview === true, 40, 50);
  }
  assert.equal(keyPreviewSnap.localPreview, true, 'custom preview must be active');

  console.log('[MockUI] advanced: queued local MT definitions use distinct shared entries');
  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelector('[data-action="set-tab"][data-tab="advanced"]')?.click();
      document.getElementById('adv-type-mt')?.click();
      return true;
    })()
  `);
  await sleep(80);
  mock.writtenBuffers.length = 0;
  await kickRenderer(`
    (() => {
      const setValue = (id, value) => {
        const el = document.getElementById(id);
        if (!el) throw new Error(id + ' missing');
        el.value = String(value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const choose = (slot, tap, hold) => {
        document.getElementById('adv-type-mt')?.click();
        setValue('adv-key-select', slot);
        setValue('adv-tap-select', tap);
        setValue('adv-hold-select', hold);
        setValue('adv-delay', 150);
      };
      window.__maicongHarness.delayAdvancedLocalMs = 250;
      window.__advQueue = {
        a: { done: false, res: null },
        b: { done: false, res: null }
      };
      choose(11, '16,0,4', '16,1,0');
      const a = window.__maicongHarness.applyAdvanced();
      choose(19, '16,0,5', '16,2,0');
      const b = window.__maicongHarness.applyAdvanced();
      Promise.resolve(a).then((res) => { window.__advQueue.a = { done: true, res }; }).catch((err) => {
        window.__advQueue.a = { done: true, res: { success: false, error: String(err && err.message || err) } };
      });
      Promise.resolve(b).then((res) => { window.__advQueue.b = { done: true, res }; }).catch((err) => {
        window.__advQueue.b = { done: true, res: { success: false, error: String(err && err.message || err) } };
      });
      return true;
    })()
  `);
  // The delay is read when each worker starts; queue the work before releasing it.
  await win.webContents.executeJavaScript('window.__maicongHarness.delayAdvancedLocalMs = 250');
  let queuedMtOps = await win.webContents.executeJavaScript('window.__advQueue');
  for (let i = 0; i < 80 && (!queuedMtOps.a.done || !queuedMtOps.b.done); i++) {
    await sleep(50);
    queuedMtOps = await win.webContents.executeJavaScript('window.__advQueue');
  }
  assert.equal(queuedMtOps.a.done, true, 'first queued MT apply must settle');
  assert.equal(queuedMtOps.b.done, true, 'second queued MT apply must settle');
  assert.equal(queuedMtOps.a.res && queuedMtOps.a.res.success, true, queuedMtOps.a.res && queuedMtOps.a.res.error);
  assert.equal(queuedMtOps.b.res && queuedMtOps.b.res.success, true, queuedMtOps.b.res && queuedMtOps.b.res.error);
  const afterQueuedMt = await waitUntil(
    (s) => s.keymapSavePending === 0 && Array.isArray(s.layer0Slot11) && Array.isArray(s.layer0Slot19),
    80,
    50
  );
  assert.deepEqual(afterQueuedMt.layer0Slot11, [146, 0, 15]);
  assert.deepEqual(afterQueuedMt.layer0Slot19, [146, 1, 15]);
  const queuedMtBytes = Buffer.from(afterQueuedMt.advancedMtHex, 'hex');
  assert.deepEqual(Array.from(queuedMtBytes.subarray(0, 6)), [16, 0, 4, 16, 1, 0]);
  assert.deepEqual(Array.from(queuedMtBytes.subarray(6, 12)), [16, 0, 5, 16, 2, 0]);
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false, 'queued local MT applies must not write HID');
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_MT_KEYS), false);
  await win.webContents.executeJavaScript('window.__maicongHarness.delayAdvancedLocalMs = 0');

  console.log('[MockUI] advanced: queued local CB applies retain sequential membership');
  await win.webContents.executeJavaScript(`
    (() => {
      const setValue = (id, value) => {
        const el = document.getElementById(id);
        if (!el) throw new Error(id + ' missing');
        el.value = String(value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const choose = (slot, modifier, regular) => {
        document.getElementById('adv-type-cb')?.click();
        setValue('adv-key-select', slot);
        setValue('adv-cb-modifier', modifier);
        setValue('adv-cb-regular', regular);
      };
      window.__maicongHarness.delayAdvancedLocalMs = 250;
      choose(11, '16,1,0', '16,0,4');
      window.__advQueue = { a: { done: false, res: null }, b: { done: false, res: null } };
      const a = window.__maicongHarness.applyAdvanced();
      choose(19, '16,8,0', '16,0,22');
      const b = window.__maicongHarness.applyAdvanced();
      Promise.resolve(a).then((res) => { window.__advQueue.a = { done: true, res }; }).catch((err) => {
        window.__advQueue.a = { done: true, res: { success: false, error: String(err && err.message || err) } };
      });
      Promise.resolve(b).then((res) => { window.__advQueue.b = { done: true, res }; }).catch((err) => {
        window.__advQueue.b = { done: true, res: { success: false, error: String(err && err.message || err) } };
      });
      return true;
    })()
  `);
  let queuedCbOps = await win.webContents.executeJavaScript('window.__advQueue');
  for (let i = 0; i < 80 && (!queuedCbOps.a.done || !queuedCbOps.b.done); i++) {
    await sleep(50);
    queuedCbOps = await win.webContents.executeJavaScript('window.__advQueue');
  }
  assert.equal(queuedCbOps.a.res && queuedCbOps.a.res.success, true, queuedCbOps.a.res && queuedCbOps.a.res.error);
  assert.equal(queuedCbOps.b.res && queuedCbOps.b.res.success, true, queuedCbOps.b.res && queuedCbOps.b.res.error);
  const afterQueuedCb = await waitUntil((s) => s.keymapSavePending === 0 && s.cbKeyIndexList[0].length === 2, 80, 50);
  assert.deepEqual(afterQueuedCb.layer0Slot11, [16, 1, 4]);
  assert.deepEqual(afterQueuedCb.layer0Slot19, [16, 8, 22]);
  assert.deepEqual(afterQueuedCb.cbKeyIndexList[0], [11, 19]);
  const queuedCbCustom = protocol.parseCbCustomParam(Buffer.from(afterQueuedCb.advancedCustomParamHex, 'hex'));
  assert.equal(queuedCbCustom.ok, true);
  assert.deepEqual(queuedCbCustom.cbKeyIndexList[0], [11, 19]);
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false, 'queued local CB applies must not write HID');
  await win.webContents.executeJavaScript('window.__maicongHarness.delayAdvancedLocalMs = 0');

  console.log('[MockUI] advanced: local save failure does not adopt tables or bindings');
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('adv-type-tgl')?.click();
      const sel = document.getElementById('adv-key-select');
      sel.value = '0';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      window.__maicongHarness.failNextLocalDraft = true;
      return true;
    })()
  `);
  const beforeLocalFailure = await snapshot();
  await kickOp('window.__maicongHarness.applyAdvanced()');
  const localFailureOp = await waitOpDone(80, 50);
  const afterLocalFailure = await snapshot();
  assert.equal(localFailureOp.res && localFailureOp.res.success, false);
  assert.match(localFailureOp.res && localFailureOp.res.error || '', /local profile save failure/i);
  assert.deepEqual(afterLocalFailure.layer0Slot0, beforeLocalFailure.layer0Slot0, 'failed local Advanced save must roll back its binding');
  assert.equal(afterLocalFailure.advancedMtHex, beforeLocalFailure.advancedMtHex, 'failed local Advanced save must not adopt table bytes');
  assert.equal(afterLocalFailure.advancedTglHex, beforeLocalFailure.advancedTglHex, 'failed local Advanced save must not adopt TGL table bytes');
  assert.deepEqual(afterLocalFailure.cbKeyIndexList, beforeLocalFailure.cbKeyIndexList, 'failed local Advanced save must not adopt CB metadata');

  console.log('[MockUI] advanced: clear then apply uses the cleared snapshot');
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('adv-type-mt')?.click();
      window.__maicongHarness.delayAdvancedLocalMs = 250;
      const sel = document.getElementById('adv-key-select');
      sel.value = '11';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const tap = document.getElementById('adv-tap-select');
      tap.value = '16,0,6';
      tap.dispatchEvent(new Event('change', { bubbles: true }));
      const hold = document.getElementById('adv-hold-select');
      hold.value = '16,4,0';
      hold.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await kickRenderer(`
    (() => {
      window.__advQueue = { clear: { done: false, res: null }, apply: { done: false, res: null } };
      const clear = window.__maicongHarness.clearAllAdvanced();
      const apply = window.__maicongHarness.applyAdvanced();
      Promise.resolve(clear).then((res) => { window.__advQueue.clear = { done: true, res }; }).catch((err) => {
        window.__advQueue.clear = { done: true, res: { success: false, error: String(err && err.message || err) } };
      });
      Promise.resolve(apply).then((res) => { window.__advQueue.apply = { done: true, res }; }).catch((err) => {
        window.__advQueue.apply = { done: true, res: { success: false, error: String(err && err.message || err) } };
      });
      return true;
    })()
  `);
  let clearApplyOps = await win.webContents.executeJavaScript('window.__advQueue');
  for (let i = 0; i < 100 && (!clearApplyOps.clear.done || !clearApplyOps.apply.done); i++) {
    await sleep(50);
    clearApplyOps = await win.webContents.executeJavaScript('window.__advQueue');
  }
  assert.equal(clearApplyOps.clear.res && clearApplyOps.clear.res.success, true, clearApplyOps.clear.res && clearApplyOps.clear.res.error);
  assert.equal(clearApplyOps.apply.res && clearApplyOps.apply.res.success, true, clearApplyOps.apply.res && clearApplyOps.apply.res.error);
  const afterClearApply = await waitUntil((s) => s.keymapSavePending === 0 && Array.isArray(s.layer0Slot11), 80, 50);
  assert.deepEqual(afterClearApply.layer0Slot11, [146, 0, 15]);
  assert.notEqual(afterClearApply.layer0Slot19 && afterClearApply.layer0Slot19[0], 145);
  assert.notEqual(afterClearApply.layer0Slot19 && afterClearApply.layer0Slot19[0], 146);
  assert.deepEqual(afterClearApply.cbKeyIndexList, [[], [], [], []]);
  const clearApplyMtBytes = Buffer.from(afterClearApply.advancedMtHex, 'hex');
  assert.deepEqual(Array.from(clearApplyMtBytes.subarray(0, 6)), [16, 0, 6, 16, 4, 0]);
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false, 'clear→apply local queue must not write HID');
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_MT_KEYS), false);
  await win.webContents.executeJavaScript('window.__maicongHarness.delayAdvancedLocalMs = 0');

  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="set-tab"][data-tab="keymap"]\')?.click()');
  await sleep(80);
  await win.webContents.executeJavaScript('document.getElementById("k_a")?.click()');
  await sleep(40);
  await kickOp('window.__maicongHarness.dropKeycodeOnSlot(11, { type: 33, code1: 0, code2: 1, label: "Wheel Up" })');
  const previewDrop = await waitUntil(
    (s) => s.keymapSavePending === 0 && Array.isArray(s.layer0Slot11) && s.layer0Slot11[0] === 33,
    80,
    50
  );
  const previewDropOp = await waitOpDone();
  assert.equal(previewDropOp.res && previewDropOp.res.success, true, previewDropOp.res && previewDropOp.res.error);
  assert.deepEqual(previewDrop.layer0Slot11, [33, 0, 1]);
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false, 'local preview drop must not write HID');
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_FUNC_CONFIG), false);
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_MACROS), false);

  console.log('[MockUI] advanced: delayed local apply keeps newer ordinary draft');
  await win.webContents.executeJavaScript(`
    (() => {
      window.__maicongHarness.delayAdvancedLocalMs = 500;
      document.querySelector('[data-action="set-tab"][data-tab="advanced"]')?.click();
      document.getElementById('adv-type-mt')?.click();
      const sel = document.getElementById('adv-key-select');
      sel.value = '0';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await sleep(80);
  mock.writtenBuffers.length = 0;
  await kickOp('window.__maicongHarness.applyAdvanced()');
  await sleep(80);
  await win.webContents.executeJavaScript(
    'window.__maicongHarness.dropKeycodeOnSlot(11, { type: 16, code1: 0, code2: 7, label: "D" })'
  );
  const delayedLocalOp = await waitOpDone(40, 50);
  await win.webContents.executeJavaScript('window.__maicongHarness.delayAdvancedLocalMs = 0');
  const delayedSlots = await waitUntil(
    (s) => s.keymapSavePending === 0 && Array.isArray(s.layer0Slot11) && s.layer0Slot11[2] === 7,
    40,
    50
  );
  assert.equal(delayedLocalOp.res && delayedLocalOp.res.success, true, delayedLocalOp.res && delayedLocalOp.res.error);
  assert.deepEqual(delayedSlots.layer0Slot11, [16, 0, 7], 'newer ordinary draft on A must survive delayed local MT apply');
  assert.equal(delayedSlots.layer0Slot0 && delayedSlots.layer0Slot0[0], 146, 'Esc must receive the local MT binding');
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false, 'delayed local advanced must not write HID');
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_MT_KEYS), false);

  console.log('[MockUI] advanced: delayed local apply rejects profile switch');
  await win.webContents.executeJavaScript(`
    (() => {
      window.__maicongHarness.delayAdvancedLocalMs = 500;
      document.getElementById('adv-type-tgl')?.click();
      const sel = document.getElementById('adv-key-select');
      sel.value = '19';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await sleep(50);
  mock.writtenBuffers.length = 0;
  await kickOp('window.__maicongHarness.applyAdvanced()');
  await sleep(80);
  await win.webContents.executeJavaScript('document.getElementById("btn-load-edit-target")?.click()');
  const advancedSwitchOp = await waitOpDone(40, 50);
  await win.webContents.executeJavaScript('window.__maicongHarness.delayAdvancedLocalMs = 0');
  const afterAdvancedSwitch = await waitUntil(
    (s) => s.keymapSavePending === 0 && s.localPreview === false && !s.loadInFlight && s.hasReadKeymap && s.hasReadKeymap[0],
    80,
    50
  );
  assert.equal(afterAdvancedSwitch.localPreview, false);
  assert.notEqual(afterAdvancedSwitch.layer0Slot19 && afterAdvancedSwitch.layer0Slot19[0], 145, 'profile switch must not receive the stale local TGL');
  assert.equal(advancedSwitchOp.res && advancedSwitchOp.res.success, true, 'profile switch must drain the delayed local save before changing targets');
  assert.notEqual(advancedSwitchOp.res && advancedSwitchOp.res.stale, true, 'a drained local save must not be mislabeled stale');
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_TGL_KEYS), false);

  console.log('[MockUI] advanced: delayed local apply rejects reset identity');
  await kickOp(`window.__maicongHarness.loadLocalPreview(${JSON.stringify(previewDrop.editSourceKey)})`);
  const reloadedLocal = await waitUntil(
    (s) => s.localPreview === true && s.localPreviewAdvanced && s.hasReadKeymap && s.hasReadKeymap[0] && s.keymapSavePending === 0,
    80,
    50
  );
  await waitOpDone(80, 50);
  assert.equal(reloadedLocal.localPreview, true);
  await win.webContents.executeJavaScript(`
    (() => {
      window.__maicongHarness.delayAdvancedLocalMs = 500;
      document.getElementById('adv-type-mt')?.click();
      const sel = document.getElementById('adv-key-select');
      sel.value = '19';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(50);
  await kickOp('window.__maicongHarness.applyAdvanced()');
  await sleep(80);
  const a2AdvancedReset = Buffer.alloc(64, 0);
  a2AdvancedReset[0] = 0xA2;
  mock.emit('data', a2AdvancedReset);
  await sleep(250);
  const advancedResetOp = await waitOpDone(80, 50);
  await win.webContents.executeJavaScript('window.__maicongHarness.delayAdvancedLocalMs = 0');
  const afterAdvancedReset = await snapshot();
  assert.equal(advancedResetOp.res && advancedResetOp.res.stale, true, 'delayed local apply must report stale after reset invalidation');
  assert.equal(afterAdvancedReset.layer0Slot19, null, 'reset invalidation must not let stale Advanced data repopulate the editor');
  assert.equal(afterAdvancedReset.localPreview, true);
  assert.equal(afterAdvancedReset.connected, false, 'reset notification must invalidate the device connection while the delayed save is pending');
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false);
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_MT_KEYS), false);
  mock.closed = false;
  mock.listeners = mock.listeners || {};
  transport.installTestAdapter(mock);
  await transport.queryStatus();
  await sleep(80);
  await win.webContents.executeJavaScript(`window.__maicongHarness.setDeviceConnected(true, ${transport.resetEpoch})`);
  const advancedResetReady = await waitUntil(
    (s) => s.connected === true && s.keymapSavePending === 0 && !s.loadInFlight,
    40,
    50
  );
  assert.equal(advancedResetReady.connected, true, 'fresh transport generation must be hydrated before local reload');
  assert.equal(advancedResetReady.keymapSavePending, 0);
  assert.equal(advancedResetReady.loadInFlight, false);
  await kickOp(`window.__maicongHarness.loadLocalPreview(${JSON.stringify(previewDrop.editSourceKey)})`);
  const afterAdvancedResetReload = await waitUntil(
    (s) => s.connected === true && s.localPreview === true && s.localPreviewAdvanced
      && s.hasReadKeymap && s.hasReadKeymap[0] && s.keymapSavePending === 0 && !s.loadInFlight,
    80,
    50
  );
  const advancedResetReloadOp = await waitOpDone(80, 50);
  assert.equal(advancedResetReloadOp.done, true, 'local reload must settle after Advanced reset reconnect');
  assert.equal(afterAdvancedResetReload.localPreview, true);
  assert.equal(afterAdvancedResetReload.connected, true);
  assert.equal(afterAdvancedResetReload.hasReadKeymap[0], true, 'local reload must hydrate keymap provenance');
  assert.ok(afterAdvancedResetReload.editGeneration > advancedResetReady.editGeneration, 'local reload must commit under the fresh edit identity');
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="set-layer"][data-layer="0"]\')?.click()');
  await sleep(80);

  console.log('[MockUI] key-config: local macro persist race');
  await win.webContents.executeJavaScript('window.__maicongHarness.fillSlotActions(0, 2)');
  const localBody = await win.webContents.executeJavaScript(
    'window.MaicongMacroDraft.getNormalizedBodyKey(window.__maicongHarness.getActions(0))'
  );
  assert.ok(localBody);
  const localMacroClip = await win.webContents.executeJavaScript(`
    window.__maicongHarness.setKeyClipboard({
      v: 1,
      kind: "g75-key-binding",
      binding: { type: 112, code1: 0, code2: 0 },
      source: { kind: "local", key: ${JSON.stringify(previewDrop.editSourceKey || 'KeyboardProfile@localstorage@x')} },
      macro: { playbackType: 0, bodyKey: ${JSON.stringify(localBody)} }
    })
  `);
  assert.equal(localMacroClip, true);
  await win.webContents.executeJavaScript('document.getElementById("k_s")?.click()');
  mock.writtenBuffers.length = 0;
  await kickRenderer(`
    (() => {
      window.__kcOp = { done: false, res: null };
      const p = window.__maicongHarness.pasteSelectedKey();
      window.__maicongHarness.fillSlotActions(0, 9);
      Promise.resolve(p).then((res) => { window.__kcOp = { done: true, res }; }).catch((err) => {
        window.__kcOp = { done: true, res: { success: false, error: String(err && err.message || err) } };
      });
      return true;
    })()
  `);
  const localRaceOp = await waitOpDone();
  assert.equal(localRaceOp.res && localRaceOp.res.success, false, 'local persist must reject after destination macro body changes');
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false);
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_MACROS), false);
  const afterLocalReject = await snapshot();
  assert.deepEqual(
    afterLocalReject.layer0Slot19,
    [112, 0, 0],
    `rejected paste draft remains in the editor until repaired: ${JSON.stringify({
      op: localRaceOp.res,
      activeLayer: afterLocalReject.activeLayer,
      hasReadKeymap: afterLocalReject.hasReadKeymap,
      selectedType: afterLocalReject.keyClipboardType,
      editSourceKind: afterLocalReject.editSourceKind,
      localPreview: afterLocalReject.localPreview
    })}`
  );
  assert.equal(afterLocalReject.keymapDirty, true);
  assert.notEqual(
    afterLocalReject.localLayer0Slot19 && afterLocalReject.localLayer0Slot19[0],
    112,
    'rejected paste must not land in the last-valid local snapshot'
  );
  await kickOp('window.__maicongHarness.dropKeycodeOnSlot(11, { type: 33, code1: 0, code2: 1, label: "Wheel Up" })');
  const localRecover = await waitOpDone();
  assert.equal(localRecover.res && localRecover.res.success, true, localRecover.res && localRecover.res.error);
  const afterUnrelatedLocal = await snapshot();
  assert.deepEqual(afterUnrelatedLocal.layer0Slot19, [112, 0, 0], 'unrelated slot save must not clear the rejected slot19 draft');
  assert.equal(afterUnrelatedLocal.keymapDirty, true, 'unrelated slot save must not mark rejected slot19 persisted');
  assert.notEqual(
    afterUnrelatedLocal.localLayer0Slot19 && afterUnrelatedLocal.localLayer0Slot19[0],
    112,
    'unrelated slot save must not persist rejected slot19'
  );
  await kickOp('window.__maicongHarness.dropKeycodeOnSlot(19, { type: 33, code1: 0, code2: 1, label: "Wheel Up" })');
  const localRepair = await waitUntil(
    (s) => s.keymapSavePending === 0 && Array.isArray(s.layer0Slot19) && s.layer0Slot19[0] === 33 && s.keymapDirty === false,
    80,
    50
  );
  const localRepairOp = await waitOpDone();
  assert.equal(localRepairOp.res && localRepairOp.res.success, true, localRepairOp.res && localRepairOp.res.error);
  assert.deepEqual(localRepair.layer0Slot19, [33, 0, 1]);
  assert.equal(localRepair.keymapDirty, false);

  console.log('[MockUI] key-config: cross-local macro clipboard');
  const crossLocalSet = await win.webContents.executeJavaScript(`
    window.__maicongHarness.setKeyClipboard({
      v: 1,
      kind: "g75-key-binding",
      binding: { type: 112, code1: 0, code2: 1 },
      source: { kind: "local", key: "KeyboardProfile@localstorage@other-profile" },
      macro: { playbackType: 1, bodyKey: "deadbeefdeadbeef" }
    })
  `);
  assert.equal(crossLocalSet, true);
  mock.writtenBuffers.length = 0;
  await kickOp('window.__maicongHarness.pasteSelectedKey()');
  const crossLocalOp = await waitOpDone();
  assert.equal(crossLocalOp.res && crossLocalOp.res.success, false);
  const afterCrossLocal = await snapshot();
  assert.deepEqual(afterCrossLocal.layer0Slot11, [33, 0, 1]);
  assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false, 'cross-local macro without matching content must not write HID');

  console.log('[MockUI] key-config: load onboard');
  await kickOp('window.__maicongHarness.loadOnboardProfile(0)');
  const backOnboard = await waitUntil(
    (s) => s.localPreview !== true && s.hasReadLighting && !s.loadInFlight && s.canEditLighting,
    80,
    50
  );
  assert.equal(backOnboard.localPreview, false);
  assert.equal(backOnboard.canEditLighting, true, 'Load must restore lighting before the reset-pending checks');

  console.log('[MockUI] key-config: reset during delayed save');
  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelector('[data-action="set-tab"][data-tab="keymap"]')?.click();
      document.querySelector('[data-action="set-layer"][data-layer="0"]')?.click();
    })()
  `);
  await win.webContents.executeJavaScript('document.querySelector(\'[data-action="read-layer"]\')?.click()');
  await waitUntil((s) => s.hasReadKeymap && s.hasReadKeymap[0] && !s.loadInFlight, 80, 50);
  mock.delayCommands.set(protocol.COMMANDS.SET_USER_KEY_MATRIX, 400);
  await kickOp('window.__maicongHarness.dropKeycodeOnSlot(11, { type: 32, code1: 1, code2: 0, label: "Left Mouse Button" })');
  await sleep(80);
  assert.ok((await snapshot()).keymapSavePending >= 1, 'delayed keymap save must still be owned when reset arrives');
  await kickRenderer(`
    (() => {
      window.__kcOpB = { done: false, res: null };
      Promise.resolve(window.__maicongHarness.dropKeycodeOnSlot(19, { type: 33, code1: 0, code2: 1, label: "Wheel Up" }))
        .then((res) => { window.__kcOpB = { done: true, res }; })
        .catch((err) => { window.__kcOpB = { done: true, res: { success: false, error: String(err && err.message || err) } }; });
      return true;
    })()
  `);
  const queuedBeforeReset = await snapshot();
  assert.ok(queuedBeforeReset.keymapSavePending >= 1, 'queued B must be pending with in-flight A before reset');
  const a2Keymap = Buffer.alloc(64, 0);
  a2Keymap[0] = 0xA2;
  mock.emit('data', a2Keymap);
  await sleep(250);
  const afterKeymapResetPending = await snapshot();
  assert.strictEqual(afterKeymapResetPending.hasReadKeymap[0], false, 'unsolicited reset must invalidate keymap during pending save');
  assert.strictEqual(afterKeymapResetPending.layer0KeyCount, 0);
  const resetA = await waitOpDone();
  let resetB = { done: false, res: null };
  for (let i = 0; i < 80; i++) {
    resetB = await win.webContents.executeJavaScript('window.__kcOpB || { done: false, res: null }');
    if (resetB.done) break;
    await sleep(50);
  }
  assert.equal(resetA.done, true, 'in-flight A must settle after reset');
  assert.equal(resetB.done, true, 'queued B must settle after reset');
  assert.notEqual(resetB.res && resetB.res.success, true, 'queued B must not write after reset');
  assert.equal(resetB.res && resetB.res.stale, true, 'queued B must abort at enqueue identity, not adopt a later generation');
  mock.delayCommands.delete(protocol.COMMANDS.SET_USER_KEY_MATRIX);
  const staleAfterKeymapReset = await snapshot();
  assert.strictEqual(staleAfterKeymapReset.hasReadKeymap[0], false, 'stale keymap save must not restore editors after reset');
  assert.strictEqual(staleAfterKeymapReset.layer0KeyCount, 0);
  mock.closed = false;
  mock.listeners = mock.listeners || {};
  transport.installTestAdapter(mock);
  await transport.queryStatus();
  await sleep(80);
  await win.webContents.executeJavaScript(`window.__maicongHarness.setDeviceConnected(true, ${transport.resetEpoch})`);
  const readyToReload = await waitUntil(
    (s) => s.connected === true && s.keymapSavePending === 0 && !s.loadInFlight,
    40,
    50
  );
  assert.equal(
    readyToReload.connected,
    true,
    `reconnect before load connected=${readyToReload.connected} pending=${readyToReload.keymapSavePending} toast=${readyToReload.toast}`
  );
  await kickOp('window.__maicongHarness.loadOnboardProfile(0)');
  const restoredAfterKeymapReset = await waitUntil(
    (s) => s.connected === true && s.editingProfile === 0 && s.hasReadLighting
      && s.hasReadKeymap && s.hasReadKeymap[0] && !s.loadInFlight && s.canEditLighting && s.localPreview !== true,
    120,
    50
  );
  const restoredLoadOp = await waitOpDone(120, 50);
  assert.equal(restoredLoadOp.done, true, 'Load must settle after keymap reset-during-save');
  assert.equal(
    restoredAfterKeymapReset.canEditLighting,
    true,
      `Load must restore lighting after keymap reset-during-save (status=${restoredAfterKeymapReset.keymapSaveStatus} err=${restoredAfterKeymapReset.keymapSaveError} dirty=${restoredAfterKeymapReset.keymapDirty} blocked=${restoredLoadOp.res && restoredLoadOp.res.blocked} lighting=${restoredAfterKeymapReset.hasReadLighting} load=${restoredAfterKeymapReset.loadInFlight})`
  );
  assert.equal(restoredAfterKeymapReset.connected, true);
  assert.equal(restoredAfterKeymapReset.hasReadKeymap[0], true, 'Load must hydrate keymap provenance after reconnect');
  assert.ok(restoredAfterKeymapReset.editGeneration > readyToReload.editGeneration, 'Load must commit under the fresh edit identity after reconnect');

  mock.delayCommands.set(protocol.COMMANDS.SET_FUNC_CONFIG, 400);
  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelector('[data-action="set-tab"][data-tab="lighting"]')?.click();
      const s = document.getElementById('light-brightness-slider');
      if (s) {
        s.value = '28';
        s.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()
  `);
  await sleep(140);
  assert.strictEqual((await snapshot()).lightingOpInFlight, true);
  const a2Pending = Buffer.alloc(64, 0);
  a2Pending[0] = 0xA2;
  mock.emit('data', a2Pending);
  await sleep(250);
  mock.delayCommands.delete(protocol.COMMANDS.SET_FUNC_CONFIG);
  const afterResetPending = await snapshot();
  assert.strictEqual(afterResetPending.hasReadLighting, false, 'unsolicited reset must invalidate lighting during pending Apply');
  assert.strictEqual(afterResetPending.lightingOpInFlight, false, 'reset must drop the pending lighting request identity');
  await sleep(400);
  const staleAfterReset = await snapshot();
  assert.strictEqual(staleAfterReset.hasReadLighting, false, 'stale Apply completion must not restore editors after reset');
  assert.strictEqual(staleAfterReset.lightingOpInFlight, false);
  assert.strictEqual(staleAfterReset.canEditLighting, false);

  mock.delayCommands.set(protocol.COMMANDS.GET_FUNC_CONFIG, 400);
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="read-lighting"]\')?.click()'
  );
  await sleep(50);
  const a2 = Buffer.alloc(64, 0);
  a2[0] = 0xA2;
  mock.emit('data', a2);
  await sleep(250);
  const afterUnsolicited = await snapshot();
  assert.strictEqual(afterUnsolicited.hasReadSettings, false, 'unsolicited reset must invalidate settings without a click');
  assert.strictEqual(afterUnsolicited.hasReadLighting, false);
  assert.strictEqual(afterUnsolicited.hasReadMacros, false);
  assert.strictEqual(afterUnsolicited.hasReadKeyColors, false);
  assert.strictEqual(afterUnsolicited.hasAdvancedRead, false);
  assert.strictEqual(afterUnsolicited.layer0KeyCount, 0, 'unsolicited reset must drop staged keymap');
  assert.strictEqual(afterUnsolicited.layer2KeyCount, 0);
  assert.strictEqual(afterUnsolicited.applySettingsDisabled, true);
  assert.strictEqual(afterUnsolicited.applyLightingDisabled, true);
  assert.strictEqual(afterUnsolicited.applyKeymapDisabled, true);
  assert.strictEqual(afterUnsolicited.applyMacrosDisabled, true);
  await assertLightingSyntheticRejected('synthetic tile click after unsolicited reset must not stage');
  await sleep(500);
  mock.delayCommands.delete(protocol.COMMANDS.GET_FUNC_CONFIG);
  const afterStaleLighting = await snapshot();
  assert.strictEqual(afterStaleLighting.hasReadLighting, false, 'stale lighting read must not restore editors');
  assert.strictEqual(afterStaleLighting.hasReadSettings, false);
  assert.strictEqual(afterStaleLighting.applyLightingDisabled, true);

  console.log('[MockUI] others: firmware review/cancel/confirm');
  // GET_INFO fixture is already catalog 1.30. Start the mock at 1.29 so the
  // native IO stamp of 1.30 after a successful transfer is a visible catalog
  // match; same-version readback is also treated as success after restore.
  mock.info[2] = 0x29;
  mock.info[3] = 0x01;
  transport.installTestAdapter(mock);
  await transport.queryStatus();
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="refresh-status"]\')?.click()'
  );
  await sleep(400);
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="set-tab"][data-tab="others"]\')?.click()'
  );
  await sleep(250);
  const othersOpen = await win.webContents.executeJavaScript(
    '!document.getElementById("panel-others")?.hidden'
  );
  assert.strictEqual(othersOpen, true, 'Others panel must open for firmware');
  const firmwareHome = await snapshot();
  assert.doesNotMatch(firmwareHome.firmwareCardText || '', /not available in this build/i);
  assert.match(firmwareHome.firmwareCardText || '', /official package|Review/i);
  assert.match(firmwareHome.firmwareMcuVersion || '', /1\.14/);
  assert.match(firmwareHome.firmwareRfVersion || '', /1\.29/);
  assert.match(firmwareHome.firmwareTargetLabel || '', /Receiver|2\.4G/i);
  assert.strictEqual(firmwareHome.firmwareInterruptedChecked, true, 'firmwareInterruptedStatus must be queried independently of firmwareStatus');
  assert.strictEqual(firmwareHome.firmwareInterruptedPresent, false, 'startup interrupted-status check must run independently');
  assert.strictEqual(firmwareHome.firmwareRecoveryHidden, true);
  assert.strictEqual(firmwareHome.firmwareRecoveryDialogHidden, true);

  console.log('[MockUI] others: interrupted firmware recovery prompt/discard');
  function writeMockRecoveryAnchor(overrides = {}) {
    const userData = app.getPath('userData');
    const catalog = mockFw.createMockUiCatalog();
    const backupPath = overrides.backupPath !== undefined
      ? overrides.backupPath
      : path.join(userData, 'firmware-recovery-backup.json');
    if (overrides.createBackup !== false && backupPath) {
      fs.writeFileSync(backupPath, '{"schema":"mock-ui-firmware"}\n');
    } else if (backupPath && fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
    const identity = firmwareBackup.currentDeviceIdentity(transport);
    const written = firmwareBackup.writeBootAnchor(firmwareBackup.bootAnchorPath(userData), {
      schema: firmwareBackup.BOOT_ANCHOR_SCHEMA,
      version: firmwareBackup.BOOT_ANCHOR_SCHEMA_VERSION,
      targetKey: 'receiver',
      locationId: Number.isInteger(identity.locationId) ? identity.locationId : 0x02400000,
      serialNumber: identity.serialNumber || 'MOCK',
      packageSha256: overrides.packageSha256 || catalog.receiver.package.sha256,
      backupPath: backupPath || path.join(userData, 'missing-firmware-recovery-backup.json'),
      firmwareField: 'rfFirmwareVersion',
      beforeVersionRaw: mockFw.RECEIVER_INFO_BEFORE.rawRfFirmwareVersion,
      enteredAt: Date.now()
    });
    assert.equal(written.success, true, written.error);
    return { userData, backupPath, catalog };
  }

  writeMockRecoveryAnchor();
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="set-tab"][data-tab="dashboard"]\')?.click()'
  );
  await sleep(80);
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="set-tab"][data-tab="others"]\')?.click()'
  );
  const recoveryPrompt = await waitUntil((s) => s.firmwareRecoveryHidden === false && s.firmwareResumeHidden === false, 40, 50);
  assert.strictEqual(recoveryPrompt.firmwareInterruptedPresent, true);
  assert.strictEqual(recoveryPrompt.firmwareInterruptedBackupPresent, true);
  assert.strictEqual(recoveryPrompt.firmwareRecoveryHidden, false);
  assert.strictEqual(recoveryPrompt.firmwareResumeHidden, false);
  assert.match(recoveryPrompt.firmwareRecoveryBody || '', /interrupted while writing/i);

  await win.webContents.executeJavaScript('document.getElementById("lang-zh")?.click()');
  const zhRecovery = await waitUntil((s) => /写入过程中中断/.test(s.firmwareRecoveryBody || ''), 20, 50);
  assert.match(zhRecovery.firmwareRecoveryBody || '', /写入过程中中断/);
  await win.webContents.executeJavaScript('document.getElementById("lang-en")?.click()');
  await waitUntil((s) => /interrupted while writing/i.test(s.firmwareRecoveryBody || ''), 20, 50);

  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-discard")?.click()');
  const discardReview = await waitUntil((s) => s.firmwareRecoveryDialogHidden === false, 20, 50);
  assert.strictEqual(discardReview.firmwareRecoveryDialogHidden, false);
  assert.match(discardReview.firmwareRecoveryDialogTitle || '', /Discard the interrupted update/i);
  assert.match(discardReview.firmwareRecoveryDialogBody || '', /recovery record/i);
  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-recovery-cancel")?.click()');
  const afterDiscardCancel = await waitUntil((s) => s.firmwareRecoveryDialogHidden === true, 20, 50);
  assert.strictEqual(afterDiscardCancel.firmwareRecoveryDialogHidden, true);
  assert.strictEqual(afterDiscardCancel.firmwareRecoveryHidden, false);
  assert.strictEqual(afterDiscardCancel.activeElementId, 'btn-firmware-discard');

  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-discard")?.click()');
  await waitUntil((s) => s.firmwareRecoveryDialogHidden === false, 20, 50);
  await win.webContents.executeJavaScript(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  `);
  const afterDiscardEscape = await waitUntil((s) => s.firmwareRecoveryDialogHidden === true, 20, 50);
  assert.strictEqual(afterDiscardEscape.firmwareRecoveryDialogHidden, true, 'Escape must close recovery discard');
  assert.strictEqual(afterDiscardEscape.firmwareRecoveryHidden, false);
  assert.strictEqual(afterDiscardEscape.firmwareInterruptedPresent, true);

  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-discard")?.click()');
  await waitUntil((s) => s.firmwareRecoveryDialogHidden === false, 20, 50);
  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-recovery-confirm")?.click()');
  const afterDiscard = await waitUntil(
    (s) => s.firmwareRecoveryDialogHidden === true && s.firmwareRecoveryHidden === true,
    40,
    50
  );
  assert.strictEqual(afterDiscard.firmwareRecoveryHidden, true);
  assert.strictEqual(afterDiscard.firmwareInterruptedPresent, false);
  assert.match(afterDiscard.toast || '', /discarded/i);
  assert.strictEqual(
    fs.existsSync(firmwareBackup.bootAnchorPath(app.getPath('userData'))),
    false,
    'confirmed discard must remove the boot anchor'
  );

  writeMockRecoveryAnchor({
    createBackup: false,
    backupPath: path.join(app.getPath('userData'), 'missing-firmware-recovery-backup.json')
  });
  await win.webContents.executeJavaScript('window.__maicongHarness.refreshInterruptedFirmware()');
  const noBackupPrompt = await waitUntil(
    (s) => s.firmwareRecoveryHidden === false && s.firmwareResumeHidden === true,
    40,
    50
  );
  assert.strictEqual(noBackupPrompt.firmwareInterruptedPresent, true);
  assert.strictEqual(noBackupPrompt.firmwareInterruptedBackupPresent, false);
  assert.strictEqual(noBackupPrompt.firmwareResumeHidden, true, 'resume must not be offered without a backup');
  assert.match(noBackupPrompt.firmwareRecoveryBody || '', /backup is gone/i);
  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-discard")?.click()');
  await waitUntil((s) => s.firmwareRecoveryDialogHidden === false, 20, 50);
  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-recovery-confirm")?.click()');
  await waitUntil((s) => s.firmwareRecoveryHidden === true, 40, 50);

  // Resume is driven only through package-mismatch: the mock HID stays in
  // normal mode, so a faithful bootloader reflash cannot be completed here.
  const mismatchCatalog = mockFw.createMockUiCatalog();
  writeMockRecoveryAnchor({ packageSha256: mismatchCatalog.keyboard.package.sha256 });
  await win.webContents.executeJavaScript('window.__maicongHarness.refreshInterruptedFirmware()');
  await waitUntil((s) => s.firmwareRecoveryHidden === false && s.firmwareResumeHidden === false, 40, 50);
  await win.webContents.executeJavaScript('window.__maicongHarness.resumeInterruptedFirmware()');
  const resumeReview = await waitUntil((s) => s.firmwareRecoveryDialogHidden === false && s.firmwareRecoveryDialogMode === 'resume', 40, 50);
  assert.strictEqual(resumeReview.firmwareRecoveryDialogMode, 'resume');
  assert.match(resumeReview.firmwareRecoveryDialogTitle || '', /Resume the interrupted firmware update/i);
  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-recovery-confirm")?.click()');
  const mismatchReview = await waitUntil((s) => s.firmwareRecoveryDialogMode === 'mismatch', 40, 50);
  assert.strictEqual(mismatchReview.firmwareRecoveryDialogMode, 'mismatch');
  assert.match(mismatchReview.firmwareRecoveryDialogTitle || '', /does not match the interrupted update/i);
  assert.match(mismatchReview.firmwareRecoveryDialogBody || '', /different package/i);
  assert.match(mismatchReview.firmwareRecoveryDialogConfirm || '', /anyway/i);
  assert.strictEqual(mismatchReview.firmwareInterruptedPresent, true, 'mismatch must not discard the anchor');
  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-recovery-cancel")?.click()');
  await waitUntil((s) => s.firmwareRecoveryDialogHidden === true, 20, 50);
  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-discard")?.click()');
  await waitUntil((s) => s.firmwareRecoveryDialogHidden === false, 20, 50);
  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-recovery-confirm")?.click()');
  await waitUntil((s) => s.firmwareRecoveryHidden === true, 40, 50);

  mock.writtenBuffers.length = 0;
  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-choose")?.click()');
  await sleep(200);
  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-review")?.click()');
  const firmwareReview = await waitUntil((s) => s.firmwareDialogHidden === false, 40, 50);
  assert.strictEqual(
    firmwareReview.firmwareDialogHidden,
    false,
    `firmware review dialog must open toast=${firmwareReview.toast} pkg=${firmwareReview.firmwarePackageName} target=${firmwareReview.firmwareTargetLabel}`
  );
  assert.match(firmwareReview.firmwareDialogHash || '', /SHA-256/i);
  assert.match(firmwareReview.firmwareDialogSize || '', /bytes/i);
  assert.match(firmwareReview.firmwareDialogBoot || '', /0x2010|PID/i);
  assert.strictEqual(firmwareReview.firmwareNativeWriteCount, 0, 'review must not flash');

  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-cancel")?.click()');
  const afterFwCancel = await waitUntil((s) => s.firmwareDialogHidden === true, 20, 50);
  assert.strictEqual(afterFwCancel.firmwareDialogHidden, true);
  assert.strictEqual(afterFwCancel.firmwareNativeWriteCount, 0, 'cancel must send zero flash writes');
  assert.strictEqual(afterFwCancel.activeElementId, 'btn-firmware-review');

  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-review")?.click()');
  await waitUntil((s) => s.firmwareDialogHidden === false, 40, 50);
  await win.webContents.executeJavaScript(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  `);
  const afterFwEscape = await waitUntil((s) => s.firmwareDialogHidden === true, 20, 50);
  assert.strictEqual(afterFwEscape.firmwareDialogHidden, true, 'Escape must close firmware review');
  assert.strictEqual(afterFwEscape.firmwareNativeWriteCount, 0, 'Escape must send zero flash writes');

  await win.webContents.executeJavaScript(
    'window.__maicongHarness.chooseFirmwarePackage({ fixture: "mismatch" })'
  );
  await sleep(150);
  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-review")?.click()');
  await sleep(300);
  const afterMismatch = await snapshot();
  assert.strictEqual(afterMismatch.firmwareDialogHidden, true, 'hash mismatch must not open confirm');
  assert.strictEqual(afterMismatch.firmwareNativeWriteCount, 0, 'hash mismatch must send zero flash writes');
  assert.match(afterMismatch.toast || '', /catalog|SHA-256|package/i);

  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-choose")?.click()');
  await sleep(200);
  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-review")?.click()');
  await waitUntil((s) => s.firmwareDialogHidden === false, 40, 50);
  await win.webContents.executeJavaScript('document.getElementById("btn-firmware-confirm")?.click()');
  const afterFwConfirm = await waitUntil(
    (s) => s.firmwareDialogHidden === true && (s.firmwareLastOutcomeSuccess === true || s.firmwareNativeWriteCount > 0),
    80,
    50
  );
  assert.strictEqual(afterFwConfirm.firmwareDialogHidden, true);
  assert.ok(afterFwConfirm.firmwareNativeWriteCount > 0, 'confirm after review must run the updater');
  assert.ok(
    (afterFwConfirm.firmwareNativeWritePhases || []).includes('erase'),
    `confirm must erase, phases=${JSON.stringify(afterFwConfirm.firmwareNativeWritePhases)}`
  );
  assert.strictEqual(afterFwConfirm.firmwareLastOutcomeSuccess, true, afterFwConfirm.firmwareStatusText);
  assert.match(afterFwConfirm.toast || afterFwConfirm.firmwareStatusText || '', /version readback|restore|finished/i);

  console.log('[MockUI] profiles: game/app auto-bind');
  await win.webContents.executeJavaScript(
    'window.__maicongHarness.setMockFrontmost(null)'
  );
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="refresh-status"]\')?.click()'
  );
  await sleep(400);
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="set-tab"][data-tab="profiles"]\')?.click()'
  );
  await sleep(200);
  const bindTarget = await win.webContents.executeJavaScript(`
    (() => {
      const btn = document.querySelector('#onboard-profile-list [data-action="delete-onboard-profile"]');
      if (!btn || !btn.dataset.key) return null;
      return { key: btn.dataset.key, profile: Number(btn.dataset.key.split('@').pop()) };
    })()
  `);
  assert.ok(bindTarget && Number.isInteger(bindTarget.profile), 'need a deletable onboard slot to bind');
  const bound = await win.webContents.executeJavaScript(
    `window.__maicongHarness.bindProfileApp(${bindTarget.profile}, { bundleId: "com.mock.game", displayName: "Mock Game" })`
  );
  assert.equal(bound && bound.success, true, bound && bound.error);
  const bindLabel = `${bindTarget.profile}:com.mock.game`;
  const afterBind = await snapshot();
  assert.ok((afterBind.appBindLabels || []).includes(bindLabel), afterBind.appBindLabels);
  assert.ok((afterBind.onboardDescs || []).some((t) => /Linked to Mock Game/i.test(t)));
  assert.ok((afterBind.appBindButtonLabels || []).includes('Unlink app'));

  await win.webContents.executeJavaScript(
    `document.querySelector('[data-action="delete-onboard-profile"][data-key="${bindTarget.key}"]')?.click()`
  );
  const bindDialog = await waitUntil((s) => s.appBindDeleteHidden === false, 20, 50);
  assert.equal(bindDialog.appBindDeleteHidden, false);
  assert.match(bindDialog.appBindDeleteBody || '', /linked to a game\/app/i);
  await win.webContents.executeJavaScript(
    'document.getElementById("btn-app-bind-delete-cancel")?.click()'
  );
  const afterBindCancel = await waitUntil((s) => s.appBindDeleteHidden === true, 20, 50);
  assert.ok((afterBindCancel.appBindLabels || []).includes(bindLabel));

  await win.webContents.executeJavaScript(
    `document.querySelector('[data-action="delete-onboard-profile"][data-key="${bindTarget.key}"]')?.click()`
  );
  await waitUntil((s) => s.appBindDeleteHidden === false, 20, 50);
  await win.webContents.executeJavaScript(
    'document.getElementById("btn-app-bind-delete-confirm")?.click()'
  );
  const afterBindDelete = await waitUntil(
    (s) => s.appBindDeleteHidden === true && !(s.appBindLabels || []).includes(bindLabel),
    50,
    80
  );
  assert.ok(
    !(afterBindDelete.appBindLabels || []).includes(bindLabel),
    `delete should drop the link toast=${afterBindDelete.toast} labels=${JSON.stringify(afterBindDelete.appBindLabels)} hidden=${afterBindDelete.appBindDeleteHidden}`
  );

  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-action="switch-profile"][data-profile="0"]\')?.click()'
  );
  await waitUntil((s) => s.activeProfile === 0, 40, 50);
  const rebound = await win.webContents.executeJavaScript(
    'window.__maicongHarness.bindProfileApp(2, { bundleId: "com.mock.game", displayName: "Mock Game" })'
  );
  assert.equal(rebound && rebound.success, true, rebound && rebound.error);
  mock.writtenBuffers.length = 0;
  const frontSwitch = await win.webContents.executeJavaScript(
    'window.__maicongHarness.setMockFrontmost({ bundleId: "com.mock.game", displayName: "Mock Game" })'
  );
  assert.equal(frontSwitch && frontSwitch.success, true, frontSwitch && frontSwitch.error);
  const afterFront = await waitUntil((s) => s.activeProfile === 2, 40, 50);
  assert.equal(afterFront.activeProfile, 2);
  assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_BASE), 'frontmost bound app must activate onboard via SET_BASE');
  await win.webContents.executeJavaScript(
    'window.__maicongHarness.setMockFrontmost(null)'
  );
}

module.exports = { run };
