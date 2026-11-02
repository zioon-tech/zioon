import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { AGENTFS_MCP_READ_NAMES } from "../../../packages/plugin-sdk/src/agentfs-mcp-policy.mjs";

export const DEFAULT_INTERACTION_PROFILE_ID = "interactive.default";
export const DEFAULT_SCHEDULED_INTERACTION_PROFILE_ID = "scheduled.default";
export const DEFAULT_INTERACTION_MODEL_PROFILE_ID = "workbench.user.dynamic.kimi-k2.5";

const PRESETS = new Set(["read-only", "workspace-write", "trusted-automation"]);
const DEFAULT_MUTATING_TOOL_EXCLUSIONS = new Set(["sendMail"]);
const DEFAULT_SCHEDULED_TOOL_NAMES = new Set([
  "read",
  "glob",
  "grep",
  "tree",
  "webSearch",
  "webFetch",
  "observabilityQuery",
  "observabilityRawRead"
]);
export const DEFAULT_INTERACTIVE_READONLY_TOOL_NAMES = Object.freeze([
  "read",
  "glob",
  "grep",
  "tree",
  "webSearch",
  "webFetch",
  "terminalInventory",
  "skillsList",
  "memoryList",
  "identityContext",
  ...AGENTFS_MCP_READ_NAMES,
  "observabilityQuery",
  "observabilityRawRead",
  "sessionList",
  "sessionGet",
  "goalManage",
  "compressionRecall"
]);
const CONTEXT_PROVIDER_ID_ALIASES = new Map([
  ["skills", "dev.skills.available"],
  ["memory", "dev.memory.context"],
  ["terminal-inventory", "dev.terminal-manager.inventory"],
  ["identity", "dev.identity.context"],
  ["project", "dev.identity.context"],
  ["compression", "dev.context-compression"],
  ["goal", "dev.goal.context"]
]);
const DEFAULT_INTERACTIVE_CONTEXT_PROVIDERS = [
  "dev.skills.available",
  "dev.terminal-manager.inventory",
  "dev.memory.context",
  "dev.identity.context",
  "dev.context-compression"
];
const DEFAULT_SCHEDULED_CONTEXT_PROVIDERS = [
  "dev.skills.available",
  "dev.terminal-manager.inventory",
  "dev.memory.context",
  "dev.identity.context",
  "dev.context-compression"
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(objectValue(value), key);
}

function stringList(value) {
  return Array.isArray(value)
    ? Array.from(new Set(value.map(String).map((item) => item.trim()).filter(Boolean)))
    : [];
}

function contextProviderIds(value) {
  return Array.from(new Set(
    stringList(value).map((id) => CONTEXT_PROVIDER_ID_ALIASES.get(id) || id)
  ));
}

function normalizePolicy(policy = {}) {
  const preset = PRESETS.has(String(policy?.preset))
    ? String(policy.preset)
    : "read-only";
  return {
    preset,
    allowedTools: stringList(policy?.allowedTools),
    maxToolCalls: Math.max(1, Number(policy?.maxToolCalls) || 50),
    fileRoots: stringList(policy?.fileRoots),
    allowedCommandPrefixes: stringList(policy?.allowedCommandPrefixes),
    allowedTerminalSessionIds: stringList(policy?.allowedTerminalSessionIds),
    allowedRecipients: stringList(policy?.allowedRecipients)
      .map((value) => value.toLowerCase()),
    maxMailPerRun: Math.max(0, Number(policy?.maxMailPerRun) || 0)
  };
}

function normalizeContextProviders(value = {}) {
  if (Array.isArray(value)) {
    return { enabled: contextProviderIds(value), disabled: [] };
  }
  return {
    enabled: contextProviderIds(value?.enabled),
    disabled: contextProviderIds(value?.disabled)
  };
}

function definedPatch(value) {
  const source = objectValue(value);
  return Object.fromEntries(
    Object.entries(source).filter(([, item]) => item !== undefined)
  );
}

function mergePolicy(base = {}, override = {}) {
  return normalizePolicy({
    ...objectValue(base),
    ...definedPatch(override)
  });
}

function mergeContextProviders(base = {}, override = {}) {
  const baseProviders = normalizeContextProviders(base);
  const patch = objectValue(override);
  return {
    enabled: hasOwn(patch, "enabled")
      ? stringList(patch.enabled)
      : baseProviders.enabled,
    disabled: hasOwn(patch, "disabled")
      ? stringList(patch.disabled)
      : baseProviders.disabled
  };
}

export function normalizeInteractionProfile(input = {}) {
  const source = objectValue(input);
  const id = String(source.id || "").trim();
  if (!id) throw new Error("Interaction profile id is required");

  const modelProfileId = String(source.modelProfileId || "").trim();
  const model = source.model && typeof source.model === "object"
    ? clone(source.model)
    : null;
  if (!modelProfileId && !model) {
    throw new Error(`Interaction profile model is required: ${id}`);
  }

  return {
    id,
    label: String(source.label || id),
    ...(modelProfileId ? { modelProfileId } : {}),
    ...(model ? { model } : {}),
    policy: normalizePolicy(source.policy),
    contextProviders: normalizeContextProviders(source.contextProviders),
    metadata: clone(objectValue(source.metadata))
  };
}

export function mergeInteractionProfile(profile, patch = {}) {
  const source = objectValue(profile);
  const update = objectValue(patch);
  return normalizeInteractionProfile({
    ...source,
    ...definedPatch(update),
    id: source.id,
    policy: mergePolicy(source.policy, update.policy),
    contextProviders: mergeContextProviders(
      source.contextProviders,
      update.contextProviders
    ),
    metadata: {
      ...clone(objectValue(source.metadata)),
      ...clone(objectValue(update.metadata))
    }
  });
}

