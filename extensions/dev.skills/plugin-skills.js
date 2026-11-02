import { isSyncableSkillFile } from "./skills-runtime-shared.js";

const BUNDLED_PLUGIN_SKILLS = import.meta.glob([
  "/extensions/**/skills/**/SKILL.md",
  "!/extensions/dev.identity/skills/**/SKILL.md"
], {
  query: "?raw",
  import: "default"
});
const BUNDLED_PLUGIN_SKILL_FILES = import.meta.glob(
  [
    "/extensions/**/skills/**/*.{md,mdx,txt,json,yaml,yml,js,mjs,cjs,ts,tsx,jsx,py,sh,bash,zsh,xml,html,css,csv}",
    "!/extensions/dev.identity/skills/**/*.{md,mdx,txt,json,yaml,yml,js,mjs,cjs,ts,tsx,jsx,py,sh,bash,zsh,xml,html,css,csv}"
  ],
  {
    query: "?raw",
    import: "default"
  }
);

function trimSlashes(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

export function normalizePluginSkillPath(value) {
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

function joinResourcePath(base, relative) {
  return `${String(base || "").replace(/\/+$/, "")}/${String(relative || "").replace(/^\/+/, "")}`;
}

function joinFsPath(base, relative) {
  return `${String(base || "").replace(/\/+$/, "")}/${String(relative || "").replace(/^\/+/, "")}`;
}

function normalizeSkillFilePath(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw || raw.startsWith("/") || raw.endsWith("/")) return "";
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return "";
  const joined = parts.join("/");
  return isSyncableSkillFile(joined) ? joined : "";
}

function modernManifest(plugin) {
  const manifest = plugin?.manifest;
  return manifest?.zion && typeof manifest.zion === "object" ? manifest.zion : null;
}

export function collectPluginSkillContributions(plugins) {
  const result = [];
  const seen = new Set();
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    const zion = modernManifest(plugin);
    const pluginId = String(plugin?.id || zion?.id || "").trim();
    const pluginPath = String(plugin?.path || "").trim().replace(/\/+$/, "");
    const contributions = zion?.contributes?.skills;
    if (!pluginId || !Array.isArray(contributions)) continue;
    for (const declaredPath of contributions) {
      const relativePath = normalizePluginSkillPath(declaredPath);
      if (!relativePath) continue;
      const skillName = safePathSegment(relativePath.split("/").pop());
      if (!skillName) continue;
      const id = `${pluginId}/${skillName}`;
      if (seen.has(id)) continue;
      seen.add(id);
      result.push({
        id,
        pluginId,
        pluginPath,
        sourceDir: typeof plugin?.sourceDir === "string" ? plugin.sourceDir : "",
        skillName,
        relativePath,
        embeddedContent: typeof plugin?.skillContents?.[relativePath] === "string"
          ? plugin.skillContents[relativePath]
          : "",
        embeddedFiles: plugin?.skillFiles?.[relativePath] && typeof plugin.skillFiles[relativePath] === "object"
          ? plugin.skillFiles[relativePath]
          : null,
        sourceFile: joinResourcePath(pluginPath, `${relativePath}/SKILL.md`)
      });
    }
  }
  return result;
}

async function bundledSkillContent(sourceFile, bundledSources = BUNDLED_PLUGIN_SKILLS) {
  const normalized = `/${trimSlashes(sourceFile)}`;
  const value = bundledSources?.[normalized];
  if (typeof value === "string") return value;
  if (typeof value !== "function") return "";
  try {
    const loaded = await value();
    return typeof loaded === "string" ? loaded : "";
  } catch {
    return "";
  }
}

async function fetchSkillContent(sourceFile, bundledSources) {
  const bundled = await bundledSkillContent(sourceFile, bundledSources);
  if (bundled) return bundled;
  try {
    const response = await fetch(sourceFile, { method: "GET" });
    if (!response.ok) return "";
    return await response.text();
  } catch {
    return "";
  }
}

async function loadRawModule(value) {
  if (typeof value === "string") return value;
  if (typeof value !== "function") return "";
  try {
    const loaded = await value();
    return typeof loaded === "string" ? loaded : "";
  } catch {
    return "";
  }
}

async function bundledSkillFiles(sourceDir, bundledSources = BUNDLED_PLUGIN_SKILL_FILES) {
  const prefix = `/${trimSlashes(sourceDir)}/`;
  const files = {};
  for (const [rawPath, loader] of Object.entries(bundledSources || {})) {
    const normalizedPath = `/${trimSlashes(rawPath)}`;
    if (!normalizedPath.startsWith(prefix)) continue;
    const relativeFile = normalizeSkillFilePath(normalizedPath.slice(prefix.length));
    if (!relativeFile) continue;
    const content = await loadRawModule(loader);
    if (content) files[relativeFile] = content;
  }
  return files;
}

