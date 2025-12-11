const APP_IMG_PREFIX = "app://img/";
const appImageCache = new Map();

/** Open IndexedDB used by dev.paste-image to store images */
function openDB() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open("dev.paste-image-db", 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("images")) {
          db.createObjectStore("images", { keyPath: "id" });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    } catch (err) {
      reject(err);
    }
  });
}

/** Read DataURL by image id */
export async function getDataUrlById(id) {
  if (!id) return null;
  if (appImageCache.has(id)) return appImageCache.get(id);
  const db = await openDB();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction("images", "readonly");
      const store = tx.objectStore("images");
      const req = store.get(id);
      req.onsuccess = (e) => {
        try { db.close(); } catch {}
        const rec = e.target.result;
        const url = rec?.dataUrl || null;
        if (url) appImageCache.set(id, url);
        resolve(url);
      };
      req.onerror = () => {
        try { db.close(); } catch {}
        resolve(null);
      };
    } catch {
      try { db.close(); } catch {}
      resolve(null);
    }
  });
}

/** Resolve app://img/<id> to DataURL; return null if not found */
export async function resolveAppImage(src) {
  if (!src || typeof src !== "string") return null;
  if (!src.startsWith(APP_IMG_PREFIX)) return null;
  const id = src.slice(APP_IMG_PREFIX.length);
  try {
    const url = await getDataUrlById(id);
    return url || null;
  } catch {
    return null;
  }
}