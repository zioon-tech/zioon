import type { HttpPluginInstaller } from "./http-installer";
import type { PluginManager } from "./manager";

export const EXTERNALIZED_BUILTIN_PLUGIN_IDS = new Set<string>([
  "dev.identity"
]);

type DevSession = {
  devId?: string;
  dir?: string;
  pluginId?: string;
};

type SyncLogger = Pick<Console, "log" | "warn">;

function sourceDirPluginId(dir: unknown): string {
  return String(dir || "")
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop()
    ?.trim() || "";
}

export function externalizedPluginIdForDevSession(
  session: DevSession
): string | null {
  const candidates = [
    String(session.pluginId || "").trim(),
    sourceDirPluginId(session.dir)
  ];
  return candidates.find((id) => EXTERNALIZED_BUILTIN_PLUGIN_IDS.has(id)) || null;
}

export function resolveExternalizedPluginServiceBaseUrl({
  configuredServiceBaseUrl,
  runtimeServiceBaseUrl,
  pageOrigin = globalThis.location?.origin || ""
}: {
  configuredServiceBaseUrl: string;
  runtimeServiceBaseUrl?: string | null;
  pageOrigin?: string;
}): string {
  if (runtimeServiceBaseUrl) {
    try {
      if (new URL(runtimeServiceBaseUrl).origin === pageOrigin) {
        return runtimeServiceBaseUrl;
      }
    } catch {
      // Fall back to the explicitly configured Plugin Host.
    }
  }
  return configuredServiceBaseUrl;
}

export async function stopExternalizedPluginDevSessions({
  pluginManager,
  serviceBaseUrl,
  fetchImpl = fetch,
  logger = console
}: {
  pluginManager: PluginManager;
  serviceBaseUrl: string;
  fetchImpl?: typeof fetch;
  logger?: SyncLogger;
}): Promise<string[]> {
  const devIds = new Set<string>();
  const savedRecords = pluginManager.listDevSessionRecords();

  for (const pluginId of EXTERNALIZED_BUILTIN_PLUGIN_IDS) {
    const savedDevId = String(savedRecords[pluginId]?.devId || "").trim();
    if (savedDevId) devIds.add(savedDevId);

    const existing = pluginManager.get(pluginId);
    if (existing && pluginManager.getPluginOrigin(existing) === "dev") {
      const installedDevId = String(existing.devId || "").trim();
      if (installedDevId) devIds.add(installedDevId);
    }
  }

  try {
    const response = await fetchImpl(
      `${serviceBaseUrl.replace(/\/$/, "")}/plugins/dev/list`
    );
    if (response.ok) {
      const payload = await response.json();
      const sessions = Array.isArray(payload?.data?.sessions)
        ? payload.data.sessions
        : [];
      for (const session of sessions) {
        if (!externalizedPluginIdForDevSession(session)) continue;
        const devId = String(session?.devId || "").trim();
        if (devId) devIds.add(devId);
      }
    }
  } catch (error) {
    logger.warn(
      "[PluginManager] 读取外迁插件开发会话失败，继续同步发布包:",
      error
    );
  }

  const stopped: string[] = [];
  for (const devId of devIds) {
    try {
      const response = await fetchImpl(
        `${serviceBaseUrl.replace(/\/$/, "")}/plugins/dev/stop`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ devId })
        }
      );
      if (!response.ok && response.status !== 404) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      if (response.ok) stopped.push(devId);
    } catch (error) {
      logger.warn(
        `[PluginManager] 停止外迁插件开发会话失败: ${devId}`,
        error
      );
    }
  }

  for (const pluginId of EXTERNALIZED_BUILTIN_PLUGIN_IDS) {
    pluginManager.removeDevSessionRecord({ pluginId });
  }
  if (stopped.length > 0) {
    logger.log(
      `[PluginManager] 已停止外迁插件开发会话: ${stopped.join(", ")}`
    );
  }
  return stopped;
}

export async function syncExternalizedBuiltinPlugins({
  pluginManager,
  pluginInstaller,
  serviceBaseUrl,
  fetchImpl = fetch,
  logger = console
}: {
  pluginManager: PluginManager;
  pluginInstaller: HttpPluginInstaller;
  serviceBaseUrl: string;
  fetchImpl?: typeof fetch;
  logger?: SyncLogger;
}): Promise<void> {
  await stopExternalizedPluginDevSessions({
    pluginManager,
    serviceBaseUrl,
    fetchImpl,
    logger
  });

  for (const pluginId of EXTERNALIZED_BUILTIN_PLUGIN_IDS) {
    try {
      const result = await pluginInstaller.installFromService(pluginId);
      if (!result.success || !result.plugin) {
        logger.warn(
          `[PluginManager] 外迁插件同步失败: ${pluginId}`,
          result.error?.message || "unknown error"
        );
        continue;
      }

      const enabled = pluginManager.getEnabledPreference(pluginId) ?? true;
      await pluginManager.installFromInfo(result.plugin, { enabled });
      logger.log(
        `[PluginManager] 已同步外迁插件: ${pluginId}@${result.plugin.version}`
      );
    } catch (error) {
      logger.warn(`[PluginManager] 外迁插件同步异常: ${pluginId}`, error);
    }
  }
}
