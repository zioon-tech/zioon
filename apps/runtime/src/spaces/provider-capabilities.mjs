import { createHash } from "node:crypto";
import { posix } from "node:path";
import { accountError } from "../accounts/account-policy.mjs";
import { isExtensionModel, SHARED_MODEL_EXECUTION } from "../marketplace/model-engine.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const FILE_TOOLS = new Set(["read", "write", "edit", "glob", "grep", "tree"]);
const rootPath = (value) => {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\\")
    || value.includes("\0") || value.split("/").includes("..") || posix.normalize(value) === "/") {
    throw accountError(400, "dedicated_root_required", "请选择专用于共享的目录");
  }
  return posix.normalize(value);
};
const pickTools = (requested, available) => {
  const selected = requested || available;
  if (!Array.isArray(selected) || !selected.length || selected.some((name) => !available.includes(name))) {
    throw accountError(400, "invalid_shared_tools");
  }
  return [...new Set(selected)].sort();
};
function sharedDeviceArguments(args, root) {
  const input = { ...args };
  const path = input.path == null ? "/shared" : input.path;
  if (typeof path !== "string" || path.includes("\\") || /[\x00-\x1f]/.test(path)
    || path.split("/").some(part => part === ".." || part === ".")) {
    throw accountError(403, "file_outside_shared_capability");
  }
  let suffix;
  if (path === "/shared" || path.startsWith("/shared/")) suffix = path.slice(7);
  else if (!path.startsWith("/")) suffix = `/${path}`;
  else if (path === root || path.startsWith(`${root}/`)) suffix = path.slice(root.length);
  else throw accountError(403, "file_outside_shared_capability");
  for (const pattern of [input.pattern, input.include]) {
    if (typeof pattern === "string" && (pattern.startsWith("/") || pattern.includes("\\")
      || pattern.split("/").includes(".."))) throw accountError(403, "file_outside_shared_capability");
  }
  input.path = posix.join(root, suffix);
  return input;
}

/** This service is exported only to other server Runtime instances. The
 * HTTP capability DTO contains no source config, credential or device path. */
