#!/usr/bin/env node

import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { isIPv4 } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { resolve4 } from "node:dns/promises";
import { setTimeout } from "node:timers";
import { pathToFileURL, URL } from "node:url";

const USAGE = `Usage:
  npm run deploy:configure -- --mode local
  npm run deploy:configure -- --mode ip --public-ip <ipv4> [--apply]
  npm run deploy:configure -- --mode domain --domain <hostname> \\
    [--public-ip <ipv4>] [--legacy-origin <https-origin>] [--apply]

Modes:
  local   Print the single-machine commands. Does not edit system files.
  ip      Configure Caddy with sslip.io/nip.io hostnames on port 8443.
  domain  Configure Caddy with a real domain on port 443.

Options:
  --runtime-port <port>  Loopback Runtime port (default: 8766)
  --observability-port <port>
                         Loopback Jaeger UI port; enables protected /observability/
  --https-port <port>    Public HTTPS port (default: 8443 for ip, 443 for domain)
  --legacy-origin <url>  Keep an existing HTTPS origin during migration; repeatable
  --caddyfile <path>     Caddy config path (default: /etc/caddy/Caddyfile)
  --env-file <path>      Runtime env path (default: /etc/zion-next/runtime.env)
  --skip-dns-check       Allow domain apply before DNS resolves
  --apply                Back up files, apply config, and restart services
  --help                 Show this help

Without --apply the command is a dry run and prints the generated Caddyfile.
Run --apply only on a dedicated Runtime host where this script may own Caddyfile.
`;

function parseArgs(argv) {
  const values = new Map();
  const repeated = new Map();
  const flags = new Set();
  const repeatable = new Set(["--legacy-origin"]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    if (["--apply", "--skip-dns-check", "--help"].includes(key)) {
      flags.add(key);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${key} requires a value`);
    }
    index += 1;
    if (repeatable.has(key)) {
      repeated.set(key, [...(repeated.get(key) || []), value]);
    } else {
      values.set(key, value);
    }
  }
  return {
    value(name, fallback = "") {
      return values.get(name) ?? fallback;
    },
    values(name) {
      return repeated.get(name) || [];
    },
    has(name) {
      return flags.has(name);
    }
  };
}

function validPort(value, name) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be between 1 and 65535`);
  }
  return port;
}

function normalizeHttpsOrigin(value, name) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use https`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an origin without path, query, or credentials`);
  }
  return url.origin;
}

function normalizeDomain(value) {
  const domain = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (
    !domain
    || domain.length > 253
    || !domain.includes(".")
    || !/^[a-z0-9.-]+$/.test(domain)
    || domain.split(".").some((label) =>
      !label
      || label.length > 63
      || label.startsWith("-")
      || label.endsWith("-")
    )
  ) {
    throw new Error("domain must be a valid DNS hostname");
  }
  return domain;
}

function originFor(hostname, port) {
  return `https://${hostname}${port === 443 ? "" : `:${port}`}`;
}

function caddySite(origin, runtimePort, observabilityPort) {
  const proxy = observabilityPort
    ? `\t@observabilityMcp path /observability/api/ai/mcp/*
\trespond @observabilityMcp 404

\t@observabilityOtlp path /observability/api/otlp/*
\trespond @observabilityOtlp 404

\tredir /observability /observability/ 308

\thandle_path /observability/* {
\t\tforward_auth 127.0.0.1:${runtimePort} {
\t\t\turi /v1/access/authorize/observability
\t\t}
\t\treverse_proxy 127.0.0.1:${observabilityPort} {
\t\t\theader_up -Cookie
\t\t\theader_up -Authorization
\t\t}
\t}

\thandle {
\t\treverse_proxy 127.0.0.1:${runtimePort}
\t}`
    : `\treverse_proxy 127.0.0.1:${runtimePort}`;
  return `${origin} {
\tencode zstd gzip
${proxy}

\theader {
\t\tStrict-Transport-Security "max-age=31536000; includeSubDomains"
\t\tX-Content-Type-Options "nosniff"
\t\tReferrer-Policy "no-referrer"
\t\tPermissions-Policy "camera=(), microphone=(), geolocation=()"
\t}
}`;
}

