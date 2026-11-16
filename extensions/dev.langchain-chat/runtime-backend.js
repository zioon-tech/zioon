import {
  createHttpRuntimeClient,
  createRemoteRunHandle
} from "../../src/runtime/http-runtime-client.ts";
import { toZionNextRunEvent } from "../../src/runtime/zion-next-compatibility.ts";
import {
  llmRequestPayloadFromWorkbenchEvent,
  registerLlmRequestPayload
} from "../../src/runtime/llm-request-observability.ts";
import {
  DEFAULT_WORKBENCH_RUNTIME_BASE_URL,
  probeWorkbenchRuntime,
  readWorkbenchRuntimeConfig,
  shouldUseWorkbenchRuntime
} from "../../src/runtime/workbench-runtime-config.ts";
import { normalizeModelLimits } from "./model-limits.js";
import { submitConversationInput } from "../../src/runtime/conversation-submission.js";
import { currentAccountSession } from "../../packages/account-ui/src/client";

export const CHAT_RUNTIME_ENABLED_KEY = "zion.chat.runtime.enabled";
export const CHAT_RUNTIME_BASE_URL_KEY = "zion.chat.runtime.baseUrl";
export const DEFAULT_CHAT_RUNTIME_BASE_URL = DEFAULT_WORKBENCH_RUNTIME_BASE_URL;
export const DEFAULT_INTERACTIVE_RUNTIME_PROFILE_ID = "interactive.default";

const INTERACTIVE_PROJECTION_OPTIONS = Object.freeze({
  mode: "projection",
  reasoningMode: "stream",
  maxDelayMs: 50,
  maxChunkChars: 256
});

const RUNTIME_SUPPORTED_TOOLS = new Set([
  "sandboxBash",
  "sandboxRead",
  "sandboxWrite",
  "goalManage",
  "compressionRecall",
  "read",
  "glob",
  "grep",
  "tree",
  "write",
  "edit",
  "Bash",
  "webSearch",
  "webFetch",
  "sendMail",
  "todoWrite",
  "mcpListTools",
  "mcpCall",
  "terminalInventory",
  "skillsList",
  "memoryList",
  "memoryManage",
  "agentsManage",
  "identityContext",
  "identityManage",
  "projectAutomationManage",
  "schedulerManage",
  "modelsManage",
  "toolsManage",
  "pluginsManage",
  "terminalManage",
  "mailManage",
  "sessionList",
  "sessionGet",
  "sessionCreate",
  "sessionUpdate",
  "sessionDelete"
]);
const RUNTIME_WORKSPACE_WRITE_TOOLS = new Set([
  "write",
  "edit",
  "memoryManage",
  "agentsManage",
  "identityManage",
  "projectAutomationManage",
  "sessionCreate",
  "sessionUpdate",
  "sessionDelete"
]);
const RUNTIME_TRUSTED_AUTOMATION_TOOLS = new Set([
  "Bash",
  "sandboxBash",
  "sandboxWrite",
  "sendMail",
  "todoWrite",
  "mcpCall",
  "modelsManage",
  "toolsManage",
  "pluginsManage",
  "terminalManage",
  "mailManage"
]);
const SUPPORTED_MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);
const RUNTIME_BACKED_CONTEXT_CONTRIBUTORS = [
  {
    contributorId: "dev.skills.standard",
    providerId: "dev.skills.available"
  },
  {
    contributorId: "dev.memory.context",
    providerId: "dev.memory.context"
  },
  {
    contributorId: "dev.identity.context",
    providerId: "dev.identity.context"
  },
  {
    contributorId: "dev.context-compression",
    providerId: "dev.context-compression"
  },
  {
    contributorId: "dev.terminal-manager.inventory",
    providerId: "dev.terminal-manager.inventory"
  },
  {
    contributorId: "dev.terminal-enhanced.context",
    providerId: "dev.terminal-manager.inventory"
  }
];

function supportedRuntimeMessageContent(message = {}) {
  const content = message.content;
  if (typeof content === "string") return true;
  if (
    message.role === "assistant"
    && content == null
    && (Array.isArray(message.tool_calls) || Array.isArray(message.toolCalls))
  ) {
    return true;
  }
  if (!Array.isArray(content) || content.length === 0) return false;
  if (message.role !== "user") return false;
  return content.every((part) => (
    part?.type === "text" && typeof part.text === "string"
  ) || (
    part?.type === "image_url"
    && typeof part.image_url?.url === "string"
    && part.image_url.url.trim().length > 0
  ));
}

