/**
 * IndexedDB v1 → v2 迁移测试：
 * 旧 resources 表中 status=published 的记录迁入 published 表（当时未记录目标网址，targetUrl 置空），
 * 未发布的记录不迁移，resources 表删除；其余 store 照常创建。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installIdbStub } from './stubs.mjs';

const stores = installIdbStub();

// 预置 v1 的 resources 表（首次 open 触发升级前）
const row = (value) => ({ key: [value.url], value });
stores.set('resources', {
  keyPath: ['url'],
  rows: new Map([
    [JSON.stringify(['https://a.com/1']), row({ url: 'https://a.com/1', status: 'published', publishedAt: 5 })],
    [JSON.stringify(['https://a.com/2']), row({ url: 'https://a.com/2', status: 'ready', publishedAt: 0 })],
  ]),
});

const { idbGetAll } = await import('../extension/lib/idb.js');

test('v1→v2：旧 resources 已发布记录迁入 published 后删表', async () => {
  const rows = await idbGetAll('published'); // 首次 open，触发升级与迁移
  assert.equal(rows.length, 1); // 只有 published 状态的记录被迁移
  assert.deepEqual(rows[0], { url: 'https://a.com/1', targetUrl: '', taskId: '', publishedAt: 5 });
  assert.equal(stores.has('resources'), false); // 旧表已删
  assert.deepEqual(await idbGetAll('analysis'), []); // 其余 store 照常可用
});
