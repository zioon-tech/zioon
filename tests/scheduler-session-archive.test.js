import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveDateForTimestamp,
  buildScheduledSessionContent,
  ensureScheduledSessionDateFolder,
  ensureScheduledSessionFolder,
  insertScheduledSessionTag,
  migrateScheduledSessions,
  rewriteScheduledSessionTag,
  scheduledSessionTagForDate,
  sessionTagForLocale,
  withSessionTag
} from "../extensions/dev.scheduler/session-archive.js";
import { LocalSchedulerStore } from "../extensions/dev.scheduler/store.js";

function createArchiveFixture({
  tree,
  catalog = [],
  metas = {},
  docs = {},
  createFolderId = "folder-created",
  createFolderIds = [],
  moveResult = true
} = {}) {
  const moveCalls = [];
  const createCalls = [];
  let createIndex = 0;
  let currentMoveResult = moveResult;
  const findNode = (node, id) => {
    if (!node) return null;
    if (node.id === id) return node;
    for (const child of node.children || []) {
      const found = findNode(child, id);
      if (found) return found;
    }
    return null;
  };
  const executeCommand = vi.fn(async (name, payload) => {
    if (name === "zion.sessions.getTreeSnapshot") return structuredClone(tree);
    if (name === "zion.sessions.createFolder") {
      createCalls.push(payload);
      const folderId = createFolderIds[createIndex] || (createIndex === 0 ? createFolderId : `folder-created-${createIndex}`);
      createIndex += 1;
      const parent = findNode(tree, payload.parentId);
      if (parent?.type === "folder" && folderId) {
        parent.children = parent.children || [];
        parent.children.unshift({
          id: folderId,
          type: "folder",
          title: payload.title,
          children: []
        });
      }
      return folderId;
    }
    if (name === "zion.sessions.getMeta") return metas[payload] || null;
    if (name === "zion.sessions.transformDoc") {
      if (!Object.prototype.hasOwnProperty.call(docs, payload.id)) return false;
      docs[payload.id] = payload.transform(docs[payload.id]);
      return true;
    }
    if (name === "zion.sessions.moveNode") {
      moveCalls.push(payload);
      return currentMoveResult;
    }
    return undefined;
  });
  const zion = {
    commands: { executeCommand },
    state: { get: (key) => key === "sessions.catalog" ? catalog : undefined }
  };
  return {
    zion,
    docs,
    moveCalls,
    createCalls,
    executeCommand,
    setMoveResult(value) {
      currentMoveResult = value;
    }
  };
}

