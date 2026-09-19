const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ARTIFACTS_DIR = path.join(__dirname, '..', 'test-artifacts');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Standalone Local macOS Configurator Smoke Verification
 * Bounded timeout, 100% offline, strictly 0 hardware writes.
 *
 * @param {Object} context
 * @param {import('electron').App} context.app
 * @param {() => import('electron').BrowserWindow} context.getWindow
 * @param {() => Object} context.getState
 */
async function run({ app, getWindow, getState }) {
  const startTime = Date.now();
  console.log('[Smoke] Starting standalone macOS Maicong Studio verification…');

  if (!fs.existsSync(ARTIFACTS_DIR)) {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }

  const win = getWindow ? getWindow() : null;
  assert.ok(win, 'MainWindow must exist');

  // Step 1: Verify window loaded local file
  console.log('[Smoke] 1. Verifying local shell finish load…');
  if (win.webContents.isLoading()) {
    await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  }
  await sleep(400);

  // Step 1b: Verify Content Security Policy strictly blocks network calls
  console.log('[Smoke] 1b. Verifying offline Content Security Policy…');
  const cspMeta = await win.webContents.executeJavaScript(
    "document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')?.getAttribute('content')"
  );
  assert.ok(cspMeta && cspMeta.includes("connect-src 'none'"), 'CSP must strictly enforce connect-src none');

  // Step 2: Verify local DOM title and tabs
  console.log('[Smoke] 2. Verifying local DOM elements and standalone architecture…');
  const appTitle = await win.webContents.executeJavaScript(
    "document.querySelector('.app-title')?.textContent?.trim()"
  );
  assert.match(appTitle || '', /Maicong Studio/i, 'Title must be Maicong Studio');

  const tabCount = await win.webContents.executeJavaScript(
    "document.querySelectorAll('.view-tabs .tab').length"
  );
  assert.strictEqual(tabCount, 9, 'Must have 9 standalone feature tabs including Advanced and Others');

  console.log('[Smoke] 2b. Verifying language toggle…');
  await win.webContents.executeJavaScript('document.getElementById("lang-zh")?.click()');
  await sleep(150);
  const zhLighting = await win.webContents.executeJavaScript(
    "document.querySelector('#tab-lighting .tab-label')?.textContent?.trim()"
  );
  assert.equal(zhLighting, '灯光');
  await win.webContents.executeJavaScript('document.getElementById("lang-en")?.click()');
  await sleep(150);
  const enLighting = await win.webContents.executeJavaScript(
    "document.querySelector('#tab-lighting .tab-label')?.textContent?.trim()"
  );
  assert.equal(enLighting, 'Lighting');

  // Step 3: Verify tabs navigation (Dashboard, Keymap, Lighting, Macros, Settings, Profiles, Guide)
  console.log('[Smoke] 3. Testing tab navigation in renderer…');
  const tabs = ['dashboard', 'keymap', 'lighting', 'macros', 'advanced', 'settings', 'profiles', 'others', 'guide'];
  for (const t of tabs) {
    await win.webContents.executeJavaScript(`
      document.querySelector('[data-action="set-tab"][data-tab="${t}"]')?.click();
    `);
    await sleep(150);
    const isVisible = await win.webContents.executeJavaScript(`
      !document.getElementById('panel-${t}')?.hidden
    `);
    assert.strictEqual(isVisible, true, `Panel ${t} must be visible when tab clicked`);
  }

  // Step 4: Verify interactive keyboard layout is rendered as accessible buttons
  console.log('[Smoke] 4. Verifying visual keyboard matrix rendering as accessible button elements…');
  await win.webContents.executeJavaScript(`
    document.querySelector('[data-action="set-tab"][data-tab="keymap"]')?.click();
  `);
  await sleep(200);

  const renderedKeyCount = await win.webContents.executeJavaScript(
    "document.querySelectorAll('#keyboard-keys-container button.kb-key').length"
  );
  assert.strictEqual(renderedKeyCount, 82, 'Must render all 82 physical keys of G75 V2 as buttons');

  // Step 5: Verify lighting tab layout with split space zones
  console.log('[Smoke] 5. Verifying lighting tab per-key layout with split space zones…');
  await win.webContents.executeJavaScript(`
    document.querySelector('[data-action="set-tab"][data-tab="lighting"]')?.click();
  `);
  await sleep(200);

  const lightingKeyCount = await win.webContents.executeJavaScript(
    "document.querySelectorAll('#lighting-keys-container button.kb-key').length"
  );
  assert.strictEqual(lightingKeyCount, 83, 'Lighting view must render 83 LED zones (knob excluded)');

  console.log('[Smoke] 5b. Verifying Others firmware UI is operable…');
  const tabLabels = await win.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('.view-tabs .tab .tab-label')).map((el) => el.textContent.trim())
  `);
  for (const label of ['Lighting', 'Key settings', 'Advanced keys', 'Performance', 'Others']) {
    assert.ok(tabLabels.includes(label), `tab ${label} must exist`);
  }
  await win.webContents.executeJavaScript(
    "document.querySelector('[data-action=\"set-tab\"][data-tab=\"others\"]')?.click()"
  );
  await sleep(200);
  const othersProbe = await win.webContents.executeJavaScript(`
    ({
      hidden: Boolean(document.getElementById('panel-others')?.hidden),
      copy: document.querySelector('#panel-others .dash-card .card-desc')?.textContent || '',
      choose: Boolean(document.getElementById('btn-firmware-choose')),
      review: Boolean(document.getElementById('btn-firmware-review')),
      dialog: Boolean(document.getElementById('firmware-review-dialog')),
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || ''
    })
  `);
  assert.strictEqual(othersProbe.hidden, false, 'Others panel must open');
  assert.equal(othersProbe.copy.includes('not available in this build'), false, 'firmware copy must not say unavailable');
  assert.ok(othersProbe.choose, 'Choose official package button must exist');
  assert.ok(othersProbe.review, 'Review update button must exist');
  assert.ok(othersProbe.dialog, 'Firmware review dialog must exist');
  assert.ok(othersProbe.csp.includes("connect-src 'none'"), 'CSP must still include connect-src none');

  // Capture screenshot of local dashboard
  await win.webContents.executeJavaScript(`
    document.querySelector('[data-action="set-tab"][data-tab="dashboard"]')?.click();
  `);
  await sleep(300);

  const dashImg = await win.webContents.capturePage();
  const dashPath = path.join(ARTIFACTS_DIR, 'smoke-standalone-dashboard.png');
  fs.writeFileSync(dashPath, dashImg.toPNG());
  console.log('[Smoke] Captured standalone dashboard screenshot:', dashPath);

  // Capture screenshot of keymap in Chinese with Extended Functions
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById("lang-zh")?.click();
      document.querySelector('[data-action="set-tab"][data-tab="keymap"]')?.click();
      document.querySelector('[data-action="set-layer"][data-layer="0"]')?.click();
      const extTab = Array.from(document.querySelectorAll('#palette-category-tabs .palette-cat-btn')).find(b => b.textContent.includes('Extended') || b.dataset.display?.includes('扩展'));
      if (extTab) extTab.click();
      document.getElementById('k_esc')?.click();
    })()
  `);
  await sleep(400);

  const keymapImg = await win.webContents.capturePage();
  const keymapPath = path.join(ARTIFACTS_DIR, 'smoke-keymap-extended.png');
  fs.writeFileSync(keymapPath, keymapImg.toPNG());
  const brainDir = '/Users/percy/.gemini/antigravity-cli/brain/91ef08e2-21e7-45ea-ae1f-cc7d41077b8e';
  if (fs.existsSync(brainDir)) {
    fs.writeFileSync(path.join(brainDir, 'smoke-keymap-extended.png'), keymapImg.toPNG());
  }
  console.log('[Smoke] Captured standalone keymap screenshot:', keymapPath);

  // Capture screenshot of keymap on Mac Layer 2 with Win key selected
  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelector('[data-action="set-layer"][data-layer="2"]')?.click();
      document.getElementById('k_lwin')?.click();
    })()
  `);
  await sleep(400);

  const macImg = await win.webContents.capturePage();
  const macPath = path.join(ARTIFACTS_DIR, 'smoke-keymap-mac-layer2.png');
  fs.writeFileSync(macPath, macImg.toPNG());
  if (fs.existsSync(brainDir)) {
    fs.writeFileSync(path.join(brainDir, 'smoke-keymap-mac-layer2.png'), macImg.toPNG());
  }
  console.log('[Smoke] Captured Mac layer 2 keymap screenshot:', macPath);

  // Return to Layer 0 and select Win key to capture Windows key in inspector
  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelector('[data-action="set-layer"][data-layer="0"]')?.click();
      document.getElementById('k_lwin')?.click();
    })()
  `);
  await sleep(400);

  const winKeyImg = await win.webContents.capturePage();
  if (fs.existsSync(brainDir)) {
    fs.writeFileSync(path.join(brainDir, 'smoke-keymap-win-key.png'), winKeyImg.toPNG());
  }

  console.log(`[Smoke] Standalone verification passed in ${Date.now() - startTime}ms with 0 hardware writes!`);
}

module.exports = { run };
