import { mkdirSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require(["node", "sqlite"].join(":"));
const SESSION_MESSAGE_COMMAND_STALE_MS = 15 * 60_000;

function encode(value) {
  return JSON.stringify(value);
}

function decode(value) {
  return JSON.parse(String(value));
}

export class SqliteRunStore {
  constructor(path) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.eventListeners = new Set();
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 30000;

      CREATE TABLE IF NOT EXISTS runtime_runs (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_run_events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES runtime_runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS runtime_run_checkpoints (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        attempt_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES runtime_runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS runtime_run_transcript (
        run_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, turn, ordinal),
        FOREIGN KEY (run_id) REFERENCES runtime_runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS runtime_sessions (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_session_seed_transcript (
        session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, ordinal),
        FOREIGN KEY (session_id) REFERENCES runtime_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS runtime_session_messages (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        role TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, sequence),
        UNIQUE (session_id, run_id, role),
        FOREIGN KEY (session_id) REFERENCES runtime_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES runtime_runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS runtime_session_message_commands (
        session_id TEXT NOT NULL,
        client_request_id TEXT NOT NULL,
        status TEXT NOT NULL,
        response_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, client_request_id),
        FOREIGN KEY (session_id) REFERENCES runtime_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS runtime_tool_invocation_receipts (
        invocation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        completed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runtime_runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS runtime_change_sets (
        change_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (artifact_id) REFERENCES runtime_artifacts(artifact_id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES runtime_runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS runtime_todo_lists (
        owner_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS runtime_run_events_created
        ON runtime_run_events(run_id, created_at);
      CREATE INDEX IF NOT EXISTS runtime_run_checkpoints_created
        ON runtime_run_checkpoints(run_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS runtime_run_transcript_created
        ON runtime_run_transcript(run_id, created_at);
      CREATE INDEX IF NOT EXISTS runtime_session_messages_created
        ON runtime_session_messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS runtime_session_seed_created
        ON runtime_session_seed_transcript(session_id, created_at);
      CREATE INDEX IF NOT EXISTS runtime_session_message_commands_updated
        ON runtime_session_message_commands(updated_at);
      CREATE INDEX IF NOT EXISTS runtime_tool_receipts_run
        ON runtime_tool_invocation_receipts(run_id, tool_name, completed_at);
      CREATE INDEX IF NOT EXISTS runtime_artifacts_run
        ON runtime_artifacts(run_id, created_at);
      CREATE INDEX IF NOT EXISTS runtime_change_sets_run
        ON runtime_change_sets(run_id, created_at);
    `);
    if (path !== ":memory:") {
      try {
        chmodSync(path, 0o600);
      } catch {
        // Some filesystems do not support POSIX permissions.
      }
    }
  }

  async create(record) {
    try {
      this.db.prepare(`
        INSERT INTO runtime_runs (id, payload_json, status, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(record.id, encode(record), record.status, record.updatedAt);
    } catch (error) {
      if (String(error?.message || "").includes("UNIQUE constraint failed")) {
        throw new Error(`Run already exists: ${record.id}`);
      }
      throw error;
    }
  }

  async append(event, patch) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        "SELECT payload_json FROM runtime_runs WHERE id = ?"
      ).get(event.runId);
      if (!row) throw new Error(`Run not found: ${event.runId}`);

      const previous = this.db.prepare(`
        SELECT sequence
        FROM runtime_run_events
        WHERE run_id = ?
        ORDER BY sequence DESC
        LIMIT 1
      `).get(event.runId);
      const expected = previous ? Number(previous.sequence) + 1 : 1;
      if (event.sequence !== expected) {
        throw new Error(
          `Run event sequence conflict: expected ${expected}, received ${event.sequence}`
        );
      }

      const current = decode(row.payload_json);
      const next = {
        ...current,
        status: event.type === "run.started" ? "running" : current.status,
        updatedAt: event.timestamp,
        ...(patch || {})
      };
      this.db.prepare(`
        INSERT INTO runtime_run_events
          (run_id, sequence, event_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        event.runId,
        event.sequence,
        event.eventId,
        encode(event),
        event.timestamp
      );
      this.db.prepare(`
        UPDATE runtime_runs
        SET payload_json = ?, status = ?, updated_at = ?
        WHERE id = ?
      `).run(encode(next), next.status, next.updatedAt, event.runId);
      this.db.exec("COMMIT");
      for (const listener of this.eventListeners) {
        try {
          Promise.resolve(listener(event)).catch(() => {});
        } catch {}
      }
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  subscribeEvents(listener) {
    if (typeof listener !== "function") {
      throw new Error("Runtime event listener must be a function");
    }
    this.eventListeners.add(listener);
    return {
      dispose: () => this.eventListeners.delete(listener)
    };
  }

  async get(runId) {
    const row = this.db.prepare(
      "SELECT payload_json FROM runtime_runs WHERE id = ?"
    ).get(runId);
    return row ? decode(row.payload_json) : null;
  }

  async getEvents(runId, afterSequence = 0) {
    return this.db.prepare(`
      SELECT payload_json
      FROM runtime_run_events
      WHERE run_id = ? AND sequence > ?
      ORDER BY sequence ASC
    `).all(runId, afterSequence).map((row) => decode(row.payload_json));
  }

  async getEvent(runId, sequence) {
    const row = this.db.prepare(`
      SELECT payload_json
      FROM runtime_run_events
      WHERE run_id = ? AND sequence = ?
    `).get(runId, Number(sequence));
    return row ? decode(row.payload_json) : null;
  }

  async appendTranscript(entry) {
    const run = this.db.prepare(
      "SELECT id FROM runtime_runs WHERE id = ?"
    ).get(entry.runId);
    if (!run) throw new Error(`Run not found: ${entry.runId}`);
    this.db.prepare(`
      INSERT INTO runtime_run_transcript
        (run_id, turn, ordinal, message_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, turn, ordinal) DO UPDATE SET
        message_id = excluded.message_id,
        payload_json = excluded.payload_json,
        created_at = excluded.created_at
    `).run(
      entry.runId,
      entry.turn,
      entry.ordinal,
      entry.id,
      encode(entry),
      entry.createdAt
    );
  }

  async getTranscript(runId) {
    return this.db.prepare(`
      SELECT payload_json
      FROM runtime_run_transcript
      WHERE run_id = ?
      ORDER BY turn ASC, ordinal ASC
    `).all(runId).map((row) => decode(row.payload_json));
  }

  async saveCheckpoint(checkpoint) {
    const run = this.db.prepare(
      "SELECT id FROM runtime_runs WHERE id = ?"
    ).get(checkpoint.runId);
    if (!run) throw new Error(`Run not found: ${checkpoint.runId}`);
    const current = this.db.prepare(`
      SELECT sequence
      FROM runtime_run_checkpoints
      WHERE run_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `).get(checkpoint.runId);
    if (current && checkpoint.sequence < Number(current.sequence)) {
      throw new Error(
        `Checkpoint sequence conflict: current ${current.sequence}, received ${checkpoint.sequence}`
      );
    }
    this.db.prepare(`
      INSERT INTO runtime_run_checkpoints
        (run_id, sequence, attempt_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, sequence) DO UPDATE SET
        attempt_id = excluded.attempt_id,
        payload_json = excluded.payload_json,
        created_at = excluded.created_at
    `).run(
      checkpoint.runId,
      checkpoint.sequence,
      checkpoint.attemptId,
      encode(checkpoint),
      checkpoint.createdAt
    );
  }

  async getLatestCheckpoint(runId) {
    const row = this.db.prepare(`
      SELECT payload_json
      FROM runtime_run_checkpoints
      WHERE run_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `).get(runId);
    return row ? decode(row.payload_json) : null;
  }

  async createSession(record) {
    try {
      this.db.prepare(`
        INSERT INTO runtime_sessions (id, payload_json, status, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(record.id, encode(record), record.status, record.updatedAt);
    } catch (error) {
      if (String(error?.message || "").includes("UNIQUE constraint failed")) {
        throw new Error(`Session already exists: ${record.id}`);
      }
      throw error;
    }
  }

  async getSession(sessionId) {
    const row = this.db.prepare(
      "SELECT payload_json FROM runtime_sessions WHERE id = ?"
    ).get(sessionId);
    return row ? decode(row.payload_json) : null;
  }

  async getActiveRunForSession(sessionId) {
    const rows = this.db.prepare(`
      SELECT payload_json
      FROM runtime_runs
      WHERE status IN ('queued', 'running')
      ORDER BY updated_at DESC
    `).all();
    for (const row of rows) {
      const run = decode(row.payload_json);
      if (String(run?.sessionId || "") === String(sessionId || "")) return run;
    }
    return null;
  }

  async updateSession(sessionId, patch = {}, updatedAt = Date.now()) {
    const id = String(sessionId || "");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        "SELECT payload_json FROM runtime_sessions WHERE id = ?"
      ).get(id);
      if (!row) throw new Error(`Session not found: ${id}`);
      const current = decode(row.payload_json);
      const input = decode(encode(patch));
      const session = {
        ...current,
        ...input,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: Math.max(
          Number(current.updatedAt) || 0,
          Number(updatedAt) || Date.now()
        )
      };
      this.db.prepare(`
        UPDATE runtime_sessions
        SET payload_json = ?, status = ?, updated_at = ?
        WHERE id = ?
      `).run(encode(session), session.status, session.updatedAt, id);
      this.db.exec("COMMIT");
      return session;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getSessionMessageCommand(sessionId, clientRequestId) {
    const row = this.db.prepare(`
      SELECT status, response_json, created_at, updated_at
      FROM runtime_session_message_commands
      WHERE session_id = ? AND client_request_id = ?
    `).get(String(sessionId), String(clientRequestId));
    if (!row) return null;
    return {
      sessionId: String(sessionId),
      clientRequestId: String(clientRequestId),
      status: String(row.status),
      response: row.response_json ? decode(row.response_json) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  reserveSessionMessageCommand(
    sessionId,
    clientRequestId,
    createdAt = Date.now()
  ) {
    this.db.prepare(`
      DELETE FROM runtime_session_message_commands
      WHERE status = 'submitting' AND updated_at < ?
    `).run(Number(createdAt) - SESSION_MESSAGE_COMMAND_STALE_MS);
    const result = this.db.prepare(`
      INSERT INTO runtime_session_message_commands (
        session_id, client_request_id, status, response_json,
        created_at, updated_at
      )
      VALUES (?, ?, 'submitting', NULL, ?, ?)
      ON CONFLICT(session_id, client_request_id) DO NOTHING
    `).run(
      String(sessionId),
      String(clientRequestId),
      Number(createdAt),
      Number(createdAt)
    );
    return {
      reserved: Number(result.changes || 0) === 1,
      command: this.getSessionMessageCommand(sessionId, clientRequestId)
    };
  }

  completeSessionMessageCommand(
    sessionId,
    clientRequestId,
    response,
    updatedAt = Date.now()
  ) {
    this.db.prepare(`
      UPDATE runtime_session_message_commands
      SET status = 'accepted', response_json = ?, updated_at = ?
      WHERE session_id = ? AND client_request_id = ?
    `).run(
      encode(response),
      Number(updatedAt),
      String(sessionId),
      String(clientRequestId)
    );
    return this.getSessionMessageCommand(sessionId, clientRequestId);
  }

  releaseSessionMessageCommand(sessionId, clientRequestId) {
    this.db.prepare(`
      DELETE FROM runtime_session_message_commands
      WHERE session_id = ? AND client_request_id = ? AND status = 'submitting'
    `).run(String(sessionId), String(clientRequestId));
  }

  async listSessions({ limit = 100, offset = 0 } = {}) {
    const boundedLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    return this.db.prepare(`
      SELECT payload_json
      FROM runtime_sessions
      ORDER BY updated_at DESC, id ASC
      LIMIT ? OFFSET ?
    `).all(boundedLimit, boundedOffset).map((row) => decode(row.payload_json));
  }

  async saveSessionSeedTranscript(sessionId, messages, createdAt = Date.now()) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const session = this.db.prepare(
        "SELECT id FROM runtime_sessions WHERE id = ?"
      ).get(String(sessionId));
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      const existing = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM runtime_session_seed_transcript
        WHERE session_id = ?
      `).get(String(sessionId));
      if (Number(existing.count) > 0) {
        this.db.exec("COMMIT");
        return this.getSessionSeedTranscript(sessionId);
      }
      const insert = this.db.prepare(`
        INSERT INTO runtime_session_seed_transcript
          (session_id, ordinal, payload_json, created_at)
        VALUES (?, ?, ?, ?)
      `);
      messages.forEach((input, index) => {
        const message = {
          ...decode(encode(input)),
          schemaVersion: 1,
          id: `seed:${sessionId}:${index + 1}`,
          sessionId: String(sessionId),
          createdAt: Number(createdAt)
        };
        insert.run(
          String(sessionId),
          index + 1,
          encode(message),
          Number(createdAt)
        );
      });
      this.db.exec("COMMIT");
      return this.getSessionSeedTranscript(sessionId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getSessionSeedTranscript(sessionId) {
    return this.db.prepare(`
      SELECT payload_json
      FROM runtime_session_seed_transcript
      WHERE session_id = ?
      ORDER BY ordinal ASC
    `).all(String(sessionId)).map((row) => decode(row.payload_json));
  }

  async forkSession(sourceSessionId, {
    id,
    title,
    createdAt = Date.now(),
    createId = () => `message_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  } = {}) {
    const source = await this.getSession(sourceSessionId);
    if (!source) throw new Error(`Session not found: ${sourceSessionId}`);
    const targetId = String(id || "").trim();
    if (!targetId) throw new Error("Forked Session id is required");
    const sourceSeedTranscript = this.getSessionSeedTranscript(sourceSessionId);
    const sourceMessages = await this.getSessionMessages(sourceSessionId);
    const sourceTranscript = await this.getSessionTranscript(sourceSessionId);
    const session = {
      ...source,
      id: targetId,
      status: "active",
      title: String(title || `${source.title || "Session"} (fork)`),
      metadata: {
        ...(source.metadata || {}),
        forkedFrom: {
          sessionId: sourceSessionId,
          transcriptSequence: sourceTranscript.at(-1)?.sequence || 0,
          forkedAt: createdAt
        }
      },
      createdAt,
      updatedAt: createdAt
    };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO runtime_sessions (id, payload_json, status, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(session.id, encode(session), session.status, session.updatedAt);
      const insertMessage = this.db.prepare(`
        INSERT INTO runtime_session_messages
          (session_id, sequence, message_id, run_id, role, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertSeed = this.db.prepare(`
        INSERT INTO runtime_session_seed_transcript
          (session_id, ordinal, payload_json, created_at)
        VALUES (?, ?, ?, ?)
      `);
      for (let index = 0; index < sourceSeedTranscript.length; index += 1) {
        const sourceMessage = sourceSeedTranscript[index];
        const message = {
          ...sourceMessage,
          id: `seed:${targetId}:${index + 1}`,
          sessionId: targetId
        };
        insertSeed.run(
          targetId,
          index + 1,
          encode(message),
          Number(message.createdAt || createdAt)
        );
      }
      for (const sourceMessage of sourceMessages) {
        const message = {
          ...sourceMessage,
          id: createId("message"),
          sessionId: targetId
        };
        insertMessage.run(
          targetId,
          message.sequence,
          message.id,
          message.runId,
          message.role,
          encode(message),
          message.createdAt
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (String(error?.message || "").includes("UNIQUE constraint failed")) {
        throw new Error(`Session already exists: ${targetId}`);
      }
      throw error;
    }
    return {
      session,
      copiedSeedTranscriptEntries: sourceSeedTranscript.length,
      copiedMessages: sourceMessages.length,
      copiedTranscriptEntries: sourceTranscript.length
    };
  }

  async getSessionMessages(sessionId, afterSequence = 0) {
    return this.db.prepare(`
      SELECT payload_json
      FROM runtime_session_messages
      WHERE session_id = ? AND sequence > ?
      ORDER BY sequence ASC
    `).all(sessionId, afterSequence).map((row) => decode(row.payload_json));
  }

  async getSessionTranscript(sessionId, afterSequence = 0) {
    const messages = await this.getSessionMessages(sessionId);
    const canonical = [];
    let sequence = 0;
    for (const entry of this.getSessionSeedTranscript(sessionId)) {
      sequence += 1;
      canonical.push({
        ...entry,
        schemaVersion: 1,
        sessionId,
        sequence
      });
    }
    for (const userMessage of messages.filter((message) => message.role === "user")) {
      const {
        canonicalContent,
        ...displayUserMessage
      } = userMessage;
      sequence += 1;
      canonical.push({
        ...displayUserMessage,
        content: canonicalContent ?? userMessage.content,
        schemaVersion: 1,
        sequence
      });
      const assistantMessage = messages.find((message) =>
        message.runId === userMessage.runId && message.role === "assistant"
      );
      if (!assistantMessage) continue;
      const runTranscript = await this.getTranscript(userMessage.runId);
      if (runTranscript.length) {
        for (const entry of runTranscript) {
          sequence += 1;
          canonical.push({
            ...entry,
            sessionId,
            sequence
          });
        }
        continue;
      }
      sequence += 1;
      canonical.push({
        ...assistantMessage,
        schemaVersion: 1,
        sequence
      });
    }
    return canonical.filter((message) => message.sequence > afterSequence);
  }

  async appendSessionMessages(sessionId, messages) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sessionRow = this.db.prepare(
        "SELECT payload_json FROM runtime_sessions WHERE id = ?"
      ).get(sessionId);
      if (!sessionRow) throw new Error(`Session not found: ${sessionId}`);
      const sequenceRow = this.db.prepare(`
        SELECT COALESCE(MAX(sequence), 0) AS sequence
        FROM runtime_session_messages
        WHERE session_id = ?
      `).get(sessionId);
      let sequence = Number(sequenceRow.sequence || 0);
      const stored = [];
      let updatedAt = decode(sessionRow.payload_json).updatedAt;

      for (const input of messages) {
        if (input.sessionId !== sessionId) {
          throw new Error(`Session message belongs to another Session: ${input.id}`);
        }
        if (input.role !== "user" && input.role !== "assistant") {
          throw new Error(`Unsupported Session message role: ${input.role}`);
        }
        const existing = this.db.prepare(`
          SELECT payload_json
          FROM runtime_session_messages
          WHERE session_id = ? AND run_id = ? AND role = ?
        `).get(sessionId, input.runId, input.role);
        if (existing) {
          stored.push(decode(existing.payload_json));
          continue;
        }

        sequence += 1;
        const message = {
          ...input,
          schemaVersion: 1,
          sessionId,
          sequence,
          content: String(input.content || "")
        };
        this.db.prepare(`
          INSERT INTO runtime_session_messages
            (session_id, sequence, message_id, run_id, role, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          sessionId,
          sequence,
          message.id,
          message.runId,
          message.role,
          encode(message),
          message.createdAt
        );
        stored.push(message);
        updatedAt = Math.max(updatedAt, message.createdAt);
      }

      const session = {
        ...decode(sessionRow.payload_json),
        updatedAt
      };
      this.db.prepare(`
        UPDATE runtime_sessions
        SET payload_json = ?, status = ?, updated_at = ?
        WHERE id = ?
      `).run(encode(session), session.status, session.updatedAt, sessionId);
      this.db.exec("COMMIT");
      return stored;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async reconcileCompletedSessionMessages({
    now = () => Date.now(),
    createId = () => `message_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  } = {}) {
    const rows = this.db.prepare(`
      SELECT payload_json
      FROM runtime_runs
      WHERE status = 'completed'
      ORDER BY updated_at ASC
    `).all();
    const projected = [];
    for (const row of rows) {
      const run = decode(row.payload_json);
      if (!run.sessionId || typeof run.output !== "string") continue;
      const userMessage = this.db.prepare(`
        SELECT 1
        FROM runtime_session_messages
        WHERE session_id = ? AND run_id = ? AND role = 'user'
      `).get(run.sessionId, run.id);
      if (!userMessage) continue;
      const assistantMessage = this.db.prepare(`
        SELECT 1
        FROM runtime_session_messages
        WHERE session_id = ? AND run_id = ? AND role = 'assistant'
      `).get(run.sessionId, run.id);
      if (assistantMessage) continue;
      const [message] = await this.appendSessionMessages(run.sessionId, [{
        schemaVersion: 1,
        id: createId("message"),
        sessionId: run.sessionId,
        role: "assistant",
        content: run.output,
        runId: run.id,
        createdAt: run.completedAt || now()
      }]);
      projected.push(message);
    }
    return projected;
  }

  async reconcileActiveRuns({
    reason = "runtime-restart",
    now = () => Date.now(),
    createId = () => `event_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  } = {}) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`
        SELECT id, payload_json
        FROM runtime_runs
        WHERE status IN ('queued', 'running')
        ORDER BY updated_at ASC
      `).all();
      const interrupted = [];
      for (const row of rows) {
        const run = decode(row.payload_json);
        const sequenceRow = this.db.prepare(`
          SELECT COALESCE(MAX(sequence), 0) AS sequence
          FROM runtime_run_events
          WHERE run_id = ?
        `).get(run.id);
        const timestamp = now();
        const event = {
          schemaVersion: 1,
          eventId: createId("event"),
          runId: run.id,
          attemptId: run.attemptId,
          sequence: Number(sequenceRow.sequence || 0) + 1,
          type: "run.interrupted",
          timestamp,
          data: { reason }
        };
        const next = {
          ...run,
          status: "interrupted",
          updatedAt: timestamp,
          completedAt: timestamp,
          terminalReason: reason,
          error: "Run interrupted because no live Runtime owner is available"
        };
        this.db.prepare(`
          INSERT INTO runtime_run_events
            (run_id, sequence, event_id, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          event.runId,
          event.sequence,
          event.eventId,
          encode(event),
          event.timestamp
        );
        this.db.prepare(`
          UPDATE runtime_runs
          SET payload_json = ?, status = ?, updated_at = ?
          WHERE id = ?
        `).run(encode(next), next.status, next.updatedAt, next.id);
        interrupted.push(next);
      }
      this.db.exec("COMMIT");
      return interrupted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getToolReceipt(invocationId) {
    const row = this.db.prepare(`
      SELECT invocation_id, run_id, tool_name, request_hash, result_json, completed_at
      FROM runtime_tool_invocation_receipts
      WHERE invocation_id = ?
    `).get(String(invocationId));
    return row
      ? {
          invocationId: String(row.invocation_id),
          runId: String(row.run_id),
          toolName: String(row.tool_name),
          requestHash: String(row.request_hash),
          result: decode(row.result_json),
          completedAt: Number(row.completed_at)
        }
      : null;
  }

  saveToolReceipt({
    invocationId,
    runId,
    toolName,
    requestHash,
    result,
    completedAt = Date.now()
  }) {
    const write = this.db.prepare(`
      INSERT INTO runtime_tool_invocation_receipts
        (invocation_id, run_id, tool_name, request_hash, result_json, completed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(invocation_id) DO NOTHING
    `).run(
      String(invocationId),
      String(runId),
      String(toolName),
      String(requestHash),
      encode(result),
      Number(completedAt)
    );
    const receipt = this.getToolReceipt(invocationId);
    if (!receipt) throw new Error(`Tool receipt was not persisted: ${invocationId}`);
    return { ...receipt, duplicate: Number(write.changes) === 0 };
  }

  countToolReceipts(runId = "", toolName = "") {
    const row = runId && toolName
      ? this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM runtime_tool_invocation_receipts
          WHERE run_id = ? AND tool_name = ?
        `).get(String(runId), String(toolName))
      : runId
        ? this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM runtime_tool_invocation_receipts
          WHERE run_id = ?
        `).get(String(runId))
        : this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM runtime_tool_invocation_receipts
          `).get();
    return Number(row.count);
  }

  saveRunArtifacts({
    runId,
    invocationId,
    artifacts = [],
    changes = []
  }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insertArtifact = this.db.prepare(`
        INSERT INTO runtime_artifacts
          (artifact_id, run_id, invocation_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(artifact_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          created_at = excluded.created_at
      `);
      for (const artifact of artifacts) {
        insertArtifact.run(
          String(artifact.id),
          String(runId),
          String(invocationId),
          encode(artifact),
          Number(artifact.createdAt || Date.now())
        );
      }
      const insertChange = this.db.prepare(`
        INSERT INTO runtime_change_sets
          (change_id, artifact_id, run_id, invocation_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(change_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          created_at = excluded.created_at
      `);
      for (const change of changes) {
        insertChange.run(
          String(change.id),
          String(change.artifactId),
          String(runId),
          String(invocationId),
          encode(change),
          Number(change.createdAt || Date.now())
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listRunArtifacts(runId);
  }

  listRunArtifacts(runId) {
    const artifacts = this.db.prepare(`
      SELECT payload_json
      FROM runtime_artifacts
      WHERE run_id = ?
      ORDER BY created_at ASC, artifact_id ASC
    `).all(String(runId)).map((row) => decode(row.payload_json));
    const changes = this.db.prepare(`
      SELECT payload_json
      FROM runtime_change_sets
      WHERE run_id = ?
      ORDER BY created_at ASC, change_id ASC
    `).all(String(runId)).map((row) => decode(row.payload_json));
    return { runId: String(runId), artifacts, changes };
  }

  listSessionArtifacts(sessionId) {
    const runIds = Array.from(new Set(
      this.db.prepare(`
        SELECT run_id
        FROM runtime_session_messages
        WHERE session_id = ?
        ORDER BY sequence ASC
      `).all(String(sessionId)).map((row) => String(row.run_id))
    ));
    const artifacts = [];
    const changes = [];
    for (const runId of runIds) {
      const run = this.listRunArtifacts(runId);
      artifacts.push(...run.artifacts);
      changes.push(...run.changes);
    }
    return { sessionId: String(sessionId), artifacts, changes };
  }

  saveTodoList(ownerId, todos, updatedAt = Date.now(), metadata = {}) {
    const taskId = String(metadata?.taskId || "").trim();
    const sessionId = String(metadata?.sessionId || "").trim();
    const runId = String(metadata?.runId || "").trim();
    const payload = {
      ownerId: String(ownerId),
      ...(taskId ? { taskId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      todos: Array.isArray(todos) ? todos : [],
      updatedAt: Number(updatedAt)
    };
    this.db.prepare(`
      INSERT INTO runtime_todo_lists (owner_id, payload_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(payload.ownerId, encode(payload), payload.updatedAt);
    return payload;
  }

  getTodoList(ownerId) {
    const row = this.db.prepare(
      "SELECT payload_json FROM runtime_todo_lists WHERE owner_id = ?"
    ).get(String(ownerId));
    return row ? decode(row.payload_json) : null;
  }

  listTodoLists({ limit = 100, updatedAfter = 0 } = {}) {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    const safeUpdatedAfter = Math.max(0, Math.floor(Number(updatedAfter) || 0));
    return this.db.prepare(`
      SELECT payload_json
      FROM runtime_todo_lists
      WHERE updated_at > ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(safeUpdatedAfter, safeLimit).map((row) => decode(row.payload_json));
  }

  close() {
    this.eventListeners.clear();
    this.db.close();
  }
}
