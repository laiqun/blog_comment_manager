/**
 * 发布任务调度器：
 * 任务 = 一批资源（resourceIds）。逐条执行：
 *   打开页面 → 注入 publisher → 采集表单 → AI 表单识别 → AI 生成评论
 *   → 自动填表 → 半自动等待浮层确认 / 全自动直接提交 → 回写资源状态与任务计数
 */
import { getState, save, addLog, findResource, findTask, updateResource } from '../lib/storage.js';
import { PUBLISH_SELECTORS, LIMITS } from '../lib/config.js';
import { detectForm, generateComment, checkRelevance, generateIdentity } from '../lib/openrouter.js';
import { waitTabComplete, sleep } from '../lib/util.js';

export class PublishRunner {
  constructor(notify) {
    this.notify = notify;
    this.busy = false;
  }

  async startTask(taskId) {
    const task = findTask(taskId);
    if (!task) throw new Error('任务不存在');
    if (task.status === 'running') throw new Error('任务已在运行');
    if (!task.resourceIds.length) throw new Error('任务没有任何资源');
    task.status = 'running';
    task.results = task.results || {};
    task.finishedAt = 0;
    const st = getState();
    st.activeTaskId = taskId;
    st.publishRuntime = { taskId, resourceId: null, stage: 'opening', tabId: null };
    addLog('publish', `任务「${task.name}」开始，共 ${task.resourceIds.length} 条资源`, 'info');
    await this.notify(['tasks', 'activeTaskId', 'publishRuntime', 'logs']);
    this.loop();
  }

