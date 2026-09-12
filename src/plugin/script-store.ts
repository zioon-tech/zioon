import type { PluginEntries, PluginInfo } from './types';

const DB_NAME = 'zion.plugins.db';
const DB_VERSION = 1;
const STORE_NAME = 'scriptSources';

export interface StoredPluginScriptContents {
  key: string;
  pluginId: string;
  version: string;
  sourceEntries: PluginEntries;
  scriptContents: Record<string, string>;
  byteSize: number;
  updatedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function getIndexedDB(): IDBFactory | null {
  try {
    return typeof indexedDB !== 'undefined' ? indexedDB : null;
  } catch {
    return null;
  }
}

function openPluginScriptDB(): Promise<IDBDatabase | null> {
  const idb = getIndexedDB();
  if (!idb) return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = idb.open(DB_NAME, DB_VERSION);
    } catch (error) {
      dbPromise = null;
      reject(error);
      return;
    }

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      try {
        db.onversionchange = () => {
          try { db.close(); } catch {}
          dbPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
        };
      } catch {}
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('plugin script IndexedDB open failed'));
    };
    request.onblocked = () => {
      dbPromise = null;
      reject(new Error('plugin script IndexedDB open blocked'));
    };
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('plugin script transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('plugin script transaction failed'));
  });
}

export function estimatePluginScriptBytes(
  scriptContents: Record<string, string> | null | undefined
): number {
  let total = 0;
  for (const [path, source] of Object.entries(scriptContents || {})) {
    total += path.length + source.length;
  }
  return total;
}

export function createPluginScriptStorageKey(pluginInfo: Pick<PluginInfo, 'id' | 'version'>): string {
  return `${pluginInfo.id}@${pluginInfo.version}`;
}

export async function savePluginScriptContents({
  key,
  pluginId,
  version,
  sourceEntries,
  scriptContents
}: {
  key: string;
  pluginId: string;
  version: string;
  sourceEntries: PluginEntries;
  scriptContents: Record<string, string>;
}): Promise<StoredPluginScriptContents | null> {
  const db = await openPluginScriptDB();
  if (!db) return null;

  const record: StoredPluginScriptContents = {
    key,
    pluginId,
    version,
    sourceEntries,
    scriptContents,
    byteSize: estimatePluginScriptBytes(scriptContents),
    updatedAt: Date.now()
  };
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(record);
  await txDone(tx);
  return record;
}

export async function loadPluginScriptContents(
  key: string
): Promise<StoredPluginScriptContents | null> {
  const db = await openPluginScriptDB();
  if (!db) return null;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => {
      const record = request.result as StoredPluginScriptContents | undefined;
      resolve(record && typeof record === 'object' ? record : null);
    };
    request.onerror = () => reject(request.error || tx.error || new Error('plugin script get failed'));
    tx.onabort = () => reject(tx.error || request.error || new Error('plugin script transaction aborted'));
    tx.onerror = () => reject(tx.error || request.error || new Error('plugin script transaction failed'));
  });
}

export async function deletePluginScriptContents(key: string | null | undefined): Promise<void> {
  if (!key) return;
  const db = await openPluginScriptDB();
  if (!db) return;

  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).delete(key);
  await txDone(tx);
}
