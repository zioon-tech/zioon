// Executed only through an authorized Node/Sandbox invocation.
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const input = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safe = (path) => typeof path === "string" && path.length <= 240
  && !path.includes("\\") && !path.includes("\0") && !/^[A-Za-z]:/.test(path)
  && !path.split("/").some((p) => !p || p === "." || p === "..");
const directory = resolve(input.directory);
if (!/^[a-f0-9]{64}$/.test(input.stageId || "")) fail("skill_stage_invalid");
const stage = `${directory}.stage.${input.stageId}`;
async function parents(path) {
  if (path !== dirname(path)) await parents(dirname(path));
  try { if (!(await lstat(path)).isDirectory()) fail("skill_symlink_denied"); }
  catch (error) { if (error.code !== "ENOENT") throw error; await mkdir(path, { mode: 0o700 }).catch(async (e) => {
    if (e.code !== "EEXIST" || !(await lstat(path)).isDirectory()) throw e;
  }); }
}
async function verify(root) {
  try { if (!(await lstat(root)).isDirectory()) fail("skill_symlink_denied"); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  const expected = new Set(input.manifest.map((f) => f.path));
  let count = 0;
  async function visit(path, prefix = "") {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) {
        if (!input.manifest.some((f) => f.path.startsWith(relative + "/"))) fail("skill_workspace_changed");
        await visit(join(path, entry.name), relative + "/");
      } else if (!entry.isFile() || !expected.has(relative)) fail("skill_workspace_changed");
      else count++;
    }
  }
  await visit(root);
  if (count !== expected.size) fail("skill_workspace_changed");
  for (const file of input.manifest) {
    if (!safe(file.path)) fail("skill_path_denied");
    const handle = await open(join(root, file.path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== file.bytes || hash(await handle.readFile()) !== file.digest) fail("skill_workspace_changed");
    } finally { await handle.close(); }
  }
  return true;
}
async function pruneAbandonedStages() {
  const prefix = `${basename(directory)}.stage.`;
  let removed = 0;
  for (const name of await readdir(dirname(directory))) {
    if (!name.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(name.slice(prefix.length))) continue;
    const path = join(dirname(directory), name);
    const stat = await lstat(path).catch(() => null);
    if (stat?.isDirectory() && Date.now() - stat.mtimeMs > 24 * 60 * 60_000) {
      await rm(path, { recursive: true, force: true });
      if (++removed >= 8) break;
    }
  }
}
try {
  if (!Array.isArray(input.manifest) || input.manifest.length > 128
    || input.manifest.some((f) => !safe(f.path))) fail("skill_manifest_invalid");
  await parents(dirname(directory));
  if (input.action === "cleanup") {
    await rm(stage, { recursive: true, force: true });
    console.log("ZIOON_SKILL_RESULT:" + JSON.stringify({ ok: true }));
  } else if (input.action === "probe") {
    await pruneAbandonedStages();
    const ready = await verify(directory);
    console.log("ZIOON_SKILL_RESULT:" + JSON.stringify({ ok: true, ready }));
  } else if (input.action === "chunk") {
    const file = input.manifest.find((f) => f.path === input.path);
    const bytes = Buffer.from(input.data || "", "base64");
    if (!file || !Number.isSafeInteger(input.offset) || input.offset < 0
      || input.offset + bytes.length > file.bytes || bytes.length > 256 * 1024) fail("skill_chunk_invalid");
    await parents(dirname(join(stage, file.path)));
    const handle = await open(join(stage, file.path), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      if (!(await handle.stat()).isFile()) fail("skill_symlink_denied");
      let written = 0;
      while (written < bytes.length) {
        const result = await handle.write(bytes, written, bytes.length - written, input.offset + written);
        if (!result.bytesWritten) fail("skill_write_failed");
        written += result.bytesWritten;
      }
      await handle.sync();
    } finally { await handle.close(); }
    console.log("ZIOON_SKILL_RESULT:" + JSON.stringify({ ok: true }));
  } else if (input.action === "commit") {
    if (!await verify(stage)) fail("skill_stage_missing");
    try { await rename(stage, directory); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code) || !await verify(directory)) throw error;
      await rm(stage, { recursive: true, force: true });
    }
    console.log("ZIOON_SKILL_RESULT:" + JSON.stringify({ ok: true, ready: true }));
  } else fail("skill_action_invalid");
} catch (error) {
  console.log("ZIOON_SKILL_RESULT:" + JSON.stringify({ ok: false, code: error.code || "skill_workspace_error" }));
  process.exitCode = 1;
}
