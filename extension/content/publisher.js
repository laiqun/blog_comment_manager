/**
 * 发布器：识别评论表单 → 填入 AI 评论与身份信息 → 半自动弹浮层等人工确认 / 全自动直接提交。
 * 由 background 注入，通过 window.__BCM_PUB__ 调用：
 *   detect / fill / submit / cleanup / showOverlay / setStatus / setStep / markForm / showComment。
 * 「AI 识别评论表单」完成后由后台调用 markForm：滚动到识别出的评论框并加蓝色高亮，
 * 让人工确认 AI 找到的是哪个表单（与红色「定位目标链接」标记互不干扰）；
 * 评论生成后由 showComment 把评论/昵称/邮箱展示在浮层上，每个字段带复制按钮，
 * 识别或填表失败时可手动粘贴。
 * 半自动模式下页面一打开就显示浮层（showOverlay），AI 步骤（生成评论/识别表单/填写表单）
 * 不自动执行，由浮层上的步骤按钮手动触发（按钮点击不置灰、可反复点击，同一步骤的
 * 并发触发由后台去重；「获取标题与摘要」「AI 生成评论」「AI 识别评论表单」全程可点，
 * 「自动填写表单」需评论生成后才解锁），填表完成后才解锁
 * Submit / Skip（步骤按钮不锁定：对填入内容不满意可重跑步骤后再点填写覆盖重填）；浮层上的「定位目标链接」按钮可循环跳转到页面中包含收集目标域名
 * （同行站点）的锚点，供人工参考已有外链。
 * 步骤按钮点击后带看门狗计时器（stepTimeoutMs，由后台按 aiTimeoutMs 推算传入）：
 * 后台 SW 被回收或请求挂死导致没有回包时，到点在浮层提示「可再点一次重试」。
 */
