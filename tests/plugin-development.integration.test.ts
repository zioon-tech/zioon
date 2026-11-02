import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginManager } from "../src/plugin/manager";
import { HttpPluginInstaller } from "../src/plugin/http-installer";
import { syncDevelopmentPlugins } from "../src/plugin/development-sync";
import { watchDevelopmentSource } from "../packages/runtime-client/src/plugin-development.mjs";

const baseUrl = "https://runtime.test";
const record = { pluginId: "dev.live", name: "Live", version: "0.1.0",
  nodeId: "node:mac", devId: "dev-live", directory: "/tmp/live" };
const manifest = { name: record.pluginId, version: record.version, zion: {
  manifestVersion: 2, id: record.pluginId, name: record.name, version: record.version,
  entries: { workbench: "./main.js" }, contributes: { styles: ["./styles.css"] }
} };
let contentRevision: number, registryRevision: number, entries: (typeof record & { build?: { digest: string; generation: number } })[], online: boolean;
let requests: URL[], live: number, activations: number;
const cleanups: (() => void | Promise<void>)[] = [];
const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  contentRevision = 1; registryRevision = 1; entries = [record]; online = true;
  requests = []; live = 0; activations = 0;
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    const url = new URL(input);
    requests.push(url);
    if (url.pathname.endsWith("/plugin-development")) return Response.json({
      revision: registryRevision, entries
    });
    if (url.pathname.includes("/builds/")) {
      const build = url.pathname.split("/builds/")[1].split("/")[0];
      if (build === "3".repeat(64)) return Response.json({ error: "unavailable" }, { status: 503 });
      if (url.pathname.endsWith("/__revision")) return Response.json({ revision: build });
      if (url.pathname.endsWith("/manifest.json")) return Response.json(manifest);
      if (url.pathname.endsWith("/main.js")) return new Response("import { label } from './nested/label.js';\nexport function activate() { return label; }");
      if (url.pathname.endsWith("/nested/label.js")) return new Response(`export const label = '${build[0]}';`);
      if (url.pathname.endsWith("/styles.css")) return new Response(`.live { --revision: ${build[0]}; }`);
      return Response.json({}, { status: 404 });
    }
    expect(url.searchParams.get("node_id")).toBe(record.nodeId);
    if (!online) return Response.json({ error: "offline" }, { status: 503 });
    if (url.pathname.endsWith("/__revision")) return Response.json({ revision: `revision-${contentRevision}` });
    if (url.pathname.endsWith("/manifest.json")) return Response.json(manifest);
    if (url.pathname.endsWith("/main.js")) return new Response("import { label } from './nested/label.js';\nexport function activate() { return label; }");
    if (url.pathname.endsWith("/nested/label.js")) return new Response(`export const label = '${contentRevision}';`);
    if (url.pathname.endsWith("/styles.css")) return new Response(`.live { --revision: ${contentRevision}; }`);
    return Response.json({}, { status: 404 });
  }));
  let blob = 0;
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => `blob:dev-${++blob}`) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreate });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevoke });
});
const settle = async () => { for (let i = 0; i < 120; i++) await Promise.resolve(); };
const client = () => {
  const manager = new PluginManager({ pluginDir: "", logLevel: "error" });
  vi.spyOn((manager as any).loader, "loadModule").mockImplementation(async () => ({
    activate(context: any) {
      live++; activations++;
      context.subscriptions.push({ dispose() { live--; } });
    }
  }));
  const installer = new HttpPluginInstaller({ baseUrl });
  const statuses: string[] = [];
  const sync = syncDevelopmentPlugins({ manager, installer, baseUrl, intervalMs: 100,
    onStatus: (_id, status) => statuses.push(status) });
  cleanups.push(() => sync.dispose(), () => manager.dispose());
  return { manager, installer, sync, statuses };
};
describe("directory discovery and reload in independent Workbench clients", () => {
  it("loads immutable builds in a fresh offline client and keeps the active UI while an update is unavailable", async () => {
    online = false;
    entries = [{ ...record, build: { digest: "1".repeat(64), generation: 1 } }];
    const active = client(); await settle();
    expect(active.manager.get(record.pluginId)?.state).toBe("active");
    expect(live).toBe(1);
    expect(requests.every((url) => !url.pathname.includes("/device-services/"))).toBe(true);
    entries = [{ ...record, build: { digest: "3".repeat(64), generation: 2 } }]; registryRevision++;
    await vi.advanceTimersByTimeAsync(200); await settle();
    expect(active.manager.get(record.pluginId)?.state).toBe("active");
    expect(live).toBe(1);
    expect(activations).toBe(1);
    entries = [{ ...record, build: { digest: "2".repeat(64), generation: 3 } }]; registryRevision++;
    await vi.advanceTimersByTimeAsync(200); await settle();
    expect(active.manager.get(record.pluginId)?.scriptContents?.["nested/label.js"]).toBe("export const label = '2';");
    expect(live).toBe(1);
    expect(activations).toBe(2);
  });

  it("loads nested modules and styles using the exact source Node in both clients", async () => {
    const first = client(), second = client();
    await settle();
    expect(first.manager.get(record.pluginId)?.state).toBe("active");
    expect(second.manager.get(record.pluginId)?.state).toBe("active");
    expect(live).toBe(2);
    expect(first.manager.get(record.pluginId)).toMatchObject({
      sourceNodeId: "node:mac",
      scriptContents: { "nested/label.js": "export const label = '1';" },
      styleContents: { "styles.css": ".live { --revision: 1; }" }
    });
    expect(requests.some((url) => url.pathname.endsWith("/nested/label.js"))).toBe(true);
    expect(JSON.parse(localStorage.getItem("zion.installedPlugins") || "[]")).toEqual([]);
    contentRevision++;
    await vi.advanceTimersByTimeAsync(3100); await settle();
    expect(activations).toBe(4);
    expect(live).toBe(2);
    expect(first.manager.get(record.pluginId)?.version).toBe("0.1.0");
    // The clients share this test document; real clients have separate DOMs.
    expect(document.querySelectorAll("style")).toHaveLength(1);
  });

  it("keeps a loaded instance while offline, then refreshes when its source returns", async () => {
    const active = client(); await settle();
    online = false; contentRevision++;
    await vi.advanceTimersByTimeAsync(3100); await settle();
    expect(active.statuses).toContain("offline");
    expect(live).toBe(1); expect(activations).toBe(1);
    online = true;
    await vi.advanceTimersByTimeAsync(3100); await settle();
    expect(activations).toBe(2); expect(live).toBe(1);
  });

  it("removes client instances after unregister without contacting a stopped source", async () => {
    const active = client(); await settle();
    online = false; entries = []; registryRevision++;
    await vi.advanceTimersByTimeAsync(200); await settle();
    expect(active.manager.get(record.pluginId)).toBeNull();
    expect(live).toBe(0);
    expect(document.querySelectorAll("style")).toHaveLength(0);
  });

  it("cancels a source check on disposal before stale code can be activated", async () => {
    let release!: (response: Response) => void;
    const changed = vi.fn();
    const watcher = watchDevelopmentSource({
      baseUrl: `${baseUrl}/v1/device-services/plugin-service/plugins/dev/dev-live?node_id=node%3Amac`,
      loadInitially: true, onChange: changed,
      fetchImpl: () => new Promise<Response>((resolve) => { release = resolve; })
    });
    await settle();
    watcher.dispose();
    release(Response.json({ revision: "late" }));
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(changed).not.toHaveBeenCalled();
  });

  it("serializes successive changes while a reload callback is still pending", async () => {
    let release!: () => void, calls = 0;
    const watcher = watchDevelopmentSource({
      baseUrl: `${baseUrl}/v1/device-services/plugin-service/plugins/dev/dev-live?node_id=node%3Amac`,
      intervalMs: 10,
      onChange: async () => { calls++; await new Promise<void>((resolve) => { release = resolve; }); }
    });
    cleanups.push(() => watcher.dispose());
    await settle(); contentRevision++;
    const pending = watcher.check(); await settle();
    contentRevision++; await watcher.check();
    expect(calls).toBe(1);
    release(); await pending;
    const second = watcher.check(); await settle();
    expect(calls).toBe(2);
    release(); await second;
  });

  it("continues source checks after the client becomes visible again", async () => {
    let visible = true;
    const changed = vi.fn();
    const watcher = watchDevelopmentSource({
      baseUrl: `${baseUrl}/v1/device-services/plugin-service/plugins/dev/dev-live?node_id=node%3Amac`,
      intervalMs: 10, isVisible: () => visible, onChange: changed
    });
    cleanups.push(() => watcher.dispose());
    await settle();
    visible = false; contentRevision++;
    await vi.advanceTimersByTimeAsync(30);
    expect(changed).not.toHaveBeenCalled();
    visible = true;
    await vi.advanceTimersByTimeAsync(15); await settle();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
