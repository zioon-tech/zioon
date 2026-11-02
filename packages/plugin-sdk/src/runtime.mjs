/** Helpers are bundled into plugins; they never load user code in Runtime. */
export function defineToolPlugin(tool) {
  if (!tool?.name || typeof tool.invoke !== "function") throw new Error("A tool name and invoke function are required");
  return function activateRuntimePlugin(context) {
    const registration = context.tools.registerTool(tool);
    return { dispose: () => registration.dispose() };
  };
}

export function defineModelPlugin(provider) {
  if (!provider?.id || !Array.isArray(provider.models) || typeof provider.request !== "function") {
    throw new Error("A model provider ID, catalog and request function are required");
  }
  return function activateRuntimePlugin(context) {
    const registration = context.models.registerProvider(provider);
    return { dispose: () => registration.dispose() };
  };
}
