export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type ModelRef = {
  profileId?: string;
  providerId: string;
  modelId: string;
  label?: string;
};

export type ModelRequestOptions = {
  thinkingMode?: "auto" | "off" | "on";
  thinkingEffort?: "auto" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Original wire arguments when normalization would change their bytes. */
  argumentsText?: string;
  /** Opaque provider state, never used to authorize or dispatch a tool. */
  providerMetadata?: Record<string, unknown>;
  validationError?: string;
};

export type AssistantToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
  providerMetadata?: Record<string, unknown>;
};

export type TranscriptTextPart = {
  type: "text";
  text: string;
};

export type TranscriptImagePart = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type TranscriptContent =
  | string
  | Array<TranscriptTextPart | TranscriptImagePart>;

export type TranscriptMessage = {
  role: MessageRole;
  content: TranscriptContent;
  reasoningContent?: string;
  /** Opaque model state such as signatures, retained for subsequent turns. */
  providerMetadata?: Record<string, unknown>;
  toolCallId?: string;
  toolCalls?: AssistantToolCall[];
  /** Runtime-generated context marker; not accepted from client messages. */
  contextProviderId?: string;
  /** Observed result status; never inferred from result text. */
  toolResultStatus?: { ok: boolean; failureCode?: string };
};

export type ToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  hostKinds?: string[];
  execution?: {
    effect: "read" | "write" | "process" | "external";
    timeoutMs: number;
    maxTimeoutMs: number;
    cancellation: "cooperative" | "best-effort" | "none";
    idempotency: "safe" | "invocation" | "reconcile";
    timeoutArgument?: string;
  };
  pluginId?: string;
  risk?: string;
  modelInjectable?: boolean;
  unavailableReason?: string;
  owner?: {
    kind: "runtime" | "plugin" | "device" | "client" | "mcp";
    id: string;
  };
  availability?: {
    headless: boolean;
    requiresWorkbench: boolean;
    requiresDevice: boolean;
    requiresNetwork: boolean;
  };
  policy?: {
    minimumPreset: RunPolicyPreset;
    requiresFileRoots?: boolean;
    requiresTerminalSession?: boolean;
    requiresApproval?: boolean;
    requiredScopes?: string[];
  };
};

export type ToolInvocation = {
  invocationId: string;
  runId: string;
  attemptId: string;
  sessionId?: string;
  projectId?: string;
  principal?: RunPrincipal;
  target?: ExecutionTarget;
  policy: CapabilityPolicy;
  toolCall: ToolCall;
};

export type ToolResult = {
  ok: boolean;
  content: string;
  error?: string;
  failureCode?: string;
  retryable?: boolean;
  artifactIds?: string[];
  artifacts?: Artifact[];
  changes?: ChangeSet[];
};

export type Artifact = {
  schemaVersion: 1;
  id: string;
  runId: string;
  invocationId: string;
  toolCallId: string;
  toolName: string;
  kind: "file";
  uri: string;
  mediaType: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
};

export type ChangeSet = {
  schemaVersion: 1;
  id: string;
  artifactId: string;
  runId: string;
  invocationId: string;
  toolCallId: string;
  toolName: string;
  operation: "created" | "modified" | "deleted" | "patch";
  path: string;
  before?: string;
  after?: string;
  patch?: string;
  addedLines: number;
  removedLines: number;
  createdAt: number;
};

export type RunPolicyPreset = "read-only" | "workspace-write" | "trusted-automation";

export type CapabilityPolicy = {
  preset: RunPolicyPreset;
  allowedTools: string[];
  maxToolCalls: number;
  fileRoots: string[];
  allowedCommandPrefixes: string[];
  allowedTerminalSessionIds: string[];
  allowedRecipients: string[];
  maxMailPerRun: number;
};

export type ExecutionTarget = {
  nodeId: string;
};

/** Assigned by the trusted Runtime admission layer, never by the model. */
export type RunPrincipal = {
  version: 1;
  kind: "user" | "service";
  userId: string;
  spaceId: string;
  grantId: string;
  parentRunId?: string;
};

