import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import {
  fileURLToPath,
  pathToFileURL,
  URL,
  URLSearchParams
} from "node:url";
import pg from "pg";
import * as QRCode from "qrcode";
import { PostgresAccessStore } from "./postgres-access-store.mjs";

const { Pool } = pg;

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

const USAGE = `Usage: npm run remote:start -- [options]

Default:
  Build Desktop Workbench and Mobile Client, create a Cloudflare Quick Tunnel,
  start Runtime, and print one-time browser pairing links.

Options:
  --public-url <https-url>  Use an existing HTTPS reverse proxy
  --local                   Run on this computer without a Tunnel
  --port <port>             Local Runtime port (default 8766)
  --data-dir <path>         Runtime file data directory
  --space <id>              Runtime Space ID (or ZION_SPACE_ID)
  --workbench-dist <path>   Use or create a specific Workbench build
  --skip-build              Reuse the current dist/
  --help                    Show this help
`;

function readArg(argv, name, fallback = "") {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      stdio: "inherit",
      ...options
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(
        `${command} exited with ${signal || `code ${code}`}`
      ));
    });
  });
}

function startTunnel(port, output) {
  const child = spawn("cloudflared", [
    "tunnel",
    "--no-autoupdate",
    "--url",
    `http://127.0.0.1:${port}`
  ], {
    cwd: REPOSITORY_ROOT,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const url = new Promise((resolveUrl, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("Timed out waiting for Cloudflare Tunnel URL"));
    }, 30_000);
    const inspect = (chunk) => {
      const text = String(chunk || "");
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      resolveUrl(match[0]);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(
        error?.code === "ENOENT"
          ? "cloudflared is required. Install it with: brew install cloudflared"
          : `Cannot start cloudflared: ${error.message}`
      ));
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cloudflared exited before publishing a URL (${code})`));
    });
  });
  child.stderr.on("data", (chunk) => {
    const line = String(chunk || "").trim();
    if (line && /ERR|error/i.test(line)) {
      output.write(`[tunnel] ${line}\n`);
    }
  });
  return { child, url };
}

function stopProcessTree(child) {
  if (!child || child.exitCode != null || child.signalCode) return;
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // Process teardown is best-effort.
  }
}

async function assertPortAvailable(port) {
  await new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.once("error", (error) => {
      reject(new Error(
        error?.code === "EADDRINUSE"
          ? `Port ${port} is already in use`
          : `Cannot use port ${port}: ${error?.message || String(error)}`
      ));
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(resolvePromise);
    });
  });
}

async function waitForRuntime(url, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) {
      throw new Error(`Runtime exited before becoming ready (${child.exitCode})`);
    }
    try {
      const response = await globalThis.fetch(`${url}/health`);
      const body = await response.json().catch(() => null);
      if (
        response.ok
        && body?.service === "zion-runtime"
        && body?.authRequired === true
      ) {
        return;
      }
    } catch {
      // Runtime is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Timed out waiting for Runtime");
}

function pairingUrl(publicUrl, pairing) {
  const url = new URL(publicUrl);
  url.hash = new URLSearchParams({
    pairing_id: pairing.pairingId,
    pairing_secret: pairing.secret
  }).toString();
  return url.toString();
}

export async function runRemoteLauncher({
  argv = process.argv.slice(2),
  environment = process.env,
  output = process.stdout
} = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    output.write(USAGE);
    return null;
  }
  const port = Number(readArg(argv, "--port", "8766"));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Remote Runtime port must be between 1 and 65535");
  }
  const dataDirectory = readArg(
    argv,
    "--data-dir",
    environment.ZION_RUNTIME_DATA_DIR || join(homedir(), ".zion-next", "runtime")
  );
  const skipBuild = argv.includes("--skip-build");
  const configuredDist = readArg(argv, "--workbench-dist", "");
  const distPath = resolve(
    configuredDist
    || (skipBuild
      ? join(REPOSITORY_ROOT, "dist")
      : join(dataDirectory, "workbench-dist"))
  );
  if (!skipBuild) {
    output.write("Building Workbench...\n");
    rmSync(distPath, { recursive: true, force: true });
    await run("npm", ["run", "build", "--", "--outDir", distPath]);
    output.write("Building Mobile Client...\n");
    await run("npm", [
      "run",
      "build:mobile",
      "--",
      "--outDir",
      join(distPath, "mobile")
    ]);
  }
  if (!existsSync(join(distPath, "index.html"))) {
    throw new Error(`Workbench build not found: ${distPath}`);
  }

  let tunnel = null;
  const localOnly = argv.includes("--local");
  let publicUrl = localOnly
    ? `http://127.0.0.1:${port}`
    : readArg(
        argv,
        "--public-url",
        environment.ZION_RUNTIME_PUBLIC_URL || ""
      ).replace(/\/+$/, "");
  if (publicUrl) {
    const parsed = new URL(publicUrl);
    if (
      parsed.protocol !== "https:"
      && !(localOnly && parsed.protocol === "http:")
    ) {
      throw new Error("Public Runtime URL must use HTTPS");
    }
    publicUrl = parsed.origin;
  }
  await assertPortAvailable(port);
  const databaseUrl = String(environment.ZION_DATABASE_URL || "").trim();
  const spaceId = readArg(argv, "--space", environment.ZION_SPACE_ID || "");
  if (!databaseUrl) throw new Error("ZION_DATABASE_URL is required");
  if (!spaceId) throw new Error("ZION_SPACE_ID or --space is required");
  if (!publicUrl) {
    output.write("Creating secure public link...\n");
    tunnel = startTunnel(port, output);
    publicUrl = await tunnel.url;
  }

  output.write("Building Runtime...\n");
  await run("npm", ["run", "runtime:build"]);
  const runtime = spawn(process.execPath, [
    join(REPOSITORY_ROOT, "apps/runtime/src/main.mjs"),
    "--host", "127.0.0.1",
    "--port", String(port),
    "--data-dir", dataDirectory,
    "--workbench-dist", distPath,
    "--runtime-plugins", "dev.session-manager,dev.skills,dev.tools,dev.plugins,dev.terminal-manager,dev.identity,dev.memory,dev.agents,dev.scheduler,dev.langchain-chat,dev.mail,dev.context-compression,dev.observability"
  ], {
    cwd: REPOSITORY_ROOT,
    detached: process.platform !== "win32",
    env: {
      ...environment,
      ZION_RUNTIME_ACCESS_CONTROL: "1",
      ZION_RUNTIME_PUBLIC_URL: publicUrl,
      ZION_RUNTIME_ALLOWED_ORIGINS: publicUrl,
      ZION_RUNTIME_ENGINE: environment.ZION_RUNTIME_ENGINE || "openai",
      ZION_RUNTIME_TOOL_MODE: "node",
      ZION_DATABASE_URL: databaseUrl,
      ZION_SPACE_ID: spaceId
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  runtime.stdout.on("data", (chunk) => {
    const line = String(chunk || "").trim();
    if (line) output.write(`[runtime] ${line}\n`);
  });
  runtime.stderr.on("data", (chunk) => {
    const line = String(chunk || "").trim();
    if (line) output.write(`[runtime] ${line}\n`);
  });

  let stopping = false;
  const stop = () => {
    stopping = true;
    stopProcessTree(runtime);
    stopProcessTree(tunnel?.child);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await waitForRuntime(`http://127.0.0.1:${port}`, runtime);
    const pool = new Pool({
      connectionString: databaseUrl,
      application_name: "zion-remote-launcher"
    });
    const accessStore = new PostgresAccessStore(pool, { spaceId });
    let pairing;
    try {
      const hasOwner = (await accessStore.listDevices()).some(
        (device) => device.kind === "owner" && !device.revokedAt
      );
      pairing = await accessStore.createPairing({
        kind: hasOwner ? "client" : "owner",
        delivery: "cookie",
        label: hasOwner ? "Browser" : "Owner browser"
      });
    } finally {
      await accessStore.close();
      await pool.end();
    }
    const url = pairingUrl(publicUrl, pairing);
    const mobileUrl = pairingUrl(`${publicUrl}/mobile/`, pairing);
    const qr = await QRCode.toString(url, {
      type: "terminal",
      small: true,
      errorCorrectionLevel: "M"
    });
    output.write("\n");
    output.write(`${qr}\n`);
    output.write(`Open: ${url}\n`);
    output.write(`Code: ${pairing.userCode}\n`);
    output.write(`Workbench: ${publicUrl}\n`);
    output.write(`Mobile: ${mobileUrl}\n`);
    output.write("Press Ctrl+C to stop.\n");

    await new Promise((resolvePromise, reject) => {
      runtime.once("error", reject);
      runtime.once("exit", (code, signal) => {
        if (code === 0 || (stopping && signal === "SIGTERM")) resolvePromise();
        else reject(new Error(`Runtime exited with ${signal || `code ${code}`}`));
      });
      tunnel?.child.once("exit", (code, signal) => {
        if (!stopping && runtime.exitCode == null) {
          reject(new Error(
            `Tunnel exited with ${signal || `code ${code}`}`
          ));
        }
      });
    });
    return { publicUrl, port };
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    stop();
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runRemoteLauncher().catch((error) => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
