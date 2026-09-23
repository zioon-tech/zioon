#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { PostgresAccountStore } from "../apps/runtime/src/accounts/postgres-account-store.mjs";
import { initializePostgresRuntimeSchema } from "../apps/runtime/src/postgres-runtime-schema.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require(["node", "sqlite"].join(":"));
const { Pool } = pg;

const DEFAULT_CHUNK_SIZE = 500;
const IMPORT_LOCK_ID = 983724612;
const MODEL_REQUEST_CONFIG_KEYS = [
  "frequency_penalty", "max_completion_tokens", "max_tokens",
  "model", "presence_penalty", "reasoning_effort", "seed", "stop", "stream",
  "temperature", "thinking", "top_p"
];

function usage() {
  return `Usage:
  node scripts/import-sqlite-runtime-to-postgres.mjs --sqlite <runtime.sqlite3> \\
    --database-url <postgres-url> --space <space-id> \\
    --owner-issuer <oidc-issuer> --owner-subject <oidc-subject> --apply \\
    --backup-dir <backup-dir>

Dry-run:
  node scripts/import-sqlite-runtime-to-postgres.mjs --sqlite /var/lib/zion-next/runtime.sqlite3 \\
    --database-url "$ZION_DATABASE_URL" --space space:production --json

Options:
  --sqlite <path>             Source SQLite Runtime database.
  --database-url <url>        Target PostgreSQL URL, or ZION_DATABASE_URL.
  --space <id>                Target Space ID, or ZION_SPACE_ID.
  --space-name <name>         Created Space name. Defaults to the Space ID.
  --owner-issuer <url>        OIDC issuer for the owner identity.
  --owner-subject <sub>       OIDC subject for the owner identity.
  --owner-name <name>         Owner display name. Defaults to owner subject.
  --owner-email <email>       Optional owner email.
  --source-id <id>            Stable import source marker. Defaults to SQLite hash.
  --chunk-size <n>            Rows per insert batch. Default: ${DEFAULT_CHUNK_SIZE}.
  --verify <hash|count>       Import verification mode. Default: hash.
  --backup-dir <path>         Copy SQLite db, -wal and -shm before applying.
  --skip-source-backup        Apply without copying SQLite source files.
  --skip-integrity-check      Skip PRAGMA integrity_check for large production dbs.
  --allow-non-empty-target    Permit only idempotent reruns when target data matches.
  --preserve-raw-model-requests
                              Import historical model.request payloads verbatim.
  --include-internal-receipts Import legacy device invocation receipt cache.
  --apply                     Mutate PostgreSQL. Omit for dry-run.
  --json                      Print machine-readable JSON.
  --help                      Show this help.

The script never deletes or overwrites source SQLite data. In apply mode it
refuses to run without an explicit backup directory.`;
}

function fail(message) {
  console.error(`sqlite-import: ${message}`);
  process.exit(1);
}

function readArg(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`missing value for ${name}`);
  return value;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function parseArgs(argv = process.argv.slice(2), environment = process.env) {
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    return { help: true };
  }
  const chunkSize = Number(readArg(argv, "--chunk-size", DEFAULT_CHUNK_SIZE));
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 5000) {
    fail("--chunk-size must be an integer between 1 and 5000");
  }
  const verify = readArg(argv, "--verify", environment.ZION_IMPORT_VERIFY || "hash");
  if (!["hash", "count"].includes(verify)) fail("--verify must be hash or count");
  return {
    sqlitePath: readArg(argv, "--sqlite", environment.ZION_RUNTIME_DB || ""),
    databaseUrl: readArg(argv, "--database-url", environment.ZION_DATABASE_URL || ""),
    spaceId: readArg(argv, "--space", environment.ZION_SPACE_ID || ""),
    spaceName: readArg(argv, "--space-name", environment.ZION_SPACE_NAME || ""),
    ownerIssuer: readArg(argv, "--owner-issuer", environment.ZION_OIDC_ISSUER || ""),
    ownerSubject: readArg(argv, "--owner-subject", ""),
    ownerName: readArg(argv, "--owner-name", ""),
    ownerEmail: readArg(argv, "--owner-email", ""),
    sourceId: readArg(argv, "--source-id", ""),
    backupDir: readArg(argv, "--backup-dir", ""),
    skipSourceBackup: hasFlag(argv, "--skip-source-backup"),
    skipIntegrityCheck: hasFlag(argv, "--skip-integrity-check"),
    chunkSize,
    verify,
    apply: hasFlag(argv, "--apply"),
    json: hasFlag(argv, "--json"),
    allowNonEmptyTarget: hasFlag(argv, "--allow-non-empty-target"),
    compactModelRequests: !hasFlag(argv, "--preserve-raw-model-requests"),
    includeInternalReceipts: hasFlag(argv, "--include-internal-receipts")
  };
}

