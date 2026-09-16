/**
 * 通用工具函数。
 */

export function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 等待某个 tab 完成 loaded 状态，超时返回 false */
export function waitTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(false); } }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete' && !done) {
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete' && !done) {
        // 已加载完成的标签（例如复用的旧 tab 导航前状态），仍等一次事件；
        // 若 800ms 内无事件则直接放行
        setTimeout(() => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve(true);
          }
        }, 800);
      }
    }).catch(() => {
      if (!done) { done = true; clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(false); }
    });
  });
}

/** 从任意 JSON 结构里递归抽出 http(s) 绝对 URL（外链拦截的通用兜底） */
export function extractUrlsDeep(obj, { excludeHosts = [], excludeDomains = [] } = {}) {
  const found = new Set();
  const exclude = [...excludeHosts, ...excludeDomains];
  const visit = (v, depth) => {
    if (depth > 12 || v == null) return;
    if (typeof v === 'string') {
      const m = v.match(/^https?:\/\/[^\s"'<>\\]+$/i);
      if (m) {
        try {
          const u = new URL(v);
          const host = u.hostname.toLowerCase();
          if (!exclude.some((h) => hostMatches(host, h))) found.add(u.origin + u.pathname + u.search);
        } catch { /* ignore */ }
      }
      return;
    }
    if (Array.isArray(v)) { for (const it of v) visit(it, depth + 1); return; }
    if (typeof v === 'object') { for (const k of Object.keys(v)) visit(v[k], depth + 1); }
  };
  visit(obj, 0);
  return [...found];
}

/** 从 HTML 里提取评论者留下的网站链接（滚雪球种子） */
export function extractCommenterSites(html, pageHost = '') {
  const out = new Set();
  try {
    const re = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>/gi;
    let m;
    while ((m = re.exec(html))) {
      try {
        const u = new URL(m[1]);
        if (u.hostname !== pageHost && !/wp\.login|wordpress|feed|\.xml$/i.test(u.hostname + u.pathname)) {
          out.add(u.hostname.replace(/^www\./, ''));
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return [...out].slice(0, 50);
}

/** 资源列表 → CSV（带 BOM，Excel 友好） */
export function toCSV(resources) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['url', 'domain', 'type', 'status', 'addedAt', 'publishedAt'];
  const lines = [head.join(',')];
  for (const r of resources) {
    lines.push([r.url, r.domain, r.type, r.status, fmtDate(r.addedAt), fmtDate(r.publishedAt)].map(esc).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

/** 收集数据集（Semrush 博客外链行）→ CSV（带 BOM，Excel 友好） */
export function backlinksCsv(rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['url', 'domain', 'title', 'platform', 'ascore', 'anchor', 'targetUrl', 'extLinks', 'intLinks', 'firstSeen', 'lastSeen', 'page', 'addedAt'];
  const lines = [head.join(',')];
  for (const r of rows || []) {
    lines.push([
      esc(r.url), esc(r.domain), esc(r.title), esc(r.platform),
      esc(r.ascore), esc(r.anchor), esc(r.targetUrl), esc(r.extLinks), esc(r.intLinks),
      esc(r.firstSeen), esc(r.lastSeen),
      r.page ?? '', esc(fmtDate(r.addedAt)),
    ].join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

/** 上层域匹配：host 是否属于 domain（含子域） */
export function hostMatches(host, domain) {
  if (!host || !domain) return false;
  host = host.toLowerCase().replace(/^www\./, '');
  domain = domain.toLowerCase().replace(/^www\./, '');
  return host === domain || host.endsWith('.' + domain);
}
