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
      remove: async (key) => { for (const k of [].concat(key)) mem.delete(key); },
    },
  },
};

const { load, getState, save, addLog, taskCounts, uid, domainOf } =
  await import('../extension/lib/storage.js');
const { LIMITS } = await import('../extension/lib/config.js');
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('taskCounts 统计成功/失败/跳过/待审核/剩余', async () => {
  await load();
  const st = getState();
  const urls = ['https://a.com/1', 'https://a.com/2', 'https://a.com/3', 'https://a.com/4'];
  const task = { id: 't', name: 'n', targetUrl: '', mode: 'semi', resourceUrls: urls, status: 'running', results: {}, createdAt: 0, finishedAt: 0 };
  st.tasks.push(task);
  task.results[urls[0]] = 'success';
  task.results[urls[1]] = 'fail';
  task.results[urls[2]] = 'skip';
  st.publishRuntime = { taskId: 't', resourceUrl: urls[3], stage: 'awaiting_review', tabId: null };
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

test('save 不把大数据表写进 chrome.storage', async () => {
  await save(); // 全量保存
  const stored = mem.get('bcm_store');
  assert.equal(stored.resources, undefined); // 旧版字段也不再出现
  assert.equal(stored.backlinks, undefined);
  assert.equal(stored.analysis, undefined);
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
