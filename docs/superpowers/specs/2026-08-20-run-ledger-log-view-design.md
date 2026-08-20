# Run Ledger Log View Design

## Goal

Replace the placeholder bottom-panel Output view with a live, readable projection of Core Run Ledger records. The view helps users observe model runs without becoming a second source of truth or exposing full prompts, tool arguments, or tool results.

## Scope

The first version displays Run Ledger data only.

Included:

- Interactive chat runs.
- Programmatic Agent runs.
- Identity project automation runs.
- Scheduler model runs.
- Run lifecycle, model usage, tool summaries, policy denials, outcomes, and terminal errors.

Excluded:

- Plugin loading logs.
- Browser console messages.
- Terminal process output.
- Network request traces.
- Full prompts, model deltas, tool arguments, and full tool results.
- Deleting or mutating ledger records from the log view.

## Data Boundary

Run Ledger remains the sole source of truth:

```text
Run Ledger
  -> runs/changed
  -> Run Log Projection
  -> Bottom Panel Log View
```

The log view does not maintain a separate persistent log database. A new pure projection module converts structured runs and events into safe display rows. Opening the view builds rows from the existing ledger; subsequent `runs/changed` notifications trigger batched refreshes.

Clearing the view stores only a local timestamp cursor. It hides older rows without deleting ledger records.

The view renders at most the latest 500 projected rows. It does not project `message.delta`.

## Compatibility

The visible title changes from `Output` to `日志`. The internal view ID remains `core.output` in this iteration so existing saved bottom-panel state and the terminal plugin's fallback behavior keep working.

## Projection Model

Each projected row contains:

```ts
type RunLogRow = {
  id: string;
  runId: string;
  parentRunId?: string;
  timestamp: number;
  level: "debug" | "info" | "warn" | "error";
  kind: "run" | "model" | "tool" | "policy" | "outcome";
  sourceKind: "project" | "agent-task" | "scheduled-task" | "chat-session" | "core";
  sourceId: string;
  summary: string;
  detail?: string;
  durationMs?: number;
  sessionId?: string;
  terminal: boolean;
};
```

Projection rules:

- `run.started`: info-level Run group header.
- `tool.requested`: debug-level and hidden by default.
- `tool.completed`: info when successful, error when the event reports an error.
- `tool.denied`: warn, or error for quota and policy termination conditions.
- `model.usage`: debug; usage totals remain visible on the Run header.
- `run.completed`: info terminal summary.
- `run.failed`: error terminal summary.
- `run.aborted`: warn terminal summary.
- `run.interrupted`: error terminal summary.
- `outcome.submitted`: info, warn, or error based on verdict.
- Unknown events: debug and hidden by default.

The formatter uses sanitized ledger fields only. A formatting failure produces a generic safe summary and never serializes the original event object into the DOM.

## Interaction

The toolbar contains:

- Search input for source, run ID, tool name, and error text.
- Level filter: all, info, warning, error.
- Source filter: all, project, Agent, scheduled task, chat.
- Auto-follow toggle, enabled by default.
- Refresh icon.
- Clear-view icon.

The body uses a compact grouped timeline:

```text
v 12:34:01  q-first paper research  research  Running
    12:34:08  webSearch completed                  2.1s
    12:34:15  Tool budget                          21/24
    12:34:20  tool call quota exceeded            ERROR
  12:34:20  Failed - 19.2s - 14,320 tokens
```

Active runs start expanded. Terminal runs start collapsed. Users can toggle a Run group, select and copy a row, or open the linked session through a session action. Project metadata remains in Biography and is not duplicated here.

When users scroll away from the bottom, auto-follow pauses without changing the toggle setting. Returning to the bottom resumes following.

## Error Handling

- If `window.zion.runs` is unavailable, show `运行账本不可用`; do not show an empty-success state.
- Skip malformed runs and events individually.
- Missing sources display as `core / <runId>`.
- A projection failure produces `无法格式化运行事件`.
- Refreshes are batched to at most once every 100 ms.
- New errors update the view/tab count but do not automatically open the bottom panel.
- The current ledger API does not expose persistence health. This view makes no storage-health claim and shows no fabricated persistence warning.

## Styling

The view is an operational tool surface:

- Dense single-line rows with stable columns.
- Monospace timestamps and identifiers.
- Restrained status colors for info, warning, error, and running states.
- No cards, nested cards, decorative gradients, or oversized headings.
- Icon buttons use existing codicons and include tooltips.
- Long summaries truncate visually while preserving full safe text in the row tooltip and copy action.

## Testing

Pure projection tests cover:

- Lifecycle and tool event mapping.
- Severity mapping.
- Unknown and malformed events.
- Sanitized summaries.
- Source and level filtering.
- Group expansion defaults.
- 500-row retention.

DOM tests cover:

- Placeholder Output content is removed.
- The title displays `日志` while the ID remains `core.output`.
- Existing records render on mount.
- Ledger changes refresh in a batch.
- Search, filters, expansion, clear-view, and auto-follow behavior.
- Disposing the view removes subscriptions and pending timers.

Regression tests verify that Terminal remains a separate bottom-panel view and existing bottom-panel persistence continues to resolve `core.output`.
