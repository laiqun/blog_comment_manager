/**
 * OpenRouter 网关客户端。四个模型角色按设置里的 models 映射。
 */
import { getState } from './storage.js';
import { LIMITS } from './config.js';

const API_BASE = 'https://openrouter.ai/api/v1';
let _lastCallAt = 0;

async function throttle() {
  const wait = LIMITS.aiDelayMs - (Date.now() - _lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastCallAt = Date.now();
}

export function getModel(role) {
  const { settings } = getState();
  return settings.models[role] || settings.models.classify;
}

/** 基础对话。返回 assistant 文本。 */
export async function chat(role, messages, { maxTokens = 1000, temperature = 0.4, json = true } = {}) {
  const { settings } = getState();
  const key = settings.openrouterKey;
  if (!key) throw new Error('未配置 OpenRouter API Key，请先到设置页填写');
  await throttle();
  const body = {
    model: getModel(role),
    messages,
    max_tokens: maxTokens,
    temperature,
  };
  if (json) body.response_format = { type: 'json_object' };
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://localhost/extension',
      'X-Title': 'Blog Comment Backlink Manager',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('OpenRouter 返回为空');
  return content;
}

/** 对话并解析 JSON（要求模型输出 json_object）。解析失败时尝试提取 {...} / [...]。 */
export async function chatJSON(role, system, user, opts = {}) {
  const text = await chat(role, [
    { role: 'system', content: system + '\n只输出合法 JSON，不要输出任何解释文字。' },
    { role: 'user', content: user },
  ], { ...opts, json: true });
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/[[{][\s\S]*[\]}]/);
    if (m) return JSON.parse(m[0]);
    throw new Error('AI 返回的 JSON 无法解析: ' + text.slice(0, 120));
  }
}

/** 测试 API Key 是否有效，成功返回 {ok, label, usage} */
export async function testKey(key) {
  const res = await fetch(`${API_BASE}/key`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const data = await res.json().catch(() => ({}));
  return { ok: true, label: data?.data?.label || '', usage: data?.data?.usage ?? null, limit: data?.data?.limit ?? null };
}

// ================= 四个 AI 角色 =================

/** 链接分类：判断页面是否为免登录可评论的博客文章 */
export async function classifyPage({ url, title, text }) {
  const system = [
    '你是网页分类助手。判断给定网页是否属于以下类型：',
    '- blog_comment：博客文章页，且无需登录/注册即可发表评论（如 WordPress 文章带评论表单）',
    '- profile：个人主页/关于页等可直接留下链接的页面',
    '- other：其他（论坛需登录、电商、纯列表页、需要注册等）',
    '只输出 JSON：{"type":"blog_comment|profile|other","commentable":true/false,"reason":"简短中文原因"}',
  ].join('\n');
  const user = `URL: ${url}\n标题: ${title || '(无)'}\n正文摘录:\n${(text || '').slice(0, LIMITS.articleTextChunk)}`;
  const out = await chatJSON('classify', system, user, { maxTokens: 300, temperature: 0.1 });
  return {
    type: ['blog_comment', 'profile'].includes(out.type) ? out.type : 'other',
    commentable: !!out.commentable,
    reason: out.reason || '',
  };
}

/** 表单识别：从评论表单 HTML 中识别各字段选择器 */
export async function detectForm({ formHtml, pageUrl }) {
  const system = [
    '你是表单识别助手。从博客评论表单的 HTML 中找出各字段对应的 CSS 选择器。',
    '优先使用 id 选择器（如 #comment），其次 name 属性（如 textarea[name="comment"]）。',
    'linkMethod 表示该站留外链的方式：website_field(有独立网址输入框) / comment_body(只能在正文放链接) / author_link(昵称带链接)。',
    '只输出 JSON：',
    '{"comment":"正文选择器","author":"昵称选择器","email":"邮箱选择器","url":"网址选择器(无则空串)",',
    ' "submit":"提交按钮选择器","saveInfo":"记住我复选框选择器(无则空串)","linkMethod":"website_field","formSelector":"表单选择器"}',
    '找不到的字段给空字符串。',
  ].join('\n');
  const user = `页面: ${pageUrl}\n表单 HTML:\n${(formHtml || '').slice(0, LIMITS.formHtmlChunk)}`;
  const out = await chatJSON('formDetect', system, user, { maxTokens: 400, temperature: 0.1 });
  return out;
}

/** 相关性预判：文章与目标网站主题是否搭得上边 */
export async function checkRelevance({ title, text, siteIntro, mainKeyword }) {
  const system = [
    '你是相关性判断助手。判断一篇博客文章与某个网站主题是否相关——即能否在评论里自然地提到该网站。',
    '完全无关（不同领域、硬凑不上）才算不相关；有任意角度可以自然关联就算相关。',
    '只输出 JSON：{"related":true/false,"reason":"简短中文原因"}',
  ].join('\n');
  const user = [
    `我的网站介绍：${siteIntro || '(无)'}`,
    `主关键词：${mainKeyword || '(无)'}`,
    '',
    `文章标题: ${title || '(无)'}`,
    '正文摘录:',
    (text || '').slice(0, LIMITS.articleTextChunk),
  ].join('\n');
  const out = await chatJSON('classify', system, user, { maxTokens: 200, temperature: 0.1 });
  return { related: !!out.related, reason: out.reason || '' };
}

/** 评论身份：根据文章内容生成不起眼的读者昵称与邮箱 */
export async function generateIdentity({ title, text }) {
  const system = [
    '为一条博客评论生成一个真实感的读者身份。',
    'name：普通的英文昵称/人名（不要名人、不要关键词堆砌）。',
    'email：与之匹配的邮箱，使用常见免费邮箱域名（gmail.com / outlook.com / yahoo.com 等），用户名部分像真人。',
    '只输出 JSON：{"name":"...","email":"..."}',
  ].join('\n');
  const user = `文章标题: ${title || '(无)'}\n正文摘录:\n${(text || '').slice(0, 800)}`;
  const out = await chatJSON('classify', system, user, { maxTokens: 120, temperature: 0.9 });
  const name = String(out.name || '').trim().slice(0, 40);
  const email = String(out.email || '').trim().slice(0, 60);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('生成的身份不合法');
  return { name, email };
}

/**
 * 把占位符替换成 <a> 链接：href 的右引号前插入换行（<a href="url\n">锚文本</a>）。
 * 没有占位符时链接追加到正文末尾；锚文本兜底用主关键词。
 */
export function buildCommentWithLink(text, targetUrl, fallbackAnchor) {
  const link = (anchor) => `<a href="${targetUrl}\n">${anchor}</a>`;
  const src = String(text || '').trim();
  const m = src.match(/\{\{LINK:([^}]+)\}\}/);
  if (m) {
    const anchor = m[1].trim().slice(0, 100) || fallbackAnchor;
    return src.replace(/\s*\{\{LINK:[^}]+\}\}/, ' ' + link(anchor)).trim();
  }
  return `${src} ${link(fallbackAnchor)}`.trim();
}