const RUNTIME_TABLES = [
  {
    name: "runtime_runs",
    orderBy: ["id"],
    columns: [
      ["id"], ["payload_json", "jsonb"], ["status"], ["updated_at", "integer"]
    ]
  },
  {
    name: "runtime_run_events",
    orderBy: ["run_id", "sequence"],
    columns: [
      ["run_id"], ["sequence", "integer"], ["event_id"], ["payload_json", "jsonb"],
      ["created_at", "integer"]
    ]
  },
  {
    name: "runtime_run_checkpoints",
    orderBy: ["run_id", "sequence"],
    columns: [
      ["run_id"], ["sequence", "integer"], ["attempt_id"], ["payload_json", "jsonb"],
      ["created_at", "integer"]
    ]
  },
  {
    name: "runtime_run_transcript",
    orderBy: ["run_id", "turn", "ordinal"],
    columns: [
      ["run_id"], ["turn", "integer"], ["ordinal", "integer"], ["message_id"],
      ["payload_json", "jsonb"], ["created_at", "integer"]
    ]
  },
  {
    name: "runtime_sessions",
    orderBy: ["id"],
    columns: [
      ["id"], ["payload_json", "jsonb"], ["status"], ["updated_at", "integer"]
    ]
  },
  {
    name: "runtime_session_seed_transcript",
    orderBy: ["session_id", "ordinal"],
    columns: [
      ["session_id"], ["ordinal", "integer"], ["payload_json", "jsonb"],
      ["created_at", "integer"]
    ]
  },
  {
    name: "runtime_session_messages",
    orderBy: ["session_id", "sequence"],
    columns: [
      ["session_id"], ["sequence", "integer"], ["message_id"], ["run_id"], ["role"],
      ["payload_json", "jsonb"], ["created_at", "integer"]
    ]
  },
  {
    name: "runtime_session_message_commands",
    orderBy: ["session_id", "client_request_id"],
    columns: [
      ["session_id"], ["client_request_id"], ["status"], ["response_json", "jsonb"],
      ["created_at", "integer"], ["updated_at", "integer"]
    ]
  },
  {
    name: "runtime_tool_invocation_receipts",
    orderBy: ["invocation_id"],
    columns: [
      ["invocation_id"], ["run_id"], ["tool_name"], ["request_hash"],
      ["result_json", "jsonb"], ["completed_at", "integer"]
    ]
  },
  {
    name: "runtime_artifacts",
    orderBy: ["artifact_id"],
    columns: [
      ["artifact_id"], ["run_id"], ["invocation_id"], ["payload_json", "jsonb"],
      ["created_at", "integer"]
    ]
  },
  {
    name: "runtime_change_sets",
    orderBy: ["change_id"],
    columns: [
      ["change_id"], ["artifact_id"], ["run_id"], ["invocation_id"],
      ["payload_json", "jsonb"], ["created_at", "integer"]
    ]
  },
  {
    name: "runtime_todo_lists",
    orderBy: ["owner_id"],
    columns: [
      ["owner_id"], ["payload_json", "jsonb"], ["updated_at", "integer"]
    ]
  },
  {
    name: "runtime_workbench_state",
    orderBy: ["space_id"],
    singleton: true,
    sourceWhere: "id = 1",
    columns: [
      ["version", "integer"], ["revision", "integer"], ["tree_json", "jsonb"],
      ["index_json", "jsonb"], ["updated_at", "integer"]
    ]
  },
  {
    name: "runtime_workbench_documents",
    orderBy: ["id"],
    columns: [["id"], ["text"], ["updated_at", "integer"]]
  },
  {
    name: "runtime_workbench_metadata",
    orderBy: ["id"],
    columns: [["id"], ["meta_json", "jsonb"], ["updated_at", "integer"]]
  },
  {
    name: "runtime_workbench_session_heads",
    orderBy: ["id"],
    columns: [
      ["id"], ["revision", "integer"], ["content_hash"], ["updated_at", "integer"]
    ]
  },
  {
    name: "runtime_workbench_session_revisions",
    orderBy: ["session_id", "revision"],
    columns: [
      ["session_id"], ["revision", "integer"], ["text"], ["meta_json", "jsonb"],
      ["content_hash"], ["reason"], ["operation_id"], ["created_at", "integer"]
    ]
  },
  {
    name: "runtime_workbench_operations",
    orderBy: ["operation_id"],
    columns: [
      ["operation_id"], ["session_id"], ["session_revision", "integer"],
      ["result_json", "jsonb"], ["created_at", "integer"]
    ]
  },
  {
    name: "runtime_workbench_tombstones",
    orderBy: ["id"],
    columns: [["id"], ["revision", "integer"], ["deleted_at", "integer"]]
  },
  {
    name: "runtime_workbench_kv",
    orderBy: ["key"],
    columns: [["key"], ["value_json", "jsonb"], ["updated_at", "integer"]]
  },
  {
    name: "runtime_workbench_events",
    orderBy: ["sequence"],
    preserveSerial: { sequence: "runtime_workbench_events_sequence_seq" },
    columns: [
      ["sequence", "integer"], ["type"], ["session_id"], ["run_id"], ["revision"],
      ["session_revision", "integer"], ["source_client_id"], ["payload_json", "jsonb"],
      ["created_at", "integer"]
    ]
  },
  {
    name: "runtime_collaboration_documents",
    orderBy: ["session_id"],
    columns: [
      ["session_id"], ["state_blob", "bytea"], ["state_hash"], ["version", "integer"],
      ["updated_at", "integer"]
    ]
  },
  {
    name: "runtime_state_migrations",
    orderBy: ["source", "fingerprint"],
    columns: [
      ["source"], ["fingerprint"], ["result_json", "jsonb"], ["created_at", "integer"]
    ]
  },
  {
    name: "runtime_scheduler_tasks",
    orderBy: ["id"],
    legacySchedulerKey: "tasks",
    columns: [
      ["id"], ["payload_json", "jsonb"], ["enabled", "boolean"], ["next_run", "integer"],
      ["created_at", "integer"], ["updated_at", "integer"]
    ]
  },
  {
    name: "runtime_scheduler_runs",
    orderBy: ["id"],
    legacySchedulerKey: "runs",
    columns: [
      ["id"], ["task_id"], ["occurrence_id"], ["status"], ["lease_until", "integer"],
      ["payload_json", "jsonb"], ["created_at", "integer"], ["updated_at", "integer"]
    ]
  },
  {
    name: "runtime_scheduler_migrations",
    orderBy: ["source", "fingerprint"],
    columns: [
      ["source"], ["fingerprint"], ["result_json", "jsonb"], ["created_at", "integer"]
    ]
  },
  {
    name: "runtime_access_pairings",
    orderBy: ["pairing_id"],
    columns: [
      ["pairing_id"], ["secret_hash"], ["user_code_hash"], ["kind"], ["delivery"],
      ["scopes_json", "jsonb"], ["label"], ["created_at", "integer"],
      ["expires_at", "integer"], ["attempts_remaining", "integer"],
      ["consumed_at", "integer"], ["consumed_by_device_id"]
    ]
  },
  {
    name: "runtime_access_devices",
    orderBy: ["device_id"],
    columns: [
      ["device_id"], ["kind"], ["label"], ["platform"], ["scopes_json", "jsonb"],
      ["created_at", "integer"], ["updated_at", "integer"], ["last_seen_at", "integer"],
      ["revoked_at", "integer"]
    ]
  },
  {
    name: "runtime_access_credentials",
    orderBy: ["credential_id"],
    columns: [
      ["credential_id"], ["device_id"], ["secret_hash"], ["created_at", "integer"],
      ["expires_at", "integer"], ["last_used_at", "integer"], ["revoked_at", "integer"]
    ]
  },
  {
    name: "runtime_device_nodes",
    orderBy: ["node_id"],
    columns: [
      ["node_id"], ["registration_json", "jsonb"], ["last_seen_at", "integer"],
      ["updated_at", "integer"]
    ]
  },
  {
    name: "runtime_project_bindings",
    orderBy: ["project_id", "node_id", "resource_id"],
    columns: [
      ["project_id"], ["node_id"], ["resource_id"], ["updated_at", "integer"]
    ]
  },
  {
    name: "runtime_invocation_receipts",
    orderBy: ["invocation_id"],
    internalCache: true,
    columns: [
      ["invocation_id"], ["node_id"], ["result_json", "jsonb"], ["completed_at", "integer"]
    ]
  }
];

