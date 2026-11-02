import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RunLedgerEvent,
  RunLedgerSnapshot,
  RunRecord
} from "../src/core/run-ledger";
import {
  createRunLogViewDefinition,
  RUN_LOG_VIEW_ID,
  RUN_LOG_VIEW_TITLE
} from "../src/ui/run-log-view";

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

function createHarness(options: { sourceKinds?: Array<Record<string, unknown>> } = {}) {
  const state = new Map<string, unknown>();
  let listener: ((snapshot: RunLedgerSnapshot) => void) | null = null;
  const disposeSubscription = vi.fn();
  const project = makeRun({
    id: "project-run",
    title: "q-first research",
    source: { pluginId: "dev.identity", kind: "project", id: "q-first" },
    sessionId: "project-session",
    executionMode: "local-only",
    model: { providerId: "anthropic", modelId: "claude-3-5-sonnet", label: "Claude Sonnet" },
    status: "failed",
    startedAt: 1_000,
    updatedAt: 3_000,
    completedAt: 3_000,
    error: "tool call quota exceeded",
    usage: {
      input: 100,
      output: 20,
      total: 120,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0
    }
  });
  const chat = makeRun({
    id: "chat-run",
    title: "Normal chat",
    source: { pluginId: "dev.langchain-chat", kind: "chat-session", id: "chat-1" },
    sessionId: "chat-session",
    status: "running",
    startedAt: 4_000,
    updatedAt: 5_000
  });
  let runs = [chat, project];
  const events: Record<string, RunLedgerEvent[]> = {
    "project-run": [
      event("project-run", "tool.denied", 2_900, {
        callId: "call-1",
        name: "webSearch",
        reason: "tool call quota exceeded"
      }),
      event("project-run", "run.failed", 3_000, {
        error: "tool call quota exceeded"
      })
    ],
    "chat-run": [
      event("chat-run", "tool.completed", 4_500, {
        callId: "call-2",
        name: "read",
        resultSize: 30
      })
    ]
  };

  const snapshot = (): RunLedgerSnapshot => ({
    runs,
    active: runs.filter((run) => run.status === "running"),
    totals: {
      count: runs.length,
      active: runs.filter((run) => run.status === "running").length,
      failed: runs.filter((run) => run.status === "failed").length,
      tokens: {
        input: 100,
        output: 20,
        total: 120,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0
      },
      cost: null,
      currency: "USD"
    }
  });

  const openSession = vi.fn();
  const zion = {
    runs: {
      getSnapshot: vi.fn(snapshot),
      getEvents: vi.fn((runId: string) => events[runId] || []),
      getSourceKinds: vi.fn(() => options.sourceKinds || []),
      subscribe: vi.fn((handler: (value: RunLedgerSnapshot) => void) => {
        listener = handler;
        return { dispose: disposeSubscription };
      }),
      clear: vi.fn()
    },
    state: {
      get: vi.fn((key: string) => state.get(key)),
      set: vi.fn((key: string, value: unknown) => state.set(key, value))
    },
    panels: {
      getActivePanelId: vi.fn(() => "panel-1"),
      openSession
    },
    icons: {
      createFromCodicon: vi.fn((name: string) => {
        const icon = document.createElement("span");
        icon.dataset.icon = name;
        return icon;
      })
    }
  };

  return {
    zion,
    state,
    openSession,
    disposeSubscription,
    emitChange() {
      listener?.(snapshot());
    },
    addRun(run: RunRecord, runEvents: RunLedgerEvent[] = []) {
      runs = [run, ...runs];
      events[run.id] = runEvents;
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  document.body.replaceChildren();
});

describe("Run Ledger bottom-panel log view", () => {
  it("keeps the compatible ID and renders existing ledger records", () => {
    const harness = createHarness();
    const container = document.createElement("div");
    const definition = createRunLogViewDefinition(harness.zion);

    expect(RUN_LOG_VIEW_ID).toBe("core.output");
    expect(RUN_LOG_VIEW_TITLE).toBe("日志");
    expect(definition).toMatchObject({
      id: "core.output",
      pluginId: "core",
      title: "日志",
      icon: "$(output)"
    });

    const mounted = definition.component.render(container);

    expect(container.textContent).toContain("q-first research");
    expect(container.textContent).toContain("Claude Sonnet");
    expect(container.textContent).toContain("anthropic");
    expect(container.textContent).toContain("本地自动");
    expect(container.textContent).toContain("Normal chat");
    expect(container.textContent).not.toContain("Bottom Panel 已启用");
    expect(container.querySelector('[data-role="run-log-search"]')).toBeTruthy();
    expect(container.querySelector('[data-role="run-log-level"]')).toBeTruthy();
    expect(container.querySelector('[data-role="run-log-source"]')).toBeTruthy();
    mounted.dispose();
  });

  it("filters by query, level, and source", () => {
    const harness = createHarness();
    const container = document.createElement("div");
    const mounted = createRunLogViewDefinition(harness.zion).component.render(container);
    const search = container.querySelector<HTMLInputElement>('[data-role="run-log-search"]')!;
    const level = container.querySelector<HTMLSelectElement>('[data-role="run-log-level"]')!;
    const source = container.querySelector<HTMLSelectElement>('[data-role="run-log-source"]')!;

    search.value = "q-first";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(container.textContent).toContain("q-first research");
    expect(container.textContent).not.toContain("Normal chat");

    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    level.value = "error";
    level.dispatchEvent(new Event("change", { bubbles: true }));
    expect(container.textContent).toContain("q-first research");
    expect(container.textContent).not.toContain("Normal chat");

    level.value = "all";
    level.dispatchEvent(new Event("change", { bubbles: true }));
    source.value = "chat-session";
    source.dispatchEvent(new Event("change", { bubbles: true }));
    expect(container.textContent).not.toContain("q-first research");
    expect(container.textContent).toContain("Normal chat");
    mounted.dispose();
  });

  it("shows readable names for legacy comment session logs", () => {
    const harness = createHarness();
    localStorage.setItem("zion.comments.threads.v1", JSON.stringify([
      {
        id: "comment-1",
        threadSessionId: "comment:comment-1",
        title: "参数校验评论",
        quote: "fallback quote"
      }
    ]));
    harness.addRun(makeRun({
      id: "comment-run",
      source: { pluginId: "dev.langchain-chat", kind: "chat-session", id: "comment:comment-1" },
      sessionId: "comment:comment-1",
      status: "completed",
      updatedAt: 6_000,
      completedAt: 6_000
    }), [
      event("comment-run", "run.completed", 6_000, { durationMs: 500 })
    ]);
    const container = document.createElement("div");
    const mounted = createRunLogViewDefinition(harness.zion).component.render(container);

    expect(container.textContent).toContain("参数校验评论");
    expect(container.textContent).toContain("评论");

    const source = container.querySelector<HTMLSelectElement>('[data-role="run-log-source"]')!;
    source.value = "comment";
    source.dispatchEvent(new Event("change", { bubbles: true }));
    expect(container.textContent).toContain("参数校验评论");
    expect(container.textContent).not.toContain("q-first research");
    expect(container.textContent).not.toContain("Normal chat");
    mounted.dispose();
  });

  it("renders registered plugin source kinds", () => {
    const harness = createHarness({
      sourceKinds: [
        { kind: "review-run", label: "代码审查", color: "purple", order: 35, pluginId: "dev.review" }
      ]
    });
    harness.addRun(makeRun({
      id: "review-run",
      title: "Review current diff",
      source: { pluginId: "dev.review", kind: "review-run", id: "diff" },
      status: "completed",
      updatedAt: 7_000,
      completedAt: 7_000
    }), [
      event("review-run", "run.completed", 7_000, { durationMs: 800 })
    ]);
    const container = document.createElement("div");
    const mounted = createRunLogViewDefinition(harness.zion).component.render(container);

    const source = container.querySelector<HTMLSelectElement>('[data-role="run-log-source"]')!;
    expect(Array.from(source.options).map((option) => [option.value, option.textContent])).toContainEqual([
      "review-run",
      "代码审查"
    ]);
    expect(container.textContent).toContain("代码审查");
    expect(container.textContent).toContain("Review current diff");
    expect(container.querySelector<HTMLElement>('[data-run-id="review-run"] .zion-run-log-source')?.style.getPropertyValue("--zion-run-log-source-color")).toBe("#7c3aed");

    source.value = "review-run";
    source.dispatchEvent(new Event("change", { bubbles: true }));
    expect(container.textContent).toContain("Review current diff");
    expect(container.textContent).not.toContain("q-first research");
    mounted.dispose();
  });

  it("expands terminal runs and opens their linked sessions", () => {
    const harness = createHarness();
    const container = document.createElement("div");
    const mounted = createRunLogViewDefinition(harness.zion).component.render(container);
    const projectGroup = container.querySelector<HTMLElement>('[data-run-id="project-run"]')!;

    expect(projectGroup.classList.contains("is-expanded")).toBe(false);
    projectGroup.querySelector<HTMLButtonElement>('[data-action="toggle-run"]')!.click();
    expect(projectGroup.classList.contains("is-expanded")).toBe(true);
    expect(projectGroup.textContent).toContain("tool call quota exceeded");
    const row = projectGroup.querySelector<HTMLElement>(".zion-run-log-row")!;
    row.click();
    expect(row.classList.contains("is-selected")).toBe(true);

    projectGroup.querySelector<HTMLButtonElement>('[data-action="open-session"]')!.click();
    expect(harness.openSession).toHaveBeenCalledWith(
      "panel-1",
      "project-session",
      { focus: true }
    );
    mounted.dispose();
  });

  it("clears only the view and never deletes the ledger", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000));
    const harness = createHarness();
    const container = document.createElement("div");
    const mounted = createRunLogViewDefinition(harness.zion).component.render(container);

    container.querySelector<HTMLButtonElement>('[data-action="clear-view"]')!.click();

    expect(container.textContent).not.toContain("q-first research");
    expect(container.textContent).not.toContain("Normal chat");
    expect(harness.zion.runs.clear).not.toHaveBeenCalled();
    expect(harness.state.get("runLogs.clearedBefore")).toBe(10_000);
    mounted.dispose();
  });

  it("batches ledger refreshes and disposes subscriptions and timers", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const container = document.createElement("div");
    const mounted = createRunLogViewDefinition(harness.zion).component.render(container);
    const next = makeRun({
      id: "next-run",
      title: "Next run",
      source: { pluginId: "dev.scheduler", kind: "scheduled-task", id: "next" },
      status: "running",
      updatedAt: 6_000
    });

    harness.addRun(next);
    harness.emitChange();
    expect(container.textContent).not.toContain("Next run");
    await vi.advanceTimersByTimeAsync(99);
    expect(container.textContent).not.toContain("Next run");
    await vi.advanceTimersByTimeAsync(1);
    expect(container.textContent).toContain("Next run");

    harness.addRun(makeRun({
      id: "disposed-run",
      title: "Disposed run",
      status: "running",
      updatedAt: 7_000
    }));
    harness.emitChange();
    mounted.dispose();
    await vi.runAllTimersAsync();
    expect(harness.disposeSubscription).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Disposed run");
  });

  it("pauses follow while scrolled away and resumes at the bottom", () => {
    const harness = createHarness();
    const container = document.createElement("div");
    const mounted = createRunLogViewDefinition(harness.zion).component.render(container);
    const viewport = container.querySelector<HTMLElement>('[data-role="run-log-viewport"]')!;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 }
    });

    viewport.scrollTop = 100;
    viewport.dispatchEvent(new Event("scroll"));
    expect(container.querySelector(".zion-run-log")?.classList.contains("is-follow-paused")).toBe(true);

    viewport.scrollTop = 400;
    viewport.dispatchEvent(new Event("scroll"));
    expect(container.querySelector(".zion-run-log")?.classList.contains("is-follow-paused")).toBe(false);
    mounted.dispose();
  });

  it("shows an explicit unavailable state when the ledger API is missing", () => {
    const container = document.createElement("div");
    const mounted = createRunLogViewDefinition({
      state: { get: () => undefined, set: () => {} }
    }).component.render(container);

    expect(container.textContent).toContain("运行账本不可用");
    expect(container.textContent).not.toContain("暂无日志");
    mounted.dispose();
  });
});
