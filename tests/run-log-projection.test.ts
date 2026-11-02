import { describe, expect, it } from "vitest";
import type { RunLedgerEvent, RunRecord } from "../src/core/run-ledger";
import {
  filterRunLogGroups,
  projectRunLogGroups
} from "../src/core/run-log-projection";

function makeRun(patch: Partial<RunRecord> & { id: string }): RunRecord {
  const startedAt = patch.startedAt || 1_000;
  return {
    id: patch.id,
    title: patch.title || "",
    source: patch.source || null,
    trigger: patch.trigger || "user",
    sessionId: patch.sessionId,
    panelId: patch.panelId || null,
    executionMode: patch.executionMode,
    model: patch.model || null,
    metadata: patch.metadata,
    status: patch.status || "running",
    createdAt: patch.createdAt || startedAt,
    startedAt,
    updatedAt: patch.updatedAt || startedAt,
    completedAt: patch.completedAt,
    terminalReason: patch.terminalReason,
    error: patch.error,
    usage: patch.usage || {
      input: 0,
      output: 0,
      total: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0
    },
    cost: patch.cost ?? null,
    currency: patch.currency || "USD",
    stepCount: patch.stepCount || 0,
    toolCalls: patch.toolCalls || 0,
    deniedToolCalls: patch.deniedToolCalls || 0,
    tools: patch.tools || [],
    lastEventAt: patch.lastEventAt || patch.updatedAt || startedAt,
    outcome: patch.outcome
  };
}

function event(
  runId: string,
  type: string,
  ts: number,
  data: Record<string, unknown> = {}
): RunLedgerEvent {
  return { id: `${runId}-${type}-${ts}`, runId, type, ts, data };
}

