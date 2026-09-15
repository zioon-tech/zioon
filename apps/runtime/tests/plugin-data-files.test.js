import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  contentHash, createPluginDataFileHost, withDataFileLock
} from "../../../packages/local-tools-client/src/plugin-data-files.mjs";

const roots = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "zion-plugin-files-"));
  roots.push(root);
  return { root, host: createPluginDataFileHost({ root }), path: join(root, "dev.identity/user.md") };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("plugin data file host", () => {
  it("writes real files, supports Bash-style external edits and conditional updates", async () => {
    const { host, path } = await setup();
    await host.handle("write", { path, content: "original" });
    const before = await host.handle("read", { path });
    await writeFile(path, "external");
    await expect(host.handle("write", {
      path, content: "stale", expected_hash: before.content_hash
    })).rejects.toThrow("changed since last read");
    await host.handle("edit", { path, old_string: "external", new_string: "edited" });
    expect(await readFile(path, "utf8")).toBe("edited");
    expect((await host.handle("read", { path })).content_hash).toBe(contentHash("edited"));
  });

  it("serializes concurrent appends, retries identical records, rejects conflicting ids", async () => {
    const { host, path } = await setup();
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      host.handle("append-jsonl", { path, records: [{ id: String(index), summary: `event ${index}` }] })
    ));
    const records = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
    expect(new Set(records.map((record) => record.id)).size).toBe(12);
    await expect(host.handle("append-jsonl", {
      path, records: [{ summary: "event 0", id: "0" }]
    })).resolves.toMatchObject({ appended: [], skipped: ["0"] });
    await expect(host.handle("append-jsonl", {
      path, records: [{ id: "0", summary: "different" }]
    })).rejects.toThrow("Conflicting JSONL id");
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(12);
  });

  it("does not overwrite existing empty profiles during initialization", async () => {
    const { host, path } = await setup();
    await host.handle("write", { path, content: "" });
    await expect(host.handle("write", { path, content: "template", create_only: true }))
      .resolves.toMatchObject({ created: false });
    expect(await readFile(path, "utf8")).toBe("");
  });

  it("rejects malformed history without changing it", async () => {
    const { host, path } = await setup();
    await host.handle("write", { path, content: "broken" });
    await expect(host.handle("append-jsonl", { path, records: [{ id: "1" }] })).rejects.toThrow("Invalid JSONL");
    expect(await readFile(path, "utf8")).toBe("broken");
  });

  it("rejects symlinks and reserved locks, leaves unrelated or terminal paths untouched", async () => {
    const { host, path, root } = await setup();
    await mkdir(join(root, "dev.identity"));
    await writeFile(join(root, "secret"), "secret");
    await symlink(join(root, "secret"), path);
    await expect(host.handle("read", { path })).rejects.toThrow("symlinks");
    await expect(host.handle("write", { path: `${path}.zion-lock`, content: "x" })).rejects.toThrow("reserved");
    expect(await host.handle("read", { path: "/not-plugin-data/file" })).toBeNull();
    await expect(host.handle("read", { path, session_id: "ssh" })).rejects.toThrow("omit session_id");
  });

  it("paginates JSONL with explicit completeness and releases locks after errors", async () => {
    const { host, path } = await setup();
    await host.handle("append-jsonl", { path, records: [{ id: "1" }, { id: "2" }, { id: "3" }] });
    expect(await host.handle("read-jsonl", { path, tail: 2, limit: 2 })).toMatchObject({
      start_line: 2, end_line: 3, has_previous: true, has_more: false
    });
    await expect(withDataFileLock(path, async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    await expect(host.handle("write", { path, content: "after" })).resolves.toMatchObject({ ok: true });
  });

  it("treats replacement text literally and never writes after cancellation", async () => {
    const { host, path } = await setup();
    await host.handle("write", { path, content: "old" });
    await host.handle("edit", { path, old_string: "old", new_string: "$& new" });
    expect(await readFile(path, "utf8")).toBe("$& new");
    const signal = { throwIfCancelled() { throw new Error("cancelled"); } };
    await expect(host.handle("write", { path, content: "cancelled" }, { signal })).rejects.toThrow("cancelled");
    expect(await readFile(path, "utf8")).toBe("$& new");
  });
});
