export const AGENTS_RUNTIME_PLUGIN_ID = "dev.agents";
export const AGENTS_RUNTIME_STATE_NAMESPACE = "agents";
export const AGENTS_RUNTIME_SNAPSHOT_KEY = "snapshot";
export const AGENTS_RUNTIME_KV_KEY =
  `runtime.plugins.${AGENTS_RUNTIME_PLUGIN_ID}.${AGENTS_RUNTIME_STATE_NAMESPACE}.${AGENTS_RUNTIME_SNAPSHOT_KEY}`;

export const AGENTS_TASKS_STORAGE_KEY = "zion.agents.tasks.v1";
export const AGENTS_ACTIVE_STORAGE_KEY = "agents.activeTaskId";
export const AGENTS_MANAGE_TOOL_NAME = "agentsManage";
export const AGENTS_MANAGE_READONLY_ACTIONS = [
  "list_agents",
  "list_tasks",
  "get_task"
];
export const AGENTS_MANAGE_WRITE_ACTIONS = [
  "create_task",
  "create_research_task",
  "delete_task",
  "select_task",
  "run_task",
  "stop_task"
];
export const AGENTS_MANAGE_RUNTIME_ACTIONS = [
  ...AGENTS_MANAGE_READONLY_ACTIONS,
  ...AGENTS_MANAGE_WRITE_ACTIONS
];

export const OUTPUT_CONTRACT = [
  { id: "contextBrief", heading: "Context Brief", label: "Context Brief" },
  { id: "workResult", heading: "Work Result", label: "Work Result" },
  { id: "evidence", heading: "Evidence", label: "Evidence" },
  { id: "nextActions", heading: "Next Actions", label: "Next Actions" }
];

