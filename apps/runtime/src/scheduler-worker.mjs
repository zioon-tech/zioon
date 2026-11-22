import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { clearTimeout, setTimeout } from "node:timers";
import {
  CancellationController
} from "../../../packages/runtime/dist/index.js";

const TERMINAL_STATUS = {
  completed: "success",
  failed: "failed",
  aborted: "aborted"
};

export class RuntimeSchedulerWorker {
  constructor({
    executor,
    scheduler,
    sessions = null,
    tools,
    resolveRequest = null,
    workerId = `runtime:${hostname()}:${randomUUID()}`,
    availableTools = ["read", "glob", "grep", "tree"],
    leaseSeconds = 600,
    pollIntervalMs = 3000,
    logger = () => {}
  } = {}) {
    if (!executor?.execute) throw new Error("Scheduler worker requires an Agent executor");
    if (!scheduler?.claim || !scheduler?.complete) {
      throw new Error("Scheduler worker requires a Runtime Scheduler store");
    }
    if (!tools?.invoke) throw new Error("Scheduler worker requires a Tool Broker");
    this.executor = executor;
    this.scheduler = scheduler;
    this.sessions = sessions;
    this.tools = tools;
    this.resolveRequest = typeof resolveRequest === "function"
      ? resolveRequest
      : null;
    this.workerId = String(workerId);
    this.availableToolsSource = availableTools;
    this.leaseSeconds = Math.max(30, Number(leaseSeconds) || 600);
    this.pollIntervalMs = Math.max(50, Number(pollIntervalMs) || 3000);
    this.logger = logger;
    this.running = false;
    this.loopPromise = null;
    this.sleepTimer = null;
    this.wakeSleep = null;
    this.activeHandle = null;
    this.activeExecution = null;
    this.activeCommandCancellation = null;
    this.activeSessionId = null;
  }

  async claim() {
    await this.scheduler.tick();
    return await this.scheduler.claim({
      workerId: this.workerId,
      workerKind: "runtime",
      leaseSeconds: this.leaseSeconds,
      availableTools: this.availableTools
    });
  }

  get availableTools() {
    const source = typeof this.availableToolsSource === "function"
      ? this.availableToolsSource()
      : this.availableToolsSource;
    return [...new Set(
      (Array.isArray(source) ? source : []).map(String).filter(Boolean)
    )];
  }

  async appendEvent(runId, event) {
    await this.scheduler.appendEvent(runId, this.workerId, {
      ...event,
      ts: event.timestamp ?? event.ts ?? Date.now()
    });
  }

  async complete(runId, result) {
    return await this.scheduler.complete(runId, this.workerId, {
      status: TERMINAL_STATUS[result.status] || "failed",
      sessionId: result.sessionId || this.activeSessionId || null,
      chatRunId: result.runId || null,
      output: result.output || "",
      error: result.error || null,
      usage: result.usage || null
    });
  }

