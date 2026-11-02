#!/usr/bin/env node
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Legacy JSONL fallback. The default Runtime path uses observabilityQuery.
export async function queryProjection({
  root = "/observability", kind = "runs", since = Date.now() - 86_400_000,
  until = Date.now(), limit = 50, runId = "", status = "", emit = console.log
} = {}) {
  if (!["runs", "events", "stages"].includes(kind)) throw new Error("kind must be runs, events or stages");
  limit = Math.max(1, Math.min(1000, Number(limit) || 50));
  if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) throw new Error("Invalid time window");
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error("Unsupported projection schema");
  emit(JSON.stringify({
    kind: "coverage", spaceId: manifest.spaceId, coverage: manifest.coverage,
    snapshot: manifest.snapshot || null,
    requested: { since, until, kind, limit }, limits: manifest.limits,
    note: "Append-only revisions; deduplicate runs by runId and greatest sourceCursor/projectedAt."
  }));
  let count = 0;
  let malformed = 0;
  let missing = 0;
  let truncated = false;
  let scannedBytes = 0;
  const maxScanBytes = 64 * 1024 * 1024;
  const files = manifest.files.filter((file) =>
    file.kind === kind && file.until >= since && file.since <= until
  ).sort((a, b) => b.day.localeCompare(a.day) || b.path.localeCompare(a.path));
  outer: for (const file of files) {
    if (!/^daily\/\d{4}-\d{2}-\d{2}\/(?:runs|events|stages)-\d{8}\.jsonl$/.test(file.path)) {
      throw new Error("Invalid manifest file path");
    }
    if (scannedBytes + file.bytes > maxScanBytes) { truncated = true; break; }
    scannedBytes += file.bytes;
    if (file.bytes <= 0) continue;
    const stream = createReadStream(join(root, file.path), { start: 0, end: file.bytes - 1 });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let record;
        try { record = JSON.parse(line); } catch { malformed++; continue; }
        if (record.timestamp < since || record.timestamp > until
          || (runId && record.runId !== runId) || (status && record.status !== status)) continue;
        if (count >= limit) { truncated = true; break outer; }
        emit(JSON.stringify(record));
        count++;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing++;
    } finally { lines.close(); stream.destroy(); }
  }
  emit(JSON.stringify({ kind: "query-result", returned: count, truncated, malformed, missing, scannedBytes }));
  return { count, truncated, malformed, missing };
}

async function main(args) {
  if (args.includes("--help")) {
    console.log("node obs.mjs [runs|events|stages] [--root /observability] [--since ISO] [--until ISO] [--run ID] [--status failed] [--limit 50]");
    return;
  }
  const options = { kind: args[0] && !args[0].startsWith("--") ? args.shift() : "runs" };
  const keys = { "--root": "root", "--since": "since", "--until": "until", "--run": "runId", "--status": "status", "--limit": "limit" };
  while (args.length) {
    const flag = args.shift();
    const key = keys[flag];
    if (!key || !args.length) throw new Error(`Unknown or incomplete option: ${flag}`);
    const value = args.shift();
    options[key] = ["since", "until"].includes(key) ? Date.parse(value) : key === "limit" ? Number(value) : value;
  }
  await queryProjection(options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
