/**
 * 全局配置 —— 所有「待联调」的不确定项都集中在这里。
 * 联调时只需要改这个文件，不用动其他逻辑。
 */

export const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';

export const DEFAULT_SETTINGS = {
  openrouterKey: '',
  models: {
    discover: DEFAULT_MODEL,   // 链接发现模型：从页面 HTML 提取候选外链
    classify: DEFAULT_MODEL,   // 链接分类模型：判断是否为可评论资源
    formDetect: DEFAULT_MODEL, // 表单识别模型：识别评论表单字段
    commentGen: DEFAULT_MODEL, // 评论生成模型：生成评论文案
  },
  identity: {
    name: '',    // 评论昵称
    email: '',   // 评论邮箱
    website: '', // 默认落地网址（任务的 targetUrl 优先）
  },
  publishMode: 'semi',     // semi=半自动(人工确认) / auto=全自动
  language: 'zh',          // zh / en
  analyzeDelayMs: 800,     // 分析队列每条之间的间隔
  aiDelayMs: 400,          // AI 请求最小间隔
  pageDelayMinMs: 3000,    // 收集翻页最小间隔（可在收集 Tab 配置）
  pageDelayMaxMs: 9000,    // 收集翻页最大间隔（实际取区间内随机值）
  logEnabled: true,        // 日志开关：关闭时 addLog 直接丢弃日志
};

export const LIMITS = {
  maxQueue: 5000,        // 收集队列上限
  logCap: 300,           // 日志保留条数
  navTimeoutMs: 30000,   // 页面加载超时
  formHtmlChunk: 15000,  // 送 AI 识别的表单 HTML 截断长度
  articleTextChunk: 3000,// 送 AI 的正文截断长度
  discoverHtmlChunk: 20000,
  pageSettleMs: 1200,    // 注入前等待页面渲染时间
};

/**
 * 外链数据源（Semrush / Ahrefs）
 * 两种接入模式：
 *  A. 面板模式（dashboardUrl 存在时）：Semrush 经 dash.3ue.co 共享面板使用——
 *     用户提前点「打开」并停留在 sem.3ue.co 工具页标签；点「开始收集」时校验
 *     当前活动标签必须是该工具页（否则报错），拿到 __gmitm 令牌后直达反向链接报告页。
 *     抓取为纯 DOM：读表格 a[data-test-source-url] 行，只保留「博客」标签行；
 *     翻页点击 [data-test-pagination-next-btn]，每页间隔随机 3-9s（联调实测 2026-09）。
 *  B. 直连模式（backlinksUrlTemplate）：直接拼列表页 URL（Ahrefs 待联调）。
 */
export const PROVIDERS = {
  semrush: {
    label: 'Semrush',
    // ---- 面板模式 ----
    dashboardUrl: 'https://dash.3ue.co/',
    toolHost: 'sem.3ue.co',         // 「打开」后的工具页 host（gmitm 代理）
    toolCachePage: 'gmitm.clean.cache.html',
    backlinksPath: '/analytics/backlinks/backlinks/',
    db: 'us',                       // Semrush 数据库
    excludeHosts: ['semrush.com', '3ue.co'],
  },
  ahrefs: {
    label: 'Ahrefs',
    backlinksUrlTemplate: '', // 待联调：如 'https://app.ahrefs.com/site-explorer/...?...'
    apiPatterns: [],          // 待联调
    paginationSelector: '',   // 待联调
    excludeHosts: ['ahrefs.com', 'app.ahrefs.com'],
  },
};

/**
 * 页面分析（判断是否为可评论博客文章）用的选择器。
 * 给出的是 WordPress 通用默认值，联调时可按需增删。
 */
export const ANALYZE_SELECTORS = {
  commentForm: ['form.comment-form', '#commentform', 'form[action*="wp-comments-post"]', 'form[action*="comments"]'],
  commentTextarea: ['#comment', 'textarea[name="comment"]', 'form textarea'],
  loginRequiredText: ['p.must-log-in', '.login-required', '#login-required'],
  commentList: ['.comment-list', '#comments ol', 'ol.comment-list', '.comments-list'],
  commentAuthorLink: ['.comment-author a', '.fn a', '.comment-meta a'],
  captcha: ['.g-recaptcha', 'iframe[src*="recaptcha"]', '#captcha', '.h-captcha'],
};

/**
 * 发布填表用的兜底选择器（WordPress 通用）。
 * 实际发布时优先使用 AI 表单识别的结果，这里只做兜底。
 */
export const PUBLISH_SELECTORS = {
  comment: ['#comment', 'textarea[name="comment"]'],
  author: ['#author', 'input[name="author"]'],
  email: ['#email', 'input[name="email"]'],
  website: ['#url', 'input[name="url"]'],
  submit: ['#submit', 'input[type="submit"]', 'button[type="submit"]'],
  saveInfo: ['#wp-comment-cookies-consent', 'input[name="wp-comment-cookies-consent"]'],
  captcha: ['.g-recaptcha', 'iframe[src*="recaptcha"]', '#captcha', '.h-captcha'],
};

// 「需要登录才能评论」的提示文案关键词（小写匹配）
export const LOGIN_HINTS = ['log in to leave a comment', 'must be logged in', '请登录后发表评论', '登录后才能评论'];
