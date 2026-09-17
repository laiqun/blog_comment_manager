/**
 * 发布器（无 UI 页面操作脚本）：识别评论表单 → 填入 AI 评论与身份信息 → 提交。
 * 由 background 注入，通过 window.__BCM_PUB__ 调用：
 *   detect / fill / submit / cleanup / markForm / locateLink。
 * 半自动模式的人工交互（步骤按钮、字段展示与复制、Submit/Skip）已全部迁移到
 * side panel 的「助手」标签页，本脚本不再向页面注入任何浮层 DOM。
 * 「AI 识别评论表单」完成后由后台调用 markForm：滚动到识别出的评论框并加蓝色高亮，
 * 让人工确认 AI 找到的是哪个表单（与红色「定位目标链接」标记互不干扰）；
 * 「定位目标链接」由面板助手页触发（locateLink）：循环跳转到页面中包含收集目标域名
 * （同行站点）的锚点并用红框标记，供人工参考已有外链，定位结果（第 n/m 个）随返回值
 * 传回面板展示。
 */
(function () {
  if (window.__BCM_PUB__) return;

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

  // 裸按钮兜底：很多简易评论框用不带 type 属性的 <button>（属性选择器匹配不到），按文案识别
  const SUBMIT_HINT = /post|submit|comment|reply|send|发表|提交|发布|评论/i;

  function findSubmitIn(scope, submitSel) {
    for (const sc of [...new Set([scope, document].filter(Boolean))]) {
      const bySel = submitSel ? q(submitSel, sc) : null;
      if (bySel) return bySel;
      const explicit = qa('input[type="submit"], button[type="submit"], .submit, #submit', sc)[0];
      if (explicit) return explicit;
      const byText = qa('button, input[type="button"]', sc)
        .find((el) => SUBMIT_HINT.test(((el.value || '') + ' ' + (el.textContent || '')).trim()));
      if (byText) return byText;
    }
    return null;
  }

  /** 归一化域名：支持完整 URL 或裸域名，去 www、转小写 */
  function domainOf(u) {
    if (!u) return '';
    try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); }
    catch { return String(u).replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./, '').toLowerCase(); }
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

      // 表单候选：包含 textarea 的 form（兼容无 form 包裹的评论组件）
      const forms = [];
      const seen = new Set();
      const candidates = [...document.querySelectorAll('form')].filter((f) => f.querySelector('textarea'));
      for (const textarea of document.querySelectorAll('textarea')) {
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

  // ---------- fill：填表 ----------

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
          if (el) return el;
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
      return { ok: true, filled, submitFound: lastFill.submitFound };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // ---------- 高亮标记：红框=定位目标链接 / 蓝框=AI 识别出的表单 ----------

  let linkIdx = 0; // 「定位目标链接」循环跳转的游标
  let lastMarked = null; // 当前红框标记的链接 { el, prev }

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

  /**
   * 循环定位页面中包含收集目标域名的锚点，并用红框标记（由面板助手页触发）。
   * 只标记滚动，文案交给面板：返回 { ok:true, index, total } 或 { ok:false, reason }。
   */
  function locateLink(cfg) {
    try {
      const domain = domainOf(cfg && cfg.domain);
      if (!domain) return { ok: false, reason: 'noTarget' };
      // 有的站点会把评论区渲染成多个 Tab（如「按时间/按热门」），隐藏 Tab 里的副本要跳过：
      // display:none 的元素滚不过去也看不见红框。优先只取可见锚点，全不可见时退回全部。
      const all = qa('a[href]').filter((a) => (a.href || '').toLowerCase().includes(domain));
      const visible = all.filter((a) => a.offsetParent !== null || a.getClientRects().length > 0);
      const links = visible.length ? visible : all;
      if (!links.length) return { ok: false, reason: 'noLink' };
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
      return { ok: true, index: i + 1, total: links.length };
    } catch (e) {
      return { ok: false, reason: 'error', error: String((e && e.message) || e) };
    }
  }

  /** 撤掉定位标记与表单高亮，恢复页面原样，并清空填表记录 */
  function cleanup() {
    unmark();
    unmarkForm();
    lastFill = null;
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

  window.__BCM_PUB__ = { detect, fill, submit, cleanup, markForm, locateLink };
})();
