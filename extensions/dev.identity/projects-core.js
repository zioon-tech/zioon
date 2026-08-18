const DEFAULT_PROJECT_INDEX_LIMIT = 1600;
const DEFAULT_PROJECT_INBOX_LIMIT = 800;
const DEFAULT_PROJECT_TEMPLATE_LIMIT = 2000;
const TRUNCATION_MARKER = "\n[truncated]";

const PROJECT_MAINTENANCE_INSTRUCTIONS = Object.freeze([
  "Treat ~/.zion-next/memory/projects as model-maintained working memory.",
  "Each project lives in projects/{canonical-slug}/; project.md is its front door, and supporting artifacts may live beside it.",
  "Every project.md preserves the template frontmatter and eight fixed sections: Goal, Current State, Plan, Timeline, Artifacts and Resources, Operating Notes, Lessons Learned, and Relationships.",
  "When the user explicitly starts or commits to a concrete project, read projects/_template.md, create projects/{canonical-slug}/project.md from it, and add its linked row to projects/index.md in the same turn; do not create projects from passing mentions.",
  "Before editing an existing project, read its project.md and preserve its fixed frontmatter and section structure.",
  "Only substantive progress, decisions, milestones, blocker changes, or completed plan items justify a project update.",
  "When project.md changes, update the matching one-line entry in projects/index.md in the same turn; write the project cell as a relative Markdown link such as [Project](./project-directory/project.md).",
  "Record a first-time unformed idea as one line in projects/inbox.md; when it recurs, propose creating a project and wait for user confirmation; after promotion, remove its inbox entry.",
  "Do not infer autonomy grants, deadlines, completion, blockers, project ownership, or user beliefs."
]);

function clipCharacters(value, maxChars) {
  const chars = Array.from(String(value || "").trim());
  const numericLimit = Number(maxChars);
  const limit = Number.isFinite(numericLimit) ? Math.max(0, Math.floor(numericLimit)) : chars.length;
  if (chars.length <= limit) return chars.join("");
  if (!limit) return "";
  const marker = Array.from(TRUNCATION_MARKER);
  if (limit <= marker.length) return marker.slice(0, limit).join("");
  return `${chars.slice(0, limit - marker.length).join("")}${TRUNCATION_MARKER}`;
}

