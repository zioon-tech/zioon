import { mkdir, readFile, readdir, stat, lstat, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { normalizeExtensionPackage, normalizeExtensionConfig } from "../../../packages/runtime-client/src/extension-package.mjs";
import { createExtensionsClient, extensionRunRequest, runtimePluginToolRequest } from "../../../packages/runtime-client/src/extensions.mjs";
import { createPluginDevelopmentClient, watchDevelopmentSource } from "../../../packages/runtime-client/src/plugin-development.mjs";
import { buildFilePath, collectDevelopmentBuild } from "../../../packages/runtime-client/src/development-build.mjs";
import { defineToolPlugin, defineModelPlugin } from "../../../packages/plugin-sdk/src/runtime.mjs";

export const EXTENSIONS_USAGE = `Usage: zion extensions <action> [options]

  init <directory> --kind <kind> Create a skill, plugin, model or mcp project (default skill)
  validate <directory>         Validate project files offline
  pack <directory> --out <file> Create a fixed JSON artifact offline
  upload <file>                Upload a packed version to your own account
  publish <directory>         Publish privately; --public submits for review
  install <id>[@version]       Install a fixed account extension version
  list [--all]                List installed extensions, or all available entries
  show <id>                   Show content, versions and installation
  status [id]                 Show installation readiness
  enable <id>                 Enable an installed extension
  disable <id>                Disable an installed extension
  uninstall <id>              Remove installation; keep uploaded private versions
  configure <id> [--node <id>] [--root <path>] [--credentials-file <path>]
  prepare <id>                Prepare MCP SDK on the configured execution Node
  probe <id>                  Discover and validate actual extension tools
  call <id> --tool <name> --args '<json>'  Call an extension tool through a Run
  files <id>                  Open/list the persistent personal source files
  read <id> --path <path>      Read one personal file
  write <id> --path <path> --file <local> --source-hash <hash>
  reload <id>                 Validate and activate a private content revision
  restore <id>                Use original release again; keep personal files
  dev <directory>             Build and watch in your account workspace
  dev start <directory> [--node <id>] [--watch]  Start directory development
  dev build <id>              Publish the latest successful source build
  dev list                    List the account's development plugins
  dev stop <id>                Unregister a development plugin

Options:
  --version <x.y.z>           Select an install version
  --digest <sha256>           Require the selected release digest to match
  --switch-source            Switch install source while preserving edited directories
  --source-hash <sha256>      Require personal source hash for write/reload
  --public                   Submit a fixed package to public marketplace review
  --runtime-profile <name>    Choose an existing account endpoint profile
  --url <url> --account       Use an account at this Runtime
  --jsonl                    Emit schemaVersion 1 JSONL records
  --transport stdio|http      MCP scaffold transport (default stdio)
  --profile <id>              Run Interaction Profile for prepare/probe/call
  --host runtime              List/show/call full Runtime SDK plugins
  --device-only               Start/list sources on older Runtime versions
  --stop-source               Also stop the Node watcher when unregistering
  --watch                     Keep building after edits and reconnection

Code plugins must contain built JavaScript; bundle third-party dependencies.
MCP supports stdio and Streamable HTTP. Credentials stay in a Node-local JSON
file (mode 600); configure stores only its path. Upload is private and does not
install. Execution requires an authorized Node, write/Bash and trusted-automation.
`;
export const LOCAL_EXTENSION_ACTIONS = new Set(["init", "validate", "pack"]);
const remoteActions = new Set(["upload", "publish", "install", "list", "show", "status", "enable", "disable", "uninstall", "configure", "prepare", "probe", "call", "files", "read", "write", "reload", "restore", "dev-start", "dev-build", "dev-list", "dev-stop"]);
const valueOptions = new Set(["--out", "--version", "--digest", "--url", "--runtime-profile", "--kind", "--transport", "--node", "--root", "--credentials-file", "--settings-file", "--tool", "--args", "--profile", "--host", "--path", "--file", "--source-hash"]);
const flagOptions = new Set(["--all", "--jsonl", "--account", "--device-only", "--stop-source", "--watch", "--public", "--switch-source"]);

export function parseExtensionsArgs(argv) {
  const positional = [], options = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (valueOptions.has(value)) {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`${value} requires a value`);
      options[value] = argv[++index];
    } else if (flagOptions.has(value)) options[value] = true;
    else if (value.startsWith("-")) throw new Error(`Unknown extensions option: ${value}`);
    else positional.push(value);
  }
  if (positional[0] === "dev") {
    if (positional[1] && !["start", "build", "list", "stop"].includes(positional[1])) {
      positional.splice(0, 1, "dev-start");
      options["--watch"] = true;
    } else {
      const operation = positional[1] || "list";
      positional.splice(0, positional.length > 1 ? 2 : 1, `dev-${operation}`);
    }
  }
  const [action = "list", argument = "", ...extra] = positional;
  if (extra.length) throw new Error("Too many extensions arguments");
  if (!LOCAL_EXTENSION_ACTIONS.has(action) && !remoteActions.has(action)) throw new Error(`Unknown extensions action: ${action}`);
  if (!["list", "status", "dev-list"].includes(action) && !argument) throw new Error(`extensions ${action} requires an argument`);
  if (["list", "dev-list"].includes(action) && argument) throw new Error(`extensions ${action} does not take an argument`);
  if (options["--public"] && action !== "publish") throw new Error("--public is supported by extensions publish");
  return { action, argument, options };
}

