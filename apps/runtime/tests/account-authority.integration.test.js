import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { PostgresAccountStore } from "../src/accounts/postgres-account-store.mjs";
import { PostgresAccessStore } from "../src/postgres-access-store.mjs";
import { AccountAccessControl } from "../src/accounts/account-access-control.mjs";
import { createAccountExecutionAuthority } from "../src/accounts/execution-authority.mjs";
import { bindRuntimeDataDirectory } from "../src/accounts/data-directory-binding.mjs";
import { FileInteractionProfileStore } from "../src/interaction-profile-store.mjs";
import { createPluginModelService } from "../src/plugin-model-service.mjs";
import { createPluginFileService } from "../src/plugin-file-service.mjs";
import { createDeviceServiceClient } from "../src/device-service-client.mjs";
import { createPluginDataFileHost } from "../../../packages/local-tools-client/src/plugin-data-files.mjs";
import { createProjectAutomationRuntimeService } from "../../../extensions/dev.identity/project-automation-runtime-service.js";
import { createAgentExecutor } from "../../../packages/runtime/src/index";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import {
  createPostgresTestDatabase,
  provisionTestTeam
} from "./helpers/postgres-test-database.mjs";

const cleanup = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const policy = {
  preset: "trusted-automation", allowedTools: ["read", "write", "Bash"], maxToolCalls: 12,
  fileRoots: [], allowedCommandPrefixes: [], allowedTerminalSessionIds: [], allowedRecipients: [], maxMailPerRun: 0
};
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "zion-authority-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const database = await createPostgresTestDatabase("account_authority");
  cleanup.push(() => database.close());
  const { accounts } = database;
  const devices = new PostgresAccessStore(database.pool, { spaceId: "space-a" });
  const owner = await provisionTestTeam(database, {
    spaceId: "space-a",
    issuer: "https://id.test"
  });
  const member = await accounts.resolveIdentity({
    issuer: "https://id.test",
    subject: "member"
  });
  await accounts.acceptInvitation(
    member.id,
    (await accounts.invite(owner.id, {}, "space-a")).token
  );
  const session = await accounts.createSession(owner.id, {
    activeSpaceId: "space-a"
  });
  const profiles = new FileInteractionProfileStore(join(directory, "profiles.json"));
  profiles.upsert({ id: "interactive.default", modelProfileId: "fixture", policy });
  const access = new AccountAccessControl({
    accounts, store: devices, oidc: { secureCookies: true }, publicBaseUrl: "https://workbench.test",
    resolveProfile: (id) => profiles.get(id),
    servedSpaceId: "space-a"
  });
  const actor = await access.authenticateHeaders({ authorization: `Bearer ${session.token}` });
  const authority = createAccountExecutionAuthority({ accessControl: access, profiles });
  const principal = await accounts.issueGrant(owner.id, policy, {
    profileId: "interactive.default",
    spaceId: "space-a"
  });
  return {
    directory,
    database,
    accounts,
    profiles,
    access,
    authority,
    owner,
    member,
    actor,
    principal
  };
}
async function finish(handle) {
  const events = (async () => { for await (const _event of handle.events) {} })();
  const result = await handle.completion;
  await events;
  return result;
}