describe("Run Ledger log projection", () => {
  it("projects lifecycle and tool events into safe grouped rows", () => {
    const completed = makeRun({
      id: "completed-run",
      title: "Daily summary",
      source: { pluginId: "dev.scheduler", kind: "scheduled-task", id: "daily" },
      sessionId: "session-daily",
      status: "completed",
      startedAt: 1_000,
      updatedAt: 3_000,
      completedAt: 3_000,
      usage: {
        input: 100,
        output: 20,
        total: 120,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0
      }
    });
    const failed = makeRun({
      id: "failed-run",
      title: "q-first research",
      source: { pluginId: "dev.identity", kind: "project", id: "q-first" },
      sessionId: "session-project",
      status: "failed",
      startedAt: 4_000,
      updatedAt: 5_000,
      completedAt: 5_000,
      error: "tool call quota exceeded"
    });
    const events: Record<string, RunLedgerEvent[]> = {
      "completed-run": [
        event("completed-run", "run.started", 1_000, { promptPreview: "secret prompt" }),
        event("completed-run", "message.delta", 1_100, { length: 20 }),
        event("completed-run", "tool.requested", 1_200, {
          callId: "call-1",
          name: "webSearch",
          argKeys: ["query"]
        }),
        event("completed-run", "tool.completed", 1_500, {
          callId: "call-1",
          name: "webSearch",
          resultSize: 240
        }),
        event("completed-run", "run.completed", 3_000, {
          durationMs: 2_000,
          outputLength: 50,
          outputPreview: "safe summary"
        })
      ],
      "failed-run": [
        event("failed-run", "run.started", 4_000),
        event("failed-run", "tool.denied", 4_900, {
          callId: "call-2",
          name: "webSearch",
          reason: "tool call quota exceeded"
        }),
        event("failed-run", "run.failed", 5_000, {
          error: "tool call quota exceeded"
        })
      ]
    };

    const groups = projectRunLogGroups(
      [completed, failed],
      (runId) => events[runId] || []
    );

    expect(groups[0]).toMatchObject({
      runId: "failed-run",
      title: "q-first research",
      sourceKind: "project",
      sourceId: "q-first",
      expandedByDefault: false,
      level: "error"
    });
    expect(groups[0].rows.map((row) => row.summary)).toContain(
      "tool call quota exceeded"
    );
    expect(groups[1]).toMatchObject({
      runId: "completed-run",
      sourceKind: "scheduled-task",
      tokenCount: 120,
      durationMs: 2_000
    });
    expect(groups.flatMap((group) => group.rows).some(
      (row) => row.type === "message.delta"
    )).toBe(false);
    expect(JSON.stringify(groups)).not.toContain("secret prompt");
  });

  it("keeps active runs expanded and maps unknown events to debug", () => {
    const active = makeRun({
      id: "active-run",
      source: { pluginId: "dev.agents", kind: "agent-task", id: "agent-1" },
      status: "running",
      updatedAt: 2_000
    });

    const [group] = projectRunLogGroups(
      [active],
      () => [event("active-run", "custom.event", 1_500, { secret: "hidden" })]
    );

    expect(group).toMatchObject({
      sourceKind: "agent-task",
      expandedByDefault: true,
      level: "info"
    });
    expect(group.rows).toEqual([
      expect.objectContaining({
        type: "custom.event",
        level: "debug",
        summary: "custom.event"
      })
    ]);
    expect(JSON.stringify(group.rows)).not.toContain("hidden");
    expect(filterRunLogGroups([group])).toEqual([
      expect.objectContaining({ runId: "active-run", rows: [] })
    ]);
  });

  it("preserves custom plugin source kinds", () => {
    const run = makeRun({
      id: "custom-run",
      title: "Deploy service",
      source: { pluginId: "dev.devops", kind: "devops-run", id: "deploy-api" },
      status: "completed",
      updatedAt: 2_000
    });

    const [group] = projectRunLogGroups(
      [run],
      () => [event("custom-run", "run.completed", 2_000)]
    );

    expect(group).toMatchObject({
      sourceKind: "devops-run",
      sourceId: "deploy-api",
      title: "Deploy service"
    });
    expect(filterRunLogGroups([group], { source: "devops-run" })).toEqual([
      expect.objectContaining({ runId: "custom-run" })
    ]);
  });

  it("filters by query, level, and source without dropping matching groups", () => {
    const project = makeRun({
      id: "project-run",
      title: "Q First",
      source: { pluginId: "dev.identity", kind: "project", id: "q-first" },
      status: "failed",
      updatedAt: 3_000,
      error: "quota exceeded"
    });
    const chat = makeRun({
      id: "chat-run",
      title: "Normal chat",
      source: { pluginId: "dev.langchain-chat", kind: "chat-session", id: "s-1" },
      status: "completed",
      updatedAt: 2_000
    });
    const groups = projectRunLogGroups(
      [project, chat],
      (runId) => runId === "project-run"
        ? [event(runId, "run.failed", 3_000, { error: "quota exceeded" })]
        : [event(runId, "run.completed", 2_000, { durationMs: 1_000 })]
    );

    expect(filterRunLogGroups(groups, { query: "quota" })).toHaveLength(1);
    expect(filterRunLogGroups(groups, { level: "error" })).toHaveLength(1);
    expect(filterRunLogGroups(groups, { source: "chat-session" })).toEqual([
      expect.objectContaining({ runId: "chat-run" })
    ]);
  });

  it("resolves readable source names for chat sessions and comments", () => {
    const chat = makeRun({
      id: "chat-run",
      source: { pluginId: "dev.langchain-chat", kind: "chat-session", id: "chat-1" },
      sessionId: "chat-1",
      status: "completed",
      updatedAt: 2_000
    });
    const legacyComment = makeRun({
      id: "comment-run",
      source: { pluginId: "dev.langchain-chat", kind: "chat-session", id: "comment:thread-1" },
      sessionId: "comment:thread-1",
      status: "completed",
      updatedAt: 3_000
    });

    const groups = projectRunLogGroups(
      [chat, legacyComment],
      (runId) => [event(runId, "run.completed", runId === "comment-run" ? 3_000 : 2_000)],
      {
        resolveSourceName: (_run, kind, sourceId) => {
          if (kind === "comment" && sourceId === "comment:thread-1") return "参数校验评论";
          if (kind === "chat-session" && sourceId === "chat-1") return "支付链路排查";
          return "";
        }
      }
    );

    expect(groups[0]).toMatchObject({
      runId: "comment-run",
      sourceKind: "comment",
      sourceName: "参数校验评论",
      title: "参数校验评论"
    });
    expect(groups[1]).toMatchObject({
      runId: "chat-run",
      sourceKind: "chat-session",
      sourceName: "支付链路排查",
      title: "支付链路排查"
    });
    expect(filterRunLogGroups(groups, { source: "comment" })).toEqual([
      expect.objectContaining({ runId: "comment-run" })
    ]);
    expect(filterRunLogGroups(groups, { query: "参数校验" })).toEqual([
      expect.objectContaining({ runId: "comment-run" })
    ]);
  });

  it("summarizes model provider and execution mode, including model switches", () => {
    const run = makeRun({
      id: "mixed-model-run",
      title: "Mixed model run",
      source: { pluginId: "dev.langchain-chat", kind: "chat-session", id: "chat-1" },
      sessionId: "chat-1",
      executionMode: "interactive",
      model: { providerId: "openai", modelId: "gpt-4.1", label: "GPT-4.1" },
      status: "completed",
      updatedAt: 4_000,
      completedAt: 4_000,
      usage: {
        input: 30,
        output: 20,
        total: 50,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0
      }
    });
    const groups = projectRunLogGroups(
      [run],
      () => [
        event("mixed-model-run", "run.started", 1_000, {
          model: { providerId: "anthropic", modelId: "claude-3-5-sonnet", label: "Claude Sonnet" }
        }),
        event("mixed-model-run", "turn.started", 2_000, {
          turn: 1,
          model: { providerId: "anthropic", modelId: "claude-3-5-sonnet", label: "Claude Sonnet" }
        }),
        event("mixed-model-run", "model.usage", 2_500, {
          turn: 1,
          model: { providerId: "anthropic", modelId: "claude-3-5-sonnet", label: "Claude Sonnet" },
          usage: { total: 20 }
        }),
        event("mixed-model-run", "turn.started", 3_000, {
          turn: 2,
          model: { providerId: "openai", modelId: "gpt-4.1", label: "GPT-4.1" }
        }),
        event("mixed-model-run", "model.usage", 3_500, {
          turn: 2,
          model: { providerId: "openai", modelId: "gpt-4.1", label: "GPT-4.1" },
          usage: { total: 30 }
        })
      ]
    );

    expect(groups[0]).toMatchObject({
      modelSummary: "Claude Sonnet -> GPT-4.1",
      modelDetail: "Claude Sonnet (anthropic) -> GPT-4.1 (openai)",
      providerSummary: "mixed",
      executionModeLabel: "交互"
    });
    expect(groups[0].rows).toContainEqual(expect.objectContaining({
      type: "model.selected",
      summary: "模型切换 · Claude Sonnet -> GPT-4.1",
      detail: "openai"
    }));
  });

  it("skips malformed events, respects clear time, and caps total rows", () => {
    const run = makeRun({
      id: "large-run",
      source: null,
      status: "running",
      updatedAt: 10_000
    });
    const events = Array.from({ length: 620 }, (_, index) =>
      event("large-run", "tool.completed", 1_000 + index, {
        callId: `call-${index}`,
        name: "read",
        resultSize: index
      })
    );
    events.unshift({ id: "", runId: "", type: "", ts: 0 });

    const [group] = projectRunLogGroups(
      [run],
      () => events,
      { after: 1_050, maxRows: 500 }
    );

    expect(group.sourceKind).toBe("core");
    expect(group.sourceId).toBe("large-run");
    expect(group.rows).toHaveLength(500);
    expect(group.rows.every((row) => row.timestamp > 1_050)).toBe(true);
  });
});
