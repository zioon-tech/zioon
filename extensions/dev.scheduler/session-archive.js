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

function findTreeNode(root, id) {
  if (!root || !id) return null;
  if (String(root.id || "") === String(id)) return root;
  for (const child of root.children || []) {
    const found = findTreeNode(child, id);
    if (found) return found;
  }
  return null;
}

function archiveFolderTitle(locale) {
  return String(locale || "") === "zh-CN" ? "定时任务" : "Scheduled Tasks";
}

export async function ensureScheduledSessionFolder({ zion, store, locale } = {}) {
  try {
    const tree = await zion?.commands?.executeCommand?.("zion.sessions.getTreeSnapshot");
    if (!tree || tree.type !== "folder") return null;
    const state = store?.getSessionArchiveState?.() || {};
    const stored = findTreeNode(tree, state.folderId);
    if (stored?.type === "folder") return String(stored.id);

    const title = archiveFolderTitle(locale);
    const adopted = !state.folderId
      ? (tree.children || []).find((node) => node?.type === "folder" && node?.title === title)
      : null;
    const folderId = adopted?.id || await zion?.commands?.executeCommand?.(
      "zion.sessions.createFolder",
      { parentId: "root", title }
    );
    if (!folderId) return null;
    store?.saveSessionArchiveState?.({
      folderId: String(folderId),
      folderLocale: String(locale || "")
    });
    return String(folderId);
  } catch {
    return null;
  }
}

export async function migrateScheduledSessions({
  zion,
  store,
  locale,
  ensureFolder = ensureScheduledSessionFolder
} = {}) {
  const archiveState = store?.getSessionArchiveState?.() || {};
  if (Number(archiveState.migrationVersion || 0) >= SESSION_ARCHIVE_MIGRATION_VERSION) {
    return true;
  }

  const folderId = await ensureFolder({ zion, store, locale });
  if (!folderId) return false;

  for (const task of store?.listTasks?.() || []) {
    if ((task?.taskType || "agent") === "command" || normalizeSessionTag(task?.sessionTag)) continue;
    store.saveTask(withSessionTag(task, locale));
  }

  const catalog = zion?.state?.get?.("sessions.catalog");
  if (!Array.isArray(catalog)) return false;

  try {
    for (const entry of catalog) {
      const sessionId = String(entry?.id || "").trim();
      if (!sessionId) continue;
      const meta = await zion?.commands?.executeCommand?.("zion.sessions.getMeta", sessionId);
      if (meta === undefined) return false;
      if (meta?.source !== "scheduled-task") continue;

      const task = store?.getTask?.(String(meta.scheduledTaskId || ""));
      const sessionTag = normalizeSessionTag(task?.sessionTag) || sessionTagForLocale(locale);
      const transformed = await zion?.commands?.executeCommand?.("zion.sessions.transformDoc", {
        id: sessionId,
        transform: (text) => insertScheduledSessionTag(text, sessionTag)
      });
      if (transformed !== true) return false;

      const moved = await zion?.commands?.executeCommand?.("zion.sessions.moveNode", {
        id: sessionId,
        targetFolderId: folderId
      });
      if (moved !== true) return false;
    }
  } catch {
    return false;
  }

  store?.saveSessionArchiveState?.({
    migrationVersion: SESSION_ARCHIVE_MIGRATION_VERSION
  });
  return true;
}
