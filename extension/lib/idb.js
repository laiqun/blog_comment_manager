/**
 * IndexedDB 轻量封装：持久存储（Service Worker 中可用）。
 * 库 bcm-idb；stores：
 *  - backlinks：已发现外链，主键 [targetDomain, url]（按域名归档、同域 url 去重、覆盖写）
 *  - analysis ：分析结论 {status, reason, checkedAt}，主键 [targetDomain, url]
 *  - resources：资源库（博客评论资源），主键 url
 */
const DB_NAME = 'bcm-idb';
const STORE_META = [
  ['backlinks', ['targetDomain', 'url']],
  ['analysis', ['targetDomain', 'url']],
  ['resources', ['url']],
];
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
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

