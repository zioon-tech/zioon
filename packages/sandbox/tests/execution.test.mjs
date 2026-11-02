import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { executionIdentity, executionCommand, cancelExecutionCommand } from "../src/execution.mjs";

const exec = promisify(execFile);
const linux = process.platform === "linux";
async function stop(execution) {
  const { stdout } = await exec("/bin/bash", ["--noprofile", "--norc", "-c", cancelExecutionCommand(execution)]);
  assert.equal(JSON.parse(stdout).stopped, true);
}
async function cleanup(execution) {
  const paths = executionIdentity(execution.id);
  await Promise.all([paths.record, paths.cancel].map((path) => rm(path, { force: true })));
}
function launch(command, execution) {
  const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", executionCommand(command, execution, { internal: true })], {
    env: { ...process.env, ZION_EXECUTION_ID: execution.id }, stdio: "ignore"
  });
  const ended = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, ended };
}
async function waitForRecord(execution) {
  for (let i = 0; i < 200; i++) {
    try { return JSON.parse(await readFile(executionIdentity(execution.id).record, "utf8")); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await delay(10);
  }
  throw new Error("Process session did not start");
}

test("execution ids cannot alter owned record paths", () => {
  assert.throws(() => executionIdentity("../../other"), /Invalid/);
});

test("cancelling a process group stops children while a concurrent session survives", { skip: !linux }, async () => {
  const first = { id: randomUUID() };
  const second = { id: randomUUID() };
  const operation = launch("sleep 60 & sleep 60 & wait", first);
  const survivor = launch("sleep 60 & wait", second);
  try {
    const own = await waitForRecord(first);
    await waitForRecord(second);
    await stop(first);
    await operation.ended;
    assert.equal(survivor.child.exitCode, null);
    const { stdout } = await exec("/usr/bin/python3", ["-c",
      `import pathlib
found=False
for p in pathlib.Path('/proc').iterdir():
    if not p.name.isdigit(): continue
    try: s=(p/'stat').read_text().rsplit(')',1)[1].split()
    except (FileNotFoundError,ProcessLookupError): continue
    if s[0]!='Z' and int(s[2])==${own.pid}: found=True
print(found)`
    ]);
    assert.equal(stdout.trim(), "False");
  } finally {
    await stop(first);
    await stop(second);
    await survivor.ended;
    await cleanup(first);
    await cleanup(second);
  }
});

test("cancel markers fence delayed starts after a lost acknowledgement", { skip: !linux }, async () => {
  const execution = { id: randomUUID() };
  const effect = `/tmp/zion-effect-${execution.id}`;
  try {
    await stop(execution);
    const late = launch(`printf effect > '${effect}'`, execution);
    assert.equal((await late.ended).code, 125);
    await assert.rejects(readFile(effect), { code: "ENOENT" });
  } finally {
    await cleanup(execution);
    await rm(effect, { force: true });
  }
});

test("cleanup finds an inherited process group even after its original shell has exited", { skip: !linux }, async () => {
  const execution = { id: randomUUID() };
  try {
    const operation = launch("sleep 60 >/dev/null 2>&1 & exit 0", execution);
    await operation.ended;
    await stop(execution);
  } finally {
    await stop(execution);
    await cleanup(execution);
  }
});
