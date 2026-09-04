import type {
  RunEvent,
  RunHandle,
  ModelRef,
  CapabilityPolicy,
  RunRecord,
  RunRequest,
  RunResult,
  ToolDefinition,
  Usage
} from "../../packages/runtime/src/index.js";

const DEFAULT_PROJECTION_MAX_DELAY_MS = 100;
const DEFAULT_PROJECTION_MAX_CHUNK_CHARS = 512;

export type AcceptedRuntimeRun = {
  runId: string;
  attemptId: string;
  status: "accepted";
  model?: ModelRef;
  policy?: CapabilityPolicy;
  interactionProfile?: RuntimeInteractionProfile;
};

export type RuntimeModelProfile = {
  id: string;
  label?: string;
  providerId?: string;
  sourceModelId?: string;
  providerType?: string;
  endpoint?: string;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  requestBody?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  credentialConfigured?: boolean;
};

export type RuntimeModelCatalog = {
  activeProfileId: string | null;
  profiles: RuntimeModelProfile[];
};

export type RuntimeInteractionProfile = {
  id: string;
  label?: string;
  modelProfileId?: string;
  model?: ModelRef;
  policy?: Partial<CapabilityPolicy>;
  contextProviders?: {
    enabled?: string[];
    disabled?: string[];
  };
  metadata?: Record<string, unknown>;
};

export type RuntimeCapabilityCatalog = {
  tools: ToolDefinition[];
};

export type RuntimeModelProfileImport = {
  profile: RuntimeModelProfile & {
    endpoint: string;
    credentialRequired?: boolean;
  };
  credential?: string;
};

export type RuntimeEventSubscription = {
  afterSequence?: number;
  signal?: AbortSignal;
  mode?: "raw" | "projection";
  reasoningMode?: "stream" | "summary" | "none";
  maxDelayMs?: number;
  maxChunkChars?: number;
  maxBufferSize?: number;
};

export interface RuntimeClient {
  createRun(request: RunRequest): Promise<AcceptedRuntimeRun>;
  getModels(): Promise<RuntimeModelCatalog>;
  getCapabilityTools(): Promise<ToolDefinition[]>;
  getInteractionProfiles(): Promise<RuntimeInteractionProfile[]>;
  getInteractionProfile(profileId: string): Promise<RuntimeInteractionProfile>;
  upsertInteractionProfile(
    profileId: string,
    profile: RuntimeInteractionProfile
  ): Promise<RuntimeInteractionProfile>;
  patchInteractionProfile(
    profileId: string,
    patch: Partial<RuntimeInteractionProfile>
  ): Promise<RuntimeInteractionProfile>;
  upsertModelProfile(
    profileId: string,
    input: RuntimeModelProfileImport
  ): Promise<RuntimeModelProfile>;
  deleteModelProfile(profileId: string): Promise<RuntimeModelProfile>;
  getRun(runId: string): Promise<RunRecord>;
  getEvent(runId: string, sequence: number): Promise<RunEvent>;
  getEvents(runId: string, afterSequence?: number): Promise<RunEvent[]>;
  getProjectionEvents(
    runId: string,
    afterSequence?: number,
    options?: Omit<RuntimeEventSubscription, "afterSequence" | "signal" | "mode">
  ): Promise<RunEvent[]>;
  subscribe(
    runId: string,
    options?: RuntimeEventSubscription
  ): AsyncIterable<RunEvent>;
  abort(runId: string, reason?: string): Promise<void>;
}

export type HttpRuntimeClientOptions = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
};

export type RemoteRunHandle = RunHandle & {
  detach(): void;
  model?: ModelRef;
};

export type RemoteRunHandleOptions = {
  subscription?: RuntimeEventSubscription;
  reconnectDelayMs?: number;
  maxQueuedEvents?: number;
};

export class RuntimeHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RuntimeHttpError";
    this.status = status;
  }
}

type AsyncEventQueue<T> = {
  push(value: T): Promise<void>;
  close(): void;
  iterable: AsyncIterable<T>;
};

