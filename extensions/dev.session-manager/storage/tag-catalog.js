import { readRemoteSessionKV, writeRemoteSessionKV } from "./remote.js";
import { validateCatalog } from "../model/tag-catalog.js";

const KEY = "sessions.tagCatalog";

export async function loadTagCatalog() {
  try {
    const raw = (await readRemoteSessionKV(KEY))?.value;
    const value = raw?.value ?? raw;
    return validateCatalog(value).entries;
  } catch {
    return [];
  }
}

export async function saveTagCatalog(_dbName, entries) {
  const clean = validateCatalog(entries).entries;
  await writeRemoteSessionKV(KEY, clean);
  return clean;
}
