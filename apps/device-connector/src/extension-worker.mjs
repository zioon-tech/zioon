// This file runs only inside an execution-side child process.
import { createInterface } from "node:readline";
import { readFile, mkdir, open, rename, lstat, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { validateToolInput } from "../../../packages/plugin-sdk/src/manifest.mjs";
import { HOST_HOOKS, normalizeHostDescription } from "../../../packages/plugin-sdk/src/host-contract.mjs";
import { signFrame } from "./extension-security.mjs";

const sendLine = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
process.stderr.write = () => true;
let ipcKey, frameSequence = 0;
const send = (v) => sendLine(`${signFrame(ipcKey, frameSequence++, v)}\n`);
const handlers = new Map(), operations = new Map(), credits = new Map();
let currentOperation;
let binding, dataRoot, description, disposer, mcp, credentials = {};
const schema = { type: "object", additionalProperties: true };
const inside = (root, p) => { const part = relative(root, p); return !part || (!isAbsolute(part) && part !== ".." && !part.startsWith("../")); };
const secretValues = () => [...new Set(
  [...Object.values(credentials.env || {}), ...Object.values(credentials.headers || {})]
    .filter((v) => typeof v === "string" && v).flatMap((v) => {
      const raw = /^Bearer /i.test(v) ? [v, v.slice(7)] : [v];
      return raw.flatMap((s) => [s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1)]);
    })
)].sort((a, b) => b.length - a.length);
const redacted = (value) => {
  let text = JSON.stringify(value);
  for (const secret of secretValues()) {
    text = text.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]");
    if (/^Bearer /i.test(secret)) text = text.split(secret.slice(7)).join("[redacted]");
  }
  if (Buffer.byteLength(text) > 100000) throw new Error("output_budget");
  return JSON.parse(text);
};
async function* modelBytes(iterable) {
  const secrets = secretValues(), decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "", total = 0;
  const consume = (final) => {
    let boundary = pending.length;
    if (!final) for (const secret of secrets) {
      for (let n = Math.min(secret.length - 1, pending.length); n > 0; n--) {
        if (pending.endsWith(secret.slice(0, n))) { boundary = Math.min(boundary, pending.length - n); break; }
      }
    }
    // Never expose part of a complete match that overlaps a retained suffix.
    for (const secret of secrets) {
      let at = pending.indexOf(secret);
      while (at >= 0 && at < boundary) {
        if (at + secret.length > boundary) boundary = at;
        at = pending.indexOf(secret, at + secret.length);
      }
    }
    let safe = pending.slice(0, boundary);
    pending = pending.slice(boundary);
    for (const secret of secrets) safe = safe.split(secret).join("[redacted]");
    return Buffer.from(safe);
  };
  for await (const raw of iterable) {
    const bytes = Buffer.from(raw);
    if ((total += bytes.length) > 16 * 1024 * 1024) throw new Error("model_budget");
    pending += decoder.decode(bytes, { stream: true });
    const safe = consume(false);
    if (safe.length) yield safe;
  }
  pending += decoder.decode();
  const safe = consume(true);
  if (safe.length) yield safe;
}
function register(kind, item) {
  if (!item || handlers.size >= 100) throw new Error("handler_limit");
  const id = String(item.id || item.name || "");
  const handle = `h:${createHash("sha256").update(JSON.stringify([kind, id])).digest("hex").slice(0, 32)}`;
  if ([...handlers.values()].some((h) => h.kind === kind && h.id === id)) throw new Error("duplicate_handler");
  const descriptor = { handle, kind, id, description: item.description, order: item.order, required: item.required };
  if (["tool", "job", "command"].includes(kind)) {
    if (typeof (item.invoke || item.process) !== "function") throw new Error("handler_function");
    Object.assign(descriptor, { inputSchema: item.inputSchema || schema, execution: item.execution });
  }
  if (kind === "context") {
    if (typeof (item.prepare || item.contribute) !== "function") throw new Error("context_function");
    descriptor.stage = item.stage || "pre";
    descriptor.mode = item.contribute ? "contribute" : "prepare";
  }
  if (kind === "controller") descriptor.hooks = HOST_HOOKS.filter((k) => typeof item[k] === "function");
  if (kind === "post-processor" && typeof item.process !== "function") throw new Error("processor_function");
  if (kind === "model") {
    if (typeof item.request !== "function") throw new Error("model_function");
    descriptor.models = item.models;
  }
  if (kind === "job") descriptor.triggers = item.triggers;
  // Validate before activation succeeds; closures stay in this map.
  normalizeHostDescription({ protocolVersion: 1, hostEpoch: "validate", handlers: [descriptor] });
  handlers.set(handle, { ...item, kind, id, descriptor });
  return { dispose: () => handlers.delete(handle) };
}
async function dataPath(name, { existing = false } = {}) {
  if (typeof name !== "string" || !name || name.includes("\\") || isAbsolute(name)
    || name.split("/").some((p) => !p || p === "." || p === "..")) throw new Error("data_path");
  const path = resolve(dataRoot, name);
  if (!inside(dataRoot, path)) throw new Error("data_path");
  let current = dataRoot;
  for (const part of name.split("/").slice(0, -1)) {
    current = join(current, part);
    await mkdir(current).catch((e) => { if (e.code !== "EEXIST") throw e; });
    if ((await lstat(current)).isSymbolicLink() || !inside(dataRoot, await realpath(current))) throw new Error("data_symlink");
  }
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error("data_symlink"); }
  catch (e) { if (e.code !== "ENOENT" || existing) throw e; }
  return path;
}
const data = Object.freeze({
  async read(name) { return readFile(await dataPath(name, { existing: true }), "utf8"); },
  async write(name, content) {
    if (typeof content !== "string" || Buffer.byteLength(content) > 1000000) throw new Error("data_budget");
    const p = await dataPath(name), temp = `${p}.${randomUUID()}.tmp`;
    const f = await open(temp, "wx", 0o600);
    try { await f.writeFile(content); await f.sync(); } finally { await f.close(); }
    await rename(temp, p);
  }
});
async function activate(message) {
  ipcKey = message.ipcKey;
  delete message.ipcKey;
  binding = message.binding;
  dataRoot = message.dataRoot;
  credentials = message.credentials || {};
  if (message.artifact.kind === "mcp") {
    const require = createRequire(message.sdkPath || import.meta.url);
    const sdk = async (p) => import(pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/client/${p}.js`)).href);
    const { Client } = await sdk("index");
    mcp = new Client({ name: "zioon-extension-host", version: "1.0.0" });
    const spec = message.artifact.mcp;
    let transport;
    if (spec.transport === "stdio") {
      const { StdioClientTransport } = await sdk("stdio");
      const env = { PATH: process.env.PATH, HOME: message.root, TMPDIR: "/tmp" };
      for (const k of spec.envKeys) {
        if (typeof credentials.env?.[k] !== "string") throw new Error("credentials_missing");
        env[k] = credentials.env[k];
      }
      // A bundled Node stdio service gets its own filesystem/process policy.
      // Other executables require an account-isolated execution resource.
      const args = message.stdioNodeArgs ? [...message.stdioNodeArgs, ...spec.args] : spec.args;
      transport = new StdioClientTransport({ command: message.stdioNodeArgs ? process.execPath : spec.command,
        args, env, cwd: message.root, stderr: "ignore" });
    } else {
      const { StreamableHTTPClientTransport } = await sdk("streamableHttp");
      if (binding.config.credentialsFile && credentials.endpoint !== spec.endpoint) throw new Error("credentials_origin");
      const headers = {};
      for (const [k, v] of Object.entries(credentials.headers || {})) {
        if (!["authorization", "x-api-key"].includes(k.toLowerCase()) || typeof v !== "string" || /[\r\n]/.test(v)) throw new Error("credential_header");
        headers[k] = v;
      }
      transport = new StreamableHTTPClientTransport(new URL(spec.endpoint), { requestInit: { headers, redirect: "error" },
        fetch: (url, options) => {
          if (new URL(String(url)).href !== spec.endpoint) throw new Error("origin");
          return fetch(url, { ...options, redirect: "error" });
        } });
    }
    await mcp.connect(transport);
    let cursor, pages = 0;
    do {
      const page = await mcp.listTools(cursor ? { cursor } : {});
      for (const t of page.tools) register("tool", { ...t, invoke: (args, ctx) =>
        mcp.callTool({ name: t.name, arguments: args }, undefined, { signal: ctx.abortSignal }) });
      if (++pages > 16 || (cursor && page.nextCursor === cursor)) throw new Error("catalog_limit");
      cursor = page.nextCursor;
    } while (cursor);
    disposer = () => mcp.close();
  } else {
    const plugin = message.artifact.plugin;
    const mod = await import(pathToFileURL(resolve(message.root, plugin.entries.runtime)).href);
    if (typeof mod.activateRuntimePlugin !== "function" || (mod.runtimePluginApiVersion !== undefined && mod.runtimePluginApiVersion !== 2)) throw new Error("plugin_api");
    const state = Object.freeze({ namespace(name = "default") {
      if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(name)) throw new Error("state_namespace");
      const path = (key) => {
        if (!/^[a-zA-Z0-9_.:-]{1,200}$/.test(key)) throw new Error("state_key");
        return `.state/${name}/${encodeURIComponent(key)}.json`;
      };
      return Object.freeze({
        async read(key) { try { return JSON.parse(await data.read(path(key))); } catch (e) { if (e.code === "ENOENT") return undefined; throw e; } },
        put: (key, value) => data.write(path(key), JSON.stringify(value))
      });
    } });
    const ctx = Object.freeze({
      apiVersion: 2, plugin: Object.freeze(plugin), config: Object.freeze(binding.config.settings || {}),
      credentials: Object.freeze(credentials), data, state, log() {},
      locations: Object.freeze({ data: Object.freeze({ root: dataRoot }) }),
      tools: Object.freeze({ registerTool: (t) => register("tool", t) }),
      context: Object.freeze({ registerProvider: (t) => register("context", t) }),
      models: Object.freeze({ registerProvider: (t) => register("model", t) }),
      jobs: Object.freeze({
        registerHandler: (t) => register("job", t),
        enqueue(id, payload) {
          if (!currentOperation || currentOperation.kind === "model" || currentOperation.events.length >= 32
            || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(id)) throw new Error("job_scope");
          currentOperation.events.push({ type: "job.enqueue", jobId: id, payload: redacted(payload ?? {}) });
        }
      }),
      events: Object.freeze({
        on(type, handler) {
          if (typeof handler !== "function") throw new Error("event_handler");
          return register("job", { id: `event:${type}`, triggers: [type],
            process: (input, context) => handler(input.payload, context) });
        },
        emit(type, payload) {
          if (!currentOperation || currentOperation.kind === "model" || currentOperation.events.length >= 32
            || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(type)) throw new Error("event_scope");
          currentOperation.events.push({ type, payload: redacted(payload ?? null) });
        }
      }),
      runs: Object.freeze({
        registerController: (t) => register("controller", t),
        registerPostProcessor: (t) => register("post-processor", t),
        registerCommands: (fn, options = {}) => register("command", { id: "commands", invoke: fn, ...options })
      })
    });
    const c = await mod.activateRuntimePlugin(ctx) || {};
    for (const [field, kind] of Object.entries({ tools: "tool", contextProviders: "context", controllers: "controller",
      runPostProcessors: "post-processor", modelProviders: "model", jobs: "job" })) {
      if (c[field] !== undefined && !Array.isArray(c[field])) throw new Error("contributions");
      for (const item of c[field] || []) register(kind, item);
    }
    if (c.dispose !== undefined && typeof c.dispose !== "function") throw new Error("dispose");
    disposer = c.dispose;
  }
  description = normalizeHostDescription({ protocolVersion: 1, hostEpoch: message.hostEpoch,
    handlers: [...handlers.values()].map((h) => h.descriptor) });
  send({ id: message.id, result: description });
}
async function execute(message) {
  const h = handlers.get(message.handle);
  if (!h) throw new Error("handler_missing");
  const controller = new AbortController(), listeners = new Set();
  operations.set(message.id, controller);
  const signal = Object.freeze({
    get cancelled() { return controller.signal.aborted; },
    get reason() { return controller.signal.reason; },
    throwIfCancelled() { controller.signal.throwIfAborted(); },
    onCancel(fn) {
      if (controller.signal.aborted) fn(controller.signal.reason);
      else listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    }
  });
  controller.signal.addEventListener("abort", () => {
    for (const fn of listeners) { try { fn(controller.signal.reason); } catch {} }
    credits.get(message.id)?.();
  });
  const ctx = Object.freeze({ ...message.context, signal, abortSignal: controller.signal,
    workspaceRoot: binding.config.workspaceRoot, data, idempotencyKey: message.context?.invocationId,
    env: Object.freeze(credentials.env || {}), settings: Object.freeze(binding.config.settings || {}),
    recordUsage(patch) {
      if (!currentOperation) throw new Error("usage_scope");
      for (const [key, value] of Object.entries(patch || {})) {
        if (!["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"].includes(key)
          || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid_usage");
        currentOperation.usage[key] = (currentOperation.usage[key] || 0) + value;
      }
    }
  });
  const operation = { id: message.id, kind: h.kind, events: [], usage: {} };
  currentOperation = operation;
  let started = false;
  try {
    let fn;
    if (["tool", "job", "command"].includes(h.kind)) {
      if (validateToolInput(message.input || {}, h.descriptor.inputSchema).length) throw new Error("arguments");
      fn = h.invoke || h.process;
    } else if (h.kind === "context") fn = h.contribute || h.prepare;
    else if (h.kind === "controller") {
      if (!h.descriptor.hooks.includes(message.method)) throw new Error("hook");
      fn = h[message.method];
    } else if (h.kind === "model") fn = h.request;
    else fn = h.process;
    started = true;
    const input = message.input ?? {};
    const result = h.kind === "controller"
      ? message.method === "beforeTool" ? await fn.call(h, input.invocation, ctx)
        : message.method === "afterTool" ? await fn.call(h, input.invocation, input.result, ctx)
          : await fn.call(h, Object.freeze({ ...ctx, ...input }))
      : await fn.call(h, input, ctx);
    if (h.kind === "model") {
      if (!result || !Number.isInteger(result.status) || result.status < 100 || result.status > 599
        || result.body === undefined || result.body === null) throw new Error("model_response");
      const upstreamType = result.headers?.get?.("content-type") || result.headers?.["content-type"] || "application/json";
      const contentType = String(upstreamType).toLowerCase().startsWith("text/event-stream") ? "text/event-stream" : "application/json";
      send({ id: message.id, event: "headers", payload: { status: result.status, headers: { "content-type": contentType } } });
      const iterable = typeof result.body === "string" || ArrayBuffer.isView(result.body) ? [result.body] : result.body;
      for await (const bytes of modelBytes(iterable)) {
        for (let i = 0; i < bytes.length; i += 24000) {
          signal.throwIfCancelled();
          const chunk = bytes.subarray(i, i + 24000);
          await new Promise((resolve) => { credits.set(message.id, resolve); send({ id: message.id, event: "chunk", payload: chunk.toString("base64") }); });
          credits.delete(message.id);
        }
      }
      send({ id: message.id, result: { complete: true } });
    } else send({ id: message.id, result: redacted(result === undefined ? null : result),
      resultUndefined: result === undefined, notifications: redacted({ events: operation.events, usage: operation.usage }) });
  } catch {
    send({ id: message.id, error: started && ["tool", "job", "command"].includes(h.kind)
      && h.descriptor.execution?.idempotency !== "safe" ? "execution_outcome_unknown" : "extension_host_error",
      notifications: redacted({ events: operation.events, usage: operation.usage }) });
  } finally {
    operations.delete(message.id); credits.delete(message.id);
    if (currentOperation === operation) currentOperation = undefined;
  }
}
async function refresh(message) {
  if (mcp) {
    const found = [];
    let cursor, pages = 0;
    do {
      const page = await mcp.listTools(cursor ? { cursor } : {});
      found.push(...page.tools);
      if (found.length > 100 || ++pages > 16 || (cursor && page.nextCursor === cursor)) throw new Error("catalog_limit");
      cursor = page.nextCursor;
    } while (cursor);
    for (const [handle, h] of handlers) if (h.kind === "tool") handlers.delete(handle);
    for (const t of found) register("tool", { ...t, invoke: (args, ctx) =>
      mcp.callTool({ name: t.name, arguments: args }, undefined, { signal: ctx.abortSignal }) });
  }
  description = normalizeHostDescription({ ...description, handlers: [...handlers.values()].map((h) => h.descriptor) });
  send({ id: message.id, result: description });
}
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let message;
  try { message = JSON.parse(line); } catch { process.exit(1); }
  if (message.action === "cancel") { operations.get(message.id)?.abort("cancelled"); continue; }
  if (message.action === "credit") { credits.get(message.id)?.(); continue; }
  if (message.action === "dispose") {
    for (const c of operations.values()) c.abort("disposed");
    try { await disposer?.(); } finally { process.exit(0); }
  }
  const action = message.action === "activate" ? activate(message)
    : message.action === "refresh" ? refresh(message) : execute(message);
  void action.catch(() => send({ id: message.id, error: "extension_host_error" }));
}
for (const c of operations.values()) c.abort("host-disconnected");
try { await disposer?.(); } finally { process.exit(0); }