function createAsyncEventQueue<T>(maxSize = 128): AsyncEventQueue<T> {
  const values: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  const capacityWaiters: Array<() => void> = [];
  let closed = false;

  return {
    async push(value) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value, done: false });
        return;
      }
      while (!closed && values.length >= maxSize) {
        await new Promise<void>((resolve) => capacityWaiters.push(resolve));
      }
      if (!closed) values.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length) {
        waiters.shift()?.({ value: undefined, done: true });
      }
      while (capacityWaiters.length) capacityWaiters.shift()?.();
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            const value = values.shift();
            if (value !== undefined) {
              capacityWaiters.shift()?.();
              return Promise.resolve({ value, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve));
          }
        };
      }
    }
  };
}

const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
};
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "aborted",
  "interrupted"
]);

function eventUsage(value: unknown): Usage {
  const usage = value && typeof value === "object"
    ? value as Partial<Usage>
    : {};
  const count = (input: unknown) => {
    const number = Number(input);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  };
  return {
    inputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
    reasoningTokens: count(usage.reasoningTokens),
    cacheReadTokens: count(usage.cacheReadTokens),
    cacheWriteTokens: count(usage.cacheWriteTokens)
  };
}

function resultFromTerminalEvent(event: RunEvent): RunResult | null {
  if (!["run.completed", "run.failed", "run.aborted"].includes(event.type)) {
    return null;
  }
  if (event.type === "run.completed") {
    return {
      runId: event.runId,
      attemptId: event.attemptId,
      status: "completed",
      output: String(event.data.output || ""),
      usage: eventUsage(event.data.usage)
    };
  }
  if (event.type === "run.aborted") {
    return {
      runId: event.runId,
      attemptId: event.attemptId,
      status: "aborted",
      output: "",
      usage: { ...EMPTY_USAGE },
      reason: String(event.data.reason || "user")
    };
  }
  return {
    runId: event.runId,
    attemptId: event.attemptId,
    status: "failed",
    output: "",
    usage: { ...EMPTY_USAGE },
    error: String(event.data.error || "Runtime Run failed")
  };
}

function resultFromTerminalRun(
  run: RunRecord,
  fallbackError = "Runtime event stream closed"
): RunResult {
  if (run.status === "completed") {
    return {
      runId: run.id,
      attemptId: run.attemptId,
      status: "completed",
      output: run.output || "",
      usage: run.usage || { ...EMPTY_USAGE }
    };
  }
  if (run.status === "aborted") {
    return {
      runId: run.id,
      attemptId: run.attemptId,
      status: "aborted",
      output: run.output || "",
      usage: run.usage || { ...EMPTY_USAGE },
      reason: run.terminalReason || "user"
    };
  }
  return {
    runId: run.id,
    attemptId: run.attemptId,
    status: "failed",
    output: run.output || "",
    usage: run.usage || { ...EMPTY_USAGE },
    error: run.error || fallbackError
  };
}

function normalizeBaseUrl(value: string): string {
  const baseUrl = String(value || "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Runtime base URL is required");
  return baseUrl;
}

function sequenceValue(value: unknown): number {
  const sequence = Number(value);
  return Number.isFinite(sequence) && sequence > 0
    ? Math.floor(sequence)
    : 0;
}

function projectionQuery(
  afterSequence: number,
  options: RuntimeEventSubscription = {}
): string {
  const query = new URLSearchParams({
    after: String(sequenceValue(afterSequence))
  });
  if (options.reasoningMode) {
    query.set("reasoning", options.reasoningMode);
  }
  if (options.maxDelayMs != null) {
    query.set("max_delay_ms", String(options.maxDelayMs));
  }
  if (options.maxChunkChars != null) {
    query.set("max_chunk_chars", String(options.maxChunkChars));
  }
  return query.toString();
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      globalThis.clearTimeout(timer);
      reject(signal.reason || Object.assign(new Error("Aborted"), {
        name: "AbortError"
      }));
    }, { once: true });
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  try {
    const parsed = await response.json() as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    } else if (response.ok) {
      throw new RuntimeHttpError(response.status, "Runtime returned invalid JSON");
    }
  } catch {
    if (response.ok) {
      throw new RuntimeHttpError(response.status, "Runtime returned invalid JSON");
    }
  }
  if (!response.ok) {
    throw new RuntimeHttpError(
      response.status,
      String(body.error || `Runtime HTTP ${response.status}`)
    );
  }
  return body;
}

