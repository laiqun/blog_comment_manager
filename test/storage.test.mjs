// chrome.storage 最小内存桩：只为让 storage.js 的纯逻辑能跑，非浏览器模拟
import { installIdbStub } from './stubs.mjs';

installIdbStub();

const mem = new Map();
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === 'string') return { [keys]: mem.get(keys) };
        return {};
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) mem.set(k, v); },
      remove: async (key) => { for (const k of [].concat(key)) mem.delete(k); },
    },
  },
};

const { load, getState, save, listResources, addResource, getResourceByUrl, findResource, updateResource, updateResourceByUrl, removeResource, addLog, taskCounts, uid, domainOf } =
  await import('../extension/lib/storage.js');
const { idbGetAll } = await import('../extension/lib/idb.js');
const { LIMITS } = await import('../extension/lib/config.js');
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('addResource 去重且默认状态为可发布', async () => {
  await load();
  const r = await addResource({ url: 'https://a.com/1', type: 'blog_comment' });
  assert.equal(r.status, 'ready');
  assert.equal(r.domain, 'a.com');
  assert.equal(await addResource({ url: 'https://a.com/1', type: 'blog_comment' }), false);
});

test('资源库以 IndexedDB 为唯一持久层，不进内存态', async () => {
  assert.equal('resources' in getState(), false);
  assert.ok(await getResourceByUrl('https://a.com/1'));
  const [first] = await listResources();
  assert.equal(first.url, 'https://a.com/1'); // listResources 按 addedAt 新→旧排序
});

test('findResource / updateResource / updateResourceByUrl / removeResource', async () => {
  const [r] = await listResources();
  assert.ok(await findResource(r.id));
  await updateResource(r.id, { status: 'captcha' });
  assert.equal((await findResource(r.id)).status, 'captcha');
  await updateResourceByUrl(r.url, { status: 'published', publishedAt: 123 });
  assert.equal((await findResource(r.id)).status, 'published');
  await removeResource(r.id);
  assert.equal(await findResource(r.id), undefined);
  assert.equal(await getResourceByUrl(r.url), undefined);
});

test('taskCounts 统计成功/失败/跳过/待审核/剩余', async () => {
  const st = getState();
  const ids = ['r1', 'r2', 'r3', 'r4'];
  const task = { id: 't', name: 'n', targetUrl: '', mode: 'semi', resourceIds: ids, status: 'running', results: {}, createdAt: 0, finishedAt: 0 };
  st.tasks.push(task);
  task.results[ids[0]] = 'success';
  task.results[ids[1]] = 'fail';
  task.results[ids[2]] = 'skip';
  st.publishRuntime = { taskId: 't', resourceId: ids[3], stage: 'awaiting_review', tabId: null };
  const c = taskCounts(task);
  assert.deepEqual(c, { total: 4, success: 1, failed: 1, skipped: 1, pending: 1, remaining: 1 });
  st.publishRuntime = null; // 待审核结束
  assert.equal(taskCounts(task).pending, 0);
  st.tasks.pop();
});

test('addLog 有上限且新日志在末尾', () => {
  for (let i = 0; i < LIMITS.logCap + 10; i++) addLog('collect', `log-${i}`);
  const logs = getState().logs;
  assert.equal(logs.length, LIMITS.logCap);
  assert.equal(logs.at(-1).msg, `log-${LIMITS.logCap + 9}`);
});

test('save 不再把 resources 写进 chrome.storage', async () => {
  await addResource({ url: 'https://s.com/1', type: 'profile' });
  await save(); // 全量保存
  assert.equal(mem.get('bcm_store').resources, undefined);
  assert.ok((await idbGetAll('resources')).some((r) => r.url === 'https://s.com/1'));
  assert.equal(uid().length > 10, true);
});

test('save 部分 key 合并写入，不抹掉其它字段', async () => {
  getState().logs = [{ t: 1, src: 'collect', msg: 'keep-me' }];
  await save('logs');
  await save('tasks'); // 第二次只存 tasks，logs 必须还在
  const stored = mem.get('bcm_store');
  assert.ok(stored.logs && stored.logs.length === 1);
  assert.ok(Array.isArray(stored.tasks));
});

test('domainOf 去掉 www', () => {
  assert.equal(domainOf('https://www.ab.com/x?y=1'), 'ab.com');
  assert.equal(domainOf('not a url'), '');
});
