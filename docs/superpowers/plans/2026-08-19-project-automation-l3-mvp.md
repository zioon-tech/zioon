# Project Automation L3 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users authorize individual working-memory projects for bounded automatic research, planning, and execution from the Biography panel.

**Architecture:** Scheduler emits a generic leader heartbeat and remains unaware of projects. A new Identity project coordinator reads UI-owned automation policy, selects one eligible project, determines its next phase, and delegates one bounded run through the Agents runtime. Project files remain model-maintained; authorization and runtime state remain machine-owned.

**Tech Stack:** JavaScript ES modules, Zion plugin events/state/Agents APIs, local-tools files API, CSS, Vitest.

---

## File Structure

- Create `extensions/dev.identity/project-automation-core.js`: normalize policy, inspect project readiness, select candidates, build bounded prompts and attention entries.
- Create `tests/identity-project-automation.test.js`: pure policy/state-machine tests.
- Modify `extensions/dev.identity/projects-core.js`: add attention and research-aware project templates.
- Modify `extensions/dev.identity/identity-core.js`: inject bounded attention content and forbid model edits to automation policy.
- Modify `extensions/dev.identity/main.js`: persist automation policy, render controls, run coordinator, delegate Agents tasks, and handle completion.
- Modify `extensions/dev.identity/styles.css`: compact project automation controls and statuses.
- Modify `extensions/dev.agents/main.js`: expose the existing headless runner and support policy-bounded automation tasks.
- Modify `extensions/dev.scheduler/main.js`: emit generic `scheduler/heartbeat` events from the elected local leader.
- Modify `tests/identity-plugin.test.js`: scaffolding, context, UI and coordinator integration coverage.

### Task 1: Pure Automation State Machine

- [ ] Add tests for normalized per-project policy defaults, disabled filtering, due-time ordering, missing-goal attention, research, planning, execute-next-checkbox, and plan-complete attention.
- [ ] Implement `normalizeAutomationDocument`, `updateProjectPolicy`, `inspectProjectReadiness`, `selectAutomationCandidate`, `buildAutomationTaskPrompt`, and `buildAttentionEntry`.
- [ ] Run `npx vitest run tests/identity-project-automation.test.js`.

### Task 2: Memory Files And Context

- [ ] Add `projects/attention.md` and `projects/.automation.json` to idempotent startup scaffolding.
- [ ] Add `## 调研` to new project templates.
- [ ] Inject bounded `<projects_attention>` but never inject raw automation policy.
- [ ] Add an Identity instruction that `.automation.json` is UI-owned and must not be edited by the model.
- [ ] Run Identity core and plugin tests.

### Task 3: Scheduler Wakeup And Agents Execution

- [ ] Emit `scheduler/heartbeat` immediately when the local scheduler becomes leader and every five minutes while it remains leader.
- [ ] Expose `window.zion.agents.runTaskHeadless`.
- [ ] For tasks containing `executionPolicy`, execute through `window.zion.chat.execute` with timeout, max tool calls, allowed tools, and allowed file roots.
- [ ] Preserve Agent task status/result/error updates so automatic runs remain visible in the Agents panel.

### Task 4: Coordinator

- [ ] On scheduler heartbeat or manual run, load index, project files and `.automation.json`.
- [ ] Select at most one enabled, due, non-running project.
- [ ] Write attention instead of running when goal/input/plan is insufficient.
- [ ] Create and run one Agent task for `research`, `planning`, or `executing`.
- [ ] On completion update last status, failure count, next eligible time and active task id in `.automation.json`.
- [ ] Append a deduplicated attention item for failure, missing input, plan review or final acceptance.
- [ ] Never recursively start another Agent from the completion callback.

### Task 5: Biography Panel Controls

- [ ] Add per-project automatic-progress toggle, `仅探索/可执行` mode selector, cadence selector, allowed-root input for execution mode, and `立即运行` button.
- [ ] Show runtime status, last run and failure state from `.automation.json`.
- [ ] Add `待处理事项` beside index and idea inbox document actions.
- [ ] Refresh project and automation state after policy writes and run completion.
- [ ] Confirm narrow-panel controls wrap without overlap.

### Task 6: Verification

- [ ] Run:

```bash
npx vitest run tests/identity-project-automation.test.js tests/identity-projects-core.test.js tests/identity-plugin.test.js tests/plugin-details.test.js
npx eslint extensions/dev.identity/project-automation-core.js extensions/dev.identity/projects-core.js extensions/dev.identity/identity-core.js extensions/dev.identity/main.js extensions/dev.agents/main.js extensions/dev.scheduler/main.js tests/identity-project-automation.test.js tests/identity-plugin.test.js
npm run build
git diff --check
```

- [ ] In the browser enable one fixture project in explore mode, run it manually, confirm one Agent task is created, and verify automation status/attention rendering without an overlapping second run.
