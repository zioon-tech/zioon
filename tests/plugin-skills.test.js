import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectPluginSkillContributions,
  materializePluginSkills,
  normalizePluginSkillPath
} from "../extensions/dev.skills/plugin-skills.js";

function plugin(overrides = {}) {
  return {
    id: "dev.identity",
    path: "/extensions/dev.identity",
    enabled: true,
    manifest: {
      zion: {
        id: "dev.identity",
        contributes: {
          skills: ["./skills/biography-memory"]
        }
      }
    },
    ...overrides
  };
}

describe("plugin skill contributions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts only plugin-relative skill directories and namespaces ids", () => {
    expect(normalizePluginSkillPath("./skills/biography-memory")).toBe("skills/biography-memory");
    expect(normalizePluginSkillPath("../outside")).toBe("");
    expect(normalizePluginSkillPath("/absolute/path")).toBe("");

    const contributions = collectPluginSkillContributions([
      plugin(),
      plugin({
        id: "dev.remote",
        path: "https://plugins.example/dev.remote",
        manifest: {
          zion: {
            id: "dev.remote",
            contributes: { skills: ["skills/search"] }
          }
        }
      })
    ]);

    expect(contributions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "dev.identity/biography-memory",
        sourceFile: "/extensions/dev.identity/skills/biography-memory/SKILL.md"
      }),
      expect.objectContaining({
        id: "dev.remote/search",
        sourceFile: "https://plugins.example/dev.remote/skills/search/SKILL.md"
      })
    ]));
  });

  it("materializes enabled plugin skills and deletes stale files", async () => {
    const requests = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return new globalThis.Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));

    const bundledSources = {
      "/extensions/dev.identity/skills/biography-memory/SKILL.md": [
        "---",
        'name: "biography-memory"',
        'description: "Retrieve biography events when details are needed."',
        "---",
        "",
        "# Biography Memory"
      ].join("\n")
    };
    const first = await materializePluginSkills({
      base: "http://127.0.0.1:8765",
      root: "/Users/test/.zion-next/skills/.plugins",
      previous: [],
      plugins: [plugin()],
      bundledSources,
      bundledSkillFiles: {}
    });

    expect(first).toEqual([
      expect.objectContaining({
        id: "dev.identity/biography-memory",
        file: "/Users/test/.zion-next/skills/.plugins/dev.identity/biography-memory/SKILL.md"
      })
    ]);
    expect(requests[0].url).toBe("http://127.0.0.1:8765/files/write");
    expect(JSON.parse(requests[0].init.body)).toMatchObject({
      path: "/Users/test/.zion-next/skills/.plugins/dev.identity/biography-memory/SKILL.md"
    });

    const second = await materializePluginSkills({
      base: "http://127.0.0.1:8765",
      root: "/Users/test/.zion-next/skills/.plugins",
      previous: first,
      plugins: [],
      bundledSources,
      bundledSkillFiles: {}
    });
    expect(second).toEqual([]);
    expect(requests[1].url).toBe("http://127.0.0.1:8765/files/delete");
  });

  it("materializes skill content extracted from an installed ZIP", async () => {
    const requests = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return new globalThis.Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));
    const zipPlugin = plugin({
      path: "https://plugins.example/dev.identity.zip",
      skillContents: {
        "skills/biography-memory": "---\nname: biography-memory\ndescription: ZIP skill\n---\n"
      },
      skillFiles: {
        "skills/biography-memory": {
          "SKILL.md": "---\nname: biography-memory\ndescription: ZIP skill\n---\n",
          "scripts/query-biography.py": "print('ok')\n"
        }
      }
    });

    const materialized = await materializePluginSkills({
      base: "http://127.0.0.1:8765",
      root: "/Users/test/.zion-next/skills/.plugins",
      plugins: [zipPlugin],
      bundledSources: {}
    });

    expect(materialized).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe("http://127.0.0.1:8765/files/write");
    expect(JSON.parse(requests[0].init.body).path).toBe("/Users/test/.zion-next/skills/.plugins/dev.identity/biography-memory/SKILL.md");
    expect(JSON.parse(requests[0].init.body).content).toContain("ZIP skill");
    expect(JSON.parse(requests[1].init.body).path).toBe("/Users/test/.zion-next/skills/.plugins/dev.identity/biography-memory/scripts/query-biography.py");
  });
});
