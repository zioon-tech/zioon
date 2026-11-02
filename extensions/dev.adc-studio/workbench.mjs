import { mountStudio } from "./panel.mjs";

const pluginId = "dev.adc-studio";
export function createRuntimeAdapter(zion = window.zion, options = {}) {
  const backendId = options.existingAdc ? "dev.agent-device-cloud" : pluginId;
  const lifecycle = new AbortController();
  const pendingRuns = new Set();
  const baseUrl = () => {
    if ((zion.state?.get?.("runtime.mode") || localStorage.getItem("zion.runtime.mode")) === "browser") throw new Error("请先连接 Zioon Runtime。");
    return String(zion.state?.get?.("runtime.baseUrl") || localStorage.getItem("zion.runtime.baseUrl") || location.origin).replace(/\/+$/, "");
  };
  async function api(path, body, signal) {
    const response = await fetch(`${baseUrl()}${path}`, { method: body === undefined ? "GET" : "POST",
      credentials: "include", redirect: "error",
      signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(50000), ...(signal ? [signal] : [])]),
      headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error?.message || value.error || `Runtime 请求失败（${response.status}）`);
    return value;
  }
  const command = async (args, signal) => (await api(`/v1/plugins/${backendId}/commands`, args, signal)).result;
  async function runTool(suffix, args, signal) {
    const name = `${options.existingAdc ? "adc_" : "adc_studio_"}${suffix}`;
    const catalog = await api("/v1/capabilities/tools", undefined, signal);
    const definition = catalog.tools?.find(tool => tool.pluginId === backendId && tool.name === name);
    if (!definition) throw new Error(`Runtime 尚未启用 ${name}，请先安装并启用 ADC Studio 的 Runtime 包。`);
    const profile = String(zion.state?.get?.("adcStudio.interactionProfileId") || "adc.studio");
    const accepted = await api("/v1/runs", {
      prompt: `ADC Studio: ${name}`, interactionProfileId: profile,
      policy: { preset: definition.policy?.minimumPreset || "read-only", allowedTools: [name] },
      metadata: { source: "adc-studio-panel", pluginToolInvocation: { pluginId: backendId, tool: name, arguments: args } }
    }, signal);
    if (!accepted.runId) throw new Error("Runtime 未返回 Run ID。");
    pendingRuns.add(accepted.runId);
    const deadline = Date.now() + 120000;
    try {
      while (Date.now() < deadline) {
        signal?.throwIfAborted(); lifecycle.signal.throwIfAborted();
        const run = (await api(`/v1/runs/${encodeURIComponent(accepted.runId)}`, undefined, signal)).run;
        if (["completed", "failed", "aborted", "interrupted"].includes(run?.status)) {
          let output;
          try { output = typeof run.output === "string" ? JSON.parse(run.output) : run.output; } catch {}
          if (!output && typeof run.error === "string") { try { output = JSON.parse(run.error); } catch {} }
          if (output?.invocationId) return { ...output, runId: accepted.runId };
          if (run.status !== "completed") throw new Error(`${run.error || run.output || run.status}（Run ${accepted.runId}）`);
          return output;
        }
        await new Promise((resolve, reject) => {
          const combined = AbortSignal.any([lifecycle.signal, ...(signal ? [signal] : [])]);
          const timer = setTimeout(() => { combined.removeEventListener("abort", abort); resolve(); }, 750);
          const abort = () => { clearTimeout(timer); reject(combined.reason || new Error("请求已中止")); };
          combined.addEventListener("abort", abort, { once: true });
          if (combined.aborted) abort();
        });
      }
      throw new Error(`Run ${accepted.runId} 仍未返回最终结果，请在任务记录中查询。`);
    } finally { pendingRuns.delete(accepted.runId); }
  }
  return {
    mode: "runtime", readOnly: false, sharedConnection: Boolean(options.existingAdc),
    status: signal => command({ action: "status" }, signal),
    select: (nodeId, signal) => command({ action: "select", nodeId }, signal),
    connect: signal => { const redirect = new URL(location.href); redirect.search = ""; redirect.hash = "";
      return command({ action: "connect", redirectUri: redirect.href }, signal); },
    finish: (code, state, signal) => command({ action: "finish", code, state }, signal),
    disconnect: signal => command({ action: "disconnect" }, signal),
    invoke: (input, signal) => {
      const suffix = input.confirmed ? "invoke" : "read";
      const allowed = options.existingAdc ? ["tool", "args", "nodeId", "idempotencyKey"] : Object.keys(input);
      return runTool(suffix, Object.fromEntries(Object.entries(input).filter(([key, value]) => value !== undefined && allowed.includes(key))), signal);
    },
    task: (task, signal) => runTool("task", { invocationId: task.invocationId, waitMs: 4000 }, signal),
    cancel: (task, signal) => runTool("cancel", { jobId: task.jobId }, signal),
    dispose() { lifecycle.abort(); }
  };
}

