# extension 核心逻辑测试

用 Node 自带的 `node:test`，不引入任何依赖，不模拟浏览器/DOM。
只测扩展里的**纯函数与状态逻辑**：

| 文件 | 覆盖内容 |
|------|---------|
| `util.test.mjs` | URL 深度抽取、评论者站点提取、CSV（转义/BOM）、域名匹配、时间格式化 |
| `storage.test.mjs` | 日志上限、save 合并写序列化、旧版任务队列数据（tasks/activeTaskId）一次性清理（内存版 chrome.storage 桩） |
| `openrouter.test.mjs` | 无 Key 报错、JSON 解析容错（脏输出提取）、classifyPage 结果归一化、模型角色映射、Key 校验（fetch 桩） |
| `i18n.test.mjs` | 中英字典 key 对齐、参数插值、语言切换 |
| `config.test.mjs` | 默认模型/数据源结构、「待联调项留空」契约 |
| `service-worker.test.mjs` | getSnapshot 时按 IndexedDB 口径刷新收集统计（已发现/已分析/队列中/命中），运行中不刷新，targetDomain 丢失时从 IDB 恢复；快照 resources 由 analysis 命中记录派生（enabled/published 标记）；资源库读 analysis 表与启停开关；快照 publish 助手页字段与 setAssistantTask「当前任务」配置（内存版 chrome.* + IndexedDB 桩） |
| `migrate-backlinks.test.mjs` | 旧版 chrome.storage backlinks 一次性迁移到 IndexedDB（补齐缺失的 targetDomain、移除原字段）、save 不再写 backlinks |
| `migrate-published.test.mjs` | IndexedDB v1→v2：旧 resources 表已发布记录迁入 published 表后删表，未发布记录不迁移 |
| `stubs.mjs` | 共享的内存版 IndexedDB 最小桩（put/get/getAll 范围/delete/clear/建删 store，复合主键） |

## 运行

```bash
# 在仓库根目录
node --test test/*.test.mjs
```

单个文件：

```bash
node --test test/util.test.mjs
```

注意：`storage.test.mjs` 与 `openrouter.test.mjs` 里给 `chrome.storage` / `fetch`
打的是几行内的最小桩（内存 Map / 假响应），只是让纯逻辑能跑起来，不是浏览器模拟。
