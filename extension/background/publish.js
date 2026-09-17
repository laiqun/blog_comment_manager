/**
 * 助手发布控制器（无后台任务队列）：
 * 发布流程全部由侧边栏「助手」标签页驱动，操作对象 = 浏览器当前激活的标签页，
 * 任务配置（目标地址/网站介绍/主关键词）= 助手页顶部「当前任务」（state.assistantTask，
 * 可从 IndexedDB templates 表选模板填充）。
 *   步骤：获取标题与摘要 / AI 识别表单 / AI 生成评论 互不依赖、可任意顺序、可反复触发
 *   （同一步骤的并发触发由 stepBusy 去重）；「自动填写表单」需评论已生成，
 *   填表成功后进入 awaiting_review 等人工 Submit / Skip（此阶段步骤仍可重跑并覆盖重填）。
 *   Submit 成功写 published 表（按 [url, targetUrl] 防重复）；Skip 仅清理页面标记。
 *   「换一个」：把当前激活标签页导航到资源库中未发布过的下一条资源（ready 优先于 captcha）。
 *   助手页所需数据（状态文案/摘要/评论/译文/昵称/邮箱）全部落在 publishRuntime
 *   （rt.uiStatus / rt.manual），经快照广播给面板渲染；页面脚本只做无 UI 操作。
 *   绑定页面时的页面检测（验证码/登录/表单）是纯规则判定，不经 AI；
 *   检测到验证码只提示不阻断（人工可在页面里完成验证后继续执行步骤）。
 */
import { getState, addLog } from '../lib/storage.js';
import { PUBLISH_SELECTORS } from '../lib/config.js';
import { idbGet, idbPut, idbGetAll } from '../lib/idb.js';
import { detectForm, generateComment, generateIdentity, summarizeArticle, translateComment } from '../lib/openrouter.js';

/** AI 表单识别失败时的兜底选择器（WordPress 默认评论表单） */
function defaultForm() {
  return {
    comment: PUBLISH_SELECTORS.comment[0],
    author: PUBLISH_SELECTORS.author[0],
    email: PUBLISH_SELECTORS.email[0],
    url: PUBLISH_SELECTORS.website[0],
    submit: PUBLISH_SELECTORS.submit[0],
    saveInfo: PUBLISH_SELECTORS.saveInfo[0],
    linkMethod: 'website_field',
  };
}

/** 文章语言是否就是用户阅读语言（一致则评论译文没有存在必要，省下这次 AI 调用） */
function langMatches(artLang, target) {
  const a = String(artLang || '').toLowerCase();
  if (!a) return false;
  return target === 'en' ? /(en|英)/.test(a) : /(中|zh|chinese)/.test(a);
}

export class PublishAssistant {
  constructor(notify) {
    this.notify = notify;
    // 正在执行中的助手页步骤：按钮不置灰可重复点击，靠这里忽略同一步骤的并发触发
    this.stepBusy = new Set();
  }