  async executeClaim(claimedRun) {
    const task = claimedRun?.task || {};
    if ((task.taskType || "agent") === "command") {
      await this.executeCommandClaim(claimedRun);
      return;
    }

    const interactionProfileId = task.interactionProfileId || "scheduled.default";
    const request = {
      title: task.title || "",
      prompt: task.prompt || "",
      interactionProfileId,
      ...(task.modelProfileId
        ? { model: { profileId: String(task.modelProfileId) } }
        : {}),
      projectId: task.projectId || undefined,
      principal: task.executionPrincipal,
      ...(task.nodeId ? { target: { nodeId: String(task.nodeId) } } : {}),
      policy: task.capability || { preset: "read-only" },
      timeoutMs: Math.max(10, Number(task.timeoutSeconds) || 300) * 1000,
      metadata: {
        source: "scheduler-worker",
        interactionProfileId,
        schedulerRunId: claimedRun.id,
        schedulerTaskId: claimedRun.taskId,
        scheduledFor: claimedRun.scheduledFor || null
      }
    };
    const resolved = this.resolveRequest
      ? await this.resolveRequest(request)
      : null;
    const sessionId = this.sessions?.createSession
      ? `scheduler_session_${randomUUID().replaceAll("-", "")}`
      : null;
    if (sessionId) {
      const timestamp = Date.now();
      await this.sessions.createSession({
        id: sessionId,
        status: "active",
        title: task.title || "定时任务",
        projectId: task.projectId || undefined,
        model: resolved?.model || request.model || undefined,
        policy: resolved?.policy || request.policy,
        metadata: {
          ...(resolved?.metadata || request.metadata),
          source: "scheduled-task",
          schedulerTaskId: claimedRun.taskId,
          schedulerRunId: claimedRun.id
        },
        createdAt: timestamp,
        updatedAt: timestamp
      }, ...(task.executionPrincipal ? [{ principal: task.executionPrincipal }] : []));
      this.activeSessionId = sessionId;
    }
    const handle = this.executor.execute({
      ...request,
      ...(sessionId ? { sessionId } : {}),
      ...(resolved?.model ? { model: resolved.model } : {}),
      policy: resolved?.policy || request.policy,
      metadata: resolved?.metadata || request.metadata
    });
    this.activeHandle = handle;
    this.activeSchedulerRunId = claimedRun.id;
    if (sessionId && this.scheduler?.linkSession) {
      await this.scheduler.linkSession(claimedRun.id, this.workerId, {
        sessionId,
        chatRunId: handle.runId
      });
    }
    if (sessionId && this.sessions?.appendSessionMessages) {
      await this.sessions.appendSessionMessages(sessionId, [{
        schemaVersion: 1,
        id: `message_${randomUUID().replaceAll("-", "")}`,
        sessionId,
        role: "user",
        content: task.prompt || "",
        runId: handle.runId,
        createdAt: Date.now()
      }]);
    }

    const toolOutcomes = {
      requested: 0,
      succeeded: 0,
      failed: 0,
      lastError: ""
    };
    const forwarding = (async () => {
      for await (const event of handle.events) {
        if (event.type === "message.delta" || event.type === "reasoning.delta") {
          continue;
        }
        if (event.type === "tool.requested") {
          toolOutcomes.requested += 1;
        }
        if (event.type === "tool.denied") {
          toolOutcomes.failed += 1;
          toolOutcomes.lastError = String(
            event.data?.reason || "Tool call denied"
          );
        }
        if (event.type === "tool.completed" && event.data?.ok === true) {
          toolOutcomes.succeeded += 1;
        }
        if (event.type === "tool.completed" && event.data?.ok === false) {
          toolOutcomes.failed += 1;
          toolOutcomes.lastError = String(
            event.data?.error || "Tool call failed"
          );
        }
        try {
          await this.appendEvent(claimedRun.id, event);
        } catch (error) {
          this.logger("warn", `Failed to append Scheduler event: ${error.message}`);
        }
      }
    })();
    const result = await handle.completion;
    await forwarding;
    const completedWithoutWorkingTools = (
      result.status === "completed"
      && toolOutcomes.requested > 0
      && toolOutcomes.succeeded === 0
      && toolOutcomes.failed > 0
    );
    const finalResult = completedWithoutWorkingTools
      ? {
          ...result,
          status: "failed",
          error: `All ${toolOutcomes.failed} tool calls failed${
            toolOutcomes.lastError ? `: ${toolOutcomes.lastError}` : ""
          }`
        }
      : result;
    await this.complete(claimedRun.id, {
      ...finalResult,
      sessionId
    });
    if (
      finalResult.status === "completed"
      && this.sessions?.reconcileCompletedSessionMessages
    ) {
      await this.sessions.reconcileCompletedSessionMessages();
    }
  }

