#!/usr/bin/env node
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REGION = "cn-shanghai";
const DEFAULT_INSTANCE_ID = "i-uf6dkbxlai8d1zr81859";
const DEFAULT_PUBLIC_URL = "https://runtime.zioon.tech";
const CHUNK_SIZE = 18 * 1024;

function usage() {
  return `Usage:
  npm run deploy:patch -- --files <path> [--files <path> ...] [--dist] [--build] [--execute]

Examples:
  npm run deploy:patch -- --build --dist \\
    --files extensions/dev.skills/skills-runtime-state.js \\
    --files apps/runtime/src/skills-catalog-http-handler.mjs

  printf '%s\\n' "$ALIYUN_ECS_CREDENTIAL" | npm run deploy:patch -- \\
    --execute --dist --files docs/operations/HANDOFF-SKILLS-SYNC-20260915.md

Options:
  --files <path[,path]>       Source files to patch under /opt/zion-next.
  --files-from <path>         Newline-delimited source file list.
  --dist                      Package and atomically replace Workbench dist/.
  --build                     Run npm run build:all before packaging dist; otherwise npm run build.
  --identity-plugin <zip>     Upload and install a dev.identity Runtime plugin archive.
  --install-systemd-units     Install included deploy/systemd/*.service files and daemon-reload.
  --test <command>            Run a local preflight command before packaging. Repeatable.
  --execute                   Upload artifacts and run the remote deployment.
  --release <id>              Release id. Defaults to production-patch-<utc timestamp>.
  --region <id>               ECS region. Default: ${DEFAULT_REGION}
  --instance-id <id>          ECS instance id. Default: ${DEFAULT_INSTANCE_ID}
  --public-url <url>          Public health URL. Default: ${DEFAULT_PUBLIC_URL}
  --require-marker <text>     Require text in the new desktop dev.skills bundle. Repeatable.
  --forbid-marker <text>      Reject text in the new desktop dev.skills bundle. Repeatable.
  --no-restart                Do not restart zion-runtime after applying files.
  --keep-stage                Keep remote /tmp staging files after success.
  --help                      Show this help.

Credentials:
  Prefer stdin or ALIYUN_ECS_CREDENTIAL. The combined credential format is
  <AccessKeyId><AccessKeySecret>. ALIYUN_ACCESS_KEY_ID and
  ALIYUN_ACCESS_KEY_SECRET are also supported. Credentials are never written
  into generated files.`;
}

