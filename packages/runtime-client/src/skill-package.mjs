import { createHash } from "node:crypto";
import { normalizeSkillFiles } from "./package-files.mjs";

export const SKILL_PACKAGE_SCHEMA_VERSION = 1;
const categories = ["研究写作", "开发", "文档", "数据", "外部服务"];
const invalid = (message) => {
  throw Object.assign(new Error(message), { statusCode: 422, code: "invalid_skill_package" });
};
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const only = (value, keys) => {
  if (!object(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    invalid("Skill package contains unsupported fields");
  }
};
const text = (value, field, max, optional = false) => {
  if (optional && value === undefined) return "";
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    invalid(`${field} must contain 1–${max} characters`);
  }
  return value.trim();
};

// Normalize in a fixed field order so pack and upload agree on the exact artifact.
export function normalizeSkillPackage(input) {
  only(input, ["schemaVersion", "kind", "manifest", "body", "files", "digest"]);
  if (input.schemaVersion !== 1 || input.kind !== "skill") invalid("Expected schemaVersion 1 and kind skill");
  only(input.manifest, ["slug", "name", "summary", "version", "category", "license", "sourceUrl", "description", "changelog"]);
  const source = input.manifest;
  const slug = text(source.slug, "slug", 60);
  if (!/^[a-z][a-z0-9-]{1,59}$/.test(slug)) invalid("slug must use lowercase letters, numbers and hyphens");
  const version = text(source.version, "version", 40);
  if (!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version)) invalid("version must be x.y.z");
  const name = text(source.name, "name", 100);
  const summary = text(source.summary, "summary", 300);
  if (!categories.includes(source.category)) invalid("Unsupported Skill category");
  const body = text(input.body, "body", 100000).replace(/\r\n/g, "\n");
  if (Buffer.byteLength(body, "utf8") > 100000) invalid("SKILL.md exceeds 100KB");
  const header = body.match(/^---\n([\s\S]+?)\n---(?:\n|$)/)?.[1];
  if (!header || !/^name:\s*\S+/m.test(header) || !/^description:\s*\S+/m.test(header)) {
    invalid("SKILL.md frontmatter must contain name and description");
  }
  let sourceUrl = text(source.sourceUrl, "sourceUrl", 1000, true);
  if (sourceUrl) {
    let url;
    try { url = new URL(sourceUrl); } catch { invalid("sourceUrl must be a valid HTTPS URL"); }
    if (url.protocol !== "https:" || url.username || url.password) invalid("sourceUrl must be credential-free HTTPS");
    sourceUrl = url.href;
  }
  const manifest = {
    slug, name, summary, version, category: source.category,
    license: text(source.license, "license", 80),
    ...(sourceUrl ? { sourceUrl } : {}),
    description: text(source.description ?? summary, "description", 20000),
    changelog: text(source.changelog ?? "首个版本", "changelog", 4000)
  };
  const files = normalizeSkillFiles(input.files);
  if (files["SKILL.md"] !== undefined && files["SKILL.md"].trim() !== body) invalid("Conflicting SKILL.md contents");
  delete files["SKILL.md"];
  const normalized = { schemaVersion: 1, kind: "skill", manifest, body,
    ...(Object.keys(files).length ? { files } : {}) };
  if (Buffer.byteLength(JSON.stringify(normalized)) > 256000) invalid("Skill package exceeds 256KB");
  const digest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  if (input.digest !== undefined && input.digest !== digest) {
    throw Object.assign(new Error("Skill package digest does not match its content"), {
      statusCode: 409, code: "digest_mismatch"
    });
  }
  return { ...normalized, digest };
}

export function privateSkillRelease(artifact, userId, userName) {
  artifact = normalizeSkillPackage(artifact);
  const { manifest, body } = artifact;
  const publisherId = `u${createHash("sha256").update(userId).digest("hex").slice(0, 16)}`;
  return {
    id: `private.${publisherId}.${manifest.slug}`,
    name: manifest.name, summary: manifest.summary, category: manifest.category,
    kind: "skill", version: manifest.version,
    publisher: { id: publisherId, name: String(userName || "我的账户").slice(0, 100), origin: "private" },
    ...(manifest.sourceUrl ? { sourceUrl: manifest.sourceUrl } : {}),
    license: manifest.license, description: manifest.description, changelog: manifest.changelog,
    visibility: "private", artifact,
    components: [{ id: manifest.slug, kind: "skill", name: manifest.name, description: manifest.summary, body }]
  };
}
