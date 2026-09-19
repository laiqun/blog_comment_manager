# AGENTS.md — 博客评论外链管理器

> 面向 AI 编码代理的项目说明。读完本文件即可上手修改本项目。

## 项目概述

这是一个 **Chrome MV3 浏览器扩展**（无构建步骤的纯 JavaScript），一款 SEO 外链建设辅助工具「博客评论外链管理器」。核心业务链路：

1. **收集**：输入同行站点域名，复用用户已打开的 Semrush 工具页（经 dash.3ue.co 共享面板），纯 DOM 抓取反向链接表格（`a[data-test-source-url]` 行，只保留「博客」标签来源），点页面「下一页」按钮自动翻页，随机间隔 3-9 秒。不构造、不重放任何接口请求。
2. **分析**：对收集到的外链逐条访问页面，**纯规则判定**（不经 AI）：要求登录 → 跳过；无评论表单 → 不入库；有评论表单 → 命中入资源库（有验证码标记为 captcha）。来源类型已由收集阶段的 Semrush「博客」标签保证。
3. **发布**：无后台任务队列，由侧边栏「助手」标签页驱动：资源库点 ↗（或助手页「换一个」）把**当前激活标签页**导航到资源页面 → 助手页顶部选定「当前任务」（目标地址/网站介绍/主关键词，可从模板选择/编辑）→ 人工逐步触发 AI 步骤（标题与摘要 / 识别表单 / 生成评论 / 填表）→ 检查后点 Submit / Skip；Submit 成功写 published 表防重复。

原始设计依据在 `docs/插件界面描述.md`（UI 复刻参考文档）。

## 技术栈与运行方式

- **纯 JavaScript ES Module**，无 package.json、无打包器、无 npm 依赖。唯一外部服务是 OpenRouter API。
- 入口清单：`extension/manifest.json`（MV3，`default_locale: zh_CN`，最低 Chrome 111）。
- 权限：`storage / tabs / scripting / alarms / favicon / sidePanel` + `host_permissions: <all_urls>`。
- 安装/调试：`chrome://extensions` 开开发者模式 → 「加载已解压的扩展程序」→ 选 `extension/` 目录。侧边栏页脚的 ↻ 按钮可热重载（`chrome.runtime.reload()`）。
- **无部署流程**：目前是本地开发者模式加载，未发布到 Chrome Web Store。

## 目录结构与模块划分

```
extension/
├── manifest.json            # MV3 清单
├── background/
│   ├── service-worker.js    # 消息路由（switch on msg.type）、状态快照广播、alarms 保活、断点续跑
│   ├── collect.js           # CollectController：DOM 抓取外链 → 翻页 → 「开始分析」逐条访问 + 规则判定入库（不经 AI）
│   └── publish.js           # PublishAssistant：助手页步骤对当前激活标签页执行（识别/生成/填表/提交），「换一个」挑未发布资源
├── content/                 # 由 background 用 scripting 注入，不走 manifest content_scripts
│   ├── analyzer.js          # window.__BCM_ANALYZE__：采集标题/正文/评论表单/评论区信息
│   └── publisher.js         # window.__BCM_PUB__：无 UI 页面操作 detect/fill/submit/cleanup/markForm/locateLink（IIFE，非 ESM）；全框架注入（评论框可能在 iframe 里），不再向页面注入任何浮层 DOM
├── lib/
│   ├── config.js            # ★ 所有「待联调」的选择器、URL 模板、默认值集中在这里，联调只改这个文件
│   ├── storage.js           # chrome.storage.local 内存镜像 + 日志操作 + 旧数据迁移（资源数据全在 IDB）
│   ├── idb.js               # IndexedDB 轻量封装（库 bcm-idb v3，stores: backlinks / analysis / published / templates）
│   ├── openrouter.js        # OpenRouter 客户端 + 四个 AI 角色（classify/formDetect/commentGen/discover）
│   ├── i18n.js              # 中/英字典（MESSAGES）+ applyI18n
│   └── util.js              # URL 处理、CSV（带 BOM）、tab 等待等纯函数
├── sidepanel/               # 侧边栏主界面（panel.html/css/js）：收集/助手/日志/资源库四 Tab，点工具栏图标打开；「助手」Tab 是发布主操作台
├── options/                 # 设置页：API Key / 四模型 / 发布身份 / 语言 / 标题与摘要语言 / AI 超时
└── _locales/                # 仅扩展名称与描述（zh_CN / en）
docs/                        # 设计文档（插件界面描述.md）
test/                        # Node 自带 node:test 单测（见下）
```

## 架构要点（改代码前必读）