function fail(message) {
  console.error(`deploy: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    files: [],
    filesFrom: [],
    tests: [],
    includeDist: false,
    identityPluginArchive: "",
    installSystemdUnits: false,
    build: false,
    execute: false,
    keepStage: false,
    restart: true,
    release: "",
    region: DEFAULT_REGION,
    instanceId: DEFAULT_INSTANCE_ID,
    publicUrl: DEFAULT_PUBLIC_URL,
    requireMarkers: [],
    forbidMarkers: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value || value.startsWith("--")) fail(`missing value for ${arg}`);
      return value;
    };
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--files" || arg === "--file") {
      args.files.push(...next().split(",").map((item) => item.trim()).filter(Boolean));
    } else if (arg === "--files-from") {
      args.filesFrom.push(next());
    } else if (arg === "--dist") {
      args.includeDist = true;
    } else if (arg === "--build") {
      args.build = true;
    } else if (arg === "--identity-plugin") {
      args.identityPluginArchive = next();
    } else if (arg === "--install-systemd-units") {
      args.installSystemdUnits = true;
    } else if (arg === "--test") {
      args.tests.push(next());
    } else if (arg === "--execute") {
      args.execute = true;
    } else if (arg === "--keep-stage") {
      args.keepStage = true;
    } else if (arg === "--no-restart") {
      args.restart = false;
    } else if (arg === "--release") {
      args.release = next();
    } else if (arg === "--region") {
      args.region = next();
    } else if (arg === "--instance-id") {
      args.instanceId = next();
    } else if (arg === "--public-url") {
      args.publicUrl = next().replace(/\/+$/, "");
    } else if (arg === "--require-marker") {
      args.requireMarkers.push(next());
    } else if (arg === "--forbid-marker") {
      args.forbidMarkers.push(next());
    } else if (arg.startsWith("--")) {
      fail(`unknown option: ${arg}`);
    } else {
      args.files.push(arg);
    }
  }
  return args;
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function sh(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function bashArray(name, values) {
  const body = values.map((value) => `  ${sh(value)}`).join("\n");
  return `${name}=(\n${body}\n)`;
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1", ...options.env }
  });
  if (result.status !== 0) {
    fail(`${command} exited with ${result.status}`);
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function credentials() {
  const explicitId = process.env.ALIYUN_ACCESS_KEY_ID;
  const explicitSecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
  if (explicitId && explicitSecret) {
    return { accessKeyId: explicitId, accessKeySecret: explicitSecret };
  }
  const combined = (process.env.ALIYUN_ECS_CREDENTIAL || await readStdin()).trim();
  if (!combined) fail("missing credentials; provide ALIYUN_ECS_CREDENTIAL or pipe the combined AK/SK");
  if (!combined.startsWith("LTAI") || combined.length <= 30) {
    fail("invalid combined credential format");
  }
  return {
    accessKeyId: combined.slice(0, 24),
    accessKeySecret: combined.slice(24)
  };
}

function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/g, "~");
}

function canonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join("&");
}

export class EcsClient {
  constructor({ region, instanceId, accessKeyId, accessKeySecret }) {
    this.region = region;
    this.instanceId = instanceId;
    this.accessKeyId = accessKeyId;
    this.accessKeySecret = accessKeySecret;
    this.uploadTokenPrefix = randomUUID();
  }

  async request(action, params = {}) {
    const payload = {
      Action: action,
      Version: "2014-05-26",
      Format: "JSON",
      RegionId: this.region,
      AccessKeyId: this.accessKeyId,
      SignatureMethod: "HMAC-SHA1",
      SignatureVersion: "1.0",
      SignatureNonce: randomUUID(),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      ...params
    };
    const stringToSign = `POST&${percentEncode("/")}&${percentEncode(canonicalQuery(payload))}`;
    const signature = createHmac("sha1", `${this.accessKeySecret}&`)
      .update(stringToSign)
      .digest("base64");
    const body = canonicalQuery({ ...payload, Signature: signature });
    const response = await fetch("https://ecs.aliyuncs.com/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
    const text = await response.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Aliyun ${action} returned non-JSON response: ${text.slice(0, 160)}`);
    }
    if (!response.ok || json.Code) {
      throw new Error(`Aliyun ${action} failed: ${json.Code || response.status} ${json.Message || ""}`.trim());
    }
    return json;
  }

  async runScript(script, timeout = 300) {
    const response = await this.request("RunCommand", {
      Type: "RunShellScript",
      CommandContent: Buffer.from(script).toString("base64"),
      ContentEncoding: "Base64",
      "InstanceId.1": this.instanceId,
      Timeout: timeout,
      WorkingDir: "/root"
    });
    return await this.waitFor(response.InvokeId, (timeout + 60) * 1000);
  }

  async waitFor(invokeId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await this.request("DescribeInvocationResults", {
        InvokeId: invokeId,
        "InstanceId.1": this.instanceId
      });
      const item = result?.Invocation?.InvocationResults?.InvocationResult?.[0];
      if (item && ["Success", "Finished", "Failed", "Stopped"].includes(item.InvocationStatus)) {
        return {
          status: item.InvocationStatus,
          exitCode: Number(item.ExitCode),
          output: item.Output ? Buffer.from(item.Output, "base64").toString("utf8") : "",
          errorCode: item.ErrorCode || ""
        };
      }
      if (Date.now() >= deadline) throw new Error("Cloud command timed out");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000));
    }
  }

  async sendChunks(filePath, targetDir) {
    const data = await readFile(filePath);
    const name = basename(filePath);
    const parts = Math.ceil(data.length / CHUNK_SIZE);
    for (let index = 0; index < parts; index += 1) {
      const chunk = data.subarray(index * CHUNK_SIZE, Math.min(data.length, (index + 1) * CHUNK_SIZE));
      const response = await this.request("SendFile", {
        Name: `${name}.part-${String(index).padStart(4, "0")}`,
        Description: `Zion deployment part ${index + 1}/${parts}`,
        TargetDir: targetDir,
        Content: chunk.toString("base64"),
        ContentType: "Base64",
        "InstanceId.1": this.instanceId,
        FileOwner: "root",
        FileGroup: "root",
        FileMode: "600",
        Overwrite: true,
        Timeout: 120,
        ClientToken: createHash("sha256")
          .update(`${this.uploadTokenPrefix}:${targetDir}:${name}:${index}:`)
          .update(chunk)
          .digest("hex")
      });
      await this.waitForSendFile(response.InvokeId, name, index, parts);
    }
    return {
      file: name,
      parts,
      bytes: data.length,
      sha256: sha256(data)
    };
  }

  async waitForSendFile(invokeId, name, index, parts, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await this.request("DescribeSendFileResults", {
        InvokeId: invokeId,
        InstanceId: this.instanceId,
        MaxResults: 10
      });
      const item = result?.Invocations?.Invocation?.[0];
      const instance = item?.InvokeInstances?.InvokeInstance?.[0];
      const status = String(instance?.InvocationStatus || item?.InvocationStatus || "");
      if (["Success", "Finished"].includes(status)) return;
      if (["Failed", "Stopped", "Timeout"].includes(status)) {
        throw new Error(
          `SendFile failed for ${name} part ${index + 1}/${parts}: `
          + `${status} ${instance?.ErrorCode || ""} ${instance?.ErrorInfo || ""}`.trim()
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(`SendFile timed out for ${name} part ${index + 1}/${parts}`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    }
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(args) {
  const files = [];
  for (const listPath of args.filesFrom) {
    const text = await readFile(resolve(ROOT, listPath), "utf8");
    files.push(...text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")));
  }
  files.push(...args.files);
  const unique = [];
  const seen = new Set();
  for (const file of files) {
    const absolute = resolve(ROOT, file);
    const repoPath = relative(ROOT, absolute).replace(/\\/g, "/");
    if (!repoPath || repoPath.startsWith("../") || repoPath === ".") fail(`file must be inside repository: ${file}`);
    if (!await fileExists(absolute)) fail(`file does not exist: ${repoPath}`);
    const info = await stat(absolute);
    if (!info.isFile()) fail(`source path must be a file: ${repoPath}`);
    if (!seen.has(repoPath)) {
      seen.add(repoPath);
      unique.push(repoPath);
    }
  }
  return unique;
}

function remoteDeployScript({
  release,
  sourceArchiveName,
  sourceSha,
  distArchiveName,
  distSha,
  identityPluginArchiveName,
  identityPluginSha,
  includeSource,
  includeDist,
  includeIdentityPlugin,
  sourceFiles,
  publicUrl,
  requireMarkers,
  forbidMarkers,
  keepStage,
  restart,
  installSystemdUnits
}) {
  const cleanupTargets = [
    includeSource ? '"$source_archive"' : null,
    includeDist ? '"$dist_archive"' : null,
    includeIdentityPlugin ? '"$identity_plugin_archive"' : null
  ].filter(Boolean).join(" ");
  const sourceBlock = includeSource ? `
tar -tzf "$source_archive" >"$backup/source-files.txt"
while IFS= read -r file; do
  [ -n "$file" ] || continue
  [ -f "$root/$file" ] || { printf '%s\\n' "$file" >>"$backup/new-files.txt"; continue; }
  install -d -m 0700 "$backup/files/$(dirname "$file")"
  cp -a "$root/$file" "$backup/files/$file"
done <"$backup/source-files.txt"
` : "";
  const distPrepareBlock = includeDist ? `
cp -a "$dist_root" "$backup/workbench-dist"
rm -rf "$next_dist"
install -d -m 0755 "$next_dist"
tar -xzf "$dist_archive" -C "$next_dist"
find "$next_dist" -name '._*' -type f -delete
test -f "$next_dist/index.html"
test -f "$next_dist/mobile/index.html"
current_bundle="$(grep -o 'assets/extensions/dev.skills/main-[^"]*\\.js' "$next_dist/index.html" | head -n 1 || true)"
if [ -n "$current_bundle" ]; then
  test -f "$next_dist/$current_bundle"
  for marker in "\${require_markers[@]}"; do
    grep -F -q -- "$marker" "$next_dist/$current_bundle"
  done
  for marker in "\${forbid_markers[@]}"; do
    if grep -F -q -- "$marker" "$next_dist/$current_bundle"; then
      printf 'forbidden marker still present in %s: %s\\n' "$current_bundle" "$marker" >&2
      exit 1
    fi
  done
fi
chown -R zion:zion "$next_dist"
` : "current_bundle=\"\"";
  const identityPluginInstallBlock = includeIdentityPlugin ? `
install -d -o zion -g zion -m 0755 "$plugin_root"
install -d -m 0700 "$backup/plugins"
if [ -d "$plugin_root/dev.identity" ]; then
  cp -a "$plugin_root/dev.identity" "$backup/plugins/dev.identity"
else
  touch "$backup/plugins/dev.identity.missing"
fi
chmod 0755 "$stage"
chown zion:zion "$identity_plugin_archive"
chmod 0644 "$identity_plugin_archive"
sudo -u zion env HOME=/home/zion PATH=/usr/local/bin:/usr/bin:/bin \\
  /usr/local/bin/node "$root/scripts/install-runtime-plugin.mjs" \\
  --archive "$identity_plugin_archive" \\
  --plugin-root "$plugin_root" \\
  --plugin-id dev.identity
identity_plugin_installed=1
` : "";
  const systemdInstallBlock = installSystemdUnits ? `
install -d -m 0700 "$backup/systemd"
for file in "\${source_files[@]}"; do
  case "$file" in
    deploy/systemd/*.service)
      unit="$(basename "$file")"
      if [ -f "/etc/systemd/system/$unit" ]; then
        cp -a "/etc/systemd/system/$unit" "$backup/systemd/$unit"
      else
        printf '%s\\n' "$unit" >>"$backup/new-systemd-units.txt"
      fi
      cp "$root/$file" "/etc/systemd/system/$unit"
      chmod 0644 "/etc/systemd/system/$unit"
      systemd_installed=1
      ;;
  esac
done
if [ "$systemd_installed" -eq 1 ]; then
  systemctl daemon-reload
  for service in zion-local-tools zion-cloud-device-connector; do
    systemctl restart "$service" >/dev/null 2>&1 || true
  done
fi
` : "";
  const sourceInstallBlock = includeSource ? `
tar -xzf "$source_archive" -C "$root"
find "$root" -type d -exec chmod 0755 {} +
while IFS= read -r file; do
  [ -n "$file" ] || continue
  target="$root/$file"
  [ -e "$target" ] || continue
  chown zion:zion "$target"
  chmod u+rw,go+r "$target"
  case "$file" in
    *.js|*.mjs)
      sudo -u zion env HOME=/home/zion PATH=/usr/local/bin:/usr/bin:/bin \\
        /usr/local/bin/node --check "$target"
      ;;
  esac
done <"$backup/source-files.txt"
` : "";
  const distSwapBlock = includeDist ? `
rm -rf "$failed_dist"
mv "$dist_root" "$failed_dist"
mv "$next_dist" "$dist_root"
dist_swapped=1
chown -R zion:zion "$dist_root"
` : "";
  const archiveList = [
    includeSource ? sourceArchiveName : null,
    includeDist ? distArchiveName : null,
    includeIdentityPlugin ? identityPluginArchiveName : null
  ].filter(Boolean);
  const shaCheckLines = [
    includeSource
      ? `  printf '%s  %s\\n' ${sh(sourceSha)} "$source_archive"`
      : null,
    includeDist
      ? `  printf '%s  %s\\n' ${sh(distSha)} "$dist_archive"`
      : null,
    includeIdentityPlugin
      ? `  printf '%s  %s\\n' ${sh(identityPluginSha)} "$identity_plugin_archive"`
      : null
  ].filter(Boolean).join("\n");
  const stopBlock = restart ? "systemctl stop zion-runtime" : ":";
  const startBlock = restart ? "systemctl start zion-runtime" : ":";
  const rollbackStopBlock = restart ? "systemctl stop zion-runtime" : ":";
  const rollbackStartBlock = restart ? "systemctl start zion-runtime" : ":";
  return `#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

release=${sh(release)}
stage="/tmp/zion-$release"
backup="/var/lib/zion-next/backups/$release"
root="/opt/zion-next"
dist_root="/var/lib/zion-next/workbench-dist"
next_dist="/var/lib/zion-next/workbench-dist.next-$release"
failed_dist="$backup/failed-dist"
source_archive="$stage/${sourceArchiveName}"
dist_archive="$stage/${distArchiveName}"
identity_plugin_archive="$stage/${identityPluginArchiveName}"
plugin_root="/var/lib/zion-next/plugins"
public_url=${sh(publicUrl)}
dist_swapped=0
identity_plugin_installed=0
systemd_installed=0
${bashArray("archives", archiveList)}
${bashArray("require_markers", requireMarkers)}
${bashArray("forbid_markers", forbidMarkers)}
${bashArray("source_files", sourceFiles)}

rollback() {
  status=$?
  trap - ERR
  set +e
  printf 'release=%s status=failed line=%s exit=%s\\n' \\
    "$release" "\${BASH_LINENO[0]:-unknown}" "$status" >&2
  ${rollbackStopBlock}
  if [ -f "$backup/new-files.txt" ]; then
    while IFS= read -r file; do
      [ -n "$file" ] && rm -f "$root/$file"
    done <"$backup/new-files.txt"
  fi
  if [ -d "$backup/files" ]; then
    (cd "$backup/files" && tar -cf - .) | (cd "$root" && tar -xf -)
    chown -R zion:zion "$root"
  fi
  if [ "$dist_swapped" -eq 1 ] && [ -d "$backup/workbench-dist" ]; then
    rm -rf "$dist_root"
    cp -a "$backup/workbench-dist" "$dist_root"
    chown -R zion:zion "$dist_root"
  fi
  if [ "$identity_plugin_installed" -eq 1 ]; then
    rm -rf "$plugin_root/dev.identity"
    if [ -d "$backup/plugins/dev.identity" ]; then
      cp -a "$backup/plugins/dev.identity" "$plugin_root/dev.identity"
      chown -R zion:zion "$plugin_root/dev.identity"
    fi
  fi
  if [ "$systemd_installed" -eq 1 ]; then
    if [ -f "$backup/new-systemd-units.txt" ]; then
      while IFS= read -r unit; do
        [ -n "$unit" ] && rm -f "/etc/systemd/system/$unit"
      done <"$backup/new-systemd-units.txt"
    fi
    if [ -d "$backup/systemd" ]; then
      for unit_file in "$backup/systemd"/*.service; do
        [ -e "$unit_file" ] || continue
        cp -a "$unit_file" "/etc/systemd/system/$(basename "$unit_file")"
      done
    fi
    systemctl daemon-reload
    for service in zion-local-tools zion-cloud-device-connector; do
      systemctl restart "$service" >/dev/null 2>&1 || true
    done
  fi
  rm -rf "$next_dist"
  ${rollbackStartBlock}
  exit "$status"
}
trap rollback ERR

test "$(id -u)" -eq 0
rm -rf "$backup"
install -d -m 0700 "$stage" "$backup/files"

shopt -s nullglob
for archive in "\${archives[@]}"; do
  parts=("$stage/$archive.part-"*)
  if [ "\${#parts[@]}" -eq 0 ]; then
    printf 'missing uploaded parts for %s\\n' "$archive" >&2
    exit 1
  fi
  cat "\${parts[@]}" >"$stage/$archive"
done
shopt -u nullglob

{
${shaCheckLines}
} | tee "$backup/sha256.txt" | sha256sum -c -
${sourceBlock}
find "$root" -type d -exec chmod 0755 {} +
${distPrepareBlock}
${stopBlock}
${sourceInstallBlock}
${identityPluginInstallBlock}
${systemdInstallBlock}
${distSwapBlock}
find "$root" "$dist_root" -name '._*' -type f -delete
${startBlock}
for attempt in $(seq 1 60); do
  if systemctl is-active --quiet zion-runtime \\
    && curl -fsS http://127.0.0.1:8766/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
systemctl is-active --quiet zion-runtime
curl -fsS http://127.0.0.1:8766/health >"$backup/health.json"
curl -k -fsS "$public_url/health" >"$backup/public-health.json"
curl -k -sS -o "$backup/snapshot-auth.txt" -w '%{http_code}\\n' "$public_url/v1/skills/snapshot" \\
  | grep -q '^401$'
test "$(find "$root" "$dist_root" -name '._*' -print | wc -l)" = "0"

for service in caddy zion-local-tools zion-plugin-host; do
  for attempt in $(seq 1 60); do
    if systemctl is-active --quiet "$service"; then
      break
    fi
    systemctl start "$service" >/dev/null 2>&1 || true
    sleep 2
  done
  systemctl is-active --quiet "$service"
done

trap - ERR
if [ ${keepStage ? "0" : "1"} -eq 1 ]; then
  rm -f "$stage"/*.part-* ${cleanupTargets}
fi
printf 'release=%s status=ok health=200 bundle=%s backup=%s\\n' \\
  "$release" "$current_bundle" "$backup"
`;
}

async function writeGenerated(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode: 0o600 });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.build) {
    run("npm", ["run", args.includeDist ? "build:all" : "build"]);
  }
  for (const command of args.tests) {
    run("bash", ["-lc", command]);
  }

  const sourceFiles = await collectFiles(args);
  if (!sourceFiles.length && !args.includeDist && !args.identityPluginArchive) {
    fail("nothing to deploy; pass --files/--files-from, --identity-plugin, and/or --dist");
  }

  const release = args.release || `production-patch-${utcStamp()}`;
  const releaseDir = join(ROOT, ".deploy-tmp", release);

  let identityPluginArchiveName = "";
  let identityPluginSha = "";
  let identityPluginBytes = null;
  if (args.identityPluginArchive) {
    const archivePath = resolve(ROOT, args.identityPluginArchive);
    if (!await fileExists(archivePath)) {
      fail(`identity plugin archive does not exist: ${relative(ROOT, archivePath)}`);
    }
    const info = await stat(archivePath);
    if (!info.isFile()) {
      fail(`identity plugin archive must be a file: ${relative(ROOT, archivePath)}`);
    }
    identityPluginArchiveName = basename(archivePath);
    identityPluginBytes = await readFile(archivePath);
    identityPluginSha = sha256(identityPluginBytes);
  }

  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });

  let sourceArchive = "";
  let sourceArchiveName = "";
  let sourceSha = "";
  if (sourceFiles.length) {
    sourceArchiveName = `source-${release}.tgz`;
    sourceArchive = join(releaseDir, sourceArchiveName);
    run("tar", ["--no-xattrs", "-czf", sourceArchive, ...sourceFiles]);
    sourceSha = sha256(await readFile(sourceArchive));
  }

  let distArchive = "";
  let distArchiveName = "";
  let distSha = "";
  if (args.includeDist) {
    if (!await fileExists(join(ROOT, "dist", "index.html"))) {
      fail("dist/index.html not found; run with --build or run npm run build first");
    }
    distArchiveName = `workbench-dist-${release}.tgz`;
    distArchive = join(releaseDir, distArchiveName);
    run("tar", ["--no-xattrs", "-czf", distArchive, "-C", "dist", "."]);
    distSha = sha256(await readFile(distArchive));
  }

  let identityPluginArchive = "";
  if (identityPluginBytes) {
    identityPluginArchive = join(releaseDir, identityPluginArchiveName);
    await writeFile(identityPluginArchive, identityPluginBytes, { mode: 0o600 });
  }

  const remoteScript = remoteDeployScript({
    release,
    sourceArchiveName,
    sourceSha,
    distArchiveName,
    distSha,
    identityPluginArchiveName,
    identityPluginSha,
    includeSource: sourceFiles.length > 0,
    includeDist: args.includeDist,
    includeIdentityPlugin: !!identityPluginArchive,
    sourceFiles,
    publicUrl: args.publicUrl,
    requireMarkers: args.requireMarkers,
    forbidMarkers: args.forbidMarkers,
    keepStage: args.keepStage,
    restart: args.restart,
    installSystemdUnits: args.installSystemdUnits
  });
  const remoteScriptPath = join(releaseDir, "remote-deploy.sh");
  await writeGenerated(remoteScriptPath, remoteScript);
  await writeFile(join(releaseDir, "source-files.txt"), `${sourceFiles.join("\n")}\n`);

  console.log(`release=${release}`);
  console.log(`stage=${relative(ROOT, releaseDir)}`);
  if (sourceArchive) console.log(`source=${relative(ROOT, sourceArchive)} sha256=${sourceSha}`);
  if (distArchive) console.log(`dist=${relative(ROOT, distArchive)} sha256=${distSha}`);
  if (identityPluginArchive) {
    console.log(`identity_plugin=${relative(ROOT, identityPluginArchive)} sha256=${identityPluginSha}`);
  }

  if (!args.execute) {
    console.log("dry_run=1");
    console.log("Add --execute and provide credentials via stdin or ALIYUN_ECS_CREDENTIAL to deploy.");
    return;
  }

  const creds = await credentials();
  const client = new EcsClient({
    region: args.region,
    instanceId: args.instanceId,
    ...creds
  });
  const remoteStage = `/tmp/zion-${release}`;
  console.log(`remote_stage=${remoteStage}`);

  let result = await client.runScript(`#!/usr/bin/env bash
set -Eeuo pipefail
rm -rf ${sh(remoteStage)}
install -d -m 0700 ${sh(remoteStage)}
printf 'stage=ready\\n'
`, 120);
  process.stdout.write(result.output);
  if (!["Success", "Finished"].includes(result.status) || result.exitCode !== 0) {
    fail(`remote staging failed: ${result.status}/${result.exitCode}`);
  }

  if (sourceArchive) {
    const sent = await client.sendChunks(sourceArchive, remoteStage);
    console.log(`sent=${sent.file} parts=${sent.parts} bytes=${sent.bytes} sha256=${sent.sha256}`);
  }
  if (distArchive) {
    const sent = await client.sendChunks(distArchive, remoteStage);
    console.log(`sent=${sent.file} parts=${sent.parts} bytes=${sent.bytes} sha256=${sent.sha256}`);
  }
  if (identityPluginArchive) {
    const sent = await client.sendChunks(identityPluginArchive, remoteStage);
    console.log(`sent=${sent.file} parts=${sent.parts} bytes=${sent.bytes} sha256=${sent.sha256}`);
  }
  {
    const sent = await client.sendChunks(remoteScriptPath, remoteStage);
    console.log(`sent=${sent.file} parts=${sent.parts} bytes=${sent.bytes} sha256=${sent.sha256}`);
  }

  result = await client.runScript(`#!/usr/bin/env bash
set -Eeuo pipefail
stage=${sh(remoteStage)}
script="$stage/remote-deploy.sh"
shopt -s nullglob
parts=("$script.part-"*)
if [ "\${#parts[@]}" -eq 0 ]; then
  printf 'missing uploaded parts for remote-deploy.sh\\n' >&2
  exit 1
fi
cat "\${parts[@]}" >"$script"
chmod 0700 "$script"
bash "$script"
`, 600);
  process.stdout.write(result.output);
  if (!["Success", "Finished"].includes(result.status) || result.exitCode !== 0) {
    fail(`remote deployment failed: ${result.status}/${result.exitCode}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    fail(error?.message || String(error));
  });
}
