import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { normalizeDevelopmentBuild, buildFilePath } from "../../../packages/runtime-client/src/development-build.mjs";
import { normalizePluginManifest } from "../../../packages/plugin-sdk/src/manifest.mjs";
import { artifactStoreFromEnvironment } from "./marketplace/artifact-store.mjs";
import { readDevelopmentRegistry, saveDevelopmentRegistry } from "./marketplace/development.mjs";

const ROOT = "/v1/workbench-state/plugin-development";
// Existing snapshot, KV and migration filters hide this private namespace.
const registryKey = (userId) => `runtime.plugins.development.private.${createHash("sha256").update(userId).digest("hex")}`;
const failure = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const json = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
};
async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 256000) throw failure(413, "request_too_large", "Development request exceeds 256 KiB");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw failure(400, "invalid_json", "Invalid development registration JSON"); }
}
function normalizeRecord(input) {
  if (!input || typeof input !== "object") throw failure(400, "invalid_source", "Development source is required");
  const record = {};
  for (const [key, max] of Object.entries({ pluginId: 128, name: 256, version: 64, nodeId: 256, devId: 128, directory: 4096 })) {
    const value = input[key];
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) {
      throw failure(400, "invalid_source", `Invalid development ${key}`);
    }
    record[key] = value.trim();
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(record.pluginId) || !/^dev-[a-zA-Z0-9_-]+$/.test(record.devId)) {
    throw failure(400, "invalid_source", "Invalid development identifier");
  }
  if (!record.directory.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(record.directory)) {
    throw failure(400, "invalid_source", "Development directory must be absolute on its source Node");
  }
  return record;
}

