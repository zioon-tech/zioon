import { readFile } from "node:fs/promises";
import { hashExtension } from "../../../../packages/runtime-client/src/extension-package.mjs";
import { collectDevelopmentBuild } from "../../../../packages/runtime-client/src/development-build.mjs";
import { readReleaseContent } from "./release-content.mjs";
import { installationFiles, releaseFromInstallationFiles } from "./installation-content.mjs";

export const isWorkspaceAction = (action) => ["workspace-prepare", "workspace-read", "workspace-write",
  "workspace-reload", "workspace-restore"].includes(action);
const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const fail = (code) => { throw Object.assign(new Error(code), { code, statusCode: 409 }); };

export class InstallationWorkspaceService {
  constructor(execution) {
    this.execution = execution;
    this.source = readFile(new URL("./installation-workspace-node.mjs", import.meta.url), "utf8");
  }
  async invoke(args, context) {
    if (!context.runId || !context.invocationId) fail("invalid_extension_invocation");
    if (typeof args.epoch !== "string" || !args.epoch) fail("installation_epoch_required");
    if (context.policy?.preset !== "trusted-automation"
      || !["write", "Bash"].every((name) => context.policy.allowedTools?.includes(name))) fail("extension_policy_denied");
    const execution = this.execution, market = execution.marketplace;
    const userId = String(context.principal?.userId || context.principal?.user?.id || "");
    const current = await market.installationFor(userId, args.listingId, args.epoch);
    if (args.action === "workspace-restore") {
      return { ok: true, content: JSON.stringify(await market.restoreInstallation(userId, args.listingId, current.install.executionEpoch)) };
    }
    const prepared = await market.prepareInstallation(userId, args.listingId, current.install.executionEpoch);
    const install = { ...prepared.install, config: await execution.resolveConfig(prepared.install.config, context.principal) };
    await execution.authorizeHost(context, install);
    const release = await readReleaseContent(current.release, market.artifactStore);
    const initialFiles = installationFiles(release);
    const remote = async (input) => {
      await market.installationFor(userId, args.listingId, install.executionEpoch);
      const payload = Buffer.from(JSON.stringify({ directory: install.workspace.directory, initialFiles, ...input })).toString("base64");
      const id = `workspace:${hashExtension([context.invocationId, input])}`;
      const result = await execution.tools().invoke({
        ...context, signal: undefined, invocationId: id, target: { nodeId: install.config.nodeId },
        toolCall: { id, name: "Bash", arguments: {
          command: `node --input-type=module -e ${quote(await this.source)} ${quote(payload)}`,
          timeout: 30000, execution_environment: "resource", node_id: install.config.nodeId
        } }
      }, context.signal);
      let stdout = result.content;
      try { const output = JSON.parse(stdout); stdout = output.stdout || stdout; } catch {}
      const frame = String(stdout).split("\n").find((line) => line.startsWith("ZIOON_INSTALLATION_RESULT:"));
      if (!frame) {
        if (!result.ok) throw Object.assign(new Error(result.content), { code: result.failureCode || "execution_outcome_unknown",
          failureCode: result.failureCode || "execution_outcome_unknown", retryable: false });
        fail("execution_outcome_unknown");
      }
      const value = JSON.parse(frame.slice("ZIOON_INSTALLATION_RESULT:".length));
      if (!value.ok) fail(value.code);
      await market.installationFor(userId, args.listingId, install.executionEpoch);
      return value;
    };
    const values = args.arguments || {};
    const snapshot = await remote({ action: args.action === "workspace-write" ? "write" : "read",
      ...(values.path ? { path: values.path } : {}),
      ...(args.action === "workspace-write" ? { content: values.content, expectedHash: values.expectedHash } : {}) });
    if (args.action !== "workspace-reload") return { ok: true, content: JSON.stringify({
      directory: install.workspace.directory, ...snapshot
    }) };
    if (values.expectedHash && values.expectedHash !== snapshot.hash) fail("installation_source_changed");
    const original = await readReleaseContent(current.source, market.artifactStore);
    const candidate = releaseFromInstallationFiles(original, snapshot.files);
    if (candidate.artifact?.kind === "plugin") {
      await collectDevelopmentBuild(async (path) => {
        if (path === "__revision") return JSON.stringify({ revision: snapshot.hash });
        if (path === "manifest.json") return JSON.stringify(candidate.artifact.plugin);
        if (typeof candidate.artifact.files[path] !== "string") fail("installation_module_missing");
        return candidate.artifact.files[path];
      });
    }
    if (candidate.artifact && ["plugin", "mcp"].includes(candidate.artifact.kind)) {
      // Activate and discover the candidate on its authorized Host first.
      const binding = execution.bridge.binding({ ...install, executionEpoch: `candidate:${candidate.artifact.digest}` }, candidate.artifact, userId);
      try { await execution.bridge.ensure(binding, candidate.artifact, context); }
      finally { await execution.bridge.dispose?.(binding, context); }
    }
    await remote({ action: "read", expectedHash: snapshot.hash });
    const activated = await market.activateInstallation(userId, args.listingId, install.executionEpoch, snapshot.files, snapshot.hash);
    return { ok: true, content: JSON.stringify({ ...activated, directory: install.workspace.directory, hash: snapshot.hash }) };
  }
}
