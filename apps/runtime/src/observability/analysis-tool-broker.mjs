import { openSync, readSync, fstatSync, closeSync } from "node:fs";
import { posix, join } from "node:path";
import { LOCAL_TOOLS_TOOL_DEFINITIONS } from "../../../../packages/local-tools-client/src/index.mjs";
import { accountError } from "../accounts/account-policy.mjs";
import { runAnalysisProcess } from "./analysis-process.mjs";
import {
  RAW_OBSERVABILITY_TOOL_DEFINITION,
  RAW_OBSERVABILITY_TOOL_NAME,
  readRawObservability
} from "./raw-read.mjs";
import {
  OBSERVABILITY_QUERY_TOOL_DEFINITION,
  OBSERVABILITY_QUERY_TOOL_NAME
} from "./query-tool.mjs";

const READ_TOOLS = new Set(["read", "glob", "grep", "tree"]);
const FILE_TOOLS = new Set([...READ_TOOLS, "write", "edit"]);
const FACT_TOOLS = new Set([
  OBSERVABILITY_QUERY_TOOL_NAME,
  RAW_OBSERVABILITY_TOOL_NAME
]);
const ANALYSIS_TOOLS = new Set([
  ...READ_TOOLS,
  "Bash",
  OBSERVABILITY_QUERY_TOOL_NAME,
  RAW_OBSERVABILITY_TOOL_NAME
]);
const VIRTUAL_ROOTS = ["/observability", "/skills/run-diagnostics"];
const within = (path, root) => path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
const virtual = (path) => VIRTUAL_ROOTS.some((root) => within(String(path || "").replaceAll("\\", "/"), root));
const definitions = [
  ...LOCAL_TOOLS_TOOL_DEFINITIONS.filter((tool) => ANALYSIS_TOOLS.has(tool.name)).map((tool) => ({
    ...tool,
    hostKinds: ["runtime-analysis"],
    description: tool.name === "Bash"
      ? "Analyze this Space's immutable /observability JSONL and /skills/run-diagnostics in an isolated container. Only /tmp is writable; no network or host files. Defaults to analysis in account mode."
      : `${tool.description} /observability and /skills/run-diagnostics are read-only Runtime snapshots.`,
    ...(tool.name === "Bash" ? {
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...tool.inputSchema.properties,
          execution_environment: {
            type: "string", enum: ["analysis", "resource"],
            description: "analysis selects the isolated JSONL workspace. resource requires explicit administrator host authorization."
          }
        }
      }
    } : {})
  })),
  OBSERVABILITY_QUERY_TOOL_DEFINITION,
  RAW_OBSERVABILITY_TOOL_DEFINITION
];

function bounded(value, fallback, maximum) {
  return Math.max(0, Math.min(maximum, Math.floor(Number(value) || fallback)));
}

function checkedPath(input, policy) {
  const value = String(input || "/observability");
  if (value.includes("\0") || value.includes("\\") || value.split("/").includes("..")) {
    throw accountError(403, "analysis_path_denied");
  }
  const path = posix.normalize(value);
  if (!virtual(path)) throw accountError(403, "analysis_path_denied");
  const roots = policy.fileRoots || [];
  if (roots.length && !roots.some((root) => within(path, posix.normalize(root)))) {
    throw accountError(403, "file_outside_grant");
  }
  return path;
}

function physical(snapshot, path) {
  return within(path, "/observability")
    ? join(snapshot.observability, posix.relative("/observability", path))
    : join(snapshot.skill, posix.relative("/skills/run-diagnostics", path));
}

