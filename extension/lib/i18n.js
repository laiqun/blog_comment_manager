/**
 * 轻量 i18n：中/英双语字典，语言偏好存于 settings.language。
 * popup / options 通过 ES module 引入；content script 的文案由 background 下发或内置双语字典。
 */

export const MESSAGES = {
  // ---- 通用 ----
  appName: { zh: '博客评论外链管理器', en: 'Blog Comment Backlink Manager' },
  cancel: { zh: '取消', en: 'Cancel' },
  confirm: { zh: '确定', en: 'OK' },
  save: { zh: '保存', en: 'Save' },
  delete: { zh: '删除', en: 'Delete' },
  close: { zh: '关闭', en: 'Close' },
  confirmClearData: { zh: '确定要清空所有本地数据吗？（资源库/任务/日志/设置全部删除）', en: 'Clear ALL local data? (resources, tasks, logs and settings will be removed)' },
  saved: { zh: '已保存', en: 'Saved' },

  // ---- Tab ----
  tab_collect: { zh: '收集', en: 'Collect' },
  tab_publish: { zh: '发布', en: 'Publish' },
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

  // ---- 发布 ----
  publishTasks: { zh: '发布任务', en: 'Publish Tasks' },
  newTask: { zh: '+ 新建任务', en: '+ New Task' },
  stat_total: { zh: '总计', en: 'Total' },
  stat_success: { zh: '成功', en: 'Success' },
  stat_pending: { zh: '待审核', en: 'Pending' },
  stat_failed: { zh: '失败', en: 'Failed' },
  stat_remaining: { zh: '剩余', en: 'Remaining' },
  statusPublishing: { zh: '正在发布...', en: 'Publishing...' },
  statusWaiting: { zh: '等待人工确认（请在目标网页浮层上操作）...', en: 'Waiting for review (use the overlay on the page)...' },
  noTasks: { zh: '暂无任务，点击右上角「+ 新建任务」创建', en: 'No tasks yet. Click "+ New Task"' },
  taskStop: { zh: '停止任务', en: 'Stop task' },
  taskDetail: { zh: '查看明细', en: 'View details' },
  taskEdit: { zh: '编辑任务', en: 'Edit task' },
  taskDelete: { zh: '删除任务', en: 'Delete task' },
  taskDone: { zh: '已完成', en: 'Done' },
  taskStopped: { zh: '已停止', en: 'Stopped' },
  taskRunning: { zh: '运行中', en: 'Running' },

  // 新建/编辑任务弹窗
  titleCreateTask: { zh: '新建发布任务', en: 'New Publish Task' },
  titleEditTask: { zh: '编辑发布任务', en: 'Edit Publish Task' },
  taskName: { zh: '任务名称', en: 'Task Name' },
  targetUrl: { zh: '目标地址（用于评论正文内嵌链接）', en: 'Target URL (linked in comment body)' },
  siteIntro: { zh: '网站介绍（一两句，供 AI 判断相关性）', en: 'Site Intro (1-2 sentences, for AI relevance check)' },
  siteIntroPh: { zh: '例：Sprunki Game 是一个免费的音乐混音小游戏网站，玩家把角色拖到 beat 上创作音乐。', en: 'e.g. Sprunki Game is a free music-mixing game site where players drag characters onto a beat.' },
  mainKeyword: { zh: '主关键词（AI 做同义词/前后缀变体作锚文本）', en: 'Main Keyword (AI varies it for anchor text)' },
  mainKeywordPh: { zh: '例：sprunki', en: 'e.g. sprunki' },
  publishMode: { zh: '发布模式', en: 'Publish Mode' },
  modeSemi: { zh: '半自动（填表后人工确认提交）', en: 'Semi-auto (review before submit)' },
  modeAuto: { zh: '全自动（直接提交，不审核）', en: 'Fully auto (submit directly)' },
  resourceScope: { zh: '资源范围', en: 'Resource Scope' },
  scopeReady: { zh: '全部「可发布」资源', en: 'All "ready" resources' },
  btnCreate: { zh: '创建并运行', en: 'Create & Run' },
  btnSave: { zh: '保存', en: 'Save' },
  noReadyResources: { zh: '资源库中没有「可发布」资源，请先收集', en: 'No "ready" resources. Collect first' },

  // 任务明细弹窗
  titleTaskDetail: { zh: '任务明细', en: 'Task Details' },
  detailSuccess: { zh: '成功', en: 'Success' },
  detailSkip: { zh: '跳过', en: 'Skipped' },
  detailFail: { zh: '失败', en: 'Failed' },
  detailCaptcha: { zh: '验证码', en: 'Captcha' },
  detailWaiting: { zh: '待处理', en: 'Pending' },

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
  resOpen: { zh: '打开链接', en: 'Open link' },
  resPublish: { zh: '立即发布', en: 'Publish now' },
  resEnable: { zh: '启用 / 停用', en: 'Enable / disable' },
  resToggleAll: { zh: '启用全部 / 停用全部', en: 'Enable / disable all' },
  logSwitch: { zh: '记录日志', en: 'Logging' },
  logSwitchTitle: { zh: '开启后记录运行日志，关闭则直接丢弃', en: 'When off, new logs are discarded' },
  singleTaskName: { zh: '单条发布', en: 'Single publish' },

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
  publishCardTitle: { zh: '发布设置', en: 'Publish Settings' },
  publishModeLabel: { zh: '默认发布模式', en: 'Default Publish Mode' },
  languageLabel: { zh: '界面语言', en: 'UI Language' },

  // ---- 发布浮层（content script）----
  overlayTitle: { zh: 'Comment Ready', en: 'Comment Ready' },
  overlayBody: { zh: '评论表单已自动填好。请检查内容后点击 Submit 提交，或点击 Skip 跳过换下一个资源。', en: 'The comment form has been filled. Please review the content and click Submit to post, or Skip to move to the next resource.' },
  overlaySkip: { zh: 'Skip', en: 'Skip' },
  overlaySubmit: { zh: 'Submit', en: 'Submit' },
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
