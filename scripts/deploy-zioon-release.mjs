#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { credentials, EcsClient } from "./deploy-production-patch.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "../../ZIOON-RELEASE-20261025");
const argv = process.argv.slice(2);
if (argv.includes("--help") || (!argv.includes("--preflight") && !argv.includes("--execute"))) {
  console.log("Usage: node scripts/deploy-zioon-release.mjs --preflight | --execute\n"
    + "Uses prepared ZIOON-RELEASE-20261025 artifacts. --execute runs preflight before applying.\n"
    + "Provide temporary ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET or combined credential via stdin.\n"
    + "No credentials are persisted.");
} else {
  const client = new EcsClient({ region: "cn-shanghai", instanceId: "i-uf6dkbxlai8d1zr81859", ...await credentials() });
  const run = async (script, timeout) => {
    const result = await client.runScript(script, timeout);
    process.stdout.write(result.output || "");
    if (!["Success", "Finished"].includes(result.status) || result.exitCode !== 0) throw new Error(`Remote operation failed (${result.status}/${result.exitCode})`);
  };
  const stamp = `zioon-20261025-${Date.now()}`;
  const stage = `/tmp/${stamp}`;
  await run(`#!/bin/bash\nset -eu\ninstall -d -m 0700 '${stage}'\ntest -d /opt/zion-next\ntest -f /etc/caddy/Caddyfile\nsystemctl is-active --quiet zion-runtime\ncurl -fsS http://127.0.0.1:8766/health >/dev/null\nprintf 'Production preconditions ready\\n'\n`, 60);
  for (const file of ["zioon-release-20261025.tgz", "apply-zioon-release.sh"]) {
    const sent = await client.sendChunks(resolve(directory, file), stage);
    console.log(`Uploaded ${file}; sha256=${sent.sha256}; bytes=${sent.bytes}`);
    await run(`#!/bin/bash\nset -eu\ncd '${stage}'\ncat '${file}'.part-* > '${file}'\nprintf '%s  %s\\n' '${sent.sha256}' '${file}' | sha256sum -c -\nrm -f '${file}'.part-*\n`, 60);
  }
  const hash = createHash("sha256").update(await readFile(resolve(directory, "zioon-release-20261025.tgz"))).digest("hex");
  await run(`#!/bin/bash\nset -eu\ncd '${stage}'\nprintf '%s  %s\\n' '${hash}' 'zioon-release-20261025.tgz' | sha256sum -c -\nbash apply-zioon-release.sh zioon-release-20261025.tgz --preflight\n`, 180);
  if (argv.includes("--execute")) {
    await run(`#!/bin/bash\nset -eu\ncd '${stage}'\nbash apply-zioon-release.sh zioon-release-20261025.tgz --apply\n`, 300);
  }
}
