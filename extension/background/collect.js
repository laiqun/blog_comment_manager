/**
 * 收集控制器：
 * 1. 复用用户提前打开的 sem.3ue.co 共享工具页（dash.3ue.co 面板「打开」所得），直达反向链接报告页
 * 2. 直接从页面表格 DOM 抓取外链行（a[data-test-source-url]），只保留带「博客」标签的来源
 * 3. 抓完一页随机等 3-9s → 点击页面上的「下一页」按钮 → 等表格刷新 → 依次抓完全部页
 * 4. 「开始分析」单独触发：数据集逐条访问 → 分析器采集 → 规则判定（登录/表单/验证码）→ 命中入库
 * 5. 评论区提取评论者网站作为滚雪球种子
 */
import { getState, save, addLog } from '../lib/storage.js';
import { PROVIDERS, ANALYZE_SELECTORS, LOGIN_HINTS, LIMITS } from '../lib/config.js';
import { idbPutAll, idbPut, idbGet, idbGetDomain } from '../lib/idb.js';
import { waitTabComplete, sleep, hostMatches } from '../lib/util.js';

export class CollectController {
  constructor(notify) {
    this.notify = notify; // async (keys) => save + broadcast
    this.busy = false;    // 分析循环是否在跑（仅内存态，SW 重启后由 alarm resume）
    this.scraping = false;// 抓页循环是否在跑
    this.providerDone = false;
    this.roundBase = null; // 本轮分析起始的累积基线（仅用于结束日志里的本轮增量）
  }

  /**
   * 统计累积基线：与空闲时 refreshCollectStatsFromIdb 完全同口径——
   * 已发现=backlinks 条数；已分析=analysis 条数；博客评论资源=analysis 中命中条数（ready/captcha，与资源库筛选一致）；
   * 队列中=backlinks 里未分析过的。运行中的计数都以此基线起算、在其上累加，不清零。
   */
  async statsBaseline(domain) {
    const links = await idbGetDomain('backlinks', domain).catch(() => []);
    const rows = await idbGetDomain('analysis', domain).catch(() => []);
    const analyzedUrls = new Set(rows.map((r) => r.url));
    return {
      links,
      rows,
      discovered: links.length,
      analyzed: rows.length,
      matched: rows.filter((r) => r.status === 'ready' || r.status === 'captcha').length,
      queued: links.filter((r) => !analyzedUrls.has(r.url)).length,
    };
  }

  /** 把四项统计对账为 IndexedDB 当前口径（读取失败则不动，保持原值） */
  async syncStatsFromIdb() {
    const base = await this.statsBaseline(this.cs.targetDomain).catch(() => null);
    if (!base) return;
    const cs = this.cs;
    cs.discovered = base.discovered;
    cs.analyzed = base.analyzed;
    cs.matched = base.matched;
    cs.queued = base.queued;
  }

  get cs() {
    return getState().collectState;
  }

  async start(domain, provider) {
    const cs = this.cs;
    if (cs.status === 'running') throw new Error('收集/分析进行中');
    domain = (domain || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain) throw new Error('请输入目标域名');
    Object.assign(cs, {
      status: 'running',
      mode: 'collect', // collect=只抓外链数据 / analyze=逐条访问+AI 分析
      targetDomain: domain,
      provider: provider in PROVIDERS ? provider : 'semrush',
      phase: 'phaseOpening',
      discovered: 0, analyzed: 0, matched: 0, queued: 0,
      queue: [], seeds: [], seen: [],
      providerTabId: null, analyzeTabId: null,
      startedAt: Date.now(),
    });
    // 四项统计均为跨轮次累积口径：从 IndexedDB 存量基线起算（与空闲时统计刷新一致，本轮不清零）
    const base = await this.statsBaseline(cs.targetDomain);
    cs.seen = base.links.map((r) => r.url); // seen 据此去重，重复抓取不重复计数
    cs.discovered = base.discovered;
    cs.analyzed = base.analyzed;
    cs.matched = base.matched;
    cs.queued = base.queued;
    this.providerDone = false;
    addLog('collect', `开始收集：${PROVIDERS[cs.provider].label} / ${domain}（从页面抓取，仅保留「博客」外链）`, 'info');
    await this.notify(['collectState', 'logs']);

    try {
      await this.ensureProviderTab();
      cs.phase = 'phaseCapturing';
      await this.notify(['collectState']);
    } catch (e) {
      cs.status = 'idle';
      cs.phase = '';
      addLog('collect', `启动失败：${e.message}`, 'error');
      await this.notify(['collectState', 'logs']);
      throw e;
    }
    // 抓页主循环（异步，不阻塞 start 返回）
    this.scrapeAllPages().catch((e) => {
      const cs2 = this.cs;
      if (cs2.status === 'running' && cs2.mode === 'collect') {
        cs2.status = 'idle';
        cs2.phase = '';
        addLog('collect', `抓取失败：${e.message}`, 'error');
        this.notify(['collectState', 'logs']).catch(() => {});
      }
    });
  }