(function () {
  if (window.__BCM_PUB__) return;

  const OVERLAY_ID = '__bcm_overlay__';
  const BALL_ID = '__bcm_ball__';

  const I18N = {
    zh: {
      title: '评论发布助手',
      manual: '页面已打开。「获取标题与摘要」「AI 生成评论」「AI 识别评论表单」互不依赖，可任意顺序执行；评论不满意可再点一次重新生成，满意后点「自动填写表单」。',
      detecting: '正在识别评论表单…',
      summarizing: 'AI 正在生成标题与摘要…',
      generating: 'AI 正在生成评论…',
      filling: '正在自动填写表单…',
      formDone: '表单识别完成，已高亮目标表单。',
      sumDone: '标题与摘要已生成，显示在下方，可复制。',
      commentDone: '评论已生成。不满意可再点「AI 生成评论」换一条，满意后点「自动填写表单」。',
      ready: '评论表单已自动填好。请检查内容后点击 Submit 提交，或点击 Skip 跳过换下一个资源。',
      stepSummarize: '获取标题与摘要',
      stepDetect: 'AI 识别评论表单',
      stepGen: 'AI 生成评论',
      stepFill: '自动填写表单',
      skip: 'Skip',
      submit: 'Submit',
      locate: '定位目标链接',
      noTarget: '未找到该资源对应的收集目标域名',
      noLink: '页面中未找到指向目标域名的链接',
      fieldComment: '评论内容',
      fieldName: '昵称',
      fieldEmail: '邮箱',
      fieldTitle: '标题',
      fieldSummary: '摘要',
      fieldLang: '文章语言',
      copy: '复制',
      copied: '已复制 ✓',
      minimize: '最小化',
      restore: '展开评论助手',
      stepNoResp: '请求超时或后台无响应，可直接再点一次重试。',
    },
    en: {
      title: 'Comment Assistant',
      manual: 'Page opened. "Get title & summary", "AI generate comment" and "AI detect form" are independent — run them in any order. Not happy with the comment? Click again for a new one, then "Auto fill form".',
      detecting: 'Detecting the comment form…',
      summarizing: 'AI is generating the title & summary…',
      generating: 'AI is generating the comment…',
      filling: 'Filling the comment form…',
      formDone: 'Form detected and highlighted on the page.',
      sumDone: 'Title & summary generated below — copyable.',
      commentDone: 'Comment generated. Click "AI generate comment" again for a new one, or "Auto fill form" to continue.',
      ready: 'The comment form has been filled. Please review the content and click Submit to post, or Skip to move to the next resource.',
      stepSummarize: 'Get title & summary',
      stepDetect: 'AI detect form',
      stepGen: 'AI generate comment',
      stepFill: 'Auto fill form',
      skip: 'Skip',
      submit: 'Submit',
      locate: 'Locate target link',
      noTarget: 'No collect target domain found for this resource',
      noLink: 'No link pointing to the target domain was found on this page',
      fieldComment: 'Comment',
      fieldName: 'Name',
      fieldEmail: 'Email',
      fieldTitle: 'Title',
      fieldSummary: 'Summary',
      fieldLang: 'Article language',
      copy: 'Copy',
      copied: 'Copied ✓',
      minimize: 'Minimize',
      restore: 'Expand comment assistant',
      stepNoResp: 'Request timed out or no response from background — just click again to retry.',
    },
  };

  // ---------- DOM 工具 ----------

  function q(sel, root) {
    if (!sel) return null;
    try { return (root || document).querySelector(sel); } catch { return null; }
  }
  function firstOf(list, root) {
    for (const s of list || []) {
      const el = q(s, root);
      if (el) return el;
    }
    return null;
  }
  function qa(sel, root) {
    try { return [...(root || document).querySelectorAll(sel)]; } catch { return []; }
  }

  /** 兼容 React/Vue 的赋值：原生 setter + input/change 事件 */
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** 是否属于本插件浮层（避免把浮层自己的输入框/按钮当成页面表单元素） */
  function isOurs(el) {
    return !!(el && el.closest && el.closest('#' + OVERLAY_ID + ', #' + BALL_ID));
  }

  // 裸按钮兜底：很多简易评论框用不带 type 属性的 <button>（属性选择器匹配不到），按文案识别
  const SUBMIT_HINT = /post|submit|comment|reply|send|发表|提交|发布|评论/i;

  function findSubmitIn(scope, submitSel) {
    for (const sc of [...new Set([scope, document].filter(Boolean))]) {
      const bySel = submitSel ? q(submitSel, sc) : null;
      if (bySel && !isOurs(bySel)) return bySel;
      const explicit = qa('input[type="submit"], button[type="submit"], .submit, #submit', sc).find((el) => !isOurs(el));
      if (explicit) return explicit;
      const byText = qa('button, input[type="button"]', sc)
        .find((el) => !isOurs(el) && SUBMIT_HINT.test(((el.value || '') + ' ' + (el.textContent || '')).trim()));
      if (byText) return byText;
    }
    return null;
  }

  // ---------- detect：采集表单候选与页面信息 ----------

  function detect(cfg) {
    const selectors = (cfg && cfg.selectors) || {};
    try {
      const title = (document.querySelector('title')?.textContent || document.title || '').trim();
      const article = q('article') || q('main') || q('.entry-content') || q('.post-content');
      let excerpt = article ? article.innerText || '' : document.body?.innerText || '';
      excerpt = excerpt.replace(/\s+/g, ' ').slice(0, 5000);

      const captchaSel = selectors.captcha || [];
      const hasCaptcha = captchaSel.some((s) => q(s));

      // 需要「登录才能评论」的判断
      let loginRequired = !!firstOf(['p.must-log-in', '.must-log-in', '.login-required']);
      if (!loginRequired) {
        const hay = (document.body?.innerText || '').toLowerCase().slice(0, 20000);
        loginRequired = ['log in to leave a comment', 'must be logged in', '请登录后发表评论'].some((h) => hay.includes(h));
      }

      // 表单候选：包含 textarea 的 form（兼容无 form 包裹的评论组件）；跳过浮层自身的 UI
      const forms = [];
      const seen = new Set();
      const candidates = [...document.querySelectorAll('form')].filter((f) => f.querySelector('textarea') && !isOurs(f));
      for (const textarea of document.querySelectorAll('textarea')) {
        if (isOurs(textarea)) continue; // 浮层里的评论展示框不是页面表单
        if (!textarea.closest('form') && textarea.offsetParent) candidates.push(textarea.closest('div') || textarea);
      }
      for (const f of candidates) {
        if (seen.has(f)) continue;
        seen.add(f);
        const html = f.outerHTML.slice(0, 15000);
        forms.push({ html, visible: !!f.offsetParent });
      }
      forms.sort((a, b) => (b.visible ? 1 : 0) - (a.visible ? 1 : 0));

      return { ok: true, url: location.href, title, excerpt, forms: forms.slice(0, 3), hasCaptcha, loginRequired };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // ---------- fill：填表 + 浮层 ----------

  let lastFill = null;

  function fill(cfg) {
    try {
      const form = cfg.form || {};
      const identity = cfg.identity || {};
      const filled = { comment: false, author: false, email: false, website: false };

      // 优先在识别到的表单范围内找字段，找不到再全局找
      const scopeHint = form.formSelector ? q(form.formSelector) : null;
      const scopes = [scopeHint, document].filter(Boolean);

      const pick = (sel) => {
        for (const sc of scopes) {
          const el = sel ? q(sel, sc) : null;
          if (el && !isOurs(el)) return el; // 浮层自己的输入框不算
        }
        return null;
      };

      const put = (el, value, key) => {
        if (!el || !value) return false;
        setNativeValue(el, value);
        filled[key] = true;
        return true;
      };

      put(pick(form.comment), cfg.comment, 'comment');
      put(pick(form.author), identity.name, 'author');
      put(pick(form.email), identity.email, 'email');
      if (form.linkMethod !== 'comment_body') {
        put(pick(form.url || '#url'), identity.website, 'website');
      }

      // 「记住我」复选框
      const saveEl = pick(form.saveInfo);
      if (saveEl && saveEl.type === 'checkbox' && !saveEl.checked) saveEl.click();

      // 找提交按钮备用
      const scopeEl = scopeHint || (pick(form.comment) && pick(form.comment).closest('form')) || document;
      const submitBtn = findSubmitIn(scopeEl, form.submit);

      lastFill = {
        submitSel: form.submit || '',
        resourceUrl: cfg.resourceUrl || null,
        mode: cfg.mode || 'semi',
        submitFound: !!submitBtn,
      };

      if (!filled.comment) return { ok: false, error: '评论文本框未找到或未填入' };

      if (cfg.mode === 'auto') {
        return { ok: true, filled, submitFound: lastFill.submitFound };
      }

      // 填表完成：浮层切到「待确认」状态（浮层在页面打开时已由 showOverlay 显示）
      if (!overlayEls) showOverlay({ lang: cfg.lang, refDomain: cfg.refDomain, resourceUrl: cfg.resourceUrl });
      setReady();
      return { ok: true, filled };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // ---------- 浮层：页面打开即显示，随流程更新状态，填表后才解锁 Submit / Skip ----------

  let overlayCfg = { lang: 'zh', refDomain: '', resourceUrl: null };
  let overlayEls = null; // { status, skipBtn, submitBtn, steps }
  let linkIdx = 0;
  let lastMarked = null; // 当前红框标记的链接 { el, outline, outlineOffset }

  function strings() {
    return I18N[overlayCfg.lang === 'en' ? 'en' : 'zh'];
  }

  function setStatus(keyOrText) {
    const s = strings();
    if (overlayEls && overlayEls.status) overlayEls.status.textContent = s[keyOrText] || keyOrText;
  }

  /** 归一化域名：支持完整 URL 或裸域名，去 www、转小写 */
  function domainOf(u) {
    if (!u) return '';
    try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); }
    catch { return String(u).replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./, '').toLowerCase(); }
  }

  // 高亮标记的样式：红框 + 红底色 + 外圈光晕，三层叠加在复杂页面上也醒目
  const MARK_PROPS = ['outline', 'outlineOffset', 'backgroundColor', 'boxShadow'];
  const MARK_STYLE = {
    outline: '3px solid #ef4444',
    outlineOffset: '2px',
    backgroundColor: 'rgba(239,68,68,.20)',
    boxShadow: '0 0 0 6px rgba(239,68,68,.30), 0 0 18px rgba(239,68,68,.55)',
  };

  function unmark() {
    if (!lastMarked) return;
    for (const p of MARK_PROPS) lastMarked.el.style[p] = lastMarked.prev[p];
    lastMarked = null;
  }

  // ---------- markForm：AI 识别完成后高亮目标表单 ----------

  // 表单高亮用蓝色系，与红色「定位目标链接」标记区分
  const FORM_MARK_STYLE = {
    outline: '3px solid #4a9eff',
    outlineOffset: '2px',
    backgroundColor: 'rgba(74,158,255,.12)',
    boxShadow: '0 0 0 6px rgba(74,158,255,.25), 0 0 18px rgba(74,158,255,.5)',
  };
  let formMarked = null; // { el, prev }

  function unmarkForm() {
    if (!formMarked) return;
    for (const p of MARK_PROPS) formMarked.el.style[p] = formMarked.prev[p];
    formMarked = null;
  }

  /** 滚动到 AI 识别出的评论框（找不到退回整个表单）并加蓝色高亮 */
  function markForm(form) {
    try {
      const f = form || {};
      const el = (f.comment && q(f.comment)) || (f.formSelector && q(f.formSelector));
      if (!el) return { ok: false, error: '页面上未找到识别出的表单元素' };
      unmarkForm();
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const prev = {};
      for (const p of MARK_PROPS) prev[p] = el.style[p];
      formMarked = { el, prev };
      for (const p of MARK_PROPS) el.style[p] = FORM_MARK_STYLE[p];
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /** 循环定位页面中包含收集目标域名的锚点，并用红框标记 */
  function locateTargetLink() {
    const s = strings();
    const domain = domainOf(overlayCfg.refDomain);
    if (!domain) { setStatus(s.noTarget); return; }
    // 有的站点会把评论区渲染成多个 Tab（如「按时间/按热门」），隐藏 Tab 里的副本要跳过：
    // display:none 的元素滚不过去也看不见红框。优先只取可见锚点，全不可见时退回全部。
    const all = qa('a[href]').filter((a) => (a.href || '').toLowerCase().includes(domain));
    const visible = all.filter((a) => a.offsetParent !== null || a.getClientRects().length > 0);
    const links = visible.length ? visible : all;
    if (!links.length) { setStatus(s.noLink); return; }
    const i = linkIdx % links.length;
    linkIdx = i + 1;
    const el = links[i];
    // 清除上一个高亮，标记始终只框住当前定位到的链接
    unmark();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const prev = {};
    for (const p of MARK_PROPS) prev[p] = el.style[p];
    lastMarked = { el, prev };
    for (const p of MARK_PROPS) el.style[p] = MARK_STYLE[p];
    setStatus(overlayCfg.lang === 'en'
      ? `Jumped to target link ${i + 1}/${links.length}`
      : `已定位到第 ${i + 1}/${links.length} 个目标链接`);
  }

  /** 复制文本到剪贴板（clipboard API 失败时退回 execCommand），按钮短暂显示「已复制」 */
  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
      document.documentElement.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* 复制失败则用户可手动全选 */ }
      ta.remove();
    }
    const old = btn.textContent;
    btn.textContent = strings().copied;
    setTimeout(() => { btn.textContent = old; }, 1200);
  }

  /** 字段展示行：label + 复制按钮 + 只读输入框/文本域（showSummary / showComment 共用），rows 控制多行高度 */
  function addFieldRow(box, label, val, multi, rows) {
    const s = strings();
    const rowEl = document.createElement('div');
    const lab = document.createElement('div');
    lab.textContent = label;
    lab.style.cssText = 'color:#9ca3af;font-size:11px;margin-bottom:2px;display:flex;justify-content:space-between;align-items:center;';
    const btn = document.createElement('button');
    btn.textContent = s.copy;
    btn.style.cssText = 'padding:1px 8px;border:1px solid #4a9eff;border-radius:6px;background:transparent;color:#4a9eff;font-size:11px;cursor:pointer;flex-shrink:0;';
    btn.addEventListener('click', () => copyText(val, btn));
    lab.appendChild(btn);
    const input = document.createElement(multi ? 'textarea' : 'input');
    if (!multi) input.type = 'text';
    input.readOnly = true;
    input.value = val;
    if (multi) input.rows = rows || 4;
    input.style.cssText = 'width:100%;box-sizing:border-box;background:#111420;border:1px solid #2d3450;border-radius:6px;color:#e5e7eb;font-size:12px;padding:5px 7px;resize:vertical;';
    rowEl.appendChild(lab);
    rowEl.appendChild(input);
    box.appendChild(rowEl);
  }

  /** 「获取标题与摘要」完成后：在浮层展示标题、摘要与文章语言（各带复制按钮） */
  function showSummary(fields) {
    if (!overlayEls || !overlayEls.summaryBox || !fields) return;
    const s = strings();
    const box = overlayEls.summaryBox;
    box.innerHTML = '';
    if (fields.title) addFieldRow(box, s.fieldTitle, fields.title, false);
    if (fields.summary) addFieldRow(box, s.fieldSummary, fields.summary, true, 8);
    if (fields.language) addFieldRow(box, s.fieldLang, fields.language, false);
    box.style.display = (fields.title || fields.summary || fields.language) ? 'flex' : 'none';
  }

  /** 评论生成后：在浮层展示各字段内容，每个字段带复制按钮（识别/填表失败时可手动粘贴） */
  function showComment(fields) {
    if (!overlayEls || !overlayEls.fieldsBox || !fields) return;
    const s = strings();
    const box = overlayEls.fieldsBox;
    box.innerHTML = '';
    const defs = [
      ['comment', s.fieldComment, true],
      ['name', s.fieldName, false],
      ['email', s.fieldEmail, false],
    ];
    for (const [key, label, multi] of defs) {
      const val = fields[key];
      if (!val) continue;
      addFieldRow(box, label, val, multi);
    }
    box.style.display = 'flex';
  }

  // ---------- 最小化：浮层收起为右下角半透明小球，点小球恢复原浮层 ----------

  function minimizeOverlay() {
    const wrap = document.getElementById(OVERLAY_ID);
    if (!wrap) return;
    wrap.style.display = 'none';
    if (document.getElementById(BALL_ID)) return;
    const s = strings();
    const ball = document.createElement('div');
    ball.id = BALL_ID;
    ball.title = s.restore;
    ball.textContent = '💬';
    ball.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'width:44px', 'height:44px',
      'border-radius:50%', 'z-index:2147483647', 'cursor:pointer', 'user-select:none',
      'background:rgba(74,158,255,.45)', 'font-size:20px',
      'display:flex', 'align-items:center', 'justify-content:center',
      'box-shadow:0 4px 16px rgba(0,0,0,.35)', 'transition:background .15s',
    ].join(';');
    ball.addEventListener('mouseenter', () => (ball.style.background = 'rgba(74,158,255,.8)'));
    ball.addEventListener('mouseleave', () => (ball.style.background = 'rgba(74,158,255,.45)'));
    ball.addEventListener('click', restoreOverlay);
    document.documentElement.appendChild(ball);
  }

  function restoreOverlay() {
    const ball = document.getElementById(BALL_ID);
    if (ball) ball.remove();
    const wrap = document.getElementById(OVERLAY_ID);
    if (wrap) wrap.style.display = '';
  }

  function showOverlay(cfg) {
    overlayCfg = { ...overlayCfg, ...(cfg || {}) };
    linkIdx = 0;
    cleanup();
    const s = strings();
    const wrap = document.createElement('div');
    wrap.id = OVERLAY_ID;
    wrap.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'width:440px', 'z-index:2147483647',
      'max-height:85vh', 'overflow-y:auto', 'overscroll-behavior:contain',
      'background:#1c1f2e', 'border-radius:12px', 'padding:16px', 'box-sizing:border-box',
      'box-shadow:0 8px 32px rgba(0,0,0,.45)', 'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
    ].join(';');

    // 头部：左上角最小化按钮 + 标题
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
    const minBtn = document.createElement('button');
    minBtn.textContent = '—';
    minBtn.title = s.minimize;
    minBtn.style.cssText = 'width:22px;height:22px;flex-shrink:0;border:none;border-radius:6px;background:#2d3450;color:#9ca3af;font-size:13px;line-height:1;cursor:pointer;padding:0;';
    minBtn.addEventListener('mouseenter', () => (minBtn.style.background = '#3d4666'));
    minBtn.addEventListener('mouseleave', () => (minBtn.style.background = '#2d3450'));
    minBtn.addEventListener('click', minimizeOverlay);

    const title = document.createElement('div');
    title.textContent = s.title;
    title.style.cssText = 'color:#4a9eff;font-size:15px;font-weight:700;flex:1;';

    header.appendChild(minBtn);
    header.appendChild(title);

    const status = document.createElement('div');
    status.style.cssText = 'color:#d1d5db;font-size:12.5px;line-height:1.6;margin-bottom:14px;white-space:pre-line;';

    // 步骤按钮：AI 操作不自动执行，由人工逐个点击触发；点击不置灰，可随时重复点击
    const stepCol = document.createElement('div');
    stepCol.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:10px;';
    const mkStep = (key, label) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'width:100%;padding:7px 10px;border:none;border-radius:8px;background:#2d3450;color:#e5e7eb;font-size:12.5px;cursor:pointer;text-align:left;box-sizing:border-box;';
      b.addEventListener('click', () => {
        // 看门狗：后台 SW 被回收/请求挂死导致没有回包时给出提示（同一步骤的并发去重由后台负责）
        const watchdog = setTimeout(() => setStatus(strings().stepNoResp), overlayCfg.stepTimeoutMs || 90000);
        chrome.runtime.sendMessage({ type: 'pub:step', resourceUrl: overlayCfg.resourceUrl, step: key })
          .then(() => clearTimeout(watchdog))
          .catch(() => { clearTimeout(watchdog); setStatus(strings().stepNoResp); });
      });
      return b;
    };
    const steps = {
      summarize: mkStep('summarize', s.stepSummarize),
      genComment: mkStep('genComment', s.stepGen),
      detectForm: mkStep('detectForm', s.stepDetect),
      fill: mkStep('fill', s.stepFill),
    };
    for (const b of Object.values(steps)) stepCol.appendChild(b);

    // 标题与摘要展示区：「获取标题与摘要」后由 showSummary 填充（各字段带复制按钮）
    const summaryBox = document.createElement('div');
    summaryBox.style.cssText = 'display:none;flex-direction:column;gap:8px;margin-bottom:10px;';

    // 评论字段展示区：生成评论后由 showComment 填充（每字段带复制按钮）
    const fieldsBox = document.createElement('div');
    fieldsBox.style.cssText = 'display:none;flex-direction:column;gap:8px;margin-bottom:10px;';

    const locateBtn = document.createElement('button');
    locateBtn.textContent = s.locate;
    locateBtn.style.cssText = 'width:100%;padding:7px 0;margin-bottom:10px;border:1px solid #4a9eff;border-radius:8px;background:transparent;color:#4a9eff;font-size:12.5px;cursor:pointer;';
    locateBtn.addEventListener('click', locateTargetLink);
    locateBtn.addEventListener('mouseenter', () => (locateBtn.style.background = 'rgba(74,158,255,.12)'));
    locateBtn.addEventListener('mouseleave', () => (locateBtn.style.background = 'transparent'));

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

    const skipBtn = document.createElement('button');
    skipBtn.textContent = s.skip;
    skipBtn.style.cssText = 'flex:1;padding:8px 0;border:none;border-radius:8px;background:#374151;color:#e5e7eb;font-size:13px;cursor:pointer;';

    const submitBtn = document.createElement('button');
    submitBtn.textContent = s.submit;
    submitBtn.style.cssText = 'flex:1;padding:8px 0;border:none;border-radius:8px;background:#22c55e;color:#fff;font-size:13px;font-weight:700;cursor:pointer;';

    skipBtn.addEventListener('click', () => decide('skip'));
    submitBtn.addEventListener('click', () => decide('submit'));
    skipBtn.addEventListener('mouseenter', () => { if (!skipBtn.disabled) skipBtn.style.background = '#4b5563'; });
    skipBtn.addEventListener('mouseleave', () => (skipBtn.style.background = '#374151'));

    // 初始为禁用：等填表完成后由 setReady 解锁
    for (const b of [skipBtn, submitBtn]) {
      b.disabled = true;
      b.style.opacity = '.45';
      b.style.cursor = 'not-allowed';
    }

    function decide(decision) {
      const rurl = (lastFill && lastFill.resourceUrl) || overlayCfg.resourceUrl;
      cleanup();
      if (rurl) chrome.runtime.sendMessage({ type: 'pub:decision', resourceUrl: rurl, decision }).catch(() => {});
    }

    row.appendChild(skipBtn);
    row.appendChild(submitBtn);
    wrap.appendChild(header);
    wrap.appendChild(status);
    wrap.appendChild(stepCol);
    wrap.appendChild(summaryBox);
    wrap.appendChild(fieldsBox);
    wrap.appendChild(locateBtn);
    wrap.appendChild(row);
    document.documentElement.appendChild(wrap);
    overlayEls = { status, skipBtn, submitBtn, steps, fieldsBox, summaryBox };
    setStep('detectForm');
  }

  /**
   * 切换可点的步骤按钮，并更新状态文案；key ∈ summarize/genComment/detectForm/fill/done。
   * 四个步骤按钮全程保持可点、可反复触发（识别表单每点一次就重新采集并重走 AI 识别；
   * 填表完成后也不锁定——对填入内容不满意可重新生成评论/识别表单后再点「自动填写表单」覆盖重填）。
   */
  function setStep(key) {
    if (!overlayEls || !overlayEls.steps) return;
    const enabled = {
      summarize: ['summarize', 'genComment', 'detectForm'],
      genComment: ['summarize', 'genComment', 'detectForm'],
      detectForm: ['summarize', 'genComment', 'detectForm'],
      fill: ['summarize', 'genComment', 'detectForm', 'fill'],
      done: ['summarize', 'genComment', 'detectForm', 'fill'],
    }[key] || [];
    for (const [k, b] of Object.entries(overlayEls.steps)) {
      const on = enabled.includes(k);
      b.disabled = !on;
      b.style.opacity = on ? '1' : '.45';
      b.style.cursor = on ? 'pointer' : 'not-allowed';
    }
    const s = strings();
    const msg = { summarize: s.sumDone, detectForm: s.manual, genComment: s.formDone, fill: s.commentDone }[key];
    if (msg) setStatus(msg);
  }

  /** 填表完成：状态切到待确认文案并解锁 Submit / Skip */
  function setReady() {
    if (!overlayEls) return;
    setStatus('ready');
    for (const b of [overlayEls.skipBtn, overlayEls.submitBtn]) {
      b.disabled = false;
      b.style.opacity = '1';
      b.style.cursor = 'pointer';
    }
  }

  function cleanup() {
    const old = document.getElementById(OVERLAY_ID);
    if (old) old.remove();
    const ball = document.getElementById(BALL_ID);
    if (ball) ball.remove(); // 最小化小球一并清掉
    overlayEls = null;
    unmark(); // 撤掉定位标记，恢复页面原样
    unmarkForm(); // 撤掉表单高亮
  }

  // ---------- submit：点击提交 ----------

  function submit() {
    try {
      if (!lastFill) return { ok: false, error: '尚未填表' };
      let btn = null;
      const scope = lastFill.formSelector ? q(lastFill.formSelector) : null;
      btn = findSubmitIn(scope || document, lastFill.submitSel);
      if (!btn) return { ok: false, error: '未找到提交按钮' };
      btn.scrollIntoView({ block: 'center' });
      cleanup();
      btn.click();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  window.__BCM_PUB__ = { detect, fill, submit, cleanup, showOverlay, setStatus, setStep, markForm, showComment, showSummary };
})();
