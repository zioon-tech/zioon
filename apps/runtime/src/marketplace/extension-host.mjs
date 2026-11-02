// Copied to and executed on the authorized Node. Never imported by Runtime.
import { readFile, mkdir, open, lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { validateToolInput } from "./schema.mjs";

const writeResult = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
process.stderr.write = () => true;
const secrets = [];
const redact = (value) => {
  const visit = (item) => {
    if (typeof item === "string") {
      for (const secret of secrets.filter((s) => typeof s === "string" && s.length)) item = item.split(secret).join("[redacted]");
      return item;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, entry]) => [visit(key), visit(entry)]));
    return item;
  };
  return visit(JSON.parse(JSON.stringify(value)));
};
const inside = (root, path) => { const part = relative(root, path); return !part || (!isAbsolute(part) && part !== ".." && !part.startsWith("../")); };
async function directory(path, root) {
  if (!inside(root, path)) throw new Error("path");
  if (path !== root) await directory(dirname(path), root);
  try { await mkdir(path); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || !inside(root, await realpath(path))) throw new Error("path");
}
async function immutableFile(path, content, root) {
  await directory(dirname(path), root);
  let file;
  try { file = await open(path, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST" || (await lstat(path)).isSymbolicLink() || await readFile(path, "utf8") !== content) throw new Error("file_integrity");
    return;
  }
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}
let job, client, transport, pluginDispose, callStarted = false;
try {
  job = JSON.parse(await readFile(process.argv[2], "utf8"));
  const { artifact, config, action } = job;
  const { digest, ...unsigned } = artifact;
  if (createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") !== digest) throw new Error("digest");
  const workspace = await realpath(config.workspaceRoot);
  const root = join(workspace, ".zion", "extension-host", "artifacts", digest);
  await directory(root, workspace);
  for (const [name, content] of Object.entries(artifact.files || {})) {
    if (!/^[a-zA-Z0-9_.\/-]+$/.test(name) || name.split("/").some((p) => !p || p === "." || p === "..")) throw new Error("path");
    await immutableFile(resolve(root, name), content, workspace);
  }
  let credentials = {};
  if (config.credentialsFile) {
    const info = await lstat(config.credentialsFile);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 16000 || (info.mode & 0o077)) throw new Error("credentials_permissions");
    credentials = JSON.parse(await readFile(config.credentialsFile, "utf8"));
    if (credentials.listingId !== job.listingId) throw new Error("credentials_binding");
    for (const value of Object.values(credentials.env || {})) secrets.push(value);
    for (const [key, value] of Object.entries(credentials.headers || {})) {
      secrets.push(value);
      if (key.toLowerCase() === "authorization" && typeof value === "string") secrets.push(value.replace(/^\S+\s+/, ""));
    }
  }
  let tools, invoke;
  if (artifact.kind === "plugin") {
    const registered = new Map();
    const unsupported = () => { throw new Error("unsupported_plugin_hook"); };
    const module = await import(pathToFileURL(resolve(root, artifact.plugin.entries.runtime)).href);
    if (module.runtimePluginApiVersion !== undefined && module.runtimePluginApiVersion !== 2) throw new Error("api_version");
    const contribution = await module.activateRuntimePlugin(Object.freeze({
      apiVersion: 2, plugin: Object.freeze(artifact.plugin), config: Object.freeze({}),
      log() {}, locations: Object.freeze({ data: Object.freeze({ root: join(workspace, ".zion", "plugin-data", artifact.manifest.slug) }) }),
      tools: Object.freeze({ registerTool(tool) {
        if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(tool?.name || "") || typeof tool.invoke !== "function" || registered.has(tool.name) || registered.size >= 100) throw new Error("tool");
        registered.set(tool.name, tool);
        return { dispose: () => registered.delete(tool.name) };
      } }),
      context: { registerProvider: unsupported }, runs: { registerController: unsupported, registerCommands: unsupported, registerPostProcessor: unsupported },
      documents: { registerProjector: unsupported }, state: { namespace: unsupported }, events: { emit: unsupported, on: unsupported }
    })) || {};
    if (Object.keys(contribution).some((key) => key !== "dispose" && key !== "tools")) throw new Error("unsupported_plugin_hook");
    pluginDispose = contribution.dispose;
    for (const tool of contribution.tools || []) {
      if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(tool?.name || "") || typeof tool.invoke !== "function" || registered.has(tool.name) || registered.size >= 100) throw new Error("tool");
      registered.set(tool.name, tool);
    }
    tools = [...registered.values()].map((tool) => ({ name: tool.name, description: String(tool.description || "").slice(0, 4000),
      inputSchema: tool.inputSchema || { type: "object", additionalProperties: true } }));
    invoke = async () => {
      const tool = registered.get(job.tool);
      if (!tool) throw new Error("tool_not_found");
      if (validateToolInput(job.arguments || {}, tool.inputSchema || { type: "object", additionalProperties: true }).length) throw new Error("arguments");
      callStarted = true;
      return await tool.invoke(job.arguments || {}, Object.freeze({
        runId: job.runId, invocationId: job.invocationId, workspaceRoot: workspace,
        signal: { cancelled: false, throwIfCancelled() {}, onCancel() { return { dispose() {} }; } }
      }));
    };
  } else {
    const require = createRequire(import.meta.url);
    const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
    client = new Client({ name: "zioon-extension-host", version: "1.0.0" });
    if (artifact.mcp.transport === "stdio") {
      const { StdioClientTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href);
      const env = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: workspace, TMPDIR: "/tmp" };
      for (const key of artifact.mcp.envKeys) {
        if (typeof credentials.env?.[key] !== "string") throw new Error("credentials_missing");
        env[key] = credentials.env[key];
      }
      transport = new StdioClientTransport({ command: artifact.mcp.command, args: artifact.mcp.args, env, cwd: root, stderr: "ignore" });
    } else {
      if (config.credentialsFile && credentials.endpoint !== artifact.mcp.endpoint) throw new Error("credentials_origin");
      const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")).href);
      const headers = {};
      for (const [key, value] of Object.entries(credentials.headers || {})) {
        if (!["authorization", "x-api-key"].includes(key.toLowerCase()) || typeof value !== "string" || /[\r\n]/.test(value)) throw new Error("credential_header");
        headers[key] = value;
      }
      const endpoint = new URL(artifact.mcp.endpoint).href;
      transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers, redirect: "error" },
        fetch: (url, options) => {
          if (new URL(String(url)).href !== endpoint) throw new Error("origin");
          return fetch(url, { ...options, redirect: "error" });
        }
      });
    }
    await client.connect(transport);
    tools = [];
    let cursor, pages = 0;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      if (tools.length > 100 || ++pages > 16 || (cursor && page.nextCursor === cursor)) throw new Error("tool_limit");
      cursor = page.nextCursor;
    } while (cursor);
    invoke = async () => {
      const tool = tools.find((tool) => tool.name === job.tool);
      if (!tool || validateToolInput(job.arguments || {}, tool.inputSchema).length) throw new Error("arguments");
      callStarted = true;
      return await client.callTool({ name: job.tool, arguments: job.arguments || {} });
    };
  }
  const result = action === "probe" ? { tools } : { result: await invoke() };
  await client?.close();
  await pluginDispose?.();
  const value = redact({ ok: true, ...result });
  if (Buffer.byteLength(JSON.stringify(value)) > 100000) throw new Error("output_limit");
  writeResult(`ZIOON_EXTENSION_RESULT:${JSON.stringify(value)}\n`);
} catch {
  try { await client?.close(); } catch {}
  writeResult(`ZIOON_EXTENSION_RESULT:${JSON.stringify({ ok: false,
    failureCode: callStarted ? "execution_outcome_unknown" : "extension_host_error",
    error: callStarted ? "扩展调用结果不确定，请检查执行端再重试" : "扩展验证失败，请检查执行端文件、凭据、依赖和工具插件兼容性" })}\n`);
  process.exitCode = 1;
}
