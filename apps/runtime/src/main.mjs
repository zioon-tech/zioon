import { shutdownTelemetry } from "./telemetry/bootstrap.mjs";
import { homedir } from "node:os";
import { readFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { AccountWorkspaceProvisioner } from "./sandbox/account-workspace-provisioner.mjs";
import { AliyunAccountStorage } from "./sandbox/aliyun-account-storage.mjs";
import { AccountRuntimeGateway } from "./accounts/account-runtime-gateway.mjs";
import { sandboxConfig } from "../../../packages/sandbox/src/config.mjs";
import { ManagedSandboxProvider } from "../../../packages/sandbox/src/provider.mjs";
import { SandboxToolBroker } from "./sandbox/sandbox-tool-broker.mjs";
import { PostgresSandboxStore } from "./sandbox/postgres-sandbox-store.mjs";
import { createSandboxHttpHandler } from "./sandbox/sandbox-http-handler.mjs";
import { ManagedNodeToolRouter } from "./sandbox/managed-node-router.mjs";
import { SandboxTerminalService } from "./sandbox/sandbox-terminal-service.mjs";
import { join } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import pg from "pg";
import {
  createAgentExecutor,
  OpenAICompatibleEngine
} from "../../../packages/runtime/dist/index.js";
import { RuntimeAccessControl } from "./access-control.mjs";
import { AccountAccessControl } from "./accounts/account-access-control.mjs";
import { createPlatformNodePolicy } from "./accounts/platform-node-policy.mjs";
import { PostgresAccountStore } from "./accounts/postgres-account-store.mjs";
import { createOidcProvider } from "./accounts/oidc-provider.mjs";
import { createSharedAccountProvider, sharedAccountKey } from "./accounts/shared-account-provider.mjs";
import { createAccountAppHandoff } from "./accounts/account-app-handoff.mjs";
import { PlatformAdminService } from "./platform-admin/service.mjs";
import { createPlatformAdminHandler } from "./platform-admin/http-handler.mjs";
import { createMemoryAccountAuthorization } from "./accounts/memory-account-connection.mjs";
import { createAccountExecutionAuthority } from "./accounts/execution-authority.mjs";
import { bindRuntimeDataDirectory } from "./accounts/data-directory-binding.mjs";
import { createAgentRunnerPluginService } from "./agent-runner-plugin-service.mjs";
import { createAssetHttpHandler } from "./asset-http-handler.mjs";
import { AssetInputEngine } from "./asset-input-engine.mjs";
import { AssetService } from "./asset-service.mjs";
import { createRuntimeCollaborationService } from "./collaboration-service.mjs";
import {
  createDeviceServiceHttpHandler,
  createDeviceServiceWebSocketHandler
} from "./device-service-http-handler.mjs";
import { EnvironmentCredentialProvider } from "./environment-credential-provider.mjs";
import { createFetchModelTransport } from "./fetch-model-transport.mjs";
import { LocalFilesystemBlobStore } from "./local-filesystem-blob-store.mjs";
import {
  createDefaultInteractionProfile,
  createDefaultScheduledInteractionProfile,
  DEFAULT_INTERACTION_PROFILE_ID,
  DEFAULT_INTERACTIVE_READONLY_TOOL_NAMES,
  DEFAULT_INTERACTION_MODEL_PROFILE_ID,
  DEFAULT_SCHEDULED_INTERACTION_PROFILE_ID,
  FileInteractionProfileStore,
  resolveInteractionRequest
} from "./interaction-profile-store.mjs";
import { migrateLegacyLocalToolsState } from "./legacy-local-tools-state-migration.mjs";
import {
  LOCAL_TOOLS_TOOL_DEFINITIONS,
  LocalToolsBroker
} from "./local-tools-broker.mjs";
import { formatByteSize, parseByteSize } from "../../../packages/node-protocol/src/index.mjs";
import { createModelGatewayHttpHandler } from "./model-gateway-http-handler.mjs";
import { FileModelProfileStore } from "./model-profile-store.mjs";
import { createBuiltinModelRegistry } from "./model-registry.mjs";
import {
  createModelRequestPublisher,
  observeRunModelRequests
} from "./model-request-observability.mjs";
import { createJaegerTraceReader } from "./observability/jaeger-trace-reader.mjs";
import { createObservabilityHttpHandler } from "./observability/observability-http-handler.mjs";
import { createRuntimeObservabilityService } from "./observability/observability-service.mjs";
import {
  PostgresObservabilityProjection
} from "./observability/postgres-projection.mjs";
import { AnalysisToolBroker } from "./observability/analysis-tool-broker.mjs";
import { NodeBroker } from "./node-broker.mjs";
import { createNodeHttpHandler } from "./node-http-handler.mjs";
import { createPluginFileService } from "./plugin-file-service.mjs";
import { createAgentFsMemoryClient, createAgentFsMemoryLocations } from "./agentfs-memory-client.mjs";
import { createAgentFsMcpClient } from "./agentfs-mcp-client.mjs";
import { AGENTFS_MCP_READ_NAMES } from "../../../packages/plugin-sdk/src/agentfs-mcp-policy.mjs";
import { createPluginFilesHttpHandler } from "./plugin-files-http-handler.mjs";
import { createDeviceServiceClient } from "./device-service-client.mjs";
import { resolvePluginDataHost } from "./plugin-data-host.mjs";
import { createPluginDataLocations, createPluginLocationsHttpHandler } from "./plugin-data-locations.mjs";
import { PluginDataToolRouter } from "./plugin-data-tool-router.mjs";
import { createPluginDataFileHost } from "../../../packages/local-tools-client/src/plugin-data-files.mjs";
import { createPluginHostService } from "./plugin-host-service.mjs";
import { createPluginModelService } from "./plugin-model-service.mjs";
import { syncRuntimePluginSkillsCatalog } from "./plugin-skills-catalog.mjs";
import { createProjectAutomationHttpHandler } from "./project-automation-http-handler.mjs";
import {
  createTerminalManagementService
} from "./terminal-management-service.mjs";
import {
  modelRefForProfile,
  ProfileRoutingEngine
} from "./profile-routing-engine.mjs";
import { RuntimePluginService } from "./runtime-plugin-service.mjs";
import {
  RUNTIME_NATIVE_TOOL_DEFINITIONS,
  RUNTIME_TOOL_DEFINITIONS,
  RuntimeToolBroker
} from "./runtime-tool-broker.mjs";
import { createSchedulerHttpHandler } from "./scheduler-http-handler.mjs";
import { RuntimeSchedulerWorker } from "./scheduler-worker.mjs";
import { createRuntimeHealthProvider } from "./runtime-health.mjs";
import { createRuntimeServer } from "./server.mjs";
import { createSkillsCatalogHttpHandler } from "./skills-catalog-http-handler.mjs";
import { MarketplaceService } from "./marketplace/service.mjs";
import { createMarketplaceHttpHandler } from "./marketplace/http-handler.mjs";
import { ExtensionExecutionService, withExtensionTools } from "./marketplace/execution-service.mjs";
import { ExtensionInvocationEngine } from "./marketplace/invocation-engine.mjs";
import { AccountExtensionModelCatalog, AccountExtensionModelEngine, isExtensionModel } from "./marketplace/model-engine.mjs";
import { AccountModelSelection, createModelManagementPluginService } from "./marketplace/model-selection.mjs";
import { ExtensionHostBridge } from "./marketplace/host-bridge.mjs";
import { ExtensionRunBindings, extensionTerminalOutbox } from "./marketplace/run-bindings.mjs";
import { ExtensionOutbox } from "./marketplace/outbox.mjs";
import { EXTENSION_HOST_TOOL } from "../../../packages/plugin-sdk/src/host-contract.mjs";
import { PostgresAccessStore } from "./postgres-access-store.mjs";
import { PostgresAssetStore } from "./postgres-asset-store.mjs";
import { PostgresNodeStateStore } from "./postgres-node-state-store.mjs";
import { PostgresRunStore } from "./postgres-run-store.mjs";
import { PostgresWebhookStore } from "./postgres-webhook-store.mjs";
import { RuntimeWebhookWorker } from "./webhook-worker.mjs";
import { createWebhookHttpHandler } from "./webhook-http-handler.mjs";
import { createExtensionHttpTransport } from "./extension-http-transport.mjs";
import { loadRuntimeHookAdapters } from "./runtime-hook-adapters.mjs";
import { initializePostgresRuntimeSchema } from "./postgres-runtime-schema.mjs";
import { PostgresSchedulerStore } from "./postgres-scheduler-store.mjs";
import {
  PostgresWorkbenchStateStore
} from "./postgres-workbench-state-store.mjs";
import { startStorageMaintenance } from "./storage-maintenance.mjs";
import { createWorkbenchStaticHttpHandler } from "./workbench-static-http-handler.mjs";
import { createWorkbenchStateHttpHandler } from "./workbench-state-http-handler.mjs";
import { createPluginDevelopmentHttpHandler } from "./plugin-development-http-handler.mjs";
import {
  SKILLS_RUNTIME_KV_KEY,
  SKILLS_RUNTIME_SOURCES_KV_KEY
} from "../../../extensions/dev.skills/skills-runtime-shared.js";

const { Pool } = pg;
const runtimeStartedAt = Date.now();

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function parsePluginIds(value) {
  const source = String(value || "").trim();
  if (!source || source.toLowerCase() === "none") return [];
  return [...new Set(source.split(",").map((id) => id.trim()).filter(Boolean))];
}

function parseList(value) {
  return [...new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  )];
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function enabledFlag(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase()
  );
}

const DEFAULT_PROFILE_TOOLSET_VERSION = 26;
const SANDBOX_TERMINAL_PROFILE_ID = "internal.sandbox-terminal";
const SANDBOX_TERMINAL_POLICY = Object.freeze({
  preset: "trusted-automation",
  allowedTools: ["Bash", "read", "write", "edit", "glob", "grep", "tree"],
  fileRoots: ["/"],
  allowedCommandPrefixes: [],
  allowedTerminalSessionIds: [],
  allowedRecipients: [],
  maxToolCalls: 1,
  maxMailPerRun: 0
});
const DEFAULT_SCHEDULED_READONLY_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "tree",
  "webSearch",
  "webFetch",
  "skillsList",
  "memoryList",
  "identityContext",
  ...AGENTFS_MCP_READ_NAMES,
  "observabilityQuery",
  "observabilityRawRead"
]);

function mergeDefaultProfileTools(store, profile, {
  profileId,
  availableToolNames = [],
  allowedToolNames = null,
  excludedToolNames = new Set(),
  replaceDefaultTools = false,
  version = DEFAULT_PROFILE_TOOLSET_VERSION
} = {}) {
  if (!profile || profile.id !== profileId || !store?.patch) return profile;
  const currentVersion = Number(profile.metadata?.defaultToolSetVersion || 0);
  if (currentVersion >= version) return profile;
  const userManaged = profile.metadata?.toolSelectionUserManaged === true;
  const allowed = new Set(
    replaceDefaultTools && !userManaged
      ? []
      : Array.isArray(profile.policy?.allowedTools)
        ? profile.policy.allowedTools.map(String).filter(Boolean)
        : []
  );
  allowed.delete("biographyQuery");
  const allowedSet = allowedToolNames
    ? new Set(Array.from(allowedToolNames).map(String).filter(Boolean))
    : null;
  for (const name of availableToolNames) {
    const value = String(name || "").trim();
    if (!value || excludedToolNames.has(value)) continue;
    if (allowedSet && !allowedSet.has(value)) continue;
    allowed.add(value);
  }
  return store.patch(profileId, {
    policy: {
      allowedTools: Array.from(allowed),
      ...(replaceDefaultTools && !userManaged ? { preset: "read-only" } : {})
    },
    metadata: {
      defaultToolSetVersion: version
    }
  });
}

