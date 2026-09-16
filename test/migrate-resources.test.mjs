/**
 * 旧版 resources 从 chrome.storage 到 IndexedDB 的一次性迁移测试：
 * load() 时把 bcm_store.resources 写入 IDB（唯一持久层）并从 chrome.storage 移除；
 * 此后内存态不再有 resources 字段，save() 也不再写该字段。
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

// 旧版遗留数据：resources 双写在 chrome.storage
mem.set('bcm_store', {
  resources: [
    { id: 'r1', url: 'https://a.com/1', domain: 'a.com', type: 'blog_comment', status: 'ready', addedAt: 1, publishedAt: 0 },
    { id: 'r2', url: 'https://a.com/2', domain: 'a.com', type: 'profile', status: 'published', addedAt: 2, publishedAt: 3 },
  ],
});

const { load, getState, save, listResources } = await import('../extension/lib/storage.js');
const { idbGetAll } = await import('../extension/lib/idb.js');

test('load 时旧版 chrome.storage resources 迁移到 IndexedDB 并移除原字段', async () => {
  await load();
  const rows = await idbGetAll('resources');
  assert.equal(rows.length, 2);
  assert.equal(mem.get('bcm_store').resources, undefined); // 原字段已移除
  assert.equal('resources' in getState(), false);          // 内存态不再有该字段
  const list = await listResources();
  assert.deepEqual(list.map((r) => r.url), ['https://a.com/2', 'https://a.com/1']); // addedAt 新→旧
  assert.equal(list[0].status, 'published'); // 状态原样保留
});

test('save 不再把 resources 写进 chrome.storage', async () => {
  await save(); // 全量保存
  assert.equal(mem.get('bcm_store').resources, undefined);
});
