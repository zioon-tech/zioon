#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Sandbox } from "../packages/sandbox/node_modules/e2b/dist/index.mjs";

const resources = JSON.parse(await readFile(new URL("../deploy/sandbox/agenticfs-poc.resources.json", import.meta.url), "utf8"));
const saved = JSON.parse(execFileSync("security", [
  "find-generic-password", "-s", "dev.zion.sandbox-poc",
  "-a", `aliyun:${resources.region}:${resources.teamId}`, "-w"
], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const options = {
  apiKey: saved.apiKey,
  apiUrl: `https://api.${resources.region}.sandbox.aliyuncs.com`,
  domain: `${resources.region}.sandbox.aliyuncs.com`,
  requestTimeoutMs: 60_000
};
const marker = `zion-verification-${randomUUID()}`;
const live = new Set();
const report = { marker, checks: [], status: "running", cleanup: [] };
async function create(workspace, role = workspace.roleArn) {
  const sandbox = await Sandbox.create(resources.templateId, {
    ...options, timeoutMs: 300_000, secure: true,
    network: {
      allowOut: ["10.88.1.0/24", "100.100.2.136/32", "100.100.2.138/32"]
    },
    metadata: {
      "zion.poc": "1", "zion.requestKey": marker,
      "fc.sandbox.auth.role": role,
      "fc.sandbox.network.vpc": JSON.stringify({
        vpcId: resources.vpcId, securityGroupId: resources.securityGroupId,
        vSwitchIds: [resources.vSwitchId]
      }),
      "fc.sandbox.storage.agenticfs": JSON.stringify({
        userID: 0, groupID: 0,
        mountPoints: [{ serverAddr: workspace.serverAddr, mountDir: "/workspace" }]
      })
    }
  });
  live.add(sandbox);
  return sandbox;
}
async function check(sandbox, name, command) {
  const started = Date.now();
  try {
    const result = await sandbox.commands.run(command, { user: "root", timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new Error("Nonzero exit");
    report.checks.push({ name, passed: true, output: result.stdout, durationMs: Date.now() - started });
    console.log(name, "passed");
  } catch (error) {
    report.checks.push({ name, passed: false, error: error.name, durationMs: Date.now() - started });
    throw error;
  }
}
async function destroy(sandbox) {
  await sandbox.kill();
  live.delete(sandbox);
}
try {
  let a = await create(resources.workspaces[0]);
  await check(a, "real-nfs-mount", "findmnt -n -o FSTYPE /workspace | grep -x nfs");
  await check(a, "write-fsync", `python3 -c "import os; f=open('/workspace/${marker}.txt','w'); f.write('persistent-data'); f.flush(); os.fsync(f.fileno()); f.close()"`);
  await destroy(a);
  a = await create(resources.workspaces[0]);
  await check(a, "hard-destroy-rebuild", `test "$(cat /workspace/${marker}.txt)" = persistent-data`);
  await a.pause();
  const paused = await Sandbox.getInfo(a.sandboxId, options);
  if (paused.state !== "paused") throw new Error("Not paused");
  await a.connect();
  await check(a, "pause-resume", `test "$(cat /workspace/${marker}.txt)" = persistent-data`);
  const b = await create(resources.workspaces[1]);
  await check(b, "workspace-b-isolation", `test ! -e /workspace/${marker}.txt && test ! -e /workspace/../zion_poc_a/${marker}.txt`);
  await check(a, "rename-and-fsync", `python3 -c "import os; os.rename('/workspace/${marker}.txt','/workspace/${marker}.renamed'); assert open('/workspace/${marker}.renamed').read()=='persistent-data'; d=os.open('/workspace',os.O_RDONLY); os.fsync(d); os.close(d)"`);
  await check(a, "git-workspace", `mkdir /workspace/${marker}-git && cd /workspace/${marker}-git && git init -q && echo probe > file.txt && git add file.txt && git -c user.name=Zion -c user.email=poc@example.invalid commit -qm probe && git status --porcelain`);
  await check(a, "remove-test-assets", `rm -rf -- /workspace/${marker}-git; rm -- /workspace/${marker}.renamed`);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.name;
  console.error("Verification failed:", error.name);
} finally {
  for (const sandbox of live) {
    try { await destroy(sandbox); report.cleanup.push({ sandboxId: sandbox.sandboxId, destroyed: true }); }
    catch { report.cleanup.push({ sandboxId: sandbox.sandboxId, destroyed: false }); report.status = "cleanup-unresolved"; }
  }
  await writeFile(process.argv[2] || "/tmp/zion-agenticfs-verification.json", JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
  if (report.status !== "passed") process.exitCode = 1;
}
