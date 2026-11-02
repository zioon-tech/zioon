import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, cp, rm, stat, chown, chmod, open } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { snapshotIdentityCatalog, restoreIdentityCatalog } from "./plugin-host-catalog.mjs";

process.umask(0o022);
const bundle = fileURLToPath(new URL("./", import.meta.url));
const [action = "preflight", proofFile, backupFile] = process.argv.slice(2);
const root = "/opt/zion-next", data = "/var/lib/zion-next/runtime", memory = "/var/lib/zion-memory";
const runtimeEnvFile = "/etc/zion-next/runtime.env";
const adcProvider = "/opt/agent-device-cloud/current/apps/control-plane/src/zioon-provider.mjs";
const clients = "/etc/zioon-account/clients.json";
const browserPluginServiceUrl = "http://127.0.0.1:8767";
const zionUid = Number(execFileSync("id", ["-u", "zion"], { encoding: "utf8" }).trim());
const zionGid = Number(execFileSync("id", ["-g", "zion"], { encoding: "utf8" }).trim());
const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, ...options
}).trim();
const exists = (path) => stat(path).then(() => true, (error) => {
  if (error.code === "ENOENT") return false; throw error;
});
function environment(text) {
  const values = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    if (Object.hasOwn(values, match[1])) throw new Error(`Duplicate environment key ${match[1]}`);
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}
async function updateEnvironment(values) {
  const text = await readFile(runtimeEnvFile, "utf8");
  environment(text);
  const remaining = { ...values };
  const lines = text.split("\n").map((line) => {
    const key = line.match(/^([A-Z_][A-Z0-9_]*)=/)?.[1];
    if (!key || !Object.hasOwn(values, key)) return line;
    delete remaining[key]; return `${key}=${values[key]}`;
  });
  for (const [key, value] of Object.entries(remaining)) lines.push(`${key}=${value}`);
  await writeFile(runtimeEnvFile, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
}
async function waitHttp(url, predicate = (value) => value.ok) {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "error" });
      if (response.ok && predicate(await response.json())) return;
    } catch {}
    await delay(1000);
  }
  throw new Error(`Service failed HTTP readiness: ${url}`);
}
async function backupDatabase(url, destination) {
  const parsed = new URL(url);
  const socket = parsed.searchParams.get("host") || "";
  assert(["127.0.0.1", "localhost"].includes(parsed.hostname)
    || (!parsed.hostname && ["", "/var/run/postgresql", "/run/postgresql"].includes(socket)),
  "This release backs up the existing local PostgreSQL");
  const database = decodeURIComponent(parsed.pathname.slice(1));
  // FORCE RLS also applies to the Runtime's owner role. Use the existing
  // PostgreSQL administrator over its local socket, without changing policies.
  const file = await open(destination, "wx", 0o600);
  let completed = false;
  try {
    execFileSync("runuser", ["-u", "postgres", "--", "pg_dump", "-Fc",
      ...(socket ? ["-h", socket] : []), "-p", parsed.port || "5432", "-d", database], {
      env: { PATH: process.env.PATH }, stdio: ["ignore", file.fd, "pipe"], timeout: 600_000
    });
    await file.sync();
    completed = true;
  } finally {
    await file.close();
    if (!completed) await rm(destination, { force: true });
  }
}
async function verifyBundle() {
  const manifest = JSON.parse(await readFile(join(bundle, "manifest.json"), "utf8"));
  assert.equal(manifest.format, 1);
  for (const [name, expected] of Object.entries(manifest.files)) {
    assert(!name.startsWith("/") && !name.split("/").includes(".."));
    const bytes = await readFile(join(bundle, name));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256, name);
  }
  return manifest;
}
async function rollback(backup) {
  const metadata = JSON.parse(await readFile(join(backup, "rollback.json"), "utf8"));
  run("systemctl", ["stop", "zion-runtime"]);
  for (const item of [...metadata.files].reverse()) {
    if (item.existed) {
      await rm(item.target, { recursive: true, force: true });
      await cp(join(backup, item.copy), item.target, { recursive: true, preserveTimestamps: true });
      await chown(item.target, item.uid, item.gid);
      await chmod(item.target, item.mode);
    } else await rm(item.target, { recursive: true, force: true });
  }
  if (metadata.distSwapped) {
    await rm("/var/lib/zion-next/workbench-dist", { recursive: true, force: true });
    await cp(join(backup, "workbench-dist"), "/var/lib/zion-next/workbench-dist", { recursive: true });
    run("chown", ["-R", "zion:zion", "/var/lib/zion-next/workbench-dist"]);
  }
  let catalogError;
  if (metadata.browserPluginUpdated) {
    try {
      await restoreIdentityCatalog({
        directory: backup, serviceBaseUrl: browserPluginServiceUrl,
        publishedHash: metadata.browserPublishedHash
      });
    } catch (error) { catalogError = error; }
  }
  run("systemctl", ["restart", "agent-device-cloud.service"]);
  run("systemctl", ["daemon-reload"]);
  run("systemctl", ["start", "zion-runtime", "zion-memory"]);
  await waitHttp("http://127.0.0.1:8766/health");
  await waitHttp("https://memory.zioon.tech/ready");
  if (catalogError) throw new Error(`Runtime restored; browser plugin restoration failed: ${catalogError.message}`);
  console.log(JSON.stringify({ rolledBack: true, backup, data: "preserved; database snapshots require explicit restoration" }));
}
assert.equal(process.getuid(), 0, "Use the authorized root maintenance channel");
if (action === "rollback") {
  assert(backupFile, "Supply backup path as third argument");
  await rollback(resolve(backupFile));
} else {
  assert(["preflight", "apply"].includes(action));
  const manifest = await verifyBundle();
  const runtimeEnv = environment(await readFile(runtimeEnvFile, "utf8"));
  assert.equal(runtimeEnv.ZION_SPACE_ID, "space:production");
  assert.equal(runtimeEnv.ZION_RUNTIME_AUTH_MODE, "accounts");
  run("pg_dump", ["--version"]);
  run("pg_restore", ["--version"]);
  run("unzip", ["-v"]);
  const database = new URL(runtimeEnv.ZION_DATABASE_URL);
  assert.equal(run("runuser", ["-u", "postgres", "--", "psql", "-At",
    "-p", database.port || "5432", "-d", decodeURIComponent(database.pathname.slice(1)),
    "-c", "SELECT rolsuper FROM pg_roles WHERE rolname=current_user"]), "t", "Full database backups require the local administrator");
  for (const path of [adcProvider, clients, join(data, "plugins/dev.identity"), "/etc/zion-memory/bridge.key"]) {
    assert(await exists(path), `Missing ${path}`);
  }
  if (action === "preflight") {
    // Install only Runtime's new declared dependencies in a separate staging tree.
    const deps = join(bundle, "runtime-deps");
    await mkdir(deps, { recursive: true });
    await cp(join(bundle, "source/apps/runtime/package.json"), join(deps, "package.json"));
    await cp(join(bundle, "source/apps/runtime/package-lock.json"), join(deps, "package-lock.json"));
    run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund", "--prefix", deps], { timeout: 300_000 });
    console.log(JSON.stringify({ ready: true, sourceFiles: Object.keys(manifest.files).filter((name) => name.startsWith("source/")).length,
      identityVersion: manifest.identityVersion, dependencies: "staged separately", data: "unchanged" }));
  } else {
    assert(proofFile, "Supply the non-secret proof verified using both saved sessions");
    const proof = JSON.parse(await readFile(proofFile, "utf8"));
    assert(Date.now() - proof.verifiedAt < 3_600_000);
    assert.equal(proof.runtimeUserId, "user:45c87081-7d1b-4226-aa21-b1c631179644");
    assert.equal(proof.adcUserId, "fQNCVWX7KJtZ1NLEy5nIZYMnSEhGQfKy");
    assert.equal(proof.spaceId, "space:production");
    assert(await exists(join(bundle, "runtime-deps/node_modules/@modelcontextprotocol/sdk")));
    const backup = `/var/backups/zion-unified-runtime/${Date.now()}`;
    await mkdir(backup, { recursive: true, mode: 0o700 });
    const metadata = { files: [], distSwapped: false };
    const persist = () => writeFile(join(backup, "rollback.json"), JSON.stringify(metadata, null, 2), { mode: 0o600 });
    const captured = new Set();
    async function capture(target) {
      if (captured.has(target)) return;
      const present = await exists(target), copy = `files/${metadata.files.length}`;
      const attributes = present ? await stat(target) : {};
      if (present) {
        await mkdir(dirname(join(backup, copy)), { recursive: true });
        await cp(target, join(backup, copy), { recursive: true, preserveTimestamps: true });
      }
      metadata.files.push({ target, copy, existed: present, uid: attributes.uid, gid: attributes.gid,
        mode: present ? attributes.mode & 0o7777 : undefined });
      captured.add(target); await persist();
    }
    try {
      await persist();
      for (const target of [runtimeEnvFile, adcProvider, clients, "/etc/caddy/Caddyfile",
        "/etc/caddy/zioon-memory.caddy", "/etc/zion-next/memory-bridge.key",
        "/etc/systemd/system/zion-runtime.service",
        join(root, "apps/runtime/node_modules"), "/var/lib/zion-next/plugins/dev.identity",
        join(root, "extensions/dev.identity/skills/biography-memory")]) await capture(target);
      await snapshotIdentityCatalog({ directory: backup, serviceBaseUrl: browserPluginServiceUrl });
      run("systemctl", ["stop", "zion-runtime", "zion-memory"]);
      await cp(data, join(backup, "runtime-snapshot"), { recursive: true });
      await cp(memory, join(backup, "memory-snapshot"), { recursive: true });
      await cp("/var/lib/zion-next/workbench-dist", join(backup, "workbench-dist"), { recursive: true });
      await backupDatabase(runtimeEnv.ZION_DATABASE_URL, join(backup, "runtime-postgres.dump"));
      const adcEnv = environment(await readFile("/etc/agent-device-cloud/adc.env", "utf8"));
      const adcDatabase = adcEnv.DATABASE_URL || adcEnv.ADC_DATABASE_URL;
      assert(adcDatabase, "Missing existing ADC database setting");
      await backupDatabase(adcDatabase, join(backup, "account-postgres.dump"));
      for (const name of Object.keys(manifest.files).filter((name) => name.startsWith("source/"))) {
        const target = join(root, name.slice(7));
        await capture(target);
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        await cp(join(bundle, name), target);
        await chown(target, zionUid, zionGid);
        await chmod(target, name.endsWith(".sh") ? 0o755 : 0o644);
      }
      await rm(join(root, "extensions/dev.identity/skills/biography-memory"), { recursive: true, force: true });
      await rm(join(root, "apps/runtime/node_modules"), { recursive: true, force: true });
      await cp(join(bundle, "runtime-deps/node_modules"), join(root, "apps/runtime/node_modules"), { recursive: true });
      const { PostgresAccountStore } = await import(pathToFileURL(join(root, "apps/runtime/src/accounts/postgres-account-store.mjs")).href);
      const store = await new PostgresAccountStore({ connectionString: runtimeEnv.ZION_DATABASE_URL, maxConnections: 1 }).initialize();
      try {
        assert(await store.activeSession(proof.runtimeSessionId, proof.runtimeUserId), "Saved Runtime session is no longer active");
        const before = { user: await store.getUser(proof.runtimeUserId), memberships: await store.listSpaces(proof.runtimeUserId) };
        await store.linkIdentity(proof.runtimeUserId, proof.spaceId, { issuer: "https://auth.zioon.tech", subject: proof.adcUserId });
        assert.equal((await store.resolveIdentity({ issuer: "https://auth.zioon.tech", subject: proof.adcUserId })).id, proof.runtimeUserId);
        assert.deepEqual(await store.getUser(proof.runtimeUserId), before.user);
        assert.deepEqual(await store.listSpaces(proof.runtimeUserId), before.memberships);
        await writeFile(join(backup, "account-link.json"), JSON.stringify({ ...proof, ...before }, null, 2), { mode: 0o600 });
      } finally { await store.close(); }
      const memoryEnv = environment(await readFile("/etc/zion-memory/service.env", "utf8"));
      run("/opt/bun-1.4.1/bun", [join(root, "deploy/unified-accounts/migrate-runtime-memory.ts"),
        join(backup, "runtime-snapshot/plugins/dev.identity"), join(backup, "memory-migration.json")],
      { env: { PATH: process.env.PATH, ...memoryEnv }, timeout: 120_000 });
      run("chown", ["-R", "zion-memory:zion-memory", memory]);
      await cp(join(bundle, "zioon-provider.mjs"), adcProvider);
      await cp(join(bundle, "clients.json"), clients);
      await cp("/etc/zion-memory/bridge.key", "/etc/zion-next/memory-bridge.key");
      run("chown", ["zion:zion", "/etc/zion-next/memory-bridge.key"]);
      await chmod("/etc/zion-next/memory-bridge.key", 0o600);
      await updateEnvironment({
        ZIOON_ACCOUNT_ISSUER: "https://auth.zioon.tech", ZIOON_ADC_ORIGIN: "https://adc.zioon.tech",
        ZIOON_ACCOUNT_SESSION_KEY_FILE: `${data}/shared-account-session.key`,
        ZION_OIDC_ISSUER: "https://auth.zioon.tech", ZION_MEMORY_SERVICE_URL: "https://memory.zioon.tech",
        ZION_MEMORY_PUBLIC_URL: "https://memory.zioon.tech", ZION_MEMORY_MCP_ENABLED: "0",
        ZION_MEMORY_BRIDGE_SECRET_FILE: "/etc/zion-next/memory-bridge.key",
        ZION_MEMORY_ACCOUNT_CONNECTIONS_DIR: ""
      });
      const unitPath = "/etc/systemd/system/zion-runtime.service";
      const unit = await readFile(unitPath, "utf8");
      assert(unit.includes("--runtime-plugins"), "Expected the existing explicit Runtime plugin configuration");
      await writeFile(unitPath, unit.replace(/(--runtime-plugins\s+)([^\s\\]+)/, (_match, flag, list) =>
        `${flag}${list.split(",").includes("dev.goal") ? list : `${list},dev.goal`}`));
      run("systemctl", ["daemon-reload"]);
      run("unzip", ["-q", join(bundle, `dev.identity-${manifest.identityVersion}.zip`), "-d", join(backup, "identity-next")]);
      await rm("/var/lib/zion-next/plugins/dev.identity", { recursive: true, force: true });
      await cp(join(backup, "identity-next"), "/var/lib/zion-next/plugins/dev.identity", { recursive: true });
      run("chown", ["-R", "zion:zion", "/var/lib/zion-next/plugins/dev.identity"]);
      const dist = "/var/lib/zion-next/workbench-dist", next = `${dist}.unified-next`;
      await rm(next, { recursive: true, force: true });
      await cp(join(bundle, "workbench"), next, { recursive: true });
      run("chown", ["-R", "zion:zion", next]);
      await rm(dist, { recursive: true, force: true });
      await cp(next, dist, { recursive: true });
      metadata.distSwapped = true; await persist();
      await rm(next, { recursive: true, force: true });
      run("systemctl", ["restart", "agent-device-cloud.service"]);
      await waitHttp("https://auth.zioon.tech/.well-known/openid-configuration", (value) => value.issuer === "https://auth.zioon.tech");
      run("systemctl", ["start", "zion-runtime", "zion-memory"]);
      await waitHttp("http://127.0.0.1:8766/health");
      await waitHttp("https://runtime.zioon.tech/health");
      await waitHttp("https://memory.zioon.tech/ready");
      const { publishIdentityPluginArchive } = await import(
        pathToFileURL(join(root, "scripts/package-identity-plugin.mjs")).href
      );
      metadata.browserPublishedHash = manifest.files[`dev.identity-${manifest.identityVersion}.zip`].sha256;
      metadata.browserPluginUpdated = true;
      await persist();
      const browserPlugin = await publishIdentityPluginArchive({
        archivePath: join(bundle, `dev.identity-${manifest.identityVersion}.zip`),
        serviceBaseUrl: browserPluginServiceUrl
      });
      assert.equal(browserPlugin.version, manifest.identityVersion);
      const migration = JSON.parse(await readFile(join(backup, "memory-migration.json"), "utf8"));
      await writeFile(join(backup, "release.json"), JSON.stringify({
        deployed: true, backup, identityVersion: manifest.identityVersion, accountId: proof.runtimeUserId,
        issuer: "https://auth.zioon.tech", memory: migration, browserPlugin, deployedAt: new Date().toISOString()
      }, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ deployed: true, backup, identityVersion: manifest.identityVersion,
        files: migration.currentFiles, jsonl: migration.jsonl, issuer: "https://auth.zioon.tech" }));
    } catch (error) {
      console.error("Release failed:", error.message);
      await rollback(backup);
      process.exitCode = 1;
    }
  }
}
