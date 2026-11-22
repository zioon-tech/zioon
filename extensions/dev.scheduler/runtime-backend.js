import { workbenchStorage as localStorage } from "../../src/runtime/workbench-space.ts";
import {
  createHttpRuntimeClient,
  createRemoteRunHandle
} from "../../src/runtime/http-runtime-client.ts";
import { toZionNextRunEvent } from "../../src/runtime/zion-next-compatibility.ts";
import {
  DEFAULT_WORKBENCH_RUNTIME_BASE_URL,
  readWorkbenchRuntimeConfig,
  shouldUseWorkbenchRuntime
} from "../../src/runtime/workbench-runtime-config.ts";

export const SCHEDULER_RUNTIME_ENABLED_KEY = "zion.scheduler.runtime.enabled";
export const SCHEDULER_RUNTIME_BASE_URL_KEY = "zion.scheduler.runtime.baseUrl";
export const DEFAULT_SCHEDULER_RUNTIME_BASE_URL = DEFAULT_WORKBENCH_RUNTIME_BASE_URL;
export const DEFAULT_SCHEDULED_RUNTIME_PROFILE_ID = "scheduled.default";

export const RUNTIME_SCHEDULER_TOOLS = new Set([
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
  "mcpCall"
]);

export function readSchedulerRuntimeConfig({
  state = globalThis.window?.zion?.state,
  storage = localStorage
} = {}) {
  const config = readWorkbenchRuntimeConfig({
    state,
    storage,
    legacyEnabledStateKey: "scheduler.runtime.enabled",
    legacyEnabledStorageKey: SCHEDULER_RUNTIME_ENABLED_KEY,
    legacyBaseUrlStateKey: "scheduler.runtime.baseUrl",
    legacyBaseUrlStorageKey: SCHEDULER_RUNTIME_BASE_URL_KEY
  });
  return config;
}

export function shouldUseSchedulerRuntime(config, options = {}) {
  return shouldUseWorkbenchRuntime(config, options);
}

export function runtimeTaskEligibility(task) {
  if ((task?.taskType || "agent") === "command") {
    return { eligible: true, reason: null };
  }
  if ((task?.executionMode || "local-only") !== "local-only") {
    return { eligible: false, reason: "service-backed-not-supported" };
  }
  const unsupportedTool = (task?.capability?.allowedTools || [])
    .map(String)
    .find((name) => !RUNTIME_SCHEDULER_TOOLS.has(name));
  if (unsupportedTool) {
    return {
      eligible: false,
      reason: `unsupported-tool:${unsupportedTool}`
    };
  }
  return { eligible: true, reason: null };
}

function projectEvents(events) {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of events) {
        yield toZionNextRunEvent(event);
      }
    }
  };
}

export async function createSchedulerRuntimeHandle({
  task,
  schedulerRunId,
  baseUrl,
  fetchImpl
}) {
  const client = createHttpRuntimeClient({ baseUrl, fetchImpl });
  const handle = await createRemoteRunHandle(
    client,
    {
      title: task.title || "",
      prompt: task.prompt || "",
      interactionProfileId: task.interactionProfileId
        || DEFAULT_SCHEDULED_RUNTIME_PROFILE_ID,
      ...(task.modelProfileId
        ? { model: { profileId: String(task.modelProfileId) } }
        : {}),
      projectId: task.projectId || undefined,
      ...(task.nodeId ? { target: { nodeId: String(task.nodeId) } } : {}),
      policy: task.capability || { preset: "read-only" },
      timeoutMs: Math.max(10, Number(task.timeoutSeconds) || 300) * 1000,
      metadata: {
        source: "scheduler",
        interactionProfileId: task.interactionProfileId
          || DEFAULT_SCHEDULED_RUNTIME_PROFILE_ID,
        schedulerTaskId: task.id,
        schedulerRunId
      }
    },
    {
      subscription: {
        mode: "projection",
        reasoningMode: "none"
      }
    }
  );
  return {
    ...handle,
    events: projectEvents(handle.events)
  };
}

export async function observeSchedulerRuntimeRun({
  runtimeRunId,
  afterSequence = 0,
  baseUrl,
  fetchImpl,
  signal,
  onEvent = async () => {}
}) {
  const client = createHttpRuntimeClient({ baseUrl, fetchImpl });
  let lastEventSequence = Math.max(0, Number(afterSequence) || 0);
  for await (const event of client.subscribe(runtimeRunId, {
    afterSequence: lastEventSequence,
    signal,
    mode: "projection",
    reasoningMode: "none"
  })) {
    const projected = toZionNextRunEvent(event);
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

export async function abortSchedulerRuntimeRun({
  runtimeRunId,
  baseUrl,
  reason = "user",
  fetchImpl
}) {
  const client = createHttpRuntimeClient({ baseUrl, fetchImpl });
  await client.abort(runtimeRunId, reason);
}