function requireString(
  value: unknown,
  field: string,
  responseStatus: number
): string {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new RuntimeHttpError(
      responseStatus,
      `Runtime response is missing ${field}`
    );
  }
  return normalized;
}

function parseEventFrame(frame: string, responseStatus: number): RunEvent | null {
  let eventType = "message";
  const dataLines: string[] = [];

  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") eventType = value;
    if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return null;

  let data: unknown;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    throw new RuntimeHttpError(responseStatus, "Runtime returned invalid SSE data");
  }

  if (eventType === "error") {
    const error = data && typeof data === "object"
      ? (data as Record<string, unknown>).error
      : null;
    throw new RuntimeHttpError(
      responseStatus,
      String(error || "Runtime event stream failed")
    );
  }

  if (
    !data
    || typeof data !== "object"
    || !String((data as Record<string, unknown>).runId || "")
    || sequenceValue((data as Record<string, unknown>).sequence) === 0
  ) {
    throw new RuntimeHttpError(responseStatus, "Runtime returned an invalid Run event");
  }

  return data as RunEvent;
}

async function* readEventStream(
  response: Response,
  maxBufferSize = 1024 * 1024
): AsyncIterable<RunEvent> {
  if (!response.ok) {
    await readJson(response);
    return;
  }
  if (!response.body) {
    throw new RuntimeHttpError(response.status, "Runtime event stream has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] || "\n\n";
        buffer = buffer.slice(boundary + separator.length);
        const event = parseEventFrame(frame, response.status);
        if (event) yield event;
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (buffer.length > maxBufferSize) {
        throw new RuntimeHttpError(
          response.status,
          "Runtime event stream frame exceeds the client buffer limit"
        );
      }

      if (done) break;
    }

    if (buffer.trim()) {
      const event = parseEventFrame(buffer, response.status);
      if (event) yield event;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The server may already have closed a terminal Run stream.
    }
  }
}