  async loop() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (true) {
        const st = getState();
        const rt = st.publishRuntime;
        if (!rt) break;
        const task = findTask(rt.taskId);
        if (!task || task.status !== 'running') break;

        const nextId = task.resourceIds.find((id) => !(id in (task.results || {})));
        if (!nextId) {
          this.finishTask(task, 'done');
          break;
        }
        rt.resourceId = nextId;
        rt.stage = 'opening';
        await this.notify(['publishRuntime', 'tasks']);
        await this.publishOne(task, nextId);
        // 半自动模式停在 awaiting_review，等 onDecision 唤醒
        if (getState().publishRuntime && getState().publishRuntime.stage === 'awaiting_review') break;
      }
    } finally {
      this.busy = false;
    }
  }

  async publishOne(task, resourceId) {
    const st = getState();
    const rt = st.publishRuntime;
    const res = findResource(resourceId);
    if (!res) return this.record(task, resourceId, 'skip', '资源已被删除');

    // 复用或新建发布标签页
    let tabId = rt.tabId;
    if (tabId) {
      try { await chrome.tabs.get(tabId); } catch { tabId = null; rt.tabId = null; }
    }
    if (!tabId) {
      const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
      tabId = tab.id;
      rt.tabId = tabId;
    }
    await chrome.tabs.update(tabId, { url: res.url });
    addLog('publish', `打开资源页面...`, 'info', res.url);
    const okNav = await waitTabComplete(tabId, LIMITS.navTimeoutMs);
    if (getState().publishRuntime !== rt) return; // 任务中途被停/删
    if (!okNav) return this.record(task, resourceId, 'fail', '页面加载超时');
    await sleep(LIMITS.pageSettleMs);

    // 注入并采集页面信息
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/publisher.js'] });
    const [det] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (cfg) => window.__BCM_PUB__ && window.__BCM_PUB__.detect(cfg),
      args: [{ selectors: PUBLISH_SELECTORS }],
    });
    const d = det && det.result;
    if (getState().publishRuntime !== rt) return;
    if (!d) return this.record(task, resourceId, 'fail', '无法注入页面脚本（可能被反爬拦截）');
    if (d.hasCaptcha) {
      await updateResource(resourceId, { status: 'captcha' });
      return this.record(task, resourceId, 'captcha', '检测到验证码，已标记资源');
    }
    if (d.loginRequired) return this.record(task, resourceId, 'fail', '该站需要登录才能评论');
    if (!d.forms.length) return this.record(task, resourceId, 'fail', '未找到评论表单');

    // AI 相关性预判：文章与目标网站搭不上边就直接跳过，不发评论
    if (task.siteIntro || task.mainKeyword) {
      try {
        const rel = await checkRelevance({
          title: d.title, text: d.excerpt,
          siteIntro: task.siteIntro, mainKeyword: task.mainKeyword,
        });
        addLog('ai', `相关性判断：${rel.related ? '相关' : '不相关'}（${rel.reason}）`, rel.related ? 'info' : 'warn', res.url);
        if (!rel.related) return this.record(task, resourceId, 'skip', `主题不相关，跳过：${rel.reason}`);
      } catch (e) {
        addLog('ai', `相关性判断失败（继续流程）：${e.message}`, 'warn', res.url);
      }
    }

    // AI 表单识别（失败时用默认 WordPress 选择器兜底）
    let form;
    try {
      form = await detectForm({ formHtml: d.forms[0].html, pageUrl: res.url });
      if (!form || !form.comment) throw new Error('未识别到评论文本框');
      addLog('ai', `表单识别成功（留链方式：${form.linkMethod || 'website_field'}）`, 'success', res.url);
    } catch (e) {
      addLog('ai', `表单识别失败，使用默认选择器兜底：${e.message}`, 'warn', res.url);
      form = {
        comment: PUBLISH_SELECTORS.comment[0],
        author: PUBLISH_SELECTORS.author[0],
        email: PUBLISH_SELECTORS.email[0],
        url: PUBLISH_SELECTORS.website[0],
        submit: PUBLISH_SELECTORS.submit[0],
        saveInfo: PUBLISH_SELECTORS.saveInfo[0],
        linkMethod: 'website_field',
      };
    }

    // AI 生成评论：正文内嵌 <a> 链接（主关键词变体锚文本，website 字段留空）
    let comment;
    try {
      comment = await generateComment(
        { url: res.url, title: d.title, text: d.excerpt },
        {
          targetUrl: task.targetUrl || st.settings.identity.website,
          siteIntro: task.siteIntro || '',
          mainKeyword: task.mainKeyword || '',
        },
      );
      addLog('ai', '评论生成完成（正文内嵌链接）', 'success', res.url);
    } catch (e) {
      return this.record(task, resourceId, 'fail', `评论生成失败：${e.message}`);
    }

    // 填表身份：昵称与邮箱由 AI 生成（失败退回设置里的静态身份）；website 留空
    let identity;
    try {
      identity = await generateIdentity({ title: d.title, text: d.excerpt });
      addLog('ai', `身份生成：${identity.name} <${identity.email}>`, 'info', res.url);
    } catch (e) {
      addLog('ai', `身份生成失败，使用设置里的默认身份：${e.message}`, 'warn', res.url);
      identity = { name: st.settings.identity.name, email: st.settings.identity.email };
    }
    identity.website = ''; // 网址字段留空，链接只通过评论正文的 <a> 传递
    const [fillRes] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (cfg) => window.__BCM_PUB__ && window.__BCM_PUB__.fill(cfg),
      args: [{ form, comment, identity, mode: task.mode, lang: st.settings.language, resourceId }],
    });
    const f = fillRes && fillRes.result;
    if (getState().publishRuntime !== rt) return;
    if (!f || !f.ok) {
      return this.record(task, resourceId, 'fail', `表单填写失败：${(f && f.error) || '未知错误'}`);
    }
    addLog('publish', `表单已填入（正文:${f.filled.comment ? '✓' : '✗'} 昵称:${f.filled.author ? '✓' : '✗'} 邮箱:${f.filled.email ? '✓' : '✗'} 网址:${f.filled.website ? '✓' : '✗'}）`, 'info', res.url);

    if (task.mode === 'auto') {
      const [subRes] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.__BCM_PUB__ && window.__BCM_PUB__.submit(),
      });
      const s = subRes && subRes.result;
      if (s && s.ok) {
        await updateResource(resourceId, { status: 'published', publishedAt: Date.now() });
        this.record(task, resourceId, 'success', '全自动已提交');
      } else {
        this.record(task, resourceId, 'fail', `提交失败：${(s && s.error) || '未知'}`);
      }
      await sleep(2000);
      return;
    }

    // 半自动：等待人工在浮层上操作
    rt.stage = 'awaiting_review';
    addLog('publish', '等待人工确认（请在网页浮层点击 Submit / Skip）', 'warn', res.url);
    await this.notify(['publishRuntime', 'logs']);
  }

  /** 浮层 Submit / Skip 回调 */
  async onDecision(resourceId, decision) {
    const st = getState();
    const rt = st.publishRuntime;
    if (!rt || rt.resourceId !== resourceId || rt.stage !== 'awaiting_review') return;
    const task = findTask(rt.taskId);
    if (!task) return;
    const tabId = rt.tabId;

    if (decision === 'submit') {
      try {
        const [subRes] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => window.__BCM_PUB__ && window.__BCM_PUB__.submit(),
        });
        const s = subRes && subRes.result;
        if (s && s.ok) {
          await updateResource(resourceId, { status: 'published', publishedAt: Date.now() });
          this.record(task, resourceId, 'success', '人工确认，已提交');
        } else {
          this.record(task, resourceId, 'fail', `提交失败：${(s && s.error) || '未知'}`);
        }
      } catch (e) {
        this.record(task, resourceId, 'fail', `提交异常：${e.message}`);
      }
    } else {
      this.record(task, resourceId, 'skip', '人工跳过');
    }

    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__BCM_PUB__ && window.__BCM_PUB__.cleanup() });
    } catch { /* tab may be gone */ }

    rt.stage = 'working';
    await this.notify(['publishRuntime', 'tasks', 'resources', 'logs']);
    this.loop();
  }

  record(task, resourceId, result, note) {
    task.results = task.results || {};
    task.results[resourceId] = result;
    const url = findResource(resourceId)?.url || '';
    const icon = result === 'success' ? '✓' : result === 'fail' ? '✗' : '⊘';
    const level = result === 'success' ? 'success' : result === 'fail' ? 'error' : 'info';
    addLog('publish', `${icon} ${note}`, level, url);
  }

  finishTask(task, status) {
    task.status = status;
    task.finishedAt = Date.now();
    const st = getState();
    if (st.publishRuntime && st.publishRuntime.taskId === task.id) {
      try { if (st.publishRuntime.tabId) chrome.tabs.remove(st.publishRuntime.tabId).catch(() => {}); } catch { /* ignore */ }
      st.publishRuntime = null;
    }
    if (st.activeTaskId === task.id) st.activeTaskId = null;
    addLog('publish', `任务「${task.name}」完成`, 'success');
    this.notify(['tasks', 'activeTaskId', 'publishRuntime', 'logs']).catch(() => {});
  }

  async stopTask(taskId) {
    const task = findTask(taskId);
    if (!task) return;
    if (task.status === 'running') {
      const st = getState();
      if (st.publishRuntime && st.publishRuntime.taskId === taskId) {
        // 若停在待审核，先清掉浮层
        try {
          if (st.publishRuntime.tabId) {
            await chrome.scripting.executeScript({ target: { tabId: st.publishRuntime.tabId }, func: () => window.__BCM_PUB__ && window.__BCM_PUB__.cleanup() });
          }
        } catch { /* ignore */ }
        try { if (st.publishRuntime.tabId) await chrome.tabs.remove(st.publishRuntime.tabId).catch(() => {}); } catch { /* ignore */ }
        st.publishRuntime = null;
      }
      task.status = 'stopped';
      addLog('publish', `任务「${task.name}」已停止`, 'warn');
    }
    await this.notify(['tasks', 'publishRuntime', 'logs']);
  }

  async deleteTask(taskId) {
    const i = getState().tasks.findIndex((t) => t.id === taskId);
    if (i < 0) return;
    const task = getState().tasks[i];
    if (task.status === 'running') await this.stopTask(taskId);
    getState().tasks.splice(i, 1);
    if (getState().activeTaskId === taskId) getState().activeTaskId = null;
    addLog('publish', `任务「${task.name}」已删除`, 'info');
    await this.notify(['tasks', 'activeTaskId', 'publishRuntime', 'logs']);
  }

  /** alarm 唤醒：检查待审核的页面是否还活着 */
  async healthCheck() {
    const st = getState();
    const rt = st.publishRuntime;
    if (!rt) return;
    const task = findTask(rt.taskId);
    if (!task || task.status !== 'running') { st.publishRuntime = null; await this.notify(['publishRuntime']); return; }
    if (rt.stage === 'awaiting_review' && rt.tabId) {
      try { await chrome.tabs.get(rt.tabId); } catch {
        this.record(task, rt.resourceId, 'fail', '待审核页面被关闭');
        st.publishRuntime = null;
        await this.notify(['publishRuntime', 'tasks', 'logs']);
        this.loop();
      }
    } else if (rt.stage !== 'awaiting_review' && !this.busy) {
      this.loop();
    }
  }
}