function runtimeMessageShapeSupported(messages = []) {
  const callIds = new Set();
  for (const message of messages) {
    const calls = Array.isArray(message?.tool_calls)
      ? message.tool_calls
      : Array.isArray(message?.toolCalls)
        ? message.toolCalls
        : [];
    for (const call of calls) {
      const id = String(call?.id || "").trim();
      const name = String(call?.function?.name || "").trim();
      if (!id || !name) return false;
      callIds.add(id);
    }
  }
  return messages.every((message) => {
    const role = String(message?.role || "");
    if (!SUPPORTED_MESSAGE_ROLES.has(role) || !supportedRuntimeMessageContent(message)) {
      return false;
    }
    if (role === "tool") {
      const id = String(message?.tool_call_id || message?.toolCallId || "").trim();
      return !!id && callIds.has(id);
    }
    return !message?.tool_call_id && !message?.toolCallId;
  });
}

function selectedToolNames(tools) {
  return [...new Set(
    (Array.isArray(tools) ? tools : [])
      .map((tool) => String(tool?.function?.name || tool?.name || ""))
      .filter(Boolean)
  )];
}

function activeRuntimeContextProviderIds(runtimeConnection) {
  const connection = runtimeConnection && typeof runtimeConnection === "object"
    ? runtimeConnection
    : globalThis.window?.zion?.state?.get?.("runtime.connection");
  if (String(connection?.backend || "") !== "runtime") return new Set();
  const plugins = Array.isArray(connection?.runtimePlugins)
    ? connection.runtimePlugins
    : [];
  const ids = [];
  for (const plugin of plugins) {
    if (String(plugin?.status || "") !== "active") continue;
    ids.push(...(Array.isArray(plugin.contextProviderIds)
      ? plugin.contextProviderIds
      : []));
  }
  return new Set(ids.map(String).filter(Boolean));
}

export function runtimeBackedContributorIds(runtimeConnection) {
  const providers = activeRuntimeContextProviderIds(runtimeConnection);
  return RUNTIME_BACKED_CONTEXT_CONTRIBUTORS
    .filter((item) => providers.has(item.providerId))
    .map((item) => item.contributorId);
}

export function includeTerminalContextForRuntime(
  state = globalThis.window?.zion?.state
) {
  return state?.get?.("chat.includeTerminalContext") !== false;
}

function configuredToolNameList(value) {
  return Array.isArray(value)
    ? selectedToolNames(value.map((name) => ({ name })))
    : null;
}

function configuredRuntimeSupportedToolNames(options = {}) {
  const state = options.state || globalThis.window?.zion?.state;
  const injectable = configuredToolNameList(
    Object.prototype.hasOwnProperty.call(options, "injectableToolNames")
      ? options.injectableToolNames
      : state?.get?.("runtime.injectableToolNames")
  );
  if (injectable) return injectable;
  const configured = configuredToolNameList(
    options.supportedToolNames || state?.get?.("runtime.supportedToolNames")
  );
  return configured || Array.from(RUNTIME_SUPPORTED_TOOLS);
}

export function listInteractiveRuntimeSupportedTools(options = {}) {
  return configuredRuntimeSupportedToolNames(options);
}

export function createInteractiveRuntimePolicy(tools, options = {}) {
  const runtimeSupportedTools = new Set(configuredRuntimeSupportedToolNames(options));
  const selectedNames = selectedToolNames(tools);
  const allowedTools = selectedNames.filter((name) =>
    runtimeSupportedTools.has(name)
  );
  const unsupportedTools = selectedNames.filter((name) =>
    !runtimeSupportedTools.has(name)
  );
  const trustedAutomation = allowedTools.some((name) =>
    RUNTIME_TRUSTED_AUTOMATION_TOOLS.has(name)
  );
  const workspaceWrite = allowedTools.some((name) =>
    RUNTIME_WORKSPACE_WRITE_TOOLS.has(name)
  );
  const preset = trustedAutomation
    ? "trusted-automation"
    : workspaceWrite
      ? "workspace-write"
      : "read-only";

  return {
    policy: {
      preset,
      allowedTools,
      fileRoots: [],
      allowedCommandPrefixes: [],
      allowedTerminalSessionIds: [],
      allowedRecipients: allowedTools.includes("sendMail") ? ["*"] : [],
      maxMailPerRun: allowedTools.includes("sendMail") ? 10 : 0
    },
    selectedTools: selectedNames,
    unsupportedTools
  };
}