  async executeCommandClaim(claimedRun) {
    const task = claimedRun.task || {};
    const cancellation = new CancellationController();
    this.activeCommandCancellation = cancellation;
    this.activeSchedulerRunId = claimedRun.id;
    await this.appendEvent(claimedRun.id, {
      type: "command.started",
      timestamp: Date.now(),
      data: { command: task.command || "", cwd: task.cwd || "" }
    });
    const result = await this.tools.invoke({
      invocationId: `scheduler:${claimedRun.id}:command`,
      runId: claimedRun.id,
      attemptId: `scheduler:${claimedRun.id}`,
      projectId: task.projectId || undefined,
      principal: task.executionPrincipal,
      ...(task.nodeId ? { target: { nodeId: String(task.nodeId) } } : {}),
      policy: task.capability || { preset: "trusted-automation" },
      toolCall: {
        id: `scheduler:${claimedRun.id}:bash`,
        name: "Bash",
        arguments: {
          command: task.command || "",
          cwd: task.cwd || "",
          timeout: Math.max(10, Number(task.timeoutSeconds) || 300) * 1000,
          session_id: task.capability?.allowedTerminalSessionIds?.[0]
        }
      }
    }, cancellation.signal);
    let payload = null;
    try {
      payload = JSON.parse(result.content);
    } catch {
      payload = null;
    }
    const exitCode = Number(payload?.exit_code);
    const succeeded = result.ok && (!Number.isFinite(exitCode) || exitCode === 0);
    const output = payload
      ? [
          String(payload.stdout || ""),
          payload.stderr ? `[stderr]\n${payload.stderr}` : ""
        ].filter(Boolean).join("\n")
      : result.content;
    await this.appendEvent(claimedRun.id, {
      type: succeeded ? "command.completed" : "command.failed",
      timestamp: Date.now(),
      data: {
        exitCode: Number.isFinite(exitCode) ? exitCode : null,
        error: succeeded ? null : result.error || payload?.error || "Command failed"
      }
    });
    await this.complete(claimedRun.id, {
      status: succeeded ? "completed" : "failed",
      runId: null,
      output,
      error: succeeded ? null : result.error || payload?.error || "Command failed",
      usage: null
    });
  }

  async pollOnce() {
    if (this.activeExecution) return null;
    const claimedRun = await this.claim();
    if (!claimedRun) return null;
    this.activeExecution = this.executeClaim(claimedRun)
      .catch(async (error) => {
        this.logger("error", `Scheduler Run failed: ${error.message}`);
        try {
          await this.complete(claimedRun.id, {
            status: "failed",
            runId: this.activeHandle?.runId || null,
            sessionId: this.activeSessionId,
            output: "",
            error: error.message,
            usage: null
          });
        } catch (completionError) {
          this.logger(
            "error",
            `Failed to report Scheduler completion: ${completionError.message}`
          );
        }
      })
      .finally(() => {
        this.activeHandle = null;
        this.activeCommandCancellation = null;
        this.activeSchedulerRunId = null;
        this.activeSessionId = null;
        this.activeExecution = null;
      });
    await this.activeExecution;
    return claimedRun;
  }

  async abort(runId, reason = "user") {
    if (this.activeSchedulerRunId !== String(runId)) {
      return false;
    }
    if (this.activeHandle) {
      await this.activeHandle.abort(String(reason || "user"));
    } else {
      this.activeCommandCancellation?.cancel(String(reason || "user"));
    }
    return true;
  }

  async sleep() {
    if (!this.running) return;
    await new Promise((resolve) => {
      this.wakeSleep = resolve;
      this.sleepTimer = setTimeout(resolve, this.pollIntervalMs);
    });
    this.sleepTimer = null;
    this.wakeSleep = null;
  }

  wake() {
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.wakeSleep?.();
  }

  async runLoop() {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.logger("debug", `Scheduler service unavailable: ${error.message}`);
      }
      await this.sleep();
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  async stop() {
    this.running = false;
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.wakeSleep?.();
    if (this.activeHandle) {
      await this.activeHandle.abort("runtime-shutdown");
    }
    this.activeCommandCancellation?.cancel("runtime-shutdown");
    await this.activeExecution;
    await this.loopPromise;
  }
}