export const MIGRATION_TABLES = Object.freeze(RUNTIME_TABLES);

function q(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return JSON.stringify({ base64: Buffer.from(value).toString("base64") });
    }
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  if (typeof value === "bigint") return JSON.stringify(String(value));
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  return JSON.stringify(value) ?? "null";
}

function hashJson(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function summarizeModelRequestEvent(event) {
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  const requestPayload = data.payload && typeof data.payload === "object"
    ? data.payload
    : null;
  if (!requestPayload) return event;
  const messages = Array.isArray(requestPayload.messages) ? requestPayload.messages : [];
  const tools = Array.isArray(requestPayload.tools) ? requestPayload.tools : [];
  const { payload: _payload, ...metadata } = data;
  return {
    ...event,
    data: {
      ...metadata,
      summaryVersion: 1,
      messageCount: messages.length,
      toolCount: tools.length,
      payloadBytes: Buffer.byteLength(canonicalJson(requestPayload), "utf8"),
      payloadHash: hashJson(requestPayload),
      messagesHash: hashJson(messages),
      toolsHash: hashJson(tools),
      config: Object.fromEntries(MODEL_REQUEST_CONFIG_KEYS
        .filter((key) => requestPayload[key] !== undefined)
        .map((key) => [key, requestPayload[key]]))
    }
  };
}

function projectRow(row, table, {
  compactModelRequests = true,
  compactionStats = null
} = {}) {
  if (!compactModelRequests || table.name !== "runtime_run_events" || row.payload_json == null) {
    return row;
  }
  let event = null;
  try {
    event = typeof row.payload_json === "string"
      ? JSON.parse(row.payload_json)
      : JSON.parse(JSON.stringify(row.payload_json));
  } catch {
    return row;
  }
  if (event?.type !== "model.request" || !event?.data?.payload) return row;
  const before = typeof row.payload_json === "string"
    ? row.payload_json
    : JSON.stringify(row.payload_json);
  const after = JSON.stringify(summarizeModelRequestEvent(event));
  if (after === before) return row;
  if (compactionStats) {
    compactionStats.compactedRows += 1;
    compactionStats.compactedBytesBefore += Buffer.byteLength(before, "utf8");
    compactionStats.compactedBytesAfter += Buffer.byteLength(after, "utf8");
  }
  return { ...row, payload_json: after };
}

function normalizeCell(value, type) {
  if (value == null) return null;
  if (type === "jsonb") {
    if (typeof value === "string") return JSON.parse(value);
    return JSON.parse(JSON.stringify(value));
  }
  if (type === "bytea") return Buffer.from(value);
  if (type === "integer") return String(Math.trunc(Number(value)));
  if (type === "boolean") return Boolean(Number(value));
  return String(value);
}

function encodeCell(value, type) {
  const normalized = normalizeCell(value, type);
  if (type === "jsonb") return normalized == null ? null : JSON.stringify(normalized);
  if (type === "bytea") return normalized == null ? null : Buffer.from(normalized);
  if (type === "integer") return normalized == null ? null : Number(normalized);
  return normalized;
}

function hashRow(row, table) {
  return canonicalJson(table.columns.map(([column, type = "text"]) => [
    column,
    normalizeCell(row[column], type)
  ]));
}

function openSqlite(path) {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA query_only = ON");
    return db;
  }
}

