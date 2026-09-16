/**
 * 内存版 IndexedDB 最小桩：只为让 idb.js 的逻辑能在 Node 里跑，非浏览器模拟。
 * 支持 idb.js 用到的 put / getAll(范围) / delete / clear，复合主键按数组字典序比较。
 */
export function installIdbStub() {
  const keyOf = (k) => (Array.isArray(k) ? JSON.stringify(k) : String(k));
  const cmp = (a, b) => {
    const aa = Array.isArray(a) ? a : [a];
    const bb = Array.isArray(b) ? b : [b];
    for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
      if (aa[i] === undefined) return -1;
      if (bb[i] === undefined) return 1;
      if (aa[i] < bb[i]) return -1;
      if (aa[i] > bb[i]) return 1;
    }
    return 0;
  };
  const stores = new Map(); // name -> { keyPath, rows: Map(keyJSON -> {key, value}) }
  const mkStore = (name) => {
    const meta = stores.get(name);
    const req = () => {
      const r = {};
      queueMicrotask(() => r.onsuccess && r.onsuccess());
      return r;
    };
    return {
      transaction: { set oncomplete(fn) { queueMicrotask(() => fn && fn()); }, onerror: null },
      put(row) {
        const key = Array.isArray(meta.keyPath)
          ? meta.keyPath.map((p) => row[p])
          : row[meta.keyPath];
        meta.rows.set(keyOf(key), { key, value: row });
        return req();
      },
      delete(key) { meta.rows.delete(keyOf(key)); return req(); },
      clear() { meta.rows.clear(); return req(); },
      getAll(range) {
        const r = {};
        queueMicrotask(() => {
          let rows = [...meta.rows.values()];
          if (range) {
            rows = rows.filter(({ key }) =>
              cmp(key, range.lower) >= 0 && cmp(key, range.upper) <= 0);
          }
          r.result = rows.map((x) => x.value);
          r.onsuccess && r.onsuccess();
        });
        return r;
      },
    };
  };
  const db = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore: (name, opts) => { stores.set(name, { keyPath: opts.keyPath, rows: new Map() }); },
    transaction: (name) => ({ objectStore: () => mkStore(name) }),
  };
  globalThis.indexedDB = {
    open() {
      const r = {};
      queueMicrotask(() => {
        r.result = db;
        r.onupgradeneeded && r.onupgradeneeded();
        r.onsuccess && r.onsuccess();
      });
      return r;
    },
  };
  globalThis.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
}
