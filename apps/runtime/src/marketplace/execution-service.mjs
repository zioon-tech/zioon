import { posix } from "node:path";
import { isObject } from "../../../../packages/runtime-client/src/extension-package.mjs";
import { CancellationController } from "../../../../packages/runtime/dist/index.js";
import { ExtensionHostBridge } from "./host-bridge.mjs";
import { InstallationWorkspaceService, isWorkspaceAction } from "./installation-workspace.mjs";

const fail = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 422 }); };
export const EXTENSIONS_CALL_TOOL = {
  name: "extensionsCall",
  description: "List, prepare, discover or call installed account code plugins and MCP on their configured authorized Nodes. Use list for extension IDs and schemas, then probe before call if validation is required.",
  inputSchema: { type: "object", properties: {
    action: { type: "string", enum: ["list", "prepare", "probe", "call", "command",
      "workspace-prepare", "workspace-read", "workspace-write", "workspace-reload", "workspace-restore"] },
    listingId: { type: "string" }, epoch: { type: "string" }, tool: { type: "string" },
    arguments: { type: "object", additionalProperties: true }
  }, required: ["action"], additionalProperties: false },
  execution: { effect: "process", timeoutMs: 600000, maxTimeoutMs: 600000 },
  policy: { minimumPreset: "trusted-automation" }
};

export function withExtensionTools(plugins, service) {
  if (!service) return plugins;
  return {
    hasTool: (name) => name === EXTENSIONS_CALL_TOOL.name || plugins.hasTool(name),
    get supportedToolNames() { return [...plugins.supportedToolNames, EXTENSIONS_CALL_TOOL.name]; },
    getToolDefinitions: () => [...plugins.getToolDefinitions(), EXTENSIONS_CALL_TOOL],
    async authorizeInvocation(invocation) {
      const args = invocation.toolCall?.arguments || {};
      if (invocation.toolCall?.name === EXTENSIONS_CALL_TOOL.name && args.action !== "list") {
        const fixed = await service.fixedOperation(args, invocation);
        await service.marketplace[isWorkspaceAction(args.action) ? "installationFor" : "assertExecution"](
          String(invocation.principal?.userId || invocation.principal?.user?.id || ""), fixed.listingId, fixed.epoch);
      }
    },
    async listTools(request) {
      const tools = await plugins.listTools(request);
      return request.policy?.preset === "trusted-automation" && request.policy.allowedTools?.includes(EXTENSIONS_CALL_TOOL.name)
        ? [...tools, { ...EXTENSIONS_CALL_TOOL, description: EXTENSIONS_CALL_TOOL.description
          + (request.metadata?.extensionToolCatalog ? "\nInstalled extensions fixed for this Run: "
            + JSON.stringify(request.metadata.extensionToolCatalog) : "") }] : tools;
    },
    invoke: (invocation, signal) => invocation.toolCall.name === EXTENSIONS_CALL_TOOL.name
      ? service.invoke(invocation.toolCall.arguments, { ...invocation, signal })
      : plugins.invoke(invocation, signal)
  };
}

export class ExtensionExecutionService {
  constructor({ marketplace, tools, allowNode, hostBridge, runs, resolveConfig = (config) => config }) {
    this.marketplace = marketplace;
    this.tools = tools;
    this.allowNode = allowNode;
    this.bridge = hostBridge || new ExtensionHostBridge({ tools });
    this.resolveConfig = resolveConfig;
    this.runs = runs;
    this.workspace = new InstallationWorkspaceService(this);
  }

  async runForContext(context) {
    const run = this.runs && context.runId ? await this.runs.get(context.runId) : null;
    if (run && String(run.principal?.userId || run.principal?.user?.id || "")
      !== String(context.principal?.userId || context.principal?.user?.id || "")) {
      fail("extension_run_account_denied", "扩展调用不属于当前账户");
    }
    return run;
  }

  async fixedOperation(args, context) {
    const run = await this.runForContext(context);
    const catalog = run?.metadata?.extensionToolCatalog;
    if (isWorkspaceAction(args.action)) {
      const operation = run?.metadata?.extensionInvocation;
      if (run && (!operation || !isWorkspaceAction(operation.action)
        || operation.listingId !== args.listingId || operation.epoch !== args.epoch)) fail("extension_tool_catalog_changed", "文件管理操作必须使用当前安装身份");
      return args;
    }
    if (!catalog) return args;
    const entry = catalog.find((entry) => entry.listingId === args.listingId);
    if (!entry || (args.epoch && args.epoch !== entry.epoch)) fail("extension_tool_catalog_changed", "此扩展不在当前 Run 固定的目录中");
    return { ...args, epoch: entry.epoch };
  }

  async executionFor(context, listingId, epoch) {
    const userId = String(context.principal?.userId || context.principal?.user?.id || "");
    const execution = await this.marketplace.executionFor(userId, listingId, epoch);
    return { ...execution, install: { ...execution.install,
      config: await this.resolveConfig(execution.install.config, context.principal) }, userId };
  }