async function readJson(path) {
  if ((await stat(path)).size > 256000) throw new Error("Extension package exceeds 256KB");
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error(`Cannot read JSON from ${path}: ${error.message}`); }
}

async function readProject(path) {
  const names = await readdir(path);
  const metadata = await readJson(join(path, "zion-extension.json"));
  const { kind = "skill", ...manifest } = metadata;
  if (kind !== "skill") {
    const files = {};
    let size = 0;
    const visit = async (directory, prefix = "") => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!prefix && ["zion-extension.json", "manifest.json", "mcp.json", ".git", "node_modules"].includes(entry.name)) continue;
        const name = `${prefix}${entry.name}`;
        if (entry.isSymbolicLink()) throw new Error("Extension files cannot be symlinks");
        if (entry.isDirectory()) { await visit(join(directory, entry.name), `${name}/`); continue; }
        if (!entry.isFile()) throw new Error("Unsupported extension file");
        size += (await stat(join(directory, entry.name))).size;
        if (size > 200000 || Object.keys(files).length >= 64) throw new Error("Extension file limit exceeded");
        const bytes = await readFile(join(directory, entry.name));
        files[name] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      }
    };
    await visit(path);
    return normalizeExtensionPackage({ schemaVersion: 1, kind, manifest, files,
      ...(kind === "plugin" ? { plugin: await readJson(join(path, "manifest.json")) } : { mcp: await readJson(join(path, "mcp.json")) }) });
  }
  const files = {};
  const visit = async (directory, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!prefix && ["zion-extension.json", "SKILL.md"].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error("Skill files cannot be symlinks");
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), name + "/");
      else {
        if (!entry.isFile() || Object.keys(files).length >= 64 || (await stat(join(directory, entry.name))).size > 200000) throw new Error("Skill file limit exceeded");
        files[name] = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(join(directory, entry.name)));
      }
    }
  };
  await visit(path);
  return normalizeExtensionPackage({
    schemaVersion: 1, kind: "skill",
    manifest,
    body: await readFile(join(path, "SKILL.md"), "utf8"), files
  });
}

async function localDevelopmentBuild(directory) {
  const root = await realpath(directory);
  return collectDevelopmentBuild(async (path) => {
    if (path === "__revision") throw Object.assign(new Error("No revision service"), { statusCode: 404 });
    const name = path === "manifest.json" ? path : buildFilePath(path);
    const file = join(root, name);
    let current = root;
    for (const part of name.split("/")) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Development files cannot be symlinks");
    }
    if ((await stat(file)).size > 250000) throw new Error("Development file exceeds 250KB");
    return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file));
  });
}

