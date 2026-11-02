import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const UPSTREAM_COMMIT = "aecd4c83606f45325daece46b01f0c38ad2cc0ed";
const root = resolve(process.env.AGENT_FS_UPSTREAM_DIR || "");
if (!process.env.AGENT_FS_UPSTREAM_DIR) throw new Error("Set AGENT_FS_UPSTREAM_DIR to the pinned agent-fs checkout");
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (commit !== UPSTREAM_COMMIT || version !== "0.18.5") throw new Error("agent-fs checkout does not match the reviewed version");
export const core = await import(pathToFileURL(resolve(root, "packages/core/src/index.ts")).href);
export const { createApp } = await import(pathToFileURL(resolve(root, "packages/server/src/app.ts")).href);
export const { createMcpServer } = await import(pathToFileURL(resolve(root, "packages/mcp/src/server.ts")).href);
export const { WebStandardStreamableHTTPServerTransport } = await import(pathToFileURL(resolve(
  root, "packages/server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js"
)).href);
// Resolve ORM from the upstream checkout; do not install a second core/ORM.
export const { eq } = await import(pathToFileURL(resolve(root, "packages/core/node_modules/drizzle-orm/index.js")).href);