export function createHttpRuntimeClient(
  options: HttpRuntimeClientOptions
): RuntimeClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!fetchImpl) throw new Error("Runtime fetch implementation is required");

  const runUrl = (runId: string, suffix = "") =>
    `${baseUrl}/v1/runs/${encodeURIComponent(runId)}${suffix}`;
  const interactionProfileUrl = (profileId: string) =>
    `${baseUrl}/v1/interaction-profiles/${encodeURIComponent(profileId)}`;

  return {
    async getModels() {
      const response = await fetchImpl(`${baseUrl}/v1/models`, {
        headers: { accept: "application/json" }
      });
      const body = await readJson(response);
      return {
        activeProfileId: body.activeProfileId
          ? String(body.activeProfileId)
          : null,
        profiles: Array.isArray(body.profiles)
          ? body.profiles as RuntimeModelProfile[]
          : []
      };
    },

    async createRun(request) {
      const response = await fetchImpl(`${baseUrl}/v1/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request)
      });
      const body = await readJson(response);
      return {
        runId: requireString(body.runId, "runId", response.status),
        attemptId: requireString(body.attemptId, "attemptId", response.status),
        status: "accepted",
        ...(body.model && typeof body.model === "object"
          ? { model: body.model as ModelRef }
          : {}),
        ...(body.policy && typeof body.policy === "object"
          ? { policy: body.policy as CapabilityPolicy }
          : {}),
        ...(body.interactionProfile && typeof body.interactionProfile === "object"
          ? { interactionProfile: body.interactionProfile as RuntimeInteractionProfile }
          : {})
      };
    },

    async getCapabilityTools() {
      const response = await fetchImpl(`${baseUrl}/v1/capabilities/tools`, {
        headers: { accept: "application/json" }
      });
      const body = await readJson(response);
      return Array.isArray(body.tools) ? body.tools as ToolDefinition[] : [];
    },

    async getInteractionProfiles() {
      const response = await fetchImpl(`${baseUrl}/v1/interaction-profiles`, {
        headers: { accept: "application/json" }
      });
      const body = await readJson(response);
      return Array.isArray(body.profiles)
        ? body.profiles as RuntimeInteractionProfile[]
        : [];
    },

    async getInteractionProfile(profileId) {
      const response = await fetchImpl(interactionProfileUrl(profileId), {
        headers: { accept: "application/json" }
      });
      const body = await readJson(response);
      if (!body.profile || typeof body.profile !== "object") {
        throw new RuntimeHttpError(
          response.status,
          "Runtime response is missing interaction profile"
        );
      }
      return body.profile as RuntimeInteractionProfile;
    },

    async upsertInteractionProfile(profileId, profile) {
      const response = await fetchImpl(interactionProfileUrl(profileId), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile })
      });
      const body = await readJson(response);
      if (!body.profile || typeof body.profile !== "object") {
        throw new RuntimeHttpError(
          response.status,
          "Runtime response is missing interaction profile"
        );
      }
      return body.profile as RuntimeInteractionProfile;
    },

    async patchInteractionProfile(profileId, patch) {
      const response = await fetchImpl(interactionProfileUrl(profileId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      });
      const body = await readJson(response);
      if (!body.profile || typeof body.profile !== "object") {
        throw new RuntimeHttpError(
          response.status,
          "Runtime response is missing interaction profile"
        );
      }
      return body.profile as RuntimeInteractionProfile;
    },

    async upsertModelProfile(profileId, input) {
      const response = await fetchImpl(
        `${baseUrl}/v1/model-profiles/${encodeURIComponent(profileId)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input)
        }
      );
      const body = await readJson(response);
      if (!body.profile || typeof body.profile !== "object") {
        throw new RuntimeHttpError(
          response.status,
          "Runtime response is missing model profile"
        );
      }
      return body.profile as RuntimeModelProfile;
    },

    async deleteModelProfile(profileId) {
      const response = await fetchImpl(
        `${baseUrl}/v1/model-profiles/${encodeURIComponent(profileId)}`,
        { method: "DELETE" }
      );
      const body = await readJson(response);
      if (!body.profile || typeof body.profile !== "object") {
        throw new RuntimeHttpError(
          response.status,
          "Runtime response is missing model profile"
        );
      }
      return body.profile as RuntimeModelProfile;
    },

    async getRun(runId) {
      const response = await fetchImpl(runUrl(runId), {
        headers: { accept: "application/json" }
      });
      const body = await readJson(response);
      if (!body.run || typeof body.run !== "object") {
        throw new RuntimeHttpError(
          response.status,
          "Runtime response is missing run"
        );
      }
      return body.run as RunRecord;
    },

    async getEvent(runId, sequence) {
      const response = await fetchImpl(
        runUrl(runId, `/events/${sequenceValue(sequence)}`),
        { headers: { accept: "application/json" } }
      );
      const body = await readJson(response);
      if (!body.event || typeof body.event !== "object") {
        throw new RuntimeHttpError(
          response.status,
          "Runtime response is missing event"
        );
      }
      return body.event as RunEvent;
    },

    async getEvents(runId, afterSequence = 0) {
      const after = sequenceValue(afterSequence);
      const response = await fetchImpl(
        `${runUrl(runId, "/events")}?after=${after}`,
        { headers: { accept: "application/json" } }
      );
      const body = await readJson(response);
      if (!Array.isArray(body.events)) {
        throw new RuntimeHttpError(
          response.status,
          "Runtime response is missing events"
        );
      }
      return body.events as RunEvent[];
    },

    async getProjectionEvents(runId, afterSequence = 0, options = {}) {
      const response = await fetchImpl(
        `${runUrl(runId, "/projection")}?${projectionQuery(afterSequence, options)}`,
        { headers: { accept: "application/json" } }
      );
      const body = await readJson(response);
      if (!Array.isArray(body.events)) {
        throw new RuntimeHttpError(
          response.status,
          "Runtime response is missing projected events"
        );
      }
      return body.events as RunEvent[];
    },

    subscribe(runId, options = {}) {
      const after = sequenceValue(options.afterSequence);
      const mode: "raw" | "projection" = options.mode === "raw"
        ? "raw"
        : "projection";
      const subscription: RuntimeEventSubscription = mode === "projection"
        ? {
            ...options,
            mode,
            maxDelayMs: options.maxDelayMs
              ?? DEFAULT_PROJECTION_MAX_DELAY_MS,
            maxChunkChars: options.maxChunkChars
              ?? DEFAULT_PROJECTION_MAX_CHUNK_CHARS
          }
        : { ...options, mode };
      const suffix = mode === "raw"
        ? "/events/stream"
        : "/projection/stream";
      const response = fetchImpl(
        `${runUrl(runId, suffix)}?${projectionQuery(after, subscription)}`,
        {
          headers: {
            accept: "text/event-stream",
            ...(after ? { "last-event-id": String(after) } : {})
          },
          signal: options.signal
        }
      );
      return (async function* subscribeToRun() {
        yield* readEventStream(
          await response,
          Math.max(64 * 1024, Number(options.maxBufferSize) || 1024 * 1024)
        );
      })();
    },

    async abort(runId, reason = "user") {
      const response = await fetchImpl(runUrl(runId, "/abort"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason })
      });
      await readJson(response);
    }
  };
}

