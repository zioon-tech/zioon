import { readdir, readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import { pathToFileURL } from "node:url";
import {
  normalizePluginManifest,
  validateToolInput,
  validateToolInputSchema
} from "../../../packages/plugin-sdk/src/manifest.mjs";

export const RUNTIME_PLUGIN_API_VERSION = 2;
export const SUPPORTED_RUNTIME_PLUGIN_API_VERSIONS = new Set([1, 2]);
const PRESET_ORDER = new Map([
  ["read-only", 1],
  ["workspace-write", 2],
  ["trusted-automation", 3]
]);
const READ_ONLY_TOOL_ACTIONS = new Map([
  ["memoryManage", ["list", "tree", "read", "search", "build_context", "providers"]],
  ["agentsManage", ["list_agents", "list_tasks", "get_task"]],
  ["identityManage", ["get"]],
  ["projectAutomationManage", ["get"]]
]);
const importRuntimeModule = (url) => import(/* @vite-ignore */ url);

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isPathInside(root, candidate) {
  const path = relative(root, candidate);
  return path === ""
    || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function pluginFailure(id, phase, error) {
  return {
    id: String(id || "unknown"),
    phase,
    message: errorMessage(error)
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function disposable(dispose) {
  return Object.freeze({
    dispose: typeof dispose === "function" ? dispose : () => {}
  });
}

function pluginStatePrefix(pluginId, namespace) {
  const safeNamespace = String(namespace || "default").trim() || "default";
  return `runtime.plugins.${pluginId}.${safeNamespace}`;
}

function pluginStateKey(pluginId, namespace, stateKey) {
  const key = String(stateKey || "").trim();
  if (!key) throw new Error("Runtime plugin state key is required");
  return `${pluginStatePrefix(pluginId, namespace)}.${key}`;
}

function createPluginStateNamespace({
  pluginId,
  namespace,
  memory,
  stateStore,
  persistentState,
  trackWrite
}) {
  if (stateStore?.readKV && stateStore?.writeKV) {
    const prefix = `${pluginStatePrefix(pluginId, namespace)}.`;
    return Object.freeze({
      get: (stateKey) => persistentState.get(
        pluginStateKey(pluginId, namespace, stateKey)
      ),
      set: (stateKey, value) => {
        const key = pluginStateKey(pluginId, namespace, stateKey);
        persistentState.set(key, clone(value));
        trackWrite(pluginId, () => stateStore.writeKV(key, value));
        return value;
      },
      delete: (stateKey) => {
        const key = pluginStateKey(pluginId, namespace, stateKey);
        persistentState.set(key, null);
        trackWrite(pluginId, () => stateStore.writeKV(key, null));
        return true;
      },
      entries: () => [...persistentState.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), value])
    });
  }

  const key = `${pluginId}:${String(namespace || "default")}`;
  if (!memory.has(key)) memory.set(key, new Map());
  const bucket = memory.get(key);
  return Object.freeze({
    get: (stateKey) => bucket.get(String(stateKey)),
    set: (stateKey, value) => {
      bucket.set(String(stateKey), value);
      return value;
    },
    delete: (stateKey) => bucket.delete(String(stateKey)),
    entries: () => Array.from(bucket.entries())
  });
}

function validateContextProvider(provider) {
  if (!provider || typeof provider !== "object") {
    throw new Error("Context Provider must be an object");
  }
  if (!String(provider.id || "").trim()) {
    throw new Error("Context Provider must declare a non-empty id");
  }
  if (
    typeof provider.prepare !== "function"
    && typeof provider.contribute !== "function"
  ) {
    throw new Error(
      `Context Provider ${provider.id} must implement prepare or contribute`
    );
  }
  if (
    provider.stage != null
    && provider.stage !== "pre"
    && provider.stage !== "post"
  ) {
    throw new Error(`Context Provider ${provider.id} has an invalid stage`);
  }
  if (provider.order != null && !Number.isFinite(provider.order)) {
    throw new Error(`Context Provider ${provider.id} has an invalid order`);
  }
}

function validateRunPostProcessor(processor) {
  if (!processor || typeof processor !== "object") {
    throw new Error("Run post-processor must be an object");
  }
  if (!String(processor.id || "").trim()) {
    throw new Error("Run post-processor must declare a non-empty id");
  }
  if (typeof processor.process !== "function") {
    throw new Error(`Run post-processor ${processor.id} must implement process`);
  }
  if (processor.order != null && !Number.isFinite(processor.order)) {
    throw new Error(`Run post-processor ${processor.id} has an invalid order`);
  }
}

function validateDocumentProjector(projector) {
  if (!projector || typeof projector !== "object") {
    throw new Error("Document projector must be an object");
  }
  if (!String(projector.id || "").trim()) {
    throw new Error("Document projector must declare a non-empty id");
  }
  if (typeof projector.prepareRun !== "function") {
    throw new Error(`Document projector ${projector.id} must implement prepareRun`);
  }
  if (typeof projector.projectRun !== "function") {
    throw new Error(`Document projector ${projector.id} must implement projectRun`);
  }
}

function validateToolName(name) {
  return /^[a-zA-Z0-9_.-]+$/.test(name);
}

function normalizeToolResult(value) {
  if (typeof value === "string") {
    return { ok: true, content: value };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      ok: value.ok !== false,
      content: typeof value.content === "string"
        ? value.content
        : JSON.stringify(value.content ?? value, null, 2),
      ...(value.error ? { error: String(value.error) } : {}),
      ...(Array.isArray(value.artifactIds)
        ? { artifactIds: value.artifactIds.map(String).filter(Boolean) }
        : {})
    };
  }
  return { ok: true, content: String(value ?? "") };
}

function normalizeToolContribution(plugin, tool) {
  if (!tool || typeof tool !== "object") {
    throw new Error("Runtime Tool contribution must be an object");
  }
  const name = String(tool.name || "").trim();
  if (!name || !validateToolName(name)) {
    throw new Error("Runtime Tool contribution must declare a valid name");
  }
  if (typeof tool.invoke !== "function") {
    throw new Error(`Runtime Tool ${name} must implement invoke`);
  }
  const inputSchema = tool.inputSchema && typeof tool.inputSchema === "object"
    ? clone(tool.inputSchema)
    : { type: "object", additionalProperties: true };
  const schemaErrors = validateToolInputSchema(
    inputSchema,
    `Runtime Tool ${name} inputSchema`
  );
  if (schemaErrors.length) {
    throw new Error(schemaErrors.join("; "));
  }
  const minimumPreset = PRESET_ORDER.has(String(tool.policy?.minimumPreset))
    ? String(tool.policy.minimumPreset)
    : "read-only";
  const declaration = plugin.capabilities.find((capability) =>
    capability.host === "runtime"
    && capability.kind === "tool"
    && capability.id === name
  );
  return {
    name,
    description: String(tool.description || ""),
    inputSchema,
    hostKinds: ["runtime-plugin", `plugin:${plugin.id}`],
    pluginId: plugin.id,
    minimumPreset,
    risk: declaration?.risk,
    requiredScopes: declaration?.requiredScopes || [],
    invoke: tool.invoke
  };
}

function presetAllows(actual, minimum) {
  return (PRESET_ORDER.get(String(actual || "read-only")) || 1)
    >= (PRESET_ORDER.get(String(minimum || "read-only")) || 1);
}

function toolDefinition(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: clone(tool.inputSchema),
    hostKinds: [...tool.hostKinds],
    pluginId: tool.pluginId,
    policy: {
      minimumPreset: tool.minimumPreset,
      ...(tool.requiredScopes.length
        ? { requiredScopes: [...tool.requiredScopes] }
        : {})
    },
    ...(tool.risk ? { risk: tool.risk } : {})
  };
}

