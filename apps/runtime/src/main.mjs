import { shutdownTelemetry } from "./telemetry/bootstrap.mjs";
import { homedir } from "node:os";
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
import { PostgresAccountStore } from "./accounts/postgres-account-store.mjs";
import { createOidcProvider } from "./accounts/oidc-provider.mjs";
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
import { createDeviceServiceClient } from "./device-service-client.mjs";
import { createPluginDataLocations, createPluginLocationsHttpHandler } from "./plugin-data-locations.mjs";
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
  RUNTIME_TOOL_DEFINITIONS,
  RuntimeToolBroker
} from "./runtime-tool-broker.mjs";
import { createSchedulerHttpHandler } from "./scheduler-http-handler.mjs";
import { RuntimeSchedulerWorker } from "./scheduler-worker.mjs";
import { createRuntimeHealthProvider } from "./runtime-health.mjs";
import { createRuntimeServer } from "./server.mjs";
import { createSkillsCatalogHttpHandler } from "./skills-catalog-http-handler.mjs";
import { PostgresAccessStore } from "./postgres-access-store.mjs";
import { PostgresAssetStore } from "./postgres-asset-store.mjs";
import { PostgresNodeStateStore } from "./postgres-node-state-store.mjs";
import { PostgresRunStore } from "./postgres-run-store.mjs";
import { initializePostgresRuntimeSchema } from "./postgres-runtime-schema.mjs";
import { PostgresSchedulerStore } from "./postgres-scheduler-store.mjs";
import {
  PostgresWorkbenchStateStore
} from "./postgres-workbench-state-store.mjs";
import { startStorageMaintenance } from "./storage-maintenance.mjs";
import { createWorkbenchStaticHttpHandler } from "./workbench-static-http-handler.mjs";
import { createWorkbenchStateHttpHandler } from "./workbench-state-http-handler.mjs";
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

const DEFAULT_PROFILE_TOOLSET_VERSION = 19;
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

