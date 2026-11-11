import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { CancellationController, normalizeModelProviderMetadata, dispatchRunHook } from "../../../packages/runtime/dist/index.js";
import { parseByteSize, requestBodyLimitError } from "../../../packages/node-protocol/src/index.mjs";
import { DEFAULT_INTERACTION_PROFILE_ID, resolveInteractionRequest } from "./interaction-profile-store.mjs";
import {
  createRunEventProjector,
  projectRunEvents
} from "./run-event-projection.mjs";
import { createRunLiveHub } from "./run-live-hub.mjs";
import { createMobileHttpHandler } from "./mobile-http-handler.mjs";
import {
  deriveSessionTitleFromContent,
  isPlaceholderSessionTitle
} from "./session-title.mjs";

// A waiting attempt has no live owner/stream but the Run remains resumable.
const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted", "interrupted", "waiting"]);
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const LIVE_RUN_REPLAY_RETENTION_MS = 30_000;
const POLICY_PRESETS = new Set(["read-only", "workspace-write", "trusted-automation"]);
const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,199}$/i;
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
  "pluginsManage",
  "terminalManage",
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

function errorPayload(error) {
  const payload = { error: error?.message || String(error) };
  if (error?.code) payload.code = String(error.code);
  if (error?.failureCode) payload.failureCode = String(error.failureCode);
  if (typeof error?.retryable === "boolean") payload.retryable = error.retryable;
  if (Number.isSafeInteger(error?.limitBytes)) payload.limitBytes = error.limitBytes;
  if (error?.limit) payload.limit = String(error.limit);
  if (Array.isArray(error?.hints)) payload.hints = error.hints.map(String);
  return payload;
}

