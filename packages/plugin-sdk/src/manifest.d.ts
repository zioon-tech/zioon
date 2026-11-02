export type PluginEntryKind =
  | "shared"
  | "skill"
  | "runtime"
  | "resource"
  | "renderer"
  | "workbench"
  | "cli";

export type PluginHostKind = "workbench" | "runtime" | "device" | "cli";

export type PluginModelDescriptor = {
  id: string;
  name?: string;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsImages?: boolean;
  contextWindow?: number;
};

export type ToolExecutionEffect = "read" | "write" | "process" | "external";
export type ToolCancellationMode = "cooperative" | "best-effort" | "none";
export type ToolIdempotencyMode = "safe" | "invocation" | "reconcile";

export type ToolExecutionPolicy = {
  effect: ToolExecutionEffect;
  timeoutMs: number;
  maxTimeoutMs: number;
  cancellation: ToolCancellationMode;
  idempotency: ToolIdempotencyMode;
  timeoutArgument?: string;
};

export type PluginCapabilityKind =
  | "tool"
  | "context"
  | "post-processor"
  | "controller"
  | "model"
  | "job"
  | "resource"
  | "renderer"
  | "skill"
  | "command";

export type NormalizedPluginManifest = {
  manifestVersion: number;
  id: string;
  name: string;
  version: string;
  entries: Partial<Record<PluginEntryKind, string>>;
  hosts: Record<PluginHostKind, boolean>;
  capabilities: Array<{
    id: string;
    kind: PluginCapabilityKind;
    host: PluginHostKind;
    required?: boolean;
    risk?: string;
    requiredScopes: string[];
    models?: PluginModelDescriptor[];
  }>;
  settingsSchema?: Record<string, unknown>;
  connection?: { label: string; envKeys: string[]; required: boolean };
  runtimeApiVersion: number;
  legacyEnvelope: boolean;
};

export const PLUGIN_MANIFEST_VERSION: number;
export const PLUGIN_ENTRY_KINDS: readonly PluginEntryKind[];
export const PLUGIN_CAPABILITY_KINDS: readonly PluginCapabilityKind[];
export const PLUGIN_HOST_KINDS: readonly PluginHostKind[];
export const TOOL_EXECUTION_EFFECTS: readonly ToolExecutionEffect[];
export const TOOL_CANCELLATION_MODES: readonly ToolCancellationMode[];
export const TOOL_IDEMPOTENCY_MODES: readonly ToolIdempotencyMode[];

export function normalizeToolExecution(
  input?: Partial<ToolExecutionPolicy> | null,
  options?: { risk?: string; fallbackEffect?: ToolExecutionEffect }
): Readonly<ToolExecutionPolicy>;

export function toolExecutionForDefinition(
  definition?: {
    risk?: string;
    execution?: Partial<ToolExecutionPolicy>;
  }
): Readonly<ToolExecutionPolicy>;

export function resolveToolExecutionTimeoutMs(
  execution: Partial<ToolExecutionPolicy>,
  args?: Record<string, unknown>
): number;

export function validateToolInputSchema(
  schema: unknown,
  path?: string
): string[];

export function validateToolInput(
  input: unknown,
  schema: unknown,
  path?: string
): string[];

export function validatePluginManifest(
  input: unknown,
  options?: { host?: PluginHostKind | "" }
): {
  valid: boolean;
  errors: string[];
  warnings: string[];
  normalized: NormalizedPluginManifest;
};

export function normalizePluginManifest(
  input: unknown,
  options?: { host?: PluginHostKind | "" }
): NormalizedPluginManifest;
export function normalizePluginSettingsSchema(input: unknown): Record<string, unknown>;
