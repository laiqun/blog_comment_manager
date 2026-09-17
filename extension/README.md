# 博客评论外链管理器 — Chrome MV3 插件

基于 `docs/插件界面描述.md` 复刻的 MV3 扩展：从 Semrush/Ahrefs 拦截采集同行站点外链 → AI 分析出「免登录可评论」的博客资源 → 在侧边栏「助手」标签页对当前标签页执行 AI 识别表单、生成评论并自动填表，人工确认提交。

## 安装（开发者模式）

1. 打开 `chrome://extensions`，右上角开启「开发者模式」
2. 「加载已解压的扩展程序」→ 选择本目录（`extension/`）
3. 点击工具栏图标打开侧边栏（Side Panel，页面刷新不影响），页脚「设置」进入设置页填入 OpenRouter API Key

## 目录结构

```
extension/
├── manifest.json            # MV3 清单（storage/tabs/scripting/alarms/favicon + <all_urls>）
├── background/
│   ├── service-worker.js    # 消息路由、快照广播、保活 alarm、断点续跑
│   ├── collect.js           # 收集控制器：DOM 抓取表格行→点下一页翻页→「开始分析」逐条访问+规则判定入库
│   └── publish.js           # 助手发布控制器：步骤对当前激活标签页执行（识别/生成/填表/提交），「换一个」挑未发布资源
├── content/
│   ├── analyzer.js          # 页面分析器：标题/正文/评论表单/评论区信息采集
│   └── publisher.js         # 发布器（无 UI 页面操作）：detect/fill/submit/cleanup/markForm/locateLink
├── lib/
│   ├── config.js            # ★ 所有「待联调」选择器与 URL 模板集中在这里
│   ├── storage.js           # chrome.storage.local 状态镜像（SW 重启可恢复）
│   ├── openrouter.js        # OpenRouter 客户端 + 四个模型角色
│   ├── i18n.js              # 中/英字典 + applyI18n
│   └── util.js              # 工具（URL 深度抽取、CSV、tab 等待等）
├── sidepanel/               # 侧边栏暗色面板：收集/助手/日志/资源库 四 Tab（点工具栏图标打开）
├── options/                 # 设置页：API Key / 四模型 / 发布身份 / 语言
└── _locales/                # 应用名称与描述
```

## 数据源配置（都在 `lib/config.js`）

Semrush 走**面板模式**（已在 dash.3ue.co 联调通过）：先在 dash.3ue.co 点 Semrush 卡片「打开」，
并**停留在**打开的工具页标签（sem.3ue.co）；点「开始收集」时插件校验当前标签必须是该工具页
（否则直接报错）→ 取 URL 里的 `__gmitm` 令牌 → 直达 `/analytics/backlinks/backlinks/?q={域名}`
反向链接报告页 → **纯 DOM 抓取**：读取表格 `a[data-test-source-url]` 行，只保留带「博客」标签
（`[data-test-type="platform"]`）的来源；每抓完一页随机等 3-9 秒 → 点击页面上的「下一页」按钮
（`[data-test-pagination-next-btn]`）→ 等表格刷新后继续，直到最后一页自动结束。
不构造、不重放任何接口请求。
收集全程只用工具页这一个标签；结构化数据（URL/域名/源页面标题/分类标签）存于 IndexedDB
（`bcm-idb` 的 `backlinks` 表，按目标域名归档，唯一持久层，不进 chrome.storage），
收集 Tab 的「导出收集数据 (CSV)」可导出。

| 配置 | 说明 |
|------|------|
| `PROVIDERS.semrush.*` | 面板入口/工具页 host/报告页路径/翻页参数（已填实测值，一般无需改动） |
| `PROVIDERS.ahrefs.backlinksUrlTemplate` | Ahrefs 外链列表页 URL 模板（`{domain}` 占位），待联调，当前留空 |
| `PROVIDERS.ahrefs.apiPatterns` / `paginationSelector` | 同上 |
| `ANALYZE_SELECTORS` / `PUBLISH_SELECTORS` | 已给出 WordPress 通用默认值，特殊站点可增删 |

联调方法（新增数据源时）：在数据源外链列表页打开 DevTools → Network → XHR，找到返回外链数据的
请求，把 URL 关键词填进 `apiPatterns`；若页面有传统「下一页」按钮，右键检查拿选择器填进
`paginationSelector`；没有则优先考虑 `pagination: { mode: 'api' }` 重放接口翻页。

## 使用流程

1. **设置**：填 OpenRouter Key（可测试连接），默认四模型均为 `z-ai/glm-5.3-flash`；填写发布身份（昵称/邮箱/默认网址）
2. **收集 → 分析（两步独立）**：先在 dash.3ue.co 点 Semrush「打开」并停留在工具页；输入同行域名点「开始收集」——只抓外链数据（自动只保留带「博客」标签的来源，每页间隔 5-10s，收完自动结束，可导出 CSV）；再点「开始分析」——才对数据集逐条访问页面做规则判定（要登录跳过 / 无评论表单不入库 / 有表单命中），命中入库「博客评论资源」
3. **资源库**：点击 Tab 时直读 IndexedDB `analysis` 表（命中结论 `ready/captcha`，有验证码的资源也算命中），支持单条打开/立即发布（当前标签页打开该资源）/启停，导出 CSV
4. **发布（助手 Tab）**：顶部选定「当前任务」（目标地址/网站介绍/主关键词，可从模板选择/编辑，可折叠）→ 对当前激活标签页逐步骤执行（获取标题与摘要 / 识别表单 / 生成评论 / 填写表单）→ 人工点 Submit / Skip；「换一个」把当前标签页导航到未发布过的下一条资源
5. **日志**：收集/发布/AI/系统四类日志实时滚动

> 开发调试：侧边栏页脚的 **↻** 按钮可随时重新加载插件（`chrome.runtime.reload()`，状态都在 storage 里，重载后收集队列可续跑）。核心纯函数的单测在仓库 `test/` 目录，运行 `node --test test/*.test.mjs`。

## 说明

- MV3 service worker 会被回收：日志/设置/助手会话等状态落 `chrome.storage.local`，大数据量表（backlinks / analysis / published）只存 IndexedDB（唯一持久层）；`chrome.alarms` 每 30 秒唤醒续跑收集队列；发布由助手页对当前标签页驱动，无后台循环
- AI 全部走 OpenRouter `/chat/completions`，表单识别/摘要要求 JSON 输出，评论生成为纯文本
