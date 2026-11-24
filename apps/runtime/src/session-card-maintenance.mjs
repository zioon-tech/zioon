import { createHash } from "node:crypto";
import * as Y from "yjs";
import {
  prepareSessionCardBody, prepareSessionCardMetadata, hydrateSessionCardMetadata,
  sessionCardStorageMode
} from "./session-card-bodies.mjs";
import {
  collaborationStateSelect, readCollaborationState, collaborationUpdateHash
} from "./collaboration-update-log.mjs";

const revisionKey = "__zionRevisionAnnotations";
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equivalent = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const invalid = message => Object.assign(new Error(message),
  { code: "CARD_STORAGE_MIGRATION_INVALID", statusCode: 409 });

/** Commit the writer fence before scanning any documents, including downgrade. */
export async function fenceSessionCardStorage(pool, mode) {
  if (!["inline", "references"].includes(mode)) throw invalid("Invalid card storage mode");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='3s'");
    const result = await client.query(
      "UPDATE runtime_session_card_storage_mode SET mode=$1 WHERE id='global' RETURNING mode", [mode]);
    if (result.rowCount !== 1) throw invalid("Card storage fence is missing");
    await client.query("COMMIT");
    return { mode };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function readRevisionMetadata(client, spaceId, sessionId, meta) {
  const full = { ...meta };
  const reference = full[revisionKey];
  delete full[revisionKey];
  if (reference != null) {
    if (!/^[a-f0-9]{64}$/.test(reference?.ref || "")) throw invalid("Invalid revision annotation reference");
    const result = await client.query(
      "SELECT annotations_json FROM runtime_workbench_revision_annotations WHERE space_id=$1 AND ref=$2",
      [spaceId, reference.ref]);
    if (result.rowCount !== 1) throw invalid("Revision annotation bundle is missing");
    full.annotations = result.rows[0].annotations_json;
  }
  return hydrateSessionCardMetadata(client, spaceId, sessionId, full);
}

async function writeRevisionMetadata(client, spaceId, meta, now) {
  if (!Object.hasOwn(meta, "annotations")) return meta;
  // Bundles may be shared across documents. Insert an immutable replacement;
  // retarget only this revision instead of changing the old shared bundle.
  const json = JSON.stringify(canonical(meta.annotations));
  const ref = createHash("sha256").update(json).digest("hex");
  await client.query(`INSERT INTO runtime_workbench_revision_annotations
    (space_id,ref,annotations_json,byte_size,created_at) VALUES($1,$2,$3::jsonb,$4,$5)
    ON CONFLICT(space_id,ref) DO NOTHING`, [spaceId, ref, json, Buffer.byteLength(json), now]);
  const stored = (await client.query(
    "SELECT annotations_json FROM runtime_workbench_revision_annotations WHERE space_id=$1 AND ref=$2",
    [spaceId, ref])).rows[0]?.annotations_json;
  if (!equivalent(stored, meta.annotations)) throw invalid("Revision annotation bundle changed");
  const { annotations, ...header } = meta;
  return { ...header, [revisionKey]: { ref,
    tools: Array.isArray(annotations?.tools) ? annotations.tools.length : 0,
    thinking: Array.isArray(annotations?.thinking) ? annotations.thinking.length : 0 } };
}

/** A bounded, operator-owned maintenance transaction; never an HTTP authorization shortcut. */
export async function convertSessionCardStorage(pool, {
  spaceId, sessionId, mode, revisionAfter = 0, revisionLimit = 8, current = true, now = Date.now()
}) {
  if (!spaceId || !sessionId || !["inline", "references"].includes(mode)
    || !Number.isSafeInteger(revisionAfter) || revisionAfter < 0
    || !Number.isSafeInteger(revisionLimit) || revisionLimit < 1 || revisionLimit > 32) {
    throw invalid("Invalid card migration boundary");
  }
  const client = await pool.connect();
  let document;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SET LOCAL statement_timeout='15s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`shared-space:${spaceId}`]);
    await client.query("SELECT space_id FROM runtime_workbench_state WHERE space_id=$1 FOR UPDATE", [spaceId]);
    if (await sessionCardStorageMode(client) !== mode) throw invalid("Card migration fence changed");
    let changedCards = 0, writtenBytes = 0, changedMetadata = false, stateBytes = 0;
    if (current) {
      const row = (await client.query(collaborationStateSelect + " FOR UPDATE OF d", [spaceId, sessionId])).rows[0];
      if (row) {
        document = new Y.Doc();
        Y.applyUpdate(document, readCollaborationState(row));
        const cards = document.getMap("cards");
        for (const [key, card] of [...cards]) {
          if (card?.bodyRef != null && key !== card.id) throw invalid("Card identity does not match its Y key");
          const kind = card?.kind === "tool" ? "tools" : card?.kind === "thinking" ? "thinking" : null;
          if (!kind) {
            if (card?.bodyRef != null) throw invalid("Unknown referenced card kind");
            continue;
          }
          if (key !== card.id) continue;
          const prepared = await prepareSessionCardBody(client, spaceId, sessionId, kind, card, now, mode);
          writtenBytes += prepared.writtenBytes;
          if (!equivalent(prepared.card, card)) { cards.set(key, prepared.card); changedCards++; }
        }
        if (changedCards) {
          const state = Buffer.from(Y.encodeStateAsUpdate(document));
          const hash = collaborationUpdateHash(state);
          const collaborationMode = (await client.query(
            "SELECT mode FROM runtime_collaboration_storage_mode WHERE id='global' FOR SHARE")).rows[0]?.mode;
          if (!["snapshot", "incremental"].includes(collaborationMode)) throw invalid("Collaboration fence is missing");
          const version = Number(row.version) + 1;
          await client.query("DELETE FROM runtime_collaboration_updates WHERE space_id=$1 AND session_id=$2",
            [spaceId, sessionId]);
          await client.query(`UPDATE runtime_collaboration_documents SET state_blob=$3,state_hash=$4,
            version=$5,base_version=$6,base_hash=$7,update_count=0,update_bytes=0
            WHERE space_id=$1 AND session_id=$2`,
          [spaceId, sessionId, state, hash, version, collaborationMode === "snapshot" ? null : version,
            collaborationMode === "snapshot" ? null : hash]);
          stateBytes = state.length;
        }
      }
      const rowMeta = (await client.query(
        "SELECT meta_json FROM runtime_workbench_metadata WHERE space_id=$1 AND id=$2 FOR UPDATE",
        [spaceId, sessionId])).rows[0]?.meta_json;
      if (rowMeta != null) {
        const full = await hydrateSessionCardMetadata(client, spaceId, sessionId, rowMeta);
        const prepared = await prepareSessionCardMetadata(client, spaceId, sessionId, full, now);
        if (!equivalent(full, await hydrateSessionCardMetadata(client, spaceId, sessionId, prepared))) {
          throw invalid("Current metadata changed during conversion");
        }
        if (!equivalent(prepared, rowMeta)) {
          await client.query("UPDATE runtime_workbench_metadata SET meta_json=$3::jsonb WHERE space_id=$1 AND id=$2",
            [spaceId, sessionId, JSON.stringify(prepared)]);
          changedMetadata = true;
        }
      }
    }
    const revisions = (await client.query(`SELECT revision,meta_json FROM runtime_workbench_session_revisions
      WHERE space_id=$1 AND session_id=$2 AND revision>$3 ORDER BY revision LIMIT $4 FOR UPDATE`,
    [spaceId, sessionId, revisionAfter, revisionLimit])).rows;
    let changedRevisions = 0;
    for (const row of revisions) {
      const full = await readRevisionMetadata(client, spaceId, sessionId, row.meta_json);
      const prepared = await prepareSessionCardMetadata(client, spaceId, sessionId, full, now);
      const stored = await writeRevisionMetadata(client, spaceId, prepared, now);
      if (!equivalent(full, await readRevisionMetadata(client, spaceId, sessionId, stored))) {
        throw invalid("Historical metadata changed during conversion");
      }
      if (!equivalent(stored, row.meta_json)) {
        await client.query(`UPDATE runtime_workbench_session_revisions SET meta_json=$4::jsonb
          WHERE space_id=$1 AND session_id=$2 AND revision=$3`,
        [spaceId, sessionId, row.revision, JSON.stringify(stored)]);
        changedRevisions++;
      }
    }
    const nextRevision = Number(revisions.at(-1)?.revision ?? revisionAfter);
    const complete = !(await client.query(`SELECT 1 FROM runtime_workbench_session_revisions
      WHERE space_id=$1 AND session_id=$2 AND revision>$3 LIMIT 1`,
    [spaceId, sessionId, nextRevision])).rowCount;
    await client.query("COMMIT");
    return { complete, nextRevision, revisions: revisions.length, changedRevisions,
      changedCards, changedMetadata, writtenBytes, stateBytes };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { document?.destroy(); client.release(); }
}

/** Header-only pagination also includes historical sessions whose live document was deleted. */
export async function listSessionCardStorageDocuments(pool, { after = null, limit = 32 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128
    || (after != null && (!Array.isArray(after) || after.length !== 2 || after.some(v => typeof v !== "string")))) {
    throw invalid("Invalid card migration page");
  }
  return (await pool.query(`SELECT space_id,session_id FROM (
    SELECT space_id,session_id FROM runtime_collaboration_documents
    UNION SELECT space_id,id AS session_id FROM runtime_workbench_metadata
    UNION SELECT space_id,session_id FROM runtime_workbench_session_revisions
  ) documents WHERE ($1::text IS NULL OR (space_id,session_id)>($1,$2))
  ORDER BY space_id,session_id LIMIT $3`, [after?.[0] ?? null, after?.[1] ?? null, limit])).rows;
}
