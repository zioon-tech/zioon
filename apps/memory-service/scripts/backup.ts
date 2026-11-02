import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import "../src/upstream.ts";

const sqliteVec = await import(pathToFileURL(join(process.env.AGENT_FS_UPSTREAM_DIR, "packages/core/node_modules/sqlite-vec/index.mjs")).href);

const source = process.env.AGENT_FS_HOME;
const output = process.argv[2];
if (!source || !output) throw new Error("Usage: AGENT_FS_HOME=... bun scripts/backup.ts <backup-directory>");
mkdirSync(output, { recursive: true, mode: 0o700 });
const destination = join(resolve(output), `agent-fs-${new Date().toISOString().replaceAll(":", "-")}.db`);
if (existsSync(destination)) throw new Error("Backup already exists");
const db = new Database(join(resolve(source), "agent-fs.db"), { readonly: true });
sqliteVec.load(db);
try {
  db.run("VACUUM INTO ?", [destination]);
  chmodSync(destination, 0o600);
  const copy = new Database(destination, { readonly: true });
  sqliteVec.load(copy);
  try {
    const integrity = copy.query("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") throw new Error("Backup integrity check failed");
  } finally { copy.close(); }
  console.log(`SQLite snapshot verified: ${destination}`);
} finally { db.close(); }
