import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresTestDatabase, provisionTestTeam } from "./helpers/postgres-test-database.mjs";
import { AccountAccessControl } from "../src/accounts/account-access-control.mjs";
import { PostgresAccessStore } from "../src/postgres-access-store.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { MarketplaceService } from "../src/marketplace/service.mjs";
import { createMarketplaceHttpHandler } from "../src/marketplace/http-handler.mjs";
import { createSkillsCatalogHttpHandler } from "../src/skills-catalog-http-handler.mjs";
import { normalizeSkillPackage } from "../../../packages/runtime-client/src/skill-package.mjs";
import { normalizeExtensionPackage } from "../../../packages/runtime-client/src/extension-package.mjs";
import { activateRuntimePlugin } from "../../../extensions/dev.skills/runtime.js";

const exec = promisify(execFile);
const entry = new URL("../bin/zion.mjs", import.meta.url).pathname;
describe("private Skill CLI lifecycle through authenticated account HTTP", () => {
  let db, market, workbench, server, url, directory, alice, bob, tokens, config;
  beforeAll(async () => {
    db = await createPostgresTestDatabase("extensions_cli");
    alice = await provisionTestTeam(db, { spaceId: "space:extensions-cli" });
    bob = await db.accounts.resolveIdentity({ issuer: "https://identity.test", subject: "bob" });
    await db.accounts.acceptInvitation(bob.id, (await db.accounts.invite(alice.id, {}, "space:extensions-cli")).token);
    tokens = new Map(await Promise.all([alice, bob].map(async (user) => [user.id,
      (await db.accounts.createSession(user.id, { activeSpaceId: "space:extensions-cli" })).token])));
    market = await new MarketplaceService({ pool: db.pool }).initialize();
    workbench = await new PostgresWorkbenchStateStore(db.pool, { spaceId: "space:extensions-cli" }).initialize();
    const access = new AccountAccessControl({ accounts: db.accounts,
      store: new PostgresAccessStore(db.pool, { spaceId: "space:extensions-cli" }),
      publicBaseUrl: "https://workbench.test", oidc: { secureCookies: true }, servedSpaceId: "space:extensions-cli" });
    const handlers = [createMarketplaceHttpHandler({ service: market }), createSkillsCatalogHttpHandler({ store: workbench, marketplace: market })];
    server = createServer(async (req, res) => {
      try {
        req.zionPrincipal = await access.authorizeRuntimeRequest(req);
        for (const handler of handlers) if (await handler(req, res, new URL(req.url, "http://runtime.test"))) return;
        res.writeHead(404); res.end();
      } catch (error) {
        res.writeHead(error.statusCode || 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: error.code, error: error.message }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${server.address().port}`;
    directory = await mkdtemp(join(tmpdir(), "zion-extensions-cli-"));
    config = join(directory, "cli.json");
    await writeFile(config, JSON.stringify({ version: 1, profiles: { test: { url,
      auth: { type: "bearer", env: "ZION_TEST_ACCOUNT_TOKEN" } } } }), { mode: 0o600 });
  });
  beforeEach(async () => { await db.pool.query("TRUNCATE marketplace_accounts, marketplace_private_releases"); });
  afterAll(async () => {
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await db?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const cli = async (user, ...args) => {
    const { stdout } = await exec(process.execPath, [entry, "extensions", ...args, "--jsonl", "--runtime-profile", "test"], {
      env: { ...process.env, ZION_RUNTIME_CLI_CONFIG: config, ZION_RUNTIME_PROFILE: "", ZION_RUNTIME_URL: "",
        ZION_TEST_ACCOUNT_TOKEN: user ? tokens.get(user.id) : "" }, timeout: 15000
    });
    return JSON.parse(stdout.trim()).value;
  };
  const call = async (user, path, method = "GET", body) => {
    const response = await fetch(url + path, { method, headers: { authorization: `Bearer ${tokens.get(user.id)}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const artifact = (version = "0.1.0", body = "# Private instructions\nUse verified evidence.") => normalizeSkillPackage({
    schemaVersion: 1, kind: "skill", manifest: { slug: "my-skill", name: "My Skill", summary: "Personal evidence guide",
      version, category: "开发", license: "UNLICENSED" },
    body: `---\nname: my-skill\ndescription: Personal evidence guide\n---\n\n${body}`
  });

  it("creates, validates and packs offline even without a usable endpoint or credential", async () => {
    const project = join(directory, "offline-skill");
    const packed = join(directory, "offline-skill.json");
    await cli(null, "init", project);
    expect((await cli(null, "validate", project)).valid).toBe(true);
    const result = await cli(null, "pack", project, "--out", packed);
    expect(normalizeSkillPackage(JSON.parse(await readFile(packed, "utf8"))).digest).toBe(result.digest);
    await expect(cli(null, "pack", project, "--out", packed)).rejects.toMatchObject({ code: 1 });
    await writeFile(join(project, "script.mjs"), "throw new Error('must not execute')");
    const withScript = await cli(null, "validate", project);
    expect(withScript.valid).toBe(true);
    expect(withScript.digest).not.toBe(result.digest);
  });

  it("uploads only to the caller, installs, toggles, rolls back and restores private versions", async () => {
    const file = join(directory, "private.json");
    await writeFile(file, JSON.stringify(artifact()));
    const upload = await cli(alice, "upload", file);
    const id = upload.listingId;
    expect(id).toMatch(/^private\.u[a-f0-9]{16}\.my-skill$/);
    expect(upload.visibility).toBe("private");
    expect(await cli(alice, "list")).toHaveLength(0);
    expect((await cli(alice, "list", "--all")).some((e) => e.id === id)).toBe(true);
    expect((await cli(bob, "list", "--all")).some((e) => e.id === id)).toBe(false);
    await expect(cli(bob, "install", id)).rejects.toMatchObject({ code: 1 });
    expect((await cli(alice, "upload", file)).reused).toBe(true);
    expect((await cli(alice, "install", id, "--digest", upload.digest)).installation.status).toBe("ready");
    await cli(alice, "disable", id);
    await cli(alice, "install", id);
    expect((await cli(alice, "status", id))[0].enabled).toBe(false);
    await cli(alice, "enable", id);
    await writeFile(file, JSON.stringify(artifact("0.2.0", "# New instructions")));
    await cli(alice, "upload", file);
    expect((await cli(alice, "list"))[0].updateAvailable).toBe(true);
    await cli(alice, "install", `${id}@0.2.0`);
    await expect(cli(alice, "install", `${id}@9.0.0`)).rejects.toMatchObject({ code: 1 });
    expect((await cli(alice, "status", id))[0].version).toBe("0.2.0");
    await cli(alice, "install", `${id}@0.1.0`);
    const restored = await new MarketplaceService({ pool: db.pool }).initialize();
    expect((await restored.snapshot(alice.id)).entries.find((e) => e.id === id).installation.version).toBe("0.1.0");
    await cli(alice, "uninstall", id);
    expect(await cli(alice, "list")).toHaveLength(0);
    expect((await cli(alice, "show", id)).versions).toHaveLength(2);
  }, 30000);

  it("creates one-function tool and model templates and publishes fixed account artifacts", async () => {
    for (const kind of ["plugin", "model"]) {
      const project = join(directory, `template-${kind}`);
      await cli(null, "init", project, "--kind", kind);
      expect((await cli(null, "validate", project)).valid).toBe(true);
      const code = await readFile(join(project, "runtime.mjs"), "utf8");
      expect(code).toContain(kind === "model" ? "defineModelPlugin" : "defineToolPlugin");
      expect(JSON.parse(await readFile(join(project, "package.json"), "utf8")).scripts.dev).toBe("zioon extensions dev .");
      const published = await cli(alice, "publish", project);
      const packed = await market.releaseFor(alice.id, published.listingId, published.version, { content: true });
      expect(normalizeExtensionPackage(packed.artifact).digest).toBe(published.artifactDigest);
      expect(packed.artifact.plugin.capabilities[0].kind).toBe(kind === "model" ? "model" : "tool");
      expect((await cli(bob, "list", "--all")).some((e) => e.id === published.listingId)).toBe(false);
      const metadataPath = join(project, "zion-extension.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      await writeFile(metadataPath, JSON.stringify({ ...metadata, sourceUrl: "https://example.test/plugin-source" }));
      const submitted = await cli(alice, "publish", project, "--public");
      expect(submitted.status).toBe("submitted");
      expect(submitted.visibility).toBe("public");
      expect((await market.contributionFor(alice.id, submitted.contributionId)).manifest.artifact.kind).toBe("plugin");
      expect((await cli(bob, "list", "--all")).some((e) => e.id === submitted.listingId)).toBe(false);
    }
  }, 30000);

  it("fences stale revisions, rejects changed or executable artifacts and preserves the installed content", async () => {
    const input = artifact();
    const uploaded = await call(alice, "/v1/marketplace/private-releases", "POST", { artifact: input, expectedRevision: 0, userId: bob.id });
    const release = uploaded.body.release;
    expect(uploaded.status).toBe(201);
    const installed = await call(alice, `/v1/marketplace/installations/${release.id}`, "POST", {
      version: release.version, digest: release.digest, expectedRevision: uploaded.body.revision
    });
    expect(installed.status).toBe(200);
    const conflict = await call(alice, "/v1/marketplace/private-releases", "POST", {
      artifact: artifact("0.1.0", "# Changed"), expectedRevision: installed.body.revision
    });
    expect(conflict.body.code).toBe("release_immutable");
    const stale = await call(alice, "/v1/marketplace/private-releases", "POST", { artifact: artifact("0.2.0"), expectedRevision: 0 });
    expect(stale.body.code).toBe("revision_conflict");
    const tampered = await call(alice, "/v1/marketplace/private-releases", "POST", {
      artifact: { ...input, body: input.body + "\nchanged" }, expectedRevision: installed.body.revision
    });
    expect(tampered.body.code).toBe("digest_mismatch");
    const executable = await call(alice, "/v1/marketplace/private-releases", "POST", {
      artifact: { ...input, scripts: { install: "touch pwned" } }, expectedRevision: installed.body.revision
    });
    expect(executable.status).toBe(422);
    expect((await market.skillsFor({ principal: { userId: alice.id } })).catalog[0].body).toBe(input.body);
    expect((await market.snapshot(bob.id)).entries.some((e) => e.id === release.id)).toBe(false);
    const bypass = await call(bob, `/v1/marketplace/installations/${release.id}`, "POST", { version: release.version, digest: release.digest });
    expect(bypass.body.code).toBe("release_unavailable");
  });

  it("feeds the same private Skill to HTTP, Agent context and skillsList while isolating a shared Space", async () => {
    const uploaded = await market.uploadPrivate(alice.id, "Alice", { artifact: artifact(), expectedRevision: 0 });
    await market.install(alice.id, uploaded.release.id, { version: uploaded.release.version, digest: uploaded.release.digest });
    const snapshot = (await call(alice, "/v1/skills/snapshot")).body.snapshot;
    const skill = snapshot.catalog.find((s) => s.pluginId === uploaded.release.id);
    expect(skill.runtimeCached).toBe(true);
    expect((await call(bob, "/v1/skills/snapshot")).body.snapshot.catalog.some((s) => s.id === skill.id)).toBe(false);
    let tool, provider;
    activateRuntimePlugin({
      state: { namespace: () => ({ read: async () => ({ catalog: [], enabled: [], sources: [] }) }) },
      config: { marketplaceSkills: (context) => market.skillsFor(context) },
      context: { registerProvider: (p) => { provider = p; return { dispose() {} }; } },
      tools: { registerTool: (t) => { tool = t; return { dispose() {} }; } }
    });
    expect((await provider.contribute([], { request: { principal: { userId: alice.id } } }))
      .some((m) => m.content.includes("My Skill"))).toBe(true);
    expect(JSON.parse((await tool.invoke({ name: skill.id, include_body: true }, { principal: { userId: alice.id } })).content).skill.body).toContain("Private instructions");
    expect(await provider.contribute([], { request: { principal: { userId: bob.id } } })).toHaveLength(0);
    const toggled = await call(alice, "/v1/skills/snapshot", "PATCH", { updates: [{ id: skill.id, enabled: false }] });
    expect(toggled.body.snapshot.enabled).not.toContain(skill.id);
    expect((await market.snapshot(alice.id)).entries.find((e) => e.id === uploaded.release.id).installation.status).toBe("disabled");
    await call(alice, "/v1/skills/snapshot", "PATCH", { updates: [{ id: skill.id, enabled: true }] });
    expect((await market.snapshot(alice.id)).entries.find((e) => e.id === uploaded.release.id).installation.status).toBe("ready");
    await market.change(alice.id, uploaded.release.id, { enabled: false, expectedRevision: (await market.account(alice.id)).revision });
    expect((await call(alice, "/v1/skills/snapshot")).body.snapshot.enabled).not.toContain(skill.id);
    expect(await provider.contribute([], { request: { principal: { userId: alice.id } } })).toHaveLength(0);
  });
});
