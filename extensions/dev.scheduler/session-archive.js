import { extractObsidianMetadata } from "../shared/obsidian-metadata.js";

// Version 4 waits for the full Session Manager catalog before committing migration.
export const SESSION_ARCHIVE_MIGRATION_VERSION = 4;

function normalizeSessionTag(value) {
  return String(value || "").replace(/^#/, "").trim();
}

function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function archiveDateForTimestamp(timestamp, timeZone, fallbackTimeZone = localTimeZone()) {
  const value = Number(timestamp);
  const date = new Date(Number.isFinite(value) ? value : Date.now());
  const zones = [...new Set([timeZone, fallbackTimeZone, "UTC"].filter(Boolean).map(String))];
  for (const zone of zones) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(date);
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      const year = String(values.year || "").padStart(4, "0");
      const month = String(values.month || "").padStart(2, "0");
      const day = String(values.day || "").padStart(2, "0");
      if (year && month && day) {
        return {
          year,
          month,
          day,
          key: `${year}/${month}/${day}`,
          segments: [year, month, day]
        };
      }
    } catch {}
  }
  return {
    year: "1970",
    month: "01",
    day: "01",
    key: "1970/01/01",
    segments: ["1970", "01", "01"]
  };
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

export function scheduledSessionTagForDate(baseTag, archiveDate) {
  const base = normalizeSessionTag(baseTag);
  const segments = Array.isArray(archiveDate?.segments) ? archiveDate.segments.map(String) : [];
  return [base, ...segments].filter(Boolean).join("/");
}

