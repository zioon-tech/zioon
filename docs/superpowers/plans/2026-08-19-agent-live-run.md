# Agent Live Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show project-automation Agent output live, persist the complete run in a normal session, and keep Agent, Biography, and attention failure states consistent.

**Architecture:** Extract Scheduler's programmatic-run session projector into a shared LangChain Chat module. The Agents programmatic runner creates a linked background session, consumes the execution event stream, projects every event to that session, and batches a live transcript into the Agent task. Identity reconciles interrupted tasks in both stores.

**Tech Stack:** JavaScript ES modules, Zion session commands/events, Agents and Identity plugin APIs, Vitest, jsdom.

---

## File Structure

- Create `extensions/dev.langchain-chat/programmatic-session.js`: shared event-to-session projection and generic session finalization.
- Create `extensions/dev.agents/programmatic-task-core.js`: pure transcript, event-log, and terminal-state formatting.
- Modify `extensions/dev.scheduler/main.js`: import and re-export the shared projector; keep Scheduler behavior unchanged.
- Modify `extensions/dev.agents/main.js`: create linked sessions, consume events, flush live text, expose session navigation, and guarantee terminal task states.
- Modify `extensions/dev.identity/main.js`: terminate stale Agent tasks and propagate concrete errors.
- Create `tests/agents-programmatic-task.test.js`: pure Agent transcript/state tests.
- Modify `tests/scheduler-plugin.test.js`: retain projector coverage through the shared implementation.
- Modify `tests/identity-plugin.test.js`: verify stale-task recovery and concrete failure propagation.

### Task 1: Shared Programmatic Session Projection

**Files:**
- Create: `extensions/dev.langchain-chat/programmatic-session.js`
- Modify: `extensions/dev.scheduler/main.js`
- Test: `tests/scheduler-plugin.test.js`

- [ ] **Step 1: Add a failing source-option assertion**

Extend the existing `projectRunEventToSession` test:

```js
await projectRunEventToSession(zion, "session-1", {
  ...base,
  type: "run.started",
  data: {}
}, { requestSource: "agent-task" });

expect(zion.events.emit).toHaveBeenCalledWith(
  "chat/runStarted",
  expect.objectContaining({ requestSource: "agent-task" })
);
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
npx vitest run tests/scheduler-plugin.test.js
```

Expected: FAIL because the current projector always emits `scheduled-task`.

- [ ] **Step 3: Extract the shared projector**

Move `projectRunEventToSession` to `extensions/dev.langchain-chat/programmatic-session.js` and accept:

```js
export async function projectRunEventToSession(
  zion,
  sessionId,
  event,
  options = {}
) {
  const requestSource = String(options.requestSource || "scheduled-task");
  const payload = {
    runId: event.runId,
    assistantBlockId: event.runId,
    sessionId,
    panelId: null,
    requestSource
  };
  // Preserve the existing run.started, message.delta, tool, completed,
  // failed, and aborted command/event mappings unchanged.
}
```

Add generic finalization:

```js
export async function finalizeProgrammaticSession(zion, sessionId, metaPatch = {}) {
  if (!sessionId) return;
  await zion.commands.executeCommand("zion.sessions.transformDoc", {
    id: sessionId,
    transform: (doc) => {
      const text = String(doc || "");
      return /\nuser\s*$/.test(text)
        ? text
        : `${text}${text.endsWith("\n") ? "" : "\n"}user `;
    }
  });
  await zion.commands.executeCommand("zion.sessions.patchMeta", {
    id: sessionId,
    patch: metaPatch
  });
  zion.commands.executeCommand("zion.sessions.bumpUpdatedAt", sessionId);
}
```

Import and re-export the projector from Scheduler so existing callers and tests remain compatible.

- [ ] **Step 4: Run Scheduler tests**

Run:

```bash
npx vitest run tests/scheduler-plugin.test.js tests/scheduler.test.js
```

Expected: PASS.

