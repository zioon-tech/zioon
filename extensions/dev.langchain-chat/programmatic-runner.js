import {
  authorizeToolCall,
  filterReadOnlyTools,
  filterToolsForPolicy,
  isReadOnlyToolCall,
  isReadOnlyToolName,
  normalizeCapabilityPolicy,
  normalizeToolCall
} from "../../src/core/run-policy";
import { buildContextWindowSnapshot } from "./context-health.js";
import { inferToolResultError } from "./tool-result-diagnostics.js";

export {
  authorizeToolCall,
  filterReadOnlyTools,
  filterToolsForPolicy,
  isReadOnlyToolCall,
  isReadOnlyToolName,
  normalizeCapabilityPolicy,
  normalizeToolCall
};

function createAsyncEventQueue() {
  const values = [];
  const waiters = [];
  let closed = false;

  return {
    push(value) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else values.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (values.length) return Promise.resolve({ value: values.shift(), done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => waiters.push(resolve));
          }
        };
      }
    }
  };
}

function createId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createProgrammaticExecutor(deps) {
  const {
    runStream,
    getActiveModel,
    resolveModelConfig,
    getTools,
    executeTool,
    runContributors,
    runs,
    emit
  } = deps;

  return function execute(request = {}) {
    const prompt = String(request.prompt || "").trim();
    if (!prompt) throw new Error("prompt is required");
    if (!["local-only", "service-backed"].includes(request.executionMode)) {
      throw new Error("Unsupported scheduled execution mode");
    }

    const runId = createId("run");
    const sessionId = String(request.sessionId || `scheduled:${runId}`);
    let runModel = null;
    const policy = normalizeCapabilityPolicy(request.policy);
    const queue = createAsyncEventQueue();
    const controllerRef = { current: null };
    let sequence = 0;
    let aborted = false;
    let abortReason = null;

    const publish = (type, data = {}) => {
      const event = {
        schemaVersion: 1,
        eventId: createId("evt"),
        runId,
        sequence: ++sequence,
        type,
        ts: Date.now(),
        data
      };
      queue.push(event);
      try { runs?.recordEvent?.(event); } catch {}
      try { emit?.("chat/runEvent", event); } catch {}
      return event;
    };

    let resolveCompletion;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });

    const abort = async (reason = "user") => {
      if (aborted) return;
      aborted = true;
      abortReason = reason;
      try { controllerRef.current?.abort?.(); } catch {}
    };

    void (async () => {
      const startedAt = Date.now();
      let output = "";
      let usage = { input_tokens: 0, output_tokens: 0 };
      let messages = [{ role: "user", content: prompt }];
      const counters = { toolCalls: 0, mail: 0 };
      let tools = [];

      try {
        const selected = getActiveModel?.(request.sessionId || null);
        runModel = (selected?.then ? await selected : selected) || null;
        runs?.start?.({
          id: runId,
          title: request.title || "",
          source: request.source || null,
          trigger: request.trigger || "user",
          sessionId,
          executionMode: request.executionMode,
          model: runModel,
          policy,
          metadata: request.metadata || {}
        });
        tools = filterToolsForPolicy(getTools?.() || [], policy);
        publish("run.started", {
          prompt,
          executionMode: request.executionMode,
          model: runModel,
          policy: { ...policy, allowedTools: tools.map((tool) => tool?.function?.name || tool?.name) }
        });
        if (runContributors) {
          messages = await runContributors(messages, "pre", {
            editor: null,
            sessionId,
            panelId: null,
            requestSource: "scheduled-task",
            runId
          });
        }

        let turn = 0;
        while (!aborted) {
          turn += 1;
          publish("turn.started", { turn, model: runModel });
          if (runContributors) {
            messages = await runContributors(messages, "post", {
              editor: null,
              sessionId,
              panelId: null,
              requestSource: "scheduled-task",
              runId
            });
          }
          try {
            const cfg = await resolveModelConfig?.(runModel);
            const contextWindow = buildContextWindowSnapshot({
              sessionId,
              messages,
              model: runModel,
              cfg,
              state: globalThis.window?.zion?.state
            });
            publish("context.window", {
              ...contextWindow,
              turn,
              model: runModel
            });
          } catch {}

          const calls = [];
          let turnOutput = "";
          let streamError = null;
          const result = await runStream({
            messages,
            tools,
            activeModel: runModel,
            runId,
            sessionId,
            panelId: null,
            requestSource: "scheduled-task",
            stepIndex: turn,
            silentReasoning: true,
            onToken(token) {
              const text = String(token || "");
              output += text;
              turnOutput += text;
              publish("message.delta", { turn, delta: text });
            },
            onToolCall(call) {
                const normalizedCall = normalizeToolCall(call);
                calls.push(normalizedCall);
              publish("tool.requested", {
                turn,
                  callId: normalizedCall.id,
                  name: normalizedCall.name,
                  args: normalizedCall.args
              });
            },
            onInvalidToolCall(call) {
              const id = String(call?.id || "");
              const name = String(call?.name || "tool");
              if (!id) return;
              const validationError = String(call?.error || "invalid arguments");
              calls.push({
                id,
                name,
                args: call?.args && typeof call.args === "object" ? call.args : {},
                validationError
              });
              publish("tool.denied", {
                turn,
                callId: id,
                name,
                reason: validationError
              });
            },
            onError(error) {
              streamError = error;
            },
              onEnd() {},
            getController(controller) {
              controllerRef.current = controller;
              if (aborted) controller.abort();
            }
          });

          if (streamError) throw streamError;
          if (result?.usage) {
            usage = {
              input_tokens: usage.input_tokens + Number(result.usage.input_tokens || result.usage.prompt_tokens || 0),
              output_tokens: usage.output_tokens + Number(result.usage.output_tokens || result.usage.completion_tokens || 0)
            };
            try {
              runs?.recordUsage?.({
                runId,
                stepIndex: turn,
                model: runModel,
                usage: result.usage
              });
            } catch {}
          }
          if (aborted) break;

          if (!calls.length) {
            publish("message.completed", { turn, content: turnOutput || output });
            publish("turn.completed", { turn, usage });
            break;
          }

          const toolCalls = [];
          const toolMessages = [];
          for (const call of calls) {
            toolCalls.push({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args || {}) }
            });
            if (call.validationError) {
              toolMessages.push({
                role: "tool",
                tool_call_id: call.id,
                content: `Invalid tool call arguments for "${call.name}": ${call.validationError}`
              });
              continue;
            }
            const decision = authorizeToolCall(call, policy, counters);
            if (!decision.allowed) {
              publish("tool.denied", { turn, callId: call.id, name: call.name, reason: decision.reason });
              toolMessages.push({ role: "tool", tool_call_id: call.id, content: `Denied by task policy: ${decision.reason}` });
              continue;
            }
            counters.toolCalls += 1;
            if (call.name === "sendMail") counters.mail += 1;
            let toolResult;
            try {
              toolResult = await executeTool(call, { runId, sessionId, policy });
              const toolError = inferToolResultError(call.name, toolResult);
              publish("tool.completed", {
                turn,
                callId: call.id,
                name: call.name,
                result: String(toolResult ?? "").slice(0, 4000),
                ...(toolError ? { error: toolError } : {})
              });
            } catch (error) {
              toolResult = `Tool "${call.name}" error: ${error?.message || String(error)}`;
              publish("tool.completed", {
                turn,
                callId: call.id,
                name: call.name,
                error: String(error?.message || error)
              });
            }
            toolMessages.push({ role: "tool", tool_call_id: call.id, content: String(toolResult ?? "") });
          }
          messages = [...messages, { role: "assistant", content: turnOutput, tool_calls: toolCalls }, ...toolMessages];
          publish("turn.completed", { turn, usage });
        }

        if (aborted) {
          publish("run.aborted", { reason: abortReason || "user" });
          resolveCompletion({ runId, status: "aborted", reason: abortReason || "user", output, usage });
        } else {
          publish("run.completed", { output, usage, durationMs: Date.now() - startedAt });
          resolveCompletion({ runId, status: "completed", output, usage });
        }
      } catch (error) {
        const isAbort = aborted || error?.name === "AbortError";
        if (isAbort) {
          publish("run.aborted", { reason: abortReason || "user" });
          resolveCompletion({ runId, status: "aborted", reason: abortReason || "user", output, usage });
        } else {
          publish("run.failed", { error: error?.message || String(error) });
          resolveCompletion({ runId, status: "failed", error: error?.message || String(error), output, usage });
        }
      } finally {
        queue.close();
      }
    })();

    return { runId, completion, abort, events: queue.iterable };
  };
}