class EchoEngine {
  id = "zion.echo";

  async *streamTurn(request) {
    const lastUser = request.messages
      .slice()
      .reverse()
      .find((message) => message.role === "user");
    yield {
      type: "message.delta",
      delta: `[echo] ${lastUser?.content || ""}`
    };
  }
}

function createEngine(mode, credentials, models, preferredProfileId = "") {
  if (mode === "echo") {
    const profile = {
      id: "echo",
      label: "Echo (development only)",
      providerId: "runtime",
      providerType: "echo",
      model: "echo",
      capabilities: {}
    };
    return {
      engine: new EchoEngine(),
      profile,
      profiles: [profile],
      resolveModel(requested) {
        if (
          requested
          && requested.profileId !== profile.id
          && requested.modelId !== profile.model
        ) {
          const error = new Error(
            `Runtime model profile is not active: ${requested.profileId || requested.modelId}`
          );
          error.statusCode = 409;
          throw error;
        }
        return modelRefForProfile(profile);
      }
    };
  }
  if (mode !== "openai") {
    throw new Error(`Unsupported Runtime engine: ${mode}`);
  }
  const hasPreferredWorkbenchModel = models.list().some(
    (item) => item.id === DEFAULT_INTERACTION_MODEL_PROFILE_ID
  );
  const profileId = readArg(
    "--model-profile",
    process.env.ZION_RUNTIME_MODEL_PROFILE
      || preferredProfileId
      || (
        hasPreferredWorkbenchModel
          ? DEFAULT_INTERACTION_MODEL_PROFILE_ID
          : models.defaultProfileId
      )
  );
  if (profileId) {
    const profile = models.get(profileId);
    const engine = new ProfileRoutingEngine({
      registry: models,
      activeProfileId: profile.id,
      createEngine(selected) {
        return new OpenAICompatibleEngine({
          id: `openai-compatible:${selected.id}`,
          endpoint: selected.endpoint,
          model: selected.model,
          credentialProvider: credentials,
          credentialRef: selected.credentialRef,
          credentialRequired: selected.credentialRequired,
          temperature: selected.temperature,
          maxOutputTokens: selected.maxOutputTokens,
          requestBody: selected.requestBody,
          observeTimings: true,
          transport: createFetchModelTransport()
        });
      }
    });
    return {
      engine,
      profile,
      profiles: models.list(),
      resolveModel: (requested) => engine.resolveModel(requested)
    };
  }
  const endpoint = readArg("--model-url", process.env.ZION_RUNTIME_MODEL_URL || "");
  const model = readArg("--model", process.env.ZION_RUNTIME_MODEL_ID || "");
  if (!endpoint || !model) {
    throw new Error(
      "OpenAI-compatible engine requires ZION_RUNTIME_MODEL_URL and ZION_RUNTIME_MODEL_ID"
    );
  }
  const profile = {
    id: "runtime-default",
    label: model,
    providerId: String(process.env.ZION_RUNTIME_PROVIDER_ID || "runtime"),
    providerType: "openai",
    endpoint,
    model,
    capabilities: {}
  };
  const engine = new OpenAICompatibleEngine({
      id: "openai-compatible",
      endpoint,
      model,
      credentialProvider: credentials,
      credentialRef: "model.default",
      credentialRequired: process.env.ZION_RUNTIME_API_KEY_REQUIRED === "1",
      observeTimings: true,
      transport: createFetchModelTransport()
  });
  return {
    engine,
    profile,
    profiles: [profile],
    resolveModel(requested) {
      if (
        requested
        && requested.profileId !== profile.id
        && requested.modelId !== profile.model
      ) {
        const error = new Error(
          `Runtime model profile is not active: ${requested.profileId || requested.modelId}`
        );
        error.statusCode = 409;
        throw error;
      }
      return modelRefForProfile(profile);
    }
  };
}

const host = readArg("--host", process.env.ZION_RUNTIME_HOST || "127.0.0.1");
const port = Number(readArg("--port", process.env.ZION_RUNTIME_PORT || "8766"));
const engineMode = readArg("--engine", process.env.ZION_RUNTIME_ENGINE || "echo");
const toolMode = readArg(
  "--tool-mode",
  process.env.ZION_RUNTIME_TOOL_MODE || "local"
);
const authMode = readArg("--auth-mode", process.env.ZION_RUNTIME_AUTH_MODE || "pairing");
if (!["pairing", "accounts"].includes(authMode)) throw new Error("Unknown Runtime auth mode");
const accountsEnabled = authMode === "accounts";
const databaseUrl = String(process.env.ZION_DATABASE_URL || "").trim();
const runtimeSpaceId = String(process.env.ZION_SPACE_ID || "").trim();
if (!databaseUrl) {
  throw new Error("ZION_DATABASE_URL is required");
}
if (!runtimeSpaceId) {
  throw new Error("ZION_SPACE_ID is required");
}
const dataDirectory = readArg(
  "--data-dir",
  process.env.ZION_RUNTIME_DATA_DIR || join(homedir(), ".zion-next", "runtime")
);
const assetDirectory = join(dataDirectory, "assets");
const workbenchDist = readArg(
  "--workbench-dist",
  process.env.ZION_RUNTIME_WORKBENCH_DIST || ""
);
const modelProfilePath = readArg(
  "--model-profiles",
  process.env.ZION_RUNTIME_MODEL_PROFILES
    || join(dataDirectory, "model-profiles.json")
);
const credentialStorePath = readArg(
  "--credential-store",
  process.env.ZION_RUNTIME_CREDENTIAL_STORE
    || join(dataDirectory, "credentials.json")
);
const interactionProfilePath = readArg(
  "--interaction-profiles",
  process.env.ZION_RUNTIME_INTERACTION_PROFILES
    || join(dataDirectory, "interaction-profiles.json")
);
const defaultInteractionModelProfileId = readArg(
  "--default-interaction-model-profile",
  process.env.ZION_RUNTIME_DEFAULT_INTERACTION_MODEL_PROFILE || ""
);
const localToolsUrl = readArg(
  "--local-tools-url",
  process.env.ZION_LOCAL_TOOLS_URL || "http://127.0.0.1:8765"
);
const pluginServiceUrl = readArg(
  "--plugin-service-url",
  process.env.ZION_PLUGIN_SERVICE_URL || "http://127.0.0.1:8767"
);
const observabilityQueryUrl = readArg(
  "--observability-query-url",
  process.env.ZION_OBSERVABILITY_QUERY_URL || ""
);
const observabilityQueryToken =
  process.env.ZION_OBSERVABILITY_QUERY_TOKEN || "";
const observabilityTraceUrlTemplate =
  process.env.ZION_OTEL_TRACE_URL_TEMPLATE || "";
const pluginRoot = readArg(
  "--plugin-root",
  process.env.ZION_RUNTIME_PLUGIN_ROOT
    || fileURLToPath(new URL("../../../extensions/", import.meta.url))
);
const externalPluginRoot = readArg(
  "--external-plugin-root",
  process.env.ZION_RUNTIME_EXTERNAL_PLUGIN_ROOT
    || join(homedir(), ".zion-next", "plugins")
);
const externalizedRuntimePluginIds = parsePluginIds(readArg(
  "--external-runtime-plugins",
  process.env.ZION_RUNTIME_EXTERNAL_PLUGINS ?? (accountsEnabled ? "" : "dev.identity")
));
const enabledRuntimePluginIds = parsePluginIds(readArg(
  "--runtime-plugins",
  process.env.ZION_RUNTIME_PLUGINS
    || (toolMode !== "local" ? "none" : "dev.terminal-manager,dev.skills,dev.memory,dev.identity,dev.context-compression,dev.goal,dev.scheduler,dev.session-manager,dev.langchain-chat,dev.tools,dev.plugins,dev.mail,dev.agents,dev.observability")
));
const nodeToken = process.env.ZION_RUNTIME_NODE_TOKEN || "";
const accessControlEnabled = accountsEnabled || enabledFlag(readArg(
  "--access-control",
  process.env.ZION_RUNTIME_ACCESS_CONTROL || "0"
));
const publicBaseUrl = readArg(
  "--public-url",
  process.env.ZION_RUNTIME_PUBLIC_URL || ""
);
const allowedOrigins = parseList(readArg(
  "--allowed-origins",
  process.env.ZION_RUNTIME_ALLOWED_ORIGINS || ""
));
if (publicBaseUrl) {
  try {
    allowedOrigins.push(new URL(publicBaseUrl).origin);
  } catch {
    throw new Error("Runtime public URL is invalid");
  }
}
const allowInsecureRemote = enabledFlag(readArg(
  "--allow-insecure-remote",
  process.env.ZION_RUNTIME_ALLOW_INSECURE_REMOTE || "0"
));
const invocationLeaseMs = positiveInteger(
  readArg(
    "--invocation-lease-ms",
    process.env.ZION_RUNTIME_INVOCATION_LEASE_MS || "120000"
  ),
  "Runtime invocation lease"
);
const invocationDeliveryGraceMs = positiveInteger(
  readArg(
    "--invocation-delivery-grace-ms",
    process.env.ZION_RUNTIME_INVOCATION_DELIVERY_GRACE_MS || "30000"
  ),
  "Runtime invocation delivery grace"
);
const runtimeMaxRequestBytes = parseByteSize(
  readArg(
    "--max-request-bytes",
    process.env.ZION_RUNTIME_MAX_REQUEST_BYTES || "1MiB"
  ),
  { label: "Runtime request body limit" }
);
const assetMaxImageBytes = parseByteSize(
  readArg(
    "--asset-max-image-bytes",
    process.env.ZION_RUNTIME_ASSET_MAX_IMAGE_BYTES || "16MiB"
  ),
  { label: "Runtime image Asset limit" }
);
const deviceServiceMaxRequestBytes = parseByteSize(
  readArg(
    "--device-service-max-request-bytes",
    process.env.ZION_RUNTIME_DEVICE_SERVICE_MAX_REQUEST_BYTES
      || process.env.ZION_RUNTIME_MAX_REQUEST_BYTES
      || "1MiB"
  ),
  { label: "Runtime Device service request body limit" }
);
const schedulerMaxRequestBytes = parseByteSize(
  readArg(
    "--scheduler-max-request-bytes",
    process.env.ZION_RUNTIME_SCHEDULER_MAX_REQUEST_BYTES
      || process.env.ZION_RUNTIME_MAX_REQUEST_BYTES
      || "1MiB"
  ),
  { label: "Runtime Scheduler request body limit" }
);
const nodeHttpMaxRequestBytes = parseByteSize(
  readArg(
    "--node-http-max-request-bytes",
    process.env.ZION_RUNTIME_NODE_HTTP_MAX_REQUEST_BYTES || "8MiB"
  ),
  { label: "Runtime Node HTTP request body limit" }
);
const modelRequestDetailMaxBytes = parseByteSize(
  process.env.ZION_RUNTIME_MODEL_REQUEST_DETAIL_MAX_BYTES || "8MiB",
  { label: "Runtime model request detail limit" }
);
const modelRequestDetailMaxRows = positiveInteger(
  process.env.ZION_RUNTIME_MODEL_REQUEST_DETAIL_MAX_ROWS || "2000",
  "Runtime model request detail row limit"
);
const modelRequestDetailMaxStoredBytes = parseByteSize(
  process.env.ZION_RUNTIME_MODEL_REQUEST_DETAIL_MAX_STORED_BYTES || "256MiB",
  { label: "Runtime model request detail storage limit" }
);
const modelRequestDetailRetentionMs = positiveInteger(
  process.env.ZION_RUNTIME_MODEL_REQUEST_DETAIL_RETENTION_DAYS || "30",
  "Runtime model request detail retention days"
) * 24 * 60 * 60_000;
const schedulerWorkerEnabled = enabledFlag(readArg(
  "--scheduler-worker",
  process.env.ZION_RUNTIME_SCHEDULER_WORKER || "1"
));
const schedulerPollIntervalMs = positiveInteger(
  readArg(
    "--scheduler-poll-ms",
    process.env.ZION_RUNTIME_SCHEDULER_POLL_MS || "3000"
  ),
  "Runtime Scheduler poll interval"
);
const projectAutomationWorkerEnabled = enabledFlag(readArg(
  "--project-automation-worker",
  process.env.ZION_RUNTIME_PROJECT_AUTOMATION_WORKER || "1"
));
const projectAutomationPollIntervalMs = positiveInteger(
  readArg(
    "--project-automation-poll-ms",
    process.env.ZION_RUNTIME_PROJECT_AUTOMATION_POLL_MS || "60000"
  ),
  "Runtime Project Automation poll interval"
);
const legacyStateMigrationEnabled = enabledFlag(readArg(
  "--migrate-local-tools-state",
  process.env.ZION_RUNTIME_MIGRATE_LOCAL_TOOLS_STATE || "1"
));
const storageMaintenanceEnabled = enabledFlag(readArg(
  "--storage-maintenance",
  process.env.ZION_RUNTIME_STORAGE_MAINTENANCE || "1"
));
const storageMaintenanceBatchRows = positiveInteger(readArg(
  "--storage-maintenance-batch-rows",
  process.env.ZION_RUNTIME_STORAGE_MAINTENANCE_BATCH_ROWS || "1000"
), "Runtime storage maintenance batch rows");
const storageMaintenanceIntervalMs = positiveInteger(readArg(
  "--storage-maintenance-interval-ms",
  process.env.ZION_RUNTIME_STORAGE_MAINTENANCE_INTERVAL_MS || "250"
), "Runtime storage maintenance interval");
if (!["local", "node", "sandbox"].includes(toolMode)) {
  throw new Error(`Unsupported Runtime tool mode: ${toolMode}`);
}
if (toolMode === "sandbox" && (!accountsEnabled
  || !enabledFlag(process.env.ZION_ACCOUNT_ALLOW_RESOURCE_EXECUTION)
  || !process.env.ZION_SANDBOX_BINDINGS_FILE)) {
  throw new Error("Sandbox mode requires accounts, resource execution and ZION_SANDBOX_BINDINGS_FILE");
}
if (toolMode === "node" && !nodeToken && !accessControlEnabled) {
  throw new Error(
    "Node tool mode requires Access Control or ZION_RUNTIME_NODE_TOKEN"
  );
}