  async ensureProviderTab() {
    const cs = this.cs;
    const prov = PROVIDERS[cs.provider];
    if (prov.dashboardUrl) return this.openViaDashboard(prov);
    // 直连模式（Ahrefs 等待联调）
    if (!prov.backlinksUrlTemplate) {
      throw new Error(`「${prov.label}」的列表页 URL 模板未配置（lib/config.js 待联调项）`);
    }
    const url = prov.backlinksUrlTemplate.replace('{domain}', encodeURIComponent(cs.targetDomain));
    if (cs.providerTabId) {
      try {
        await chrome.tabs.get(cs.providerTabId);
        await chrome.tabs.update(cs.providerTabId, { url });
        await waitTabComplete(cs.providerTabId, LIMITS.navTimeoutMs);
        return cs.providerTabId;
      } catch { cs.providerTabId = null; }
    }
    const tab = await chrome.tabs.create({ url, active: false });
    cs.providerTabId = tab.id;
    await waitTabComplete(tab.id, LIMITS.navTimeoutMs);
    return tab.id;
  }

  /**
   * 面板模式：要求当前活动标签就是用户提前打开的 sem.3ue.co 工具页（dash.3ue.co「打开」所得），
   * 拿 URL 里的 __gmitm 令牌直达反向链接报告页；不是工具页则直接报错。
   */
  async openViaDashboard(prov) {
    const cs = this.cs;
    const tab = await this.findToolTab(prov);
    if (!tab) {
      throw new Error(`当前标签页不是 ${prov.label} 工具页：请先在 dash.3ue.co 点「打开」，并停留在 ${prov.toolHost} 工具页再开始收集`);
    }
    cs.providerTabId = tab.id;
    addLog('collect', `使用当前工具页标签（${prov.toolHost}）`, 'info');
    await this.notify(['logs']);
    await this.gotoBacklinksReport(prov);
    return tab.id;
  }

