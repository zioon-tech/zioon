export type PluginEntryKind =
  | "shared"
  | "skill"
  | "runtime"
  | "resource"
  | "renderer"
  | "workbench"
  | "cli";

export type PluginHostKind = "workbench" | "runtime" | "device" | "cli";

export type PluginCapabilityKind =
  | "tool"
  | "context"
  | "post-processor"
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
    risk?: string;
    requiredScopes: string[];
  }>;
  runtimeApiVersion: number;
  legacyEnvelope: boolean;
};

export const PLUGIN_MANIFEST_VERSION: number;
export const PLUGIN_ENTRY_KINDS: readonly PluginEntryKind[];
export const PLUGIN_CAPABILITY_KINDS: readonly PluginCapabilityKind[];
export const PLUGIN_HOST_KINDS: readonly PluginHostKind[];

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
