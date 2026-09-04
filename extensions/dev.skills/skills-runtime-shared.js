export const SKILLS_RUNTIME_PLUGIN_ID = "dev.skills";
export const SKILLS_RUNTIME_STATE_NAMESPACE = "skills";
export const SKILLS_RUNTIME_SNAPSHOT_KEY = "snapshot";
export const SKILLS_RUNTIME_KV_KEY =
  `runtime.plugins.${SKILLS_RUNTIME_PLUGIN_ID}.${SKILLS_RUNTIME_STATE_NAMESPACE}.${SKILLS_RUNTIME_SNAPSHOT_KEY}`;

function uniqueStrings(value) {
  return Array.from(new Set(
    (Array.isArray(value) ? value : [])
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean)
  ));
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function normalizeMaterializedSkills(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => objectValue(entry))
    .filter((entry) => String(entry.id || "").trim())
    .map((entry) => ({
      id: String(entry.id),
      pluginId: String(entry.pluginId || ""),
      pluginPath: String(entry.pluginPath || ""),
      skillName: String(entry.skillName || ""),
      relativePath: String(entry.relativePath || ""),
      sourceFile: String(entry.sourceFile || ""),
      path: String(entry.path || ""),
      file: String(entry.file || ""),
      files: uniqueStrings(entry.files)
    }));
}

export function normalizeSkillsSnapshot(value = {}) {
  const source = objectValue(value);
  const catalog = Array.isArray(source.catalog) ? source.catalog : [];
  return {
    version: 1,
    savedAt: Number(source.savedAt) || Date.now(),
    paths: uniqueStrings(source.paths),
    enabled: uniqueStrings(source.enabled),
    catalog: catalog
      .map((skill) => objectValue(skill))
      .filter((skill) => String(skill.id || "").trim())
      .map((skill) => ({
        id: String(skill.id),
        name: String(skill.name || skill.id),
        description: String(skill.description || ""),
        category: String(skill.category || ""),
        tags: uniqueStrings(skill.tags),
        difficulty: String(skill.difficulty || ""),
        allowedTools: uniqueStrings(skill.allowedTools),
        dependencies: uniqueStrings(skill.dependencies),
        path: String(skill.path || ""),
        file: String(skill.file || ""),
        source: String(skill.source || "user"),
        pluginId: String(skill.pluginId || "")
      })),
    // Skill bodies remain in the filesystem and are loaded on demand.
    cacheContent: {},
    usageHistory: objectValue(source.usageHistory),
    tokenBudget: Number(source.tokenBudget) || 30000,
    config: objectValue(source.config),
    dependencyGraph: objectValue(source.dependencyGraph),
    pluginMaterialized: normalizeMaterializedSkills(source.pluginMaterialized),
    pluginLastSync: Number(source.pluginLastSync) || 0,
    lastScan: Number(source.lastScan) || 0
  };
}

function escapeXML(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildAvailableSkillsContextXml(snapshot) {
  const normalized = normalizeSkillsSnapshot(snapshot);
  const enabledSet = new Set(normalized.enabled);
  const enabledSkills = normalized.catalog.filter((skill) =>
    enabledSet.has(skill.id)
  );
  const skillXMLs = enabledSkills
    .map((skill) => {
      const name = escapeXML(skill.name || skill.id);
      const desc = skill.description
        ? `<description>${escapeXML(skill.description)}</description>`
        : "";
      const location = skill.file || (skill.path ? `${skill.path}/SKILL.md` : "");
      const locationXml = location
        ? `<location>${escapeXML(location)}</location>`
        : "";
      return `  <skill>\n    <name>${name}</name>\n    ${desc}\n    ${locationXml}\n  </skill>`;
    })
    .join("\n");

  return `<available_skills>\n${skillXMLs}\n</available_skills>\n\nWhen you need detailed instructions for a skill, use the Read tool to access the file at the specified location.`;
}

export function insertAfterLeadingSystem(messages, injectedMessage) {
  const list = Array.isArray(messages) ? messages : [];
  let insertAt = 0;
  while (insertAt < list.length && list[insertAt]?.role === "system") insertAt += 1;
  return [
    ...list.slice(0, insertAt),
    injectedMessage,
    ...list.slice(insertAt)
  ];
}
