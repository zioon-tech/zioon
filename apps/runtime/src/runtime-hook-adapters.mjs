import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createExtensionHttpTransport, extensionEndpoint } from "./extension-http-transport.mjs";
import { environmentExtensionSecret } from "./runtime-extension-credentials.mjs";
import { signRuntimeExtension, verifyRuntimeExtension } from "../../../packages/plugin-sdk/src/runtime-extension-signature.mjs";
import { validateRunHookDecision } from "../../../packages/runtime/dist/index.js";

const stages = ["beforeStart", "beforeTurn", "beforeModel", "beforeTool", "afterTool", "beforeStop", "afterRun"];
const host = fileURLToPath(new URL("../../../packages/plugin-sdk/src/runtime-hook-script-host.mjs", import.meta.url));

function config(input) {
  if (!input || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(input.id || "")
    || !Array.isArray(input.stages) || !input.stages.length || input.stages.some((stage) => !stages.includes(stage))
    || (input.failurePolicy && !["fail-open", "fail-closed"].includes(input.failurePolicy))) {
    throw new Error("Invalid Hook adapter configuration");
  }
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Invalid Hook timeout");
  return { id: input.id, stages: [...new Set(input.stages)], timeoutMs, failurePolicy: input.failurePolicy || "fail-closed" };
}

function envelope(context) {
  const { signal: _signal, recordUsage: _recordUsage, ...data } = context;
  const copy = JSON.parse(JSON.stringify(data));
  // External services/scripts have no authority to reuse Runtime execution grants.
  const owner = copy.request?.principal;
  if (copy.request) delete copy.request.principal;
  if (copy.invocation) delete copy.invocation.principal;
  copy.owner = owner ? { spaceId: owner.spaceId, userId: owner.userId } : null;
  const body = JSON.stringify({ schemaVersion: 1, context: copy });
  if (Buffer.byteLength(body) > 512 * 1024) throw new Error("Hook context exceeds 512 KiB");
  return body;
}

function parseDecision(body, stage) {
  const value = JSON.parse(body);
  if (value.schemaVersion !== 1) throw new Error("Unsupported Hook response protocol");
  return validateRunHookDecision(value.decision, stage);
}

export function createHttpRunController(input, {
  transport = createExtensionHttpTransport(), secret = environmentExtensionSecret,
  trustedOrigins = [], now = Date.now
} = {}) {
  const settings = config(input);
  const endpoint = extensionEndpoint(input.endpoint, { trustedOrigins }).href;
  secret(input.secretRef);
  return {
    ...settings,
    async handle(context) {
      const body = envelope(context);
      const timestamp = String(now());
      const id = context.idempotencyKey;
      const abort = new AbortController();
      const linked = context.signal.onCancel(() => abort.abort());
      try {
        context.signal.throwIfCancelled();
        const response = await transport({
          endpoint, body, timeoutMs: settings.timeoutMs, signal: abort.signal,
          headers: {
            "x-zion-hook-id": id, "x-zion-timestamp": timestamp,
            "x-zion-signature": signRuntimeExtension(secret(input.secretRef), { timestamp, id, body })
          }
        });
        if (response.status !== 200) throw new Error("Hook endpoint rejected request");
        // Responses echo the request timestamp/id and sign their raw response body.
        const signed = JSON.parse(response.body);
        if (!verifyRuntimeExtension(secret(input.secretRef), {
          timestamp, id, body: JSON.stringify(signed.response), signature: signed.signature
        }, { now: now() })) throw new Error("Invalid Hook response signature");
        return parseDecision(JSON.stringify(signed.response), context.stage);
      } finally { linked.dispose(); }
    }
  };
}

export function createScriptRunController(input, { allowScripts = false, environment = process.env } = {}) {
  const settings = config(input);
  if (!allowScripts || !isAbsolute(input.modulePath || "")) {
    throw new Error("Script Hooks require operator opt-in and an absolute module path");
  }
  if (input.environmentKeys && (!Array.isArray(input.environmentKeys)
    || input.environmentKeys.length > 32
    || input.environmentKeys.some((key) => !/^[A-Z_][A-Z0-9_]{0,80}$/.test(key)))) {
    throw new Error("Invalid Script Hook environment allowlist");
  }
  const env = Object.fromEntries((input.environmentKeys || []).filter((key) => environment[key] !== undefined)
    .map((key) => [key, environment[key]]));
  return {
    ...settings,
    async handle(context) {
      const body = envelope(context);
      context.signal.throwIfCancelled();
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [host, input.modulePath], {
          shell: false, env, detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"]
        });
        let completed = false;
        const chunks = [];
        let size = 0;
        let stderrSize = 0;
        let killTimer;
        let linked;
        const killGroup = (signal) => {
          if (!child.pid) return;
          if (process.platform === "win32") {
            const cleanup = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              shell: false, stdio: "ignore", windowsHide: true
            });
            cleanup.on("error", () => child.kill("SIGKILL"));
          } else {
            try { process.kill(-child.pid, signal); }
            catch (error) { if (error.code !== "ESRCH") child.kill(signal); }
          }
        };
        const stop = () => {
          if (killTimer) return;
          killGroup("SIGTERM");
          killTimer = setTimeout(() => killGroup("SIGKILL"), 250);
          killTimer.unref();
        };
        const finish = (error, value) => {
          if (completed) return;
          completed = true;
          clearTimeout(timer);
          linked?.dispose();
          // A module may unref a helper before returning; successful completion
          // must also retire the invocation's process group.
          stop();
          error ? reject(error) : resolve(value);
        };
        const timer = setTimeout(() => finish(new Error("Script Hook timed out")), settings.timeoutMs);
        linked = context.signal.onCancel(() => finish(new Error("Script Hook cancelled")));
        child.stdout.on("data", (chunk) => {
          size += chunk.length;
          if (size > 64 * 1024) finish(new Error("Script Hook output exceeds limit"));
          else chunks.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderrSize += chunk.length;
          if (stderrSize > 8 * 1024) finish(new Error("Script Hook diagnostics exceed limit"));
        });
        child.on("error", () => finish(new Error("Script Hook process failed")));
        child.stdin.on("error", () => finish(new Error("Script Hook input failed")));
        child.on("exit", () => {
          // Descendants may retain inherited pipes after the host returned.
          // Cleanup releases them so close can validate the protocol output.
          if (!completed) {
            clearTimeout(timer);
            stop();
          }
        });
        child.on("close", (code) => {
          if (completed) return;
          if (code !== 0) finish(new Error("Script Hook process exited unsuccessfully"));
          else {
            try { finish(null, parseDecision(Buffer.concat(chunks).toString("utf8"), context.stage)); }
            catch { finish(new Error("Script Hook returned an invalid decision")); }
          }
        });
        child.stdin.end(body);
      });
    }
  };
}

export async function loadRuntimeHookAdapters(path, options = {}) {
  if (!path) return [];
  const buffer = await readFile(path);
  if (buffer.length > 64 * 1024) throw new Error("Hook configuration exceeds 64 KiB");
  const inputs = JSON.parse(buffer.toString("utf8"));
  if (!Array.isArray(inputs) || inputs.length > 32) throw new Error("Hook configuration must contain at most 32 adapters");
  if (new Set(inputs.map((input) => input.id)).size !== inputs.length) throw new Error("Duplicate Hook adapter id");
  return inputs.map((input) => {
    if (input.type === "http") return createHttpRunController(input, options);
    if (input.type === "script") return createScriptRunController(input, options);
    throw new Error("Unsupported Hook adapter type");
  });
}
