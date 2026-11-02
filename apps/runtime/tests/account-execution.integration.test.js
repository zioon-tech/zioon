import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentExecutor, CancellationController } from "../../../packages/runtime/src/index";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { PostgresAccessStore } from "../src/postgres-access-store.mjs";
import { AccountAccessControl } from "../src/accounts/account-access-control.mjs";
import { FileInteractionProfileStore } from "../src/interaction-profile-store.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { RuntimeToolBroker } from "../src/runtime-tool-broker.mjs";
import {
  createPostgresTestDatabase,
  provisionTestTeam
} from "./helpers/postgres-test-database.mjs";

const cleanup = [];
const policy = {
  preset: "trusted-automation", allowedTools: ["read"], maxToolCalls: 3,
  fileRoots: [], allowedCommandPrefixes: [], allowedTerminalSessionIds: [], allowedRecipients: [], maxMailPerRun: 0
};
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function harness() {
  const database = await createPostgresTestDatabase("account_execution");
  const accounts = database.accounts;
  const owner = await provisionTestTeam(database, {
    spaceId: "space:one",
    issuer: "https://id.test"
  });
  const runs = new PostgresRunStore(database.pool, { spaceId: "space:one" });
  const devices = new PostgresAccessStore(database.pool, { spaceId: "space:one" });
  cleanup.push(() => database.close());
  const user = await accounts.resolveIdentity({
    issuer: "https://id.test",
    subject: "member"
  });
  await accounts.acceptInvitation(
    user.id,
    (await accounts.invite(owner.id, {}, "space:one")).token
  );
  const session = await accounts.createSession(user.id, {
    activeSpaceId: "space:one"
  });
  const access = new AccountAccessControl({
    accounts,
    store: devices,
    oidc: { secureCookies: true },
    publicBaseUrl: "https://workbench.test",
    servedSpaceId: "space:one"
  });
  const principal = await accounts.issueGrant(user.id, policy, {
    spaceId: "space:one"
  });
  return { runs, accounts, owner, user, access, principal, session };
}
async function finish(handle) {
  const drain = (async () => { for await (const _event of handle.events) {} })();
  const result = await handle.completion;
  await drain;
  return result;
}

describe("account execution integration", () => {
  it("records the initiating account through HTTP, context, model and tool execution", async () => {
    const h = await harness();
    const observed = [];
    const tool = vi.fn(async (invocation) => {
      observed.push(["tool", invocation.principal]);
      return { ok: true, content: "safe-data" };
    });
    const executor = createAgentExecutor({
      runs: h.runs,
      authorizeRun: (request) => h.access.authorizeRunExecution(request),
      contexts: [{
        id: "test",
        prepare(request) { observed.push(["context", request.principal]); return []; }
      }],
      tools: { listTools: async () => [{ name: "read" }], invoke: tool },
      engine: {
        id: "account-fixture",
        async *streamTurn(request) {
          observed.push(["model", request.principal]);
          if (request.turn === 1) yield { type: "tool.call", call: { id: "read1", name: "read", arguments: {} } };
          else yield { type: "message.delta", delta: "done" };
        }
      }
    });
    const profiles = new FileInteractionProfileStore();
    profiles.upsert({ id: "interactive.default", modelProfileId: "fixture", policy });
    const server = createRuntimeServer({
      executor, runs: h.runs, accessControl: h.access, interactionProfiles: profiles
    });
    cleanup.push(() => server.close());
    const address = await server.start();
    const response = await fetch(address.url + "/v1/runs", {
      method: "POST", headers: { authorization: `Bearer ${h.session.token}` },
      body: JSON.stringify({
        prompt: "inspect", policy,
        principal: { ...h.principal, userId: h.owner.id, spaceId: "forged" }
      })
    });
    expect(response.status).toBe(202);
    const accepted = await response.json();
    await vi.waitFor(async () => expect((await h.runs.get(accepted.runId))?.status).toBe("completed"));
    expect((await h.runs.get(accepted.runId)).principal).toMatchObject({ userId: h.user.id, spaceId: "space:one" });
    expect(observed.map(([phase]) => phase)).toEqual(["context", "model", "tool", "model"]);
    for (const [, actor] of observed) expect(actor).toMatchObject({ userId: h.user.id, spaceId: "space:one" });
  });

  it("stops a tool requested by an in-flight model when membership is removed", async () => {
    const h = await harness();
    const invoke = vi.fn();
    const executor = createAgentExecutor({
      runs: h.runs, authorizeRun: (request) => h.access.authorizeRunExecution(request),
      tools: { listTools: async () => [{ name: "read" }], invoke },
      engine: {
        id: "revocation-fixture",
        async *streamTurn() {
          await h.accounts.setMember(
            h.owner.id,
            h.user.id,
            { role: "member", status: "removed" },
            "space:one"
          );
          yield { type: "tool.call", call: { id: "read1", name: "read", arguments: {} } };
        }
      }
    });
    const result = await finish(executor.execute({ prompt: "inspect", policy, principal: h.principal }));
    expect(result).toMatchObject({ status: "failed", error: "grant_inactive" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("checks grant revocation before returning a durable tool receipt", async () => {
    const h = await harness();
    const invoke = vi.fn(async () => ({ ok: true, content: "private result" }));
    const broker = new RuntimeToolBroker({
      receipts: h.runs, localTools: { listTools: async () => [{ name: "read" }], invoke },
      authorizeInvocation: (input) => h.access.authorizeInvocation(input)
    });
    const input = {
      invocationId: "i:one", runId: "r:one", attemptId: "a:one",
      principal: h.principal, policy, toolCall: { id: "read1", name: "read", arguments: {} }
    };
    const signal = new CancellationController().signal;
    expect((await broker.invoke(input, signal)).content).toBe("private result");
    await h.accounts.revokeGrant(h.user.id, h.principal.grantId);
    await expect(broker.invoke(input, signal)).rejects.toThrow("grant_inactive");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("refuses unbound legacy runs and rechecks revocation when resuming a checkpoint", async () => {
    const h = await harness();
    const executor = createAgentExecutor({
      runs: h.runs, authorizeRun: (request) => h.access.authorizeRunExecution(request),
      tools: {
        listTools: async () => [{ name: "read" }],
        invoke: async () => ({ ok: true, content: "data" })
      },
      engine: {
        id: "checkpoint-fixture",
        async *streamTurn() {
          yield { type: "tool.call", call: { id: "read1", name: "read", arguments: {} } };
        }
      }
    });
    const legacy = executor.execute({ prompt: "legacy", policy });
    expect(await finish(legacy)).toMatchObject({
      status: "failed",
      error: "invalid_run_principal"
    });
    const handle = executor.execute({ prompt: "inspect", principal: h.principal, policy, maxTurns: 1 });
    expect((await finish(handle)).status).toBe("failed");
    await h.accounts.revokeGrant(h.user.id, h.principal.grantId);
    await expect(executor.resume(handle.runId)).rejects.toThrow("grant_inactive");
  });
});
