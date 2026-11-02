#!/usr/bin/env node
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  buildBiographyDigest,
  parseBiographyEventsJsonl,
  serializeBiographyEventsJsonl
} from "../extensions/dev.identity/identity-core.js";

function usage() {
  return `Usage:
  node scripts/recover-identity-biography-files.mjs --target-root <dev.identity-data-root> \\
    --candidate-root <old-dev.identity-data-root> [--candidate-root <root> ...] [--apply]

Options:
  --target-root <path>        Current dev.identity plugin data root.
  --candidate-root <path>     Candidate old dev.identity data root. Repeatable.
  --candidate-events <path>   Candidate biography/events.jsonl file. Repeatable.
  --candidate-digest <path>   Candidate biography/digest.md file. Repeatable.
  --backup-dir <path>         Backup directory for target files when applying.
  --apply                     Write merged events.jsonl and digest.md. Default is dry-run.
  --json                      Print machine-readable JSON.
  --help                      Show this help.

The script only merges biography/events.jsonl records by event id and rebuilds
biography/digest.md. It never imports Runtime runs or Workbench sessions.`;
}

function fail(message) {
  console.error(`identity-biography-recover: ${message}`);
  process.exit(1);
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    targetRoot: "",
    candidateRoots: [],
    candidateEvents: [],
    candidateDigests: [],
    backupDir: "",
    apply: false,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value || value.startsWith("--")) fail(`missing value for ${arg}`);
      return value;
    };
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--target-root") {
      args.targetRoot = next();
    } else if (arg === "--candidate-root") {
      args.candidateRoots.push(next());
    } else if (arg === "--candidate-events") {
      args.candidateEvents.push(next());
    } else if (arg === "--candidate-digest") {
      args.candidateDigests.push(next());
    } else if (arg === "--backup-dir") {
      args.backupDir = next();
    } else if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg.startsWith("--")) {
      fail(`unknown option: ${arg}`);
    } else {
      args.candidateRoots.push(arg);
    }
  }
  if (!args.targetRoot) fail("--target-root is required");
  return args;
}

async function optionalRead(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

async function optionalCopy(source, target) {
  try {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

async function fileInfo(path) {
  try {
    const current = await stat(path);
    return { exists: true, bytes: current.size };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { exists: false, bytes: 0 };
    }
    throw error;
  }
}

function eventPathFromRoot(root) {
  return join(resolve(root), "biography", "events.jsonl");
}

async function loadEvents(path) {
  const content = await optionalRead(path);
  const events = parseBiographyEventsJsonl(content || "");
  return {
    path,
    exists: content != null,
    events,
    count: events.length,
    bytes: Buffer.byteLength(content || "", "utf8")
  };
}

function parseBiographyDigest(text) {
  const events = [];
  let currentProject = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)(?:\s+\[project\/([^\]]+)])?(?:（|$)/);
    if (heading && heading[1] !== "可查询索引") {
      currentProject = String(heading[2] || heading[1] || "").trim();
      if (currentProject === "未归类") currentProject = "";
      continue;
    }
    if (!line.includes("[[memory:")) continue;
    const match = line.match(/^-\s+(\d{4}-\d{2}-\d{2})\s+(.+?)\s+\[\[memory:([^\]]+)]](?:（会话：([^）]+)）)?/);
    if (!match) continue;
    const [, date, body, id, explicitSessionId] = match;
    let rest = body.trim();
    const labels = [];
    for (;;) {
      const label = rest.match(/^\[([^\]]+)]\s*/);
      if (!label) break;
      labels.push(label[1]);
      rest = rest.slice(label[0].length).trim();
    }
    const kind = labels.find((label) => ["decision", "milestone", "outcome", "lesson"].includes(label)) || "outcome";
    const topics = labels
      .filter((label) => label.startsWith("topic/"))
      .map((label) => label.slice("topic/".length))
      .filter(Boolean);
    const sessionId = explicitSessionId || String(id).split(":")[0] || "";
    const parts = String(id).split(":");
    const runId = parts.length >= 3 ? parts.slice(1, -1).join(":") : "";
    events.push({
      id,
      at: `${date}T12:00:00.000Z`,
      kind,
      summary: rest,
      confirmed: false,
      project: currentProject,
      topics,
      sessionId,
      runId
    });
  }
  return parseBiographyEventsJsonl(serializeBiographyEventsJsonl(events));
}

