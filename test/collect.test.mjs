/**
 * CollectController.statsBaseline 口径测试：与空闲时 refreshCollectStatsFromIdb 同口径——
 * 已发现=backlinks 条数；已分析=analysis 条数；队列中=backlinks 里未分析的；
 * 博客评论资源=analysis 中 ready/captcha 条数（与资源库筛选一致）。
 * 打内存版 indexedDB 最小桩，不启动浏览器。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installIdbStub } from './stubs.mjs';

installIdbStub();
// collect.js 经 storage.js 间接引用 chrome.storage：打最小桩让模块可加载
const storeData = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => (k in storeData ? { [k]: storeData[k] } : {}),
      set: async (obj) => { Object.assign(storeData, obj); },
      remove: async (k) => { delete storeData[k]; },
    },
  },
  runtime: { sendMessage: () => Promise.reject(new Error('no receiver')) },
};

let CollectController, idbPutAll;

before(async () => {
  ({ CollectController } = await import('../extension/background/collect.js'));
  ({ idbPutAll } = await import('../extension/lib/idb.js'));
  const bl = (url) => ({ targetDomain: 'example.com', url, domain: 'b.com' });
  await idbPutAll('backlinks', [
    bl('https://a.com/1'), bl('https://a.com/2'), bl('https://a.com/3'),
    bl('https://a.com/4'), bl('https://a.com/5'),
  ]);
  const an = (url, status) => ({ targetDomain: 'example.com', url, status });
  await idbPutAll('analysis', [
    an('https://a.com/1', 'ready'),
    an('https://a.com/2', 'captcha'),
    an('https://a.com/3', 'invalid'),
  ]);
});

test('statsBaseline：四项统计与 IndexedDB 存量口径一致', async () => {
  const c = new CollectController(async () => {});
  const base = await c.statsBaseline('example.com');
  assert.equal(base.discovered, 5); // backlinks 表该域名条数
  assert.equal(base.analyzed, 3);   // analysis 表条数
  assert.equal(base.queued, 2);     // backlinks 未分析（5 - 3）
  assert.equal(base.matched, 2);    // analysis 中 ready/captcha（与资源库筛选一致）
  assert.equal(base.links.length, 5);
  assert.equal(base.rows.length, 3);
});

test('statsBaseline：无数据域名四项全为 0', async () => {
  const c = new CollectController(async () => {});
  const base = await c.statsBaseline('nope.com');
  assert.deepEqual(
    [base.discovered, base.analyzed, base.queued, base.matched],
    [0, 0, 0, 0],
  );
});
