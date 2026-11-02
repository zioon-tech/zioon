#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

archive="${1:?Usage: apply-zioon-release.sh release.tgz --preflight|--apply}"
mode="${2:---preflight}"
[[ "$mode" == "--preflight" || "$mode" == "--apply" ]] || exit 2
[[ "$(id -u)" == 0 ]] || { echo "Run deployment as root." >&2; exit 1; }
archive="$(realpath "$archive")"
release="zioon-20261025"
stage="$(mktemp -d "/tmp/$release.XXXXXXXX")"
root="/opt/zion-next"
backup="/var/lib/zion-next/backups/$release-$(date -u +%Y%m%dT%H%M%SZ)"
site_release="/srv/zioon-public/releases/$release"
dist_root="/var/lib/zion-next/workbench-dist"
source_changed=0
dist_changed=0
site_changed=0
caddy_changed=0
dependency_changed=0
unit_changed=0
committed=0
runtime_stopped=0
cleanup() {
  local code=$?
  trap - EXIT
  if [[ "$code" != 0 && "$committed" == 0 && -d "$backup" && ( "$runtime_stopped" == 1 || "$source_changed" == 1 || "$dist_changed" == 1 || "$site_changed" == 1 || "$caddy_changed" == 1 || "$dependency_changed" == 1 || "$unit_changed" == 1 ) ]]; then
    echo "Deployment failed; restoring source and routes." >&2
    systemctl stop zion-runtime || true
    if [[ "$source_changed" == 1 ]]; then
      cp -a "$backup/source/." "$root/"
      while IFS= read -r path; do rm -f "$root/$path"; done < "$backup/new-files.txt"
    fi
    if [[ "$dist_changed" == 1 ]]; then
      rm -rf "$dist_root"
      mv "$backup/workbench-dist" "$dist_root"
    fi
    if [[ "$dependency_changed" == 1 ]]; then
      rm -rf "$root/packages/sandbox/node_modules"
      [[ ! -e "$backup/sandbox-node_modules" && ! -L "$backup/sandbox-node_modules" ]] || mv "$backup/sandbox-node_modules" "$root/packages/sandbox/node_modules"
    fi
    if [[ "$site_changed" == 1 ]]; then
      rm -f /srv/zioon-public/current
      [[ ! -L "$backup/site-current" ]] || cp -a "$backup/site-current" /srv/zioon-public/current
    fi
    if [[ "$caddy_changed" == 1 ]]; then
      cp -a "$backup/Caddyfile" /etc/caddy/Caddyfile
      caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
      systemctl reload caddy || true
    fi
    if [[ "$unit_changed" == 1 ]]; then
      cp -a "$backup/zion-runtime.service" /etc/systemd/system/zion-runtime.service
      systemctl daemon-reload
    fi
    systemctl start zion-runtime || true
    echo "Backup remains at $backup" >&2
  fi
  rm -rf "$stage"
  exit "$code"
}
trap cleanup EXIT
tar -xzf "$archive" -C "$stage"
python3 - "$stage" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
manifest=json.loads((root/'manifest.json').read_text())
for name,digest in manifest['files'].items():
    p=root/name
    if p.is_symlink() or not p.is_file() or '..' in pathlib.PurePosixPath(name).parts:
        raise SystemExit('Unsafe release path')
    if hashlib.sha256(p.read_bytes()).hexdigest()!=digest:
        raise SystemExit('Release checksum mismatch')
print('Release manifest verified')
PY
test -f "$root/apps/runtime/src/main.mjs"
test -f "$dist_root/index.html"
test -f /etc/caddy/Caddyfile
systemctl is-active --quiet zion-runtime
curl -fsS http://127.0.0.1:8766/health >/dev/null
for package in "$stage/source/apps/runtime/src/main.mjs" "$stage/source/apps/runtime/src/server.mjs"; do
  node --check "$package"
done

# Replace precisely one standalone host block; reject unfamiliar multi-host
# arrangements before mutating Runtime or Caddy.
node "$stage/release-preflight.mjs" --caddy /etc/caddy/Caddyfile "$stage/website.caddy" "$stage/Caddyfile"
caddy validate --config "$stage/Caddyfile" --adapter caddyfile >/dev/null
python3 - /etc/systemd/system/zion-runtime.service "$stage/zion-runtime.service" <<'PY'
from pathlib import Path
import re,sys
source,target=map(Path,sys.argv[1:])
text=source.read_text()
pattern=r'(--runtime-plugins[ \t]+)([a-zA-Z0-9.,_-]+)'
matches=list(re.finditer(pattern,text))
if len(matches)!=1: raise SystemExit('Expected one explicit Runtime plugin list')
plugins=matches[0][2].split(',')
if 'dev.agent-device-cloud' not in plugins: plugins.append('dev.agent-device-cloud')
target.write_text(re.sub(pattern,lambda match:match[1]+','.join(plugins),text))
PY

