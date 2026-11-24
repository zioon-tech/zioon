const DB_NAME = "zion.collaboration-recovery.v1";
export const LOCAL_DRAFT_MAX_CODE_UNITS = 32_768;
let recoveryDatabase = null;

// The legacy sessions adapter caches a single DB connection. Keep this sidecar
// connection separate so opening it cannot switch or reuse that database.
function openRecoveryDatabase() {
  if (recoveryDatabase) return recoveryDatabase;
  const opening = new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onerror = () => reject(request.error || new Error("Recovery database open failed"));
    request.onblocked = () => reject(new Error("Recovery database open blocked"));
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => {
        if (recoveryDatabase === opening) recoveryDatabase = null;
      };
      db.onversionchange = () => {
        db.close();
        if (recoveryDatabase === opening) recoveryDatabase = null;
      };
      resolve(db);
    };
  });
  recoveryDatabase = opening;
  void opening.catch(() => {
    if (recoveryDatabase === opening) recoveryDatabase = null;
  });
  return opening;
}

async function recoveryTransaction(key, operation, draft) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = await openRecoveryDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("drafts", operation === "get" ? "readonly" : "readwrite");
        const store = tx.objectStore("drafts");
        const request = operation === "set" ? store.put(draft, key)
          : operation === "delete" ? store.delete(key) : store.get(key);
        // A successful request is not yet a committed recovery copy.
        tx.oncomplete = () => resolve(operation === "get" ? request.result : undefined);
        tx.onabort = () => reject(tx.error || request.error || new Error("Recovery transaction aborted"));
        tx.onerror = () => reject(tx.error || request.error || new Error("Recovery transaction failed"));
      });
    } catch (error) {
      if (attempt || error?.name !== "InvalidStateError") throw error;
      try { db.close(); } catch {}
      recoveryDatabase = null;
    }
  }
}

// This is a recovery sidecar, not a second authoritative session database.
// Capture the newest document once per batch; a slow disk retains one active
// write and a dirty flag, rather than a queue of full document snapshots.
export function createCollaborationDraftRecovery({
  key,
  snapshot,
  onSnapshot = () => {},
  onError = () => {},
  storage = globalThis.localStorage,
  delayMs = 750,
  readTimeoutMs = 2000,
  largeStore = {
    get: key => recoveryTransaction(key, "get"),
    set: (key, value) => recoveryTransaction(key, "set", value),
    delete: key => recoveryTransaction(key, "delete"),
    // Discover committed recovery even if a full localStorage prevented the
    // small marker write. This does not create a database on ordinary startup.
    exists: async () => {
      const databases = await globalThis.indexedDB?.databases?.();
      return !!databases?.some(database => database.name === DB_NAME);
    }
  }
}) {
  const marker = `${key}:indexeddb`;
  let timer = null;
  let dirty = false;
  let active = null;
  let generation = 0;
  let disposed = false;
  let previous = null;
  let preserved = false;
  let largeWritten = false;

  const cancelTimer = () => {
    if (timer != null) globalThis.clearTimeout(timer);
    timer = null;
  };
  const readLegacy = () => {
    try { return JSON.parse(storage?.getItem(key) || "null"); } catch { return null; }
  };
  const hasLarge = () => {
    try { return storage?.getItem(marker) === "1"; } catch { return false; }
  };
  const hasLargeRecovery = async () => {
    if (largeWritten || hasLarge()) return true;
    try { return !!await largeStore.exists?.(); } catch (error) {
      onError(error);
      return false;
    }
  };
  const track = promise => {
    const operation = promise.finally(() => {
      if (active === operation) active = null;
    });
    active = operation;
    return operation;
  };
  const persist = async draft => {
    if (!storage) throw new Error("Local recovery storage is unavailable");
    // Reject large writes before serializing or calling native Storage.setItem.
    const copies = [draft, ...(draft.alternatives || [])];
    if (copies.reduce((size, copy) => size + copy.baseline.length + copy.text.length, 0)
      <= LOCAL_DRAFT_MAX_CODE_UNITS) {
      const payload = JSON.stringify(draft);
      if (payload.length <= LOCAL_DRAFT_MAX_CODE_UNITS) {
        storage.setItem(key, payload);
        if (largeWritten || hasLarge()) {
          await largeStore.delete(key);
          storage.removeItem(marker);
          largeWritten = false;
        }
        return;
      }
    }
    await largeStore.set(key, draft);
    largeWritten = true;
    // Keep the legacy recovery copy until the IDB transaction has committed.
    if (!hasLarge()) storage.setItem(marker, "1");
    storage.removeItem(key);
  };

  const flush = () => {
    cancelTimer();
    if (active) return active.then(() => dirty ? flush() : undefined);
    if (!dirty) return Promise.resolve();
    dirty = false;
    const writeGeneration = generation;
    let draft;
    try {
      draft = snapshot();
      onSnapshot(draft);
      if (draft.recoveryReason) preserved = true;
      if (previous?.baseline === draft.baseline && previous?.text === draft.text
        && previous?.recoveryReason === draft.recoveryReason
        && (previous?.alternatives || []).length === (draft.alternatives || []).length
        && (previous?.alternatives || []).every((copy, index) =>
          copy.baseline === draft.alternatives[index].baseline && copy.text === draft.alternatives[index].text)) {
        return Promise.resolve();
      }
    } catch (error) {
      onError(error);
      return Promise.resolve();
    }
    return track(persist(draft).then(() => {
      if (generation === writeGeneration) previous = draft;
    }).catch(error => onError(error)));
  };

  const schedule = () => {
    if (disposed) return;
    generation += 1;
    dirty = true;
    if (timer == null) {
      timer = globalThis.setTimeout(() => {
        timer = null;
        void flush();
      }, delayMs);
    }
  };

  const onPageHide = () => { void flush(); };
  globalThis.window?.addEventListener?.("pagehide", onPageHide);
  return {
    async load(currentText) {
      const legacy = readLegacy();
      let readTimer;
      try {
        const saved = await Promise.race([
          (async () => {
            if (!await hasLargeRecovery()) return legacy;
            const large = await largeStore.get(key);
            return typeof large?.text === "string" && (!legacy || Number(large.savedAt) >= Number(legacy.savedAt))
              ? large : legacy;
          })(),
          new Promise((_, reject) => {
            readTimer = globalThis.setTimeout(
              () => reject(new Error("Recovery database read timed out")), readTimeoutMs
            );
          })
        ]);
        if (disposed) return null;
        // A recovered draft must not be removed by acknowledgement of a newly
        // opened document before the user has chosen how to recover it.
        preserved = !!saved?.recoveryReason || !!saved?.text && saved.text !== currentText;
        return saved;
      } catch (error) {
        // A stuck local recovery database must not block the cloud editor or
        // permit acknowledgement to discard an unread recovery copy.
        preserved = true;
        onError(error);
        return legacy;
      } finally { globalThis.clearTimeout(readTimer); }
    },
    schedule,
    flush,
    clear() {
      if (preserved) return Promise.resolve(false);
      const clearGeneration = ++generation;
      dirty = false;
      cancelTimer();
      return track((active || Promise.resolve()).then(async () => {
        if (generation !== clearGeneration) return false;
        if (await hasLargeRecovery()) await largeStore.delete(key);
        if (generation !== clearGeneration) return false;
        storage?.removeItem(marker);
        storage?.removeItem(key);
        previous = null;
        largeWritten = false;
        return true;
      }).catch(error => { onError(error); return false; }));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      globalThis.window?.removeEventListener?.("pagehide", onPageHide);
      void flush();
    }
  };
}
