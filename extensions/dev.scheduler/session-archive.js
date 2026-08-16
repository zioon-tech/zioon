import { extractObsidianMetadata } from "../shared/obsidian-metadata.js";

export const SESSION_ARCHIVE_MIGRATION_VERSION = 1;

function normalizeSessionTag(value) {
  return String(value || "").replace(/^#/, "").trim();
}

export function sessionTagForLocale(locale) {
  return String(locale || "") === "zh-CN" ? "定时任务" : "scheduled_tasks";
}

export function withSessionTag(task, locale) {
  const sessionTag = normalizeSessionTag(task?.sessionTag) || sessionTagForLocale(locale);
  return { ...(task || {}), sessionTag };
}

export function buildScheduledSessionContent(prompt, sessionTag) {
  const tag = normalizeSessionTag(sessionTag);
  return `user ${String(prompt || "")}\n\n#${tag}\nassistant `;
}

export function insertScheduledSessionTag(text, sessionTag) {
  const source = String(text || "");
  const tag = normalizeSessionTag(sessionTag);
  if (!tag) return source;
  const label = `#${tag}`;
  if (extractObsidianMetadata(source).tags.some((item) => item.label === label)) return source;

  const lines = source.split("\n");
  const assistantIndex = lines.findIndex((line) => /^\s*assistant(?:\s|$)/.test(line));
  const insertAt = assistantIndex < 0 ? lines.length : assistantIndex;
  const insertion = [];
  if (insertAt > 0 && lines[insertAt - 1] !== "") insertion.push("");
  insertion.push(label);
  lines.splice(insertAt, 0, ...insertion);
  return lines.join("\n");
}
