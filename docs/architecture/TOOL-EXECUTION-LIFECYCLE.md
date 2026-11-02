# Tool Execution Lifecycle

## Purpose

Tool implementations provide domain behavior. They do not implement their own
deadline scheduler, cancellation bridge, retry classification, duplicate
suppression, or Runtime receipt handling.

The shared path is:

```text
AgentEngine
  -> RuntimeToolBroker authorization and receipt lookup
  -> request/invocation fence
  -> ToolInvocationLifecycle deadline and cancellation
  -> Runtime plugin, Runtime-native tool, or Device Tool Host
  -> artifact enrichment
  -> durable Runtime receipt
```

Device capabilities carry the same execution contract. `NodeBroker` derives the
remote invocation lease from it, and Device Connector receives cancellation
through the existing `tool.cancel` command.

## Plugin Contract

A Runtime plugin declares only the operation traits:

```js
context.tools.registerTool({
  name: "report.publish",
  description: "Publish a report to the configured service.",
  inputSchema: {
    type: "object",
    properties: {
      report_id: { type: "string" }
    },
    required: ["report_id"],
    additionalProperties: false
  },
  execution: {
    effect: "external",
    timeoutMs: 60_000,
    maxTimeoutMs: 120_000
  },
  policy: { minimumPreset: "trusted-automation" },
  async invoke(args, { signal }) {
    return publishReport(args.report_id, { signal });
  }
});
```

The plugin does not create a timer, persist an invocation receipt, or decide
whether a failed invocation may be retried. Passing `signal` into a cancellable
domain API improves shutdown latency, but the platform remains conservative if
the host cannot confirm cancellation.

`execution` is normalized by `@zion/plugin-sdk`:

| Field | Values | Meaning |
| --- | --- | --- |
| `effect` | `read`, `write`, `process`, `external` | User-visible effect class |
| `timeoutMs` | positive integer | Default host execution deadline |
| `maxTimeoutMs` | positive integer | Maximum accepted dynamic deadline |
| `timeoutArgument` | property name | Optional numeric argument such as Bash `timeout` |
| `cancellation` | `cooperative`, `best-effort`, `none` | Host cancellation capability |
| `idempotency` | `safe`, `invocation`, `reconcile` | Retry and duplicate policy |

Declaring only `effect` is normally sufficient. The platform fills the
remaining fields. Old Runtime plugins with no declaration use the conservative
`process/reconcile` policy. Existing manifest risk declarations are also
understood.

## Default Policies

| Effect | Timeout | Cancellation | Idempotency |
| --- | ---: | --- | --- |
| `read` | 30s | cooperative | safe |
| `write` | 60s | cooperative | same invocation only |
| `process` | 120s | best effort | reconcile before retry |
| `external` | 60s | best effort | reconcile before retry |

The Runtime adds a delivery/result grace period around the host timeout.
Device leases use the larger of the configured base lease and the declared
execution timeout plus Device delivery grace.

## Outcome Rules

- A completed invocation is persisted under its stable `invocationId`.
- Reusing that ID with the same request replays the receipt.
- Reusing that ID with different arguments is rejected.
- Concurrent delivery of the same invocation to one Runtime shares one
  execution.
- Concurrent identical side effects with different invocation IDs are fenced
  within that Runtime.
- A safe read interrupted by its deadline returns `failureCode=timeout` and
  `retryable=true`.
- An interrupted write, process, or external effect returns
  `failureCode=execution_outcome_unknown` and `retryable=false`.
- A later identical side-effect request is blocked while an unknown receipt
  exists. The caller must inspect or reconcile effects before issuing a
  deliberately different operation.
- Result delivery from Device Connector retries with bounded exponential
  backoff. A late result after lease expiry is rejected and cannot overwrite the
  Runtime's unknown-outcome receipt.

`cancellation` describes host behavior; `idempotency` determines retry safety.
They are separate because a cooperative cancellation request does not prove
that a side effect did not already happen.

## Host Responsibilities

The platform owns generic lifecycle mechanics. A Tool Host still owns facts
that only the domain can know:

- validate arguments and authorization at the host boundary;
- use atomic or conditional writes where the domain supports them;
- honor the supplied cancellation signal where practical;
- expose a domain-specific inspect or reconcile operation for non-idempotent
  effects;
- return a stable `failureCode` when it has more precise evidence than the
  platform.

These are domain semantics, not duplicated lifecycle infrastructure.

The current in-flight fence is process-local, matching the single active Runtime
deployment model. Completed and unknown receipts are durable. Active-active
Runtime replicas will require a transactional invocation claim in PostgreSQL
before horizontal execution is enabled; the post-execution unique receipt alone
is not a distributed lock.
