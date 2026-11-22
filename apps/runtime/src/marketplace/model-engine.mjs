import { OpenAICompatibleEngine, CancellationController } from "../../../../packages/runtime/dist/index.js";
import { hashExtension } from "../../../../packages/runtime-client/src/extension-package.mjs";
import { contentHash } from "../../../../packages/plugin-sdk/src/runtime-workflow.mjs";
import { extensionAccountId } from "./run-bindings.mjs";

const fail = (code) => { throw Object.assign(new Error(code), { code, statusCode: 409, retryable: false }); };
const profileId = (listingId, providerId, modelId) => `extension.${hashExtension([listingId, providerId, modelId])}`;
export const isExtensionModel = (model) => String(model?.profileId || "").startsWith("extension.");
// A symbol cannot be supplied by HTTP/JSON metadata. Only the server's
// capability broker may provide a separately authorized source-side Run.
export const SHARED_MODEL_EXECUTION = Symbol("sharedModelExecution");

/** Account discovery is metadata-only and never activates an execution resource. */
export class AccountExtensionModelCatalog {
  constructor({ marketplace }) { this.marketplace = marketplace; }
  async list(principal) {
    const accountId = extensionAccountId(principal);
    if (!accountId) return [];
    const snapshot = await this.marketplace.snapshot(accountId);
    return snapshot.entries.flatMap((entry) => {
      const install = entry.installation;
      if (!install?.enabled || entry.installedRelease?.artifact?.kind !== "plugin") return [];
      const declared = entry.installedRelease.artifact.plugin.capabilities.filter((c) => c.kind === "model" && c.models);
      const providers = declared.length ? declared : (install.validation?.handlers || []).filter((h) => h.kind === "model");
      return providers.flatMap((provider) => provider.models.map((model) => ({
        id: profileId(entry.id, provider.id, model.id), providerId: `extension.${hashExtension([entry.id, provider.id])}`,
        providerType: "openai", model: model.id, label: model.name,
        supportsStreaming: model.supportsStreaming, supportsTools: model.supportsTools,
        supportsImages: model.supportsImages === true, contextWindow: model.contextWindow,
        capabilities: { supportsImage: model.supportsImages === true, supportsTools: model.supportsTools },
        limits: model.contextWindow ? { contextWindow: model.contextWindow } : {},
        metadata: { source: "account-extension", readOnly: true, stream: model.supportsStreaming, contextWindowTokens: model.contextWindow },
        credentialConfigured: !!install.config
          && (!entry.installedRelease.artifact.plugin.connection?.required || !!install.config.credentialsFile), extension: {
          listingId: entry.id, providerId: provider.id, epoch: install.executionEpoch, model
        }
      })));
    });
  }
  async resolve(requested, principal) {
    const models = await this.list(principal);
    const selected = models.find((m) => m.id === requested?.profileId);
    if (!selected || (requested.providerId && requested.providerId !== selected.providerId)
      || (requested.modelId && requested.modelId !== selected.model)) fail("extension_model_unavailable");
    return { profileId: selected.id, providerId: selected.providerId, modelId: selected.model, label: selected.label };
  }
}

