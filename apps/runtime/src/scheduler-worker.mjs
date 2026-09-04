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
    tools,
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
    this.tools = tools;
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
  }

  async claim() {
    this.scheduler.tick();
    return this.scheduler.claim({
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
    this.scheduler.appendEvent(runId, this.workerId, {
      ...event,
      ts: event.timestamp ?? event.ts ?? Date.now()
    });
  }

  async complete(runId, result) {
    return this.scheduler.complete(runId, this.workerId, {
      status: TERMINAL_STATUS[result.status] || "failed",
      sessionId: null,
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

    const handle = this.executor.execute({
      title: task.title || "",
      prompt: task.prompt || "",
      interactionProfileId: task.interactionProfileId || undefined,
      projectId: task.projectId || undefined,
      policy: task.capability || { preset: "read-only" },
      timeoutMs: Math.max(10, Number(task.timeoutSeconds) || 300) * 1000,
      metadata: {
        source: "scheduler-worker",
        interactionProfileId: task.interactionProfileId || null,
        schedulerRunId: claimedRun.id,
        schedulerTaskId: claimedRun.taskId,
        scheduledFor: claimedRun.scheduledFor || null
      }
    });
    this.activeHandle = handle;
    this.activeSchedulerRunId = claimedRun.id;

    const forwarding = (async () => {
      for await (const event of handle.events) {
        if (event.type === "message.delta") continue;
        try {
          await this.appendEvent(claimedRun.id, event);
        } catch (error) {
          this.logger("warn", `Failed to append Scheduler event: ${error.message}`);
        }
      }
    })();
    const result = await handle.completion;
    await forwarding;
    await this.complete(claimedRun.id, result);
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
