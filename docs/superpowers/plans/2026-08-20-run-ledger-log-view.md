# Run Ledger Log View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder Core Output bottom-panel view with a filterable, grouped, live Run Ledger log view.

**Architecture:** A pure projection module converts sanitized Run Ledger records and events into display groups. A separate DOM view subscribes to `window.zion.runs`, batches refreshes, renders filters and grouped rows, and opens linked sessions. `src/main.ts` only registers the view definition under the compatible `core.output` ID.

**Tech Stack:** TypeScript, DOM APIs, existing Zion bottom-panel and Run Ledger APIs, Vitest with jsdom, existing CSS tokens.

---

### Task 1: Run Log Projection

**Files:**
- Create: `src/core/run-log-projection.ts`
- Create: `tests/run-log-projection.test.ts`

- [ ] **Step 1: Write projection tests**

Add tests that construct completed, failed, active, malformed, and unknown-event runs. Assert:

```ts
const groups = projectRunLogGroups(
  [completedRun, failedRun],
  (runId) => eventsByRun[runId] || []
);

expect(groups[0]).toMatchObject({
  runId: "failed-run",
  sourceKind: "project",
  sourceId: "q-first",
  expandedByDefault: false,
  level: "error"
});
expect(groups[0].rows.map((row) => row.summary)).toContain("tool call quota exceeded");
expect(groups.flatMap((group) => group.rows).some((row) => row.type === "message.delta")).toBe(false);
```

Also assert source/level/query filtering, unknown events mapping to debug, and a global 500-row limit.

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
npx vitest run tests/run-log-projection.test.ts
```

Expected: FAIL because `src/core/run-log-projection.ts` does not exist.

- [ ] **Step 3: Implement projection types and functions**

Export:

```ts
export type RunLogLevel = "debug" | "info" | "warn" | "error";
export type RunLogSourceKind =
  | "project"
  | "agent-task"
  | "scheduled-task"
  | "chat-session"
  | "core";

export type RunLogRow = {
  id: string;
  runId: string;
  timestamp: number;
  level: RunLogLevel;
  kind: "run" | "model" | "tool" | "policy" | "outcome";
  type: string;
  sourceKind: RunLogSourceKind;
  sourceId: string;
  summary: string;
  detail?: string;
  durationMs?: number;
  sessionId?: string;
  terminal: boolean;
};

export type RunLogGroup = {
  runId: string;
  title: string;
  sourceKind: RunLogSourceKind;
  sourceId: string;
  sessionId?: string;
  timestamp: number;
  status: string;
  level: RunLogLevel;
  expandedByDefault: boolean;
  tokenCount: number;
  durationMs?: number;
  rows: RunLogRow[];
};

export function projectRunLogGroups(
  runs: RunRecord[],
  getEvents: (runId: string) => RunLedgerEvent[],
  options?: { after?: number; maxRows?: number }
): RunLogGroup[];

export function filterRunLogGroups(
  groups: RunLogGroup[],
  filter?: {
    query?: string;
    level?: "all" | "info" | "warn" | "error";
    source?: "all" | RunLogSourceKind;
  }
): RunLogGroup[];
```

Map known events using sanitized fields only. Skip `message.delta`, malformed events, and events before `after`. Unknown events become debug rows. Use run status for group severity and expansion defaults.

- [ ] **Step 4: Run projection tests**

Run:

```bash
npx vitest run tests/run-log-projection.test.ts
```

Expected: PASS.

### Task 2: Bottom-Panel Log View

**Files:**
- Create: `src/ui/run-log-view.ts`
- Create: `tests/run-log-view.test.ts`
- Modify: `src/styles.css`

- [ ] **Step 1: Write DOM view tests**

Create a fake ledger with `getSnapshot`, `getEvents`, and `subscribe`. Assert:

```ts
const definition = createRunLogViewDefinition(fakeZion);
expect(definition).toMatchObject({ id: "core.output", title: "日志" });

const mounted = definition.component.render(container);
expect(container.textContent).toContain("q-first");
expect(container.textContent).not.toContain("Bottom Panel 已启用");
expect(container.querySelector('[data-role="run-log-search"]')).toBeTruthy();
```

Then test search, severity/source filters, group expansion, clear-view, auto-follow pause/resume, linked-session opening, batched subscription refresh, unavailable-ledger state, and disposal.

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
npx vitest run tests/run-log-view.test.ts
```

