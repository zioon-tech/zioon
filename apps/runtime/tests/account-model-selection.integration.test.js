import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountOidcFixture } from "./helpers/account-oidc-fixture.mjs";
import { startAccountRuntimeFixture, browserAccountLogin } from "./helpers/account-runtime-fixture.mjs";
import { normalizeExtensionPackage } from "../../../packages/runtime-client/src/extension-package.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const api = (origin, login, path, body, method = body === undefined ? "GET" : "POST") =>
  fetch(origin + path, { method, headers: { cookie: login.cookie, origin, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("account model selection across independent authenticated clients", () => {
  it("persists plugin defaults, isolates other members, and leaves explicit Session/Run/resume models pinned", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zioon-model-selection-"));
    cleanup.push(() => rm(directory, { force: true, recursive: true }));
    const idp = await createAccountOidcFixture();
    cleanup.push(idp.close);
    const runtime = await startAccountRuntimeFixture({ directory, spaceId: "space:models", idp });
    cleanup.push(runtime.close);
    const first = await browserAccountLogin(runtime.url);
    const second = await browserAccountLogin(runtime.url);
    const initial = await (await api(runtime.url, first, "/v1/models")).json();
    const builtin = initial.activeProfileId;
    const artifact = normalizeExtensionPackage({ schemaVersion: 1, kind: "plugin",
      manifest: { slug: "selection-relay", name: "内网模型", summary: "selection fixture", version: "0.1.0", category: "开发", license: "MIT" },
      plugin: { id: "selection-relay", version: "0.1.0", entries: { runtime: "./runtime.mjs" }, runtime: { apiVersion: 2 },
        capabilities: [{ id: "relay", kind: "model", host: "runtime",
          models: [{ id: "local", name: "Local", supportsStreaming: false, supportsTools: true }] }] },
      files: { "runtime.mjs": "export function activateRuntimePlugin(){return{}};" } });
    const snapshot = await (await api(runtime.url, first, "/v1/marketplace/snapshot")).json();
    const upload = await api(runtime.url, first, "/v1/marketplace/private-releases", { artifact, expectedRevision: snapshot.revision });
    expect(upload.status).toBe(201);
    const { release } = await upload.json();
    expect((await api(runtime.url, first, `/v1/marketplace/installations/${encodeURIComponent(release.id)}`,
      { version: release.version, digest: release.digest })).status).toBe(200);
    const catalog = await (await api(runtime.url, second, "/v1/models")).json();
    const extension = catalog.profiles.find((profile) => profile.metadata?.source === "account-extension");
    expect(extension).toBeTruthy();
    expect((await api(runtime.url, first, "/v1/models/selection", { profileId: extension.id }, "PUT")).status).toBe(200);
    expect(await (await api(runtime.url, second, "/v1/models")).json()).toMatchObject({
      activeProfileId: extension.id, selectedProfileId: extension.id
    });
    expect(await (await api(runtime.url, second, "/v1/interaction-profiles/interactive.default")).json()).toMatchObject({
      profile: { modelProfileId: builtin }
    });
    // A fresh browser session sees the durable preference rather than its own local storage.
    const fresh = await browserAccountLogin(runtime.url);
    expect(await (await api(runtime.url, fresh, "/v1/models")).json()).toMatchObject({ selectedProfileId: extension.id });
    const started = await api(runtime.url, fresh, "/v1/runs", { prompt: "use account default" });
    expect(started.status).toBe(202);
    const accepted = await started.json();
    let record;
    for (let i = 0; i < 50; i++) {
      record = await (await api(runtime.url, fresh, `/v1/runs/${accepted.runId}`)).json();
      if (["completed", "failed", "aborted"].includes(record.run.status)) break;
      await delay(20);
    }
    expect(record.run.model.profileId).toBe(extension.id);
    expect(record.run.status).toBe("failed"); // Unconfigured Node is explicit; no built-in fallback.
    const session = await (await api(runtime.url, fresh, "/v1/sessions",
      { title: "Pinned", model: { profileId: builtin } })).json();
    const message = await api(runtime.url, fresh, `/v1/sessions/${session.session.id}/messages`, { content: "pinned session" });
    expect(message.status).toBe(202);
    const sessionRun = await message.json();
    expect((await (await api(runtime.url, fresh, `/v1/runs/${sessionRun.runId}`)).json()).run.model.profileId).toBe(builtin);
    expect((await api(runtime.url, fresh, "/v1/models/selection", { profileId: builtin }, "PUT")).status).toBe(200);
    const resumed = await api(runtime.url, fresh, `/v1/runs/${accepted.runId}/resume`, {});
    expect(resumed.status).toBe(409);
    expect(await resumed.json()).toMatchObject({ code: "run_checkpoint_unavailable" });
    expect((await (await api(runtime.url, fresh, `/v1/runs/${accepted.runId}`)).json()).run.model.profileId).toBe(extension.id);
    idp.setSubject("test-member");
    const member = await browserAccountLogin(runtime.url);
    const invite = await (await api(runtime.url, first, "/v1/account/invitations", { role: "member" })).json();
    const joined = await (await api(runtime.url, member, "/v1/account/invitations/accept", { token: invite.token })).json();
    await api(runtime.url, member, "/v1/account/spaces/select", { spaceId: joined.space.id });
    const otherCatalog = await (await api(runtime.url, member, "/v1/models")).json();
    expect(otherCatalog.selectedProfileId).toBeNull();
    expect(otherCatalog.profiles.some((profile) => profile.id === extension.id)).toBe(false);
    expect((await api(runtime.url, member, "/v1/models/selection", { profileId: extension.id }, "PUT")).status).toBe(422);
    expect((await api(runtime.url, member, "/v1/models/selection", { profileId: builtin }, "PUT")).status).toBe(200);
    expect((await api(runtime.url, member, "/v1/interaction-profiles/interactive.default",
      { modelProfileId: builtin }, "PATCH")).status).toBe(403);
    expect((await api(runtime.url, first, "/v1/models/selection", { profileId: null }, "PUT")).status).toBe(200);
    expect(await (await api(runtime.url, second, "/v1/models")).json()).toMatchObject({ selectedProfileId: null, activeProfileId: builtin });
  }, 30000);
});
