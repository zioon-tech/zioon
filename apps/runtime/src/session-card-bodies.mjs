import { createHash } from "node:crypto";
import {
  sessionCardBody, withoutSessionCardBody, hydratedSessionCard
} from "../../../packages/runtime-client/src/session-card-bodies.mjs";
import { isRuntimeAnnotation } from "../../../packages/runtime-client/src/session-annotations.mjs";

export const SESSION_CARD_BODY_MIN_BYTES = 2048;
const kinds = ["tools", "thinking"];
const failure = code => Object.assign(new Error("Card body is unavailable or invalid"),
  { statusCode: ["CARD_BODY_SCOPE_MISMATCH", "CARD_BODY_DUPLICATE"].includes(code) ? 403 : 409, code });
const identity = (spaceId, sessionId, kind, card, body) =>
  JSON.stringify([1, spaceId, sessionId, kind, card.id, card.runId ?? null, body]);
const hash = value => createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export async function sessionCardStorageMode(client) {
  const mode = (await client.query(
    "SELECT mode FROM runtime_session_card_storage_mode WHERE id='global' FOR SHARE"
  )).rows[0]?.mode;
  if (!["inline", "references"].includes(mode)) throw failure("CARD_BODY_STORAGE_MODE_MISSING");
  return mode;
}

function validateReference(sessionId, kind, card) {
  if (!kinds.includes(kind) || card?.bodyKind !== kind || card.bodySessionId !== sessionId
    || typeof card.id !== "string" || !card.id || !/^[a-f0-9]{64}$/.test(card.bodyRef || "")) {
    throw failure("CARD_BODY_SCOPE_MISMATCH");
  }
}

function validateBodyRow(spaceId, sessionId, kind, card, row) {
  if (!row?.body_json) throw failure("CARD_BODY_MISSING");
  let body;
  try { body = JSON.parse(row.body_json); } catch { throw failure("CARD_BODY_CORRUPT"); }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || row.run_id !== (card.runId ?? null)
    || Buffer.byteLength(row.body_json) !== Number(row.byte_size)
    || card.bodyBytes !== Number(row.byte_size)
    || hash(identity(spaceId, sessionId, kind, card, row.body_json)) !== card.bodyRef
    || JSON.stringify(sessionCardBody(kind, body)) !== JSON.stringify(body)) {
    throw failure("CARD_BODY_CORRUPT");
  }
  return body;
}

function* boundedGroups(entries) {
  let group = [], bytes = 2;
  for (const entry of entries) {
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (group.length && (group.length === 128 || bytes + size > 1024 * 1024)) {
      yield group; group = []; bytes = 2;
    }
    group.push(entry); bytes += size;
  }
  if (group.length) yield group;
}

/** Callers own the authorized document transaction. No Space-wide ref lookup. */
export async function readSessionCardBody(client, spaceId, sessionId, kind, card) {
  validateReference(sessionId, kind, card);
  const row = (await client.query(
    `SELECT body_json, byte_size, run_id FROM runtime_session_card_bodies
     WHERE space_id=$1 AND session_id=$2 AND kind=$3 AND card_id=$4 AND ref=$5`,
    [spaceId, sessionId, kind, card.id, card.bodyRef]
  )).rows[0];
  return validateBodyRow(spaceId, sessionId, kind, card, row);
}

export async function readSessionCardBodies(client, spaceId, sessionId, entries, { allowMissing = false } = {}) {
  const bodies = [];
  const wanted = entries.map(({ kind, card }, ordinal) => {
    validateReference(sessionId, kind, card);
    return { ordinal, kind, card_id: card.id, ref: card.bodyRef };
  });
  for (const group of boundedGroups(wanted)) {
    const rows = (await client.query(`SELECT wanted.ordinal, body.body_json, body.byte_size, body.run_id
      FROM jsonb_to_recordset($3::jsonb) AS wanted(ordinal INTEGER,kind TEXT,card_id TEXT,ref TEXT)
      LEFT JOIN runtime_session_card_bodies body ON body.space_id=$1 AND body.session_id=$2
        AND body.kind=wanted.kind AND body.card_id=wanted.card_id AND body.ref=wanted.ref`,
    [spaceId, sessionId, JSON.stringify(group)])).rows;
    if (rows.length !== group.length) throw failure("CARD_BODY_MISSING");
    for (const row of rows) {
      const entry = entries[row.ordinal];
      if (!entry) throw failure("CARD_BODY_CORRUPT");
      bodies[row.ordinal] = allowMissing && row.body_json == null
        ? undefined : validateBodyRow(spaceId, sessionId, entry.kind, entry.card, row);
    }
  }
  return bodies;
}

