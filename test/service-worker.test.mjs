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
    onInstalled: capture('onInstalled'),
    onStartup: capture('onStartup'),
    // 广播推送（stateChanged）：测试环境无接收方，模拟拒绝以覆盖 broadcast 的 catch
    sendMessage: () => Promise.reject(new Error('no receiver')),
  },
  sidePanel: { setPanelBehavior: async () => {} },
  alarms: { create: () => {}, clear: () => {}, onAlarm: capture('onAlarm') },
  tabs: { onRemoved: capture('onRemoved'), onUpdated: capture('onUpdated') },
};

let idbPutAll, getState, resetStatsRefreshDebounce;
const sendMsg = (msg) => new Promise((resolve) => listeners.onMessage(msg, {}, resolve));

before(async () => {
  ({ resetStatsRefreshDebounce } = await import('../extension/background/service-worker.js'));
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
  const an = (url, status, reason) => ({ targetDomain: 'example.com', url, status, reason, checkedAt: 1 });
  await idbPutAll('analysis', [
    an('https://a.com/1', 'ready', '命中，可发布'),
    an('https://a.com/2', 'captcha', '命中，有验证码'),
    an('https://a.com/3', 'invalid', '页面加载超时，已强制中断加载'),
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
  resetStatsRefreshDebounce();
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

test('getSnapshot：短时间内重复触发去抖，只刷新一次', async () => {
  resetStatsRefreshDebounce();
  const cs = getState().collectState;
  const first = await sendMsg({ type: 'getSnapshot' });
  assert.equal(first.snapshot.collect.discovered, 5); // 第一次正常刷新
  cs.discovered = 77; // 若再次刷新会被覆盖回 5
  const second = await sendMsg({ type: 'getSnapshot' });
  assert.equal(second.snapshot.collect.discovered, 77); // 第二次被去抖跳过，保持原值
  resetStatsRefreshDebounce();
});

test('getSnapshot：resources 由 analysis 命中记录派生（不经内存态），含 enabled/published 标记', async () => {
  const res = await sendMsg({ type: 'getSnapshot' });
  const urls = res.snapshot.resources.map((r) => r.url).sort();
  assert.deepEqual(urls, ['https://a.com/1', 'https://a.com/2']); // invalid 不入选
  assert.ok(res.snapshot.resources.every((r) => r.enabled === true && r.published === false));
  assert.equal('resources' in getState(), false); // 内存态不存资源
});

test('getSnapshot：published 表有记录的 url 标记为已发布', async () => {
  await idbPutAll('published', [{ url: 'https://a.com/1', targetUrl: 'https://me.com', taskId: 't1', publishedAt: 10 }]);
  const res = await sendMsg({ type: 'getSnapshot' });
  assert.equal(res.snapshot.resources.find((r) => r.url === 'https://a.com/1').published, true);
  assert.equal(res.snapshot.resources.find((r) => r.url === 'https://a.com/2').published, false);
});

test('getLibraryResources：取 analysis 表中命中结论（ready/captcha）的记录', async () => {
  const res = await sendMsg({ type: 'getLibraryResources' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.resources.map((r) => r.url), ['https://a.com/1', 'https://a.com/2']); // invalid 不入选，captcha 也算命中
  const row = res.resources[0];
  assert.equal(row.domain, 'a.com');
  assert.equal(row.targetDomain, 'example.com');
  assert.equal(row.type, 'blog_comment');
  assert.equal(row.status, 'ready');
  assert.equal(row.enabled, true); // 旧数据无 enabled 字段，默认启用
  assert.equal(row.published, true); // 上个用例已把 a.com/1 写入 published 表
});

test('setLibraryEnabled：停用只改标记不删数据，快照资源同步停用', async () => {
  const res = await sendMsg({ type: 'setLibraryEnabled', keys: [['example.com', 'https://a.com/1']], enabled: false });
  assert.equal(res.ok, true);
  const lib = await sendMsg({ type: 'getLibraryResources' });
  assert.equal(lib.resources.length, 2); // 数据保留，两条命中记录都还在
  assert.equal(lib.resources.find((r) => r.url === 'https://a.com/1').enabled, false);
  assert.equal(lib.resources.find((r) => r.url === 'https://a.com/2').enabled, true);
  // 快照里的资源（建任务过滤用）同步为停用
  assert.equal(res.snapshot.resources.find((r) => r.url === 'https://a.com/1').enabled, false);
  assert.equal(res.snapshot.resources.find((r) => r.url === 'https://a.com/2').enabled, true);
});

test('setLibraryEnabled：批量启停（总开关）', async () => {
  const keys = [['example.com', 'https://a.com/1'], ['example.com', 'https://a.com/2']];
  await sendMsg({ type: 'setLibraryEnabled', keys, enabled: false });
  let lib = await sendMsg({ type: 'getLibraryResources' });
  assert.ok(lib.resources.every((r) => r.enabled === false));
  await sendMsg({ type: 'setLibraryEnabled', keys, enabled: true });
  lib = await sendMsg({ type: 'getLibraryResources' });
  assert.ok(lib.resources.every((r) => r.enabled === true));
});

test('alarm：SW 回收后卡住的 stopping 状态被收尾为 idle', async () => {
  const cs = getState().collectState;
  cs.status = 'stopping';
  cs.phase = 'phaseStopping';
  listeners.onAlarm({ name: 'bcm-tick' });
  // alarm 处理器是异步 IIFE，轮询等待收尾完成
  for (let i = 0; i < 100 && getState().collectState.status !== 'idle'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(getState().collectState.status, 'idle');
  assert.equal(getState().collectState.phase, 'stopCollect');
});
