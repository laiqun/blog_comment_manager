/**
 * Popup：四 Tab（收集/发布/日志/资源库）+ 页脚 + 任务弹窗。
 * 与 background 通过 sendMessage(RPC) + stateChanged 广播推送交互。
 */
import { setLanguage, t, applyI18n } from '../lib/i18n.js';
import { toCSV, fmtTime } from '../lib/util.js';

let snap = null;

// 资源库筛选状态
const filters = { type: 'all', status: null };
// 资源库列表：点击「资源库」Tab 时从 IndexedDB analysis 表加载（不经快照内存态）
let libraryRows = null;

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
  renderPublish();
  renderLogs();
  renderLibrary();
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

/* ---- 发布 ---- */
function renderPublish() {
  const list = $('#task-list');
  const tasks = snap.tasks || [];
  $('#tasks-empty').hidden = tasks.length > 0;
  $('#tasks-empty').style.display = tasks.length ? 'none' : '';

  list.innerHTML = tasks.map((task) => {
    const c = task.counts;
    const running = task.status === 'running';
    const statusBadge = running ? t('taskRunning') : task.status === 'done' ? t('taskDone') : t('taskStopped');
    const modeLabel = task.mode === 'auto' ? 'AUTO' : 'SEMI';
    return `
      <div class="task-card ${running ? 'running' : ''}">
        <div class="task-top">
          <span class="task-name">${esc(task.name)}</span>
          <span class="task-url">${esc(task.targetUrl || '—')}</span>
          <span class="task-mode">${modeLabel}</span>
        </div>
        <div class="task-mid">
          <span class="ok">✓ <b>${c.success}</b></span>
          <span class="fail">✗ <b>${c.failed}</b></span>
          <span>⊘ <b>${c.skipped}</b></span>
          <span>${t('stat_remaining')}: <b>${c.remaining}</b></span>
          <span style="margin-left:auto;color:var(--text-faint)">${statusBadge}</span>
        </div>
        <div class="task-actions">
          <button class="icon-btn stop" data-act="stop" data-id="${task.id}" ${running ? '' : 'disabled'} title="${t('taskStop')}">⏹</button>
          <button class="icon-btn" data-act="detail" data-id="${task.id}" title="${t('taskDetail')}">☰</button>
          <button class="icon-btn" data-act="edit" data-id="${task.id}" ${running ? 'disabled' : ''} title="${t('taskEdit')}">✏</button>
          <button class="icon-btn danger" data-act="delete" data-id="${task.id}" title="${t('taskDelete')}">✕</button>
        </div>
      </div>`;
  }).join('');

  // 运行状态卡片
  const active = tasks.find((x) => x.id === snap.activeTaskId) || tasks.find((x) => x.status === 'running');
  const card = $('#publish-card');
  if (active) {
    card.hidden = false;
    const c = active.counts;
    const waiting = snap.publish && snap.publish.stage === 'awaiting_review';
    $('#publish-phase').textContent = waiting ? t('statusWaiting') : t('statusPublishing');
    $('#pt-total').textContent = c.total;
    $('#pt-success').textContent = c.success;
    $('#pt-pending').textContent = c.pending;
    $('#pt-failed').textContent = c.failed;
    $('#pt-remaining').textContent = c.remaining;
  } else {
    card.hidden = true;
  }
}

/* ---- 日志 ---- */
function renderLogs() {
  const list = $('#log-list');
  const logs = snap.logs || [];
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
  if (filters.status) rs = rs.filter((r) => r.status === filters.status);
  return rs;
}

function renderLibrary() {
  document.querySelectorAll('#type-chips .chip').forEach((ch) => ch.classList.toggle('active', ch.dataset.type === filters.type));
  document.querySelectorAll('#status-chips .chip').forEach((ch) => ch.classList.toggle('active', ch.dataset.status === filters.status));

  const rs = filteredResources();
  $('#res-count').textContent = t('countLine', { n: rs.length });

  const list = $('#res-list');
  $('#res-empty').style.display = rs.length ? 'none' : '';
  // 最多渲染 200 条，避免 popup 卡顿
  const view = rs.slice(0, 200);
  list.innerHTML = view.map((r) => {
    const fav = `<img class="fav" src="${chrome.runtime.getURL('/_favicon/?pageUrl=' + encodeURIComponent(r.url) + '&clientId=bcm')}" onerror="this.style.display='none'">`;
    const short = r.domain + (r.url.replace(/^https?:\/\/[^/]+/, '').length > 1 ? r.url.replace(/^https?:\/\/[^/]+/, '') : '');
    return `
      <div class="res-item">
        ${fav}
        <span class="badge type">${t(r.type === 'profile' ? 'type_profile' : 'type_blog_comment')}</span>
        <span class="url" title="${esc(r.url)}">${esc(short.length > 34 ? short.slice(0, 34) + '…' : short)}</span>
        <span class="badge st-${r.status}">${t('st_' + r.status)}</span>
        <span class="ops">
          <button class="icon-btn" data-ract="open" data-url="${esc(r.url)}" title="${t('resOpen')}">🔗</button>
          <button class="icon-btn" data-ract="publish" data-url="${esc(r.url)}" title="${t('resPublish')}">↗</button>
          <button class="icon-btn danger" data-ract="del" data-url="${esc(r.url)}" title="${t('resDelete')}">✕</button>
        </span>
      </div>`;
  }).join('');
}

// ================= 弹窗 =================

function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modal-mask').hidden = false;
}
function closeModal() {
  $('#modal-mask').hidden = true;
  $('#modal').innerHTML = '';
}

