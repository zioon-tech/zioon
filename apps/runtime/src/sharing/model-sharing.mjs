import { createHash } from "node:crypto";
import { CancellationController } from "../../../../packages/runtime/dist/index.js";
import { accountError } from "../accounts/account-policy.mjs";

const userId = p => p?.userId || p?.user?.id;
export const borrowedModelShare = model => String(model?.profileId || "").startsWith("share.")
  ? model.profileId.slice(6) : null;
const visiblePayload = (payload = {}) => Object.fromEntries(Object.entries(payload).filter(([key]) =>
  ["messages", "tools", "tool_choice", "temperature", "max_tokens", "max_completion_tokens",
    "stream", "stream_options", "top_p", "reasoning"].includes(key)));
const redactedRequest = (share, payload) => ({
  type: "model.request", request: {
    url: "share://model", providerId: "shared", modelId: share.id, modelLabel: share.name,
    payload: { ...visiblePayload(payload), model: share.id }
  }
});
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const digest = v => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
const publicFailure = error => error?.statusCode && /^(share_|capability_|grant_|authentication_)/.test(error.code || "")
  ? accountError(error.statusCode, error.code, error.code === "capability_source_changed"
    ? "提供者的模型配置已变化，请重新分享" : error.message)
  : Object.assign(accountError(502, "shared_model_failed", "分享的模型暂时不可用，请联系提供者"),
    error?.failureCode === "execution_outcome_unknown" ? { failureCode: "execution_outcome_unknown" } : {});

/** Only a model's request/response crosses the provider boundary. Conversation
 * storage, tools, Memory and model defaults remain in the requester's account. */
export class AccountModelSharing {
  constructor({ sharing, acquireRuntime, authorize = async () => {} }) {
    Object.assign(this, { sharing, acquireRuntime, authorize });
  }
  async sources(principal) {
    const space = await this.sharing.ownerSpace(userId(principal));
    const lease = await this.acquireRuntime(space.id);
    try { return (await lease.app.listShareableSources(userId(principal))).filter(s => s.kind === "model"); }
    finally { lease.release(); }
  }
  async source(principal, input) {
    const space = await this.sharing.ownerSpace(userId(principal));
    const lease = await this.acquireRuntime(space.id);
    try { return await lease.app.describeSharedSource(userId(principal), { kind: "model", originResourceId: input.sourceId }); }
    finally { lease.release(); }
  }
  async acquire(principal, id) {
    const share = await this.sharing.requireGrant(userId(principal), id);
    if (share.kind !== "model") throw accountError(403, "share_model_required");
    const lease = await this.acquireRuntime(share.originSpaceId);
    try {
      const source = await lease.app.describeSharedSource(share.providerId, { kind: "model", originResourceId: share.originResourceId });
      if (source.version !== share.sourceVersion) throw accountError(409, "capability_source_changed");
      return { ...lease, share, source };
    } catch (error) { lease.release(); throw publicFailure(error); }
  }
  async models(principal) {
    if (!userId(principal)) return [];
    const result = [];
    for (const share of await this.sharing.list(userId(principal))) {
      if (share.kind !== "model") continue;
      let lease;
      try {
        lease = await this.acquire(principal, share.id);
        result.push({
          id: `share.${share.id}`, providerId: "shared", providerType: "openai",
          model: share.id, label: share.name, credentialConfigured: true, credentialRequired: false,
          capabilities: lease.source.capabilities || {}, limits: lease.source.modelLimits || {},
          metadata: { source: "account-share", readOnly: true, providerName: lease.share.owner.name },
          sharedModel: { id: share.id, provider: lease.share.owner, monthlyCalls: share.monthlyCalls, expiresAt: share.expiresAt }
        });
      } catch { /* Revoked, changed or unavailable sources cannot be selected. */ }
      finally { lease?.release(); }
    }
    return result;
  }
  async resolve(requested, principal) {
    const selected = (await this.models(principal)).find(p => p.id === requested.profileId);
    if (!selected || requested.modelId && selected.model !== requested.modelId
      || requested.providerId && selected.providerId !== requested.providerId) throw accountError(409, "share_model_unavailable", "此分享模型已不可用");
    return { profileId: selected.id, providerId: selected.providerId, modelId: selected.model, label: selected.label };
  }
  async *streamTurn(request) {
    const id = borrowedModelShare(request.model);
    const lease = await this.acquire(request.principal, id);
    const cancellation = new CancellationController();
    const parent = request.signal.onCancel(reason => cancellation.cancel(reason));
    if (request.signal.cancelled) cancellation.cancel(request.signal.reason);
    let guard, guardError, reservation, complete = false, dispatched = false, usage = {};
    const validate = async () => {
      await this.authorize(request);
      const current = await this.sharing.requireGrant(userId(request.principal), id);
      if (current.revision !== lease.share.revision) throw accountError(409, "share_changed");
      const source = await lease.app.describeSharedSource(current.providerId, { kind: "model", originResourceId: current.originResourceId });
      if (source.version !== current.sourceVersion) throw accountError(409, "capability_source_changed");
    };
    const timer = setInterval(() => {
      if (!guard) guard = validate().catch(error => {
        guardError = error; cancellation.cancel("model-share-revoked");
      }).finally(() => { guard = null; });
    }, 500);
    timer.unref();
    try {
      await validate();
      if (request.preview) {
        yield redactedRequest(lease.share, { messages: request.messages, tools: request.tools, ...request.modelOptions });
        return;
      }
      reservation = await this.sharing.reserve(userId(request.principal), id, {
        runId: request.runId, attemptId: request.attemptId, turn: request.turn,
        inputHash: digest({ model: request.model, messages: request.messages, tools: request.tools, options: request.modelOptions })
      });
      // Private destination document IDs are deliberately omitted from provider metadata.
      for await (const event of lease.app.streamSharedModel({ ...lease.share,
        spaceId: request.principal.spaceId || request.principal.space?.id }, {
        ...request, signal: cancellation.signal, destinationId: undefined, authorize: validate
      })) {
        await validate();
        cancellation.signal.throwIfCancelled();
        if (event.type === "model.request") {
          yield redactedRequest(lease.share, event.request?.payload);
          await validate();
          cancellation.signal.throwIfCancelled();
          await this.sharing.dispatch(reservation.id);
          dispatched = true;
        } else {
          if (!dispatched) { await this.sharing.dispatch(reservation.id); dispatched = true; }
          if (event.type === "model.usage") usage = { ...usage, ...event.usage };
          yield event.type === "message.metadata" ? { ...event, metadata: Object.fromEntries(
            Object.entries(event.metadata || {}).filter(([key]) => ["reasoning", "reasoningDetails"].includes(key))) } : event;
        }
      }
      await validate();
      complete = true;
    } catch (error) { throw publicFailure(guardError || error); }
    finally {
      clearInterval(timer); parent.dispose(); await guard; lease.release();
      if (reservation) await this.sharing.finish(reservation.id, { complete, usage });
    }
  }
}
