import { idbGetKV, idbSetKV } from "./idb.js";
import {
  createSessionTagIndex,
  validateSessionTagIndex
} from "../model/session-tag-index.js";

const KEY = "sessions.tagIndex";

export async function loadSessionTagIndex(dbName) {
  try {
    const value = await idbGetKV(dbName, KEY);
    return validateSessionTagIndex(value);
  } catch {
    return createSessionTagIndex();
  }
}

export async function saveSessionTagIndex(dbName, index) {
  const clean = validateSessionTagIndex(index);
  await idbSetKV(dbName, KEY, clean);
  return clean;
}
