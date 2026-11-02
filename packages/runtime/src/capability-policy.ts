import type { CapabilityPolicy, RunPolicyPreset } from "./protocol.js";

export function normalizeCapabilityPolicy(input: Partial<CapabilityPolicy> = {}): CapabilityPolicy {
  const preset: RunPolicyPreset = [
    "read-only",
    "workspace-write",
    "trusted-automation"
  ].includes(String(input.preset))
    ? input.preset as RunPolicyPreset
    : "read-only";

  return {
    preset,
    allowedTools: Array.isArray(input.allowedTools)
      ? [...new Set(input.allowedTools.map(String).filter(Boolean))]
      : [],
    fileRoots: Array.isArray(input.fileRoots)
      ? input.fileRoots.map(String).filter(Boolean)
      : [],
    allowedCommandPrefixes: Array.isArray(input.allowedCommandPrefixes)
      ? input.allowedCommandPrefixes.map(String).filter(Boolean)
      : [],
    allowedTerminalSessionIds: Array.isArray(input.allowedTerminalSessionIds)
      ? input.allowedTerminalSessionIds.map(String).filter(Boolean)
      : [],
    allowedRecipients: Array.isArray(input.allowedRecipients)
      ? input.allowedRecipients.map((value) => String(value).toLowerCase()).filter(Boolean)
      : [],
    maxMailPerRun: Math.max(0, Number(input.maxMailPerRun) || 0),
    maxToolCalls: Math.max(1, Number(input.maxToolCalls) || 50)
  };
}
