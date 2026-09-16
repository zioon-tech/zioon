import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { URL } from "node:url";
import {
  LOCAL_TOOLS_TOOL_DEFINITIONS
} from "../../../packages/local-tools-client/src/index.mjs";
import { enrichToolResultWithArtifacts } from "./run-artifact-service.mjs";
import {
  cancellationType,
  failSpan,
  runtimeTracer,
  telemetryIdentifier
} from "../../../packages/runtime/dist/telemetry.js";

export const RUNTIME_NATIVE_TOOL_DEFINITIONS = [{
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
  hostKinds: ["runtime"]
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
  hostKinds: ["runtime"]
}];

export const RUNTIME_TOOL_DEFINITIONS = [
  ...LOCAL_TOOLS_TOOL_DEFINITIONS,
  ...RUNTIME_NATIVE_TOOL_DEFINITIONS
];

const RUNTIME_NATIVE_TOOL_NAMES = new Set(
  RUNTIME_NATIVE_TOOL_DEFINITIONS.map((tool) => tool.name)
);

const WEB_FETCH_PROXY_ORIGINS = [
  "https://r.jinaai.cn",
  "https://r.jina.ai"
];

function errorDetail(error) {
  const message = String(error?.message || error || "unknown error");
  const cause = String(error?.cause?.code || error?.cause?.message || "").trim();
  return cause && !message.includes(cause) ? `${message} (${cause})` : message;
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
      arguments: invocation.toolCall?.arguments || {}
    })))
    .digest("hex");
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
    delegatedToolNames = null,
    fetchImpl = globalThis.fetch,
    lookupImpl = lookup,
    maxWebResultChars = 30_000,
    webTimeoutMs = 30_000
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
    this.fetchImpl = fetchImpl;
    this.lookupImpl = lookupImpl;
    this.maxWebResultChars = maxWebResultChars;
    this.webTimeoutMs = webTimeoutMs;
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
    ];
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
    return [
      ...local.filter((tool) => !reserved.has(tool.name)),
      ...native,
      ...plugin
    ];
  }

  async invoke(invocation, signal) {
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
        if (!result.ok) failSpan(span, "tool_result_error");
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
    const hash = requestHash(invocation);
    const existing = this.receipts.getToolReceipt(invocation.invocationId);
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
    observation.failureType = "policy_denied";
    if (!(invocation.policy?.allowedTools || []).includes(name)) {
      throw new Error("tool is not allowed by capability policy");
    }
    if (
      name === "todoWrite"
      && invocation.policy?.preset !== "trusted-automation"
    ) {
      throw new Error("todoWrite requires trusted-automation capability");
    }
    if (
      name === "sendMail"
      && this.receipts.countToolReceipts(invocation.runId, "sendMail")
        >= Number(invocation.policy?.maxMailPerRun || 0)
    ) {
      throw new Error("mail quota exceeded");
    }

    observation.failureType = "tool_error";
    let result;
    if (name === "webFetch") {
      span.setAttribute("zion.tool.host_kind", "runtime");
      result = await this.invokeWebFetch(invocation, signal);
    } else if (name === "todoWrite") {
      span.setAttribute("zion.tool.host_kind", "runtime");
      result = this.invokeTodoWrite(invocation);
    } else if (this.pluginTools?.hasTool?.(name)) {
      span.setAttribute("zion.tool.host_kind", "runtime-plugin");
      result = await this.pluginTools.invoke(invocation, signal);
    } else if (RUNTIME_NATIVE_TOOL_NAMES.has(name)) {
      throw new Error(`Unsupported Runtime-native tool: ${name}`);
    } else {
      span.setAttribute("zion.tool.host_kind", "delegated");
      result = await this.localTools.invoke(invocation, signal);
    }

    const completedAt = Date.now();
    const enrichedResult = enrichToolResultWithArtifacts(
      invocation,
      result,
      completedAt
    );
    span.setAttribute("zion.tool.artifact_count", enrichedResult.artifacts?.length || 0);
    span.setAttribute("zion.tool.change_count", enrichedResult.changes?.length || 0);
    if (enrichedResult.artifacts?.length || enrichedResult.changes?.length) {
      this.receipts.saveRunArtifacts?.({
        runId: invocation.runId,
        invocationId: invocation.invocationId,
        artifacts: enrichedResult.artifacts || [],
        changes: enrichedResult.changes || [],
        createdAt: completedAt
      });
    }
    return this.receipts.saveToolReceipt({
      invocationId: invocation.invocationId,
      runId: invocation.runId,
      toolName: name,
      requestHash: hash,
      result: enrichedResult,
      completedAt
    }).result;
  }

  async invokeWebFetch(invocation, signal) {
    signal.throwIfCancelled();
    const target = await assertPublicUrl(
      invocation.toolCall?.arguments?.url,
      this.lookupImpl
    );
    const failures = [];
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
        failures.push(`${proxy.hostname}: ${errorDetail(error)}`);
      } finally {
        globalThis.clearTimeout(timer);
        cancellation.dispose();
      }
    }
    const error = `webFetch proxy attempts failed: ${failures.join("; ")}`;
    return {
      ok: false,
      error,
      content: error
    };
  }

  invokeTodoWrite(invocation) {
    const args = invocation.toolCall?.arguments || {};
    const todos = normalizeTodoList(args.todos);
    const taskId = String(args.taskId || "").trim();
    const ownerId = invocation.sessionId || invocation.runId;
    const saved = this.receipts.saveTodoList(ownerId, todos, Date.now(), {
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