export function createProviderCapabilities({
  accounts, runtimeSpaceId, listModels, resolveModel, configuredEngine,
  extensionModels, modelCatalog, marketplace, extensionExecution, nodeBroker,
  accessStore, profileId
}) {
  const requireOwner = async (id) => {
    const member = await accounts.membership(id, runtimeSpaceId);
    if (member?.status !== "active" || member.role !== "owner") throw accountError(403, "source_owner_required");
    if ((await accounts.space(runtimeSpaceId))?.kind !== "personal") throw accountError(403, "source_personal_space_required");
  };
  const contextFor = (id) => ({ principal: { userId: id, spaceId: runtimeSpaceId } });
  const describe = async (id, input) => {
    await requireOwner(id);
    const resourceId = String(input.originResourceId || "");
    if (input.kind === "model") {
      const model = (await listModels({ userId: id, spaceId: runtimeSpaceId })).find((m) => m.id === resourceId);
      if (!model || !model.credentialConfigured) throw accountError(404, "source_model_unavailable");
      let version;
      if (isExtensionModel({ profileId: resourceId })) {
        const execution = await marketplace.assertExecution(id, model.extension.listingId, model.extension.epoch);
        version = digest({ model: model.extension, configDigest: execution.configDigest, artifact: execution.artifactDigest });
      } else version = digest(model);
      return { id: resourceId, kind: "model", name: model.label || model.model,
        version, capabilities: model.capabilities || {}, modelLimits: model.limits || {} };
    }
    if (input.kind === "skill") {
      const catalog = await marketplace?.skillsFor(contextFor(id));
      const skill = catalog?.catalog.find((s) => s.id === resourceId && catalog.enabled.includes(s.id));
      if (!skill) throw accountError(404, "source_skill_unavailable");
      return { id: resourceId, kind: "skill", name: skill.name, description: skill.description,
        version: skill.contentHash, allowedTools: ["read"] };
    }
    if (input.kind === "plugin") {
      const current = await marketplace.assertExecution(id, resourceId);
      const install = current.install;
      const allowed = (install.validation && install.validation.epoch === install.executionEpoch ? install.validation.handlers || [] : [])
        .filter((h) => h.kind === "tool").map((h) => h.id);
      if (!allowed.length) throw accountError(409, "plugin_validation_required", "请先验证插件工具");
      const dedicatedRoot = rootPath(input.dedicatedRoot);
      if (dedicatedRoot !== rootPath(install.config.workspaceRoot)) throw accountError(403, "shared_plugin_root_mismatch");
      const selected = pickTools(input.allowedTools, allowed);
      return { id: resourceId, kind: "plugin", name: current.release.name, allowedTools: selected, dedicatedRoot,
        version: digest({ epoch: install.executionEpoch, artifact: current.artifactDigest,
          config: current.configDigest, tools: selected, dedicatedRoot }) };
    }
    if (input.kind === "device") {
      const device = (await accessStore?.listDevices() || []).find((d) =>
        d.deviceId === resourceId && d.kind === "resource" && !d.revokedAt);
      const node = nodeBroker?.snapshot().nodes.find((n) => n.nodeId === resourceId && n.status === "online");
      if (!node || !device) throw accountError(404, "source_device_unavailable");
      const dedicatedRoot = rootPath(input.dedicatedRoot);
      const selected = pickTools(input.allowedTools, node.capabilities.map((c) => c.name).filter((name) => FILE_TOOLS.has(name)));
      return { id: resourceId, kind: "device", name: device.label || resourceId,
        allowedTools: selected, dedicatedRoot,
        version: digest({ deviceId: device.deviceId, createdAt: device.createdAt,
          capabilities: node.capabilities.filter((c) => selected.includes(c.name)), dedicatedRoot }) };
    }
    throw accountError(400, "invalid_capability_kind");
  };
  const delegate = async (binding, allowedTools, fileRoots) => {
    await requireOwner(binding.providerId);
    const policy = { preset: "trusted-automation", allowedTools, fileRoots,
      allowedCommandPrefixes: [], allowedTerminalSessionIds: [], allowedRecipients: [],
      maxToolCalls: 50, maxMailPerRun: 0 };
    const principal = await accounts.issueGrant(binding.providerId, policy, {
      spaceId: runtimeSpaceId, purpose: "task", sourceId: `shared-capability:${binding.spaceId}:${binding.id}`,
      profileId, ttlMs: 60 * 60 * 1000
    });
    return { principal, policy };
  };
  const service = {
    describeSharedSource: describe,
    async listShareableSources(id) {
      await requireOwner(id);
      const result = [];
      for (const m of await listModels({ userId: id, spaceId: runtimeSpaceId })) {
        if (m.credentialConfigured) result.push({ id: m.id, kind: "model", name: m.label || m.model,
          capabilities: m.capabilities || {} });
      }
      const skills = await marketplace?.skillsFor(contextFor(id));
      for (const s of skills?.catalog || []) if (skills.enabled.includes(s.id)) result.push({
        id: s.id, kind: "skill", name: s.name, description: s.description
      });
      for (const entry of (await marketplace?.snapshot(id))?.entries || []) {
        if (entry.installation?.enabled && entry.installation.validation?.handlers?.some((h) => h.kind === "tool")) {
          result.push({ id: entry.id, kind: "plugin", name: entry.name, requiresDedicatedRoot: true,
            tools: entry.installation.validation.handlers.filter((h) => h.kind === "tool").map((h) => h.id) });
        }
      }
      for (const d of await accessStore?.listDevices() || []) if (d.kind === "resource" && !d.revokedAt) {
        const node = nodeBroker?.snapshot().nodes.find((n) => n.nodeId === d.deviceId);
        result.push({ id: d.deviceId, kind: "device", name: d.label || d.deviceId, requiresDedicatedRoot: true,
          tools: (node?.capabilities || []).map((c) => c.name).filter((n) => FILE_TOOLS.has(n)) });
      }
      return result;
    },
    async *streamSharedModel(binding, request) {
      const source = await describe(binding.providerId, { kind: "model", originResourceId: binding.originResourceId });
      if (source.version !== binding.sourceVersion) throw accountError(409, "capability_source_changed");
      const model = await resolveModel({ profileId: binding.originResourceId }, { userId: binding.providerId, spaceId: runtimeSpaceId });
      const { principal, policy } = await delegate(binding, ["write", "Bash"], []);
      try {
        await request.authorize();
        const providerRequest = { ...request, model, principal, policy, sessionId: undefined,
          metadata: { sharedDestination: { spaceId: binding.spaceId, documentId: request.destinationId,
            requesterId: request.principal.userId, bindingId: binding.id } } };
        if (isExtensionModel(model)) {
          const prepared = await extensionModels.prepare(providerRequest, {
            runId: request.runId, attemptId: request.attemptId, signal: request.signal, resumed: false
          });
          providerRequest.metadata = { ...providerRequest.metadata, ...prepared.metadata };
          providerRequest[SHARED_MODEL_EXECUTION] = providerRequest;
        }
        for await (const event of (isExtensionModel(model) ? extensionModels : configuredEngine).streamTurn(providerRequest)) {
          await accounts.validateGrant(principal);
          await request.authorize();
          yield event;
        }
      } finally { await accounts.revokeGrant(binding.providerId, principal.grantId, runtimeSpaceId); }
    },
    async invokeSharedCapability(binding, invocation, signal, authorize) {
      const args = invocation.toolCall.arguments;
      const input = { kind: binding.kind, originResourceId: binding.originResourceId,
        dedicatedRoot: binding.limits.dedicatedRoot, allowedTools: binding.allowedTools };
      const source = await describe(binding.providerId, input);
      if (source.version !== binding.sourceVersion) throw accountError(409, "capability_source_changed");
      if (!binding.allowedTools.includes(args.tool)) throw accountError(403, "tool_outside_shared_capability");
      await authorize();
      if (binding.kind === "skill") {
        const path = String(args.arguments?.path || "SKILL.md");
        const catalog = await marketplace.skillsFor(contextFor(binding.providerId));
        const skill = catalog.catalog.find((s) => s.id === binding.originResourceId);
        const content = path === "SKILL.md" ? skill.body
          : (await marketplace.skillFileFor(contextFor(binding.providerId), skill.id, path, binding.sourceVersion)).content;
        await authorize();
        return { ok: true, content };
      }
      const { principal, policy } = await delegate(binding,
        binding.kind === "plugin" ? ["write", "Bash"] : binding.allowedTools, [binding.limits.dedicatedRoot]);
      try {
        signal.throwIfCancelled();
        const providerInvocation = { ...invocation, principal, policy, sessionId: undefined,
          metadata: { sharedRequesterId: invocation.principal.userId, sharedSpaceId: binding.spaceId } };
        let result;
        if (binding.kind === "device") {
          const arguments_ = sharedDeviceArguments(args.arguments || {}, binding.limits.dedicatedRoot);
          if (arguments_.node_id && arguments_.node_id !== binding.originResourceId) throw accountError(403, "shared_device_target_conflict");
          result = await nodeBroker.invoke({ ...providerInvocation,
            target: { nodeId: binding.originResourceId },
            toolCall: { id: invocation.toolCall.id, name: args.tool, arguments: arguments_ }
          }, signal);
        } else {
          const current = await marketplace.assertExecution(binding.providerId, binding.originResourceId);
          result = await extensionExecution.invoke({
            action: "call", listingId: binding.originResourceId, epoch: current.install.executionEpoch,
            tool: args.tool, arguments: args.arguments || {}
          }, { ...providerInvocation, signal });
          try {
            const payload = JSON.parse(result.content);
            if (Object.hasOwn(payload, "result")) result = { ...result, content: JSON.stringify(payload.result) };
          } catch { /* plain plugin errors remain bounded tool results */ }
        }
        await accounts.validateGrant(principal);
        await authorize();
        return result;
      } finally { await accounts.revokeGrant(binding.providerId, principal.grantId, runtimeSpaceId); }
    }
  };
  return service;
}
