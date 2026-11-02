import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { URL } from "node:url";
import {
  LOCAL_TOOLS_TOOL_DEFINITIONS
} from "../../../packages/local-tools-client/src/index.mjs";
import {
  normalizeToolExecution,
  toolExecutionForDefinition
} from "../../../packages/plugin-sdk/src/tool-execution.mjs";
import { enrichToolResultWithArtifacts } from "./run-artifact-service.mjs";
import { executeWebSearch, WEB_SEARCH_TOOL_DEFINITION } from "./web-search.mjs";
import {
  applyToolRetryClassification,
  ToolInvocationLifecycle
} from "./tool-invocation-lifecycle.mjs";
import {
  cancellationType,
  failSpan,
  runtimeTracer,
  telemetryIdentifier
} from "../../../packages/runtime/dist/telemetry.js";

export const RUNTIME_NATIVE_TOOL_DEFINITIONS = [WEB_SEARCH_TOOL_DEFINITION, {
  name: "webFetch",
  description: "Fetch a public HTTP(S) URL and return bounded markdown-like content.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", format: "uri" },
      prompt: { type: "string" }
    },
    required: ["url"],
    additionalProperties: false
  },
  hostKinds: ["runtime"],
  execution: normalizeToolExecution({ effect: "read" })
}, {
  name: "todoWrite",
  description: "Replace the durable todo list associated with this Runtime session or Run.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        minLength: 1,
        description: "Stable id of the todo task being updated."
      },
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              minLength: 1,
              description: "Stable id of this todo item."
            },
            content: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"]
            },
            activeForm: { type: "string" }
          },
          required: ["content", "status", "activeForm"],
          additionalProperties: false
        }
      }
    },
    required: ["todos"],
    additionalProperties: false
  },
  hostKinds: ["runtime"],
  execution: normalizeToolExecution({ effect: "write" })
}];

export const RUNTIME_TOOL_DEFINITIONS = [
  ...LOCAL_TOOLS_TOOL_DEFINITIONS.filter((tool) =>
    !RUNTIME_NATIVE_TOOL_DEFINITIONS.some((native) => native.name === tool.name)),
  ...RUNTIME_NATIVE_TOOL_DEFINITIONS
];

const RUNTIME_NATIVE_TOOL_NAMES = new Set(
  RUNTIME_NATIVE_TOOL_DEFINITIONS.map((tool) => tool.name)
);

const WEB_FETCH_PROXY_ORIGINS = [
  "https://r.jinaai.cn",
  "https://r.jina.ai"
];
const FAILURE_CODE_PRIORITY = [
  "execution_outcome_unknown",
  "rate_limit",
  "http_4xx",
  "http_5xx",
  "http_status",
  "timeout",
  "dns_error",
  "network_error",
  "content_type",
  "size_limit",
  "truncated",
  "permission_denied",
  "policy_denied",
  "cancelled",
  "tool_error"
];

function errorDetail(error) {
  const message = String(error?.message || error || "unknown error");
  const cause = String(error?.cause?.code || error?.cause?.message || "").trim();
  return cause && !message.includes(cause) ? `${message} (${cause})` : message;
}

function httpFailureCode(status) {
  const code = Number(status);
  if (code === 429) return "rate_limit";
  if (code >= 400 && code < 500) return "http_4xx";
  if (code >= 500 && code < 600) return "http_5xx";
  return "http_status";
}

