import { createHash, randomBytes } from "node:crypto";
import { AdcClient, buildInvocation } from "@adc/client";
import { projectToolDefinitions } from "@adc/mcp-adapter";
import { ToolArgsSchemas, isBuiltinTool } from "@adc/protocol";
import Ajv from "ajv/dist/2020.js";

export const runtimePluginApiVersion = 2;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const active = new Set(["queued", "running", "approval_required"]);
const success = new Set(["queued", "running", "succeeded", "approval_required"]);
const schemas = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const linksFor = origin => ({ devices: `${origin}/devices`, access: `${origin}/access`, approvals: `${origin}/approvals` });

export function principalKey(principal) {
  const user = principal?.kind === "account" ? principal.user?.id
    : principal?.version === 1 && ["user", "service"].includes(principal.kind) && principal.grantId ? principal.userId : null;
  const space = principal?.kind === "account" ? principal.space?.id : principal?.spaceId;
  if (!user || !space) throw new Error("请先登录 Zioon 账户。");
  return Buffer.from(JSON.stringify([space, user])).toString("base64url");
}

export async function activateRuntimePlugin(context, dependencies = {}) {
  const origin = String(context.config.serviceUrl || "https://adc.zioon.tech");
  const service = new URL(origin);
  if (service.origin !== origin || service.protocol !== "https:" || service.username || service.password) {
    throw new Error("ADC Studio 需要完整 HTTPS origin。");
  }
  const lifecycle = new AbortController(), locks = new Map(), registrations = [];
  const fetcher = (url, init = {}) => {
    if (new URL(url).origin !== origin) throw new Error("ADC origin mismatch");
    return (dependencies.fetcher || fetch)(url, { ...init, redirect: "error",
      signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(45000), ...(init.signal ? [init.signal] : [])]) });
  };
  async function scoped(call, operation) {
    const key = principalKey(call.principal), namespace = context.state.namespace(`studio.user-${key}`);
    const next = (locks.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      lifecycle.signal.throwIfAborted();
      call.signal?.throwIfCancelled?.();
      const abort = new AbortController();
      if (call.signal?.cancelled) abort.abort();
      const sub = call.signal?.onCancel?.(() => abort.abort());
      const signal = AbortSignal.any([abort.signal, lifecycle.signal]);
      const store = { read: async () => await namespace.read("connection") || {},
        put: async state => namespace.put("connection", clone(state)) };
      try { return await operation(store, signal); } finally { sub?.dispose?.(); }
    });
    locks.set(key, next);
    try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
  }
  async function post(path, body, signal) {
    const response = await fetcher(`${origin}${path}`, { method: "POST", signal,
      headers: { "content-type": body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json" },
      body: body instanceof URLSearchParams ? body : JSON.stringify(body) });
    if (!response.ok) {
      const error = new Error(`ADC 授权请求失败（${response.status}）。`);
      error.statusCode = response.status; throw error;
    }
    return response.json();
  }
  function parseToken(value, clientId, oldRefresh) {
    if (typeof value.access_token !== "string" || value.token_type?.toLowerCase() !== "bearer"
      || !Number.isFinite(value.expires_in) || value.expires_in <= 0) throw new Error("ADC 授权响应无效。");
    return { accessToken: value.access_token, refreshToken: value.refresh_token || oldRefresh,
      expiresAt: Date.now() + value.expires_in * 1000, clientId };
  }
  async function clientFor(store, signal) {
    const state = await store.read(), connection = state.connection;
    if (!connection) throw new Error("请先连接 ADC Studio。");
    if (connection.expiresAt <= Date.now() + 30000) {
      if (!connection.refreshToken) throw new Error("ADC 授权已过期，请重新连接。");
      try {
        const value = await post("/api/auth/oauth2/token", new URLSearchParams({
          grant_type: "refresh_token", refresh_token: connection.refreshToken,
          client_id: connection.clientId, resource: `${origin}/mcp` }), signal);
        state.connection = parseToken(value, connection.clientId, connection.refreshToken);
        await store.put(state);
      } catch (error) {
        if ([400, 401, 403].includes(error.statusCode)) { delete state.connection; await store.put(state); }
        throw error;
      }
    }
    return new AdcClient(origin, state.connection.accessToken, (url, init) => fetcher(url, { ...init, signal }));
  }
  async function snapshot(store, signal) {
    const client = await clientFor(store, signal), me = await client.me();
    if (me.kind !== "agent") throw new Error("ADC Studio 需要受限 Agent 授权。");
    const current = { ...me.context, allowedTools: me.context.allowedTools || me.grant.allowedTools };
    const result = await client.invoke(buildInvocation({ context: current, tool: "device.list", args: {}, source: "sdk" }), { waitMs: 4000, signal });
    if (result.status !== "succeeded") throw new Error(result.error?.message || "无法发现 ADC 设备。");
    const tools = projectToolDefinitions({ context: current });
    const devices = (result.output?.nodes || []).map(device => ({ ...device,
      roots: device.roots || device.capability?.roots || [] }));
    return { client, current, public: { connected: true, origin, access: me.grant.name,
      accountId: current.accountId, grantId: current.grantId, devices, tools, links: linksFor(origin),
      refreshedAt: new Date().toISOString() } };
  }
  async function saveTask(store, task) {
    const state = await store.read(), tasks = (state.tasks || []).filter(item => item.invocationId !== task.invocationId);
    await store.put({ ...state, tasks: [task, ...tasks].slice(0, 80) });
    return task;
  }
  function publicTask(result, previous = {}) {
    const task = { ...previous, ...result, updatedAt: new Date().toISOString() };
    if (!result.error) delete task.error;
    if (result.status === "approval_required") task.reviewUrl = linksFor(origin).approvals;
    else delete task.reviewUrl;
    return task;
  }
  async function status(store, signal, poll = false) {
    let state = await store.read();
    const base = { origin, links: linksFor(origin), tasks: state.tasks || [], devices: [], tools: [] };
    if (!state.connection) return { ...base, connected: false };
    try {
      const value = await snapshot(store, signal);
      if (poll) {
        for (const task of state.tasks || []) {
          if (!active.has(task.status)) continue;
          try { await saveTask(store, publicTask(await value.client.invocationStatus(task.invocationId, { waitMs: 0, signal }), task)); }
          catch (error) { await saveTask(store, { ...task, pollingError: error.message }); }
        }
      }
      state = await store.read();
      return { ...value.public, tasks: state.tasks || [], selectedNodeId: state.selectedNodeId,
        expiresAt: state.connection?.expiresAt };
    } catch (error) {
      state = await store.read();
      return { ...base, connected: Boolean(state.connection), unavailable: true, message: error.message };
    }
  }
  const command = (args, call) => scoped(call, async (store, signal) => {
    if (args.action === "status") return status(store, signal, true);
    if (args.action === "connect") {
      const redirect = new URL(String(args.redirectUri));
      const allowed = [...(context.config.redirectOrigins || []), ...(call.origin ? [call.origin] : [])];
      if (!allowed.includes(redirect.origin) || redirect.username || redirect.password || redirect.search || redirect.hash
        || (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["127.0.0.1", "localhost"].includes(redirect.hostname)))) {
        throw new Error("回调必须使用当前已认证 Workbench 的地址。");
      }
      const registration = await post("/api/auth/oauth2/register", {
        client_name: "ADC Studio · Zioon", redirect_uris: [redirect.href],
        ...(redirect.protocol === "http:" ? { application_type: "native" } : {}),
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
        token_endpoint_auth_method: "none", scope: "adc:tools offline_access" }, signal);
      if (typeof registration.client_id !== "string") throw new Error("ADC 客户端注册失败。");
      const verifier = randomBytes(32).toString("base64url");
      const pending = { state: `adcstudio_${randomBytes(32).toString("base64url")}`, verifier,
        redirectUri: redirect.href, clientId: registration.client_id, expiresAt: Date.now() + 600000 };
      await store.put({ ...(await store.read()), pending });
      const url = new URL(`${origin}/api/auth/oauth2/authorize`);
      url.search = new URLSearchParams({ client_id: pending.clientId, redirect_uri: pending.redirectUri,
        response_type: "code", scope: "adc:tools offline_access", resource: `${origin}/mcp`, state: pending.state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
      return { authorizeUrl: url.href };
    }
    if (args.action === "finish") {
      const state = await store.read(), pending = state.pending;
      if (!pending || pending.state !== args.state || pending.expiresAt <= Date.now() || !args.code) throw new Error("授权已过期或属于其他账户。");
      delete state.pending; await store.put(state);
      const value = await post("/api/auth/oauth2/token", new URLSearchParams({ grant_type: "authorization_code",
        code: args.code, client_id: pending.clientId, redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier, resource: `${origin}/mcp` }), signal);
      await store.put({ ...state, connection: parseToken(value, pending.clientId) });
      return { connected: true };
    }
    if (args.action === "disconnect") {
      const state = await store.read(), c = state.connection;
      if (c) await post("/api/auth/oauth2/revoke", new URLSearchParams({
        token: c.refreshToken || c.accessToken, client_id: c.clientId }), signal).catch(() => {});
      await store.put({}); return { connected: false };
    }
    if (args.action === "select") {
      const found = await snapshot(store, signal);
      if (!found.public.devices.some(device => device.nodeId === args.nodeId)) throw new Error("设备不在当前授权中。");
      await store.put({ ...(await store.read()), selectedNodeId: args.nodeId });
      return { selectedNodeId: args.nodeId };
    }
    throw new Error("该操作必须通过 Runtime 工具与 Run 执行。");
  });
  registrations.push(context.runs.registerCommands(command, { requiresSession: false }));
  async function execute(args, call, readOnly) {
    return scoped(call, async (store, signal) => {
      const found = await snapshot(store, signal), tool = found.public.tools.find(item => item.name === args.tool);
      if (!tool) throw new Error("工具已不在当前授权中，请刷新。");
      const effect = tool.annotations?.readOnlyHint === true ? "read" : "external";
      if (readOnly && effect !== "read") throw new Error("只读工具不能执行此操作。");
      if (!found.public.devices.some(device => device.nodeId === args.nodeId)) throw new Error("请选择当前已授权的设备。");
      const targets = tool.inputSchema?.properties?.target?.properties?.nodeId?.enum;
      if (targets && !targets.includes(args.nodeId)) throw new Error("所选设备未提供此工具。");
      const validate = schemas.compile(tool.inputSchema.properties.args);
      if (!validate(args.args)) throw new Error(`参数不符合实时 schema：${schemas.errorsText(validate.errors)}`);
      if (isBuiltinTool(args.tool)) {
        const parsed = ToolArgsSchemas[args.tool].safeParse(args.args);
        if (!parsed.success) throw new Error(`参数不符合 ADC 协议：${parsed.error.message}`);
        args = { ...args, args: parsed.data };
      }
      if (effect !== "read" && (args.confirmed !== true || !args.idempotencyKey)) throw new Error("执行此工具需要确认和 idempotencyKey。");
      const requestHash = hash([args.nodeId, args.tool, args.args]);
      const previous = (await store.read()).tasks?.find(item => args.idempotencyKey && item.idempotencyKey === args.idempotencyKey);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new Error("此 idempotencyKey 已用于不同请求。");
        return saveTask(store, publicTask(await found.client.invocationStatus(previous.invocationId, { waitMs: 4000, signal }), previous));
      }
      const invocation = buildInvocation({ context: found.current, tool: args.tool, args: args.args,
        target: { nodeId: args.nodeId }, source: "sdk", idempotencyKey: args.idempotencyKey,
        executionTimeoutMs: args.executionTimeoutMs || 300000 });
      const intent = { invocationId: invocation.invocationId, attemptId: invocation.attemptId,
        nodeId: args.nodeId, tool: args.tool, arguments: args.args, requestHash,
        ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
        runId: call.runId, createdAt: new Date().toISOString(), status: "unknown_outcome",
        error: { code: "execution_outcome_unknown", message: "请求已记录，尚未确认 ADC 执行结果。" } };
      await saveTask(store, intent);
      try { return saveTask(store, publicTask(await found.client.invoke(invocation, { waitMs: 4000, signal }), { ...intent, error: undefined })); }
      catch (error) {
        return saveTask(store, { ...intent, error: { code: "execution_outcome_unknown",
          message: `${error.message} 请查询原 invocation，确认结果后再操作。` } });
      }
    });
  }
  const objectSchema = properties => ({ type: "object", properties, additionalProperties: false });
  const executionSchema = { ...objectSchema({
    tool: { type: "string", minLength: 1 }, nodeId: { type: "string", minLength: 1 },
    args: { type: "object", additionalProperties: true },
    confirmed: { type: "boolean" }, idempotencyKey: { type: "string", minLength: 8, maxLength: 256 },
    executionTimeoutMs: { type: "integer", minimum: 100, maximum: 1800000 }
  }), required: ["tool", "nodeId", "args"] };
  const taskSchema = objectSchema({ invocationId: { type: "string" }, jobId: { type: "string" }, waitMs: { type: "integer", minimum: 0, maximum: 10000 } });
  const definitions = [
    ["status", {}, (args, call) => command({ action: "status" }, call)],
    ["discover", {}, (args, call) => command({ action: "status" }, call)],
    ["read", executionSchema, (args, call) => execute(args, call, true)],
    ["invoke", executionSchema, (args, call) => execute(args, call, false)],
    ["task", taskSchema, (args, call) => scoped(call, async (store, signal) => {
      const client = await clientFor(store, signal), tasks = (await store.read()).tasks || [];
      const previous = tasks.find(t => args.invocationId ? t.invocationId === args.invocationId : t.jobId === args.jobId);
      if (!previous) throw new Error("只能查询此连接记录的任务。");
      const result = await client.invocationStatus(previous.invocationId, { waitMs: args.waitMs || 0, signal });
      return saveTask(store, publicTask(result, previous));
    })],
    ["cancel", { ...taskSchema, required: ["jobId"] }, (args, call) => scoped(call, async (store, signal) => {
      const previous = (await store.read()).tasks?.find(t => t.jobId === args.jobId);
      if (!previous) throw new Error("只能取消此连接记录的任务。");
      if (!active.has(previous.status)) throw new Error("任务已结束。");
      const client = await clientFor(store, signal);
      return saveTask(store, publicTask(await client.cancelTask(previous.jobId), previous));
    })]
  ];
  for (const [suffix, schema, handler] of definitions) {
    const effect = ["invoke", "cancel"].includes(suffix) ? "external" : "read";
    registrations.push(context.tools.registerTool({
      name: `adc_studio_${suffix}`, description: `ADC Studio ${suffix}; uses the current account's independent ADC authorization.`,
      inputSchema: schema.type ? schema : objectSchema({}),
      policy: { minimumPreset: effect === "read" ? "read-only" : "trusted-automation" },
      execution: { effect, timeoutMs: 45000, maxTimeoutMs: 45000, cancellation: "cooperative",
        idempotency: effect === "read" ? "safe" : "reconcile" },
      async invoke(args, call) {
        const result = await handler(args, call);
        const ok = !result.status || success.has(result.status);
        return { ok, content: JSON.stringify(result), ...(!ok ? { failureCode:
          result.status === "unknown_outcome" ? "execution_outcome_unknown" : result.error?.code || result.status,
          retryable: false } : {}) };
      }
    }));
  }
  return { dispose() { lifecycle.abort(); registrations.forEach(registration => registration?.dispose?.()); } };
}
