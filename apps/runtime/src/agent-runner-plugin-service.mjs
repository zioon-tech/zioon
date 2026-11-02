import { DEFAULT_INTERACTION_PROFILE_ID } from "./interaction-profile-store.mjs";

function stringList(value) {
  return Array.isArray(value)
    ? Array.from(new Set(value.map(String).map((item) => item.trim()).filter(Boolean)))
    : [];
}

const AGENT_TOOL_HINTS = new Map([
  ["read", ["read", "fsRead", "fsEntries", "fsTree", "tree"]],
  ["search", ["grep", "glob", "localSearch", "webSearch"]],
  ["web", ["webSearch", "webFetch"]],
  ["edit", ["edit", "write"]],
  ["write", ["edit", "write"]],
  ["diff", ["read", "grep"]],
  ["test", []]
]);

const AGENT_MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "sessionCreate",
  "sessionUpdate",
  "sessionDelete",
  "memoryManage",
  "agentsManage",
  "pluginsManage",
  "terminalManage",
  "todoWrite"
]);

function expandAgentToolHints(values = []) {
  const out = new Set();
  for (const value of stringList(values)) {
    const mapped = AGENT_TOOL_HINTS.get(value);
    if (mapped) {
      for (const name of mapped) out.add(name);
    } else {
      out.add(value);
    }
  }
  return out;
}

function presetRank(value) {
  if (value === "trusted-automation") return 3;
  if (value === "workspace-write") return 2;
  return 1;
}

function capPreset(value, ceiling) {
  return presetRank(value) <= presetRank(ceiling) ? value : ceiling;
}

export function buildAgentTaskMessages(task = {}) {
  const outputContract = [
    "1. Context Brief",
    "2. Work Result",
    "3. Evidence",
    "4. Next Actions"
  ].join("\n");
  const prompt = String(task.prompt || task.anchorText || task.quote || task.title || "").trim();
  const system = [
    "You are running a Zion Agent Task inside the headless Runtime Host.",
    "Keep the work scoped to the task, respect the capability policy, and return structured Markdown.",
    "",
    `Agent: ${task.agentId || "agent"}`,
    `Task id: ${task.id || ""}`,
    `Permission mode: ${task.permissionMode || "default"}`,
    `Allowed capability hints: ${stringList(task.tools).join(", ") || "none"}`,
    `Disallowed capability hints: ${stringList(task.disallowedTools).join(", ") || "none"}`,
    "",
    "Output contract:",
    outputContract,
    "",
    "Anchored context:",
    task.anchorText || task.quote || ""
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: prompt || String(task.body || "").replace(/^user\s+/i, "").trim() || task.title || task.id }
  ];
}

export function deriveAgentTaskPolicy(task = {}, {
  profilePolicy = {},
  parentPolicy = {}
} = {}) {
  const profileAllowed = stringList(profilePolicy.allowedTools);
  const parentAllowed = stringList(parentPolicy.allowedTools);
  const requested = expandAgentToolHints(task.tools);
  const disallowed = expandAgentToolHints(task.disallowedTools);
  const parentAllowedSet = new Set(parentAllowed);
  const requestedSet = requested.size ? requested : new Set(profileAllowed);
  let allowedTools = profileAllowed.filter((name) =>
    requestedSet.has(name)
    && !disallowed.has(name)
    && name !== "agentsManage"
    && (!parentAllowedSet.size || parentAllowedSet.has(name))
  );
  const readOnlyTask = ["read-only", "plan"].includes(String(task.permissionMode || ""));
  const parentPreset = parentPolicy.preset || "read-only";
  const profilePreset = profilePolicy.preset || "read-only";
  let preset = readOnlyTask ? "read-only" : "workspace-write";
  preset = capPreset(capPreset(preset, profilePreset), parentPreset);
  if (preset === "read-only") {
    allowedTools = allowedTools.filter((name) => !AGENT_MUTATING_TOOLS.has(name));
  }
  return {
    ...profilePolicy,
    ...parentPolicy,
    preset,
    allowedTools,
    maxToolCalls: Math.min(
      Math.max(1, Number(profilePolicy.maxToolCalls) || 50),
      Math.max(1, Number(parentPolicy.maxToolCalls) || 50),
      Math.max(1, Number(task.maxTurns || 8) * 4)
    ),
    fileRoots: stringList(parentPolicy.fileRoots || profilePolicy.fileRoots),
    allowedCommandPrefixes: [],
    allowedTerminalSessionIds: [],
    allowedRecipients: [],
    maxMailPerRun: 0
  };
}

export function createAgentRunnerPluginService({
  getExecutor,
  interactionProfiles,
  resolveModel
}) {
  const activeRuns = new Map();
  return Object.freeze({
    startTaskRun(task = {}, {
      interactionProfileId = DEFAULT_INTERACTION_PROFILE_ID,
      parentRunId = "",
      parentAttemptId = "",
      principal,
      projectId = "",
      policy = {}
    } = {}) {
      const executor = getExecutor?.();
      if (!executor?.execute) throw new Error("Runtime Agent executor is unavailable");
      const profileId = String(interactionProfileId || DEFAULT_INTERACTION_PROFILE_ID);
      const profile = interactionProfiles.get(profileId)
        || interactionProfiles.get(DEFAULT_INTERACTION_PROFILE_ID);
      if (!profile) throw new Error(`Interaction profile not found: ${profileId}`);
      const modelRef = profile.modelProfileId
        ? { profileId: profile.modelProfileId }
        : profile.model || null;
      const model = typeof resolveModel === "function"
        ? resolveModel(modelRef)
        : modelRef || undefined;
      const sessionId = String(task.taskSessionId || `agent-task:${task.id}`);
      const runPolicy = deriveAgentTaskPolicy(task, {
        profilePolicy: profile.policy,
        parentPolicy: policy
      });
      const handle = executor.execute({
        title: task.title || `Agent Task: ${task.id}`,
        messages: buildAgentTaskMessages(task),
        interactionProfileId: profile.id,
        sessionId,
        projectId: projectId || task.projectId || undefined,
        ...(principal ? { principal: { ...principal, parentRunId } } : {}),
        model,
        policy: runPolicy,
        maxTurns: Math.max(1, Number(task.maxTurns || 8)),
        metadata: {
          source: "agent-task",
          agentTaskId: task.id,
          agentId: task.agentId || "",
          parentRunId: parentRunId || "",
          parentAttemptId: parentAttemptId || "",
          interactionProfileId: profile.id
        }
      });
      activeRuns.set(handle.runId, handle);
      handle.completion
        .finally(() => activeRuns.delete(handle.runId))
        .catch(() => {});
      return {
        ...handle,
        sessionId,
        policy: runPolicy
      };
    },
    async abortRun(runId, reason = "user") {
      const handle = activeRuns.get(String(runId || ""));
      if (!handle) return false;
      await handle.abort(String(reason || "user"));
      return true;
    }
  });
}
