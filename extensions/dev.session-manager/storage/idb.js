let __dbPromise = null;
let __dbCurrent = null;
let __dbName = null;
let __dbVersion = 1;

function invalidateDB(db) {
  // Only drop the cache if it still points at the connection that failed,
  // so a concurrent reopen isn't clobbered.
  if (!db) {
    __dbPromise = null;
    return;
  }
  if (__dbCurrent === db) {
    __dbPromise = null;
    __dbCurrent = null;
  }
}

export function openSessionsDB(dbName, version = 1) {
  __dbName = dbName;
  __dbVersion = version;
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
      req.onsuccess = (e) => {
        const db = e.target.result;
        __dbCurrent = db;
        // The browser can close idle IDB connections (background/sleep tabs) or
        // ask us to close on a version change from another tab. When that
        // happens the cached connection starts throwing "database connection is
        // closing"; drop the cache so the next call reopens a fresh connection.
        try {
          db.onclose = () => invalidateDB(db);
          db.onversionchange = () => {
            try { db.close(); } catch {}
            invalidateDB(db);
          };
        } catch {}
        resolve(db);
      };
      req.onerror = (e) => {
        __dbPromise = null;
        reject(e.target.error || new Error("idb open error"));
      };
      req.onblocked = () => {
        __dbPromise = null;
        reject(new Error("idb open blocked"));
      };
    } catch (err) {
      __dbPromise = null;
      reject(err);
    }
  });
  // If opening fails, make sure we don't cache a rejected promise forever.
  __dbPromise.catch(() => { __dbPromise = null; });
  return __dbPromise;
}

function isConnectionClosingError(err) {
  const name = err?.name || "";
  const msg = String(err?.message || err || "");
  return name === "InvalidStateError" || /connection is closing|database connection is closing/i.test(msg);
}

// Run a transaction, reopening a fresh connection once if the cached one is
// closing. `run(db)` must start the transaction synchronously and return a
// promise that settles on completion.
async function runTx(dbName, run) {
  let db = await openSessionsDB(dbName || __dbName, __dbVersion);
  try {
    return await run(db);
  } catch (err) {
    if (!isConnectionClosingError(err)) throw err;
    invalidateDB(db);
    db = await openSessionsDB(dbName || __dbName, __dbVersion);
    return await run(db);
  }
}

export async function idbGet(dbName, store, key) {
  return runTx(dbName, (db) => new Promise((resolve, reject) => {
    // transaction() can throw synchronously on a closing connection.
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
  }));
}

export async function idbGetAll(dbName, store) {
  return runTx(dbName, (db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
    req.onerror = () => reject(req.error);
  }));
}

export async function idbSet(dbName, store, record) {
  return runTx(dbName, (db) => new Promise((resolve, reject) => {
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
  }));
}

export async function idbDel(dbName, store, key) {
  return runTx(dbName, (db) => new Promise((resolve, reject) => {
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
  }));
}

export async function idbClear(dbName, store) {
  return runTx(dbName, (db) => new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).clear();
    req.onerror = () => settle(reject, req.error || tx.error || new Error("idb clear error"));
    tx.oncomplete = () => settle(resolve, true);
    tx.onabort = () => settle(reject, tx.error || req.error || new Error("idb transaction aborted"));
    tx.onerror = () => settle(reject, tx.error || req.error || new Error("idb transaction error"));
  }));
}

export const idbGetKV = (dbName, key) => idbGet(dbName, "kv", key);
export const idbSetKV = (dbName, key, value) => idbSet(dbName, "kv", { key, value });
export const idbDelKV = (dbName, key) => idbDel(dbName, "kv", key);