function compactLine(value, fallback = "") {
  const text = Array.from(String(value || ""))
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(text || fallback).slice(0, 120).join("");
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function yamlString(value) {
  return JSON.stringify(String(value || ""));
}

export const PROJECT_INDEX_TEMPLATE = `# 项目索引

> 项目列使用 Markdown 链接：[项目名](./目录名/project.md)。

| 项目 | 状态 | 优先级 | 下一步 | 更新 |
|---|---|---|---|---|
`;

export const PROJECT_INBOX_TEMPLATE = `# 杂思收集箱

> 未成形的想法先记录在这里；同一想法再次出现时提议立项。
`;

export function buildProjectTemplate(options = {}) {
  const project = compactLine(options.project, "project-name");
  const date = normalizeDate(options.date);
  return `---
project: ${yamlString(project)}
status: active
priority: medium
owner: user
autonomy: none
next_due:
wait_until:
created: ${date}
updated: ${date}
tags: []
---

# ${project}

## 目标

## 当前状态
- 进度：
- 下一步：
- 阻塞：
- 等待：

## 计划

## 时间线

## 产物与资源

## 使用姿势

## 经验教训

## 关联
`;
}

export const PROJECT_FILE_TEMPLATE = buildProjectTemplate();

export function buildProjectContext(index, options = {}) {
  const indexContent = clipCharacters(
    index,
    options.maxChars ?? DEFAULT_PROJECT_INDEX_LIMIT
  );
  const inboxContent = clipCharacters(
    options.inbox,
    options.inboxMaxChars ?? DEFAULT_PROJECT_INBOX_LIMIT
  );
  const templateContent = clipCharacters(
    options.template,
    options.templateMaxChars ?? DEFAULT_PROJECT_TEMPLATE_LIMIT
  );
  const fragments = [];
  if (indexContent) {
    fragments.push([
      '<projects_index source="~/.zion-next/memory/projects/index.md">',
      `  <content>${escapeXml(indexContent)}</content>`,
      "</projects_index>"
    ].join("\n"));
  }
  if (inboxContent) {
    fragments.push([
      '<projects_inbox source="~/.zion-next/memory/projects/inbox.md">',
      `  <content>${escapeXml(inboxContent)}</content>`,
      "</projects_inbox>"
    ].join("\n"));
  }
  if (templateContent) {
    fragments.push([
      '<project_template source="~/.zion-next/memory/projects/_template.md">',
      `  <content>${escapeXml(templateContent)}</content>`,
      "</project_template>"
    ].join("\n"));
  }
  return {
    fragment: fragments.join("\n"),
    instructions: [...PROJECT_MAINTENANCE_INSTRUCTIONS]
  };
}

function splitProjectTableRow(line) {
  const text = String(line || "").trim();
  if (!text.startsWith("|")) return [];
  const cells = [];
  let current = "";
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\" && text[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) cells.push(current.trim());
  return cells;
}

function isProjectTableHeader(cells) {
  if (cells[0] === "项目") return true;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseProjectLink(value) {
  const text = String(value || "").trim();
  const match = text.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (!match) return { name: text, path: "" };
  return {
    name: match[1].replace(/\\([[\]|])/g, "$1").trim(),
    path: match[2].trim()
  };
}

function safeProjectRelativePath(value) {
  let path = String(value || "").trim();
  if (path.startsWith("<") && path.endsWith(">")) path = path.slice(1, -1).trim();
  try {
    path = decodeURIComponent(path);
  } catch {
    return "";
  }
  if (!path || path.startsWith("/") || path.includes("\\")) return "";
  path = path.replace(/^\.\//, "");
  const segments = path.split("/");
  if (
    segments.length < 2
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || segments.at(-1) !== "project.md"
  ) {
    return "";
  }
  return segments.join("/");
}

function projectSlug(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeProjectDirectories(entries, projectsRoot) {
  const root = String(projectsRoot || "").replace(/\/+$/, "");
  const directories = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const type = String(entry?.type || "").toLowerCase();
    if (type !== "dir" && type !== "directory") continue;
    const path = String(entry?.path || "").replace(/\/+$/, "");
    const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
    if (!relative || relative.includes("/")) continue;
    directories.push({ name: relative, path: `${root}/${relative}` });
  }
  return directories;
}

function resolveLegacyProjectPath(name, directories) {
  const exactMatches = directories.filter((directory) => directory.name === name);
  if (exactMatches.length === 1) return `${exactMatches[0].path}/project.md`;
  const slug = projectSlug(name);
  if (!slug) return "";
  const slugMatches = directories.filter((directory) => projectSlug(directory.name) === slug);
  return slugMatches.length === 1 ? `${slugMatches[0].path}/project.md` : "";
}

export function parseProjectIndex(markdown, options = {}) {
  const numericLimit = Number(options.limit);
  const limit = Math.min(
    200,
    Math.max(0, Number.isFinite(numericLimit) ? Math.floor(numericLimit) : 200)
  );
  if (!limit) return [];
  const rows = [];
  for (const line of String(markdown || "").split(/\r?\n/)) {
    const cells = splitProjectTableRow(line);
    if (cells.length < 5 || isProjectTableHeader(cells)) continue;
    const linked = parseProjectLink(cells[0]);
    const name = compactLine(linked.name || cells[0]);
    if (!name) continue;
    rows.push({
      name,
      status: compactLine(cells[1]),
      priority: compactLine(cells[2]),
      nextStep: compactLine(cells[3]),
      updated: compactLine(cells[4]),
      relativePath: safeProjectRelativePath(linked.path)
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

export function resolveProjectIndexRows(rows, entries, projectsRoot) {
  const root = String(projectsRoot || "").replace(/\/+$/, "");
  const directories = normalizeProjectDirectories(entries, root);
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    path: row.relativePath
      ? `${root}/${row.relativePath}`
      : resolveLegacyProjectPath(row.name, directories)
  }));
}