function sqliteTables(db) {
  return new Set(db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all().map((row) => String(row.name)));
}

function readJson(value, fallback) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function legacySchedulerPayload(db) {
  try {
    const row = db.prepare(
      "SELECT payload_json FROM runtime_scheduler_state WHERE id = 1"
    ).get();
    return readJson(row?.payload_json, {});
  } catch {
    return {};
  }
}

function legacySchedulerRows(db, table) {
  if (!table.legacySchedulerKey) return [];
  const payload = legacySchedulerPayload(db);
  const items = Array.isArray(payload?.[table.legacySchedulerKey])
    ? payload[table.legacySchedulerKey]
    : [];
  const rows = items
    .filter((item) => item && item.id)
    .map((item, index) => {
      if (table.legacySchedulerKey === "tasks") {
        const created = Number(item.createdAt || item.updatedAt || 0);
        return {
          __rowid: index + 1,
          id: String(item.id),
          payload_json: JSON.stringify(item),
          enabled: item.enabled === false ? 0 : 1,
          next_run: item.nextRun == null ? null : Number(item.nextRun),
          created_at: created,
          updated_at: Number(item.updatedAt || created)
        };
      }
      const created = Number(item.createdAt || item.updatedAt || 0);
      return {
        __rowid: index + 1,
        id: String(item.id),
        task_id: String(item.taskId || ""),
        occurrence_id: String(item.occurrenceId || item.id),
        status: String(item.status || "pending"),
        lease_until: item.leaseUntil == null ? null : Number(item.leaseUntil),
        payload_json: JSON.stringify(item),
        created_at: created,
        updated_at: Number(item.updatedAt || created)
      };
    });
  return rows.sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function sourceWhere(table) {
  return table.sourceWhere ? ` WHERE ${table.sourceWhere}` : "";
}

function rowWhere(table) {
  return table.sourceWhere ? ` AND (${table.sourceWhere})` : "";
}

function sourceColumns(table) {
  return table.columns.map(([column]) => column);
}

function sourceTableCount(db, table) {
  try {
    return Number(db.prepare(
      `SELECT COUNT(*) AS count FROM ${q(table.name)}${sourceWhere(table)}`
    ).get().count);
  } catch {
    return 0;
  }
}

function useLegacySchedulerRows(db, table, existing) {
  return table.legacySchedulerKey
    && existing.has("runtime_scheduler_state")
    && (!existing.has(table.name) || sourceTableCount(db, table) === 0)
    && legacySchedulerRows(db, table).length > 0;
}

function sourceMaxRowid(db, table) {
  return Number(db.prepare(
    `SELECT COALESCE(MAX(rowid), 0) AS rowid FROM ${q(table.name)}${sourceWhere(table)}`
  ).get().rowid);
}

function orderedSourceRows(db, table, { limit, offset }) {
  if (table.__legacySchedulerRows) {
    return table.__legacySchedulerRows.slice(offset, offset + limit);
  }
  const columns = sourceColumns(table).map(q).join(", ");
  const orderBy = table.orderBy
    .filter((column) => column !== "space_id")
    .map(q)
    .join(", ");
  return db.prepare(`
    SELECT ${columns}
    FROM ${q(table.name)}
    ${sourceWhere(table)}
    ORDER BY ${orderBy || "rowid"}
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function sourceRowsAfter(db, table, { lastRowid, limit }) {
  if (table.__legacySchedulerRows) {
    return table.__legacySchedulerRows
      .filter((row) => Number(row.__rowid) > Number(lastRowid || 0))
      .slice(0, limit);
  }
  const columns = sourceColumns(table).map(q).join(", ");
  return db.prepare(`
    SELECT rowid AS __rowid, ${columns}
    FROM ${q(table.name)}
    WHERE rowid > ?${rowWhere(table)}
    ORDER BY rowid
    LIMIT ?
  `).all(lastRowid, limit);
}

function tableHashFromRows(rows, table) {
  const digest = createHash("sha256");
  for (const row of rows) {
    digest.update(hashRow(row, table));
    digest.update("\n");
  }
  return digest.digest("hex");
}

function sqliteTableStats(db, table, chunkSize, options = {}) {
  if (options.verify === "count") {
    const count = table.__legacySchedulerRows
      ? table.__legacySchedulerRows.length
      : sourceTableCount(db, table);
    return {
      count,
      hash: `count:${count}`,
      maxRowid: table.__legacySchedulerRows
        ? table.__legacySchedulerRows.length
        : sourceMaxRowid(db, table),
      compactedRows: 0,
      compactedBytesBefore: 0,
      compactedBytesAfter: 0
    };
  }
  const digest = createHash("sha256");
  let offset = 0;
  let count = 0;
  const compactionStats = {
    compactedRows: 0,
    compactedBytesBefore: 0,
    compactedBytesAfter: 0
  };
  for (;;) {
    const rows = orderedSourceRows(db, table, { limit: chunkSize, offset });
    if (!rows.length) break;
    count += rows.length;
    for (const row of rows) {
      digest.update(hashRow(projectRow(row, table, {
        ...options,
        compactionStats
      }), table));
      digest.update("\n");
    }
    offset += rows.length;
  }
  return {
    count,
    hash: digest.digest("hex"),
    ...compactionStats,
    maxRowid: table.__legacySchedulerRows
      ? table.__legacySchedulerRows.length
      : sourceMaxRowid(db, table)
  };
}

function requiredColumnsPresent(db, table) {
  const columns = new Set(db.prepare(
    `PRAGMA table_info(${q(table.name)})`
  ).all().map((column) => String(column.name)));
  return sourceColumns(table).every((column) => columns.has(column));
}

export function inspectSqliteSource(sqlitePath, {
  chunkSize = DEFAULT_CHUNK_SIZE,
  compactModelRequests = true,
  verify = "hash",
  integrityCheck = true,
  includeInternalReceipts = false
} = {}) {
  const resolved = resolve(sqlitePath);
  const db = openSqlite(resolved);
  try {
    let integrityStatus = "skipped";
    if (integrityCheck) {
      const integrity = db.prepare("PRAGMA integrity_check").get();
      integrityStatus = String(Object.values(integrity || {})[0] || "");
      if (integrityStatus !== "ok") {
        throw new Error(`SQLite integrity_check failed: ${integrityStatus}`);
      }
    }
    const existing = sqliteTables(db);
    const tables = [];
    const digest = createHash("sha256");
    for (const table of RUNTIME_TABLES) {
      if (table.internalCache && !includeInternalReceipts) {
        const count = existing.has(table.name) ? sourceTableCount(db, table) : 0;
        tables.push({
          table: table.name,
          status: "skipped-internal-cache",
          count,
          hash: `skipped:${count}`,
          maxRowid: 0
        });
        digest.update(`${table.name}:skipped:${count}\n`);
        continue;
      }
      const migrationTable = useLegacySchedulerRows(db, table, existing)
        ? { ...table, __legacySchedulerRows: legacySchedulerRows(db, table) }
        : table;
      if (!existing.has(table.name) && !migrationTable.__legacySchedulerRows) {
        tables.push({ table: table.name, status: "missing", count: 0, hash: "" });
        continue;
      }
      if (!migrationTable.__legacySchedulerRows && !requiredColumnsPresent(db, table)) {
        throw new Error(`SQLite table ${table.name} is missing required columns`);
      }
      const stats = sqliteTableStats(db, migrationTable, chunkSize, {
        compactModelRequests,
        verify
      });
      tables.push({
        table: table.name,
        status: migrationTable.__legacySchedulerRows ? "legacy-snapshot" : "ready",
        count: stats.count,
        hash: stats.hash,
        maxRowid: stats.maxRowid,
        ...(stats.compactedRows > 0 ? {
          compactedRows: stats.compactedRows,
          compactedBytesBefore: stats.compactedBytesBefore,
          compactedBytesAfter: stats.compactedBytesAfter
        } : {})
      });
      digest.update(`${table.name}:${stats.count}:${stats.hash}\n`);
    }
    return {
      sqlitePath: resolved,
      integrity: integrityStatus,
      sourceHash: digest.digest("hex"),
      tables
    };
  } finally {
    db.close();
  }
}

async function copyIfExists(source, destination) {
  try {
    await stat(source);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  await copyFile(source, destination);
  return destination;
}

async function backupSqlite(sourcePath, backupDir) {
  const resolvedDir = resolve(backupDir);
  await mkdir(resolvedDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const target = join(resolvedDir, `${basename(sourcePath)}.${stamp}`);
  const copied = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${sourcePath}${suffix}`;
    const destination = `${target}${suffix}`;
    const file = await copyIfExists(source, destination);
    if (file) copied.push(file);
  }
  if (!copied.length) throw new Error(`SQLite source not found: ${sourcePath}`);
  return copied;
}

async function ensureOwnerSpace(pool, options) {
  const accounts = await new PostgresAccountStore({ pool }).initialize();
  const {
    spaceId,
    spaceName = spaceId,
    ownerIssuer,
    ownerSubject,
    ownerName = ownerSubject,
    ownerEmail = ""
  } = options;
  if (!ownerIssuer || !ownerSubject) {
    const existing = await accounts.space(spaceId);
    if (!existing) {
      throw new Error("Target Space does not exist; provide --owner-issuer and --owner-subject");
    }
    return { accounts, user: null, space: existing, membership: null };
  }
  new URL(ownerIssuer);
  const user = await accounts.resolveIdentity({
    issuer: ownerIssuer,
    subject: ownerSubject,
    name: ownerName || ownerSubject,
    email: ownerEmail,
    emailVerified: Boolean(ownerEmail)
  });
  const result = await accounts.transaction(async (client) => {
    const existing = await accounts.space(spaceId, client);
    const createdAt = Date.now();
    if (!existing) {
      await client.query(
        `INSERT INTO account_spaces (id, name, kind, created_by, created_at)
         VALUES ($1, $2, 'team', $3, $4)`,
        [spaceId, spaceName || spaceId, user.id, createdAt]
      );
    }
    await client.query(
      `INSERT INTO account_memberships
       (space_id, user_id, role, status, revision, created_at, updated_at)
       VALUES ($1, $2, 'owner', 'active', 1, $3, $3)
       ON CONFLICT (space_id, user_id) DO UPDATE SET
         role = 'owner',
         status = 'active',
         revision = account_memberships.revision + 1,
         updated_at = EXCLUDED.updated_at`,
      [spaceId, user.id, createdAt]
    );
    return {
      space: await accounts.space(spaceId, client),
      membership: await accounts.membership(user.id, spaceId, client)
    };
  });
  return { accounts, user, ...result };
}

async function targetCount(client, table, spaceId) {
  const result = await client.query(
    `SELECT COUNT(*) AS count FROM ${q(table.name)} WHERE space_id = $1`,
    [spaceId]
  );
  return Number(result.rows[0]?.count || 0);
}

function tableByName(name) {
  return RUNTIME_TABLES.find((table) => table.name === name);
}

function insertSql(table) {
  const targetColumns = ["space_id", ...table.columns.map(([column]) => column)];
  const rowWidth = targetColumns.length;
  return (rowCount) => {
    const values = [];
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const placeholders = [];
      for (let columnIndex = 0; columnIndex < rowWidth; columnIndex += 1) {
        const parameter = rowIndex * rowWidth + columnIndex + 1;
        const target = targetColumns[columnIndex];
        const type = target === "space_id"
          ? "text"
          : table.columns[columnIndex - 1]?.[1] || "text";
        placeholders.push(type === "jsonb" ? `$${parameter}::jsonb` : `$${parameter}`);
      }
      values.push(`(${placeholders.join(", ")})`);
    }
    return `
      INSERT INTO ${q(table.name)} (${targetColumns.map(q).join(", ")})
      VALUES ${values.join(", ")}
      ON CONFLICT DO NOTHING
    `;
  };
}