function createEngine(mode, credentials, models) {
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
    || (toolMode === "node" ? "none" : "dev.terminal-manager,dev.skills,dev.memory,dev.identity,dev.context-compression,dev.scheduler,dev.session-manager,dev.langchain-chat,dev.tools,dev.plugins,dev.mail,dev.agents,dev.observability")
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
if (toolMode !== "local" && toolMode !== "node") {
  throw new Error(`Unsupported Runtime tool mode: ${toolMode}`);
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
const runtimeSpace = accountStore
  ? await accountStore.space(runtimeSpaceId)
  : null;
if (accountStore && !runtimeSpace) {
  await postgresPool.end();
  throw new Error(
    `Account database does not contain the configured Runtime Space: ${runtimeSpaceId}`
  );
}
await initializePostgresRuntimeSchema(postgresPool);
const pluginDataRoot = readArg(
  "--plugin-data-root",
  process.env.ZION_PLUGIN_DATA_ROOT || join(dataDirectory, "plugins")
);
const oidcProvider = accountStore ? await createOidcProvider({
  store: accountStore,
  issuer: process.env.ZION_OIDC_ISSUER,
  clientId: process.env.ZION_OIDC_CLIENT_ID,
  clientSecret: process.env.ZION_OIDC_CLIENT_SECRET || "",
  publicBaseUrl,
  audience: process.env.ZION_OIDC_API_AUDIENCE || "",
  requiredScope: process.env.ZION_OIDC_API_SCOPE || "zion.api",
  activeSpaceId: runtimeSpaceId,
  allowLoopbackHttp: enabledFlag(process.env.ZION_ACCOUNT_ALLOW_LOOPBACK_HTTP)
}) : null;
const runs = new PostgresRunStore(postgresPool, {
  spaceId: runtimeSpaceId,
  modelRequestDetailMaxBytes,
  modelRequestDetailMaxRows,
  modelRequestDetailMaxStoredBytes,
  modelRequestDetailRetentionMs
});
const assetMetadata = new PostgresAssetStore(postgresPool, {
  spaceId: runtimeSpaceId
});
bindRuntimeDataDirectory({
  dataDirectory,
  spaceId: runtimeSpaceId,
  paths: [
    { path: modelProfilePath }, { path: credentialStorePath }, { path: interactionProfilePath },
    { path: pluginDataRoot, directory: true },
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
const accessStore = accessControlEnabled
  ? new PostgresAccessStore(postgresPool, { spaceId: runtimeSpaceId })
  : null;
const accessControl = accountStore
  ? new AccountAccessControl({
      accounts: accountStore,
      oidc: oidcProvider,
      store: accessStore,
      allowedOrigins,
      publicBaseUrl,
      servedSpaceId: runtimeSpaceId
    })
  : accessStore ? new RuntimeAccessControl({
      store: accessStore,
      allowedOrigins,
      publicBaseUrl
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
const scheduler = new PostgresSchedulerStore(postgresPool, {
  spaceId: runtimeSpaceId
});
const interrupted = await runs.reconcileActiveRuns();
const projectedMessages = await runs.reconcileCompletedSessionMessages();
const modelProfileStore = new FileModelProfileStore(modelProfilePath);
const models = createBuiltinModelRegistry({
  additionalProfiles: modelProfileStore.list()
});
const interactionProfileStore = new FileInteractionProfileStore(
  interactionProfilePath
);
if (accountStore) accessControl.resolveProfile = (id) => interactionProfileStore.get(id);
const accountExecution = accountStore ? createAccountExecutionAuthority({
  accessControl, profiles: interactionProfileStore
}) : null;
const credentials = new EnvironmentCredentialProvider({
  storePath: credentialStorePath,
  bindings: {
    "model.default": "ZION_RUNTIME_API_KEY",
    "model.deepseek": "ZION_RUNTIME_DEEPSEEK_API_KEY"
  }
});
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
} = createEngine(engineMode, credentials, models);
const engine = new AssetInputEngine({
  engine: configuredEngine,
  assets: assetService,
  maxInlineBytes: assetMaxImageBytes
});
const importModelProfile = engineMode === "openai"
  ? ({ profile: input, credential }) => {
      const id = String(input?.id || "").trim();
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
const localDataFiles = createPluginDataFileHost({ root: pluginDataRoot });
const localTools = new LocalToolsBroker({
  baseUrl: localToolsUrl,
  dataFiles: localDataFiles,
  allowDangerousCommands: enabledFlag(process.env.ZION_ALLOW_DANGEROUS)
});
const nodeGatewayEnabled = toolMode === "node" || !!nodeToken;
const nodeStateStore = nodeGatewayEnabled
  ? new PostgresNodeStateStore(postgresPool, {
      spaceId: runtimeSpaceId
    })
  : null;
const nodeBroker = nodeGatewayEnabled
  ? await new NodeBroker({
      invocationLeaseMs,
      stateStore: nodeStateStore
    }).initialize()
  : null;
const restoredNodeState = nodeBroker?.snapshot();
const delegatedTools = toolMode === "node" ? nodeBroker : localTools;
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
  nodeBroker
});
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
    if (typeof availableModels === "function") {
      scheduler.setAvailableModels(availableModels());
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
      });
      wakeWorker?.();
      return task;
    },
    async updateTask(taskId, patch = {}, meta = {}) {
      refreshCapabilities();
      const current = await scheduler.getTask(String(taskId || ""));
      const input = mergeTaskPatch(current, patch);
      const approved = authorizeScheduledTask
        ? await authorizeScheduledTask(meta.principal, input) : input;
      const task = await scheduler.updateTask(current.id, approved);
      await revokeTaskGrant(current);
      wakeWorker?.();
      return task;
    },
    async setEnabled(taskId, enabled) {
      const current = await scheduler.getTask(String(taskId || ""));
      const task = await scheduler.updateTask(current.id, {
        ...current,
        revision: current.revision,
        enabled: Boolean(enabled)
      });
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
function createModelManagementPluginService({
  listProfiles,
  importProfile,
  deleteProfile,
  interactionProfiles
}) {
  return Object.freeze({
    listProfiles: () => listProfiles(),
    async upsertProfile(input = {}) {
      if (typeof importProfile !== "function") {
        throw new Error("Runtime model profile import is unavailable");
      }
      return await importProfile(input);
    },
    async deleteProfile(profileId) {
      if (typeof deleteProfile !== "function") {
        throw new Error("Runtime model profile delete is unavailable");
      }
      return await deleteProfile(profileId);
    },
    getActiveModel({
      interactionProfileId = "interactive.default"
    } = {}) {
      const profile = interactionProfiles.get(interactionProfileId);
      return profile ? {
        interactionProfileId: profile.id,
        modelProfileId: profile.modelProfileId || null,
        model: profile.model || null
      } : null;
    },
    setActiveProfile(profileId, {
      interactionProfileId = "interactive.default"
    } = {}) {
      const id = String(profileId || "").trim();
      const available = listProfiles().some((profile) => profile.id === id);
      if (!available) throw new Error(`Model profile not found: ${id}`);
      return interactionProfiles.patch(interactionProfileId, {
        modelProfileId: id
      });
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
const pluginDataLocations = createPluginDataLocations({
  root: pluginDataRoot,
  nodeId: readArg("--plugin-data-node-id", process.env.ZION_PLUGIN_DATA_NODE_ID || ""),
  requireNode: toolMode === "node"
});
const identityFileService = createPluginFileService({
  toolHost: delegatedTools,
  authorizeRequest: accountExecution?.authorizePluginFile,
  dataLocation: () => pluginDataLocations.forPlugin("dev.identity").data,
  fileClient: createDeviceServiceClient({
    service: "local-tools", baseUrl: localToolsUrl,
    nodeBroker: toolMode === "node" ? nodeBroker : null,
    dataFiles: localDataFiles
  }),
  invocationPrefix: "dev.identity.file"
});
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
        availableModels: listModelProfilesWithCredentialStatus,
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
        listProfiles: listModelProfilesWithCredentialStatus,
        importProfile: importModelProfile,
        deleteProfile: deleteModelProfile,
        interactionProfiles: interactionProfileStore
      })
    },
    "dev.tools": {
      toolService: createToolsManagementPluginService({
        listTools: () => capabilityTools(),
        interactionProfiles: interactionProfileStore
      })
    },
    "dev.observability": {},
    "dev.skills": {
      availableNodes: () => nodeBroker?.snapshot().nodes || [],
      localSourceAvailable: toolMode === "local"
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
const pluginSnapshot = await runtimePlugins.start();
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
collaboration.setDocumentProjector(
  runtimePlugins.getDocumentProjector(
    "dev.session-manager.chat-document"
  )
);
tools = new RuntimeToolBroker({
  localTools: analysisTools,
  pluginTools: runtimePlugins,
  receipts: runs,
  authorizeInvocation: async (invocation) => {
    const authorized = accountStore
      ? await accessControl.authorizeInvocation(invocation)
      : invocation;
    if (!runtimePlugins.hasTool(authorized.toolCall?.name)
      && !["webFetch", "todoWrite"].includes(authorized.toolCall?.name)) {
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
    ...runtimePlugins.getToolDefinitions()
  ].map((tool) => [tool.name, tool])
);
capabilityTools = () => {
  const delegatedDefinitions = analysisTools.getToolDefinitions();
  const definitions = new Map([
    ...knownToolDefinitions,
    ...delegatedDefinitions.map((tool) => [tool.name, tool])
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
  createDefaultInteractionProfile({
    modelProfileId: defaultInteractionModelProfileId || profile?.id,
    availableToolNames: defaultAvailableToolNames
  })
);
defaultInteractionProfile = mergeDefaultProfileTools(
  interactionProfileStore,
  defaultInteractionProfile,
  {
    profileId: DEFAULT_INTERACTION_PROFILE_ID,
    availableToolNames: defaultAvailableToolNames,
    allowedToolNames: DEFAULT_INTERACTIVE_READONLY_TOOL_NAMES,
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
    ? {}
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
executor = createAgentExecutor({
  engine,
  tools,
  runs,
  contexts: runtimePlugins.getContextProviders(),
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
      resolveRequest: (request) => resolveInteractionRequest({
        body: request,
        interactionProfiles: interactionProfileStore,
        resolveModel,
        fallbackModel: modelRefForProfile(profile)
      }),
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
  createAssetHttpHandler({ assets: assetService }),
  createObservabilityHttpHandler({
    service: observabilityService,
    projection: observabilityProjection,
    canViewExternalTrace: (principal) => (
      !accessControl || accessControl.hasScope?.(principal, "device.manage")
    )
  }),
  createPluginLocationsHttpHandler({ locations: pluginDataLocations }),
  createSkillsCatalogHttpHandler({
    store: workbenchState,
    availableNodes: () => nodeBroker?.snapshot().nodes || [],
    localSourceAvailable: toolMode === "local",
    maxRequestBytes: runtimeMaxRequestBytes
  }),
  createModelGatewayHttpHandler({
    profiles: listModelProfiles,
    credentials
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
    availableModels: listModelProfilesWithCredentialStatus,
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
const runtime = createRuntimeServer({
  executor,
  runs,
  host,
  port,
  allowRemote: allowInsecureRemote,
  modelProfiles: listModelProfilesWithCredentialStatus,
  resolveModel,
  importModelProfile,
  deleteModelProfile,
  interactionProfiles: interactionProfileStore,
  capabilityTools,
  accessControl,
  nodeHttpHandler,
  publicHttpHandlers: [
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
    const selectedProfile = listModelProfiles().find((item) => (
      item.id === request.model?.profileId
      || item.model === request.model?.modelId
    )) || profile;
    if (selectedProfile?.capabilities?.supportsImage !== true) {
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
    toolHosts: [toolMode === "node" ? "device-node" : "local-tools"],
    deviceNodeGateway: !!nodeHttpHandler,
    invocationLeaseMs: nodeBroker ? invocationLeaseMs : null,
    durableNodeState: !!nodeStateStore,
    recoveredDeviceNodes: restoredNodeState?.nodes.length || 0,
    recoveredProjectBindings: restoredNodeState?.projectBindings.length || 0,
    durableInvocationReceipts:
      restoredNodeState?.durableReceiptCount || 0,
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
const address = await runtime.start();
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
  `Zion Runtime listening at ${address?.url || `${host}:${port}`} using PostgreSQL `
  + `(engine=${engine.id}, plugins=${pluginSnapshot.plugins.length}, `
  + `scheduler=${schedulerWorker ? "on" : "off"}, `
  + `projectAutomation=${projectAutomationService?.running ? "on" : "off"}, `
  + `recovered=${interrupted.length})\n`
);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await storageMaintenance?.stop();
    await projectAutomationService?.stop();
    await schedulerWorker?.stop();
    await collaboration.close();
    await runtime.close();
  } finally {
    try {
      nodeBroker?.close();
    } finally {
      try {
        await nodeStateStore?.close();
      } finally {
        try {
          await runtimePlugins.stop();
        } finally {
          try {
            await observabilityProjection.stop();
          } finally {
            try {
              await scheduler.close();
            } finally {
              try {
                runModelRequestSubscription.dispose();
                await workbenchState.close();
              } finally {
                try {
                  await runs.close();
                } finally {
                  try {
                    await accessStore?.close();
                    await oidcProvider?.close();
                  } finally {
                    try {
                      await accountStore?.close();
                    } finally {
                      await postgresPool.end();
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

process.on("SIGINT", () => {
  void shutdown().finally(shutdownTelemetry).finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(shutdownTelemetry).finally(() => process.exit(0));
});
