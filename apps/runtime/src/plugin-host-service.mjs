import { createDeviceServiceClient } from "./device-service-client.mjs";

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

export function createPluginHostService({
  baseUrl = "http://127.0.0.1:8767",
  nodeBroker = null,
  fetchImpl = globalThis.fetch
} = {}) {
  const { request } = createDeviceServiceClient({
    service: "plugin-service",
    baseUrl,
    nodeBroker,
    fetchImpl
  });

  const listDev = async ({ runContext = {} } = {}) => {
    const payload = await request("/plugins/dev/list", { runContext });
    return {
      sessions: Array.isArray(payload?.data?.sessions)
        ? payload.data.sessions
        : []
    };
  };

  return Object.freeze({
    async list({ limit, offset, runContext = {} } = {}) {
      const safeLimit = boundedInteger(limit, 50, 1, 100);
      const safeOffset = boundedInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const [catalog, development] = await Promise.all([
        request(`/plugins/?limit=${safeLimit}&offset=${safeOffset}`, {
          runContext
        }),
        listDev({ runContext })
      ]);
      return {
        plugins: Array.isArray(catalog?.data) ? catalog.data : [],
        total: Math.max(0, Number(catalog?.total) || 0),
        limit: safeLimit,
        offset: safeOffset,
        devSessions: development.sessions
      };
    },

    async search({ query, limit, runContext = {} } = {}) {
      const text = String(query || "").trim();
      if (!text) throw new Error("pluginsManage search requires query");
      const safeLimit = boundedInteger(limit, 20, 1, 100);
      const payload = await request(
        `/plugins/search?query=${encodeURIComponent(text)}&limit=${safeLimit}`,
        { runContext }
      );
      return {
        query: text,
        plugins: Array.isArray(payload?.data) ? payload.data : [],
        count: Math.max(0, Number(payload?.count) || 0)
      };
    },

    listDev,

    async startDev({ path, runContext = {} } = {}) {
      const sourcePath = String(path || "").trim();
      if (!sourcePath) throw new Error("pluginsManage startDev requires path");
      const payload = await request("/plugins/dev/start", {
        method: "POST",
        body: { path: sourcePath },
        runContext
      });
      return payload?.data || payload;
    },

    async stopDev({ devId, runContext = {} } = {}) {
      const requestedId = String(devId || "").trim();
      const ids = requestedId
        ? [requestedId]
        : (await listDev({ runContext })).sessions
          .map((session) => String(session?.devId || "").trim())
          .filter(Boolean);
      const stopped = [];
      for (const id of [...new Set(ids)]) {
        await request("/plugins/dev/stop", {
          method: "POST",
          body: { devId: id },
          runContext
        });
        stopped.push(id);
      }
      return { stopped };
    }
  });
}