function insertParameters(table, rows, spaceId) {
  const params = [];
  for (const row of rows) {
    params.push(spaceId);
    for (const [column, type = "text"] of table.columns) {
      params.push(encodeCell(row[column], type));
    }
  }
  return params;
}

async function importTable(client, db, table, { spaceId, chunkSize, compactModelRequests = true }) {
  const insert = insertSql(table);
  let lastRowid = 0;
  let imported = 0;
  const compactionStats = {
    compactedRows: 0,
    compactedBytesBefore: 0,
    compactedBytesAfter: 0
  };
  for (;;) {
    const existing = sqliteTables(db);
    const migrationTable = useLegacySchedulerRows(db, table, existing)
      ? { ...table, __legacySchedulerRows: legacySchedulerRows(db, table) }
      : table;
    const rows = sourceRowsAfter(db, migrationTable, { lastRowid, limit: chunkSize });
    if (!rows.length) break;
    const projectedRows = rows.map((row) => projectRow(row, migrationTable, {
      compactModelRequests,
      compactionStats
    }));
    await client.query(insert(rows.length), insertParameters(migrationTable, projectedRows, spaceId));
    lastRowid = Number(rows[rows.length - 1].__rowid);
    imported += rows.length;
  }
  return { imported, lastRowid, ...compactionStats };
}

