/**
 * user.dynamic provider ( backed by localStorage )
 *
 * Purpose:
 * - 不再在代码中写死 models.json；模型由用户通过 UI/对话（modelsManage 工具）配置并保存到 localStorage。
 * - 使用与 models-tools 中相同的 key（zion.models.dynamic），以保证两者一致。
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
  async resolve(modelId) {
    const dict = loadStore();
    const cfg = dict[modelId];
    if (!cfg) return null;
    return { id: modelId, ...cfg };
  }
};