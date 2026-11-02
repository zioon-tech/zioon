import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

export class FileModelProfileStore {
  constructor(path = "") {
    this.path = String(path || "");
    this.profiles = new Map();
    this.load();
  }

  load() {
    if (!this.path) return;
    try {
      const payload = JSON.parse(readFileSync(this.path, "utf8"));
      for (const profile of Array.isArray(payload?.profiles) ? payload.profiles : []) {
        const id = String(profile?.id || "").trim();
        if (id) this.profiles.set(id, { ...profile, id });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  list() {
    return Array.from(this.profiles.values(), (profile) => ({ ...profile }));
  }

  upsert(profile) {
    const id = String(profile?.id || "").trim();
    if (!id) throw new Error("Model profile id is required");
    this.profiles.set(id, { ...profile, id });
    this.persist();
    return { ...this.profiles.get(id) };
  }

  delete(id) {
    const profileId = String(id || "").trim();
    if (!profileId) throw new Error("Model profile id is required");
    const existing = this.profiles.get(profileId) || null;
    const deleted = this.profiles.delete(profileId);
    if (deleted) this.persist();
    return existing ? { ...existing } : null;
  }

  persist() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({ version: 1, profiles: this.list() }, null, 2),
      { mode: 0o600 }
    );
    renameSync(temporary, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Some filesystems do not support POSIX permissions.
    }
  }
}
