# Runtime OpenTelemetry

Date: 2026-09-17
Status: trace export, bounded diagnostics, protected access, PostgreSQL
projection, and local PostgreSQL fallback implemented; production rollout remains
opt-in.

## Delivered behavior

Runtime now exports one `invoke_agent` root per Attempt, with `chat` and
`execute_tool` children. Fixed span names keep model/tool catalogs out of names;
their identifiers are attributes.

- An Attempt ends when its terminal outcome has been persisted, including
  failure, user cancellation and timeout. A store failure also closes the span.
- `chat` covers credential acquisition, transport, stream/JSON consumption and
  credential release. It ends even without usage, on HTTP/parse/stream failure,
  or when the consumer closes the iterator. There is no model retry loop.
- `chat.duration` is model call-chain wall time. The
  `zion.model.consumer_wait.duration` attribute records time yielded to the
  caller, and diagnostics expose `consumerWaitMs` plus `activeDurationMs`.
  Neither value is pure provider inference time.
- Model context is bound on each iterator `next`/`return`, preserving the
  consumer's Attempt context and isolating concurrent Runs.
- `execute_tool` starts at Broker invocation, before receipt lookup. It covers
  routing, execution, artifact enrichment and receipt persistence. It records
  `receipt_hit`, host kind, counts and `ok=false` results.
- Executor policy denials are bounded root events. They do not pretend that a
  Tool Host executed the rejected call. Broker policy errors use
  `error.type=policy_denied`; consumers must distinguish these from infrastructure
  errors.
- `RunRecord.metadata.zionTelemetry` stores version, Attempt ID, trace ID, span
  ID and trace flags. Resume creates a new trace and links the immediately
  previous Attempt, including across executor/process restarts. Missing or
  invalid metadata does not prevent resume. Unsampled traces may have no backend
  record, even though their correlation IDs are valid.
- If an active initiator span exists, the Attempt links it. HTTP/scheduler spans
  themselves are not instrumented yet.

Semantic RunEvents, tool receipts and document projection remain the business
mechanisms. Token and reasoning deltas are transient: Workbench receives them
through the in-memory live hub, while the selected Runtime Store saves complete
messages and semantic events only. Telemetry never writes to Yjs.

In PostgreSQL account mode Runtime maintains a bounded, sanitized projection in
`obs_runs`, `obs_events`, and `obs_stages`, partitioned by Space with forced
RLS. Local/offline mode maintains the same projection contract in
`PostgreSQL observability tables`.
Run Ledger facts remain available when `ZION_OBSERVABILITY_QUERY_URL` is not
configured; the optional backend only enriches trace timing:

- `GET /v1/observability/status` reports `queryBackend.available`, which checks
  the configured Jaeger Query API, and reports projection coverage;
- `GET /v1/observability/projection` reports projection coverage, limits,
  counts, and health;
- `GET /v1/runs/{runId}/diagnostics` joins Run Ledger state with a sanitized
  Trace projection and defaults to summary-only output;
- Runtime exposes `observabilityQuery` for bounded read-only SQL over
  `obs_runs`, `obs_events`, and `obs_stages`;
- Runtime exposes `observabilityRawRead` for exact, byte-bounded,
  credential-redacted tool-call evidence;
- built-in plugin `dev.observability` contributes the `run-diagnostics` Skill,
  which documents the fact schema and evidence access without generating
  conclusions itself;
- every Tool call revalidates the current Space grant and
  `observability.read`; query and raw evidence access are account-audited;
- only callers with the owner-level `device.manage` scope receive an external
  Trace URL.

## Local startup

From the repository root, install dependencies and build Runtime:

```bash
npm install
npm run runtime:build
```

The repository currently installs shared dependencies at the root. The Runtime
library declares only `@opentelemetry/api`; the host declares the Node SDK and
exporter dependencies.

With Docker Engine and Compose available:

```bash
docker compose -f deploy/otel-collector/compose.yaml up -d
docker compose -f deploy/otel-collector/compose.yaml logs -f collector
```

