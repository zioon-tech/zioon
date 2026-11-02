// Private Unix socket used by the managed account sandbox. Connector Nodes use
// ExtensionHost directly and keep their existing outbound dispatch channel.
import { createServer } from "node:net";
import { chmod, lstat, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionHost } from "./extension-host.mjs";
import { StringDecoder } from "node:string_decoder";

const socketPath = process.argv[2];
const lockPath = `${socketPath}.lock`;
const host = new ExtensionHost({ supportDirectory: dirname(fileURLToPath(import.meta.url)), accountIsolated: true });
const server = createServer((socket) => {
  let buffer = "", accepted = false;
  const decoder = new StringDecoder("utf8");
  socket.on("data", (bytes) => {
    buffer += decoder.write(bytes);
    if (Buffer.byteLength(buffer) > 800000) { socket.destroy(); return; }
    const newline = buffer.indexOf("\n");
    if (accepted || newline === -1) return;
    accepted = true;
    let input;
    try { input = JSON.parse(buffer.slice(0, newline)); } catch { socket.destroy(); return; }
    // This socket lives in the 0700 account workspace Host directory. It is not
    // exposed as an HTTP service, and binds to that account's approved root.
    void host.invoke(input, null, { principal: { userId: input.binding?.accountId } })
      .then((result) => socket.end(`${JSON.stringify(result)}\n`))
      .catch(() => socket.destroy());
  });
  socket.setTimeout(30000, () => socket.destroy());
});
server.on("error", () => { host.close(); process.exit(1); });
await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
// The client holds an exclusive startup lock and confirmed that no listener
// exists before spawning this daemon.
try {
  const info = await lstat(socketPath);
  if (!info.isSocket()) throw new Error("socket_path");
  await unlink(socketPath);
} catch (e) { if (e.code !== "ENOENT") throw e; }
await new Promise((resolve) => server.listen(socketPath, resolve));
await chmod(socketPath, 0o600);
await unlink(lockPath).catch(() => {});
const close = () => { host.close(); server.close(() => process.exit(0)); };
process.on("SIGTERM", close);
process.on("SIGINT", close);
setInterval(() => {
  if (!host.workers.size && !host.pending.size) close();
}, 300000).unref();
