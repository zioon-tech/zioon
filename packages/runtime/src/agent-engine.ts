import { AsyncQueue } from "./async-queue.js";
import { CancellationController, RunCancelledError } from "./cancellation.js";
import { normalizeCapabilityPolicy } from "./capability-policy.js";
import type {
  AgentCheckpoint,
  AgentEngine,
  CapabilityPolicy,
  ContextProvider,
  EngineOutputEvent,
  ModelRef,
  ResumeRunRequest,
  RunEvent,
  RunHandle,
  RunRecord,
  RunRequest,
  RunResult,
  RunStore,
  TimeoutScheduler,
  ToolAuthorizer,
  ToolBroker,
  ToolCall,
  ToolResult,
  TranscriptMessage,
  Usage
} from "./protocol.js";

export type AgentExecutorDependencies = {
  engine: AgentEngine;
  tools: ToolBroker;
  runs: RunStore;
  contexts?: ContextProvider[];
  authorizeTool?: ToolAuthorizer;
  scheduleTimeout?: TimeoutScheduler;
  now?: () => number;
  createId?: (prefix: string) => string;
  defaultMaxTurns?: number;
};

export type AgentExecutor = {
  execute(request: RunRequest): RunHandle;
  resume(runId: string, request?: ResumeRunRequest): Promise<RunHandle>;
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

function assistantToolCalls(calls: ToolCall[]) {
  return calls.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments || {})
    }
  }));
}

