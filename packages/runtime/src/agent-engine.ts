import { AsyncQueue } from "./async-queue.js";
import { CancellationController, RunCancelledError } from "./cancellation.js";
import { normalizeCapabilityPolicy } from "./capability-policy.js";
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
};

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

  if (stage === "pre") {
    const preparedMessages: TranscriptMessage[] = [];
    for (const provider of selected.filter((item) => !item.contribute)) {
      signal.throwIfCancelled();
      await reauthorize("context");
      try {
        if (!provider.prepare) {
          throw new Error("provider has no prepare or contribute implementation");
        }
        const prepared = await provider.prepare(request);
        if (!Array.isArray(prepared)) {
          throw new Error("provider returned an invalid result");
        }
        preparedMessages.push(...prepared);
      } catch (error) {
        await onFailure(provider, error);
        if (provider.required) throw error;
      }
    }
    output = [...preparedMessages, ...output];
  }

  for (const provider of selected.filter((item) => !!item.contribute)) {
    signal.throwIfCancelled();
    await reauthorize("context");
    try {
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
    } catch (error) {
      await onFailure(provider, error);
      if (provider.required) throw error;
    }
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
        error?: string
      ) => {
        terminal = true;
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
          ...(error ? { error } : {})
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
            createdAt,
            updatedAt: createdAt
          });
          persisted = true;
        }

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
            error: undefined
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
        const availableTools = await tools.listTools(effectiveRequest);
        const exposedTools = availableTools.filter((tool) =>
          policy.allowedTools.includes(tool.name)
        );
        const controllerContext = (turn?: number) => ({
          runId, attemptId, turn, request: effectiveRequest,
          signal: cancellation.signal, messages: cloneMessages(messages),
          usage: { ...usage }, tools: exposedTools, output
        });
        for (const controller of runControllers) {
          await reauthorize("context");
          await controller.beforeStart?.(controllerContext());
        }

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
          await applyContexts("pre");
        }

        for (let turn = startTurn; turn <= maxTurns; turn += 1) {
          cancellation.signal.throwIfCancelled();
          for (const controller of runControllers) {
            await reauthorize("context");
            const reason = await controller.beforeTurn?.(controllerContext(turn));
            if (reason) {
              cancellation.cancel(reason);
              cancellation.signal.throwIfCancelled();
            }
          }
          await publish("turn.started", { turn, model: request.model || null });
          await applyContexts("post", turn);
          for (const controller of runControllers) {
            await reauthorize("context");
            const reason = await controller.beforeModel?.(controllerContext(turn));
            if (reason) {
              cancellation.cancel(reason);
              cancellation.signal.throwIfCancelled();
            }
          }

          const calls: ToolCall[] = [];
          let turnOutput = "";
          let turnReasoning = "";
          let turnMetadata: Record<string, unknown> | undefined;
          let reasoningStarted = false;
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
            await publish("reasoning.completed", { turn });
          }

          cancellation.signal.throwIfCancelled();
          if (calls.length === 0) {
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
            let continuation = "";
            for (const controller of runControllers) {
              await reauthorize("context");
              const instruction = await controller.beforeStop?.(controllerContext(turn));
              if (instruction) {
                if (continuation) throw new Error("Multiple Run controllers requested continuation");
                continuation = instruction;
              }
            }
            cancellation.signal.throwIfCancelled();
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

          const toolMessages: TranscriptMessage[] = [];
          await appendTranscript(turn, 0, {
            role: "assistant",
            content: turnOutput,
            ...(turnMetadata ? { providerMetadata: turnMetadata } : {}),
            ...(turnReasoning ? { reasoningContent: turnReasoning } : {}),
            toolCalls: assistantToolCalls(calls)
          });
          for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
            const call = calls[callIndex];
            cancellation.signal.throwIfCancelled();
            await reauthorize("tool");
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

            counters.toolCalls += 1;
            const invocationId = `${runId}:turn:${turn}:tool:${callIndex}`;
            const invocation = {
              invocationId, runId, attemptId, sessionId: request.sessionId,
              projectId: request.projectId, principal: effectiveRequest.principal,
              target: request.target, policy, toolCall: call
            };
            let result: ToolResult;
            let intercepted = false;
            for (const controller of runControllers) {
              await reauthorize("context");
              const retained = await controller.beforeTool?.(invocation, controllerContext(turn));
              if (typeof retained === "string") {
                cancellation.cancel(retained);
                throw new RunCancelledError(retained);
              }
              if (retained) { result = retained; intercepted = true; break; }
            }
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
            if (!intercepted) for (const controller of runControllers) {
              await reauthorize("context");
              await controller.afterTool?.(invocation, result, controllerContext(turn));
            }
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
          for (const controller of runControllers) {
            await reauthorize("context");
            const decision = await controller.beforeStop?.(controllerContext(maxTurns));
            if (decision === null) acceptedStop = true;
            else if (decision) {
              if (continuation) throw new Error("Multiple Run controllers requested continuation");
              continuation = decision;
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
      if (!["interrupted", "aborted", "failed"].includes(existingRun.status)) {
        throw new Error(`Run cannot be resumed from status: ${existingRun.status}`);
      }
      const checkpoint = await runs.getLatestCheckpoint(runId);
      if (!checkpoint) throw new Error(`Run has no checkpoint: ${runId}`);
      validateCheckpoint(checkpoint, runId);
      const events = await runs.getEvents(runId);
      const model = request.model || existingRun.model;
      const modelOptions = request.modelOptions || existingRun.modelOptions;
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
        attemptId: createId("attempt"),
        initialSequence: events.at(-1)?.sequence || 0,
        initialMessages: checkpoint.messages,
        initialOutput: checkpoint.output,
        initialUsage: checkpoint.usage,
        initialCounters: checkpoint.counters,
        startTurn: checkpoint.nextTurn,
        existingRun,
        previousAttemptId: checkpoint.attemptId,
        resumedFromSequence: checkpoint.sequence
      });
    }
  };
}

type EngineEventConsumer = {
  turn: number;
  model?: ModelRef;
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
      ...summary
    }, undefined, {
      turn: consumer.turn,
      model: consumer.model || null,
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
