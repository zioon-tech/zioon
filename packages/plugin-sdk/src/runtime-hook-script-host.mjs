import { pathToFileURL } from "node:url";

/** Executed in a fresh child process. stdout is reserved for the decision protocol. */
export async function runRuntimeHookScript(modulePath, {
  input = process.stdin, output = process.stdout, maxInputBytes = 512 * 1024
} = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.length;
    if (size > maxInputBytes) throw new Error("Hook input limit exceeded");
    chunks.push(chunk);
  }
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (envelope.schemaVersion !== 1 || envelope.context?.schemaVersion !== 1) {
    throw new Error("Unsupported Hook protocol");
  }
  const hook = await import(pathToFileURL(modulePath).href);
  if (typeof hook.handle !== "function") throw new Error("Script Hook must export handle");
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGTERM", stop);
  try {
    const decision = await hook.handle(envelope.context, { signal: abort.signal });
    const body = JSON.stringify({ schemaVersion: 1, decision: decision || { action: "pass" } });
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error("Hook output limit exceeded");
    output.write(body);
  } finally { process.removeListener("SIGTERM", stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRuntimeHookScript(process.argv[2]).catch(() => {
    process.stderr.write("Script Hook execution failed\n");
    process.exitCode = 1;
  });
}
