// Shared account API transport for CLI, Workbench and other clients.
// Callers supply their existing account credentials; this adds no authority.
export function createExtensionsClient({
  baseUrl = "", fetchImpl = globalThis.fetch, headers = {}, credentials = "same-origin", signal
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, "");
  const request = async (path, { method = "GET", body, runtime = false } = {}) => {
    const pending = new AbortController();
    const onAbort = () => pending.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => pending.abort(), 15000);
    try {
      const response = await fetchImpl(`${base}/v1/${runtime ? "" : "marketplace/"}${path}`, {
      method, credentials, redirect: "error",
      signal: pending.signal,
      headers: { ...headers, accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(value.error || `Extensions HTTP ${response.status}`), {
        code: value.code || "extensions_http_error", statusCode: response.status
      });
      return value;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
  return Object.freeze({
    request,
    snapshot: () => request("snapshot"),
    connections: () => request("connections"),
    artifact: (id, version) => request(`releases/${encodeURIComponent(id)}/${encodeURIComponent(version)}/artifact`),
    assetUrl: (id, version, path) => `${base}/v1/marketplace/releases/${encodeURIComponent(id)}/${encodeURIComponent(version)}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
    upload: (artifact, expectedRevision) => request("private-releases", {
      method: "POST", body: { artifact, expectedRevision }
    }),
    saveContribution: (artifact, expectedRevision) => request("contributions", {
      method: "POST", body: { artifact, expectedRevision }
    }),
    submitContribution: (id, expectedRevision) => request(`contributions/${encodeURIComponent(id)}/submit`, {
      method: "POST", body: { expectedRevision }
    }),
    install: (id, input) => request(`installations/${encodeURIComponent(id)}`, { method: "POST", body: input }),
    configure: (id, config, expectedRevision) => request(`installations/${encodeURIComponent(id)}/config`, {
      method: "PUT", body: { config, expectedRevision }
    }),
    startExecution: (entry, action, input = {}, interactionProfileId = "interactive.default") => request("runs", {
      method: "POST", runtime: true, body: extensionRunRequest(entry, action, input, interactionProfileId)
    }),
    getExecution: (runId) => request(`runs/${encodeURIComponent(runId)}`, { runtime: true }),
    setEnabled: (id, enabled, expectedRevision) => request(`installations/${encodeURIComponent(id)}`, {
      method: "PATCH", body: { enabled, expectedRevision }
    }),
    uninstall: (id, expectedRevision) => request(`installations/${encodeURIComponent(id)}`, {
      method: "DELETE", body: { expectedRevision }
    })
  });
}

export function extensionRunRequest(entry, action, input = {}, interactionProfileId = "interactive.default") {
  if (!["prepare", "probe", "call", "workspace-prepare", "workspace-read", "workspace-write",
    "workspace-reload", "workspace-restore"].includes(action)) throw new Error("Unsupported extension operation");
  const config = entry.installation?.config || (action.startsWith("workspace-") ? {
    nodeId: "managed:account", workspaceRoot: "/workspace"
  } : null);
  if (!config) throw new Error("Configure an authorized execution Node first");
  return {
    prompt: `Extension ${action}: ${entry.name}`,
    ...(interactionProfileId ? { interactionProfileId } : {}),
    policy: { preset: "trusted-automation", allowedTools: ["extensionsCall", "write", "Bash"],
      fileRoots: [config.workspaceRoot, ...(config.credentialsFile ? [config.credentialsFile] : [])] },
    metadata: { source: "extensions", extensionInvocation: {
      action, listingId: entry.id, epoch: entry.installation.executionEpoch,
      ...(action === "call" ? { tool: input.tool, arguments: input.arguments || {} }
        : action.startsWith("workspace-") ? { arguments: input.arguments || {} } : {})
    } }
  };
}

export function runtimePluginToolRequest(pluginId, tool, arguments_ = {}, interactionProfileId = "interactive.default") {
  if (!pluginId || !tool?.name || tool.pluginId !== pluginId) throw new Error("Tool is not owned by the selected Runtime plugin");
  if (!arguments_ || typeof arguments_ !== "object" || Array.isArray(arguments_)) throw new Error("Tool arguments must be an object");
  const preset = tool.policy?.minimumPreset || (tool.execution?.effect === "read" ? "read-only" : "trusted-automation");
  return {
    prompt: `Plugin tool: ${pluginId}/${tool.name}`,
    ...(interactionProfileId ? { interactionProfileId } : {}),
    policy: { preset, allowedTools: [tool.name] },
    metadata: { source: "runtime-plugin-cli", pluginToolInvocation: {
      pluginId, tool: tool.name, arguments: arguments_
    } }
  };
}