/** A per-Run model proxy. Model Node routing is independent of tool routing. */
export class AccountExtensionModelEngine {
  constructor({ engine, runs, execution, catalog, authorize = async () => {} }) {
    this.engine = engine; this.runs = runs; this.execution = execution; this.catalog = catalog;
    this.authorize = authorize; this.id = engine.id;
  }
  async prepare(request, context) {
    if (!isExtensionModel(request.model) || request.metadata?.extensionInvocation || request.metadata?.pluginToolInvocation) return {};
    const selected = (await this.catalog.list(request.principal)).find((m) => m.id === request.model.profileId);
    if (!selected || request.model.modelId !== selected.model || request.model.providerId !== selected.providerId) fail("extension_model_unavailable");
    const entry = selected.extension;
    const resolved = await this.execution.executionFor(request, entry.listingId, entry.epoch);
    await this.authorize(request);
    await this.execution.authorizeHost(request, resolved.install);
    const plan = { profileId: selected.id, listingId: entry.listingId, providerId: entry.providerId,
      model: entry.model, epoch: entry.epoch, digest: resolved.artifact.digest, configDigest: resolved.configDigest };
    if (context.resumed && contentHash(request.metadata?.extensionModelPlan) !== contentHash(plan)) fail("extension_model_plan_changed");
    return { metadata: { extensionModelPlan: plan } };
  }
  async *streamTurn(request) {
    if (!isExtensionModel(request.model)) { yield* this.engine.streamTurn(request); return; }
    if (request.preview) {
      const plan = request.metadata?.extensionModelPlan;
      if (!plan || plan.profileId !== request.model.profileId) fail("extension_model_plan_missing");
      const current = await this.execution.marketplace.assertExecution(extensionAccountId(request.principal), plan.listingId, plan.epoch);
      if (current.artifactDigest !== plan.digest || current.configDigest !== plan.configDigest) fail("extension_model_plan_changed");
      const previewEngine = new OpenAICompatibleEngine({
        id: `account-model:${plan.providerId}`, endpoint: "https://models.zioon.invalid/chat/completions",
        model: plan.model.id, supportsStreaming: plan.model.supportsStreaming,
        transport: async () => { fail("extension_preview_execution_denied"); }
      });
      const iterator = previewEngine.streamTurn(request)[Symbol.asyncIterator]();
      try {
        const first = await iterator.next();
        if (first.done || first.value.type !== "model.request") fail("extension_model_preview_missing");
        yield first.value;
      } finally { await iterator.return?.(); }
      return;
    }
    const run = request[SHARED_MODEL_EXECUTION] || await this.runs.get(request.runId);
    const plan = run?.metadata?.extensionModelPlan;
    if (!run || !plan || plan.profileId !== request.model.profileId
      || plan.model.id !== request.model.modelId || extensionAccountId(run.principal) !== extensionAccountId(request.principal)) {
      fail("extension_model_plan_missing");
    }
    const cancellation = new CancellationController();
    const parent = request.signal.onCancel((reason) => cancellation.cancel(reason));
    if (request.signal.cancelled) cancellation.cancel(request.signal.reason);
    let resolved;
    const fixed = async () => {
      await this.authorize(run);
      const current = await this.execution.marketplace.assertExecution(extensionAccountId(run.principal), plan.listingId, plan.epoch);
      if (current.artifactDigest !== plan.digest || current.configDigest !== plan.configDigest) fail("extension_model_plan_changed");
      const config = await this.execution.resolveConfig(current.install.config, run.principal);
      if (resolved && contentHash(config) !== contentHash(resolved.install.config)) fail("extension_model_node_changed");
      await this.execution.authorizeHost(run, { ...current.install, config });
      return current;
    };
    let guard, guardError, iterator;
    const timer = setInterval(() => {
      if (!guard) guard = fixed().catch((error) => {
        guardError = error; cancellation.cancel("extension-model-revoked");
      }).finally(() => { guard = null; });
    }, 500);
    timer.unref();
    try {
      resolved = await this.execution.executionFor(run, plan.listingId, plan.epoch);
      await fixed();
      const binding = this.execution.bridge.binding(resolved.install, resolved.artifact, extensionAccountId(run.principal));
      const context = { principal: run.principal, policy: run.policy, signal: cancellation.signal,
        runId: request.runId, attemptId: request.attemptId, turn: request.turn, sessionId: run.sessionId,
        invocationId: `model:${hashExtension([request.runId, request.attemptId, request.turn, plan])}`,
        authorize: fixed };
      const description = await this.execution.bridge.ensure(binding, resolved.artifact, context);
      const handler = description.handlers.find((h) => h.kind === "model" && h.id === plan.providerId);
      const model = handler?.models.find((m) => m.id === plan.model.id);
      if (!model || contentHash(model) !== contentHash(plan.model)) fail("extension_model_catalog_changed");
      if (request.tools.length && !model.supportsTools) fail("extension_model_tools_unsupported");
      if (!model.supportsImages && request.messages.some((m) => Array.isArray(m.content)
        && m.content.some((part) => part.type === "image_url"))) fail("extension_model_images_unsupported");
      await this.execution.marketplace.recordValidation(extensionAccountId(run.principal), plan.listingId, plan.epoch,
        description.handlers.filter((h) => h.kind === "tool").map((h) => ({
          name: h.id, description: h.description, inputSchema: h.inputSchema, execution: h.execution
        })), description);
      const transport = async (input) => {
        // The handler receives OpenAI request data; upstream URLs and credentials
        // are supplied by the installed module and its execution-side connection.
        iterator = this.execution.bridge.invokeStream(binding, description, handler, JSON.parse(input.body), context)[Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.done || first.value.type !== "headers") fail("extension_model_headers");
        const { status, headers } = first.value.payload;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let consumed = false;
        const body = { async *[Symbol.asyncIterator]() {
          if (consumed) fail("extension_model_body_consumed");
          consumed = true;
          let completed = false;
          try {
            while (true) {
              const item = await iterator.next();
              if (item.done) fail("extension_model_incomplete");
              if (item.value.type === "result") {
                if (!item.value.payload?.complete) fail("extension_model_incomplete");
                completed = true;
                const tail = decoder.decode();
                if (tail) yield tail;
                return;
              }
              if (item.value.type !== "chunk") fail("extension_model_chunk");
              yield decoder.decode(Buffer.from(item.value.payload, "base64"), { stream: true });
            }
          } finally { if (!completed) await iterator.return?.(); }
        } };
        const text = async () => { let value = ""; for await (const chunk of body) value += chunk; return value; };
        return { ok: status >= 200 && status < 300, status, headers, body,
          text, json: async () => JSON.parse(await text()) };
      };
      const engine = new OpenAICompatibleEngine({
        id: `account-model:${plan.providerId}`, endpoint: "https://models.zioon.invalid/chat/completions",
        model: model.id, supportsStreaming: model.supportsStreaming, transport, observeTimings: true
      });
      yield* engine.streamTurn({ ...request, signal: cancellation.signal });
      await fixed();
    } catch (error) { throw guardError || error; }
    finally {
      clearInterval(timer); parent.dispose();
      await iterator?.return?.();
      await guard;
    }
  }
}