  /** 当前激活标签页（助手页的默认操作对象）；非 http(s) 页面不可操作，返回 null */
  async activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab && /^https?:/.test(tab.url || '') ? tab : null;
  }

  /** 当前任务配置：助手页「当前任务」字段，目标地址缺省回落到设置里的身份网址 */
  taskConfig() {
    const st = getState();
    const t = st.assistantTask || {};
    return {
      name: t.name || '',
      targetUrl: t.targetUrl || st.settings.identity.website || '',
      siteIntro: t.siteIntro || '',
      mainKeyword: t.mainKeyword || '',
    };
  }

  /**
   * 绑定激活标签页：publishRuntime 已指向该页面则复用；否则新建会话——
   * 全框架注入 publisher（评论框可能在 iframe 里）+ 纯规则页面检测（验证码/登录/表单），
   * 并查 analysis 表得到 refDomain（「定位目标链接」参考的收集目标域名）。
   */
  async bind(tab) {
    const st = getState();
    const cur = st.publishRuntime;
    if (cur && cur.resourceUrl === tab.url) {
      cur.tabId = tab.id; // SW 回收后 tabId 可能过期，每次操作前刷新
      return cur;
    }
    const rt = st.publishRuntime = {
      resourceUrl: tab.url,
      tabId: tab.id,
      stage: 'awaiting_steps',
      refDomain: '',
      uiStatus: { key: 'asstManual' },
      manual: { title: tab.title || '', excerpt: '', form: null, frameId: 0, comment: null, identity: null },
    };
    try {
      const rows = await idbGetAll('analysis');
      const hit = rows.find((r) => r && r.url === tab.url);
      if (hit) rt.refDomain = hit.targetDomain || '';
    } catch { /* 查不到则面板「定位目标链接」会提示 */ }
    await this.injectAll(tab.id).catch(() => {});
    const d = await this.detectAll(tab.id).catch(() => null);
    if (st.publishRuntime !== rt) return rt; // 检测期间用户切到了别的页面
    if (!d) {
      rt.uiStatus = { text: '无法注入页面脚本（可能被反爬拦截），可尝试手动复制评论粘贴' };
    } else {
      rt.manual = { ...rt.manual, title: d.title || rt.manual.title, excerpt: d.excerpt, frameId: (d.forms[0] && d.forms[0].frameId) || 0 };
      if (d.hasCaptcha) {
        await this.markCaptcha(tab.url);
        rt.uiStatus = { key: 'asstCaptcha' };
        addLog('publish', '检测到验证码，已标记资源；可在页面中手动完成验证后继续执行步骤', 'warn', tab.url);
      } else if (d.loginRequired) {
        rt.uiStatus = { key: 'asstLogin' };
      } else if (!d.forms.length) {
        // 未找到表单不代表没有表单：可人工找到后点「识别表单」重试，或生成评论后复制手动粘贴
        rt.uiStatus = { key: 'asstNoForm' };
      }
    }
    // 同目标网址已在此页面发布过：提示避免重复评论（不阻断，用户显式操作仍可继续）
    const cfg = this.taskConfig();
    if (cfg.targetUrl && await idbGet('published', [tab.url, cfg.targetUrl]).catch(() => null)) {
      rt.uiStatus = { key: 'asstAlreadyPublished' };
    }
    await this.notify(['publishRuntime', 'logs']);
    return rt;
  }

  /** 发布成功：记入 published 表（已发过的外链，按 [url, targetUrl] 去重） */
  async markPublished(url, targetUrl, taskName) {
    try {
      await idbPut('published', { url, targetUrl, taskName: taskName || '', publishedAt: Date.now() });
    } catch (e) {
      addLog('publish', `published 表写入失败：${e.message}`, 'warn', url);
    }
  }

  /** 发现验证码：把 analysis 表里的资源结论改为 captcha（保留 enabled 标记） */
  async markCaptcha(url) {
    try {
      const rows = await idbGetAll('analysis');
      const hit = rows.find((r) => r && r.url === url && r.status === 'ready');
      if (hit) await idbPut('analysis', { ...hit, status: 'captcha', reason: '发布时检测到验证码', checkedAt: Date.now() });
    } catch { /* 标记失败不影响主流程 */ }
  }

  /** 注入 publisher.js 到页面的所有框架（评论框可能在 iframe 里，如 Disqus）；个别框架不可注入时退回主框架 */
  async injectAll(tabId) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content/publisher.js'] });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/publisher.js'] });
    }
  }

  /**
   * 跨框架采集：在每个框架里执行 detect 并合并结果。
   * 标题/正文取主框架；表单候选跨框架合并并带上 frameId（后续填表/提交/高亮按 frameId 定向）；
   * 验证码与登录提示可能在 iframe 里，跨框架取并集。
   */
  async detectAll(tabId) {
    const cfg = {
      func: (c) => window.__BCM_PUB__ && window.__BCM_PUB__.detect(c),
      args: [{ selectors: PUBLISH_SELECTORS }],
    };
    let results;
    try {
      results = await chrome.scripting.executeScript({ ...cfg, target: { tabId, allFrames: true } });
    } catch {
      // 个别框架无法注入时（如 chrome:// 子框架）退回只采主框架
      results = await chrome.scripting.executeScript({ ...cfg, target: { tabId } });
    }
    const frames = (results || []).filter((r) => r && r.result && r.result.ok);
    if (!frames.length) return null;
    const top = frames.find((r) => r.frameId === 0) || frames[0];
    const forms = [];
    for (const r of frames) {
      for (const f of r.result.forms || []) forms.push({ ...f, frameId: r.frameId });
    }
    forms.sort((a, b) => (b.visible ? 1 : 0) - (a.visible ? 1 : 0));
    return {
      ok: true,
      title: top.result.title,
      excerpt: top.result.excerpt,
      forms: forms.slice(0, 3),
      hasCaptcha: frames.some((r) => r.result.hasCaptcha),
      loginRequired: frames.some((r) => r.result.loginRequired),
    };
  }

  /** 在表单所在框架里执行填表/提交/高亮（表单可能在 iframe 中） */
  async frameCall(tabId, frameId, fn, arg) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId || 0] },
      func: (f, a) => window.__BCM_PUB__ && window.__BCM_PUB__[f] && window.__BCM_PUB__[f](a),
      args: [fn, arg],
    });
    return res && res.result;
  }

  /** 标题与摘要：长正文先经 AI 提炼（语言由设置 summaryLang 决定）；失败退回原标题 + 原始摘录 */
  async summarize(url, title, excerpt) {
    try {
      const art = await summarizeArticle({ title, text: excerpt, lang: getState().settings.summaryLang || 'zh' });
      addLog('ai', `标题与摘要完成（${art.summary.length} 字）`, 'info', url);
      return art;
    } catch (e) {
      addLog('ai', `标题与摘要失败，改用原标题与原始摘录：${e.message}`, 'warn', url);
      return { title: title || '', summary: excerpt || '', language: '' };
    }
  }

  /**
   * 助手页步骤按钮回调：获取标题与摘要 / 识别表单 / 生成评论 / 填写表单。
   * 操作对象 = 当前激活标签页；rt.uiStatus / rt.manual 更新后 notify，由面板从快照渲染
   * （uiStatus.key 走 i18n 翻译，动态错误文本用 uiStatus.text 直显）。
   */
  async onStep(step) {
    if (!['summarize', 'detectForm', 'genComment', 'fill'].includes(step)) return { ok: false, error: '未知步骤' };
    // 同一步骤正在执行时忽略重复触发（面板按钮不置灰，防并发在这里兜底）
    if (this.stepBusy.has(step)) return { ok: true };
    const tab = await this.activeTab();
    if (!tab) return { ok: false, error: '当前标签页不是可操作的网页' };
    this.stepBusy.add(step);

    try {
      const rt = await this.bind(tab);
      const st = getState();
      const cfg = this.taskConfig();
      const url = tab.url;
      const m = rt.manual || {};
      // 步骤开始：先更新状态文案并广播，让面板立刻显示「进行中」
      const begin = async (key) => { rt.uiStatus = { key }; await this.notify(['publishRuntime']); };

      if (step === 'summarize') {
        // 获取标题与摘要：AI 按设置里的 summaryLang 输出，同时识别文章语言；展示到助手页（可复制）
        await begin('asstSummarizing');
        const art = await this.summarize(url, m.title, m.excerpt);
        rt.manual = { ...m, sumTitle: art.title, summary: art.summary, artLang: art.language };
        rt.uiStatus = { key: 'asstSumDone' };
      } else if (step === 'detectForm') {
        await begin('asstDetecting');
        // 重新采集页面表单候选（跨框架，标题/摘要一并刷新）；表单可能在 iframe 里，记住 frameId
        const d = await this.detectAll(tab.id).catch(() => null);
        const frameId = (d && d.forms.length && d.forms[0].frameId) || 0;
        // 允许识别失败：表单留空也继续走「生成评论」，评论会展示在助手页上，可手动复制粘贴
        let form = null;
        if (d && d.ok && d.forms.length) {
          try {
            form = await detectForm({ formHtml: d.forms[0].html, pageUrl: url });
            if (!form || !form.comment) throw new Error('未识别到评论文本框');
            addLog('ai', `表单识别成功${frameId ? '（在 iframe 中）' : ''}（留链方式：${form.linkMethod || 'website_field'}）`, 'success', url);
          } catch (e) {
            addLog('ai', `表单识别失败，使用默认选择器兜底：${e.message}`, 'warn', url);
            form = defaultForm();
          }
        } else {
          addLog('publish', '页面上未找到评论表单，跳过表单识别（生成评论后可从助手页复制手动填写）', 'warn', url);
        }
        rt.manual = { ...m, title: (d && d.title) || m.title, excerpt: (d && d.excerpt) || m.excerpt, form, frameId };
        // 滚动到识别出的表单并高亮（在表单所在框架执行），让人工确认 AI 的识别结果
        if (form) await this.frameCall(tab.id, frameId, 'markForm', form);
        rt.uiStatus = { key: 'asstFormDone' };
      } else if (step === 'genComment') {
        // 不依赖表单识别结果：识别失败也照常生成评论，展示在助手页上供手动复制
        await begin('asstGenerating');
        // 标题与摘要优先复用「获取标题与摘要」的缓存；没点过则自动生成一次（同样缓存，
        // 反复点「生成评论」换一条时不会重复总结）
        const art = (m.summary != null && m.sumTitle != null)
          ? { title: m.sumTitle, summary: m.summary, language: m.artLang || '' }
          : await this.summarize(url, m.title, m.excerpt);
        const comment = await generateComment(
          { url, title: art.title, text: art.summary },
          {
            targetUrl: cfg.targetUrl,
            siteIntro: cfg.siteIntro,
            mainKeyword: cfg.mainKeyword,
            articleLang: art.language,
          },
        );
        addLog('ai', comment.includes('<a') ? '评论生成完成（正文内嵌链接）' : '评论生成完成', 'success', url);
        let identity;
        try {
          identity = await generateIdentity({ title: art.title, text: art.summary });
          addLog('ai', `身份生成：${identity.name} <${identity.email}>`, 'info', url);
        } catch (e) {
          addLog('ai', `身份生成失败，使用设置里的默认身份：${e.message}`, 'warn', url);
          identity = { name: st.settings.identity.name, email: st.settings.identity.email };
        }
        identity.website = ''; // 网址字段留空，链接只通过评论正文的 <a> 传递
        // 评论译文：仅展示给用户看（评论语言跟随文章，用户未必读得懂），不参与填表；
        // 文章语言与阅读语言一致时跳过；翻译失败不影响主流程
        let translation = '';
        const readLang = st.settings.summaryLang || 'zh';
        if (!langMatches(art.language, readLang)) {
          try {
            translation = await translateComment(comment, readLang);
          } catch (e) {
            addLog('ai', `评论译文生成失败（不影响发布）：${e.message}`, 'warn', url);
          }
        }
        // 评论/译文/昵称/邮箱全部落进 rt.manual，由助手页从快照渲染（每个字段带复制按钮）
        rt.manual = { ...m, sumTitle: art.title, summary: art.summary, artLang: art.language, comment, translation, identity };
        rt.uiStatus = { key: 'asstCommentDone' };
      } else if (step === 'fill') {
        if (!m.comment) throw new Error('请先生成评论，再执行「自动填写表单」');
        await begin('asstFilling');
        // 表单识别失败时用默认选择器兜底；仍填不进去可重试，或从助手页复制评论手动粘贴
        const form = m.form || defaultForm();
        const f = await this.frameCall(tab.id, m.frameId || 0, 'fill',
          { form, comment: m.comment, identity: m.identity, mode: 'semi', resourceUrl: url });
        if (!f || !f.ok) throw new Error((f && f.error) || '未知错误');
        addLog('publish', `表单已填入（正文:${f.filled.comment ? '✓' : '✗'} 昵称:${f.filled.author ? '✓' : '✗'} 邮箱:${f.filled.email ? '✓' : '✗'} 网址:${f.filled.website ? '✓' : '✗'}）`, 'info', url);
        // fill 成功后进入待确认阶段：面板按 stage === 'awaiting_review' 解锁 Submit / Skip
        rt.stage = 'awaiting_review';
        rt.uiStatus = { key: 'asstReady' };
      }
      await this.notify(['publishRuntime', 'logs']);
      return { ok: true };
    } catch (e) {
      addLog('publish', `步骤执行失败：${e.message}`, 'error', tab.url);
      const rt = getState().publishRuntime;
      if (rt && rt.resourceUrl === tab.url) rt.uiStatus = { text: `步骤失败：${e.message}` }; // 面板直显，可直接再点一次该步骤重试
      await this.notify(['publishRuntime', 'logs']);
      return { ok: false, error: e.message };
    } finally {
      this.stepBusy.delete(step);
    }
  }

  /**
   * 助手页「定位目标链接」：在当前标签页主框架循环标记指向收集目标域名的锚点。
   * 结果（{ ok, index, total } 或 { ok:false, reason }）随消息响应返回给面板展示。
   */
  async onLocate() {
    const tab = await this.activeTab();
    if (!tab) return { ok: false, reason: 'noPage' };
    const rt = await this.bind(tab);
    if (!rt.refDomain) return { ok: false, reason: 'noTarget' };
    try {
      const res = await this.frameCall(tab.id, 0, 'locateLink', { domain: rt.refDomain });
      return res || { ok: false, reason: 'noLink' };
    } catch {
      return { ok: false, reason: 'noLink' }; // 页面可能已跳转/关闭
    }
  }

  /** 助手页 Submit / Skip 回调：仅 awaiting_review（表单已填好待确认）可执行 */
  async onDecision(decision) {
    const tab = await this.activeTab();
    const rt = getState().publishRuntime;
    if (!tab || !rt || rt.resourceUrl !== tab.url || rt.stage !== 'awaiting_review') return { ok: false };
    const cfg = this.taskConfig();

    if (decision === 'submit') {
      try {
        // 提交在表单所在框架执行（iframe 里的表单在对应框架提交）
        const s = await this.frameCall(tab.id, (rt.manual && rt.manual.frameId) || 0, 'submit');
        if (s && s.ok) {
          await this.markPublished(rt.resourceUrl, cfg.targetUrl, cfg.name);
          addLog('publish', '✓ 人工确认，已提交', 'success', rt.resourceUrl);
          rt.uiStatus = { key: 'asstSubmitted' };
          // 已提交成功的评论作废：强制重新生成，避免页面刷新后误重复提交同一条
          rt.manual = { ...(rt.manual || {}), comment: null, translation: '', identity: null };
        } else {
          // 提交失败时表单已填好，保留 awaiting_review 让人工检查后再点 Submit 或手动提交
          addLog('publish', `✗ 提交失败：${(s && s.error) || '未知'}（表单内容仍在页面上，可检查后重试）`, 'error', rt.resourceUrl);
          rt.uiStatus = { text: `提交失败：${(s && s.error) || '未知'}，可直接在页面上检查后再点 Submit` };
          await this.notify(['publishRuntime', 'logs']);
          return { ok: true };
        }
      } catch (e) {
        addLog('publish', `✗ 提交异常：${e.message}`, 'error', rt.resourceUrl);
        rt.uiStatus = { text: `提交异常：${e.message}` };
        await this.notify(['publishRuntime', 'logs']);
        return { ok: true };
      }
    } else {
      addLog('publish', '⊘ 人工跳过', 'info', rt.resourceUrl);
      rt.uiStatus = { key: 'asstSkipped' };
    }

    try {
      // 表单高亮/链接标记可能在 iframe 里：全框架清理，恢复页面原样
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => window.__BCM_PUB__ && window.__BCM_PUB__.cleanup() });
    } catch { /* tab may be gone */ }

    // 停在当前页面，退回步骤阶段：可继续操作本页，或点「换一个」去下一条未发布资源
    rt.stage = 'awaiting_steps';
    await this.notify(['publishRuntime', 'logs']);
    return { ok: true };
  }

  /**
   * 助手页「换一个」：把当前激活标签页导航到资源库中未发布过的下一条资源。
   * 口径与资源库一致：analysis 表命中结论（ready/captcha）且启用，published 表无记录；
   * ready 优先于 captcha，同档按命中时间新→旧。
   */
  async pickNext() {
    const tab = await this.activeTab();
    if (!tab) return { ok: false, error: '当前标签页不可导航' };
    const [analysis, published] = await Promise.all([
      idbGetAll('analysis').catch(() => []),
      idbGetAll('published').catch(() => []),
    ]);
    const pubUrls = new Set(published.map((r) => r && r.url));
    const seen = new Set();
    const candidates = analysis
      .filter((r) => r && r.url && (r.status === 'ready' || r.status === 'captcha')
        && r.enabled !== false && !pubUrls.has(r.url) && r.url !== tab.url)
      .filter((r) => !seen.has(r.url) && seen.add(r.url))
      .sort((a, b) => ((a.status === 'ready' ? 0 : 1) - (b.status === 'ready' ? 0 : 1)) || ((b.checkedAt || 0) - (a.checkedAt || 0)));
    if (!candidates.length) return { ok: false, error: '资源库中没有未发布过的资源了' };
    const url = candidates[0].url;
    await chrome.tabs.update(tab.id, { url });
    addLog('publish', '换一个：已在当前标签页打开下一条未发布资源', 'info', url);
    await this.notify(['logs']);
    return { ok: true, url };
  }
}