function toolDefinitionForPolicy(tool, policy = {}) {
  const definition = toolDefinition(tool);
  const actions = READ_ONLY_TOOL_ACTIONS.get(definition.name);
  if (
    actions
    && String(policy?.preset || "read-only") === "read-only"
    && definition.inputSchema?.properties?.action
  ) {
    definition.inputSchema.properties.action.enum = [...actions];
  }
  return definition;
}

async function loadManifest(pluginDirectory) {
  const manifestPath = resolve(pluginDirectory, "manifest.json");
  const source = await readFile(manifestPath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${manifestPath}: ${errorMessage(error)}`);
  }

  const normalized = normalizePluginManifest(manifest);
  const runtimeEntry = normalized.entries.runtime;
  if (!runtimeEntry) return null;
  if (!normalized.hosts.runtime) {
    throw new Error(`Runtime plugin ${normalized.id} is not compatible with the runtime host`);
  }

  return {
    id: normalized.id,
    version: normalized.version,
    directory: pluginDirectory,
    manifest,
    runtimeEntry,
    runtimeApiVersion: normalized.runtimeApiVersion,
    manifestVersion: normalized.manifestVersion,
    entries: normalized.entries,
    hosts: normalized.hosts,
    capabilities: normalized.capabilities
  };
}

function normalizePluginRoot(configuredRoot) {
  if (
    configuredRoot
    && typeof configuredRoot === "object"
    && !Array.isArray(configuredRoot)
  ) {
    return {
      path: resolve(String(configuredRoot.path || "")),
      origin: String(configuredRoot.origin || "configured"),
      optional: configuredRoot.optional === true
    };
  }
  return {
    path: resolve(String(configuredRoot || "")),
    origin: "configured",
    optional: false
  };
}

export async function discoverRuntimePluginManifests(pluginRoots) {
  const plugins = [];
  const failures = [];

  for (const configuredRoot of pluginRoots || []) {
    const rootConfig = normalizePluginRoot(configuredRoot);
    const root = rootConfig.path;
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (rootConfig.optional && error?.code === "ENOENT") continue;
      failures.push(pluginFailure(basename(root), "discovery", error));
      continue;
    }

    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (!entry.isDirectory()) continue;
      const pluginDirectory = resolve(root, entry.name);
      try {
        const plugin = await loadManifest(pluginDirectory);
        if (plugin) {
          plugins.push({
            ...plugin,
            origin: rootConfig.origin
          });
        }
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        failures.push(pluginFailure(entry.name, "manifest", error));
      }
    }
  }

  return { plugins, failures };
}

async function resolveRuntimeEntry(plugin) {
  const entry = String(plugin.runtimeEntry || "").trim();
  if (!entry) {
    throw new Error(`Runtime plugin ${plugin.id} has no entries.runtime`);
  }
  if (isAbsolute(entry)) {
    throw new Error(`Runtime entry for ${plugin.id} must be relative`);
  }

  const pluginRoot = await realpath(plugin.directory);
  const entryPath = resolve(pluginRoot, entry);
  if (!isPathInside(pluginRoot, entryPath)) {
    throw new Error(`Runtime entry for ${plugin.id} escapes its plugin directory`);
  }

  const canonicalEntry = await realpath(entryPath);
  if (!isPathInside(pluginRoot, canonicalEntry)) {
    throw new Error(`Runtime entry for ${plugin.id} resolves outside its plugin directory`);
  }
  if (!(await stat(canonicalEntry)).isFile()) {
    throw new Error(`Runtime entry for ${plugin.id} is not a file`);
  }
  if (![".js", ".mjs", ".cjs"].includes(extname(canonicalEntry))) {
    throw new Error(`Runtime entry for ${plugin.id} must be JavaScript`);
  }

  return canonicalEntry;
}

export class RuntimePluginService {
  constructor({
    pluginRoots = [],
    enabledPluginIds = [],
    externalizedPluginIds = [],
    configByPluginId = {},
    dataLocations = null,
    stateStore = null,
    importModule = importRuntimeModule,
    logger = () => {}
  } = {}) {
    this.pluginRoots = [...pluginRoots];
    this.enabledPluginIds = [
      ...new Set(enabledPluginIds.map(String).filter(Boolean))
    ];
    this.externalizedPluginIds = new Set(
      externalizedPluginIds.map(String).filter(Boolean)
    );
    this.configByPluginId = { ...configByPluginId };
    this.dataLocations = dataLocations;
    this.stateStore = stateStore;
    this.importModule = importModule;
    this.logger = logger;
    this.state = "idle";
    this.activePlugins = [];
    this.providers = [];
    this.postProcessors = [];
    this.documentProjectors = [];
    this.tools = [];
    this.toolByName = new Map();
    this.failures = [];
    this.statuses = new Map();
    this.namespacedState = new Map();
    this.persistentState = new Map();
    this.stateWrites = new Set();
    this.stateWriteTail = Promise.resolve();
    this.eventHandlers = new Map();
  }

  async start() {
    if (this.state !== "idle") {
      throw new Error(`Runtime Plugin Service cannot start from ${this.state}`);
    }
    this.state = "starting";

    if (this.stateStore?.readSnapshot) {
      const persisted = await this.stateStore.readSnapshot();
      for (const [key, value] of Object.entries(
        persisted?.snapshot?.kv || {}
      )) {
        this.persistentState.set(key, clone(value));
      }
    }

    const discovery = await discoverRuntimePluginManifests(this.pluginRoots);
    const discoveryFailureIds = new Set();
    for (const failure of discovery.failures) {
      this.failures.push(failure);
      discoveryFailureIds.add(failure.id);
      this.logger({
        level: "error",
        pluginId: failure.id,
        message: `${failure.phase}: ${failure.message}`
      });
    }
    const candidates = new Map();
    for (const plugin of discovery.plugins) {
      const existing = candidates.get(plugin.id) || [];
      existing.push(plugin);
      candidates.set(plugin.id, existing);
    }

    const providerOwners = new Map();
    const documentProjectorOwners = new Map();
    const toolOwners = new Map();
    for (const pluginId of this.enabledPluginIds) {
      const discoveredMatches = candidates.get(pluginId) || [];
      const matches = this.externalizedPluginIds.has(pluginId)
        ? discoveredMatches.filter((plugin) => plugin.origin === "external")
        : discoveredMatches;
      if (matches.length === 0) {
        if (discoveryFailureIds.has(pluginId)) {
          this.statuses.set(pluginId, {
            id: pluginId,
            status: "failed",
            contextProviderIds: [],
            postProcessorIds: [],
            documentProjectorIds: [],
            toolNames: []
          });
          continue;
        }
        if (
          this.externalizedPluginIds.has(pluginId)
          && discoveredMatches.length > 0
        ) {
          this.recordFailure(pluginId, "discovery", new Error(
            `Externalized Runtime plugin ${pluginId} was not found in the external plugin root`
          ));
          continue;
        }
        this.recordFailure(pluginId, "discovery", new Error(
          `Enabled Runtime plugin ${pluginId} was not found`
        ));
        continue;
      }
      if (matches.length > 1) {
        this.recordFailure(pluginId, "manifest", new Error(
          `Runtime plugin id ${pluginId} is duplicated`
        ));
        continue;
      }

      const plugin = matches[0];
      let contribution;
      const registeredProviders = [];
      const registeredPostProcessors = [];
      const registeredDocumentProjectors = [];
      const registeredTools = [];
      const activationDisposables = [];
      try {
        if (!SUPPORTED_RUNTIME_PLUGIN_API_VERSIONS.has(plugin.runtimeApiVersion)) {
          throw new Error(
            `Runtime plugin ${plugin.id} declares API version `
            + `${plugin.runtimeApiVersion}; host provides `
            + RUNTIME_PLUGIN_API_VERSION
          );
        }
        const entryPath = await resolveRuntimeEntry(plugin);
        const module = await this.importModule(pathToFileURL(entryPath).href);
        if (
          module.runtimePluginApiVersion != null
          && module.runtimePluginApiVersion !== plugin.runtimeApiVersion
        ) {
          throw new Error(
            `Runtime plugin ${plugin.id} entry API version `
            + `${module.runtimePluginApiVersion} does not match its manifest`
          );
        }
        if (typeof module.activateRuntimePlugin !== "function") {
          throw new Error(
            `Runtime plugin ${plugin.id} must export activateRuntimePlugin`
          );
        }

        const dataLocationsForPlugin = () => this.dataLocations.forPlugin(plugin.id).data;
        const pluginContext = {
          apiVersion: RUNTIME_PLUGIN_API_VERSION,
          plugin: Object.freeze({
            id: plugin.id,
            version: plugin.version,
            manifestVersion: plugin.manifestVersion,
            entries: Object.freeze({ ...plugin.entries }),
            hosts: Object.freeze({ ...plugin.hosts }),
            capabilities: Object.freeze(plugin.capabilities.map((capability) =>
              Object.freeze({
                ...capability,
                requiredScopes: Object.freeze([...capability.requiredScopes])
              })
            ))
          }),
          config: Object.freeze({
            ...(this.configByPluginId[plugin.id] || {})
          }),
          locations: this.dataLocations
            ? Object.freeze({
                get data() {
                  return dataLocationsForPlugin();
                }
              })
            : Object.freeze({}),
          log: (level, message) => this.logger({
            level,
            pluginId: plugin.id,
            message: String(message)
          })
        };
        if (plugin.runtimeApiVersion >= 2) {
          pluginContext.tools = Object.freeze({
            registerTool: (tool) => {
              const normalized = normalizeToolContribution(plugin, tool);
              if (registeredTools.some((item) => item.name === normalized.name)) {
                throw new Error(
                  `Runtime plugin ${plugin.id} contributes Tool `
                  + `${normalized.name} more than once`
                );
              }
              registeredTools.push(normalized);
              const registration = disposable(() => {
                const index = registeredTools.indexOf(normalized);
                if (index >= 0) registeredTools.splice(index, 1);
              });
              activationDisposables.push(registration);
              return registration;
            }
          });
          pluginContext.context = Object.freeze({
            registerProvider: (provider) => {
              validateContextProvider(provider);
              registeredProviders.push(provider);
              const registration = disposable(() => {
                const index = registeredProviders.indexOf(provider);
                if (index >= 0) registeredProviders.splice(index, 1);
              });
              activationDisposables.push(registration);
              return registration;
            }
          });
          pluginContext.runs = Object.freeze({
            registerPostProcessor: (processor) => {
              validateRunPostProcessor(processor);
              registeredPostProcessors.push(processor);
              const registration = disposable(() => {
                const index = registeredPostProcessors.indexOf(processor);
                if (index >= 0) registeredPostProcessors.splice(index, 1);
              });
              activationDisposables.push(registration);
              return registration;
            }
          });
          pluginContext.documents = Object.freeze({
            registerProjector: (projector) => {
              validateDocumentProjector(projector);
              registeredDocumentProjectors.push(projector);
              const registration = disposable(() => {
                const index = registeredDocumentProjectors.indexOf(projector);
                if (index >= 0) registeredDocumentProjectors.splice(index, 1);
              });
              activationDisposables.push(registration);
              return registration;
            }
          });
          pluginContext.state = Object.freeze({
            namespace: (name = "default") => createPluginStateNamespace({
              pluginId: plugin.id,
              namespace: name,
              memory: this.namespacedState,
              stateStore: this.stateStore,
              persistentState: this.persistentState,
              trackWrite: (pluginId, write) =>
                this.trackStateWrite(pluginId, write)
            })
          });
          pluginContext.events = Object.freeze({
            emit: (type, payload) => {
              const eventType = String(type || "").trim();
              if (!eventType) return;
              for (const handler of this.eventHandlers.get(eventType) || []) {
                try {
                  handler(payload);
                } catch (error) {
                  this.recordFailure(plugin.id, "event", error);
                }
              }
            },
            on: (type, handler) => {
              const eventType = String(type || "").trim();
              if (!eventType || typeof handler !== "function") {
                throw new Error("Runtime event handler requires type and handler");
              }
              const handlers = this.eventHandlers.get(eventType) || new Set();
              handlers.add(handler);
              this.eventHandlers.set(eventType, handlers);
              const registration = disposable(() => {
                handlers.delete(handler);
                if (!handlers.size) this.eventHandlers.delete(eventType);
              });
              activationDisposables.push(registration);
              return registration;
            }
          });
        }

        contribution = await module.activateRuntimePlugin(Object.freeze(pluginContext)) || {};

        if (
          contribution == null
          || typeof contribution !== "object"
          || Array.isArray(contribution)
        ) {
          throw new Error(`Runtime plugin ${plugin.id} returned an invalid contribution`);
        }
        if (
          contribution.dispose != null
          && typeof contribution.dispose !== "function"
        ) {
          throw new Error(`Runtime plugin ${plugin.id} returned an invalid dispose hook`);
        }

        const returnedContextProviders = contribution.contextProviders || [];
        if (!Array.isArray(returnedContextProviders)) {
          throw new Error(
            `Runtime plugin ${plugin.id} contextProviders must be an array`
          );
        }
        const contextProviders = [
          ...registeredProviders,
          ...returnedContextProviders
        ];
        const returnedPostProcessors = contribution.runPostProcessors || [];
        if (!Array.isArray(returnedPostProcessors)) {
          throw new Error(
            `Runtime plugin ${plugin.id} runPostProcessors must be an array`
          );
        }
        const runPostProcessors = [
          ...registeredPostProcessors,
          ...returnedPostProcessors
        ];
        const returnedDocumentProjectors = contribution.documentProjectors || [];
        if (!Array.isArray(returnedDocumentProjectors)) {
          throw new Error(
            `Runtime plugin ${plugin.id} documentProjectors must be an array`
          );
        }
        const documentProjectors = [
          ...registeredDocumentProjectors,
          ...returnedDocumentProjectors
        ];
        const providerIds = new Set();
        for (const provider of contextProviders) {
          validateContextProvider(provider);
          const providerId = String(provider.id);
          if (providerIds.has(providerId)) {
            throw new Error(
              `Runtime plugin ${plugin.id} contributes Context Provider `
              + `${providerId} more than once`
            );
          }
          const owner = providerOwners.get(providerId);
          if (owner) {
            throw new Error(
              `Context Provider ${providerId} is already registered by ${owner}`
            );
          }
          providerIds.add(providerId);
        }
        const processorIds = new Set();
        for (const processor of runPostProcessors) {
          validateRunPostProcessor(processor);
          const processorId = String(processor.id);
          if (processorIds.has(processorId)) {
            throw new Error(
              `Runtime plugin ${plugin.id} contributes Run post-processor `
              + `${processorId} more than once`
            );
          }
          processorIds.add(processorId);
        }
        const documentProjectorIds = new Set();
        for (const projector of documentProjectors) {
          validateDocumentProjector(projector);
          const projectorId = String(projector.id);
          if (documentProjectorIds.has(projectorId)) {
            throw new Error(
              `Runtime plugin ${plugin.id} contributes Document Projector `
              + `${projectorId} more than once`
            );
          }
          const owner = documentProjectorOwners.get(projectorId);
          if (owner) {
            throw new Error(
              `Document Projector ${projectorId} is already registered by ${owner}`
            );
          }
          documentProjectorIds.add(projectorId);
        }

        const returnedTools = contribution.tools || [];
        if (!Array.isArray(returnedTools)) {
          throw new Error(`Runtime plugin ${plugin.id} tools must be an array`);
        }
        const toolContributions = [
          ...registeredTools,
          ...returnedTools.map((tool) =>
            normalizeToolContribution(plugin, tool)
          )
        ];
        const toolNames = new Set();
        for (const tool of toolContributions) {
          const name = tool.name;
          if (toolNames.has(name)) {
            throw new Error(
              `Runtime plugin ${plugin.id} contributes Tool ${name} more than once`
            );
          }
          const owner = toolOwners.get(name);
          if (owner) {
            throw new Error(`Runtime Tool ${name} is already registered by ${owner}`);
          }
          toolNames.add(name);
        }

        for (const providerId of providerIds) providerOwners.set(providerId, plugin.id);
        for (const projectorId of documentProjectorIds) {
          documentProjectorOwners.set(projectorId, plugin.id);
        }
        for (const toolName of toolNames) toolOwners.set(toolName, plugin.id);

        this.providers.push(...contextProviders);
        this.postProcessors.push(...runPostProcessors.map((processor) => ({
          ...processor,
          pluginId: plugin.id,
          order: Number.isFinite(processor.order) ? processor.order : 100
        })).sort((left, right) => left.order - right.order || String(left.id).localeCompare(String(right.id))));
        this.documentProjectors.push(...documentProjectors.map((projector) => ({
          ...projector,
          pluginId: plugin.id
        })));
        this.tools.push(...toolContributions);
        for (const tool of toolContributions) this.toolByName.set(tool.name, tool);
        this.activePlugins.push({
          plugin,
          contribution,
          contextProviders,
          runPostProcessors,
          documentProjectors,
          tools: toolContributions,
          activationDisposables
        });
        this.statuses.set(plugin.id, {
          id: plugin.id,
          version: plugin.version,
          origin: plugin.origin,
          status: "active",
          capabilities: plugin.capabilities.map((capability) => ({
            ...capability,
            requiredScopes: [...capability.requiredScopes]
          })),
          contextProviderIds: contextProviders.map((provider) => provider.id),
          postProcessorIds: runPostProcessors.map((processor) => processor.id),
          documentProjectorIds: documentProjectors.map((projector) => projector.id),
          toolNames: toolContributions.map((tool) => tool.name)
        });
        this.logger({
          level: "info",
          pluginId: plugin.id,
          message:
            `activated v${plugin.version} from ${plugin.origin} `
            + `(providers=${contextProviders.length}, `
            + `postProcessors=${runPostProcessors.length}, `
            + `tools=${toolContributions.length})`
        });
      } catch (error) {
        if (typeof contribution?.dispose === "function") {
          try {
            await contribution.dispose();
          } catch (disposeError) {
            this.recordFailure(plugin.id, "rollback", disposeError);
          }
        }
        for (const registration of [...activationDisposables].reverse()) {
          try {
            registration.dispose();
          } catch (disposeError) {
            this.recordFailure(plugin.id, "rollback", disposeError);
          }
        }
        this.recordFailure(plugin.id, "activation", error);
      }
    }

    this.state = "started";
    return this.snapshot();
  }

  getContextProviders() {
    if (this.state !== "started") {
      throw new Error("Runtime Plugin Service is not started");
    }
    return [...this.providers];
  }

  getRunPostProcessors() {
    if (this.state !== "started") {
      throw new Error("Runtime Plugin Service is not started");
    }
    return [...this.postProcessors].sort((left, right) =>
      left.order - right.order || String(left.id).localeCompare(String(right.id))
    );
  }

  getDocumentProjector(projectorId) {
    if (this.state !== "started") {
      throw new Error("Runtime Plugin Service is not started");
    }
    const id = String(projectorId || "");
    return this.documentProjectors.find((projector) => projector.id === id)
      || null;
  }

  get supportedToolNames() {
    return this.tools.map((tool) => tool.name);
  }

  getToolDefinitions() {
    if (this.state !== "started") {
      throw new Error("Runtime Plugin Service is not started");
    }
    return this.tools.map(toolDefinition);
  }

  getActivePluginInfos() {
    if (this.state !== "started") {
      throw new Error("Runtime Plugin Service is not started");
    }
    return this.activePlugins.map(({ plugin }) => ({
      id: plugin.id,
      version: plugin.version,
      directory: plugin.directory,
      origin: plugin.origin,
      manifest: clone(plugin.manifest)
    }));
  }

  hasTool(name) {
    return this.toolByName.has(String(name || ""));
  }

  async listTools(request = {}) {
    if (this.state !== "started") {
      throw new Error("Runtime Plugin Service is not started");
    }
    const allowed = new Set(request.policy?.allowedTools || []);
    return this.tools
      .filter((tool) =>
        allowed.has(tool.name)
        && presetAllows(request.policy?.preset, tool.minimumPreset)
      )
      .map((tool) => toolDefinitionForPolicy(tool, request.policy));
  }

  async invoke(invocation, signal) {
    if (this.state !== "started") {
      throw new Error("Runtime Plugin Service is not started");
    }
    const tool = this.toolByName.get(String(invocation?.toolCall?.name || ""));
    if (!tool) {
      throw new Error(`Runtime plugin tool not found: ${invocation?.toolCall?.name}`);
    }
    if (!presetAllows(invocation.policy?.preset, tool.minimumPreset)) {
      throw new Error(`${tool.name} requires ${tool.minimumPreset} capability`);
    }
    const args = invocation.toolCall?.arguments;
    const validationErrors = validateToolInput(
      args,
      tool.inputSchema,
      `Runtime Tool ${tool.name} arguments`
    );
    if (validationErrors.length) {
      throw new Error(validationErrors.join("; "));
    }
    signal.throwIfCancelled();
    return normalizeToolResult(await tool.invoke(
      { ...args },
      Object.freeze({
        runId: invocation.runId,
        attemptId: invocation.attemptId,
        sessionId: invocation.sessionId,
        projectId: invocation.projectId,
        principal: invocation.principal,
        policy: invocation.policy,
        toolCall: invocation.toolCall,
        signal
      })
    ));
  }

  snapshot() {
    return {
      state: this.state,
      plugins: this.enabledPluginIds.map((id) =>
        this.statuses.get(id) || {
          id,
          status: "failed",
          contextProviderIds: [],
          postProcessorIds: [],
          documentProjectorIds: [],
          toolNames: []
        }
      ),
      failures: this.failures.map((failure) => ({ ...failure }))
    };
  }

  async stop() {
    if (this.state === "stopped") return this.snapshot();
    if (this.state !== "started") {
      throw new Error(`Runtime Plugin Service cannot stop from ${this.state}`);
    }
    this.state = "stopping";

    for (const active of [...this.activePlugins].reverse()) {
      let stopped = true;
      if (typeof active.contribution.dispose === "function") {
        try {
          await active.contribution.dispose();
        } catch (error) {
          stopped = false;
          this.recordFailure(active.plugin.id, "dispose", error);
        }
      }
      for (const registration of [...active.activationDisposables].reverse()) {
        try {
          registration.dispose();
        } catch (error) {
          stopped = false;
          this.recordFailure(active.plugin.id, "dispose", error);
        }
      }
      const status = this.statuses.get(active.plugin.id);
      if (status && stopped) {
        this.statuses.set(active.plugin.id, { ...status, status: "stopped" });
      }
    }

    this.activePlugins = [];
    this.providers = [];
    this.postProcessors = [];
    this.documentProjectors = [];
    this.tools = [];
    this.toolByName.clear();
    if (this.stateWrites.size) {
      await Promise.allSettled([...this.stateWrites]);
    }
    this.state = "stopped";
    return this.snapshot();
  }

  trackStateWrite(pluginId, write) {
    const pending = this.stateWriteTail.then(write)
      .catch((error) => {
        const failure = pluginFailure(pluginId, "state", error);
        this.failures.push(failure);
        this.logger({
          level: "error",
          pluginId,
          message: `state: ${failure.message}`
        });
      })
      .finally(() => this.stateWrites.delete(pending));
    this.stateWriteTail = pending;
    this.stateWrites.add(pending);
  }

  recordFailure(pluginId, phase, error) {
    const failure = pluginFailure(pluginId, phase, error);
    this.failures.push(failure);
    this.statuses.set(pluginId, {
      id: pluginId,
      status: "failed",
      contextProviderIds: [],
      postProcessorIds: [],
      documentProjectorIds: [],
      toolNames: []
    });
    this.logger({
      level: "error",
      pluginId,
      message: `${phase}: ${failure.message}`
    });
  }
}
