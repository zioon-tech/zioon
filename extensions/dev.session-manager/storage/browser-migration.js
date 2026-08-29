import {
  idbClear,
  idbDelKV,
  idbGetAll,
  idbGetKV,
  openSessionsDB
} from "./idb.js";

const SESSION_KV_KEYS = [
  "tree",
  "index",
  "sessions.tagCatalog",
  "tagCatalog.v1",
  "sessions.tagIndex"
];

function safeParse(raw, fallback) {
  try {
    return JSON.parse(String(raw || ""));
  } catch {
    return fallback;
  }
}

async function fingerprint(value) {
  const input = JSON.stringify(value);
  try {
    const bytes = new globalThis.TextEncoder().encode(input);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    const hash = Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    return `idb-v2-${hash}`;
  } catch {}
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return `idb-v1-${(hash >>> 0).toString(16)}-${input.length}`;
}

function collectLegacyLocalStorage() {
  const docs = [];
  const metas = [];
  let tree = null;
  let index = [];
  try {
    tree = safeParse(localStorage.getItem("zion.sessions.tree"), null);
    index = safeParse(localStorage.getItem("zion.sessions.index"), []);
    for (let offset = 0; offset < localStorage.length; offset += 1) {
      const key = localStorage.key(offset);
      const match = /^zion\.session\.(.+)\.(doc|meta)$/.exec(String(key || ""));
      if (!match) continue;
      const id = match[1];
      if (match[2] === "doc") {
        docs.push({ id, text: localStorage.getItem(key) || "" });
      } else {
        metas.push({
          id,
          meta: safeParse(localStorage.getItem(key), { id })
        });
      }
    }
  } catch {}
  return {
    docs,
    metas,
    tree: tree?.type === "folder" ? tree : null,
    index: Array.isArray(index) ? index : []
  };
}

function mergeById(primary, fallback, valueKey) {
  const merged = new Map();
  for (const item of fallback) {
    if (item?.id) merged.set(String(item.id), item);
  }
  for (const item of primary) {
    if (item?.id) merged.set(String(item.id), item);
  }
  return Array.from(merged.values()).map((item) => (
    valueKey === "text"
      ? { id: String(item.id), text: String(item.text || "") }
      : { id: String(item.id), meta: item.meta || { id: String(item.id) } }
  ));
}

export async function readBrowserSessionCandidate(dbName) {
  const legacy = collectLegacyLocalStorage();
  try {
    await openSessionsDB(dbName);
    const [docs, metas, tree, index, ...kvValues] = await Promise.all([
      idbGetAll(dbName, "docs"),
      idbGetAll(dbName, "metas"),
      idbGetKV(dbName, "tree"),
      idbGetKV(dbName, "index"),
      ...SESSION_KV_KEYS.slice(2).map((key) => idbGetKV(dbName, key))
    ]);
    const kv = {};
    SESSION_KV_KEYS.slice(2).forEach((key, offset) => {
      if (kvValues[offset] !== undefined) kv[key] = kvValues[offset];
    });
    const snapshot = {
      docs: mergeById(docs, legacy.docs, "text"),
      metas: mergeById(metas, legacy.metas, "meta"),
      tree: tree?.type === "folder" ? tree : legacy.tree,
      index: Array.isArray(index) ? index : legacy.index,
      kv
    };
    return {
      available: true,
      sourceId: `${globalThis.location?.origin || "unknown-origin"}:${dbName}`,
      fingerprint: await fingerprint(snapshot),
      snapshot,
      candidates: new Set([
        ...snapshot.docs.map((item) => item.id),
        ...snapshot.metas.map((item) => item.id)
      ]).size
    };
  } catch (error) {
    const snapshot = {
      docs: legacy.docs,
      metas: legacy.metas,
      tree: legacy.tree,
      index: legacy.index,
      kv: {}
    };
    return {
      available: false,
      error,
      sourceId: `${globalThis.location?.origin || "unknown-origin"}:${dbName}`,
      fingerprint: await fingerprint(snapshot),
      snapshot,
      candidates: new Set([
        ...legacy.docs.map((item) => item.id),
        ...legacy.metas.map((item) => item.id)
      ]).size
    };
  }
}

export async function clearMigratedBrowserSessions(dbName) {
  const cleanupResults = await Promise.allSettled([
    idbClear(dbName, "docs"),
    idbClear(dbName, "metas"),
    ...SESSION_KV_KEYS.map((key) => idbDelKV(dbName, key))
  ]);
  try {
    const keys = [];
    for (let offset = 0; offset < localStorage.length; offset += 1) {
      const key = localStorage.key(offset);
      if (
        key === "zion.sessions.tree"
        || key === "zion.sessions.index"
        || /^zion\.session\..+\.(doc|meta)$/.test(String(key || ""))
      ) {
        keys.push(key);
      }
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {}
  const failures = cleanupResults.filter((result) => result.status === "rejected");
  if (failures.length) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      "legacy IndexedDB session cleanup incomplete"
    );
  }
  return true;
}