export async function runExtensionsCli({
  parsed, output, baseUrl, fetchImpl, headers, signal, controlClient, defaultProfile
}) {
  const { action, argument, options } = parsed;
  const emit = (result) => {
    output.write(options["--jsonl"]
      ? `${JSON.stringify({ schemaVersion: 1, type: `extensions.${action}`, value: result })}\n`
      : `${JSON.stringify(result, null, 2)}\n`);
    return result;
  };
  if (action === "init") {
    const directory = resolve(argument);
    const slug = basename(directory);
    const template = options["--kind"] || "skill";
    const kind = template === "model" ? "plugin" : template;
    if (!["skill", "plugin", "model", "mcp"].includes(template)) throw new Error("--kind must be skill, plugin, model or mcp");
    const manifest = { slug, name: slug, summary: "说明这个技能的用途", version: "0.1.0", category: "开发", license: "UNLICENSED" };
    const body = `---\nname: ${slug}\ndescription: 说明这个技能的用途\n---\n\n# ${slug}\n\n在这里编写技能指令。遵循当前账户、会话和工具授权。\n`;
    const plugin = { manifestVersion: 2, id: slug, name: slug, version: manifest.version,
      entries: { runtime: "./runtime.mjs" }, runtime: { apiVersion: 2 },
      capabilities: template === "model"
        ? [{ id: "relay", kind: "model", host: "runtime",
          models: [{ id: "local-model", name: "Local model", supportsStreaming: true, supportsTools: true }] }]
        : [{ id: "hello", kind: "tool", host: "runtime" }] };
    const runtime = template === "model" ? `import { defineModelPlugin } from "./plugin-runtime.mjs";
export const runtimePluginApiVersion = 2;
export const activateRuntimePlugin = defineModelPlugin({
  id: "relay",
  models: [{ id: "local-model", name: "Local model", supportsStreaming: true, supportsTools: true }],
  async request(body, { abortSignal, env }) {
    return fetch("http://127.0.0.1:8771/v1/chat/completions", {
      method: "POST", redirect: "error", signal: abortSignal,
      headers: { "content-type": "application/json", ...(env.MODEL_API_KEY ? { authorization: "Bearer " + env.MODEL_API_KEY } : {}) },
      body: JSON.stringify(body)
    });
  }
});
` : `import { defineToolPlugin } from "./plugin-runtime.mjs";
export const runtimePluginApiVersion = 2;
export const activateRuntimePlugin = defineToolPlugin({
  name: "hello", description: "Say hello",
  inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  execution: { effect: "read", idempotency: "safe" },
  async invoke({ name }) { return { ok: true, content: "Hello, " + name }; }
});
`;
    const helper = kind === "plugin"
      ? `export const defineToolPlugin = ${defineToolPlugin.toString()};\nexport const defineModelPlugin = ${defineModelPlugin.toString()};\n` : "";
    const transport = options["--transport"] || "stdio";
    if (kind === "mcp" && !["stdio", "http"].includes(transport)) throw new Error("--transport must be stdio or http");
    const mcp = transport === "http" ? { transport, endpoint: "https://example.com/mcp" } : { transport, command: "node", args: ["server.mjs"], envKeys: [] };
    const server = `import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const result = request.method === "initialize"
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "${slug}", version: "0.1.0" } }
    : request.method === "tools/list"
      ? { tools: [{ name: "hello", description: "Say hello", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }] }
      : request.method === "tools/call"
        ? { content: [{ type: "text", text: "Hello, " + request.params.arguments.name }] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`;
    const artifact = normalizeExtensionPackage(kind === "skill" ? { schemaVersion: 1, kind, manifest, body }
      : kind === "plugin" ? { schemaVersion: 1, kind, manifest, plugin, files: { "runtime.mjs": runtime, "plugin-runtime.mjs": helper } }
        : { schemaVersion: 1, kind, manifest, mcp, files: transport === "stdio" ? { "server.mjs": server } : {} });
    await mkdir(directory, { recursive: false });
    await writeFile(join(directory, "zion-extension.json"), JSON.stringify({ ...manifest, ...(kind !== "skill" ? { kind } : {}) }, null, 2) + "\n", { flag: "wx" });
    if (kind === "skill") await writeFile(join(directory, "SKILL.md"), body, { flag: "wx" });
    else {
      await writeFile(join(directory, kind === "plugin" ? "manifest.json" : "mcp.json"), JSON.stringify(kind === "plugin" ? plugin : mcp, null, 2) + "\n", { flag: "wx" });
      for (const [name, content] of Object.entries(artifact.files)) await writeFile(join(directory, name), content, { flag: "wx" });
      if (kind === "plugin") await writeFile(join(directory, "package.json"), JSON.stringify({
        name: slug, private: true, type: "module", scripts: {
          dev: "zioon extensions dev .", publish: "zioon extensions publish ."
        }
      }, null, 2) + "\n", { flag: "wx" });
    }
    return emit({ directory, version: manifest.version, next: kind === "plugin"
      ? `zioon extensions dev ${argument}` : `zioon extensions validate ${argument}` });
  }
  if (action === "validate" || action === "pack") {
    const artifact = await readProject(resolve(argument));
    if (action === "validate") return emit({ valid: true, slug: artifact.manifest.slug, version: artifact.manifest.version, digest: artifact.digest });
    if (!options["--out"]) throw new Error("extensions pack requires --out <file>");
    const path = resolve(options["--out"]);
    await writeFile(path, JSON.stringify(artifact, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return emit({ file: path, slug: artifact.manifest.slug, version: artifact.manifest.version, digest: artifact.digest });
  }

  const client = createExtensionsClient({ baseUrl, fetchImpl, headers, signal });
  if (action.startsWith("dev-")) {
    if (options["--host"] && options["--host"] !== "runtime") throw new Error("Directory development uses the Runtime Workbench host");
    const development = createPluginDevelopmentClient({ baseUrl, fetchImpl, headers, signal });
    if (action === "dev-build") return emit(await development.publish(argument));
    if (action === "dev-start") {
      const directory = resolve(argument);
      const build = !options["--node"] ? await localDevelopmentBuild(directory) : undefined;
      const started = await development.start(directory, options["--node"], {
        deviceOnly: !!options["--device-only"], build
      });
      emit(started);
      if (!options["--watch"]) return started;
      if (options["--device-only"]) throw new Error("--watch requires account development builds");
      let watcher;
      if (!options["--node"]) {
        let previous = JSON.stringify(build), disposed = false, timer;
        const check = async () => {
          try {
            const next = await localDevelopmentBuild(directory);
            if (disposed) return;
            const serialized = JSON.stringify(next);
            if (serialized !== previous) {
              emit(await development.publish(started.source.pluginId, next));
              previous = serialized;
            }
          } catch (error) {
            if (!disposed) output.write(`${JSON.stringify({ schemaVersion: 1, type: "extensions.dev-status",
              value: { status: "build-failed", error: error.message } })}\n`);
          } finally { if (!disposed) timer = setTimeout(check, 3000); }
        };
        timer = setTimeout(check, 3000);
        watcher = { dispose() { disposed = true; clearTimeout(timer); } };
      } else watcher = watchDevelopmentSource({
        baseUrl: started.source.baseUrl, fetchImpl, headers, loadInitially: started.buildStatus !== "available",
        onChange: async () => emit(await development.publish(started.source.pluginId)),
        onStatus: (status) => {
          if (status !== "online") output.write(`${JSON.stringify({ schemaVersion: 1, type: "extensions.dev-status", value: { status } })}\n`);
        }
      });
      await new Promise((done) => {
        const stop = () => {
          watcher.dispose();
          process.removeListener("SIGINT", stop);
          process.removeListener("SIGTERM", stop);
          signal?.removeEventListener("abort", stop);
          done();
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        if (signal?.aborted) stop();
        else signal?.addEventListener("abort", stop, { once: true });
      });
      return started;
    }
    if (action === "dev-stop") return emit(await development.stop(argument, { stopSource: !!options["--stop-source"] }));
    if (options["--device-only"]) return emit(await development.listSources(options["--node"]));
    return emit(await development.list());
  }
  if (options["--host"] && options["--host"] !== "runtime") throw new Error("Supported --host is runtime");
  if (options["--host"] === "runtime") {
    if (!["list", "show", "status", "call"].includes(action)) throw new Error("Runtime plugins support list/show/status/call; installation is managed by the Runtime host");
    const health = await (fetchImpl || fetch)(`${String(baseUrl).replace(/\/+$/, "")}/health`, {
      headers, signal: signal || AbortSignal.timeout(15000), redirect: "error"
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Runtime health HTTP ${response.status}`);
      return response.json();
    });
    const catalog = await client.request("capabilities/tools", { runtime: true });
    const plugins = (health.runtimePlugins || []).map((plugin) => ({
      id: plugin.id, version: plugin.version, status: plugin.status,
      tools: (catalog.tools || []).filter((tool) => tool.pluginId === plugin.id)
    }));
    if (action === "list" || (action === "status" && !argument)) return emit(plugins);
    const plugin = plugins.find((value) => value.id === argument);
    if (!plugin) throw new Error(`Installed Runtime plugin not found: ${argument}`);
    if (action === "show" || action === "status") return emit(plugin);
    const tool = plugin.tools.find((value) => value.name === options["--tool"]);
    if (plugin.status !== "active" || !tool) throw new Error("Plugin is not active or tool is unavailable");
    if (!controlClient) throw new Error("Runtime control client is unavailable");
    const arguments_ = options["--args"] ? JSON.parse(options["--args"]) : {};
    const accepted = await controlClient.createRun(runtimePluginToolRequest(plugin.id, tool, arguments_, options["--profile"] || defaultProfile));
    const run = await controlClient.followRun(accepted.runId, () => {}, { signal, mode: "raw" });
    if (run.status !== "completed") throw Object.assign(new Error(run.error || run.output || `Plugin Run ${run.status}`),
      { code: "plugin_run_failed", runId: accepted.runId });
    return emit({ runId: accepted.runId, status: run.status, output: run.output });
  }
  // Capture a single revision. Never retry a stale mutation implicitly.
  const snapshot = await client.snapshot();
  if (action === "upload" || action === "publish") {
    const artifact = action === "publish" ? await readProject(resolve(argument))
      : normalizeExtensionPackage(await readJson(resolve(argument)));
    if (options["--public"]) {
      const saved = await client.saveContribution(artifact, snapshot.revision);
      const submitted = await client.submitContribution(saved.contribution.id, saved.revision);
      const contribution = submitted.contribution;
      return emit({ contributionId: contribution.id, listingId: contribution.manifest.id,
        version: contribution.manifest.version, digest: contribution.digest,
        visibility: "public", status: contribution.status, revision: submitted.revision });
    }
    const uploaded = await client.upload(artifact, snapshot.revision);
    return emit({ listingId: uploaded.release.id, version: uploaded.release.version,
      digest: uploaded.release.digest, artifactDigest: uploaded.release.artifactDigest,
      visibility: "private", reused: uploaded.reused, revision: uploaded.revision });
  }
  const at = argument.lastIndexOf("@");
  const id = at > 0 ? argument.slice(0, at) : argument;
  const version = options["--version"] || (at > 0 ? argument.slice(at + 1) : "");
  const entry = id && snapshot.entries.find((value) => value.id === id);
  if (id && !entry) throw Object.assign(new Error(`Account extension not found: ${id}`), { code: "extension_not_found" });
  if (action === "list") return emit(snapshot.entries.filter((e) => options["--all"] || e.installation).map((e) => ({
    id: e.id, name: e.name, visibility: e.visibility || "public",
    version: e.installation?.version || e.version, status: e.installation?.status || "not_installed",
    ...(e.installation ? { enabled: e.installation.enabled, updateAvailable: e.installation.updateAvailable } : {})
  })));
  if (action === "show") return emit(entry);
  if (action === "status") return emit((entry ? [entry] : snapshot.entries.filter((e) => e.installation)).map((e) => ({
    id: e.id, visibility: e.visibility || "public",
    ...(e.installation || { status: "not_installed" })
  })));
  if (action === "install") {
    const selected = entry.versions.find((v) => v.version === (version || entry.version));
    if (!selected) throw new Error(`Extension version unavailable: ${id}@${version || entry.version}`);
    if (options["--digest"] && options["--digest"] !== selected.digest) throw Object.assign(new Error("Selected release digest does not match --digest"), { code: "digest_mismatch" });
    return emit(await client.install(id, { version: selected.version, digest: selected.digest, expectedRevision: snapshot.revision,
      ...(options["--switch-source"] ? { discardWorkspace: true } : {}) }));
  }
  if (action === "uninstall") return emit(await client.uninstall(id, snapshot.revision));
  if (action === "configure") {
    const nodeId = options["--node"] || entry.installation?.config?.nodeId || "managed:account";
    const connections = options["--root"] ? null : await client.connections();
    const workspaceRoot = options["--root"] || connections.connections?.find((c) => c.nodeId === nodeId)?.workspaceRoot
      || entry.installation?.config?.workspaceRoot;
    return emit(await client.configure(id, normalizeExtensionConfig({
      nodeId, workspaceRoot,
      ...(entry.installation?.config?.credentialsFile ? { credentialsFile: entry.installation.config.credentialsFile } : {}),
      ...(options["--credentials-file"] ? { credentialsFile: options["--credentials-file"] } : {}),
      ...(options["--settings-file"] ? { settings: await readJson(resolve(options["--settings-file"])) }
        : entry.installation?.config?.settings ? { settings: entry.installation.config.settings } : {})
    }), snapshot.revision));
  }
  if (["prepare", "probe", "call", "files", "read", "write", "reload", "restore"].includes(action)) {
    const workspaceAction = { files: "workspace-prepare", read: "workspace-read", write: "workspace-write",
      reload: "workspace-reload", restore: "workspace-restore" }[action];
    if ((!entry.installation?.config && !workspaceAction) || !controlClient) throw new Error("Configure an authorized execution Node before running the extension");
    let arguments_ = {};
    if (options["--args"]) arguments_ = JSON.parse(options["--args"]);
    if (workspaceAction) {
      if (["read", "write"].includes(action) && !options["--path"]) throw new Error("Provide --path");
      if (action === "write" && (!options["--file"] || !options["--source-hash"])) throw new Error("Write requires --file and --source-hash from files/read");
      arguments_ = { ...(options["--path"] ? { path: options["--path"] } : {}),
        ...(options["--source-hash"] ? { expectedHash: options["--source-hash"] } : {}),
        ...(action === "write" ? { content: await readFile(resolve(options["--file"]), "utf8") } : {}) };
    }
    if (action === "call" && !options["--tool"]) throw new Error("extensions call requires --tool");
    const profile = options["--profile"] || defaultProfile;
    const accepted = await controlClient.createRun(extensionRunRequest(entry, workspaceAction || action,
      { tool: options["--tool"], arguments: arguments_ }, profile));
    const run = await controlClient.followRun(accepted.runId, () => {}, { signal, mode: "raw" });
    if (run.status !== "completed") throw Object.assign(new Error(run.error || run.output || `Extension Run ${run.status}: ${accepted.runId}`), { code: "extension_run_failed", runId: accepted.runId });
    return emit({ runId: accepted.runId, status: run.status, output: run.output });
  }
  return emit(await client.setEnabled(id, action === "enable", snapshot.revision));
}