export function createDefaultInteractionProfile({
  id = DEFAULT_INTERACTION_PROFILE_ID,
  modelProfileId = DEFAULT_INTERACTION_MODEL_PROFILE_ID,
  availableToolNames = [],
  excludedToolNames = DEFAULT_MUTATING_TOOL_EXCLUSIONS,
  maxToolCalls = 50
} = {}) {
  const excluded = new Set(stringList([...excludedToolNames]));
  const safeDefaults = new Set(DEFAULT_INTERACTIVE_READONLY_TOOL_NAMES);
  const allowedTools = stringList(availableToolNames)
    .filter((name) => safeDefaults.has(name) && !excluded.has(name));
  return normalizeInteractionProfile({
    id,
    label: "Default interactive agent",
    modelProfileId,
    policy: {
      preset: "read-only",
      allowedTools,
      fileRoots: [],
      allowedTerminalSessionIds: [],
      allowedCommandPrefixes: [],
      allowedRecipients: [],
      maxMailPerRun: 0,
      maxToolCalls
    },
    contextProviders: {
      enabled: DEFAULT_INTERACTIVE_CONTEXT_PROVIDERS,
      disabled: []
    },
    metadata: {
      includeTerminalContext: true
    }
  });
}

export function createDefaultScheduledInteractionProfile({
  id = DEFAULT_SCHEDULED_INTERACTION_PROFILE_ID,
  modelProfileId = DEFAULT_INTERACTION_MODEL_PROFILE_ID,
  availableToolNames = [],
  maxToolCalls = 30
} = {}) {
  const allowedTools = stringList(availableToolNames)
    .filter((name) => DEFAULT_SCHEDULED_TOOL_NAMES.has(name));
  return normalizeInteractionProfile({
    id,
    label: "Default scheduled agent",
    modelProfileId,
    policy: {
      preset: "read-only",
      allowedTools,
      fileRoots: [],
      allowedTerminalSessionIds: [],
      allowedCommandPrefixes: [],
      allowedRecipients: [],
      maxMailPerRun: 0,
      maxToolCalls
    },
    contextProviders: {
      enabled: DEFAULT_SCHEDULED_CONTEXT_PROVIDERS,
      disabled: []
    },
    metadata: {
      includeTerminalContext: true
    }
  });
}

export function resolveInteractionRequest({
  body = {},
  interactionProfiles,
  resolveModel,
  fallbackModel = null
} = {}) {
  const profileId = String(body?.interactionProfileId || "").trim();
  let profile = null;
  if (profileId) {
    if (!interactionProfiles?.get) {
      const error = new Error("Runtime interaction profiles are unavailable");
      error.statusCode = 501;
      throw error;
    }
    profile = interactionProfiles.get(profileId);
    if (!profile) {
      const error = new Error(`Interaction profile not found: ${profileId}`);
      error.statusCode = 404;
      throw error;
    }
  }

  const profileModel = profile?.modelProfileId
    ? { profileId: profile.modelProfileId }
    : profile?.model;
  const requestedModel = body?.model || profileModel || null;
  const model = typeof resolveModel === "function"
    ? resolveModel(requestedModel)
    : requestedModel || fallbackModel || null;
  const policy = mergePolicy(profile?.policy, body?.policy);
  let metadata = {
    ...objectValue(profile?.metadata),
    ...(profile
      ? {
          interactionProfileId: profile.id,
          interactionProfileLabel: profile.label,
          contextProviders: profile.contextProviders
        }
      : {}),
    ...objectValue(body?.metadata)
  };
  if (
    profile?.id === DEFAULT_SCHEDULED_INTERACTION_PROFILE_ID
    && metadata.source === "scheduler-worker"
  ) {
    const providers = normalizeContextProviders(metadata.contextProviders);
    metadata = {
      ...metadata,
      includeTerminalContext: true,
      contextProviders: {
        enabled: Array.from(new Set([
          ...providers.enabled,
          "dev.terminal-manager.inventory"
        ])),
        disabled: providers.disabled.filter(
          (id) => id !== "dev.terminal-manager.inventory"
        )
      }
    };
  }

  return {
    profile,
    model,
    policy,
    metadata
  };
}

export class FileInteractionProfileStore {
  constructor(path = "") {
    this.path = String(path || "");
    this.profiles = new Map();
    this.load();
  }

  load() {
    if (!this.path) return;
    try {
      const payload = JSON.parse(readFileSync(this.path, "utf8"));
      for (const profile of Array.isArray(payload?.profiles) ? payload.profiles : []) {
        const normalized = normalizeInteractionProfile(profile);
        this.profiles.set(normalized.id, normalized);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  list() {
    return Array.from(this.profiles.values(), (profile) => clone(profile));
  }

  get(id) {
    const profile = this.profiles.get(String(id || ""));
    return profile ? clone(profile) : null;
  }

  upsert(profile) {
    const normalized = normalizeInteractionProfile(profile);
    this.profiles.set(normalized.id, normalized);
    this.persist();
    return clone(normalized);
  }

  patch(id, patch) {
    const current = this.get(id);
    if (!current) {
      const error = new Error(`Interaction profile not found: ${id}`);
      error.statusCode = 404;
      throw error;
    }
    const next = mergeInteractionProfile(current, patch);
    this.profiles.set(next.id, next);
    this.persist();
    return clone(next);
  }

  ensure(profile) {
    const normalized = normalizeInteractionProfile(profile);
    const current = this.get(normalized.id);
    if (current) return current;
    this.profiles.set(normalized.id, normalized);
    this.persist();
    return clone(normalized);
  }

  persist() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({ version: 1, profiles: this.list() }, null, 2),
      { mode: 0o600 }
    );
    renameSync(temporary, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Some filesystems do not support POSIX permissions.
    }
  }
}