describe("scheduled session archive helpers", () => {
  beforeEach(() => localStorage.clear());

  it("fixes a task tag from its creation locale", () => {
    expect(sessionTagForLocale("zh-CN")).toBe("定时任务");
    expect(sessionTagForLocale("en-US")).toBe("scheduled_tasks");
    expect(sessionTagForLocale("fr-FR")).toBe("scheduled_tasks");
    expect(withSessionTag({ id: "task-1" }, "zh-CN")).toMatchObject({
      id: "task-1",
      sessionTag: "定时任务"
    });
    expect(withSessionTag({
      id: "task-1",
      sessionTag: "scheduled_tasks"
    }, "zh-CN").sessionTag).toBe("scheduled_tasks");
  });

  it("builds tagged session content without changing the execution prompt", () => {
    expect(buildScheduledSessionContent("Summarize", "scheduled_tasks")).toBe(
      "user Summarize\n\n#scheduled_tasks\nassistant "
    );
  });

  it("inserts an exact inline tag before the first assistant block once", () => {
    const source = "user Prompt\nassistant Reply\nuser ";
    const once = insertScheduledSessionTag(source, "定时任务");

    expect(once).toBe("user Prompt\n\n#定时任务\nassistant Reply\nuser ");
    expect(insertScheduledSessionTag(once, "定时任务")).toBe(once);
  });

  it("does not mistake inline code or descendant tags for the exact tag", () => {
    expect(insertScheduledSessionTag(
      "user `#定时任务` #定时任务/日报\nassistant Reply",
      "定时任务"
    )).toBe(
      "user `#定时任务` #定时任务/日报\n\n#定时任务\nassistant Reply"
    );
  });

  it("resolves the archive date in the task time zone", () => {
    const timestamp = Date.UTC(2026, 7, 16, 0, 30);

    expect(archiveDateForTimestamp(timestamp, "Asia/Shanghai")).toMatchObject({
      year: "2026",
      month: "08",
      day: "16",
      key: "2026/08/16",
      segments: ["2026", "08", "16"]
    });
    expect(archiveDateForTimestamp(timestamp, "America/Los_Angeles").key).toBe("2026/08/15");
    expect(archiveDateForTimestamp(timestamp, "Invalid/Zone", "UTC").key).toBe("2026/08/16");
  });

  it("rewrites only generated scheduled tags to the dated path", () => {
    const archiveDate = {
      year: "2026",
      month: "08",
      day: "16",
      key: "2026/08/16",
      segments: ["2026", "08", "16"]
    };

    expect(scheduledSessionTagForDate("定时任务", archiveDate)).toBe("定时任务/2026/08/16");
    expect(rewriteScheduledSessionTag(
      "user Prompt\n\n#定时任务\nassistant Done",
      "定时任务",
      archiveDate
    )).toContain("#定时任务/2026/08/16");
    expect(rewriteScheduledSessionTag(
      "user #定时任务/2026/08/15 #定时任务/日报\nassistant Done",
      "定时任务",
      archiveDate
    )).toContain("#定时任务/2026/08/16 #定时任务/日报");
    const rewritten = rewriteScheduledSessionTag(
      "user Prompt\nassistant Done",
      "定时任务",
      archiveDate
    );
    expect(rewriteScheduledSessionTag(rewritten, "定时任务", archiveDate)).toBe(rewritten);
  });

  it("persists Scheduler-owned archive state", () => {
    const store = new LocalSchedulerStore();
    expect(store.getSessionArchiveState()).toEqual({
      folderId: null,
      folderLocale: "",
      migrationVersion: 0
    });

    store.saveSessionArchiveState({
      folderId: "folder-1",
      folderLocale: "zh-CN",
      migrationVersion: 1
    });

    expect(new LocalSchedulerStore().getSessionArchiveState()).toEqual({
      folderId: "folder-1",
      folderLocale: "zh-CN",
      migrationVersion: 1
    });
  });

  it("adopts a matching root folder and later resolves it by stable id", async () => {
    const tree = {
      id: "root",
      type: "folder",
      children: [{
        id: "folder-existing",
        type: "folder",
        title: "定时任务",
        children: []
      }, {
        id: "folder-parent",
        type: "folder",
        title: "Archive",
        children: [{
          id: "folder-moved",
          type: "folder",
          title: "Renamed",
          children: []
        }]
      }]
    };
    const fixture = createArchiveFixture({ tree });
    const store = new LocalSchedulerStore();

    await expect(ensureScheduledSessionFolder({
      zion: fixture.zion,
      store,
      locale: "zh-CN"
    })).resolves.toBe("folder-existing");
    expect(fixture.createCalls).toEqual([]);

    store.saveSessionArchiveState({ folderId: "folder-moved" });
    await expect(ensureScheduledSessionFolder({
      zion: fixture.zion,
      store,
      locale: "en-US"
    })).resolves.toBe("folder-moved");
    expect(fixture.createCalls).toEqual([]);
  });

  it("creates a replacement when a stored archive folder was deleted", async () => {
    const fixture = createArchiveFixture({
      tree: {
        id: "root",
        type: "folder",
        children: [{
          id: "folder-same-title",
          type: "folder",
          title: "定时任务",
          children: []
        }]
      },
      createFolderId: "folder-replacement"
    });
    const store = new LocalSchedulerStore();
    store.saveSessionArchiveState({ folderId: "folder-deleted", folderLocale: "zh-CN" });

    await expect(ensureScheduledSessionFolder({
      zion: fixture.zion,
      store,
      locale: "zh-CN"
    })).resolves.toBe("folder-replacement");
    expect(fixture.createCalls).toEqual([{ parentId: "root", title: "定时任务" }]);
    expect(store.getSessionArchiveState().folderId).toBe("folder-replacement");
  });

  it("creates and reuses the YYYY/MM/DD folder path", async () => {
    const tree = {
      id: "root",
      type: "folder",
      children: [{
        id: "folder-root",
        type: "folder",
        title: "定时任务",
        children: []
      }]
    };
    const fixture = createArchiveFixture({
      tree,
      createFolderIds: ["folder-2026", "folder-08", "folder-16"]
    });
    const store = new LocalSchedulerStore();
    store.saveSessionArchiveState({ folderId: "folder-root", folderLocale: "zh-CN" });
    const archiveDate = archiveDateForTimestamp(Date.UTC(2026, 7, 16), "UTC");

    await expect(ensureScheduledSessionDateFolder({
      zion: fixture.zion,
      store,
      locale: "zh-CN",
      archiveDate
    })).resolves.toBe("folder-16");
    expect(fixture.createCalls).toEqual([
      { parentId: "folder-root", title: "2026" },
      { parentId: "folder-2026", title: "08" },
      { parentId: "folder-08", title: "16" }
    ]);

    await expect(ensureScheduledSessionDateFolder({
      zion: fixture.zion,
      store,
      locale: "zh-CN",
      archiveDate
    })).resolves.toBe("folder-16");
    expect(fixture.createCalls).toHaveLength(3);
  });

  it("migrates scheduled sessions with task tags and an orphan fallback", async () => {
    const tree = {
      id: "root",
      type: "folder",
      children: [{
        id: "folder-root",
        type: "folder",
        title: "定时任务",
        children: [
          { id: "scheduled-1", type: "session", title: "English task" },
          { id: "scheduled-orphan", type: "session", title: "Orphan task" }
        ]
      }, {
        id: "folder-manual",
        type: "folder",
        title: "Manual",
        children: [{ id: "scheduled-outside", type: "session", title: "Moved task" }]
      }]
    };
    const docs = {
      "scheduled-1": "user English task\n\n#scheduled_tasks\nassistant Done\nuser ",
      "scheduled-orphan": "user Orphan task\nassistant Done\nuser ",
      "scheduled-outside": "user Moved task\n\n#定时任务\nassistant Done\nuser ",
      "normal-1": "user Normal\nassistant Done\nuser "
    };
    const fixture = createArchiveFixture({
      tree,
      catalog: [
        { id: "scheduled-1" },
        { id: "scheduled-orphan" },
        { id: "scheduled-outside" },
        { id: "normal-1" }
      ],
      metas: {
        "scheduled-1": {
          source: "scheduled-task",
          scheduledTaskId: "task-1",
          createdAt: Date.UTC(2026, 7, 16, 0, 30)
        },
        "scheduled-orphan": {
          source: "scheduled-task",
          scheduledTaskId: "missing",
          createdAt: Date.UTC(2026, 7, 16, 1, 30)
        },
        "scheduled-outside": {
          source: "scheduled-task",
          scheduledTaskId: "missing",
          createdAt: Date.UTC(2026, 7, 16, 2, 30)
        },
        "normal-1": { source: "chat" }
      },
      docs,
      createFolderIds: ["folder-2026", "folder-08", "folder-16"]
    });
    const store = new LocalSchedulerStore();
    store.saveSessionArchiveState({
      folderId: "folder-root",
      folderLocale: "zh-CN",
      migrationVersion: 1
    });
    store.saveTask({
      id: "task-1",
      taskType: "agent",
      title: "English task",
      sessionTag: "scheduled_tasks",
      schedule: { timeZone: "UTC" },
      createdAt: 1
    });

    await expect(migrateScheduledSessions({
      zion: fixture.zion,
      store,
      locale: "zh-CN"
    })).resolves.toBe(true);

    expect(docs["scheduled-1"]).toContain("\n#scheduled_tasks/2026/08/16\nassistant");
    expect(docs["scheduled-orphan"]).toContain("\n#定时任务/2026/08/16\nassistant");
    expect(docs["scheduled-outside"]).toContain("\n#定时任务/2026/08/16\nassistant");
    expect(docs["normal-1"]).not.toContain("#");
    expect(fixture.moveCalls).toEqual([
      { id: "scheduled-1", targetFolderId: "folder-16" },
      { id: "scheduled-orphan", targetFolderId: "folder-16" }
    ]);
    expect(store.getSessionArchiveState().migrationVersion).toBe(3);
  });

  it("retries an interrupted migration without duplicating tags", async () => {
    const docs = { "scheduled-1": "user Prompt\nassistant Done\nuser " };
    const fixture = createArchiveFixture({
      tree: {
        id: "root",
        type: "folder",
        children: [{
          id: "folder-root",
          type: "folder",
          title: "定时任务",
          children: [{ id: "scheduled-1", type: "session", title: "Task" }]
        }]
      },
      catalog: [{ id: "scheduled-1" }],
      metas: {
        "scheduled-1": {
          source: "scheduled-task",
          scheduledTaskId: "task-1",
          createdAt: Date.UTC(2026, 7, 16)
        }
      },
      docs,
      createFolderIds: ["folder-2026", "folder-08", "folder-16"],
      moveResult: false
    });
    const store = new LocalSchedulerStore();
    store.saveSessionArchiveState({
      folderId: "folder-root",
      folderLocale: "zh-CN",
      migrationVersion: 1
    });
    store.saveTask({ id: "task-1", taskType: "agent", title: "Task", createdAt: 1 });

    await expect(migrateScheduledSessions({
      zion: fixture.zion,
      store,
      locale: "zh-CN"
    })).resolves.toBe(false);
    expect(store.getSessionArchiveState().migrationVersion).toBe(1);
    expect(docs["scheduled-1"].match(/#定时任务\/2026\/08\/16/g)).toHaveLength(1);

    fixture.setMoveResult(true);
    await expect(migrateScheduledSessions({
      zion: fixture.zion,
      store,
      locale: "en-US"
    })).resolves.toBe(true);
    expect(docs["scheduled-1"].match(/#定时任务\/2026\/08\/16/g)).toHaveLength(1);
    expect(store.getTask("task-1").sessionTag).toBe("定时任务");
    expect(store.getSessionArchiveState().migrationVersion).toBe(3);
  });

  it("waits for the Session Manager catalog before completing migration", async () => {
    const fixture = createArchiveFixture({
      tree: {
        id: "root",
        type: "folder",
        children: [{ id: "existing-session", type: "session", title: "Existing" }]
      },
      catalog: []
    });
    const store = new LocalSchedulerStore();
    store.saveSessionArchiveState({ migrationVersion: 2 });

    await expect(migrateScheduledSessions({
      zion: fixture.zion,
      store,
      locale: "zh-CN"
    })).resolves.toBe(false);
    expect(store.getSessionArchiveState().migrationVersion).toBe(2);
    expect(fixture.executeCommand).not.toHaveBeenCalled();
  });

  it("does not scan sessions after migration has completed", async () => {
    const fixture = createArchiveFixture({
      tree: { id: "root", type: "folder", children: [] }
    });
    const store = new LocalSchedulerStore();
    store.saveSessionArchiveState({ migrationVersion: 3 });

    await expect(migrateScheduledSessions({
      zion: fixture.zion,
      store,
      locale: "zh-CN"
    })).resolves.toBe(true);
    expect(fixture.executeCommand).not.toHaveBeenCalled();
  });
});
