/**
 * Paste Image Extension (Option C)
 *
 * Behavior:
 * - For local File/Blob images or data: URLs found in clipboard/html, read as DataURL,
 *   persist into IndexedDB and insert a short internal link: ![](app://img/<id>)
 * - For remote image URLs (http/https) or remote <img src="...">, insert the original src.
 *
 * Storage:
 * - IndexedDB DB: "dev.paste-image-db", store: "images", records: { id, dataUrl, createdAt }
 *
 * Notes:
 * - This is a local in-browser cache. The short link scheme "app://img/<id>" is an
 *   application-local identifier — you will need a runtime loader to resolve and render
 *   these links when displaying content. This keeps pasted documents lightweight.
 */

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = (e) => reject(e);
    fr.readAsDataURL(file);
  });
}

function openDB() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open('dev.paste-image-db', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('images')) {
          db.createObjectStore('images', { keyPath: 'id' });
        }
      };
      req.onsuccess = (e) => {
        resolve(e.target.result);
      };
      req.onerror = (e) => {
        reject(e.target.error);
      };
    } catch (err) {
      reject(err);
    }
  });
}

function genId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    }
  } catch (_) {}
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

async function saveDataUrlToDB(dataUrl) {
  const db = await openDB();
  const id = genId();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('images', 'readwrite');
      const store = tx.objectStore('images');
      store.put({ id, dataUrl, createdAt: Date.now() });
      tx.oncomplete = () => {
        try { db.close(); } catch (_) {}
        resolve(id);
      };
      tx.onerror = (e) => {
        try { db.close(); } catch (_) {}
        reject(e.target && e.target.error ? e.target.error : new Error('TX error'));
      };
    } catch (err) {
      try { db.close(); } catch (_) {}
      reject(err);
    }
  });
}

function makeAppLink(id) {
  return `app://img/${id}`;
}

export async function activate(ctx) {
  // ensure subscriptions array exists
  ctx.subscriptions = ctx.subscriptions || [];

  const handler = {
    id: 'dev.paste-image.handler',
    priority: 100,
    async handle({ clipboardData, editor }) {
      if (!clipboardData || !editor) return false;

      // Helper: insertDataUrlWithCache -> saves to IDB and inserts short link.
      const insertCached = async (dataUrl) => {
        try {
          const id = await saveDataUrlToDB(dataUrl);
          editor.replaceSelection(`![](${makeAppLink(id)})`);
          return true;
        } catch (e) {
          console.error('[dev.paste-image] save to IDB failed, falling back to inline data URL', e);
          // fallback: insert raw data URL (may be large)
          try {
            editor.replaceSelection(`![](${dataUrl})`);
            return true;
          } catch (e2) {
            console.error('[dev.paste-image] fallback insert failed', e2);
            return false;
          }
        }
      };

      // 1) Check clipboardData.files (standard)
      const files = clipboardData.files;
      if (files && files.length) {
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          if (f && f.type && f.type.startsWith('image/')) {
            try {
              const dataUrl = await readAsDataURL(f);
              // save to IDB and insert short link
              return await insertCached(dataUrl);
            } catch (e) {
              console.error('[dev.paste-image] read file failed', e);
            }
          }
        }
      }

      // 2) Check clipboardData.items (some browsers expose items with kind=file)
      const items = clipboardData.items || [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        try {
          if (it && it.kind === 'file' && it.type && it.type.startsWith('image/')) {
            const file = it.getAsFile && it.getAsFile();
            if (file) {
              const dataUrl = await readAsDataURL(file);
              return await insertCached(dataUrl);
            }
          }
        } catch (e) {
          // continue
        }
      }

      // 3) Check HTML payload for <img src="...">
      try {
        const html = clipboardData.getData && clipboardData.getData('text/html');
        if (html) {
          const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
          if (m && m[1]) {
            const src = m[1];
            // If src is data:, cache it, else insert original src
            if (src.startsWith('data:')) {
              return await insertCached(src);
            } else {
              editor.replaceSelection(`![](${src})`);
              return true;
            }
          }
        }
      } catch (e) {
        // ignore
      }

      // 4) Check plain text for image URL or raw data URL
      try {
        const text = (clipboardData.getData && clipboardData.getData('text/plain')) || '';
        const t = text.trim();
        if (!t) return false;
        // data: URL
        if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(t)) {
          return await insertCached(t);
        }
        // remote image URL
        if (/^https?:\/\/\S+\.(png|jpe?g|gif|webp|bmp)(\?.*)?$/i.test(t)) {
          editor.replaceSelection(`![](${t})`);
          return true;
        }
      } catch (e) {
        // ignore
      }

      // not handled
      return false;
    }
  };

  const disp = window.zion?.editor?.registerPasteHandler
    ? window.zion.editor.registerPasteHandler(handler)
    : { dispose: () => {} };

  ctx.subscriptions.push(disp);
}

export function deactivate(ctx) {
  // optional cleanup if host calls deactivate with ctx
  if (ctx && Array.isArray(ctx.subscriptions)) {
    for (const d of ctx.subscriptions) {
      try { d && typeof d.dispose === 'function' && d.dispose(); } catch (_) {}
    }
  }
}