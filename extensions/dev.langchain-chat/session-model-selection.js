const valid = model => !!(model?.profileId || (model?.providerId && model?.modelId));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// chat.activeModel is only the visible session's projection. Persistent defaults
// and each session's saved model have separate write paths.
export function createSessionModelSelection({
  state, getSessionId, loadMeta, patchMeta, loadLegacyModel = async () => null,
  onError = () => {}, normalizeModel = model => model
}) {
  let applying = false;
  let ready = false;
  let disposed = false;
  let generation = 0;
  let metadataListener = null;
  const pending = new Map();
  const tails = new Map();
  const currentModel = id => pending.get(id)
    || state.get(`sessions.meta.${id}`)?.model
    || state.get(`sessions.summary.${id}`)?.model;
  const project = model => {
    model = normalizeModel(model);
    if (!valid(model) || same(state.get("chat.activeModel"), model)) return;
    applying = true;
    try { state.set("chat.activeModel", { ...model }); }
    finally { applying = false; }
  };
  const save = (id, model, onlyIfAbsent = false) => {
    const work = (tails.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      const meta = await patchMeta(id, current => ({
        ...current,
        model: onlyIfAbsent && valid(current.model) ? current.model : model
      }));
      if (!meta || meta === false) throw new Error("会话模型保存失败");
      if (pending.get(id) === model) pending.delete(id);
      if (!disposed && getSessionId() === id && !pending.has(id)) project(meta.model);
      return meta.model;
    });
    tails.set(id, work);
    void work.catch(error => onError(error, id)).finally(() => {
      if (tails.get(id) === work) tails.delete(id);
    });
    return work;
  };
  const refresh = async () => {
    const seq = ++generation;
    metadataListener?.dispose?.();
    metadataListener = null;
    const id = getSessionId();
    if (!ready || disposed) return;
    if (!id) { project(state.get("chat.defaultModel")); return; }
    project(currentModel(id) || state.get("chat.defaultModel"));
    metadataListener = state.onDidChange(`sessions.meta.${id}`, () => {
      if (getSessionId() === id && !pending.has(id)) project(currentModel(id));
    });
    try {
      const meta = await loadMeta(id);
      if (disposed || seq !== generation || getSessionId() !== id || pending.has(id)) return;
      const model = valid(meta?.model) ? meta.model : await loadLegacyModel(id);
      if (disposed || seq !== generation || getSessionId() !== id || pending.has(id)) return;
      const selected = valid(model) ? model : state.get("chat.defaultModel");
      project(selected);
      if (!valid(meta?.model) && valid(selected)) await save(id, selected, true);
    } catch (error) { if (!disposed) onError(error, id); }
  };
  const activeListener = state.onDidChange("chat.activeModel", model => {
    if (applying || disposed || !valid(model)) return;
    const id = getSessionId();
    if (!id) return;
    const selected = { ...model };
    pending.set(id, selected);
    void save(id, selected);
  });
  const sessionListener = state.onDidChange("sessions.currentId", () => { void refresh(); });
  const panelListener = state.onDidChange("editors.activePanelId", () => { void refresh(); });
  return {
    initializeDefault(model) {
      if (valid(model)) state.set("chat.defaultModel", { ...model });
      ready = true;
      return refresh();
    },
    getModel(id) { return currentModel(id) || state.get("chat.defaultModel"); },
    async resolveModel(id) {
      await tails.get(id);
      const meta = await loadMeta(id);
      if (pending.has(id)) return save(id, pending.get(id));
      if (valid(meta?.model)) return meta.model;
      const legacy = await loadLegacyModel(id);
      if (pending.has(id)) return save(id, pending.get(id));
      // A concurrent metadata hydration may have published a newer choice.
      const selected = currentModel(id) || legacy || state.get("chat.defaultModel");
      if (!valid(selected)) throw new Error("会话尚未选择模型");
      return save(id, selected, true);
    },
    refresh,
    async flush(id) { await tails.get(id); },
    dispose() {
      disposed = true;
      ++generation;
      activeListener.dispose();
      sessionListener.dispose();
      panelListener.dispose();
      metadataListener?.dispose?.();
    }
  };
}