### Task 2: Pure Agent Live-State Formatting

**Files:**
- Create: `extensions/dev.agents/programmatic-task-core.js`
- Create: `tests/agents-programmatic-task.test.js`

- [ ] **Step 1: Write failing transcript and terminal-state tests**

Cover:

```js
expect(buildProgrammaticTaskBody("research", "partial")).toBe(
  "user research\n\nassistant partial"
);
expect(programmaticEventLogEntry({
  type: "tool.requested",
  ts: 10,
  data: { name: "webSearch" }
})).toMatchObject({ type: "tool.requested", message: "webSearch" });
expect(programmaticCompletionState({
  status: "aborted",
  reason: "timeout"
})).toEqual({ status: "error", error: "运行超时" });
expect(programmaticCompletionState({
  status: "failed",
  error: "provider unavailable"
})).toEqual({ status: "error", error: "provider unavailable" });
```

- [ ] **Step 2: Run the new test and verify failure**

Run:

```bash
npx vitest run tests/agents-programmatic-task.test.js
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure helpers**

Export:

```js
export function buildProgrammaticTaskBody(prompt, output) {
  return `user ${String(prompt || "").trim()}\n\nassistant ${String(output || "")}`;
}

export function programmaticEventLogEntry(event) {
  const type = String(event?.type || "");
  if (!type || type === "message.delta" || type === "message.completed") return null;
  const data = event?.data || {};
  const message = type.startsWith("tool.")
    ? String(data.name || data.reason || data.error || "")
    : String(data.error || data.reason || "");
  return { id: event.eventId, type, ts: event.ts, message };
}

export function programmaticCompletionState(completion = {}) {
  if (completion.status === "completed") return { status: "done", error: "" };
  if (completion.status === "aborted" && completion.reason === "user") {
    return { status: "aborted", error: "" };
  }
  if (completion.status === "aborted" && completion.reason === "timeout") {
    return { status: "error", error: "运行超时" };
  }
  return {
    status: "error",
    error: String(completion.error || completion.reason || "自动推进失败")
  };
}
```

- [ ] **Step 4: Run the pure tests**

Run:

```bash
npx vitest run tests/agents-programmatic-task.test.js
```

Expected: PASS.

### Task 3: Live Agent Transcript And Linked Session

**Files:**
- Modify: `extensions/dev.agents/main.js`
- Test: `tests/agents-programmatic-task.test.js`

- [ ] **Step 1: Add a linked-session integration fixture**

Mock `zion.sessions.new`, `window.zion.chat.execute`, and a finite async event stream. Assert that `runTaskHeadless`:

```js
expect(task.linkedSessionId).toBe("agent-run-session");
expect(task.body).toContain("assistant partial result");
expect(task.events).toEqual(expect.arrayContaining([
  expect.objectContaining({ type: "tool.requested", message: "webSearch" })
]));
expect(task.status).toBe("done");
```

- [ ] **Step 2: Implement concurrent event consumption**

In `runProgrammaticTask`:

```js
const linkedSessionId = await window.zion.commands.executeCommand("zion.sessions.new", {
  title: task.title || `Agent Task: ${task.id}`,
  content: `user ${prompt}\n`,
  open: false,
  meta: {
    source: "agent-task",
    agentTaskId: task.id,
    projectAutomation: task.automation || null
  }
});