export async function prepareSessionCardBody(client, spaceId, sessionId, kind, card, now = Date.now(),
  mode = null) {
  if (!card || typeof card !== "object") return { card, writtenBytes: 0, reused: false };
  mode ??= await sessionCardStorageMode(client);
  if (card.bodyRef != null) {
    const body = await readSessionCardBody(client, spaceId, sessionId, kind, card);
    if (Object.keys(sessionCardBody(kind, card)).length) throw failure("CARD_BODY_DUPLICATE");
    return { card: mode === "inline" ? hydratedSessionCard(card, body) : card,
      writtenBytes: 0, reused: true };
  }
  if (mode === "inline") return { card, writtenBytes: 0, reused: false };
  if (!isRuntimeAnnotation(card)) return { card, writtenBytes: 0, reused: false };
  // Keep an unfinished reasoning segment available to the synchronous reducer.
  // Completion is externalized; a resumed segment is hydrated before its delta.
  if (kind === "thinking" && card.status === "running") {
    return { card, writtenBytes: 0, reused: false };
  }
  // PostgreSQL JSONB can reorder object keys. Equivalent Y/metadata bodies
  // must reuse one reference while preserving every JSON value and array order.
  const body = JSON.stringify(canonical(JSON.parse(JSON.stringify(sessionCardBody(kind, card)))));
  const size = Buffer.byteLength(body);
  if (size < SESSION_CARD_BODY_MIN_BYTES || typeof card.id !== "string" || !card.id) {
    return { card, writtenBytes: 0, reused: false };
  }
  const ref = hash(identity(spaceId, sessionId, kind, card, body));
  const compact = { ...withoutSessionCardBody(kind, card), bodyRef: ref,
    bodySessionId: sessionId, bodyKind: kind, bodyBytes: size };
  const existing = (await client.query(
    `SELECT 1 FROM runtime_session_card_bodies
     WHERE space_id=$1 AND session_id=$2 AND kind=$3 AND card_id=$4 AND ref=$5`,
    [spaceId, sessionId, kind, card.id, ref]
  )).rowCount;
  if (existing) {
    await readSessionCardBody(client, spaceId, sessionId, kind, compact);
    return { card: compact, writtenBytes: 0, reused: true };
  }
  const inserted = await client.query(
    `INSERT INTO runtime_session_card_bodies
       (space_id,session_id,kind,card_id,ref,run_id,body_json,byte_size,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT(space_id,session_id,kind,card_id,ref) DO NOTHING`,
    [spaceId, sessionId, kind, card.id, ref, card.runId ?? null, body, size, now]);
  // A concurrent creator must agree on both identity and exact bytes.
  await readSessionCardBody(client, spaceId, sessionId, kind, compact);
  return { card: compact, writtenBytes: inserted.rowCount ? size : 0, reused: !inserted.rowCount };
}

export async function prepareSessionCardMetadata(client, spaceId, sessionId, meta, now) {
  if (!meta?.annotations) return meta;
  const mode = await sessionCardStorageMode(client);
  const annotations = { ...meta.annotations };
  for (const kind of kinds) {
    if (!Array.isArray(annotations[kind])) continue;
    annotations[kind] = (await prepareSessionCardBodies(client, spaceId, sessionId,
      annotations[kind].map(card => ({ kind, card })), now, mode)).map(result => result.card);
  }
  return { ...meta, annotations };
}

export async function hydrateSessionCardMetadata(client, spaceId, sessionId, meta, { onlyExpanded = false } = {}) {
  if (!meta?.annotations) return meta;
  const annotations = { ...meta.annotations };
  for (const kind of kinds) {
    if (!Array.isArray(annotations[kind])) continue;
    const entries = annotations[kind].filter(card => card?.bodyRef != null && (!onlyExpanded || card.expanded === true))
      .map(card => ({ kind, card }));
    const bodies = await readSessionCardBodies(client, spaceId, sessionId, entries);
    let index = 0;
    annotations[kind] = annotations[kind].map(card => card?.bodyRef != null && (!onlyExpanded || card.expanded === true)
      ? hydratedSessionCard(card, bodies[index++]) : card);
  }
  return { ...meta, annotations };
}