function targetOrder(table) {
  return table.orderBy.length
    ? table.orderBy.map(q).join(", ")
    : table.columns.map(([column]) => q(column)).join(", ");
}

async function hashPostgresTable(client, table, { spaceId, chunkSize }) {
  const digest = createHash("sha256");
  let offset = 0;
  let count = 0;
  const columns = table.columns.map(([column]) => q(column)).join(", ");
  for (;;) {
    const result = await client.query(
      `SELECT ${columns}
       FROM ${q(table.name)}
       WHERE space_id = $1
       ORDER BY ${targetOrder(table)}
       LIMIT $2 OFFSET $3`,
      [spaceId, chunkSize, offset]
    );
    if (!result.rows.length) break;
    count += result.rows.length;
    for (const row of result.rows) {
      digest.update(hashRow(row, table));
      digest.update("\n");
    }
    offset += result.rows.length;
  }
  return { count, hash: digest.digest("hex") };
}

async function recordProgress(client, sourceId, spaceId, table, stats, importResult, status) {
  await client.query(
    `INSERT INTO runtime_import_progress
     (source_id, space_id, table_name, last_rowid, rows_imported,
      source_count, source_hash, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (source_id, space_id, table_name) DO UPDATE SET
       last_rowid = EXCLUDED.last_rowid,
       rows_imported = EXCLUDED.rows_imported,
       source_count = EXCLUDED.source_count,
       source_hash = EXCLUDED.source_hash,
       status = EXCLUDED.status,
       updated_at = EXCLUDED.updated_at`,
    [
      sourceId,
      spaceId,
      table.name,
      importResult.lastRowid || stats.maxRowid || 0,
      importResult.imported || 0,
      stats.count,
      stats.hash,
      status,
      Date.now()
    ]
  );
}

