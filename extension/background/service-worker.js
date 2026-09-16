/**
 * MV3 Service Worker：消息路由 + 状态快照广播 + 保活与断点续跑。
 */
import {
  load, getState, save, clearAll, addLog,
  addResource, removeResource, findTask, taskCounts, uid, domainOf,
} from '../lib/storage.js';
import { backlinksCsv } from '../lib/util.js';
import { idbGetDomain, idbGetAll, idbDelete } from '../lib/idb.js';
import { CollectController } from './collect.js';
import { PublishRunner } from './publish.js';
import { testKey } from '../lib/openrouter.js';

const ALARM_TICK = 'bcm-tick';
const ports = new Set();

// 点击工具栏图标直接打开侧边栏（无 popup）
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => {
  console.error('[BCM] sidePanel behavior error', e);
});

let collect, publish;

function ensureControllers() {
  const notify = async (...keys) => {
    await save(...keys);
    broadcast();
  };
  if (!collect) collect = new CollectController(notify);
  if (!publish) publish = new PublishRunner(notify);
}

function snapshot() {
  const st = getState();
  return {
    collect: {
      status: st.collectState.status,
      mode: st.collectState.mode || 'collect',
      targetDomain: st.collectState.targetDomain,
      provider: st.collectState.provider,
      phase: st.collectState.phase,
      discovered: st.collectState.discovered,
      analyzed: st.collectState.analyzed,
      matched: st.collectState.matched,
      queued: st.collectState.queued,
      seeds: st.collectState.seeds.length,
    },
    tasks: st.tasks.map((t) => ({
      id: t.id, name: t.name, targetUrl: t.targetUrl,
      siteIntro: t.siteIntro || '', mainKeyword: t.mainKeyword || '',
      mode: t.mode,
      status: t.status, resourceIds: t.resourceIds, results: t.results || {},
      createdAt: t.createdAt, finishedAt: t.finishedAt,
      counts: taskCounts(t),
    })),
    activeTaskId: st.activeTaskId,
    publish: st.publishRuntime
      ? { taskId: st.publishRuntime.taskId, resourceId: st.publishRuntime.resourceId, stage: st.publishRuntime.stage }
      : null,
    resources: st.resources,
    logs: st.logs.slice(-200).reverse(),
    settings: {
      publishMode: st.settings.publishMode,
      language: st.settings.language,
      hasKey: !!st.settings.openrouterKey,
      pageDelayMinMs: st.settings.pageDelayMinMs,
      pageDelayMaxMs: st.settings.pageDelayMaxMs,
    },
  };
}

function broadcast() {
  const msg = { type: 'stateChanged', snapshot: snapshot() };
  for (const p of ports) {
    try { p.postMessage(msg); } catch { /* closed */ }
  }
}

function ensureAlarm(on) {
  if (on) {
    chrome.alarms.create(ALARM_TICK, { periodInMinutes: 0.5 });
  } else {
    chrome.alarms.clear(ALARM_TICK);
  }
}

function isIdle() {
  const st = getState();
  return st.collectState.status === 'idle' && !st.publishRuntime;
}

/**
 * 空闲时把收集统计刷新为 IndexedDB 存量口径（跨轮次累积）：
 * 已发现 = backlinks 表条数；已分析 = analysis 表条数；
 * 队列中 = backlinks 里未分析过的；博客评论资源 = analysis 中命中结论（ready/captcha）条数。
 */