async function readSnapshot(snapshot, name, args, policy, processOptions) {
  const path = checkedPath(args.path, policy);
  const candidates = snapshot.files.filter((file) => within(file, path));
  if (name === "read") {
    if (!snapshot.files.includes(path)) throw accountError(404, "analysis_file_not_found");
    const fd = openSync(physical(snapshot, path), "r");
    let content;
    let partial;
    try {
      const size = fstatSync(fd).size;
      // Bounded input as well as output; large offsets never scan indefinitely.
      const buffer = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
      let bytes = 0;
      while (bytes < buffer.length) {
        const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
        if (!count) break;
        bytes += count;
      }
      content = buffer.subarray(0, bytes).toString("utf8");
      partial = bytes < size;
    } finally { closeSync(fd); }
    const offset = bounded(args.offset, 0, 100_000);
    const limit = bounded(args.limit, 200, 1000);
    const lines = content.split("\n");
    const selected = lines.slice(offset, offset + limit).join("\n");
    return {
      path, offset, content: selected.slice(0, 28_000),
      truncated: partial || selected.length > 28_000 || offset + limit < lines.length,
      snapshot: snapshot.manifest.snapshot
    };
  }
  if (name === "tree") {
    const depth = bounded(args.max_depth, 3, 16);
    const files = candidates.filter((file) => posix.relative(path, file).split("/").length <= depth);
    return { path, files: files.slice(0, 200), truncated: files.length > 200, snapshot: snapshot.manifest.snapshot };
  }
  const pattern = String(args.pattern || "");
  if (!pattern || pattern.length > 4096) throw accountError(400, "invalid_analysis_pattern");
  const globs = Array.isArray(args.glob) ? args.glob.map(String) : [];
  if (globs.length > 10 || globs.some((glob) => glob.length > 1024)) throw accountError(400, "invalid_analysis_glob");
  if (!candidates.length) return { path, output: "", truncated: false };
  // rg's default Rust regex engine is linear-time. No user-supplied flags,
  // config, PCRE, file discovery, symlink traversal, preprocessor or shell.
  const common = ["--no-config", "--hidden", "--no-ignore", "--color=never"];
  const argsv = name === "glob"
    ? [...common, "--files", `--glob=${pattern}`, "--", physical(snapshot, path)]
    : [...common, "--engine=default", "--no-heading", "--with-filename",
    "--max-count=200", "--max-columns=2000",
    ...globs.map((glob) => `--glob=${glob}`),
    ...(args.i ? ["--ignore-case"] : []),
    ...(args.output_mode === "files_with_matches" ? ["--files-with-matches"]
      : args.output_mode === "count" ? ["--count"] : ["--line-number"]),
    "--", pattern, physical(snapshot, path)];
  const result = await runAnalysisProcess(processOptions.ripgrep || "rg", argsv, processOptions).catch((error) => {
    if (error.code === "ENOENT") throw accountError(503, "analysis_grep_unavailable", "Install ripgrep or use read");
    throw error;
  });
  if (result.code !== 0 && result.code !== 1 && !result.truncated) {
    throw accountError(400, "analysis_grep_failed", "Invalid or unsupported search pattern");
  }
  return {
    path,
    output: result.output.replaceAll(snapshot.observability, "/observability").replaceAll(snapshot.skill, "/skills/run-diagnostics"),
    truncated: result.truncated, snapshot: snapshot.manifest.snapshot
  };
}

export class AnalysisToolBroker {
  constructor({
    delegated, snapshots = null, executor = null, runs = null, projection = null,
    accessControl = null, allowResourceExecution = false, ripgrep = "rg"
  }) {
    this.delegated = delegated;
    this.snapshots = snapshots;
    this.executor = executor;
    this.runs = runs;
    this.projection = projection;
    this.workspaceEnabled = Boolean(snapshots && executor);
    this.accessControl = accessControl;
    this.allowResourceExecution = allowResourceExecution;
    this.ripgrep = ripgrep;
  }

  get supportedToolNames() {
    const analysis = new Set([
      ...(this.workspaceEnabled ? [...READ_TOOLS, "Bash"] : []),
      ...(this.projection ? [OBSERVABILITY_QUERY_TOOL_NAME] : []),
      ...(this.accessControl ? [RAW_OBSERVABILITY_TOOL_NAME] : [])
    ]);
    return [...new Set([...analysis, ...(this.delegated.supportedToolNames || [])])];
  }

  getToolDefinitions() {
    const available = definitions.filter((tool) =>
      (this.workspaceEnabled && !FACT_TOOLS.has(tool.name))
      || (tool.name === OBSERVABILITY_QUERY_TOOL_NAME && this.projection)
      || (tool.name === RAW_OBSERVABILITY_TOOL_NAME && this.accessControl)
    );
    const replaced = new Set(available.map((tool) => tool.name));
    return [...(this.delegated.getToolDefinitions?.() || LOCAL_TOOLS_TOOL_DEFINITIONS)
      .filter((tool) => !replaced.has(tool.name)), ...available];
  }

  resolveInvocation(invocation) {
    return this.delegated.resolveInvocation?.(invocation) || invocation;
  }

  async authority(request) {
    if (!this.accessControl) return { policy: request.policy || {}, scopes: [], spaceId: "legacy" };
    const policy = await this.accessControl.authorizeRunExecution(request);
    const grant = await this.accessControl.accounts.validateGrant(request.principal, policy);
    return { policy, grant, scopes: grant.scopes, spaceId: grant.principal.spaceId };
  }

  resourceAllowed(authority) {
    return !this.accessControl || (this.allowResourceExecution && authority.scopes.includes("resource.execute"));
  }

  async listTools(request = {}) {
    const authority = await this.authority(request);
    const analysis = this.getToolDefinitions().filter((tool) =>
      ANALYSIS_TOOLS.has(tool.name)
      && authority.policy.allowedTools?.includes(tool.name)
      && (this.workspaceEnabled || FACT_TOOLS.has(tool.name))
      && (tool.name !== OBSERVABILITY_QUERY_TOOL_NAME || this.projection)
      && (tool.name !== RAW_OBSERVABILITY_TOOL_NAME || this.accessControl)
      && (tool.name !== "Bash" || this.accessControl || authority.policy.preset === "trusted-automation"));
    let delegated = [];
    if (this.resourceAllowed(authority)) {
      try { delegated = await this.delegated.listTools({ ...request, policy: authority.policy }); }
      catch { /* Analysis remains available when the optional Resource is offline. */ }
    }
    return [...analysis, ...delegated.filter((tool) => !analysis.some((item) => item.name === tool.name))];
  }

