# Agent Live Run Design

## Problem

Project automation runs through the Agents headless runner, but the runner currently waits for completion without consuming `execution.events`. The Agent body therefore remains static while running, tool activity is invisible, and the event queue accumulates in memory. A restarted or otherwise interrupted run can also leave the Agent task marked `running` after Biography has already marked the project run failed.

## Decision

Reuse the programmatic-run event projection already used by Scheduler. Every project-automation Agent run creates a normal background session and projects the same event stream into that session while also maintaining a throttled live mirror in the Agent task.

Scheduler remains only a heartbeat source. Identity remains the project coordinator. Agents owns task execution, live transcript, linked session, and terminal task state.

## Runtime Flow

1. Identity creates an Agent task and starts it through `runTaskHeadless`.
2. Agents creates an indexed session with `open: false`, records its ID on the task, and starts `window.zion.chat.execute`.
3. Agents consumes `execution.events` concurrently with `execution.completion`.
4. The shared projector writes assistant tokens and tool events into the linked session.
5. Agents batches token and event updates into `task.body` and `task.events`, so the open Agents panel shows live text without rerendering for every token.
6. Completion, failure, abort, timeout, and restart interruption set both the Agent task and project policy to terminal states.

## User Experience

- Opening the Agent task while it runs shows assistant text as it arrives.
- The run log is expanded while running or failed and shows tool requests, results, denials, and the concrete failure reason.
- The Agent task links to the persisted session for the complete conversation and tool trace.
- Failure messages in Agents, Biography, and `projects/attention.md` use the same concrete error.
- A stale task recovered after restart becomes `error`, never remains visually `running`.

## Boundaries

- Do not move project selection or readiness logic into Scheduler.
- Do not expose additional automation permissions.
- Do not write authorization state into project Markdown.
- Keep ordinary non-programmatic Agent tasks on their existing editor-backed runner.

## Verification

- Unit-test event-to-transcript formatting and throttled flush behavior.
- Test successful, failed, aborted, timeout, and interrupted task terminal states.
- Test that the linked session receives streamed assistant text and tool events.
- Test that Identity recovery terminates a stale Agent task and propagates its error.
- Run targeted Vitest suites, ESLint, production build, and staged-diff checks.