const VALID_STATUSES = ['ready', 'captcha'];
// Chrome 在插件重载后会两次创建 side panel 文档（恢复 + 附着），每次都会发 getSnapshot；
// 短时间内的重复触发去抖，只跑一次
const STATS_REFRESH_DEBOUNCE_MS = 3000;
let lastStatsRefreshAt = 0;
export function resetStatsRefreshDebounce() { lastStatsRefreshAt = 0; } // 测试用
async function refreshCollectStatsFromIdb() {
  if (Date.now() - lastStatsRefreshAt < STATS_REFRESH_DEBOUNCE_MS) return;
  lastStatsRefreshAt = Date.now();
  const st = getState();
  const c = st.collectState;
  if (c.status !== 'idle') {
    addLog('collect', `统计刷新跳过：status=${c.status}`, 'warn');
    await save('logs');
    return;
  }
  try {
    // targetDomain 丢失时（如旧版 save 覆盖写 bug 抹掉持久化状态）从 IndexedDB 恢复最近收集的域名
    if (!c.targetDomain) {
      const all = await idbGetAll('backlinks');
      if (all.length) {
        all.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        c.targetDomain = all[0].targetDomain;
        addLog('collect', `目标域名丢失，已从收集数据恢复：${c.targetDomain}`, 'warn');
        await save('collectState');
      }
    }
    if (!c.targetDomain) {
      addLog('collect', '统计刷新跳过：无目标域名且收集数据为空', 'warn');
      await save('logs');
      return;
    }
    const [links, analysis] = await Promise.all([
      idbGetDomain('backlinks', c.targetDomain),
      idbGetDomain('analysis', c.targetDomain),
    ]);
    const analyzedUrls = new Set(analysis.map((r) => r.url));
    const next = {
      discovered: links.length,
      analyzed: analysis.length,
      queued: links.filter((r) => !analyzedUrls.has(r.url)).length,
      matched: analysis.filter((r) => VALID_STATUSES.includes(r.status)).length,
      seen: links.map((r) => r.url),
    };
    addLog('collect', `统计刷新（${c.targetDomain}）：已发现=${next.discovered} / 已分析=${next.analyzed} / 队列中=${next.queued} / 博客评论资源=${next.matched}`, 'info');
    if (c.discovered !== next.discovered || c.analyzed !== next.analyzed
      || c.queued !== next.queued || c.matched !== next.matched) {
      Object.assign(c, next);
      await save('collectState', 'logs');
      broadcast();
    } else {
      await save('logs');
    }
  } catch (e) {
    addLog('collect', `统计刷新失败：${e.message}`, 'error');
    await save('logs');
  }
}

// ---------------- 消息处理 ----------------

