export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted";

export type ModelRef = {
  profileId?: string;
  providerId: string;
  modelId: string;
  label?: string;
};

export type CapabilityPolicy = {
  preset: "read-only" | "workspace-write" | "trusted-automation";
  allowedTools: string[];
  maxToolCalls: number;
  fileRoots: string[];
  allowedCommandPrefixes: string[];
  allowedTerminalSessionIds: string[];
  allowedRecipients: string[];
  maxMailPerRun: number;
};

export type SessionRecord = {
  id: string;
  status: "active" | "archived";
  title: string;
  projectId?: string;
  model?: ModelRef;
  policy?: CapabilityPolicy;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type SessionConfigurationPatch = {
  model?: {
    profileId: string;
  };
  policy?: Partial<CapabilityPolicy>;
  skills?: {
    enabled: string[];
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

export type AssistantToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type SessionMessage = {
  schemaVersion?: number;
  id: string;
  sessionId?: string;
  sequence: number;
  role: "system" | "user" | "assistant" | "tool";
  content: TranscriptContent;
  reasoningContent?: string;
  toolCallId?: string;
  toolCalls?: AssistantToolCall[];
  runId?: string;
  turn?: number;
  createdAt?: number;
};

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type RunWait = {
  id: string;
  controllerId: string;
  stage: string;
  reason: string;
  createdAt: number;
  data?: Record<string, unknown>;
};

export type RunRecord = {
  id: string;
  attemptId: string;
  status: RunStatus;
  title: string;
  sessionId?: string;
  projectId?: string;
  model?: ModelRef;
  policy?: CapabilityPolicy;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  terminalReason?: string;
  error?: string;
  output?: string;
  usage?: Usage;
  waiting?: RunWait;
};

export type RunEvent = {
  schemaVersion: number;
  eventId: string;
  runId: string;
  attemptId: string;
  sequence: number;
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
};

export type ActiveRun = {
  runId: string;
  attemptId: string;
  status: RunStatus;
  waiting?: RunWait;
};

export type SessionSummary = SessionRecord & {
  lastMessage: {
    id: string;
    sequence: number;
    role: string;
    content: string;
    runId?: string;
    createdAt?: number;
  } | null;
  activeRun: ActiveRun | null;
};

export type RuntimeModelProfile = {
  id: string;
  label?: string;
  providerId?: string;
  providerType?: string;
  endpoint?: string;
  model: string;
  capabilities?: Record<string, unknown>;
  credentialConfigured?: boolean;
  credentialRequired?: boolean;
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

export type CapabilityTool = {
  name: string;
  description?: string;
  hostKinds?: string[];
  execution?: {
    effect?: "read" | "write" | "process" | "external";
    timeoutMs?: number;
    maxTimeoutMs?: number;
    cancellation?: "cooperative" | "best-effort" | "none";
    idempotency?: "safe" | "invocation" | "reconcile";
    timeoutArgument?: string;
  };
  pluginId?: string;
  risk?: string;
  modelInjectable?: boolean;
  unavailableReason?: string;
  availability?: {
    headless?: boolean;
    requiresWorkbench?: boolean;
    requiresDevice?: boolean;
    requiresNetwork?: boolean;
  };
  policy?: {
    minimumPreset?: string;
    requiresApproval?: boolean;
  };
};

export type SkillRecord = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  difficulty?: string;
  allowedTools?: string[];
  dependencies?: string[];
  path?: string;
  file?: string;
  source?: string;
  pluginId?: string;
  sourceNodeId?: string;
  sourceNodeLabel?: string;
  sourceStatus?: "online" | "offline" | string;
  sourcePath?: string;
  contentHash?: string;
  runtimeCached?: boolean;
  runtimeNodeId?: string;
  runtimeFile?: string;
};

export type SkillsSnapshot = {
  version?: number;
  savedAt?: number;
  enabled: string[];
  catalog: SkillRecord[];
  paths?: string[];
  pathSources?: Array<{
    path: string;
    nodeId?: string;
    nodeLabel?: string;
  }>;
  lastScan?: number;
};

export type TodoItem = {
  id?: string;
  content: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
};

export type TodoList = {
  ownerId: string;
  taskId?: string;
  sessionId?: string;
  runId?: string;
  todos: TodoItem[];
  updatedAt: number;
};

export type SchedulerTask = {
  id: string;
  revision?: number;
  title: string;
  taskType?: "agent" | "command";
  executionMode?: string;
  prompt?: string;
  command?: string;
  cwd?: string;
  note?: string;
  interactionProfileId?: string;
  modelProfileId?: string;
  schedule: {
    kind: "daily" | "weekdays" | "interval" | "once";
    timeZone?: string;
    misfirePolicy?: string;
    overlapPolicy?: string;
    time?: string;
    intervalMinutes?: number;
    timestamp?: number;
  };
  capability?: Partial<CapabilityPolicy>;
  timeoutSeconds?: number;
  enabled: boolean;
  nextRun?: number;
  lastRun?: {
    id: string;
    status: string;
    startedAt?: number;
    completedAt?: number;
  } | null;
  createdAt?: number;
  updatedAt?: number;
};

export type SchedulerRunEvent = {
  eventId?: string;
  runId?: string;
  sequence?: number;
  type?: string;
  timestamp?: number;
  ts?: number;
  data?: Record<string, unknown>;
};

export type SchedulerRun = {
  id: string;
  occurrenceId?: string;
  taskId: string;
  taskRevision?: number;
  task?: SchedulerTask | {
    id: string;
    title?: string;
    taskType?: "agent" | "command";
  };
  status: string;
  trigger?: "manual" | "schedule" | string;
  createdAt?: number;
  scheduledFor?: number;
  startedAt?: number;
  completedAt?: number;
  workerId?: string;
  workerKind?: string;
  sessionId?: string | null;
  chatRunId?: string | null;
  output?: string;
  error?: string;
  result?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  eventCount?: number;
  outputLength?: number;
  events?: SchedulerRunEvent[];
};

export type Artifact = {
  id: string;
  runId: string;
  toolCallId?: string;
  toolName?: string;
  kind: "file";
  uri: string;
  mediaType: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
};

export type ChangeSet = {
  id: string;
  artifactId: string;
  runId: string;
  toolName?: string;
  operation: "created" | "modified" | "deleted" | "patch";
  path: string;
  before?: string;
  after?: string;
  patch?: string;
  addedLines: number;
  removedLines: number;
  createdAt: number;
};

export type TerminalSession = {
  id: string;
  session_id?: string;
  name?: string;
  type?: "local" | "ssh";
  status?: string;
  active?: boolean;
  cwd?: string;
  initial_cwd?: string;
  nodeId?: string;
  node_id?: string;
  nodeLabel?: string;
  node_label?: string;
  resourceId?: string;
  resource_id?: string;
  machine_id?: string;
  workspace_id?: string;
  projectRoot?: string;
  project_root?: string;
  projectName?: string;
  project_name?: string;
  ssh_user?: string;
  ssh_host?: string;
  ssh_port?: number;
  last_activity?: string | number;
  created_at?: string | number;
  updated_at?: string | number;
};

export type PluginRecord = {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  enabled?: boolean;
  status?: string;
  source?: string;
  filename?: string;
  file_size?: number;
  download_count?: number;
  upload_time?: string;
  metadata?: {
    name?: string;
    version?: string;
    description?: string;
  };
};

export type AccessDevice = {
  deviceId: string;
  kind: "owner" | "client" | "resource";
  label: string;
  platform?: string;
  scopes: string[];
  createdAt: number;
  lastSeenAt: number;
  revokedAt?: number | null;
};

export type AccessSession = {
  authenticated: true;
  mode?: string;
  scopes?: string[];
  expiresAt: number;
  device?: AccessDevice;
};

export type PairingInput = {
  pairingId?: string;
  secret?: string;
  userCode?: string;
};

export type FileEntry = {
  name: string;
  path: string;
  type?: "file" | "directory";
  kind?: "file" | "directory";
  size?: number;
  modifiedAt?: number | string;
};

export type RuntimeHealth = {
  ok: boolean;
  service: string;
  authRequired: boolean;
  authMode?: string;
  accessControl?: string;
  modelProfile?: {
    id: string;
    label?: string;
    model?: string;
  } | null;
  runtimePlugins?: Array<{
    id: string;
    status: string;
    version?: string;
  }>;
  runtimePluginFailures?: number;
  toolHosts?: string[];
  deviceNodeGateway?: boolean;
  schedulerWorker?: boolean;
  approvalProvider?: boolean;
};

export type ConnectionState = "online" | "offline" | "auth-required";
