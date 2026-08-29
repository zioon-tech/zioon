import { describe, expect, it } from "vitest";
import {
  isKnownFileToolFailure,
  mergeContextFileResources,
  normalizeContextResourcePath
} from "../extensions/dev.tools/context-file-resources.js";
import {
  buildBiographyContextSummary,
  buildFileTreeModel,
  normalizeContextBiographyEvents
} from "../extensions/dev.tools/context-panel.js";
import {
  createTerminalToolExecutionContext,
  getTerminalSessionRequirementError
} from "../extensions/dev.tools/terminal-tool-context.js";

const terminalSessions = [
  { id: "local-1", type: "local", cwd: "/Users/bytedance" },
  { id: "local-2", type: "local", cwd: "/Users/bytedance/Downloads/zion-next" }
];

function flatten(nodes, out = []) {
  for (const node of nodes || []) {
    out.push(node);
    flatten(node.children, out);
  }
  return out;
}

describe("context file resources", () => {
  it("resolves relative paths against the execution terminal cwd", () => {
    expect(normalizeContextResourcePath(".zion-next/skills/../skills/fenjue/SKILL.md", {
      sourceId: "terminal:local-1",
      terminalSessions
    })).toMatchObject({
      canonicalPath: "/Users/bytedance/.zion-next/skills/fenjue/SKILL.md",
      resolved: true
    });
  });

  it("renders one logical local tree for duplicate Local and Terminal observations", () => {
    const paths = [
      "/Users/bytedance/.zion-next/skills/fenjue/SKILL.md",
      "/Users/bytedance/.zion-next/skills-external/superpowers/skills/brainstorming/SKILL.md",
      "/Users/bytedance/Downloads/zion-next/.worktrees/memory-panel/docs/architecture/HARNESS-MEMORY-SYSTEM-DESIGN.md"
    ];
    const resources = mergeContextFileResources(paths.flatMap((path, index) => [
      { kind: "file", path, sourceId: "local", source: "link" },
      { kind: "file", path, sourceId: `terminal:local-${index % 2 + 1}`, source: "read" }
    ]), { terminalSessions });

    expect(resources).toHaveLength(paths.length);
    expect(resources.every((item) => item.deviceKey === "local")).toBe(true);
    expect(resources.every((item) => item.sourceIds.includes("local"))).toBe(true);

    const model = buildFileTreeModel(resources);
    const nodes = flatten(model.roots);
    expect(model.roots.some((node) => node.key.startsWith("device:"))).toBe(false);
    expect(nodes.filter((node) => node.fullPath === "/Users/bytedance/.zion-next")).toHaveLength(1);
    expect(nodes.filter((node) => node.fullPath === "/Users/bytedance/Downloads")).toHaveLength(1);
  });

  it("keeps an SSH path separate from the same local path", () => {
    const resources = mergeContextFileResources([
      { kind: "file", path: "/workspace/config.json", sourceId: "local" },
      { kind: "file", path: "/workspace/config.json", sourceId: "terminal:ssh-1" }
    ], {
      terminalSessions: [
        { id: "ssh-1", type: "ssh", ssh_user: "dev", ssh_host: "example.com", ssh_port: 22, cwd: "/workspace" }
      ]
    });

    expect(resources).toHaveLength(2);
    expect(resources.map((item) => item.deviceKey).sort()).toEqual([
      "local",
      "ssh:dev@example.com:22"
    ]);
  });

  it("uses the execution-time cwd after the live terminal changes directory", () => {
    const resources = mergeContextFileResources([{
      kind: "file",
      path: "src/index.js",
      sourceId: "terminal:local-1",
      executionContext: {
        sourceId: "terminal:local-1",
        terminalSession: { id: "local-1", type: "local", cwd: "/old/workspace" }
      }
    }], {
      terminalSessions: [{ id: "local-1", type: "local", cwd: "/new/workspace" }]
    });

    expect(resources[0].path).toBe("/old/workspace/src/index.js");
  });

  it("filters failed file operations before they enter Context", () => {
    expect(isKnownFileToolFailure("HTTP 404: file not found")).toBe(true);
    expect(isKnownFileToolFailure("Read error: ENOENT: no such file")).toBe(true);
    expect(isKnownFileToolFailure({ ok: false, error: "permission denied" })).toBe(true);
    expect(isKnownFileToolFailure("// File: /tmp/errors.txt (1-1)\n     1 | ENOENT is documented here")).toBe(false);
  });

  it("requires an explicit terminal session before creating execution context", () => {
    expect(getTerminalSessionRequirementError("read", { path: "README.md" }, terminalSessions)).toContain("Missing session_id");
    expect(getTerminalSessionRequirementError("read", {
      path: "README.md",
      session_id: "local-1"
    }, terminalSessions)).toBe("");
    expect(getTerminalSessionRequirementError("Bash", {
      command: "pwd",
      session_id: "local"
    }, terminalSessions)).toContain("terminal session type");
    expect(getTerminalSessionRequirementError("Bash", {
      command: "pwd",
      session_id: "machine:local"
    }, terminalSessions)).toContain("is a machine_id");
    expect(getTerminalSessionRequirementError("Bash", {
      command: "pwd",
      session_id: "missing-session"
    }, terminalSessions)).toContain("Unknown session_id");
    expect(getTerminalSessionRequirementError("fsRead", { path: "README.md" })).toBe("");
    expect(createTerminalToolExecutionContext({
      path: "README.md",
      session_id: "local-1"
    }, terminalSessions)).toMatchObject({
      sourceId: "terminal:local-1",
      terminalSession: { id: "local-1", type: "local", cwd: "/Users/bytedance" }
    });
  });

    it("normalizes biography events for the context panel", () => {
      const events = normalizeContextBiographyEvents([
        {
          id: "session-1:run-2:0",
          at: "2026-08-12T10:10:00.000Z",
          kind: "lesson",
          summary: "成本大头是 review 输出 tokens",
          project: "Script Gen",
          topics: ["Cost", "model_usage"],
          confirmed: false,
          sessionId: "session-1",
          runId: "run-2"
        },
        {
          id: "session-1:run-1:0",
          at: "2026-08-12T10:00:00.000Z",
          kind: "outcome",
          summary: "完成 14 分钟视频成本估算",
          project: "script-gen",
          topics: ["cost"],
          confirmed: true,
          sessionId: "session-1",
          runId: "run-1"
        },
        { id: "invalid", kind: "chat", summary: "普通聊天" }
      ]);

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        kind: "lesson",
        project: "script-gen",
        topics: ["cost", "model-usage"]
      });
      expect(events[1]).toMatchObject({ confirmed: true });

      const summary = buildBiographyContextSummary(events);
      expect(summary.total).toBe(2);
      expect(summary.confirmed).toBe(1);
      expect(summary.projects.has("script-gen")).toBe(true);
      expect(summary.kinds).toMatchObject({ lesson: 1, outcome: 1 });
    });
});
