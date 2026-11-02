import { hashExtension } from "../../../../packages/runtime-client/src/extension-package.mjs";
import { contentHash } from "../../../../packages/plugin-sdk/src/runtime-workflow.mjs";
import { extensionToolCatalog, assertExtensionToolCatalog, extensionContextEnabled } from "./run-catalog.mjs";

const fail = (code) => { throw Object.assign(new Error(code), { code, statusCode: 403 }); };
export const extensionAccountId = (principal) => String(principal?.userId || principal?.user?.id || "");
// Execution grants and browser identities are never sent to user modules.
export function extensionRequest(request) {
  const { principal, metadata, ...rest } = request;
  const { zionTelemetry, extensionPlan, ...safeMetadata } = metadata || {};
  return { ...rest, metadata: safeMetadata, principal: {
    userId: extensionAccountId(principal), spaceId: principal?.spaceId || principal?.space?.id || ""
  } };
}

/** Produces per-Run proxies and immutable intent. No user module is imported. */
export class ExtensionRunBindings {
  constructor({ execution, outbox, authorize = async () => {} }) {
    this.execution = execution;
    this.marketplace = execution.marketplace;
    this.outbox = outbox;
    this.authorize = authorize;
  }
  async prepare(request, context) {
    const accountId = extensionAccountId(request.principal);
    if (!accountId) return {};
    const snapshot = await this.marketplace.snapshot(accountId);
    const toolCatalog = context.resumed && request.metadata?.extensionToolCatalog
      ? assertExtensionToolCatalog(request.metadata.extensionToolCatalog, snapshot) : extensionToolCatalog(snapshot);
    const previous = context.resumed ? request.metadata?.extensionPlan : null;
    if (context.resumed && previous && (!Array.isArray(previous) || previous.length > 100)) fail("extension_plan_invalid");
    const entries = previous || snapshot.entries.filter((entry) => {
      const install = entry.installation;
      const artifact = entry.installedRelease?.artifact;
      if (!install?.enabled || artifact?.kind !== "plugin") return false;
      const capabilities = artifact.plugin?.capabilities || [];
      // Model-only/command-only extensions are activated by their selected
      // operation. Listing and unrelated conversations never wake those Nodes.
      const handlers = install.validation?.epoch === install.executionEpoch ? install.validation.handlers : null;
      if (handlers) return handlers.some((h) =>
        (h.kind === "context" && extensionContextEnabled(h, entry.id, request))
        || ["controller", "post-processor"].includes(h.kind)
        || (h.kind === "job" && h.triggers?.includes("run.completed")));
      return capabilities.some((c) =>
        (c.kind === "context" && extensionContextEnabled(c, entry.id, request))
        || ["controller", "post-processor", "job"].includes(c.kind));
    }).map((entry) => ({ listingId: entry.id, epoch: entry.installation.executionEpoch }));
    const plan = [], contexts = [], controllers = [], leases = [];
    try {
    for (const entry of entries) {
      const resolved = await this.execution.executionFor({ principal: request.principal }, entry.listingId, entry.epoch);
      const { install, artifact, configDigest } = resolved;
      if (entry.digest && (entry.digest !== artifact.digest || entry.configDigest !== configDigest)) fail("extension_plan_changed");
      const invocation = { ...request, ...context, invocationId: `bind:${hashExtension([context.runId, context.attemptId, entry.listingId])}` };
      await this.authorize(invocation);
      await this.execution.authorizeHost(invocation, install);
      const binding = this.execution.bridge.binding(install, artifact, accountId);
      const lease = this.execution.bridge.acquireActivity(binding, invocation);
      if (lease) leases.push(lease);
      const description = await this.execution.bridge.ensure(binding, artifact, invocation);
      const tools = description.handlers.filter((h) => h.kind === "tool").map((h) => ({
        name: h.id, description: h.description, inputSchema: h.inputSchema, execution: h.execution
      }));
      await this.marketplace.recordValidation(accountId, entry.listingId, install.executionEpoch, tools, description);
      const fixed = { listingId: entry.listingId, epoch: install.executionEpoch, digest: artifact.digest,
        configDigest, handlers: description.handlers };
      if (entry.handlers && contentHash(entry.handlers) !== contentHash(fixed.handlers)) fail("extension_catalog_changed");
      plan.push(fixed);
      const invoke = async (handler, input, ctx, method) => {
        const id = `hook:${hashExtension([context.runId, context.attemptId, entry.listingId, handler.handle,
          method, ctx.turn ?? 0, input?.invocation?.invocationId || ""])}`;
        const hostContext = { ...invocation, ...ctx, principal: request.principal, policy: request.policy,
          request: extensionRequest(request), invocationId: id,
          authorize: async () => {
            await this.authorize(invocation);
            await this.marketplace.executionFor(accountId, entry.listingId, install.executionEpoch);
          },
          publishEvents: (events) => this.publishEvents(fixed, description, events, { ...invocation, invocationId: id })
        };
        return this.execution.bridge.invoke(binding, description, handler, input, hostContext, method);
      };
      for (const handler of description.handlers) {
        const id = `extension:${entry.listingId}:${handler.id}`;
        if (handler.kind === "context" && extensionContextEnabled(handler, entry.listingId, request)) contexts.push({
          id, required: handler.required, stage: handler.stage, order: handler.order,
          async contribute(messages, ctx) {
            const result = await invoke(handler,
              handler.mode === "prepare" ? extensionRequest(ctx.request) : messages, ctx);
            const output = Array.isArray(result) ? result : result?.messages;
            if (!Array.isArray(output)) fail("extension_context_result");
            return handler.mode === "prepare" ? [...output, ...messages] : output;
          }
        });
        if (handler.kind === "controller") {
          const controller = { id, order: handler.order };
          for (const method of handler.hooks.filter((hook) => hook !== "afterRun")) {
            controller[method] = async (...args) => {
              const ctx = args.at(-1);
              const input = method === "beforeTool" ? { invocation: this.publicInvocation(args[0]) }
                : method === "afterTool" ? { invocation: this.publicInvocation(args[0]), result: args[1] }
                  : { messages: ctx.messages, output: ctx.output, usage: ctx.usage, turn: ctx.turn };
              try {
                const result = await invoke(handler, input, ctx, method);
                if (["beforeTurn", "beforeModel", "beforeStop"].includes(method)
                  && result !== null && typeof result !== "string") {
                  if (result !== undefined) fail("extension_controller_result");
                }
                if (method === "beforeTool" && result && typeof result !== "string"
                  && result.ok !== false) fail("extension_controller_result");
                return result === null && method !== "beforeStop" ? undefined : result;
              } catch (error) { if (handler.required) throw error; }
            };
          }
          controllers.push(controller);
        }
      }
    }
    controllers.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const terminalCount = plan.reduce((count, entry) => count + entry.handlers.filter((h) =>
      (h.kind === "controller" && h.hooks.includes("afterRun")) || h.kind === "post-processor"
        || (h.kind === "job" && h.triggers.includes("run.completed"))).length, 0);
    if (terminalCount > 100) fail("extension_outbox_budget");
    return { contexts, controllers, metadata: { extensionPlan: plan, extensionToolCatalog: toolCatalog },
      dispose: () => { for (const lease of leases) lease.dispose(); },
      terminalOutbox: (result) => {
        if (context.preview) return [];
        const jobs = [];
        for (const entry of plan) for (const handler of entry.handlers) {
          const method = handler.kind === "controller" && handler.hooks.includes("afterRun") ? "afterRun" : undefined;
          if (!method && !(result.status === "completed" && (handler.kind === "post-processor"
            || (handler.kind === "job" && handler.triggers.includes("run.completed"))))) continue;
          jobs.push({ id: `job:${hashExtension([result.runId, result.attemptId, entry.listingId, handler.handle])}`,
            kind: "extension.handler", payload: { accountId, listingId: entry.listingId,
              epoch: entry.epoch, digest: entry.digest, configDigest: entry.configDigest,
              handler, ...(method ? { method } : {}) } });
        }
        return jobs;
      }
    };
    } catch (error) { for (const lease of leases) lease.dispose(); throw error; }
  }
  publicInvocation(invocation) {
    const { principal, ...rest } = invocation;
    return { ...rest, principal: { userId: extensionAccountId(principal) } };
  }
  async publishEvents(entry, description, events, context) {
    if (!this.outbox) fail("extension_outbox_unavailable");
    if (!Array.isArray(events) || events.length > 32) fail("extension_event_budget");
    const entries = events.flatMap((event, index) => {
      if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(event.type || "") || JSON.stringify(event).length > 100000) fail("extension_event_invalid");
      if (event.jobId && !/^[a-zA-Z0-9_.:-]{1,100}$/.test(event.jobId)) fail("extension_job_invalid");
      const handlers = description.handlers.filter((h) => h.kind === "job"
        && (event.jobId ? h.id === event.jobId : h.triggers.includes(event.type)));
      if (event.jobId && !handlers.length) fail("extension_job_missing");
      return handlers.map((handler) => ({
        id: `event:${hashExtension([context.invocationId, index, handler.handle])}`, kind: "extension.handler",
        payload: { accountId: extensionAccountId(context.principal), listingId: entry.listingId,
          epoch: entry.epoch, digest: entry.digest, configDigest: entry.configDigest, handler,
          ...(event.jobId ? { jobInput: event.payload } : { event: { type: event.type, payload: event.payload } }) }
      }));
    });
    await this.outbox.enqueue(context.runId, context.attemptId, entries);
  }
  async runJob(job, runs, signal) {
    const run = await runs.get(job.run_id);
    const entry = job.payload_json;
    if (!run || extensionAccountId(run.principal) !== entry.accountId) fail("extension_job_account");
    await this.authorize(run);
    const { install, artifact, configDigest } = await this.execution.executionFor(run, entry.listingId, entry.epoch);
    if (artifact.digest !== entry.digest || configDigest !== entry.configDigest) fail("extension_job_changed");
    const context = { ...run, runId: run.id, attemptId: job.attempt_id, signal,
      invocationId: job.id, jobId: job.id, jobGeneration: Number(job.generation),
      request: extensionRequest(run) };
    await this.execution.authorizeHost(context, install);
    const binding = this.execution.bridge.binding(install, artifact, entry.accountId);
    const description = await this.execution.bridge.ensure(binding, artifact, context);
    const handler = description.handlers.find((h) => h.handle === entry.handler.handle);
    if (!handler || contentHash(handler) !== contentHash(entry.handler)) fail("extension_job_catalog_changed");
    let input;
    if (Object.hasOwn(entry, "jobInput")) input = entry.jobInput;
    else if (entry.event) input = entry.event;
    else {
      const terminal = (await runs.getEvents(run.id)).findLast((event) =>
        event.attemptId === job.attempt_id && ["run.completed", "run.failed", "run.aborted"].includes(event.type));
      if (!terminal) fail("extension_job_terminal_missing");
      const result = { runId: run.id, attemptId: job.attempt_id, status: terminal.type.slice(4),
        output: terminal.data.output || "", usage: terminal.data.usage,
        reason: terminal.data.reason, error: terminal.data.error };
      input = entry.method ? { result } : {
        ...result, messages: await runs.getTranscript(run.id), request: extensionRequest(run)
      };
    }
    return this.execution.bridge.invoke(binding, description, handler, input, {
      ...context,
      authorize: async () => { await this.authorize(run); await this.marketplace.executionFor(entry.accountId, entry.listingId, entry.epoch); },
      publishEvents: (events) => this.publishEvents(entry, description, events, context)
    }, entry.method);
  }
}
