/**
 * service-worker 集成测试：getSnapshot 时从 IndexedDB 刷新收集统计。
 * 口径：已发现=backlinks 表条数；已分析=analysis 表条数；
 *      队列中=backlinks 未分析的；博客评论资源=analysis 中 ready/captcha 条数。
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
    onConnect: capture('onConnect'),
    onInstalled: capture('onInstalled'),
    onStartup: capture('onStartup'),
  },
  sidePanel: { setPanelBehavior: async () => {} },
  alarms: { create: () => {}, clear: () => {}, onAlarm: capture('onAlarm') },
  tabs: { onRemoved: capture('onRemoved'), onUpdated: capture('onUpdated') },
};

let idbPutAll, getState;
const sendMsg = (msg) => new Promise((resolve) => listeners.onMessage(msg, {}, resolve));

before(async () => {
  await import('../extension/background/service-worker.js');
  ({ idbPutAll } = await import('../extension/lib/idb.js'));
  ({ getState } = await import('../extension/lib/storage.js'));

  storeData.bcm_store = {
    collectState: {
      status: 'idle', mode: 'collect', targetDomain: 'example.com',
      discovered: 0, analyzed: 0, matched: 0, queued: 0,
      queue: [], seeds: [], seen: [],
    },
  };
  const bl = (url) => ({ targetDomain: 'example.com', url, domain: 'b.com', addedAt: 2 });
  await idbPutAll('backlinks', [
    bl('https://a.com/1'), bl('https://a.com/2'), bl('https://a.com/3'),
    bl('https://a.com/4'), bl('https://a.com/5'),
    { targetDomain: 'other.com', url: 'https://x.com/9', domain: 'x.com', addedAt: 1 }, // 其它域名不计入
  ]);
  const an = (url, status) => ({ targetDomain: 'example.com', url, status, checkedAt: 1 });
  await idbPutAll('analysis', [
    an('https://a.com/1', 'ready'),
    an('https://a.com/2', 'captcha'),
    an('https://a.com/3', 'invalid'),
  ]);
});

test('getSnapshot：空闲时按 IndexedDB 口径刷新四个统计', async () => {
  const res = await sendMsg({ type: 'getSnapshot' });
  assert.equal(res.ok, true);
  const c = res.snapshot.collect;
  assert.equal(c.discovered, 5); // backlinks 表该域名条数
  assert.equal(c.analyzed, 3);   // analysis 表条数
  assert.equal(c.queued, 2);     // backlinks 未分析（5 - 3）
  assert.equal(c.matched, 2);    // analysis 中 ready/captcha
});

test('getSnapshot：运行中不刷新，保持运行态计数', async () => {
  const cs = getState().collectState;
  cs.status = 'running';
  cs.discovered = 99;
  const res = await sendMsg({ type: 'getSnapshot' });
  assert.equal(res.snapshot.collect.discovered, 99);
  cs.status = 'idle';
});

test('getSnapshot：targetDomain 丢失时从 IndexedDB 恢复最近收集的域名', async () => {
  const cs = getState().collectState;
  cs.targetDomain = '';
  const res = await sendMsg({ type: 'getSnapshot' });
  assert.equal(res.snapshot.collect.targetDomain, 'example.com'); // addedAt 最新的域名
  assert.equal(res.snapshot.collect.discovered, 5);
  assert.equal(res.snapshot.collect.analyzed, 3);
  assert.equal(res.snapshot.collect.queued, 2);
  assert.equal(res.snapshot.collect.matched, 2);
  assert.equal(cs.targetDomain, 'example.com'); // 已写回状态
});