function showCreateTaskModal(prefill = null) {
  const readyCount = (snap.resources || []).filter((r) => r.status === 'ready').length;
  const isEdit = !!prefill;
  if (!isEdit && readyCount === 0) {
    toast(t('noReadyResources'), 'error');
    return;
  }
  openModal(`
    <h3>${t(isEdit ? 'titleEditTask' : 'titleCreateTask')}</h3>
    <div class="form-row">
      <label class="field-label">${t('taskName')}</label>
      <input type="text" id="m-name" value="${esc(prefill?.name || '')}" placeholder="Canva" />
    </div>
    <div class="form-row">
      <label class="field-label">${t('targetUrl')}</label>
      <input type="text" id="m-url" value="${esc(prefill?.targetUrl || '')}" placeholder="https://www.canva.com/" />
    </div>
    <div class="form-row">
      <label class="field-label">${t('siteIntro')}</label>
      <textarea id="m-intro" rows="3" placeholder="${esc(t('siteIntroPh'))}">${esc(prefill?.siteIntro || '')}</textarea>
    </div>
    <div class="form-row">
      <label class="field-label">${t('mainKeyword')}</label>
      <input type="text" id="m-keyword" value="${esc(prefill?.mainKeyword || '')}" placeholder="${esc(t('mainKeywordPh'))}" />
    </div>
    <div class="form-row">
      <label class="field-label">${t('publishMode')}</label>
      <div class="mode-row">
        <label><input type="radio" name="m-mode" value="semi" ${prefill?.mode !== 'auto' ? 'checked' : ''} /> ${t('modeSemi')}</label>
        <label><input type="radio" name="m-mode" value="auto" ${prefill?.mode === 'auto' ? 'checked' : ''} /> ${t('modeAuto')}</label>
      </div>
    </div>
    ${isEdit ? '' : `
    <div class="form-row">
      <label class="field-label">${t('resourceScope')}</label>
      <select id="m-scope" disabled><option>${t('scopeReady')} (${readyCount})</option></select>
    </div>`}
    <div class="btn-row">
      <button class="btn btn-ghost" id="m-cancel">${t('cancel')}</button>
      <button class="btn btn-primary" id="m-ok">${t(isEdit ? 'btnSave' : 'btnCreate')}</button>
    </div>
  `);
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-ok').addEventListener('click', async () => {
    const name = $('#m-name').value.trim() || '未命名任务';
    const targetUrl = $('#m-url').value.trim();
    const siteIntro = $('#m-intro').value.trim();
    const mainKeyword = $('#m-keyword').value.trim();
    const mode = document.querySelector('input[name="m-mode"]:checked').value;
    if (isEdit) {
      await act({ type: 'updateTask', id: prefill.id, name, targetUrl, siteIntro, mainKeyword, mode });
    } else {
      const ids = (snap.resources || []).filter((r) => r.status === 'ready').map((r) => r.id);
      if (!ids.length) return toast(t('noReadyResources'), 'error');
      closeModal();
      await act({ type: 'createTask', name, targetUrl, siteIntro, mainKeyword, mode, resourceIds: ids });
    }
    closeModal();
  });
}

function showDetailModal(task) {
  const statusLabel = { success: t('detailSuccess'), skip: t('detailSkip'), fail: t('detailFail'), captcha: t('detailCaptcha') };
  const items = (task.resourceIds || []).map((id) => {
    const res = (snap.resources || []).find((r) => r.id === id);
    if (!res) return '';
    const st = task.results[id] ? statusLabel[task.results[id]] || task.results[id] : t('detailWaiting');
    return `<div class="detail-item"><span class="badge st-${res.status}">${st}</span><span class="u" title="${esc(res.url)}">${esc(res.url)}</span></div>`;
  }).join('');
  openModal(`
    <h3>${t('titleTaskDetail')} — ${esc(task.name)}</h3>
    ${items || `<div class="empty">—</div>`}
    <div class="btn-row"><button class="btn btn-ghost" id="m-cancel">${t('close')}</button></div>
  `);
  $('#m-cancel').addEventListener('click', closeModal);
}

// ================= 事件绑定 =================

function bindEvents() {
  // Tab 切换
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + btn.dataset.tab));
    if (btn.dataset.tab === 'library') loadLibrary();
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

  // 发布任务操作（事件委托）
  $('#task-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const task = (snap.tasks || []).find((x) => x.id === id);
    switch (btn.dataset.act) {
      case 'stop': await act({ type: 'taskAction', id, action: 'stop' }); break;
      case 'delete':
        if (confirm(t('taskDelete') + '?')) await act({ type: 'taskAction', id, action: 'delete' });
        break;
      case 'edit': if (task) showCreateTaskModal(task); break;
      case 'detail': if (task) showDetailModal(task); break;
    }
  });

  $('#btn-new-task').addEventListener('click', () => showCreateTaskModal());

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
    const btn = e.target.closest('[data-ract]');
    if (!btn) return;
    const url = btn.dataset.url;
    const res = (libraryRows || []).find((r) => r.url === url);
    if (!res) return;
    if (btn.dataset.ract === 'open') chrome.tabs.create({ url: res.url });
    if (btn.dataset.ract === 'publish') await act({ type: 'publishOne', url: res.url });
    if (btn.dataset.ract === 'del') {
      await act({ type: 'deleteLibraryRow', targetDomain: res.targetDomain, url: res.url });
      libraryRows = (libraryRows || []).filter((r) => r.url !== url);
      renderLibrary();
    }
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

  // 弹窗遮罩点击关闭
  $('#modal-mask').addEventListener('click', (e) => {
    if (e.target.id === 'modal-mask') closeModal();
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
  // 后台快照推送（sendMessage 单向广播，无连接状态，SW 重启不影响送达）
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'stateChanged') applySnapshot(msg.snapshot);
  });
}

init();
