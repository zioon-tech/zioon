import { connect } from "node:net";
import { spawn } from "node:child_process";
import { readFile, open, unlink, stat, mkdir, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const [socketPath, jobPath] = process.argv.slice(2);
const input = JSON.parse(await readFile(jobPath, "utf8"));
await mkdir(dirname(socketPath), { mode: 0o700 }).catch((e) => { if (e.code !== "EEXIST") throw e; });
const socketDirectory = await lstat(dirname(socketPath));
if (!socketDirectory.isDirectory() || socketDirectory.isSymbolicLink() || (socketDirectory.mode & 0o077)) throw new Error("host_socket_directory");
const request = () => new Promise((resolve, reject) => {
  const socket = connect(socketPath);
  let body = "";
  const decoder = new StringDecoder("utf8");
  socket.once("connect", () => socket.write(`${JSON.stringify(input)}\n`));
  socket.on("data", (bytes) => {
    body += decoder.write(bytes);
    if (Buffer.byteLength(body) > 200000) socket.destroy(new Error("host_response_budget"));
  });
  socket.once("error", reject);
  socket.once("end", () => {
    try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
  });
  socket.setTimeout(30000, () => socket.destroy(new Error("host_timeout")));
});
let result;
try { result = await request(); }
catch (e) {
  if (!["ENOENT", "ECONNREFUSED"].includes(e.code)) throw e;
  const lockPath = `${socketPath}.lock`;
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (e) {
    if (e.code !== "EEXIST") throw e;
    // A startup interrupted by a VM pause is recoverable. A fresh lock is
    // owned by a concurrent client, so leave it alone.
    if (Date.now() - (await stat(lockPath)).mtimeMs > 30000) {
      await unlink(lockPath);
      lock = await open(lockPath, "wx", 0o600);
    }
  }
  if (lock) {
    await lock.close();
    const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "extension-daemon.mjs"), socketPath],
      { detached: true, stdio: "ignore", env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: dirname(socketPath), TMPDIR: "/tmp" } });
    child.unref();
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try { result = await request(); break; }
    catch (e) { if (!["ENOENT", "ECONNREFUSED", "EPIPE", "ECONNRESET"].includes(e.code)) throw e; }
    await delay(50);
  }
  if (!result) throw new Error("host_start_failed");
}
process.stdout.write(`ZIOON_HOST_RESULT:${JSON.stringify(result)}\n`);
