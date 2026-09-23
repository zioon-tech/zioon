import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  syncRuntimePluginSkillsCatalog
} from "../src/plugin-skills-catalog.mjs";
import {
  SKILLS_RUNTIME_KV_KEY,
  SKILLS_RUNTIME_PLUGIN_NODE_ID
} from "../../../extensions/dev.skills/skills-runtime-shared.js";

const directories = [];

function memoryStore() {
  const values = new Map();
  return {
    values,
    readKV(key) {
      return values.has(key) ? { key, value: values.get(key) } : null;
    },
    writeKV(key, value) {
      values.set(key, value);
      return { ok: true, key };
    }
  };
}

async function fixturePlugin() {
  const root = await mkdtemp(join(tmpdir(), "zion-plugin-skills-"));
  directories.push(root);
  const pluginDir = join(root, "dev.observability");
  const skillDir = join(pluginDir, "skills", "run-diagnostics");
  await mkdir(join(skillDir, "scripts"), { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), [
    "---",
    "name: \"run-diagnostics\"",
    "description: \"Diagnose Runs from the observability JSONL projection.\"",
    "---",
    "",
    "# Run Diagnostics"
  ].join("\n"));
  await writeFile(join(skillDir, "scripts", "obs.mjs"), "console.log('ok');\n");
  return {
    id: "dev.observability",
    directory: pluginDir,
    manifest: {
      zion: {
        id: "dev.observability",
        contributes: {
          skills: ["./skills/run-diagnostics"]
        }
      }
    }
  };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Runtime plugin Skill catalog sync", () => {
  it("adds enabled plugin-contributed Skills without a frontend scan", async () => {
    const store = memoryStore();
    const plugin = await fixturePlugin();

    const snapshot = await syncRuntimePluginSkillsCatalog({
      store,
      plugins: [plugin],
      now: 1234
    });

    expect(snapshot.enabled).toEqual(["dev.observability/run-diagnostics"]);
    expect(snapshot.catalog).toEqual([
      expect.objectContaining({
        id: "dev.observability/run-diagnostics",
        name: "run-diagnostics",
        description: "Diagnose Runs from the observability JSONL projection.",
        pluginId: "dev.observability",
        source: "plugin",
        sourceNodeId: SKILLS_RUNTIME_PLUGIN_NODE_ID,
        runtimeCached: true,
        body: expect.stringContaining("# Run Diagnostics")
      })
    ]);
    expect(snapshot.sources).toEqual([
      expect.objectContaining({
        nodeId: SKILLS_RUNTIME_PLUGIN_NODE_ID,
        catalog: [
          expect.objectContaining({
            id: "dev.observability/run-diagnostics"
          })
        ]
      })
    ]);
    expect(store.values.get(SKILLS_RUNTIME_KV_KEY).catalog).toHaveLength(1);
  });

  it("removes stale plugin Skills when the plugin no longer contributes them", async () => {
    const store = memoryStore();
    const plugin = await fixturePlugin();
    await syncRuntimePluginSkillsCatalog({ store, plugins: [plugin], now: 1234 });

    const snapshot = await syncRuntimePluginSkillsCatalog({
      store,
      plugins: [],
      now: 2345
    });

    expect(snapshot.catalog).toEqual([]);
    expect(snapshot.enabled).toEqual([]);
  });
});
