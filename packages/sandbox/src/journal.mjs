import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fingerprint, SandboxOperationError } from "./provider.mjs";

/** Durable single-operator PoC journal. Not a production multi-worker claim store. */
export class SandboxJournal {
  constructor(path) { this.path = path; }
  async exclusive(action) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try { await mkdir(`${this.path}.lock`, { mode: 0o700 }); }
    catch (error) {
      if (error.code === "EEXIST") throw new Error("PoC journal is locked; never steal a lock while its owner may be alive");
      throw error;
    }
    try { return await action(); }
    finally { await rm(`${this.path}.lock`, { recursive: true }); }
  }
  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      if (value.version !== 1 || !value.creations || !value.invocations) throw new Error("Unsupported journal");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, creations: {}, invocations: {} };
      throw error;
    }
  }
  async save(value) {
    const temporary = `${this.path}.${process.pid}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, this.path);
    const directory = await open(dirname(this.path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

function recordKey(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(id)) throw new Error("Invalid operation ID");
  // Hash keys so user-provided IDs cannot address JS prototype properties.
  return fingerprint(id);
}

export class SandboxPocController {
  constructor(provider, journal) { this.provider = provider; this.journal = journal; }
  async create(scope, requestKey, options = {}) {
    return this.journal.exclusive(async () => {
      const state = await this.journal.read();
      const key = recordKey(requestKey);
      const hash = fingerprint({ scope, options, provider: this.provider.publicIdentity() });
      const existing = state.creations[key];
      if (existing) {
        if (existing.requestHash !== hash) throw new Error("Creation key reused with different scope/configuration");
        if (existing.status === "created") return existing.handle;
        throw new SandboxOperationError("sandbox_create_requires_reconcile", "create");
      }
      const record = { requestKey, scope, requestHash: hash, status: "creating", startedAt: Date.now() };
      state.creations[key] = record;
      await this.journal.save(state);
      try {
        record.handle = await this.provider.create(scope, requestKey, options);
        record.status = "created";
        await this.journal.save(state);
        return record.handle;
      } catch (error) {
        record.status = "unknown";
        record.errorCode = error.code || "sandbox_create_outcome_unknown";
        await this.journal.save(state);
        throw error;
      }
    });
  }
  async exec(handle, scope, invocationId, request) {
    return this.journal.exclusive(async () => {
      const state = await this.journal.read();
      const key = recordKey(invocationId);
      const hash = fingerprint({ sandboxId: handle.sandboxId, scope, request });
      const existing = state.invocations[key];
      if (existing) {
        if (existing.requestHash !== hash) throw new Error("Invocation ID reused with different arguments");
        // Re-authorize before replay; a receipt is not permission.
        await this.provider.inspect(handle, scope);
        if (existing.status === "completed") return existing.result;
        throw new SandboxOperationError("execution_outcome_unknown", "exec", handle.sandboxId);
      }
      const record = { invocationId, sandboxId: handle.sandboxId, scope, requestHash: hash, status: "dispatching", startedAt: Date.now() };
      state.invocations[key] = record;
      await this.journal.save(state);
      try {
        record.result = await this.provider.exec(handle, scope, request);
        record.status = "completed";
        record.completedAt = Date.now();
        await this.journal.save(state);
        return record.result;
      } catch (error) {
        record.status = "unknown";
        record.errorCode = error.code || "execution_outcome_unknown";
        await this.journal.save(state);
        throw error;
      }
    });
  }
  async reconcile(requestKey) {
    return this.journal.exclusive(async () => {
      const state = await this.journal.read();
      const record = state.creations[recordKey(requestKey)];
      if (!record) throw new Error("Creation operation not recorded");
      if (record.status === "destroyed") return [];
      const matches = await this.provider.findCreated(record.scope, requestKey);
      if (matches.length === 1 && ["unknown", "creating"].includes(record.status)) {
        record.handle = matches[0];
        record.status = "created";
        await this.journal.save(state);
      }
      // No matches is not proof the original create failed. Multiple matches need operator reconciliation.
      return matches;
    });
  }
  async cleanup() {
    return this.journal.exclusive(async () => {
      const state = await this.journal.read();
      const result = [];
      for (const record of Object.values(state.creations)) {
        if (record.status === "destroyed") continue;
        try {
          const handles = ["creating", "unknown"].includes(record.status)
            ? await this.provider.findCreated(record.scope, record.requestKey)
            : [record.handle];
          if (!handles.length) {
            result.push({ requestKey: record.requestKey, status: "unresolved" });
            continue;
          }
          for (const handle of handles) await this.provider.destroy(handle, record.scope);
          record.status = "destroyed";
          await this.journal.save(state);
          result.push({ requestKey: record.requestKey, status: "destroyed" });
        } catch (error) {
          result.push({ requestKey: record.requestKey, status: "unresolved", code: error.code || "cleanup_failed" });
        }
      }
      return result;
    });
  }

  async audit() {
    const [state, cloud] = await Promise.all([
      this.journal.read(),
      this.provider.listManaged()
    ]);
    const recorded = Object.values(state.creations);
    const recordedIds = new Set(recorded.map((item) => item.handle?.sandboxId).filter(Boolean));
    const cloudIds = new Set(cloud.map((item) => item.sandboxId));
    return {
      cloud,
      orphanedCloud: cloud.filter((item) => !recordedIds.has(item.sandboxId)),
      missingCloud: recorded
        .filter((item) => item.status === "created" && item.handle?.sandboxId && !cloudIds.has(item.handle.sandboxId))
        .map((item) => ({
          requestKey: item.requestKey,
          sandboxId: item.handle.sandboxId,
          status: item.status
        })),
      journal: recorded.map((item) => ({
        requestKey: item.requestKey,
        sandboxId: item.handle?.sandboxId || null,
        status: item.status
      }))
    };
  }
}
