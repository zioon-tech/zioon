export type RunStatus =
  | "queued"
  | "running"
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
  validationError?: string;
};

export type AssistantToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
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
  toolCallId?: string;
  toolCalls?: AssistantToolCall[];
};

export type ToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  hostKinds?: string[];
  pluginId?: string;
  risk?: string;
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
  policy: CapabilityPolicy;
  toolCall: ToolCall;
};

export type ToolResult = {
  ok: boolean;
  content: string;
  error?: string;
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

export type RunRequest = {
  prompt?: string;
  messages?: TranscriptMessage[];
  sessionHistory?: TranscriptMessage[];
  title?: string;
  interactionProfileId?: string;
  sessionId?: string;
  projectId?: string;
  model?: ModelRef;
  modelOptions?: ModelRequestOptions;
  policy?: Partial<CapabilityPolicy>;
  maxTurns?: number;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
};

export type ResumeRunRequest = {
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
  model?: ModelRef;
  modelOptions?: ModelRequestOptions;
  policy: CapabilityPolicy;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  terminalReason?: string;
  error?: string;
  output?: string;
  usage?: Usage;
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
  sequence: number;
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
};

export type RunResult = {
  runId: string;
  attemptId: string;
  status: "completed" | "failed" | "aborted";
  output: string;
  usage: Usage;
  error?: string;
  reason?: string;
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
  turn: number;
  messages: TranscriptMessage[];
  tools: ToolDefinition[];
  model?: ModelRef;
  modelOptions?: ModelRequestOptions;
  signal: CancellationSignal;
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
  | { type: "reasoning.delta"; delta: string }
  | { type: "tool.call"; call: ToolCall }
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
};

export interface ContextProvider {
  readonly id: string;
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
      >>
  ): Promise<void>;
  get(runId: string): Promise<RunRecord | null>;
  getEvents(runId: string, afterSequence?: number): Promise<RunEvent[]>;
  getEvent?(runId: string, sequence: number): Promise<RunEvent | null>;
  appendTranscript(entry: RunTranscriptEntry): Promise<void>;
  getTranscript(runId: string): Promise<RunTranscriptEntry[]>;
  saveCheckpoint(checkpoint: AgentCheckpoint): Promise<void>;
  getLatestCheckpoint(runId: string): Promise<AgentCheckpoint | null>;
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

export type TimeoutScheduler = (
  callback: () => void,
  timeoutMs: number
) => { dispose(): void };

export type RunHandle = {
  runId: string;
  attemptId: string;
  events: AsyncIterable<RunEvent>;
  completion: Promise<RunResult>;
  abort(reason?: string): Promise<void>;
};
