/**
 * 发布器：识别评论表单 → 填入 AI 评论与身份信息 → 半自动弹「Comment Ready」浮层等人工确认 / 全自动直接提交。
 * 由 background 注入，通过 window.__BCM_PUB__ 的 detect / fill / submit / cleanup 四个入口调用。
 */
(function () {
  if (window.__BCM_PUB__) return;

  const OVERLAY_ID = '__bcm_overlay__';

  const I18N = {
    zh: {
      title: 'Comment Ready',
      body: '评论表单已自动填好。请检查内容后点击 Submit 提交，或点击 Skip 跳过换下一个资源。',
      skip: 'Skip',
      submit: 'Submit',
    },
    en: {
      title: 'Comment Ready',
      body: 'The comment form has been filled. Please review the content and click Submit to post, or Skip to move to the next resource.',
      skip: 'Skip',
      submit: 'Submit',
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

  function findSubmitIn(scope, submitSel) {
    const bySel = submitSel ? q(submitSel, scope) : null;
    if (bySel) return bySel;
    return (
      q('input[type="submit"]', scope) ||
      q('button[type="submit"]', scope) ||
      qa('input[type="submit"], button[type="submit"], .submit, #submit').find((el) => true) ||
      null
    );
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

      if (cfg.mode === 'auto') {
        return { ok: true, filled, submitFound: lastFill.submitFound };
      }

      showOverlay(cfg.lang || 'zh');
      return { ok: true, filled };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function showOverlay(lang) {
    cleanup();
    const s = I18N[lang === 'en' ? 'en' : 'zh'];
    const wrap = document.createElement('div');
    wrap.id = OVERLAY_ID;
    wrap.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'width:320px', 'z-index:2147483647',
      'background:#1c1f2e', 'border-radius:12px', 'padding:16px', 'box-sizing:border-box',
      'box-shadow:0 8px 32px rgba(0,0,0,.45)', 'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = s.title;
    title.style.cssText = 'color:#4a9eff;font-size:15px;font-weight:700;margin-bottom:8px;';

    const body = document.createElement('div');
    body.textContent = s.body;
    body.style.cssText = 'color:#d1d5db;font-size:12.5px;line-height:1.6;margin-bottom:14px;white-space:pre-line;';

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
    skipBtn.addEventListener('mouseenter', () => (skipBtn.style.background = '#4b5563'));
    skipBtn.addEventListener('mouseleave', () => (skipBtn.style.background = '#374151'));

    function decide(decision) {
      const rurl = lastFill && lastFill.resourceUrl;
      cleanup();
      if (rurl) chrome.runtime.sendMessage({ type: 'pub:decision', resourceUrl: rurl, decision }).catch(() => {});
    }

    row.appendChild(skipBtn);
    row.appendChild(submitBtn);
    wrap.appendChild(title);
    wrap.appendChild(body);
    wrap.appendChild(row);
    document.documentElement.appendChild(wrap);
  }

  function cleanup() {
    const old = document.getElementById(OVERLAY_ID);
    if (old) old.remove();
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

  window.__BCM_PUB__ = { detect, fill, submit, cleanup };
})();
