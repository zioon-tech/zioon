import { createServer } from "node:http";
import { createHmac, createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { MarketplaceService } from "../src/marketplace/service.mjs";
import { createMarketplaceHttpHandler } from "../src/marketplace/http-handler.mjs";
import { ArtifactStore, artifactHash, createMemoryArtifactStore, createOssArtifactStore,
  artifactStoreFromEnvironment } from "../src/marketplace/artifact-store.mjs";
import { normalizeExtensionPackage, privateExtensionRelease } from "../../../packages/runtime-client/src/extension-package.mjs";
import { digest } from "../src/marketplace/catalog.mjs";
import { createPluginDevelopmentHttpHandler } from "../src/plugin-development-http-handler.mjs";
import { createPluginDevelopmentClient } from "../../../packages/runtime-client/src/plugin-development.mjs";
import { ExtensionExecutionService } from "../src/marketplace/execution-service.mjs";
import { ExtensionHostBridge } from "../src/marketplace/host-bridge.mjs";
import { ExtensionHost } from "../../device-connector/src/extension-host.mjs";
import { CancellationController } from "../../../packages/runtime/dist/index.js";
import { parseExtensionsArgs, runExtensionsCli } from "../src/extensions-cli.mjs";

const artifact = () => normalizeExtensionPackage({ schemaVersion: 1, kind: "plugin",
  manifest: { slug: "storage-test", name: "Storage", summary: "Artifact integration", version: "1.0.0", category: "开发", license: "MIT" },
  plugin: { id: "storage-test", version: "1.0.0", entries: { runtime: "./runtime.mjs", workbench: "./ui.mjs" }, runtime: { apiVersion: 2 } },
  files: { "runtime.mjs": "throw new Error('never imported in Runtime');",
    "ui.mjs": "export const label = 'UI available while Node sleeps';" } });

describe("immutable extension objects and authorized static delivery", () => {
  let db, store, market, alice, bob, server, url, root;
  const sources = new Map(), registrations = new Map();
  beforeAll(async () => {
    db = await createPostgresTestDatabase("artifact_storage");
    alice = (await db.accounts.resolveIdentity({ issuer: "https://storage.test", subject: "alice" })).id;
    bob = (await db.accounts.resolveIdentity({ issuer: "https://storage.test", subject: "bob" })).id;
    store = createMemoryArtifactStore();
    root = await mkdtemp(join(tmpdir(), "zioon-development-"));
    market = await new MarketplaceService({ pool: db.pool, artifactStore: store,
      defaultExecutionConfig: async () => ({ nodeId: "node:fixture", workspaceRoot: root }) }).initialize();
    const handler = createMarketplaceHttpHandler({ service: market });
    const development = createPluginDevelopmentHttpHandler({ marketplace: market, artifactStore: store,
      store: { readKV: async (key) => registrations.get(key),
        deleteKV: async (key, { expectedValue }) => {
          if (JSON.stringify(registrations.get(key)?.value) !== JSON.stringify(expectedValue)) return false;
          return registrations.delete(key);
        } } });
    server = createServer(async (request, response) => {
      // Integration fixture identity; production tests exercise real account auth.
      const id = request.headers["x-fixture-account"];
      if (id) request.zionPrincipal = { kind: "account", user: { id } };
      const target = new URL(request.url, "http://storage.test");
      if (await development(request, response, target) || await handler(request, response, target)) return;
      // Source writes exercise the same client transport; managed filesystem
      // authorization/receipts are independently covered by workspace tests.
      if (target.pathname.startsWith("/v1/device-services/local-tools/files/")) {
        if (!id) { response.writeHead(401); response.end("{}"); return; }
        const payload = request.method === "POST"
          ? JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString()) : {};
        const path = `${id}:${payload.path || target.searchParams.get("path")}`;
        if (request.method === "POST" && request.headers["x-fixture-conflict"]) {
          sources.set(path, "concurrent writer");
          response.writeHead(200); response.end(JSON.stringify({ ok: true, written: false, created: false })); return;
        }
        if (request.method === "POST") sources.set(path, payload.content);
        if (!sources.has(path)) { response.writeHead(404); response.end("{}"); return; }
        response.writeHead(200); response.end(JSON.stringify({ content: sources.get(path), content_hash: "fixture" })); return;
      }
      response.writeHead(404); response.end("{}");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => { await db.pool.query("TRUNCATE marketplace_accounts,marketplace_private_releases,marketplace_development_releases"); sources.clear(); registrations.clear(); });
  afterAll(async () => {
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await db?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("automatically installs managed development builds, switches real handlers and rolls back failed metadata commits", async () => {
    const client = createPluginDevelopmentClient({ baseUrl: url, headers: { "x-fixture-account": alice } });
    const plugin = { id: "dev.automatic", name: "Automatic", version: "1.0.0",
      entries: { runtime: "./runtime.mjs" }, runtime: { apiVersion: 2 },
      capabilities: [{ id: "hello", kind: "tool", host: "runtime" }] };
    const build = (message) => ({ schemaVersion: 1, manifest: plugin,
      files: { "runtime.mjs": `export function activateRuntimePlugin(c) {
        c.tools.registerTool({ name: "hello", execution: { effect: "read", idempotency: "safe" },
          invoke() { return ${JSON.stringify(message)}; } }); return {};
      }` } });
    const first = await client.start("/local/source", undefined, { build: build("first function") });
    expect(first.backend.status).toBe("installed");
    expect(first.build.hasWorkbench).toBe(false);
    const id = first.backend.listingId;
    const epoch = first.backend.epoch;
    expect((await market.executionFor(alice, id)).install.config.nodeId).toBe("node:fixture");
    const host = new ExtensionHost();
    const bridge = new ExtensionHostBridge({ tools: () => null, hasNativeHost: () => true,
      nativeInvoke: (invocation, signal) => host.invoke(invocation.toolCall.arguments, signal, invocation) });
    const execution = new ExtensionExecutionService({ marketplace: market, hostBridge: bridge, allowNode: () => true });
    const context = { principal: { userId: alice }, runId: "run:dev", invocationId: "inv:dev:1",
      signal: new CancellationController().signal, policy: { preset: "trusted-automation", allowedTools: ["write", "Bash"], fileRoots: [root] } };
    try {
      const called = await execution.invoke({ action: "call", listingId: id, epoch, tool: "hello" }, context);
      expect(JSON.parse(called.content).result).toBe("first function");
      const state = await client.snapshot();
      const input = { expectedRevision: state.revision, generation: 2, build: build("second function") };
      const compete = await Promise.all([1, 2].map(() => fetch(`${url}/v1/workbench-state/plugin-development/dev.automatic/builds`,
        { method: "PUT", headers: { "content-type": "application/json", "x-fixture-account": alice }, body: JSON.stringify(input) })));
      expect(compete.map((r) => r.status).sort()).toEqual([200, 409]);
      const second = (await client.snapshot()).entries[0];
      expect(second.backend.epoch).not.toBe(epoch);
      await expect(market.executionFor(alice, id, epoch)).rejects.toMatchObject({ code: "extension_changed" });
      const next = await execution.invoke({ action: "call", listingId: id, epoch: second.backend.epoch, tool: "hello" },
        { ...context, invocationId: "inv:dev:2" });
      expect(JSON.parse(next.content).result).toBe("second function");
      await db.pool.query(`CREATE FUNCTION reject_dev_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.state_json->'development'->'entries'->0->'build'->>'generation'='3'
          THEN RAISE EXCEPTION 'fixture_transaction_failure'; END IF; RETURN NEW; END; $$;
        CREATE TRIGGER reject_dev_update BEFORE UPDATE ON marketplace_accounts
          FOR EACH ROW EXECUTE FUNCTION reject_dev_update();`);
      await expect(client.publish(plugin.id, build("must roll back"))).rejects.toThrow("fixture_transaction_failure");
      expect((await client.snapshot()).entries[0].build.digest).toBe(second.build.digest);
      expect((await market.executionFor(alice, id)).install.executionEpoch).toBe(second.backend.epoch);
      expect((await db.pool.query("SELECT 1 FROM marketplace_development_releases WHERE version='0.0.3'")).rowCount).toBe(0);
      await db.pool.query("DROP TRIGGER reject_dev_update ON marketplace_accounts; DROP FUNCTION reject_dev_update()");
      expect((await market.snapshot(bob)).entries.some((e) => e.id === id)).toBe(false);
      expect(JSON.stringify(await market.account(alice))).not.toContain("second function");
      const fresh = new MarketplaceService({ pool: db.pool, artifactStore: store });
      expect((await fresh.account(alice)).development.entries[0].backend.epoch).toBe(second.backend.epoch);
      await client.stop(plugin.id);
      await expect(market.executionFor(alice, id)).rejects.toMatchObject({ code: "extension_disabled" });
    } finally {
      await db.pool.query("DROP TRIGGER IF EXISTS reject_dev_update ON marketplace_accounts; DROP FUNCTION IF EXISTS reject_dev_update()");
      await host.close();
    }
  }, 30000);

  it("removes the legacy private registry only after successful authoritative DB migration", async () => {
    const key = `runtime.plugins.development.private.${createHash("sha256").update(alice).digest("hex")}`;
    registrations.set(key, { value: { schemaVersion: 1, revision: 3, entries: [] } });
    const client = createPluginDevelopmentClient({ baseUrl: url, headers: { "x-fixture-account": alice } });
    expect((await client.snapshot()).revision).toBe(3);
    const migrated = await fetch(`${url}/v1/workbench-state/plugin-development`, {
      method: "PUT", headers: { "content-type": "application/json", "x-fixture-account": alice },
      body: JSON.stringify({ expectedRevision: 3, record: { pluginId: "dev.migrate", name: "Migrate", version: "1.0.0",
        nodeId: "node:fixture", directory: root, devId: "dev-migrate" } })
    });
    expect(migrated.status, await migrated.clone().text()).toBe(200);
    expect((await market.account(alice)).development.revision).toBe(4);
    expect(registrations.has(key)).toBe(false);
    expect((await client.snapshot()).entries[0].pluginId).toBe("dev.migrate");
  });

  it("starts the generated one-function template from a local directory without manual Node configuration", async () => {
    const directory = join(root, "managed-cli");
    const output = { write() {} };
    await runExtensionsCli({ parsed: parseExtensionsArgs(["init", directory, "--kind", "plugin"]), output });
    const started = await runExtensionsCli({ parsed: parseExtensionsArgs(["dev", "start", directory]), output,
      baseUrl: url, headers: { "x-fixture-account": alice } });
    expect(started.source.nodeId).toBe("managed:account");
    expect(started.backend.status).toBe("installed");
    expect(sources.get(`${alice}:/workspace/.zion/plugins/managed-cli/runtime.mjs`)).toContain("defineToolPlugin");
    const host = new ExtensionHost();
    const bridge = new ExtensionHostBridge({ tools: () => null, hasNativeHost: () => true,
      nativeInvoke: (input, signal) => host.invoke(input.toolCall.arguments, signal, input) });
    try {
      const execution = new ExtensionExecutionService({ marketplace: market, hostBridge: bridge, allowNode: () => true });
      const result = await execution.invoke({ action: "call", listingId: started.backend.listingId,
        epoch: started.backend.epoch, tool: "hello", arguments: { name: "Workbench" } }, {
        principal: { userId: alice }, runId: "run:cli", invocationId: "inv:cli:1",
        signal: new CancellationController().signal,
        policy: { preset: "trusted-automation", allowedTools: ["write", "Bash"], fileRoots: [root] }
      });
      expect(JSON.parse(result.content).result.content).toBe("Hello, Workbench");
    } finally { await host.close(); }
  }, 30000);

  it("validates declarative public settings and resolves defaults and private credentials only in the Node", async () => {
    const original = artifact();
    const packed = normalizeExtensionPackage({ ...original, digest: undefined, plugin: { ...original.plugin,
      settingsSchema: { type: "object", additionalProperties: false, properties: {
        greeting: { type: "string", default: "hello" },
        count: { type: "integer", minimum: 1, maximum: 5 }
      } },
      connection: { label: "Test service", envKeys: ["MODEL_API_KEY"] }
    }, files: { ...original.files, "runtime.mjs": `export function activateRuntimePlugin(c) {
      c.tools.registerTool({name:"settings",execution:{effect:"read",idempotency:"safe"},
        invoke(input, ctx) { return { greeting:ctx.settings.greeting, count:ctx.settings.count,
          credentialAvailable: Boolean(ctx.env.MODEL_API_KEY) }; }}); return {};
    }` } });
    const { release } = await market.uploadPrivate(alice, "Alice", { artifact: packed, expectedRevision: 0 });
    await market.install(alice, release.id, { version: release.version, digest: release.digest });
    const path = join(root, "settings-credentials.json");
    await writeFile(path, JSON.stringify({ listingId: release.id, accountId: alice, env: { MODEL_API_KEY: "node-only-secret" } }), { mode: 0o600 });
    const config = { nodeId: "node:fixture", workspaceRoot: root, credentialsFile: path };
    await expect(market.configure(alice, release.id, { expectedRevision: 2, config: { ...config, settings: { count: 20 } } }))
      .rejects.toMatchObject({ code: "invalid_extension_settings" });
    await expect(market.configure(alice, release.id, { expectedRevision: 2, config: { ...config, settings: { apiKey: "must-not-store" } } }))
      .rejects.toMatchObject({ code: "invalid_extension_package" });
    const saved = await market.configure(alice, release.id, { expectedRevision: 2, config: { ...config, settings: { count: 2 } } });
    const effective = await market.executionFor(alice, release.id);
    expect(effective.install.config.settings).toEqual({ greeting: "hello", count: 2 });
    expect(effective.configDigest).toBe((await market.assertExecution(alice, release.id)).configDigest);
    const host = new ExtensionHost();
    const bridge = new ExtensionHostBridge({ tools: () => null, hasNativeHost: () => true,
      nativeInvoke: (input, signal) => host.invoke(input.toolCall.arguments, signal, input) });
    try {
      const execution = new ExtensionExecutionService({ marketplace: market, hostBridge: bridge, allowNode: () => true });
      const result = await execution.invoke({ action: "call", listingId: release.id,
        epoch: saved.installation.executionEpoch, tool: "settings" }, {
        principal: { userId: alice }, runId: "run:settings", invocationId: "inv:settings:1",
        signal: new CancellationController().signal,
        policy: { preset: "trusted-automation", allowedTools: ["write", "Bash"], fileRoots: [root] }
      });
      expect(JSON.parse(result.content).result).toEqual({ greeting: "hello", count: 2, credentialAvailable: true });
      expect(JSON.stringify(await market.snapshot(alice))).not.toContain("node-only-secret");
    } finally { await host.close(); }
  }, 30000);

  it("stores no source bytes in catalog/database, and serves installed UI without invoking a Node", async () => {
    const packed = artifact();
    const { release } = await market.uploadPrivate(alice, "Alice", { artifact: packed, expectedRevision: 0 });
    await market.install(alice, release.id, { version: release.version, digest: release.digest });
    const raw = (await db.pool.query("SELECT manifest_json FROM marketplace_private_releases")).rows[0].manifest_json;
    expect(raw.artifact.files).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain(packed.files["runtime.mjs"]);
    const snapshot = await market.snapshot(alice);
    expect(snapshot.entries.find((e) => e.id === release.id).installedRelease.artifact.files).toBeUndefined();
    const prefix = `/v1/marketplace/releases/${release.id}/${release.version}`;
    const loaded = await fetch(url + prefix + "/files/ui.mjs", { headers: { "x-fixture-account": alice } });
    expect(loaded.status).toBe(200);
    expect(loaded.headers.get("content-type")).toContain("text/javascript");
    expect(await loaded.text()).toBe(packed.files["ui.mjs"]);
    expect((await (await fetch(url + prefix + "/artifact", { headers: { "x-fixture-account": alice } })).json()).artifact.digest).toBe(packed.digest);
    expect((await fetch(url + prefix + "/files/ui.mjs", { headers: { "x-fixture-account": bob } })).status).toBe(404);
    expect((await fetch(url + prefix + "/artifact")).status).toBe(401);
  });

  it("copies and verifies legacy bytes before removing them, preserving installation/version digests", async () => {
    const packed = artifact(), legacy = privateExtensionRelease(packed, alice, "Alice");
    await db.pool.query(`INSERT INTO marketplace_private_releases
      (user_id,listing_id,version,digest,artifact_digest,manifest_json,published_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [alice, legacy.id, legacy.version, digest(legacy), packed.digest, legacy, Date.now()]);
    await market.install(alice, legacy.id, { version: legacy.version, digest: digest(legacy) });
    await market.configure(alice, legacy.id, { expectedRevision: 1, config: { nodeId: "node:account", workspaceRoot: "/workspace" } });
    const unavailable = new MarketplaceService({ pool: db.pool, artifactStore: new ArtifactStore({
      async put() { throw new Error("storage unavailable"); }, async get() { throw new Error("unreachable"); }
    }) });
    await expect(unavailable.migrateInlineContent()).rejects.toThrow("storage unavailable");
    expect((await db.pool.query("SELECT manifest_json FROM marketplace_private_releases")).rows[0].manifest_json.artifact.files).toEqual(packed.files);
    expect((await market.migrateInlineContent()).migrated).toBe(1);
    expect((await market.migrateInlineContent()).migrated).toBe(0);
    const restored = await new MarketplaceService({ pool: db.pool, artifactStore: store }).initialize();
    expect((await restored.executionFor(alice, legacy.id)).artifact).toEqual(packed);
    expect((await restored.account(alice)).installations[legacy.id].digest).toBe(digest(legacy));
  });

  it("stores Skill and draft text as objects while retaining authenticated editing and context access", async () => {
    const input = { slug: "draft-storage", name: "Draft", summary: "Test", category: "开发", version: "1.0.0", license: "MIT",
      sourceUrl: "https://example.test/skill", body: "---\nname: draft\ndescription: Test\n---\n\nUnique Skill text" };
    const saved = await market.saveContribution(alice, "Alice", input);
    const raw = (await market.account(alice)).contributions[saved.contribution.id];
    expect(raw.manifest.components[0].body).toBeUndefined();
    expect((await market.contributionFor(alice, raw.id)).manifest.components[0].body).toBe(input.body);
    await expect(market.contributionFor(bob, raw.id)).rejects.toMatchObject({ code: "contribution_not_found" });
  });

  it("unregisters development sources during an object-store outage without re-reading other builds", async () => {
    const client = createPluginDevelopmentClient({ baseUrl: url, headers: { "x-fixture-account": alice } });
    const build = (id) => ({ schemaVersion: 1, manifest: { id, name: id, version: "1.0.0",
      entries: { runtime: "./runtime.mjs" }, runtime: { apiVersion: 2 } },
      files: { "runtime.mjs": "export function activateRuntimePlugin() { return {}; }" } });
    const first = await client.start("/local/one", undefined, { build: build("dev.offline-one") });
    const second = await client.start("/local/two", undefined, { build: build("dev.offline-two") });
    const get = vi.spyOn(store, "get").mockRejectedValue(new Error("object store offline"));
    try {
      await client.stop(first.source.pluginId);
      expect(get).not.toHaveBeenCalled();
      const state = await client.snapshot();
      expect(state.entries).toHaveLength(1);
      expect(state.entries[0].backend.epoch).toBe(second.backend.epoch);
      expect((await market.account(alice)).installations[second.backend.listingId].executionEpoch).toBe(second.backend.epoch);
      expect((await market.account(alice)).installations[first.backend.listingId]).toBeUndefined();
    } finally { get.mockRestore(); }
  });
  it("rejects lost source writes and oversized Runtime builds before publishing a development installation", async () => {
    const client = createPluginDevelopmentClient({ baseUrl: url,
      headers: { "x-fixture-account": alice, "x-fixture-conflict": "true" } });
    const build = { schemaVersion: 1, manifest: { id: "dev.conflict", name: "Conflict", version: "1.0.0",
      entries: { runtime: "./runtime.mjs" }, runtime: { apiVersion: 2 } },
      files: { "runtime.mjs": "export function activateRuntimePlugin(){return {};}" } };
    await expect(client.start("/local/source", undefined, { build })).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await client.snapshot()).entries).toEqual([]);
    sources.clear();
    await expect(client.start("/local/source", undefined, { build: { ...build,
      files: { "runtime.mjs": "//" + "x".repeat(210000) } } })).rejects.toMatchObject({ code: "invalid_development_build" });
    expect(sources.size).toBe(0);
  });
  it("ignores imports in comments and refuses local symlink assets before staging their content", async () => {
    const directory = join(root, "syntax-cli");
    const output = { write() {} };
    await runExtensionsCli({ parsed: parseExtensionsArgs(["init", directory, "--kind", "plugin"]), output });
    await writeFile(join(directory, "runtime.mjs"), `// import "./missing.mjs";
      const example = "import './also-missing.mjs'";
      export function activateRuntimePlugin() { return {}; }`);
    const started = await runExtensionsCli({ parsed: parseExtensionsArgs(["dev", "start", directory]),
      output, baseUrl: url, headers: { "x-fixture-account": alice } });
    expect(started.backend.status).toBe("installed");
    sources.clear();
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ ...manifest, assets: ["./data.json"] }));
    const privateFile = join(root, "outside-source.json");
    await writeFile(privateFile, '{"value":"private-file-must-not-upload"}');
    await symlink(privateFile, join(directory, "data.json"));
    await expect(runExtensionsCli({ parsed: parseExtensionsArgs(["dev", "start", directory]),
      output, baseUrl: url, headers: { "x-fixture-account": alice } })).rejects.toThrow("symlinks");
    expect(sources.size).toBe(0);
  });
});

describe("artifact object integrity and production configuration", () => {
  it("rejects corrupted storage on write verification and reads", async () => {
    const store = new ArtifactStore({ async put() {}, async get() { return Buffer.from("{}"); } });
    await expect(store.put({ payload: "original" })).rejects.toMatchObject({ code: "artifact_integrity_error" });
    await expect(store.get({ schemaVersion: 1, digest: artifactHash(Buffer.from("original")), bytes: 8 }))
      .rejects.toMatchObject({ code: "artifact_integrity_error" });
    expect(() => artifactStoreFromEnvironment({ ZION_ARTIFACT_STORE: "local", ZION_ENV: "production", ZION_ARTIFACT_DIRECTORY: "/tmp" }))
      .toThrow("explicit development mode");
    expect(() => artifactStoreFromEnvironment({})).toThrow("ZION_ARTIFACT_STORE=oss");
  });

  it("signs private OSS requests, disables redirects, and verifies read-back bytes", async () => {
    let bytes;
    const calls = [];
    const fetchImpl = vi.fn(async (url, request) => {
      calls.push({ url, request });
      if (request.method === "PUT") { bytes = Buffer.from(request.body); return new Response(null, { status: 200 }); }
      return new Response(bytes, { status: 200 });
    });
    const store = createOssArtifactStore({ endpoint: "https://oss-cn-test.aliyuncs.com", bucket: "zioon-artifacts-test",
      accessKeyId: "fixture-id", accessKeySecret: "fixture-secret", securityToken: "fixture-session", fetchImpl });
    const ref = await store.put({ value: "immutable" });
    expect(await store.get(ref)).toEqual({ value: "immutable" });
    for (const { url, request } of calls) {
      const type = request.headers["content-type"] || "";
      const signature = createHmac("sha1", "fixture-secret")
        .update(`${request.method}\n\n${type}\n${request.headers.date}\nx-oss-security-token:fixture-session\n/zioon-artifacts-test/zioon/artifacts/${ref.digest}.json`)
        .digest("base64");
      expect(request.headers.authorization).toBe(`OSS fixture-id:${signature}`);
      expect(request.redirect).toBe("error");
      expect(url).toBe(`https://zioon-artifacts-test.oss-cn-test.aliyuncs.com/zioon/artifacts/${ref.digest}.json`);
    }
  });
});
