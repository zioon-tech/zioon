const DEFAULT_PROJECT_INDEX_LIMIT = 1600;
const TRUNCATION_MARKER = "\n[truncated]";

const PROJECT_MAINTENANCE_INSTRUCTIONS = Object.freeze([
  "Treat ~/.zion-next/memory/projects as model-maintained working memory.",
  "Before editing an existing project, read its project.md and preserve its fixed frontmatter and section structure.",
  "Only substantive progress, decisions, milestones, blocker changes, or completed plan items justify a project update.",
  "When project.md changes, update the matching one-line entry in projects/index.md in the same turn.",
  "Record a first-time unformed idea as one line in projects/inbox.md; when it recurs, propose creating a project and wait for user confirmation.",
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
  const content = clipCharacters(
    index,
    options.maxChars ?? DEFAULT_PROJECT_INDEX_LIMIT
  );
  if (!content) return { fragment: "", instructions: [] };
  return {
    fragment: [
      '<projects_index source="~/.zion-next/memory/projects/index.md">',
      `  <content>${escapeXml(content)}</content>`,
      "</projects_index>"
    ].join("\n"),
    instructions: [...PROJECT_MAINTENANCE_INSTRUCTIONS]
  };
}
