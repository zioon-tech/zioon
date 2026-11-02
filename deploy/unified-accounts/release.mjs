#!/usr/bin/env node
import { readFile, writeFile, mkdir, cp, rm, stat, readdir, chown, chmod } from "node:fs/promises";
import { resolve, join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { setTimeout as delay } from "node:timers/promises";
import { adcPlan, applyPlan } from "./patch-sources.mjs";

process.umask(0o022);
const bundle = fileURLToPath(new URL("./", import.meta.url));
const [action = "preflight", settingsPath, backupArgument] = process.argv.slice(2);
if (!["preflight", "prepare", "activate", "rollback"].includes(action)) throw new Error("Use preflight|prepare|activate|rollback");
const config = JSON.parse(await readFile(settingsPath || join(bundle, "settings.json"), "utf8"));
const run = (program, args) => execFileSync(program, args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000
}).trim();
const property = (service, key) => run("systemctl", ["show", service, `--property=${key}`, "--value"]);
async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function environment(text) {
  const result = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) {
      if (Object.hasOwn(result, match[1])) throw new Error(`Duplicate environment key: ${match[1]}`);
      result[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return result;
}
async function setEnvironment(path, values) {
  const text = await readFile(path, "utf8");
  environment(text);
  const remaining = { ...values };
  const lines = text.split("\n").map((line) => {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (!match || !Object.hasOwn(values, match[1])) return line;
    delete remaining[match[1]];
    return `${match[1]}=${values[match[1]]}`;
  });
  for (const [key, value] of Object.entries(remaining)) lines.push(`${key}=${value}`);
  await writeFile(path, lines.join("\n").replace(/\n*$/, "\n"));
}
async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Unexpected symlink in release: ${path}`);
  }
  return result;
}
async function verifyBundle() {
  const manifest = JSON.parse(await readFile(join(bundle, "manifest.json"), "utf8"));
  if (manifest.format !== 1) throw new Error("Unsupported release manifest");
  for (const [name, entry] of Object.entries(manifest.files)) {
    if (resolve(bundle, name) !== join(bundle, name) || name.startsWith("/") || name.includes("..")) throw new Error("Invalid manifest path");
    const bytes = await readFile(join(bundle, name));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(`Release hash differs: ${name}`);
  }
}
async function discover() {
  if (property(config.adcService, "LoadState") !== "loaded") {
    const units = run("systemctl", ["list-unit-files", "--type=service", "--no-legend"]).split("\n")
      .map((line) => line.split(/\s+/)[0]).filter((name) => /^(adc|agent-device-cloud)[.-].*service$/.test(name));
    if (units.length !== 1) throw new Error("Set adcService in settings.json to the existing ADC service");
    config.adcService = units[0];
  }
  config.adcRoot ||= property(config.adcService, "WorkingDirectory");
  if (!config.adcEnvironmentFile) {
    const values = property(config.adcService, "EnvironmentFiles").match(/\/[^\s;]+/g) || [];
    const present = [];
    for (const path of values) if (await exists(path)) present.push(path);
    if (present.length !== 1) throw new Error("Set adcEnvironmentFile in settings.json");
    config.adcEnvironmentFile = present[0];
  }
  const adcEnv = environment(await readFile(config.adcEnvironmentFile, "utf8"));
  if (adcEnv.ADC_PUBLIC_URL !== "https://adc.zioon.tech") throw new Error("ADC origin differs; inspect settings before deployment");
  config.adcPort = Number(adcEnv.PORT || config.adcPort);
  for (const path of [config.adcRoot, config.memoryRoot, config.bun,
    config.memoryEnvironmentFile, config.caddyFile]) {
    if (!path || !await exists(path)) throw new Error(`Required deployment path missing: ${path}`);
  }
  if (!Number.isInteger(config.adcPort) || config.adcPort < 1 || config.adcPort > 65535) throw new Error("Invalid ADC port");
  const memory = environment(await readFile(config.memoryEnvironmentFile, "utf8"));
  if (memory.AGENT_FS_HOME !== join(config.memoryDataRoot, "data")
    || memory.AGENT_FS_STORAGE_PROVIDER !== "local"
    || memory.AGENT_FS_LOCAL_ROOT !== join(config.memoryDataRoot, "objects")) {
    throw new Error("Expected the existing local-disk Memory pilot; inspect storage before deployment");
  }
  if (run("git", ["-C", memory.AGENT_FS_UPSTREAM_DIR, "rev-parse", "HEAD"]) !== "aecd4c83606f45325daece46b01f0c38ad2cc0ed") {
    throw new Error("Upstream agent-fs version differs");
  }
  const dns = {};
  for (const name of ["memory.zioon.tech", "auth.zioon.tech"]) {
    try { dns[name] = (await resolve4(name)).includes(config.expectedAddress); }
    catch { dns[name] = false; }
  }
  return dns;
}
async function waitHttp(url, predicate = (value) => value.ok === true, headers = {}) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(5000) });
      if (response.ok && predicate(await response.json())) return;
    } catch {}
    await delay(1000);
  }
  throw new Error(`HTTP readiness failed: ${url}`);
}
async function serviceSnapshot() {
  const states = {};
  for (const name of action === "prepare" ? [config.adcService, config.memoryService] : [config.memoryService]) {
    const loaded = property(name, "LoadState") === "loaded";
    states[name] = { loaded, active: loaded && property(name, "ActiveState") === "active",
      enabled: loaded && property(name, "UnitFileState") === "enabled" };
  }
  return states;
}
async function rollback(path) {
  const metadata = JSON.parse(await readFile(join(path, "backup.json"), "utf8"));
  for (const [name, state] of Object.entries(metadata.services)) {
    if (state.loaded) run("systemctl", ["stop", name]);
  }
  for (const item of metadata.files.reverse()) {
    if (item.existed) {
      await cp(join(path, item.copy), item.target, { preserveTimestamps: true });
      await chown(item.target, item.uid, item.gid);
      await chmod(item.target, item.mode);
    } else await rm(item.target, { force: true });
  }
  run("caddy", ["validate", "--config", metadata.config.caddyFile]);
  run("systemctl", ["reload", "caddy"]);
  for (const [name, state] of Object.entries(metadata.services)) {
    if (!state.loaded) continue;
    run("systemctl", [state.enabled ? "enable" : "disable", name]);
    if (state.active) run("systemctl", ["start", name]);
  }
  await waitHttp(metadata.config.runtimeHealth);
  await waitHttp(metadata.config.memoryReady);
  console.log(JSON.stringify({ rolledBack: true, backup: path, data: "retained current memory and additive account links" }));
}

let backup, metadata, releaseLock = false;
try {
  if (process.getuid() !== 0) throw new Error("Root is required to deploy system services and Caddy");
  if (action === "rollback") {
    if (!backupArgument) throw new Error("Usage: node release.mjs rollback SETTINGS BACKUP");
    await rollback(resolve(backupArgument));
  } else {
    await verifyBundle();
    const dns = await discover();
    const adcChanges = await adcPlan(config.adcRoot, bundle, { includeConsole: false });
    if (action === "preflight") {
      console.log(JSON.stringify({ ready: Object.values(dns).every(Boolean), dns,
        adcRoot: config.adcRoot, adcService: config.adcService,
        sourceChanges: { accountBridge: adcChanges.map((item) => item.path), memory: true },
        scope: "memory-only" }, null, 2));
    } else {
      if (!Object.values(dns).every(Boolean)) throw new Error("Add memory/auth A records pointing to the ECS before deployment");
      await mkdir("/run/zioon-memory-deploy.lock");
      releaseLock = true;
      if (action === "activate") {
        if (adcChanges.length) throw new Error("Run prepare before activate");
        run(config.bun, [join(bundle, "migration-check.mjs"), join(config.memoryDataRoot, "data/agent-fs.db")]);
      }
      backup = join(config.backupRoot, `${Date.now()}-${action}`);
      await mkdir(backup, { recursive: true, mode: 0o700 });
      metadata = { action, config, services: await serviceSnapshot(), files: [] };
      const captured = new Set();
      async function capture(target) {
        if (captured.has(target)) return;
        const existed = await exists(target), copy = `files/${metadata.files.length}`;
        if (existed) {
          await mkdir(dirname(join(backup, copy)), { recursive: true });
          await cp(target, join(backup, copy), { preserveTimestamps: true });
        }
        const attributes = existed ? await stat(target) : {};
        metadata.files.push({ target, existed, copy, uid: attributes.uid, gid: attributes.gid, mode: existed ? attributes.mode & 0o7777 : undefined });
        captured.add(target);
        await writeFile(join(backup, "backup.json"), JSON.stringify(metadata, null, 2), { mode: 0o600 });
      }
      async function install(source, target) {
        await capture(target);
        await mkdir(dirname(target), { recursive: true });
        await cp(source, target);
      }
      await capture(config.memoryEnvironmentFile);
      if (action === "prepare") {
        await capture(config.adcEnvironmentFile);
        await capture(config.caddyFile);
        await capture(config.caddyFragment);
        for (const item of adcChanges) await capture(join(config.adcRoot, item.path));
        run("systemctl", ["stop", config.memoryService]);
        // A quiescent full pilot snapshot supplements code rollback. Never
        // automatically restore it over writes made after the release.
        await cp(config.memoryDataRoot, join(backup, "memory-snapshot"), { recursive: true });
        await mkdir(config.accountConfigDirectory, { recursive: true, mode: 0o755 });
        const keyFile = join(config.accountConfigDirectory, "signing.pem");
        await capture(keyFile);
        if (!await exists(keyFile)) {
          const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" } });
          await writeFile(keyFile, privateKey, { mode: 0o600 });
        }
        const user = property(config.adcService, "User") || "root";
        const group = property(config.adcService, "Group");
        await chown(keyFile, Number(run("id", ["-u", user])), Number(group ? run("getent", ["group", group]).split(":")[2] : run("id", ["-g", user])));
        await install(join(bundle, "clients.json"), join(config.accountConfigDirectory, "clients.json"));
        for (const source of await files(join(bundle, "memory"))) {
          await install(source, join(config.memoryRoot, relative(join(bundle, "memory"), source)));
        }
        await applyPlan(config.adcRoot, adcChanges);
        await setEnvironment(config.adcEnvironmentFile, {
          ZIOON_ACCOUNT_ISSUER: "https://auth.zioon.tech",
          ZIOON_ACCOUNT_CLIENTS_FILE: join(config.accountConfigDirectory, "clients.json"),
          ZIOON_ACCOUNT_SIGNING_KEY_FILE: keyFile
        });
        await setEnvironment(config.memoryEnvironmentFile, {
          ZIOON_ADC_ORIGIN: "https://adc.zioon.tech", ZIOON_ACCOUNT_ISSUER: "https://auth.zioon.tech"
        });
        const fragment = (await readFile(join(bundle, "Caddyfile"), "utf8")).replaceAll("__ADC_PORT__", String(config.adcPort));
        await writeFile(config.caddyFragment, fragment, { mode: 0o644 });
        const caddy = await readFile(config.caddyFile, "utf8");
        const importLine = `import ${config.caddyFragment}`;
        if (!caddy.includes(importLine) && /(?:memory|auth)\.zioon\.tech/.test(caddy)) {
          throw new Error("Existing Memory/account Caddy hosts need manual merging");
        }
        if (!caddy.includes(importLine)) await writeFile(config.caddyFile, `${caddy.trimEnd()}\n\n${importLine}\n`);
        run("caddy", ["validate", "--config", config.caddyFile]);
        run("systemctl", ["restart", config.adcService]);
        await waitHttp(`http://127.0.0.1:${config.adcPort}/api/v1/zioon/.well-known/openid-configuration`,
          (value) => value.issuer === "https://auth.zioon.tech");
        run("systemctl", ["reload", "caddy"]);
        await waitHttp("https://auth.zioon.tech/.well-known/openid-configuration", (value) => value.issuer === "https://auth.zioon.tech");
        await waitHttp(config.runtimeHealth);
        run("systemctl", ["start", config.memoryService]);
        await waitHttp(config.memoryReady);
        console.log(JSON.stringify({ prepared: true, backup, scope: "memory-only",
          next: "Bind existing Memory data using both saved sessions, then run activate" }));
      } else {
        await setEnvironment(config.memoryEnvironmentFile, {
          ZION_MEMORY_WEBSITE_ORIGIN: "https://memory.zioon.tech",
          ZION_MEMORY_ALLOWED_ORIGINS: "https://runtime.zioon.tech,https://memory.zioon.tech"
        });
        await waitHttp(config.runtimeHealth);
        run("systemctl", ["restart", config.memoryService]);
        await waitHttp(config.memoryReady);
        const site = await fetch("https://memory.zioon.tech", { signal: AbortSignal.timeout(10_000) });
        if (!site.ok || !(await site.text()).includes("Zioon Memory")) throw new Error("Memory website failed");
        const session = await fetch("https://memory.zioon.tech/console/api/me", { signal: AbortSignal.timeout(10_000) });
        if (session.status !== 401) throw new Error("Console authentication check failed");
        const login = await fetch("https://memory.zioon.tech/account/login", { redirect: "error", signal: AbortSignal.timeout(10_000) });
        if (!login.ok || !(await login.text()).includes('id="login-form"')) throw new Error("Memory login page failed");
        console.log(JSON.stringify({ activated: true, backup, scope: "memory-only",
          website: "https://memory.zioon.tech", issuer: "https://auth.zioon.tech" }));
      }
    }
  }
} catch (error) {
  console.error(error.message);
  if (backup && metadata?.files.length) {
    try { await rollback(backup); }
    catch (restoreError) { console.error(`Rollback failed: ${restoreError.message}; backup ${backup}`); }
  }
  process.exitCode = 1;
} finally {
  if (releaseLock) await rm("/run/zioon-memory-deploy.lock", { recursive: true, force: true });
}