async function resetSerial(client, table, spaceId) {
  if (!table.preserveSerial) return;
  for (const [column] of Object.entries(table.preserveSerial)) {
    const result = await client.query(
      `SELECT COALESCE(MAX(${q(column)}), 0) AS max FROM ${q(table.name)}
       WHERE space_id = $1`,
      [spaceId]
    );
    const max = Number(result.rows[0]?.max || 0);
    const sequence = `${table.name}_${column}_seq`;
    await client.query(
      `SELECT setval($1::regclass, GREATEST($2::bigint, 1), $3)`,
      [sequence, max, max > 0]
    );
  }
}

async function inspectTarget(pool, source, options) {
  const client = await pool.connect();
  try {
    const rows = [];
    for (const tableStats of source.tables) {
      if (!["ready", "legacy-snapshot"].includes(tableStats.status)) {
        rows.push({ ...tableStats, targetCount: null, targetStatus: "source-missing" });
        continue;
      }
      const table = tableByName(tableStats.table);
      try {
        rows.push({
          ...tableStats,
          targetCount: await targetCount(client, table, options.spaceId),
          targetStatus: "ready"
        });
      } catch (error) {
        rows.push({
          ...tableStats,
          targetCount: null,
          targetStatus: "unavailable",
          targetError: error.message
        });
      }
    }
    return rows;
  } finally {
    client.release();
  }
}

function assertApplyOptions(options) {
  if (!options.sqlitePath) throw new Error("--sqlite is required");
  if (!options.databaseUrl) throw new Error("--database-url or ZION_DATABASE_URL is required");
  if (!options.spaceId) throw new Error("--space or ZION_SPACE_ID is required");
  if (options.apply && !options.backupDir && !options.skipSourceBackup) {
    throw new Error("--backup-dir or --skip-source-backup is required when --apply is used");
  }
}