Expected: FAIL because `src/ui/run-log-view.ts` does not exist.

- [ ] **Step 3: Implement the view definition and renderer**

Export:

```ts
export const RUN_LOG_VIEW_ID = "core.output";
export const RUN_LOG_VIEW_TITLE = "日志";

export function createRunLogViewDefinition(zion: any) {
  return {
    id: RUN_LOG_VIEW_ID,
    pluginId: "core",
    title: RUN_LOG_VIEW_TITLE,
    icon: "$(output)",
    order: 10,
    keepWhenActive: true,
    maximizable: true,
    component: {
      render: (container: HTMLElement) => renderRunLogView(container, zion)
    }
  };
}
```

The renderer must:

- Create search, level, and source controls.
- Create icon buttons for follow, refresh, clear, copy, and open session.
- Build groups from `zion.runs.getSnapshot()` plus `zion.runs.getEvents(runId)`.
- Batch subscription refreshes at 100 ms.
- Preserve expansion state across refreshes.
- Keep active runs expanded unless manually collapsed.
- Set a local clear timestamp without calling `zion.runs.clear()`.
- Render no more than 500 rows.
- Stop follow mode while scrolled away from the bottom and resume at the bottom.
- Open sessions through `zion.panels.openSession(activePanelId, sessionId, { focus: true })`.
- Dispose ledger subscriptions, DOM listeners, and pending timers.

- [ ] **Step 4: Add operational log styles**

Add `.zion-run-log-*` styles to `src/styles.css` with:

```css
.zion-run-log {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: 34px minmax(0, 1fr);
  color: var(--fg);
}

.zion-run-log-row {
  display: grid;
  grid-template-columns: 72px minmax(96px, 180px) minmax(0, 1fr) auto;
  min-height: 24px;
  align-items: center;
}
```

Use existing surface, border, foreground, error, and warning tokens. Keep controls compact, square icon buttons, stable columns, ellipsis for long text, and responsive wrapping below 640 px.

- [ ] **Step 5: Run DOM tests**

Run:

```bash
npx vitest run tests/run-log-view.test.ts
```

Expected: PASS.

### Task 3: Core Registration and Regression Verification

**Files:**
- Modify: `src/main.ts:5421-5456`
- Modify: `tests/run-log-view.test.ts`

- [ ] **Step 1: Replace placeholder registration**

Import:

```ts
import { createRunLogViewDefinition } from "./ui/run-log-view";
```

Replace the inline placeholder registration with:

```ts
try {
  window.zion.bottomPanel?.registerView(
    createRunLogViewDefinition(window.zion)
  );
} catch {}
```

- [ ] **Step 2: Add compatibility assertions**

Assert the definition keeps `id: "core.output"`, exposes title `日志`, and does not alter the terminal view. Keep `extensions/dev.terminal-enhanced/main.js` unchanged.

- [ ] **Step 3: Run focused tests**

Run:

```bash
npx vitest run \
  tests/run-log-projection.test.ts \
  tests/run-log-view.test.ts \
  tests/run-ledger.test.ts \
  tests/workbench-runtime.test.js
```

Expected: PASS.

- [ ] **Step 4: Run static verification**

Run:

```bash
npx eslint \
  src/core/run-log-projection.ts \
  src/ui/run-log-view.ts \
  src/main.ts \
  tests/run-log-projection.test.ts \
  tests/run-log-view.test.ts \
  --quiet
npm run build
git diff --check
```

Expected: focused lint, production build, and whitespace check all pass. Existing unrelated full-repository lint failures are not part of this change.

- [ ] **Step 5: Commit**

Stage only the plan, projection, view, styles, main registration, and tests:

```bash
git add \
  docs/superpowers/plans/2026-08-20-run-ledger-log-view.md \
  src/core/run-log-projection.ts \
  src/ui/run-log-view.ts \
  src/styles.css \
  src/main.ts \
  tests/run-log-projection.test.ts \
  tests/run-log-view.test.ts
git commit -m "feat(core): add run ledger log view"
```