function failureCodeFromText(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return "";
  if (/execution outcome is unknown|may still be running|termination was not confirmed/.test(text)) {
    return "execution_outcome_unknown";
  }
  if (/http\s+429|status\s+429/.test(text)) return "rate_limit";
  if (/http\s+4\d\d|status\s+4\d\d/.test(text)) return "http_4xx";
  if (/http\s+5\d\d|status\s+5\d\d/.test(text)) return "http_5xx";
  if (/und_err_connect_timeout|timed?\s*out|timeout|etimedout/.test(text)) return "timeout";
  if (/enotfound|eai_again|getaddrinfo|dns/.test(text)) return "dns_error";
  if (/unsupported\s+content|content[-_\s]?type|media\s+type/.test(text)) return "content_type";
  if (/too\s+large|size\s+limit|max(?:imum)?\s+(?:bytes|size)|exceeded.*limit/.test(text)) return "size_limit";
  if (/truncated/.test(text)) return "truncated";
  if (/resource_execution_denied|outside_grant|not allowed by capability policy|policy/.test(text)) return "policy_denied";
  if (/permission denied|eacces|forbidden/.test(text)) return "permission_denied";
  if (/cancelled|canceled|aborted/.test(text)) return "cancelled";
  if (/fetch failed|network|econnreset|econnrefused|socket|connection/.test(text)) return "network_error";
  return "";
}

function failureCodeFromError(error) {
  return failureCodeFromText(`${error?.message || ""} ${error?.code || ""} ${error?.cause?.code || ""}`)
    || "network_error";
}

function toolFailureCodeFromError(error) {
  return String(error?.failureCode || "").trim() || failureCodeFromText(
    `${error?.message || ""} ${error?.code || ""} ${error?.cause?.code || ""}`
  ) || "tool_error";
}

function chooseFailureCode(codes) {
  const set = new Set((Array.isArray(codes) ? codes : []).filter(Boolean));
  return FAILURE_CODE_PRIORITY.find((code) => set.has(code)) || "tool_error";
}

function classifyToolResult(toolName, result, execution) {
  if (result?.ok !== false) return result;
  const classified = String(result.failureCode || "").trim()
    ? result
    : {
        ...result,
        failureCode: failureCodeFromText(`${result.error || ""}\n${result.content || ""}`)
          || (toolName === "webFetch" ? "network_error" : "tool_error")
      };
  return applyToolRetryClassification(classified, execution);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  );
}

function requestHash(invocation) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue({
      runId: invocation.runId,
      toolName: invocation.toolCall?.name,
      arguments: invocation.toolCall?.arguments || {},
      ...(invocation.target ? { target: invocation.target } : {})
    })))
    .digest("hex");
}

function duplicateUnknownResult(toolName, receipt) {
  const message = [
    `Duplicate ${toolName} execution was blocked.`,
    `Earlier invocation ${receipt.invocationId} has an unknown outcome and may still be running or already completed.`,
    "Inspect its effects before issuing a deliberately different operation."
  ].join(" ");
  return {
    ok: false,
    content: message,
    error: message,
    failureCode: "execution_outcome_unknown",
    retryable: false
  };
}

function isPrivateIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
  );
}

function isPrivateAddress(address) {
  const normalized = String(address || "").toLowerCase();
  const version = isIP(normalized);
  if (version === 4) return isPrivateIpv4(normalized);
  if (version === 6) {
    return (
      normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb")
      || normalized.startsWith("::ffff:127.")
      || normalized.startsWith("::ffff:10.")
      || normalized.startsWith("::ffff:192.168.")
    );
  }
  return true;
}

async function assertPublicUrl(value, lookupImpl = lookup) {
  let target;
  try {
    target = new URL(String(value || ""));
  } catch {
    throw new Error("webFetch requires a valid URL");
  }
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("webFetch only supports HTTP(S)");
  }
  const hostname = target.hostname.toLowerCase();
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "metadata.google.internal"
  ) {
    throw new Error("webFetch blocks loopback and metadata hosts");
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookupImpl(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("webFetch blocks private network targets");
  }
  return target;
}

function normalizeTodoList(value) {
  if (!Array.isArray(value)) throw new Error("todoWrite.todos must be an array");
  const todos = value.map((item) => {
    const id = String(item?.id || "").trim();
    const content = String(item?.content || "").trim();
    const activeForm = String(item?.activeForm || "").trim();
    const status = String(item?.status || "");
    if (!content || !activeForm) throw new Error("todo content and activeForm are required");
    if (!["pending", "in_progress", "completed"].includes(status)) {
      throw new Error(`invalid todo status: ${status}`);
    }
    return {
      ...(id ? { id } : {}),
      content,
      status,
      activeForm
    };
  });
  if (todos.filter((item) => item.status === "in_progress").length > 1) {
    throw new Error("only one todo may be in_progress");
  }
  return todos;
}

