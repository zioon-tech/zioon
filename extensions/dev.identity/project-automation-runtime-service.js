import {
  buildAttentionEntry,
  buildAutomationTaskPrompt,
  inspectProjectReadiness,
  normalizeAutomationDocument,
  normalizeProjectPolicy,
  reconcileProjectRun,
  selectAutomationCandidate,
  updateProjectPolicy
} from "./project-automation-core.js";
import {
  PROJECT_AUTOMATION_RUNTIME_KV_KEY
} from "./identity-runtime-shared.js";
import {
  AGENTS_RUNTIME_KV_KEY,
  createAgentTask,
  finishAgentTaskRun,
  normalizeAgentTask,
  normalizeAgentsSnapshot,
  startAgentTaskRun,
  stopAgentTaskRun
} from "../dev.agents/agents-runtime-shared.js";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const PROJECT_INDEX_PATH = "projects/index.md";
const PROJECT_ATTENTION_PATH = "projects/attention.md";

function projectRelativePath(projectKey) {
  const key = String(projectKey || "").trim().replaceAll("\\", "/");
  if (!key || key.startsWith("/") || key.split("/").some((part) => part === "..")) {
    throw new Error(`Invalid project_key: ${projectKey}`);
  }
  return `projects/${key}/project.md`;
}

function executionPolicy(fileService, memoryRoot, projectKey, policy) {
  const projectPath = fileService.resolvePath(memoryRoot, projectRelativePath(projectKey));
  const indexPath = fileService.resolvePath(memoryRoot, PROJECT_INDEX_PATH);
  const attentionPath = fileService.resolvePath(memoryRoot, PROJECT_ATTENTION_PATH);
  const trusted = policy.mode === "execute" && policy.allowedCommandPrefixes.length > 0;
  return {
    projectPath,
    indexPath,
    attentionPath,
    policy: {
      preset: trusted ? "trusted-automation" : "workspace-write",
      allowedTools: [
        "read",
        "glob",
        "grep",
        "tree",
        "webSearch",
        "webFetch",
        "write",
        "edit",
        ...(trusted ? ["Bash"] : [])
      ],
      fileRoots: [
        projectPath,
        indexPath,
        attentionPath,
        ...(policy.mode === "execute" ? policy.fileRoots : [])
      ],
      allowedCommandPrefixes: trusted ? policy.allowedCommandPrefixes : [],
      allowedTerminalSessionIds: [],
      allowedRecipients: [],
      maxMailPerRun: 0,
      maxToolCalls: policy.maxToolCalls
    }
  };
}

function replaceAttentionEntry(current, entry) {
  const lines = String(current || "").split(/\r?\n/);
  const entryLines = String(entry || "").split("\n");
  const index = lines.findIndex((line) => line === entryLines[0]);
  if (index < 0) {
    const base = String(current || "").trim() || "# 待处理事项";
    return `${base}\n\n${entry}\n`;
  }
  const removeCount = lines[index + 1]?.startsWith("- [ ]") ? 2 : 1;
  lines.splice(index, removeCount, ...entryLines);
  return `${lines.join("\n").trim()}\n`;
}

function agentForPhase(phase) {
  if (phase === "research") return "researcher";
  if (phase === "planning") return "planner";
  return "implementer";
}