export async function createRemoteRunHandle(
  client: RuntimeClient,
  request: RunRequest,
  options: RemoteRunHandleOptions = {}
): Promise<RemoteRunHandle> {
  const accepted = await client.createRun(request);
  const queue = createAsyncEventQueue<RunEvent>(
    Math.max(16, Number(options.maxQueuedEvents) || 128)
  );
  const observer = new AbortController();
  let detached = false;
  let settled = false;
  let resolveCompletion: (result: RunResult) => void = () => {};
  const completion = new Promise<RunResult>((resolve) => {
    resolveCompletion = resolve;
  });
  const settle = (result: RunResult) => {
    if (settled) return;
    settled = true;
    resolveCompletion(result);
  };

  void (async () => {
    let cursor = sequenceValue(options.subscription?.afterSequence);
    const subscription = {
      ...(options.subscription || {}),
      signal: observer.signal
    };
    while (!settled && !observer.signal.aborted) {
      try {
        for await (const event of client.subscribe(accepted.runId, {
          ...subscription,
          afterSequence: cursor
        })) {
          cursor = Math.max(cursor, sequenceValue(event.sequence));
          await queue.push(event);
          const result = resultFromTerminalEvent(event);
          if (result) settle(result);
        }
        if (settled || observer.signal.aborted) break;
        const run = await client.getRun(accepted.runId);
        if (TERMINAL_STATUSES.has(run.status)) {
          settle(resultFromTerminalRun(
            run,
            `Runtime event stream closed while Run was ${run.status}`
          ));
          break;
        }
      } catch (error) {
        if (detached || observer.signal.aborted) break;
        try {
          const run = await client.getRun(accepted.runId);
          if (TERMINAL_STATUSES.has(run.status)) {
            settle(resultFromTerminalRun(run, String(error)));
            break;
          }
        } catch {
          // Retry the stream using the last delivered raw sequence.
        }
      }
      if (!settled && !observer.signal.aborted) {
        await wait(
          Math.max(100, Number(options.reconnectDelayMs) || 250),
          observer.signal
        ).catch(() => {});
      }
    }
    if (!settled) {
      settle({
        runId: accepted.runId,
        attemptId: accepted.attemptId,
        status: "aborted",
        output: "",
        usage: { ...EMPTY_USAGE },
        reason: detached ? "detached" : "user"
      });
    }
    try {
      // The queue is closed only after terminal state or explicit detach.
    } finally {
      queue.close();
    }
  })();

  return {
    runId: accepted.runId,
    attemptId: accepted.attemptId,
    model: accepted.model,
    events: queue.iterable,
    completion,
    abort: (reason = "user") => client.abort(accepted.runId, reason),
    detach() {
      detached = true;
      observer.abort();
    }
  };
}
