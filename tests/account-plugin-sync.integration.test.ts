import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginManager } from "../src/plugin/manager";
import { HttpPluginInstaller } from "../src/plugin/http-installer";
import { syncAccountPlugins } from "../src/plugin/account-sync";

const baseUrl = "https://runtime.test", pluginId = "account.ui", listingId = "private.user.ui";
const manifest = { manifestVersion: 2, id: pluginId, name: "Account UI", version: "1.0.0",
  entries: { workbench: "./ui.mjs" } };
let snapshot: any, unavailable: boolean, content: string, live: number;
let requests: URL[];
const cleanup: (() => void | Promise<void>)[] = [];
const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
beforeEach(() => {
  localStorage.clear(); vi.useFakeTimers();
  live = 0; requests = []; unavailable = false; content = "export function activate() {}";
  snapshot = { accountId: "alice", entries: [{
    id: listingId, installation: { enabled: true, version: "1.0.0", digest: "a".repeat(64), executionEpoch: "first" },
    installedRelease: { status: "private", artifact: { plugin: manifest } }
  }] };
  let blob = 0;
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => `blob:account-${++blob}`) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    const url = new URL(input); requests.push(url);
    if (url.pathname.endsWith("/snapshot")) return Response.json(structuredClone(snapshot));
    if (unavailable) return Response.json({ error: "object unavailable" }, { status: 503 });
    if (url.pathname.endsWith("/manifest.json")) return Response.json(manifest);
    if (url.pathname.endsWith("/ui.mjs")) return new Response(content);
    throw new Error(`Unexpected Node or tool request: ${url}`);
  }));
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
});
const settle = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };
const start = () => {
  const manager = new PluginManager({ pluginDir: "", logLevel: "error" });
  vi.spyOn((manager as any).loader, "loadModule").mockImplementation(async () => ({
    activate(context: any) { live++; context.subscriptions.push({ dispose() { live--; } }); }
  }));
  const statuses: string[] = [];
  const sync = syncAccountPlugins({ manager, installer: new HttpPluginInstaller({ baseUrl }),
    baseUrl, intervalMs: 100, onStatus: (_id, status) => statuses.push(status) });
  cleanup.push(() => sync.dispose(), () => manager.dispose());
  return { manager, sync, statuses };
};
describe("installed account UI delivery without an execution Host", () => {
  it("loads the effective private revision for the unchanged publisher version", async () => {
    const { manager } = start(); await settle();
    const originalDigest = snapshot.entries[0].installation.digest;
    snapshot.entries[0].installation.activeRevision = { digest: "c".repeat(64) };
    snapshot.entries[0].installation.executionEpoch = "personal";
    content = "export function activate() { /* account edit */ }";
    await vi.advanceTimersByTimeAsync(110); await settle();
    expect(manager.get(pluginId)?.accountInstallation?.digest).toBe("c".repeat(64));
    expect(manager.get(pluginId)?.accountInstallation?.epoch).toBe("personal");
    expect(snapshot.entries[0].installation.digest).toBe(originalDigest);
    expect(requests.some((url) => url.pathname.includes(`/installations/${listingId}/revisions/${"c".repeat(64)}/files/`))).toBe(true);
    expect(manager.get(pluginId)?.state).toBe("active");
    expect(live).toBe(1);
  });
  it("loads and activates a fresh client from static release files without caching another account's code", async () => {
    const { manager } = start(); await settle();
    expect(manager.get(pluginId)?.state).toBe("active");
    expect(manager.get(pluginId)?.origin).toBe("account");
    expect(live).toBe(1);
    expect(requests.every((url) => url.pathname.startsWith("/v1/marketplace/"))).toBe(true);
    expect(JSON.parse(localStorage.getItem("zion.installedPlugins") || "[]")).toEqual([]);
  });
  it("loads a valid immutable UI containing commented import examples without requesting missing files", async () => {
    content = `// import "./removed.mjs";
      const example = 'import "./also-removed.mjs";';
      export function activate() { return example; }`;
    const { manager } = start(); await settle();
    expect(manager.get(pluginId)?.state).toBe("active");
    expect(requests.some((url) => url.pathname.includes("removed.mjs"))).toBe(false);
  });

  it("applies account disable and uninstall in an already open Workbench", async () => {
    const { manager } = start(); await settle();
    snapshot.entries[0].installation.enabled = false;
    await vi.advanceTimersByTimeAsync(110); await settle();
    expect(live).toBe(0);
    snapshot.entries[0].installation.enabled = true;
    snapshot.entries[0].installation.executionEpoch = "enabled";
    await vi.advanceTimersByTimeAsync(110); await settle();
    expect(live).toBe(1);
    snapshot.entries = [];
    await vi.advanceTimersByTimeAsync(110); await settle();
    expect(manager.get(pluginId)).toBeNull();
    expect(live).toBe(0);
  });

  it("keeps the active version when new immutable files cannot be read and removes it after account changes", async () => {
    const { manager, statuses } = start(); await settle();
    snapshot.entries[0].installation.digest = "b".repeat(64);
    unavailable = true;
    await vi.advanceTimersByTimeAsync(110); await settle();
    expect(statuses).toContain("load-error");
    expect(manager.get(pluginId)?.accountInstallation?.digest).toBe("a".repeat(64));
    expect(live).toBe(1);
    snapshot.accountId = "bob"; snapshot.entries = [];
    await vi.advanceTimersByTimeAsync(110); await settle();
    expect(manager.get(pluginId)).toBeNull();
    expect(live).toBe(0);
  });

  it("rechecks the installation epoch after fetching files so a revoked UI is not activated", async () => {
    const fetchImpl = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input, options) => {
      const response = await fetchImpl(input, options);
      if (new URL(String(input)).pathname.endsWith("/ui.mjs")) snapshot.entries[0].installation.enabled = false;
      return response;
    }));
    const { manager } = start(); await settle();
    expect(manager.get(pluginId)).toBeNull();
    expect(live).toBe(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:account-1");
  });
  it("does not overwrite a development UI installed while the account artifact is downloading", async () => {
    const fetchImpl = globalThis.fetch;
    let fixture: ReturnType<typeof start>, inserted = false;
    vi.stubGlobal("fetch", vi.fn(async (input, options) => {
      const response = await fetchImpl(input, options);
      const url = new URL(String(input));
      if (!inserted && url.pathname.startsWith("/v1/marketplace/") && url.pathname.endsWith("/ui.mjs")) {
        inserted = true;
        const loaded = await new HttpPluginInstaller({ baseUrl }).installFromDevBase(`${baseUrl}/fixture-dev`, "dev-override");
        expect(loaded.success).toBe(true);
        await fixture.manager.installFromInfo(loaded.plugin!);
      }
      return response;
    }));
    fixture = start(); await settle();
    expect(fixture.manager.get(pluginId)?.origin).toBe("dev");
    expect(fixture.statuses).toContain("identity-conflict");
    expect(live).toBe(1);
  });
  it("removes obsolete local code when another client changes a disabled installation's version", async () => {
    const { manager } = start(); await settle();
    snapshot.entries[0].installation.enabled = false;
    snapshot.entries[0].installation.version = "2.0.0";
    snapshot.entries[0].installation.digest = "b".repeat(64);
    await vi.advanceTimersByTimeAsync(110); await settle();
    expect(manager.get(pluginId)).toBeNull();
    expect(live).toBe(0);
  });
});
