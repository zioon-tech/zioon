import { describe, expect, it } from "vitest";
import {
  addAutomationRequest,
  buildAttentionEntry,
  buildAutomationTaskPrompt,
  inspectProjectReadiness,
  normalizeAutomationDocument,
  reconcileProjectRun,
  resolveAutomationRequest,
  selectAutomationCandidate,
  updateProjectPolicy
} from "../extensions/dev.identity/project-automation-core.js";

const READY_PROJECT = `---
project: "Zion Next"
status: active
---

# Zion Next

## 目标

交付可运行的项目自动推进能力。

## 调研

- 已确认 Scheduler 提供心跳，Identity 负责协调。

## 计划

- [x] 建立项目工作记忆
- [ ] 实现自动推进控制器
- [ ] 验证失败回退
`;

describe("project automation core", () => {
  it("normalizes policy and preserves UI-owned runtime state", () => {
    const document = normalizeAutomationDocument({
      projects: {
        "zion-next": {
          enabled: true,
          mode: "execute",
          cadenceMinutes: 30,
          fileRoots: ["/workspace/zion-next", "/workspace/zion-next"],
          maxToolCalls: 999,
          activeTaskId: "task-1"
        }
      }
    });

    expect(document.version).toBe(1);
    expect(document.requests).toEqual([]);
    expect(document.projects["zion-next"]).toEqual(expect.objectContaining({
      enabled: true,
      mode: "execute",
      cadenceMinutes: 30,
      fileRoots: ["/workspace/zion-next"],
      maxToolCalls: 80,
      activeTaskId: "task-1"
    }));

    const updated = updateProjectPolicy(document, "zion-next", { enabled: false }, 1234);
    expect(updated.projects["zion-next"].enabled).toBe(false);
    expect(updated.projects["zion-next"].updatedAt).toBe(1234);
  });

  it("keeps automation changes pending until the user approves them", () => {
    const requested = addAutomationRequest(normalizeAutomationDocument(), {
      id: "request-1",
      projectKey: "zion-next",
      patch: {
        enabled: true,
        mode: "execute",
        fileRoots: ["/workspace/zion-next"]
      },
      reason: "用户希望自动继续实现",
      requestedAt: 1000
    });

    expect(requested.projects["zion-next"]).toBeUndefined();
    expect(requested.requests[0]).toEqual(expect.objectContaining({
      id: "request-1",
      status: "pending"
    }));

    const approved = resolveAutomationRequest(requested, "request-1", true, 2000);
    expect(approved.projects["zion-next"]).toEqual(expect.objectContaining({
      enabled: true,
      mode: "execute",
      fileRoots: ["/workspace/zion-next"]
    }));
    expect(approved.requests[0]).toEqual(expect.objectContaining({
      status: "approved",
      resolvedAt: 2000
    }));
  });

  it("clears stale running state after an application restart", () => {
    const stale = normalizeAutomationDocument({
      projects: {
        "zion-next": {
          enabled: true,
          activeTaskId: "task-1",
          lastStatus: "running",
          lastPhase: "research"
        }
      }
    }).projects["zion-next"];

    expect(reconcileProjectRun(stale, { status: "running" }, false, 1000)).toEqual({
      activeTaskId: "",
      lastStatus: "failed",
      nextEligibleAt: 7_201_000,
      lastError: "自动推进因应用或插件重启中断"
    });
    expect(reconcileProjectRun(stale, { status: "running" }, true)).toBeNull();
    expect(normalizeAutomationDocument({
      projects: {
        inconsistent: { lastStatus: "running", activeTaskId: "" }
      }
    }).projects.inconsistent.lastStatus).toBe("idle");
  });

  it("maps project completeness to one bounded next action", () => {
    expect(inspectProjectReadiness("## 目标\n\n", { mode: "explore" })).toEqual(
      expect.objectContaining({ kind: "attention", reason: "missing-goal" })
    );
    expect(inspectProjectReadiness("## 目标\n\n完成自动化。\n\n## 计划\n\n- [ ] 实现", {
      mode: "explore"
    })).toEqual(expect.objectContaining({ kind: "run", phase: "research" }));
    expect(inspectProjectReadiness(`${READY_PROJECT.replace(
      /## 计划[\s\S]*/,
      "## 计划\n\n先完成实现。"
    )}`, {
      mode: "explore"
    })).toEqual(expect.objectContaining({ kind: "run", phase: "planning" }));
    expect(inspectProjectReadiness(READY_PROJECT, { mode: "explore" })).toEqual(
      expect.objectContaining({ kind: "attention", reason: "plan-review" })
    );
    expect(inspectProjectReadiness(READY_PROJECT, { mode: "execute" })).toEqual(
      expect.objectContaining({
        kind: "run",
        phase: "executing",
        nextStep: "实现自动推进控制器"
      })
    );
    expect(inspectProjectReadiness(READY_PROJECT.replaceAll("- [ ]", "- [x]"), {
      mode: "execute"
    })).toEqual(expect.objectContaining({ kind: "attention", reason: "final-review" }));
  });

  it("selects only an enabled due non-running project", () => {
    const automation = normalizeAutomationDocument({
      projects: {
        disabled: { enabled: false },
        running: { enabled: true, activeTaskId: "task-1" },
        later: { enabled: true, nextEligibleAt: 5000 },
        due: { enabled: true, nextEligibleAt: 1000 }
      }
    });
    const rows = [
      { key: "disabled", name: "Disabled" },
      { key: "running", name: "Running" },
      { key: "later", name: "Later" },
      { key: "due", name: "Due" }
    ];

    expect(selectAutomationCandidate(rows, automation, 2000)?.key).toBe("due");
    expect(selectAutomationCandidate(rows, automation, 2000, { projectKey: "later" })?.key)
      .toBe("later");
  });

  it("builds phase-specific prompts and attention entries", () => {
    const prompt = buildAutomationTaskPrompt({
      project: { key: "zion-next", name: "Zion Next" },
      projectPath: "/memory/projects/zion-next/project.md",
      indexPath: "/memory/projects/index.md",
      attentionPath: "/memory/projects/attention.md",
      phase: "executing",
      nextStep: "实现自动推进控制器"
    });

    expect(prompt).toContain("只推进一个计划项");
    expect(prompt).toContain("实现自动推进控制器");
    expect(prompt).toContain("只能调用 projectAutomationManage");
    expect(buildAttentionEntry({
      projectName: "Zion Next",
      reason: "missing-goal",
      at: "2026-08-19T01:00:00.000Z"
    })).toContain("缺少明确目标");
  });
});