# Resolve existing production dependencies without reading or printing secrets.
if ! node --input-type=module - "$root" <<'JS'
import {createRequire} from "node:module";
const require=createRequire(`${process.argv[2]}/packages/sandbox/package.json`);
try { require.resolve("e2b"); } catch { process.exit(1); }
JS
then
  # Install the fixed lockfile into temporary staging only. Other production
  # dependency changes require inspecting the existing deployment first.
  npm ci --prefix "$stage/source/packages/sandbox" --omit=dev --ignore-scripts --no-audit --no-fund
fi
node "$stage/release-preflight.mjs" --dependencies "$root" "$stage"
if [[ -d "$stage/source/packages/sandbox/node_modules" ]]; then
  mv "$stage/source/packages/sandbox/node_modules" "$stage/sandbox-node_modules"
fi
if [[ "$mode" == "--preflight" ]]; then
  echo "Preflight passed. No production files changed."
  exit 0
fi

install -d -m 0700 "$backup/source"
cp -a /etc/caddy/Caddyfile "$backup/Caddyfile"
cp -a /etc/systemd/system/zion-runtime.service "$backup/zion-runtime.service"
[[ ! -L /srv/zioon-public/current ]] || cp -a /srv/zioon-public/current "$backup/site-current"
touch "$backup/new-files.txt"
while IFS= read -r path; do
  if [[ -f "$root/$path" ]]; then
    install -d -m 0700 "$backup/source/$(dirname "$path")"
    cp -a "$root/$path" "$backup/source/$path"
  else
    printf '%s\n' "$path" >> "$backup/new-files.txt"
  fi
done < <(cd "$stage/source" && find . -type f -print | sed 's|^\./||')
cp -a "$dist_root" "$backup/workbench-dist"
install -d -m 0755 /srv/zioon-public/releases
[[ ! -e "$site_release" ]] || { echo "Release directory exists; preserve it and choose a new release." >&2; exit 1; }
cp -a "$stage/website" "$site_release"
chmod -R a+rX "$site_release"
cp -a "$stage/workbench" "$dist_root.next-$release"
chown -R zion:zion "$dist_root.next-$release"
runtime_stopped=1
systemctl stop zion-runtime
source_changed=1
cp -a "$stage/source/." "$root/"
chown -R zion:zion "$root/apps/runtime/src" "$root/packages/runtime/dist"
chmod -R a+rX "$root/apps/runtime/src" "$root/packages/runtime/dist"
if [[ -d "$stage/sandbox-node_modules" ]]; then
  if [[ -e "$root/packages/sandbox/node_modules" || -L "$root/packages/sandbox/node_modules" ]]; then
    mv "$root/packages/sandbox/node_modules" "$backup/sandbox-node_modules"
  fi
  dependency_changed=1
  cp -a "$stage/sandbox-node_modules" "$root/packages/sandbox/node_modules"
  chown -R zion:zion "$root/packages/sandbox/node_modules"
  chmod -R a+rX "$root/packages/sandbox/node_modules"
fi
dist_changed=1
rm -rf "$dist_root"
mv "$dist_root.next-$release" "$dist_root"
unit_changed=1
cp "$stage/zion-runtime.service" /etc/systemd/system/zion-runtime.service
chmod 0644 /etc/systemd/system/zion-runtime.service
systemctl daemon-reload
systemctl start zion-runtime
ready=0
for ((attempt=0; attempt<90; attempt++)); do
  if systemctl is-active --quiet zion-runtime && curl -fsS http://127.0.0.1:8766/health >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo "Runtime did not become HTTP ready." >&2; exit 1; }
site_changed=1
ln -s "$site_release" "/srv/zioon-public/current.next-$release"
mv -Tf "/srv/zioon-public/current.next-$release" /srv/zioon-public/current
caddy_changed=1
cp "$stage/Caddyfile" /etc/caddy/Caddyfile
chmod 0644 /etc/caddy/Caddyfile
systemctl reload caddy
node --input-type=module - "$site_release" <<'JS'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const directory=process.argv[2];
for(const url of ["https://runtime.zioon.tech/health","https://runtime.zioon.tech/v1/account/config","https://zioon.tech/","https://zioon.tech/docs/","https://zioon.tech/docs/cli/","https://zioon.tech/docs/plugin-invocation/","https://zioon.tech/.well-known/skills/index.json"]){
  const response=await fetch(url,{redirect:"manual",signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200,url);
}
for(const url of ["https://runtime.zioon.tech/v1/sessions","https://runtime.zioon.tech/v1/marketplace/snapshot"]){
  assert.equal((await fetch(url,{redirect:"manual"})).status,401,url);
}
assert.equal((await fetch("https://zioon.tech/a-missing-page")).status,404);
const manifest=JSON.parse(readFileSync(`${directory}/downloads/release.json`));
for(const [file,hash] of Object.entries(manifest.files)){
  const response=await fetch(`https://zioon.tech/downloads/${file}`,{signal:AbortSignal.timeout(30000)});
  assert.equal(response.status,200,file);
  assert.equal(createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex"),hash,file);
}
console.log("Public routes, account boundaries and download hashes verified");
JS
committed=1
printf 'Published %s; backup=%s\n' "$release" "$backup"
