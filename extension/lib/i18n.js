/**
 * 轻量 i18n：中/英双语字典，语言偏好存于 settings.language。
 * sidepanel / options 通过 ES module 引入；content 脚本为纯无 UI 页面操作，不含界面文案。
 */

export const MESSAGES = {
  // ---- 通用 ----
  appName: { zh: '博客评论外链管理器', en: 'Blog Comment Backlink Manager' },
  delete: { zh: '删除', en: 'Delete' },
  confirmClearData: { zh: '确定要清空所有本地数据吗？（资源库/模板/日志/设置全部删除）', en: 'Clear ALL local data? (resources, templates, logs and settings will be removed)' },
  saved: { zh: '已保存', en: 'Saved' },

  // ---- Tab ----
  tab_collect: { zh: '收集', en: 'Collect' },
  tab_logs: { zh: '日志', en: 'Logs' },
  tab_library: { zh: '资源库', en: 'Library' },

  // ---- 页脚 ----
  settings: { zh: '设置', en: 'Settings' },
  clearData: { zh: '清空数据', en: 'Clear Data' },
  devReload: { zh: '重新加载插件（开发用）', en: 'Reload extension (dev)' },
  devReloadShort: { zh: '重载插件', en: 'Reload' },

  // ---- 收集 ----
  targetDomain: { zh: '目标域名', en: 'Target Domain' },
  targetDomainPh: { zh: '输入同行站点域名，如 sprunki-game.io', en: "Competitor domain, e.g. sprunki-game.io" },
  dataSource: { zh: '数据来源', en: 'Data Source' },
  pageDelay: { zh: '翻页间隔(秒)', en: 'Page Delay (s)' },
  pageAsFilter: { zh: '页面 AS ≥', en: 'Page AS ≥' },
  pageAsFilterHint: { zh: '低于该值的来源页面不入库', en: 'Sources below this score are skipped' },
  startCollect: { zh: '开始收集', en: 'Start Collecting' },
  stopCollect: { zh: '停止收集', en: 'Stop Collecting' },
  startAnalysis: { zh: '开始分析', en: 'Start Analysis' },
  stopAnalysis: { zh: '停止分析', en: 'Stop Analysis' },
  stat_discovered: { zh: '已发现外链', en: 'Discovered' },
  stat_analyzed: { zh: '已分析', en: 'Analyzed' },
  stat_matched: { zh: '博客评论资源', en: 'Comment Blogs' },
  stat_queued: { zh: '队列中', en: 'Queued' },
  statusIdle: { zh: '空闲中，输入域名开始收集', en: 'Idle. Enter a domain to start' },
  phaseOpening: { zh: '正在打开外链列表页...', en: 'Opening backlink list page...' },
  phaseCapturing: { zh: '正在抓取外链数据...', en: 'Scraping backlink data...' },
  phaseAnalyzing: { zh: '正在分析外链页面...', en: 'Analyzing backlink pages...' },
  phaseStopping: { zh: '正在停止...', en: 'Stopping...' },
  collectDone: { zh: '收集完成', en: 'Collection finished' },
  analysisDone: { zh: '分析完成', en: 'Analysis finished' },
  seedHint: { zh: '条同行种子域名（可回炉再收集）', en: 'peer seed domains (can be re-collected)' },
  matchedHint: { zh: '命中的博客评论资源已存入「资源库」Tab', en: 'Matched comment-blog resources are saved to the Library tab' },

  // ---- 助手页「当前任务」配置（原发布任务的可复用部分，模板存 IndexedDB templates 表）----
  asstTask: { zh: '当前任务', en: 'Current Task' },
  asstExpand: { zh: '展开', en: 'Expand' },
  asstCollapse: { zh: '收起', en: 'Collapse' },
  taskName: { zh: '任务名称', en: 'Task Name' },
  targetUrl: { zh: '目标地址（用于评论正文内嵌链接）', en: 'Target URL (linked in comment body)' },
  siteIntro: { zh: '网站介绍（一两句，供 AI 生成评论）', en: 'Site Intro (1-2 sentences, for AI comment generation)' },
  siteIntroPh: { zh: '例：Sprunki Game 是一个免费的音乐混音小游戏网站，玩家把角色拖到 beat 上创作音乐。', en: 'e.g. Sprunki Game is a free music-mixing game site where players drag characters onto a beat.' },
  mainKeyword: { zh: '主关键词（AI 做同义词/前后缀变体作锚文本）', en: 'Main Keyword (AI varies it for anchor text)' },
  mainKeywordPh: { zh: '例：sprunki', en: 'e.g. sprunki' },
  tplSelect: { zh: '选择模板填充…', en: 'Fill from template…' },
  tplSave: { zh: '存为模板', en: 'Save as template' },
  tplNamePrompt: { zh: '模板名称', en: 'Template name' },
  tplOverwrite: { zh: '已存在同名模板「{name}」，覆盖它？', en: 'Template "{name}" exists. Overwrite?' },
  tplSaved: { zh: '模板已保存', en: 'Template saved' },
  tplDeleted: { zh: '模板已删除', en: 'Template deleted' },

  // ---- 日志 ----
  logsTitle: { zh: '运行日志', en: 'Activity Logs' },
  clearLogs: { zh: '清空日志', en: 'Clear Logs' },
  copyLogs: { zh: '一键复制', en: 'Copy Logs' },
  logsCopied: { zh: '✓ 已复制到剪贴板', en: '✓ Copied to clipboard' },
  noLogs: { zh: '暂无日志', en: 'No logs yet' },
  src_collect: { zh: '收集', en: 'Collect' },
  src_publish: { zh: '发布', en: 'Publish' },
  src_ai: { zh: 'AI', en: 'AI' },
  src_system: { zh: '系统', en: 'System' },

  // ---- 资源库 ----
  filterAll: { zh: '全部', en: 'All' },
  type_blog_comment: { zh: '博客评论', en: 'Blog Comment' },
  type_profile: { zh: '个人主页', en: 'Profile' },
  st_ready: { zh: '可发布', en: 'Ready' },
  st_published: { zh: '已发布', en: 'Published' },
  st_failed: { zh: '失败', en: 'Failed' },
  st_captcha: { zh: '有验证码', en: 'Captcha' },
  countLine: { zh: '共 {n} 条资源', en: '{n} resources' },
  exportCSV: { zh: '导出 CSV', en: 'Export CSV' },
  exportBacklinks: { zh: '导出收集数据 (CSV)', en: 'Export collected (CSV)' },
  noResources: { zh: '暂无资源，去「收集」Tab 发现外链资源', en: 'No resources yet. Go to the Collect tab' },
  resOpen: { zh: '打开链接（新标签页）', en: 'Open link (new tab)' },
  resPublish: { zh: '在当前标签页打开该资源，到「助手」页发布', en: 'Open in the active tab and publish from the Assistant tab' },
  resEnable: { zh: '启用 / 停用', en: 'Enable / disable' },
  resToggleAll: { zh: '启用全部 / 停用全部', en: 'Enable / disable all' },
  logSwitch: { zh: '记录日志', en: 'Logging' },
  logSwitchTitle: { zh: '开启后记录运行日志，关闭则直接丢弃', en: 'When off, new logs are discarded' },

  // ---- 设置页 ----
  optionsTitle: { zh: '博客评论外链管理器 - 设置', en: 'Blog Comment Backlink Manager - Settings' },
  apiCardTitle: { zh: 'OpenRouter API Key', en: 'OpenRouter API Key' },
  apiKeyPh: { zh: 'sk-or-v1-...', en: 'sk-or-v1-...' },
  testConn: { zh: '测试连接', en: 'Test Connection' },
  testOk: { zh: '✓ 连接成功', en: '✓ Connected' },
  testFail: { zh: '✗ 连接失败', en: '✗ Failed' },
  modelsCardTitle: { zh: '模型配置', en: 'Model Configuration' },
  model_discover: { zh: '链接发现模型', en: 'Link Discovery Model' },
  model_discover_desc: { zh: '从页面 HTML 中提取候选外链（高频调用，建议便宜快速模型）', en: 'Extract candidate links from HTML (frequent calls, prefer cheap & fast models)' },
  model_classify: { zh: '链接分类模型', en: 'Link Classification Model' },
  model_classify_desc: { zh: '判断外链页面是否属于免登录可评论的博客资源', en: 'Decide whether a page is a login-free commentable blog' },
  model_formDetect: { zh: '表单识别模型', en: 'Form Detection Model' },
  model_formDetect_desc: { zh: '识别评论表单的各字段（昵称/邮箱/网址/正文/提交按钮）', en: 'Identify comment form fields (name/email/website/comment)' },
  model_commentGen: { zh: '评论生成模型', en: 'Comment Generation Model' },
  model_commentGen_desc: { zh: '根据文章内容生成相关的原创评论文案（建议高质量模型）', en: 'Generate a relevant original comment (prefer a strong model)' },
  identityCardTitle: { zh: '发布身份', en: 'Commenter Identity' },
  identityCardDesc: { zh: '发布评论时填入的昵称与邮箱；网址优先使用任务的目标地址', en: 'Name & email used when posting; website prefers the task target URL' },
  idName: { zh: '昵称', en: 'Name' },
  idEmail: { zh: '邮箱', en: 'Email' },
  idWebsite: { zh: '网址（默认落地链接）', en: 'Website (default target link)' },
  generalCardTitle: { zh: '通用设置', en: 'General' },
  languageLabel: { zh: '界面语言', en: 'UI Language' },
  summaryLangLabel: { zh: '标题与摘要语言', en: 'Title & Summary Language' },
  aiTimeoutLabel: { zh: 'AI 请求超时（秒）', en: 'AI Request Timeout (s)' },

  // ---- 助手页（发布主操作台：对当前激活标签页执行步骤，任务配置 = 顶部「当前任务」）----
  tab_assistant: { zh: '助手', en: 'Assistant' },
  asstCurrentUrl: { zh: '当前资源（当前激活标签页）', en: 'Current resource (active tab)' },
  asstNoPage: { zh: '当前标签页不是可操作的网页，请先打开一个博客页面', en: 'The active tab is not an operable web page — open a blog page first' },
  asstNext: { zh: '换一个（在当前标签页打开未发布资源）', en: 'Pick next (open an unpublished resource in this tab)' },
  asstNoMore: { zh: '资源库中没有未发布过的资源了', en: 'No unpublished resources left in the library' },
  asstCaptcha: { zh: '检测到验证码（已标记资源）：可在页面中手动完成验证后继续执行步骤', en: 'Captcha detected (resource flagged): solve it on the page, then continue with the steps' },
  asstLogin: { zh: '该站可能需要登录才能评论', en: 'This site may require login to comment' },
  asstNoForm: { zh: '未自动找到评论表单：可人工定位表单后点「AI 识别评论表单」重试，或「AI 生成评论」后复制手动粘贴', en: 'No comment form found: locate it manually and retry "AI detect form", or copy a generated comment and paste it yourself' },
  asstAlreadyPublished: { zh: '提示：该页面已发布过当前目标链接，注意避免重复评论', en: 'Note: this page already has your target link published — avoid duplicate comments' },
  asstSubmitted: { zh: '✓ 已提交。可点「换一个」继续下一条未发布资源', en: '✓ Submitted. Click "Pick next" to continue with another unpublished resource' },
  asstSkipped: { zh: '已跳过。可点「换一个」继续下一条', en: 'Skipped. Click "Pick next" to continue' },
  stepSummarize: { zh: '获取标题与摘要', en: 'Get title & summary' },
  stepDetect: { zh: 'AI 识别评论表单', en: 'AI detect form' },
  stepGen: { zh: 'AI 生成评论', en: 'AI generate comment' },
  stepFill: { zh: '自动填写表单', en: 'Auto fill form' },
  asstSummarizing: { zh: 'AI 正在生成标题与摘要…', en: 'AI is generating the title & summary…' },
  asstDetecting: { zh: '正在识别评论表单…', en: 'Detecting the comment form…' },
  asstGenerating: { zh: 'AI 正在生成评论…', en: 'AI is generating the comment…' },
  asstFilling: { zh: '正在自动填写表单…', en: 'Filling the comment form…' },
  asstSumDone: { zh: '标题与摘要已生成，显示在下方，可复制。', en: 'Title & summary generated below — copyable.' },
  asstFormDone: { zh: '表单识别完成，已在页面上蓝色高亮目标表单。', en: 'Form detected and highlighted on the page.' },
  asstNoFormShort: { zh: '未找到评论表单', en: 'No comment form found' },
  asstCommentDone: { zh: '评论已生成。不满意可再点「AI 生成评论」换一条，满意后点「自动填写表单」。', en: 'Comment generated. Click "AI generate comment" again for a new one, or "Auto fill form" to continue.' },
  asstReady: { zh: '评论表单已自动填好。请检查内容后点击 Submit 提交，或点击 Skip 跳过换下一个资源。', en: 'The comment form has been filled. Please review the content and click Submit to post, or Skip to move to the next resource.' },
  asstManual: { zh: '操作对象是当前激活的标签页。「获取标题与摘要」「AI 生成评论」「AI 识别评论表单」互不依赖，可任意顺序执行；评论不满意可再点一次重新生成，满意后点「自动填写表单」。', en: 'Steps act on the active tab. "Get title & summary", "AI generate comment" and "AI detect form" are independent — run them in any order. Not happy with the comment? Click again for a new one, then "Auto fill form".' },
  asstLocate: { zh: '定位同行网站', en: 'Locate target link' },
  asstLocateDomainPh: { zh: '同行网站域名', en: 'Peer site domain' },
  asstLocating: { zh: '正在定位…', en: 'Locating…' },
  asstNoTarget: { zh: '未找到该资源对应的收集目标域名', en: 'No collect target domain found for this resource' },
  asstNoLink: { zh: '页面中未找到指向目标域名的链接', en: 'No link pointing to the target domain was found on this page' },
  asstLocated: { zh: '已定位到第 {n}/{m} 个目标链接', en: 'Jumped to target link {n}/{m}' },
  asstSubmit: { zh: 'Submit', en: 'Submit' },
  asstSkip: { zh: 'Skip', en: 'Skip' },
  asstMarkInvalid: { zh: '标记为无效资源', en: 'Mark as invalid resource' },
  asstInvalidMarked: { zh: '已标记为无效资源（资源库中已停用，数据保留）', en: 'Marked as invalid (disabled in the library, data kept)' },
  asstNoteLabel: { zh: '上次发布备注（标记最近一条已发评论）', en: 'Note for the last published comment' },
  asstNoteSave: { zh: '备注', en: 'Note' },
  asstNoteDefault: { zh: '有审核', en: 'Has moderation' },
  asstNoteSaved: { zh: '备注已保存', en: 'Note saved' },
  fieldComment: { zh: '评论内容', en: 'Comment' },
  fieldTranslation: { zh: '评论译文（仅供参考，不填入表单）', en: 'Translation (reference only, not filled)' },
  fieldName: { zh: '昵称', en: 'Name' },
  fieldEmail: { zh: '邮箱', en: 'Email' },
  fieldTitle: { zh: '标题', en: 'Title' },
  fieldSummary: { zh: '摘要', en: 'Summary' },
  fieldLang: { zh: '文章语言', en: 'Article language' },
  copy: { zh: '复制', en: 'Copy' },
  copied: { zh: '已复制 ✓', en: 'Copied ✓' },
  asstStepNoResp: { zh: '请求超时或后台无响应，可直接再点一次重试。', en: 'Request timed out or no response from background — just click again to retry.' },
  asstStepNeedComment: { zh: '请先生成评论，再执行「自动填写表单」', en: 'Generate a comment first, then "Auto fill form"' },
};

let _lang = 'zh';

export function setLanguage(lang) {
  _lang = lang === 'en' ? 'en' : 'zh';
}

export function getLanguage() {
  return _lang;
}

export function t(key, params = {}) {
  let s = MESSAGES[key]?.[_lang] ?? MESSAGES[key]?.zh ?? key;
  for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, v);
  return s;
}

/** 将语言应用到 DOM：data-i18n(文本) / data-i18n-ph(placeholder) / data-i18n-title(title) */
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
}