export function readInteractiveRuntimeConfig({
  state = globalThis.window?.zion?.state,
  storage = globalThis.localStorage
} = {}) {
  const config = readWorkbenchRuntimeConfig({
    state,
    storage,
    legacyEnabledStateKey: "chat.runtime.enabled",
    legacyEnabledStorageKey: CHAT_RUNTIME_ENABLED_KEY,
    legacyBaseUrlStateKey: "chat.runtime.baseUrl",
    legacyBaseUrlStorageKey: CHAT_RUNTIME_BASE_URL_KEY
  });
  return config;
}

export function shouldUseInteractiveRuntime(config, options = {}) {
  return shouldUseWorkbenchRuntime(config, options);
}

export function probeInteractiveRuntime(config, options = {}) {
  return probeWorkbenchRuntime({
    baseUrl: config.baseUrl,
    ...options
  });
}

export function interactiveRuntimeEligibility({
  messages,
  tools,
  content,
  requestSource,
  skipSessionPersistence
}) {
  if (requestSource) {
    return { eligible: false, reason: "non-interactive-source" };
  }
  if (skipSessionPersistence) {
    return { eligible: false, reason: "session-persistence-disabled" };
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { eligible: false, reason: "no-messages" };
  }
  if (!runtimeMessageShapeSupported(messages)) {
    return { eligible: false, reason: "unsupported-message-shape" };
  }
  const {
    policy,
    unsupportedTools
  } = createInteractiveRuntimePolicy(tools);
  const explicitToolNames = Array.from(
    String(content || "").matchAll(/^tools?:\s*([a-zA-Z0-9_]+)/gm),
    (match) => match[1]
  );
  const unsupportedExplicitTool = explicitToolNames.find(
    (name) => !configuredRuntimeSupportedToolNames().includes(name)
  );
  if (unsupportedExplicitTool) {
    return {
      eligible: false,
      reason: `unsupported-tool:${unsupportedExplicitTool}`
    };
  }
  return {
    eligible: true,
    reason: null,
    toolNames: policy.allowedTools,
    unsupportedToolNames: unsupportedTools
  };
}

function createEventDetailResolver({ baseUrl, fetchImpl, runtimeRunId, signal }) {
  return async (sequence) => {
    if (signal?.aborted) return null;
    const controller = new AbortController();
    let cancel;
    const cancelled = new Promise((resolve) => {
      cancel = () => {
        controller.abort();
        resolve(null);
      };
    });
    const timer = setTimeout(cancel, 5_000);
    signal?.addEventListener("abort", cancel, { once: true });
    const client = createHttpRuntimeClient({
      baseUrl,
      fetchImpl: (input, init) => (fetchImpl || globalThis.fetch)(input, {
        ...init,
        signal: controller.signal
      })
    });
    try {
      return await Promise.race([
        client.getEvent(runtimeRunId, sequence),
        cancelled
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  };
}

function createEventProjector(resolveEventDetail, { sessionId, metadata } = {}) {
  const seen = new Set();
  let hydrating = 0;
  return (event) => {
    const projected = toZionNextRunEvent(event);
    const sequence = Number(projected.data?.rawEventSequence);
    const key = `${projected.runId}:${sequence}`;
    if (
      projected.type === "model.request"
      && !projected.data?.payload
      && projected.data?.detailAvailable === true
      && sequence > 0
      && typeof resolveEventDetail === "function"
      && !seen.has(key)
      && hydrating < 4
    ) {
      seen.add(key);
      if (seen.size > 256) seen.delete(seen.values().next().value);
      hydrating += 1;
      // Inspector enrichment must never delay or replay ordered chat events.
      void Promise.resolve().then(() => resolveEventDetail(sequence)).then((detail) => {
        if (detail?.type !== "model.request" || !detail.data?.payload) return;
        const payload = llmRequestPayloadFromWorkbenchEvent({
          ...projected,
          type: "llm.request",
          sessionId: sessionId || "",
          data: {
            ...projected.data,
            ...detail.data,
            id: detail.eventId || event.eventId,
            timestamp: event.timestamp,
            source: metadata?.requestSource || metadata?.source || "interactive-chat",
            panelId: metadata?.panelId || "",
            stepIndex: detail.data.turn
          }
        });
        registerLlmRequestPayload(globalThis.window?.zion, payload);
      }).catch(() => {
        // Optional inspector detail may be unavailable, cancelled, or timed out.
      }).finally(() => {
        hydrating -= 1;
      });
    }
    return projected;
  };
}

function projectEvents(events, resolveEventDetail = null, context = {}) {
  const projectEvent = createEventProjector(resolveEventDetail, context);
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of events) {
        yield projectEvent(event);
      }
    }
  };
}