The stack pins Collector Contrib `0.160.0` and Jaeger `2.20.0`. Host ports 4318
and 16686 are bound to loopback. The Collector applies memory limiting,
attribute filtering and batching, then forwards traces to Jaeger without a
debug exporter. Jaeger uses a named-volume Badger store with a seven-day span
TTL. `jaeger-init` creates the writable data directory for Jaeger's non-root
container user.

Open the local trace UI at:

```text
http://127.0.0.1:16686
```

Start a development Runtime:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
OTEL_SERVICE_NAME=zion-runtime \
ZION_DEPLOYMENT_ENVIRONMENT=development \
ZION_OBSERVABILITY_QUERY_URL=http://127.0.0.1:16686 \
ZION_OTEL_TRACE_URL_TEMPLATE='http://127.0.0.1:16686/trace/{traceId}' \
npm run runtime:serve
```

Without an endpoint, telemetry is disabled. A configured endpoint enables traces
with a default sample ratio of 1, suitable for local validation. The
observability query URL is configured independently: omitting it leaves Runs
and trace export intact; `observabilityQuery` remains available with sanitized
Run Ledger facts, while trace state reports `telemetry-disabled`.

Generate a deterministic model-tool-model trace:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
OTEL_SERVICE_NAME=zion-runtime \
ZION_OTEL_TRACE_URL_TEMPLATE='http://127.0.0.1:16686/trace/{traceId}' \
npm run observability:smoke
```

The command prints the Run, Attempt and Trace IDs plus a direct Jaeger URL.

`main.mjs` imports the bootstrap, so direct `node`, npm, remote-launcher and
existing systemd entry paths all initialize it. The same module is also usable
as `node --import ./apps/runtime/src/telemetry/bootstrap.mjs ...`. Only manual
semantic spans are enabled, so no module monkey-patching is required yet.

Inspect correlation using the existing `GET /v1/runs/{runId}` response under
`run.metadata.zionTelemetry`, then search the backend by `traceId` or
`zion.run.id`. Model inspection in the Workbench remains a separate local
diagnostic feature.

## Configuration contract

| Setting | Default / behavior |
|---|---|
| `OTEL_SDK_DISABLED` | `1` or `true` disables telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No default; base URL gets `/v1/traces` appended |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Optional exact signal URL; takes precedence |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` only |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | Optional signal override; `http/json` only |
| `OTEL_TRACES_SAMPLER` | `parentbased_traceidratio` only |
| `OTEL_TRACES_SAMPLER_ARG` | `1`; finite number in `[0,1]` |
| `OTEL_SERVICE_NAME` | `zion-runtime` |
| `ZION_SERVICE_VERSION` | `0.1.0`; set to release/commit identifier |
| `ZION_DEPLOYMENT_ENVIRONMENT` | `development` |
| OTLP header variables | Standard exporter authentication headers are supported |
| `ZION_OBSERVABILITY_QUERY_URL` | No default; Jaeger base URL used only by the Runtime query adapter |
| `ZION_OBSERVABILITY_QUERY_TOKEN` | Optional bearer token sent only to the configured query Backend |
| `ZION_OTEL_TRACE_URL_TEMPLATE` | Optional owner-only HTTP(S) link containing one `{traceId}` placeholder |

Resource identifiers accept up to 128 letters, digits, dots, underscores and
hyphens. Invalid values fall back to defaults. Endpoint credentials, query and
fragment components are rejected. Use exporter headers for authentication.
Unsupported protocol/sampler, invalid URL or initialization failure produces one
generic stderr warning and leaves the application running.

There is deliberately no content-capture or SDK debug switch. `OTEL_LOG_LEVEL`
does not enable detailed SDK diagnostics in this bootstrap. No implicit logs or
metrics exporter is created, even if their environment variables are present.

For non-local collectors, configure HTTPS and authenticated access according to
the deployment environment. Do not expose the development debug receiver.

## Proposed ECS topology

For the existing Runtime at `runtime.zioon.tech`, the initial production shape
should be:

```text
zion-runtime process
  -> 127.0.0.1:4318 Collector
  -> private OTLP endpoint of the selected Trace Backend

