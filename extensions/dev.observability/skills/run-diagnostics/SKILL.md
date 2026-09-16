---
name: "run-diagnostics"
description: "Diagnose why a completed Zion Run was slow, failed, timed out, or behaved unexpectedly by combining a sanitized OpenTelemetry summary with Run Ledger facts."
---

# Run Diagnostics

Use this skill when the user asks why a Zion Run was slow, failed, cancelled,
or otherwise behaved unexpectedly.

## Workflow

1. For a specific Run, call `observabilityInspect`.
2. For "recent problems", call `observabilityOverview`, then inspect at most
   three relevant Run ids.
3. For "the previous Run", omit `run_id`; the Tool selects the latest terminal
   Run in the current Session.
4. Treat `ledger` as authoritative for status, ordering, usage, and policy
   denial. Use Trace only for observed timing and relationships.
5. State `coverage`, `traceState`, and `limitations` before drawing conclusions.
6. Give at most three conclusions directly supported by returned evidence.

## Interpretation Rules

- Do not claim causality from duration alone.
- Missing spans mean unknown, not zero duration.
- `unsampled` or Backend unavailability does not mean the Run failed.
- A policy denial is not a Tool Host failure.
- Do not output raw Tool JSON unless explicitly requested.