  /** 当前活动标签必须是工具页（排除清缓存中转页），否则视为未就绪 */
  async findToolTab(prov) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab && tab.url && tab.url.startsWith(`https://${prov.toolHost}/`)
      && !tab.url.includes(prov.toolCachePage) ? tab : null;
  }

  /** 用当前工具页 URL 里的 __gmitm 令牌直达目标域名的反向链接报告页 */
  async gotoBacklinksReport(prov) {
    const cs = this.cs;
    const tabId = cs.providerTabId;
    const tab = await chrome.tabs.get(tabId);
    let token;
    try { token = new URL(tab.url).searchParams.get('__gmitm'); } catch { /* ignore */ }
    if (!token) throw new Error('工具页 URL 缺少 __gmitm 令牌，无法构造外链报告地址');
    addLog('collect', '已取到 __gmitm 令牌，跳转反向链接报告页', 'info');
    await this.notify(['logs']);
    const url = `https://${prov.toolHost}${prov.backlinksPath}?q=${encodeURIComponent(cs.targetDomain)}`
      + `&db=${prov.db}&__gmitm=${encodeURIComponent(token)}`;
    // 直接导航到报告页；仅当目标 URL 与当前完全相同时（Chrome 不会重新加载）改用 reload，
    // 确保页面重新加载后表格重新渲染
    if ((tab.url || '') === url) {
      await chrome.tabs.reload(tabId);
    } else {
      await chrome.tabs.update(tabId, { url });
    }
    const ok = await waitTabComplete(tabId, LIMITS.navTimeoutMs);
    if (!ok) throw new Error('外链报告页加载超时');
    await sleep(LIMITS.pageSettleMs);
  }

  // ---------------- 抓页主循环（纯 DOM，从页面表格读数据 + 点「下一页」） ----------------

  async scrapeAllPages() {
    const cs = this.cs;
    this.scraping = true;
    try {
      const tabId = cs.providerTabId;
      const ready = await this.waitForRows(tabId, LIMITS.navTimeoutMs);
      if (!ready) {
        addLog('collect', '表格迟迟未渲染，停止抓取（可检查页面是否正常显示外链列表）', 'warn');
        return;
      }
      let page = 1;
      while (true) {
        if (cs.status !== 'running' || cs.mode !== 'collect') return;
        const rows = await this.scrapePageRows(tabId);
        const kept = this.onScrapedRows(rows, page);
        addLog('collect', `第 ${page} 页：抓到 ${rows.length} 行，保留「博客」外链 ${kept} 条（累计 ${cs.discovered}）`, 'info');
        await this.notify(['collectState', 'logs']);

        const next = await this.nextBtnState(tabId);
        if (!next.found) { addLog('collect', '页面上没有「下一页」按钮，抓取完成', 'info'); return; }
        if (next.disabled) { addLog('collect', '已是最后一页，抓取完成', 'info'); return; }

        // 抓完一页随机等 pageDelayMin~Max 秒再翻页（收集 Tab 可配置）
        const { pageDelayMinMs, pageDelayMaxMs } = this.pageDelay();
        const delay = pageDelayMinMs + Math.random() * (pageDelayMaxMs - pageDelayMinMs);
        addLog('collect', `${(delay / 1000).toFixed(1)}s 后翻到第 ${page + 1} 页`, 'info');
        await this.notify(['logs']);
        // 长等待拆成小段轮询停止标志：停止响应延迟从最坏 delay 秒降到 ≤0.3s
        const deadline = Date.now() + delay;
        while (Date.now() < deadline) {
          if (cs.status !== 'running' || cs.mode !== 'collect') return;
          await sleep(Math.min(300, deadline - Date.now()));
        }

        const firstBefore = (rows[0] && rows[0].url) || '';
        await this.clickNext(tabId);
        const changed = await this.waitForTableChange(tabId, firstBefore, 30000);
        if (!changed) {
          addLog('collect', '点击「下一页」后表格未刷新，停止抓取', 'warn');
          return;
        }
        page += 1;
      }
    } finally {
      this.scraping = false;
      const cs2 = this.cs;
      if (cs2.status === 'stopping') {
        if (!this.busy) this.finish('stopCollect');
      } else if (cs2.status === 'running' && cs2.mode === 'collect') {
        this.finish('collectDone');
      }
    }
  }

  /**
   * 抓取当前页表格：行 = 源链接所在的 [role=row]；
   * 列 = 按「列头文字 → 索引」映射（中英文界面均可），取全字段：
   * 源URL/源页面标题/分类标签/页面AS/锚链接/目标URL/外部链接/内部链接/首次发现/上次发现
   */
  async scrapePageRows(tabId) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // 列索引按列头文字映射（中英文界面均可）
        const heads = [...document.querySelectorAll('[role="columnheader"]')].map((h) => (h.textContent || '').trim());
        const idxOf = (re) => heads.findIndex((t) => re.test(t));
        const idx = {
          as: idxOf(/页面\s*AS|Page AS/i),
          ext: idxOf(/外部链接|External/i),
          int: idxOf(/内部链接|Internal/i),
          first: idxOf(/首次发现|First seen/i),
          last: idxOf(/上次发现|Last seen/i),
          anchor: idxOf(/锚链接|锚文本|Anchor/i),
        };
        const pick = (cells, i) => (i >= 0 && cells[i] ? (cells[i].innerText || '').trim().slice(0, 100) : '');
        const out = [];
        for (const a of document.querySelectorAll('a[data-test-source-url]')) {
          const url = a.getAttribute('data-test-source-url') || '';
          const row = a.closest('[role="row"]');
          if (!row) continue;
          const cells = [...row.querySelectorAll('[role="gridcell"]')];
          let platform = '';
          const tagEl = row.querySelector('[data-test-type="platform"]');
          if (tagEl) {
            const t = tagEl.querySelector('[data-ui-name="Tag.Text"]');
            platform = ((t ? t.textContent : tagEl.textContent) || '').trim();
          }
          const titleEl = row.querySelector('[data-test-source-title]');
          const title = ((titleEl ? titleEl.textContent : a.innerText) || '').trim().slice(0, 200);
          // 合并列「锚链接和目标 URL」
          let anchor = '';
          let targetUrl = '';
          const anchorCell = idx.anchor >= 0 ? cells[idx.anchor] : null;
          if (anchorCell) {
            const an = anchorCell.querySelector('[data-test-anchor]');
            anchor = ((an ? an.textContent : '') || '').trim().slice(0, 200);
            const tLink = anchorCell.querySelector('a[data-test-target-url]');
            if (tLink) targetUrl = tLink.getAttribute('data-test-target-url') || tLink.getAttribute('href') || '';
            if (!targetUrl) {
              const ext = anchorCell.querySelector('a[data-test-target-url-external-link]');
              if (ext) targetUrl = ext.getAttribute('href') || '';
            }
          }
          out.push({
            url,
            title,
            platform,
            ascore: pick(cells, idx.as),
            anchor,
            targetUrl,
            extLinks: pick(cells, idx.ext),
            intLinks: pick(cells, idx.int),
            firstSeen: pick(cells, idx.first),
            lastSeen: pick(cells, idx.last),
          });
        }
        return out;
      },
    });
    return (res && res.result) || [];
  }

  /** 入库：去重 + 目标站/数据源/静态资源排除 + 只保留「博客」标签行 + 页面 AS 下限筛选；唯一持久层为 IndexedDB */
  onScrapedRows(rows, page) {
    const cs = this.cs;
    const prov = PROVIDERS[cs.provider];
    const seen = new Set(cs.seen);
    const minAs = this.minAscore();
    const idbRows = [];
    let kept = 0;
    let lowAs = 0;
    for (const r of rows || []) {
      let u;
      try { u = new URL(r.url); } catch { continue; }
      if (!/^https?:$/.test(u.protocol)) continue;
      const host = u.hostname.toLowerCase();
      if (hostMatches(host, cs.targetDomain)) continue;                // 排除目标站自身
      if (prov.excludeHosts.some((h) => hostMatches(host, h))) continue; // 排除数据源站
      if (/\.(jpg|jpeg|png|gif|webp|svg|css|js|ico|woff2?|ttf|pdf)(\?|$)/i.test(u.pathname)) continue;
      if (!/博客|blog/i.test(r.platform || '')) continue; // 表格「博客」标签（中文=博客，英文=Blog）
      // 页面 AS 下限：能解析出数值且低于阈值的丢弃（解析不到数值的不过滤，避免列缺失时全军覆没）
      const asText = String(r.ascore || '').trim();
      if (asText !== '') {
        const asNum = Number(asText.replace(/[^\d.]/g, ''));
        if (asNum < minAs) { lowAs++; continue; }
      }
      const norm = u.origin + u.pathname + u.search;
      if (seen.has(norm)) continue;
      if (cs.seen.length >= LIMITS.maxQueue) break;
      seen.add(norm);
      cs.seen.push(norm);
      const row = {
        targetDomain: cs.targetDomain,
        url: norm,
        domain: host.replace(/^www\./, ''),
        title: r.title || '',
        platform: r.platform || '',
        ascore: r.ascore || '',
        anchor: r.anchor || '',
        targetUrl: r.targetUrl || '',
        extLinks: r.extLinks || '',
        intLinks: r.intLinks || '',
        firstSeen: r.firstSeen || '',
        lastSeen: r.lastSeen || '',
        page,
        addedAt: Date.now(),
      };
      idbRows.push(row);
      kept++;
    }
    cs.discovered = cs.seen.length;
    cs.queued += kept; // 新入档的外链尚未分析，队列中同步增长（口径：backlinks − analysis）
    if (lowAs > 0) addLog('collect', `第 ${page} 页有 ${lowAs} 条页面 AS 低于 ${minAs} 被过滤`, 'info');
    if (idbRows.length) {
      idbPutAll('backlinks', idbRows).catch((e) =>
        addLog('collect', `IndexedDB 写入失败：${e.message}`, 'warn'));
    }
    return kept;
  }

  /** 翻页随机间隔（毫秒），读取设置并做合法性收敛 */
  pageDelay() {
    const s = getState().settings;
    let min = Math.min(Math.max(Number(s.pageDelayMinMs) || 3000, 1000), 60000);
    let max = Math.min(Math.max(Number(s.pageDelayMaxMs) || 9000, 1000), 60000);
    if (min > max) [min, max] = [max, min];
    return { pageDelayMinMs: min, pageDelayMaxMs: max };
  }

  /** 页面 AS 下限（收集筛选），读取设置并收敛到 0-100 */
  minAscore() {
    const s = getState().settings;
    return Math.min(Math.max(Number(s.minAscore) || 0, 0), 100);
  }

  async waitForRows(tabId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.cs.status !== 'running') return false;
      const rows = await this.scrapePageRows(tabId).catch(() => []);
      if (rows.length) return true;
      await sleep(1000);
    }
    return false;
  }

  async nextBtnState(tabId) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const b = document.querySelector('[data-test-pagination-next-btn]');
        return b ? { found: true, disabled: !!b.disabled || /disabled/i.test(b.className) } : { found: false, disabled: false };
      },
    });
    return (res && res.result) || { found: false, disabled: false };
  }

  async clickNext(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const b = document.querySelector('[data-test-pagination-next-btn]');
        if (b && !b.disabled) b.click();
      },
    });
  }

  async waitForTableChange(tabId, prevFirstUrl, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.cs.status !== 'running') return false;
      const rows = await this.scrapePageRows(tabId).catch(() => []);
      const first = (rows[0] && rows[0].url) || '';
      if (rows.length && first !== prevFirstUrl) return true;
      await sleep(800);
    }
    return false;
  }

  // ---------------- 分析（「开始分析」单独触发） ----------------

  /** 「开始分析」：对收集数据集里的外链逐条访问 + 规则判定（与收集相互独立、先后执行） */
  async startAnalysis() {
    const cs = this.cs;
    if (cs.status === 'running') throw new Error('收集/分析进行中');
    // 数据只以 IndexedDB 为准（按目标域名累积，跨收集轮次）；统计也从同一基线起算，本轮不清零
    const base = await this.statsBaseline(cs.targetDomain);
    if (!base.links.length) throw new Error('收集数据集为空：请先「开始收集」抓取外链数据');
    // 去重：已分析过的 URL（无论结论）不再重复分析
    const analyzedUrls = new Set(base.rows.map((r) => r.url));
    const pending = base.links.filter((r) => !analyzedUrls.has(r.url));
    Object.assign(cs, {
      status: 'running',
      mode: 'analyze',
      phase: 'phaseAnalyzing',
      discovered: base.discovered,
      analyzed: base.analyzed, matched: base.matched,
      queue: pending.map((r) => r.url),
      analyzeTabId: null,
      startedAt: Date.now(),
    });
    this.roundBase = { analyzed: base.analyzed, matched: base.matched };
    cs.queued = cs.queue.length;
    addLog('collect', `开始分析：数据集共 ${base.links.length} 条，已分析过跳过 ${base.links.length - pending.length} 条，本次待分析 ${pending.length} 条`, 'info');
    await this.notify(['collectState', 'logs']);
    if (pending.length) this.loop();
    else this.finish('analysisDone');
  }

  /** 分析队列主循环 */
  async loop() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (true) {
        const cs = this.cs;
        if (cs.status !== 'running') break;
        if (!cs.queue.length) {
          if (cs.mode === 'analyze') { this.finish('analysisDone'); break; }
          if (this.providerDone) { this.finish('collectDone'); break; }
          await sleep(1500); // 等待队列
          continue;
        }
        cs.phase = 'phaseAnalyzing';
        const url = cs.queue.shift();
        cs.queued = cs.queue.length;
        await this.notify(['collectState']);
        try {
          await this.analyzeOne(url);
        } catch (e) {
          addLog('collect', `分析失败：${e.message}`, 'error', url);
        }
        // 每处理完一条从 IndexedDB 重新对账四项统计：显示值恒等于表口径，
        // 不依赖增量计数（IDB 写失败/异常路径/SW 回收都不会造成漂移）
        await this.syncStatsFromIdb();
        await this.notify(['collectState', 'logs']);
        await sleep(getState().settings.analyzeDelayMs);
      }
    } finally {
      this.busy = false;
      // 用户点了停止：当前条处理完后在这里落地为 idle
      if (this.cs.status === 'stopping') this.finish('stopCollect');
    }
  }

  /**
   * 分析单条外链：复用同一标签页加载，规则判定（Semrush「博客」标签已保证来源类型，无需 AI）。
   * 页面长时间打不开 → 强制中断加载（导航到 about:blank），按无效资源记录原因。
   */
  async analyzeOne(url) {
    const cs = this.cs;
    const tabId = await this.ensureAnalyzeTab();
    try {
      await chrome.tabs.update(tabId, { url });
      const okNav = await waitTabComplete(tabId, LIMITS.navTimeoutMs);
      if (!okNav) {
        // 长时间打不开：强制中断加载，记为无效资源
        await chrome.tabs.update(tabId, { url: 'about:blank' }).catch(() => {});
        await this.recordAnalysis(cs.targetDomain, url, 'invalid',
          `页面加载超时（${Math.round(LIMITS.navTimeoutMs / 1000)}s），已强制中断加载`);
        addLog('collect', '页面加载超时，已强制中断并记为无效资源', 'warn', url);
        return;
      }
      await sleep(LIMITS.pageSettleMs);
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/analyzer.js'] });
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (cfg) => window.__BCM_ANALYZE__ && window.__BCM_ANALYZE__(cfg),
        args: [{ selectors: ANALYZE_SELECTORS, loginHints: LOGIN_HINTS }],
      });
      const data = res && res.result;
      if (!data || !data.ok) throw new Error((data && data.error) || '分析器无返回（页面可能被反爬拦截）');

      // 规则判定：要登录 → 跳过；无评论表单 → 不入库；有表单 → 命中（有验证码标记状态）
      // 可用资源 = analysis 表里命中结论的记录，不再单独写 resources 表
      if (data.loginRequired) {
        await this.recordAnalysis(cs.targetDomain, url, 'login', '页面要求登录后才能评论');
        addLog('collect', '页面要求登录后才能评论，跳过', 'info', url);
        return;
      }
      if (!data.hasForm) {
        await this.recordAnalysis(cs.targetDomain, url, 'no_form', '未找到评论表单');
        addLog('collect', '未找到评论表单，不匹配', 'info', url);
        return;
      }
      // matched 不在运行中增量累加：由 loop 每条的 syncStatsFromIdb 对账得出
      await this.recordAnalysis(cs.targetDomain, url, data.hasCaptcha ? 'captcha' : 'ready',
        data.hasCaptcha ? '命中，有验证码' : '命中，可发布');
      addLog('collect', `命中博客评论资源（评论表单=有${data.hasCaptcha ? '，验证码=有' : ''}）`, 'success', url);
    } catch (e) {
      // 任何异常：中断当前页加载，按无效资源记录原因，再抛给外层计入「已分析」
      await chrome.tabs.update(tabId, { url: 'about:blank' }).catch(() => {});
      await this.recordAnalysis(cs.targetDomain, url, 'invalid', e.message);
      throw e;
    }
  }

  /** 分析结论写入 IndexedDB（失败只告警，不影响主流程）；保留已有记录的 enabled 启停标记 */
  async recordAnalysis(domain, url, status, reason) {
    try {
      const old = await idbGet('analysis', [domain, url]).catch(() => null);
      await idbPut('analysis', { ...(old || {}), targetDomain: domain, url, status, reason, checkedAt: Date.now() });
    } catch (e) {
      addLog('collect', `IndexedDB 分析记录写入失败：${e.message}`, 'warn', url);
    }
  }

  async ensureAnalyzeTab() {
    const cs = this.cs;
    if (cs.analyzeTabId) {
      try { await chrome.tabs.get(cs.analyzeTabId); return cs.analyzeTabId; } catch { cs.analyzeTabId = null; }
    }
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    cs.analyzeTabId = tab.id;
    return tab.id;
  }

  async stop() {
    const cs = this.cs;
    if (cs.status === 'idle') return;
    cs.status = 'stopping';
    cs.phase = 'phaseStopping';
    addLog('collect', '用户停止收集', 'info');
    await this.notify(['collectState', 'logs']);
    // 抓页/分析循环检测到 stopping 后自行落地为 idle
    if (!this.busy && !this.scraping) this.finish('stopCollect');
  }

  async finish(phaseKey) {
    const cs = this.cs;
    cs.status = 'idle';
    cs.phase = phaseKey || '';
    // 收尾时再对账一次四项统计，保证结束态显示与 IndexedDB 表口径一致
    await this.syncStatsFromIdb().catch(() => {});
    let round = '';
    if (this.roundBase) {
      round = `（本轮分析 ${cs.analyzed - this.roundBase.analyzed} / 命中 ${cs.matched - this.roundBase.matched}）`;
      this.roundBase = null;
    }
    addLog('collect', `收集结束：发现 ${cs.discovered} / 分析 ${cs.analyzed} / 命中 ${cs.matched}${round}`, 'success');
    this.notify(['collectState', 'logs']).catch(() => {});
  }

  /** SW 被 alarm 唤醒后续跑：分析续循环；抓页续跑（数据集去重，不会重复入库） */
  resume() {
    const cs = this.cs;
    if (cs.status !== 'running') return;
    if (cs.mode === 'analyze' && !this.busy) this.loop();
    if (cs.mode === 'collect' && !this.scraping) {
      this.scrapeAllPages().catch(() => {});
    }
  }
}