function unavailableModel(message) {
  const error = new Error(message);
  error.code = "RUNTIME_MODEL_UNAVAILABLE";
  return error;
}

function unsupportedRuntimeContext(message) {
  const error = new Error(message);
  error.code = "RUNTIME_CONTEXT_UNSUPPORTED";
  return error;
}

function assertRuntimeMessageShape(messages) {
  if (!runtimeMessageShapeSupported(Array.isArray(messages) ? messages : [])) {
    throw unsupportedRuntimeContext(
      "A Workbench message contributor produced a message shape unsupported by Runtime"
    );
  }
}

export async function prepareInteractiveRuntimeMessages({
  messages,
  runContributors,
  contributorContext = {},
  transformMessages
}) {
  let prepared = Array.isArray(messages) ? messages : [];
  const context = {
    ...contributorContext,
    runtimeBackend: "external",
    excludedContributorIds: Array.from(new Set([
      ...(Array.isArray(contributorContext.excludedContributorIds)
        ? contributorContext.excludedContributorIds.map(String)
        : []),
      ...runtimeBackedContributorIds(contributorContext.runtimeConnection)
    ]))
  };
  if (typeof runContributors === "function") {
    prepared = await runContributors(prepared, "pre", context);
  }
  if (typeof transformMessages === "function") {
    prepared = await transformMessages(prepared, context);
  }
  if (typeof runContributors === "function") {
    prepared = await runContributors(prepared, "post", context);
  }
  assertRuntimeMessageShape(prepared);
  return prepared;
}

function importedProfileId(selectedModel) {
  const safe = (value) => String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `workbench.${safe(selectedModel?.providerId)}.${safe(selectedModel?.modelId)}`;
}

function modelRequestOptions(selectedConfig = {}) {
  const thinkingMode = String(selectedConfig?.thinkingMode || "").toLowerCase();
  const thinkingEffort = String(selectedConfig?.thinkingEffort || "").toLowerCase();
  const options = {};
  if (["auto", "off", "on"].includes(thinkingMode)) {
    options.thinkingMode = thinkingMode;
  }
  if (
    ["auto", "minimal", "low", "medium", "high", "xhigh", "max"]
      .includes(thinkingEffort)
  ) {
    options.thinkingEffort = thinkingEffort;
  }
  return options;
}