export type RunRequest = {
  conversationInput?: {
    schemaVersion: 1;
    mode: "snapshot";
    clientRequestId: string;
    parentInputId?: string;
    expectedAccount?: { userId: string; spaceId: string };
  };
  principal?: RunPrincipal;
  prompt?: string;
  messages?: TranscriptMessage[];
  sessionHistory?: TranscriptMessage[];
  title?: string;
  interactionProfileId?: string;
  sessionId?: string;
  projectId?: string;
  target?: ExecutionTarget;
  model?: ModelRef;
  modelOptions?: ModelRequestOptions;
  policy?: Partial<CapabilityPolicy>;
  maxTurns?: number;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
};

export type ResumeRunRequest = {
  /** Required for a suspended Run; stale/duplicate waits are rejected atomically. */
  waitId?: string;
  input?: unknown;
  model?: ModelRef;
  modelOptions?: ModelRequestOptions;
  maxTurns?: number;
  timeoutMs?: number;
};

export type RunRecord = {
  id: string;
  attemptId: string;
  status: RunStatus;
  title: string;
  sessionId?: string;
  projectId?: string;
  principal?: RunPrincipal;
  target?: ExecutionTarget;
  model?: ModelRef;
  modelOptions?: ModelRequestOptions;
  policy: CapabilityPolicy;
  metadata: Record<string, unknown>;
  /** Immutable caller context, before providers prepare the model request. */
  inputMessages?: TranscriptMessage[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  terminalReason?: string;
  error?: string;
  output?: string;
  usage?: Usage;
  waiting?: RunWait;
};

export type SessionStatus = "active" | "archived";

export type SessionRecord = {
  id: string;
  status: SessionStatus;
  title: string;
  projectId?: string;
  model?: ModelRef;
  policy: CapabilityPolicy;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type SessionMessageRole = "user" | "assistant";

export type SessionMessage = {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  sequence: number;
  role: SessionMessageRole;
  content: string;
  runId: string;
  createdAt: number;
};

export type SessionMessageInput = Omit<SessionMessage, "sequence">;

export type RunEvent = {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  attemptId: string;
  // Monotonic across live and durable events. Durable stores may contain gaps
  // because high-frequency stream deltas are intentionally transient.
  sequence: number;
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
};

export type RunResult = {
  runId: string;
  attemptId: string;
  status: "completed" | "failed" | "aborted" | "waiting";
  output: string;
  usage: Usage;
  error?: string;
  reason?: string;
  waiting?: RunWait;
};

/** Intent committed atomically with its originating semantic Run event. */
export type RunOutboxEntry = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
};

export type CancellationSignal = {
  readonly cancelled: boolean;
  readonly reason?: string;
  throwIfCancelled(): void;
  onCancel(listener: (reason: string) => void): { dispose(): void };
};

export type EngineTurnRequest = {
  runId: string;
  attemptId: string;
  principal?: RunPrincipal;
  turn: number;
  messages: TranscriptMessage[];
  tools: ToolDefinition[];
  model?: ModelRef;
  modelOptions?: ModelRequestOptions;
  signal: CancellationSignal;
  maxOutputTokens?: number;
  preview?: boolean;
  metadata?: RunRequest["metadata"];
};

export type CredentialRequest = {
  ref: string;
  providerId?: string;
  modelId?: string;
};

export type CredentialLease = {
  headers: Readonly<Record<string, string>>;
  expiresAt?: number;
  release?(): void | Promise<void>;
};

export interface CredentialProvider {
  acquire(request: CredentialRequest): Promise<CredentialLease | null>;
}

export type AgentCheckpoint = {
  schemaVersion: 1;
  runId: string;
  attemptId: string;
  sequence: number;
  nextTurn: number;
  messages: TranscriptMessage[];
  output: string;
  usage: Usage;
  counters: {
    toolCalls: number;
  };
  maxTurns: number;
  createdAt: number;
  /** Exact execution boundary. Omitted on legacy checkpoints. */
  pending?: PendingRunStep;
};

export type RunHookStage = "beforeStart" | "beforeTurn" | "beforeModel"
  | "beforeTool" | "afterTool" | "beforeStop" | "afterRun";

export type RunWait = {
  id: string;
  controllerId: string;
  stage: RunHookStage;
  reason: string;
  createdAt: number;
  data?: Record<string, unknown>;
};

export type PendingRunStep = {
  stage: Exclude<RunHookStage, "afterRun">;
  controllerIndex: number;
  /** Detect a changed controller chain rather than silently skipping policy. */
  controllerIds: string[];
  completedDecisions?: RunHookDecision[];
  turn: number;
  calls?: ToolCall[];
  callIndex?: number;
  turnOutput?: string;
  turnReasoning?: string;
  turnMetadata?: Record<string, unknown>;
  toolMessages?: TranscriptMessage[];
  /** A crash during a side effect requires reconciliation, never blind replay. */
  inFlight?: boolean;
  /** Known result awaiting durable result-observer completion; never re-run the tool. */
  afterToolResult?: ToolResult;
  resume?: { waitId: string; input?: unknown };
  stopBoundary?: "max-turns";
};

export type RunHookDecision =
  | { action: "pass" }
  | { action: "deny"; reason: string }
  | { action: "pause"; reason: string; data?: Record<string, unknown> }
  | { action: "replace-tool-result"; result: ToolResult }
  | { action: "continue"; instruction: string }
  | { action: "accept-stop" }
  | { action: "continue-run"; instruction: string; metadata?: Record<string, unknown> };

export type RunHookContext = RunControllerContext & {
  schemaVersion: 1;
  stage: RunHookStage;
  controllerId: string;
  idempotencyKey: string;
  invocation?: ToolInvocation;
  result?: ToolResult | RunResult;
  resume?: { waitId: string; input?: unknown };
};

export type RunTranscriptEntry = TranscriptMessage & {
  schemaVersion: 1;
  id: string;
  runId: string;
  attemptId: string;
  turn: number;
  ordinal: number;
  createdAt: number;
};

export type EngineOutputEvent =
  | {
      type: "model.request";
      request: {
        url: string;
        providerId?: string;
        providerType?: string;
        modelId: string;
        modelLabel?: string;
        stream: boolean;
        payload: Record<string, unknown>;
      };
    }
  | { type: "message.delta"; delta: string }
  | { type: "message.metadata"; metadata: Record<string, unknown> }
  | { type: "reasoning.delta"; delta: string }
  | { type: "tool.call"; call: ToolCall }
  | { type: "model.timing"; timing: {
      phase: "first-chunk" | "first-reasoning" | "first-answer";
      requestStartedAt: number;
      elapsedMs: number;
      credentialMs: number;
      responseHeadersMs: number;
      preparationMs: number;
    } }
  | { type: "model.usage"; usage: Partial<Usage> };

export interface AgentEngine {
  readonly id: string;
  streamTurn(request: EngineTurnRequest): AsyncIterable<EngineOutputEvent>;
}

export interface ToolBroker {
  listTools(request: RunRequest): Promise<ToolDefinition[]>;
  invoke(invocation: ToolInvocation, signal: CancellationSignal): Promise<ToolResult>;
}

export type ContextStage = "pre" | "post";

export type ContextProviderContext = {
  runId: string;
  attemptId: string;
  turn?: number;
  request: RunRequest;
  signal: CancellationSignal;
  tools?: ToolDefinition[];
  usage?: Usage;
  preview?: boolean;
  recordUsage?: (usage: Partial<Usage>) => void;
};

export type RunControllerContext = ContextProviderContext & {
  messages: TranscriptMessage[];
  output?: string;
};

/** Workflow policy belongs to plugins; execution and admission stay in Runtime. */
export interface RunController {
  readonly id: string;
  /** V1 contract. Controllers may implement V1 or legacy hooks, never both per call. */
  handle?(context: RunHookContext): Promise<RunHookDecision | void>;
  stages?: RunHookStage[];
  timeoutMs?: number;
  failurePolicy?: "fail-open" | "fail-closed";
  beforeStart?(context: RunControllerContext): Promise<void>;
  beforeTurn?(context: RunControllerContext): Promise<string | void>;
  beforeModel?(context: RunControllerContext): Promise<string | void>;
  /** string continues, null accepts a boundary stop, undefined does not control it. */
  beforeStop?(context: RunControllerContext): Promise<string | null | void>;
  beforeTool?(invocation: ToolInvocation, context: RunControllerContext): Promise<ToolResult | string | void>;
  afterTool?(invocation: ToolInvocation, result: ToolResult, context: RunControllerContext): Promise<void>;
  afterRun?(context: {
    runId: string; request: RunRequest; result: RunResult;
  }): Promise<{ instruction?: string; metadata?: Record<string, unknown> } | void>;
  continuationFailed?(context: {
    request: RunRequest; error: unknown; runId?: string;
  }): Promise<void>;
}

export interface ContextProvider {
  readonly id: string;
  readonly required?: boolean;
  readonly stage?: ContextStage;
  readonly order?: number;
  prepare?(request: RunRequest): Promise<TranscriptMessage[]>;
  contribute?(
    messages: TranscriptMessage[],
    context: ContextProviderContext
  ): Promise<TranscriptMessage[]>;
}

export interface RunStore {
  create(record: RunRecord): Promise<void>;
  // Persists semantic events. Callers must preserve increasing sequence, but
  // contiguous values are not required.
  append(
    event: RunEvent,
    patch?: Pick<RunRecord, "status" | "updatedAt"> &
      Partial<Pick<
        RunRecord,
        | "attemptId"
        | "completedAt"
        | "terminalReason"
        | "error"
        | "model"
        | "output"
        | "usage"
        | "metadata"
        | "waiting"
      >>,
    detailEvent?: RunEvent,
    outbox?: RunOutboxEntry[]
  ): Promise<void>;
  get(runId: string): Promise<RunRecord | null>;
  listRuns(options?: {
    since?: number;
    statuses?: RunStatus[];
    limit?: number;
  }): Promise<RunRecord[]>;
  // Returns durable semantic events only; active stream replay is Runtime-owned.
  getEvents(runId: string, afterSequence?: number): Promise<RunEvent[]>;
  getEvent?(runId: string, sequence: number): Promise<RunEvent | null>;
  appendTranscript(entry: RunTranscriptEntry): Promise<void>;
  getTranscript(runId: string): Promise<RunTranscriptEntry[]>;
  saveCheckpoint(checkpoint: AgentCheckpoint): Promise<void>;
  getLatestCheckpoint(runId: string): Promise<AgentCheckpoint | null>;
  /** Atomically persists the wait, event and exact step. */
  suspend(event: RunEvent, checkpoint: AgentCheckpoint, waiting: RunWait): Promise<void>;
  /** Cancels only the observed wait/attempt, atomically clearing its checkpoint. */
  cancelWait(event: RunEvent, waitId: string, outbox?: RunOutboxEntry[]): Promise<boolean>;
  /** Compare-and-swap against the observed attempt and wait/checkpoint. */
  claimResume(options: {
    runId: string; previousAttemptId: string; attemptId: string;
    checkpointSequence: number; waitId?: string; input?: unknown;
  }): Promise<boolean>;
}

export interface SessionStore {
  createSession(record: SessionRecord): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  listSessions(options?: {
    limit?: number;
    offset?: number;
  }): Promise<SessionRecord[]>;
  getSessionMessages(sessionId: string, afterSequence?: number): Promise<SessionMessage[]>;
  appendSessionMessages(
    sessionId: string,
    messages: SessionMessageInput[]
  ): Promise<SessionMessage[]>;
}

export type ToolAuthorization = {
  allowed: boolean;
  reason?: string;
};

export type ToolAuthorizer = (
  call: ToolCall,
  policy: CapabilityPolicy,
  counters: { toolCalls: number }
) => ToolAuthorization | Promise<ToolAuthorization>;

export type RunAuthorizationPhase = "admission" | "resume" | "context" | "model" | "tool";
export type RunAuthorizer = (
  request: RunRequest,
  phase: RunAuthorizationPhase
) => CapabilityPolicy | Promise<CapabilityPolicy>;

export type TimeoutScheduler = (
  callback: () => void,
  timeoutMs: number
) => { dispose(): void };

export type RunHandle = {
  runId: string;
  attemptId: string;
  /** Resolves when admission and the initial durable Run write succeed. */
  ready?: Promise<void>;
  events: AsyncIterable<RunEvent>;
  completion: Promise<RunResult>;
  abort(reason?: string): Promise<void>;
};