async function loadDigestEvents(path) {
  const content = await optionalRead(path);
  const events = parseBiographyDigest(content || "");
  return {
    path,
    exists: content != null,
    events,
    count: events.length,
    bytes: Buffer.byteLength(content || "", "utf8"),
    sourceType: "digest"
  };
}

function defaultBackupDir(targetRoot) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return join(dirname(resolve(targetRoot)), ".biography-recovery-backups", stamp);
}

async function main() {
  const args = parseArgs();
  const targetRoot = resolve(args.targetRoot);
  const targetEventsPath = eventPathFromRoot(targetRoot);
  const targetDigestPath = join(targetRoot, "biography", "digest.md");
  const candidatePaths = [
    ...args.candidateRoots.map(eventPathFromRoot),
    ...args.candidateEvents.map((path) => resolve(path))
  ];
  const uniqueCandidatePaths = Array.from(new Set(candidatePaths))
    .filter((path) => path !== targetEventsPath);
  const uniqueDigestPaths = Array.from(new Set(args.candidateDigests.map((path) => resolve(path))))
    .filter((path) => path !== targetDigestPath);

  const current = await loadEvents(targetEventsPath);
  const candidates = [];
  for (const path of uniqueCandidatePaths) {
    candidates.push(await loadEvents(path));
  }
  for (const path of uniqueDigestPaths) {
    candidates.push(await loadDigestEvents(path));
  }

  const mergedById = new Map();
  for (const event of current.events) mergedById.set(event.id, event);
  const imported = [];
  for (const candidate of candidates) {
    for (const event of candidate.events) {
      if (mergedById.has(event.id)) continue;
      mergedById.set(event.id, event);
      imported.push({ id: event.id, source: candidate.path });
    }
  }

  const merged = Array.from(mergedById.values())
    .sort((left, right) =>
      Date.parse(left.at) - Date.parse(right.at)
      || String(left.id).localeCompare(String(right.id))
    );
  const digest = buildBiographyDigest(merged);
  const result = {
    targetRoot,
    targetEvents: { path: targetEventsPath, count: current.count, bytes: current.bytes },
    candidates: candidates.map(({ path, exists, count, bytes, sourceType }) => ({
      path, exists, count, bytes, sourceType: sourceType || "events"
    })),
    mergedCount: merged.length,
    importedCount: imported.length,
    importedBySource: imported.reduce((acc, item) => {
      acc[item.source] = (acc[item.source] || 0) + 1;
      return acc;
    }, {}),
    apply: args.apply
  };

  if (args.apply && imported.length) {
    const backupDir = resolve(args.backupDir || defaultBackupDir(targetRoot));
    await mkdir(backupDir, { recursive: true });
    await optionalCopy(targetEventsPath, join(backupDir, basename(targetEventsPath)));
    await optionalCopy(targetDigestPath, join(backupDir, basename(targetDigestPath)));
    await mkdir(dirname(targetEventsPath), { recursive: true });
    await writeFile(targetEventsPath, serializeBiographyEventsJsonl(merged), "utf8");
    await writeFile(targetDigestPath, digest, "utf8");
    result.backupDir = backupDir;
    result.written = {
      events: await fileInfo(targetEventsPath),
      digest: await fileInfo(targetDigestPath)
    };
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`target=${targetEventsPath}`);
  console.log(`current_events=${current.count}`);
  for (const candidate of candidates) {
    console.log(`candidate_events=${candidate.count} exists=${candidate.exists ? 1 : 0} path=${candidate.path}`);
  }
  console.log(`merged_events=${result.mergedCount}`);
  console.log(`imported_events=${result.importedCount}`);
  if (!args.apply) console.log("dry_run=1");
  else if (imported.length) console.log(`backup=${result.backupDir}`);
  else console.log("no_changes=1");
}

main().catch((error) => {
  fail(error?.message || String(error));
});
