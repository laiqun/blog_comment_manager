import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODEL, DEFAULT_SETTINGS, PROVIDERS, LIMITS,
  ANALYZE_SELECTORS, PUBLISH_SELECTORS, LOGIN_HINTS,
} from '../extension/lib/config.js';

test('默认四模型角色都指向 DEFAULT_MODEL', () => {
  const roles = ['discover', 'classify', 'formDetect', 'commentGen'];
  for (const role of roles) {
    assert.equal(DEFAULT_SETTINGS.models[role], DEFAULT_MODEL, `模型角色 ${role} 应有默认值`);
  }
});

test('Semrush 面板模式配置完整（dash.3ue.co 联调实测值）', () => {
  const s = PROVIDERS.semrush;
  assert.ok(s.dashboardUrl.startsWith('https://'), '面板入口应为 https 地址');
  assert.ok(s.toolHost, '工具页 host 必填');
  assert.ok(!s.backlinksPath.includes('{') && s.backlinksPath.startsWith('/'), '报告页路径应为固定 path');
  assert.ok(s.db, 'Semrush 数据库必填');
  assert.ok(DEFAULT_SETTINGS.pageDelayMinMs === 3000 && DEFAULT_SETTINGS.pageDelayMaxMs === 9000, '翻页间隔默认随机 3-9s（收集 Tab 可配置）');
  // 面板模式不需要直连 URL 模板
  assert.equal(s.backlinksUrlTemplate, undefined);
  // 排除列表必须含数据源自身域（防止把面板/代理站当成外链资源）
  const hasSource = s.excludeHosts.some((h) => s.toolHost.endsWith(h) || h.endsWith(s.toolHost.replace(/^[^.]+\./, '')));
  assert.ok(hasSource, 'excludeHosts 应覆盖工具站域名');
});

test('Ahrefs 直连模式待联调：模板/捕获/翻页均留空', () => {
  const a = PROVIDERS.ahrefs;
  assert.equal(a.backlinksUrlTemplate, '');
  assert.deepEqual(a.apiPatterns, []);
  assert.equal(a.paginationSelector, '');
});

test('分析/发布选择器兜底均为非空数组（WordPress 通用值）', () => {
  for (const [name, list] of Object.entries(ANALYZE_SELECTORS)) {
    assert.ok(Array.isArray(list) && list.length > 0, `ANALYZE_SELECTORS.${name} 不应为空`);
  }
  for (const [name, list] of Object.entries(PUBLISH_SELECTORS)) {
    assert.ok(Array.isArray(list) && list.length > 0, `PUBLISH_SELECTORS.${name} 不应为空`);
  }
});

test('登录提示关键词与基础限制存在', () => {
  assert.ok(LOGIN_HINTS.length >= 2);
  assert.ok(LIMITS.maxQueue > 0 && LIMITS.logCap > 0 && LIMITS.navTimeoutMs > 0);
});
