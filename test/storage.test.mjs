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

const { load, getState, save, addLog, uid, domainOf } =
  await import('../extension/lib/storage.js');
const { LIMITS } = await import('../extension/lib/config.js');
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('addLog 有上限且新日志在末尾', () => {
  for (let i = 0; i < LIMITS.logCap + 10; i++) addLog('collect', `log-${i}`);
  const logs = getState().logs;
  assert.equal(logs.length, LIMITS.logCap);
  assert.equal(logs.at(-1).msg, `log-${LIMITS.logCap + 9}`);
});

test('日志开关关闭时 addLog 直接丢弃', () => {
  const st = getState();
  st.logs.length = 0;
  st.settings.logEnabled = false;
  const before = st.logs.length;
  addLog('system', 'dropped');
  assert.equal(st.logs.length, before);
  st.settings.logEnabled = true;
  addLog('system', 'kept');
  assert.equal(st.logs.length, before + 1);
  assert.equal(st.logs.at(-1).msg, 'kept');
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
  await save('assistantTask'); // 第二次只存 assistantTask，logs 必须还在
  const stored = mem.get('bcm_store');
  assert.ok(stored.logs && stored.logs.length === 1);
  assert.ok(stored.assistantTask && typeof stored.assistantTask === 'object');
});

test('旧版任务队列数据（tasks/activeTaskId）加载时被一次性清除', async () => {
  // 模拟旧版残留：直接往桩里塞 tasks/activeTaskId，重新加载后应被抹掉
  const cur = mem.get('bcm_store') || {};
  mem.set('bcm_store', { ...cur, tasks: [{ id: 't1' }], activeTaskId: 't1' });
  getState().loaded = false; // 强制重新走 load()
  await load();
  const stored = mem.get('bcm_store');
  assert.equal(stored.tasks, undefined);
  assert.equal(stored.activeTaskId, undefined);
  assert.equal('tasks' in getState(), false); // 内存态也不再有任务队列
});

test('domainOf 去掉 www', () => {
  assert.equal(domainOf('https://www.ab.com/x?y=1'), 'ab.com');
  assert.equal(domainOf('not a url'), '');
});

test('save 兼容数组传参：多 key 数组不再被 coercion 成 "a,b" 垃圾键', async () => {
  getState().collectState.status = 'running';
  getState().logs = [{ t: 2, src: 'collect', msg: 'arr-call' }];
  await save(['collectState', 'logs']); // 控制器经 notify 的调用形式
  const stored = mem.get('bcm_store');
  assert.equal(stored.collectState.status, 'running');
  assert.ok(stored.logs.some((l) => l.msg === 'arr-call'));
  assert.equal(Object.keys(stored).some((k) => k.includes(',')), false);
  // 已有的垃圾键会被合并写入时剔除
  mem.set('bcm_store', { ...mem.get('bcm_store'), 'collectState,logs': { junk: true } });
  await save('logs');
  assert.equal(mem.get('bcm_store')['collectState,logs'], undefined);
});
