import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

export const localPath = (value) => resolve(value.replace(/^(["'])(.*)\1$/, "$2").replace(/^~(?=[/\\]|$)/, homedir()));

export async function completeFilePath(text) {
  const match = text.match(/^(\/(?:file|export|image)\s+)(.*)$/s);
  if (!match) return null;
  const raw = match[2].replace(/^"/, ""), absolute = localPath(raw || ".");
  const directory = /[/\\]$/.test(raw) || !raw ? absolute : dirname(absolute);
  const prefix = /[/\\]$/.test(raw) ? "" : basename(raw);
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((item) => item.name.startsWith(prefix) && (!match[1].startsWith("/image ") || item.isDirectory() || /\.(png|jpe?g|gif|webp|avif)$/i.test(item.name)))
    .sort((a, b) => a.isDirectory() !== b.isDirectory() ? Number(b.isDirectory()) - Number(a.isDirectory()) : a.name.localeCompare(b.name));
  return entries.slice(0, 100).map((item) => {
    const full = join(directory, item.name) + (item.isDirectory() ? sep : "");
    return { id: `${match[1]}${full}`, label: item.name + (item.isDirectory() ? sep : "") };
  });
}

// Attachment is explicit text inclusion; no hidden filesystem reads or binary
// upload. Read from one open handle, bounded even if the file grows concurrently.
export async function readTextAttachment(value) {
  const path = localPath(value);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Choose a regular text file.");
    const buffer = Buffer.alloc(48 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 48 * 1024) throw new Error("File exceeds 48 KiB. Select a smaller excerpt.");
    const bytes = buffer.subarray(0, size);
    if (bytes.includes(0)) throw new Error("Only UTF-8 text files are supported.");
    let content;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("Only UTF-8 text files are supported."); }
    return { name: basename(path), content };
  } finally { await handle.close(); }
}

export async function editDraft(text, environment = process.env, signal) {
  const configured = environment.VISUAL || environment.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
  // Tokenize quoted executable/arguments without executing shell substitutions.
  const tokens = configured.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map((part) => part.replace(/^(["'])(.*)\1$/, "$2")) || [];
  if (!tokens.length) throw new Error("Set VISUAL or EDITOR to an editor executable.");
  const dir = await mkdtemp(join(tmpdir(), "zioon-draft-"));
  const path = join(dir, "message.md");
  try {
    await writeFile(path, text, { mode: 0o600 });
    signal?.throwIfAborted();
    await new Promise((resolvePromise, reject) => {
      const child = spawn(tokens[0], [...tokens.slice(1), path], { stdio: "inherit", shell: false, signal });
      let failure, killTimer;
      const cancelled = () => { killTimer = setTimeout(() => child.kill("SIGKILL"), 1500); };
      signal?.addEventListener("abort", cancelled, { once: true });
      child.once("error", (error) => { failure = error.name === "AbortError" ? error
        : new Error("Cannot launch editor. Check VISUAL or EDITOR."); });
      child.once("close", (code) => {
        clearTimeout(killTimer); signal?.removeEventListener("abort", cancelled);
        if (failure || signal?.aborted) reject(failure || signal.reason);
        else if (code === 0) resolvePromise();
        else reject(new Error("Editor exited without success; draft retained."));
      });
    });
    const result = await readFile(path, "utf8");
    if (result.length > 64 * 1024) throw new Error("Edited draft exceeds 64 KiB; original draft retained.");
    return result;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