const postgresPool = new Pool({
  connectionString: databaseUrl,
  max: positiveInteger(
    process.env.ZION_DATABASE_POOL_SIZE || "10",
    "Database pool size"
  ),
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  ...(process.env.ZION_DATABASE_SSL === "disable" ? { ssl: false } : {}),
  application_name: "zion-runtime"
});
const accountStore = accountsEnabled
  ? await new PostgresAccountStore({ pool: postgresPool }).initialize()
  : null;
const marketplace = accountStore ? await new MarketplaceService({
  pool: postgresPool,
  defaultExecutionConfig: toolMode === "sandbox" ? async () => ({
    nodeId: "managed:account", workspaceRoot: "/workspace"
  }) : undefined,
  reviewerIds: String(process.env.ZION_MARKETPLACE_REVIEWER_IDS || "").split(",").filter(Boolean)
}).initialize() : null;
await initializePostgresRuntimeSchema(postgresPool);
const extensionTrustedOrigins = parseList(process.env.ZION_RUNTIME_EXTENSION_TRUSTED_ORIGINS);
const extensionTransport = createExtensionHttpTransport({ trustedOrigins: extensionTrustedOrigins });
const configuredRunControllers = await loadRuntimeHookAdapters(process.env.ZION_RUNTIME_HOOKS_FILE, {
  trustedOrigins: extensionTrustedOrigins,
  transport: extensionTransport,
  allowScripts: enabledFlag(process.env.ZION_RUNTIME_ALLOW_SCRIPT_HOOKS)
});
const webhookWorker = new RuntimeWebhookWorker({
  pool: postgresPool, transport: extensionTransport,
  onError: (code) => process.stderr.write(`[runtime-webhooks] ${code}\n`)
});
const automaticWorkspaces = toolMode === "sandbox"
  && enabledFlag(process.env.ZION_SANDBOX_AUTO_PROVISION);
const sharedSandboxBindings = toolMode === "sandbox"
  ? JSON.parse(await readFile(process.env.ZION_SANDBOX_BINDINGS_FILE, "utf8"))
  : null;
const workspaceProvisioner = automaticWorkspaces
  ? await new AccountWorkspaceProvisioner({
      pool: postgresPool,
      bindings: sharedSandboxBindings,
      cloud: new AliyunAccountStorage(JSON.parse(
        await readFile(process.env.ZION_SANDBOX_PROVISIONING_CONFIG, "utf8")
      )),
      onError: ({ accountId, code }) => process.stderr.write(
        `[runtime-onboarding] account=${accountId} code=${code}\n`
      )
    }).initialize()
  : null;

