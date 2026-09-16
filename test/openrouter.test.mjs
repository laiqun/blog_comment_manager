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
