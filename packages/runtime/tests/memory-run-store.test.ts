import { describe, expect, it } from "vitest";
import { MemoryRunStore, type RunRecord } from "../src/index";

function record(id: string, status: RunRecord["status"], updatedAt: number): RunRecord {
  return {
    id,
    attemptId: `attempt-${id}`,
    status,
    title: id,
    policy: {
      preset: "read-only",
      allowedTools: [],
      maxToolCalls: 10,
      fileRoots: [],
      allowedCommandPrefixes: [],
      allowedTerminalSessionIds: [],
      allowedRecipients: [],
      maxMailPerRun: 0
    },
    metadata: {},
    createdAt: updatedAt,
    updatedAt
  };
}

describe("MemoryRunStore", () => {
  it("lists bounded recent Runs by status", async () => {
    const store = new MemoryRunStore();
    await store.create(record("old", "failed", 1000));
    await store.create(record("completed", "completed", 3000));
    await store.create(record("failed", "failed", 4000));

    await expect(store.listRuns({
      since: 2000,
      statuses: ["failed", "completed"],
      limit: 1
    })).resolves.toEqual([
      expect.objectContaining({ id: "failed", status: "failed" })
    ]);
  });
});