export async function migrateSqliteRuntime(options) {
  assertApplyOptions(options);
  const sqlitePath = resolve(options.sqlitePath);
  const source = inspectSqliteSource(sqlitePath, {
    chunkSize: options.chunkSize,
    compactModelRequests: options.compactModelRequests !== false,
    verify: options.verify || "hash",
    integrityCheck: options.skipIntegrityCheck !== true,
    includeInternalReceipts: options.includeInternalReceipts === true
  });
  const sourceId = options.sourceId || `sqlite:${source.sourceHash.slice(0, 24)}`;
  const report = {
    ok: false,
    mode: options.apply ? "apply" : "dry-run",
    sqlitePath,
    sourceId,
    sourceHash: source.sourceHash,
    compaction: {
      modelRequests: options.compactModelRequests !== false
    },
    verification: options.verify || "hash",
    backup: [],
    tables: source.tables
  };
  if (!options.databaseUrl) {
    report.ok = true;
    return report;
  }
  const pool = new Pool({
    connectionString: options.databaseUrl,
    max: 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    ...(process.env.ZION_DATABASE_SSL === "disable" ? { ssl: false } : {}),
    application_name: "zion-sqlite-import"
  });
  let accounts = null;
  try {
    if (!options.apply) {
      report.tables = await inspectTarget(pool, source, options);
      report.ok = true;
      return report;
    }

    report.backup = options.skipSourceBackup
      ? ["source-backup-skipped"]
      : await backupSqlite(sqlitePath, options.backupDir);
    const owner = await ensureOwnerSpace(pool, options);
    accounts = owner.accounts;
    await initializePostgresRuntimeSchema(pool);
    report.owner = owner.user ? {
      userId: owner.user.id,
      spaceId: owner.space.id,
      role: owner.membership.role
    } : { spaceId: owner.space.id };

    const db = openSqlite(sqlitePath);
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [IMPORT_LOCK_ID]);
      const importedTables = [];
      for (const tableStats of source.tables) {
        const table = tableByName(tableStats.table);
        if (
          !table
          || !["ready", "legacy-snapshot"].includes(tableStats.status)
          || tableStats.count === 0
        ) {
          importedTables.push({ ...tableStats, imported: 0, targetCount: 0 });
          continue;
        }
        await client.query("BEGIN");
        try {
          const existing = await targetCount(client, table, options.spaceId);
          if (existing > 0 && !options.allowNonEmptyTarget) {
            throw new Error(
              `Target ${table.name} already has ${existing} rows in ${options.spaceId}; `
              + "refusing to merge without --allow-non-empty-target"
            );
          }
          if (existing > 0) {
            const targetStats = options.verify === "count"
              ? { count: await targetCount(client, table, options.spaceId), hash: tableStats.hash }
              : await hashPostgresTable(client, table, options);
            if (
              targetStats.count !== tableStats.count
              || (options.verify !== "count" && targetStats.hash !== tableStats.hash)
            ) {
              throw new Error(
                `Target ${table.name} is non-empty and differs from the SQLite source; `
                + "refusing to merge"
              );
            }
            await recordProgress(
              client,
              sourceId,
              options.spaceId,
              table,
              tableStats,
              { imported: 0, lastRowid: tableStats.maxRowid },
              "complete"
            );
            await client.query("COMMIT");
            importedTables.push({
              ...tableStats,
              imported: 0,
              targetCount: targetStats.count,
              targetHash: targetStats.hash,
              targetStatus: "already-imported"
            });
            continue;
          }
          const importResult = await importTable(client, db, table, options);
          await resetSerial(client, table, options.spaceId);
          const targetStats = options.verify === "count"
            ? { count: await targetCount(client, table, options.spaceId), hash: tableStats.hash }
            : await hashPostgresTable(client, table, options);
          if (
            targetStats.count !== tableStats.count
            || (options.verify !== "count" && targetStats.hash !== tableStats.hash)
          ) {
            throw new Error(
              `Verification failed for ${table.name}: source ${tableStats.count}/${tableStats.hash}, `
              + `target ${targetStats.count}/${targetStats.hash}`
            );
          }
          await recordProgress(
            client, sourceId, options.spaceId, table, tableStats, importResult, "complete"
          );
          await client.query("COMMIT");
          importedTables.push({
            ...tableStats,
            imported: importResult.imported,
            compactedRows: importResult.compactedRows || tableStats.compactedRows || 0,
            compactedBytesBefore: importResult.compactedBytesBefore || tableStats.compactedBytesBefore || 0,
            compactedBytesAfter: importResult.compactedBytesAfter || tableStats.compactedBytesAfter || 0,
            targetCount: targetStats.count,
            targetHash: targetStats.hash
          });
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
      report.tables = importedTables;
      report.ok = true;
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [IMPORT_LOCK_ID]);
      } catch {}
      client.release();
      db.close();
    }
    return report;
  } finally {
    await accounts?.close();
    await pool.end();
  }
}

function printText(report) {
  console.log(`SQLite: ${report.sqlitePath}`);
  console.log(`Mode: ${report.mode}`);
  console.log(`Source: ${report.sourceId}`);
  if (report.backup?.length) {
    console.log("Backup:");
    for (const file of report.backup) console.log(`  ${file}`);
  }
  if (report.owner) {
    console.log(`Owner Space: ${report.owner.spaceId}`);
  }
  console.log("Tables:");
  for (const table of report.tables) {
    const target = table.targetCount == null ? "" : ` target=${table.targetCount}`;
    const imported = table.imported == null ? "" : ` imported=${table.imported}`;
    console.log(
      `  ${table.table}: ${table.status} count=${table.count}${target}${imported} hash=${table.hash}`
    );
    if (table.targetError) console.log(`    target: ${table.targetError}`);
  }
  console.log(`Result: ${report.ok ? "ok" : "failed"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
  } else {
    migrateSqliteRuntime(options).then((report) => {
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else printText(report);
    }).catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
  }
}
