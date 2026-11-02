import { spawn } from "node:child_process";

// No shell, inherited application environment, or unbounded buffered output.
export async function runAnalysisProcess(executable, args, {
  signal, timeoutMs = 30_000, maxBytes = 30_000, authorize = () => {},
  cwd, env = { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin", LANG: "C.UTF-8" }
} = {}) {
  signal?.throwIfCancelled();
  await authorize();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    let bytes = 0;
    let truncated = false;
    let failure;
    let done = false;
    const kill = (error) => { failure ||= error; child.kill("SIGKILL"); };
    const accept = (chunk) => {
      const remaining = Math.max(0, maxBytes - bytes);
      if (remaining) output.push(chunk.subarray(0, remaining));
      bytes += Math.min(remaining, chunk.length);
      if (chunk.length > remaining) {
        truncated = true;
        kill(Object.assign(new Error("analysis_output_limit"), { code: "analysis_output_limit" }));
      }
    };
    child.stdout.on("data", accept);
    child.stderr.on("data", accept);
    const timer = setTimeout(() => kill(new Error("analysis_timeout")), timeoutMs);
    let authorizing = false;
    const guard = setInterval(() => {
      if (authorizing || done) return;
      authorizing = true;
      Promise.resolve()
        .then(() => authorize())
        .catch((error) => kill(error))
        .finally(() => { authorizing = false; });
    }, 250);
    const cancellation = signal?.onCancel(() => kill(new Error("analysis_cancelled")));
    const finish = async (error, code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(guard);
      cancellation?.dispose();
      if (error) reject(error);
      else if (failure && !truncated) reject(failure);
      else {
        try { await authorize(); } catch (denied) { reject(denied); return; }
        resolve({ ok: code === 0 && !truncated, code, output: Buffer.concat(output).toString("utf8"), truncated });
      }
    };
    child.on("error", (error) => { void finish(error); });
    child.on("close", (code) => { void finish(null, code); });
  });
}
