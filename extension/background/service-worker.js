/**
 * MV3 Service Worker：消息路由 + 状态快照广播 + 保活与断点续跑。
 */
import {
  load, getState, save, clearAll, addLog,
  findTask, taskCounts, uid, domainOf,
} from '../lib/storage.js';
import { backlinksCsv } from '../lib/util.js';
import { idbGet, idbGetDomain, idbGetAll, idbPutAll } from '../lib/idb.js';
import { CollectController } from './collect.js';
import { PublishRunner } from './publish.js';
import { testKey } from '../lib/openrouter.js';

const ALARM_TICK = 'bcm-tick';

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

async function snapshot() {
  const st = getState();
  // 可用资源 = analysis 表命中结论的记录（不经内存态）；同一 url 可能被多个目标域名收集到，按 url 去重合并：
  // 任一记录停用即停用，任一目标网址发布过即标 published
  const [analysis, published] = await Promise.all([
    idbGetAll('analysis').catch(() => []),
    idbGetAll('published').catch(() => []),
  ]);
  const publishedUrls = new Set(published.map((r) => r && r.url));
  const hits = analysis
    .filter((r) => r && r.url && VALID_STATUSES.includes(r.status))
    .sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0)); // 新命中的在前
  const byUrl = new Map();
  for (const r of hits) {
    const cur = byUrl.get(r.url);
    if (!cur) {
      byUrl.set(r.url, {
        url: r.url,
        domain: domainOf(r.url),
        status: r.status,
        enabled: r.enabled !== false, // 旧数据无该字段，默认启用
        published: publishedUrls.has(r.url),
        checkedAt: r.checkedAt,
      });
    } else {
      cur.enabled = cur.enabled && r.enabled !== false;
      cur.published = cur.published || publishedUrls.has(r.url);
    }
  }
  const resources = [...byUrl.values()];
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
      status: t.status, resourceUrls: t.resourceUrls || [], results: t.results || {},
      createdAt: t.createdAt, finishedAt: t.finishedAt,
      counts: taskCounts(t),
    })),
    activeTaskId: st.activeTaskId,
    publish: st.publishRuntime
      ? { taskId: st.publishRuntime.taskId, resourceUrl: st.publishRuntime.resourceUrl, stage: st.publishRuntime.stage }
      : null,
    resources,
    logs: st.logs.slice(-200).reverse(),
    settings: {
      publishMode: st.settings.publishMode,
      language: st.settings.language,
      hasKey: !!st.settings.openrouterKey,
      pageDelayMinMs: st.settings.pageDelayMinMs,
      pageDelayMaxMs: st.settings.pageDelayMaxMs,
      logEnabled: st.settings.logEnabled !== false,
    },
  };
}

