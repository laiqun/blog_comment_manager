// fetch 最小桩：假 OpenRouter 响应，只验证解析逻辑，非浏览器模拟
const { getState } = await import('../extension/lib/storage.js');
const { LIMITS } = await import('../extension/lib/config.js');
const { chat, chatJSON, classifyPage, detectForm, getModel, testKey } = await import('../extension/lib/openrouter.js');
import { test } from 'node:test';
import assert from 'node:assert/strict';

LIMITS.aiDelayMs = 0; // 测试不受限流间隔影响

function stubFetch(content, { status = 200 } = {}) {
  globalThis.fetch = async () => ({
    ok: status < 400,
    status,
    json: async () => (status < 400
      ? { choices: [{ message: { content } }] }
      : { error: { message: 'bad key' } }),
    text: async () => 'err',
  });
}

test('未配置 API Key 时直接报错', async () => {
  await assert.rejects(chat('classify', [{ role: 'user', content: 'hi' }]), /API Key/);
});

test('chatJSON 正常解析模型 JSON 输出', async () => {
  getState().settings.openrouterKey = 'test-key';
  stubFetch('{"type":"blog_comment","commentable":true,"reason":"wp评论"}');
  const out = await chatJSON('classify', 'sys', 'user');
  assert.equal(out.type, 'blog_comment');
});

test('chatJSON 对脏输出（JSON 前后有废话）也能提取', async () => {
  stubFetch('好的，以下是结果：{"type":"profile","commentable":false,"reason":"个人主页"} 请查收');
  const out = await chatJSON('classify', 'sys', 'user');
  assert.equal(out.type, 'profile');
});

test('classifyPage 归一化非法类型为 other', async () => {
  stubFetch('{"type":"forum","commentable":true,"reason":"论坛"}');
  const v = await classifyPage({ url: 'https://a.com/1', title: 't', text: 'body' });
  assert.equal(v.type, 'other');
  assert.equal(v.commentable, true);

  stubFetch('{"type":"blog_comment","commentable":true,"reason":"WordPress 文章"}');
  const v2 = await classifyPage({ url: 'https://a.com/2', title: 't', text: 'body' });
  assert.equal(v2.type, 'blog_comment');
});

test('detectForm 透传选择器字段', async () => {
  stubFetch('{"comment":"#comment","author":"#author","email":"#email","url":"#url","submit":"#submit","saveInfo":"","linkMethod":"website_field","formSelector":"#commentform"}');
  const f = await detectForm({ formHtml: '<form id="commentform"></form>', pageUrl: 'https://a.com/1' });
  assert.equal(f.comment, '#comment');
  assert.equal(f.linkMethod, 'website_field');
});

test('getModel 按角色取模型', () => {
  getState().settings.models.discover = 'model-A';
  assert.equal(getModel('discover'), 'model-A');
  getState().settings.models.discover = undefined; // 缺失时回退 classify
  assert.equal(getModel('discover'), getState().settings.models.classify);
});

test('testKey：401 返回 ok:false，200 返回 ok:true', async () => {
  stubFetch('', { status: 401 });
  const bad = await testKey('wrong');
  assert.equal(bad.ok, false);
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { label: 'my-key', usage: 0.1, limit: 10 } }) });
  const good = await testKey('right');
  assert.equal(good.ok, true);
  assert.equal(good.label, 'my-key');
});

test('chat 请求体带低强度 reasoning（防思考模型吃光 max_tokens）', async () => {
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  await chat('classify', [{ role: 'user', content: 'hi' }]);
  assert.equal(captured.reasoning?.effort, 'low');
});

test('content 为空且 finish_reason=length 时报错提示思考占用额度', async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ finish_reason: 'length', message: { content: null, reasoning: '...' } }] }),
  });
  await assert.rejects(chat('classify', [{ role: 'user', content: 'hi' }]), /截断/);
});

test('summarizeArticle 返回指定语言的标题与摘要并识别文章语言，空摘要报错', async () => {
  const { summarizeArticle } = await import('../extension/lib/openrouter.js');
  stubFetch('{"title":"中文标题","summary":"文章讲了三个要点：A、B、C。","language":"English"}');
  const s = await summarizeArticle({ title: 'English Title', text: '很长很长的正文'.repeat(100), lang: 'zh' });
  assert.equal(s.title, '中文标题');
  assert.equal(s.summary, '文章讲了三个要点：A、B、C。');
  assert.equal(s.language, 'English');
  // 模型没给 title 时回退原标题
  stubFetch('{"title":"","summary":"摘要"}');
  const s2 = await summarizeArticle({ title: 'Orig', text: 'x' });
  assert.equal(s2.title, 'Orig');
  stubFetch('{"title":"t","summary":"  "}');
  await assert.rejects(summarizeArticle({ title: 't', text: 'x' }), /摘要为空/);
});

test('generateComment 评论语言跟随文章语言', async () => {
  const { generateComment } = await import('../extension/lib/openrouter.js');
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '评论内容' } }] }) };
  };
  await generateComment({ url: 'https://a.com/1', title: 't', text: '摘要' }, { articleLang: '中文' });
  assert.ok(captured.messages[0].content.includes('中文'), 'prompt 应要求用文章语言写评论');
  assert.ok(captured.messages[1].content.includes('中文'), 'user 消息应带上文章语言');
  // 未识别到语言时：仅要求与文章语言一致，不写死语种
  await generateComment({ url: 'https://a.com/1', title: 't', text: '摘要' }, {});
  assert.ok(captured.messages[0].content.includes('与文章相同的语言'));
});

test('generateComment 无占位符时不强插链接（AI 判断无交集）', async () => {
  const { generateComment } = await import('../extension/lib/openrouter.js');
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: 'This article really resonates with me.' } }] }),
  });
  const out = await generateComment({ url: 'https://a.com/1', title: 't', text: 's' }, { targetUrl: 'https://x.com/', mainKeyword: 'kw' });
  assert.ok(!out.includes('<a'), '无占位符时不应在句尾硬插链接');
  // 有占位符时正常替换为 <a>
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: 'I made one with {{LINK:this free tool}} last week.' } }] }),
  });
  const out2 = await generateComment({ url: 'https://a.com/1', title: 't', text: 's' }, { targetUrl: 'https://x.com/', mainKeyword: 'kw' });
  assert.ok(out2.includes('<a href="https://x.com/\n">this free tool</a>'));
});

test('buildCommentWithLink：占位符替换、href 右引号前换行、无占位符时追加', async () => {
  const { buildCommentWithLink } = await import('../extension/lib/openrouter.js');
  // 占位符替换
  const withPh = buildCommentWithLink(
    'Love the beat layering here, reminds me of my {{LINK:sprunki mix maker}} project.',
    'https://sprunki.com/', 'sprunki',
  );
  assert.ok(withPh.includes('<a href="https://sprunki.com/\n">sprunki mix maker</a>'), 'href 右引号前应有换行且锚文本来自占位符');
  assert.ok(!withPh.includes('{{LINK'), '占位符应被替换掉');
  // 无占位符 → 追加到末尾，锚文本兜底主关键词
  const noPh = buildCommentWithLink('Solid breakdown of the sound design.', 'https://s.com/', 'sprunki game');
  assert.ok(noPh.endsWith('<a href="https://s.com/\n">sprunki game</a>'), '无占位符时应追加链接');
  // 空锚文本占位符 → 兜底关键词
  const emptyAnchor = buildCommentWithLink('a {{LINK:}} b', 'https://s.com/', 'kw');
  assert.ok(emptyAnchor.includes('>kw</a>'), '空占位符应回退主关键词');
});