export async function activate(context, options = {}) {
  const zion = window.zion, subscriptions = context.subscriptions || [], mounts = new Set(), workspaces = new Set();
  const open = () => { zion.bottomPanel?.activateView?.("adc-studio.workspace"); zion.bottomPanel?.show?.(); zion.bottomPanel?.setHeight?.(640); };
  const mount = (container, compact = false) => {
    const panel = mountStudio(container, createRuntimeAdapter(zion, options), {
      compact, onOpen: open, onMaximize: compact ? undefined : () => zion.bottomPanel?.maximize?.(),
      onSelect: nodeId => mounts.forEach(other => other.selectNode(nodeId)),
      onOpenTab: compact ? value => { open(); queueMicrotask(() => workspaces.forEach(other => other.showTab(value))); } : undefined
    }); mounts.add(panel);
    if (!compact) workspaces.add(panel);
    return { dispose() { mounts.delete(panel); workspaces.delete(panel); panel.dispose(); } };
  };
  subscriptions.push(zion.bottomPanel?.registerView?.({
    id: "adc-studio.workspace", pluginId, title: "ADC Studio", icon: "$(remote)", location: "bottompanel",
    order: 46, maximizable: true, component: { render: container => mount(container) }
  }));
  subscriptions.push(zion.sideBar?.registerView?.({
    id: "adc-studio.devices", pluginId, title: "ADC Studio", icon: "$(remote)", location: "sidebar", order: 46,
    component: { render: container => mount(container, true) }
  }));
  subscriptions.push(zion.activityBar?.registerItem?.({
    id: "adc-studio.activity", pluginId, icon: "$(remote)", tooltip: "ADC Studio", sideBarViewId: "adc-studio.devices", order: 46
  }));
  subscriptions.push(zion.commands?.registerCommand?.("adc-studio.open", open));
  subscriptions.push(zion.commands?.registerCommand?.("adc-studio.refresh", () => mounts.forEach(panel => void panel.refresh())));
  subscriptions.push(zion.bottomStatusBar?.registerItem?.({
    id: "adc-studio.status", text: "ADC Studio", tooltip: "设备工作台 · 测试副本", priority: 56, onClick: open
  }));
  subscriptions.push({ dispose() { mounts.forEach(panel => panel.dispose()); mounts.clear(); } });
  const callback = new URL(location.href);
  if (!options.existingAdc && callback.searchParams.get("state")?.startsWith("adcstudio_")) {
    const code = callback.searchParams.get("code"), state = callback.searchParams.get("state"), adapter = createRuntimeAdapter(zion);
    for (const name of ["code", "state", "error", "error_description", "iss"]) callback.searchParams.delete(name);
    history.replaceState(null, "", callback.href);
    try { if (!code) throw new Error("ADC Studio 登录已取消。"); await adapter.finish(code, state); open(); }
    catch (error) { zion.notification?.error?.(error.message); }
    finally { adapter.dispose(); }
  }
  return {};
}
