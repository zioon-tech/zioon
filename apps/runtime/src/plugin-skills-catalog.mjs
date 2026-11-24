import { createHash } from "node:crypto";
import { readdir, readFile, realpath, lstat } from "node:fs/promises";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import {
  isSyncableSkillFile,
  SKILLS_RUNTIME_PLUGIN_NODE_ID
} from "../../../extensions/dev.skills/skills-runtime-shared.js";
import { canonicalSkillBundle } from "../../../extensions/dev.skills/skill-bundle.js";
import { syncSkillsCatalog } from "./skills-catalog-http-handler.mjs";

const MAX_SKILL_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_FILES = 128;
const MAX_AUXILIARY_FILE_BYTES = 512 * 1024;
const MAX_SKILL_BYTES = 8 * 1024 * 1024;

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function modernManifest(plugin) {
  const manifest = objectValue(plugin?.manifest);
  return objectValue(manifest.zion);
}

function normalizePluginSkillPath(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!raw || raw.startsWith("/")) return "";
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return "";
  return parts.join("/");
}

function safePathSegment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

function isPathInside(root, candidate) {
  const path = relative(root, candidate);
  return path === ""
    || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function parseSkillFrontMatter(text) {
  const match = /^---\s*[\r\n]+([\s\S]*?)[\r\n]+---\s*/.exec(String(text || ""));
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+)\s*$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    const array = value.match(/^\[(.*)\]$/);
    meta[kv[1].trim()] = array
      ? array[1].split(",").map((item) => item.trim()).filter(Boolean)
      : value;
  }
  return {
    name: meta.name,
    description: meta.description,
    category: meta.category,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    allowedTools: Array.isArray(meta["allowed-tools"]) ? meta["allowed-tools"] : []
  };
}

async function readTextFile(path, maxBytes) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Skill symlink or non-file is not supported");
  if (info.size > maxBytes) throw new Error("Skill file exceeds its size limit");
  return await readFile(path, "utf8");
}

async function readSkillBundle(skillRoot) {
  const files = {};
  const skillBody = await readTextFile(join(skillRoot, "SKILL.md"), MAX_SKILL_BODY_BYTES).catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (!skillBody.trim()) return files;
  files["SKILL.md"] = skillBody;
  let totalBytes = Buffer.byteLength(skillBody);
  const queue = [{ path: skillRoot, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    const entries = await readdir(current.path, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(current.path, entry.name);
      const relativeFile = relative(skillRoot, absolute).replaceAll("\\", "/");
      if (!relativeFile || relativeFile === "SKILL.md") continue;
      if (entry.isDirectory()) {
        if (!isSyncableSkillFile(`${relativeFile}/placeholder.md`)) continue;
        if (current.depth >= 6) throw new Error("Skill directory exceeds its depth limit");
        if (current.depth < 6) queue.push({ path: absolute, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !isSyncableSkillFile(relativeFile)) continue;
      if (Object.keys(files).length >= MAX_SKILL_FILES) throw new Error("Skill bundle exceeds its file limit");
      const content = await readTextFile(absolute, MAX_AUXILIARY_FILE_BYTES);
      const size = Buffer.byteLength(content);
      if (totalBytes + size > MAX_SKILL_BYTES) throw new Error("Skill bundle exceeds its size limit");
      totalBytes += size;
      files[relativeFile] = content;
    }
  }
  return files;
}

function contentHash(files) {
  return createHash("sha256").update(canonicalSkillBundle(files)).digest("hex");
}

export async function buildRuntimePluginSkillsSource({
  plugins = [],
  bundles = null,
  now = Date.now()
} = {}) {
  const source = {
    nodeId: SKILLS_RUNTIME_PLUGIN_NODE_ID,
    nodeLabel: "Runtime Plugins",
    syncedAt: now,
    paths: [],
    catalog: []
  };
  const seen = new Set();
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    const zion = modernManifest(plugin);
    const pluginId = String(plugin?.id || zion.id || "").trim();
    const pluginDirectory = String(plugin?.directory || plugin?.path || "").trim();
    const contributions = zion?.contributes?.skills;
    if (!pluginId || !pluginDirectory || !Array.isArray(contributions)) continue;
    const pluginRoot = await realpath(pluginDirectory).catch(() => "");
    if (!pluginRoot) continue;
    for (const declaredPath of contributions) {
      const relativePath = normalizePluginSkillPath(declaredPath);
      const skillName = safePathSegment(basename(relativePath));
      if (!relativePath || !skillName) continue;
      const id = `${pluginId}/${skillName}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const skillRoot = resolve(pluginRoot, relativePath);
      const canonicalSkillRoot = await realpath(skillRoot).catch(() => "");
      if (!canonicalSkillRoot || !isPathInside(pluginRoot, canonicalSkillRoot)) continue;
      const files = await readSkillBundle(canonicalSkillRoot);
      const body = String(files["SKILL.md"] || "");
      if (!body.trim()) continue;
      const meta = parseSkillFrontMatter(body.slice(0, 6144));
      source.paths.push(canonicalSkillRoot);
      const skill = {
        id,
        name: meta.name || skillName,
        description: meta.description || "",
        category: meta.category || "",
        tags: meta.tags || [],
        allowedTools: meta.allowedTools || [],
        path: canonicalSkillRoot,
        file: join(canonicalSkillRoot, "SKILL.md"),
        source: "plugin",
        pluginId,
        sourceNodeId: SKILLS_RUNTIME_PLUGIN_NODE_ID,
        sourceNodeLabel: "Runtime Plugins",
        sourcePath: canonicalSkillRoot,
        sourceFile: join(canonicalSkillRoot, "SKILL.md"),
        contentHash: contentHash(files),
        syncedAt: now,
        runtimeCached: true,
        files: Object.keys(files),
        body
      };
      source.catalog.push(bundles?.artifactStore ? await bundles.publish(skill, files) : skill);
    }
  }
  source.paths = [...new Set(source.paths)];
  return source;
}

export async function syncRuntimePluginSkillsCatalog({
  store,
  plugins = [],
  bundles = null,
  now = Date.now()
} = {}) {
  const source = await buildRuntimePluginSkillsSource({ plugins, now, bundles });
  return syncSkillsCatalog({
    store,
    bundles,
    snapshot: {
      savedAt: now,
      pluginLastSync: now,
      enabled: source.catalog.map((skill) => skill.id),
      sources: [source]
    }
  });
}
