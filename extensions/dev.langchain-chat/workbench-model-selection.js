import { createSessionModelSelection } from "./session-model-selection.js";

export function normalizeWorkbenchModel(model, catalog = []) {
  const item = catalog.find(item => model?.profileId
    ? item.runtimeProfileId === model.profileId
    : item.providerId === model?.providerId && item.id === model?.modelId);
  if (!model?.profileId && !(model?.providerId && model?.modelId)) return null;
  return {
    ...model,
    ...(item ? { providerId: item.providerId, modelId: item.id,
      label: model.label || item.label || item.id,
      ...(item.runtimeProfileId ? { profileId: item.runtimeProfileId } : {}) } : {})
  };
}

// The real Workbench session API retains the metadata comparison base and
// persists a delta, so changing a model cannot overwrite concurrent card edits.
export function installWorkbenchModelSelection({
  zion, getSessionId, loadLegacyModel, persistDefault, onError
}) {
  const normalize = model => normalizeWorkbenchModel(model, zion.state.get("models.catalog") || []);
  const selection = createSessionModelSelection({
    state: zion.state, getSessionId, loadLegacyModel, onError,
    normalizeModel: normalize,
    loadMeta: id => zion.commands.executeCommand("zion.sessions.getMetaAsync", id),
    patchMeta: (id, updater) => zion.commands.executeCommand("zion.sessions.patchMeta", { id, updater })
  });
  let defaultTail = Promise.resolve();
  const command = zion.commands.registerCommand("models.setDefaultModel", spec => {
    const work = defaultTail.catch(() => {}).then(async () => {
      const catalog = zion.state.get("models.catalog") || [];
      const item = typeof spec === "string"
        ? catalog.find(item => `${item.providerId}:${item.id}` === spec) : null;
      const model = normalize(item ? { providerId: item.providerId, modelId: item.id } : spec);
      if (!model) throw new Error("请选择有效的默认模型");
      const saved = await persistDefault(model);
      await selection.initializeDefault(normalize(saved || model));
      return zion.state.get("chat.defaultModel");
    });
    defaultTail = work;
    return work;
  });
  return {
    ...selection,
    async resolveModel(id) {
      return normalize(await selection.resolveModel(id));
    },
    dispose() { command.dispose(); selection.dispose(); }
  };
}