function localToolsUrl(base, endpoint, { path, nodeId, ...params } = {}) {
  const url = new URL(
    `${String(base || "").replace(/\/+$/, "")}${endpoint}`,
    globalThis.location?.href || "http://localhost/"
  );
  if (path != null) url.searchParams.set("path", String(path));
  if (nodeId) url.searchParams.set("node_id", String(nodeId));
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function listLocalDirEntries(base, dir, nodeId) {
  try {
    const url = localToolsUrl(base, "/files/entries", {
      path: dir,
      nodeId,
      max_depth: 1
    });
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return [];
    const json = await res.json().catch(() => null);
    const raw = json && typeof json === "object" && "results" in json ? json.results : json;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry) => {
        const path = String(entry?.path || entry?.full_path || entry || "").trim().replace(/\/$/, "");
        if (!path) return null;
        const type = String(entry?.type || entry?.kind || "").toLowerCase() || (String(entry).endsWith("/") ? "dir" : "file");
        return { path, type: type === "directory" ? "dir" : type };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readLocalTextFile(base, path, nodeId) {
  try {
    const url = localToolsUrl(base, "/files/read", { path, nodeId });
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return "";
    const json = await res.json().catch(() => null);
    const content = json && typeof json === "object" ? json.content : "";
    return typeof content === "string" && content.length <= 256 * 1024 ? content : "";
  } catch {
    return "";
  }
}

async function localSkillFiles(base, sourceDir, relativePath, nodeId, maxDepth = 6) {
  const skillRoot = joinFsPath(sourceDir, relativePath);
  const files = {};
  const walk = async (dir, depth) => {
    if (depth > maxDepth) return;
    const entries = await listLocalDirEntries(base, dir, nodeId);
    for (const entry of entries) {
      if (!entry?.path) continue;
      const relativeFile = normalizeSkillFilePath(entry.path.slice(skillRoot.length).replace(/^\/+/, ""));
      if (entry.type === "dir") {
        await walk(entry.path, depth + 1);
        continue;
      }
      if (!relativeFile) continue;
      const content = await readLocalTextFile(base, entry.path, nodeId);
      if (content) files[relativeFile] = content;
    }
  };
  await walk(skillRoot, 0);
  return files;
}

async function resolveSkillFiles(base, declaration, options, skillContent) {
  const embedded = declaration.embeddedFiles && typeof declaration.embeddedFiles === "object"
    ? { ...declaration.embeddedFiles }
    : {};
  if (Object.keys(embedded).length) {
    if (skillContent && !embedded["SKILL.md"]) embedded["SKILL.md"] = skillContent;
    return embedded;
  }

  const bundled = await bundledSkillFiles(
    joinResourcePath(declaration.pluginPath, declaration.relativePath),
    options.bundledSkillFiles
  );
  if (Object.keys(bundled).length) {
    if (skillContent && !bundled["SKILL.md"]) bundled["SKILL.md"] = skillContent;
    return bundled;
  }

  if (declaration.sourceDir) {
    const local = await localSkillFiles(
      base,
      declaration.sourceDir,
      declaration.relativePath,
      options.nodeId
    );
    if (Object.keys(local).length) {
      if (skillContent && !local["SKILL.md"]) local["SKILL.md"] = skillContent;
      return local;
    }
  }

  return skillContent ? { "SKILL.md": skillContent } : {};
}

async function writeFile(base, path, content, nodeId) {
  const response = await fetch(localToolsUrl(base, "/files/write", { nodeId }), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content })
  });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(message || `HTTP ${response.status}`);
  }
}

async function deleteFile(base, path, nodeId) {
  try {
    const response = await fetch(localToolsUrl(base, "/files/delete", { nodeId }), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path })
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

export async function materializePluginSkills(options = {}) {
  const base = String(options.base || "").replace(/\/$/, "");
  const root = String(options.root || "").replace(/\/$/, "");
  const nodeId = String(options.nodeId || "").trim();
  const previous = Array.isArray(options.previous) ? options.previous : [];
  const declarations = collectPluginSkillContributions(options.plugins);
  if (!base || !root) return previous;

  const previousById = new Map(previous.map((entry) => [entry?.id, entry]).filter(([id]) => id));
  const desiredIds = new Set(declarations.map((entry) => entry.id));
  const materialized = [];

  for (const declaration of declarations) {
    const { embeddedContent, ...catalogEntry } = declaration;
    const destinationDir = `${root}/${safePathSegment(declaration.pluginId)}/${declaration.skillName}`;
    const destinationFile = `${destinationDir}/SKILL.md`;
    const content = embeddedContent || await fetchSkillContent(declaration.sourceFile, options.bundledSources);
    const files = await resolveSkillFiles(base, declaration, options, content);
    if (!String(files["SKILL.md"] || "").trim()) {
      const existing = previousById.get(declaration.id);
      if (existing) materialized.push(existing);
      continue;
    }
    const writtenFiles = [];
    for (const [relativeFile, fileContent] of Object.entries(files).sort(([a], [b]) => {
      if (a === "SKILL.md") return -1;
      if (b === "SKILL.md") return 1;
      return a.localeCompare(b);
    })) {
      const normalizedFile = normalizeSkillFilePath(relativeFile);
      if (!normalizedFile || typeof fileContent !== "string") continue;
      const targetFile = `${destinationDir}/${normalizedFile}`;
      await writeFile(base, targetFile, fileContent, nodeId);
      writtenFiles.push(targetFile);
    }
    materialized.push({
      ...catalogEntry,
      path: destinationDir,
      file: destinationFile,
      files: writtenFiles
    });
  }

  for (const entry of previous) {
    if (!entry?.id || desiredIds.has(entry.id)) continue;
    const files = Array.isArray(entry.files) && entry.files.length ? entry.files : [entry.file].filter(Boolean);
    for (const file of files) await deleteFile(base, file, nodeId);
  }

  return materialized;
}
