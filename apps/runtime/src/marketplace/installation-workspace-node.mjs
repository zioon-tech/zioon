// Runs only on the selected account Sandbox/authorized Node through Bash.
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const input = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const safe = (path) => {
  if (typeof path !== "string" || path.length > 240 || !/^[a-zA-Z0-9_.\/-]+$/.test(path)
    || path.split("/").some((p) => !p || p === "." || p === ".." || ["node_modules", ".git"].includes(p)
      || /^(?:\.env|credentials|secrets)(?:\.|$)/i.test(p))
    || !/\.(md|txt|json|ya?ml|py|sh|js|mjs|cjs|ts|css|html)$/.test(path)) fail("installation_path_denied");
  return path;
};
const root = resolve(input.directory);
async function parents(path) {
  if (path === dirname(path)) return;
  await parents(dirname(path));
  try { if (!(await lstat(path)).isDirectory()) fail("installation_symlink_denied"); }
  catch (error) { if (error.code !== "ENOENT") throw error; await mkdir(path, { mode: 0o700 }); }
}
async function read(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256000) fail("installation_file_limit");
    return new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile());
  } finally { await handle.close(); }
}
const hash = (files) => createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]])))).digest("hex");
async function snapshot() {
  const files = {};
  let bytes = 0, directories = 0;
  async function visit(path, prefix = "") {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) fail("installation_symlink_denied");
      if (entry.isDirectory()) {
        if (++directories > 128 || name.split("/").length > 12 || ["node_modules", ".git"].includes(entry.name)
          || /^(?:\.env|credentials|secrets)(?:\.|$)/i.test(entry.name)) fail("installation_path_denied");
        await visit(join(path, entry.name), name + "/");
      } else {
        safe(name);
        if (!entry.isFile() || Object.keys(files).length >= 65) fail("installation_file_limit");
        const content = await read(join(path, entry.name));
        bytes += Buffer.byteLength(content);
        if (bytes > 256000 || content.includes("\0")) fail("installation_file_limit");
        files[name] = content;
      }
    }
  }
  await visit(root);
  return { files, hash: hash(files) };
}
let lock, stage;
try {
  await parents(dirname(root));
  lock = root + ".lock";
  try { await mkdir(lock, { mode: 0o700 }); } catch { lock = null; fail("installation_workspace_busy"); }
  try {
    if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) fail("installation_symlink_denied");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!input.initialFiles) fail("installation_workspace_missing");
    stage = root + "." + randomUUID();
    await mkdir(stage, { mode: 0o700 });
    for (const [name, content] of Object.entries(input.initialFiles)) {
      safe(name);
      const path = join(stage, name);
      await parents(dirname(path));
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await handle.writeFile(content); } finally { await handle.close(); }
    }
    await rename(stage, root);
    stage = null;
  }
  let result = await snapshot();
  if (input.expectedHash && input.expectedHash !== result.hash) fail("installation_source_changed");
  if (input.action === "write") {
    if (typeof input.expectedHash !== "string") fail("installation_source_hash_required");
    const path = join(root, safe(input.path));
    if (typeof input.content !== "string" || input.content.includes("\0") || Buffer.byteLength(input.content) > 200000) fail("installation_file_limit");
    await parents(dirname(path));
    let exists = false;
    try { const stat = await lstat(path); exists = true; if (!stat.isFile()) fail("installation_symlink_denied"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!exists && Object.keys(result.files).length >= 65
      || Buffer.byteLength(JSON.stringify({ ...result.files, [input.path]: input.content })) > 256000) fail("installation_file_limit");
    const temporary = path + "." + randomUUID();
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await handle.writeFile(input.content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    result = await snapshot();
  }
  if (input.path && input.action === "read") {
    safe(input.path);
    if (!Object.hasOwn(result.files, input.path)) fail("installation_file_not_found");
    result = { hash: result.hash, path: input.path, content: result.files[input.path],
      paths: Object.keys(result.files) };
  }
  console.log("ZIOON_INSTALLATION_RESULT:" + JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.log("ZIOON_INSTALLATION_RESULT:" + JSON.stringify({ ok: false, code: error.code || "installation_workspace_error" }));
  process.exitCode = 1;
} finally {
  if (stage) await rm(stage, { recursive: true, force: true });
  if (lock) await rm(lock, { recursive: true, force: true });
}
