const BUNDLED_PLUGIN_SKILLS = import.meta.glob("/extensions/**/skills/**/SKILL.md", {
  query: "?raw",
  import: "default"
});

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
        skillName,
        relativePath,
        embeddedContent: typeof plugin?.skillContents?.[relativePath] === "string"
          ? plugin.skillContents[relativePath]
          : "",
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

async function writeFile(base, path, content) {
  const response = await fetch(`${base}/files/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content })
  });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(message || `HTTP ${response.status}`);
  }
}

async function deleteFile(base, path) {
  try {
    const response = await fetch(`${base}/files/delete`, {
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
    if (!content.trim()) {
      const existing = previousById.get(declaration.id);
      if (existing) materialized.push(existing);
      continue;
    }
    await writeFile(base, destinationFile, content);
    materialized.push({
      ...catalogEntry,
      path: destinationDir,
      file: destinationFile
    });
  }

  for (const entry of previous) {
    if (!entry?.id || desiredIds.has(entry.id) || !entry.file) continue;
    await deleteFile(base, entry.file);
  }

  return materialized;
}