function importableProfile(selectedModel, selectedConfig) {
  if (String(selectedConfig?.providerType || "").toLowerCase() !== "openai") {
    return null;
  }
  const endpoint = String(selectedConfig?.url || "").trim();
  const model = String(
    selectedConfig?.modelName
    || selectedConfig?.model
    || selectedModel?.modelId
    || ""
  ).trim();
  if (!endpoint || !model) return null;
  return {
    id: importedProfileId(selectedModel),
    label: String(selectedModel?.label || selectedConfig?.label || model),
    providerId: String(selectedModel?.providerId || selectedConfig?.providerId || "runtime"),
    sourceModelId: String(selectedModel?.modelId || model),
    providerType: "openai",
    endpoint,
    model,
    credentialRequired: selectedConfig?.credentialRequired !== false
      && (
        selectedConfig?._requiresConfig === true
        || selectedConfig?._credentialConfigured === true
        || !!String(selectedConfig?.key || selectedConfig?.apiKey || "").trim()
      ),
    temperature: selectedConfig?.temperature,
    maxOutputTokens: selectedConfig?.max_tokens,
    limits: normalizeModelLimits(selectedConfig?.limits || selectedConfig || {}),
    capabilities: {
      supportsImage: !!selectedConfig?.supportsImage,
      supportsThinking: !!selectedConfig?.supportsThinking,
      supportsThinkingEffort: !!selectedConfig?.supportsThinkingEffort,
      thinkingMode: selectedConfig?.thinkingMode,
      thinkingEffort: selectedConfig?.thinkingEffort,
      preservedThinking: !!selectedConfig?.preservedThinking,
      interleavedThinking: !!selectedConfig?.interleavedThinking
    }
  };
}

function findRuntimeProfile(profiles, selectedModel) {
  const selectedProfileId = String(selectedModel?.profileId || "");
  const selectedProviderId = String(selectedModel?.providerId || "");
  const selectedModelId = String(selectedModel?.modelId || "");
  if (selectedProfileId) {
    return profiles.find((item) => item.id === selectedProfileId);
  }

  const importedId = importedProfileId(selectedModel);
  const imported = profiles.find((item) => item.id === importedId);
  if (imported) return imported;

  const matches = profiles.filter((item) =>
    (
      item.id === selectedModelId
      || item.model === selectedModelId
      || item.sourceModelId === selectedModelId
    )
    && (!selectedProviderId || item.providerId === selectedProviderId)
  );
  return matches.find((item) => item.credentialConfigured === true) || matches[0];
}

export async function resolveInteractiveRuntimeModel(
  client,
  selectedModel,
  selectedConfig,
  runtimeCatalog
) {
  const catalog = Array.isArray(runtimeCatalog?.profiles)
    ? runtimeCatalog
    : await client.getModels();
  const profiles = Array.isArray(catalog.profiles) ? catalog.profiles : [];
  const selectedProviderId = String(selectedModel?.providerId || "");
  const selectedModelId = String(selectedModel?.modelId || "");
  let profile = findRuntimeProfile(profiles, selectedModel);
  if (!profile && catalog === runtimeCatalog) {
    const freshCatalog = await client.getModels();
    profile = findRuntimeProfile(
      Array.isArray(freshCatalog.profiles) ? freshCatalog.profiles : [],
      selectedModel
    );
  }
  const importable = importableProfile(selectedModel, selectedConfig);
  const credential = String(
    selectedConfig?.key || selectedConfig?.apiKey || ""
  ).trim();
  if (
    importable
    && (
      !profile
      || (profile.credentialConfigured === false && credential)
    )
  ) {
    profile = await client.upsertModelProfile(importable.id, {
      profile: importable,
      ...(credential ? { credential } : {})
    });
  }
  if (!profile) {
    throw unavailableModel(
      `Selected model is not configured in Runtime: `
      + `${selectedProviderId || "unknown"}/${selectedModelId || "unknown"}`
    );
  }
  return {
    profileId: profile.id,
    providerId: String(profile.providerId || profile.providerType || "runtime"),
    modelId: profile.model,
    label: profile.label || profile.model
  };
}

export async function syncWorkbenchModelProfiles({
  models,
  resolveConfig,
  baseUrl,
  fetchImpl,
  overwriteExisting = false
}) {
  const client = createHttpRuntimeClient({ baseUrl, fetchImpl });
  const catalog = await client.getModels();
  const profiles = Array.isArray(catalog.profiles)
    ? [...catalog.profiles]
    : [];
  const imported = [];
  const skipped = [];

  for (const selectedModel of Array.isArray(models) ? models : []) {
    let selectedConfig;
    try {
      selectedConfig = await resolveConfig(selectedModel);
    } catch (error) {
      skipped.push({
        model: selectedModel,
        reason: error?.message || String(error)
      });
      continue;
    }
    const importable = importableProfile(selectedModel, selectedConfig);
    const credential = String(
      selectedConfig?.key || selectedConfig?.apiKey || ""
    ).trim();
    if (!importable) {
      skipped.push({ model: selectedModel, reason: "unsupported-provider" });
      continue;
    }
    const existing = findRuntimeProfile(profiles, selectedModel);
    if (
      importable.credentialRequired
      && !credential
      && existing?.credentialConfigured !== true
    ) {
      skipped.push({ model: selectedModel, reason: "missing-credential" });
      continue;
    }
    if (
      existing
      && !overwriteExisting
      && (
        existing.credentialConfigured !== false
        || !credential
      )
    ) continue;

    const profile = await client.upsertModelProfile(importable.id, {
      profile: importable,
      ...(credential ? { credential } : {})
    });
    const previousIndex = profiles.findIndex((item) => item.id === profile.id);
    if (previousIndex >= 0) profiles[previousIndex] = profile;
    else profiles.push(profile);
    imported.push(profile);
  }

  return { profiles, imported, skipped };
}

