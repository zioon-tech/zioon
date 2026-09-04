import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function normalizeBinding(value) {
  if (typeof value === "string") {
    return {
      environmentVariable: value,
      header: "authorization",
      prefix: "Bearer "
    };
  }
  const binding = value && typeof value === "object" ? value : {};
  const header = String(binding.header || "authorization").toLowerCase();
  if (!HEADER_NAME_PATTERN.test(header)) {
    throw new Error(`Invalid credential header: ${header}`);
  }
  return {
    environmentVariable: String(binding.environmentVariable || ""),
    header,
    prefix: String(binding.prefix ?? "Bearer ")
  };
}

export class EnvironmentCredentialProvider {
  constructor({
    environment = globalThis.process?.env || {},
    bindings = {},
    storePath = ""
  } = {}) {
    this.environment = environment;
    this.storePath = String(storePath || "");
    this.imported = new Map();
    this.bindings = new Map(
      Object.entries(bindings).map(([ref, binding]) => [
        String(ref),
        normalizeBinding(binding)
      ])
    );
    this.load();
  }

  load() {
    if (!this.storePath) return;
    try {
      const payload = JSON.parse(readFileSync(this.storePath, "utf8"));
      for (const [ref, credential] of Object.entries(payload || {})) {
        const value = String(credential?.value || "").trim();
        if (!value) continue;
        const binding = normalizeBinding({
          header: credential?.header,
          prefix: credential?.prefix
        });
        this.imported.set(String(ref), { ...binding, value });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  persist() {
    if (!this.storePath) return;
    mkdirSync(dirname(this.storePath), { recursive: true });
    const payload = Object.fromEntries(this.imported);
    const temporary = `${this.storePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600 });
    renameSync(temporary, this.storePath);
    try {
      chmodSync(this.storePath, 0o600);
    } catch {
      // Some filesystems do not support POSIX permissions.
    }
  }

  set(ref, credential) {
    const id = String(ref || "").trim();
    const value = String(credential?.value || "").trim();
    if (!id || !value) throw new Error("Credential ref and value are required");
    const binding = normalizeBinding({
      header: credential?.header,
      prefix: credential?.prefix
    });
    this.imported.set(id, { ...binding, value });
    this.persist();
  }

  delete(ref) {
    const id = String(ref || "").trim();
    if (!id) return false;
    const deleted = this.imported.delete(id);
    if (deleted) this.persist();
    return deleted;
  }

  has(ref) {
    const id = String(ref || "");
    if (this.imported.has(id)) return true;
    const binding = this.bindings.get(id);
    return !!(
      binding?.environmentVariable
      && String(this.environment[binding.environmentVariable] || "").trim()
    );
  }

  async acquire(request) {
    const ref = String(request?.ref || "");
    const imported = this.imported.get(ref);
    if (imported) {
      return {
        headers: Object.freeze({
          [imported.header]: `${imported.prefix}${imported.value}`
        }),
        release() {}
      };
    }
    const binding = this.bindings.get(ref);
    if (!binding) return null;
    if (!binding.environmentVariable) {
      throw new Error(`Credential binding has no environment variable: ${request.ref}`);
    }
    const value = String(this.environment[binding.environmentVariable] || "").trim();
    if (!value) return null;
    return {
      headers: Object.freeze({
        [binding.header]: `${binding.prefix}${value}`
      }),
      release() {}
    };
  }
}
