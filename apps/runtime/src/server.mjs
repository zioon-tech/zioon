import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { resolveInteractionRequest } from "./interaction-profile-store.mjs";
import {
  createRunEventProjector,
  projectRunEvents
} from "./run-event-projection.mjs";

const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted", "interrupted"]);
const MAX_REQUEST_BYTES = 1024 * 1024;
const POLICY_PRESETS = new Set(["read-only", "workspace-write", "trusted-automation"]);
const THINKING_MODES = new Set(["auto", "off", "on"]);
const THINKING_EFFORTS = new Set([
  "auto",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);
const WORKSPACE_WRITE_TOOLS = new Set([
  "write",
  "edit",
  "sessionCreate",
  "sessionUpdate",
  "sessionDelete"
]);
const TRUSTED_AUTOMATION_TOOLS = new Set([
  "Bash",
  "sendMail",
  "todoWrite",
  "mcpCall",
  "schedulerManage",
  "modelsManage",
  "toolsManage",
  "mailManage"
]);
const NETWORK_TOOLS = new Set([
  "webSearch",
  "webFetch",
  "sendMail",
  "mcpListTools",
  "mcpCall"
]);

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error("Request body exceeds 1 MiB");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function matchRunPath(pathname, suffix = "") {
  const escapedSuffix = suffix.replaceAll("/", "\\/");
  const match = pathname.match(
    new RegExp(`^\\/v1\\/runs\\/([^/]+)${escapedSuffix}$`)
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function matchRunEventPath(pathname) {
  const match = pathname.match(/^\/v1\/runs\/([^/]+)\/events\/(\d+)$/);
  return match ? {
    runId: decodeURIComponent(match[1]),
    sequence: Number(match[2])
  } : null;
}

function matchSessionPath(pathname, suffix = "") {
  const escapedSuffix = suffix.replaceAll("/", "\\/");
  const match = pathname.match(
    new RegExp(`^\\/v1\\/sessions\\/([^/]+)${escapedSuffix}$`)
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function matchModelProfilePath(pathname) {
  const match = pathname.match(/^\/v1\/model-profiles\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function matchInteractionProfilePath(pathname) {
  const match = pathname.match(/^\/v1\/interaction-profiles\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function matchTodoListPath(pathname) {
  const match = pathname.match(/^\/v1\/todo-lists\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function normalizePolicy(policy) {
  const preset = ["read-only", "workspace-write", "trusted-automation"]
    .includes(String(policy?.preset))
    ? String(policy.preset)
    : "read-only";
  return {
    preset,
    allowedTools: Array.isArray(policy?.allowedTools)
      ? Array.from(new Set(policy.allowedTools.map(String).filter(Boolean)))
      : [],
    maxToolCalls: Math.max(1, Number(policy?.maxToolCalls) || 50),
    fileRoots: Array.isArray(policy?.fileRoots)
      ? policy.fileRoots.map(String).filter(Boolean)
      : [],
    allowedCommandPrefixes: Array.isArray(policy?.allowedCommandPrefixes)
      ? policy.allowedCommandPrefixes.map(String).filter(Boolean)
      : [],
    allowedTerminalSessionIds: Array.isArray(policy?.allowedTerminalSessionIds)
      ? policy.allowedTerminalSessionIds.map(String).filter(Boolean)
      : [],
    allowedRecipients: Array.isArray(policy?.allowedRecipients)
      ? policy.allowedRecipients.map((value) => String(value).toLowerCase()).filter(Boolean)
      : [],
    maxMailPerRun: Math.max(0, Number(policy?.maxMailPerRun) || 0)
  };
}

function normalizeModelOptions(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const thinkingMode = String(source.thinkingMode || "").toLowerCase();
  const thinkingEffort = String(source.thinkingEffort || "").toLowerCase();
  return {
    ...(THINKING_MODES.has(thinkingMode) ? { thinkingMode } : {}),
    ...(THINKING_EFFORTS.has(thinkingEffort) ? { thinkingEffort } : {})
  };
}

function cloneObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeMessageContent(value, role = "user") {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || role !== "user") {
    const error = new Error("Message content must be text or supported content parts");
    error.statusCode = 400;
    throw error;
  }
  const parts = value.map((part) => {
    if (part?.type === "text" && typeof part.text === "string") {
      return { type: "text", text: part.text };
    }
    if (
      part?.type === "image_url"
      && typeof part.image_url?.url === "string"
      && part.image_url.url.trim()
    ) {
      return {
        type: "image_url",
        image_url: {
          url: part.image_url.url,
          ...(["auto", "low", "high"].includes(part.image_url.detail)
            ? { detail: part.image_url.detail }
            : {})
        }
      };
    }
    const error = new Error(`Unsupported message content part: ${part?.type || "unknown"}`);
    error.statusCode = 400;
    throw error;
  });
  if (!parts.length) {
    const error = new Error("Message content parts cannot be empty");
    error.statusCode = 400;
    throw error;
  }
  return parts;
}

function messageContentText(value) {
  if (typeof value === "string") return value;
  return (Array.isArray(value) ? value : []).map((part) => {
    if (part?.type === "text") return String(part.text || "");
    if (part?.type === "image_url") return `[image:${String(part.image_url?.url || "")}]`;
    return "";
  }).filter(Boolean).join("\n");
}

function normalizeRunMessages(value) {
  if (!Array.isArray(value)) return undefined;
  const callIds = new Set();
  const messages = value.map((message) => {
    const role = String(message?.role || "");
    if (!["system", "user", "assistant", "tool"].includes(role)) {
      const error = new Error(`Unsupported message role: ${role || "missing"}`);
      error.statusCode = 400;
      throw error;
    }
    const sourceCalls = Array.isArray(message?.toolCalls)
      ? message.toolCalls
      : Array.isArray(message?.tool_calls)
        ? message.tool_calls
        : [];
    const toolCalls = sourceCalls.map((call) => {
      const id = String(call?.id || "").trim();
      const name = String(call?.function?.name || "").trim();
      if (!id || !name) {
        const error = new Error("Assistant tool calls require id and function.name");
        error.statusCode = 400;
        throw error;
      }
      callIds.add(id);
      let argumentsText = call.function.arguments;
      if (typeof argumentsText !== "string") {
        argumentsText = JSON.stringify(argumentsText || {});
      }
      return {
        id,
        type: "function",
        function: { name, arguments: argumentsText }
      };
    });
    const toolCallId = String(message?.toolCallId || message?.tool_call_id || "").trim();
    const content = normalizeMessageContent(
      message?.content == null && role === "assistant" && toolCalls.length
        ? ""
        : message?.content,
      role
    );
    return {
      role,
      content,
      ...(message?.reasoningContent || message?.reasoning_content
        ? {
            reasoningContent: String(
              message.reasoningContent || message.reasoning_content
            )
          }
        : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(toolCallId ? { toolCallId } : {})
    };
  });
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.toolCallId || !callIds.has(message.toolCallId)) {
        const error = new Error("Tool messages require a matching assistant tool call");
        error.statusCode = 400;
        throw error;
      }
    } else if (message.toolCallId) {
      const error = new Error("toolCallId is only valid on tool messages");
      error.statusCode = 400;
      throw error;
    }
  }
  return messages;
}

function sessionSeedMessages(value) {
  const messages = Array.isArray(value) ? value : [];
  let currentUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      currentUserIndex = index;
      break;
    }
  }
  return currentUserIndex >= 0
    ? messages.slice(0, currentUserIndex)
    : messages;
}

function policyPresetForTool(tool) {
  const explicit = String(
    tool?.policy?.minimumPreset
    || tool?.minimumPreset
    || ""
  );
  if (POLICY_PRESETS.has(explicit)) return explicit;
  const name = String(tool?.name || "");
  if (TRUSTED_AUTOMATION_TOOLS.has(name)) return "trusted-automation";
  if (WORKSPACE_WRITE_TOOLS.has(name)) return "workspace-write";
  return "read-only";
}

function ownerForTool(tool, hostKinds) {
  const pluginId = String(tool?.pluginId || "").trim();
  if (pluginId) return { kind: "plugin", id: pluginId };
  const name = String(tool?.name || "");
  if (name.startsWith("mcp")) return { kind: "mcp", id: "local-tools" };
  if (hostKinds.includes("runtime")) return { kind: "runtime", id: "runtime" };
  if (hostKinds.includes("local-tools")) return { kind: "device", id: "local-tools" };
  if (hostKinds.includes("device-node")) return { kind: "device", id: "device-node" };
  if (hostKinds.includes("device")) return { kind: "device", id: "device" };
  if (hostKinds.includes("runtime-plugin")) return { kind: "plugin", id: "runtime-plugin" };
  return { kind: "runtime", id: "runtime" };
}

function availabilityForTool(tool, owner) {
  const name = String(tool?.name || "");
  return {
    headless: true,
    requiresWorkbench: false,
    requiresDevice: owner.kind === "device" || owner.kind === "mcp",
    requiresNetwork: NETWORK_TOOLS.has(name)
  };
}

function policyMetadataForTool(tool) {
  const name = String(tool?.name || "");
  return {
    minimumPreset: policyPresetForTool(tool),
    ...(WORKSPACE_WRITE_TOOLS.has(name)
      ? { requiresFileRoots: true }
      : {}),
    ...(name === "sendMail"
      ? { requiresApproval: true, requiredScopes: ["mail.send"] }
      : {})
  };
}

function normalizeCapabilityTool(tool) {
  const hostKinds = Array.isArray(tool?.hostKinds)
    ? tool.hostKinds.map(String).filter(Boolean)
    : [];
  const owner = ownerForTool(tool, hostKinds);
  return {
    name: String(tool?.name || ""),
    description: String(tool?.description || ""),
    inputSchema: tool?.inputSchema && typeof tool.inputSchema === "object"
      ? cloneObject(tool.inputSchema)
      : tool?.inputSchema,
    hostKinds,
    ...(tool?.pluginId ? { pluginId: String(tool.pluginId) } : {}),
    ...(tool?.risk ? { risk: String(tool.risk) } : {}),
    owner,
    availability: availabilityForTool(tool, owner),
    policy: {
      ...(tool?.policy && typeof tool.policy === "object"
        ? cloneObject(tool.policy)
        : {}),
      ...policyMetadataForTool(tool)
    }
  };
}

function modelRefFromProfile(profile) {
  if (!profile?.model) return null;
  return {
    profileId: String(profile.id || profile.model),
    providerId: String(profile.providerId || profile.providerType || "runtime"),
    modelId: String(profile.model),
    label: String(profile.label || profile.model)
  };
}

function createId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function assertLocalBinding(host, allowRemote) {
  if (allowRemote) return;
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") return;
  throw new Error(
    "Runtime Host has no remote authentication yet and may only bind to loopback"
  );
}

function allowLoopbackBrowserOrigin(request, response) {
  const origin = String(request.headers.origin || "").trim();
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (
      !["http:", "https:"].includes(url.protocol)
      || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
    ) {
      return false;
    }
  } catch {
    return false;
  }
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "content-type, authorization, last-event-id, x-api-key, api-key, anthropic-version, anthropic-beta"
  );
  response.setHeader("vary", "Origin");
  return true;
}

async function drainEvents(events, onEvent = null) {
  for await (const event of events) {
    if (typeof onEvent === "function") await onEvent(event);
  }
}

async function writeSseEvent(response, event) {
  if (response.destroyed || response.writableEnded) return false;
  const frame = [
    `id: ${event.sequence}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    ""
  ].join("\n");
  if (response.write(frame)) return true;
  return new Promise((resolve) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onClose);
  });
}

function runProjectionOptions(url) {
  return {
    reasoningMode: url.searchParams.get("reasoning") || "stream",
    maxDelayMs: url.searchParams.get("max_delay_ms"),
    maxChunkChars: url.searchParams.get("max_chunk_chars")
  };
}

export function createRuntimeServer({
  executor,
  runs,
  sessions = runs,
  host = "127.0.0.1",
  port = 0,
  allowRemote = false,
  pollIntervalMs = 50,
  serviceInfo = {},
  modelProfiles = [],
  resolveModel,
  importModelProfile,
  deleteModelProfile,
  interactionProfiles,
  capabilityTools = [],
  nodeHttpHandler,
  serviceHttpHandlers = [],
  upgradeHandlers = [],
  sessionEventStore = null,
  sessionDocumentService = null,
  runPostProcessors = [],
  onPostProcessorError = () => {}
}) {
  if (!executor?.execute) throw new Error("Runtime executor is required");
  if (!runs?.get || !runs?.getEvents) throw new Error("Runtime RunStore is required");
  if (
    !sessions?.createSession
    || !sessions?.forkSession
    || !sessions?.getSession
    || !sessions?.getSessionMessages
    || !sessions?.getSessionTranscript
    || !sessions?.appendSessionMessages
  ) {
    throw new Error("Runtime SessionStore is required");
  }
  assertLocalBinding(host, allowRemote);
  const defaultModel = modelRefFromProfile(serviceInfo.modelProfile);
  const resolveRequestedModel = (requested) => {
    if (typeof resolveModel === "function") return resolveModel(requested || null);
    return requested || defaultModel || null;
  };
  const resolveRequest = (body) => resolveInteractionRequest({
    body,
    interactionProfiles,
    resolveModel: resolveRequestedModel,
    fallbackModel: defaultModel
  });
  const listCapabilityTools = () => {
    const source = typeof capabilityTools === "function"
      ? capabilityTools()
      : capabilityTools;
    return Array.isArray(source)
      ? source.map(normalizeCapabilityTool)
      : [];
  };

  const handles = new Map();
  const sessionHandles = new Map();
  const projectionFailures = new Map();
  const publishSessionEvent = (type, {
    sessionId = "",
    runId = "",
    attemptId = "",
    sourceClientId = "",
    data = {}
  } = {}) => {
    if (!sessionEventStore?.appendEvent) return null;
    try {
      return sessionEventStore.appendEvent(type, {
        sessionId,
        runId,
        sourceClientId,
        payload: {
          ...data,
          ...(attemptId ? { attemptId } : {})
        }
      });
    } catch (error) {
      onPostProcessorError(error, {
        processorId: "runtime.session-events",
        runId,
        sessionId
      });
      return null;
    }
  };
  const listRunPostProcessors = () => {
    const source = typeof runPostProcessors === "function"
      ? runPostProcessors()
      : runPostProcessors;
    return Array.isArray(source)
      ? source
          .filter((processor) => processor && typeof processor.process === "function")
          .sort((left, right) =>
            Number(left.order || 100) - Number(right.order || 100)
            || String(left.id || "").localeCompare(String(right.id || ""))
          )
      : [];
  };
  const runCompletedPostProcessors = async ({
    handle,
    result,
    runRequest,
    sessionId,
    messages
  }) => {
    if (result.status !== "completed") return;
    const processors = listRunPostProcessors();
    if (!processors.length) return;
    const transcript = Array.isArray(messages) && messages.length
      ? messages
      : [
          ...(Array.isArray(runRequest?.messages) ? runRequest.messages : []),
          ...(String(result.output || "").trim()
            ? [{ role: "assistant", content: result.output }]
            : [])
        ];
    const context = Object.freeze({
      runId: result.runId || handle.runId,
      attemptId: handle.attemptId,
      sessionId: String(sessionId || runRequest?.sessionId || ""),
      projectId: String(runRequest?.projectId || ""),
      title: String(runRequest?.title || ""),
      status: result.status,
      output: String(result.output || ""),
      usage: result.usage || {},
      messages: transcript.map((message) => ({
        role: String(message?.role || ""),
        content: messageContentText(message?.content),
        ...(message?.reasoningContent
          ? { reasoningContent: String(message.reasoningContent) }
          : {}),
        ...(Array.isArray(message?.toolCalls)
          ? { toolCalls: message.toolCalls }
          : {}),
        ...(message?.toolCallId
          ? { toolCallId: String(message.toolCallId) }
          : {}),
        ...(message?.runId ? { runId: String(message.runId) } : {})
      })),
      metadata: runRequest?.metadata && typeof runRequest.metadata === "object"
        ? { ...runRequest.metadata }
        : {},
      model: runRequest?.model || null,
      policy: runRequest?.policy || null
    });
    for (const processor of processors) {
      try {
        await processor.process(context);
      } catch (error) {
        try {
          onPostProcessorError(error, {
            processorId: processor.id,
            pluginId: processor.pluginId,
            runId: context.runId,
            sessionId: context.sessionId
          });
        } catch {
          // Post-processor error reporting must not affect Run completion.
        }
      }
    }
  };
  const reconcileSessionProjections = async () => {
    if (!sessions.reconcileCompletedSessionMessages) return;
    await sessions.reconcileCompletedSessionMessages();
    projectionFailures.clear();
  };
  const trackHandle = (handle, sessionId, runRequest = {}) => {
    handles.set(handle.runId, handle);
    if (sessionId) sessionHandles.set(sessionId, handle);
    let completedAssistantContent;
    if (sessionId) {
      publishSessionEvent("run.started", {
        sessionId,
        runId: handle.runId,
        attemptId: handle.attemptId,
        sourceClientId: String(
          runRequest?.metadata?.workbenchClientId || ""
        ),
        data: {
          status: "running",
          resumed: runRequest?.metadata?.resumed === true
        }
      });
    }
    const documentProjection = drainEvents(handle.events, async (event) => {
      if (event.type === "message.completed") {
        completedAssistantContent = String(event.data?.content || "");
      }
      if (!sessionId || !sessionDocumentService?.applyRunEvent) return;
      await sessionDocumentService.applyRunEvent(
        sessionId,
        event,
        {
          appendUserPrompt:
            runRequest?.metadata?.documentProjection?.appendUserPrompt === true
        }
      );
    }).catch((error) => {
      onPostProcessorError(error, {
        processorId: "runtime.collaboration-projection",
        runId: handle.runId,
        sessionId
      });
    });
    void documentProjection;
    void handle.completion
      .then(async (result) => {
        await documentProjection;
        let projectedMessages = null;
        if (sessionId && result.status === "completed") {
          await sessions.appendSessionMessages(sessionId, [{
            schemaVersion: 1,
            id: createId("message"),
            sessionId,
            role: "assistant",
            content: completedAssistantContent ?? result.output,
            runId: result.runId,
            createdAt: Date.now()
          }]);
          projectedMessages = await sessions.getSessionTranscript(sessionId);
        }
        if (sessionId) {
          publishSessionEvent(`run.${result.status}`, {
            sessionId,
            runId: result.runId || handle.runId,
            attemptId: handle.attemptId,
            sourceClientId: String(
              runRequest?.metadata?.workbenchClientId || ""
            ),
            data: {
              status: result.status,
              reason: result.reason || "",
              error: result.error || ""
            }
          });
        }
        await runCompletedPostProcessors({
          handle,
          result,
          runRequest,
          sessionId,
          messages: projectedMessages
        });
      })
      .catch((error) => {
        projectionFailures.set(handle.runId, error);
        if (sessionId) {
          publishSessionEvent("run.failed", {
            sessionId,
            runId: handle.runId,
            attemptId: handle.attemptId,
            sourceClientId: String(
              runRequest?.metadata?.workbenchClientId || ""
            ),
            data: {
              status: "failed",
              error: error?.message || String(error)
            }
          });
        }
      })
      .finally(() => {
        if (handles.get(handle.runId) === handle) handles.delete(handle.runId);
        if (sessionId && sessionHandles.get(sessionId) === handle) {
          sessionHandles.delete(sessionId);
        }
      });
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || host}`);
      if (!allowLoopbackBrowserOrigin(request, response)) {
        json(response, 403, { error: "Browser origin is not allowed" });
        return;
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }

      if (
        nodeHttpHandler
        && await nodeHttpHandler(request, response, url)
      ) {
        return;
      }
      for (const handler of serviceHttpHandlers) {
        if (await handler(request, response, url)) return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, {
          ok: true,
          service: "zion-runtime",
          ...serviceInfo
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        json(response, 200, {
          activeProfileId: serviceInfo.modelProfile?.id || null,
          profiles: typeof modelProfiles === "function"
            ? modelProfiles()
            : modelProfiles
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/capabilities/tools") {
        json(response, 200, { tools: listCapabilityTools() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/todo-lists") {
        if (typeof runs.listTodoLists !== "function") {
          json(response, 501, { error: "Runtime todo list store is unavailable" });
          return;
        }
        json(response, 200, {
          todoLists: runs.listTodoLists({
            limit: url.searchParams.get("limit"),
            updatedAfter: url.searchParams.get("updatedAfter")
          })
        });
        return;
      }

      const todoListOwnerId =
        matchTodoListPath(url.pathname)
        || matchSessionPath(url.pathname, "/todos")
        || matchRunPath(url.pathname, "/todos");
      if (request.method === "GET" && todoListOwnerId) {
        if (typeof runs.getTodoList !== "function") {
          json(response, 501, { error: "Runtime todo list store is unavailable" });
          return;
        }
        const todoList = runs.getTodoList(todoListOwnerId);
        if (!todoList) {
          json(response, 404, { error: "Runtime todo list not found" });
          return;
        }
        json(response, 200, { todoList });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/interaction-profiles") {
        json(response, 200, {
          profiles: typeof interactionProfiles?.list === "function"
            ? interactionProfiles.list()
            : []
        });
        return;
      }

      const interactionProfileId = matchInteractionProfilePath(url.pathname);
      if (request.method === "GET" && interactionProfileId) {
        const profile = interactionProfiles?.get?.(interactionProfileId);
        if (!profile) {
          json(response, 404, { error: "Interaction profile not found" });
          return;
        }
        json(response, 200, { profile });
        return;
      }

      if (
        (request.method === "PUT" || request.method === "PATCH")
        && interactionProfileId
      ) {
        if (
          request.method === "PATCH"
          && typeof interactionProfiles?.patch !== "function"
        ) {
          json(response, 501, { error: "Runtime interaction profile patch is unavailable" });
          return;
        }
        if (
          request.method === "PUT"
          && typeof interactionProfiles?.upsert !== "function"
        ) {
          json(response, 501, { error: "Runtime interaction profile store is unavailable" });
          return;
        }
        const body = await readJson(request);
        const profile = request.method === "PATCH"
          ? interactionProfiles.patch(interactionProfileId, body.profile || body)
          : interactionProfiles.upsert({
              ...(body.profile && typeof body.profile === "object"
                ? body.profile
                : body),
              id: interactionProfileId
            });
        json(response, 200, { profile });
        return;
      }

      const modelProfileId = matchModelProfilePath(url.pathname);
      if (request.method === "PUT" && modelProfileId) {
        if (typeof importModelProfile !== "function") {
          json(response, 501, { error: "Runtime model profile import is unavailable" });
          return;
        }
        const body = await readJson(request);
        const result = await importModelProfile({
          profile: {
            ...(body.profile && typeof body.profile === "object"
              ? body.profile
              : {}),
            id: modelProfileId
          },
          credential: body.credential
        });
        json(response, 200, result);
        return;
      }
      if (request.method === "DELETE" && modelProfileId) {
        if (typeof deleteModelProfile !== "function") {
          json(response, 501, { error: "Runtime model profile delete is unavailable" });
          return;
        }
        const result = await deleteModelProfile(modelProfileId);
        if (!result) {
          json(response, 404, { error: "Model profile not found" });
          return;
        }
        json(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/runs") {
        const body = await readJson(request);
        if (
          body?.metadata?.source === "interactive-chat"
          && Number(body.metadata.workbenchProtocolVersion) !== 2
        ) {
          json(response, 426, {
            error: "Workbench realtime protocol is outdated; refresh all Workbench tabs"
          });
          return;
        }
        const normalizedMessages = normalizeRunMessages(body.messages);
        const normalizedSessionHistory = normalizeRunMessages(body.sessionHistory);
        const resolved = body.interactionProfileId
          ? resolveRequest(body)
          : {
              model: resolveRequestedModel(body.model),
              policy: normalizePolicy(body.policy),
              metadata: body.metadata && typeof body.metadata === "object"
                ? { ...body.metadata }
                : {}
            };
        const runRequest = {
          ...body,
          ...(normalizedMessages ? { messages: normalizedMessages } : {}),
          ...(resolved.model ? { model: resolved.model } : {}),
          modelOptions: normalizeModelOptions(body.modelOptions),
          policy: resolved.policy,
          metadata: resolved.metadata
        };
        const requestedSessionId = String(body.sessionId || "").trim();
        const latestUserMessage = Array.isArray(normalizedMessages)
          ? normalizedMessages.slice().reverse().find((message) => message?.role === "user")
          : null;
        const canonicalUserContent = latestUserMessage?.content ?? body.prompt ?? "";
        const sessionUserContent = messageContentText(canonicalUserContent);
        let attachedSessionId = "";
        let createdSession = false;
        if (requestedSessionId && sessionUserContent.trim()) {
          if (sessionHandles.has(requestedSessionId)) {
            json(response, 409, { error: "Session already has an active Run" });
            return;
          }
          let session = await sessions.getSession(requestedSessionId);
          if (!session) {
            const timestamp = Date.now();
            session = {
              id: requestedSessionId,
              status: "active",
              title: String(body.title || resolved.metadata?.sessionTitle || ""),
              projectId: body.projectId ? String(body.projectId) : undefined,
              model: resolved.model || undefined,
              policy: resolved.policy,
              metadata: resolved.metadata,
              createdAt: timestamp,
              updatedAt: timestamp
            };
            await sessions.createSession(session);
            createdSession = true;
          }
          if (session.status !== "active") {
            json(response, 409, { error: `Session is not active: ${session.status}` });
            return;
          }
          attachedSessionId = requestedSessionId;
        }
        if (
          createdSession
          && normalizedSessionHistory?.length
          && typeof sessions.saveSessionSeedTranscript === "function"
        ) {
          await sessions.saveSessionSeedTranscript(
            attachedSessionId,
            sessionSeedMessages(normalizedSessionHistory),
            Date.now()
          );
        }
        const handle = executor.execute(runRequest);
        if (attachedSessionId) {
          try {
            await sessions.appendSessionMessages(attachedSessionId, [{
              schemaVersion: 1,
              id: createId("message"),
              sessionId: attachedSessionId,
              role: "user",
              content: sessionUserContent,
              canonicalContent: canonicalUserContent,
              runId: handle.runId,
              createdAt: Date.now()
            }]);
            await sessionDocumentService?.prepareRun?.(
              attachedSessionId,
              {
                runId: handle.runId,
                userContent: sessionUserContent,
                documentAnchor: runRequest.metadata?.documentProjection?.anchor
              }
            );
          } catch (error) {
            await handle.abort("session-persistence-failed");
            await handle.completion;
            throw error;
          }
        }
        trackHandle(handle, attachedSessionId, runRequest);
        json(response, 202, {
          runId: handle.runId,
          attemptId: handle.attemptId,
          status: "accepted",
          model: resolved.model || null,
          policy: resolved.policy,
          ...(resolved.profile ? { interactionProfile: resolved.profile } : {})
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/sessions") {
        json(response, 200, {
          sessions: await sessions.listSessions({
            limit: url.searchParams.get("limit"),
            offset: url.searchParams.get("offset")
          })
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        const body = await readJson(request);
        const timestamp = Date.now();
        const resolved = body.interactionProfileId
          ? resolveRequest(body)
          : {
              model: resolveRequestedModel(body.model),
              policy: normalizePolicy(body.policy),
              metadata: body.metadata && typeof body.metadata === "object"
                ? { ...body.metadata }
                : {}
            };
        const session = {
          id: createId("session"),
          status: "active",
          title: String(body.title || ""),
          projectId: body.projectId ? String(body.projectId) : undefined,
          model: resolved.model || undefined,
          policy: resolved.policy,
          metadata: resolved.metadata,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        await sessions.createSession(session);
        json(response, 201, {
          session,
          ...(resolved.profile ? { interactionProfile: resolved.profile } : {})
        });
        return;
      }

      const sendMessageSessionId = matchSessionPath(url.pathname, "/messages");
      if (request.method === "POST" && sendMessageSessionId) {
        const session = await sessions.getSession(sendMessageSessionId);
        if (!session) {
          json(response, 404, { error: "Session not found" });
          return;
        }
        if (session.status !== "active") {
          json(response, 409, { error: `Session is not active: ${session.status}` });
          return;
        }
        if (sessionHandles.has(sendMessageSessionId)) {
          json(response, 409, { error: "Session already has an active Run" });
          return;
        }
        await reconcileSessionProjections();
        const body = await readJson(request);
        const canonicalContent = normalizeMessageContent(body.content, "user");
        const content = messageContentText(canonicalContent);
        if (!content.trim()) {
          json(response, 400, { error: "Message content is required" });
          return;
        }
        const history = await sessions.getSessionTranscript(sendMessageSessionId);
        const projectionFailure = Array.from(projectionFailures.entries())
          .find(([runId]) => history.some((message) => message.runId === runId));
        if (projectionFailure) {
          throw projectionFailure[1];
        }
        const runRequest = {
          messages: [
            ...history.map((message) => ({
              role: message.role,
              content: message.content,
              ...(message.reasoningContent
                ? { reasoningContent: message.reasoningContent }
                : {}),
              ...(Array.isArray(message.toolCalls)
                ? { toolCalls: message.toolCalls }
                : {}),
              ...(message.toolCallId
                ? { toolCallId: message.toolCallId }
                : {})
            })),
            { role: "user", content: canonicalContent }
          ],
          title: session.title,
          sessionId: session.id,
          projectId: session.projectId,
          model: session.model,
          modelOptions: normalizeModelOptions(body.modelOptions),
          policy: session.policy,
          metadata: {
            ...session.metadata,
            source: "session-message"
          },
          maxTurns: body.maxTurns,
          timeoutMs: body.timeoutMs
        };
        const handle = executor.execute(runRequest);
        let message;
        try {
          [message] = await sessions.appendSessionMessages(session.id, [{
            schemaVersion: 1,
            id: createId("message"),
            sessionId: session.id,
            role: "user",
            content,
            canonicalContent,
            runId: handle.runId,
            createdAt: Date.now()
          }]);
          await sessionDocumentService?.prepareRun?.(
            session.id,
            {
              runId: handle.runId,
              userContent: content,
              documentAnchor: runRequest.metadata?.documentProjection?.anchor
            }
          );
        } catch (error) {
          await handle.abort("session-persistence-failed");
          await handle.completion;
          throw error;
        }
        trackHandle(handle, session.id, runRequest);
        json(response, 202, {
          sessionId: session.id,
          message,
          runId: handle.runId,
          attemptId: handle.attemptId,
          status: "accepted"
        });
        return;
      }

      const forkSessionId = matchSessionPath(url.pathname, "/fork");
      if (request.method === "POST" && forkSessionId) {
        if (sessionHandles.has(forkSessionId)) {
          json(response, 409, { error: "Cannot fork a Session with an active Run" });
          return;
        }
        await reconcileSessionProjections();
        const body = await readJson(request);
        const result = await sessions.forkSession(forkSessionId, {
          id: String(body.id || createId("session")),
          title: body.title,
          createdAt: Date.now(),
          createId
        });
        json(response, 201, result);
        return;
      }

      const canonicalTranscriptSessionId = matchSessionPath(url.pathname, "/transcript");
      const sessionArtifactsId = matchSessionPath(url.pathname, "/artifacts");
      if (request.method === "GET" && sessionArtifactsId) {
        if (typeof runs.listSessionArtifacts !== "function") {
          json(response, 501, { error: "Runtime artifact store is unavailable" });
          return;
        }
        const session = await sessions.getSession(sessionArtifactsId);
        if (!session) {
          json(response, 404, { error: "Session not found" });
          return;
        }
        json(response, 200, runs.listSessionArtifacts(sessionArtifactsId));
        return;
      }
      const transcriptSessionId =
        canonicalTranscriptSessionId
        || matchSessionPath(url.pathname, "/messages");
      if (request.method === "GET" && transcriptSessionId) {
        const session = await sessions.getSession(transcriptSessionId);
        if (!session) {
          json(response, 404, { error: "Session not found" });
          return;
        }
        await reconcileSessionProjections();
        const after = Math.max(0, Number(url.searchParams.get("after") || 0) || 0);
        json(response, 200, {
          sessionId: transcriptSessionId,
          messages: canonicalTranscriptSessionId
            ? await sessions.getSessionTranscript(transcriptSessionId, after)
            : await sessions.getSessionMessages(transcriptSessionId, after)
        });
        return;
      }

      const sessionId = matchSessionPath(url.pathname);
      const activeRunSessionId = matchSessionPath(
        url.pathname,
        "/active-run"
      );
      if (request.method === "GET" && activeRunSessionId) {
        const handle = sessionHandles.get(activeRunSessionId);
        const run = handle ? await runs.get(handle.runId) : null;
        json(response, 200, {
          sessionId: activeRunSessionId,
          activeRun: handle
            ? {
                runId: handle.runId,
                attemptId: handle.attemptId,
                status: run?.status || "running"
              }
            : null
        });
        return;
      }
      if (request.method === "GET" && sessionId) {
        const session = await sessions.getSession(sessionId);
        if (!session) {
          json(response, 404, { error: "Session not found" });
          return;
        }
        json(response, 200, { session });
        return;
      }

      const resumeRunId = matchRunPath(url.pathname, "/resume");
      if (request.method === "POST" && resumeRunId) {
        if (handles.has(resumeRunId)) {
          json(response, 409, { error: "Run already has a live Runtime owner" });
          return;
        }
        const body = await readJson(request);
        const existingRun = await runs.get(resumeRunId);
        if (existingRun?.sessionId && sessionHandles.has(existingRun.sessionId)) {
          json(response, 409, { error: "Session already has an active Run" });
          return;
        }
        const handle = await executor.resume(resumeRunId, {
          ...body,
          modelOptions: normalizeModelOptions(body.modelOptions)
        });
        trackHandle(handle, existingRun?.sessionId, {
          sessionId: existingRun?.sessionId,
          projectId: existingRun?.projectId,
          model: existingRun?.model,
          policy: existingRun?.policy,
          metadata: {
            resumed: true
          }
        });
        json(response, 202, {
          runId: handle.runId,
          attemptId: handle.attemptId,
          status: "accepted"
        });
        return;
      }

      const projectionStreamRunId = matchRunPath(
        url.pathname,
        "/projection/stream"
      );
      if (request.method === "GET" && projectionStreamRunId) {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-zion-stream-mode": "projection"
        });
        let closed = false;
        request.on("close", () => {
          closed = true;
        });
        let cursor = Math.max(
          0,
          Number(
            url.searchParams.get("after")
            || request.headers["last-event-id"]
            || 0
          ) || 0
        );
        const projector = createRunEventProjector(
          runProjectionOptions(url)
        );
        while (!closed) {
          const events = await runs.getEvents(projectionStreamRunId, cursor);
          for (const event of events) {
            cursor = event.sequence;
            for (const projected of projector.push(event)) {
              if (!await writeSseEvent(response, projected)) return;
            }
          }
          for (const projected of projector.flushDue()) {
            if (!await writeSseEvent(response, projected)) return;
          }
          const run = await runs.get(projectionStreamRunId);
          if (!run) {
            response.write(`event: error\ndata: ${JSON.stringify({ error: "Run not found" })}\n\n`);
            response.end();
            return;
          }
          if (TERMINAL_STATUSES.has(run.status) && events.length === 0) {
            for (const projected of projector.flush()) {
              if (!await writeSseEvent(response, projected)) return;
            }
            response.end();
            return;
          }
          await delay(pollIntervalMs);
        }
        return;
      }

      const projectionRunId = matchRunPath(url.pathname, "/projection");
      if (request.method === "GET" && projectionRunId) {
        const after = Math.max(
          0,
          Number(
            url.searchParams.get("after")
            || request.headers["last-event-id"]
            || 0
          ) || 0
        );
        const run = await runs.get(projectionRunId);
        if (!run) {
          json(response, 404, { error: "Run not found" });
          return;
        }
        const sourceEvents = await runs.getEvents(projectionRunId, after);
        json(response, 200, {
          runId: projectionRunId,
          events: projectRunEvents(
            sourceEvents,
            runProjectionOptions(url)
          ),
          sourceCursor: Number(sourceEvents.at(-1)?.sequence || after)
        });
        return;
      }

      const runEventPath = matchRunEventPath(url.pathname);
      if (request.method === "GET" && runEventPath) {
        const run = await runs.get(runEventPath.runId);
        if (!run) {
          json(response, 404, { error: "Run not found" });
          return;
        }
        const event = typeof runs.getEvent === "function"
          ? await runs.getEvent(runEventPath.runId, runEventPath.sequence)
          : (await runs.getEvents(
              runEventPath.runId,
              Math.max(0, runEventPath.sequence - 1)
            )).find((item) => item.sequence === runEventPath.sequence);
        if (!event) {
          json(response, 404, { error: "Run event not found" });
          return;
        }
        json(response, 200, { event });
        return;
      }

      const streamRunId = matchRunPath(url.pathname, "/events/stream");
      if (request.method === "GET" && streamRunId) {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive"
        });
        let closed = false;
        request.on("close", () => {
          closed = true;
        });
        let cursor = Math.max(
          0,
          Number(
            url.searchParams.get("after")
            || request.headers["last-event-id"]
            || 0
          ) || 0
        );
        while (!closed) {
          const events = await runs.getEvents(streamRunId, cursor);
          for (const event of events) {
            cursor = event.sequence;
            if (!await writeSseEvent(response, event)) return;
          }
          const run = await runs.get(streamRunId);
          if (!run) {
            response.write(`event: error\ndata: ${JSON.stringify({ error: "Run not found" })}\n\n`);
            response.end();
            return;
          }
          if (TERMINAL_STATUSES.has(run.status) && events.length === 0) {
            response.end();
            return;
          }
          await delay(pollIntervalMs);
        }
        return;
      }

      const eventsRunId = matchRunPath(url.pathname, "/events");
      if (request.method === "GET" && eventsRunId) {
        const after = Math.max(0, Number(url.searchParams.get("after") || 0) || 0);
        const run = await runs.get(eventsRunId);
        if (!run) {
          json(response, 404, { error: "Run not found" });
          return;
        }
        json(response, 200, {
          runId: eventsRunId,
          events: await runs.getEvents(eventsRunId, after)
        });
        return;
      }

      const transcriptRunId = matchRunPath(url.pathname, "/transcript");
      if (request.method === "GET" && transcriptRunId) {
        const run = await runs.get(transcriptRunId);
        if (!run) {
          json(response, 404, { error: "Run not found" });
          return;
        }
        json(response, 200, {
          runId: transcriptRunId,
          messages: await runs.getTranscript(transcriptRunId)
        });
        return;
      }

      const artifactsRunId = matchRunPath(url.pathname, "/artifacts");
      if (request.method === "GET" && artifactsRunId) {
        const run = await runs.get(artifactsRunId);
        if (!run) {
          json(response, 404, { error: "Run not found" });
          return;
        }
        if (typeof runs.listRunArtifacts !== "function") {
          json(response, 501, { error: "Runtime artifact store is unavailable" });
          return;
        }
        json(response, 200, runs.listRunArtifacts(artifactsRunId));
        return;
      }

      const abortRunId = matchRunPath(url.pathname, "/abort");
      if (request.method === "POST" && abortRunId) {
        const handle = handles.get(abortRunId);
        if (!handle) {
          const run = await runs.get(abortRunId);
          json(response, run ? 409 : 404, {
            error: run ? `Run is not active: ${run.status}` : "Run not found"
          });
          return;
        }
        const body = await readJson(request);
        await handle.abort(String(body.reason || "user"));
        json(response, 202, { ok: true, runId: abortRunId });
        return;
      }

      const runId = matchRunPath(url.pathname);
      if (request.method === "GET" && runId) {
        const run = await runs.get(runId);
        if (!run) {
          json(response, 404, { error: "Run not found" });
          return;
        }
        json(response, 200, { run });
        return;
      }

      json(response, 404, { error: "Not found" });
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      json(response, Number(error?.statusCode || 500), {
        error: error?.message || String(error)
      });
    }
  });
  const normalizedUpgradeHandlers = (Array.isArray(upgradeHandlers)
    ? upgradeHandlers
    : []
  ).filter((handler) => typeof handler === "function");
  if (normalizedUpgradeHandlers.length) {
    server.on("upgrade", (request, socket, head) => {
      void (async () => {
        for (const handler of normalizedUpgradeHandlers) {
          if (await handler(request, socket, head)) return;
        }
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
      })().catch(() => {
        socket.destroy();
      });
    });
  }

  return {
    async start() {
      if (server.listening) return this.address();
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      return this.address();
    },
    address() {
      const address = server.address();
      if (!address || typeof address === "string") return null;
      return {
        host: address.address,
        port: address.port,
        url: `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`
      };
    },
    async close() {
      const activeHandles = Array.from(handles.values());
      for (const handle of activeHandles) {
        await handle.abort("runtime-shutdown");
      }
      await Promise.allSettled(activeHandles.map((handle) => handle.completion));
      await new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections?.();
      });
    }
  };
}
