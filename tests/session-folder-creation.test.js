import { expect, it, vi } from "vitest";
import { createNamedFolder } from "../extensions/dev.session-manager/commands/folder-create.js";
it.each([null, "", "  "])("cancels folder creation without inserting a placeholder (%s)", async title => {
  const create = vi.fn();
  expect(await createNamedFolder({}, { readAccount: () => null, prompt: async () => title, create })).toBeNull();
  expect(create).not.toHaveBeenCalled();
});
it("abandons an outstanding name prompt after account switch", async () => {
  let account = { user: { id: "one" }, space: { id: "own" }, sessionId: "login" };
  const create = vi.fn();
  const result = await createNamedFolder({ parentId: "root" }, { readAccount: () => account,
    prompt: async () => { account = { ...account, user: { id: "two" } }; return "目录"; }, create });
  expect(result).toBeNull(); expect(create).not.toHaveBeenCalled();
});
it("uses an explicitly supplied name without prompting", async () => {
  const prompt = vi.fn(), create = vi.fn(async () => "folder");
  expect(await createNamedFolder({ parentId: "root", title: " 名称 " },
    { readAccount: () => null, prompt, create })).toEqual({ id: "folder", parentId: "root" });
  expect(prompt).not.toHaveBeenCalled(); expect(create).toHaveBeenCalledWith("root", "名称");
});
