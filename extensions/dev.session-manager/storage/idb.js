let __dbPromise = null;

export function openSessionsDB(dbName, version = 1) {
  if (__dbPromise) return __dbPromise;
  __dbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(dbName, version);
      req.onupgradeneeded = (e) => {
        try {
          const db = e.target.result;
          if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "id" });
          if (!db.objectStoreNames.contains("metas")) db.createObjectStore("metas", { keyPath: "id" });
          if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "key" });
        } catch (err) {
          console.error("[sessions] idb upgrade error:", err);
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error || new Error("idb open error"));
    } catch (err) {
      reject(err);
    }
  });
  return __dbPromise;
}

export async function idbGet(dbName, store, key) {
  const db = await openSessionsDB(dbName);
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(store, "readonly");
      const st = tx.objectStore(store);
      const req = st.get(key);
      req.onsuccess = () => {
        const v = req.result;
        if (!v) return resolve(undefined);
        if (store === "docs" || store === "metas") resolve(v);
        else resolve(v?.value);
      };
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

export async function idbSet(dbName, store, record) {
  const db = await openSessionsDB(dbName);
  return new Promise((resolve, reject) => {
    try {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      const tx = db.transaction(store, "readwrite");
      const st = tx.objectStore(store);
      const req = st.put(record);
      req.onerror = () => settle(reject, req.error || tx.error || new Error("idb put error"));
      tx.oncomplete = () => settle(resolve, true);
      tx.onabort = () => settle(reject, tx.error || req.error || new Error("idb transaction aborted"));
      tx.onerror = () => settle(reject, tx.error || req.error || new Error("idb transaction error"));
    } catch (e) {
      reject(e);
    }
  });
}

export async function idbDel(dbName, store, key) {
  const db = await openSessionsDB(dbName);
  return new Promise((resolve, reject) => {
    try {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      const tx = db.transaction(store, "readwrite");
      const st = tx.objectStore(store);
      const req = st.delete(key);
      req.onerror = () => settle(reject, req.error || tx.error || new Error("idb delete error"));
      tx.oncomplete = () => settle(resolve, true);
      tx.onabort = () => settle(reject, tx.error || req.error || new Error("idb transaction aborted"));
      tx.onerror = () => settle(reject, tx.error || req.error || new Error("idb transaction error"));
    } catch (e) {
      reject(e);
    }
  });
}

export const idbGetKV = (dbName, key) => idbGet(dbName, "kv", key);
export const idbSetKV = (dbName, key, value) => idbSet(dbName, "kv", { key, value });
export const idbDelKV = (dbName, key) => idbDel(dbName, "kv", key);