async function handleMessage(msg, sender) {
  await load();
  ensureControllers();

  switch (msg.type) {
    // ---- Popup 拉取与控制 ----
    case 'getSnapshot':
      await refreshCollectStatsFromIdb();
      return { ok: true, snapshot: snapshot() };

    case 'startCollect':
      await collect.start(msg.domain, msg.provider);
      ensureAlarm(true);
      return { ok: true, snapshot: snapshot() };

    case 'stopCollect':
      await collect.stop();
      if (isIdle()) ensureAlarm(false);
      return { ok: true, snapshot: snapshot() };

    case 'startAnalysis':
      await collect.startAnalysis();
      ensureAlarm(true);
      return { ok: true, snapshot: snapshot() };

    case 'createTask': {
      const task = {
        id: uid(),
        name: msg.name || '未命名任务',
        targetUrl: (msg.targetUrl || '').trim(),
        siteIntro: (msg.siteIntro || '').trim(),
        mainKeyword: (msg.mainKeyword || '').trim(),
        mode: msg.mode === 'auto' ? 'auto' : 'semi',
        resourceIds: Array.isArray(msg.resourceIds) ? msg.resourceIds : [],
        status: 'idle',
        results: {},
        createdAt: Date.now(),
        finishedAt: 0,
      };
      getState().tasks.unshift(task);
      addLog('publish', `创建任务「${task.name}」，绑定 ${task.resourceIds.length} 条资源`, 'info');
      await save('tasks', 'logs');
      broadcast();
      await publish.startTask(task.id);
      ensureAlarm(true);
      return { ok: true, snapshot: snapshot() };
    }

    case 'updateTask': {
      const task = findTask(msg.id);
      if (task) {
        if (typeof msg.name === 'string') task.name = msg.name;
        if (typeof msg.targetUrl === 'string') task.targetUrl = msg.targetUrl;
        if (typeof msg.siteIntro === 'string') task.siteIntro = msg.siteIntro.trim();
        if (typeof msg.mainKeyword === 'string') task.mainKeyword = msg.mainKeyword.trim();
        if (msg.mode) task.mode = msg.mode === 'auto' ? 'auto' : 'semi';
        await save('tasks');
        broadcast();
      }
      return { ok: true, snapshot: snapshot() };
    }

    case 'taskAction': {
      const { id, action } = msg;
      if (action === 'start') {
        await publish.startTask(id);
        ensureAlarm(true);
      } else if (action === 'stop') {
        await publish.stopTask(id);
        if (isIdle()) ensureAlarm(false);
      } else if (action === 'delete') {
        await publish.deleteTask(id);
      }
      return { ok: true, snapshot: snapshot() };
    }

    case 'deleteResource': {
      await removeResource(msg.id);
      await save('resources');
      broadcast();
      return { ok: true, snapshot: snapshot() };
    }

    // 资源库：直接读 IndexedDB analysis 表，筛选「命中，可发布」的记录（不经内存态）
    case 'getLibraryResources': {
      const rows = await idbGetAll('analysis').catch(() => []);
      const resources = rows
        .filter((r) => r && r.url && r.reason === '命中，可发布')
        .sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0)) // 新命中的在前
        .map((r) => ({
          url: r.url,
          domain: domainOf(r.url),
          targetDomain: r.targetDomain,
          type: 'blog_comment',
          status: 'ready',
          checkedAt: r.checkedAt,
        }));
      return { ok: true, resources };
    }

    // 从资源库移除一条：删 analysis 记录（资源库不再显示）+ 资源表里的对应记录
    case 'deleteLibraryRow': {
      if (msg.targetDomain && msg.url) {
        await idbDelete('analysis', [msg.targetDomain, msg.url]).catch(() => {});
      }
      const st = getState();
      const hit = st.resources.find((r) => r.url === msg.url);
      if (hit) {
        await removeResource(hit.id);
        await save('resources');
      }
      broadcast();
      return { ok: true, snapshot: snapshot() };
    }

    case 'publishOne': {
      // 单条立即发布：包装成一个临时任务
      const st = getState();
      let res = st.resources.find((r) => r.id === msg.id || (msg.url && r.url === msg.url));
      if (!res && msg.url) {
        // 资源库行直接来自 analysis 表，资源表里没有就先补建
        await addResource({ url: msg.url, type: 'blog_comment' });
        res = st.resources.find((r) => r.url === msg.url);
      }
      if (!res) return { ok: false, error: '资源不存在' };
      const task = {
        id: uid(),
        name: '单条发布',
        targetUrl: st.settings.identity.website || '',
        mode: st.settings.publishMode || 'semi',
        resourceIds: [res.id],
        status: 'idle',
        results: {},
        createdAt: Date.now(),
        finishedAt: 0,
      };
      st.tasks.unshift(task);
      await save('tasks');
      await publish.startTask(task.id);
      ensureAlarm(true);
      return { ok: true, snapshot: snapshot() };
    }

    case 'clearData': {
      await collect.stop().catch(() => {});
      await clearAll();
      ensureAlarm(false);
      broadcast();
      return { ok: true, snapshot: snapshot() };
    }

    case 'clearLogs': {
      getState().logs = [];
      await save('logs');
      broadcast();
      return { ok: true, snapshot: snapshot() };
    }

    case 'setSettings': {
      // 设置唯一写入口：options 页与 popup 都走这里，避免直接写 storage 被后台内存态覆盖
      const st = getState();
      const patch = msg.patch || {};
      if (patch.language) st.settings.language = patch.language === 'en' ? 'en' : 'zh';
      if (typeof patch.publishMode === 'string') st.settings.publishMode = patch.publishMode === 'auto' ? 'auto' : 'semi';
      if (typeof patch.openrouterKey === 'string') st.settings.openrouterKey = patch.openrouterKey.trim();
      if (typeof patch.sheetsWebAppUrl === 'string') st.settings.sheetsWebAppUrl = patch.sheetsWebAppUrl.trim();
      if (patch.models && typeof patch.models === 'object') {
        for (const k of Object.keys(st.settings.models)) {
          if (typeof patch.models[k] === 'string') st.settings.models[k] = patch.models[k].trim();
        }
      }
      if (patch.identity && typeof patch.identity === 'object') {
        if (typeof patch.identity.name === 'string') st.settings.identity.name = patch.identity.name;
        if (typeof patch.identity.email === 'string') st.settings.identity.email = patch.identity.email.trim();
        if (typeof patch.identity.website === 'string') st.settings.identity.website = patch.identity.website.trim();
      }
      // 收集翻页随机间隔（毫秒），收敛到 1s-60s 且 min<=max
      const clamp = (v, d) => Math.min(Math.max(Number(v) || d, 1000), 60000);
      if (patch.pageDelayMinMs != null || patch.pageDelayMaxMs != null) {
        let min = clamp(patch.pageDelayMinMs ?? st.settings.pageDelayMinMs, 3000);
        let max = clamp(patch.pageDelayMaxMs ?? st.settings.pageDelayMaxMs, 9000);
        if (min > max) [min, max] = [max, min];
        st.settings.pageDelayMinMs = min;
        st.settings.pageDelayMaxMs = max;
      }
      await save('settings');
      broadcast();
      return { ok: true, snapshot: snapshot() };
    }

    case 'testKey':
      return await testKey(msg.key || '');

    case 'syncSheets': {
      const st = getState();
      const url = msg.url || st.settings.sheetsWebAppUrl;
      if (!url) return { ok: false, error: '未配置 Apps Script URL' };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // 避免 Apps Script CORS 预检
        body: JSON.stringify({ action: 'syncResources', resources: st.resources }),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true, count: st.resources.length };
    }

    // ---- 内容脚本上报 ----
    // 收集数据集导出（侧边栏下载 CSV）：以 IndexedDB 按目标域名读取，跨收集轮次累积
    case 'getBacklinksCsv': {
      const st = getState();
      const rows = await idbGetDomain('backlinks', st.collectState.targetDomain).catch(() => []);
      if (!rows.length) return { ok: false, error: '还没有收集到外链数据' };
      return { ok: true, csv: backlinksCsv(rows), count: rows.length };
    }

    case 'pub:decision': {
      await publish.onDecision(msg.resourceId, msg.decision);
      return { ok: true };
    }

    default:
      return { ok: false, error: `未知消息类型: ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((r) => { try { sendResponse(r || { ok: true }); } catch { /* port closed */ } })
    .catch((e) => { try { sendResponse({ ok: false, error: e.message }); } catch { /* port closed */ } });
  return true; // 异步响应
});

// ---- Popup 长连接：实时推送快照 ----
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
});

// ---- 保活 / 断点续跑 ----
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_TICK) return;
  (async () => {
    await load();
    ensureControllers();
    const st = getState();
    if (st.collectState.status === 'running') collect.resume();
    if (st.publishRuntime) await publish.healthCheck();
    if (isIdle()) ensureAlarm(false);
  })().catch((e) => console.error('[BCM] alarm error', e));
});

chrome.runtime.onInstalled.addListener(() => {
  (async () => {
    await load();
    ensureControllers();
    await refreshCollectStatsFromIdb();
    const st = getState();
    // 断点续跑：安装/更新时如果状态是 running，恢复队列处理
    if (st.collectState.status === 'running') collect.resume();
    if (st.publishRuntime) await publish.healthCheck();
  })().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  (async () => {
    await load();
    ensureControllers();
    await refreshCollectStatsFromIdb();
    const st = getState();
    if (st.collectState.status === 'running') collect.resume();
    if (st.publishRuntime) await publish.healthCheck();
  })().catch(console.error);
});

// 标签页被用户手动关闭时清理引用
chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    await load();
    const st = getState();
    if (st.collectState.providerTabId === tabId) st.collectState.providerTabId = null;
    if (st.collectState.analyzeTabId === tabId) st.collectState.analyzeTabId = null;
    if (st.publishRuntime && st.publishRuntime.tabId === tabId) st.publishRuntime.tabId = null;
  })().catch(() => {});
});

// 列表页整页跳转后（SPA 内部跳转不会触发）重新注入拦截钩子
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  (async () => {
    await load();
    ensureControllers();
    const st = getState();
    if (st.collectState.status === 'running' && st.collectState.providerTabId === tabId) {
      collect.injectInterceptor().catch((e) => addLog('collect', `重新注入拦截器失败：${e.message}`, 'warn'));
    }
  })().catch(() => {});
});
