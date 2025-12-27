/**
 * Zion LangChain Chat Plugin - User Models Provider
 * Dynamic model provider backed by localStorage
 */

const DYN_KEY = "zion.models.dynamic";

function loadStore() {
  try {
    const raw = localStorage.getItem(DYN_KEY);
    if (!raw) return {};
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

export const userModelsProvider = {
  id: "user.dynamic",
  async list() {
    const dict = loadStore();
    return Object.keys(dict).map(id => ({ id, label: dict[id]?.label || id }));
  },
  async resolve(modelId: string) {
    const dict = loadStore();
    const cfg = dict[modelId];
    if (!cfg) return null;
    return { id: modelId, ...cfg };
  }
};
