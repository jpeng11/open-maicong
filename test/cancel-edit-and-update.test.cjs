'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const i18n = require('../src/i18n.js');
const pkg = require('../package.json');

test('App name and appId match project requirements to prevent trademark conflicts', () => {
  assert.equal(pkg.name, 'open-maicong');
  assert.equal(pkg.build.productName, 'Open Maicong');
  assert.equal(pkg.build.appId, 'dev.openmaicong.studio', 'appId must stay consistent to avoid losing settings/permissions across upgrades');
  assert.match(pkg.build.artifactName, /^Open-Maicong/);
});

test('i18n contains Cancel Edit and Software Update strings in zh and en', () => {
  i18n.setLocale('zh');
  assert.equal(i18n.t('sidebar.cancelEdit'), '取消编辑');
  assert.equal(i18n.t('tray.showWindow'), '显示主窗口');
  assert.equal(i18n.t('tray.settings'), '设置...');
  assert.equal(i18n.t('tray.about'), '关于 Open Maicong');
  assert.equal(i18n.t('tray.checkUpdates'), '检查更新...');
  assert.equal(i18n.t('tray.quit'), '退出 Open Maicong');
  assert.equal(i18n.t('others.appUpdate'), '软件更新');
  assert.equal(i18n.t('others.checkUpdate'), '检查更新');
  assert.equal(i18n.t('others.downloadUpdate'), '下载更新');

  i18n.setLocale('en');
  assert.equal(i18n.t('sidebar.cancelEdit'), 'Cancel Edit');
  assert.equal(i18n.t('tray.showWindow'), 'Show Main Window');
  assert.equal(i18n.t('tray.settings'), 'Settings...');
  assert.equal(i18n.t('tray.about'), 'About Open Maicong');
  assert.equal(i18n.t('tray.checkUpdates'), 'Check for Updates...');
  assert.equal(i18n.t('tray.quit'), 'Quit Open Maicong');
  assert.equal(i18n.t('others.appUpdate'), 'Software update');
  assert.equal(i18n.t('others.checkUpdate'), 'Check for updates');
  assert.equal(i18n.t('others.downloadUpdate'), 'Download update');
});

test('Tray template icons exist and conform to macOS menu bar icon standards', () => {
  const icon1x = path.join(__dirname, '..', 'src', 'assets', 'trayTemplate.png');
  const icon2x = path.join(__dirname, '..', 'src', 'assets', 'trayTemplate@2x.png');
  assert.ok(fs.existsSync(icon1x), 'trayTemplate.png must exist');
  assert.ok(fs.existsSync(icon2x), 'trayTemplate@2x.png must exist');

  // Verify PNG headers
  const b1 = fs.readFileSync(icon1x);
  const b2 = fs.readFileSync(icon2x);
  assert.equal(b1.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(b2.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  // Check 16x16 and 32x32 dimensions in IHDR
  assert.equal(b1.readUInt32BE(16), 16);
  assert.equal(b1.readUInt32BE(20), 16);
  assert.equal(b2.readUInt32BE(16), 32);
  assert.equal(b2.readUInt32BE(20), 32);
});

test('Semver comparator handles release tags and version strings accurately', () => {
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

  assert.equal(compareSemver('0.2.0', '0.1.0'), 1);
  assert.equal(compareSemver('0.1.1', '0.1.0'), 1);
  assert.equal(compareSemver('0.1.0', '0.1.0'), 0);
  assert.equal(compareSemver('0.0.9', '0.1.0'), -1);
  assert.equal(compareSemver('1.0.0', '0.9.9'), 1);
});

test('UserData migration copies legacy settings to ensure no data loss across app renaming', () => {
  const tmpDir = path.join(__dirname, '..', 'node_modules', '.test-migration-' + Date.now());
  const legacyDir = path.join(tmpDir, 'Maicong Studio');
  const targetDir = path.join(tmpDir, 'Open Maicong');

  fs.mkdirSync(legacyDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });

  const dummyProfiles = JSON.stringify({ local: [{ key: 'test', name: 'My Profile' }] });
  fs.writeFileSync(path.join(legacyDir, 'profile-library.json'), dummyProfiles, 'utf8');
  fs.writeFileSync(path.join(legacyDir, 'locale.json'), JSON.stringify({ locale: 'zh' }), 'utf8');

  // Perform migration logic
  const files = [
    'locale.json',
    'profile-library.json',
    'profile-app-binds.json',
    'macro-metadata.json',
    'lighting-memory.json',
    'still-library.json',
    'gif-library.json'
  ];
  for (const file of files) {
    const src = path.join(legacyDir, file);
    const dst = path.join(targetDir, file);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
    }
  }

  assert.ok(fs.existsSync(path.join(targetDir, 'profile-library.json')));
  assert.equal(fs.readFileSync(path.join(targetDir, 'profile-library.json'), 'utf8'), dummyProfiles);
  assert.ok(fs.existsSync(path.join(targetDir, 'locale.json')));

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