export async function resolveInteractiveRuntimeProfileModel({
  baseUrl,
  fetchImpl,
  interactionProfileId = DEFAULT_INTERACTIVE_RUNTIME_PROFILE_ID
}) {
  const client = createHttpRuntimeClient({ baseUrl, fetchImpl });
  const [profile, catalog] = await Promise.all([
    client.getInteractionProfile(interactionProfileId),
    client.getModels(interactionProfileId)
  ]);
  const modelProfileId = String(
    catalog.selectedProfileId
    || profile?.modelProfileId
    || profile?.model?.profileId
    || ""
  ).trim();
  if (!modelProfileId) return null;
  const profiles = Array.isArray(catalog.profiles) ? catalog.profiles : [];
  const modelProfile = profiles.find((item) => item.id === modelProfileId);
  if (!modelProfile) return null;
  const capabilities = modelProfile.capabilities
    && typeof modelProfile.capabilities === "object"
    ? modelProfile.capabilities
    : {};
  return {
    profileId: modelProfile.id,
    providerId: String(modelProfile.providerId || profile?.model?.providerId || "runtime"),
    modelId: String(
      modelProfile.sourceModelId
      || modelProfile.model
      || profile?.model?.modelId
      || modelProfile.id
    ),
    label: String(modelProfile.label || modelProfile.model || modelProfile.id),
    ...(capabilities.supportsThinking !== undefined
      ? { supportsThinking: capabilities.supportsThinking === true }
      : {}),
    ...(capabilities.supportsThinkingEffort !== undefined
      ? { supportsThinkingEffort: capabilities.supportsThinkingEffort === true }
      : {}),
    ...(capabilities.thinkingMode !== undefined
      ? { thinkingMode: capabilities.thinkingMode }
      : {}),
    ...(capabilities.thinkingEffort !== undefined
      ? { thinkingEffort: capabilities.thinkingEffort }
      : {})
  };
}

export async function persistInteractiveRuntimeProfileModel({
  selectedModel,
  selectedModelConfig,
  baseUrl,
  fetchImpl,
  interactionProfileId = DEFAULT_INTERACTIVE_RUNTIME_PROFILE_ID
}) {
  const client = createHttpRuntimeClient({ baseUrl, fetchImpl });
  const runtimeModel = await resolveInteractiveRuntimeModel(
    client,
    selectedModel,
    selectedModelConfig
  );
  const profile = await client.setModelSelection(runtimeModel.profileId, interactionProfileId);
  return { runtimeModel, profile };
}

function runtimeRequestMessage(message) {
  return {
    role: message.role,
    content: message.content == null ? "" : message.content,
    ...(message.reasoning_content
      ? { reasoningContent: String(message.reasoning_content) }
      : message.reasoningContent
        ? { reasoningContent: String(message.reasoningContent) }
        : {}),
    ...(Array.isArray(message.tool_calls)
      ? { toolCalls: message.tool_calls }
      : Array.isArray(message.toolCalls)
        ? { toolCalls: message.toolCalls }
        : {}),
    ...(message.tool_call_id
      ? { toolCallId: String(message.tool_call_id) }
      : message.toolCallId
        ? { toolCallId: String(message.toolCallId) }
        : {})
  };
}

