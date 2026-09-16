/**
 * 持久化状态存储（chrome.storage.local 的内存镜像）。
 * MV3 service worker 随时可能被杀，所有状态变更后必须 save()。
 */
import { DEFAULT_SETTINGS, LIMITS } from './config.js';
import { idbPutAll, idbPut, idbDelete, idbGetAll, idbClear } from './idb.js';

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
  resources: [],         // {id, url, domain, type:'blog_comment'|'profile', status:'ready'|'published'|'failed'|'captcha', addedAt, publishedAt}
  collectState: EMPTY_COLLECT(),
  tasks: [],             // {id, name, targetUrl, mode, resourceIds, status, results:{id:'success'|'skip'|'fail'|'captcha'}, createdAt, finishedAt}
  activeTaskId: null,
  publishRuntime: null,  // {taskId, resourceId, stage, tabId}
  logs: [],              // {t, src, msg, level, url}
  backlinks: [],         // 收集数据集（JSON）：{url, domain, anchor, targetUrl, ascore, nofollow, sitewide, page, addedAt}
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
      resources: saved.resources || [],
      collectState: { ...EMPTY_COLLECT(), ...(saved.collectState || {}) },
      tasks: saved.tasks || [],
      activeTaskId: saved.activeTaskId ?? null,
      publishRuntime: saved.publishRuntime || null,
      logs: saved.logs || [],
      backlinks: saved.backlinks || [],
    });
  }
  state.loaded = true;
  await restoreResourcesFromIdb();
  return state;
}

/** 资源库以 IndexedDB 为持久层：启动时恢复；旧数据（仅在 chrome.storage）自动迁移过去 */
async function restoreResourcesFromIdb() {
  try {
    const rows = await idbGetAll('resources');
    if (rows.length) {
      state.resources = rows;
    } else if (state.resources.length) {
      await idbPutAll('resources', state.resources); // 旧数据迁移
    }
  } catch { /* IndexedDB 不可用时继续用 chrome.storage 的数据 */ }
}

export async function save(...keys) {
  const all = ['settings', 'resources', 'collectState', 'tasks', 'activeTaskId', 'publishRuntime', 'logs', 'backlinks'];
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
  state.resources = [];
  state.collectState = EMPTY_COLLECT();
  state.tasks = [];
  state.activeTaskId = null;
  state.publishRuntime = null;
  state.logs = [];
  state.backlinks = [];
  for (const s of ['backlinks', 'analysis', 'resources']) idbClear(s).catch(() => {});
}

// ---------- 日志 ----------

export function addLog(src, msg, level = 'info', url = '') {
  state.logs.push({ t: Date.now(), src, msg, level, url });
  if (state.logs.length > LIMITS.logCap) state.logs.splice(0, state.logs.length - LIMITS.logCap);
}

// ---------- 资源库 ----------

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export async function addResource({ url, type, note = '' }) {
  if (state.resources.some((r) => r.url === url)) return false;
  const r = {
    id: uid(),
    url,
    domain: domainOf(url),
    type, // 'blog_comment' | 'profile'
    status: 'ready', // ready | published | failed | captcha
    addedAt: Date.now(),
    publishedAt: 0,
    note,
  };
  state.resources.unshift(r);
  idbPut('resources', r).catch(() => {}); // 持久镜像到 IndexedDB
  return true;
}

export function findResource(id) {
  return state.resources.find((r) => r.id === id);
}

export async function updateResource(id, patch) {
  const r = findResource(id);
  if (r) {
    Object.assign(r, patch);
    idbPut('resources', r).catch(() => {}); // 持久镜像到 IndexedDB
  }
  return r;
}

export async function removeResource(id) {
  const i = state.resources.findIndex((r) => r.id === id);
  if (i >= 0) {
    const [r] = state.resources.splice(i, 1);
    idbDelete('resources', r.url).catch(() => {}); // 同步删除 IndexedDB
  }
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
  const total = task.resourceIds.length;
  const pending = Math.max(state.publishRuntime?.taskId === task.id && state.publishRuntime.stage === 'awaiting_review' ? 1 : 0, 0);
  return { total, success, failed, skipped, pending, remaining: Math.max(total - processed, 0) };
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
