/**
 * IndexedDB 轻量封装：持久存储（Service Worker 中可用）。
 * 库 bcm-idb（v2）；stores：
 *  - backlinks：已发现外链，主键 [targetDomain, url]（按域名归档、同域 url 去重、覆盖写）
 *  - analysis ：分析结论 + 可用资源（含 enabled 启停标记），主键 [targetDomain, url]
 *  - published：已发过的外链 {url, targetUrl, taskId, publishedAt}，主键 [url, targetUrl]
 * v1 → v2：resources 表废弃（可用资源复用 analysis 表），其中已发布记录迁入 published 后删表
 */
const DB_NAME = 'bcm-idb';
const DB_VERSION = 2;
const STORE_META = [
  ['backlinks', ['targetDomain', 'url']],
  ['analysis', ['targetDomain', 'url']],
  ['published', ['url', 'targetUrl']],
];
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // v2 迁移：旧 resources 表中 status=published 的记录搬进 published（当时未记录目标网址，targetUrl 置空）
      if (db.objectStoreNames.contains('resources')) {
        const tx = req.transaction;
        const getReq = tx.objectStore('resources').getAll();
        getReq.onsuccess = () => {
          const pub = db.objectStoreNames.contains('published')
            ? tx.objectStore('published')
            : db.createObjectStore('published', { keyPath: ['url', 'targetUrl'] });
          for (const r of getReq.result || []) {
            if (r && r.url && r.status === 'published') {
              pub.put({ url: r.url, targetUrl: '', taskId: '', publishedAt: r.publishedAt || 0 });
            }
          }
          db.deleteObjectStore('resources');
        };
      }
      for (const [name, keyPath] of STORE_META) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function idbPutAll(store, rows) {
  if (!rows || !rows.length) return;
  const db = await open();
  await new Promise((resolve, reject) => {
    const os = db.transaction(store, 'readwrite').objectStore(store);
    for (const r of rows) os.put(r);
    os.transaction.oncomplete = resolve;
    os.transaction.onerror = () => reject(os.transaction.error || new Error('IndexedDB 写入失败'));
  });
}

export async function idbPut(store, row) {
  return idbPutAll(store, [row]);
}

/** 按主键取单条记录（复合主键传数组，如 analysis 表传 [targetDomain, url]） */
export async function idbGet(store, key) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const os = db.transaction(store, 'readonly').objectStore(store);
    const req = os.get(key);
    req.onsuccess = () => resolve(req.result || undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbDelete(store, key) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const os = db.transaction(store, 'readwrite').objectStore(store);
    const req = os.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function idbGetAll(store) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const os = db.transaction(store, 'readonly').objectStore(store);
    const req = os.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** 取某目标域名下的全部记录（主键 [domain, url] 的前缀范围查询） */
export async function idbGetDomain(store, domain) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const os = db.transaction(store, 'readonly').objectStore(store);
    const req = os.getAll(IDBKeyRange.bound([domain, ''], [domain, '\uFFFF']));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** 清空指定 store（clearAll 时用） */
export async function idbClear(store) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const os = db.transaction(store, 'readwrite').objectStore(store);
    const req = os.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

