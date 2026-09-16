/**
 * 页面分析器：采集候选博客文章页的信息，供 AI 分类与评论生成使用。
 * 由 background 注入后调用 window.__BCM_ANALYZE__(cfg)，同步返回结果对象。
 */
(function () {
  if (window.__BCM_ANALYZE__) return;

  function q(sel) {
    try { return document.querySelector(sel); } catch { return null; }
  }
  function qAny(list) {
    for (const s of list || []) {
      const el = q(s);
      if (el) return el;
    }
    return null;
  }
  function qa(sel) {
    try { return [...document.querySelectorAll(sel)]; } catch { return []; }
  }

  window.__BCM_ANALYZE__ = function analyze(cfg) {
    const selectors = (cfg && cfg.selectors) || {};
    const loginHints = (cfg && cfg.loginHints) || [];
    try {
      const title = (document.querySelector('title')?.textContent || document.title || '').trim();
      const desc = q('meta[name="description"]')?.content || '';
      const bodyClone = document.body ? document.body.cloneNode(true) : null;

      // 正文文本：优先 article，退化为 body 全文（截断交给后台）
      let text = '';
      const article = q('article') || q('main') || q('.entry-content') || q('.post-content');
      if (article) text = article.innerText || '';
      if (!text && bodyClone) {
        bodyClone.querySelectorAll('script,style,noscript,nav,header,footer').forEach((el) => el.remove());
        text = bodyClone.innerText || '';
      }

      const commentForm = qAny(selectors.commentForm);
      const textarea = qAny(selectors.commentTextarea);
      const loginEl = qAny(selectors.loginRequiredText);
      let loginRequired = !!loginEl;
      if (!loginRequired) {
        const hay = ((loginEl && loginEl.innerText) || document.body?.innerText || '').toLowerCase().slice(0, 20000);
        loginRequired = loginHints.some((h) => hay.includes(h.toLowerCase()));
      }

      const hasForm = !!(commentForm || textarea);

      // 评论区 HTML（用于提取评论者网站，滚雪球种子）
      const commentList = qAny(selectors.commentList);
      const commentHtml = commentList ? commentList.innerHTML.slice(0, 60000) : '';

      return {
        ok: true,
        url: location.href,
        title,
        description: desc,
        text: (text || '').replace(/\s+/g, ' ').slice(0, 12000),
        hasForm,
        loginRequired,
        hasCaptcha: !!qAny(selectors.captcha),
        commentHtml,
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };
})();