  async invoke(args, context) {
    const userId = String(context.principal?.userId || context.principal?.user?.id || "");
    if (args.action === "list") {
      const run = await this.runForContext(context);
      if (run?.metadata?.extensionToolCatalog) {
        return { ok: true, content: JSON.stringify(run.metadata.extensionToolCatalog) };
      }
      const snapshot = await this.marketplace.snapshot(userId);
      return { ok: true, content: JSON.stringify(snapshot.entries.filter((e) =>
        e.installation && ["plugin", "mcp"].includes(e.kind)).map((e) => ({
        listingId: e.id, name: e.name, kind: e.kind, installation: e.installation
      }))) };
    }
    args = await this.fixedOperation(args, context);
    if (isWorkspaceAction(args.action)) return this.workspace.invoke(args, context);
    const { install, artifact, configDigest } = await this.executionFor(context, args.listingId, args.epoch);
    const cancellation = new CancellationController();
    const parent = context.signal.onCancel((reason) => cancellation.cancel(reason));
    let guard;
    const timer = setInterval(() => {
      if (!guard) guard = this.marketplace.assertExecution(userId, args.listingId, install.executionEpoch)
        .catch(() => cancellation.cancel("extension-changed"))
        .finally(() => { guard = null; });
    }, 500);
    timer.unref();
    try {
      const result = await this.invokeOperation(args, { ...context, signal: cancellation.signal }, { userId, install, artifact, configDigest });
      if (!result.ok && args.action === "probe") await this.marketplace.clearValidation(userId, args.listingId, install.executionEpoch);
      return result;
    } catch (error) {
      if (args.action === "probe") await this.marketplace.clearValidation(userId, args.listingId, install.executionEpoch);
      throw error;
    } finally {
      clearInterval(timer);
      parent.dispose();
      await guard;
    }
  }

  async invokeOperation(args, context, { userId, install, artifact, configDigest }) {
    if (!context.invocationId || !context.runId || !["prepare", "probe", "call", "command"].includes(args.action)) fail("invalid_extension_invocation", "扩展执行必须属于普通 Run");
    await this.authorizeHost(context, install);
    const { nodeId, workspaceRoot } = install.config;
    const binding = this.bridge.binding(install, artifact, userId);
    if (args.action === "prepare") {
      if (artifact.kind !== "mcp") return { ok: true, content: JSON.stringify({ prepared: true, dependency: "none", nodeId }) };
      await this.bridge.ensure(binding, artifact, context);
      return { ok: true, content: JSON.stringify({ prepared: true, nodeId, dependency: "@modelcontextprotocol/sdk@1.27.1" }) };
    }
    const description = await this.bridge.ensure(binding, artifact, context, { refresh: args.action === "probe" });
    const tools = description.handlers.filter((h) => h.kind === "tool").map((h) => ({
      name: h.id, description: h.description, inputSchema: h.inputSchema, execution: h.execution
    }));
    await this.marketplace.recordValidation(userId, args.listingId, install.executionEpoch, tools, description);
    if (args.action === "probe") return { ok: true, content: JSON.stringify({
      listingId: args.listingId, nodeId, version: install.version, tools, contributions: description.handlers
    }) };
    const handler = description.handlers.find((h) => h.kind === (args.action === "command" ? "command" : "tool")
      && h.id === (args.tool || (args.action === "command" ? "commands" : "")));
    if (!handler) fail("extension_tool_not_found", "工具不在已验证的扩展目录中");
    if (!isObject(args.arguments || {}) || Buffer.byteLength(JSON.stringify(args.arguments || {})) > 100000) fail("invalid_extension_arguments", "工具参数必须为不超过 100KB 的 JSON 对象");
    let result;
    try {
      result = await this.bridge.invoke(binding, description, handler, args.arguments || {}, {
        ...context, authorize: () => this.marketplace.assertExecution(userId, args.listingId, install.executionEpoch),
        publishEvents: (events) => this.publishEvents?.({
          listingId: args.listingId, epoch: install.executionEpoch, digest: artifact.digest,
          configDigest
        }, description, events, context)
      });
    } catch (error) {
      return { ok: false, content: String(error.code || "extension_host_error"),
        failureCode: error.failureCode || "extension_tool_error", retryable: false };
    }
    await this.marketplace.assertExecution(userId, args.listingId, install.executionEpoch);
    const ok = result?.ok !== false && result?.isError !== true;
    return { ok, content: JSON.stringify({ listingId: args.listingId, nodeId, version: install.version, result }),
      ...(!ok ? { failureCode: "extension_tool_error", retryable: false } : {}) };
  }
  async authorizeHost(context, install) {
    const { nodeId, workspaceRoot } = install.config;
    if (!await this.allowNode(nodeId, context.principal)) fail("extension_node_denied", "请选择账户沙箱或已授权的实体 Node，平台服务器不能执行扩展");
    if (context.policy?.preset !== "trusted-automation" || !["write", "Bash"].every((name) => context.policy.allowedTools?.includes(name))) fail("extension_policy_denied", "扩展执行需要当前 Run 授权 write、Bash 和 trusted-automation");
    for (const path of [workspaceRoot, install.config.credentialsFile].filter(Boolean)) {
      if (context.policy.fileRoots?.length && !context.policy.fileRoots.some((root) => {
        const relative = posix.relative(root, path);
        return !relative || (!posix.isAbsolute(relative) && relative !== ".." && !relative.startsWith("../"));
      })) fail("extension_path_denied", "扩展目录或凭据文件超出当前 Run 授权");
    }
  }
  async commandOperation(pluginId, args, principal) {
    const snapshot = await this.marketplace.snapshot(String(principal?.userId || principal?.user?.id || ""));
    const entries = snapshot.entries.filter((entry) => entry.installation?.enabled
      && entry.installedRelease?.artifact?.plugin?.id === pluginId);
    if (entries.length !== 1) fail("extension_command_unavailable", "当前账户的插件命令不存在或标识冲突");
    const installation = entries[0].installation;
    const contentDigest = installation.activeRevision?.digest || installation.digest;
    if (args.installationDigest !== contentDigest || args.installationEpoch !== installation.executionEpoch) {
      fail("extension_ui_changed", "插件内容已重新加载，请等待界面刷新后重试");
    }
    const { installationDigest, installationEpoch, ...arguments_ } = args;
    return { action: "command", listingId: entries[0].id,
      epoch: installation.executionEpoch, arguments: arguments_ };
  }
}
