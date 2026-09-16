import type {
  AgentCheckpoint,
  RunEvent,
  RunRecord,
  RunStatus,
  RunStore,
  RunTranscriptEntry
} from "./protocol.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class MemoryRunStore implements RunStore {
  private runs = new Map<string, RunRecord>();
  private events = new Map<string, RunEvent[]>();
  private checkpoints = new Map<string, AgentCheckpoint>();
  private transcripts = new Map<string, RunTranscriptEntry[]>();

  async create(record: RunRecord): Promise<void> {
    if (this.runs.has(record.id)) {
      throw new Error(`Run already exists: ${record.id}`);
    }
    this.runs.set(record.id, clone(record));
    this.events.set(record.id, []);
    this.transcripts.set(record.id, []);
  }

  async append(
    event: RunEvent,
    patch?: Pick<RunRecord, "status" | "updatedAt"> &
      Partial<Pick<
        RunRecord,
        | "attemptId"
        | "completedAt"
        | "terminalReason"
        | "error"
        | "model"
        | "output"
        | "usage"
        | "metadata"
      >>
  ): Promise<void> {
    const run = this.runs.get(event.runId);
    if (!run) throw new Error(`Run not found: ${event.runId}`);
    const events = this.events.get(event.runId) || [];
    const previous = events.at(-1);
    if (previous && event.sequence !== previous.sequence + 1) {
      throw new Error(
        `Run event sequence conflict: expected ${previous.sequence + 1}, received ${event.sequence}`
      );
    }
    if (!previous && event.sequence !== 1) {
      throw new Error(`Run event sequence must start at 1, received ${event.sequence}`);
    }
    events.push(clone(event));
    this.events.set(event.runId, events);
    this.runs.set(event.runId, {
      ...run,
      status: event.type === "run.started" ? "running" : run.status,
      updatedAt: event.timestamp,
      ...(patch || {})
    });
  }

  async get(runId: string): Promise<RunRecord | null> {
    const run = this.runs.get(runId);
    return run ? clone(run) : null;
  }

  async listRuns({
    since = 0,
    statuses,
    limit = 100
  }: {
    since?: number;
    statuses?: RunStatus[];
    limit?: number;
  } = {}): Promise<RunRecord[]> {
    const normalizedSince = Math.max(0, Number(since) || 0);
    const normalizedLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    const statusSet = Array.isArray(statuses) && statuses.length
      ? new Set(statuses)
      : null;
    return clone(
      [...this.runs.values()]
        .filter((run) => run.updatedAt >= normalizedSince)
        .filter((run) => !statusSet || statusSet.has(run.status))
        .sort((left, right) =>
          right.updatedAt - left.updatedAt || right.id.localeCompare(left.id)
        )
        .slice(0, normalizedLimit)
    );
  }

  async getEvents(runId: string, afterSequence = 0): Promise<RunEvent[]> {
    return clone(
      (this.events.get(runId) || []).filter((event) => event.sequence > afterSequence)
    );
  }

  async getEvent(runId: string, sequence: number): Promise<RunEvent | null> {
    const event = (this.events.get(runId) || []).find((item) =>
      item.sequence === Number(sequence)
    );
    return event ? clone(event) : null;
  }

  async appendTranscript(entry: RunTranscriptEntry): Promise<void> {
    if (!this.runs.has(entry.runId)) {
      throw new Error(`Run not found: ${entry.runId}`);
    }
    const entries = this.transcripts.get(entry.runId) || [];
    const index = entries.findIndex((item) =>
      item.turn === entry.turn && item.ordinal === entry.ordinal
    );
    if (index >= 0) entries[index] = clone(entry);
    else entries.push(clone(entry));
    entries.sort((left, right) => left.turn - right.turn || left.ordinal - right.ordinal);
    this.transcripts.set(entry.runId, entries);
  }

  async getTranscript(runId: string): Promise<RunTranscriptEntry[]> {
    return clone(this.transcripts.get(runId) || []);
  }

  async saveCheckpoint(checkpoint: AgentCheckpoint): Promise<void> {
    if (!this.runs.has(checkpoint.runId)) {
      throw new Error(`Run not found: ${checkpoint.runId}`);
    }
    const current = this.checkpoints.get(checkpoint.runId);
    if (current && checkpoint.sequence < current.sequence) {
      throw new Error(
        `Checkpoint sequence conflict: current ${current.sequence}, received ${checkpoint.sequence}`
      );
    }
    this.checkpoints.set(checkpoint.runId, clone(checkpoint));
  }

  async getLatestCheckpoint(runId: string): Promise<AgentCheckpoint | null> {
    const checkpoint = this.checkpoints.get(runId);
    return checkpoint ? clone(checkpoint) : null;
  }
}