  async authorizeInvocation(invocation) {
    const { name, arguments: args = {} } = invocation.toolCall || {};
    const authority = await this.authority(invocation);
    if (!authority.policy.allowedTools?.includes(name)) throw accountError(403, "tool_outside_grant");
    const workspace = this.workspaceEnabled && (
      (name === "Bash" && (args.execution_environment === "analysis"
      || (this.accessControl && args.execution_environment !== "resource"
        && !invocation.target?.nodeId)))
      || (FILE_TOOLS.has(name) && virtual(args.path))
      || (READ_TOOLS.has(name) && this.accessControl && !args.path
        && !invocation.target?.nodeId)
    );
    if (
      !this.workspaceEnabled
      && ((name === "Bash" && args.execution_environment === "analysis")
        || (FILE_TOOLS.has(name) && virtual(args.path)))
    ) {
      throw accountError(503, "analysis_workspace_unavailable");
    }
    const analyze = workspace
      || name === OBSERVABILITY_QUERY_TOOL_NAME
      || name === RAW_OBSERVABILITY_TOOL_NAME;
    if (!analyze) {
      if (!this.resourceAllowed(authority)) throw accountError(403, "resource_execution_denied");
      return { analyze, authority };
    }
    if (args.session_id || args.node_id || args.resource_id) throw accountError(403, "analysis_resource_target_denied");
    if (!ANALYSIS_TOOLS.has(name)) throw accountError(403, "analysis_read_only");
    if (this.accessControl && !authority.scopes.includes("observability.read")) throw accountError(403, "observability_denied");
    if (name === RAW_OBSERVABILITY_TOOL_NAME && !this.accessControl) {
      throw accountError(403, "raw_observability_requires_accounts");
    }
    if (name === OBSERVABILITY_QUERY_TOOL_NAME && !this.projection) {
      throw accountError(503, "observability_query_unavailable");
    }
    // Bash can read the entire mounted snapshot. A narrower Profile must use
    // read/glob/grep/tree, where each virtual path is checked individually.
    if (name === "Bash") for (const root of VIRTUAL_ROOTS) checkedPath(root, authority.policy);
    if (name === "Bash" && authority.policy.allowedCommandPrefixes?.length) {
      throw accountError(403, "analysis_command_policy_restricted", "Use read: this Profile limits commands");
    }
    if (READ_TOOLS.has(name)) checkedPath(args.path, authority.policy);
    return { analyze, authority };
  }

  async invoke(invocation, signal) {
    const { name, arguments: args = {} } = invocation.toolCall || {};
    const { analyze, authority } = await this.authorizeInvocation(invocation);
    if (!analyze) return this.delegated.invoke({ ...invocation, policy: authority.policy }, signal);
    const authorize = async () => {
      await this.authorizeInvocation(invocation);
    };
    await authorize();
    signal?.throwIfCancelled();
    if (name === OBSERVABILITY_QUERY_TOOL_NAME) {
      if (!["runtime_analysis", "evolution_case_build"].includes(args.purpose)) {
        throw accountError(400, "invalid_observability_query_purpose");
      }
      const result = await this.projection.query(args);
      await authorize();
      if (this.accessControl) {
        await this.accessControl.accounts.audit(
          authority.grant.principal.userId,
          "observability.query",
          result.queryHash,
          {
            actor: {
              kind: "model",
              runId: String(invocation.runId || "")
            },
            spaceId: authority.spaceId,
            queryHash: result.queryHash,
            purpose: args.purpose,
            durationMs: result.durationMs,
            rows: result.rowCount,
            bytes: result.bytes,
            truncated: result.truncated
          },
          { spaceId: authority.spaceId }
        );
      }
      return { ok: true, content: JSON.stringify(result) };
    }
    if (name === RAW_OBSERVABILITY_TOOL_NAME) {
      const actorRun = await this.runs?.getRunForSpace(invocation.runId, authority.spaceId);
      const result = await readRawObservability({
        runs: this.runs,
        spaceId: authority.spaceId,
        input: args,
        actorRun
      });
      await authorize();
      await this.accessControl.accounts.audit(
        authority.grant.principal.userId,
        "observability.raw.read",
        `${result.audit.target.runId}:${result.audit.target.callId}`.slice(0, 512),
        result.audit,
        { spaceId: authority.spaceId }
      );
      return { ok: true, content: JSON.stringify(result.output) };
    }
    if (!this.snapshots) throw accountError(503, "analysis_workspace_unavailable");
    const snapshot = this.snapshots.create(authority.spaceId);
    try {
      const result = name === "Bash"
        ? await this.executor.execute({ snapshot, command: args.command, timeout: args.timeout, signal, authorize })
        : await readSnapshot(snapshot, name, args, authority.policy, { signal, authorize, timeoutMs: 5000, ripgrep: this.ripgrep });
      await authorize();
      return {
        ok: name !== "Bash" || result.ok,
        content: JSON.stringify(result),
        ...(name === "Bash" && !result.ok ? { error: result.truncated ? "analysis_output_limit" : "analysis_command_failed" } : {})
      };
    } finally { snapshot.dispose(); }
  }
}
