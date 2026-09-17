/**
 * 发布任务调度器：
 * 任务 = 一批资源（resourceUrls，即可用资源的页面 URL，来自 analysis 表命中记录）。逐条执行：
 *   打开页面 → 全框架注入 publisher（评论框可能在 iframe 里，如 Disqus；detect 跨框架合并、
 *   填表/提交/高亮按表单所在 frameId 定向）→ 采集页面信息（验证码/登录/表单检查，非 AI）
 *   → 全自动：AI 表单识别 → AI 生成评论 → 自动填表 → 直接提交
 *   → 半自动：停在 awaiting_steps，由浮层按钮手动触发（「生成评论」与「识别表单」互不依赖、
 *     可任意顺序执行；步骤按钮不置灰、可反复点击，同一步骤的并发触发由 onStep 的
 *     stepBusy 去重忽略；「填写表单」需评论已生成），
 *     填表后进入 awaiting_review 等人工 Submit / Skip（此阶段步骤仍可重跑并覆盖重填）
 *   发布成功写 published 表 + 任务计数
 *   失败（超时/无表单/验证码/填表/提交失败等）保留标签页不关闭，便于人工接管；
 *   半自动模式找不到表单不判失败，直接进入手动流程（可重试识别或复制评论手动粘贴）
 */
import { getState, save, addLog, findTask } from '../lib/storage.js';
import { PUBLISH_SELECTORS, LIMITS } from '../lib/config.js';
import { idbGet, idbPut, idbGetAll } from '../lib/idb.js';
import { detectForm, generateComment, checkRelevance, generateIdentity, summarizeArticle, translateComment } from '../lib/openrouter.js';
import { waitTabComplete, sleep } from '../lib/util.js';

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

export class PublishRunner {
  constructor(notify) {
    this.notify = notify;
    this.busy = false;
    // 正在执行中的浮层步骤：按钮不置灰可重复点击，靠这里忽略同一步骤的并发触发
    this.stepBusy = new Set();
  }

  async startTask(taskId) {
    const task = findTask(taskId);
    if (!task) throw new Error('任务不存在');
    if (task.status === 'running') throw new Error('任务已在运行');
    if (!(task.resourceUrls || []).length) throw new Error('任务没有任何资源');
    task.status = 'running';
    task.results = task.results || {};
    task.finishedAt = 0;
    const st = getState();
    st.activeTaskId = taskId;
    st.publishRuntime = { taskId, resourceUrl: null, stage: 'opening', tabId: null };
    addLog('publish', `任务「${task.name}」开始，共 ${task.resourceUrls.length} 条资源`, 'info');
    await this.notify(['tasks', 'activeTaskId', 'publishRuntime', 'logs']);
    this.loop();
  }