- **持久化分两层**：
  - `chrome.storage.local`（key `bcm_store`）存小状态：settings / collectState / assistantTask / publishRuntime / lastPublish / logs。`lib/storage.js` 的 `state` 是它的内存镜像，**变更后必须 `save(...keys)`**；`save` 是合并写入（先 get 再展开），不要绕过它直接写 storage。旧版的任务队列（`tasks` / `activeTaskId`）已随「发布」Tab 移除，`load()` 里有一次性清理。
  - **IndexedDB（`bcm-idb` v3）是大数据表的唯一持久层**，不进 chrome.storage、不进内存态：`backlinks`（主键 `[targetDomain, url]`）、`analysis`（同主键；命中结论 ready/captcha 的记录即「可用资源」，含 `enabled` 启停标记，默认启用）、`published`（已发过的外链，主键 `[url, targetUrl]`，Submit 成功时写入）、`templates`（「当前任务」模板，主键 `name`，助手页顶部可存/选/删，同名覆盖即编辑）。绑定页面时若同 `[url, targetUrl]` 已发布过会在助手页状态行提示。资源库 UI 直读 `analysis` 表；v1 的 `resources` 表已废弃（升级时已发布记录自动迁入 `published` 后删表），旧版 chrome.storage 双写的 backlinks 由 `storage.js` 里的一次性迁移函数搬到 IDB。
- **MV3 service worker 随时被回收**：所有状态落盘后才能丢；`chrome.alarms`（`bcm-tick`，30 秒）负责唤醒续跑收集队列，并把回收途中卡住的 `stopping` 状态收尾为 `idle`；`onInstalled`/`onStartup` 做断点续跑。发布无后台循环，回收不影响——publishRuntime（助手会话）落盘后重开面板照样续上。
- **UI ↔ 后台通信**：sidepanel 用 `sendMessage` RPC（`getSnapshot`、`startCollect`、`setAssistantTask`、`setSettings` 等；助手页交互 `pub:step`/`pub:decision`/`pub:locate`/`pickNextResource` 也来自 sidepanel 的「助手」Tab）；后台状态推送走 `chrome.runtime.sendMessage` 单向广播（`stateChanged` 快照），**不用 port 长连接**——无连接状态，SW 回收重启后新实例照样送达，面板关着时静默丢弃、打开时由 `init()` 的 `getSnapshot` 追平。**设置的唯一写入口是 `setSettings` 消息**，options 页也不得直接写 storage（会被后台内存态覆盖）。
- **助手页（发布主操作台）**：操作对象 = 浏览器当前激活的标签页（面板用 `chrome.tabs.query` + onActivated/onUpdated 跟踪，仅 http/https 可注入）。顶部「当前任务」配置区（`assistantTask`，字段失焦即存；模板下拉选择即填充并保存），下方步骤按钮/字段复制/定位同行网站/换一个/Submit/Skip 全部作用于当前标签页。后台 `PublishAssistant` 收到步骤时取激活 tab，`publishRuntime.resourceUrl` 与该 tab URL 不一致则重新绑定（全框架注入 + 纯规则页面检测：验证码/登录/表单，只提示不阻断）；面板按快照 `publish.resourceUrl` 与当前标签页一致才算「绑定」——字段区仅绑定时展示、Submit/Skip 仅绑定且 `stage === 'awaiting_review'` 解锁、「自动填写表单」需 `manual.comment` 已生成。Submit 成功写 published 表并作废已提交评论（强制重新生成防误重复提交），同时把这次发布记进 `lastPublish`（url/目标地址/任务名/时间/备注）；助手页底部「备注」按钮就是给 `lastPublish` 打标记（如「有审核」「失败」），**与当前标签页解耦**——提交后随时可改，并尽力同步 published 表的 comment 字段；「换一个」（`pickNextResource`）把当前标签页导航到资源库未发布过的下一条资源（ready 优先于 captcha，同档按命中时间新→旧）。步骤按钮看门狗在面板侧：`aiTimeoutMs * 3 + 30000` 未回包提示可重试。
- **收集统计口径**：四项统计均为跨轮次累积口径——空闲时（`getSnapshot` 触发，3 秒去抖）从 IndexedDB 重新计算：已发现=backlinks 条数、已分析=analysis 条数、队列中=backlinks 里未分析的、博客评论资源=analysis 中 ready/captcha 条数（与资源库筛选一致）（见 `service-worker.js` 的 `refreshCollectStatsFromIdb`）；「开始收集/开始分析」也从同一基线起算，分析运行中每处理完一条即调 `syncStatsFromIdb` 从 IndexedDB 重新对账四项统计（不增量累加，显示值恒等于表口径）；收集模式下「队列中」随抓取新入档逐条 +1。
- **AI 调用**：全走 OpenRouter `/chat/completions`，`chatJSON` 要求 `json_object` 输出并有脏输出兜底提取；四个角色模型可在设置页分别配置，默认 `z-ai/glm-5.3-flash`；调用间有 `aiDelayMs` 节流；单次请求有 `aiTimeoutMs` 超时（默认 20s，设置页按秒配置，5-300s 收敛），超时用 AbortController 主动中止——请求挂死会把助手页步骤按钮永久卡住（面板侧另有 aiTimeoutMs*3+30s 看门狗兜底）。所有请求带 `reasoning: { effort: 'low' }`（GLM 这类思考模型默认推理很长，会把 `max_tokens` 吃光导致 `content` 为空、`finish_reason: length`），且各角色的 `maxTokens` 预算已按「思考 + 正文」留足。发布时先用 `summarizeArticle`（复用 classify 模型）把可能截断的正文提炼成标题+摘要并识别文章语言（标题/摘要的输出语言由 `settings.summaryLang` 决定，默认中文，设置页可改），评论生成/身份生成统一吃摘要，**评论语言跟随文章语言**（`generateComment` 的 `articleLang` 参数，识别不到时仅要求与文章一致）；摘要缓存于 `rt.manual.summary`/`sumTitle`/`artLang`，反复生成评论不重复总结；摘要失败退回原标题+原始摘录。助手页有独立「获取标题与摘要」步骤按钮，结果（含文章语言）连同评论/身份一起经 `rt.manual` 落盘、随快照展示在助手页上（各字段带复制按钮）；评论语言跟随文章，用户未必读得懂，因此生成评论时附带一次 `translateComment` 译文（目标语言同 summaryLang，纯文本剥掉 HTML，存 `rt.manual.translation`、仅助手页展示不填表；文章语言与阅读语言一致时跳过，失败仅记日志）。评论内嵌链接用 `{{LINK:锚文本}}` 占位符，由 `buildCommentWithLink` 替换为 `<a>`；链接是硬性要求（不带链接的评论无效）：提示词要求必须输出占位符且与摘要论点自然融合，模型未输出占位符时加强措辞重试一次，仍无则 `generateComment` 抛错——助手页状态行报错，可直接再点一次重新生成。
- **数据源联调**：Semrush 走「面板模式」（已联调通过）：用户需先在 dash.3ue.co 打开工具并停留在 `sem.3ue.co` 标签，插件校验当前标签后取 URL 里的 `__gmitm` 令牌直达报告页。Ahrefs 是「直连模式」占位（`backlinksUrlTemplate` 等留空待联调）。新增数据源时只改 `lib/config.js` 的 `PROVIDERS`。

