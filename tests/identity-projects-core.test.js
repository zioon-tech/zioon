import { describe, expect, it } from "vitest";
import {
  PROJECT_FILE_TEMPLATE,
  PROJECT_INDEX_TEMPLATE,
  PROJECT_INBOX_TEMPLATE,
  buildProjectContext,
  buildProjectTemplate
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

  it("builds an escaped bounded project context", () => {
    const context = buildProjectContext(
      `# Index\n${"A < B & C ".repeat(20)}`,
      { maxChars: 80 }
    );

    expect(context.fragment).toContain(
      '<projects_index source="~/.zion-next/memory/projects/index.md">'
    );
    expect(context.fragment).toContain("&lt;");
    expect(context.fragment).toContain("&amp;");
    expect(context.fragment).toContain("[truncated]");
    expect(context.fragment).not.toContain("A < B");
    expect(context.instructions.join("\n")).toContain("model-maintained working memory");
    expect(context.instructions.join("\n")).toContain("read its project.md");
    expect(context.instructions.join("\n")).toContain("projects/index.md");
    expect(context.instructions.join("\n")).toContain("Do not infer autonomy grants");
  });

  it("clips by Unicode characters without splitting surrogate pairs", () => {
    const context = buildProjectContext(`项目${"😀".repeat(30)}`, { maxChars: 24 });
    const content = context.fragment.match(/<content>([\s\S]+)<\/content>/)?.[1] || "";

    expect(Array.from(content)).toHaveLength(24);
    expect(content).toContain("[truncated]");
    expect(content).not.toContain("\uFFFD");
  });

  it("returns no block or instructions for an empty index", () => {
    expect(buildProjectContext("")).toEqual({ fragment: "", instructions: [] });
    expect(buildProjectContext(" \n ")).toEqual({ fragment: "", instructions: [] });
  });
});