authorized browser
  -> HTTPS reverse proxy / SSO
  -> Jaeger or Grafana query UI
```

Deployment requirements:

- keep Collector OTLP ports private to localhost or the VPC;
- expose only the authenticated HTTPS query UI, never port 4318;
- use the committed single-node Badger configuration and named volume;
- retain Trace data for seven days; Trace backup is not required because
  RunStore remains authoritative;
- apply CPU/memory limits independently to Runtime, Collector and Backend;
- use 100% sampling only for the explicit `single-user-pilot` environment and
  reassess before broader rollout;
- set `ZION_SERVICE_VERSION` to the deployed release/commit;
- use a separate service name and instance ID for every future Runtime/Connector
  process;
- preserve RunStore as the authoritative record if telemetry is missing.

The current `__Host-zion_session` cookie cannot be shared with another subdomain.
The first integrated rollout should therefore use the Owner-protected
`https://runtime.zioon.tech/observability/` path. A future
`observe.zioon.tech` is a clearer independent security boundary only after
OIDC/SSO or another dedicated authentication proxy exists. The detailed
current-code analysis is in
[OTEL-JAEGER-ACCESS-CREDENTIAL-DESIGN-20260916.md](../architecture/OTEL-JAEGER-ACCESS-CREDENTIAL-DESIGN-20260916.md).

Generate the Caddy route from source:

```bash
npm run deploy:configure -- \
  --mode domain \
  --domain runtime.example.com \
  --observability-port 16686
```

The generated route authenticates `/observability/` through Runtime, removes
Cookie and Authorization before proxying to Jaeger, and returns `404` for
Jaeger's MCP and browser OTLP paths. Without `--observability-port`, generated
Caddy behavior is unchanged.

Remote Resource Nodes are not instrumented in the current slice. Their complete
Tool duration is visible from Runtime, but routing, queue, delivery, remote
execution and result upload are not yet separate spans. Do not infer Node-local
causes until Device trace propagation is implemented.

## Privacy and failure isolation

The source adapter constructs metadata explicitly. An exporter wrapper then
rebuilds spans from allowlisted fields, dropping unrelated instrumentation,
unknown names, raw exception events, status messages, arbitrary resource
attributes, baggage/tracestate and link attributes.

No prompt, reasoning, model/tool body, URL, path, command, email, authorization,
cookie or credential field is exported. Opaque internal IDs and configured
model/provider/tool identifiers are exported. These identifiers are metadata
contracts: do not use user content or secrets as catalog names or IDs. This
filter is not a general secret detector for arbitrary strings.

Resource auto-detection is disabled, so command-line arguments, environment
resource attributes and hostname cannot silently enter exports. The only
Resource attributes are service name/version, a random process instance ID and
deployment environment.

| Limit | Value |
|---|---|
| Batch queue | 1,024 spans |
| Export batch | 128 spans |
| Batch interval | 1 second |
| OTLP request timeout | 1 second |
| Processor export timeout | 1.5 seconds |
| Shutdown wait bound | 2 seconds |
| Span attributes / value length | 40 / 128 characters |
| Span events / links | 32 / 2 |

Exporter rejection, network failure and slow response cannot alter Run status
or wait on the durable event append path. Overflow or process termination can
lose telemetry. Telemetry is not an audit store.

One generic warning is emitted per process on initialization/export failure.
Repeated failures are intentionally quiet. Export health metrics and alerts are
future work. `SIGINT`/`SIGTERM` first complete normal Runtime shutdown, then flush
telemetry within the bound. This bound applies to telemetry, not all existing
Runtime service shutdown work.

Rollback requires only a restart with `OTEL_SDK_DISABLED=1` or removal of the
endpoint. No database migration is needed.

## Validation

The focused observability suite contains **70 passing cases**:

