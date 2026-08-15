// Catalog persistence on top of the existing Sessions IndexedDB kv store.
import { idbGetKV, idbSetKV } from "./idb.js";
import { validateCatalog } from "../model/tag-catalog.js";

const KEY = "sessions.tagCatalog";

export async function loadTagCatalog(dbName) {
  try {
    const raw = await idbGetKV(dbName, KEY);
    const value = raw?.value ?? raw;
    return validateCatalog(value).entries;
  } catch {
    return [];
  }
}

export async function saveTagCatalog(dbName, entries) {
  const clean = validateCatalog(entries).entries;
  await idbSetKV(dbName, KEY, clean);
  return clean;
}
