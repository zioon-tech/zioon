import process from "node:process";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { PostgresAccessStore } from "./postgres-access-store.mjs";
import { initializePostgresRuntimeSchema } from "./postgres-runtime-schema.mjs";

const { Pool } = pg;

const USAGE = `Usage: npm run runtime:access -- <command> [options]

Commands:
  pair create                 Create a one-time pairing invitation
  devices list               List paired devices without credentials
  devices revoke <device-id> Revoke one device and all its credentials

Options:
  --space <id>               Runtime Space ID (or ZION_SPACE_ID)
  --kind <kind>              owner, client, or resource
  --delivery <delivery>      cookie or bearer
  --label <text>             Pairing/device label
  --ttl <seconds>            Pairing lifetime (30-3600, default 300)
  --public-url <url>         Workbench URL used to build a QR-ready link
  --json                     Emit JSON
`;

const VALUE_OPTIONS = new Set([
  "--space",
  "--kind",
  "--delivery",
  "--label",
  "--ttl",
  "--public-url"
]);

function readArg(argv, name, fallback = "") {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
}

function positionalArgs(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (VALUE_OPTIONS.has(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith("-")) values.push(value);
  }
  return values;
}

function pairingUrl(publicBaseUrl, pairing) {
  if (!String(publicBaseUrl || "").trim()) return "";
  const url = new URL(publicBaseUrl);
  url.hash = new URLSearchParams({
    pairing_id: pairing.pairingId,
    pairing_secret: pairing.secret
  }).toString();
  return url.toString();
}

function printJson(output, value) {
  output.write(`${JSON.stringify(value)}\n`);
}

export async function runRuntimeAccessCli({
  argv = process.argv.slice(2),
  environment = process.env,
  output = process.stdout,
  store = null
} = {}) {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    output.write(USAGE);
    return null;
  }
  const databaseUrl = String(environment.ZION_DATABASE_URL || "").trim();
  const spaceId = readArg(argv, "--space", environment.ZION_SPACE_ID || "");
  if (!store && !databaseUrl) throw new Error("ZION_DATABASE_URL is required");
  if (!store && !spaceId) throw new Error("ZION_SPACE_ID or --space is required");
  const pool = store ? null : new Pool({
    connectionString: databaseUrl,
    application_name: "zion-runtime-access-cli"
  });
  if (pool) await initializePostgresRuntimeSchema(pool);
  const accessStore = store || new PostgresAccessStore(pool, { spaceId });
  try {
    const positionals = positionalArgs(argv);
    const command = positionals[0];
    const action = positionals[1];
    const json = argv.includes("--json");

    if (command === "pair" && action === "create") {
      const kind = readArg(argv, "--kind", "client");
      const delivery = readArg(
        argv,
        "--delivery",
        kind === "resource" ? "bearer" : "cookie"
      );
      const ttlSeconds = Number(readArg(argv, "--ttl", "300"));
      const pairing = await accessStore.createPairing({
        kind,
        delivery,
        label: readArg(argv, "--label", ""),
        ttlMs: ttlSeconds * 1000
      });
      const result = {
        ...pairing,
        pairingUrl: pairingUrl(
          readArg(
            argv,
            "--public-url",
            environment.ZION_RUNTIME_PUBLIC_URL || ""
          ),
          pairing
        )
      };
      if (json) {
        printJson(output, result);
      } else {
        output.write(`Pairing code: ${result.userCode}\n`);
        if (result.pairingUrl) {
          output.write(`Pairing URL: ${result.pairingUrl}\n`);
        }
        output.write(
          `Kind: ${result.kind}; delivery: ${result.delivery}; `
          + `expires: ${new Date(result.expiresAt).toISOString()}\n`
        );
      }
      return result;
    }

    if (command === "devices" && action === "list") {
      const devices = await accessStore.listDevices();
      if (json) printJson(output, { devices });
      else output.write(`${JSON.stringify(devices, null, 2)}\n`);
      return devices;
    }

    if (command === "devices" && action === "revoke") {
      const deviceId = positionals[2];
      if (!deviceId) throw new Error("devices revoke requires a device id");
      const revoked = await accessStore.revokeDevice(deviceId);
      const result = { deviceId, revoked };
      if (json) printJson(output, result);
      else output.write(
        revoked
          ? `Revoked device ${deviceId}\n`
          : `Device not found: ${deviceId}\n`
      );
      return result;
    }

    throw new Error(`Unknown Runtime access command: ${positionals.join(" ")}`);
  } finally {
    if (!store) {
      await accessStore.close();
      await pool.end();
    }
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runRuntimeAccessCli().catch((error) => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
