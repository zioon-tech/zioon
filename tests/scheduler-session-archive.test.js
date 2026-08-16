import { beforeEach, describe, expect, it } from "vitest";
import {
  buildScheduledSessionContent,
  insertScheduledSessionTag,
  sessionTagForLocale,
  withSessionTag
} from "../extensions/dev.scheduler/session-archive.js";
import { LocalSchedulerStore } from "../extensions/dev.scheduler/store.js";

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
});
