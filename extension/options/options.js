/**
 * 设置页：读写 chrome.storage.local 的 bcm_store.settings，改动即保存。
 */
import { DEFAULT_SETTINGS } from '../lib/config.js';
import { setLanguage, t, applyI18n } from '../lib/i18n.js';

const STORAGE_KEY = 'bcm_store';
const $ = (sel) => document.querySelector(sel);

let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
let saveTimer = null;

function readStore() {
  return chrome.storage.local.get(STORAGE_KEY).then((data) => data[STORAGE_KEY] || {});
}

/**
 * 保存统一走后台 setSettings 消息（后台内存态是唯一数据源）。
 * 若在本页直接写 chrome.storage，会被后台随后的整包 save 用旧 settings 覆盖，导致参数保存不住。
 */
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const flash = $('#saved-flash');
    try {
      await chrome.runtime.sendMessage({
        type: 'setSettings',
        patch: {
          openrouterKey: settings.openrouterKey,
          models: settings.models,
          identity: settings.identity,
          language: settings.language,
          summaryLang: settings.summaryLang,
          aiTimeoutMs: settings.aiTimeoutMs,
        },
      });
      flash.classList.add('show');
      setTimeout(() => flash.classList.remove('show'), 1200);
    } catch (e) {
      flash.textContent = e.message;
      flash.classList.add('show', 'err');
      setTimeout(() => { flash.classList.remove('show', 'err'); flash.textContent = '已保存'; }, 2500);
    }
  }, 500);
}

function bindField(sel, get, set) {
  const el = $(sel);
  el.value = get();
  el.addEventListener('input', () => { set(el.value); saveSettings(); });
  el.addEventListener('change', () => { set(el.value); saveSettings(); });
}

async function init() {
  const store = await readStore();
  settings = {
    ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    ...(store.settings || {}),
    models: { ...DEFAULT_SETTINGS.models, ...(store.settings?.models || {}) },
    identity: { ...DEFAULT_SETTINGS.identity, ...(store.settings?.identity || {}) },
  };

  setLanguage(settings.language);
  $('#lang-select').value = settings.language;
  applyI18n();

  // API Key
  bindField('#api-key', () => settings.openrouterKey, (v) => (settings.openrouterKey = v.trim()));
  $('#btn-test').addEventListener('click', async () => {
    const key = $('#api-key').value.trim();
    const out = $('#test-result');
    if (!key) { out.textContent = t('testFail'); out.className = 'hint err'; return; }
    out.textContent = '...';
    out.className = 'hint';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'testKey', key });
      if (res && res.ok) {
        const extra = res.limit != null ? ` (usage ${res.usage ?? '-'}/${res.limit})` : res.usage != null ? ` (used $${res.usage})` : '';
        out.textContent = t('testOk') + extra;
        out.className = 'hint ok';
      } else {
        out.textContent = `${t('testFail')} ${res?.error || ''}`;
        out.className = 'hint err';
      }
    } catch (e) {
      out.textContent = `${t('testFail')} ${e.message}`;
      out.className = 'hint err';
    }
  });

  // 四个模型
  bindField('#model-discover', () => settings.models.discover, (v) => (settings.models.discover = v.trim()));
  bindField('#model-classify', () => settings.models.classify, (v) => (settings.models.classify = v.trim()));
  bindField('#model-formdetect', () => settings.models.formDetect, (v) => (settings.models.formDetect = v.trim()));
  bindField('#model-commentgen', () => settings.models.commentGen, (v) => (settings.models.commentGen = v.trim()));

  // 发布身份
  bindField('#id-name', () => settings.identity.name, (v) => (settings.identity.name = v));
  bindField('#id-email', () => settings.identity.email, (v) => (settings.identity.email = v));
  bindField('#id-website', () => settings.identity.website, (v) => (settings.identity.website = v.trim()));

  // 语言 / 摘要语言 / AI 超时
  $('#summary-lang').value = settings.summaryLang || 'zh';
  $('#summary-lang').addEventListener('change', (e) => { settings.summaryLang = e.target.value; saveSettings(); });

  // AI 请求超时：界面填秒，存储为毫秒
  const timeoutEl = $('#ai-timeout');
  timeoutEl.value = Math.round((settings.aiTimeoutMs || 20000) / 1000);
  timeoutEl.addEventListener('change', () => {
    settings.aiTimeoutMs = Math.round(Number(timeoutEl.value) || 20) * 1000;
    saveSettings();
  });

  $('#lang-select').addEventListener('change', (e) => {
    settings.language = e.target.value;
    setLanguage(settings.language);
    applyI18n();
    saveSettings(); // setSettings 已包含 language，无需重复发消息
  });
}

init();