async function createSpaceRuntime({
  runtimeSpaceId: selectedSpaceId,
  dataDirectory: selectedDataDirectory,
  modelProfilePath: selectedModelProfilePath,
  credentialStorePath: selectedCredentialStorePath,
  interactionProfilePath: selectedInteractionProfilePath,
  platformContext = null
} = {}) {
const startupCleanup = [];
try {
const runtimeSpaceId = selectedSpaceId || String(process.env.ZION_SPACE_ID || "");
const dataDirectory = selectedDataDirectory || readArg(
  "--data-dir", process.env.ZION_RUNTIME_DATA_DIR || join(homedir(), ".zion-next", "runtime")
);
const modelProfilePath = selectedModelProfilePath || readArg(
  "--model-profiles", process.env.ZION_RUNTIME_MODEL_PROFILES || join(dataDirectory, "model-profiles.json")
);
const credentialStorePath = selectedCredentialStorePath || readArg(
  "--credential-store", process.env.ZION_RUNTIME_CREDENTIAL_STORE || join(dataDirectory, "credentials.json")
);
const interactionProfilePath = selectedInteractionProfilePath || readArg(
  "--interaction-profiles", process.env.ZION_RUNTIME_INTERACTION_PROFILES || join(dataDirectory, "interaction-profiles.json")
);
const assetDirectory = join(dataDirectory, "assets");
const schedulerWorkerEnabled = !platformContext && enabledFlag(readArg(
  "--scheduler-worker", process.env.ZION_RUNTIME_SCHEDULER_WORKER || "1"
));
const projectAutomationWorkerEnabled = !platformContext && enabledFlag(readArg(
  "--project-automation-worker", process.env.ZION_RUNTIME_PROJECT_AUTOMATION_WORKER || "1"
));
const runtimeSpace = accountStore
  ? await accountStore.space(runtimeSpaceId)
  : null;
if (accountStore && !runtimeSpace) {
  throw new Error(
    `Account database does not contain the configured Runtime Space: ${runtimeSpaceId}`
  );
}
const pluginDataNodeId = readArg(
  "--plugin-data-node-id",
  process.env.ZION_PLUGIN_DATA_NODE_ID || ""
);
const pluginDataHost = resolvePluginDataHost({
  host: readArg(
    "--plugin-data-host",
    process.env.ZION_PLUGIN_DATA_HOST || "auto"
  ),
  nodeId: pluginDataNodeId,
  toolMode
});
const pluginDataRoot = readArg(
  "--plugin-data-root",
  process.env.ZION_PLUGIN_DATA_ROOT
    || (pluginDataHost.managed
      ? "/workspace/.zion/plugin-data"
      : join(dataDirectory, "plugins"))
);
const pluginDataScope = readArg(
  "--plugin-data-scope",
  process.env.ZION_PLUGIN_DATA_SCOPE
    || (pluginDataHost.managed ? "account" : "legacy")
);
const pluginDataLegacyReadAccountId = readArg(
  "--plugin-data-legacy-read-account-id",
  process.env.ZION_PLUGIN_DATA_LEGACY_READ_ACCOUNT_ID || ""
);
if (pluginDataHost.ambiguousLegacyRouting) {
  process.stderr.write(
    "[runtime-plugin-data] auto mode preserves legacy local file hosting "
    + "while publishing a Node id; configure ZION_PLUGIN_DATA_HOST=runtime "
    + "or node before production migration\n"
  );
}
const sharedAccountIssuer = String(process.env.ZIOON_ACCOUNT_ISSUER || "").trim();
const oidcProvider = accountStore ? await (sharedAccountIssuer ? createSharedAccountProvider : createOidcProvider)({
  store: accountStore,
  issuer: sharedAccountIssuer || process.env.ZION_OIDC_ISSUER,
  ...(sharedAccountIssuer ? {
    adcOrigin: process.env.ZIOON_ADC_ORIGIN,
    key: await sharedAccountKey(process.env.ZIOON_ACCOUNT_SESSION_KEY_FILE)
  } : {}),
  clientId: process.env.ZION_OIDC_CLIENT_ID,
  clientSecret: process.env.ZION_OIDC_CLIENT_SECRET || "",
  publicBaseUrl,
  audience: process.env.ZION_OIDC_API_AUDIENCE || "",
  requiredScope: process.env.ZION_OIDC_API_SCOPE || "zion.api",
  activeSpaceId: runtimeSpaceId,
  onSessionCreated: workspaceProvisioner
    ? (user) => workspaceProvisioner.ensure(user.id)
    : null,
  allowLoopbackHttp: enabledFlag(process.env.ZION_ACCOUNT_ALLOW_LOOPBACK_HTTP)
}) : null;
startupCleanup.push(() => oidcProvider?.close());
const webhooks = new PostgresWebhookStore(postgresPool, { spaceId: runtimeSpaceId });
const runs = new PostgresRunStore(postgresPool, {
  spaceId: runtimeSpaceId,
  webhooks,
  modelRequestDetailMaxBytes,
  modelRequestDetailMaxRows,
  modelRequestDetailMaxStoredBytes,
  modelRequestDetailRetentionMs
});
startupCleanup.push(() => runs.close());
const assetMetadata = new PostgresAssetStore(postgresPool, {
  spaceId: runtimeSpaceId
});
bindRuntimeDataDirectory({
  dataDirectory,
  spaceId: runtimeSpaceId,
  paths: [
    { path: modelProfilePath }, { path: credentialStorePath }, { path: interactionProfilePath },
    ...(pluginDataHost.localFiles
      ? [{ path: pluginDataRoot, directory: true }]
      : []),
    { path: assetDirectory, directory: true }
  ]
});
const blobStore = await new LocalFilesystemBlobStore({
  root: assetDirectory
}).initialize();
const assetService = new AssetService({
  blobs: blobStore,
  metadata: assetMetadata,
  maxImageBytes: assetMaxImageBytes
});
const workbenchState = await new PostgresWorkbenchStateStore(postgresPool, {
  spaceId: runtimeSpaceId
}).initialize();
startupCleanup.push(() => workbenchState.close());
const accessStore = accessControlEnabled
  ? new PostgresAccessStore(postgresPool, { spaceId: runtimeSpaceId })
  : null;
const memoryServiceUrl = String(process.env.ZION_MEMORY_SERVICE_URL || "").trim();
const memoryAccountConnectionsDir = String(process.env.ZION_MEMORY_ACCOUNT_CONNECTIONS_DIR || "").trim();
const mcpEnabled = process.env.ZION_RUNTIME_MCP_ENABLED !== "0";
const memoryMcpEnabled = mcpEnabled && process.env.ZION_MEMORY_MCP_ENABLED !== "0";
if (memoryAccountConnectionsDir && memoryMcpEnabled) {
  throw new Error("Linked Memory accounts currently require ZION_MEMORY_MCP_ENABLED=0");
}
const memoryBridgeSecret = memoryServiceUrl && !memoryAccountConnectionsDir
  ? (await readFile(process.env.ZION_MEMORY_BRIDGE_SECRET_FILE || "", "utf8")).trim()
  : "";
if (memoryServiceUrl && !accountStore) throw new Error("agent-fs memory requires Zion account mode");
if (enabledRuntimePluginIds.includes("dev.identity") && !memoryServiceUrl) {
  throw new Error(
    "dev.identity requires ZION_MEMORY_SERVICE_URL; legacy plugin-data storage is no longer supported"
  );
}
const accessControl = accountStore
  ? new AccountAccessControl({
      accounts: accountStore,
      oidc: oidcProvider,
      store: accessStore,
      allowedOrigins,
      publicBaseUrl,
      trustedProxyAddresses: parseList(process.env.ZION_RUNTIME_TRUSTED_PROXY_ADDRESSES),
      memoryBridgeSecret,
      memoryEnabled: !!memoryServiceUrl,
      adcOrigin: process.env.ZIOON_ADC_ORIGIN || "",
      sharedAccountIssuer: process.env.ZIOON_ACCOUNT_ISSUER || "",
      servedSpaceId: runtimeSpaceId
    })
  : accessStore ? new RuntimeAccessControl({
      store: accessStore,
      allowedOrigins,
      publicBaseUrl,
      trustedProxyAddresses: parseList(process.env.ZION_RUNTIME_TRUSTED_PROXY_ADDRESSES)
    })
  : null;
const observabilityTraceReader = observabilityQueryUrl
  ? createJaegerTraceReader({
      baseUrl: observabilityQueryUrl,
      headers: observabilityQueryToken
        ? { authorization: `Bearer ${observabilityQueryToken}` }
        : {}
    })
  : null;
const observabilityService = createRuntimeObservabilityService({
  runs,
  traceReader: observabilityTraceReader,
  traceUrlTemplate: observabilityTraceUrlTemplate
});
const observabilityProjectionOptions = {
  runs,
  spaceId: runtimeSpaceId || "legacy",
  observability: observabilityService,
  retentionDays: process.env.ZION_OBSERVABILITY_RETENTION_DAYS,
  debounceMs: process.env.ZION_OBSERVABILITY_DEBOUNCE_MS,
  queryTimeoutMs: process.env.ZION_OBSERVABILITY_QUERY_TIMEOUT_MS,
  queryMaxRows: process.env.ZION_OBSERVABILITY_QUERY_MAX_ROWS,
  queryMaxBytes: process.env.ZION_OBSERVABILITY_QUERY_MAX_BYTES,
  onError({ code }) {
    process.stderr.write(
      `[runtime-observability] projection degraded: ${code}\n`
    );
  }
};
const observabilityProjection = await new PostgresObservabilityProjection({
  ...observabilityProjectionOptions,
  pool: postgresPool
}).initialize();
startupCleanup.push(() => observabilityProjection.stop());
const collaboration = createRuntimeCollaborationService({
  store: workbenchState,
  authenticate: accessControl
    ? (input) => accessControl.authenticateCollaboration(input)
    : null,
  reauthorize: accessControl
    ? (context) => accessControl.reauthorize(
        context?.principal,
        context?.readOnly ? "runtime.read" : "collaboration.write"
      )
    : null,
  authorizeOutbound: accountStore
    ? (context) => accessControl.reauthorize(context.principal, "runtime.read")
    : null,
  allowOrigin: accessControl
    ? (request) => accessControl.originAllowed(request.headers?.origin)
    : undefined
});
startupCleanup.push(() => collaboration.close());
const scheduler = new PostgresSchedulerStore(postgresPool, {
  spaceId: runtimeSpaceId
});
const interrupted = await runs.reconcileActiveRuns();
const projectedMessages = await runs.reconcileCompletedSessionMessages();
const modelProfileStore = new FileModelProfileStore(modelProfilePath);
const models = createBuiltinModelRegistry({
  additionalProfiles: modelProfileStore.list()
});
const platformModelRefs = new Map();
if (platformContext && engineMode === "openai") {
  for (const item of platformContext.listModelProfiles()) {
    const ref = `platform.${item.id}`;
    platformModelRefs.set(ref, item.credentialRef);
    models.upsert({ ...item, credentialRef: ref, metadata: { ...item.metadata, platformManaged: true } });
  }
}
const interactionProfileStore = new FileInteractionProfileStore(
  interactionProfilePath
);
if (accountStore) {
  accessControl.resolveProfile = (id) => {
    if (id === SANDBOX_TERMINAL_PROFILE_ID) {
      return { id, policy: SANDBOX_TERMINAL_POLICY };
    }
    return interactionProfileStore.get(id);
  };
}
const accountExecution = accountStore ? createAccountExecutionAuthority({
  accessControl, profiles: interactionProfileStore
}) : null;
const localCredentials = new EnvironmentCredentialProvider({
  storePath: credentialStorePath,
  ...(platformContext ? { environment: {}, bindings: {} } : { bindings: {
    "model.default": "ZION_RUNTIME_API_KEY",
    "model.deepseek": "ZION_RUNTIME_DEEPSEEK_API_KEY"
  } })
});
const credentials = platformContext ? {
  has: (ref) => platformModelRefs.has(ref)
    ? platformContext.credentials.has(platformModelRefs.get(ref))
    : localCredentials.has(ref),
  acquire: (request) => platformModelRefs.has(request.ref)
    ? platformContext.credentials.acquire({ ...request, ref: platformModelRefs.get(request.ref) })
    : localCredentials.acquire(request),
  set: (ref, value) => localCredentials.set(ref, value),
  delete: (ref) => localCredentials.delete(ref)
} : localCredentials;
const authorizeScheduledTask = accountStore ? (actor, input) => accessControl.authorizeTask(
  actor, input,
  interactionProfileStore.get(input.interactionProfileId || DEFAULT_SCHEDULED_INTERACTION_PROFILE_ID),
  input.id ? `scheduler:${input.id}` : "scheduler:new"
) : null;
const revokeTaskGrant = async (task) => {
  const principal = task?.executionPrincipal;
  if (accountStore && principal) {
    await accountStore.revokeGrant(
      principal.userId,
      principal.grantId,
      principal.spaceId
    );
  }
};
const {
  engine: configuredEngine,
  profile,
  profiles: runtimeModelProfiles,
  resolveModel
} = createEngine(engineMode, credentials, models, platformContext?.defaultModelProfileId);
let accountModelEngine;
const engine = new AssetInputEngine({
  engine: new ExtensionInvocationEngine({
    engine: { id: configuredEngine.id, async *streamTurn(request) {
      yield* (accountModelEngine || configuredEngine).streamTurn(request);
    } }, runs,
    resolvePluginTool: (pluginId, name) => runtimePlugins.getToolDefinitions()
      .find((tool) => tool.pluginId === pluginId && tool.name === name)
  }),
  assets: assetService,
  maxInlineBytes: assetMaxImageBytes
});
const importModelProfile = engineMode === "openai"
  ? ({ profile: input, credential }) => {
      const id = String(input?.id || "").trim();
      if (platformContext && platformModelRefs.has(`platform.${id}`)) {
        throw Object.assign(new Error("平台模型由平台管理，请添加自己的模型配置。"), {
          code: "platform_model_readonly", statusCode: 403
        });
      }
      const credentialRef = `model.${id}`;
      const imported = models.upsert({
        ...input,
        id,
        credentialRef
      });
      modelProfileStore.upsert(imported);
      const credentialValue = typeof credential === "string"
        ? credential
        : credential?.value;
      if (String(credentialValue || "").trim()) {
        credentials.set(credentialRef, {
          value: credentialValue,
          header: credential?.header || "authorization",
          prefix: credential?.prefix ?? "Bearer "
        });
      }
      return {
        profile: {
          ...imported,
          credentialConfigured: credentials.has(credentialRef)
        }
      };
    }
  : null;
const deleteModelProfile = engineMode === "openai"
  ? (profileId) => {
      if (platformContext && platformModelRefs.has(`platform.${profileId}`)) {
        throw Object.assign(new Error("平台模型由平台管理。"), {
          code: "platform_model_readonly", statusCode: 403
        });
      }
      const removed = modelProfileStore.delete(profileId);
      if (!removed) return null;
      const registryProfile = models.delete(profileId) || removed;
      const credentialRef = String(
        registryProfile?.credentialRef
        || removed?.credentialRef
        || `model.${profileId}`
      );
      credentials.delete(credentialRef);
      return {
        profile: {
          ...registryProfile,
          credentialConfigured: credentials.has(credentialRef)
        }
      };
    }
  : null;
const listModelProfiles = () => (
  engineMode === "openai" ? models.list() : runtimeModelProfiles
);
const listModelProfilesWithCredentialStatus = () => listModelProfiles()
  .map((item) => ({
    ...item,
    credentialConfigured: credentials.has(item.credentialRef)
  }));
const listAccountModelProfiles = async (principal) => [
  ...listModelProfilesWithCredentialStatus(), ...(accountModelCatalog ? await accountModelCatalog.list(principal) : [])
];
const resolveAccountModel = (requested, principal) => isExtensionModel(requested)
  ? accountModelCatalog.resolve(requested, principal) : resolveModel(requested);
const modelSelection = new AccountModelSelection({
  marketplace, listProfiles: listAccountModelProfiles, interactionProfiles: interactionProfileStore,
  resolveModel: resolveAccountModel, fallbackModel: modelRefForProfile(profile)
});
const localDataFiles = pluginDataHost.localFiles
  ? createPluginDataFileHost({ root: pluginDataRoot })
  : null;
const localTools = new LocalToolsBroker({
  baseUrl: localToolsUrl,
  dataFiles: localDataFiles,
  allowDangerousCommands: enabledFlag(process.env.ZION_ALLOW_DANGEROUS)
});
const nodeGatewayEnabled = ["node", "sandbox"].includes(toolMode) || !!nodeToken;
const nodeStateStore = nodeGatewayEnabled
  ? new PostgresNodeStateStore(postgresPool, {
      spaceId: runtimeSpaceId
    })
  : null;
const nodeBroker = nodeGatewayEnabled
  ? await new NodeBroker({
      invocationLeaseMs,
      invocationDeliveryGraceMs,
      stateStore: nodeStateStore,
      authorizeTarget: toolMode === "sandbox"
        ? createPlatformNodePolicy({
            nodeIds: parseList(process.env.ZION_PLATFORM_NODE_IDS || "node:cloud-runtime"),
            serviceGrantIds: parseList(process.env.ZION_PLATFORM_NODE_SERVICE_GRANT_IDS),
            accounts: accountStore
          })
        : null
    }).initialize()
  : null;
const restoredNodeState = nodeBroker?.snapshot();
startupCleanup.push(() => nodeBroker?.close());
const sandboxProvider = toolMode === "sandbox"
  ? new ManagedSandboxProvider(sandboxConfig(), { persistentHome: true })
  : null;
// Fail before serving health checks if the configured tool provider cannot load.
await sandboxProvider?.sdk();
const sandboxStore = toolMode === "sandbox"
  ? await new PostgresSandboxStore(postgresPool, {
      spaceId: runtimeSpaceId
    }).initialize()
  : null;
startupCleanup.push(() => sandboxStore?.close());
const sandboxBindings = toolMode === "sandbox"
  ? sharedSandboxBindings
  : null;
const sandboxTools = toolMode === "sandbox" ? new SandboxToolBroker({
  provider: sandboxProvider,
  store: sandboxStore,
  bindings: sandboxBindings,
  allowEmptyBindings: automaticWorkspaces,
  authorizeInvocation: (invocation) => accessControl.authorizeInvocation(invocation),
  idlePauseMs: Number(process.env.ZION_SANDBOX_IDLE_PAUSE_MS || 120000),
  idleDestroyMs: Number(process.env.ZION_SANDBOX_IDLE_DESTROY_MS || 1800000),
  onError: (error) => process.stderr.write(`[runtime-sandbox] ${error.message}\n`)
}) : null;
startupCleanup.push(() => sandboxTools?.close());
const authorizeSandboxActor = sandboxTools ? async (runContext = {}) => {
  const principal = runContext.principal;
  if (principal?.kind === "account") {
    return await accessControl.reauthorize(principal, "resource.execute");
  }
  const policy = await accessControl.authorizeRunExecution({
    principal,
    policy: runContext.policy
  });
  const grant = await accountStore.validateGrant(principal, policy);
  if (!grant.scopes.includes("resource.execute")) {
    const error = new Error("Managed workspace execution requires resource.execute");
    error.statusCode = 403;
    throw error;
  }
  return grant.principal;
} : null;
const withSandboxLifecycleGrant = sandboxTools
  ? async (runContext, operation) => {
      const actor = await authorizeSandboxActor(runContext);
      const userId = String(actor.userId || actor.user?.id || "");
      const spaceId = String(actor.spaceId || actor.space?.id || runtimeSpaceId);
      const policy = SANDBOX_TERMINAL_POLICY;
      const principal = await accountStore.issueGrant(userId, policy, {
        spaceId,
        profileId: SANDBOX_TERMINAL_PROFILE_ID,
        ttlMs: 5 * 60_000,
        scopes: ["run.execute", "resource.execute"]
      });
      try {
        return await operation({ principal, policy });
      } finally {
        await accountStore.revokeGrant(userId, principal.grantId, spaceId)
          .catch((error) => {
            process.stderr.write(
              `[runtime-sandbox] Failed to revoke terminal grant: ${error.message}\n`
            );
          });
      }
    }
  : null;
const sandboxTerminalService = sandboxTools ? new SandboxTerminalService({
  sandbox: sandboxTools,
  provider: sandboxProvider,
  store: sandboxStore,
  authorizeActor: authorizeSandboxActor,
  withLifecycleGrant: withSandboxLifecycleGrant,
  channelIdleMs: Number(process.env.ZION_SANDBOX_TERMINAL_CHANNEL_IDLE_MS || 45000),
  maxChannels: Number(process.env.ZION_SANDBOX_TERMINAL_MAX_CHANNELS || 8)
}) : null;
startupCleanup.push(() => sandboxTerminalService?.close());
const managedNodeTools = sandboxTools ? new ManagedNodeToolRouter({
  sandbox: sandboxTools,
  device: nodeBroker
}) : null;
const nodePluginDataLocations = createPluginDataLocations({
  root: pluginDataRoot,
  nodeId: pluginDataHost.locationNodeId,
  requireNode: pluginDataHost.requireNode,
  scope: pluginDataScope,
  accountVolume: pluginDataHost.accountVolume,
  resolveNodeId: pluginDataHost.managed
    ? (context = {}) => {
        const principal = context.principal
          || context.request?.principal
          || context;
        const target = managedNodeTools?.managedTarget(principal);
        if (!target) {
          const error = new Error(
            "Managed plugin data requires a bound account workspace"
          );
          error.statusCode = 403;
          throw error;
        }
        return target.nodeId;
      }
    : null,
  legacyReadAccountId: pluginDataLegacyReadAccountId
});
const pluginDataLocations = memoryServiceUrl
  ? createAgentFsMemoryLocations(nodePluginDataLocations, process.env.ZION_MEMORY_PUBLIC_URL || memoryServiceUrl, {
      accessMode: memoryMcpEnabled ? "mcp" : "cli"
    })
  : nodePluginDataLocations;
const executionTools = managedNodeTools
  || (toolMode === "node" ? nodeBroker : localTools);
const pluginDataNeedsRouter = pluginDataHost.managed
  || (pluginDataHost.localFiles && toolMode !== "local");
const delegatedTools = pluginDataNeedsRouter
  ? new PluginDataToolRouter({
      delegated: executionTools,
      dataHost: pluginDataHost.managed ? executionTools : localTools,
      locations: pluginDataLocations,
      pluginIds: enabledRuntimePluginIds.filter((id) => id !== "dev.identity")
    })
  : executionTools;
const analysisTools = new AnalysisToolBroker({
  delegated: delegatedTools,
  runs,
  accessControl: accountStore ? accessControl : null,
  allowResourceExecution: enabledFlag(process.env.ZION_ACCOUNT_ALLOW_RESOURCE_EXECUTION),
  projection: observabilityProjection
});
const pluginHostService = createPluginHostService({
  baseUrl: pluginServiceUrl,
  nodeBroker
});
const terminalManagementService = createTerminalManagementService({
  baseUrl: localToolsUrl,
  nodeBroker,
  managedSandbox: sandboxTerminalService
});
managedNodeTools?.setTerminalService(sandboxTerminalService);
function createSchedulerPluginService({
  scheduler,
  wakeWorker,
  availableTools,
  availableModels,
  availableNodes
}) {
  const refreshCapabilities = () => {
    if (typeof availableTools === "function") {
      scheduler.setAvailableTools(availableTools());
    }
    if (typeof availableNodes === "function") {
      scheduler.setAvailableNodes(availableNodes());
    }
  };
  const mergeTaskPatch = (current, patch = {}) => ({
    ...current,
    ...patch,
    revision: current.revision,
    schedule: {
      ...(current.schedule || {}),
      ...(patch.schedule || {})
    },
    capability: {
      ...(current.capability || {}),
      ...(patch.capability || {})
    }
  });
  return Object.freeze({
    listTasks: () => scheduler.listTasks(),
    getTask: (taskId) => scheduler.getTask(String(taskId || "")),
    async listRuns({ taskId = "", limit = 50, includeDetails = false } = {}) {
      return (await scheduler.listRuns({ taskId, limit, includeDetails })).runs || [];
    },
    async createTask(input = {}, meta = {}) {
      refreshCapabilities();
      const approved = authorizeScheduledTask
        ? await authorizeScheduledTask(meta.principal, input) : input;
      const task = await scheduler.createTask({
        ...approved,
        interactionProfileId: input.interactionProfileId || "scheduled.default"
      }, { availableModels: availableModels ? await availableModels(meta.principal) : undefined });
      wakeWorker?.();
      return task;
    },
    async updateTask(taskId, patch = {}, meta = {}) {
      refreshCapabilities();
      const current = await scheduler.getTask(String(taskId || ""));
      const input = mergeTaskPatch(current, patch);
      const approved = authorizeScheduledTask
        ? await authorizeScheduledTask(meta.principal, input) : input;
      const task = await scheduler.updateTask(current.id, approved, {
        availableModels: availableModels ? await availableModels(meta.principal) : undefined
      });
      await revokeTaskGrant(current);
      wakeWorker?.();
      return task;
    },
    async setEnabled(taskId, enabled, meta = {}) {
      const current = await scheduler.getTask(String(taskId || ""));
      const task = await scheduler.updateTask(current.id, {
        ...current,
        revision: current.revision,
        enabled: Boolean(enabled)
      }, { availableModels: availableModels ? await availableModels(meta.principal) : undefined });
      wakeWorker?.();
      return task;
    },
    async runNow(taskId) {
      const run = await scheduler.runNow(String(taskId || ""));
      wakeWorker?.();
      return run;
    },
    async deleteTask(taskId) {
      const previous = await scheduler.getTask(String(taskId || ""));
      await scheduler.deleteTask(String(taskId || ""));
      await revokeTaskGrant(previous);
      wakeWorker?.();
      return true;
    }
  });
}
function createSessionManagerPluginService({ workbenchState }) {
  return Object.freeze({
    async readSnapshot() {
      return await workbenchState.readSnapshot() || {
        snapshot: {
          version: 1,
          updatedAt: 0,
          tree: { id: "root", type: "folder", title: "Sessions", children: [] },
          index: [],
          docs: [],
          metas: []
        }
      };
    },
    readSession(sessionId) {
      return workbenchState.readSession(String(sessionId || ""));
    },
    createSession(input = {}) {
      return workbenchState.createSession(input);
    },
    updateSession(sessionId, patch = {}) {
      return workbenchState.updateSession(String(sessionId || ""), patch);
    },
    deleteSession(sessionId, input = {}) {
      return workbenchState.deleteSession(String(sessionId || ""), input);
    }
  });
}
function createToolsManagementPluginService({
  listTools,
  interactionProfiles
}) {
  return Object.freeze({
    listTools: () => listTools(),
    getProfile(profileId) {
      return interactionProfiles.get(String(profileId || ""));
    },
    patchProfile(profileId, patch = {}) {
      return interactionProfiles.patch(String(profileId || ""), patch);
    }
  });
}
function createMailManagementPluginService({
  interactionProfiles
}) {
  return Object.freeze({
    getProfile(profileId) {
      return interactionProfiles.get(String(profileId || ""));
    },
    patchProfile(profileId, patch = {}) {
      return interactionProfiles.patch(String(profileId || ""), patch);
    }
  });
}
let executor = null;
let tools = null;
let capabilityTools = () => [];
const identityFileService = memoryServiceUrl ? createPluginFileService({
  toolHost: delegatedTools,
  authorizeRequest: null,
  serializeInvocations: false,
  dataLocation: (runContext, options) =>
    pluginDataLocations.forPlugin("dev.identity", runContext, options),
  fileClient: createAgentFsMemoryClient({
    baseUrl: memoryServiceUrl,
    secret: memoryBridgeSecret,
    ...(memoryAccountConnectionsDir ? { authorizationProvider: createMemoryAccountAuthorization({
      directory: memoryAccountConnectionsDir, baseUrl: memoryServiceUrl, accessControl
    }) } : {})
  }),
  invocationPrefix: "dev.identity.file"
}) : null;
const identityMcpService = memoryMcpEnabled && memoryServiceUrl && enabledRuntimePluginIds.includes("dev.identity")
  ? createAgentFsMcpClient({ baseUrl: memoryServiceUrl, secret: memoryBridgeSecret })
  : null;
if (identityMcpService) await identityMcpService.discover();
const withIdentityFileHttpContext = async (
  actor,
  { access },
  operation
) => {
  if (!memoryServiceUrl || !accessControl) {
    throw Object.assign(new Error("Identity memory service is unavailable"), {
      statusCode: 503
    });
  }
  const principal = await accessControl.reauthorize(
    actor, access === "write" ? "runtime.write" : "runtime.read"
  );
  return await operation({ principal, policy: {
    preset: access === "write" ? "workspace-write" : "read-only",
    fileRoots: ["/memory/dev.identity"],
    allowedTerminalSessionIds: []
  } });
};
const publishModelRequest = createModelRequestPublisher({
  eventStore: workbenchState
});
const runModelRequestSubscription = observeRunModelRequests({
  runStore: runs,
  publish: publishModelRequest,
  onError(error, event) {
    process.stderr.write(
      `[runtime-model-observability:${event?.runId || "unknown"}] `
      + `${error?.message || String(error)}\n`
    );
  }
});
const agentRunnerService = createAgentRunnerPluginService({
  getExecutor: () => executor,
  interactionProfiles: interactionProfileStore,
  resolveModel
});
let projectAutomationService = null;
const runtimePlugins = new RuntimePluginService({
  pluginRoots: [
    {
      path: externalPluginRoot,
      origin: "external",
      optional: true
    },
    {
      path: pluginRoot,
      origin: "builtin"
    }
  ],
  enabledPluginIds: enabledRuntimePluginIds,
  externalizedPluginIds: externalizedRuntimePluginIds,
  stateStore: workbenchState,
  dataLocations: pluginDataLocations,
  configByPluginId: {
    "dev.terminal-manager": {
      baseUrl: localToolsUrl,
      terminalManagementService
    },
    "dev.scheduler": {
      schedulerService: createSchedulerPluginService({
        scheduler,
        wakeWorker: () => schedulerWorker?.wake(),
        availableTools: () => tools?.supportedToolNames || [],
        availableModels: listAccountModelProfiles,
        availableNodes: () => nodeBroker?.snapshot().nodes || []
      })
    },
    "dev.session-manager": {
      sessionService: createSessionManagerPluginService({
        workbenchState
      })
    },
    "dev.langchain-chat": {
      modelService: createModelManagementPluginService({
        listProfiles: listAccountModelProfiles,
        importProfile: importModelProfile,
        deleteProfile: deleteModelProfile,
        selection: modelSelection
      })
    },
    "dev.tools": {
      toolService: createToolsManagementPluginService({
        listTools: () => capabilityTools(),
        interactionProfiles: interactionProfileStore
      })
    },
    "dev.observability": {},
    "dev.goal": { runStore: runs },
    "dev.context-compression": {
      runStore: runs,
      modelLimits: (model) => {
        const selected = listModelProfiles().find((item) => item.id === model?.profileId || item.model === model?.modelId);
        return { ...(selected?.limits || selected?.metadata?.limits || {}),
          defaultOutputTokens: selected?.maxOutputTokens };
      },
      modelService: createPluginModelService({
        engine, resolveModel,
        authorizeRequest: accountExecution?.authorizeExecution,
        onRequest: publishModelRequest
      })
    },
    "dev.skills": {
      availableNodes: () => nodeBroker?.snapshot().nodes || [],
      localSourceAvailable: toolMode === "local",
      marketplaceSkills: marketplace ? (context) => marketplace.skillsFor(context) : null,
      marketplaceSkillFile: marketplace ? (context, id, path, hash) => marketplace.skillFileFor(context, id, path, hash) : null
    },
    "dev.plugins": {
      pluginHostService
    },
    "dev.mail": {
      mailService: createMailManagementPluginService({
        interactionProfiles: interactionProfileStore
      })
    },
    "dev.identity": {
      fileService: identityFileService,
      mcpService: identityMcpService,
      modelService: createPluginModelService({
        engine,
        resolveModel,
        authorizeRequest: accountExecution?.authorizeExecution,
        onRequest: publishModelRequest,
        onRequestError(error, { requestContext } = {}) {
          process.stderr.write(
            `[runtime-model-observability:`
            + `${requestContext?.source || "runtime-plugin"}] `
            + `${error?.message || String(error)}\n`
          );
        }
      }),
      projectAutomation: {
        stateStore: workbenchState,
        runnerService: agentRunnerService,
        authorizeExecution: accountExecution?.authorizeProject,
        authorizeDelegation: accountExecution?.authorizeDelegation,
        revokeDelegation: accountExecution?.revokeDelegation,
        pollIntervalMs: projectAutomationPollIntervalMs,
        registerService(service) {
          projectAutomationService = service || null;
        },
        logger(level, message) {
          if (level !== "debug") {
            process.stderr.write(
              `[runtime-project-automation:${level}] ${message}\n`
            );
          }
        }
      },
      biography: {
        enabled: process.env.ZION_RUNTIME_IDENTITY_BIOGRAPHY_POSTPROCESSOR !== "0"
      }
    },
    "dev.agents": {
      agentRunnerService
    }
  },
  logger({ level, pluginId, message }) {
    process.stderr.write(
      `[runtime-plugin:${pluginId}] ${level}: ${message}\n`
    );
  }
});
startupCleanup.push(() => runtimePlugins.stop());
const pluginSnapshot = await runtimePlugins.start();
const sessionDocumentProjector = runtimePlugins.getDocumentProjector(
  "dev.session-manager.chat-document"
);
if (
  enabledRuntimePluginIds.includes("dev.session-manager")
  && (
    typeof sessionDocumentProjector?.prepareRun !== "function"
    || typeof sessionDocumentProjector?.projectEvents !== "function"
  )
) {
  throw new Error("Session Manager document projector failed to activate; refusing to serve conversations without editor output");
}
try {
  await syncRuntimePluginSkillsCatalog({
    store: workbenchState,
    plugins: runtimePlugins.getActivePluginInfos()
  });
} catch (error) {
  process.stderr.write(
    `[runtime-skills:warn] Plugin Skill catalog sync failed: ${error?.message || String(error)}\n`
  );
}
collaboration.setDocumentProjector(sessionDocumentProjector);
const extensionExecution = marketplace ? new ExtensionExecutionService({
  runs,
  marketplace, tools: () => tools,
  resolveConfig: async (config, principal) => {
    if (config.nodeId !== "managed:account") return config;
    let target = managedNodeTools?.managedTarget(principal);
    if (!target && workspaceProvisioner) {
      await workspaceProvisioner.ensure(String(principal?.userId || principal?.user?.id || ""));
      target = managedNodeTools?.managedTarget(principal);
    }
    if (!target) throw Object.assign(new Error("账户沙箱尚未开通"), { code: "sandbox_account_unbound", statusCode: 403 });
    return { ...config, nodeId: target.nodeId };
  },
  hostBridge: new ExtensionHostBridge({
    tools: () => tools,
    hasNativeHost: (nodeId) => !!nodeBroker?.nodes.get(nodeId)?.registration.capabilities
      .some((capability) => capability.name === EXTENSION_HOST_TOOL),
    resolveResourceEpoch: async (binding, context) => {
      if (!managedNodeTools?.isManagedNode(binding.config.nodeId, context.principal)) {
        return nodeBroker?.nodes.get(binding.config.nodeId)?.registration.instanceId;
      }
      await authorizeSandboxActor(context);
      return sandboxTools.prepareExtensionHost(context, context.signal);
    },
    nativeInvoke: async (invocation, signal) => {
      const input = invocation.toolCall.arguments;
      const cleanup = invocation.extensionCleanup && ["cancel", "dispose"].includes(input.action)
        && input.binding.accountId === String(invocation.principal?.userId || invocation.principal?.user?.id || "");
      if (accountStore && !cleanup) {
        const grant = await accountStore.validateGrant(invocation.principal);
        if (!grant.scopes.includes("resource.execute")) throw Object.assign(
          new Error("resource_execution_denied"), { code: "resource_execution_denied", statusCode: 403 });
        const original = { ...invocation, policy: grant.policy };
        const policy = await accessControl.authorizeRunExecution(original);
        await extensionExecution.authorizeHost({ ...original, policy }, { config: input.binding.config });
      }
      return nodeBroker.invoke(invocation, signal);
    },
    acquireActivity: (binding, context) => {
      const target = managedNodeTools?.managedTarget(context.principal);
      return target?.nodeId === binding.config.nodeId
        ? sandboxTools.acquireActivityLease(binding.accountId, target.binding.workspaceId) : null;
    }
  }),
  allowNode: async (nodeId, principal) => {
    if (parseList(process.env.ZION_PLATFORM_NODE_IDS || "node:cloud-runtime").includes(nodeId)) return false;
    if (managedNodeTools?.isManagedNode(nodeId, principal)) return true;
    if (!nodeBroker?.snapshot().nodes.some((node) => node.nodeId === nodeId)) return false;
    return !accessControl || (await accessControl.store.listDevices())
      .some((device) => device.deviceId === nodeId && device.kind === "resource" && !device.revokedAt);
  }
}) : null;
const accountModelCatalog = marketplace ? new AccountExtensionModelCatalog({ marketplace }) : null;
accountModelEngine = extensionExecution ? new AccountExtensionModelEngine({
  engine: configuredEngine, runs, execution: extensionExecution, catalog: accountModelCatalog,
  authorize: (request) => accountStore ? accessControl.authorizeRunExecution(request) : undefined
}) : null;
let extensionBindings;
const extensionOutbox = extensionExecution ? new ExtensionOutbox({
  pool: postgresPool, spaceId: runtimeSpaceId, runs,
  execute: (...args) => extensionBindings.runJob(...args),
  onError: (error, context = {}) => process.stderr.write(
    `[runtime-extension-job] ${context.jobId || ""} ${error.code || "extension_job_error"}\n`)
}) : null;
extensionBindings = extensionExecution ? new ExtensionRunBindings({
  execution: extensionExecution, outbox: extensionOutbox,
  authorize: (request) => accountStore ? accessControl.authorizeRunExecution(request) : undefined
}) : null;
if (extensionExecution) extensionExecution.publishEvents = (...args) => extensionBindings.publishEvents(...args);
startupCleanup.push(() => extensionOutbox?.close());
startupCleanup.push(() => extensionExecution?.bridge.close());
const pluginTools = withExtensionTools(runtimePlugins, extensionExecution);
tools = new RuntimeToolBroker({
  localTools: analysisTools,
  pluginTools,
  receipts: runs,
  mcpEnabled,
  delegatedToolNames: ["node", "sandbox"].includes(toolMode)
    ? LOCAL_TOOLS_TOOL_DEFINITIONS.map((tool) => tool.name)
    : null,
  authorizeInvocation: async (invocation) => {
    const authorized = accountStore
      ? await accessControl.authorizeInvocation(invocation)
      : invocation;
    await pluginTools.authorizeInvocation?.(authorized);
    if (!pluginTools.hasTool(authorized.toolCall?.name)
      && !RUNTIME_NATIVE_TOOL_DEFINITIONS.some((tool) => tool.name === authorized.toolCall?.name)) {
      await analysisTools.authorizeInvocation(authorized);
    }
    return authorized;
  }
});
observabilityProjection.tools = new Set(tools.supportedToolNames);
observabilityProjection.start();
const knownToolDefinitions = new Map(
  [
    ...RUNTIME_TOOL_DEFINITIONS,
    ...analysisTools.getToolDefinitions(),
    ...pluginTools.getToolDefinitions(),
    ...RUNTIME_NATIVE_TOOL_DEFINITIONS
  ].map((tool) => [tool.name, tool])
);
capabilityTools = () => {
  const delegatedDefinitions = analysisTools.getToolDefinitions();
  const definitions = new Map([
    ...knownToolDefinitions,
    ...delegatedDefinitions.map((tool) => [tool.name, tool]),
    ...RUNTIME_NATIVE_TOOL_DEFINITIONS.map((tool) => [tool.name, tool])
  ]);
  return (tools.supportedToolNames || []).map((name) =>
    ({
      ...(definitions.get(name) || {
        name,
        description: `Device-provided tool: ${name}`,
        inputSchema: { type: "object" },
        hostKinds: ["device"]
      }),
      modelInjectable: true
    })
  );
};
const defaultAvailableToolNames = [
  ...new Set(tools.supportedToolNames || [])
];
let defaultInteractionProfile = interactionProfileStore.ensure(
  {
    ...createDefaultInteractionProfile({
    modelProfileId: defaultInteractionModelProfileId || profile?.id,
    availableToolNames: defaultAvailableToolNames
    }),
    ...(platformContext ? {
      policy: {
        ...SANDBOX_TERMINAL_POLICY,
        allowedTools: defaultAvailableToolNames.filter((name) =>
          DEFAULT_INTERACTIVE_READONLY_TOOL_NAMES.includes(name)
          || SANDBOX_TERMINAL_POLICY.allowedTools.includes(name) || name === "extensionsCall"
        ),
        maxToolCalls: 50
      },
      metadata: { includeTerminalContext: true, defaultToolSetVersion: DEFAULT_PROFILE_TOOLSET_VERSION }
    } : {})
  }
);
if (platformContext
  && defaultInteractionProfile.modelProfileId === models.defaultProfileId
  && Number(defaultInteractionProfile.metadata?.defaultToolSetVersion) > 0
  && Number(defaultInteractionProfile.metadata?.defaultToolSetVersion) <= DEFAULT_PROFILE_TOOLSET_VERSION
  && !credentials.has(models.get(defaultInteractionProfile.modelProfileId).credentialRef)
  && profile?.id !== defaultInteractionProfile.modelProfileId) {
  defaultInteractionProfile = interactionProfileStore.patch(DEFAULT_INTERACTION_PROFILE_ID, {
    modelProfileId: profile.id
  });
}
defaultInteractionProfile = mergeDefaultProfileTools(
  interactionProfileStore,
  defaultInteractionProfile,
  {
    profileId: DEFAULT_INTERACTION_PROFILE_ID,
    availableToolNames: defaultAvailableToolNames,
    allowedToolNames: platformContext
      ? [...DEFAULT_INTERACTIVE_READONLY_TOOL_NAMES, ...SANDBOX_TERMINAL_POLICY.allowedTools, "extensionsCall"]
      : [...DEFAULT_INTERACTIVE_READONLY_TOOL_NAMES,
        ...(extensionExecution && defaultInteractionProfile.policy?.preset === "trusted-automation"
          ? ["extensionsCall"] : [])],
    version: DEFAULT_PROFILE_TOOLSET_VERSION,
    replaceDefaultTools: true
  }
);
mergeDefaultProfileTools(
  interactionProfileStore,
  interactionProfileStore.ensure(
    createDefaultScheduledInteractionProfile({
      modelProfileId: defaultInteractionModelProfileId || profile?.id,
      availableToolNames: defaultAvailableToolNames
    })
  ),
  {
    profileId: DEFAULT_SCHEDULED_INTERACTION_PROFILE_ID,
    availableToolNames: defaultAvailableToolNames,
    allowedToolNames: DEFAULT_SCHEDULED_READONLY_TOOLS,
    version: DEFAULT_PROFILE_TOOLSET_VERSION,
    replaceDefaultTools: true
  }
);
scheduler.setAvailableTools(tools.supportedToolNames);
scheduler.setAvailableModels(listModelProfilesWithCredentialStatus());
scheduler.setAvailableNodes(nodeBroker?.snapshot().nodes || []);
const nodeHttpHandler = nodeBroker
  ? createNodeHttpHandler({
      broker: nodeBroker,
      token: accessControl ? "" : nodeToken,
      maxRequestBytes: nodeHttpMaxRequestBytes,
      authorize: accessControl
        ? (input) => accessControl.authorizeNode(input)
        : null
    })
  : null;
const deviceServiceHttpHandler = createDeviceServiceHttpHandler({
  dataFiles: localDataFiles,
  broker: nodeBroker,
  terminalService: terminalManagementService,
  serviceBaseUrls: nodeBroker
    ? { "plugin-service": pluginServiceUrl }
    : {
        "local-tools": localToolsUrl,
        "plugin-service": pluginServiceUrl
      },
  authorize: accessControl
    ? (request, route) => accessControl.authorizeDeviceService(request, route)
    : null,
  maxRequestBytes: deviceServiceMaxRequestBytes
});
const deviceServiceWebSocketHandler = createDeviceServiceWebSocketHandler({
  broker: nodeBroker,
  serviceBaseUrls: nodeBroker
    ? {}
    : {
        "local-tools": localToolsUrl
      },
  authorize: accessControl
    ? (request, route) => accessControl.authorizeDeviceService(request, route)
    : null
});
const listRunControllers = () => {
  const controllers = [...runtimePlugins.getRunControllers(), ...configuredRunControllers];
  if (new Set(controllers.map((controller) => controller.id)).size !== controllers.length) {
    throw new Error("Duplicate Runtime Hook controller id");
  }
  return controllers;
};
executor = createAgentExecutor({
  engine,
  tools,
  runs,
  contexts: runtimePlugins.getContextProviders(),
  controllers: listRunControllers(),
  bindRun: extensionBindings ? async (request, context) => {
    const bindings = await extensionBindings.prepare(request, context);
    try {
      const model = await accountModelEngine.prepare(request, context);
      return { ...bindings, metadata: { ...bindings.metadata, ...model.metadata } };
    } catch (error) { bindings.dispose?.(); throw error; }
  } : undefined,
  authorizeRun: accountStore
    ? (request, phase) => phase === "admission"
      ? request.policy
      : accessControl.authorizeRunExecution(request)
    : undefined,
  scheduleTimeout(callback, timeoutMs) {
    const timer = setTimeout(callback, timeoutMs);
    return { dispose: () => clearTimeout(timer) };
  }
});
const projectAutomationRuntimeAvailable = pluginSnapshot.plugins.some((plugin) => (
  plugin.id === "dev.identity" && plugin.status === "active"
)) && !!projectAutomationService;
const projectAutomationRuntimeEnabled = projectAutomationWorkerEnabled
  && projectAutomationRuntimeAvailable;
if (projectAutomationRuntimeEnabled) {
  projectAutomationService.start();
}
const schedulerWorker = schedulerWorkerEnabled
  ? new RuntimeSchedulerWorker({
      executor,
      scheduler,
      sessions: runs,
      tools,
      resolveRequest: (request) => modelSelection.resolveRequest(request, request.principal),
      availableTools: () => tools.supportedToolNames,
      pollIntervalMs: schedulerPollIntervalMs,
      logger(level, message) {
        if (level !== "debug") {
          process.stderr.write(`[runtime-scheduler:${level}] ${message}\n`);
        }
      }
    })
  : null;
const legacyMigration = legacyStateMigrationEnabled && !accountStore
  ? await migrateLegacyLocalToolsState({
      baseUrl: localToolsUrl,
      workbenchState,
      scheduler,
      logger(level, message) {
        if (level !== "debug") {
          process.stderr.write(`[runtime-migration:${level}] ${message}\n`);
        }
      }
    })
  : { available: false, reason: "disabled" };
if (legacyMigration.ok) {
  try {
    await scheduler.checkpoint();
  } catch (error) {
    process.stderr.write(
      `[runtime-migration:warn] Scheduler checkpoint failed: ${error.message}\n`
    );
  }
}
const serviceHttpHandlers = [
  createWebhookHttpHandler({ store: webhooks, accessControl, trustedOrigins: extensionTrustedOrigins }),
  ...(marketplace ? [createMarketplaceHttpHandler({
    service: marketplace, jobs: extensionOutbox,
    connections: async (principal) => {
      await accessControl.reauthorize(principal, "resource.execute");
      const devices = (await accessControl.store.listDevices()).filter((d) => d.kind === "resource" && !d.revokedAt);
      const platformNodes = parseList(process.env.ZION_PLATFORM_NODE_IDS || "node:cloud-runtime");
      return [
        ...(managedNodeTools ? [{ nodeId: "managed:account", label: "账户工作区", kind: "managed",
          workspaceRoot: "/workspace", status: managedNodeTools.managedTarget(principal) ? "available" : "unprovisioned" }] : []),
        ...(nodeBroker?.snapshot().nodes || []).filter((node) => !platformNodes.includes(node.nodeId)
          && devices.some((d) => d.deviceId === node.nodeId)).map((node) => ({
          nodeId: node.nodeId, label: node.label || node.nodeId, kind: "device", status: node.status,
          workspaceRoot: node.resources.find((r) => r.kind === "workspace")?.workspaceRoot || ""
        }))
      ];
    }
  })] : []),
  ...(sandboxTools ? [createSandboxHttpHandler({ broker: sandboxTools, accessControl })] : []),
  createAssetHttpHandler({ assets: assetService }),
  createObservabilityHttpHandler({
    service: observabilityService,
    projection: observabilityProjection,
    canViewExternalTrace: (principal) => (
      !accessControl || accessControl.hasScope?.(principal, "device.manage")
    )
  }),
  createPluginLocationsHttpHandler({ locations: pluginDataLocations }),
  ...(identityFileService ? [createPluginFilesHttpHandler({
    pluginId: "dev.identity",
    fileService: identityFileService,
    withRunContext: withIdentityFileHttpContext
  })] : []),
  createSkillsCatalogHttpHandler({
    store: workbenchState,
    marketplace,
    availableNodes: () => nodeBroker?.snapshot().nodes || [],
    localSourceAvailable: toolMode === "local",
    maxRequestBytes: runtimeMaxRequestBytes
  }),
  createModelGatewayHttpHandler({
    profiles: listModelProfiles,
    credentials
  }),
  createPluginDevelopmentHttpHandler({
    store: workbenchState,
    artifactStore: marketplace?.artifactStore,
    marketplace,
    localMode: !accessControl,
    platformNodeIds: parseList(process.env.ZION_PLATFORM_NODE_IDS || "node:cloud-runtime")
  }),
  createWorkbenchStateHttpHandler({
    store: workbenchState,
    readOnlyKeys: [
      "runtime.plugins.dev.identity.identity.snapshot",
      SKILLS_RUNTIME_KV_KEY,
      SKILLS_RUNTIME_SOURCES_KV_KEY
    ],
    reauthorize: accessControl
      ? (principal) => accessControl.reauthorize(principal, "runtime.read")
      : null
  }),
  createSchedulerHttpHandler({
    scheduler,
    abortRun: (runId, reason) => schedulerWorker?.abort(runId, reason),
    wakeWorker: () => schedulerWorker?.wake(),
    availableTools: () => tools.supportedToolNames,
    availableModels: listAccountModelProfiles,
    availableNodes: () => nodeBroker?.snapshot().nodes || [],
    authorizeTask: authorizeScheduledTask,
    onTaskChanged: revokeTaskGrant,
    maxRequestBytes: schedulerMaxRequestBytes
  }),
  ...(deviceServiceHttpHandler ? [deviceServiceHttpHandler] : []),
  ...(projectAutomationRuntimeAvailable
    ? [createProjectAutomationHttpHandler({
        service: projectAutomationService
      })]
    : [])
];
const workbenchStaticHandler = workbenchDist
  ? await createWorkbenchStaticHttpHandler({ root: workbenchDist })
  : null;
const canonicalWorkbenchHostHandler = accountStore && !oidcProvider?.secureCookies
  ? (request, response, url) => {
      if (!["GET", "HEAD"].includes(request.method)) return false;
      if (url.pathname === "/health" || url.pathname.startsWith("/v1/")) return false;
      const canonical = new URL(publicBaseUrl);
      const requestHost = String(request.headers.host || "").toLowerCase();
      if (!requestHost || requestHost === canonical.host.toLowerCase()) return false;
      response.writeHead(307, {
        location: `${canonical.origin}${url.pathname}${url.search}`,
        "cache-control": "no-store"
      });
      response.end();
      return true;
    }
  : null;
const runtimeHealth = createRuntimeHealthProvider({
  pool: postgresPool,
  spaceId: runtimeSpaceId,
  startedAt: runtimeStartedAt,
  modelRequestDetailMaxRows,
  modelRequestDetailMaxStoredBytes,
  nodeBroker,
  schedulerWorker,
  projectAutomationService
});
const platformAdmin = accessControl && !platformContext
  ? await new PlatformAdminService({ pool: postgresPool, health: runtimeHealth }).initialize() : null;
const runtime = createRuntimeServer({
  executor,
  runs,
  waitingTerminalOutbox: extensionTerminalOutbox,
  host,
  port,
  allowRemote: allowInsecureRemote,
  modelProfiles: listAccountModelProfiles,
  resolveModel: resolveAccountModel,
  modelSelection,
  importModelProfile,
  deleteModelProfile,
  interactionProfiles: interactionProfileStore,
  capabilityTools,
  accessControl,
  nodeHttpHandler,
  publicHttpHandlers: [
    ...(platformAdmin ? [createPlatformAdminHandler({ service: platformAdmin, access: accessControl })] : []),
    ...(accessControl && sharedAccountIssuer ? [createAccountAppHandoff({
      access: accessControl,
      key: await sharedAccountKey(process.env.ZIOON_ACCOUNT_SESSION_KEY_FILE),
      appOrigin: process.env.ZIOON_MARKETPLACE_ORIGIN || "https://marketplace.zioon.tech",
      appOrigins: {
        workbench: process.env.ZIOON_WORKBENCH_ORIGIN || "https://workbench.zioon.tech",
        mobile: process.env.ZIOON_MOBILE_ORIGIN || "https://mobile.zioon.tech",
        admin: process.env.ZIOON_ADMIN_ORIGIN || "https://admin.zioon.tech"
      }
    })] : []),
    ...(marketplace ? [async (request, response, url) => {
      if (request.method !== "GET" || url.pathname !== "/v1/marketplace/public") return false;
      const snapshot = await marketplace.snapshot("");
      response.writeHead(200, { "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=60", "x-content-type-options": "nosniff" });
      response.end(JSON.stringify({ categories: snapshot.categories, entries: snapshot.entries }));
      return true;
    }] : []),
    ...(accessControl ? [accessControl.handleHttp.bind(accessControl)] : []),
    ...(canonicalWorkbenchHostHandler ? [canonicalWorkbenchHostHandler] : []),
    ...(workbenchStaticHandler ? [workbenchStaticHandler] : [])
  ],
  serviceHttpHandlers,
  upgradeHandlers: [
    collaboration.handleUpgrade,
    ...(deviceServiceWebSocketHandler ? [deviceServiceWebSocketHandler] : [])
  ],
  sessionEventStore: workbenchState,
  sessionDocumentService: collaboration,
  runtimeHealth,
  maxRequestBytes: runtimeMaxRequestBytes,
  validateRunRequest: async (request) => {
    await assetService.validateRunRequest(request);
    if (!assetService.hasRunReferences(request)) return;
    const selectedProfile = (await listAccountModelProfiles(request.principal)).find((item) => (
      item.id === request.model?.profileId
      || item.model === request.model?.modelId
    )) || profile;
    if (selectedProfile?.capabilities?.supportsImage !== true && selectedProfile?.supportsImages !== true) {
      throw Object.assign(
        new Error("The selected model does not support image input"),
        {
          code: "MEDIA_CAPABILITY_UNSUPPORTED",
          statusCode: 422
        }
      );
    }
  },
  runPostProcessors: () => runtimePlugins.getRunPostProcessors(),
  runControllers: listRunControllers,
  pluginCommands: async (id, args, context) => {
    if (runtimePlugins.commandHandlers.has(id)) return runtimePlugins.invokeCommand(id, args, context);
    if (!extensionExecution) throw Object.assign(new Error("Plugin commands unavailable"), { statusCode: 404 });
    return context.invokeToolRun(await extensionExecution.commandOperation(id, args, context.principal));
  },
  pluginCommandRequiresSession: (id) => runtimePlugins.commandHandlers.has(id)
    && runtimePlugins.commandRequiresSession(id),
  onPostProcessorError: (error, meta = {}) => {
    process.stderr.write(
      `[runtime-postprocessor:${meta.pluginId || meta.processorId || "unknown"}] `
      + `${error?.message || String(error)}\n`
    );
  },
  serviceInfo: {
    engineId: engine.id,
    modelProfile: profile
      ? {
          id: profile.id,
          label: profile.label,
          providerId: profile.providerId,
          providerType: profile.providerType,
          model: profile.model,
          capabilities: profile.capabilities
        }
      : null,
    credentialProvider: "environment",
    toolHosts: [toolMode === "sandbox" ? "managed-node" : toolMode === "node" ? "device-node" : "local-tools"],
    deviceNodeGateway: !!nodeHttpHandler,
    invocationLeaseMs: nodeBroker ? invocationLeaseMs : null,
    invocationDeliveryGraceMs: nodeBroker ? invocationDeliveryGraceMs : null,
    durableNodeState: !!nodeStateStore,
    recoveredDeviceNodes: restoredNodeState?.nodes.length || 0,
    recoveredProjectBindings: restoredNodeState?.projectBindings.length || 0,
    durableInvocationReceipts:
      restoredNodeState?.durableReceiptCount || 0,
    pluginData: {
      host: pluginDataHost.mode,
      scope: pluginDataLocations.scopeMode,
      localFilesystem: pluginDataHost.localFiles,
      nodeBound: Boolean(pluginDataHost.locationNodeId),
      managedAccountVolume: pluginDataHost.managed === true,
      legacyReadFallback: Boolean(pluginDataLegacyReadAccountId),
      legacyAmbiguousRouting: pluginDataHost.ambiguousLegacyRouting
    },
    requestLimits: {
      runtime: {
        bytes: runtimeMaxRequestBytes,
        label: formatByteSize(runtimeMaxRequestBytes)
      },
      imageAsset: {
        bytes: assetMaxImageBytes,
        label: formatByteSize(assetMaxImageBytes)
      },
      deviceService: {
        bytes: deviceServiceMaxRequestBytes,
        label: formatByteSize(deviceServiceMaxRequestBytes)
      },
      scheduler: {
        bytes: schedulerMaxRequestBytes,
        label: formatByteSize(schedulerMaxRequestBytes)
      },
      nodeHttp: {
        bytes: nodeHttpMaxRequestBytes,
        label: formatByteSize(nodeHttpMaxRequestBytes)
      }
    },
    runtimePlugins: pluginSnapshot.plugins,
    runtimePluginFailures: pluginSnapshot.failures.length,
    observability: observabilityService.configuration(),
    externalizedRuntimePlugins: externalizedRuntimePluginIds,
    schedulerWorker: !!schedulerWorker,
    schedulerAvailableTools: schedulerWorker?.availableTools || [],
    projectAutomationWorker: projectAutomationRuntimeEnabled,
    recoveredToolReceipts: await runs.countToolReceipts(),
    interactionProfiles: interactionProfileStore.list().map((item) => item.id),
    defaultInteractionProfileId: defaultInteractionProfile.id,
    workbenchStateOwner: "runtime",
    collaboration: "yjs-hocuspocus",
    accessControl: accountStore ? "accounts-v1" : accessControl ? "single-space-pairing-v1" : "loopback",
    ...(accountStore ? {
      space: runtimeSpace,
      accountStore: accountStore.backend
    } : {}),
    workbenchHosted: !!workbenchStaticHandler,
    schedulerOwner: "runtime",
    legacyStateMigration: legacyMigration,
    recoveredInterruptedRuns: interrupted.length,
    recoveredSessionMessages: projectedMessages.length,
    approvalProvider: false,
    artifactStore: "postgresql-bounded-metadata",
    assetStore: "filesystem-cas"
  }
});
sandboxTools?.start();
extensionOutbox?.start();
schedulerWorker?.start();
const storageMaintenance = storageMaintenanceEnabled
  ? startStorageMaintenance({
      stores: [runs, workbenchState],
      batchRows: storageMaintenanceBatchRows,
      intervalMs: storageMaintenanceIntervalMs,
      logger(level, message) {
        process.stderr.write(`[runtime-storage:${level}] ${message}\n`);
      }
    })
  : null;

process.stdout.write(
  `Zion Runtime ready for ${runtimeSpaceId} using PostgreSQL `
  + `(engine=${engine.id}, plugins=${pluginSnapshot.plugins.length}, `
  + `scheduler=${schedulerWorker ? "on" : "off"}, `
  + `projectAutomation=${projectAutomationService?.running ? "on" : "off"}, `
  + `recovered=${interrupted.length})\n`
);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const failures = [];
  for (const cleanup of [
    () => runtime.close(), () => extensionOutbox?.close(), () => extensionExecution?.bridge.close(),
    () => sandboxTerminalService?.close(),
    () => sandboxTools?.close(), () => sandboxStore?.close(), () => storageMaintenance?.stop(),
    () => projectAutomationService?.stop(), () => schedulerWorker?.stop(),
    () => collaboration.close(), () => nodeBroker?.close(),
    () => nodeStateStore?.close(), () => runtimePlugins.stop(),
    () => observabilityProjection.stop(), () => scheduler.close(),
    () => runModelRequestSubscription.dispose(), () => workbenchState.close(),
    () => runs.close(), () => accessStore?.close(), () => oidcProvider?.close()
  ]) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Runtime cleanup failed");
}
return {
  runtime, accessControl, credentials, listModelProfiles,
  defaultModelProfileId: defaultInteractionProfile.modelProfileId
    || models.resolveModelRef(defaultInteractionProfile.model).id,
  close: shutdown,
  isIdle: () => runtime.isIdle() && collaboration.stats().connections === 0
    && !sandboxTools?.pending.size && !sandboxTerminalService?.channels.size
    && !extensionOutbox?.active.size
    && !(nodeBroker?.snapshot().nodes || []).some((node) => node.status === "online")
};
} catch (error) {
  for (const cleanup of startupCleanup.reverse()) {
    try { await cleanup(); } catch {}
  }
  throw error;
}
}

