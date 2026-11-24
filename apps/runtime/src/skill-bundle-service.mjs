import { createHash } from "node:crypto";
import { canonicalSkillBundle, SKILL_BUNDLE_LIMITS, validSkillBundlePath } from "../../../extensions/dev.skills/skill-bundle.js";
import { isSyncableSkillFile } from "../../../extensions/dev.skills/skills-runtime-shared.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code, statusCode = 422) => { throw Object.assign(new Error(code), { code, statusCode }); };
const identity = (skill) => ({
  id: String(skill.id || ""), nodeId: String(skill.sourceNodeId || ""),
  path: String(skill.sourcePath || skill.path || "")
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CHUNK_BYTES = 256 * 1024; // Base64 + JSON stays below ArtifactStore's 1 MiB limit.

export function validateSkillBundle(files) {
  if (!files || typeof files !== "object" || Array.isArray(files)
    || !Object.hasOwn(files, "SKILL.md") || typeof files["SKILL.md"] !== "string"
    || !files["SKILL.md"].trim()) fail("skill_document_required");
  if (Object.keys(files).length > SKILL_BUNDLE_LIMITS.files) fail("skill_bundle_limit", 413);
  let total = 0;
  for (const [path, content] of Object.entries(files)) {
    if (!validSkillBundlePath(path) || !isSyncableSkillFile(path)) fail("skill_file_path_denied");
    if (typeof content !== "string" || content.includes("\0")
      || Buffer.from(content).toString("utf8") !== content) fail("skill_file_content_invalid");
    const size = Buffer.byteLength(content);
    if (size > (path === "SKILL.md" ? SKILL_BUNDLE_LIMITS.documentBytes : SKILL_BUNDLE_LIMITS.auxiliaryBytes)
      || (total += size) > SKILL_BUNDLE_LIMITS.bytes) fail("skill_bundle_limit", 413);
  }
  return hash(canonicalSkillBundle(files));
}

// One instance per authorized Runtime Space. Clients receive references, never
// storage keys/URLs; submitted references must match this Space and source.
export class SkillBundleService {
  constructor({ artifactStore, scopeId }) {
    this.artifactStore = artifactStore;
    this.scopeId = String(scopeId || "local");
  }
  async publish(skill, files) {
    if (!this.artifactStore) fail("skill_artifact_store_unavailable", 503);
    if (!skill?.id || !skill?.sourceNodeId) fail("skill_source_required");
    const contentHash = validateSkillBundle(files);
    if (skill.contentHash && skill.contentHash !== contentHash) fail("skill_content_changed", 409);
    const entries = [];
    for (const [path, content] of Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const bytes = Buffer.from(content);
      const chunks = [];
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        chunks.push(await this.artifactStore.put({
          type: "skill-file-chunk", schemaVersion: 1,
          data: bytes.subarray(offset, offset + CHUNK_BYTES).toString("base64")
        }));
      }
      entries.push({ path, bytes: bytes.length, digest: hash(bytes), chunks });
    }
    const bundleRef = await this.artifactStore.put({
      type: "skill-bundle", schemaVersion: 1, scopeId: this.scopeId,
      source: identity(skill), contentHash, files: entries
    });
    return this.cachedSkill(skill, bundleRef, contentHash, Object.keys(files), files["SKILL.md"]);
  }
  cachedSkill(skill, bundleRef, contentHash, files, body) {
    return { ...skill, bundleRef, contentHash, files, body, runtimeCached: true,
      runtimeNodeId: "", runtimePath: "", runtimeFile: "" };
  }
  async manifest(skill) {
    if (!this.artifactStore) fail("skill_artifact_store_unavailable", 503);
    const value = await this.artifactStore.get(skill.bundleRef);
    if (value?.type !== "skill-bundle" || value.schemaVersion !== 1
      || value.scopeId !== this.scopeId || !same(value.source, identity(skill))
      || value.contentHash !== skill.contentHash || !/^[a-f0-9]{64}$/.test(value.contentHash || "")
      || !Array.isArray(value.files) || !value.files.length || value.files.length > SKILL_BUNDLE_LIMITS.files) {
      fail("skill_bundle_reference_denied", 403);
    }
    let total = 0;
    const names = new Set();
    for (const file of value.files) {
      if (!validSkillBundlePath(file.path) || !isSyncableSkillFile(file.path) || names.has(file.path)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0
        || file.bytes > (file.path === "SKILL.md" ? SKILL_BUNDLE_LIMITS.documentBytes : SKILL_BUNDLE_LIMITS.auxiliaryBytes)
        || (total += file.bytes) > SKILL_BUNDLE_LIMITS.bytes
        || !/^[a-f0-9]{64}$/.test(file.digest || "") || !Array.isArray(file.chunks)
        || file.chunks.length !== Math.ceil(file.bytes / CHUNK_BYTES)) fail("skill_bundle_invalid", 409);
      names.add(file.path);
    }
    if (!names.has("SKILL.md")) fail("skill_document_required", 409);
    return value;
  }
  async content(file) {
    const parts = [];
    for (const ref of file.chunks) {
      const chunk = await this.artifactStore.get(ref);
      if (chunk?.type !== "skill-file-chunk" || chunk.schemaVersion !== 1
        || typeof chunk.data !== "string" || chunk.data.length > Math.ceil(CHUNK_BYTES / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)) fail("skill_file_invalid", 409);
      parts.push(Buffer.from(chunk.data, "base64"));
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== file.bytes || hash(bytes) !== file.digest) fail("skill_file_integrity_error", 409);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  }
  async resolve(skill, previous) {
    if (!skill.bundleRef) {
      // Old clients continue to sync body-only Skills. Retain a verified bundle
      // when an old client sends the same version without its new reference.
      if (previous?.bundleRef && skill.contentHash === previous.contentHash && skill.body === previous.body) {
        return this.cachedSkill(skill, previous.bundleRef, previous.contentHash, previous.files, previous.body);
      }
      return { ...skill, runtimeCached: !!skill.body };
    }
    if (previous?.bundleRef && same(identity(skill), identity(previous))
      && skill.contentHash === previous.contentHash && same(skill.bundleRef, previous.bundleRef)) {
      return this.cachedSkill(skill, previous.bundleRef, previous.contentHash, previous.files, previous.body);
    }
    const manifest = await this.manifest(skill);
    return this.cachedSkill(skill, skill.bundleRef, manifest.contentHash, manifest.files.map((f) => f.path),
      await this.content(manifest.files.find((f) => f.path === "SKILL.md")));
  }
  async file(skill, path, expectedHash) {
    if (expectedHash && expectedHash !== skill.contentHash) fail("skill_content_changed", 409);
    if (!validSkillBundlePath(path) || !isSyncableSkillFile(path)) fail("skill_file_path_denied");
    if (!skill.bundleRef) fail("skill_bundle_not_cached", 409);
    const manifest = await this.manifest(skill);
    const file = manifest.files.find((f) => f.path === path);
    if (!file) fail("skill_file_not_found", 404);
    return { path, content: await this.content(file), contentHash: manifest.contentHash };
  }
  async files(skill, expectedHash) {
    if (!expectedHash || expectedHash !== skill.contentHash) fail("skill_content_changed", 409);
    const manifest = await this.manifest(skill);
    const files = Object.create(null);
    for (const file of manifest.files) files[file.path] = await this.content(file);
    if (validateSkillBundle(files) !== expectedHash) fail("skill_content_changed", 409);
    return files;
  }
}