export function rewriteScheduledSessionTag(text, baseTag, archiveDate) {
  const source = String(text || "");
  const base = normalizeSessionTag(baseTag);
  const nextTag = scheduledSessionTagForDate(base, archiveDate);
  if (!base || !nextTag) return source;
  const nextLabel = `#${nextTag}`;
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const generatedPattern = new RegExp(`^#${escapedBase}(?:$|/\\d{4}/\\d{2}/\\d{2}$)`);
  const generated = extractObsidianMetadata(source).tags.find((tag) => generatedPattern.test(tag.label));
  if (!generated) return insertScheduledSessionTag(source, nextTag);
  if (generated.label === nextLabel) return source;
  return `${source.slice(0, generated.pos)}${nextLabel}${source.slice(generated.pos + generated.label.length)}`;
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

function isTreeDescendant(root, ancestorId, nodeId) {
  const ancestor = findTreeNode(root, ancestorId);
  return Boolean(findTreeNode(ancestor, nodeId));
}

function collectTreeSessionIds(root, result = []) {
  if (!root) return result;
  if (root.type === "session" && root.id) result.push(String(root.id));
  for (const child of root.children || []) collectTreeSessionIds(child, result);
  return result;
}

function findDirectFolder(parent, title) {
  return (parent?.children || []).find((node) => (
    node?.type === "folder" && String(node.title || "") === String(title)
  )) || null;
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

export async function ensureScheduledSessionDateFolder({
  zion,
  store,
  locale,
  archiveDate,
  ensureFolder = ensureScheduledSessionFolder
} = {}) {
  try {
    const rootId = await ensureFolder({ zion, store, locale });
    if (!rootId || !Array.isArray(archiveDate?.segments) || !archiveDate.segments.length) return null;
    const tree = await zion?.commands?.executeCommand?.("zion.sessions.getTreeSnapshot");
    let parent = findTreeNode(tree, rootId);
    if (parent?.type !== "folder") return null;

    for (const rawSegment of archiveDate.segments) {
      const segment = String(rawSegment || "").trim();
      if (!segment) return null;
      const existing = findDirectFolder(parent, segment);
      if (existing) {
        parent = existing;
        continue;
      }
      const folderId = await zion?.commands?.executeCommand?.(
        "zion.sessions.createFolder",
        { parentId: parent.id, title: segment }
      );
      if (!folderId) return null;
      parent = {
        id: String(folderId),
        type: "folder",
        title: segment,
        children: []
      };
    }
    return String(parent.id);
  } catch {
    return null;
  }
}

export async function removeEmptyScheduledSessionFolder({
  zion,
  store
} = {}) {
  try {
    const tree = await zion?.commands?.executeCommand?.("zion.sessions.getTreeSnapshot");
    if (!tree || tree.type !== "folder") return false;
    const archiveState = store?.getSessionArchiveState?.() || {};
    const stored = findTreeNode(tree, archiveState.folderId);
    const folder = stored?.type === "folder" ? stored : null;
    if (!folder || (folder.children || []).length > 0) return false;
    const removed = await zion?.commands?.executeCommand?.(
      "zion.sessions.deleteFolder",
      folder.id
    );
    if (removed !== true) return false;
    store?.saveSessionArchiveState?.({
      folderId: null,
      folderLocale: "",
      migrationVersion: SESSION_ARCHIVE_MIGRATION_VERSION
    });
    return true;
  } catch {
    return false;
  }
}

export async function migrateScheduledSessions({
  zion,
  store,
  locale,
  force = false,
  moveOutsideArchive = false,
  now = () => Date.now(),
  ensureFolder = ensureScheduledSessionFolder,
  ensureDateFolder = ensureScheduledSessionDateFolder
} = {}) {
  const archiveState = store?.getSessionArchiveState?.() || {};
  const previousVersion = Number(archiveState.migrationVersion || 0);
  if (!force && previousVersion >= SESSION_ARCHIVE_MIGRATION_VERSION) {
    return true;
  }

  const catalog = zion?.state?.get?.("sessions.catalog");
  if (!Array.isArray(catalog) || catalog.length === 0) return false;
  const initialTree = await zion?.commands?.executeCommand?.("zion.sessions.getTreeSnapshot");
  if (!initialTree) return false;
  const catalogIds = new Set(catalog.map((entry) => String(entry?.id || "")).filter(Boolean));
  if (collectTreeSessionIds(initialTree).some((id) => !catalogIds.has(id))) return false;

  const folderId = await ensureFolder({ zion, store, locale });
  if (!folderId) return false;
  const migrationStartedAt = Number(now()) || Date.now();

  for (const task of store?.listTasks?.() || []) {
    if ((task?.taskType || "agent") === "command" || normalizeSessionTag(task?.sessionTag)) continue;
    store.saveTask(withSessionTag(task, locale));
  }

  try {
    for (const entry of catalog) {
      const sessionId = String(entry?.id || "").trim();
      if (!sessionId) continue;
      const meta = await zion?.commands?.executeCommand?.("zion.sessions.getMeta", sessionId);
      if (meta === undefined) return false;
      const treeTitle = findTreeNode(initialTree, sessionId)?.title;
      const isLegacyScheduledSession = force && /^定时任务\s*·/.test(
        String(treeTitle || meta?.title || entry?.title || "")
      );
      if (meta?.source !== "scheduled-task" && !isLegacyScheduledSession) continue;

      const task = store?.getTask?.(String(meta.scheduledTaskId || ""));
      const sessionTag = normalizeSessionTag(task?.sessionTag) || sessionTagForLocale(locale);
      const timestamp = Number(
        meta.createdAt
        || meta.scheduledRunCompletedAt
        || meta.updatedAt
        || migrationStartedAt
      );
      const archiveDate = archiveDateForTimestamp(timestamp, task?.schedule?.timeZone);
      const transformed = await zion?.commands?.executeCommand?.("zion.sessions.transformDoc", {
        id: sessionId,
        transform: (text) => rewriteScheduledSessionTag(text, sessionTag, archiveDate)
      });
      if (transformed !== true) return false;

      if (
        moveOutsideArchive
        || previousVersion < 1
        || isTreeDescendant(initialTree, folderId, sessionId)
      ) {
        const targetFolderId = await ensureDateFolder({
          zion,
          store,
          locale,
          archiveDate,
          ensureFolder
        });
        if (!targetFolderId) return false;
        const moved = await zion?.commands?.executeCommand?.("zion.sessions.moveNode", {
          id: sessionId,
          targetFolderId
        });
        if (moved !== true) return false;
      }
    }
  } catch {
    return false;
  }

  store?.saveSessionArchiveState?.({
    migrationVersion: SESSION_ARCHIVE_MIGRATION_VERSION
  });
  return true;
}
