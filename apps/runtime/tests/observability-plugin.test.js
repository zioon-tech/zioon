import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validatePluginManifest } from "../../../packages/plugin-sdk/src/manifest.mjs";
import { activateRuntimePlugin } from "../../../extensions/dev.observability/runtime.js";
import {
  collectPluginSkillContributions
} from "../../../extensions/dev.skills/plugin-skills.js";
import {
  OBSERVABILITY_QUERY_TOOL_DEFINITION
} from "../src/observability/query-tool.mjs";
import {
  RAW_OBSERVABILITY_TOOL_DEFINITION
} from "../src/observability/raw-read.mjs";

describe("dev.observability Runtime plugin", () => {
  it("declares a valid Skill-only plugin", () => {
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
    expect(manifest.zion.capabilities).toEqual([
      expect.objectContaining({
        id: "run-diagnostics",
        kind: "skill",
        risk: "read-only"
      })
    ]);
    expect(manifest.zion.contributes.skills).toEqual([
      "./skills/run-diagnostics"
    ]);
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
  });

  it("documents facts and evidence access without embedding conclusions or repair", () => {
    const skill = readFileSync(
      resolve("../../extensions/dev.observability/skills/run-diagnostics/SKILL.md"),
      "utf8"
    );

    expect(skill).toMatch(/^name:\s*"?run-diagnostics"?$/m);
    expect(skill).toContain("observabilityQuery");
    expect(skill).toContain("observabilityRawRead");
    expect(skill).toContain("analysis and conclusions remain the");
    expect(skill).not.toContain("root cause");
    expect(skill).not.toContain("apply patch");
  });

  it("registers no diagnostic conclusion Tools while Runtime owns two fact interfaces", () => {
    const registerTool = vi.fn();
    const log = vi.fn();
    const contribution = activateRuntimePlugin({
      tools: { registerTool },
      log
    });

    expect(registerTool).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("observability facts are exposed by Runtime")
    );
    expect(OBSERVABILITY_QUERY_TOOL_DEFINITION).toMatchObject({
      name: "observabilityQuery",
      inputSchema: {
        required: ["sql", "purpose"],
        additionalProperties: false
      }
    });
    expect(RAW_OBSERVABILITY_TOOL_DEFINITION.name).toBe(
      "observabilityRawRead"
    );
    expect(() => contribution.dispose()).not.toThrow();
  });
});