/** Normalize a document's cards in bounded SQL batches, preserving per-card validation. */
export async function prepareSessionCardBodies(client, spaceId, sessionId, entries, now = Date.now(), mode = null) {
  mode ??= await sessionCardStorageMode(client);
  const inserts = [], references = [], positions = [], suppliedRefs = new Set();
  const results = entries.map(({ kind, card }, index) => {
    if (!card || typeof card !== "object") return { card, writtenBytes: 0, reused: false };
    if (card.bodyRef != null) {
      validateReference(sessionId, kind, card);
      if (Object.keys(sessionCardBody(kind, card)).length) throw failure("CARD_BODY_DUPLICATE");
      suppliedRefs.add(references.length);
      references.push({ kind, card }); positions.push(index);
      return { card, writtenBytes: 0, reused: true };
    }
    if (mode === "inline" || !isRuntimeAnnotation(card)
      || (kind === "thinking" && card.status === "running")) return { card, writtenBytes: 0, reused: false };
    const body = JSON.stringify(canonical(JSON.parse(JSON.stringify(sessionCardBody(kind, card)))));
    const size = Buffer.byteLength(body);
    if (size < SESSION_CARD_BODY_MIN_BYTES || typeof card.id !== "string" || !card.id) {
      return { card, writtenBytes: 0, reused: false };
    }
    const ref = hash(identity(spaceId, sessionId, kind, card, body));
    const compact = { ...withoutSessionCardBody(kind, card), bodyRef: ref,
      bodySessionId: sessionId, bodyKind: kind, bodyBytes: size };
    references.push({ kind, card: compact }); positions.push(index);
    inserts.push({ kind, card_id: card.id, ref, run_id: card.runId ?? null,
      body_json: body, byte_size: size, created_at: now });
    return { card: compact, writtenBytes: 0, reused: true };
  });
  const bodies = await readSessionCardBodies(client, spaceId, sessionId, references, { allowMissing: true });
  const missingKeys = new Set(), missingEntries = [], missingPositions = [];
  for (const [index, entry] of references.entries()) {
    if (bodies[index] != null) continue;
    if (suppliedRefs.has(index)) throw failure("CARD_BODY_MISSING");
    missingKeys.add(JSON.stringify([entry.kind, entry.card.id, entry.card.bodyRef]));
    missingEntries.push(entry); missingPositions.push(index);
  }
  const inserted = new Set();
  for (const group of boundedGroups(inserts.filter(row => missingKeys.has(JSON.stringify([row.kind, row.card_id, row.ref]))))) {
    const unique = [...new Map(group.map(row => [JSON.stringify([row.kind, row.card_id, row.ref]), row])).values()];
    const rows = (await client.query(`INSERT INTO runtime_session_card_bodies
      (space_id,session_id,kind,card_id,ref,run_id,body_json,byte_size,created_at)
      SELECT $1,$2,kind,card_id,ref,run_id,body_json,byte_size,created_at
      FROM jsonb_to_recordset($3::jsonb) AS body(kind TEXT,card_id TEXT,ref TEXT,run_id TEXT,
        body_json TEXT,byte_size BIGINT,created_at BIGINT)
      ON CONFLICT(space_id,session_id,kind,card_id,ref) DO NOTHING RETURNING kind,card_id,ref`,
    [spaceId, sessionId, JSON.stringify(unique)])).rows;
    for (const row of rows) inserted.add(JSON.stringify([row.kind, row.card_id, row.ref]));
  }
  const createdBodies = await readSessionCardBodies(client, spaceId, sessionId, missingEntries);
  for (const [index, body] of createdBodies.entries()) bodies[missingPositions[index]] = body;
  for (const [index, { kind, card }] of references.entries()) {
    const result = results[positions[index]];
    if (inserted.delete(JSON.stringify([kind, card.id, card.bodyRef]))) {
      result.writtenBytes = card.bodyBytes; result.reused = false;
    }
    if (mode === "inline") result.card = hydratedSessionCard(card, bodies[index]);
  }
  return results;
}
