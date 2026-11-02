import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClientPortal } from "./app.mjs";

const key = await readFile(process.env.ZIOON_PORTAL_SESSION_KEY_FILE);
const portals = [];
for (const [app, defaultPort] of [["workbench", 8778], ["mobile", 8779], ["admin", 8780]]) {
  const prefix = `ZIOON_${app.toUpperCase()}_`;
  const portal = createClientPortal({ app, key,
    origin: process.env[prefix + "ORIGIN"] || `https://${app}.zioon.tech`,
    dist: resolve(process.env[prefix + "DIST"] || `dist/${app}`),
    runtimeOrigin: process.env.ZIOON_RUNTIME_ORIGIN || "https://runtime.zioon.tech",
    runtimeTarget: process.env.ZIOON_RUNTIME_TARGET || "http://127.0.0.1:8766" });
  await new Promise((resolve, reject) => {
    portal.server.once("error", reject);
    portal.server.listen(Number(process.env[prefix + "PORT"] || defaultPort), "127.0.0.1", resolve);
  });
  portals.push(portal);
  console.log(`Zioon ${app} listening on loopback`);
}
let closing = false;
const shutdown = async () => {
  if (closing) return; closing = true;
  await Promise.all(portals.map(portal => portal.close()));
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
