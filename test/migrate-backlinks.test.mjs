/**
 * 旧版 backlinks 从 chrome.storage 到 IndexedDB 的一次性迁移测试：
 * load() 时把 bcm_store.backlinks 写入 IDB（缺 targetDomain 的用当时目标域名补齐），
 * 并从 chrome.storage 移除；此后 save() 不再写 backlinks 字段。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

// 旧版遗留数据：一条带 targetDomain，一条缺 targetDomain（用 collectState.targetDomain 补齐）
mem.set('bcm_store', {
  collectState: { status: 'idle', targetDomain: 'legacy.com' },
  backlinks: [
    { targetDomain: 'legacy.com', url: 'https://a.com/1', domain: 'a.com', addedAt: 1 },
    { url: 'https://a.com/2', domain: 'a.com', addedAt: 2 },
  ],
});

const { load, getState, save } = await import('../extension/lib/storage.js');
const { idbGetAll } = await import('../extension/lib/idb.js');

test('load 时旧版 chrome.storage backlinks 迁移到 IndexedDB 并移除原字段', async () => {
  await load();
  const rows = await idbGetAll('backlinks');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.targetDomain, r.url]).sort(), [
    ['legacy.com', 'https://a.com/1'],
    ['legacy.com', 'https://a.com/2'], // 缺失的 targetDomain 已补齐
  ]);
  assert.equal(mem.get('bcm_store').backlinks, undefined); // 原字段已移除
  assert.equal('backlinks' in getState(), false);          // 内存态不再有该字段
});

test('save 不再把 backlinks 写进 chrome.storage', async () => {
  await save(); // 全量保存
  assert.equal(mem.get('bcm_store').backlinks, undefined);
});