export function createProjectAutomationRuntimeService({
  stateStore,
  readDocument,
  writeDocument,
  readAgentsDocument,
  writeAgentsDocument,
  fileService,
  runnerService,
  memoryRoot,
  interactionProfileId = "interactive.default",
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  logger = () => {},
  now = () => Date.now(),
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout
} = {}) {
  const readState = typeof readDocument === "function"
    ? readDocument
    : stateStore?.readKV
      ? () => stateStore.readKV(PROJECT_AUTOMATION_RUNTIME_KV_KEY)?.value
      : null;
  const writeState = typeof writeDocument === "function"
    ? writeDocument
    : stateStore?.writeKV
      ? (document) => stateStore.writeKV(PROJECT_AUTOMATION_RUNTIME_KV_KEY, document)
      : null;
  if (typeof readState !== "function" || typeof writeState !== "function") {
    throw new Error("Project Automation requires Runtime state access");
  }
  let inMemoryAgentsDocument = normalizeAgentsSnapshot();
  const readAgentsState = typeof readAgentsDocument === "function"
    ? readAgentsDocument
    : stateStore?.readKV
      ? () => stateStore.readKV(AGENTS_RUNTIME_KV_KEY)?.value
      : () => inMemoryAgentsDocument;
  const writeAgentsState = typeof writeAgentsDocument === "function"
    ? writeAgentsDocument
    : stateStore?.writeKV
      ? (document) => stateStore.writeKV(AGENTS_RUNTIME_KV_KEY, document)
      : (document) => {
          inMemoryAgentsDocument = document;
        };
  if (!fileService?.readTextFiles || !fileService?.writeTextFiles || !fileService?.resolvePath) {
    throw new Error("Project Automation requires the Runtime plugin file service");
  }
  if (!runnerService?.startTaskRun || !runnerService?.abortRun) {
    throw new Error("Project Automation requires the Runtime Agent runner");
  }
  const root = String(memoryRoot || "").trim();
  if (!root) throw new Error("Project Automation requires an Identity memory root");

  const activeRuns = new Map();
  let running = false;
  let timer = null;
  let coordinatorPromise = null;

  const loadDocument = () => normalizeAutomationDocument(readState() || {});
  const saveDocument = (document) => {
    const normalized = normalizeAutomationDocument(document);
    writeState(normalized);
    return normalized;
  };
  const loadAgentsDocument = () => normalizeAgentsSnapshot(readAgentsState() || {});
  const saveAgentsDocument = (document) => {
    const normalized = normalizeAgentsSnapshot(document);
    writeAgentsState(normalized);
    return normalized;
  };
  const fileRunContext = (projectKey) => ({
    runId: `project-automation:${projectKey}`,
    attemptId: `project-automation:${projectKey}`,
    sessionId: `agent-project:${projectKey}`,
    projectId: projectKey,
    policy: {
      preset: "workspace-write",
      fileRoots: [root]
    }
  });

  async function appendAttention(projectKey, reason, detail = "") {
    const loaded = await fileService.readTextFiles({
      fileRoot: root,
      files: { attention: PROJECT_ATTENTION_PATH },
      runContext: fileRunContext(projectKey)
    });
    const entry = buildAttentionEntry({
      projectKey,
      projectName: projectKey,
      reason,
      detail,
      at: new Date(now()).toISOString()
    });
    await fileService.writeTextFiles({
      fileRoot: root,
      files: {
        attention: {
          relativePath: PROJECT_ATTENTION_PATH,
          content: replaceAttentionEntry(loaded.files.attention, entry)
        }
      },
      runContext: fileRunContext(projectKey)
    });
  }

  async function finishProject(projectKey, taskId, completion) {
    const agentsDocument = loadAgentsDocument();
    const task = agentsDocument.tasks.find((item) => item.id === taskId);
    try {
      if (
        task?.status === "running"
        && (
          !completion?.runId
          || !task.activeRunId
          || task.activeRunId === completion.runId
        )
      ) {
        const finishedTask = finishAgentTaskRun(
          agentsDocument,
          taskId,
          completion,
          now()
        );
        saveAgentsDocument(finishedTask.snapshot);
      }
    } catch (error) {
      logger("warn", `Project Automation Agent task completion failed: ${error.message}`);
    }
    const current = loadDocument();
    const policy = current.projects[projectKey] || normalizeProjectPolicy();
    if (policy.activeTaskId !== taskId) return;
    const completedAt = now();
    const succeeded = completion?.status === "completed";
    const error = String(completion?.error || "自动推进失败").trim();
    saveDocument(updateProjectPolicy(current, projectKey, {
      activeTaskId: "",
      lastCompletedAt: completedAt,
      lastStatus: succeeded ? "success" : "failed",
      lastError: succeeded ? "" : error,
      failureCount: succeeded ? 0 : policy.failureCount + 1,
      nextEligibleAt: completedAt + policy.cadenceMinutes * 60_000
    }, completedAt));
    if (!succeeded) {
      await appendAttention(projectKey, "run-failed", error);
    }
  }

  async function launchProject(projectKey, options = {}) {
    const current = loadDocument();
    const key = String(projectKey || "").trim();
    const policy = current.projects[key] || normalizeProjectPolicy();
    if (!key) throw new Error("project_key is required");
    if (!policy.enabled) {
      return { status: "disabled", projectKey: key };
    }
    if (policy.activeTaskId || activeRuns.has(key)) {
      const active = activeRuns.get(key);
      const task = loadAgentsDocument().tasks.find((item) => item.id === policy.activeTaskId);
      return {
        status: "running",
        projectKey: key,
        taskId: policy.activeTaskId || active?.taskId || "",
        runId: active?.handle?.runId || task?.activeRunId || ""
      };
    }

    const paths = executionPolicy(fileService, root, key, policy);
    const loaded = await fileService.readTextFiles({
      fileRoot: root,
      files: {
        project: projectRelativePath(key),
        index: PROJECT_INDEX_PATH
      },
      runContext: fileRunContext(key)
    });
    if (!String(loaded.files.project || "").trim()) {
      await appendAttention(key, "project-missing");
      saveDocument(updateProjectPolicy(current, key, {
        lastStatus: "attention",
        lastError: "Project file is missing",
        nextEligibleAt: now() + policy.cadenceMinutes * 60_000
      }, now()));
      return { status: "attention", projectKey: key, reason: "project-missing" };
    }

    const readiness = inspectProjectReadiness(loaded.files.project, policy);
    if (readiness.kind === "none") return { status: "idle", projectKey: key };
    if (readiness.kind === "attention") {
      await appendAttention(key, readiness.reason);
      saveDocument(updateProjectPolicy(current, key, {
        lastStatus: "attention",
        lastPhase: "",
        lastError: "",
        nextEligibleAt: now() + policy.cadenceMinutes * 60_000
      }, now()));
      return { status: "attention", projectKey: key, reason: readiness.reason };
    }

    const prompt = buildAutomationTaskPrompt({
      project: { key, name: key },
      projectPath: paths.projectPath,
      indexPath: paths.indexPath,
      attentionPath: paths.attentionPath,
      phase: readiness.phase,
      nextStep: readiness.nextStep
    });
    const taskId = `project-auto-${key.replace(/[^a-zA-Z0-9_-]+/g, "-")}-${now().toString(36)}`;
    const created = createAgentTask(loadAgentsDocument(), {
      action: "create_task",
      task_id: taskId,
      session_id: `agent-project:${key}`,
      agent_id: agentForPhase(readiness.phase),
      title: `自动推进 · ${key} · ${readiness.phase}`,
      prompt
    }, now());
    const task = normalizeAgentTask({
      ...created.snapshot.tasks.find((item) => item.id === taskId),
      permissionMode: "accept-edits",
      tools: paths.policy.allowedTools,
      disallowedTools: [],
      maxTurns: Math.max(1, Math.ceil(policy.maxToolCalls / 4))
    });
    saveAgentsDocument({
      ...created.snapshot,
      tasks: created.snapshot.tasks.map((item) => item.id === taskId ? task : item)
    });
    let handle;
    try {
      handle = runnerService.startTaskRun(task, {
        interactionProfileId: options.interactionProfileId || interactionProfileId,
        parentRunId: options.parentRunId || "",
        parentAttemptId: options.parentAttemptId || "",
        projectId: key,
        policy: paths.policy
      });
    } catch (error) {
      const failedAt = now();
      const message = error?.message || String(error);
      saveAgentsDocument(finishAgentTaskRun(
        loadAgentsDocument(),
        taskId,
        { status: "failed", error: message },
        failedAt
      ).snapshot);
      saveDocument(updateProjectPolicy(loadDocument(), key, {
        activeTaskId: "",
        lastCompletedAt: failedAt,
        lastStatus: "failed",
        lastError: message,
        failureCount: policy.failureCount + 1,
        nextEligibleAt: failedAt + policy.cadenceMinutes * 60_000
      }, failedAt));
      try {
        await appendAttention(key, "run-failed", message);
      } catch (attentionError) {
        logger("warn", `Project Automation attention write failed: ${attentionError.message}`);
      }
      throw error;
    }
    saveAgentsDocument(startAgentTaskRun(
      loadAgentsDocument(),
      taskId,
      {
        runId: handle.runId,
        attemptId: handle.attemptId,
        sessionId: handle.sessionId
      },
      now()
    ).snapshot);
    const startedAt = now();
    saveDocument(updateProjectPolicy(loadDocument(), key, {
      activeTaskId: taskId,
      lastRunAt: startedAt,
      lastStatus: "running",
      lastPhase: readiness.phase,
      lastError: ""
    }, startedAt));
    const timeout = setTimer(() => {
      void handle.abort?.("timeout");
    }, policy.timeoutMinutes * 60_000);
    activeRuns.set(key, { handle, taskId, timeout });
    void (async () => {
      if (!handle.events?.[Symbol.asyncIterator]) return;
      for await (const _event of handle.events) {
        // RunStore already persists the event stream; draining prevents queue buildup.
      }
    })().catch((error) => logger("warn", `Project Automation event drain failed: ${error.message}`));
    void Promise.resolve(handle.completion)
      .then(
        (completion) => finishProject(key, taskId, completion),
        (error) => finishProject(key, taskId, {
          status: "failed",
          error: error?.message || String(error)
        })
      )
      .catch((error) => logger("warn", `Project Automation completion failed: ${error.message}`))
      .finally(() => {
        clearTimer(timeout);
        activeRuns.delete(key);
        if (running) wake();
      });
    return {
      status: "running",
      projectKey: key,
      taskId,
      runId: handle.runId,
      attemptId: handle.attemptId,
      sessionId: handle.sessionId || task.taskSessionId
    };
  }

  async function pollOnce(options = {}) {
    if (coordinatorPromise) return coordinatorPromise;
    if (activeRuns.size) return { status: "busy" };
    coordinatorPromise = (async () => {
      let document = loadDocument();
      let agentsDocument = loadAgentsDocument();
      let agentsChanged = false;
      let documentChanged = false;
      const timestamp = now();
      for (const [key, policy] of Object.entries(document.projects)) {
        if (!policy.activeTaskId || activeRuns.has(key)) continue;
        const task = agentsDocument.tasks.find((item) => item.id === policy.activeTaskId);
        const patch = reconcileProjectRun(policy, task, false, timestamp);
        if (!patch) continue;
        document = updateProjectPolicy(document, key, {
          ...patch,
          failureCount: patch.lastStatus === "success" ? 0 : policy.failureCount + 1
        }, timestamp);
        documentChanged = true;
        if (task && task.status === "running") {
          agentsDocument = finishAgentTaskRun(agentsDocument, task.id, {
            status: "interrupted",
            error: patch.lastError
          }, timestamp).snapshot;
          agentsChanged = true;
        }
      }
      if (documentChanged) saveDocument(document);
      if (agentsChanged) saveAgentsDocument(agentsDocument);
      const projects = Object.keys(document.projects).map((key) => ({ key }));
      const candidate = selectAutomationCandidate(projects, document, timestamp, {
        projectKey: options.projectKey
      });
      if (!candidate) return { status: "idle" };
      return launchProject(candidate.key, options);
    })().finally(() => {
      coordinatorPromise = null;
    });
    return coordinatorPromise;
  }

  function schedule(delay = pollIntervalMs) {
    if (!running || timer) return;
    timer = setTimer(() => {
      timer = null;
      void pollOnce()
        .catch((error) => logger("warn", `Project Automation poll failed: ${error.message}`))
        .finally(() => schedule());
    }, Math.max(0, Number(delay) || 0));
  }

  function wake() {
    if (timer) clearTimer(timer);
    timer = null;
    schedule(0);
  }

  async function stopProject(projectKey, reason = "user") {
    const key = String(projectKey || "").trim();
    if (!key) throw new Error("project_key is required");
    if (coordinatorPromise) {
      await coordinatorPromise.catch(() => {});
    }
    const current = loadDocument();
    const policy = current.projects[key] || normalizeProjectPolicy();
    if (!policy.activeTaskId && !activeRuns.has(key)) {
      return { status: "idle", projectKey: key, abortedRun: false };
    }
    const active = activeRuns.get(key);
    const agentsDocument = loadAgentsDocument();
    const task = agentsDocument.tasks.find((item) => item.id === policy.activeTaskId);
    const runId = active?.handle?.runId || task?.activeRunId || "";
    const aborted = active
      ? await Promise.resolve(active.handle.abort?.(reason)).then(() => true, () => false)
      : await Promise.resolve(runnerService.abortRun(runId, reason)).then(Boolean, () => false);
    if (active?.timeout) clearTimer(active.timeout);
    activeRuns.delete(key);
    if (task) {
      saveAgentsDocument(stopAgentTaskRun(agentsDocument, task.id, reason, now()).snapshot);
    }
    saveDocument(updateProjectPolicy(loadDocument(), key, {
      activeTaskId: "",
      lastStatus: "idle",
      lastError: reason === "disabled" ? "Disabled from Runtime projectAutomationManage" : ""
    }, now()));
    return { status: "stopped", projectKey: key, abortedRun: aborted };
  }

  return Object.freeze({
    readDocument: loadDocument,
    writeDocument: saveDocument,
    runNow(projectKey, options = {}) {
      return pollOnce({ ...options, projectKey });
    },
    stopProject,
    pollOnce,
    start() {
      if (running) return;
      running = true;
      wake();
    },
    async stop() {
      running = false;
      if (timer) clearTimer(timer);
      timer = null;
      await Promise.all(Array.from(activeRuns.keys()).map((key) =>
        stopProject(key, "runtime-shutdown")
      ));
    },
    get running() {
      return running;
    }
  });
}
