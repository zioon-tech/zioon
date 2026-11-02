import { validateToolInputSchema } from "./manifest.mjs";
import { normalizeToolExecution } from "./tool-execution.mjs";
import { normalizePluginModels } from "./model-catalog.mjs";

export const EXTENSION_HOST_TOOL = "zion.internal.extensionHost";
export const HOST_PROTOCOL_VERSION = 1;
export const HOST_HOOKS = Object.freeze([
  "beforeStart", "beforeTurn", "beforeModel", "beforeStop", "beforeTool", "afterTool", "afterRun"
]);
export const EXTENSION_HOST_CAPABILITY = Object.freeze({
  name: EXTENSION_HOST_TOOL, version: "1", risk: "execute", hostKind: "extension-host",
  description: "Account-bound isolated extension handlers. Platform use only.",
  inputSchema: { type: "object", additionalProperties: true },
  execution: { effect: "process", timeoutMs: 30000, maxTimeoutMs: 30000,
    cancellation: "cooperative", idempotency: "reconcile" }
});
const error = (code) => { throw Object.assign(new Error(code), { code, statusCode: 422 }); };
const id = (v) => {
  if (typeof v !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(v)) error("invalid_host_id");
  return v;
};
export function normalizeHostBinding(value) {
  if (!value || !/^[a-f0-9]{64}$/.test(value.digest || "")) error("invalid_host_binding");
  return { accountId: id(value.accountId), listingId: id(value.listingId),
    epoch: id(value.epoch), digest: value.digest, config: value.config,
    ...(value.resourceEpoch ? { resourceEpoch: id(value.resourceEpoch) } : {}) };
}
export function normalizeHostDescription(value) {
  if (value?.protocolVersion !== HOST_PROTOCOL_VERSION || !Array.isArray(value.handlers)
    || value.handlers.length > 100) error("invalid_host_description");
  const seen = new Set();
  const handlers = value.handlers.map((h) => {
    id(h.handle); id(h.id);
    if (seen.has(h.handle) || !["tool", "context", "controller", "post-processor", "model", "job", "command"].includes(h.kind)) error("invalid_host_handler");
    seen.add(h.handle);
    const result = { handle: h.handle, kind: h.kind, id: h.id,
      description: String(h.description || "").slice(0, 4000),
      order: Number.isFinite(h.order) ? h.order : 100, required: h.required !== false };
    if (h.kind === "tool" || h.kind === "job" || h.kind === "command") {
      if (validateToolInputSchema(h.inputSchema).length) error("invalid_host_schema");
      result.inputSchema = h.inputSchema;
      result.execution = normalizeToolExecution(h.execution);
    }
    if (h.kind === "context") {
      if (!["pre", "post"].includes(h.stage)) error("invalid_host_stage");
      result.stage = h.stage;
      result.mode = h.mode === "contribute" ? "contribute" : "prepare";
    }
    if (h.kind === "controller") {
      if (!Array.isArray(h.hooks) || !h.hooks.length || h.hooks.some((hook) => !HOST_HOOKS.includes(hook))) error("invalid_host_hooks");
      result.hooks = [...new Set(h.hooks)];
    }
    if (h.kind === "model") {
      result.models = normalizePluginModels(h.models);
    }
    if (h.kind === "job") {
      if (h.triggers !== undefined && (!Array.isArray(h.triggers) || h.triggers.length > 20
        || h.triggers.some((t) => typeof t !== "string" || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(t)))) error("invalid_job_triggers");
      result.triggers = [...new Set(h.triggers || [])];
    }
    return result;
  });
  if (Buffer.byteLength(JSON.stringify(handlers)) > 100000) error("host_catalog_budget");
  return { protocolVersion: HOST_PROTOCOL_VERSION, hostEpoch: id(value.hostEpoch), handlers };
}
