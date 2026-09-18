/**
 * 侧边栏：四 Tab（收集/助手/日志/资源库）+ 页脚。
 * 「助手」Tab 是发布主操作台：顶部「当前任务」配置（可从模板选择/存为模板/删除模板），
 * 步骤按钮、字段展示与复制、定位目标链接、Submit/Skip、「换一个」——全部作用于浏览器
 * 当前激活的标签页；AI 步骤的运行结果来自 snapshot.publish（后台 publishRuntime 的投影），
 * 面板按 publish.resourceUrl 与当前激活标签页 URL 是否一致决定字段区与 Submit/Skip 是否生效。
 * 与 background 通过 sendMessage(RPC) + stateChanged 广播推送交互。
 */
import { setLanguage, t, applyI18n } from '../lib/i18n.js';
import { toCSV, fmtTime } from '../lib/util.js';

let snap = null;

// 资源库筛选状态
const filters = { type: 'all', status: null };
// 资源库列表：点击「资源库」Tab 时从 IndexedDB analysis 表加载（不经快照内存态）
let libraryRows = null;
// 当前激活标签页 URL（助手页的默认操作对象；仅 http/https 可注入）
let activeTabUrl = '';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

function toast(text, level = '') {
  const el = $('#toast');
  el.textContent = text;
  el.className = level;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2200);
}

