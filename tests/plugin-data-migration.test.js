// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migratePluginData } from "../scripts/migrate-plugin-data.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "zion-data-migrate-"));
  roots.push(root);
  const source = join(root, "old");
  await mkdir(join(source, "projects/example"), { recursive: true });
  await writeFile(join(source, "user.md"), "user");
  await writeFile(join(source, "projects/example/project.md"), "project");
  return { source, dataRoot: join(root, "plugins"), pluginId: "dev.identity" };
}
describe("plugin data migration", () => {
  it("previews, verifies and copies the full tree without deleting the source", async () => {
    const options = await setup();
    const preview = await migratePluginData(options);
    expect(preview).toMatchObject({ status: "dry-run", files: 2 });
    await expect(readFile(join(preview.destination, "user.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const result = await migratePluginData({ ...options, apply: true });
    expect(result.status).toBe("migrated");
    expect(await readFile(join(result.destination, "projects/example/project.md"), "utf8")).toBe("project");
    expect(await readFile(join(options.source, "user.md"), "utf8")).toBe("user");
    expect((await migratePluginData({ ...options, apply: true })).status).toBe("already-migrated");
  });
  it("ignores macOS AppleDouble and Finder metadata files", async () => {
    const options = await setup();
    await writeFile(join(options.source, "._user.md"), "appledouble");
    await writeFile(join(options.source, ".DS_Store"), "finder");
    await writeFile(join(options.source, "projects/example/._project.md"), "appledouble");
    await mkdir(join(options.source, "__MACOSX"), { recursive: true });
    await writeFile(join(options.source, "__MACOSX/._user.md"), "archive metadata");
    const preview = await migratePluginData(options);
    expect(preview.files).toBe(2);
    const result = await migratePluginData({ ...options, apply: true });
    await expect(readFile(join(result.destination, "._user.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(result.destination, ".DS_Store"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(result.destination, "projects/example/._project.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses to overwrite new data on retry", async () => {
    const options = await setup();
    const result = await migratePluginData({ ...options, apply: true });
    await writeFile(join(result.destination, "user.md"), "new");
    await expect(migratePluginData({ ...options, apply: true })).rejects.toThrow("will not merge or overwrite");
    expect(await readFile(join(result.destination, "user.md"), "utf8")).toBe("new");
  });
  it("rejects symlinks, active locks and nested destinations", async () => {
    const options = await setup();
    await symlink(join(options.source, "user.md"), join(options.source, "link"));
    await expect(migratePluginData(options)).rejects.toThrow("symlinks");
    await rm(join(options.source, "link"));
    await mkdir(join(options.source, "user.md.zion-lock"));
    await expect(migratePluginData(options)).rejects.toThrow("stop writers");
    await expect(migratePluginData({ ...options, dataRoot: options.source })).rejects.toThrow("separate directories");
  });
});
