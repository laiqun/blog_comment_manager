import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  truncate, hostMatches, samePageUrl, extractUrlsDeep, extractCommenterSites,
  toCSV, fmtTime, fmtDate,
} from '../extension/lib/util.js';

test('truncate 截断并加省略号', () => {
  assert.equal(truncate('abcdef', 3), 'abc…');
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('', 5), '');
  assert.equal(truncate(null, 5), '');
});

test('hostMatches 支持子域并忽略 www', () => {
  assert.equal(hostMatches('www.sprunki-game.io', 'sprunki-game.io'), true);
  assert.equal(hostMatches('a.b.sprunki-game.io', 'sprunki-game.io'), true);
  assert.equal(hostMatches('sprunki-game.io.evil.com', 'sprunki-game.io'), false);
  assert.equal(hostMatches('notrelated.com', 'sprunki-game.io'), false);
  assert.equal(hostMatches('', 'x.com'), false);
});

test('samePageUrl 容忍协议/www/末尾斜杠/hash 差异', () => {
  assert.equal(samePageUrl('https://blog.com/post/', 'http://www.blog.com/post#c1'), true);
  assert.equal(samePageUrl('https://blog.com/', 'https://blog.com'), true);
  assert.equal(samePageUrl('https://blog.com/a', 'https://blog.com/b'), false);
  assert.equal(samePageUrl('HTTPS://Blog.com/A?x=1', 'https://blog.com/a?x=1'), true);
  assert.equal(samePageUrl('', 'https://blog.com'), false);
});

test('extractUrlsDeep 递归抽取并排除指定主机', () => {
  const data = {
    list: [
      { source_url: 'https://blog.one.com/post/1', meta: { next: 'https://blog.two.com/a/b?x=1' } },
      'https://ads.ex.com/track',
      'not a url',
    ],
  };
  const urls = extractUrlsDeep(data, { excludeHosts: ['ex.com'] });
  assert.deepEqual(urls.sort(), ['https://blog.one.com/post/1', 'https://blog.two.com/a/b?x=1']);
});

test('extractUrlsDeep 排除目标域名自身', () => {
  const urls = extractUrlsDeep(['https://sprunki-game.io/home', 'https://other.com/p'], { excludeHosts: ['sprunki-game.io'] });
  assert.deepEqual(urls, ['https://other.com/p']);
});

test('extractCommenterSites 提取评论者域名并排除本站', () => {
  const html = `
    <div class="comment"><a href="https://www.foodblog.com/hi">小明</a></div>
    <div class="comment"><a href="https://self.post/me">本站</a></div>
    <a href="/relative/path">站内链接</a>`;
  const sites = extractCommenterSites(html, 'self.post');
  assert.deepEqual(sites, ['foodblog.com']);
});

test('toCSV 带 BOM、表头与引号转义', () => {
  const csv = toCSV([
    { url: 'https://a.com/x"1",2', domain: 'a.com', type: 'blog_comment', status: 'ready', addedAt: 1700000000000, publishedAt: 0 },
  ]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('url,domain,type,status,addedAt,publishedAt'));
  assert.ok(csv.includes('"https://a.com/x""1"",2"'));
  assert.ok(csv.includes('blog_comment'));
});

test('时间格式化输出固定位数', () => {
  assert.match(fmtTime(Date.now()), /^\d{2}:\d{2}:\d{2}$/);
  assert.match(fmtDate(1700000000000), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(fmtDate(0), '');
});

test('backlinksCsv：表头/BOM/字段转义', async () => {
  const { backlinksCsv } = await import('../extension/lib/util.js');
  const csv = backlinksCsv([
    { url: 'https://a.com/x', domain: 'a.com', title: '他说"你好"', platform: '博客', ascore: '88', anchor: 'click here', targetUrl: 'https://t.com/', extLinks: '3', intLinks: '12', firstSeen: '2025-01-02', lastSeen: '2026-09-01', page: 1, addedAt: 0 },
    { url: 'https://b.com/', domain: 'b.com', title: '', platform: '', ascore: '', anchor: '', targetUrl: '', extLinks: '', intLinks: '', firstSeen: '', lastSeen: '', page: 2, addedAt: 0 },
  ]);
  assert.ok(csv.startsWith('\uFEFF'), '应带 BOM');
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], 'url,domain,title,platform,ascore,anchor,targetUrl,extLinks,intLinks,firstSeen,lastSeen,page,addedAt');
  assert.ok(lines[1].includes('"他说""你好"""'), '引号应转义为两个引号');
  assert.ok(lines[1].includes('"博客"'), 'platform 文本应保留');
  assert.ok(lines[1].includes('"2025-01-02"') && lines[1].includes('"click here"'), '日期与锚文本应保留');
  assert.equal(backlinksCsv([]).split('\r\n').length, 1, '空数据只有表头');
});
