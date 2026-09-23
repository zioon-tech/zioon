import { describe, expect, it } from "vitest";
import { expandSkillHomePath } from "../extensions/dev.skills/main.js";

describe("skills path resolution", () => {
  it("expands a local home-relative skill directory", () => {
    expect(expandSkillHomePath("~/skills", [{
      type: "local",
      cwd: "/Users/test/workspace"
    }])).toEqual({
      path: "/Users/test/skills",
      nodeId: "runtime:local",
      nodeLabel: "This Runtime"
    });
  });

  it("expands a home-relative path on an explicitly selected remote node", () => {
    expect(expandSkillHomePath("~/.config/skills", [{
      type: "ssh",
      nodeId: "remote-1",
      nodeLabel: "Build Host",
      home: "/home/dev"
    }], "remote-1")).toEqual({
      path: "/home/dev/.config/skills",
      nodeId: "remote-1",
      nodeLabel: "Build Host"
    });
  });

  it("does not guess when multiple homes are possible", () => {
    expect(expandSkillHomePath("~/skills", [{
      type: "local",
      cwd: "/Users/one/workspace"
    }, {
      type: "local",
      cwd: "/Users/two/workspace"
    }])).toBeNull();
  });
});