function compactText(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} characters]`;
}

export class RuntimeToolBroker {
  constructor({
    localTools,
    pluginTools = null,
    receipts,
    authorizeInvocation = null,
    delegatedToolNames = null,
    mcpEnabled = true,
    fetchImpl = globalThis.fetch,
    lookupImpl = lookup,
    maxWebResultChars = 30_000,
    webTimeoutMs = 30_000,
    invocationLifecycle = new ToolInvocationLifecycle()
  } = {}) {
    if (!localTools?.listTools || !localTools?.invoke) {
      throw new Error("Runtime Tool Broker requires a delegated Tool Broker");
    }
    if (!receipts?.getToolReceipt || !receipts?.saveToolReceipt) {
      throw new Error("Runtime Tool Broker requires a durable receipt store");
    }
    this.localTools = localTools;
    this.pluginTools = pluginTools;
    this.receipts = receipts;
    this.authorizeInvocation = authorizeInvocation;
    this.mcpEnabled = mcpEnabled;
    this.fetchImpl = fetchImpl;
    this.lookupImpl = lookupImpl;
    this.maxWebResultChars = maxWebResultChars;
    this.webTimeoutMs = webTimeoutMs;
    this.invocationLifecycle = invocationLifecycle;
    this.activeInvocations = new Map();
    this.activeRequests = new Map();
    this.toolDefinitions = new Map();
    this.delegatedToolNames = Array.isArray(delegatedToolNames)
      ? delegatedToolNames.map(String)
      : null;
    const pluginNames = Array.isArray(pluginTools?.supportedToolNames)
      ? pluginTools.supportedToolNames.map(String)
      : [];
    const baseNames = new Set([
      ...(this.delegatedToolNames || []),
      ...RUNTIME_NATIVE_TOOL_DEFINITIONS.map((tool) => tool.name)
    ]);
    const conflict = pluginNames.find((name) => baseNames.has(name));
    if (conflict) {
      throw new Error(`Runtime plugin tool conflicts with built-in tool: ${conflict}`);
    }
    this.rememberToolDefinitions([
      ...LOCAL_TOOLS_TOOL_DEFINITIONS,
      ...(this.localTools.getToolDefinitions?.() || []),
      ...(this.pluginTools?.getToolDefinitions?.() || []),
      ...RUNTIME_NATIVE_TOOL_DEFINITIONS
    ]);
  }

  rememberToolDefinitions(definitions = []) {
    for (const definition of definitions) {
      const name = String(definition?.name || "");
      if (!name || !this.isToolEnabled(name)) continue;
      this.toolDefinitions.set(name, {
        ...definition,
        execution: toolExecutionForDefinition(definition)
      });
    }
  }

  isToolEnabled(name) {
    return this.mcpEnabled || !/^mcp(?:__|ListTools$|Call$)/.test(String(name));
  }

  executionForTool(name) {
    return this.toolDefinitions.get(String(name || ""))?.execution
      || normalizeToolExecution(null);
  }

  getToolDefinitions() {
    const supported = new Set(this.supportedToolNames);
    return [...this.toolDefinitions.values()].filter((definition) =>
      supported.has(definition.name)).map((definition) => ({
      ...definition,
      execution: { ...definition.execution }
    }));
  }

  async authorizeForReplay(invocation) {
    const authorized = this.authorizeInvocation
      ? await this.authorizeInvocation(invocation)
      : invocation;
    const name = String(authorized.toolCall?.name || "");
    if (!this.isToolEnabled(name)) throw new Error("MCP tools are disabled");
    if (!(authorized.policy?.allowedTools || []).includes(name)) {
      throw new Error("tool is not allowed by capability policy");
    }
    if (
      name === "todoWrite"
      && authorized.policy?.preset !== "trusted-automation"
    ) {
      throw new Error("todoWrite requires trusted-automation capability");
    }
    return authorized;
  }

  get supportedToolNames() {
    const delegatedNames = this.delegatedToolNames
      || (Array.isArray(this.localTools?.supportedToolNames)
        ? this.localTools.supportedToolNames.map(String)
        : []);
    const pluginNames = Array.isArray(this.pluginTools?.supportedToolNames)
      ? this.pluginTools.supportedToolNames.map(String)
      : [];
    const reserved = new Set([
      ...RUNTIME_NATIVE_TOOL_DEFINITIONS.map((tool) => tool.name),
      ...pluginNames
    ]);
    return [
      ...new Set([
        ...delegatedNames.filter((name) => !reserved.has(name)),
        ...RUNTIME_NATIVE_TOOL_DEFINITIONS.map((tool) => tool.name),
        ...pluginNames
      ])
    ].filter((name) => this.isToolEnabled(name));
  }

  async listTools(request = {}) {
    const allowed = new Set(request.policy?.allowedTools || []);
    const native = RUNTIME_NATIVE_TOOL_DEFINITIONS.filter(
      (tool) => allowed.has(tool.name)
        && (
          tool.name !== "todoWrite"
          || request.policy?.preset === "trusted-automation"
        )
    );
    const [local, plugin] = await Promise.all([
      this.localTools.listTools(request),
      this.pluginTools?.listTools
        ? this.pluginTools.listTools(request)
        : []
    ]);
    const reserved = new Set([
      ...RUNTIME_NATIVE_TOOL_DEFINITIONS.map((tool) => tool.name),
      ...plugin.map((tool) => tool.name)
    ]);
    const tools = [
      ...local.filter((tool) => !reserved.has(tool.name)),
      ...native,
      ...plugin
    ].filter((tool) => this.isToolEnabled(tool.name)).map((tool) => ({
      ...tool,
      execution: toolExecutionForDefinition(tool)
    }));
    this.rememberToolDefinitions(tools);
    return tools;
  }

  async invoke(invocation, signal) {
    if (!RUNTIME_NATIVE_TOOL_NAMES.has(invocation.toolCall?.name)) {
      invocation = await (
        this.localTools.resolveInvocation?.(invocation) || invocation
      );
    }
    const invocationId = String(invocation?.invocationId || "");
    const hash = requestHash(invocation);
    const active = this.activeInvocations.get(invocationId);
    if (active) {
      await this.authorizeForReplay(invocation);
      if (active.requestHash !== hash) {
        throw new Error(
          `Tool invocation id was reused with different arguments: ${invocationId}`
        );
      }
      return await active.completion;
    }

    const completion = this.invokeTraced(invocation, signal);
    this.activeInvocations.set(invocationId, {
      requestHash: hash,
      completion
    });
    try {
      return await completion;
    } finally {
      const current = this.activeInvocations.get(invocationId);
      if (current?.completion === completion) {
        this.activeInvocations.delete(invocationId);
      }
    }
  }

  async invokeTraced(invocation, signal) {
    return runtimeTracer.startActiveSpan("execute_tool", {
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": telemetryIdentifier(invocation.toolCall?.name),
        "gen_ai.tool.call.id": telemetryIdentifier(invocation.toolCall?.id),
        "zion.run.id": telemetryIdentifier(invocation.runId),
        "zion.attempt.id": telemetryIdentifier(invocation.attemptId),
        "zion.tool.receipt_hit": false
      }
    }, async (span) => {
      const observation = { failureType: "tool_error" };
      try {
        const result = await this.invokeObserved(invocation, signal, span, observation);
        span.setAttribute("zion.tool.ok", result.ok === true);
        if (!result.ok) {
          failSpan(span, result.failureCode || "tool_result_error");
        }
        return result;
      } catch (error) {
        if (signal?.cancelled) {
          const reason = cancellationType(signal.reason);
          span.setAttribute("zion.cancellation.reason", reason);
          if (reason === "timeout") failSpan(span, reason);
        } else {
          failSpan(span, observation.failureType);
        }
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async invokeObserved(invocation, signal, span, observation) {
    // Authorization precedes receipt lookup: revoked users cannot read cached
    // results or skip a newly restricted policy by replaying an invocation ID.
    observation.failureType = "policy_denied";
    invocation = await this.authorizeForReplay(invocation);
    const hash = requestHash(invocation);
    const existing = await this.receipts.getToolReceipt(invocation.invocationId);
    if (existing) {
      if (existing.requestHash !== hash) {
        observation.failureType = "receipt_conflict";
        throw new Error(
          `Tool invocation id was reused with different arguments: ${invocation.invocationId}`
        );
      }
      span.setAttribute("zion.tool.receipt_hit", true);
      return existing.result;
    }

    const name = String(invocation.toolCall?.name || "");
    const execution = this.executionForTool(name);
    span.setAttribute("zion.tool.effect", execution.effect);
    span.setAttribute("zion.tool.idempotency", execution.idempotency);
    span.setAttribute("zion.tool.cancellation", execution.cancellation);
    const priorUnknown = await this.receipts.findToolReceiptByRequestHash?.(
      invocation.runId,
      name,
      hash
    );
    if (
      priorUnknown
      && priorUnknown.invocationId !== invocation.invocationId
      && priorUnknown.result?.failureCode === "execution_outcome_unknown"
      && execution.idempotency !== "safe"
    ) {
      span.setAttribute("zion.tool.receipt_hit", true);
      const result = duplicateUnknownResult(name, priorUnknown);
      return (await this.receipts.saveToolReceipt({
        invocationId: invocation.invocationId,
        runId: invocation.runId,
        toolName: name,
        requestHash: hash,
        result,
        completedAt: Date.now()
      })).result;
    }
    if (
      name === "sendMail"
      && await this.receipts.countToolReceipts(invocation.runId, "sendMail")
        >= Number(invocation.policy?.maxMailPerRun || 0)
    ) {
      throw new Error("mail quota exceeded");
    }

    observation.failureType = "tool_error";
    const activeRequest = this.activeRequests.get(hash);
    if (
      activeRequest
      && activeRequest.invocationId !== invocation.invocationId
      && execution.idempotency !== "safe"
    ) {
      span.setAttribute("zion.tool.receipt_hit", true);
      const result = duplicateUnknownResult(name, activeRequest);
      return (await this.receipts.saveToolReceipt({
        invocationId: invocation.invocationId,
        runId: invocation.runId,
        toolName: name,
        requestHash: hash,
        result,
        completedAt: Date.now()
      })).result;
    }

    const invokeHost = async (executionSignal) => {
      if (name === "webSearch") {
        span.setAttribute("zion.tool.host_kind", "runtime");
        return await executeWebSearch(invocation.toolCall?.arguments, {
          fetchImpl: this.fetchImpl,
          signal: executionSignal,
          invocationId: invocation.invocationId,
          timeoutMs: this.webTimeoutMs,
          maxResultChars: this.maxWebResultChars
        });
      }
      if (name === "webFetch") {
        span.setAttribute("zion.tool.host_kind", "runtime");
        return await this.invokeWebFetch(invocation, executionSignal);
      }
      if (name === "todoWrite") {
        span.setAttribute("zion.tool.host_kind", "runtime");
        return await this.invokeTodoWrite(invocation);
      }
      if (this.pluginTools?.hasTool?.(name)) {
        span.setAttribute("zion.tool.host_kind", "runtime-plugin");
        return await this.pluginTools.invoke(invocation, executionSignal);
      }
      if (RUNTIME_NATIVE_TOOL_NAMES.has(name)) {
        throw new Error(`Unsupported Runtime-native tool: ${name}`);
      }
      span.setAttribute("zion.tool.host_kind", "delegated");
      return await this.localTools.invoke(invocation, executionSignal);
    };
    const activeMarker = {
      invocationId: invocation.invocationId,
      requestHash: hash
    };
    this.activeRequests.set(hash, activeMarker);
    try {
      const result = await this.invocationLifecycle.execute({
        invocation,
        signal,
        execution,
        invoke: invokeHost,
        failureCodeFromError: toolFailureCodeFromError
      });
      const completedAt = Date.now();
      const resultWithArtifacts = enrichToolResultWithArtifacts(
        invocation,
        result,
        completedAt
      );
      const enrichedResult = classifyToolResult(
        name,
        resultWithArtifacts,
        execution
      );
      span.setAttribute(
        "zion.tool.artifact_count",
        enrichedResult.artifacts?.length || 0
      );
      span.setAttribute(
        "zion.tool.change_count",
        enrichedResult.changes?.length || 0
      );
      if (enrichedResult.artifacts?.length || enrichedResult.changes?.length) {
        await this.receipts.saveRunArtifacts?.({
          runId: invocation.runId,
          invocationId: invocation.invocationId,
          artifacts: enrichedResult.artifacts || [],
          changes: enrichedResult.changes || [],
          createdAt: completedAt
        });
      }
      return (await this.receipts.saveToolReceipt({
        invocationId: invocation.invocationId,
        runId: invocation.runId,
        toolName: name,
        requestHash: hash,
        result: enrichedResult,
        completedAt
      })).result;
    } finally {
      if (this.activeRequests.get(hash) === activeMarker) {
        this.activeRequests.delete(hash);
      }
    }
  }

  async invokeWebFetch(invocation, signal) {
    signal.throwIfCancelled();
    const target = await assertPublicUrl(
      invocation.toolCall?.arguments?.url,
      this.lookupImpl
    );
    const failures = [];
    const failureCodes = [];
    for (const origin of WEB_FETCH_PROXY_ORIGINS) {
      signal.throwIfCancelled();
      const controller = new globalThis.AbortController();
      const cancellation = signal.onCancel(() => controller.abort());
      const timer = globalThis.setTimeout(
        () => controller.abort(),
        this.webTimeoutMs
      );
      const proxy = new URL(`${origin}/${target.href}`);
      try {
        const response = await this.fetchImpl(proxy, {
          method: "GET",
          headers: {
            accept: "text/markdown, text/plain;q=0.9",
            "x-zion-invocation-id": invocation.invocationId
          },
          signal: controller.signal
        });
        const content = await response.text();
        if (!response.ok) {
          failureCodes.push(httpFailureCode(response.status));
          failures.push(`${proxy.hostname}: HTTP ${response.status}`);
          continue;
        }
        return {
          ok: true,
          content: compactText(
            `# Fetched: ${target.href}\n\n${content}`,
            this.maxWebResultChars
          )
        };
      } catch (error) {
        signal.throwIfCancelled();
        failureCodes.push(failureCodeFromError(error));
        failures.push(`${proxy.hostname}: ${errorDetail(error)}`);
      } finally {
        globalThis.clearTimeout(timer);
        cancellation.dispose();
      }
    }
    const error = `webFetch proxy attempts failed: ${failures.join("; ")}`;
    return {
      ok: false,
      failureCode: chooseFailureCode(failureCodes),
      error,
      content: error
    };
  }

  async invokeTodoWrite(invocation) {
    const args = invocation.toolCall?.arguments || {};
    const todos = normalizeTodoList(args.todos);
    const taskId = String(args.taskId || "").trim();
    const ownerId = invocation.sessionId || invocation.runId;
    const saved = await this.receipts.saveTodoList(ownerId, todos, Date.now(), {
      taskId,
      sessionId: invocation.sessionId || "",
      runId: invocation.runId
    });
    return {
      ok: true,
      content: JSON.stringify(saved, null, 2)
    };
  }
}