export function createPluginDevelopmentHttpHandler({ store, artifactStore, marketplace, localMode = false, platformNodeIds = [] }) {
  let objects = artifactStore;
  const contentStore = () => objects ||= artifactStoreFromEnvironment();
  return async (request, response, url) => {
    if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return false;
    try {
      const principal = request.zionPrincipal;
      const userId = principal?.kind === "account" ? principal.user?.id : localMode && !principal ? "local-development" : "";
      if (!userId) throw failure(401, "account_required", "Plugin development requires an account");
      const key = registryKey(userId);
      const stored = await store.readKV(key);
      const legacy = async () => (await store.readKV(key))?.value;
      const authoritative = marketplace ? (await marketplace.account(userId)).development : null;
      const clearLegacy = async () => {
        if (stored && store.deleteKV) {
          // Cleanup is repeatable and must not turn a successful DB commit into
          // a failed build response. Later reads retry a failed metadata cleanup.
          await store.deleteKV(key, { expectedValue: stored.value }).catch(() => {});
        }
      };
      if (authoritative) await clearLegacy();
      const current = authoritative || (marketplace ? await readDevelopmentRegistry(marketplace, userId, legacy)
        : stored?.value || { schemaVersion: 1, revision: 0, entries: [] });
      const save = async (next) => {
        if (marketplace) {
          const saved = await saveDevelopmentRegistry(marketplace, userId, next, legacy);
          // Only the successful DB commit makes the old private KV redundant.
          await clearLegacy();
          return saved;
        }
        await store.writeKV(key, next, { expectedValue: stored?.value ?? null });
        return next;
      };
      const buildMatch = url.pathname.slice(ROOT.length).match(/^\/([^/]+)\/builds(?:\/([a-f0-9]{64})\/(.+))?$/);
      if (buildMatch) {
        const pluginId = decodeURIComponent(buildMatch[1]);
        const record = current.entries.find((entry) => entry.pluginId === pluginId);
        if (!record) throw failure(404, "source_not_found", "Development registration not found");
        if (request.method === "GET" && buildMatch[2]) {
          const build = [record.build, ...(record.builds || [])].find((b) => b?.digest === buildMatch[2]);
          if (!build) throw failure(404, "build_not_found", "Successful build not found");
          const loaded = await contentStore().get(build.ref);
          const path = decodeURIComponent(buildMatch[3]);
          const content = path === "manifest.json" ? JSON.stringify(loaded.manifest)
            : path === "__revision" ? JSON.stringify({ revision: build.digest })
              : loaded.files[buildFilePath(path)];
          if (typeof content !== "string") throw failure(404, "build_file_not_found", "Build file not found");
          const type = path.endsWith(".css") ? "text/css" : /\.(mjs|js|cjs)$/.test(path) ? "text/javascript"
            : path.endsWith(".json") || path === "__revision" ? "application/json" : "text/plain";
          response.writeHead(200, { "content-type": `${type}; charset=utf-8`, "content-length": Buffer.byteLength(content),
            "cache-control": "private, max-age=0, must-revalidate", etag: `"${build.digest}"`, "x-content-type-options": "nosniff" });
          response.end(content);
          return true;
        }
        if (request.method !== "PUT" || buildMatch[2]) throw failure(405, "method_not_allowed", "Unsupported build operation");
        const body = await readBody(request);
        if (body.expectedRevision !== current.revision || !Number.isSafeInteger(body.generation)
          || body.generation !== (record.build?.generation || 0) + 1) throw failure(409, "revision_conflict", "Build generation changed");
        const packed = normalizeDevelopmentBuild(body.build);
        const plugin = normalizePluginManifest(packed.manifest);
        if (plugin.id !== record.pluginId) throw failure(422, "build_identity_mismatch", "Build plugin identity must match its registration");
        const ref = await contentStore().put(packed);
        const nextBuild = { generation: body.generation, digest: ref.digest, ref, publishedAt: Date.now(),
          hasWorkbench: Boolean(plugin.entries.workbench) };
        const nextRecord = { ...record, name: plugin.name, version: plugin.version, build: nextBuild,
          builds: record.build ? [record.build, ...(record.builds || [])].slice(0, 7) : [] };
        const next = { ...current, revision: current.revision + 1,
          entries: current.entries.map((entry) => entry.pluginId === pluginId ? nextRecord : entry) };
        const saved = await save(next);
        json(response, 200, { ...saved, build: nextBuild,
          backend: saved.entries.find((entry) => entry.pluginId === pluginId)?.backend });
        return true;
      }
      if (request.method === "GET" && url.pathname === ROOT) {
        json(response, 200, current);
        return true;
      }
      if (!["PUT", "DELETE"].includes(request.method)) throw failure(405, "method_not_allowed", "Unsupported development operation");
      const body = await readBody(request);
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision !== current.revision) {
        throw failure(409, "revision_conflict", "Development registration changed; read the current revision");
      }
      let entries;
      if (request.method === "PUT" && url.pathname === ROOT) {
        const record = normalizeRecord(body.record);
        if (platformNodeIds.includes(record.nodeId)) throw failure(403, "platform_node_execution_denied", "Platform Nodes cannot host user development sources");
        // Only discovery metadata is stored here. Every source read and tool
        // invocation still goes through the existing Node authorization.
        const previous = current.entries.find((entry) => entry.pluginId === record.pluginId);
        entries = [...current.entries.filter((entry) => entry.pluginId !== record.pluginId),
          { ...record, ...(previous?.build ? { build: previous.build, builds: previous.builds || [] } : {}) }];
        if (entries.length > 64) throw failure(400, "source_limit", "At most 64 development plugins can be registered");
      } else if (request.method === "DELETE" && url.pathname.startsWith(`${ROOT}/`)) {
        const pluginId = decodeURIComponent(url.pathname.slice(ROOT.length + 1));
        if (!current.entries.some((entry) => entry.pluginId === pluginId)) throw failure(404, "source_not_found", "Development registration not found");
        entries = current.entries.filter((entry) => entry.pluginId !== pluginId);
      } else throw failure(405, "method_not_allowed", "Unsupported development operation");
      const next = { schemaVersion: 1, revision: current.revision + 1, entries };
      json(response, 200, await save(next));
    } catch (error) {
      json(response, error.statusCode || 500, { error: error.message, code: error.code || "development_error" });
    }
    return true;
  };
}
