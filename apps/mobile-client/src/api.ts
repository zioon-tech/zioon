import { createParser } from "eventsource-parser";
import type {
  AccessDevice,
  AccessSession,
  ActiveRun,
  Artifact,
  CapabilityTool,
  ChangeSet,
  FileEntry,
  PairingInput,
  PluginRecord,
  RunEvent,
  RunRecord,
  RuntimeHealth,
  RuntimeInteractionProfile,
  RuntimeModelProfile,
  SchedulerRun,
  SchedulerTask,
  SessionConfigurationPatch,
  SessionMessage,
  SessionRecord,
  SessionSummary,
  SkillsSnapshot,
  TerminalSession,
  TodoList,
  TranscriptContent,
} from "./types";

const configuredBaseUrl = String(import.meta.env.VITE_RUNTIME_URL || "")
  .trim()
  .replace(/\/+$/, "");

export const runtimeBaseUrl = configuredBaseUrl;

export class RuntimeApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown = null) {
    super(message);
    this.name = "RuntimeApiError";
    this.status = status;
    this.payload = payload;
  }
}

function apiUrl(path: string): string {
  if (!path.startsWith("/")) throw new Error(`Runtime path must be absolute: ${path}`);
  return `${runtimeBaseUrl}${path}`;
}

async function responsePayload(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function errorMessage(response: Response, payload: unknown): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    return String((payload as { error?: unknown }).error || `HTTP ${response.status}`);
  }
  return typeof payload === "string" && payload.trim()
    ? payload
    : `Runtime HTTP ${response.status}`;
}

export async function requestJson<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...options,
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new RuntimeApiError(response.status, errorMessage(response, payload), payload);
  }
  return payload as T;
}

export async function getHealth(): Promise<RuntimeHealth> {
  return await requestJson<RuntimeHealth>("/health");
}

export async function getAccessSession(): Promise<AccessSession> {
  return await requestJson<AccessSession>("/v1/access/session");
}

function mobileDeviceId(): string {
  const key = "zion.mobile.deviceId";
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const value = `client:${crypto.randomUUID()}`;
    localStorage.setItem(key, value);
    return value;
  } catch {
    return `client:${crypto.randomUUID()}`;
  }
}

function mobileDevice() {
  const hints = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = String(hints.userAgentData?.platform || navigator.platform || "");
  return {
    deviceId: mobileDeviceId(),
    label: platform ? `${platform} Zion Mobile` : "Zion Mobile",
    platform,
  };
}

export async function exchangePairing(input: PairingInput): Promise<AccessSession | null> {
  await requestJson("/v1/access/pair", {
    method: "POST",
    body: JSON.stringify({
      ...input,
      device: mobileDevice(),
    }),
  });
  return await getAccessSession().catch(() => null);
}

