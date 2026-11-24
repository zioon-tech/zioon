import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code, statusCode = 403) => { throw Object.assign(new Error(code), { code, statusCode }); };
const TRANSFER_CHUNK_BYTES = 48 * 1024;
export class SkillExecutionService {
  constructor({ bundles, tools, resolveTarget, authorizeHost }) {
    Object.assign(this, { bundles, tools, resolveTarget, authorizeHost });
    this.source = readFile(new URL("./skill-workspace-node.mjs", import.meta.url), "utf8");
  }
  async prepare(skill, args, context) {
    if (!context.runId || !context.invocationId) fail("skill_run_required");
    if (!args.node_id) fail("skill_execution_node_required", 422);
    if (!args.content_hash || args.content_hash !== skill.contentHash) fail("skill_content_changed", 409);
    const target = await this.resolveTarget(args, context);
    const path = /^[A-Za-z]:[\\/]/.test(target.root) ? win32 : posix;
    const windows = path === win32;
    const chunkBytes = windows ? 8 * 1024 : TRANSFER_CHUNK_BYTES;
    if (!path.isAbsolute(target.root) || target.root.split(/[\\/]/).includes("..")) fail("skill_execution_path_denied");
    const directory = path.join(target.root, "skills", hash(JSON.stringify([
      skill.id, skill.sourceNodeId, skill.sourcePath
    ])), skill.contentHash);
    // Validate the complete destination against the Run's authorization.
    await this.authorizeHost(context, { config: { nodeId: target.nodeId, workspaceRoot: path.dirname(directory) } });
    const manifest = (await this.bundles.manifest(skill)).files.map(({ path, bytes, digest }) => ({ path, bytes, digest }));
    const stageId = hash(JSON.stringify([context.runId, context.invocationId]));
    const remote = async (input) => {
      const payload = Buffer.from(JSON.stringify({ directory, stageId,
        manifest: input.action === "chunk" ? manifest.filter((f) => f.path === input.path) : manifest,
        ...input })).toString("base64");
      const id = `skills:${hash(JSON.stringify([context.runId, context.invocationId, target.nodeId, directory, input]))}`;
      // The import source and payload contain only base64: cmd, PowerShell and
      // POSIX shells interpret the same command without quoting source text.
      const source = Buffer.from(await this.source).toString("base64");
      const command = `node -e "import('data:text/javascript;base64,${source}')" "${payload}"`;
      if (command.length > (windows ? 30000 : 120000)) fail("skill_prepare_command_limit", 413);
      const result = await this.tools().invoke({
        ...context, invocationId: id, target: { nodeId: target.nodeId },
        toolCall: { id, name: "Bash", arguments: {
          command,
          timeout: 30_000, execution_environment: "resource", node_id: target.nodeId
        } }
      }, context.signal);
      let stdout = result.content;
      try { stdout = JSON.parse(stdout).stdout || stdout; } catch {}
      const frame = String(stdout).split("\n").find((line) => line.startsWith("ZIOON_SKILL_RESULT:"));
      if (!frame) fail(result.failureCode || "skill_prepare_outcome_unknown", 409);
      const value = JSON.parse(frame.slice("ZIOON_SKILL_RESULT:".length));
      if (!result.ok || !value.ok) fail(value.code || result.failureCode || "skill_prepare_failed", 409);
      return value;
    };
    const { ready } = await remote({ action: "probe" });
    if (!ready) {
      const files = await this.bundles.files(skill, args.content_hash);
      try {
        for (const [name, content] of Object.entries(files)) {
          const bytes = Buffer.from(content);
          for (let offset = 0; offset < bytes.length || offset === 0; offset += chunkBytes) {
            await remote({ action: "chunk", path: name, offset,
              data: bytes.subarray(offset, offset + chunkBytes).toString("base64") });
          }
        }
        await remote({ action: "commit" });
      } catch (error) {
        await remote({ action: "cleanup" }).catch(() => {});
        throw error;
      }
    }
    return { ok: true, content: JSON.stringify({ prepared: true, reused: ready,
      node_id: target.nodeId, directory, file: path.join(directory, "SKILL.md"),
      contentHash: skill.contentHash, files: skill.files,
      executionNotice: "Run bundled scripts from this directory on this node_id. This preparation does not install dependencies, copy credentials or transfer source-local login state." }) };
  }
}
