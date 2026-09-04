import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentExecutor } from "../../../packages/runtime/src/index";
import { runRuntimeCli } from "../src/runtime-cli.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { SqliteRunStore } from "../src/sqlite-run-store.mjs";
import { SqliteWorkbenchStateStore } from "../src/sqlite-workbench-state-store.mjs";
import { createWorkbenchStateHttpHandler } from "../src/workbench-state-http-handler.mjs";

const resources = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    try {
      await resource.server.close();
    } catch {}
    try {
      resource.workbenchState?.close();
    } catch {}
    try {
      resource.store.close();
    } catch {}
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("zion CLI Runtime fixture", () => {
  it("executes against a standalone Runtime Host and emits canonical JSONL", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-runtime-cli-e2e-"));
    const store = new SqliteRunStore(join(directory, "runtime.sqlite3"));
    const executor = createAgentExecutor({
      engine: {
        id: "cli-fixture",
        async *streamTurn() {
          for (const delta of "fixture-ok") {
            yield { type: "message.delta", delta };
          }
        }
      },
      tools: {
        async listTools() {
          return [];
        },
        async invoke() {
          throw new Error("No tools configured");
        }
      },
      runs: store
    });
    const server = createRuntimeServer({
      executor,
      runs: store,
      port: 0,
      pollIntervalMs: 5
    });
    resources.push({ directory, store, server });
    const address = await server.start();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => {
      text += chunk.toString();
    });

    const run = await runRuntimeCli({
      argv: [
        "run",
        "fixture prompt",
        "--profile", "none",
        "--url", address.url,
        "--jsonl"
      ],
      output,
      environment: {},
      pollIntervalMs: 1
    });

    expect(run).toMatchObject({
      status: "completed",
      output: "fixture-ok"
    });
    const records = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.some((record) =>
      record.type === "run.event"
      && record.event.type === "message.delta"
      && record.event.data.delta === "fixture-ok"
    )).toBe(true);
    expect(records.filter((record) =>
      record.type === "run.event"
      && record.event.type === "message.delta"
    )).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({
      schemaVersion: 1,
      type: "run.snapshot",
      run: {
        status: "completed",
        output: "fixture-ok"
      }
    });
  });

  it("attaches to the active Run by Session id", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-runtime-cli-attach-"));
    const store = new SqliteRunStore(join(directory, "runtime.sqlite3"));
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const executor = createAgentExecutor({
      engine: {
        id: "cli-attach-fixture",
        async *streamTurn() {
          await gate;
          yield { type: "message.delta", delta: "attached-ok" };
        }
      },
      tools: {
        async listTools() { return []; },
        async invoke() { throw new Error("No tools configured"); }
      },
      runs: store
    });
    const server = createRuntimeServer({
      executor,
      runs: store,
      port: 0,
      pollIntervalMs: 5
    });
    resources.push({ directory, store, server });
    const address = await server.start();
    const created = await fetch(`${address.url}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-live",
        messages: [{ role: "user", content: "hold" }]
      })
    }).then((response) => response.json());
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => {
      text += chunk.toString();
    });
    setTimeout(release, 25);

    const run = await runRuntimeCli({
      argv: [
        "session",
        "attach",
        "session-live",
        "--url",
        address.url,
        "--jsonl"
      ],
      output,
      environment: {}
    });

    expect(run).toMatchObject({
      id: created.runId,
      status: "completed",
      output: "attached-ok"
    });
    const records = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toContainEqual(expect.objectContaining({
      type: "run.attached",
      runId: created.runId
    }));
  });

  it("watches durable Session events as JSONL", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-runtime-cli-watch-"));
    const path = join(directory, "runtime.sqlite3");
    const store = new SqliteRunStore(path);
    const workbenchState = new SqliteWorkbenchStateStore(path);
    const executor = createAgentExecutor({
      engine: {
        id: "cli-watch-fixture",
        async *streamTurn() {
          yield { type: "message.delta", delta: "unused" };
        }
      },
      tools: {
        async listTools() { return []; },
        async invoke() { throw new Error("No tools configured"); }
      },
      runs: store
    });
    const server = createRuntimeServer({
      executor,
      runs: store,
      port: 0,
      pollIntervalMs: 5,
      sessionEventStore: workbenchState,
      serviceHttpHandlers: [
        createWorkbenchStateHttpHandler({
          store: workbenchState,
          eventPollIntervalMs: 5
        })
      ]
    });
    resources.push({ directory, store, workbenchState, server });
    const address = await server.start();
    workbenchState.createSession({
      id: "watched-session",
      title: "Watched",
      text: "hello"
    });
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => {
      text += chunk.toString();
    });

    const result = await runRuntimeCli({
      argv: [
        "session",
        "watch",
        "watched-session",
        "--url",
        address.url,
        "--after",
        "0",
        "--limit",
        "1",
        "--jsonl"
      ],
      output,
      environment: {}
    });

    expect(result).toEqual({
      sessionId: "watched-session",
      events: 1
    });
    expect(text.trim().split("\n").map((line) => JSON.parse(line)))
      .toContainEqual(expect.objectContaining({
        type: "session.event",
        event: expect.objectContaining({
          type: "session.created",
          sessionId: "watched-session"
        })
      }));
  });
});