export function deploymentConfig({
  mode,
  publicIp = "",
  domain = "",
  runtimePort = 8766,
  observabilityPort,
  httpsPort,
  legacyOrigins = []
}) {
  const normalizedMode = String(mode || "").trim().toLowerCase();
  const port = validPort(runtimePort, "runtime-port");
  const tracePort = observabilityPort === undefined || observabilityPort === ""
    ? null
    : validPort(observabilityPort, "observability-port");
  if (normalizedMode === "local") {
    return {
      mode: "local",
      publicOrigin: `http://127.0.0.1:${port}`,
      connectorOrigin: null,
      allowedOrigins: [`http://127.0.0.1:${port}`],
      caddyfile: ""
    };
  }
  if (!["ip", "domain"].includes(normalizedMode)) {
    throw new Error("mode must be local, ip, or domain");
  }

  const publicPort = validPort(
    httpsPort ?? (normalizedMode === "ip" ? 8443 : 443),
    "https-port"
  );
  let publicOrigin;
  let connectorOrigin;
  if (normalizedMode === "ip") {
    if (!isIPv4(publicIp)) throw new Error("ip mode requires --public-ip <ipv4>");
    const dashed = publicIp.replaceAll(".", "-");
    publicOrigin = originFor(`${dashed}.sslip.io`, publicPort);
    connectorOrigin = originFor(`${dashed}.nip.io`, publicPort);
  } else {
    const hostname = normalizeDomain(domain);
    if (publicIp && !isIPv4(publicIp)) {
      throw new Error("public-ip must be a valid IPv4 address");
    }
    publicOrigin = originFor(hostname, publicPort);
    connectorOrigin = publicOrigin;
  }

  const normalizedLegacy = legacyOrigins.map((origin) =>
    normalizeHttpsOrigin(origin, "legacy-origin")
  );
  const sites = [...new Set([
    publicOrigin,
    connectorOrigin,
    ...normalizedLegacy
  ])];
  const caddyfile = `${sites.map((origin) =>
    caddySite(origin, port, tracePort)
  ).join("\n\n")}\n`;
  return {
    mode: normalizedMode,
    publicIp,
    domain: normalizedMode === "domain" ? normalizeDomain(domain) : "",
    publicOrigin,
    connectorOrigin,
    allowedOrigins: sites,
    observabilityPort: tracePort,
    caddyfile
  };
}

export function updateEnvironment(content, updates) {
  const remaining = new Map(Object.entries(updates));
  const lines = String(content || "").split(/\r?\n/);
  const output = [];
  for (const line of lines) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match || !remaining.has(match[1])) {
      output.push(line);
      continue;
    }
    output.push(`${match[1]}=${remaining.get(match[1])}`);
    remaining.delete(match[1]);
  }
  while (output.length && output.at(-1) === "") output.pop();
  for (const [key, value] of remaining) output.push(`${key}=${value}`);
  return `${output.join("\n")}\n`;
}

function run(command, args, {
  allowFailure = false,
  capture = false,
  ...options
} = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function writeAtomic(path, content, fallbackMode) {
  const existing = existsSync(path) ? statSync(path) : null;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, {
    encoding: "utf8",
    mode: existing?.mode ?? fallbackMode
  });
  if (existing && typeof process.getuid === "function" && process.getuid() === 0) {
    chownSync(temporary, existing.uid, existing.gid);
    chmodSync(temporary, existing.mode);
  }
  renameSync(temporary, path);
}

async function waitForHealth(runtimePort) {
  const url = `http://127.0.0.1:${runtimePort}/health`;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await globalThis.fetch(url);
      const body = await response.json().catch(() => null);
      if (response.ok && body?.service === "zion-runtime") return;
    } catch {
      // Service is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Runtime did not become healthy at ${url}`);
}

async function verifyDomain(config, skipDnsCheck) {
  if (config.mode !== "domain" || skipDnsCheck) return;
  const addresses = await resolve4(config.domain);
  if (!addresses.length) throw new Error(`${config.domain} has no A record`);
  if (config.publicIp && !addresses.includes(config.publicIp)) {
    throw new Error(
      `${config.domain} resolves to ${addresses.join(", ")}, not ${config.publicIp}`
    );
  }
}

