/** Public discovery metadata only. No endpoint, credentials, or executable code. */
export function normalizePluginModels(models) {
  const fail = () => { throw Object.assign(new Error("invalid_plugin_models"), { code: "invalid_plugin_models" }); };
  if (!Array.isArray(models) || models.length > 50) fail();
  const seen = new Set();
  return models.map((m) => {
    if (!m || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(m.id || "") || seen.has(m.id)) fail();
    seen.add(m.id);
    for (const key of ["supportsStreaming", "supportsTools", "supportsImages"]) {
      if (m[key] !== undefined && typeof m[key] !== "boolean") fail();
    }
    return {
      id: m.id, name: String(m.name || m.id).slice(0, 200),
      supportsStreaming: m.supportsStreaming === true,
      supportsTools: m.supportsTools === true,
      supportsImages: m.supportsImages === true,
      ...(Number.isSafeInteger(m.contextWindow) && m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {})
    };
  });
}
