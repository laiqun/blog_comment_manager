import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGES, t, setLanguage, getLanguage } from '../extension/lib/i18n.js';

test('中英字典 key 完全对齐（防止漏翻译）', () => {
  for (const [key, val] of Object.entries(MESSAGES)) {
    assert.ok(val.zh, `缺少中文文案: ${key}`);
    assert.ok(val.en, `缺少英文文案: ${key}`);
  }
});

test('t() 双语切换', () => {
  setLanguage('zh');
  assert.equal(t('tab_collect'), '收集');
  setLanguage('en');
  assert.equal(t('tab_collect'), 'Collect');
  assert.equal(getLanguage(), 'en');
  setLanguage('zh');
});

test('t() 参数插值', () => {
  assert.equal(t('countLine', { n: 226 }), '共 226 条资源');
  setLanguage('en');
  assert.equal(t('countLine', { n: 226 }), '226 resources');
  setLanguage('zh');
});

test('t() 未知 key 返回 key 本身（便于发现漏配）', () => {
  assert.equal(t('no_such_key'), 'no_such_key');
});
