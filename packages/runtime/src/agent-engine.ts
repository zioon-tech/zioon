import { AsyncQueue } from "./async-queue.js";
import { CancellationController, RunCancelledError } from "./cancellation.js";
import { normalizeCapabilityPolicy } from "./capability-policy.js";
import { dispatchRunHook } from "./run-hooks.js";
import { context, trace } from "@opentelemetry/api";
import {
  attemptMetadata,
  cancellationType,
  failSpan,
  startAttempt,
  storedAttemptContext,
  telemetryIdentifier
} from "./telemetry.js";
import type {
  AgentCheckpoint,
  AgentEngine,
  CapabilityPolicy,
  CancellationSignal,
  ContextProvider,
  EngineOutputEvent,
  ModelRef,
  PendingRunStep,
  RunHookStage,
  RunHookDecision,
  RunWait,
  ResumeRunRequest,
  RunAuthorizer,
  RunAuthorizationPhase,
  RunEvent,
  RunHandle,
  RunRecord,
  RunController,
  RunRequest,
  RunResult,
  RunOutboxEntry,
  RunStore,
  TimeoutScheduler,
  ToolAuthorizer,
  ToolBroker,
  ToolCall,
  ToolResult,
  TranscriptMessage,
  Usage
} from "./protocol.js";

const TRANSIENT_STREAM_EVENT_TYPES = new Set([
  "message.delta",
  "reasoning.delta"
]);
const DEFERRED_OBSERVATION_EVENT_TYPES = new Set(["model.timing", "reasoning.started"]);
type ContextTiming = {
  providerId: string;
  stage: "pre" | "post";
  authorizationMs: number;
  contributionMs: number;
  status: "completed" | "failed";
};
const MODEL_REQUEST_CONFIG_KEYS = [
  "frequency_penalty",
  "max_completion_tokens",
  "max_tokens",
  "model",
  "presence_penalty",
  "reasoning_effort",
  "seed",
  "stop",
  "stream",
  "temperature",
  "thinking",
  "top_p"
] as const;

export type AgentExecutorDependencies = {
  engine: AgentEngine;
  tools: ToolBroker;
  runs: RunStore;
  contexts?: ContextProvider[];
  controllers?: RunController[];
  bindRun?: (request: RunRequest, context: {
    runId: string; attemptId: string; signal: CancellationSignal;
    resumed: boolean; preview?: boolean;
  }) => Promise<{
    contexts?: ContextProvider[];
    controllers?: RunController[];
    metadata?: Record<string, unknown>;
    terminalOutbox?: (result: RunResult) => RunOutboxEntry[];
    dispose?: () => void | Promise<void>;
  }>;
  authorizeTool?: ToolAuthorizer;
  authorizeRun?: RunAuthorizer;
  scheduleTimeout?: TimeoutScheduler;
  now?: () => number;
  createId?: (prefix: string) => string;
  defaultMaxTurns?: number;
};

export type AgentExecutor = {
  execute(request: RunRequest): RunHandle;
  resume(runId: string, request?: ResumeRunRequest): Promise<RunHandle>;
  preview(request: RunRequest): Promise<{
    runId: string;
    attemptId: string;
    turn: number;
    request: Extract<EngineOutputEvent, { type: "model.request" }>["request"];
    contextFailures: Array<{ providerId: string; stage: string; error: string }>;
  }>;
};

type RunPatch = Pick<RunRecord, "status" | "updatedAt"> &
  Partial<Pick<
    RunRecord,
    | "attemptId"
    | "completedAt"
    | "terminalReason"
    | "error"
    | "model"
    | "output"
    | "usage"
    | "metadata"
    | "waiting"
  >>;

type StartState = {
  runId: string;
  attemptId: string;
  initialSequence: number;
  initialMessages: TranscriptMessage[];
  initialOutput: string;
  initialUsage: Usage;
  initialCounters: { toolCalls: number };
  startTurn: number;
  existingRun: RunRecord | null;
  authorizeAdmission?: boolean;
  previousAttemptId?: string;
  resumedFromSequence?: number;
  pending?: PendingRunStep;
  resumeInput?: { waitId: string; input?: unknown };
};

class RunSuspended extends Error {
  constructor(readonly waiting: RunWait) { super(waiting.reason); }
}

const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
};

function createDefaultId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function resolveMaxTurns(
  requestedMaxTurns: unknown,
  defaultMaxTurns: number,
  maxToolCalls: number
): number {
  const explicit = positiveInteger(requestedMaxTurns, 0);
  if (explicit) return explicit;
  return Math.max(
    positiveInteger(defaultMaxTurns, 16),
    positiveInteger(maxToolCalls, 50) + 1
  );
}

function normalizeMessages(request: RunRequest): TranscriptMessage[] {
  const messages = Array.isArray(request.messages)
    ? request.messages.map((message) => ({ ...message }))
    : [];
  const prompt = String(request.prompt || "").trim();
  if (prompt) messages.push({ role: "user", content: prompt });
  if (messages.length === 0) throw new Error("prompt or messages are required");
  return messages;
}

function cloneMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  return JSON.parse(JSON.stringify(messages)) as TranscriptMessage[];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalJson(item)}`
    ).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  if (typeof value === "bigint") return JSON.stringify(String(value));
  return JSON.stringify(value) ?? "null";
}

async function requestHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

function toolName(value: unknown): string {
  const tool = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const fn = tool.function && typeof tool.function === "object"
    ? tool.function as Record<string, unknown>
    : {};
  return String(fn.name || tool.name || "").trim();
}

async function modelRequestSummary(request: Record<string, unknown>) {
  const payload = request.payload && typeof request.payload === "object"
    ? request.payload as Record<string, unknown>
    : {};
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const toolNames = Array.from(new Set(tools.map(toolName).filter(Boolean)));
  const config = Object.fromEntries(MODEL_REQUEST_CONFIG_KEYS
    .filter((key) => payload[key] !== undefined)
    .map((key) => [key, payload[key]]));
  const [payloadHash, messagesHash, toolsHash] = await Promise.all([
    requestHash(payload),
    requestHash(messages),
    requestHash(tools)
  ]);
  const {
    payload: _payload,
    ...requestMetadata
  } = request;
  return {
    summaryVersion: 1,
    ...requestMetadata,
    messageCount: messages.length,
    toolCount: tools.length,
    toolNames,
    payloadBytes: utf8Bytes(payload),
    payloadHash,
    messagesHash,
    toolsHash,
    config
  };
}

function stringSet(value: unknown): Set<string> {
  return new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  );
}

function contextProviderEnabled(
  provider: ContextProvider,
  request: RunRequest
): boolean {
  if (provider.required) return true;
  const selection = request.metadata?.contextProviders;
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    return true;
  }
  const config = selection as { enabled?: unknown; disabled?: unknown };
  const providerId = String(provider.id || "");
  const disabled = stringSet(config.disabled);
  if (disabled.has(providerId)) return false;
  const enabled = stringSet(config.enabled);
  return enabled.size === 0 || enabled.has(providerId);
}

async function applyContextStage({
  contexts,
  stage,
  messages,
  request,
  runId,
  attemptId,
  turn,
  signal,
  contextExtras = {},
  onTiming,
  reauthorize,
  onFailure
}: {
  contexts: ContextProvider[];
  stage: "pre" | "post";
  messages: TranscriptMessage[];
  request: RunRequest;
  runId: string;
  attemptId: string;
  turn?: number;
  signal: CancellationSignal;
  contextExtras?: Partial<import("./protocol.js").ContextProviderContext>;
  onTiming?: (timing: ContextTiming) => void;
  reauthorize: (phase: RunAuthorizationPhase) => void | Promise<void>;
  onFailure: (
    provider: ContextProvider,
    error: unknown
  ) => void | Promise<void>;
}): Promise<TranscriptMessage[]> {
  const selected = contexts
    .map((provider, index) => ({ provider, index }))
    .filter(({ provider }) => (provider.stage || "pre") === stage)
    .filter(({ provider }) => contextProviderEnabled(provider, request))
    .sort((left, right) =>
      (left.provider.order ?? 50) - (right.provider.order ?? 50)
      || left.index - right.index
    )
    .map(({ provider }) => provider);
  let output = messages;
  const measure = async (provider: ContextProvider, apply: () => Promise<void>) => {
    signal.throwIfCancelled();
    const startedAt = performance.now();
    await reauthorize("context");
    const authorizedAt = performance.now();
    let status: ContextTiming["status"] = "completed";
    let contributedAt = authorizedAt;
    try {
      await apply();
      contributedAt = performance.now();
    } catch (error) {
      contributedAt = performance.now();
      status = "failed";
      await onFailure(provider, error);
      if (provider.required) throw error;
    } finally {
      onTiming?.({
        providerId: provider.id, stage, status,
        authorizationMs: Math.max(0, authorizedAt - startedAt),
        contributionMs: Math.max(0, contributedAt - authorizedAt)
      });
    }
  };

  if (stage === "pre") {
    const preparedMessages: TranscriptMessage[] = [];
    for (const provider of selected.filter((item) => !item.contribute)) {
      await measure(provider, async () => {
        if (!provider.prepare) {
          throw new Error("provider has no prepare or contribute implementation");
        }
        const prepared = await provider.prepare(request);
        if (!Array.isArray(prepared)) {
          throw new Error("provider returned an invalid result");
        }
        preparedMessages.push(...prepared);
      });
    }
    output = [...preparedMessages, ...output];
  }

  for (const provider of selected.filter((item) => !!item.contribute)) {
    await measure(provider, async () => {
      const contributed = await provider.contribute?.(
        cloneMessages(output),
        {
          runId,
          attemptId,
          ...(turn === undefined ? {} : { turn }),
          request,
          signal,
          ...contextExtras
        }
      );
      if (!Array.isArray(contributed)) {
        throw new Error("provider returned an invalid result");
      }
      output = cloneMessages(contributed);
    });
  }
  return output;
}

function addUsage(current: Usage, patch: Partial<Usage>): Usage {
  return {
    inputTokens: current.inputTokens + positiveInteger(patch.inputTokens, 0),
    outputTokens: current.outputTokens + positiveInteger(patch.outputTokens, 0),
    reasoningTokens: current.reasoningTokens + positiveInteger(patch.reasoningTokens, 0),
    cacheReadTokens: current.cacheReadTokens + positiveInteger(patch.cacheReadTokens, 0),
    cacheWriteTokens: current.cacheWriteTokens + positiveInteger(patch.cacheWriteTokens, 0)
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown runtime error");
}

function toolFailureCode(result: ToolResult | null, fallback = "tool_error"): string | undefined {
  if (result?.ok !== false) return undefined;
  const explicit = String(result.failureCode || "").trim();
  if (explicit) return explicit;
  const text = `${result.error || ""}\n${result.content || ""}`.toLowerCase();
  if (/execution outcome is unknown|may still be running|termination was not confirmed/.test(text)) {
    return "execution_outcome_unknown";
  }
  if (/http\s+429|status\s+429/.test(text)) return "rate_limit";
  if (/http\s+4\d\d|status\s+4\d\d/.test(text)) return "http_4xx";
  if (/http\s+5\d\d|status\s+5\d\d/.test(text)) return "http_5xx";
  if (/timeout|timed\s*out|und_err_connect_timeout|etimedout/.test(text)) return "timeout";
  if (/enotfound|eai_again|getaddrinfo|dns/.test(text)) return "dns_error";
  if (/resource_execution_denied|outside_grant|not allowed by capability policy|policy/.test(text)) return "policy_denied";
  if (/permission denied|eacces|forbidden/.test(text)) return "permission_denied";
  if (/cancelled|canceled|aborted/.test(text)) return "cancelled";
  if (/fetch failed|network|econnreset|econnrefused|socket|connection/.test(text)) return "network_error";
  return fallback;
}

function toolFailureCodeFromError(error: unknown): string {
  const explicit = error && typeof error === "object" && "failureCode" in error
    ? String(error.failureCode || "").trim()
    : "";
  if (explicit) return explicit;
  const text = errorMessage(error).toLowerCase();
  if (/execution outcome is unknown|may still be running|termination was not confirmed/.test(text)) {
    return "execution_outcome_unknown";
  }
  if (/timeout|timed\s*out|und_err_connect_timeout|etimedout/.test(text)) return "timeout";
  if (/resource_execution_denied|outside_grant|not allowed by capability policy|policy/.test(text)) return "policy_denied";
  if (/permission denied|eacces|forbidden/.test(text)) return "permission_denied";
  if (/cancelled|canceled|aborted/.test(text)) return "cancelled";
  return "tool_error";
}

function assistantToolCalls(calls: ToolCall[]) {
  return calls.map((call) => ({
    id: call.id,
    type: "function" as const,
    ...(call.providerMetadata ? { providerMetadata: call.providerMetadata } : {}),
    function: {
      name: call.name,
      arguments: call.argumentsText ?? JSON.stringify(call.arguments || {})
    }
  }));
}

function toolMessage(call: ToolCall, result: ToolResult): TranscriptMessage {
  return {
    role: "tool",
    toolCallId: call.id,
    content: result.content || result.error || "",
    toolResultStatus: {
      ok: result.ok,
      ...(toolFailureCode(result) ? { failureCode: toolFailureCode(result) } : {})
    }
  };
}

function invalidToolResult(call: ToolCall): ToolResult {
  return {
    ok: false,
    content: `Invalid tool call arguments for "${call.name}": ${call.validationError || "invalid arguments"}`,
    error: call.validationError || "invalid arguments"
  };
}

function deniedToolResult(reason: string): ToolResult {
  return {
    ok: false,
    content: `Denied by capability policy: ${reason}`,
    error: reason
  };
}

function defaultAuthorizeTool(
  call: ToolCall,
  policy: CapabilityPolicy,
  counters: { toolCalls: number }
) {
  if (counters.toolCalls >= policy.maxToolCalls) {
    return { allowed: false, reason: "tool call quota exceeded" };
  }
  if (!policy.allowedTools.includes(call.name)) {
    return { allowed: false, reason: "tool is not allowed by capability policy" };
  }
  return { allowed: true };
}

function validateCheckpoint(checkpoint: AgentCheckpoint, runId: string): void {
  if (checkpoint.schemaVersion !== 1 || checkpoint.runId !== runId) {
    throw new Error(`Run has an incompatible checkpoint: ${runId}`);
  }
  if (!Array.isArray(checkpoint.messages) || checkpoint.nextTurn < 1) {
    throw new Error(`Run has an invalid checkpoint: ${runId}`);
  }
}

export function createAgentExecutor(dependencies: AgentExecutorDependencies): AgentExecutor {
  const {
    engine,
    tools,
    runs,
    contexts = [],
    controllers = [],
    bindRun,
    authorizeTool = defaultAuthorizeTool,
    authorizeRun,
    scheduleTimeout,
    now = () => Date.now(),
    createId = createDefaultId,
    defaultMaxTurns = 16
  } = dependencies;

  if (!engine?.streamTurn) throw new Error("Agent engine is required");
  if (!tools?.listTools || !tools?.invoke) throw new Error("Tool broker is required");
  if (
    !runs?.create
    || !runs?.append
    || !runs?.get
    || !runs?.getEvents
    || !runs?.appendTranscript
    || !runs?.getTranscript
    || !runs?.saveCheckpoint
    || !runs?.getLatestCheckpoint
  ) {
    throw new Error("Run store is required");
  }

  const startExecution = (request: RunRequest, state: StartState): RunHandle => {
    const {
      runId,
      attemptId,
      initialSequence,
      initialMessages,
      initialOutput,
      initialUsage,
      initialCounters,
      startTurn,
      existingRun,
      authorizeAdmission = false,
      previousAttemptId,
      resumedFromSequence
    } = state;
    const queue = new AsyncQueue<RunEvent>();
    const cancellation = new CancellationController();
    const policy = normalizeCapabilityPolicy(request.policy);
    const effectiveRequest: RunRequest = {
      ...request, policy,
      ...(request.principal ? { principal: Object.freeze({ ...request.principal }) } : {})
    };
    const reauthorize = (phase: RunAuthorizationPhase): void | Promise<void> => {
      if (!authorizeRun) return;
      const authorized = authorizeRun(effectiveRequest, phase);
      if (authorized && typeof (authorized as Promise<CapabilityPolicy>).then === "function") {
        return Promise.resolve(authorized).then((resolved) => {
          Object.assign(policy, normalizeCapabilityPolicy(resolved));
        });
      }
      Object.assign(policy, normalizeCapabilityPolicy(authorized as CapabilityPolicy));
    };
    let maxTurns = resolveMaxTurns(
      request.maxTurns,
      defaultMaxTurns,
      policy.maxToolCalls
    );
    const attemptSpan = startAttempt({
      "zion.run.id": telemetryIdentifier(runId),
      "zion.attempt.id": telemetryIdentifier(attemptId),
      "zion.policy.preset": policy.preset
    }, storedAttemptContext(existingRun?.metadata, existingRun?.attemptId));
    const metadata = { ...(request.metadata || {}) };
    delete metadata.zionTelemetry;
    Object.assign(metadata, attemptMetadata(attemptSpan, attemptId));
    let terminal = false;
    let timeoutDisposable: { dispose(): void } | undefined;
    let resolveCompletion: (result: RunResult) => void = () => {};
    const completion = new Promise<RunResult>((resolve) => {
      resolveCompletion = resolve;
    });
    let resolveReady: () => void;
    let rejectReady: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Existing callers may observe completion only.
    void ready.catch(() => {});

    const abort = async (reason = "user") => {
      if (terminal) return;
      cancellation.cancel(reason);
    };

    const run = async () => {
      let sequence = initialSequence;
      let persisted = !!existingRun;
      let output = initialOutput;
      let usage = { ...initialUsage };
      let messages = cloneMessages(initialMessages);
      const counters = { ...initialCounters };
      let bindings: Awaited<ReturnType<NonNullable<AgentExecutorDependencies["bindRun"]>>> | undefined;
      let runContexts = contexts;
      let runControllers = controllers;
      let pending = state.pending;
      const needsPreContext = !existingRun || pending?.stage === "beforeStart";
      let observationWrites = Promise.resolve();
      const contextTimings: ContextTiming[] = [];

      const publish = async (
        type: string,
        data: Record<string, unknown> = {},
        patch?: RunPatch,
        detailData?: Record<string, unknown>
      ) => {
        const nextSequence = sequence + 1;
        const timestamp = now();
        const event: RunEvent = {
          schemaVersion: 1,
          eventId: createId("event"),
          runId,
          attemptId,
          sequence: nextSequence,
          type,
          timestamp,
          data
        };
        if (TRANSIENT_STREAM_EVENT_TYPES.has(type)) {
          sequence = nextSequence;
          queue.push(event);
          return event;
        }
        if (DEFERRED_OBSERVATION_EVENT_TYPES.has(type)) {
          // These facts do not authorize execution. Deliver them in order and
          // persist in the background; the next durable boundary joins the writes.
          observationWrites = observationWrites.then(() => runs.append(event));
          void observationWrites.catch(() => {});
          sequence = nextSequence;
          queue.push(event);
          return event;
        }
        const observations = observationWrites;
        observationWrites = Promise.resolve();
        await observations;
        const detailEvent = detailData
          ? { ...event, data: detailData }
          : undefined;
        const outbox = ["run.completed", "run.failed", "run.aborted"].includes(type)
          ? bindings?.terminalOutbox?.({
              runId, attemptId, status: patch!.status as RunResult["status"],
              output, usage: { ...usage },
              ...(patch?.terminalReason ? { reason: patch.terminalReason } : {}),
              ...(patch?.error ? { error: patch.error } : {})
            }) : undefined;
        await runs.append(event, patch, detailEvent, outbox);
        sequence = nextSequence;
        queue.push(detailEvent || event);
        return detailEvent || event;
      };
      const appendTranscript = async (
        turn: number,
        ordinal: number,
        message: TranscriptMessage
      ) => {
        await runs.appendTranscript({
          schemaVersion: 1,
          id: createId("transcript"),
          runId,
          attemptId,
          turn,
          ordinal,
          createdAt: now(),
          ...cloneMessages([message])[0]
        });
      };

      const settle = (
        status: RunResult["status"],
        terminalReason: string,
        error?: string,
        waiting?: RunWait
      ) => {
        terminal = true;
        rejectReady(new Error(error || terminalReason));
        attemptSpan.setAttribute("zion.run.status", status);
        if (status === "failed") failSpan(attemptSpan, terminalReason === "persistence-failed"
          ? "persistence_error" : "run_error");
        if (status === "aborted") {
          attemptSpan.setAttribute("zion.cancellation.reason", cancellationType(terminalReason));
          if (terminalReason === "timeout") failSpan(attemptSpan, "timeout");
        }
        attemptSpan.end();
        resolveCompletion({
          runId,
          attemptId,
          status,
          output,
          usage,
          ...(terminalReason !== "completed" ? { reason: terminalReason } : {}),
          ...(error ? { error } : {}),
          ...(waiting ? { waiting } : {})
        });
      };

      try {
        if (authorizeAdmission && authorizeRun) {
          const authorization = reauthorize("admission");
          if (authorization) await authorization;
          maxTurns = resolveMaxTurns(
            request.maxTurns,
            defaultMaxTurns,
            policy.maxToolCalls
          );
        }
        if (!existingRun) {
          const createdAt = now();
          await runs.create({
            id: runId,
            attemptId,
            status: "queued",
            title: String(request.title || ""),
            sessionId: request.sessionId,
            projectId: request.projectId,
            principal: effectiveRequest.principal,
            target: request.target,
            model: request.model,
            modelOptions: request.modelOptions,
            policy,
            metadata,
            inputMessages: cloneMessages(initialMessages),
            createdAt,
            updatedAt: createdAt
          });
          persisted = true;
        }
        resolveReady();

        if (request.timeoutMs !== undefined) {
          if (!scheduleTimeout) {
            throw new Error("timeoutMs requires a TimeoutScheduler");
          }
          const timeoutMs = positiveInteger(request.timeoutMs, 0);
          if (timeoutMs > 0) {
            timeoutDisposable = scheduleTimeout(
              () => cancellation.cancel("timeout"),
              timeoutMs
            );
          }
        }

        if (existingRun) {
          const startedAt = now();
          await publish("attempt.started", {
            engineId: engine.id,
            previousAttemptId: previousAttemptId || existingRun.attemptId,
            resumedFromSequence: resumedFromSequence || 0,
            model: request.model || null
          }, {
            status: "running",
            attemptId,
            metadata,
            model: request.model,
            updatedAt: startedAt,
            completedAt: undefined,
            terminalReason: undefined,
            error: undefined,
            waiting: undefined
          });
        }

        bindings = await bindRun?.(effectiveRequest, {
          runId, attemptId, signal: cancellation.signal, resumed: !!existingRun
        });
        if (bindings) {
          runContexts = [...contexts, ...(bindings.contexts || [])];
          runControllers = [...controllers, ...(bindings.controllers || [])];
          Object.assign(metadata, bindings.metadata || {});
          effectiveRequest.metadata = metadata;
          await publish("run.bindings", { bound: true }, {
            status: existingRun ? "running" : "queued", updatedAt: now(), metadata
          });
        }
        if (new Set(runControllers.map((item) => item.id)).size !== runControllers.length) {
          throw new Error("Duplicate Runtime Hook controller id");
        }
        if (pending && JSON.stringify(pending.controllerIds) !== JSON.stringify(runControllers.map((item) => item.id))) {
          throw new Error("Run controller chain changed; restore the checkpoint controller configuration");
        }
        const availableTools = await tools.listTools(effectiveRequest);
        const exposedTools = availableTools.filter((tool) =>
          policy.allowedTools.includes(tool.name)
        );
        const controllerContext = (turn?: number) => ({
          runId, attemptId, turn, request: effectiveRequest,
          signal: cancellation.signal, messages: cloneMessages(messages),
          usage: { ...usage }, tools: exposedTools, output
        });
        const checkpointFor = (step: PendingRunStep, checkpointSequence = sequence): AgentCheckpoint => ({
          schemaVersion: 1, runId, attemptId, sequence: checkpointSequence,
          nextTurn: step.turn, messages: cloneMessages(messages),
          output, usage: { ...usage }, counters: { ...counters }, maxTurns,
          createdAt: now(), pending: JSON.parse(JSON.stringify(step))
        });
        const hooks = async (
          stage: Exclude<RunHookStage, "afterRun">,
          turn: number,
          extras: { invocation?: import("./protocol.js").ToolInvocation; result?: ToolResult } = {},
          stepExtras: Partial<PendingRunStep> = {}
        ): Promise<RunHookDecision[]> => {
          const resumingStage = pending?.stage === stage && pending.turn === turn
            && pending.callIndex === stepExtras.callIndex;
          const startIndex = resumingStage ? pending!.controllerIndex : 0;
          const decisions: RunHookDecision[] = resumingStage ? [...(pending!.completedDecisions || [])] : [];
          for (let index = startIndex; index < runControllers.length; index += 1) {
            const controller = runControllers[index];
            if (stage === "afterTool" && (controller.handle
              ? !controller.stages?.includes(stage)
              : typeof controller.afterTool !== "function")) continue;
            await reauthorize(stage === "beforeTool" || stage === "afterTool" ? "tool" : "context");
            const resumed = pending?.stage === stage && pending.turn === turn
              && pending.callIndex === stepExtras.callIndex && pending.controllerIndex === index;
            if (stage === "afterTool") {
              await runs.saveCheckpoint(checkpointFor({
                ...stepExtras, stage, turn, controllerIndex: index,
                controllerIds: runControllers.map((item) => item.id), completedDecisions: decisions
              }));
            }
            const decision = await dispatchRunHook(controller, {
              ...controllerContext(turn), ...extras,
              schemaVersion: 1, stage, controllerId: controller.id,
              idempotencyKey: `${runId}:${stage}:${turn}:${stepExtras.callIndex ?? ""}:${controller.id}${resumed && state.resumeInput ? `:resume:${state.resumeInput.waitId}` : ""}`,
              ...(resumed && state.resumeInput ? { resume: state.resumeInput } : {})
            }, async (type, data) => { await publish(type, data); });
            if (resumed) pending = undefined;
            if (decision.action === "deny") {
              cancellation.cancel(decision.reason);
              throw new RunCancelledError(decision.reason);
            }
            if (decision.action === "pause") {
              if (stage === "afterTool") throw new Error("Observers cannot suspend a Run");
              cancellation.signal.throwIfCancelled();
              const waiting: RunWait = {
                id: createId("wait"), controllerId: controller.id, stage,
                reason: decision.reason, createdAt: now(), ...(decision.data ? { data: decision.data } : {})
              };
              const step: PendingRunStep = {
                ...stepExtras, stage, turn, controllerIndex: index,
                controllerIds: runControllers.map((item) => item.id), completedDecisions: decisions
              };
              const event: RunEvent = {
                schemaVersion: 1, eventId: createId("event"), runId, attemptId,
                sequence: sequence + 1, type: "run.waiting", timestamp: now(), data: { waiting, output, usage }
              };
              await runs.suspend(event, checkpointFor(step, event.sequence), waiting);
              sequence = event.sequence;
              queue.push(event);
              throw new RunSuspended(waiting);
            }
            decisions.push(decision);
            if (stage === "afterTool") {
              await runs.saveCheckpoint(checkpointFor({
                ...stepExtras, stage, turn, controllerIndex: index + 1,
                controllerIds: runControllers.map((item) => item.id), completedDecisions: decisions
              }));
            }
            if (decision.action === "replace-tool-result") break;
          }
          return decisions;
        };
        const finishToolHooks = async (
          invocation: import("./protocol.js").ToolInvocation,
          result: ToolResult, step: PendingRunStep
        ) => {
          const afterStep: PendingRunStep = {
            ...step, stage: "afterTool", afterToolResult: result, inFlight: false,
            controllerIndex: pending?.stage === "afterTool" ? pending.controllerIndex : 0,
            completedDecisions: pending?.stage === "afterTool" ? pending.completedDecisions : []
          };
          await runs.saveCheckpoint(checkpointFor(afterStep));
          await hooks("afterTool", step.turn, { invocation, result }, afterStep);
          pending = undefined;
          await runs.saveCheckpoint(checkpointFor({
            ...step, stage: "beforeTool", callIndex: (step.callIndex || 0) + 1,
            controllerIndex: 0, completedDecisions: [], afterToolResult: undefined, inFlight: false
          }));
        };
        if (!existingRun || pending?.stage === "beforeStart") await hooks("beforeStart", startTurn);

        const applyContexts = async (stage: "pre" | "post", turn?: number) => {
          messages = await applyContextStage({
            contexts: runContexts,
            stage,
            messages,
            request: effectiveRequest,
            runId,
            attemptId,
            turn,
            signal: cancellation.signal,
            contextExtras: {
              tools: exposedTools,
              usage: { ...usage },
              recordUsage: (patch) => { usage = addUsage(usage, patch); }
            },
            onTiming: (timing) => contextTimings.push(timing),
            reauthorize,
            onFailure: async (provider, error) => {
              await publish("context.failed", {
                providerId: provider.id,
                stage,
                ...(turn === undefined ? {} : { turn }),
                error: errorMessage(error)
              });
            }
          });
        };

        if (!existingRun) {
          await publish("run.started", {
            engineId: engine.id,
            model: request.model || null,
            sessionId: request.sessionId || null,
            projectId: request.projectId || null,
            target: request.target || null,
            allowedTools: exposedTools.map((tool) => tool.name),
            maxTurns,
            maxToolCalls: policy.maxToolCalls
          });
        }
        if (needsPreContext) await applyContexts("pre");

        for (let turn = startTurn; turn <= maxTurns; turn += 1) {
          cancellation.signal.throwIfCancelled();
          const resumedStep = pending?.turn === turn ? pending : undefined;
          const skipModel = resumedStep?.stage === "beforeTool" || resumedStep?.stage === "afterTool"
            || resumedStep?.stage === "beforeStop";
          const calls: ToolCall[] = resumedStep?.calls || [];
          let turnOutput = resumedStep?.turnOutput || "";
          let turnReasoning = resumedStep?.turnReasoning || "";
          let turnMetadata: Record<string, unknown> | undefined = resumedStep?.turnMetadata;
          let reasoningStarted = false;
          if (!skipModel) {
            if (resumedStep?.stage !== "beforeModel") {
              await hooks("beforeTurn", turn);
              await publish("turn.started", { turn, model: request.model || null });
              await applyContexts("post", turn);
            }
            await hooks("beforeModel", turn);
            await reauthorize("model");
            for await (const engineEvent of engine.streamTurn({
              runId,
              attemptId,
              principal: effectiveRequest.principal,
              turn,
              messages,
              tools: exposedTools.filter((tool) => policy.allowedTools.includes(tool.name)),
              model: request.model,
              modelOptions: request.modelOptions,
              signal: cancellation.signal
            })) {
              cancellation.signal.throwIfCancelled();
              if (engineEvent.type === "message.metadata") {
                turnMetadata = { ...turnMetadata, ...engineEvent.metadata };
                continue;
              }
              if (
                engineEvent.type === "reasoning.delta"
                && String(engineEvent.delta || "")
                && !reasoningStarted
              ) {
                reasoningStarted = true;
                await publish("reasoning.started", { turn });
              }
              await consumeEngineEvent(engineEvent, {
                turn,
                model: request.model,
                contextTimings: engineEvent.type === "model.request" ? contextTimings.splice(0) : [],
                calls,
                appendText(delta) {
                  turnOutput += delta;
                  output += delta;
                },
                addUsage(patch) {
                  usage = addUsage(usage, patch);
                },
                appendReasoning(delta) {
                  turnReasoning += delta;
                },
                publish
              });
            }
            if (reasoningStarted) {
              await publish("reasoning.completed", { turn, content: turnReasoning });
            }
          }

          cancellation.signal.throwIfCancelled();
          if (calls.length === 0) {
            if (resumedStep?.stage !== "beforeStop") {
              const assistantMessage: TranscriptMessage = {
                role: "assistant",
                content: turnOutput,
                ...(turnMetadata ? { providerMetadata: turnMetadata } : {}),
                ...(turnReasoning ? { reasoningContent: turnReasoning } : {})
              };
              messages = [...messages, assistantMessage];
              await appendTranscript(turn, 0, assistantMessage);
              await publish("message.completed", { turn, content: turnOutput });
              await publish("turn.completed", {
                turn,
                model: request.model || null,
                usage
              });
            }
            let continuation = "";
            let acceptedStop = false;
            for (const decision of await hooks("beforeStop", turn, {}, { turnOutput, turnReasoning, turnMetadata,
              ...(resumedStep?.stopBoundary ? { stopBoundary: resumedStep.stopBoundary } : {})
            })) {
              if (decision.action === "accept-stop") acceptedStop = true;
              if (decision.action === "continue") {
                if (continuation) throw new Error("Multiple Run controllers requested continuation");
                continuation = decision.instruction;
              }
            }
            cancellation.signal.throwIfCancelled();
            if (resumedStep?.stopBoundary === "max-turns" && !continuation && !acceptedStop) {
              throw new Error(`Maximum agent turn count exceeded: ${maxTurns}`);
            }
            if (continuation && turn < maxTurns) {
              // A controller instruction is distinct from a trusted user message.
              messages = [...messages, { role: "assistant", content: continuation }];
              await runs.saveCheckpoint({
                schemaVersion: 1, runId, attemptId, sequence,
                nextTurn: turn + 1, messages: cloneMessages(messages),
                output, usage: { ...usage }, counters: { ...counters },
                maxTurns, createdAt: now()
              });
              await publish("run.continuing", { turn, controller: true });
              continue;
            }
            const terminalReason = continuation ? "controller-yield" : "completed";
            const completedAt = now();
            await publish("run.completed", { output, usage, reason: terminalReason }, {
              status: "completed",
              updatedAt: completedAt,
              completedAt,
              terminalReason,
              output,
              usage
            });
            settle("completed", terminalReason);
            return;
          }

          const toolMessages: TranscriptMessage[] = resumedStep?.toolMessages || [];
          if (!skipModel) {
            await appendTranscript(turn, 0, {
              role: "assistant",
              content: turnOutput,
              ...(turnMetadata ? { providerMetadata: turnMetadata } : {}),
              ...(turnReasoning ? { reasoningContent: turnReasoning } : {}),
              toolCalls: assistantToolCalls(calls)
            });
            await publish("message.completed", { turn, content: turnOutput });
          }
          for (let callIndex = resumedStep?.callIndex || 0; callIndex < calls.length; callIndex += 1) {
            const call = calls[callIndex];
            cancellation.signal.throwIfCancelled();
            await reauthorize("tool");
            if (resumedStep?.stage === "afterTool" && resumedStep.callIndex === callIndex) {
              if (!resumedStep.afterToolResult) throw new Error("Missing checkpointed tool result");
              await finishToolHooks({
                invocationId: `${runId}:turn:${turn}:tool:${callIndex}`, runId, attemptId,
                sessionId: request.sessionId, projectId: request.projectId,
                principal: effectiveRequest.principal, target: request.target, policy, toolCall: call
              }, resumedStep.afterToolResult, resumedStep);
              continue;
            }
            if (call.validationError) {
              attemptSpan.addEvent("tool.denied", { "zion.tool.denial": "invalid_arguments" });
              const message = toolMessage(call, invalidToolResult(call));
              toolMessages.push(message);
              await appendTranscript(turn, callIndex + 1, message);
              continue;
            }

            const decision = await authorizeTool(call, policy, counters);
            if (!decision.allowed) {
              attemptSpan.addEvent("tool.denied", { "zion.tool.denial": "policy" });
              const reason = decision.reason || "tool call denied";
              await publish("tool.denied", {
                turn,
                callId: call.id,
                name: call.name,
                denialType: "policy",
                reason
              });
              const message = toolMessage(call, deniedToolResult(reason));
              toolMessages.push(message);
              await appendTranscript(turn, callIndex + 1, message);
              continue;
            }

            const invocationId = `${runId}:turn:${turn}:tool:${callIndex}`;
            const invocation = {
              invocationId, runId, attemptId, sessionId: request.sessionId,
              projectId: request.projectId, principal: effectiveRequest.principal,
              target: request.target, policy, toolCall: call
            };
            let result: ToolResult;
            let intercepted = false;
            const step: PendingRunStep = {
              stage: "beforeTool", turn, controllerIndex: 0,
              controllerIds: runControllers.map((item) => item.id),
              calls, callIndex, turnOutput, turnReasoning, turnMetadata, toolMessages
            };
            for (const decision of await hooks("beforeTool", turn, { invocation }, step)) {
              if (decision.action === "replace-tool-result") { result = decision.result; intercepted = true; break; }
            }
            await reauthorize("tool");
            if (!(await authorizeTool(call, policy, counters)).allowed) {
              cancellation.cancel("tool-authorization-changed");
              throw new RunCancelledError("tool-authorization-changed");
            }
            counters.toolCalls += 1;
            // A restart during the side effect must reconcile its stable invocation ID.
            await runs.saveCheckpoint(checkpointFor({ ...step, inFlight: !intercepted }));
            try {
              if (!intercepted) result = await tools.invoke(invocation, cancellation.signal);
            } catch (error) {
              result = {
                ok: false,
                content: `Tool "${call.name}" failed: ${errorMessage(error)}`,
                error: errorMessage(error),
                failureCode: toolFailureCodeFromError(error)
              };
            }
            result = result!;
            const failureCode = toolFailureCode(result);
            await publish("tool.completed", {
              turn,
              callId: call.id,
              name: call.name,
              ok: result.ok,
              error: result.error || null,
              ...(failureCode ? { failureCode } : {}),
              ...(typeof result.retryable === "boolean"
                ? { retryable: result.retryable }
                : {}),
              artifactIds: result.artifactIds || [],
              result: String(result.content || "").slice(0, 4000)
            });
            const message = toolMessage(call, result);
            toolMessages.push(message);
            await appendTranscript(turn, callIndex + 1, message);
            await finishToolHooks(invocation, result, step);
          }

          messages = [
            ...messages,
            {
              role: "assistant",
              content: turnOutput,
              ...(turnMetadata ? { providerMetadata: turnMetadata } : {}),
              ...(turnReasoning ? { reasoningContent: turnReasoning } : {}),
              toolCalls: assistantToolCalls(calls)
            },
            ...toolMessages
          ];
          await publish("turn.completed", {
            turn,
            model: request.model || null,
            usage
          });
          const checkpoint: AgentCheckpoint = {
            schemaVersion: 1,
            runId,
            attemptId,
            sequence,
            nextTurn: turn + 1,
            messages: cloneMessages(messages),
            output,
            usage: { ...usage },
            counters: { ...counters },
            maxTurns,
            createdAt: now()
          };
          await runs.saveCheckpoint(checkpoint);
          attemptSpan.addEvent("checkpoint.created", { "zion.checkpoint.sequence": checkpoint.sequence });
          await publish("checkpoint.created", {
            checkpointSequence: checkpoint.sequence,
            nextTurn: checkpoint.nextTurn
          });
        }

        if (runControllers.length) {
          let continuation = "";
          let acceptedStop = false;
          for (const decision of await hooks("beforeStop", maxTurns, {}, { stopBoundary: "max-turns" })) {
            if (decision.action === "accept-stop") acceptedStop = true;
            else if (decision.action === "continue") {
              if (continuation) throw new Error("Multiple Run controllers requested continuation");
              continuation = decision.instruction;
            }
          }
          if (continuation || acceptedStop) {
            const reason = continuation ? "controller-yield" : "completed";
            const completedAt = now();
            await publish("run.completed", { output, usage, reason }, {
              status: "completed", updatedAt: completedAt, completedAt,
              terminalReason: reason, output, usage
            });
            settle("completed", reason);
            return;
          }
        }
        throw new Error(
          `Maximum agent turn count exceeded: ${maxTurns} `
          + `(tool calls executed: ${counters.toolCalls}/${policy.maxToolCalls})`
        );
      } catch (error) {
        if (error instanceof RunSuspended) {
          if (cancellation.signal.cancelled) {
            const reason = cancellation.signal.reason || "user";
            const event: RunEvent = {
              schemaVersion: 1, eventId: createId("event"), runId, attemptId,
              sequence: sequence + 1, type: "run.aborted", timestamp: now(),
              data: { reason, output, usage }
            };
            try {
              const outbox = bindings?.terminalOutbox?.({
                runId, attemptId, status: "aborted", reason, output, usage: { ...usage }
              });
              if (await runs.cancelWait(event, error.waiting.id, outbox)) {
                sequence = event.sequence;
                queue.push(event);
                settle("aborted", reason);
                return;
              }
              // A competing resume owns the new attempt. Never overwrite it.
            } catch (persistenceError) {
              settle("failed", "persistence-failed",
                `Failed to persist waiting cancellation: ${errorMessage(persistenceError)}`);
              return;
            }
          }
          settle("waiting", error.waiting.reason, undefined, error.waiting);
          return;
        }
        const cancelled = error instanceof RunCancelledError || cancellation.signal.cancelled;
        if (persisted) {
          if (cancelled) {
            const reason = cancellation.signal.reason || "user";
            try {
              const completedAt = now();
              await publish("run.aborted", { reason, output, usage }, {
                status: "aborted",
                updatedAt: completedAt,
                completedAt,
                terminalReason: reason, output, usage
              });
              settle("aborted", reason);
            } catch (persistenceError) {
              settle(
                "failed",
                "persistence-failed",
                `Failed to persist aborted Run: ${errorMessage(persistenceError)}`
              );
            }
          } else {
            const message = errorMessage(error);
            try {
              const completedAt = now();
              await publish("run.failed", { error: message, output, usage }, {
                status: "failed",
                updatedAt: completedAt,
                completedAt,
                terminalReason: "failed",
                error: message, output, usage
              });
              settle("failed", "failed", message);
            } catch (persistenceError) {
              settle(
                "failed",
                "persistence-failed",
                `Failed to persist Run failure: ${errorMessage(persistenceError)}`
              );
            }
          }
        } else {
          settle(
            cancelled ? "aborted" : "failed",
            cancelled ? cancellation.signal.reason || "user" : "failed",
            cancelled ? undefined : errorMessage(error)
          );
        }
      } finally {
        timeoutDisposable?.dispose();
        queue.close();
        await bindings?.dispose?.();
      }
    };

    void context.with(trace.setSpan(context.active(), attemptSpan), run);
    return {
      runId,
      attemptId,
      ready,
      events: queue,
      completion,
      abort
    };
  };

  return {
    async preview(request: RunRequest) {
      const runId = createId("preview");
      const attemptId = createId("attempt");
      const cancellation = new CancellationController();
      const policy = normalizeCapabilityPolicy(request.policy);
      const effectiveRequest: RunRequest = {
        ...request,
        policy,
        ...(request.principal
          ? { principal: Object.freeze({ ...request.principal }) }
          : {})
      };
      const reauthorize = async (phase: RunAuthorizationPhase) => {
        if (!authorizeRun) return;
        Object.assign(
          policy,
          normalizeCapabilityPolicy(await authorizeRun(effectiveRequest, phase))
        );
      };
      const contextFailures: Array<{
        providerId: string;
        stage: string;
        error: string;
      }> = [];
      await reauthorize("admission");
      const bindings = await bindRun?.(effectiveRequest, {
        runId, attemptId, signal: cancellation.signal, resumed: false, preview: true
      });
      try {
      if (bindings?.metadata) effectiveRequest.metadata = { ...request.metadata, ...bindings.metadata };
      const availableTools = await tools.listTools(effectiveRequest);
      const exposedTools = availableTools.filter((tool) =>
        policy.allowedTools.includes(tool.name)
      );
      let messages = normalizeMessages(request);
      const apply = async (stage: "pre" | "post", turn?: number) => {
        messages = await applyContextStage({
          contexts: [...contexts, ...(bindings?.contexts || [])],
          stage,
          messages,
          request: effectiveRequest,
          runId,
          attemptId,
          turn,
          signal: cancellation.signal,
          contextExtras: { tools: exposedTools, preview: true },
          reauthorize,
          onFailure(provider, error) {
            contextFailures.push({
              providerId: provider.id,
              stage,
              error: errorMessage(error)
            });
          }
        });
      };
      await apply("pre");
      await apply("post", 1);
      await reauthorize("model");
      const iterator = engine.streamTurn({
        runId,
        attemptId,
        principal: effectiveRequest.principal,
        turn: 1,
        messages,
        tools: exposedTools.filter((tool) =>
          policy.allowedTools.includes(tool.name)
        ),
        model: request.model,
        modelOptions: request.modelOptions,
        signal: cancellation.signal,
        preview: true,
        metadata: effectiveRequest.metadata
      })[Symbol.asyncIterator]();
      try {
        const first = await iterator.next();
        if (first.done || first.value.type !== "model.request") {
          throw new Error("Agent engine does not expose a previewable model request");
        }
        return {
          runId,
          attemptId,
          turn: 1,
          request: first.value.request,
          contextFailures
        };
      } finally {
        await iterator.return?.();
      }
      } finally {
        await bindings?.dispose?.();
      }
    },

    execute(request: RunRequest): RunHandle {
      return startExecution(request, {
        runId: createId("run"),
        attemptId: createId("attempt"),
        initialSequence: 0,
        initialMessages: normalizeMessages(request),
        initialOutput: "",
        initialUsage: { ...EMPTY_USAGE },
        initialCounters: { toolCalls: 0 },
        startTurn: 1,
        existingRun: null,
        authorizeAdmission: true
      });
    },

    async resume(runId: string, request: ResumeRunRequest = {}): Promise<RunHandle> {
      const existingRun = await runs.get(runId);
      if (!existingRun) throw new Error(`Run not found: ${runId}`);
      const policy = authorizeRun
        ? await authorizeRun(existingRun, "resume")
        : existingRun.policy;
      if (!["waiting", "interrupted", "aborted", "failed"].includes(existingRun.status)) {
        throw new Error(`Run cannot be resumed from status: ${existingRun.status}`);
      }
      const checkpoint = await runs.getLatestCheckpoint(runId);
      if (!checkpoint) throw new Error(`Run has no checkpoint: ${runId}`);
      validateCheckpoint(checkpoint, runId);
      if (existingRun.status === "waiting" && (!request.waitId || request.waitId !== existingRun.waiting?.id)) {
        throw Object.assign(new Error("A matching waitId is required"), { statusCode: 409 });
      }
      if (checkpoint.pending?.inFlight) {
        throw Object.assign(new Error("Tool execution outcome is unknown; reconcile the existing invocation before resuming"), { statusCode: 409 });
      }
      if (!bindRun && checkpoint.pending && JSON.stringify(checkpoint.pending.controllerIds) !== JSON.stringify(controllers.map((item) => item.id))) {
        throw Object.assign(new Error("Run controller chain changed; restore the checkpoint controller configuration"), { statusCode: 409 });
      }
      const events = await runs.getEvents(runId);
      if (utf8Bytes(request.input) > 64 * 1024) throw Object.assign(new Error("Resume input exceeds 64 KiB"), { statusCode: 400 });
      const model = request.model || existingRun.model;
      const modelOptions = request.modelOptions || existingRun.modelOptions;
      const attemptId = createId("attempt");
      const claimed = await runs.claimResume({
        runId, previousAttemptId: existingRun.attemptId, attemptId,
        checkpointSequence: checkpoint.sequence, waitId: request.waitId, input: request.input
      });
      if (!claimed) throw Object.assign(new Error("Run was already resumed or its checkpoint changed"), { statusCode: 409 });
      return startExecution({
        messages: cloneMessages(checkpoint.messages),
        title: existingRun.title,
        sessionId: existingRun.sessionId,
        projectId: existingRun.projectId,
        principal: existingRun.principal,
        target: existingRun.target,
        model,
        modelOptions,
        policy,
        metadata: existingRun.metadata,
        maxTurns: request.maxTurns ?? checkpoint.maxTurns,
        timeoutMs: request.timeoutMs
      }, {
        runId,
        attemptId,
        initialSequence: events.at(-1)?.sequence || 0,
        initialMessages: checkpoint.messages,
        initialOutput: checkpoint.output,
        initialUsage: checkpoint.usage,
        initialCounters: checkpoint.counters,
        startTurn: checkpoint.nextTurn,
        existingRun,
        previousAttemptId: checkpoint.attemptId,
        resumedFromSequence: checkpoint.sequence,
        pending: checkpoint.pending,
        resumeInput: request.waitId ? { waitId: request.waitId, input: request.input } : checkpoint.pending?.resume
      });
    }
  };
}

type EngineEventConsumer = {
  turn: number;
  model?: ModelRef;
  contextTimings?: ContextTiming[];
  calls: ToolCall[];
  appendText(delta: string): void;
  appendReasoning(delta: string): void;
  addUsage(usage: Partial<Usage>): void;
  publish(
    type: string,
    data?: Record<string, unknown>,
    patch?: RunPatch,
    detailData?: Record<string, unknown>
  ): Promise<RunEvent>;
};

async function consumeEngineEvent(
  event: EngineOutputEvent,
  consumer: EngineEventConsumer
): Promise<void> {
  if (event.type === "message.metadata") return;
  if (event.type === "model.timing") {
    await consumer.publish("model.timing", { turn: consumer.turn, ...event.timing });
    return;
  }
  if (event.type === "model.request") {
    const summary = await modelRequestSummary(event.request);
    await consumer.publish("model.request", {
      turn: consumer.turn,
      model: consumer.model || null,
      contextTimings: consumer.contextTimings || [],
      ...summary
    }, undefined, {
      turn: consumer.turn,
      model: consumer.model || null,
      contextTimings: consumer.contextTimings || [],
      ...summary,
      payload: event.request.payload
    });
    return;
  }
  if (event.type === "message.delta") {
    const delta = String(event.delta || "");
    consumer.appendText(delta);
    await consumer.publish("message.delta", { turn: consumer.turn, delta });
    return;
  }
  if (event.type === "reasoning.delta") {
    const delta = String(event.delta || "");
    consumer.appendReasoning(delta);
    await consumer.publish("reasoning.delta", {
      turn: consumer.turn,
      delta
    });
    return;
  }
  if (event.type === "model.usage") {
    consumer.addUsage(event.usage);
    await consumer.publish("model.usage", {
      turn: consumer.turn,
      model: consumer.model || null,
      usage: event.usage
    });
    return;
  }

  const call: ToolCall = {
    id: String(event.call.id || ""),
    name: String(event.call.name || ""),
    arguments: { ...(event.call.arguments || {}) },
    ...(typeof event.call.argumentsText === "string"
      ? { argumentsText: event.call.argumentsText } : {}),
    ...(event.call.providerMetadata ? { providerMetadata: event.call.providerMetadata } : {}),
    ...(event.call.validationError
      ? { validationError: String(event.call.validationError) }
      : {})
  };
  consumer.calls.push(call);
  if (call.validationError) {
    await consumer.publish("tool.denied", {
      turn: consumer.turn,
      callId: call.id,
      name: call.name,
      denialType: "invalid_arguments",
      reason: call.validationError
    });
    return;
  }
  await consumer.publish("tool.requested", {
    turn: consumer.turn,
    callId: call.id,
    name: call.name,
    arguments: call.arguments
  });
}