async function buildInteractiveRuntimeRequest({
  messages,
  sessionHistory = messages,
  tools,
  selectedModel,
  selectedModelConfig,
  runtimeCatalog,
  signal,
  expectedAccount,
  title,
  workbenchSessionId,
  projectId,
  metadata,
  baseUrl,
  fetchImpl,
  interactionProfileId = DEFAULT_INTERACTIVE_RUNTIME_PROFILE_ID
}) {
  const {
    policy,
    selectedTools,
    unsupportedTools
  } = createInteractiveRuntimePolicy(tools);
  const latestUser = messages.filter((message) => message.role === "user").at(-1);
  const goalRequested = metadata?.goal
    || globalThis.window?.zion?.state?.get?.(`goal.session.${workbenchSessionId}`)?.status === "active"
    || (typeof latestUser?.content === "string" && /^\s*\/goal(?:\s|$)/.test(latestUser.content));
  if (goalRequested) {
    // Admission still intersects these workflow tools with the administrator's ceiling.
    policy.allowedTools = Array.from(new Set([...policy.allowedTools, "goalManage", "compressionRecall"]));
  }
  const client = createHttpRuntimeClient({ baseUrl, fetchImpl });
  const runtimeModel = await resolveInteractiveRuntimeModel(
    client,
    selectedModel,
    selectedModelConfig,
    runtimeCatalog
  );
  signal?.throwIfAborted();
  return {
    client,
    request: {
    interactionProfileId,
    title: title || "",
    ...(workbenchSessionId ? { sessionId: String(workbenchSessionId) } : {}),
    ...(workbenchSessionId ? { conversationInput: {
      schemaVersion: 1, mode: "snapshot",
      clientRequestId: metadata?.chatSubmission?.clientRequestId || crypto.randomUUID(),
      ...(expectedAccount ? { expectedAccount } : {})
    } } : {}),
    ...((projectId || metadata?.projectId) ? {
      projectId: String(projectId || metadata.projectId)
    } : {}),
    messages: messages.map(runtimeRequestMessage),
    sessionHistory: sessionHistory.map(runtimeRequestMessage),
    model: runtimeModel,
    modelOptions: modelRequestOptions({
      ...selectedModelConfig,
      ...(selectedModel?.thinkingMode != null
        ? { thinkingMode: selectedModel.thinkingMode }
        : {}),
      ...(selectedModel?.thinkingEffort != null
        ? { thinkingEffort: selectedModel.thinkingEffort }
        : {}),
      ...(/^glm-5\.3(?:-flash)?$/i.test(String(runtimeModel?.modelId || ""))
        && (!selectedModel?.thinkingEffort || selectedModel.thinkingEffort === "auto")
        && (!selectedModelConfig?.thinkingEffort || selectedModelConfig.thinkingEffort === "auto")
        ? { thinkingMode: "on", thinkingEffort: "low" }
        : {})
    }),
    policy,
    metadata: {
      ...(metadata || {}),
      source: "interactive-chat",
      workbenchProtocolVersion: 4,
      interactionProfileId,
      workbenchSessionId,
      workbenchEnabledTools: selectedTools,
      runtimeEnabledTools: policy.allowedTools,
      runtimeUnsupportedTools: unsupportedTools
    }
    }
  };
}

export async function previewInteractiveRuntimeRequest(options) {
  const { client, request } = await buildInteractiveRuntimeRequest(options);
  return await client.previewRun(request);
}

export function captureInteractiveRuntimeAccount() {
  const account = currentAccountSession();
  return account?.user?.id && account?.space?.id
    ? { userId: account.user.id, spaceId: account.space.id } : null;
}

