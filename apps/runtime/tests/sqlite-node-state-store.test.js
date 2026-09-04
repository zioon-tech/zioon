import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CancellationController } from "../../../packages/runtime/src/index";
import { NodeBroker } from "../src/node-broker.mjs";
import { SqliteNodeStateStore } from "../src/sqlite-node-state-store.mjs";

const temporaryDirectories = [];

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "zion-node-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "runtime.sqlite3");
}

function registration(instanceId = "instance:one") {
  return {
    protocolVersion: 1,
    nodeId: "node:macbook",
    instanceId,
    label: "MacBook",
    platform: "darwin",
    capabilities: [{
      name: "read",
      version: "1",
      risk: "read",
      description: "Read a file",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" }
        }
      },
      hostKind: "local-tools"
    }],
    resources: [{
      resourceId: "workspace:zion-next",
      kind: "workspace",
      projectId: "zion-next",
      label: "Zion Next",
      localRoot: "/must-not-be-persisted"
    }]
  };
}

function invocation() {
  return {
    invocationId: "invocation:durable",
    runId: "run:durable",
    attemptId: "attempt:durable",
    projectId: "zion-next",
    policy: {
      allowedTools: ["read"],
      fileRoots: ["/workspace/zion-next"],
      allowedTerminalSessionIds: ["terminal:one"]
    },
    toolCall: {
      id: "call:durable",
      name: "read",
      arguments: {
        path: "/workspace/zion-next/package.json",
        session_id: "terminal:one"
      }
    }
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteNodeStateStore", () => {
  it("restores offline Nodes, project bindings, and completed receipts", async () => {
    const path = databasePath();
    let time = 1_000;
    const firstStore = new SqliteNodeStateStore(path);
    const firstBroker = new NodeBroker({
      stateStore: firstStore,
      now: () => time
    });
    firstBroker.registerNode(registration());
    const completion = firstBroker.invoke(
      invocation(),
      new CancellationController().signal
    );
    await firstBroker.nextCommand("node:macbook", "instance:one");
    firstBroker.completeInvocation(
      "node:macbook",
      "instance:one",
      "invocation:durable",
      { ok: true, content: "persisted result" }
    );
    await expect(completion).resolves.toEqual({
      ok: true,
      content: "persisted result"
    });
    time = 12_000;
    firstBroker.heartbeat("node:macbook", "instance:one");
    firstBroker.close();
    firstStore.close();

    const reopenedStore = new SqliteNodeStateStore(path);
    const reopenedBroker = new NodeBroker({
      stateStore: reopenedStore,
      now: () => 2_000
    });
    expect(reopenedBroker.snapshot()).toMatchObject({
      nodes: [{
        nodeId: "node:macbook",
        status: "offline",
        lastSeenAt: 12_000,
        resources: [{
          resourceId: "workspace:zion-next",
          projectId: "zion-next"
        }]
      }],
      projectBindings: [{
        projectId: "zion-next",
        nodeId: "node:macbook",
        resourceId: "workspace:zion-next"
      }],
      durableReceiptCount: 1
    });
    expect(reopenedBroker.snapshot().nodes[0].resources[0])
      .not.toHaveProperty("localRoot");
    await expect(reopenedBroker.listTools({
      projectId: "zion-next",
      policy: { allowedTools: ["read"] }
    })).resolves.toEqual([]);
    await expect(reopenedBroker.invoke(
      invocation(),
      new CancellationController().signal
    )).resolves.toEqual({
      ok: true,
      content: "persisted result"
    });

    reopenedBroker.registerNode(registration("instance:two"));
    await expect(reopenedBroker.listTools({
      projectId: "zion-next",
      policy: { allowedTools: ["read"] }
    })).resolves.toEqual([
      expect.objectContaining({ name: "read" })
    ]);
    reopenedBroker.close();
    reopenedStore.close();
  });

  it("keeps the first durable result beyond the in-memory receipt cache", async () => {
    const store = new SqliteNodeStateStore(databasePath());
    expect(store.saveReceipt({
      invocationId: "invocation:one",
      nodeId: "node:one",
      result: { ok: true, content: "first" },
      completedAt: 1_000
    })).toMatchObject({
      duplicate: false,
      result: { ok: true, content: "first" }
    });
    expect(store.saveReceipt({
      invocationId: "invocation:one",
      nodeId: "node:one",
      result: { ok: true, content: "second" },
      completedAt: 2_000
    })).toMatchObject({
      duplicate: true,
      result: { ok: true, content: "first" }
    });
    store.saveReceipt({
      invocationId: "invocation:two",
      nodeId: "node:one",
      result: { ok: true, content: "newer" },
      completedAt: 3_000
    });
    const broker = new NodeBroker({
      stateStore: store,
      maxReceipts: 1
    });
    expect(broker.snapshot()).toMatchObject({
      receiptCount: 1,
      durableReceiptCount: 2
    });
    await expect(broker.invoke({
      ...invocation(),
      invocationId: "invocation:one"
    }, new CancellationController().signal)).resolves.toEqual({
      ok: true,
      content: "first"
    });
    expect(broker.snapshot()).toMatchObject({
      receiptCount: 1,
      durableReceiptCount: 2
    });
    broker.close();
    store.close();
  });
});