const platformRuntime = await createSpaceRuntime({
  runtimeSpaceId, dataDirectory, modelProfilePath, credentialStorePath, interactionProfilePath
});
const gateway = automaticWorkspaces ? new AccountRuntimeGateway({
  platform: platformRuntime, platformSpaceId: runtimeSpaceId, pool: postgresPool,
  provisioner: workspaceProvisioner, host, port,
  maxRuntimes: positiveInteger(process.env.ZION_ACCOUNT_RUNTIME_MAX_ACTIVE || "32", "Active account Runtime limit"),
  createRuntime: async (spaceId) => {
    const key = createHash("sha256").update(spaceId).digest("hex");
    const directory = join(dataDirectory, "accounts", key);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return createSpaceRuntime({
      runtimeSpaceId: spaceId, dataDirectory: directory,
      modelProfilePath: join(directory, "model-profiles.json"),
      credentialStorePath: join(directory, "credentials.json"),
      interactionProfilePath: join(directory, "interaction-profiles.json"),
      platformContext: platformRuntime
    });
  }
}) : null;
const address = await (gateway || platformRuntime.runtime).start();
webhookWorker.start();
process.stdout.write(`Zion Runtime listening at ${address.url} (automaticWorkspaces=${automaticWorkspaces})\n`);
let closingPlatform = false;
async function shutdown() {
  if (closingPlatform) return;
  closingPlatform = true;
  try {
    if (gateway) await gateway.close();
    else await platformRuntime.close();
  } finally {
    await webhookWorker.stop();
    await accountStore?.close();
    await postgresPool.end();
  }
}

process.on("SIGINT", () => {
  void shutdown().finally(shutdownTelemetry).finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(shutdownTelemetry).finally(() => process.exit(0));
});