async function act(msg, okMsg) {
  try {
    const res = await send(msg);
    if (res && res.snapshot) applySnapshot(res.snapshot);
    if (res && res.ok === false && res.error) return toast(res.error, 'error');
    if (okMsg) toast(okMsg, 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

function applySnapshot(s) {
  snap = s;
  if (s.settings?.language) {
    setLanguage(s.settings.language);
    $('#lang-select').value = s.settings.language;
    applyI18n();
  }
  render();
}

// ================= 渲染 =================

function render() {
  if (!snap) return;
  renderCollect();
  renderLogs();
  renderLibrary();
  renderAssistant();
}

/* ---- 收集 ---- */
function renderCollect() {
  const c = snap.collect;
  const running = c.status === 'running';
  const stopping = c.status === 'stopping';
  const busy = running || stopping;
  const mode = c.mode || 'collect';
  const collectRunning = busy && mode === 'collect';
  const analyzeRunning = busy && mode === 'analyze';

  $('#collect-domain').value = c.targetDomain || $('#collect-domain').value;
  $('#collect-provider').value = c.provider || 'semrush';
  $('#collect-provider').disabled = busy;
  $('#collect-domain').disabled = busy;

  // 翻页间隔（秒）：仅在非聚焦时回填，避免打断输入
  const dMin = $('#page-delay-min');
  const dMax = $('#page-delay-max');
  const s = snap.settings || {};
  dMin.disabled = busy;
  dMax.disabled = busy;
  if (document.activeElement !== dMin) dMin.value = Math.round((s.pageDelayMinMs ?? 3000) / 1000);
  if (document.activeElement !== dMax) dMax.value = Math.round((s.pageDelayMaxMs ?? 9000) / 1000);

  const btn = $('#btn-collect');
  btn.textContent = collectRunning ? t('stopCollect') : t('startCollect');
  btn.classList.toggle('btn-danger', collectRunning);
  btn.classList.toggle('btn-primary', !collectRunning);
  btn.disabled = analyzeRunning;

  const abtn = $('#btn-analyze');
  abtn.textContent = analyzeRunning ? t('stopAnalysis') : t('startAnalysis');
  abtn.disabled = collectRunning;

  const phaseKey = busy ? (c.phase || 'phaseAnalyzing') : '';
  $('#collect-phase').textContent = busy
    ? t(phaseKey)
    : (c.status === 'idle' && (c.phase === 'collectDone' || c.phase === 'analysisDone') ? t(c.phase) : t('statusIdle'));
  $('#collect-dot').classList.toggle('idle', !busy);

  $('#st-discovered').textContent = c.discovered;
  $('#st-analyzed').textContent = c.analyzed;
  $('#st-matched').textContent = c.matched;
  $('#st-queued').textContent = c.queued;

  const seedEl = $('#collect-seeds');
  if (c.seeds > 0) {
    seedEl.hidden = false;
    seedEl.textContent = `❄ ${c.seeds} ${t('seedHint')}`;
  } else {
    seedEl.hidden = true;
  }
}

/* ---- 日志 ---- */
function renderLogs() {
  const list = $('#log-list');
  const logs = snap.logs || [];
  // 日志开关状态回填（默认开）
  $('#log-enabled').checked = (snap.settings?.logEnabled) !== false;
  $('#logs-empty').style.display = logs.length ? 'none' : '';
  list.innerHTML = logs.map((l) => {
    const url = l.url ? `<div class="url">${esc(l.url.length > 60 ? l.url.slice(0, 60) + '…' : l.url)}</div>` : '';
    return `
      <div class="log-item ${l.level}">
        <span class="t">${fmtTime(l.t)}</span>
        <span class="src">${t('src_' + l.src)}</span>
        <span class="msg">${esc(l.msg)}${url}</span>
      </div>`;
  }).join('');
}

/* ---- 资源库 ---- */
// 点击「资源库」Tab 时：读 IndexedDB analysis 表（命中结论 ready/captcha，验证码资源也算命中）
async function loadLibrary() {
  try {
    const res = await send({ type: 'getLibraryResources' });
    if (res && res.ok === false) return toast(res.error, 'error');
    if (res && res.resources) {
      libraryRows = res.resources;
      renderLibrary();
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

function filteredResources() {
  let rs = libraryRows || [];
  if (filters.type !== 'all') rs = rs.filter((r) => r.type === filters.type);
  if (filters.status === 'published') rs = rs.filter((r) => r.published);
  else if (filters.status) rs = rs.filter((r) => r.status === filters.status);
  return rs;
}

function renderLibrary() {
  document.querySelectorAll('#type-chips .chip').forEach((ch) => ch.classList.toggle('active', ch.dataset.type === filters.type));
  document.querySelectorAll('#status-chips .chip').forEach((ch) => ch.classList.toggle('active', ch.dataset.status === filters.status));

  const rs = filteredResources();
  $('#res-count').textContent = t('countLine', { n: rs.length });

  // 总开关：作用于全部资源（非当前筛选子集）；全启用=勾选，部分启用=半选
  const all = libraryRows || [];
  const allBox = $('#res-toggle-all');
  allBox.disabled = all.length === 0;
  allBox.checked = all.length > 0 && all.every((r) => r.enabled !== false);
  allBox.indeterminate = !allBox.checked && all.some((r) => r.enabled !== false);

  const list = $('#res-list');
  $('#res-empty').style.display = rs.length ? 'none' : '';
  // 最多渲染 200 条，避免面板卡顿
  const view = rs.slice(0, 200);
  // 按目标域名分组（组间按域名字典序排列）
  const groups = new Map();
  for (const r of view) {
    const key = r.targetDomain || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const sortedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  list.innerHTML = sortedGroups.map(([td, rows]) => `
      <div class="res-group-head">
        <span class="g-domain">${esc(td || '—')}</span>
        <span class="g-count">${rows.length}</span>
      </div>
      ${rows.map((r) => {
        const fav = `<img class="fav" src="${chrome.runtime.getURL('/_favicon/?pageUrl=' + encodeURIComponent(r.url) + '&clientId=bcm')}" onerror="this.style.display='none'">`;
        const short = r.domain + (r.url.replace(/^https?:\/\/[^/]+/, '').length > 1 ? r.url.replace(/^https?:\/\/[^/]+/, '') : '');
        return `
      <div class="res-item${r.enabled === false ? ' disabled' : ''}">
        ${fav}
        <span class="badge type">${t(r.type === 'profile' ? 'type_profile' : 'type_blog_comment')}</span>
        <span class="url" title="${esc(r.url)}">${esc(short.length > 34 ? short.slice(0, 34) + '…' : short)}</span>
        <span class="badge ${r.published ? 'st-published' : 'st-' + r.status}">${t(r.published ? 'st_published' : 'st_' + r.status)}</span>
        <span class="ops">
          <input type="checkbox" class="res-enable" data-ract="toggle" data-url="${esc(r.url)}" data-td="${esc(r.targetDomain)}" ${r.enabled !== false ? 'checked' : ''} title="${t('resEnable')}">
          <button class="icon-btn" data-ract="open" data-url="${esc(r.url)}" title="${t('resOpen')}">🔗</button>
          <button class="icon-btn" data-ract="publish" data-url="${esc(r.url)}" title="${t('resPublish')}">↗</button>
        </span>
      </div>`;
      }).join('')}`).join('');
}

/* ---- 助手（发布主操作台：操作对象 = 当前激活标签页）---- */
let asstLastReview = false; // 上次是否处于待确认阶段：进入 awaiting_review 自动切到助手 Tab 时去重
let asstStepBusy = null;    // 正在等待回包的步骤名（本地防重入；后台另有 stepBusy 并发去重）
let asstWatchdog = 0;       // 步骤按钮看门狗计时器
let asstTemplates = [];     // 模板缓存（IndexedDB templates 表）
let asstTaskCollapsed = true;  // 「当前任务」详情折叠状态（默认收起，模板选择行不受影响）
let asstTaskTouched = false;   // 用户手动折叠过则不再自动展开

function activateTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'library') loadLibrary();
}

/** 刷新当前激活标签页（助手页的操作对象），随后重渲染助手区 */
async function refreshActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabUrl = tab && /^https?:/.test(tab.url || '') ? tab.url : '';
  } catch {
    activeTabUrl = '';
  }
  renderAssistant();
}

function renderAssistant() {
  if (!snap) return;
  const pub = snap.publish;
  // 后台会话与当前激活标签页一致才算绑定：字段区/Submit/Skip 只对绑定页面生效
  const bound = !!(pub && activeTabUrl && pub.resourceUrl === activeTabUrl);
  const stage = bound ? pub.stage : null;

  // 「当前任务」字段回填：仅在非聚焦时覆盖，避免打断输入
  const at = snap.assistantTask || {};
  const fillIfIdle = (sel, val) => {
    const el = $(sel);
    if (document.activeElement !== el && el.value !== (val || '')) el.value = val || '';
  };
  fillIfIdle('#at-name', at.name);
  fillIfIdle('#at-url', at.targetUrl);
  fillIfIdle('#at-intro', at.siteIntro);
  fillIfIdle('#at-keyword', at.mainKeyword);

  // 「当前任务」详情折叠：未配置任务时强制展开引导填写；收起时标题行显示任务名摘要
  if (!asstTaskTouched && !at.name && !at.targetUrl) asstTaskCollapsed = false;
  $('#asst-task-body').hidden = asstTaskCollapsed;
  const toggleBtn = $('#asst-task-toggle');
  toggleBtn.textContent = asstTaskCollapsed ? '▸' : '▾';
  toggleBtn.title = t(asstTaskCollapsed ? 'asstExpand' : 'asstCollapse');
  const taskNameEl = $('#asst-task-name');
  taskNameEl.hidden = !asstTaskCollapsed;
  taskNameEl.textContent = at.name || at.targetUrl || '';
  taskNameEl.title = at.targetUrl || '';

  // 当前资源 = 当前激活标签页
  $('#asst-url').textContent = activeTabUrl || t('asstNoPage');
  $('#asst-url').title = activeTabUrl;

  // 状态行：优先绑定会话的 uiStatus（key 走 i18n，text 直显），无则给默认引导
  let status = '';
  if (bound && pub.uiStatus) status = pub.uiStatus.key ? t(pub.uiStatus.key) : (pub.uiStatus.text || '');
  if (!status) status = !activeTabUrl ? t('asstNoPage') : stage === 'awaiting_review' ? t('asstReady') : t('asstManual');
  $('#asst-status').textContent = status;
  $('#asst-dot').classList.toggle('idle', stage !== 'awaiting_review');

  // 步骤按钮：激活标签页是可注入网页即可点、可反复触发；
  // 「自动填写表单」需评论已生成（绑定会话的 manual.comment）；本地 busy 中的步骤临时置灰防重入
  document.querySelectorAll('.asst-step').forEach((b) => {
    const step = b.dataset.step;
    const needComment = step === 'fill' && !(bound && (pub.manual || {}).comment);
    b.title = needComment ? t('asstStepNeedComment') : '';
    b.disabled = !activeTabUrl || needComment || asstStepBusy === step;
  });

  // 字段区：摘要（标题/摘要+文章语言）+ 评论字段（评论/译文/昵称+邮箱），各带复制按钮；
  // 仅绑定会话时展示（切到别的标签页后旧数据不误导）。
  // 文章语言跟在「摘要」标签行右侧、昵称/邮箱并排一行，都是为了省高度
  const m = bound ? (pub.manual || {}) : {};
  const copies = [];
  const fieldHtml = (key, val, side = '') => {
    const i = copies.push(val) - 1;
    return `
    <div class="asst-field">
      <div class="asst-field-label"><span>${t(key)}</span>${side}<button class="asst-copy" data-idx="${i}">${t('copy')}</button></div>
      <div class="asst-field-val">${esc(val)}</div>
    </div>`;
  };
  const parts = [];
  if (m.sumTitle) parts.push(fieldHtml('fieldTitle', m.sumTitle));
  if (m.summary) {
    const lang = m.artLang ? `<span class="asst-field-side">${t('fieldLang')}: ${esc(m.artLang)}</span>` : '';
    parts.push(fieldHtml('fieldSummary', m.summary, lang));
  } else if (m.artLang) {
    parts.push(fieldHtml('fieldLang', m.artLang));
  }
  if (m.comment) parts.push(fieldHtml('fieldComment', m.comment));
  if (m.translation) parts.push(fieldHtml('fieldTranslation', m.translation));
  const nameEmail = [['fieldName', m.name], ['fieldEmail', m.email]].filter(([, v]) => v);
  if (nameEmail.length) {
    parts.push(`<div class="asst-field-pair">${nameEmail.map(([k, v]) => fieldHtml(k, v)).join('')}</div>`);
  }
  const box = $('#asst-fields');
  box.innerHTML = parts.join('');
  box.querySelectorAll('.asst-copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(copies[Number(btn.dataset.idx)]);
        const old = btn.textContent;
        btn.textContent = t('copied');
        setTimeout(() => { btn.textContent = old; }, 1200);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });

  // 定位目标链接 / 换一个：激活标签页是可注入网页即可用
  $('#asst-locate').disabled = !activeTabUrl;
  $('#asst-next').disabled = !activeTabUrl;
  // Submit / Skip：仅绑定会话且 awaiting_review（表单已填好待确认）解锁
  const review = stage === 'awaiting_review';
  $('#asst-submit').disabled = !review;
  $('#asst-skip').disabled = !review;
  // 填表完成进入待确认时自动切到助手 Tab（后台无法主动弹面板，缓解「看不到确认界面」）
  if (review && !asstLastReview) {
    const cur = document.querySelector('.tab.active');
    if (cur && cur.dataset.tab !== 'assistant') activateTab('assistant');
  }
  asstLastReview = review;
}

/** 步骤按钮：发 pub:step；看门狗超时未回包（SW 被回收/请求挂死）提示可再点一次重试 */
async function runStep(step) {
  if (asstStepBusy) return;
  asstStepBusy = step;
  const timeout = (Number(snap?.settings?.aiTimeoutMs) || 20000) * 3 + 30000;
  clearTimeout(asstWatchdog);
  asstWatchdog = setTimeout(() => {
    asstStepBusy = null;
    renderAssistant(); // 先恢复按钮状态，再覆盖状态行（避免被快照渲染抹掉提示）
    $('#asst-status').textContent = t('asstStepNoResp');
  }, timeout);
  renderAssistant();
  let failed = false;
  try {
    const res = await send({ type: 'pub:step', step });
    if (res && res.ok === false) {
      failed = true;
      if (res.error) toast(res.error, 'error');
    }
  } catch {
    failed = true;
  }
  clearTimeout(asstWatchdog);
  asstStepBusy = null;
  renderAssistant();
  if (failed) $('#asst-status').textContent = t('asstStepNoResp');
}

/** 「定位目标链接」：结果（第 n/m 个 / 未找到）显示在状态行 */
async function runLocate() {
  const btn = $('#asst-locate');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = t('asstLocating');
  try {
    const res = await send({ type: 'pub:locate' });
    const status = $('#asst-status');
    if (res && res.ok && res.index != null) status.textContent = t('asstLocated', { n: res.index, m: res.total });
    else if (res && res.reason === 'noTarget') status.textContent = t('asstNoTarget');
    else if (res && res.reason === 'noPage') status.textContent = t('asstNoPage');
    else status.textContent = t('asstNoLink');
  } catch (e) {
    toast(e.message, 'error');
  }
  btn.disabled = false;
  btn.textContent = old;
}

async function decide(decision) {
  try {
    const res = await send({ type: 'pub:decision', decision });
    if (res && res.ok === false) toast(t('asstStepNoResp'), 'error');
  } catch (e) {
    toast(e.message, 'error');
  }
}

/** 「换一个」：当前激活标签页导航到资源库中未发布过的下一条资源 */
async function pickNext() {
  const btn = $('#asst-next');
  btn.disabled = true;
  try {
    const res = await send({ type: 'pickNextResource' });
    if (res && res.ok === false) toast(res.error || t('asstNoMore'), 'error');
  } catch (e) {
    toast(e.message, 'error');
  }
  renderAssistant();
}

/* ---- 助手页「当前任务」与模板 ---- */

function currentTaskFromFields() {
  return {
    name: $('#at-name').value.trim(),
    targetUrl: $('#at-url').value.trim(),
    siteIntro: $('#at-intro').value.trim(),
    mainKeyword: $('#at-keyword').value.trim(),
  };
}

function fillTplOptions(list, selected) {
  asstTemplates = list || [];
  const sel = $('#asst-tpl');
  sel.innerHTML = `<option value="" data-i18n="tplSelect">${t('tplSelect')}</option>` +
    asstTemplates.map((x) => `<option value="${esc(x.name)}" ${x.name === selected ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  $('#asst-tpl-del').disabled = !sel.value;
}

async function reloadTemplates(selected) {
  try {
    const res = await send({ type: 'getTemplates' });
    if (res && res.templates) fillTplOptions(res.templates, selected);
  } catch { /* 面板打开时后台未必就绪，忽略 */ }
}

// ================= 事件绑定 =================

function bindEvents() {
  // Tab 切换
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    activateTab(btn.dataset.tab);
  });

  // 收集
  $('#btn-collect').addEventListener('click', async () => {
    const mode = snap && snap.collect ? (snap.collect.mode || 'collect') : 'collect';
    const collectRunning = snap && snap.collect && snap.collect.status === 'running' && mode === 'collect';
    const stopping = snap && snap.collect && snap.collect.status === 'stopping';
    if (collectRunning || (stopping && mode === 'collect')) {
      await act({ type: 'stopCollect' });
    } else {
      const domain = $('#collect-domain').value.trim();
      if (!domain) return toast(t('targetDomain') + '?', 'error');
      await act({ type: 'startCollect', domain, provider: $('#collect-provider').value });
    }
  });

  // 分析（对已收集的数据集逐条访问 + 规则判定）
  $('#btn-analyze').addEventListener('click', async () => {
    const c = snap && snap.collect;
    const analyzeRunning = c && c.status === 'running' && (c.mode || 'collect') === 'analyze';
    const stopping = c && c.status === 'stopping';
    if (analyzeRunning || (stopping && (c.mode || 'collect') === 'analyze')) {
      await act({ type: 'stopCollect' });
    } else {
      await act({ type: 'startAnalysis' });
    }
  });

  // 助手页：步骤按钮 / 定位目标链接 / 换一个 / Submit / Skip
  document.querySelectorAll('.asst-step').forEach((b) => {
    b.addEventListener('click', () => runStep(b.dataset.step));
  });
  $('#asst-locate').addEventListener('click', runLocate);
  $('#asst-next').addEventListener('click', pickNext);
  $('#asst-submit').addEventListener('click', () => decide('submit'));
  $('#asst-skip').addEventListener('click', () => decide('skip'));

  // 助手页「当前任务」：折叠/展开任务详情
  $('#asst-task-toggle').addEventListener('click', () => {
    asstTaskTouched = true;
    asstTaskCollapsed = !asstTaskCollapsed;
    renderAssistant();
  });

  // 助手页「当前任务」：字段失焦即保存（快照回来时已按聚焦态跳过回填，不打断输入）
  ['#at-name', '#at-url', '#at-intro', '#at-keyword'].forEach((sel) => {
    $(sel).addEventListener('change', () => {
      send({ type: 'setAssistantTask', ...currentTaskFromFields() }).catch(() => {});
      toast(t('saved'), 'success');
    });
  });

  // 模板下拉：选中即填充字段并保存为当前任务
  $('#asst-tpl').addEventListener('change', () => {
    $('#asst-tpl-del').disabled = !$('#asst-tpl').value;
    const tpl = asstTemplates.find((x) => x.name === $('#asst-tpl').value);
    if (!tpl) return;
    $('#at-name').value = tpl.name || '';
    $('#at-url').value = tpl.targetUrl || '';
    $('#at-intro').value = tpl.siteIntro || '';
    $('#at-keyword').value = tpl.mainKeyword || '';
    send({ type: 'setAssistantTask', ...currentTaskFromFields() }).catch(() => {});
  });

  // 存为模板（同名覆盖即编辑）
  $('#asst-tpl-save').addEventListener('click', async () => {
    const input = prompt(t('tplNamePrompt'), $('#at-name').value.trim() || $('#asst-tpl').value);
    const tplName = (input || '').trim();
    if (!tplName) return;
    if (asstTemplates.some((x) => x.name === tplName) && !confirm(t('tplOverwrite', { name: tplName }))) return;
    const res = await send({ type: 'saveTemplate', ...currentTaskFromFields(), name: tplName });
    if (res && res.ok === false) return toast(res.error, 'error');
    if (res && res.templates) fillTplOptions(res.templates, tplName);
    toast(t('tplSaved'), 'success');
  });

  // 删除模板
  $('#asst-tpl-del').addEventListener('click', async () => {
    const tplName = $('#asst-tpl').value;
    if (!tplName) return;
    if (!confirm(`${t('delete')}「${tplName}」?`)) return;
    const res = await send({ type: 'deleteTemplate', name: tplName });
    if (res && res.templates) fillTplOptions(res.templates);
    toast(t('tplDeleted'), 'success');
  });

  // 翻页间隔保存（单位秒 → 毫秒）
  const savePageDelay = () => {
    const min = parseInt($('#page-delay-min').value, 10) * 1000;
    const max = parseInt($('#page-delay-max').value, 10) * 1000;
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    send({ type: 'setSettings', patch: { pageDelayMinMs: min, pageDelayMaxMs: max } }).catch(() => {});
    toast(t('saved'), 'success');
  };
  $('#page-delay-min').addEventListener('change', savePageDelay);
  $('#page-delay-max').addEventListener('change', savePageDelay);

  // 日志
  $('#btn-clear-logs').addEventListener('click', () => act({ type: 'clearLogs' }));

  // 日志开关：关闭后后台 addLog 直接丢弃新日志
  $('#log-enabled').addEventListener('change', (e) => {
    send({ type: 'setSettings', patch: { logEnabled: e.target.checked } }).catch(() => {});
  });

  // 一键复制日志（调试时方便发给 AI）
  $('#btn-copy-logs').addEventListener('click', async () => {
    const logs = snap && snap.logs ? snap.logs : [];
    if (!logs.length) return toast(t('noLogs'), 'error');
    // snap.logs 为新→旧，复制时转成旧→新的时间线顺序
    const text = logs.slice().reverse().map((l) => {
      const src = ({ collect: '收集', publish: '发布', ai: 'AI', system: '系统' })[l.src] || l.src;
      return `${fmtTime(l.t)} [${l.level}] ${src} ${l.msg}${l.url ? ` | ${l.url}` : ''}`;
    }).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast(t('logsCopied'), 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  // 资源筛选 chips
  $('#type-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    filters.type = chip.dataset.type;
    renderLibrary();
  });
  $('#status-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const s = chip.dataset.status;
    filters.status = filters.status === s ? null : s; // 再点一次取消
    renderLibrary();
  });

  // 资源行内操作
  $('#res-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-ract]');
    if (!btn) return;
    const url = btn.dataset.url;
    const res = (libraryRows || []).find((r) => r.url === url);
    if (!res) return;
    if (btn.dataset.ract === 'open') chrome.tabs.create({ url: res.url });
    // 立即发布：把当前激活标签页导航到该资源 URL，随后到助手页执行各步骤
    if (btn.dataset.ract === 'publish') {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return toast(t('asstNoPage'), 'error');
        await chrome.tabs.update(tab.id, { url: res.url });
        activateTab('assistant');
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  // 资源启用/停用（行内 checkbox）
  $('#res-list').addEventListener('change', async (e) => {
    const box = e.target.closest('input[data-ract="toggle"]');
    if (!box) return;
    const res = (libraryRows || []).find((r) => r.url === box.dataset.url && r.targetDomain === box.dataset.td);
    if (!res) return;
    res.enabled = box.checked;
    renderLibrary();
    await act({ type: 'setLibraryEnabled', keys: [[res.targetDomain, res.url]], enabled: box.checked });
  });

  // 总开关：启用全部 / 停用全部
  $('#res-toggle-all').addEventListener('change', async (e) => {
    const all = libraryRows || [];
    if (!all.length) return;
    const enabled = e.target.checked;
    for (const r of all) r.enabled = enabled;
    renderLibrary();
    await act({ type: 'setLibraryEnabled', keys: all.map((r) => [r.targetDomain, r.url]), enabled });
  });

  // 导出收集数据集 CSV
  $('#btn-export-backlinks').addEventListener('click', async () => {
    try {
      const res = await send({ type: 'getBacklinksCsv' });
      if (res && res.ok === false) return toast(res.error, 'error');
      const blob = new Blob([res.csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const d = new Date();
      const p = (x) => String(x).padStart(2, '0');
      a.download = `backlinks_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  // 导出 CSV
  $('#btn-export-csv').addEventListener('click', () => {
    const rs = libraryRows || snap.resources || [];
    if (!rs.length) return toast(t('noResources'), 'error');
    const blob = new Blob([toCSV(rs)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    a.download = `resources_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  // 页脚
  $('#btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('#btn-clear-data').addEventListener('click', async () => {
    if (confirm(t('confirmClearData'))) await act({ type: 'clearData' });
  });
  // 开发用：直接重载插件（状态都在 storage 里，重载后可断点续跑）
  $('#btn-reload').addEventListener('click', () => chrome.runtime.reload());
  $('#lang-select').addEventListener('change', (e) => {
    setLanguage(e.target.value);
    applyI18n();
    render();
    send({ type: 'setSettings', patch: { language: e.target.value } });
  });
}

// ================= 启动 =================

async function init() {
  bindEvents();
  try {
    const res = await send({ type: 'getSnapshot' });
    if (res && res.snapshot) applySnapshot(res.snapshot);
  } catch (e) {
    toast(e.message, 'error');
  }
  reloadTemplates();
  await refreshActiveTab();
  // 激活标签页变化 / 页内跳转时刷新助手页的操作对象
  chrome.tabs.onActivated.addListener(refreshActiveTab);
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (tab && tab.active && (info.url || info.status)) refreshActiveTab();
  });
  // 后台快照推送（sendMessage 单向广播，无连接状态，SW 重启不影响送达）
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'stateChanged') applySnapshot(msg.snapshot);
  });
}

init();
