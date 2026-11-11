import { createServer } from "node:http";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CancellationController, dispatchRunHook } from "../../../packages/runtime/src/index";
import { createHttpRunController, createScriptRunController } from "../src/runtime-hook-adapters.mjs";
import { createExtensionHttpTransport, publicAddress } from "../src/extension-http-transport.mjs";
import { parseRuntimeHookRequest, signedRuntimeHookResponse, verifyRuntimeExtension } from "../../../packages/plugin-sdk/src/runtime-extension-signature.mjs";

const resources = [];
afterEach(async () => { for (const cleanup of resources.splice(0).reverse()) await cleanup(); });
const secret = "hook-test-signing-secret-32-bytes-long";
const context = () => ({
  schemaVersion: 1, stage: "beforeModel", controllerId: "external", idempotencyKey: "run:beforeModel:external",
  runId: "run", attemptId: "attempt", turn: 1, messages: [{ role: "user", content: "hello" }],
  request: { principal: { spaceId: "space", userId: "user", grantId: "private-grant" } },
  signal: new CancellationController().signal
});
async function server(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  resources.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function script(source, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zion-hook-test-"));
  resources.push(() => rm(directory, { recursive: true, force: true }));
  const modulePath = join(directory, "hook.mjs");
  await writeFile(modulePath, source);
  return createScriptRunController({ id: "external", stages: ["beforeModel"], modulePath, ...options }, { allowScripts: true });
}

describe("isolated Hook adapters", () => {
  it("authenticates HTTP requests and decisions without leaking execution grants", async () => {
    const origin = await server(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const parsed = parseRuntimeHookRequest(secret, { body: Buffer.concat(chunks).toString("utf8"), headers: request.headers });
      expect(JSON.stringify(parsed.context)).not.toContain("private-grant");
      expect(parsed.context.owner).toEqual({ spaceId: "space", userId: "user" });
      response.end(JSON.stringify(signedRuntimeHookResponse(secret, parsed, { action: "pause", reason: "Review required" })));
    });
    const adapter = createHttpRunController({
      id: "external", stages: ["beforeModel"], endpoint: `${origin}/hook`, secretRef: "test"
    }, { secret: () => secret, trustedOrigins: [origin], transport: createExtensionHttpTransport({ trustedOrigins: [origin] }) });
    expect(await dispatchRunHook(adapter, context())).toEqual({ action: "pause", reason: "Review required" });
  });

  it("fails closed for unsigned decisions and rejects stale or tampered requests", async () => {
    const adapter = createHttpRunController({
      id: "external", stages: ["beforeModel"], endpoint: "https://example.com/hook", secretRef: "test"
    }, { secret: () => secret, transport: async () => ({ status: 200, body: '{"response":{"schemaVersion":1,"decision":{"action":"pass"}},"signature":"v1=0000"}' }) });
    await expect(dispatchRunHook(adapter, context())).rejects.toThrow("Hook failed");
    expect(verifyRuntimeExtension(secret, { timestamp: "1", id: "id", body: "tampered", signature: `v1=${"0".repeat(64)}` })).toBe(false);
  });

  it("pins DNS, rejects private/mapped addresses and never follows redirects", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "2001:db8::1"]) {
      expect(publicAddress(ip)).toBe(false);
    }
    expect(publicAddress("8.8.8.8")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
    const transport = createExtensionHttpTransport({ resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }] });
    await expect(transport({ endpoint: "https://example.com/", body: "{}" })).rejects.toThrow("restricted address");
    let calls = 0;
    const origin = await server((_request, response) => { calls++; response.writeHead(302, { location: "/target" }); response.end(); });
    const response = await createExtensionHttpTransport({ trustedOrigins: [origin] })({ endpoint: origin, body: "{}" });
    expect(response.status).toBe(302);
    expect(calls).toBe(1);
  });

  it("bounds DNS stalls, response size and request duration", async () => {
    const stalled = createExtensionHttpTransport({ resolve: () => new Promise(() => {}) });
    await expect(stalled({ endpoint: "https://example.com", body: "{}", timeoutMs: 10 })).rejects.toThrow("timed out");
    const origin = await server((_request, response) => response.end("x".repeat(100)));
    await expect(createExtensionHttpTransport({ trustedOrigins: [origin] })({
      endpoint: origin, body: "{}", maxResponseBytes: 10
    })).rejects.toThrow("limit");
  });

  it("runs a real script in a fresh process with a minimal environment", async () => {
    process.env.ZION_TEST_PARENT_SECRET = "private";
    try {
      const adapter = await script('export async function handle(context) { return { action: "pause", reason: context.owner.userId + ":" + String(process.env.ZION_TEST_PARENT_SECRET) }; }');
      expect(await dispatchRunHook(adapter, context())).toEqual({ action: "pause", reason: "user:undefined" });
    } finally { delete process.env.ZION_TEST_PARENT_SECRET; }
  });

  it("terminates hung scripts, bounds stdout and supports explicit fail-open policy", async () => {
    const hung = await script("export async function handle() { setInterval(() => {},1000); await new Promise(() => {}); }", { timeoutMs: 60 });
    await expect(dispatchRunHook(hung, context())).rejects.toThrow("Hook failed");
    const flood = await script('export async function handle() { process.stdout.write("x".repeat(70000)); return { action: "pass" }; }', { failurePolicy: "fail-open" });
    expect(await dispatchRunHook(flood, context())).toEqual({ action: "pass" });
  });

  it("rejects script execution without operator opt-in", () => {
    expect(() => createScriptRunController({ id: "external", stages: ["beforeModel"], modulePath: "/tmp/hook.mjs" })).toThrow("operator opt-in");
  });

  it("accepts a successful return while retiring helpers that inherit its pipes", async () => {
    if (process.platform === "win32") return;
    const adapter = await script(`
      import { spawn } from "node:child_process";
      export async function handle() {
        const helper = spawn(process.execPath, ["-e",
          'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: "inherit" });
        helper.unref();
        return { action: "pass" };
      }`, { timeoutMs: 2000 });
    expect(await dispatchRunHook(adapter, context())).toEqual({ action: "pass" });
  });

  it("terminates a script's helper process even when that helper ignores SIGTERM", async () => {
    if (process.platform === "win32") return; // Windows taskkill requires native-host acceptance.
    const directory = await mkdtemp(join(tmpdir(), "zion-hook-descendant-"));
    resources.push(() => rm(directory, { recursive: true, force: true }));
    const pidPath = join(directory, "helper.pid");
    const adapter = await script(`
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      export async function handle() {
        const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: "ignore" });
        writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
        await new Promise(() => {});
      }`, { timeoutMs: 1200 });
    const task = dispatchRunHook(adapter, context()).then(() => null, (error) => error);
    let pid;
    try {
      await vi.waitFor(async () => { pid = Number(await readFile(pidPath, "utf8")); expect(pid).toBeGreaterThan(0); });
      expect(await task).toBeInstanceOf(Error);
      await vi.waitFor(() => {
        let alive = true;
        try { process.kill(pid, 0); } catch { alive = false; }
        expect(alive).toBe(false);
      }, { timeout: 3000, interval: 20 });
    } finally { if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} } await task; }
  });
});
