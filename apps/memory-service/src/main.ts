import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { core } from "./upstream.ts";
import { createMemoryGateway } from "./gateway.ts";
import { OssStorageAdapter } from "./oss-storage.ts";
import { createMemoryPortal } from "./portal.ts";

const secret = readFileSync(process.env.ZION_MEMORY_BRIDGE_SECRET_FILE || "", "utf8").trim();
const directory = resolve(process.env.AGENT_FS_HOME || "");
if (!process.env.AGENT_FS_HOME) throw new Error("Set a persistent AGENT_FS_HOME for SQLite metadata");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const runtimeUrl = new URL(process.env.ZION_ACCOUNT_RUNTIME_URL || "");
if (runtimeUrl.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(runtimeUrl.hostname)) {
  throw new Error("Account validation requires HTTPS or loopback");
}
const storage = process.env.AGENT_FS_STORAGE_PROVIDER === "oss"
  ? new OssStorageAdapter()
  : core.createStorageAdapter(core.getConfig().s3);
if (storage instanceof OssStorageAdapter && !await storage.checkVersioningEnabled()) {
  throw new Error("OSS Bucket versioning must be enabled before storing memory history");
}
const db = core.createDatabase(resolve(directory, "agent-fs.db"));
db.$client.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
const gateway = createMemoryGateway({
  db, storage, secret, runtimeUrl: runtimeUrl.origin,
  accountIssuer: process.env.ZIOON_ACCOUNT_ISSUER || "",
  adcOrigin: process.env.ZIOON_ADC_ORIGIN || "",
  origins: (process.env.ZION_MEMORY_ALLOWED_ORIGINS || "").split(",").filter(Boolean)
});
const websiteOrigin = process.env.ZION_MEMORY_WEBSITE_ORIGIN;
const portal = websiteOrigin ? createMemoryPortal({
  db, gateway, secret, publicOrigin: websiteOrigin,
  issuer: process.env.ZIOON_ACCOUNT_ISSUER || "",
  adcOrigin: process.env.ZIOON_ADC_ORIGIN || ""
}) : null;
const server = Bun.serve({
  hostname: process.env.ZION_MEMORY_HOST || "127.0.0.1",
  port: Number(process.env.ZION_MEMORY_PORT || 18991),
  maxRequestBodySize: 5 * 1024 * 1024,
  async fetch(request) {
    if (portal && new URL(request.url).host === new URL(websiteOrigin).host) {
      const response = await portal.fetch(request);
      if (response) return response;
    }
    return gateway.fetch(request);
  }
});
console.log(`Zion memory service ready on ${server.hostname}:${server.port}; agent-fs ${core.VERSION}; ${storage.constructor.name}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop();
  db.$client.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.$client.close();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
