# Core Run Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a core-owned run ledger and policy gate so plugins can share one source of truth for background model runs.

**Architecture:** Core owns run records, usage, tool-call summaries, outcomes, subscriptions, and deterministic recovery. Domain plugins pass a `source` reference when starting runs and read history through `window.zion.runs`.

**Tech Stack:** TypeScript core modules, existing `window.zion` registry API, Vitest.

---

### Task 1: Core Policy Module

**Files:**
- Create: `src/core/run-policy.ts`
- Modify: `extensions/dev.langchain-chat/programmatic-runner.js`
- Test: `tests/programmatic-runner.test.js`

- [ ] Move the existing capability normalization, tool filtering, and authorization helpers from `programmatic-runner.js` into `src/core/run-policy.ts`.
- [ ] Re-export those helpers from `programmatic-runner.js` to keep current imports working.
- [ ] Run `npx vitest run tests/programmatic-runner.test.js`.

### Task 2: Core Run Ledger

**Files:**
- Create: `src/core/run-ledger.ts`
- Create: `tests/run-ledger.test.ts`
- Modify: `src/ext/registry.ts`
- Modify: `src/types/zion.d.ts`

- [ ] Implement a small append-only ledger with local storage adapter, capped event retention, run projections, tool summaries, usage summaries, outcomes, and subscriptions.
- [ ] Expose the ledger as `window.zion.runs`.
- [ ] Add public type declarations.
- [ ] Run `npx vitest run tests/run-ledger.test.ts`.

### Task 3: Programmatic Run Integration

**Files:**
- Modify: `extensions/dev.langchain-chat/programmatic-runner.js`
- Modify: `extensions/dev.langchain-chat/main.js`
- Modify: `extensions/dev.agents/main.js`
- Modify: `extensions/dev.scheduler/main.js`
- Modify: `tests/programmatic-runner.test.js`

- [ ] Have `chat.execute` write `run.started`, `model.usage`, `tool.*`, and terminal events into `window.zion.runs`.
- [ ] Pass `source` from Agent and Scheduler callers.
- [ ] Keep the existing event stream behavior unchanged.
- [ ] Run `npx vitest run tests/programmatic-runner.test.js tests/agents-programmatic-task.test.js tests/scheduler-plugin.test.js`.

### Task 4: Verification

**Files:**
- No additional source files.

- [ ] Run `npx vitest run tests/run-ledger.test.ts tests/programmatic-runner.test.js tests/agents-programmatic-task.test.js tests/scheduler-plugin.test.js`.
- [ ] Run `npm run lint -- --quiet`.
- [ ] Run `git diff --check`.
