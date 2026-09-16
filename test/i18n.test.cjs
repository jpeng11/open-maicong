'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../src/i18n.js');

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
});