async function broadcast() {
  const msg = { type: 'stateChanged', snapshot: await snapshot() };
  // 无连接单向广播给扩展页面（sidepanel）：不依赖长连接，SW 重启换新实例后照样送达；
  // 面板未打开时无人接收，静默忽略
  chrome.runtime.sendMessage(msg).catch(() => {});
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
      return { ok: true, snapshot: await snapshot() };

    case 'startCollect':
      await collect.start(msg.domain, msg.provider);
      ensureAlarm(true);
      return { ok: true, snapshot: await snapshot() };

    case 'stopCollect':
      await collect.stop();
      if (isIdle()) ensureAlarm(false);
      return { ok: true, snapshot: await snapshot() };

    case 'startAnalysis':
      await collect.startAnalysis();
      ensureAlarm(true);
      return { ok: true, snapshot: await snapshot() };

    case 'createTask': {
      const task = {
        id: uid(),
        name: msg.name || '未命名任务',
        targetUrl: (msg.targetUrl || '').trim(),
        siteIntro: (msg.siteIntro || '').trim(),
        mainKeyword: (msg.mainKeyword || '').trim(),
        mode: msg.mode === 'auto' ? 'auto' : 'semi',
        resourceUrls: Array.isArray(msg.resourceUrls) ? msg.resourceUrls : [],
        status: 'idle',
        results: {},
        createdAt: Date.now(),
        finishedAt: 0,
      };
      getState().tasks.unshift(task);
      addLog('publish', `创建任务「${task.name}」，绑定 ${task.resourceUrls.length} 条资源`, 'info');
      await save('tasks', 'logs');
      broadcast();
      await publish.startTask(task.id);
      ensureAlarm(true);
      return { ok: true, snapshot: await snapshot() };
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
      return { ok: true, snapshot: await snapshot() };
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
      return { ok: true, snapshot: await snapshot() };
    }

    // 资源库：直接读 IndexedDB analysis 表，取命中结论（ready/captcha，验证码资源也算命中）的记录（不经内存态）
    case 'getLibraryResources': {
      const [rows, published] = await Promise.all([
        idbGetAll('analysis').catch(() => []),
        idbGetAll('published').catch(() => []),
      ]);
      const publishedUrls = new Set(published.map((r) => r && r.url));
      const resources = rows
        .filter((r) => r && r.url && VALID_STATUSES.includes(r.status))
        .sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0)) // 新命中的在前
        .map((r) => ({
          url: r.url,
          domain: domainOf(r.url),
          targetDomain: r.targetDomain,
          type: 'blog_comment',
          status: r.status,
          enabled: r.enabled !== false, // 旧数据无该字段，默认启用
          published: publishedUrls.has(r.url), // published 表有记录（任一目标网址）即视为已发布
          checkedAt: r.checkedAt,
        }));
      return { ok: true, resources };
    }

    // 资源启用/停用：只改 analysis 记录的 enabled 标记，数据保留（删了下次分析会重跑一遍）
    // keys: [[targetDomain, url], ...]，单条与批量（总开关）共用
    case 'setLibraryEnabled': {
      const keys = Array.isArray(msg.keys) ? msg.keys : [];
      const enabled = msg.enabled !== false;
      const want = new Set(keys.map(([d, u]) => `${d} ${u}`));
      addLog('system', `资源启停请求：${keys.length} 条，enabled=${enabled}`, 'info', keys[0] && keys[0][1]);
      const rows = await idbGetAll('analysis').catch(() => []);
      const dirty = rows
        .filter((r) => r && r.url && want.has(`${r.targetDomain} ${r.url}`) && (r.enabled !== false) !== enabled)
        .map((r) => ({ ...r, enabled }));
      // 一条都没匹配到通常是 key 对不上（主键不一致），打印请求 key 与库存样本对比
      if (!dirty.length && keys.length) {
        const sample = rows.filter((r) => r && r.url).slice(0, 3)
          .map((r) => `[${r.targetDomain}, ${r.url}]`).join(' | ');
        addLog('system', `资源启停未匹配到待更新记录：请求 key=${[...want].join(' | ')}；analysis 共 ${rows.length} 条，样本：${sample || '(空)'}`,
          'warn', keys[0] && keys[0][1]);
      }
      if (dirty.length) {
        await idbPutAll('analysis', dirty).catch((e) =>
          addLog('system', `资源启用状态写入失败：${e.message}`, 'warn'));
        // 回读第一条校验落库结果
        const [d, u] = keys[0] || [];
        const back = d ? await idbGet('analysis', [d, u]).catch(() => null) : null;
        addLog('system', `资源启停写入 ${dirty.length} 条；回读校验 enabled=${back ? back.enabled : '(读不到记录)'}`, 'info', u);
      }
      await save('logs');
      broadcast();
      return { ok: true, snapshot: await snapshot() };
    }

    case 'publishOne': {
      // 单条立即发布：包装成一个临时任务（资源直接用页面 URL，来自 analysis 表命中记录）
      const st = getState();
      if (!msg.url) return { ok: false, error: '资源不存在' };
      const task = {
        id: uid(),
        name: '单条发布',
        targetUrl: st.settings.identity.website || '',
        mode: st.settings.publishMode || 'semi',
        resourceUrls: [msg.url],
        status: 'idle',
        results: {},
        createdAt: Date.now(),
        finishedAt: 0,
      };
      st.tasks.unshift(task);
      await save('tasks');
      await publish.startTask(task.id);
      ensureAlarm(true);
      return { ok: true, snapshot: await snapshot() };
    }

    case 'clearData': {
      await collect.stop().catch(() => {});
      await clearAll();
      ensureAlarm(false);
      broadcast();
      return { ok: true, snapshot: await snapshot() };
    }

    case 'clearLogs': {
      getState().logs = [];
      await save('logs');
      broadcast();
      return { ok: true, snapshot: await snapshot() };
    }

    case 'setSettings': {
      // 设置唯一写入口：options 页与 popup 都走这里，避免直接写 storage 被后台内存态覆盖
      const st = getState();
      const patch = msg.patch || {};
      if (patch.language) st.settings.language = patch.language === 'en' ? 'en' : 'zh';
      if (typeof patch.publishMode === 'string') st.settings.publishMode = patch.publishMode === 'auto' ? 'auto' : 'semi';
      if (typeof patch.logEnabled === 'boolean') st.settings.logEnabled = patch.logEnabled;
      if (typeof patch.openrouterKey === 'string') st.settings.openrouterKey = patch.openrouterKey.trim();
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
      return { ok: true, snapshot: await snapshot() };
    }

    case 'testKey':
      return await testKey(msg.key || '');

    // ---- 内容脚本上报 ----
    // 收集数据集导出（侧边栏下载 CSV）：以 IndexedDB 按目标域名读取，跨收集轮次累积
    case 'getBacklinksCsv': {
      const st = getState();
      const rows = await idbGetDomain('backlinks', st.collectState.targetDomain).catch(() => []);
      if (!rows.length) return { ok: false, error: '还没有收集到外链数据' };
      return { ok: true, csv: backlinksCsv(rows), count: rows.length };
    }

    case 'pub:decision': {
      await publish.onDecision(msg.resourceUrl, msg.decision);
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

// ---- 保活 / 断点续跑 ----
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_TICK) return;
  (async () => {
    await load();
    ensureControllers();
    const st = getState();
    if (st.collectState.status === 'running') collect.resume();
    // SW 在停止途中被回收时状态会卡在 stopping：此处无循环在跑（新实例），直接落地为 idle
    if (st.collectState.status === 'stopping' && !collect.busy && !collect.scraping) {
      collect.finish('stopCollect');
    }
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