## 构建与测试命令

无构建步骤。测试用 Node 自带 runner，零依赖：

```bash
# 在仓库根目录运行全部测试（59 个用例）
node --test test/*.test.mjs

# 单个文件
node --test test/util.test.mjs
```

注意：`node --test test/`（目录形式）在当前 Node 24 环境下会报 `Cannot find module`，请用上面的 glob 形式。

## 测试策略

- 测试在仓库根目录 `test/`，只测**纯函数与状态逻辑**，不模拟浏览器/DOM。
- `test/stubs.mjs` 提供共享的内存版 IndexedDB 最小桩；个别测试文件内还有几行的 `chrome.storage` / `fetch` 桩（内存 Map / 假响应），只为让纯逻辑能跑，不是浏览器模拟。
- 已有覆盖：util（CSV/URL/域名匹配）、storage（日志上限/save 合并写/旧版任务队列数据一次性清理）、openrouter（JSON 容错/分类归一化/Key 校验）、i18n（中英 key 对齐/插值）、config（「待联调项留空」契约）、service-worker（IDB 口径统计刷新/快照资源派生/资源启停/快照 publish 助手页扩展字段/setAssistantTask）、collect（statsBaseline 四项统计与 IDB 存量同口径）、templates（模板保存/同名覆盖/删除/名称校验）、两条迁移（chrome.storage backlinks → IDB；IDB v1→v2 resources 已发布记录 → published）。
- 新增纯逻辑时应同步加测试到对应 `test/*.test.mjs`；涉及 DOM/浏览器 API 的逻辑不进单测。

## 代码风格约定

- 注释、日志文案、提交信息均使用**中文**；代码标识符用英文。新代码请沿用此惯例。
- `lib/` 下的模块为 ES Module；`content/` 脚本是 IIFE（注入后挂 `window.__BCM_*__`，带幂等守卫 `if (window.__BCM_...__) return;`）。
- 文件头部普遍有一段块注释说明模块职责，新文件请保持。
- 选择器、URL 模板、可调参数一律放 `lib/config.js`，不要散落到业务代码里；「待联调」项留空并在 config 测试中有契约约束。
- UI 文案走 `lib/i18n.js` 的 `MESSAGES` 字典（zh/en 双语，key 必须两边对齐，有测试保证）；content 脚本为纯无 UI 页面操作，不含界面文案。
- 错误处理偏好：可恢复异常记日志（`addLog(src, msg, level, url)`，src ∈ collect/publish/ai/system）并继续，不向用户抛原始堆栈。

## 安全注意事项

- OpenRouter API Key 存于 `chrome.storage.local`（settings.openrouterKey），仅用于 `openrouter.ai` 请求的 Authorization 头；快照只暴露 `hasKey` 布尔值，不回传 Key 本体。
- `host_permissions: <all_urls>` 是业务必需（要注入任意博客页面填表），引入新权限时需同样克制并说明理由。
- 收集只做被动 DOM 读取和点击页面已有按钮，**不构造/重放数据源的接口请求**，新增数据源时保持这一原则。
- 仓库无密钥文件；不要把任何 Key 提交进代码或文档。