describe("persisted account authority across execution services", () => {
  it("rechecks the issuing profile after a model turn and refuses its newly removed tool", async () => {
    const h = await setup();
    const runs = new PostgresRunStore(h.database.pool, { spaceId: "space-a" });
    let toolCalls = 0;
    const executor = createAgentExecutor({
      runs, authorizeRun: h.authority.authorizeExecution,
      tools: { listTools: async () => [{ name: "read" }], invoke: async () => { toolCalls++; return { ok: true, content: "" }; } },
      engine: {
        id: "profile-change",
        async *streamTurn({ turn }) {
          if (turn === 1) {
            h.profiles.patch("interactive.default", { policy: { allowedTools: [] } });
            yield { type: "tool.call", call: { id: "read1", name: "read", arguments: {} } };
          } else yield { type: "message.delta", delta: "finished" };
        }
      }
    });
    const result = await finish(executor.execute({ prompt: "read", policy, principal: h.principal }));
    expect(toolCalls).toBe(0);
    expect(result.status).toBe("completed");
    expect((await runs.getEvents(result.runId)).some((event) => event.type === "tool.denied")).toBe(true);
    await expect(h.access.authorizeInvocation({
      principal: h.principal, policy, toolCall: { name: "read" }
    })).rejects.toThrow("tool_outside_grant");
  });

  it("retains a task delegation after browser logout and checks its persisted policy binding on restart", async () => {
    const h = await setup();
    await h.authority.authorizeDelegation({
      projectKey: "research", actor: h.actor, policy, interactionProfileId: "interactive.default"
    });
    await h.accounts.revokeSession(h.owner.id, h.actor.sessionId);
    const reopened = new PostgresAccountStore({ pool: h.database.pool });
    const reopenedDeviceStore = new PostgresAccessStore(h.database.pool, {
      spaceId: "space-a"
    });
    const reopenedAccess = new AccountAccessControl({
      accounts: reopened,
      store: reopenedDeviceStore,
      oidc: {},
      resolveProfile: (id) => h.profiles.get(id),
      servedSpaceId: "space-a"
    });
    const authority = createAccountExecutionAuthority({ accessControl: reopenedAccess, profiles: h.profiles });
    expect((await authority.authorizeProject({
      projectKey: "research", policy
    })).principal.kind).toBe("service");
    await expect(authority.authorizeProject({
      projectKey: "research", policy: { ...policy, fileRoots: ["/another-root"] }
    })).rejects.toThrow("Project policy requires");
    const delegation = await reopened.getDelegation(
      "project:research",
      "space-a"
    );
    await reopened.revokeGrant(
      h.owner.id,
      delegation.principal.grantId,
      "space-a"
    );
    await expect(authority.authorizeProject({ projectKey: "research", policy }))
      .rejects.toThrow("grant_inactive");
  });

  it("does not let a promoted member use an old run to create an administrative task", async () => {
    const h = await setup();
    const oldPrincipal = await h.accounts.issueGrant(h.member.id, policy, {
      profileId: "interactive.default",
      spaceId: "space-a"
    });
    await h.accounts.setMember(
      h.owner.id,
      h.member.id,
      { role: "admin" },
      "space-a"
    );
    await expect(h.access.authorizeTask(
      oldPrincipal, { capability: policy }, h.profiles.get("interactive.default"), "scheduler:new"
    )).rejects.toThrow("task_management_denied");
  });

  it("reauthorizes direct plugin model calls and physical plugin file reads and writes", async () => {
    const h = await setup();
    const root = join(h.directory, "plugins");
    const path = join(root, "dev.identity", "projects", "example.md");
    mkdirSync(join(root, "dev.identity", "projects"), { recursive: true });
    writeFileSync(path, "initial");
    const limited = { ...policy, fileRoots: [path] };
    const principal = await h.accounts.issueGrant(h.owner.id, limited, {
      profileId: "interactive.default",
      spaceId: "space-a"
    });
    const files = createPluginFileService({
      toolHost: { invoke() { throw new Error("Unexpected delegated file access"); } },
      authorizeRequest: h.authority.authorizePluginFile,
      dataLocation: { root: join(root, "dev.identity") },
      fileClient: createDeviceServiceClient({
        service: "local-tools", baseUrl: "http://unused",
        dataFiles: createPluginDataFileHost({ root })
      })
    });
    const request = {
      fileRoot: join(root, "dev.identity"), runContext: { principal, policy: limited }
    };
    expect((await files.readTextFiles({ ...request, files: { project: "projects/example.md" } })).files.project).toBe("initial");
    expect((await files.readTextFiles({
      fileRoot: join(root, "dev.identity"),
      files: { project: "projects/example.md" },
      runContext: { request: { principal, policy: limited } }
    })).files.project).toBe("initial");
    await files.writeTextFiles({ ...request, files: { project: { relativePath: "projects/example.md", content: "updated" } } });
    expect(readFileSync(path, "utf8")).toBe("updated");
    await expect(files.readTextFiles({ ...request, files: { other: "private.md" } })).rejects.toThrow("file_outside_grant");
    h.profiles.patch("interactive.default", { policy: { preset: "read-only" } });
    await expect(files.writeTextFiles({
      ...request, files: { project: { relativePath: "projects/example.md", content: "forbidden" } }
    })).rejects.toThrow("file_write_denied");
    const service = createPluginModelService({
      authorizeRequest: h.authority.authorizeExecution,
      engine: {
        async *streamTurn(input) {
          expect(input.principal.userId).toBe(h.owner.id);
          await h.accounts.revokeGrant(
            h.owner.id,
            principal.grantId,
            "space-a"
          );
          yield { type: "message.delta", delta: "must not return" };
        }
      }
    });
    await expect(service.generateText({ runContext: { principal } })).rejects.toThrow("grant_inactive");
    await expect(files.readTextFiles({ ...request, files: { project: "projects/example.md" } })).rejects.toThrow("grant_inactive");
  });

  it("launches project automation with a persisted delegation and denies a changed project policy", async () => {
    const h = await setup();
    let document = { projects: { sample: { enabled: true } } };
    let context;
    const service = createProjectAutomationRuntimeService({
      readDocument: () => document, writeDocument: (value) => { document = value; },
      memoryRoot: "/workspace/identity",
      fileService: {
        resolvePath: (root, path) => `${root}/${path}`,
        async readTextFiles() { return { files: { project: "# Sample\n## 目标\nStudy a feature" } }; },
        async writeTextFiles() {}
      },
      runnerService: {
        startTaskRun(_task, options) {
          context = options;
          return { runId: "r", completion: new Promise(() => {}), abort: async () => {} };
        },
        abortRun() {}
      },
      authorizeExecution: h.authority.authorizeProject,
      authorizeDelegation: h.authority.authorizeDelegation,
      revokeDelegation: h.authority.revokeDelegation
    });
    cleanup.push(() => service.stop());
    await expect(service.runNow("sample")).rejects.toThrow("Project policy requires");
    const result = await service.runNow("sample", { actor: h.actor });
    expect(result.status).toBe("running");
    expect(context.principal).toMatchObject({ kind: "service", userId: h.owner.id, spaceId: "space-a" });
    await service.stopProject("sample");
    service.writeDocument({ projects: { sample: { enabled: true, mode: "execute", fileRoots: ["/new"] } } });
    await expect(service.runNow("sample")).rejects.toThrow("Project policy requires");
  });

  it("binds a PostgreSQL Runtime data directory to one Space", () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-postgres-binding-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    bindRuntimeDataDirectory({
      dataDirectory: directory,
      spaceId: "space-postgres",
      paths: [{ path: join(directory, "profiles.json") }]
    });
    expect(JSON.parse(
      readFileSync(join(directory, ".zion-space.json"), "utf8")
    )).toMatchObject({
      version: 3,
      spaceId: "space-postgres",
      storage: "postgresql"
    });
    expect(() => bindRuntimeDataDirectory({
      dataDirectory: directory,
      spaceId: "space-other"
    })).toThrow("another Runtime");
    expect(() => bindRuntimeDataDirectory({
      dataDirectory: directory,
      spaceId: "space-postgres",
      paths: [{ path: join(tmpdir(), "external-credentials") }]
    })).toThrow("inside this Runtime");
  });
});