| File | Cases | Evidence |
|---|---:|---|
| `packages/runtime/tests/agent-telemetry.test.ts` | 8 | Attempt status, concurrent isolation, ordered events, multi-resume links, missing metadata |
| `packages/runtime/tests/genai-telemetry.test.ts` | 14 | Streaming/JSON, consumer backpressure, HTTP/parse/truncation, credential cleanup, cancellation |
| `apps/runtime/tests/runtime-tool-telemetry.test.js` | 8 | Policy, result errors, exception, cancellation, plugin/local routing, receipts, model-tool-model golden trace |
| `apps/runtime/tests/telemetry-policy.test.js` | 6 | Content removal across export surfaces, bounded fields, exporter failure isolation |
| `apps/runtime/tests/telemetry-bootstrap.test.js` | 9 | Disabled/invalid/zero sampling, real OTLP HTTP, slow/rejecting/unreachable receiver, shutdown |
| `apps/runtime/tests/observability-service.test.js` | 19 | Ledger facts, state semantics, bounds, overview scope, sanitization and HTTP policy |
| `apps/runtime/tests/observability-plugin.test.js` | 5 | Manifest, both Tools, Backend-independent registration and visibility |
| `apps/runtime/tests/access-control.test.js` | 1 relevant case | Owner-only observability authorization |

`npm run runtime:test` passed: **480 tests in the current source tree**. Its broad
compatibility glob additionally ran 60 tests under existing `.deploy-tmp`
snapshots; those are not counted as current-source coverage.

The checked-in Collector config passes Collector Contrib `0.160.0` validation.
The Badger config passes Jaeger `2.20.0 validate`, and
`docker-compose config` accepts the named-volume topology. The Docker daemon and
Caddy binary were unavailable for container startup and `caddy validate`.

The native local chain passed:

```text
Runtime SDK
  -> Jaeger OTLP :14328
  -> Badger
  -> Jaeger Query API :17686
```

The deterministic smoke produced Trace
`804f1fcba247dd9c4009d6c40dd85fdf` with the expected four operations:
`invoke_agent`, `chat`, `execute_tool`, `chat`. The stored JSON contained none
of the smoke prompt, tool path or tool result. Jaeger was stopped and restarted
against the same Badger directory; the same Trace and all four spans remained
queryable.

Reproduce the automated checks:

```bash
npm run runtime:build
npm run runtime:test
```

## Performance baseline

The representative mode executes five warm-ups and 30 measured Runs using a
real PostgreSQL RunStore, two model calls and one instrumented Tool call per Run.
The model transport and Tool body are deterministic, so the result measures
Runtime overhead rather than provider latency.

One local macOS / Node 22.18 comparison:

| Mode | startup ms | p50 Run ms | p95 Run ms | RSS MiB | event-loop p95 ms |
|---|---:|---:|---:|---:|---:|
| SDK disabled | 178.16 | 2.564 | 17.313 | 171.0 | 32.342 |
| Collector healthy | 630.77 | 2.769 | 6.111 | 196.8 | 13.033 |
| Collector unavailable | 711.15 | 2.646 | 6.761 | 199.0 | 12.837 |

The enabled p50 deltas were `+0.205 ms` and `+0.082 ms`; neither enabled p95
exceeded the disabled p95 in this noisy short run. SDK startup and RSS costs
remain visible. This satisfies the current absolute `<20 ms` Run-latency gate
for the single-user pilot, so the committed example keeps 100% sampling.
Re-run this benchmark before multi-user rollout or a higher concurrency target.

The reusable commands are:

```bash
OTEL_SDK_DISABLED=1 \
  node scripts/benchmark-runtime-telemetry.mjs --representative

OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
  node scripts/benchmark-runtime-telemetry.mjs --representative

OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
  node scripts/benchmark-runtime-telemetry.mjs --representative
```

Next work follows the
[roadmap](../architecture/OPENTELEMETRY-OBSERVABILITY-ROADMAP.md) and the
[consumption experience design](../architecture/OTEL-CONSUMPTION-EXPERIENCE-AND-AGENT-DIAGNOSTICS-DESIGN-20260916.md):
context/turn/projection spans, HTTP exclusions and propagation, representative
performance tuning, Device trace context, standard metrics, dashboards and
structured logs. Production endpoint and identity-export policy remain
deployment decisions. Tail sampling cannot recover head-dropped traces.