const execution = window.zion.chat.execute({
  prompt,
  executionMode: "local-only",
  sessionId: linkedSessionId || sessionId,
  policy: task.executionPolicy
});
```

Consume `execution.events` concurrently. Append `message.delta` to an output buffer, map non-token events through `programmaticEventLogEntry`, project every event through `projectRunEventToSession`, and flush `body` plus the last 80 events at most once every 200 ms.

- [ ] **Step 3: Guarantee terminal task state**

After both completion and event consumption finish:

```js
const terminal = programmaticCompletionState(completion);
patchTask(task.id, {
  status: terminal.status,
  completedAt: now(),
  activeRunId: "",
  body: buildProgrammaticTaskBody(prompt, completion.output || streamedOutput),
  result: {
    workResult: completion.output || streamedOutput,
    status: completion.status,
    usage: completion.usage || null
  },
  error: terminal.error
});
```

On a thrown error, emit/project `run.failed`, retain partial output, and patch `status: "error"`. In `runTaskHeadless`, if the returned task is still `running` while `activeRuns` no longer contains it, patch it to `error` before returning.

- [ ] **Step 4: Finalize and expose the linked session**

Call `finalizeProgrammaticSession` with Agent metadata. In the Agent actions, use the external-link button to execute:

```js
window.zion.commands.executeCommand("zion.sessions.switch", task.linkedSessionId);
```

when `linkedSessionId` exists; retain `promoteTask` for ordinary tasks. Expand the run log automatically while task status is `running` or `error`.

- [ ] **Step 5: Run Agent and runner tests**

Run:

```bash
npx vitest run tests/agents-programmatic-task.test.js tests/programmatic-runner.test.js
```

Expected: PASS.

### Task 4: Cross-Store Failure Reconciliation

**Files:**
- Modify: `extensions/dev.identity/main.js`
- Modify: `tests/identity-plugin.test.js`
- Test: `tests/identity-project-automation.test.js`

- [ ] **Step 1: Add stale-task and concrete-error assertions**

Mock a persisted task with `status: "running"` and `isRunning: false`. After startup reconciliation assert:

```js
expect(window.zion.agents.updateTask).toHaveBeenCalledWith(
  staleTaskId,
  expect.objectContaining({
    status: "error",
    activeRunId: "",
    error: "自动推进因应用或插件重启中断"
  })
);
```

Mock `runTaskHeadless` returning `error: "provider unavailable"` and assert Biography policy plus the attention entry contain that exact message.

- [ ] **Step 2: Synchronize interrupted Agent state**

When `reconcileProjectRun` returns an interruption patch, call:

```js
agents?.updateTask?.(policy.activeTaskId, {
  status: patch.lastStatus === "success" ? "done" : "error",
  activeRunId: "",
  completedAt: Date.now(),
  error: patch.lastError
});
```

- [ ] **Step 3: Preserve the concrete run error**

Resolve failure text in this order:

```js
const failedTask = result?.task || agents?.getTask?.(task.id);
const runError = String(
  failedTask?.error || result?.error || "自动推进失败"
).trim();
```

Use `runError` for project policy and `appendProjectAttention`.

- [ ] **Step 4: Run Identity tests**

Run:

```bash
npx vitest run tests/identity-project-automation.test.js tests/identity-plugin.test.js
```

Expected: PASS.

### Task 5: Full Verification And Commit

**Files:**
- Verify all files above.

- [ ] **Step 1: Run targeted tests**

```bash
npx vitest run tests/agents-programmatic-task.test.js tests/programmatic-runner.test.js tests/scheduler-plugin.test.js tests/scheduler.test.js tests/identity-project-automation.test.js tests/identity-plugin.test.js
```

Expected: all test files pass.

- [ ] **Step 2: Run lint and build**

```bash
npx eslint extensions/dev.langchain-chat/programmatic-session.js extensions/dev.agents/programmatic-task-core.js extensions/dev.agents/main.js extensions/dev.scheduler/main.js extensions/dev.identity/main.js tests/agents-programmatic-task.test.js tests/scheduler-plugin.test.js tests/identity-plugin.test.js
npm run build
git diff --check
```

Expected: ESLint and build exit 0; only existing Vite size/eval warnings remain.

- [ ] **Step 3: Audit and commit only live-run changes**

Stage only the files named in this plan, verify unrelated Biography tag, session-manager, debug, and build artifacts remain unstaged, then commit:

```bash
git commit -m "fix(agents): stream project automation runs"
```