function backup(path, timestamp) {
  if (!existsSync(path)) return null;
  const target = `${path}.before-zion-${timestamp}`;
  copyFileSync(path, target);
  const stat = statSync(path);
  chmodSync(target, stat.mode);
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    chownSync(target, stat.uid, stat.gid);
  }
  return target;
}

export async function runDeploymentCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.has("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  const mode = args.value("--mode");
  const config = deploymentConfig({
    mode,
    publicIp: args.value("--public-ip"),
    domain: args.value("--domain"),
    runtimePort: args.value("--runtime-port", "8766"),
    observabilityPort: args.value("--observability-port"),
    httpsPort: args.value("--https-port", mode === "ip" ? "8443" : "443"),
    legacyOrigins: args.values("--legacy-origin")
  });

  if (config.mode === "local") {
    process.stdout.write(`Single-machine mode needs no DNS, Caddy, or TLS.

Start the local Workbench:
  npm install
  npm run dev

Or start the access-controlled local Runtime:
  npm run remote:start -- --local
`);
    return;
  }

  process.stdout.write(`Mode: ${config.mode}
Browser URL: ${config.publicOrigin}
Connector URL: ${config.connectorOrigin}
Runtime listen: 127.0.0.1:${args.value("--runtime-port", "8766")}
Observability UI: ${config.observabilityPort
    ? `127.0.0.1:${config.observabilityPort} via /observability/`
    : "disabled"}
Required inbound TCP ports: 80, ${args.value(
    "--https-port",
    mode === "ip" ? "8443" : "443"
  )}
Allowed origins: ${config.allowedOrigins.join(",")}

Generated Caddyfile:
${config.caddyfile}`);

  if (!args.has("--apply")) {
    process.stdout.write("\nDry run only. Add --apply on the Runtime host to install.\n");
    return;
  }
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("--apply must run as root");
  }
  await verifyDomain(config, args.has("--skip-dns-check"));

  const caddyfilePath = args.value("--caddyfile", "/etc/caddy/Caddyfile");
  const envFilePath = args.value("--env-file", "/etc/zion-next/runtime.env");
  const runtimePort = validPort(args.value("--runtime-port", "8766"), "runtime-port");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "zion-deploy-"));
  const candidate = join(temporaryRoot, "Caddyfile");
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  let caddyBackup = null;
  let envBackup = null;

  try {
    writeFileSync(candidate, config.caddyfile, "utf8");
    run("caddy", ["validate", "--config", candidate, "--adapter", "caddyfile"]);
    caddyBackup = backup(caddyfilePath, timestamp);
    envBackup = backup(envFilePath, timestamp);
    writeAtomic(caddyfilePath, config.caddyfile, 0o644);
    const environment = existsSync(envFilePath)
      ? readFileSync(envFilePath, "utf8")
      : "";
    writeAtomic(envFilePath, updateEnvironment(environment, {
      ZION_RUNTIME_PUBLIC_URL: config.publicOrigin,
      ZION_RUNTIME_ALLOWED_ORIGINS: config.allowedOrigins.join(",")
    }), 0o600);
    run("caddy", ["validate", "--config", caddyfilePath, "--adapter", "caddyfile"]);
    run("systemctl", ["reload", "caddy"]);
    run("systemctl", ["restart", "zion-runtime"]);
    await waitForHealth(runtimePort);
    process.stdout.write(
      `\nApplied successfully.\nBackups: ${
        [caddyBackup, envBackup].filter(Boolean).join(", ") || "none"
      }\n`
      + `Verify: curl -fsS ${config.publicOrigin}/health\n`
    );
  } catch (error) {
    if (caddyBackup || envBackup) {
      if (caddyBackup) copyFileSync(caddyBackup, caddyfilePath);
      else rmSync(caddyfilePath, { force: true });
      if (envBackup) copyFileSync(envBackup, envFilePath);
      else rmSync(envFilePath, { force: true });
      run("systemctl", ["reload", "caddy"], { allowFailure: true });
      run("systemctl", ["restart", "zion-runtime"], { allowFailure: true });
      throw new Error(
        `${error?.message || String(error)}; previous configuration restored`
      );
    }
    throw error;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runDeploymentCli().catch((error) => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
