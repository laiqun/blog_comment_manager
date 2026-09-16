# 博客评论外链管理器 — Chrome MV3 插件

基于 `docs/插件界面描述.md` 复刻的 MV3 扩展：从 Semrush/Ahrefs 拦截采集同行站点外链 → AI 分析出「免登录可评论」的博客资源 → 创建发布任务，AI 识别表单、生成评论并自动填表，半自动模式由人工在网页浮层上确认提交。

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
│   ├── collect.js           # 收集控制器：DOM 抓取表格行→点下一页翻页→「开始分析」逐条访问+AI 分类入库
│   └── publish.js           # 发布调度：任务逐条执行→表单识别→评论生成→填表→人工确认
├── content/
│   ├── analyzer.js          # 页面分析器：标题/正文/评论表单/评论区信息采集
│   └── publisher.js         # 发布器：detect/fill/submit/cleanup + Comment Ready 浮层
├── lib/
│   ├── config.js            # ★ 所有「待联调」选择器与 URL 模板集中在这里
│   ├── storage.js           # chrome.storage.local 状态镜像（SW 重启可恢复）
│   ├── openrouter.js        # OpenRouter 客户端 + 四个模型角色
│   ├── i18n.js              # 中/英字典 + applyI18n
│   └── util.js              # 工具（URL 深度抽取、CSV、tab 等待等）
├── sidepanel/               # 侧边栏暗色面板：收集/发布/日志/资源库 四 Tab（点工具栏图标打开）
├── options/                 # 设置页：API Key / 四模型 / 发布身份 / Sheets 同步 / 语言
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

1. **设置**：填 OpenRouter Key（可测试连接），默认四模型均为 `google/gemini-2.0-flash-001`；填写发布身份（昵称/邮箱/默认网址）
2. **收集 → 分析（两步独立）**：先在 dash.3ue.co 点 Semrush「打开」并停留在工具页；输入同行域名点「开始收集」——只抓外链数据（自动只保留带「博客」标签的来源，每页间隔 5-10s，收完自动结束，可导出 CSV）；再点「开始分析」——才对数据集逐条访问页面 + AI 分类，命中入库「博客评论资源」
3. **资源库**：按类型（博客评论/个人主页）与状态（可发布/已发布/失败/有验证码）筛选，支持单条打开/立即发布/删除，导出 CSV
4. **发布**：新建任务（绑定全部「可发布」资源 + 目标网址 + 模式）→ 自动逐条执行；半自动模式目标页面右下角弹「Comment Ready」浮层，人工点 Submit / Skip
5. **日志**：收集/发布/AI/系统四类日志实时滚动

> 开发调试：侧边栏页脚的 **↻** 按钮可随时重新加载插件（`chrome.runtime.reload()`，状态都在 storage 里，重载后队列可续跑）。核心纯函数的单测在仓库 `test/` 目录，运行 `node --test test/*.test.mjs`。

## 说明

- MV3 service worker 会被回收：所有状态落 `chrome.storage.local`，`chrome.alarms` 每 30 秒唤醒续跑队列；半自动待审核不受影响
- AI 全部走 OpenRouter `/chat/completions`，分类/表单识别要求 JSON 输出，评论生成为纯文本
- Google Sheets 同步采用 Apps Script Web App URL（`doPost` 接收 `{action:'syncResources', resources:[...]}`），避免 OAuth 复杂度；后续可替换为完整 OAuth 流程
