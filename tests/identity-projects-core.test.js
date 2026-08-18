import { describe, expect, it } from "vitest";
import {
  PROJECT_FILE_TEMPLATE,
  PROJECT_INDEX_TEMPLATE,
  PROJECT_INBOX_TEMPLATE,
  buildProjectContext,
  buildProjectTemplate,
  parseProjectIndex,
  resolveProjectIndexRows
} from "../extensions/dev.identity/projects-core.js";

describe("identity project memory core", () => {
  it("provides stable scaffold templates", () => {
    expect(PROJECT_INDEX_TEMPLATE).toContain("# 项目索引");
    expect(PROJECT_INDEX_TEMPLATE).toContain("| 项目 | 状态 | 优先级 | 下一步 | 更新 |");
    expect(PROJECT_INBOX_TEMPLATE).toContain("# 杂思收集箱");
    expect(PROJECT_INBOX_TEMPLATE).toContain("再次出现时提议立项");

    const template = buildProjectTemplate({
      project: "示例项目",
      date: "2026-08-18"
    });
    expect(template).toContain('project: "示例项目"');
    expect(template).toContain("status: active");
    expect(template).toContain("autonomy: none");
    expect(template).toContain("created: 2026-08-18");
    expect(template).toContain("updated: 2026-08-18");
    expect(template).toContain("# 示例项目");
    expect(template).toContain("## 目标");
    expect(template).toContain("## 当前状态");
    expect(template).toContain("## 计划");
    expect(template).toContain("## 时间线");
    expect(template).toContain("## 产物与资源");
    expect(template).toContain("## 使用姿势");
    expect(template).toContain("## 经验教训");
    expect(template).toContain("## 关联");
    expect(PROJECT_FILE_TEMPLATE).toBe(buildProjectTemplate());
  });

  it("normalizes template identity fields to single safe lines", () => {
    const template = buildProjectTemplate({
      project: "  Alpha:\nBeta  ",
      date: "not-a-date"
    });
    expect(template).toContain('project: "Alpha: Beta"');
    expect(template).toContain("# Alpha: Beta");
    expect(template).toContain("created: ");
    expect(template).toContain("updated: ");
    expect(template).not.toContain("created: not-a-date");
  });

  it("builds escaped bounded project index and inbox context", () => {
    const context = buildProjectContext(
      `# Index\n${"A < B & C ".repeat(20)}`,
      {
        inbox: `# Inbox\n${"Idea < draft & review ".repeat(20)}`,
        maxChars: 80,
        inboxMaxChars: 70
      }
    );

    expect(context.fragment).toContain(
      '<projects_index source="~/.zion-next/memory/projects/index.md">'
    );
    expect(context.fragment).toContain(
      '<projects_inbox source="~/.zion-next/memory/projects/inbox.md">'
    );
    expect(context.fragment).toContain("&lt;");
    expect(context.fragment).toContain("&amp;");
    expect(context.fragment).toContain("[truncated]");
    expect(context.fragment).not.toContain("A < B");
    expect(context.instructions.join("\n")).toContain("model-maintained working memory");
    expect(context.instructions.join("\n")).toContain("read its project.md");
    expect(context.instructions.join("\n")).toContain("projects/index.md");
    expect(context.instructions.join("\n")).toContain("create projects/{canonical-slug}/project.md");
    expect(context.instructions.join("\n")).toContain("remove its inbox entry");
    expect(context.instructions.join("\n")).toContain("Do not infer autonomy grants");
  });

  it("clips by Unicode characters without splitting surrogate pairs", () => {
    const context = buildProjectContext(`项目${"😀".repeat(30)}`, { maxChars: 24 });
    const content = context.fragment.match(/<content>([\s\S]+)<\/content>/)?.[1] || "";

    expect(Array.from(content)).toHaveLength(24);
    expect(content).toContain("[truncated]");
    expect(content).not.toContain("\uFFFD");
  });

  it("keeps project maintenance instructions when project files are empty", () => {
    const context = buildProjectContext("", { inbox: "" });

    expect(context.fragment).toBe("");
    expect(context.instructions.join("\n")).toContain("model-maintained working memory");
    expect(context.instructions.join("\n")).toContain("create projects/{canonical-slug}/project.md");
  });

  it("parses linked and legacy project rows", () => {
    const rows = parseProjectIndex(`| 项目 | 状态 | 优先级 | 下一步 | 更新 |
|---|---|---|---|---|
| [Zion Next](./zion-next/project.md) | active | high | Ship \\| verify | 2026-08-19 |
| Legacy | waiting | medium | 等待反馈 | 2026-08-18 |`);

    expect(rows).toEqual([
      {
        name: "Zion Next",
        status: "active",
        priority: "high",
        nextStep: "Ship | verify",
        updated: "2026-08-19",
        relativePath: "zion-next/project.md"
      },
      {
        name: "Legacy",
        status: "waiting",
        priority: "medium",
        nextStep: "等待反馈",
        updated: "2026-08-18",
        relativePath: ""
      }
    ]);
  });

  it("rejects unsafe project links", () => {
    const rows = parseProjectIndex(`| 项目 | 状态 | 优先级 | 下一步 | 更新 |
|---|---|---|---|---|
| [Parent](../secret/project.md) | active | | | |
| [Absolute](/tmp/project.md) | active | | | |
| [Wrong](./safe/readme.md) | active | | | |
| [Safe](./safe/project.md) | active | | | |`);

    expect(rows.map((row) => row.relativePath)).toEqual([
      "",
      "",
      "",
      "safe/project.md"
    ]);
  });

  it("resolves one unambiguous legacy directory", () => {
    const rows = [
      {
        name: "Legacy Project",
        status: "active",
        priority: "",
        nextStep: "",
        updated: "",
        relativePath: ""
      },
      {
        name: "Duplicate Project",
        status: "waiting",
        priority: "",
        nextStep: "",
        updated: "",
        relativePath: ""
      }
    ];
    const resolved = resolveProjectIndexRows(rows, [
      { path: "/memory/projects/legacy-project", type: "dir" },
      { path: "/memory/projects/duplicate_project", type: "dir" },
      { path: "/memory/projects/duplicate-project", type: "dir" },
      { path: "/memory/projects/index.md", type: "file" }
    ], "/memory/projects");

    expect(resolved[0].path).toBe("/memory/projects/legacy-project/project.md");
    expect(resolved[1].path).toBe("");
  });

  it("caps parsed indexes at 200 rows", () => {
    const rows = Array.from({ length: 220 }, (_, index) => (
      `| Project ${index} | active | medium | Next ${index} | 2026-08-19 |`
    )).join("\n");

    expect(parseProjectIndex(rows)).toHaveLength(200);
  });
});