export const DEFAULT_AGENTS = [
  {
    id: "researcher",
    labelKey: "agent.researcher",
    color: "cyan",
    modelPolicy: "fast",
    isolation: "context",
    background: true,
    maxTurns: 8,
    tools: ["read", "search", "web"],
    disallowedTools: ["edit", "write", "shell-write"],
    permissionMode: "read-only",
    outputContract: OUTPUT_CONTRACT,
    prompt: [
      "你是一个只读 Researcher sub-agent。",
      "适合调研代码、文档和外部资料，不直接修改文件。",
      "输出必须包含：Context Brief、关键发现、证据、建议下一步。"
    ].join("\n")
  },
  {
    id: "planner",
    labelKey: "agent.planner",
    color: "purple",
    modelPolicy: "inherit",
    isolation: "context",
    background: false,
    maxTurns: 6,
    tools: ["read", "search"],
    disallowedTools: ["edit", "write", "shell-write"],
    permissionMode: "plan",
    outputContract: OUTPUT_CONTRACT,
    prompt: [
      "你是一个 Planner sub-agent。",
      "目标是把模糊需求拆成可执行步骤，明确依赖、风险和验收标准。",
      "不要直接写代码，除非用户明确要求。"
    ].join("\n")
  },
  {
    id: "implementer",
    labelKey: "agent.implementer",
    color: "green",
    modelPolicy: "capable",
    isolation: "worktree-proposed",
    background: true,
    maxTurns: 12,
    tools: ["read", "search", "edit", "test"],
    disallowedTools: ["destructive-git", "secrets"],
    permissionMode: "accept-edits",
    outputContract: OUTPUT_CONTRACT,
    prompt: [
      "你是一个 Implementer sub-agent。",
      "适合实现自包含的改动。优先小步提交、最小修改、可验证结果。",
      "输出必须说明修改范围、验证方式和剩余风险。"
    ].join("\n")
  },
  {
    id: "reviewer",
    labelKey: "agent.reviewer",
    color: "orange",
    modelPolicy: "inherit",
    isolation: "context",
    background: true,
    maxTurns: 6,
    tools: ["read", "diff", "test"],
    disallowedTools: ["edit", "write"],
    permissionMode: "read-only",
    outputContract: OUTPUT_CONTRACT,
    prompt: [
      "你是一个 Reviewer sub-agent。",
      "重点发现 bug、回归风险、缺失测试和安全问题。",
      "按严重程度排序，避免只做总结。"
    ].join("\n")
  }
];

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function stringList(value) {
  return Array.isArray(value)
    ? Array.from(new Set(value.map((item) => String(item || "").trim()).filter(Boolean)))
    : [];
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function generatedTaskId(timestamp = Date.now()) {
  const random = globalThis.crypto?.randomUUID?.()
    || Math.random().toString(36).slice(2, 10);
  return `task_${Number(timestamp) || Date.now()}_${String(random).replace(/[^a-zA-Z0-9]+/g, "").slice(0, 10)}`;
}

function eventId(timestamp = Date.now()) {
  return `evt_${Number(timestamp) || Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function taskBody(prompt, output = "") {
  return `user ${String(prompt || "").trim()}\n\nassistant ${String(output || "")}`;
}

function completionStatus(completion = {}) {
  if (completion.status === "completed") return { status: "done", error: "" };
  if (completion.status === "aborted" && completion.reason === "user") {
    return { status: "aborted", error: "" };
  }
  if (completion.status === "aborted" && completion.reason === "timeout") {
    return { status: "error", error: "运行超时" };
  }
  return {
    status: "error",
    error: String(completion.error || completion.reason || "Agent Task failed").trim()
  };
}

function runEvent(type, data = {}, timestamp = Date.now()) {
  return {
    id: eventId(timestamp),
    type,
    ts: timestamp,
    data: objectValue(data),
    message: String(data.message || data.error || data.reason || "")
  };
}

export function getDefaultAgent(id) {
  return DEFAULT_AGENTS.find((agent) => agent.id === id) || DEFAULT_AGENTS[0];
}

export function normalizeAgentTask(task = {}) {
  const source = objectValue(task);
  const id = String(source.id || "").trim();
  if (!id) return null;
  const agent = getDefaultAgent(String(source.agentId || ""));
  return {
    id,
    title: String(source.title || source.anchorText || id),
    agentId: String(source.agentId || agent.id),
    status: String(source.status || "idle"),
    sessionId: String(source.sessionId || "global"),
    panelId: String(source.panelId || ""),
    taskSessionId: String(source.taskSessionId || ""),
    linkedSessionId: String(source.linkedSessionId || ""),
    body: String(source.body || ""),
    quote: String(source.quote || source.anchorText || ""),
    lineFrom: numberOrZero(source.lineFrom),
    lineTo: numberOrZero(source.lineTo),
    ...(Number.isFinite(Number(source.from)) ? { from: Number(source.from) } : {}),
    ...(Number.isFinite(Number(source.to)) ? { to: Number(source.to) } : {}),
    isolation: String(source.isolation || agent.isolation || "context"),
    background: source.background === undefined ? !!agent.background : source.background === true,
    permissionMode: String(source.permissionMode || agent.permissionMode || "default"),
    tools: stringList(source.tools || agent.tools),
    disallowedTools: stringList(source.disallowedTools || agent.disallowedTools),
    modelPolicy: String(source.modelPolicy || agent.modelPolicy || "inherit"),
    maxTurns: Math.max(1, Number(source.maxTurns || agent.maxTurns || 8)),
    prompt: String(source.prompt || ""),
    anchorText: String(source.anchorText || source.quote || ""),
    scratch: source.scratch === true,
    runner: cloneJson(source.runner) || null,
    result: cloneJson(source.result) || null,
    events: Array.isArray(source.events) ? source.events.slice(-80).map((event) => objectValue(event)) : [],
    activeRunId: String(source.activeRunId || ""),
    error: String(source.error || ""),
    runCount: Math.max(0, Number(source.runCount || 0)),
    createdAt: numberOrZero(source.createdAt),
    updatedAt: numberOrZero(source.updatedAt),
    completedAt: numberOrZero(source.completedAt)
  };
}

export function normalizeAgentsSnapshot(value = {}) {
  const source = objectValue(value);
  const tasks = (Array.isArray(source.tasks) ? source.tasks : [])
    .map(normalizeAgentTask)
    .filter(Boolean);
  return {
    version: 1,
    savedAt: numberOrZero(source.savedAt) || Date.now(),
    lastChangedAt: numberOrZero(source.lastChangedAt) || numberOrZero(source.savedAt) || Date.now(),
    activeTaskId: String(source.activeTaskId || ""),
    tasks
  };
}

function updateAgentsSnapshot(snapshot, {
  tasks,
  activeTaskId,
  timestamp = Date.now()
} = {}) {
  return normalizeAgentsSnapshot({
    ...snapshot,
    savedAt: timestamp,
    lastChangedAt: timestamp,
    activeTaskId: String(activeTaskId || ""),
    tasks
  });
}

export function agentsManageToolDefinition({
  actions = AGENTS_MANAGE_READONLY_ACTIONS
} = {}) {
  return {
    name: AGENTS_MANAGE_TOOL_NAME,
    description: "Inspect and update Runtime-backed Zion Agent definitions and Agent Tasks. Runtime supports task create/delete/select/run/stop; reveal_task and open_panel remain Workbench-only UI actions.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: actions,
          description: "Agent management action"
        },
        task_id: {
          type: "string",
          description: "Agent Task id for get_task"
        },
        session_id: {
          type: "string",
          description: "Filter tasks by source session id"
        },
        agent_id: {
          type: "string",
          enum: DEFAULT_AGENTS.map((agent) => agent.id),
          description: "Agent id when creating a task"
        },
        prompt: {
          type: "string",
          description: "Delegated prompt or anchored source text for task creation"
        },
        title: {
          type: "string",
          description: "Task title when creating a task"
        },
        instruction: {
          type: "string",
          description: "Instruction to place in the task body"
        },
        panel_id: {
          type: "string",
          description: "Workbench panel id projection for the task"
        },
        interaction_profile_id: {
          type: "string",
          description: "Runtime InteractionProfile id used when running a task"
        }
      },
      required: ["action"],
      additionalProperties: false
    }
  };
}

export function createAgentTask(snapshot = {}, args = {}, timestamp = Date.now()) {
  const current = normalizeAgentsSnapshot(snapshot);
  const prompt = String(args.prompt || args.instruction || "").trim();
  if (!prompt) throw new Error("prompt is required");
  const action = String(args.action || "create_task");
  const requestedAgentId = action === "create_research_task"
    ? "researcher"
    : String(args.agent_id || args.agentId || "");
  const agent = getDefaultAgent(requestedAgentId);
  const id = String(args.task_id || args.id || "").trim() || generatedTaskId(timestamp);
  if (current.tasks.some((task) => task.id === id)) {
    throw new Error(`Agent Task already exists: ${id}`);
  }
  const instruction = String(args.instruction || prompt).trim();
  const task = normalizeAgentTask({
    id,
    title: String(args.title || prompt).slice(0, 120) || id,
    agentId: agent.id,
    status: "idle",
    sessionId: String(args.session_id || args.sessionId || "global"),
    panelId: String(args.panel_id || args.panelId || ""),
    body: `user ${instruction}`,
    prompt: instruction,
    anchorText: prompt,
    quote: prompt,
    isolation: agent.isolation,
    background: agent.background,
    permissionMode: agent.permissionMode,
    tools: agent.tools,
    disallowedTools: agent.disallowedTools,
    modelPolicy: agent.modelPolicy,
    maxTurns: agent.maxTurns,
    events: [{
      type: "task.created",
      ts: timestamp,
      data: { message: "created in Runtime" }
    }],
    result: null,
    runCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  return {
    snapshot: updateAgentsSnapshot(current, {
      tasks: [...current.tasks, task],
      activeTaskId: task.id,
      timestamp
    }),
    task: summarizeAgentTask(task)
  };
}

export function deleteAgentTask(snapshot = {}, taskId = "", timestamp = Date.now()) {
  const current = normalizeAgentsSnapshot(snapshot);
  const id = String(taskId || "").trim();
  if (!id) throw new Error("task_id is required");
  const tasks = current.tasks.filter((task) => task.id !== id);
  if (tasks.length === current.tasks.length) throw new Error(`Agent Task not found: ${id}`);
  const activeTaskId = current.activeTaskId === id ? (tasks[0]?.id || "") : current.activeTaskId;
  return {
    snapshot: updateAgentsSnapshot(current, { tasks, activeTaskId, timestamp }),
    deleted: id
  };
}

export function selectAgentTask(snapshot = {}, taskId = "", timestamp = Date.now()) {
  const current = normalizeAgentsSnapshot(snapshot);
  const id = String(taskId || "").trim();
  if (!id) throw new Error("task_id is required");
  if (!current.tasks.some((task) => task.id === id)) {
    throw new Error(`Agent Task not found: ${id}`);
  }
  return {
    snapshot: updateAgentsSnapshot(current, {
      tasks: current.tasks,
      activeTaskId: id,
      timestamp
    }),
    selected: id
  };
}

export function startAgentTaskRun(snapshot = {}, taskId = "", run = {}, timestamp = Date.now()) {
  const current = normalizeAgentsSnapshot(snapshot);
  const id = String(taskId || "").trim();
  if (!id) throw new Error("task_id is required");
  const index = current.tasks.findIndex((task) => task.id === id);
  if (index < 0) throw new Error(`Agent Task not found: ${id}`);
  const task = current.tasks[index];
  if (task.status === "running" && task.activeRunId) {
    throw new Error(`Agent Task is already running: ${id}`);
  }
  const runId = String(run.runId || "").trim();
  if (!runId) throw new Error("runId is required");
  const runSessionId = String(run.sessionId || task.taskSessionId || `agent-task:${id}`);
  const nextTask = normalizeAgentTask({
    ...task,
    status: "running",
    activeRunId: runId,
    taskSessionId: runSessionId,
    linkedSessionId: task.linkedSessionId || "",
    startedAt: timestamp,
    updatedAt: timestamp,
    runCount: Number(task.runCount || 0) + 1,
    body: task.body || taskBody(task.prompt || task.anchorText || task.quote || ""),
    result: null,
    error: "",
    events: [
      ...task.events,
      runEvent("runner.start", {
        runId,
        attemptId: run.attemptId || "",
        runner: "runtime",
        message: "started in Runtime Host"
      }, timestamp)
    ]
  });
  const tasks = current.tasks.slice();
  tasks[index] = nextTask;
  return {
    snapshot: updateAgentsSnapshot(current, { tasks, activeTaskId: id, timestamp }),
    task: summarizeAgentTask(nextTask)
  };
}

export function finishAgentTaskRun(snapshot = {}, taskId = "", completion = {}, timestamp = Date.now()) {
  const current = normalizeAgentsSnapshot(snapshot);
  const id = String(taskId || "").trim();
  if (!id) throw new Error("task_id is required");
  const index = current.tasks.findIndex((task) => task.id === id);
  if (index < 0) throw new Error(`Agent Task not found: ${id}`);
  const task = current.tasks[index];
  const output = String(completion.output || "");
  const terminal = completionStatus(completion);
  const nextTask = normalizeAgentTask({
    ...task,
    status: terminal.status,
    activeRunId: "",
    completedAt: timestamp,
    updatedAt: timestamp,
    body: taskBody(task.prompt || task.anchorText || task.quote || "", output),
    result: {
      workResult: output,
      status: completion.status || "failed",
      usage: completion.usage || null
    },
    error: terminal.error,
    events: [
      ...task.events,
      runEvent(
        terminal.status === "done" ? "runner.complete" : "runner.error",
        {
          runId: completion.runId || task.activeRunId || "",
          message: terminal.error || "completed",
          status: completion.status || terminal.status
        },
        timestamp
      )
    ]
  });
  const tasks = current.tasks.slice();
  tasks[index] = nextTask;
  return {
    snapshot: updateAgentsSnapshot(current, {
      tasks,
      activeTaskId: current.activeTaskId,
      timestamp
    }),
    task: summarizeAgentTask(nextTask)
  };
}

export function stopAgentTaskRun(snapshot = {}, taskId = "", reason = "user", timestamp = Date.now()) {
  const current = normalizeAgentsSnapshot(snapshot);
  const id = String(taskId || "").trim();
  if (!id) throw new Error("task_id is required");
  const index = current.tasks.findIndex((task) => task.id === id);
  if (index < 0) throw new Error(`Agent Task not found: ${id}`);
  const task = current.tasks[index];
  const nextTask = normalizeAgentTask({
    ...task,
    status: "aborted",
    activeRunId: "",
    completedAt: timestamp,
    updatedAt: timestamp,
    error: "",
    events: [
      ...task.events,
      runEvent("runner.stop", {
        runId: task.activeRunId || "",
        reason,
        message: "stop requested"
      }, timestamp)
    ]
  });
  const tasks = current.tasks.slice();
  tasks[index] = nextTask;
  return {
    snapshot: updateAgentsSnapshot(current, {
      tasks,
      activeTaskId: current.activeTaskId,
      timestamp
    }),
    task: summarizeAgentTask(nextTask)
  };
}

export function summarizeAgent(agent = {}) {
  return {
    id: String(agent.id || ""),
    labelKey: String(agent.labelKey || ""),
    isolation: agent.isolation,
    background: agent.background === true,
    permissionMode: agent.permissionMode,
    tools: stringList(agent.tools),
    disallowedTools: stringList(agent.disallowedTools),
    modelPolicy: agent.modelPolicy,
    maxTurns: agent.maxTurns,
    outputContract: (agent.outputContract || OUTPUT_CONTRACT).map((item) => item.heading)
  };
}

export function summarizeAgentTask(task = {}) {
  const normalized = normalizeAgentTask(task);
  if (!normalized) return null;
  return {
    id: normalized.id,
    title: normalized.title,
    agentId: normalized.agentId,
    status: normalized.status,
    sessionId: normalized.sessionId,
    lineFrom: normalized.lineFrom,
    lineTo: normalized.lineTo,
    isolation: normalized.isolation,
    background: normalized.background,
    permissionMode: normalized.permissionMode,
    tools: normalized.tools,
    disallowedTools: normalized.disallowedTools,
    modelPolicy: normalized.modelPolicy,
    maxTurns: normalized.maxTurns,
    runner: normalized.runner || null,
    result: normalized.result || null,
    activeRunId: normalized.activeRunId,
    runCount: normalized.runCount,
    updatedAt: normalized.updatedAt
  };
}

export function listAgentTasks(snapshot = {}, {
  sessionId = ""
} = {}) {
  const normalized = normalizeAgentsSnapshot(snapshot);
  const sid = String(sessionId || "").trim();
  return normalized.tasks
    .filter((task) => !sid || String(task.sessionId || "global") === sid)
    .sort((left, right) =>
      Number(right.updatedAt || 0) - Number(left.updatedAt || 0)
      || String(left.id || "").localeCompare(String(right.id || ""))
    )
    .map(summarizeAgentTask);
}

export function getAgentTask(snapshot = {}, taskId = "") {
  const id = String(taskId || "").trim();
  if (!id) return null;
  const task = normalizeAgentsSnapshot(snapshot).tasks.find((item) => item.id === id);
  return task ? summarizeAgentTask(task) : null;
}
