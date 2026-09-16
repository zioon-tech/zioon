import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validatePluginManifest } from "../../../packages/plugin-sdk/src/manifest.mjs";
import { activateRuntimePlugin } from "../../../extensions/dev.observability/runtime.js";
import {
  collectPluginSkillContributions
} from "../../../extensions/dev.skills/plugin-skills.js";

function pluginContext(service) {
  const tools = new Map();
  const disposers = [];
  const context = {
    config: { observabilityService: service },
    tools: {
      registerTool(definition) {
        tools.set(definition.name, definition);
        const dispose = vi.fn();
        disposers.push(dispose);
        return { dispose };
      }
    },
    log: vi.fn()
  };
  return {
    context,
    tools,
    disposers,
    tool(name) {
      return tools.get(name);
    }
  };
}

describe("dev.observability Runtime plugin", () => {
  it("declares a valid Runtime Tool and bundled Skill", () => {
    const manifest = JSON.parse(readFileSync(
      resolve("../../extensions/dev.observability/manifest.json"),
      "utf8"
    ));
    const validation = validatePluginManifest(manifest, { host: "runtime" });

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.normalized).toMatchObject({
      id: "dev.observability",
      hosts: { runtime: true },
      runtimeApiVersion: 2
    });
    expect(manifest.zion.contributes.skills).toEqual([
      "./skills/run-diagnostics"
    ]);
    expect(manifest.zion.capabilities.map((capability) => capability.id))
      .toEqual(expect.arrayContaining([
        "observabilityInspect",
        "observabilityOverview",
        "run-diagnostics"
      ]));
    expect(collectPluginSkillContributions([{
      id: "dev.observability",
      path: "/extensions/dev.observability",
      manifest
    }])).toEqual([
      expect.objectContaining({
        id: "dev.observability/run-diagnostics",
        pluginId: "dev.observability",
        relativePath: "skills/run-diagnostics",
        sourceFile:
          "/extensions/dev.observability/skills/run-diagnostics/SKILL.md"
      })
    ]);
    const skill = readFileSync(
      resolve("../../extensions/dev.observability/skills/run-diagnostics/SKILL.md"),
      "utf8"
    );
    expect(skill).toContain("name: \"run-diagnostics\"");
    expect(skill).toContain("observabilityInspect");
  });

  it("registers ledger-backed Tools when the trace Backend is disabled", () => {
    const fixture = pluginContext({
      enabled: false,
      diagnoseRun: vi.fn(),
      overview: vi.fn(),
      status: vi.fn()
    });

    const contribution = activateRuntimePlugin(fixture.context);

    expect([...fixture.tools.keys()]).toEqual([
      "observabilityInspect",
      "observabilityOverview"
    ]);
    expect(() => contribution.dispose()).not.toThrow();
    expect(fixture.disposers.every((dispose) => dispose.mock.calls.length === 1))
      .toBe(true);
  });

  it("registers a read-only, Run-scoped diagnostic Tool", async () => {
    const diagnoseRun = vi.fn(async () => ({
      schemaVersion: 1,
      runId: "run-history",
      attemptId: "attempt-internal",
      availability: "ready",
      correlation: { traceId: "1".repeat(32), sampled: true },
      coverage: ["attempt", "model"],
      stages: [{ kind: "model", name: "model", durationMs: 2000 }],
      findings: [{
        code: "largest_observed_stage",
        severity: "info",
        evidence: ["model:model=2.0s"]
      }],
      limitations: []
    }));
    const fixture = pluginContext({
      enabled: true,
      diagnoseRun,
      overview: vi.fn(),
      status: vi.fn()
    });
    const contribution = activateRuntimePlugin(fixture.context);
    const tool = fixture.tool("observabilityInspect");

    expect(tool).toMatchObject({
      name: "observabilityInspect",
      policy: { minimumPreset: "read-only" },
      inputSchema: {
        additionalProperties: false
      }
    });
    expect(tool.inputSchema.required).toBeUndefined();
    const result = await tool.invoke({
      run_id: "run-history",
      include_stages: true,
      include_findings: false
    }, {
      runId: "run-current",
      attemptId: "attempt-current",
      sessionId: "session-1",
      projectId: "project-1",
      signal: { cancelled: false }
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content).diagnostic).toMatchObject({
      runId: "run-history",
      availability: "ready"
    });
    const modelDiagnostic = JSON.parse(result.content).diagnostic;
    expect(modelDiagnostic).not.toHaveProperty("attemptId");
    expect(modelDiagnostic).not.toHaveProperty("correlation");
    expect(diagnoseRun).toHaveBeenCalledWith("run-history", {
      signal: { cancelled: false },
      requester: {
        runId: "run-current",
        sessionId: "session-1",
        projectId: "project-1"
      },
      enforceVisibility: true,
      includeStages: true,
      includeFindings: false,
      includeExternalUrl: false
    });

    contribution.dispose();
    expect(fixture.disposers.every((dispose) => dispose.mock.calls.length === 1))
      .toBe(true);
  });

  it("does not disclose whether an invisible Run exists", async () => {
    const fixture = pluginContext({
      enabled: true,
      diagnoseRun: vi.fn(async () => null),
      overview: vi.fn(),
      status: vi.fn()
    });
    activateRuntimePlugin(fixture.context);

    const result = await fixture.tool("observabilityInspect").invoke({
      run_id: "run-private"
    }, {
      runId: "run-current",
      sessionId: "session-current",
      projectId: "project-current"
    });

    expect(result).toEqual({
      ok: false,
      error: "Run not found or not visible",
      content: JSON.stringify({
        error: "not-found-or-not-visible",
        runId: "run-private"
      })
    });
  });

  it("uses a no-target result for omitted run_id and exposes bounded overview", async () => {
    const diagnoseRun = vi.fn(async () => null);
    const overview = vi.fn(async () => ({
      schemaVersion: 1,
      scope: { kind: "project", id: "project-1" },
      totals: { inspected: 1, problems: 1 },
      runs: [{ runId: "run-failed", signals: ["failed"] }],
      truncated: false
    }));
    const fixture = pluginContext({
      enabled: false,
      diagnoseRun,
      overview,
      status: vi.fn()
    });
    activateRuntimePlugin(fixture.context);
    const meta = {
      runId: "run-current",
      sessionId: "session-1",
      projectId: "project-1",
      signal: { cancelled: false }
    };

    const noTarget = await fixture.tool("observabilityInspect").invoke({}, meta);
    expect(noTarget).toMatchObject({ ok: false });
    expect(JSON.parse(noTarget.content)).toEqual({ error: "no-target" });
    expect(diagnoseRun).toHaveBeenCalledWith(undefined, expect.objectContaining({
      requester: {
        runId: "run-current",
        sessionId: "session-1",
        projectId: "project-1"
      }
    }));

    const result = await fixture.tool("observabilityOverview").invoke({
      window_minutes: 60,
      limit: 5,
      min_duration_ms: 10_000
    }, meta);
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content).overview.runs[0]).toMatchObject({
      runId: "run-failed"
    });
    expect(overview).toHaveBeenCalledWith({
      windowMinutes: 60,
      limit: 5,
      minDurationMs: 10_000
    }, {
      signal: { cancelled: false },
      requester: {
        runId: "run-current",
        sessionId: "session-1",
        projectId: "project-1"
      }
    });
  });
});
