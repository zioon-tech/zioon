#!/usr/bin/env node
// Augment an installed upstream CLI without patching its file commands.
import { access, readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
async function atomicWrite(path, content, mode) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", mode);
    await file.writeFile(content);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
  } finally {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

export async function installAgentfsLogin({
  prefix = join(homedir(), ".local"),
  bun = join(homedir(), ".bun/bin/bun"),
  archiveDir = join(prefix, "share/zion-agent-fs-cli-0.18.5"),
  upstreamCli
} = {}) {
  prefix = resolve(prefix);
  bun = resolve(bun);
  archiveDir = resolve(archiveDir);
  await access(bun, constants.X_OK);
  let launch;
  if (upstreamCli) {
    upstreamCli = resolve(upstreamCli);
    await access(upstreamCli, constants.R_OK);
    launch = `exec "$bun" ${quote(upstreamCli)} "$@"`;
  } else {
    const archive = join(archiveDir, "cli.tar.gz");
    await access(archive, constants.R_OK);
    const hash = (await readFile(join(archiveDir, "archive.sha256"), "utf8")).trim().split(/\s/)[0];
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid CLI archive SHA-256");
    launch = `archive=${quote(archive)}
cache="\${TMPDIR:-/tmp}/zion-agent-fs-cli-${hash.slice(0, 16)}"
cli="$cache/node_modules/@desplega.ai/agent-fs/dist/cli.js"
if [ ! -f "$cli" ]; then
  actual=$(sha256sum "$archive")
  actual=\${actual%% *}
  [ "$actual" = ${quote(hash)} ] || { echo "CLI archive checksum failed" >&2; exit 1; }
  stage=$(mktemp -d "\${TMPDIR:-/tmp}/agentfs-extract.XXXXXXXX")
  trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
  tar -xzf "$archive" -C "$stage"
  [ -f "$stage/node_modules/@desplega.ai/agent-fs/dist/cli.js" ] || exit 1
  if ! mv -T "$stage" "$cache" 2>/dev/null; then
    [ -f "$cli" ] || { echo "CLI cache restore failed" >&2; exit 1; }
    rm -rf -- "$stage"
  fi
  trap - EXIT HUP INT TERM
fi
exec "$bun" "$cli" "$@"`;
  }
  const bin = join(prefix, "bin");
  const helperDirectory = join(prefix, "share/zion-agent-fs-auth");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await mkdir(helperDirectory, { recursive: true, mode: 0o700 });
  const helper = join(helperDirectory, "login.mjs");
  await atomicWrite(helper, await readFile(new URL("./agentfs-login.mjs", import.meta.url)), 0o600);
  const wrapper = `#!/bin/sh
set -eu
bun=${quote(bun)}
login=${quote(helper)}
case "\${1:-}" in
  login|logout|status|whoami|auth) exec "$bun" "$login" "$@" ;;
  --json)
    case "\${2:-}" in
      login|logout|status|whoami|auth) exec "$bun" "$login" "$@" ;;
    esac ;;
  --help|-h) "$bun" "$login" help ;;
esac
${launch}
`;
  await atomicWrite(join(bin, "agent-fs"), wrapper, 0o755);
  await atomicWrite(join(bin, "zion-agentfs-login"), `#!/bin/sh
set -eu
exec ${quote(bun)} ${quote(helper)} login "$@"
`, 0o755);
  return { executable: join(bin, "agent-fs"), helper, archivePreserved: !upstreamCli };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    while (args.length) {
      const flag = args.shift();
      const keys = { "--prefix": "prefix", "--bun": "bun", "--archive-dir": "archiveDir", "--upstream-cli": "upstreamCli" };
      if (flag === "--help") {
        console.log("Install Zion login on an existing agent-fs CLI:\n"
          + "  node scripts/install-agentfs-login.mjs [--prefix <dir>] [--bun <file>]\n"
          + "    [--archive-dir <dir> | --upstream-cli <cli.js>]");
        process.exit(0);
      }
      const key = keys[flag];
      const value = args.shift();
      if (!key || !value || value.startsWith("-")) throw new Error("Invalid installer argument");
      options[key] = value;
    }
    console.log(JSON.stringify(await installAgentfsLogin(options)));
  } catch (error) {
    console.error(`agent-fs login install failed: ${error.message}`);
    process.exitCode = 1;
  }
}