export async function logout(): Promise<void> {
  await requestJson("/v1/access/logout", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function listDevices(): Promise<AccessDevice[]> {
  const body = await requestJson<{ devices?: AccessDevice[] }>("/v1/access/devices");
  return Array.isArray(body.devices) ? body.devices : [];
}

export async function revokeDevice(deviceId: string): Promise<void> {
  await requestJson(`/v1/access/devices/${encodeURIComponent(deviceId)}/revoke`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function createPairing(kind: "client" | "resource") {
  return await requestJson<{
    pairingId: string;
    secret: string;
    userCode: string;
    pairingUrl: string;
    kind: string;
    expiresAt: number;
  }>("/v1/access/pairings", {
    method: "POST",
    body: JSON.stringify({
      kind,
      delivery: kind === "resource" ? "bearer" : "cookie",
    }),
  });
}

export async function listDeviceNodes(): Promise<Record<string, unknown>> {
  return await requestJson<Record<string, unknown>>("/v1/device-nodes");
}

export async function listSessions(limit = 100, offset = 0): Promise<SessionRecord[]> {
  const query = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  const body = await requestJson<{ sessions?: SessionRecord[] }>(
    `/v1/sessions?${query}`,
  );
  return Array.isArray(body.sessions) ? body.sessions : [];
}

export async function listSessionSummaries(
  limit = 50,
  offset = 0,
  query = "",
): Promise<SessionSummary[]> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (query.trim()) params.set("query", query.trim());
  const body = await requestJson<{ sessions?: SessionSummary[] }>(
    `/v1/mobile/sessions?${params}`,
  );
  const sessions = Array.isArray(body.sessions) ? body.sessions : [];
  // #region debug-point A:mobile-session-titles
  try { const probe = (globalThis as any).__zionScheduledSurfaceProbe; if (probe?.url) void fetch(probe.url, { method: "POST", body: JSON.stringify({ sessionId: "scheduled-session-surfaces", runId: probe.phase || "pre-fix", hypothesisId: "A", location: "apps/mobile-client/src/api.ts:listSessionSummaries", msg: "[DEBUG] Mobile received Runtime session titles", data: { sessions: sessions.slice(0, 100).map((session) => ({ id: session.id, title: session.title, activeRunId: session.activeRun?.runId || null })) }, ts: Date.now() }) }).catch(() => {}); } catch {}
  // #endregion
  return sessions;
}

export async function getSession(sessionId: string): Promise<SessionRecord> {
  const body = await requestJson<{ session: SessionRecord }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}`,
  );
  return body.session;
}

export async function updateSessionConfiguration(
  sessionId: string,
  patch: SessionConfigurationPatch,
): Promise<SessionRecord> {
  const body = await requestJson<{ session: SessionRecord }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
  );
  return body.session;
}

export async function createSession(input: {
  title?: string;
  interactionProfileId?: string;
} = {}): Promise<SessionRecord> {
  const interactionProfileId =
    input.interactionProfileId?.trim() || "interactive.default";
  const body = await requestJson<{ session: SessionRecord }>("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      ...input,
      interactionProfileId,
    }),
  });
  return body.session;
}

export async function getSessionMessages(
  sessionId: string,
  after = 0,
): Promise<SessionMessage[]> {
  const body = await requestJson<{ messages?: SessionMessage[] }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/transcript?after=${Math.max(0, after)}`,
  );
  return Array.isArray(body.messages) ? body.messages : [];
}

export async function getActiveRun(sessionId: string): Promise<ActiveRun | null> {
  const body = await requestJson<{ activeRun?: ActiveRun | null }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/active-run`,
  );
  return body.activeRun || null;
}

export async function sendSessionMessage(
  sessionId: string,
  input: {
    content: TranscriptContent;
    clientRequestId: string;
    modelOptions?: Record<string, unknown>;
  },
): Promise<{
  sessionId: string;
  message: SessionMessage;
  runId: string;
  attemptId: string;
  status: "accepted";
}> {
  return await requestJson(
    `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function forkSession(sessionId: string): Promise<SessionRecord> {
  const body = await requestJson<{ session: SessionRecord }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/fork`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
  return body.session;
}

export async function getRun(runId: string): Promise<RunRecord> {
  const body = await requestJson<{ run: RunRecord }>(
    `/v1/runs/${encodeURIComponent(runId)}`,
  );
  return body.run;
}

export async function abortRun(runId: string): Promise<void> {
  await requestJson(`/v1/runs/${encodeURIComponent(runId)}/abort`, {
    method: "POST",
    body: JSON.stringify({ reason: "mobile-user" }),
  });
}

export async function getSessionArtifacts(sessionId: string): Promise<{
  artifacts: Artifact[];
  changes: ChangeSet[];
}> {
  const body = await requestJson<{
    artifacts?: Artifact[];
    changes?: ChangeSet[];
  }>(`/v1/sessions/${encodeURIComponent(sessionId)}/artifacts`);
  return {
    artifacts: Array.isArray(body.artifacts) ? body.artifacts : [],
    changes: Array.isArray(body.changes) ? body.changes : [],
  };
}

export async function* subscribeRun(
  runId: string,
  {
    afterSequence = 0,
    signal,
  }: {
    afterSequence?: number;
    signal?: AbortSignal;
  } = {},
): AsyncGenerator<RunEvent> {
  const query = new URLSearchParams({
    after: String(Math.max(0, afterSequence)),
    reasoning: "summary",
    max_delay_ms: "100",
    max_chunk_chars: "512",
  });
  const response = await fetch(
    apiUrl(`/v1/runs/${encodeURIComponent(runId)}/projection/stream?${query}`),
    {
      credentials: "include",
      headers: {
        accept: "text/event-stream",
        ...(afterSequence ? { "last-event-id": String(afterSequence) } : {}),
      },
      signal,
    },
  );
  if (!response.ok || !response.body) {
    const payload = await responsePayload(response);
    throw new RuntimeApiError(response.status, errorMessage(response, payload), payload);
  }

  const queue: RunEvent[] = [];
  let parseError: Error | null = null;
  const parser = createParser({
    onEvent(frame) {
      if (!frame.data) return;
      try {
        const event = JSON.parse(frame.data) as RunEvent;
        if (frame.event === "error") {
          parseError = new Error(String(event?.data?.error || "Run stream failed"));
        } else {
          queue.push(event);
        }
      } catch {
        parseError = new Error("Runtime returned invalid Run stream JSON");
      }
    },
    onError(error) {
      parseError = error;
    },
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      parser.feed(decoder.decode(value || new Uint8Array(), { stream: !done }));
      if (parseError) throw parseError;
      while (queue.length) {
        yield queue.shift()!;
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function listModels(): Promise<{
  activeProfileId: string | null;
  profiles: RuntimeModelProfile[];
}> {
  const body = await requestJson<{
    activeProfileId?: string | null;
    profiles?: RuntimeModelProfile[];
  }>("/v1/models");
  return {
    activeProfileId: body.activeProfileId || null,
    profiles: Array.isArray(body.profiles) ? body.profiles : [],
  };
}

export async function listInteractionProfiles(): Promise<RuntimeInteractionProfile[]> {
  const body = await requestJson<{ profiles?: RuntimeInteractionProfile[] }>(
    "/v1/interaction-profiles",
  );
  return Array.isArray(body.profiles) ? body.profiles : [];
}

export async function patchInteractionProfile(
  profileId: string,
  patch: Partial<RuntimeInteractionProfile>,
): Promise<RuntimeInteractionProfile> {
  const body = await requestJson<{ profile: RuntimeInteractionProfile }>(
    `/v1/interaction-profiles/${encodeURIComponent(profileId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
  );
  return body.profile;
}

export async function listCapabilityTools(): Promise<CapabilityTool[]> {
  const body = await requestJson<{ tools?: CapabilityTool[] }>(
    "/v1/capabilities/tools",
  );
  return Array.isArray(body.tools) ? body.tools : [];
}

export async function listTodoLists(): Promise<TodoList[]> {
  const body = await requestJson<{ todoLists?: TodoList[] }>(
    "/v1/todo-lists?limit=100",
  );
  return Array.isArray(body.todoLists) ? body.todoLists : [];
}

export async function listSchedulerTasks(): Promise<SchedulerTask[]> {
  const body = await requestJson<{ tasks?: SchedulerTask[] }>(
    "/v1/scheduler/tasks",
  );
  return Array.isArray(body.tasks) ? body.tasks : [];
}

export async function getSchedulerTask(taskId: string): Promise<SchedulerTask> {
  return await requestJson<SchedulerTask>(
    `/v1/scheduler/tasks/${encodeURIComponent(taskId)}`,
  );
}

export async function listSchedulerRuns(
  taskId = "",
  limit = 100,
): Promise<SchedulerRun[]> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (taskId) query.set("task_id", taskId);
  const body = await requestJson<SchedulerRun[] | { runs?: SchedulerRun[] }>(
    `/v1/scheduler/runs?${query}`,
  );
  if (Array.isArray(body)) return body;
  return Array.isArray(body.runs) ? body.runs : [];
}

export async function getSchedulerRun(runId: string): Promise<SchedulerRun> {
  const run = await requestJson<SchedulerRun>(
    `/v1/scheduler/runs/${encodeURIComponent(runId)}?event_limit=50`,
  );
  // #region debug-point B-D:mobile-scheduler-run
  try { const probe = (globalThis as any).__zionScheduledSurfaceProbe; if (probe?.url) void fetch(probe.url, { method: "POST", body: JSON.stringify({ sessionId: "scheduled-session-surfaces", runId: probe.phase || "pre-fix", hypothesisId: "B-D", location: "apps/mobile-client/src/api.ts:getSchedulerRun", msg: "[DEBUG] Mobile received Scheduler run detail", data: { schedulerRunId: run.id, status: run.status, sessionId: run.sessionId || null, chatRunId: run.chatRunId || null, eventCount: run.events?.length || run.eventCount || 0, outputLength: String(run.output || "").length }, ts: Date.now() }) }).catch(() => {}); } catch {}
  // #endregion
  return run;
}

export async function createSchedulerTask(
  task: Omit<SchedulerTask, "id">,
): Promise<SchedulerTask> {
  return await requestJson<SchedulerTask>("/v1/scheduler/tasks", {
    method: "POST",
    body: JSON.stringify(task),
  });
}

export async function updateSchedulerTask(
  taskId: string,
  task: Partial<SchedulerTask>,
): Promise<SchedulerTask> {
  return await requestJson<SchedulerTask>(
    `/v1/scheduler/tasks/${encodeURIComponent(taskId)}`,
    {
      method: "PUT",
      body: JSON.stringify(task),
    },
  );
}

export async function runSchedulerTask(taskId: string): Promise<SchedulerRun> {
  return await requestJson<SchedulerRun>(
    `/v1/scheduler/tasks/${encodeURIComponent(taskId)}/run`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function deleteSchedulerTask(taskId: string): Promise<void> {
  await requestJson(`/v1/scheduler/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
  });
}

const LOCAL_TOOLS_PREFIX = "/v1/device-services/local-tools";
const PLUGIN_SERVICE_PREFIX = "/v1/device-services/plugin-service";
export const SKILLS_SNAPSHOT_KEY =
  "runtime.plugins.dev.skills.skills.snapshot";
export const MEMORY_SNAPSHOT_KEY =
  "runtime.plugins.dev.memory.memory.snapshot";
export const IDENTITY_SNAPSHOT_KEY =
  "runtime.plugins.dev.identity.identity.snapshot";

export async function listTerminalSessions(): Promise<TerminalSession[]> {
  const body = await requestJson<{ sessions?: TerminalSession[] }>(
    `${LOCAL_TOOLS_PREFIX}/sessions`,
  );
  return (Array.isArray(body.sessions) ? body.sessions : []).map((session) => ({
    ...session,
    id: String(session.id || session.session_id || ""),
  })).filter((session) => session.id);
}

export async function createTerminalSession(input: {
  type?: "local" | "ssh";
  initial_cwd?: string;
}): Promise<TerminalSession> {
  const body = await requestJson<{ session?: TerminalSession }>(
    `${LOCAL_TOOLS_PREFIX}/sessions`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  const session = body.session || body as unknown as TerminalSession;
  return {
    ...session,
    id: String(session.id || session.session_id || ""),
  };
}

export async function closeTerminalSession(sessionId: string): Promise<void> {
  await requestJson(
    `${LOCAL_TOOLS_PREFIX}/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
}

export async function listFiles(
  sessionId: string,
  path: string,
): Promise<FileEntry[]> {
  const query = new URLSearchParams({
    session_id: sessionId,
    path,
    max_depth: "1",
  });
  const body = await requestJson<
    { entries?: FileEntry[]; tree?: FileEntry[]; results?: string } | FileEntry[]
  >(`${LOCAL_TOOLS_PREFIX}/files/entries?${query}`);
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.entries)) return body.entries;
  if (Array.isArray(body.tree)) return body.tree;
  if (typeof body.results === "string") {
    return body.results
      .split(/\r?\n/)
      .slice(1)
      .flatMap((line) => {
        const match = /^-\s+(.+?)\s*$/.exec(line);
        if (!match) return [];
        const raw = match[1];
        const directory = raw.endsWith("/");
        const name = raw.replace(/\/$/, "");
        return [{
          name,
          path: `${path.replace(/\/+$/, "")}/${name}`,
          type: directory ? "directory" : "file",
        }];
      });
  }
  return [];
}

export async function readFile(
  sessionId: string,
  path: string,
): Promise<{ content: string; size?: number; truncated?: boolean }> {
  const query = new URLSearchParams({
    session_id: sessionId,
    path,
  });
  const body = await requestJson<{
    content?: string;
    size?: number;
    truncated?: boolean;
  }>(`${LOCAL_TOOLS_PREFIX}/files/read?${query}`);
  return {
    content: String(body.content || ""),
    size: body.size,
    truncated: body.truncated,
  };
}

export async function listPlugins(): Promise<PluginRecord[]> {
  const body = await requestJson<
    { plugins?: PluginRecord[]; data?: PluginRecord[] } | PluginRecord[]
  >(`${PLUGIN_SERVICE_PREFIX}/plugins`);
  return Array.isArray(body)
    ? body
    : Array.isArray(body.plugins)
      ? body.plugins
      : Array.isArray(body.data)
        ? body.data
        : [];
}

export async function readWorkbenchKV<T>(key: string): Promise<T | null> {
  try {
    const body = await requestJson<{ value?: T }>(
      `/v1/workbench-state/kv/${encodeURIComponent(key)}`,
    );
    return body && typeof body === "object" && "value" in body
      ? body.value ?? null
      : body as unknown as T;
  } catch (error) {
    if (error instanceof RuntimeApiError && error.status === 404) return null;
    throw error;
  }
}

export async function writeWorkbenchKV<T>(key: string, value: T): Promise<T> {
  const body = await requestJson<{ value?: T }>(
    `/v1/workbench-state/kv/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      body: JSON.stringify({ value }),
    },
  );
  return body.value ?? value;
}

export async function getSkillsSnapshot(): Promise<SkillsSnapshot | null> {
  return await readWorkbenchKV<SkillsSnapshot>(SKILLS_SNAPSHOT_KEY);
}

export async function updateSkillsSnapshot(
  snapshot: SkillsSnapshot,
): Promise<SkillsSnapshot> {
  return await writeWorkbenchKV(SKILLS_SNAPSHOT_KEY, {
    ...snapshot,
    savedAt: Date.now(),
  });
}

export function pairingFromLocation(): PairingInput | null {
  const raw = location.hash.replace(/^#/, "");
  const query = raw.startsWith("/pair?")
    ? raw.slice(raw.indexOf("?") + 1)
    : raw;
  const values = new URLSearchParams(query);
  const pairingId = values.get("pairing_id") || "";
  const secret = values.get("pairing_secret") || "";
  if (!pairingId || !secret) return null;
  return { pairingId, secret };
}

export function clearPairingFragment(): void {
  const url = new URL(location.href);
  url.hash = "";
  history.replaceState(history.state, "", url);
}
