'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../src/i18n.js');

function placeholders(text) {
  return (String(text).match(/\{(\w+)\}/g) || []).sort();
}

describe('app locale catalogs', () => {
  test('defaults to Chinese and interpolates profile labels', () => {
    i18n.setLocale('zh');
    assert.equal(i18n.getLocale(), 'zh');
    assert.equal(i18n.t('tab.lighting'), '灯光');
    assert.equal(i18n.t('tab.others'), '其他');
    assert.equal(i18n.t('sidebar.hardwareActive', { n: 2 }), '键盘当前：配置 2');
  });

  test('English catalog covers the same chrome keys', () => {
    i18n.setLocale('en');
    assert.equal(i18n.t('tab.lighting'), 'Lighting');
    assert.equal(i18n.t('tab.keymap'), 'Key settings');
    assert.equal(i18n.t('nav.scan'), 'Scan');
    i18n.setLocale('zh');
    assert.equal(i18n.t('nav.scan'), '扫描');
  });

  test('unknown locale falls back to Chinese', () => {
    assert.equal(i18n.normalizeLocale('fr'), 'zh');
    i18n.setLocale('not-a-locale');
    assert.equal(i18n.getLocale(), 'zh');
    assert.equal(i18n.t('tab.backup'), '备份');
  });

  test('zh and en catalogs stay symmetric with matching placeholders', () => {
    const zhKeys = Object.keys(i18n.STRINGS.zh).sort();
    const enKeys = Object.keys(i18n.STRINGS.en).sort();
    assert.deepEqual(zhKeys, enKeys);
    assert.equal(zhKeys.length, 795);
    for (const key of zhKeys) {
      assert.deepEqual(
        placeholders(i18n.STRINGS.zh[key]),
        placeholders(i18n.STRINGS.en[key]),
        key
      );
    }
  });

  test('representative toasts interpolate in both locales', () => {
    i18n.setLocale('zh');
    assert.equal(
      i18n.t('toast.keymapApplied', { count: 3, layer: 2, profile: 1 }),
      '已成功将 3 个按键应用到编辑目标配置 1 的层 2！'
    );
    assert.equal(i18n.t('toast.resetDidNotRun', { error: 'busy' }), '恢复出厂设置未执行：busy');
    i18n.setLocale('en');
    assert.equal(
      i18n.t('toast.keymapApplied', { count: 3, layer: 2, profile: 1 }),
      'Successfully applied 3 keys to Layer 2 on edit-target Profile 1!'
    );
    assert.equal(i18n.t('toast.resetDidNotRun', { error: 'busy' }), 'Factory reset did not run: busy');
    assert.notEqual(i18n.t('toast.scanning'), i18n.STRINGS.zh['toast.scanning']);
    i18n.setLocale('zh');
  });
});
