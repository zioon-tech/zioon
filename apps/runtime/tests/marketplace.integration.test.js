import { createServer } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresTestDatabase, provisionTestTeam } from "./helpers/postgres-test-database.mjs";
import { AccountAccessControl } from "../src/accounts/account-access-control.mjs";
import { PostgresAccessStore } from "../src/postgres-access-store.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { MarketplaceService } from "../src/marketplace/service.mjs";
import { createMemoryArtifactStore } from "../src/marketplace/artifact-store.mjs";
import { createMarketplaceHttpHandler } from "../src/marketplace/http-handler.mjs";
import { createSkillsCatalogHttpHandler } from "../src/skills-catalog-http-handler.mjs";
import { SKILLS_RUNTIME_KV_KEY } from "../../../extensions/dev.skills/skills-runtime-shared.js";
import { activateRuntimePlugin } from "../../../extensions/dev.skills/runtime.js";
import { normalizeExtensionPackage } from "../../../packages/runtime-client/src/extension-package.mjs";

describe("Marketplace account and Runtime integration", () => {
  let database, marketplace, workbench, server, url, access, alice, bob, reviewer, headers;
  beforeAll(async () => {
    database = await createPostgresTestDatabase("marketplace");
    const { accounts } = database;
    alice = await provisionTestTeam(database, { spaceId: "space:marketplace", ownerSubject: "alice" });
    bob = await accounts.resolveIdentity({ issuer: "https://identity.test", subject: "bob" });
    reviewer = await accounts.resolveIdentity({ issuer: "https://identity.test", subject: "reviewer" });
    await accounts.acceptInvitation(bob.id, (await accounts.invite(alice.id, {}, "space:marketplace")).token);
    const tokens = new Map(await Promise.all([alice, bob].map(async (user) => [user.id,
      (await accounts.createSession(user.id)).token])));
    headers = (user) => ({ authorization: `Bearer ${tokens.get(user.id)}`, "content-type": "application/json" });
    marketplace = await new MarketplaceService({ pool: database.pool,
      artifactStore: createMemoryArtifactStore(), reviewerIds: [reviewer.id] }).initialize();
    workbench = await new PostgresWorkbenchStateStore(database.pool, { spaceId: "space:marketplace" }).initialize();
    access = new AccountAccessControl({
      accounts, store: new PostgresAccessStore(database.pool, { spaceId: "space:marketplace" }),
      publicBaseUrl: "https://workbench.test", oidc: { secureCookies: true }
    });
    const handlers = [createMarketplaceHttpHandler({ service: marketplace }),
      createSkillsCatalogHttpHandler({ store: workbench, marketplace })];
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
  });
  beforeEach(async () => {
    await database.pool.query("TRUNCATE marketplace_accounts");
    await database.pool.query("DELETE FROM marketplace_releases WHERE listing_id NOT LIKE 'zion.%'");
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await database?.close();
  });
  const call = async (user, path, method = "GET", body) => {
    const response = await fetch(url + path, { method, headers: user ? headers(user) : {},
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const install = async (user, id) => {
    const { entries } = await marketplace.snapshot(user.id);
    const entry = entries.find((e) => e.id === id);
    return marketplace.install(user.id, id, { version: entry.version, digest: entry.digest });
  };
  const draft = (version = "1.0.0") => ({ slug: "test-skill", name: "Test Skill", summary: "Review evidence",
    category: "研究写作", version, license: "MIT", sourceUrl: "https://github.com/example/skills",
    body: "---\nname: test-skill\ndescription: Review evidence\n---\n\n# Instructions\nCheck sources." });

  it("requires account authentication, isolates personal installs and blocks private extension management in a team Space", async () => {
    expect((await call(null, "/v1/marketplace/snapshot")).status).toBe(401);
    const entry = (await marketplace.snapshot(alice.id)).entries[0];
    const added = await call(alice, `/v1/marketplace/installations/${entry.id}`, "POST", {
      version: entry.version, digest: entry.digest, userId: bob.id, expectedRevision: 0
    });
    expect(added.status).toBe(200);
    expect((await call(bob, "/v1/marketplace/snapshot")).body.entries.every((e) => !e.installation)).toBe(true);
    expect((await call(alice, "/v1/marketplace/snapshot")).body.entries.filter((e) => e.installation)).toHaveLength(1);
    // Ordinary members can manage their own account extensions.
    const member = await call(bob, `/v1/marketplace/installations/${entry.id}`, "POST", {
      version: entry.version, digest: entry.digest, expectedRevision: 0
    });
    expect(member.status).toBe(200);
    const teamHeaders = { ...headers(alice), "x-zioon-space-id": "space:marketplace" };
    const team = await fetch(url + "/v1/marketplace/snapshot", { headers: teamHeaders });
    expect((await team.json()).entries.every(e => !e.installation)).toBe(true);
    const denied = await fetch(url + `/v1/marketplace/installations/${entry.id}`, {
      method: "POST", headers: teamHeaders, body: JSON.stringify({ version: entry.version, digest: entry.digest })
    });
    expect(denied.status).toBe(409);
    expect((await denied.json()).code).toBe("personal_extension_requires_personal_space");
  });

  it("serializes duplicate additions and rejects stale mutations and mismatched artifacts", async () => {
    const entry = (await marketplace.snapshot(alice.id)).entries[0];
    await Promise.all(Array.from({ length: 6 }, () => marketplace.install(alice.id, entry.id, {
      version: entry.version, digest: entry.digest
    })));
    let state = await marketplace.account(alice.id);
    expect(Object.keys(state.installations)).toHaveLength(1);
    await marketplace.change(alice.id, entry.id, { expectedRevision: state.revision, enabled: false });
    await marketplace.install(alice.id, entry.id, { version: entry.version, digest: entry.digest });
    state = await marketplace.account(alice.id);
    expect(state.installations[entry.id].enabled).toBe(false);
    await expect(marketplace.change(alice.id, entry.id, { expectedRevision: 0, enabled: true }))
      .rejects.toMatchObject({ code: "revision_conflict" });
    await expect(marketplace.install(alice.id, entry.id, { version: entry.version, digest: "changed" }))
      .rejects.toMatchObject({ code: "digest_mismatch" });
    expect((await marketplace.account(alice.id)).installations[entry.id].enabled).toBe(false);
  });

  it("projects installed Skills through HTTP, Runtime context, and skillsList without writing to shared state", async () => {
    await workbench.writeKV(SKILLS_RUNTIME_KV_KEY, { catalog: [], enabled: [], sources: [] });
    await install(alice, "zion.research-kit");
    const snapshot = (await call(alice, "/v1/skills/snapshot")).body.snapshot;
    expect(snapshot.catalog).toHaveLength(2);
    expect(snapshot.catalog.every((s) => s.runtimeCached && s.sourceStatus === "online")).toBe(true);
    expect((await call(bob, "/v1/skills/snapshot")).body.snapshot.catalog).toHaveLength(0);
    expect((await workbench.readKV(SKILLS_RUNTIME_KV_KEY)).value.catalog).toHaveLength(0);
    let tool, provider;
    activateRuntimePlugin({
      state: { namespace: () => ({ read: async () => (await workbench.readKV(SKILLS_RUNTIME_KV_KEY)).value }) },
      config: { marketplaceSkills: (context) => marketplace.skillsFor(context) },
      context: { registerProvider: (p) => { provider = p; return { dispose() {} }; } },
      tools: { registerTool: (t) => { tool = t; return { dispose() {} }; } }
    });
    const context = { request: { principal: { userId: alice.id } } };
    const messages = await provider.contribute([{ role: "user", content: "Research" }], context);
    expect(messages.some((m) => m.content.includes("<name>研究工作台 · 证据研究</name>"))).toBe(true);
    const skill = await tool.invoke({ name: snapshot.catalog[0].id, include_body: true }, { principal: { userId: alice.id } });
    expect(JSON.parse(skill.content).skill.body).toContain("证据研究");
    expect(JSON.parse((await tool.invoke({ name: snapshot.catalog[0].id }, { principal: { userId: bob.id } })).content).error).toBe("Skill not found");
    const disabled = await call(alice, "/v1/skills/snapshot", "PATCH", { updates: [{ id: snapshot.catalog[0].id, enabled: false }] });
    expect(disabled.body.snapshot.enabled).not.toContain(snapshot.catalog[0].id);
    const forged = await provider.contribute([], { request: { principal: { userId: bob.id },
      metadata: { skills: { enabled: [snapshot.catalog[0].id], transientCatalog: snapshot.catalog } } } });
    expect(forged).toHaveLength(0);
  });

  it("keeps incomplete MCP and Workbench preparation explicit and restores durable installs", async () => {
    const result = await install(alice, "zion.github-mcp");
    expect(result.installation.status).toBe("configuration_required");
    await install(alice, "zion.document-kit");
    const recreated = await new MarketplaceService({ pool: database.pool,
      artifactStore: marketplace.artifactStore }).initialize();
    const entries = (await recreated.snapshot(alice.id)).entries;
    expect(entries.find((e) => e.id === "zion.document-kit").installation.status).toBe("partially_ready");
    expect(entries.find((e) => e.id === "zion.github-mcp").installation.components[0].requirements).toHaveLength(2);
  });

  it("publishes the reviewed immutable contribution, rejects self review, and rolls back failed updates", async () => {
    const saved = await marketplace.saveContribution(alice.id, "Alice", draft());
    const submitted = await marketplace.submit(alice.id, saved.contribution.id, { expectedRevision: saved.revision });
    const { contribution } = submitted;
    expect((await marketplace.snapshot(bob.id)).entries.some((e) => e.id === contribution.manifest.id)).toBe(false);
    await expect(marketplace.review(alice.id, alice.id, contribution.id, { decision: "publish", digest: contribution.digest }))
      .rejects.toMatchObject({ code: "reviewer_required" });
    await expect(marketplace.review(reviewer.id, alice.id, contribution.id, { decision: "publish", digest: "wrong" }))
      .rejects.toMatchObject({ code: "digest_mismatch" });
    await marketplace.review(reviewer.id, alice.id, contribution.id, { decision: "publish", digest: contribution.digest });
    const first = await install(bob, contribution.manifest.id);
    await expect(marketplace.install(bob.id, contribution.manifest.id, { version: "2.0.0", digest: "missing" }))
      .rejects.toMatchObject({ code: "release_unavailable" });
    expect((await marketplace.account(bob.id)).installations[contribution.manifest.id].version).toBe(first.installation.version);
    const secondDraft = await marketplace.saveContribution(alice.id, "Alice", draft("2.0.0"));
    const second = await marketplace.submit(alice.id, secondDraft.contribution.id, { expectedRevision: secondDraft.revision });
    await marketplace.review(reviewer.id, alice.id, second.contribution.id, { decision: "publish", digest: second.contribution.digest });
    let versions = (await marketplace.snapshot(bob.id)).entries.find((e) => e.id === contribution.manifest.id).versions;
    expect(versions.map((v) => v.version)).toEqual(["2.0.0", "1.0.0"]);
    await marketplace.install(bob.id, contribution.manifest.id, { version: versions[0].version, digest: versions[0].digest });
    await marketplace.install(bob.id, contribution.manifest.id, { version: versions[1].version, digest: versions[1].digest });
    expect((await marketplace.account(bob.id)).installations[contribution.manifest.id].version).toBe("1.0.0");
    const state = await marketplace.account(bob.id);
    await marketplace.change(bob.id, contribution.manifest.id, { expectedRevision: state.revision }, true);
    expect((await marketplace.skillsFor({ principal: { userId: bob.id } })).catalog).toHaveLength(0);
  });

  it("validates contribution metadata and forbids edits after submission", async () => {
    await expect(marketplace.saveContribution(alice.id, "Alice", { ...draft(), body: "# Missing frontmatter" }))
      .rejects.toMatchObject({ statusCode: 422 });
    await expect(marketplace.saveContribution(alice.id, "Alice", { ...draft(), sourceUrl: "https://token@example.test/repo" }))
      .rejects.toMatchObject({ statusCode: 422 });
    const saved = await marketplace.saveContribution(alice.id, "Alice", draft());
    await marketplace.submit(alice.id, saved.contribution.id, { expectedRevision: saved.revision });
    await expect(marketplace.saveContribution(alice.id, "Alice", { ...draft(), id: saved.contribution.id }))
      .rejects.toMatchObject({ code: "contribution_locked" });
  });

  it("publishes reviewed code and MCP packages for other accounts without exposing draft bytes or executing code", async () => {
    for (const kind of ["plugin", "mcp"]) {
      const manifest = { slug: `public-${kind}`, name: "Reviewed package", summary: "Public artifact",
        version: "1.0.0", category: "开发", license: "MIT", sourceUrl: "https://example.test/source" };
      const artifact = normalizeExtensionPackage({ schemaVersion: 1, kind, manifest,
        ...(kind === "plugin" ? { plugin: { id: "public-plugin", version: "1.0.0",
          entries: { runtime: "./runtime.mjs" }, runtime: { apiVersion: 2 } },
          files: { "runtime.mjs": "throw new Error('never execute in control plane');" } }
          : { mcp: { transport: "stdio", command: "node", args: ["server.mjs"] },
            files: { "server.mjs": "throw new Error('never execute in control plane');" } }) });
      const saved = await call(alice, "/v1/marketplace/contributions", "POST", {
        artifact, expectedRevision: (await marketplace.account(alice.id)).revision
      });
      expect(saved.status).toBe(201);
      const id = saved.body.contribution.id, listingId = saved.body.contribution.manifest.id;
      expect((await marketplace.snapshot(bob.id)).entries.some((e) => e.id === listingId)).toBe(false);
      const submitted = await marketplace.submit(alice.id, id, { expectedRevision: saved.body.revision });
      const pending = (await marketplace.reviewQueue(reviewer.id)).find((c) => c.id === id);
      expect(normalizeExtensionPackage(pending.manifest.artifact).digest).toBe(artifact.digest);
      await marketplace.review(reviewer.id, alice.id, id, { decision: "publish", digest: submitted.contribution.digest });
      const entry = (await marketplace.snapshot(bob.id)).entries.find((e) => e.id === listingId);
      expect(entry.visibility).toBe("public");
      expect(entry.artifact.files).toBeUndefined();
      const installed = await install(bob, listingId);
      expect(installed.installation.digest).toBe(submitted.contribution.digest);
      const downloaded = await call(bob, `/v1/marketplace/releases/${listingId}/1.0.0/artifact`);
      expect(normalizeExtensionPackage(downloaded.body.artifact).digest).toBe(artifact.digest);
      await expect(marketplace.saveContribution(alice.id, "Alice", { artifact: { ...artifact, digest: "changed" } }))
        .rejects.toMatchObject({ code: "digest_mismatch" });
    }
  });
});
