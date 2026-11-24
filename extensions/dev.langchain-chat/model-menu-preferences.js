import { workbenchStorage } from "../../src/runtime/workbench-space";

export const MENU_PREFERENCES_EVENT = "zion:menu-preferences-changed";
const KEY = "zion.menuUsageStats";
const safePart = value => encodeURIComponent(String(value)).replace(/%/g, "_");
// Preserve existing context-menu preferences across the scope correction.
export const modelMenuKey = model =>
  `editor/context:models.openSwitcher:models.setDefaultModel.${safePart(model.providerId)}.${safePart(model.id)}`;
export function readModelMenuPreferences(storage = workbenchStorage) {
  try {
    const value = JSON.parse(storage.getItem(KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
export function sortPinnedModels(models, preferences = readModelMenuPreferences()) {
  return models.map((model, index) => ({ model, index, preference: preferences[modelMenuKey(model)] || {} }))
    .sort((a, b) => Number(b.preference.pinned === true) - Number(a.preference.pinned === true)
      || (a.preference.pinned && b.preference.pinned
        ? (a.preference.customOrder ?? 50) - (b.preference.customOrder ?? 50) : 0)
      || a.index - b.index)
    .map(item => item.model);
}
export function toggleModelPin(model, storage = workbenchStorage, target = globalThis.window) {
  const preferences = readModelMenuPreferences(storage);
  const key = modelMenuKey(model);
  const previous = preferences[key] || { clickCount: 0, lastClickTime: 0 };
  const pinned = !previous.pinned;
  const order = Math.max(-1, ...Object.values(preferences).filter(item => item?.pinned)
    .map(item => Number(item.customOrder) || 0)) + 10;
  preferences[key] = { ...previous, pinned, ...(pinned ? { customOrder: order } : {}) };
  storage.setItem(KEY, JSON.stringify(preferences));
  target?.dispatchEvent(new CustomEvent(MENU_PREFERENCES_EVENT));
  return pinned;
}
