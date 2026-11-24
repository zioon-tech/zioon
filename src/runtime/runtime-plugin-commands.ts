import { readWorkbenchRuntimeConfig } from "./workbench-runtime-config";

export function activeWorkflowSessionId(zion: any = (globalThis as any).window?.zion): string {
  const panelId = zion?.panels?.getActivePanelId?.();
  const panel = zion?.panels?.list?.().find((item: any) => item.id === panelId);
  return String(panel?.activeTabId || zion?.state?.get?.("sessions.currentId") || "");
}

export async function runtimePluginCommand(pluginId: string, args: Record<string, unknown>,
  installation?: { digest: string; epoch: string }) {
  const zion = (globalThis as any).window?.zion;
  const config = readWorkbenchRuntimeConfig({ state: zion?.state, storage: globalThis.localStorage });
  if (config.mode === "browser") throw new Error("此功能需要连接 Zioon Runtime");
  const sessionId = String(args.sessionId || activeWorkflowSessionId(zion));
  if (!sessionId && !installation) throw new Error("请先打开一个会话");
  const response = await fetch(`${config.baseUrl}/v1/plugins/${encodeURIComponent(pluginId)}/commands`, {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...args, sessionId, ...(installation ? {
      installationDigest: installation.digest, installationEpoch: installation.epoch
    } : {}) })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error || `Runtime command failed: ${response.status}`);
  return body.result;
}
