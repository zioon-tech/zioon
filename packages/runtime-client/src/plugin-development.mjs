import { createExtensionsClient } from "./extensions.mjs";
import { collectDevelopmentBuild, normalizeDevelopmentBuild } from "./development-build.mjs";

export const DEVELOPMENT_PATH = "workbench-state/plugin-development";

export function developmentRequestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (AbortSignal.any) return AbortSignal.any([signal, timeout]);
  const pending = new AbortController();
  const abort = () => {
    pending.abort(signal.aborted ? signal.reason : timeout.reason);
    signal.removeEventListener("abort", abort);
    timeout.removeEventListener("abort", abort);
  };
  if (signal.aborted) abort();
  else {
    signal.addEventListener("abort", abort, { once: true });
    timeout.addEventListener("abort", abort, { once: true });
  }
  return pending.signal;
}

// A source URL is derived from an exact Node and dev session, never supplied
// by another client or used as a new execution authority.
export function developmentBaseUrl(baseUrl, devId, nodeId = "") {
  if (!/^dev-[a-zA-Z0-9_-]+$/.test(devId)) throw new Error("Invalid development session");
  const url = new URL(`/v1/device-services/plugin-service/plugins/dev/${encodeURIComponent(devId)}`,
    baseUrl || globalThis.location?.origin);
  if (nodeId) url.searchParams.set("node_id", nodeId);
  return url.href;
}

export function developmentBuildBaseUrl(baseUrl, pluginId, digest) {
  if (!pluginId || !/^[a-f0-9]{64}$/.test(digest || "")) throw new Error("Invalid development build identity");
  return new URL(`/v1/${DEVELOPMENT_PATH}/${encodeURIComponent(pluginId)}/builds/${digest}`,
    baseUrl || globalThis.location?.origin).href;
}

