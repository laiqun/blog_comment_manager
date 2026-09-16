# extension 核心逻辑测试

用 Node 自带的 `node:test`，不引入任何依赖，不模拟浏览器/DOM。
只测扩展里的**纯函数与状态逻辑**：

| 文件 | 覆盖内容 |
|------|---------|
| `util.test.mjs` | URL 深度抽取、评论者站点提取、CSV（转义/BOM）、域名匹配、时间格式化 |
| `storage.test.mjs` | 资源去重/增删改、任务计数（含待审核）、日志上限、save 序列化（内存版 chrome.storage 桩） |
| `openrouter.test.mjs` | 无 Key 报错、JSON 解析容错（脏输出提取）、classifyPage 结果归一化、模型角色映射、Key 校验（fetch 桩） |
| `i18n.test.mjs` | 中英字典 key 对齐、参数插值、语言切换 |
| `config.test.mjs` | 默认模型/数据源结构、「待联调项留空」契约 |

## 运行

```bash
# 在仓库根目录
node --test test/
```

单个文件：

```bash
node --test test/util.test.mjs
```

注意：`storage.test.mjs` 与 `openrouter.test.mjs` 里给 `chrome.storage` / `fetch`
打的是几行内的最小桩（内存 Map / 假响应），只是让纯逻辑能跑起来，不是浏览器模拟。