  async loop() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (true) {
        const st = getState();
        const rt = st.publishRuntime;
        if (!rt) break;
        const task = findTask(rt.taskId);
        if (!task || task.status !== 'running') break;

        const nextUrl = (task.resourceUrls || []).find((u) => !(u in (task.results || {})));
        if (!nextUrl) {
          this.finishTask(task, 'done');
          break;
        }
        rt.resourceUrl = nextUrl;
        rt.stage = 'opening';
        await this.notify(['publishRuntime', 'tasks']);
        await this.publishOne(task, nextUrl);
        // 半自动模式停在 awaiting_steps / awaiting_review，等浮层操作唤醒
        const stage = getState().publishRuntime && getState().publishRuntime.stage;
        if (stage === 'awaiting_review' || stage === 'awaiting_steps') break;
      }
    } finally {
      this.busy = false;
    }
  }

  /** 发布成功：记入 published 表（已发过的外链，按 [url, targetUrl] 去重） */
  async markPublished(task, url) {
    const targetUrl = task.targetUrl || getState().settings.identity.website || '';
    try {
      await idbPut('published', { url, targetUrl, taskId: task.id, publishedAt: Date.now() });
    } catch (e) {
      addLog('publish', `published 表写入失败：${e.message}`, 'warn', url);
    }
  }

  /** 发布途中发现验证码：把 analysis 表里的资源结论改为 captcha（保留 enabled 标记） */
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

  /** 在表单所在框架里执行填表/提交/高亮（表单可能在 iframe 中；浮层操作仍在主框架） */
  async frameCall(tabId, frameId, fn, arg) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId || 0] },
      func: (f, a) => window.__BCM_PUB__ && window.__BCM_PUB__[f] && window.__BCM_PUB__[f](a),
      args: [fn, arg],
    });
    return res && res.result;
  }

  /** 标题与摘要：长正文先经 AI 提炼（语言由设置 summaryLang 决定）；失败退回原标题 + 原始摘录 */  async summarize(url, title, excerpt) {
    try {
      const art = await summarizeArticle({ title, text: excerpt, lang: getState().settings.summaryLang || 'zh' });
      addLog('ai', `标题与摘要完成（${art.summary.length} 字）`, 'info', url);
      return art;
    } catch (e) {
      addLog('ai', `标题与摘要失败，改用原标题与原始摘录：${e.message}`, 'warn', url);
      return { title: title || '', summary: excerpt || '', language: '' };
    }
  }

  async publishOne(task, url) {
    const st = getState();
    const rt = st.publishRuntime;

    // 同目标网址已在此页面发布过：跳过，避免重复评论
    const targetUrl = task.targetUrl || st.settings.identity.website || '';
    if (targetUrl && await idbGet('published', [url, targetUrl]).catch(() => null)) {
      return this.record(task, url, 'skip', '该页面已发布过此目标链接，跳过');
    }

    // 复用或新建发布标签页
    let tabId = rt.tabId;
    if (tabId) {
      try { await chrome.tabs.get(tabId); } catch { tabId = null; rt.tabId = null; }
    }
    if (!tabId) {
      // 半自动模式直接聚焦新标签页，便于人工盯着浮层操作
      const tab = await chrome.tabs.create({ url: 'about:blank', active: task.mode !== 'auto' });
      tabId = tab.id;
      rt.tabId = tabId;
    }
    await chrome.tabs.update(tabId, { url });
    addLog('publish', `打开资源页面...`, 'info', url);
    const okNav = await waitTabComplete(tabId, LIMITS.navTimeoutMs);
    if (getState().publishRuntime !== rt) return; // 任务中途被停/删
    if (!okNav) return this.recordKeepTab(task, rt, url, 'fail', '页面加载超时');
    await sleep(LIMITS.pageSettleMs);

    // 注入并采集页面信息（全框架：评论框可能在 iframe 里）；半自动模式页面一打开就显示浮层（状态随流程更新）
    await this.injectAll(tabId);
    // 「定位目标链接」参考的是收集时输入的同行站点域名：资源页面里本就存在指向它的外链
    let refDomain = '';
    try {
      const rows = await idbGetAll('analysis');
      const hit = rows.find((r) => r && r.url === url);
      if (hit) refDomain = hit.targetDomain || '';
    } catch { /* 查不到则定位按钮会提示 */ }
    if (task.mode !== 'auto') {
      // stepTimeoutMs：浮层步骤按钮的看门狗时长——一步最多串行 3 次 AI 调用（摘要/评论/身份），
      // 超时后浮层自行解锁按钮，防止 SW 被回收导致按钮永久禁用
      const stepTimeoutMs = (Number(st.settings.aiTimeoutMs) || 20000) * 3 + 30000;
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (cfg) => window.__BCM_PUB__ && window.__BCM_PUB__.showOverlay(cfg),
        args: [{ lang: st.settings.language, refDomain, resourceUrl: url, stepTimeoutMs }],
      }).catch(() => {});
    }
    const d = await this.detectAll(tabId).catch(() => null);
    if (getState().publishRuntime !== rt) return;
    if (!d) return this.recordKeepTab(task, rt, url, 'fail', '无法注入页面脚本（可能被反爬拦截）');
    if (d.hasCaptcha) {
      await this.markCaptcha(url);
      return this.recordKeepTab(task, rt, url, 'captcha', '检测到验证码，已标记资源');
    }
    if (d.loginRequired) return this.recordKeepTab(task, rt, url, 'fail', '该站需要登录才能评论');
    if (!d.forms.length) {
      // 半自动：未找到表单不代表没有表单——保留页面进手动流程，人工找到表单后可点浮层「识别表单」重试，
      // 或「生成评论」后从浮层复制评论手动粘贴提交
      if (task.mode !== 'auto') {
        rt.stage = 'awaiting_steps';
        rt.refDomain = refDomain;
        rt.manual = { title: d.title, excerpt: d.excerpt, form: null, comment: null, identity: null };
        addLog('publish', '未自动找到评论表单，页面已保留：可人工定位表单后点浮层「识别表单」重试，或「生成评论」后复制手动填写', 'warn', url);
        await this.notify(['publishRuntime', 'logs']);
        await this.overlayCall(tabId, 'setStep', 'detectForm');
        return;
      }
      return this.recordKeepTab(task, rt, url, 'fail', '未找到评论表单');
    }

    // 半自动：到此为止（页面检测不是 AI 操作），AI 步骤由浮层按钮手动触发
    if (task.mode !== 'auto') {
      rt.stage = 'awaiting_steps';
      rt.refDomain = refDomain;
      // frameId 预填表单候选所在框架：用户跳过「识别表单」直接填表时也能定向到 iframe
      rt.manual = { title: d.title, excerpt: d.excerpt, form: null, frameId: d.forms[0].frameId || 0, comment: null, identity: null };
      addLog('publish', '页面已就绪，请在浮层中手动执行各步骤（获取标题与摘要 / 生成评论 / 识别表单 / 填写表单）', 'info', url);
      await this.notify(['publishRuntime', 'logs']);
      await this.overlayCall(tabId, 'setStep', 'detectForm');
      return;
    }

    // 以下为全自动模式的连续 AI 流程
    // 先把（可能截断的）正文提炼成 AI 标题+摘要，相关性判断/评论生成/身份生成统一用摘要
    const art = await this.summarize(url, d.title, d.excerpt);

    // AI 相关性预判：文章与目标网站搭不上边就直接跳过，不发评论
    if (task.siteIntro || task.mainKeyword) {
      try {
        const rel = await checkRelevance({
          title: art.title, text: art.summary,
          siteIntro: task.siteIntro, mainKeyword: task.mainKeyword,
        });
        addLog('ai', `相关性判断：${rel.related ? '相关' : '不相关'}（${rel.reason}）`, rel.related ? 'info' : 'warn', url);
        if (!rel.related) return this.record(task, url, 'skip', `主题不相关，跳过：${rel.reason}`);
      } catch (e) {
        addLog('ai', `相关性判断失败（继续流程）：${e.message}`, 'warn', url);
      }
    }

    // AI 表单识别（失败时用默认 WordPress 选择器兜底）；表单可能在 iframe 里，记住其 frameId 供填表/提交定向
    const formFrameId = (d.forms[0] && d.forms[0].frameId) || 0;
    let form;
    try {
      form = await detectForm({ formHtml: d.forms[0].html, pageUrl: url });
      if (!form || !form.comment) throw new Error('未识别到评论文本框');
      addLog('ai', `表单识别成功（留链方式：${form.linkMethod || 'website_field'}）`, 'success', url);
    } catch (e) {
      addLog('ai', `表单识别失败，使用默认选择器兜底：${e.message}`, 'warn', url);
      form = defaultForm();
    }

    // AI 生成评论：正文内嵌 <a> 链接（主关键词变体锚文本，website 字段留空）
    let comment;
    try {
      comment = await generateComment(
        { url, title: art.title, text: art.summary },
        {
          targetUrl: task.targetUrl || st.settings.identity.website,
          siteIntro: task.siteIntro || '',
          mainKeyword: task.mainKeyword || '',
          articleLang: art.language,
        },
      );
      addLog('ai', comment.includes('<a') ? '评论生成完成（正文内嵌链接）' : '评论生成完成', 'success', url);
    } catch (e) {
      return this.recordKeepTab(task, rt, url, 'fail', `评论生成失败：${e.message}`);
    }

    // 填表身份：昵称与邮箱由 AI 生成（失败退回设置里的静态身份）；website 留空
    let identity;
    try {
      identity = await generateIdentity({ title: art.title, text: art.summary });
      addLog('ai', `身份生成：${identity.name} <${identity.email}>`, 'info', url);
    } catch (e) {
      addLog('ai', `身份生成失败，使用设置里的默认身份：${e.message}`, 'warn', url);
      identity = { name: st.settings.identity.name, email: st.settings.identity.email };
    }
    identity.website = ''; // 网址字段留空，链接只通过评论正文的 <a> 传递
    const f = await this.frameCall(tabId, formFrameId, 'fill',
      { form, comment, identity, mode: task.mode, lang: st.settings.language, resourceUrl: url, refDomain });
    if (getState().publishRuntime !== rt) return;
    if (!f || !f.ok) {
      return this.recordKeepTab(task, rt, url, 'fail', `表单填写失败：${(f && f.error) || '未知错误'}`);
    }
    addLog('publish', `表单已填入（正文:${f.filled.comment ? '✓' : '✗'} 昵称:${f.filled.author ? '✓' : '✗'} 邮箱:${f.filled.email ? '✓' : '✗'} 网址:${f.filled.website ? '✓' : '✗'}）`, 'info', url);

    const s = await this.frameCall(tabId, formFrameId, 'submit');
    if (s && s.ok) {
      await this.markPublished(task, url);
      this.record(task, url, 'success', '全自动已提交');
    } else {
      // 提交失败时表单已填好，保留页面让人工检查后可手动点提交
      this.recordKeepTab(task, rt, url, 'fail', `提交失败：${(s && s.error) || '未知'}`);
    }
    await sleep(2000);
  }

  /** 半自动浮层的步骤按钮回调：识别表单 → 生成评论 → 填写表单，逐步手动执行 */
  async onStep(resourceUrl, step) {
    const st = getState();
    const rt = st.publishRuntime;
    // awaiting_review（已填表待确认）也允许重跑步骤：对填入内容不满意可重新生成/识别后再填
    if (!rt || rt.resourceUrl !== resourceUrl || (rt.stage !== 'awaiting_steps' && rt.stage !== 'awaiting_review')) return;
    const task = findTask(rt.taskId);
    if (!task) return;
    // 同一步骤正在执行时忽略重复触发（浮层按钮不置灰，防并发在这里兜底）
    if (this.stepBusy.has(step)) return;
    this.stepBusy.add(step);
    const tabId = rt.tabId;
    const m = rt.manual || {};

    try {
      if (step === 'summarize') {
        // 获取标题与摘要：AI 按设置里的 summaryLang 输出，同时识别文章语言；展示到浮层（可复制）
        await this.overlayCall(tabId, 'setStatus', 'summarizing');
        const art = await this.summarize(resourceUrl, m.title, m.excerpt);
        rt.manual = { ...m, sumTitle: art.title, summary: art.summary, artLang: art.language };
        await this.overlayCall(tabId, 'showSummary', { title: art.title, summary: art.summary, language: art.language });
        await this.overlayCall(tabId, 'setStep', 'summarize');
      } else if (step === 'detectForm') {
        await this.overlayCall(tabId, 'setStatus', 'detecting');
        // 重新采集页面表单候选（跨框架，标题/摘要一并刷新）；表单可能在 iframe 里，记住 frameId
        const d = await this.detectAll(tabId).catch(() => null);
        const frameId = (d && d.forms.length && d.forms[0].frameId) || 0;
        // 允许识别失败：表单留空也继续走「生成评论」，评论会展示在浮层上，可手动复制粘贴
        let form = null;
        if (d && d.ok && d.forms.length) {
          try {
            form = await detectForm({ formHtml: d.forms[0].html, pageUrl: resourceUrl });
            if (!form || !form.comment) throw new Error('未识别到评论文本框');
            addLog('ai', `表单识别成功${frameId ? '（在 iframe 中）' : ''}（留链方式：${form.linkMethod || 'website_field'}）`, 'success', resourceUrl);
          } catch (e) {
            addLog('ai', `表单识别失败，使用默认选择器兜底：${e.message}`, 'warn', resourceUrl);
            form = defaultForm();
          }
        } else {
          addLog('publish', '页面上未找到评论表单，跳过表单识别（生成评论后可从浮层复制手动填写）', 'warn', resourceUrl);
        }
        rt.manual = { ...m, title: (d && d.title) || m.title, excerpt: (d && d.excerpt) || m.excerpt, form, frameId };
        // 滚动到识别出的表单并高亮（在表单所在框架执行），让人工确认 AI 的识别结果
        if (form) await this.frameCall(tabId, frameId, 'markForm', form);
        // 评论已生成过时回到 fill 阶段（保住「自动填写表单」的可点状态），否则推进到生成评论
        await this.overlayCall(tabId, 'setStep', rt.manual.comment ? 'fill' : 'genComment');
      } else if (step === 'genComment') {
        // 不依赖表单识别结果：识别失败也照常生成评论，展示在浮层上供手动复制
        await this.overlayCall(tabId, 'setStatus', 'generating');
        // 标题与摘要优先复用「获取标题与摘要」的缓存；没点过则自动生成一次（同样缓存，
        // 反复点「生成评论」换一条时不会重复总结）
        const art = (m.summary != null && m.sumTitle != null)
          ? { title: m.sumTitle, summary: m.summary, language: m.artLang || '' }
          : await this.summarize(resourceUrl, m.title, m.excerpt);
        if (m.summary == null) {
          rt.manual = { ...m, sumTitle: art.title, summary: art.summary, artLang: art.language };
          await this.overlayCall(tabId, 'showSummary', { title: art.title, summary: art.summary, language: art.language });
        }
        const comment = await generateComment(
          { url: resourceUrl, title: art.title, text: art.summary },
          {
            targetUrl: task.targetUrl || st.settings.identity.website,
            siteIntro: task.siteIntro || '',
            mainKeyword: task.mainKeyword || '',
            articleLang: art.language,
          },
        );
        addLog('ai', comment.includes('<a') ? '评论生成完成（正文内嵌链接）' : '评论生成完成', 'success', resourceUrl);
        let identity;
        try {
          identity = await generateIdentity({ title: art.title, text: art.summary });
          addLog('ai', `身份生成：${identity.name} <${identity.email}>`, 'info', resourceUrl);
        } catch (e) {
          addLog('ai', `身份生成失败，使用设置里的默认身份：${e.message}`, 'warn', resourceUrl);
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
            addLog('ai', `评论译文生成失败（不影响发布）：${e.message}`, 'warn', resourceUrl);
          }
        }
        rt.manual = { ...rt.manual, sumTitle: art.title, summary: art.summary, artLang: art.language, comment, identity };
        // 评论与身份信息展示到浮层，每个字段带复制按钮
        await this.overlayCall(tabId, 'showComment', { comment, translation, name: identity.name, email: identity.email });
        await this.overlayCall(tabId, 'setStep', 'fill');
      } else if (step === 'fill') {
        if (!m.comment) throw new Error('请先执行前面的步骤');
        await this.overlayCall(tabId, 'setStatus', 'filling');
        // 表单识别失败时用默认选择器兜底；仍填不进去可重试，或从浮层复制评论手动粘贴
        const form = m.form || defaultForm();
        const f = await this.frameCall(tabId, m.frameId || 0, 'fill',
          { form, comment: m.comment, identity: m.identity, mode: task.mode, lang: st.settings.language, resourceUrl, refDomain: rt.refDomain || '' });
        if (!f || !f.ok) throw new Error((f && f.error) || '未知错误');
        addLog('publish', `表单已填入（正文:${f.filled.comment ? '✓' : '✗'} 昵称:${f.filled.author ? '✓' : '✗'} 邮箱:${f.filled.email ? '✓' : '✗'} 网址:${f.filled.website ? '✓' : '✗'}）`, 'info', resourceUrl);
        // fill 成功后浮层已解锁 Submit / Skip，进入待确认阶段
        rt.stage = 'awaiting_review';
        await this.overlayCall(tabId, 'setStep', 'done');
      } else {
        return;
      }
      await this.notify(['publishRuntime', 'logs']);
    } catch (e) {
      addLog('publish', `步骤执行失败：${e.message}`, 'error', resourceUrl);
      await this.overlayCall(tabId, 'setStatus', `步骤失败：${e.message}`);
      await this.overlayCall(tabId, 'setStep', step); // 重新允许点击该步骤重试
      await this.notify(['publishRuntime', 'logs']);
    } finally {
      this.stepBusy.delete(step);
    }
  }

  /** 浮层 Submit / Skip 回调 */
  async onDecision(resourceUrl, decision) {
    const st = getState();
    const rt = st.publishRuntime;
    if (!rt || rt.resourceUrl !== resourceUrl || rt.stage !== 'awaiting_review') return;
    const task = findTask(rt.taskId);
    if (!task) return;
    const tabId = rt.tabId;

    if (decision === 'submit') {
      try {
        // 提交在表单所在框架执行（iframe 里的表单在对应框架提交）
        const s = await this.frameCall(tabId, (rt.manual && rt.manual.frameId) || 0, 'submit');
        if (s && s.ok) {
          await this.markPublished(task, resourceUrl);
          this.record(task, resourceUrl, 'success', '人工确认，已提交');
        } else {
          // 提交失败时表单已填好，保留页面便于人工检查后手动提交
          this.recordKeepTab(task, rt, resourceUrl, 'fail', `提交失败：${(s && s.error) || '未知'}`);
        }
      } catch (e) {
        this.recordKeepTab(task, rt, resourceUrl, 'fail', `提交异常：${e.message}`);
      }
    } else {
      this.record(task, resourceUrl, 'skip', '人工跳过');
    }

    try {
      // 浮层在主框架，表单高亮可能在 iframe 里：全框架清理
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => window.__BCM_PUB__ && window.__BCM_PUB__.cleanup() });
    } catch { /* tab may be gone */ }

    rt.stage = 'working';
    await this.notify(['publishRuntime', 'tasks', 'logs']);
    this.loop();
  }

  /** 半自动模式：调用页面浮层的方法（fn 为 showOverlay/setStatus/setStep 等） */
  async overlayCall(tabId, fn, arg) {
    if (!tabId) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (f, a) => window.__BCM_PUB__ && window.__BCM_PUB__[f] && window.__BCM_PUB__[f](a),
        args: [fn, arg],
      });
    } catch { /* 页面可能已跳转 */ }
  }

  async record(task, url, result, note) {
    task.results = task.results || {};
    task.results[url] = result;
    const icon = result === 'success' ? '✓' : result === 'fail' ? '✗' : '⊘';
    const level = result === 'success' ? 'success' : result === 'fail' ? 'error' : 'info';
    addLog('publish', `${icon} ${note}`, level, url);
  }

  /**
   * 记录结果并保留当前标签页：与运行时解绑（rt.tabId 置空），
   * 后续资源会另开新标签，任务结束/停止也不会关掉它，便于人工接管页面手动处理
   */
  async recordKeepTab(task, rt, url, result, note) {
    if (rt.tabId) rt.tabId = null;
    await this.record(task, url, result, `${note}（标签页已保留，可手动处理）`);
  }

  finishTask(task, status) {
    task.status = status;
    task.finishedAt = Date.now();
    const st = getState();
    if (st.publishRuntime && st.publishRuntime.taskId === task.id) {
      try { if (st.publishRuntime.tabId) chrome.tabs.remove(st.publishRuntime.tabId).catch(() => {}); } catch { /* ignore */ }
      st.publishRuntime = null;
    }
    if (st.activeTaskId === task.id) st.activeTaskId = null;
    addLog('publish', `任务「${task.name}」完成`, 'success');
    this.notify(['tasks', 'activeTaskId', 'publishRuntime', 'logs']).catch(() => {});
  }

  async stopTask(taskId) {
    const task = findTask(taskId);
    if (!task) return;
    if (task.status === 'running') {
      const st = getState();
      if (st.publishRuntime && st.publishRuntime.taskId === taskId) {
        // 若停在待审核，先清掉浮层（全框架：表单高亮可能在 iframe 里）
        try {
          if (st.publishRuntime.tabId) {
            await chrome.scripting.executeScript({ target: { tabId: st.publishRuntime.tabId, allFrames: true }, func: () => window.__BCM_PUB__ && window.__BCM_PUB__.cleanup() });
          }
        } catch { /* ignore */ }
        try { if (st.publishRuntime.tabId) await chrome.tabs.remove(st.publishRuntime.tabId).catch(() => {}); } catch { /* ignore */ }
        st.publishRuntime = null;
      }
      task.status = 'stopped';
      addLog('publish', `任务「${task.name}」已停止`, 'warn');
    }
    await this.notify(['tasks', 'publishRuntime', 'logs']);
  }

  async deleteTask(taskId) {
    const i = getState().tasks.findIndex((t) => t.id === taskId);
    if (i < 0) return;
    const task = getState().tasks[i];
    if (task.status === 'running') await this.stopTask(taskId);
    getState().tasks.splice(i, 1);
    if (getState().activeTaskId === taskId) getState().activeTaskId = null;
    addLog('publish', `任务「${task.name}」已删除`, 'info');
    await this.notify(['tasks', 'activeTaskId', 'publishRuntime', 'logs']);
  }

  /** alarm 唤醒：检查待操作的页面是否还活着 */
  async healthCheck() {
    const st = getState();
    const rt = st.publishRuntime;
    if (!rt) return;
    const task = findTask(rt.taskId);
    if (!task || task.status !== 'running') { st.publishRuntime = null; await this.notify(['publishRuntime']); return; }
    const waiting = rt.stage === 'awaiting_review' || rt.stage === 'awaiting_steps';
    if (waiting && rt.tabId) {
      try { await chrome.tabs.get(rt.tabId); } catch {
        this.record(task, rt.resourceUrl, 'fail', '待操作页面被关闭');
        st.publishRuntime = null;
        await this.notify(['publishRuntime', 'tasks', 'logs']);
        this.loop();
      }
    } else if (!waiting && !this.busy) {
      this.loop();
    }
  }
}