async function readJson(request, maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequestBytes) {
      throw requestBodyLimitError("Request body", maxRequestBytes);
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

function normalizeExecutionTarget(value) {
  if (value == null) return undefined;
  const nodeId = String(value?.nodeId || "").trim();
  if (!NODE_ID_PATTERN.test(nodeId)) {
    const error = new Error("target.nodeId is invalid");
    error.statusCode = 422;
    throw error;
  }
  return { nodeId };
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
        ...(normalizeModelProviderMetadata(call?.providerMetadata)
          ? { providerMetadata: normalizeModelProviderMetadata(call.providerMetadata) } : {}),
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
      ...(role === "assistant" && normalizeModelProviderMetadata(message?.providerMetadata)
        ? { providerMetadata: normalizeModelProviderMetadata(message.providerMetadata) } : {}),
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
    ...(tool?.execution && typeof tool.execution === "object"
      ? { execution: cloneObject(tool.execution) }
      : {}),
    ...(tool?.pluginId ? { pluginId: String(tool.pluginId) } : {}),
    ...(tool?.risk ? { risk: String(tool.risk) } : {}),
    modelInjectable: tool?.modelInjectable !== false,
    ...(tool?.unavailableReason
      ? { unavailableReason: String(tool.unavailableReason) }
      : {}),
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

function assertLocalBinding(host, allowRemote, accessControl) {
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") return;
  if (allowRemote && accessControl?.authorizeRuntimeRequest) return;
  throw new Error(
    allowRemote
      ? "Remote Runtime binding requires Access Control"
      : "Runtime Host has no remote authentication yet and may only bind to loopback"
  );
}

function allowBrowserOrigin(request, response, accessControl) {
  if (accessControl?.applyCors) {
    return accessControl.applyCors(request, response);
  }
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
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "content-type, authorization, last-event-id, x-api-key, api-key, "
    + "anthropic-version, anthropic-beta, x-zion-workbench-protocol"
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
  modelSelection = null,
  resolveModel,
  importModelProfile,
  deleteModelProfile,
  interactionProfiles,
  capabilityTools = [],
  accessControl = null,
  nodeHttpHandler,
  publicHttpHandlers = [],
  serviceHttpHandlers = [],
  upgradeHandlers = [],
  sessionEventStore = null,
  sessionDocumentService = null,
  runtimeHealth = null,
  runPostProcessors = [],
  runControllers = [],
  waitingTerminalOutbox = () => [],
  pluginCommands = null,
  pluginCommandRequiresSession = () => true,
  onPostProcessorError = () => {},
  validateRunRequest = null,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES
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
  assertLocalBinding(host, allowRemote, accessControl);
  const requestBodyLimit = parseByteSize(maxRequestBytes, {
    label: "Runtime request body limit"
  });
  const defaultModel = modelRefFromProfile(serviceInfo.modelProfile);
  const resolveRequestedModel = async (requested, principal) => {
    if (!requested && modelSelection) return modelSelection.defaultModel(principal);
    if (typeof resolveModel === "function") return resolveModel(requested || null, principal);
    return requested || defaultModel || null;
  };
  const readRequestJson = (request) => readJson(request, requestBodyLimit);
  const resolveRequest = async (body, principal) => {
    if (modelSelection) return modelSelection.resolveRequest(body, principal);
    const resolved = resolveInteractionRequest({
      body, interactionProfiles, fallbackModel: defaultModel
    });
    return { ...resolved, model: await resolveRequestedModel(resolved.model, principal) };
  };
  const admitRun = async (principal, runRequest) => {
    let admitted;
    if (!accessControl?.authorizeRunRequest) {
      // Principal is reserved even on the legacy admission surface.
      delete runRequest.principal;
      admitted = runRequest;
    } else {
      const profileId = runRequest.interactionProfileId
        || runRequest.metadata?.interactionProfileId || DEFAULT_INTERACTION_PROFILE_ID;
      const profile = interactionProfiles?.get?.(profileId);
      if (!profile) throw Object.assign(new Error("An administrator-configured interaction profile is required"), {
        statusCode: 403
      });
      admitted = await accessControl.authorizeRunRequest(principal, {
        ...runRequest,
        interactionProfileId: profile.id,
        metadata: { ...runRequest.metadata, interactionProfileId: profile.id }
      }, profile.policy);
    }
    await validateRunRequest?.(admitted);
    return admitted;
  };
  const authorizeExistingRun = async (principal, run, options) => {
    await accessControl?.authorizeExistingRun?.(principal, run, options);
  };
  const listCapabilityTools = () => {
    const source = typeof capabilityTools === "function"
      ? capabilityTools()
      : capabilityTools;
    return Array.isArray(source)
      ? source.map(normalizeCapabilityTool)
      : [];
  };

  const handles = new Map();
  let closing = false;
  const liveRuns = new Map();
  const liveRunRetirements = new Map();
  const sessionHandles = new Map();
  const sessionFinalizations = new Map();
  const runFinalizations = new Map();
  const sessionAdmissions = new Set();
  const reserveSessionAdmission = async (sessionId, resumingRunId) => {
    if (!sessionId) return null;
    const previous = sessionHandles.get(sessionId);
    if (previous && !sessionAdmissions.has(sessionId)) {
      const record = await runs.get(previous.runId);
      if (record && TERMINAL_STATUSES.has(record.status)) {
        await sessionFinalizations.get(sessionId);
      }
    }
    if (sessionAdmissions.has(sessionId) || sessionHandles.has(sessionId)) {
      const error = new Error("Session already has an active Run");
      error.statusCode = 409;
      throw error;
    }
    sessionAdmissions.add(sessionId);
    try {
      const persisted = await runs.getActiveRunForSession?.(sessionId);
      if (persisted?.status === "waiting" && persisted.id !== resumingRunId) {
        throw Object.assign(new Error("Session has a waiting Run; resume it with its waitId"), { statusCode: 409 });
      }
      return () => sessionAdmissions.delete(sessionId);
    } catch (error) {
      sessionAdmissions.delete(sessionId);
      throw error;
    }
  };
  const projectionFailures = new Map();
  const presentationForSession = async (sessionId) => {
    if (sessionEventStore?.readSessionMeta) {
      return await sessionEventStore.readSessionMeta(sessionId);
    }
    const record = await sessionEventStore?.readSession?.(sessionId);
    return record?.meta && typeof record.meta === "object" ? record.meta : null;
  };
  const presentSession = async (session) => {
    if (!session?.id) return session;
    const presentation = await presentationForSession(session.id);
    return presentation?.title
      && !isPlaceholderSessionTitle(presentation.title, session.id, presentation)
      ? { ...session, title: String(presentation.title) }
      : session;
  };
  const activeRunForSession = async (sessionId) => {
    const handle = sessionHandles.get(sessionId);
    if (handle) {
      const run = await runs.get(handle.runId);
      if (run && TERMINAL_STATUSES.has(run.status)) return null;
      return {
        runId: handle.runId,
        attemptId: handle.attemptId,
        status: run?.status || "running"
      };
    }
    const run = await runs.getActiveRunForSession?.(sessionId);
    return run
      ? {
          runId: run.id,
          attemptId: run.attemptId,
          status: run.status
        }
      : null;
  };
  const mobileHttpHandler = createMobileHttpHandler({
    sessions,
    activeRunForSession,
    presentationForSession
  });
  const publishSessionEvent = async (type, {
    sessionId = "",
    runId = "",
    attemptId = "",
    sourceClientId = "",
    data = {}
  } = {}) => {
    if (!sessionEventStore?.appendEvent) return null;
    try {
      return await sessionEventStore.appendEvent(type, {
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
  const maybeAutoTitleSession = async (session, {
    history = [],
    content = "",
    timestamp = Date.now()
  } = {}) => {
    if (
      !session?.id
      || typeof sessions.updateSession !== "function"
      || history.some((message) => message?.role === "user")
      || !isPlaceholderSessionTitle(session.title, session.id, session.metadata)
    ) {
      return session;
    }
    let presentation = null;
    try {
      presentation = await presentationForSession(session.id);
      if (
        presentation?.title
        && !isPlaceholderSessionTitle(presentation.title, session.id, presentation)
      ) {
        return {
          ...session,
          title: String(presentation.title)
        };
      }
    } catch (error) {
      onPostProcessorError(error, {
        processorId: "runtime.session-auto-title-presentation",
        sessionId: session.id
      });
    }
    const title = deriveSessionTitleFromContent(content, 48);
    if (!title) return session;
    const metadata = {
      ...(session.metadata || {}),
      titleAuto: true,
      titleSource: "first-user-message"
    };
    let updated = session;
    try {
      updated = await sessions.updateSession(session.id, {
        title,
        metadata
      }, timestamp);
    } catch (error) {
      onPostProcessorError(error, {
        processorId: "runtime.session-auto-title",
        sessionId: session.id
      });
      return session;
    }
    try {
      if (
        sessionEventStore?.updateSession
        && (!presentation?.title || isPlaceholderSessionTitle(
          presentation.title,
          session.id,
          presentation
        ))
      ) {
        await sessionEventStore.updateSession(session.id, {
          title,
          meta: {
            ...(presentation && typeof presentation === "object"
              ? presentation
              : {}),
            id: session.id,
            title,
            titleAuto: true,
            updatedAt: timestamp
          },
          reason: "runtime-auto-title"
        });
      } else {
        await publishSessionEvent("session.updated", {
          sessionId: session.id,
          data: {
            fields: ["title"],
            reason: "auto-title"
          }
        });
      }
    } catch (error) {
      onPostProcessorError(error, {
        processorId: "runtime.session-auto-title-presentation-update",
        sessionId: session.id
      });
      await publishSessionEvent("session.updated", {
        sessionId: session.id,
        data: {
          fields: ["title"],
          reason: "auto-title"
        }
      });
    }
    return updated || {
      ...session,
      title,
      metadata
    };
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
    const runId = result.runId || handle.runId;
    let storedRun = null;
    try {
      storedRun = await runs.get(runId);
    } catch {}
    const metadata = {
      ...(storedRun?.metadata && typeof storedRun.metadata === "object"
        ? storedRun.metadata
        : {}),
      ...(runRequest?.metadata && typeof runRequest.metadata === "object"
        ? runRequest.metadata
        : {})
    };
    const requestPrincipal = runRequest?.principal;
    const storedPrincipal = storedRun?.principal;
    const postProcessPrincipal = requestPrincipal?.version === 1 && requestPrincipal?.spaceId
      ? requestPrincipal
      : storedPrincipal;
    const postProcessRequest = {
      ...(storedRun || {}),
      ...(runRequest || {}),
      id: runId,
      runId,
      metadata,
      policy: runRequest?.policy || storedRun?.policy || null,
      principal: postProcessPrincipal
    };
    const transcript = Array.isArray(messages) && messages.length
      ? messages
      : [
          ...(Array.isArray(runRequest?.messages) ? runRequest.messages : []),
          ...(String(result.output || "").trim()
            ? [{ role: "assistant", content: result.output }]
            : [])
        ];
    const context = Object.freeze({
      runId,
      attemptId: handle.attemptId,
      sessionId: String(sessionId || runRequest?.sessionId || storedRun?.sessionId || ""),
      projectId: String(runRequest?.projectId || storedRun?.projectId || ""),
      title: String(runRequest?.title || storedRun?.title || ""),
      status: result.status,
      output: String(result.output || ""),
      usage: result.usage || {},
      messages: transcript.map((message) => ({
        role: String(message?.role || ""),
        content: messageContentText(message?.content),
        ...(message?.providerMetadata ? { providerMetadata: message.providerMetadata } : {}),
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
      metadata,
      model: runRequest?.model || storedRun?.model || null,
      policy: postProcessRequest.policy,
      principal: postProcessPrincipal,
      request: postProcessRequest
    });
    for (const processor of processors) {
      try {
        await accessControl?.authorizeRunExecution?.(postProcessRequest);
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
  const trackHandle = async (handle, sessionId, runRequest = {}, { initialEvents = [], publishStarted = true } = {}) => {
    const live = createRunLiveHub();
    for (const event of initialEvents) live.publish(event);
    globalThis.clearTimeout(liveRunRetirements.get(handle.runId));
    liveRunRetirements.delete(handle.runId);
    handles.set(handle.runId, handle);
    liveRuns.set(handle.runId, live);
    if (sessionId) sessionHandles.set(sessionId, handle);
    let completedAssistantContent;
    let terminalSessionEventPublished = false;
    if (sessionId && publishStarted) {
      await publishSessionEvent("run.started", {
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
      live.publish(event);
      if (event.type === "message.completed") {
        completedAssistantContent = String(event.data?.content || "");
      }
      if (
        sessionId
        && ["run.completed", "run.failed", "run.aborted", "run.waiting"].includes(event.type)
      ) {
        terminalSessionEventPublished = true;
        await publishSessionEvent(event.type, {
          sessionId,
          runId: event.runId || handle.runId,
          attemptId: event.attemptId || handle.attemptId,
          sourceClientId: String(
            runRequest?.metadata?.workbenchClientId || ""
          ),
          data: {
            status: event.type.slice("run.".length),
            reason: event.data?.reason || "",
            error: event.data?.error || ""
          }
        });
      }
      if (!sessionId || !sessionDocumentService?.applyRunEvent) return;
      try {
        await sessionDocumentService.applyRunEvent(
          sessionId,
          event,
          {
            appendUserPrompt:
              runRequest?.metadata?.documentProjection?.appendUserPrompt === true,
            includeReasoning:
              runRequest?.metadata?.documentProjection?.includeReasoning !== false
          }
        );
      } catch (error) {
        onPostProcessorError(error, {
          processorId: "runtime.collaboration-projection",
          runId: handle.runId,
          sessionId
        });
      }
    }).catch((error) => {
      onPostProcessorError(error, {
        processorId: "runtime.live-events",
        runId: handle.runId,
        sessionId
      });
    });
    void documentProjection;
    const finalization = handle.completion
      .then(async (result) => {
        await documentProjection;
        let projectedMessages = null;
        if (sessionId && result.status === "completed") {
          if (completedAssistantContent === undefined) {
            const transcript = await runs.getTranscript(result.runId);
            const finalAssistant = transcript.findLast((message) => message.role === "assistant");
            if (finalAssistant) completedAssistantContent = String(finalAssistant.content || "");
          }
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
          await sessionDocumentService?.reconcileTranscript?.(
            sessionId,
            await sessions.getSessionMessages(sessionId)
          );
        }
        if (sessionId && !terminalSessionEventPublished) {
          await publishSessionEvent(`run.${result.status}`, {
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
        // Yield the Session only after transcript/document persistence completes.
        if (sessionId && sessionHandles.get(sessionId) === handle) sessionHandles.delete(sessionId);
        if (result.status === "waiting") return;
        const events = await runs.getEvents(handle.runId);
        const publishHostEvent = async (event) => {
          await runs.append(event);
          live.publish(event);
        };
        await publishHostEvent({
          schemaVersion: 1, eventId: createId("event"), runId: handle.runId,
          attemptId: handle.attemptId, sequence: (events.at(-1)?.sequence || 0) + 1,
          type: "run.finalized", timestamp: Date.now(),
          data: { status: result.status, sessionId: sessionId || null }
        });
        const controllers = typeof runControllers === "function" ? runControllers() : runControllers;
        for (const controller of controllers || []) {
          let decision;
          try {
            decision = await dispatchRunHook(controller, {
              schemaVersion: 1, stage: "afterRun", controllerId: controller.id,
              idempotencyKey: `${handle.runId}:${handle.attemptId}:afterRun:${controller.id}`,
              runId: handle.runId, attemptId: handle.attemptId, request: runRequest, result,
              messages: [], signal: new CancellationController().signal
            }, async (type, data) => {
              const latest = await runs.getEvents(handle.runId);
              await publishHostEvent({
                schemaVersion: 1, eventId: createId("event"), runId: handle.runId,
                attemptId: handle.attemptId, sequence: (latest.at(-1)?.sequence || 0) + 1,
                type, timestamp: Date.now(), data
              });
            });
          } catch (error) {
            // A failed afterRun policy prevents continuation. It cannot undo a
            // completed Run or turn a persisted transcript into a projection failure.
            try { await controller.continuationFailed?.({ request: runRequest, error }); }
            catch {}
            try { onPostProcessorError(error, { processorId: controller.id, runId: handle.runId, sessionId }); }
            catch {}
            break;
          }
          if (decision.action !== "continue-run") continue;
          const next = decision;
          if (closing) {
            await controller.continuationFailed?.({ request: runRequest, error: new Error("Runtime is shutting down") });
            break;
          }
          let release;
          let nextHandle;
          try {
            release = await reserveSessionAdmission(sessionId);
            const session = await sessions.getSession(sessionId);
            if (!session || session.status !== "active") throw new Error("Continuation Session is unavailable");
            await accessControl?.authorizeRunExecution?.(runRequest);
            const history = await sessions.getSessionTranscript(sessionId);
            const continuationText = String(next.instruction || "继续当前已授权的持续工作；先检查已有结果和仍在运行的工具。");
            const nextRequest = {
              ...runRequest,
              prompt: undefined,
              messages: [
                ...(runRequest.messages || []).filter((message) => message.role === "system"),
                ...history.map(({ role, content, reasoningContent, providerMetadata, toolCalls, toolCallId, toolResultStatus }) => ({
                  role, content, ...(toolCalls ? { toolCalls } : {}),
                  ...(reasoningContent ? { reasoningContent } : {}),
                  ...(providerMetadata ? { providerMetadata } : {}),
                  ...(toolCallId ? { toolCallId } : {}),
                  ...(toolResultStatus ? { toolResultStatus } : {})
                })),
                { role: "user", content: continuationText }
              ],
              metadata: { ...runRequest.metadata, ...next.metadata, workbenchClientId: "" }
            };
            await validateRunRequest?.(nextRequest);
            nextHandle = executor.execute(nextRequest);
            await sessions.appendSessionMessages(sessionId, [{
              schemaVersion: 1, id: createId("message"), sessionId,
              role: "user", content: continuationText, runId: nextHandle.runId,
              createdAt: Date.now()
            }]);
            await sessionDocumentService?.prepareRun?.(sessionId, {
              runId: nextHandle.runId,
              userContent: continuationText,
              forceNewUser: true
            });
            await trackHandle(nextHandle, sessionId, nextRequest);
          } catch (error) {
            if (nextHandle) {
              await nextHandle.abort("continuation-admission-failed");
              await nextHandle.completion;
            }
            await controller.continuationFailed?.({ request: runRequest, error, runId: nextHandle?.runId });
            throw error;
          } finally {
            release?.();
          }
          break;
        }
      })
      .catch(async (error) => {
        projectionFailures.set(handle.runId, error);
        if (sessionId) {
          await publishSessionEvent("run.failed", {
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
        live.close();
        if (handles.get(handle.runId) === handle) handles.delete(handle.runId);
        if (liveRuns.get(handle.runId) === live) {
          const retirement = globalThis.setTimeout(() => {
            liveRunRetirements.delete(handle.runId);
            if (liveRuns.get(handle.runId) === live) {
              liveRuns.delete(handle.runId);
            }
          }, LIVE_RUN_REPLAY_RETENTION_MS);
          retirement.unref?.();
          liveRunRetirements.set(handle.runId, retirement);
        }
        if (sessionId && sessionHandles.get(sessionId) === handle) {
          sessionHandles.delete(sessionId);
        }
        if (sessionId && sessionFinalizations.get(sessionId) === finalization) {
          sessionFinalizations.delete(sessionId);
        }
        if (runFinalizations.get(handle.runId) === finalization) runFinalizations.delete(handle.runId);
      });
    runFinalizations.set(handle.runId, finalization);
    if (sessionId) sessionFinalizations.set(sessionId, finalization);
    void finalization.catch((error) => {
      try {
        onPostProcessorError(error, { processorId: "runtime.finalization", runId: handle.runId, sessionId });
      } catch { /* Observation cannot create another unhandled rejection. */ }
    });
  };
  const handleRequest = async (request, response) => {
    let releaseAdmission;
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || host}`);
      if (!allowBrowserOrigin(request, response, accessControl)) {
        json(response, 403, { error: "Browser origin is not allowed" });
        return;
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }

      for (const handler of publicHttpHandlers) {
        if (await handler(request, response, url)) return;
      }
      if (
        nodeHttpHandler
        && await nodeHttpHandler(request, response, url)
      ) {
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        const principal = await accessControl?.authenticateRequest?.(request);
        if (accessControl && !await accessControl.hasScope?.(principal, "runtime.read")) {
          json(response, 200, {
            ok: true,
            service: "zion-runtime",
            authRequired: true,
            ...(accessControl.mode ? { authMode: accessControl.mode } : {})
          });
          return;
        }
        json(response, 200, {
          ok: true,
          service: "zion-runtime",
          authRequired: !!accessControl,
          ...serviceInfo
        });
        return;
      }

      if (accessControl) {
        request.zionPrincipal = await accessControl.authorizeRuntimeRequest(request);
      }
      const pluginCommandPath = url.pathname.match(/^\/v1\/plugins\/([^/]+)\/commands$/);
      if (request.method === "POST" && pluginCommandPath && pluginCommands) {
        const body = await readRequestJson(request);
        const pluginId = decodeURIComponent(pluginCommandPath[1]);
        const requiresSession = body.action === "compact" || pluginCommandRequiresSession(pluginId) !== false;
        const sessionId = String(body.sessionId || "").trim();
        if (requiresSession && !sessionId) throw Object.assign(new Error("sessionId is required"), { statusCode: 400 });
        const session = sessionId ? await sessions.getSession(sessionId) : null;
        if (requiresSession && !session) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
        const readOnly = body.action === "status";
        if (!readOnly) await accessControl?.requireScope?.(request.zionPrincipal, "run.execute");
        let executionRequest = null;
        const commandCancellation = new CancellationController();
        const disconnected = () => {
          if (!response.writableEnded) commandCancellation.cancel("client-disconnected");
        };
        response.on("close", disconnected);
        try {
          // Model commands use the same admission/authorization as normal Runs.
          if (body.action === "compact") {
            releaseAdmission = await reserveSessionAdmission(sessionId);
            executionRequest = await admitRun(request.zionPrincipal, {
              sessionId, projectId: session.projectId, model: await resolveRequestedModel(session.model, request.zionPrincipal),
              policy: session.policy, metadata: session.metadata
            });
          }
          const result = await pluginCommands(pluginId, body, {
            sessionId,
            principal: request.zionPrincipal,
            origin: request.headers.origin,
            request: executionRequest,
            signal: commandCancellation.signal,
            tools: executionRequest ? listCapabilityTools().filter((tool) => executionRequest.policy.allowedTools.includes(tool.name)) : [],
            messages: body.action === "compact" ? await sessions.getSessionTranscript(sessionId) : undefined,
            abort: async (reason) => sessionHandles.get(sessionId)?.abort(reason),
            activeRunId: sessionHandles.get(sessionId)?.runId || null,
            invokeToolRun: async (operation) => {
              const profile = interactionProfiles?.get?.(DEFAULT_INTERACTION_PROFILE_ID);
              const commandRequest = await admitRun(request.zionPrincipal, {
                prompt: "Execute the installed plugin command",
                sessionId: sessionId || undefined, projectId: session?.projectId,
                policy: session?.policy || profile?.policy,
                metadata: { extensionInvocation: operation, interactionProfileId: profile?.id }
              });
              const handle = executor.execute(commandRequest);
              const subscription = commandCancellation.signal.onCancel((reason) => { void handle.abort(reason); });
              try {
                await trackHandle(handle, null, commandRequest);
                const result = await handle.completion;
                if (result.status !== "completed") throw Object.assign(
                  new Error(result.error || result.reason || "extension_command_failed"),
                  { statusCode: 422, code: "extension_command_failed", runId: handle.runId });
                return JSON.parse(result.output).result;
              } finally { subscription.dispose(); }
            },
            startRun: async ({ sourceRunId, instruction, metadata }) => {
              const release = await reserveSessionAdmission(sessionId);
              let handle;
              let admitted;
              try {
                const currentSession = await sessions.getSession(sessionId);
                if (currentSession?.status !== "active") throw Object.assign(new Error("Session is not active"), { statusCode: 409 });
                const previous = await runs.get(String(sourceRunId || ""));
                if (!previous || previous.sessionId !== sessionId) throw Object.assign(new Error("Source Run not found in this Session"), { statusCode: 404 });
                // This is a new Run under the current user's freshly admitted grant.
                await authorizeExistingRun(request.zionPrincipal, previous, { allowRevoked: true });
                const history = await sessions.getSessionTranscript(sessionId);
                const content = String(instruction || "").trim();
                if (!content) throw Object.assign(new Error("Continuation instruction is required"), { statusCode: 400 });
                const nextRequest = admitted = await admitRun(request.zionPrincipal, {
                  sessionId, projectId: currentSession.projectId,
                  model: await resolveRequestedModel(previous.model || currentSession.model, request.zionPrincipal),
                  modelOptions: previous.modelOptions, target: previous.target,
                  policy: previous.policy || currentSession.policy,
                  messages: [
                    ...(previous.messages || []).filter((message) => message.role === "system"),
                    ...history,
                    { role: "user", content }
                  ],
                  metadata: {
                    ...previous.metadata, ...metadata, workbenchClientId: "",
                    documentProjection: undefined
                  }
                });
                commandCancellation.signal.throwIfCancelled();
                handle = executor.execute(nextRequest);
                await sessions.appendSessionMessages(sessionId, [{
                  schemaVersion: 1, id: createId("message"), sessionId,
                  role: "user", content, runId: handle.runId, createdAt: Date.now()
                }]);
                await sessionDocumentService?.prepareRun?.(sessionId, {
                  runId: handle.runId, userContent: content, forceNewUser: true
                });
                await trackHandle(handle, sessionId, nextRequest);
                return { runId: handle.runId, attemptId: handle.attemptId, status: "accepted" };
              } catch (error) {
                if (handle) {
                  await handle.abort("continuation-admission-failed");
                  await handle.completion;
                  error.runId = handle.runId;
                } else if (admitted) await accessControl?.releaseRunPreview?.(admitted);
                throw error;
              } finally {
                release?.();
              }
            }
          });
          json(response, 200, { result });
        } finally {
          response.off("close", disconnected);
          if (executionRequest) await accessControl?.releaseRunPreview?.(executionRequest);
        }
        return;
      }
      if (await mobileHttpHandler(request, response, url)) return;
      for (const handler of serviceHttpHandlers) {
        if (await handler(request, response, url)) return;
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/runtime-health") {
        if (typeof runtimeHealth !== "function") {
          json(response, 501, { error: "Runtime health provider is unavailable" });
          return;
        }
        try {
          const health = await runtimeHealth();
          json(response, 200, {
            ok: health?.status !== "critical",
            service: "zion-runtime",
            ...(health && typeof health === "object" ? health : {})
          });
        } catch (error) {
          json(response, 200, {
            ok: false,
            service: "zion-runtime",
            status: "degraded",
            generatedAt: Date.now(),
            error: error?.message || String(error)
          });
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        const active = modelSelection ? await modelSelection.get(request.zionPrincipal,
          url.searchParams.get("interactionProfileId") || DEFAULT_INTERACTION_PROFILE_ID) : null;
        json(response, 200, {
          activeProfileId: active?.modelProfileId || serviceInfo.modelProfile?.id || null,
          ...(active ? { selectedProfileId: active.selectedProfileId } : {}),
          profiles: typeof modelProfiles === "function"
            ? await modelProfiles(request.zionPrincipal)
            : modelProfiles
        });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/v1/models/selection") {
        if (!modelSelection) {
          json(response, 501, { error: "Model selection is unavailable" });
          return;
        }
        const body = await readRequestJson(request);
        const selection = await modelSelection.set(request.zionPrincipal, body.profileId,
          body.interactionProfileId || DEFAULT_INTERACTION_PROFILE_ID);
        json(response, 200, { selection });
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
          todoLists: await runs.listTodoLists({
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
        const todoList = await runs.getTodoList(todoListOwnerId);
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
        const body = await readRequestJson(request);
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
        const body = await readRequestJson(request);
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

      if (request.method === "POST" && url.pathname === "/v1/runs/preview") {
        if (typeof executor.preview !== "function") {
          json(response, 501, { error: "Runtime request preview is unavailable" });
          return;
        }
        const body = await readRequestJson(request);
        const normalizedMessages = normalizeRunMessages(body.messages);
        const resolved = body.interactionProfileId
          ? await resolveRequest(body, request.zionPrincipal)
          : {
              model: await resolveRequestedModel(body.model, request.zionPrincipal),
              policy: normalizePolicy(body.policy),
              metadata: body.metadata && typeof body.metadata === "object"
                ? { ...body.metadata }
                : {}
            };
        const previewRequest = await admitRun(request.zionPrincipal, {
          ...body,
          target: normalizeExecutionTarget(body.target),
          ...(normalizedMessages ? { messages: normalizedMessages } : {}),
          ...(resolved.model ? { model: resolved.model } : {}),
          modelOptions: normalizeModelOptions(body.modelOptions),
          policy: resolved.policy,
          metadata: resolved.metadata
        });
        try {
          json(response, 200, {
            preview: await executor.preview(previewRequest)
          });
        } finally {
          await accessControl?.releaseRunPreview?.(previewRequest);
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/runs") {
        const receivedAt = Date.now();
        const body = await readRequestJson(request);
        if (
          body?.metadata?.source === "interactive-chat"
          && Number(body.metadata.workbenchProtocolVersion) !== 4
        ) {
          json(response, 426, {
            error: "Workbench realtime protocol is outdated; refresh all Workbench tabs"
          });
          return;
        }
        const normalizedMessages = normalizeRunMessages(body.messages);
        const normalizedSessionHistory = normalizeRunMessages(body.sessionHistory);
        const resolved = body.interactionProfileId
          ? await resolveRequest(body, request.zionPrincipal)
          : {
              model: await resolveRequestedModel(body.model, request.zionPrincipal),
              policy: normalizePolicy(body.policy),
              metadata: body.metadata && typeof body.metadata === "object"
                ? { ...body.metadata }
                : {}
            };
        const runRequest = await admitRun(request.zionPrincipal, {
          ...body,
          target: normalizeExecutionTarget(body.target),
          ...(normalizedMessages ? { messages: normalizedMessages } : {}),
          ...(resolved.model ? { model: resolved.model } : {}),
          modelOptions: normalizeModelOptions(body.modelOptions),
          policy: resolved.policy,
          metadata: resolved.metadata
        });
        runRequest.metadata = {
          ...runRequest.metadata,
          chatAdmission: { receivedAt, admissionMs: Date.now() - receivedAt }
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
          releaseAdmission = await reserveSessionAdmission(requestedSessionId);
          let session = await sessions.getSession(requestedSessionId);
          if (!session) {
            const timestamp = Date.now();
            session = {
              id: requestedSessionId,
              status: "active",
              title: String(body.title || resolved.metadata?.sessionTitle || ""),
              projectId: body.projectId ? String(body.projectId) : undefined,
              model: resolved.model || undefined,
              policy: runRequest.policy,
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
          if (
            !Array.isArray(runRequest.metadata?.skills?.enabled)
            && session.metadata?.skills
            && typeof session.metadata.skills === "object"
          ) {
            runRequest.metadata = {
              ...runRequest.metadata,
              skills: {
                ...session.metadata.skills,
                ...(runRequest.metadata?.skills || {})
              }
            };
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
        await trackHandle(handle, attachedSessionId, runRequest);
        response.setHeader("Server-Timing", `admission;dur=${runRequest.metadata.chatAdmission.admissionMs},prepare;dur=${Date.now() - receivedAt}`);
        json(response, 202, {
          runId: handle.runId,
          attemptId: handle.attemptId,
          status: "accepted",
          model: resolved.model || null,
          policy: runRequest.policy,
          ...(resolved.profile ? { interactionProfile: resolved.profile } : {})
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/sessions") {
        const records = await sessions.listSessions({
          limit: url.searchParams.get("limit"),
          offset: url.searchParams.get("offset")
        });
        json(response, 200, {
          sessions: await Promise.all(records.map(presentSession))
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        const body = await readRequestJson(request);
        const timestamp = Date.now();
        const explicitTitle = String(body.title || "").trim();
        const resolved = body.interactionProfileId
          ? await resolveRequest(body, request.zionPrincipal)
          : {
              model: await resolveRequestedModel(body.model, request.zionPrincipal),
              policy: normalizePolicy(body.policy),
              metadata: body.metadata && typeof body.metadata === "object"
                ? { ...body.metadata }
                : {}
            };
        const metadata = { ...(resolved.metadata || {}) };
        if (!Object.hasOwn(metadata, "titleAuto")) {
          metadata.titleAuto = !explicitTitle;
        }
        const session = {
          id: createId("session"),
          status: "active",
          title: explicitTitle,
          projectId: body.projectId ? String(body.projectId) : undefined,
          model: resolved.model || undefined,
          policy: resolved.policy,
          metadata,
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
        const body = await readRequestJson(request);
        const clientRequestId = String(body.clientRequestId || "").trim();
        if (clientRequestId.length > 200) {
          json(response, 400, { error: "clientRequestId exceeds 200 characters" });
          return;
        }
        if (clientRequestId && typeof sessions.getSessionMessageCommand === "function") {
          const existing = await sessions.getSessionMessageCommand(
            sendMessageSessionId,
            clientRequestId
          );
          if (existing?.status === "accepted" && existing.response) {
            await authorizeExistingRun(request.zionPrincipal, await runs.get(existing.response.runId));
            json(response, 202, {
              ...existing.response,
              clientRequestId,
              replayed: true
            });
            return;
          }
          if (existing) {
            json(response, 409, {
              error: "Message submission is already in progress",
              clientRequestId,
              status: existing.status
            });
            return;
          }
        }
        releaseAdmission = await reserveSessionAdmission(sendMessageSessionId);
        let session = await sessions.getSession(sendMessageSessionId);
        if (!session) {
          json(response, 404, { error: "Session not found" });
          return;
        }
        if (session.status !== "active") {
          json(response, 409, { error: `Session is not active: ${session.status}` });
          return;
        }
        await reconcileSessionProjections();
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
        session = await maybeAutoTitleSession(session, {
          history,
          content: canonicalContent,
          timestamp: Date.now()
        });
        const runRequest = await admitRun(request.zionPrincipal, {
          messages: [
            ...history.map((message) => ({
              role: message.role,
              content: message.content,
              ...(message.providerMetadata ? { providerMetadata: message.providerMetadata } : {}),
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
          model: await resolveRequestedModel(session.model, request.zionPrincipal),
          modelOptions: normalizeModelOptions(body.modelOptions),
          policy: session.policy,
          metadata: {
            ...session.metadata,
            source: "session-message",
            ...(clientRequestId ? { clientRequestId } : {})
          },
          maxTurns: body.maxTurns,
          timeoutMs: body.timeoutMs
        });
        if (
          clientRequestId
          && typeof sessions.reserveSessionMessageCommand === "function"
        ) {
          const reservation = await sessions.reserveSessionMessageCommand(
            session.id,
            clientRequestId,
            Date.now()
          );
          if (!reservation.reserved) {
            const existing = reservation.command;
            if (existing?.status === "accepted" && existing.response) {
              await authorizeExistingRun(request.zionPrincipal, await runs.get(existing.response.runId));
              json(response, 202, {
                ...existing.response,
                clientRequestId,
                replayed: true
              });
            } else {
              json(response, 409, {
                error: "Message submission is already in progress",
                clientRequestId,
                status: existing?.status || "submitting"
              });
            }
            return;
          }
        }
        let handle;
        try {
          handle = executor.execute(runRequest);
        } catch (error) {
          if (clientRequestId) {
            await sessions.releaseSessionMessageCommand?.(
              session.id,
              clientRequestId
            );
          }
          throw error;
        }
        let message;
        try {
          [message] = await sessions.appendSessionMessages(session.id, [{
            schemaVersion: 1,
            id: createId("message"),
            sessionId: session.id,
            role: "user",
            content,
            canonicalContent,
            ...(clientRequestId ? { clientRequestId } : {}),
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
          try {
            await handle.abort("session-persistence-failed");
            await handle.completion;
          } finally {
            if (clientRequestId) {
              await sessions.releaseSessionMessageCommand?.(
                session.id,
                clientRequestId
              );
            }
          }
          throw error;
        }
        await trackHandle(handle, session.id, runRequest);
        const accepted = {
          sessionId: session.id,
          message,
          runId: handle.runId,
          attemptId: handle.attemptId,
          status: "accepted",
          ...(clientRequestId ? { clientRequestId } : {})
        };
        if (clientRequestId) {
          await sessions.completeSessionMessageCommand?.(
            session.id,
            clientRequestId,
            accepted,
            Date.now()
          );
        }
        json(response, 202, accepted);
        return;
      }

      const forkSessionId = matchSessionPath(url.pathname, "/fork");
      if (request.method === "POST" && forkSessionId) {
        if (sessionHandles.has(forkSessionId) || sessionAdmissions.has(forkSessionId)) {
          json(response, 409, { error: "Cannot fork a Session with an active Run" });
          return;
        }
        await reconcileSessionProjections();
        const body = await readRequestJson(request);
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
        json(response, 200, await runs.listSessionArtifacts(sessionArtifactsId));
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
        const messages = canonicalTranscriptSessionId
          ? await sessions.getSessionTranscript(transcriptSessionId, after)
          : await sessions.getSessionMessages(transcriptSessionId, after);
        if (canonicalTranscriptSessionId) {
          await sessionDocumentService?.reconcileTranscript?.(
            transcriptSessionId,
            await sessions.getSessionMessages(transcriptSessionId)
          );
        }
        json(response, 200, {
          sessionId: transcriptSessionId,
          messages
        });
        return;
      }

      const sessionId = matchSessionPath(url.pathname);
      const activeRunSessionId = matchSessionPath(
        url.pathname,
        "/active-run"
      );
      if (request.method === "GET" && activeRunSessionId) {
        json(response, 200, {
          sessionId: activeRunSessionId,
          activeRun: await activeRunForSession(activeRunSessionId)
        });
        return;
      }
      if (request.method === "PATCH" && sessionId) {
        if (typeof sessions.updateSession !== "function") {
          json(response, 501, { error: "Runtime Session update is unavailable" });
          return;
        }
        const current = await sessions.getSession(sessionId);
        if (!current) {
          json(response, 404, { error: "Session not found" });
          return;
        }
        if (current.status !== "active") {
          json(response, 409, { error: `Session is not active: ${current.status}` });
          return;
        }
        const body = await readRequestJson(request);
        const configurationUpdate = ["model", "policy", "skills"].some(
          (field) => Object.hasOwn(body, field)
        );
        if (configurationUpdate && await activeRunForSession(sessionId)) {
          json(response, 409, { error: "Cannot update Session configuration with an active Run" });
          return;
        }
        const patch = {};
        if (Object.hasOwn(body, "title")) {
          const title = String(body.title || "").trim();
          if (!title || title.length > 200) {
            json(response, 400, { error: "Session title must contain 1-200 characters" });
            return;
          }
          patch.title = title;
        }
        if (Object.hasOwn(body, "model")) {
          patch.model = await resolveRequestedModel(body.model, request.zionPrincipal);
        }
        if (Object.hasOwn(body, "policy")) {
          patch.policy = normalizePolicy({
            ...(current.policy || {}),
            ...(body.policy && typeof body.policy === "object"
              ? body.policy
              : {})
          });
        }
        if (Object.hasOwn(body, "skills")) {
          if (!Array.isArray(body.skills?.enabled)) {
            json(response, 400, { error: "Session skills.enabled must be an array" });
            return;
          }
          patch.metadata = {
            ...(current.metadata || {}),
            skills: {
              ...(current.metadata?.skills
                && typeof current.metadata.skills === "object"
                ? current.metadata.skills
                : {}),
              enabled: Array.from(new Set(
                body.skills.enabled.map(String).map((value) => value.trim()).filter(Boolean)
              ))
            }
          };
        }
        if (Object.keys(patch).length === 0) {
          json(response, 400, {
            error: "Session update requires title, model, policy, or skills"
          });
          return;
        }
        const session = await sessions.updateSession(sessionId, patch, Date.now());
        publishSessionEvent("session.updated", {
          sessionId,
          data: {
            fields: Object.keys(patch)
          }
        });
        json(response, 200, { session: await presentSession(session) });
        return;
      }
      if (request.method === "GET" && sessionId) {
        const session = await sessions.getSession(sessionId);
        if (!session) {
          json(response, 404, { error: "Session not found" });
          return;
        }
        json(response, 200, { session: await presentSession(session) });
        return;
      }

      const resumeRunId = matchRunPath(url.pathname, "/resume");
      if (request.method === "POST" && resumeRunId) {
        if (handles.has(resumeRunId)) {
          json(response, 409, { error: "Run already has a live Runtime owner" });
          return;
        }
        const body = await readRequestJson(request);
        const existingRun = await runs.get(resumeRunId);
        await authorizeExistingRun(request.zionPrincipal, existingRun);
        if (
          accessControl?.mode === "accounts-v1"
          && existingRun?.principal?.kind === "service"
        ) {
          throw Object.assign(
            new Error("Scheduled service Runs must be started by their scheduler; a user must submit a new Run under their own grant"),
            { statusCode: 403, code: "service_run_resume_denied" }
          );
        }
        if (runs.getLatestCheckpoint && !await runs.getLatestCheckpoint(resumeRunId)) {
          throw Object.assign(new Error("This Run has no recoverable checkpoint"), {
            statusCode: 409, code: "run_checkpoint_unavailable"
          });
        }
        releaseAdmission = await reserveSessionAdmission(existingRun?.sessionId, resumeRunId);
        const handle = await executor.resume(resumeRunId, {
          waitId: body.waitId,
          input: body.input,
          model: body.model ? await resolveRequestedModel(body.model, request.zionPrincipal) : undefined,
          maxTurns: body.maxTurns,
          timeoutMs: body.timeoutMs,
          modelOptions: normalizeModelOptions(body.modelOptions)
        });
        await trackHandle(handle, existingRun?.sessionId, {
          ...existingRun,
          sessionId: existingRun?.sessionId,
          projectId: existingRun?.projectId,
          model: existingRun?.model,
          policy: existingRun?.policy,
          principal: existingRun?.principal,
          metadata: { ...existingRun?.metadata, resumed: true }
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
        const live = liveRuns.get(projectionStreamRunId);
        if (live) {
          const options = runProjectionOptions(url);
          const liveAbort = new globalThis.AbortController();
          const abortLive = () => liveAbort.abort();
          request.once("close", abortLive);
          try {
            for await (const event of live.subscribe(cursor, {
              signal: liveAbort.signal
            })) {
              await accessControl?.reauthorize?.(
                request.zionPrincipal,
                "runtime.read"
              );
              cursor = Math.max(cursor, Number(event.sequence) || 0);
              for (const projected of projectRunEvents([event], options)) {
                if (!await writeSseEvent(response, projected)) return;
              }
            }
          } finally {
            request.off("close", abortLive);
          }
          response.end();
          return;
        }
        const projector = createRunEventProjector(
          runProjectionOptions(url)
        );
        while (!closed) {
          await accessControl?.reauthorize?.(
            request.zionPrincipal,
            "runtime.read"
          );
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
        const live = liveRuns.get(projectionRunId);
        const sourceEvents = live
          ? live.eventsAfter(after)
          : await runs.getEvents(projectionRunId, after);
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
        const liveEvent = liveRuns.get(runEventPath.runId)
          ?.eventsAfter(Math.max(0, runEventPath.sequence - 1))
          .find((item) => item.sequence === runEventPath.sequence);
        const event = liveEvent || (typeof runs.getEvent === "function"
          ? await runs.getEvent(runEventPath.runId, runEventPath.sequence)
          : (await runs.getEvents(
              runEventPath.runId,
              Math.max(0, runEventPath.sequence - 1)
            )).find((item) => item.sequence === runEventPath.sequence));
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
        const live = liveRuns.get(streamRunId);
        if (live) {
          const liveAbort = new globalThis.AbortController();
          const abortLive = () => liveAbort.abort();
          request.once("close", abortLive);
          try {
            for await (const event of live.subscribe(cursor, {
              signal: liveAbort.signal
            })) {
              await accessControl?.reauthorize?.(
                request.zionPrincipal,
                "runtime.read"
              );
              cursor = Math.max(cursor, Number(event.sequence) || 0);
              if (!await writeSseEvent(response, event)) return;
            }
          } finally {
            request.off("close", abortLive);
          }
          response.end();
          return;
        }
        while (!closed) {
          await accessControl?.reauthorize?.(
            request.zionPrincipal,
            "runtime.read"
          );
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
        const live = liveRuns.get(eventsRunId);
        json(response, 200, {
          runId: eventsRunId,
          events: live
            ? live.eventsAfter(after)
            : await runs.getEvents(eventsRunId, after)
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
        json(response, 200, await runs.listRunArtifacts(artifactsRunId));
        return;
      }

      const abortRunId = matchRunPath(url.pathname, "/abort");
      if (request.method === "POST" && abortRunId) {
        const run = await runs.get(abortRunId);
        await authorizeExistingRun(
          request.zionPrincipal,
          run,
          { allowRevoked: true }
        );
        const body = await readRequestJson(request);
        if (run?.status === "waiting") {
          // Drain the completed waiting attempt before replacing its live hub.
          await runFinalizations.get(run.id);
          const events = await runs.getEvents(abortRunId);
          const event = {
            schemaVersion: 1, eventId: createId("event"), runId: abortRunId,
            attemptId: run.attemptId, sequence: (events.at(-1)?.sequence || 0) + 1,
            type: "run.aborted", timestamp: Date.now(),
            data: { reason: String(body.reason || "user"), output: run.output || "", usage: run.usage }
          };
          const result = {
            runId: run.id, attemptId: run.attemptId, status: "aborted",
            output: run.output || "", usage: run.usage, reason: event.data.reason
          };
          const outbox = await waitingTerminalOutbox(run, result);
          if (!await runs.cancelWait(event, run.waiting?.id, outbox)) {
            throw Object.assign(new Error("Waiting Run was already resumed or cancelled"), { statusCode: 409 });
          }
          // Existing terminal observers and session projections see the same
          // cancellation as an active Run, without executing any paused work.
          await trackHandle({
            runId: run.id, attemptId: run.attemptId,
            events: (async function* () { yield event; })(),
            completion: Promise.resolve(result),
            abort: async () => {}
          }, run.sessionId, { ...run, prompt: undefined }, { initialEvents: events, publishStarted: false });
          json(response, 202, { ok: true, runId: abortRunId });
          return;
        }
        const handle = handles.get(abortRunId);
        if (!handle) {
          json(response, run ? 409 : 404, {
            error: run ? `Run is not active: ${run.status}` : "Run not found"
          });
          return;
        }
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
      json(response, Number(error?.statusCode || 500), errorPayload(error));
    } finally {
      // A successful admission is now protected by trackHandle until finalization.
      releaseAdmission?.();
    }
  };
  const server = createServer(handleRequest);
  const normalizedUpgradeHandlers = (Array.isArray(upgradeHandlers)
    ? upgradeHandlers
    : []
  ).filter((handler) => typeof handler === "function");
  const handleUpgrade = async (request, socket, head) => {
    try {
      for (const handler of normalizedUpgradeHandlers) {
        if (await handler(request, socket, head)) return;
      }
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
    } catch { socket.destroy(); }
  };
  if (normalizedUpgradeHandlers.length) server.on("upgrade", handleUpgrade);

  return {
    handleRequest,
    handleUpgrade,
    isIdle: () => handles.size === 0 && sessionFinalizations.size === 0,
    async start() {
      if (server.listening) return this.address();
      closing = false;
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
      closing = true;
      const activeHandles = Array.from(handles.values());
      for (const handle of activeHandles) {
        await handle.abort("runtime-shutdown");
      }
      await Promise.allSettled(activeHandles.map((handle) => handle.completion));
      await Promise.allSettled([...runFinalizations.values()]);
      for (const retirement of liveRunRetirements.values()) {
        globalThis.clearTimeout(retirement);
      }
      liveRunRetirements.clear();
      for (const live of liveRuns.values()) live.close();
      liveRuns.clear();
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
