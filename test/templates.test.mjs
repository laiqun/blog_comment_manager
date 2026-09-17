/**
 * 任务模板测试：saveTemplate / getTemplates / deleteTemplate 消息（IndexedDB templates 表，主键 name）。
 * 覆盖：保存-读取-同名覆盖（编辑）-删除，以及名称空白时的报错。
 * 打内存版 chrome.* / indexedDB 最小桩，不启动浏览器。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installIdbStub } from './stubs.mjs';

installIdbStub();

// ---------- 内存版 chrome.* 最小桩 ----------
const storeData = {};
const listeners = {};
const capture = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => (k in storeData ? { [k]: storeData[k] } : {}),
      set: async (obj) => { Object.assign(storeData, obj); },
      remove: async (k) => { delete storeData[k]; },
    },
  },
  runtime: {
    onMessage: capture('onMessage'),
    onInstalled: capture('onInstalled'),
    onStartup: capture('onStartup'),
    sendMessage: () => Promise.reject(new Error('no receiver')),
  },
  sidePanel: { setPanelBehavior: async () => {} },
  alarms: { create: () => {}, clear: () => {}, onAlarm: capture('onAlarm') },
  tabs: { onRemoved: capture('onRemoved'), onUpdated: capture('onUpdated') },
};

const sendMsg = (msg) => new Promise((resolve) => listeners.onMessage(msg, {}, resolve));

before(async () => {
  await import('../extension/background/service-worker.js');
});

const tpl = (over = {}) => ({
  type: 'saveTemplate',
  name: 'Canva 模板',
  targetUrl: 'https://www.canva.com/',
  siteIntro: '在线设计工具',
  mainKeyword: 'canva',
  ...over,
});

test('saveTemplate：保存后可从 getTemplates 读回', async () => {
  const res = await sendMsg(tpl());
  assert.equal(res.ok, true);
  const list = await sendMsg({ type: 'getTemplates' });
  assert.equal(list.templates.length, 1);
  assert.deepEqual(
    list.templates.map((x) => [x.name, x.targetUrl, x.siteIntro, x.mainKeyword]),
    [['Canva 模板', 'https://www.canva.com/', '在线设计工具', 'canva']],
  );
  assert.ok(list.templates[0].updatedAt > 0);
});

test('saveTemplate：同名覆盖即编辑（不新增条数，字段更新）', async () => {
  const res = await sendMsg(tpl({ mainKeyword: 'design' }));
  assert.equal(res.ok, true);
  assert.equal(res.templates.length, 1);
  assert.equal(res.templates[0].mainKeyword, 'design');
});

test('saveTemplate：名称空白报错，不落库', async () => {
  const res = await sendMsg(tpl({ name: '   ' }));
  assert.equal(res.ok, false);
  const list = await sendMsg({ type: 'getTemplates' });
  assert.equal(list.templates.length, 1); // 仍是上一条
});

test('deleteTemplate：按名称删除；删不存在的名称报错', async () => {
  const bad = await sendMsg({ type: 'deleteTemplate', name: ' ' });
  assert.equal(bad.ok, false);
  const res = await sendMsg({ type: 'deleteTemplate', name: 'Canva 模板' });
  assert.equal(res.ok, true);
  assert.equal(res.templates.length, 0);
});