export function developmentFileUrl(baseUrl, path, cacheToken = "") {
  const base = new URL(baseUrl, globalThis.location?.href);
  const relative = String(path).replace(/^\.\//, "");
  if (!relative || relative.startsWith("/") || relative.split("/").includes("..") || /^[a-z]+:/i.test(relative)) {
    throw new Error("Development files must be inside the source directory");
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/${relative}`;
  if (cacheToken) base.searchParams.set("zionDevTs", cacheToken);
  return base.href;
}

export function createPluginDevelopmentClient(options = {}) {
  const transport = createExtensionsClient(options);
  const device = (path, nodeId, input) => transport.request(
    `device-services/plugin-service/plugins/dev/${path}${nodeId ? `?node_id=${encodeURIComponent(nodeId)}` : ""}`,
    { runtime: true, ...(input ? { method: "POST", body: input } : {}) }
  );
  const managedRead = async (directory, path) => {
    const loaded = await transport.request(`device-services/local-tools/files/read?path=${encodeURIComponent(`${directory}/${path}`)}`,
      { runtime: true });
    if (typeof loaded.content !== "string") throw new Error("Invalid managed source read");
    return loaded.content;
  };
  async function stageManagedSource(record, build) {
    // Every write uses the existing authenticated file service, its Node
    // policy and durable receipts; source bytes never live on the ECS.
    for (const [path, content] of Object.entries({ ...build.files, "manifest.json": JSON.stringify(build.manifest) })) {
      const absolute = `${record.directory}/${path}`;
      let previous;
      try {
        previous = await transport.request(`device-services/local-tools/files/read?path=${encodeURIComponent(absolute)}`, { runtime: true });
      } catch (error) { if (error.statusCode !== 404) throw error; }
      if (previous?.content === content) continue;
      const written = await transport.request("device-services/local-tools/files/write", { runtime: true, method: "POST",
        body: { path: absolute, content, ...(previous ? { expected_hash: previous.content_hash } : { create_only: true }) } });
      if (written.written === false || written.created === false) {
        const actual = await managedRead(record.directory, path);
        if (actual !== content) throw Object.assign(new Error("Managed source changed during staging"),
          { statusCode: 409, code: "revision_conflict" });
      }
    }
  }
  const snapshot = async () => {
    try { return await transport.request(DEVELOPMENT_PATH, { runtime: true }); }
    catch (error) {
      if (error.statusCode === 404) {
        throw Object.assign(new Error("This Runtime needs the plugin development update; device-only development remains available."),
          { code: "development_upgrade_required", statusCode: 426 });
      }
      throw error;
    }
  };
  async function publish(pluginId, build) {
    if (build) build = normalizeDevelopmentBuild(build);
    const current = await snapshot();
    const record = current.entries.find((entry) => entry.pluginId === pluginId);
    if (!record) throw new Error("Register the development source before building");
    if (record.nodeId === "managed:account") {
      if (!build) build = await collectDevelopmentBuild((path) => managedRead(record.directory, path));
      else await stageManagedSource(record, build);
    }
    if (!build) {
      const baseUrl = developmentBaseUrl(options.baseUrl, record.devId, record.nodeId);
      build = await collectDevelopmentBuild(async (path) => {
        const response = await (options.fetchImpl || globalThis.fetch)(developmentFileUrl(baseUrl, path), {
          headers: options.headers, credentials: options.credentials || "same-origin", redirect: "error", cache: "no-store",
          signal: developmentRequestSignal(options.signal, 15000)
        });
        if (!response.ok) throw Object.assign(new Error(`Development build file HTTP ${response.status}: ${path}`), { statusCode: response.status });
        const chunks = [];
        let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > 250000) throw new Error("Development source file exceeds build size limit");
          chunks.push(chunk);
        }
        const buffer = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      });
    }
    const result = await transport.request(`${DEVELOPMENT_PATH}/${encodeURIComponent(pluginId)}/builds`, {
      runtime: true, method: "PUT", body: { expectedRevision: current.revision,
        generation: (record.build?.generation || 0) + 1, build }
    });
    return { ...result, baseUrl: developmentBuildBaseUrl(options.baseUrl, pluginId, result.build.digest) };
  }
  return Object.freeze({
    snapshot,
    publish,
    listSources: (nodeId) => device("list", nodeId),
    async list() {
      const current = await snapshot();
      const nodes = new Map();
      for (const nodeId of new Set(current.entries.map((entry) => entry.nodeId).filter((id) => id !== "managed:account"))) {
        try { nodes.set(nodeId, await device("list", nodeId)); }
        catch (error) { nodes.set(nodeId, { error }); }
      }
      return { ...current, entries: current.entries.map((entry) => {
        const result = nodes.get(entry.nodeId);
        const source = result?.data?.sessions?.find((item) => item.devId === entry.devId);
        const status = entry.nodeId === "managed:account" ? "account-workspace" : result?.error
          ? ([401, 403].includes(result.error.statusCode) ? "access-denied" : "offline")
          : !source || source.dirExists === false ? "source-missing"
            : source.active ? "online" : "stopped";
        return { ...entry, status, uiHost: "workbench", buildStatus: entry.build ? "available" : "build-required" };
      }) };
    },
    async start(directory, nodeId, { deviceOnly = false, build } = {}) {
      if (build) build = normalizeDevelopmentBuild(build);
      const current = deviceOnly ? null : await snapshot();
      if (!nodeId) {
        if (deviceOnly || !build) throw new Error("Managed development requires a local build; use the CLI or select a source Node");
        const plugin = build.manifest.zion || build.manifest;
        const pluginId = plugin.id || build.manifest.id || build.manifest.name;
        if (!/^[a-zA-Z0-9._-]{1,128}$/.test(pluginId || "")) throw new Error("Invalid development plugin identity");
        const record = { pluginId, name: plugin.name || pluginId, version: plugin.version,
          nodeId: "managed:account", devId: "dev-managed", directory: `/workspace/.zion/plugins/${pluginId}` };
        await stageManagedSource(record, build);
        await transport.request(DEVELOPMENT_PATH, { runtime: true, method: "PUT",
          body: { record, expectedRevision: current.revision } });
        const published = await publish(pluginId, build);
        return { ...published, source: record, registration: "account", buildStatus: "available" };
      }
      const started = await device("start", nodeId, { path: directory });
      const source = started.data;
      if (!started.success || !source?.devId || !source?.dir) throw new Error("Invalid development start response");
      const baseUrl = developmentBaseUrl(options.baseUrl, source.devId, nodeId);
      if (deviceOnly) return { ...source, nodeId, baseUrl, registration: "device-only" };
      try {
        const response = await (options.fetchImpl || globalThis.fetch)(developmentFileUrl(baseUrl, "manifest.json"), {
          headers: options.headers, credentials: options.credentials || "same-origin",
          signal: options.signal || AbortSignal.timeout(15000), redirect: "error", cache: "no-store"
        });
        if (!response.ok) throw new Error(`Development manifest HTTP ${response.status}`);
        const manifest = await response.json();
        const plugin = manifest.zion || manifest;
        const record = {
          pluginId: plugin.id || manifest.id || manifest.name,
          name: plugin.name || manifest.name, version: plugin.version || manifest.version,
          nodeId, devId: source.devId, directory: source.dir
        };
        const result = await transport.request(DEVELOPMENT_PATH, {
          runtime: true, method: "PUT", body: { record, expectedRevision: current.revision }
        });
        try {
          const published = await publish(record.pluginId);
          return { ...published, source: { ...record, baseUrl }, registration: "account", buildStatus: "available" };
        } catch (error) {
          return { ...result, source: { ...record, baseUrl }, registration: "account",
            buildStatus: "build-failed", buildError: error.message };
        }
      } catch (error) {
        // The source watcher may already exist. Do not stop it or retry a
        // control-plane mutation whose outcome is not known.
        error.source = { devId: source.devId, nodeId, directory: source.dir };
        error.message += ` (source session ${source.devId} exists on ${nodeId}; inspect before retrying)`;
        throw error;
      }
    },
    async stop(pluginId, { stopSource = false } = {}) {
      const current = await snapshot();
      const record = current.entries.find((entry) => entry.pluginId === pluginId);
      if (!record) throw new Error(`Development plugin not found: ${pluginId}`);
      const result = await transport.request(`${DEVELOPMENT_PATH}/${encodeURIComponent(pluginId)}`, {
        runtime: true, method: "DELETE", body: { expectedRevision: current.revision }
      });
      if (stopSource && record.nodeId !== "managed:account") {
        try { await device("stop", record.nodeId, { devId: record.devId }); }
        catch (error) { return { ...result, sourceStopped: false, sourceError: error.message }; }
      }
      return { ...result, sourceStopped: stopSource && record.nodeId !== "managed:account" };
    }
  });
}

// HTTP works through an outbound Connector; no WebSocket tunnel is required.
// Keep polling after sleep/disconnection, serialize callbacks, and cancel on
// dispose so an old watcher cannot activate stale code.
export function watchDevelopmentSource({
  baseUrl, fetchImpl = globalThis.fetch, headers = {}, credentials = "same-origin",
  intervalMs = 3000, onChange, onStatus = () => {}, isVisible = () => true, loadInitially = false
}) {
  const controller = new AbortController();
  let disposed = false, busy = false, baseline, timer, status = "";
  const report = (next, error) => {
    if (next !== status) { status = next; onStatus(next, error); }
  };
  const read = async (path) => {
    const response = await fetchImpl(developmentFileUrl(baseUrl, path, String(Date.now())), {
      headers, credentials, cache: "no-store", redirect: "error",
      signal: developmentRequestSignal(controller.signal, 10000)
    });
    if (!response.ok) throw Object.assign(new Error(`Development source HTTP ${response.status}`), { statusCode: response.status });
    return response;
  };
  const check = async () => {
    if (disposed || busy) return;
    clearTimeout(timer);
    if (!isVisible()) {
      timer = setTimeout(() => void check(), intervalMs);
      return;
    }
    busy = true;
    try {
      let revision;
      try {
        const value = await (await read("__revision")).json();
        if (!value.revision) throw new Error("Invalid development revision");
        revision = value.revision;
      } catch (error) {
        if (error.statusCode !== 404) throw error;
        // Compatibility with an older Plugin Host. Bundled UI entries are
        // sufficient here; newer hosts track the entire directory.
        const manifestText = await (await read("manifest.json")).text();
        const manifest = JSON.parse(manifestText), plugin = manifest.zion || manifest;
        const entry = plugin.entries?.workbench || plugin.main || manifest.main;
        const contents = [manifestText];
        if (entry) {
          const entryUrl = new URL(entry, `${new URL(baseUrl).origin}${new URL(baseUrl).pathname}/`);
          const sourceBase = new URL(baseUrl);
          if (entryUrl.origin !== sourceBase.origin || !entryUrl.pathname.startsWith(`${sourceBase.pathname}/`)) {
            throw new Error("Development entry is outside its source session");
          }
          contents.push(await (await read(entryUrl.pathname.slice(sourceBase.pathname.length + 1))).text());
        }
        for (const style of plugin.contributes?.styles || []) contents.push(await (await read(style)).text());
        revision = contents.join("\0");
      }
      if (disposed) return;
      if (baseline === undefined) {
        if (loadInitially) await onChange(controller.signal);
        if (!disposed) baseline = revision;
      }
      else if (revision !== baseline) {
        await onChange(controller.signal);
        if (!disposed) baseline = revision;
      }
      if (!disposed) report("online");
    } catch (error) {
      if (!disposed) report([401, 403].includes(error.statusCode) ? "access-denied"
        : error.statusCode === 404 ? "source-missing"
          : error.statusCode || error.name === "TypeError" || error.name === "TimeoutError" ? "offline" : "load-error", error);
    } finally {
      busy = false;
      if (!disposed) timer = setTimeout(() => void check(), intervalMs);
    }
  };
  void check();
  return {
    check,
    dispose() { disposed = true; clearTimeout(timer); controller.abort(); }
  };
}