export async function createInteractiveRuntimeHandle(options) {
  const {
    signal,
    baseUrl,
    fetchImpl,
    workbenchSessionId,
    metadata
  } = options;
  const expectedAccount = options.expectedAccount === undefined
    ? captureInteractiveRuntimeAccount() : options.expectedAccount;
  const assertIdentity = () => {
    const current = captureInteractiveRuntimeAccount();
    if (globalThis.window?.zion?.state?.get?.("workbench.accessChanged")
      || current?.userId !== expectedAccount?.userId || current?.spaceId !== expectedAccount?.spaceId) {
      throw Object.assign(new Error("账户已变化，旧请求已保留；请返回原账户确认。"), {
        code: "INPUT_SUBMISSION_ACCOUNT_CHANGED"
      });
    }
  };
  signal?.throwIfAborted();
  assertIdentity();
  const { client, request } = await buildInteractiveRuntimeRequest({ ...options, expectedAccount });
  signal?.throwIfAborted();
  assertIdentity();
  if (request.metadata?.chatSubmission?.stages) {
    request.metadata.chatSubmission.stages.requestSent =
      Date.now() - request.metadata.chatSubmission.submittedAt;
  }
  // #region debug-point D:request-start
  if (globalThis.window?.zion?.state?.get?.("debug.chatSubmitUrl")) void fetch(window.zion.state.get("debug.chatSubmitUrl"), { method: "POST", body: JSON.stringify({ sessionId: "chat-submit-latency", runId: window.zion.state.get("debug.chatSubmitPhase") || "pre-fix", hypothesisId: "D", location: "createInteractiveRuntimeHandle:request-start", msg: "[DEBUG] request-start", ts: Date.now() }) }).catch(() => {});
  // #endregion
  const submissionClient = request.conversationInput ? {
    ...client,
    createRun: (input) => submitConversationInput(client, input, {
      scope: JSON.stringify([baseUrl, expectedAccount?.userId, expectedAccount?.spaceId]),
      assertIdentity,
      signal,
      onRecover() {
        globalThis.window?.zion?.notification?.show?.("正在确认上一条发送；当前编辑已保留。", { type: "info" });
      }
    })
  } : client;
  const handle = await createRemoteRunHandle(submissionClient, request, {
    subscription: {
      ...INTERACTIVE_PROJECTION_OPTIONS
    }
  });
  // #region debug-point D:accepted
  if (globalThis.window?.zion?.state?.get?.("debug.chatSubmitUrl")) void fetch(window.zion.state.get("debug.chatSubmitUrl"), { method: "POST", body: JSON.stringify({ sessionId: "chat-submit-latency", runId: window.zion.state.get("debug.chatSubmitPhase") || "pre-fix", hypothesisId: "D", location: "createInteractiveRuntimeHandle:accepted", msg: "[DEBUG] accepted", ts: Date.now() }) }).catch(() => {});
  // #endregion
  return {
    ...handle,
    events: projectEvents(
      handle.events,
      createEventDetailResolver({
        baseUrl,
        fetchImpl,
        runtimeRunId: handle.runId,
        signal
      }),
      { sessionId: workbenchSessionId, metadata }
    )
  };
}

export async function observeInteractiveRuntimeRun({
  runtimeRunId,
  afterSequence = 0,
  baseUrl,
  fetchImpl,
  signal,
  onRun = async () => {},
  onEvent = async () => {}
}) {
  const client = createHttpRuntimeClient({ baseUrl, fetchImpl });
  const run = await client.getRun(runtimeRunId);
  await onRun(run);
  const projectEvent = createEventProjector(
    createEventDetailResolver({ baseUrl, fetchImpl, runtimeRunId, signal }),
    { sessionId: run.sessionId, metadata: run.metadata }
  );
  let lastEventSequence = Math.max(0, Number(afterSequence) || 0);
  for await (const event of client.subscribe(runtimeRunId, {
    afterSequence: lastEventSequence,
    signal,
    ...INTERACTIVE_PROJECTION_OPTIONS
  })) {
    const projected = projectEvent(event);
    await onEvent(projected);
    lastEventSequence = Math.max(
      lastEventSequence,
      Number(projected.sequence) || 0
    );
  }
  return {
    run: await client.getRun(runtimeRunId),
    lastEventSequence
  };
}

export async function abortInteractiveRuntimeRun({
  runtimeRunId,
  baseUrl,
  reason = "user",
  fetchImpl
}) {
  const client = createHttpRuntimeClient({ baseUrl, fetchImpl });
  await client.abort(runtimeRunId, reason);
}

export async function respondInteractiveRuntimeRun({ runtimeRunId, waitId, input, baseUrl, fetchImpl }) {
  const client = createHttpRuntimeClient({ baseUrl, fetchImpl });
  await client.resumeRun(runtimeRunId, { waitId, input });
  return await client.getRun(runtimeRunId);
}