function toolMessage(call: ToolCall, result: ToolResult): TranscriptMessage {
  return {
    role: "tool",
    toolCallId: call.id,
    content: result.content || result.error || ""
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
    authorizeTool = defaultAuthorizeTool,
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
      previousAttemptId,
      resumedFromSequence
    } = state;
    const queue = new AsyncQueue<RunEvent>();
    const cancellation = new CancellationController();
    const policy = normalizeCapabilityPolicy(request.policy);
    const effectiveRequest: RunRequest = { ...request, policy };
    const maxTurns = resolveMaxTurns(
      request.maxTurns,
      defaultMaxTurns,
      policy.maxToolCalls
    );
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

      const publish = async (
        type: string,
        data: Record<string, unknown> = {},
        patch?: RunPatch
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
        await runs.append(event, patch);
        sequence = nextSequence;
        queue.push(event);
        return event;
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
        resolveCompletion({
          runId,
          attemptId,
          status,
          output,
          usage,
          ...(status === "aborted" ? { reason: terminalReason } : {}),
          ...(error ? { error } : {})
        });
      };

      try {
        if (!existingRun) {
          const createdAt = now();
          await runs.create({
            id: runId,
            attemptId,
            status: "queued",
            title: String(request.title || ""),
            sessionId: request.sessionId,
            projectId: request.projectId,
            target: request.target,
            model: request.model,
            modelOptions: request.modelOptions,
            policy,
            metadata: { ...(request.metadata || {}) },
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
            model: request.model,
            updatedAt: startedAt,
            completedAt: undefined,
            terminalReason: undefined,
            error: undefined
          });
        }

        const availableTools = await tools.listTools(effectiveRequest);
        const exposedTools = availableTools.filter((tool) =>
          policy.allowedTools.includes(tool.name)
        );

        const applyContexts = async (stage: "pre" | "post", turn?: number) => {
          const selected = contexts
            .map((provider, index) => ({ provider, index }))
            .filter(({ provider }) => (provider.stage || "pre") === stage)
            .filter(({ provider }) => contextProviderEnabled(provider, effectiveRequest))
            .sort((left, right) =>
              (left.provider.order ?? 50) - (right.provider.order ?? 50)
              || left.index - right.index
            )
            .map(({ provider }) => provider);

          if (stage === "pre") {
            const preparedMessages: TranscriptMessage[] = [];
            for (const provider of selected.filter((item) => !item.contribute)) {
              cancellation.signal.throwIfCancelled();
              try {
                if (!provider.prepare) {
                  throw new Error("provider has no prepare or contribute implementation");
                }
                const prepared = await provider.prepare(effectiveRequest);
                if (!Array.isArray(prepared)) {
                  throw new Error("provider returned an invalid result");
                }
                preparedMessages.push(...prepared);
              } catch (error) {
                await publish("context.failed", {
                  providerId: provider.id,
                  stage,
                  error: errorMessage(error)
                });
              }
            }
            messages = [...preparedMessages, ...messages];
          }

          for (const provider of selected.filter((item) => !!item.contribute)) {
            cancellation.signal.throwIfCancelled();
            try {
              const contributed = await provider.contribute?.(
                cloneMessages(messages),
                {
                  runId,
                  attemptId,
                  ...(turn === undefined ? {} : { turn }),
                  request: effectiveRequest,
                  signal: cancellation.signal
                }
              );
              if (!Array.isArray(contributed)) {
                throw new Error("provider returned an invalid result");
              }
              messages = cloneMessages(contributed);
            } catch (error) {
              await publish("context.failed", {
                providerId: provider.id,
                stage,
                ...(turn === undefined ? {} : { turn }),
                error: errorMessage(error)
              });
            }
          }
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
          await publish("turn.started", { turn, model: request.model || null });
          await applyContexts("post", turn);

          const calls: ToolCall[] = [];
          let turnOutput = "";
          let turnReasoning = "";
          let reasoningStarted = false;
          for await (const engineEvent of engine.streamTurn({
            runId,
            attemptId,
            turn,
            messages,
            tools: exposedTools,
            model: request.model,
            modelOptions: request.modelOptions,
            signal: cancellation.signal
          })) {
            cancellation.signal.throwIfCancelled();
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
            await appendTranscript(turn, 0, {
              role: "assistant",
              content: turnOutput,
              ...(turnReasoning ? { reasoningContent: turnReasoning } : {})
            });
            await publish("message.completed", { turn, content: turnOutput });
            await publish("turn.completed", {
              turn,
              model: request.model || null,
              usage
            });
            const completedAt = now();
            await publish("run.completed", { output, usage }, {
              status: "completed",
              updatedAt: completedAt,
              completedAt,
              terminalReason: "completed",
              output,
              usage
            });
            settle("completed", "completed");
            return;
          }

          const toolMessages: TranscriptMessage[] = [];
          await appendTranscript(turn, 0, {
            role: "assistant",
            content: turnOutput,
            ...(turnReasoning ? { reasoningContent: turnReasoning } : {}),
            toolCalls: assistantToolCalls(calls)
          });
          for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
            const call = calls[callIndex];
            cancellation.signal.throwIfCancelled();
            if (call.validationError) {
              const message = toolMessage(call, invalidToolResult(call));
              toolMessages.push(message);
              await appendTranscript(turn, callIndex + 1, message);
              continue;
            }

            const decision = await authorizeTool(call, policy, counters);
            if (!decision.allowed) {
              const reason = decision.reason || "tool call denied";
              await publish("tool.denied", {
                turn,
                callId: call.id,
                name: call.name,
                reason
              });
              const message = toolMessage(call, deniedToolResult(reason));
              toolMessages.push(message);
              await appendTranscript(turn, callIndex + 1, message);
              continue;
            }

            counters.toolCalls += 1;
            const invocationId = `${runId}:turn:${turn}:tool:${callIndex}`;
            let result: ToolResult;
            try {
              result = await tools.invoke({
                invocationId,
                runId,
                attemptId,
                sessionId: request.sessionId,
                projectId: request.projectId,
                target: request.target,
                policy,
                toolCall: call
              }, cancellation.signal);
            } catch (error) {
              result = {
                ok: false,
                content: `Tool "${call.name}" failed: ${errorMessage(error)}`,
                error: errorMessage(error)
              };
            }
            await publish("tool.completed", {
              turn,
              callId: call.id,
              name: call.name,
              ok: result.ok,
              error: result.error || null,
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
          await publish("checkpoint.created", {
            checkpointSequence: checkpoint.sequence,
            nextTurn: checkpoint.nextTurn
          });
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
              await publish("run.aborted", { reason }, {
                status: "aborted",
                updatedAt: completedAt,
                completedAt,
                terminalReason: reason
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
              await publish("run.failed", { error: message }, {
                status: "failed",
                updatedAt: completedAt,
                completedAt,
                terminalReason: "failed",
                error: message
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
          terminal = true;
          resolveCompletion({
            runId,
            attemptId,
            status: cancelled ? "aborted" : "failed",
            output,
            usage,
            ...(cancelled
              ? { reason: cancellation.signal.reason || "user" }
              : { error: errorMessage(error) })
          });
        }
      } finally {
        timeoutDisposable?.dispose();
        queue.close();
      }
    };

    void run();
    return {
      runId,
      attemptId,
      events: queue,
      completion,
      abort
    };
  };

  return {
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
        existingRun: null
      });
    },

    async resume(runId: string, request: ResumeRunRequest = {}): Promise<RunHandle> {
      const existingRun = await runs.get(runId);
      if (!existingRun) throw new Error(`Run not found: ${runId}`);
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
        target: existingRun.target,
        model,
        modelOptions,
        policy: existingRun.policy,
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
  publish(type: string, data?: Record<string, unknown>): Promise<RunEvent>;
};

async function consumeEngineEvent(
  event: EngineOutputEvent,
  consumer: EngineEventConsumer
): Promise<void> {
  if (event.type === "model.request") {
    await consumer.publish("model.request", {
      turn: consumer.turn,
      model: consumer.model || null,
      ...event.request
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
