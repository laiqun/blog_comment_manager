/**
 * 持久化状态存储（chrome.storage.local 的内存镜像）。
 * MV3 service worker 随时可能被杀，所有状态变更后必须 save()。
 * 大数据量表（backlinks / analysis / published）只存 IndexedDB，不进 chrome.storage。
 */
import { DEFAULT_SETTINGS, LIMITS } from './config.js';
import { idbPutAll, idbClear } from './idb.js';

const STORAGE_KEY = 'bcm_store';

const EMPTY_COLLECT = () => ({
  status: 'idle',        // idle | running | stopping
  mode: 'collect',       // collect=抓外链数据 / analyze=逐条分析
  targetDomain: '',
  provider: 'semrush',
  phase: '',             // 当前阶段文案，如「正在分析外链页面...」
  discovered: 0,
  analyzed: 0,
  matched: 0,
  queued: 0,
  queue: [],
  seeds: [],             // 滚雪球发现的同行域名
  seen: [],              // 已见过的外链 URL（去重）
  providerTabId: null,
  analyzeTabId: null,
  startedAt: 0,
});

const state = {
  settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
  collectState: EMPTY_COLLECT(),
  tasks: [],             // {id, name, targetUrl, mode, resourceUrls, status, results:{url:'success'|'skip'|'fail'|'captcha'}, createdAt, finishedAt}
  activeTaskId: null,
  publishRuntime: null,  // {taskId, resourceUrl, stage, tabId}
  logs: [],              // {t, src, msg, level, url}
  loaded: false,
};

export function getState() {
  return state;
}

export async function load() {
  if (state.loaded) return state;
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const saved = data[STORAGE_KEY];
  if (saved) {
    Object.assign(state, {
      settings: { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...saved.settings, models: { ...DEFAULT_SETTINGS.models, ...(saved.settings?.models || {}) }, identity: { ...DEFAULT_SETTINGS.identity, ...(saved.settings?.identity || {}) } },
      collectState: { ...EMPTY_COLLECT(), ...(saved.collectState || {}) },
      tasks: saved.tasks || [],
      activeTaskId: saved.activeTaskId ?? null,
      publishRuntime: saved.publishRuntime || null,
      logs: saved.logs || [],
    });
  }
  state.loaded = true;
  await migrateBacklinksToIdb(saved);
  return state;
}

/** 旧版 backlinks 双写在 chrome.storage：一次性迁移到 IndexedDB（唯一持久层）后从 storage 移除 */
async function migrateBacklinksToIdb(saved) {
  const rows = saved && saved.backlinks;
  if (!Array.isArray(rows) || !rows.length) return;
  try {
    // 更老的记录可能缺 targetDomain（IDB 主键之一），用当时的目标域名补齐
    const domain = saved.collectState?.targetDomain || '';
    const valid = rows
      .filter((r) => r && r.url)
      .map((r) => (r.targetDomain ? r : { ...r, targetDomain: domain }))
      .filter((r) => r.targetDomain);
    if (valid.length) await idbPutAll('backlinks', valid);
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const cur = data[STORAGE_KEY] || {};
    delete cur.backlinks;
    await chrome.storage.local.set({ [STORAGE_KEY]: cur });
  } catch { /* IDB 不可用时保留原样，下次启动再迁移 */ }
}

export async function save(...keys) {
  const all = ['settings', 'collectState', 'tasks', 'activeTaskId', 'publishRuntime', 'logs'];
  const list = keys && keys.length ? keys : all;
  const payload = {};
  for (const k of list) {
    payload[k] = state[k];
  }
  // 合并写入：chrome.storage 的 set 是整个 key 覆盖，直接写 payload 会把未保存的其它字段抹掉
  const data = await chrome.storage.local.get(STORAGE_KEY);
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...(data[STORAGE_KEY] || {}), ...payload } });
}

export async function clearAll() {
  await chrome.storage.local.remove(STORAGE_KEY);
  state.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  state.collectState = EMPTY_COLLECT();
  state.tasks = [];
  state.activeTaskId = null;
  state.publishRuntime = null;
  state.logs = [];
  for (const s of ['backlinks', 'analysis', 'published']) idbClear(s).catch(() => {});
}

// ---------- 日志 ----------

export function addLog(src, msg, level = 'info', url = '') {
  state.logs.push({ t: Date.now(), src, msg, level, url });
  if (state.logs.length > LIMITS.logCap) state.logs.splice(0, state.logs.length - LIMITS.logCap);
}

// ---------- 资源 ----------
// 可用资源复用 IndexedDB analysis 表（命中结论 ready/captcha 的记录，含 enabled 启停标记），
// 已发过的外链在 published 表；均不进内存态，每次读写直接走 IndexedDB（见 idb.js）。

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// ---------- 任务 ----------

export function findTask(id) {
  return state.tasks.find((t) => t.id === id);
}

export function taskCounts(task) {
  const results = Object.values(task.results || {});
  const processed = results.length;
  const success = results.filter((v) => v === 'success').length;
  const failed = results.filter((v) => v === 'fail').length;
  const skipped = results.filter((v) => v === 'skip' || v === 'captcha').length;
  const total = (task.resourceUrls || []).length;
  const pending = Math.max(state.publishRuntime?.taskId === task.id && state.publishRuntime.stage === 'awaiting_review' ? 1 : 0, 0);
  return { total, success, failed, skipped, pending, remaining: Math.max(total - processed, 0) };
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