/** 评论生成：自然相关评论 + 正文内嵌主关键词变体锚链接（website 字段留空，链接只走正文） */
export async function generateComment({ url, title, text }, { targetUrl, siteIntro = '', mainKeyword = '' } = {}) {
  const system = [
    '你是一位真实的博客读者，要给一篇博客文章写一条自然、相关、有观点的英文评论。',
    '要求：2-4 句，口语化、具体地回应文章观点；像真人，不要奉承开头（不要用 "Great post!" 这类空洞话）；',
    '不要出现 markdown；不要暴露你是 AI。',
    targetUrl ? [
      '评论中要用 {{LINK:锚文本}} 占位符标出提到我网站的链接位置（只放一次，自然融入句子）。',
      `锚文本要求：基于我的主关键词「${mainKeyword || siteIntro || targetUrl}」做变体——可加相关前缀/后缀、同义词或长尾组合`,
      '（例如 "best X"、"X for beginners"、"cheap X alternatives"），不要每次都用一模一样的裸关键词。',
      `我的网站：${targetUrl}${siteIntro ? `\n网站介绍：${siteIntro}` : ''}`,
    ].join('\n') : '不要在评论里放任何链接，也不要输出占位符。',
  ].join('\n');
  const user = `文章标题: ${title || '(无)'}\n文章 URL: ${url}\n正文摘录:\n${(text || '').slice(0, LIMITS.articleTextChunk)}`;
  const out = await chat('commentGen', [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { maxTokens: 400, temperature: 0.8, json: false });
  const cleaned = out.trim();
  if (!targetUrl) return cleaned.replace(/\s*\{\{LINK:[^}]+\}\}/g, '');
  return buildCommentWithLink(cleaned, targetUrl, mainKeyword || 'this website');
}

/** 链接发现：从列表页 HTML 提取候选文章链接（拦截不到 API 时的兜底） */
export async function discoverLinks(html, baseUrl) {
  const system = [
    '从网页 HTML 中提取所有指向文章/详情页的链接（排除导航、分类、标签、登录、页脚链接）。',
    '只输出 JSON：{"links":["绝对URL1","绝对URL2",...]}，最多 50 条。',
  ].join('\n');
  const user = `基准地址: ${baseUrl}\nHTML:\n${(html || '').slice(0, LIMITS.discoverHtmlChunk)}`;
  const out = await chatJSON('discover', system, user, { maxTokens: 1500, temperature: 0.1 });
  return Array.isArray(out.links) ? out.links.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)) : [];
}
