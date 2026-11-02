---
name: adc-studio
description: Use the independent ADC Studio test plugin for authorized device discovery, live tools, file reads and task receipts.
---

# ADC Studio

Plugin ID: `dev.adc-studio`. Uses its own per-account ADC OAuth connection.

1. Call `adc_studio_status` or `adc_studio_discover` first. Do not invent device IDs, roots or tools.
2. Use `adc_studio_read` for a discovered read-only tool:
   `{"tool":"file.list","nodeId":"<discovered>","args":{"rootId":"<discovered>","path":"","glob":"*"}}`.
   ADC represents an authorized root with an empty relative path. Use `glob:"*"` for the current directory; `**/*` recurses.
3. For side effects, use `adc_studio_invoke` with explicit confirmation, the discovered schema and a stable `idempotencyKey`. Do not claim the user confirmed an operation they did not authorize.
4. Track returned `invocationId` and `jobId`. `queued`, `running`, `approval_required` and HTTP acceptance are not completion.
5. Query `adc_studio_task` for an existing task. On `unknown_outcome`, inspect the original invocation and actual effect before any new operation. Never silently retry with a new key.
6. `adc_studio_cancel` requires the existing job ID. Verify the final state after cancellation.

Device/Agent policy remains authoritative. Authorization and approval changes happen in ADC's management pages. Never execute on the platform server as a fallback.
