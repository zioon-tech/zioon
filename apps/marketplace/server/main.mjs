import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createMarketplaceServer } from "./app.mjs";

const keyPath = process.env.ZIOON_MARKETPLACE_SESSION_KEY_FILE
  || "/var/lib/zioon-marketplace/session.key";
await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
try { await writeFile(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" }); }
catch (error) { if (error.code !== "EEXIST") throw error; }
if ((await stat(keyPath)).mode & 0o077) throw new Error("Session key must be private");
const server = createMarketplaceServer({
  key: await readFile(keyPath),
  origin: process.env.ZIOON_MARKETPLACE_ORIGIN || "https://marketplace.zioon.tech",
  runtimeOrigin: process.env.ZIOON_RUNTIME_ORIGIN || "https://runtime.zioon.tech",
  runtimeTarget: process.env.ZIOON_RUNTIME_TARGET || "http://127.0.0.1:8766",
  dist: process.env.ZIOON_MARKETPLACE_DIST || fileURLToPath(new URL("../dist", import.meta.url)),
  allowLoopbackHttp: process.env.ZIOON_MARKETPLACE_DEVELOPMENT === "1",
});
server.listen(Number(process.env.PORT || 8777), "127.0.0.1", () =>
  console.log("Zioon Marketplace is listening on loopback"));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
});
