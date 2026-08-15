import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createPluginDetailModel,
  getPluginContributions,
  getPluginPresentation,
  getPluginStatus,
  localizePluginValue,
  renderPluginEditor
} from "../extensions/dev.plugins/plugin-details.js";

function memoryPlugin() {
  const manifest = JSON.parse(fs.readFileSync(
    path.resolve("extensions/dev.memory/manifest.json"),
    "utf8"
  ));
  return {
    id: manifest.zion.id,
    name: manifest.zion.name,
    version: manifest.zion.version,
    description: manifest.description,
    author: manifest.author,
    license: manifest.license,
    path: "/extensions/dev.memory",
    enabled: true,
    state: "active",
    manifest
  };
}

describe("plugin detail metadata", () => {
  it("resolves localized presentation values with stable fallbacks", () => {
    expect(localizePluginValue({ "zh-CN": "记忆", "en-US": "Memory" }, "en-US")).toBe("Memory");
    expect(localizePluginValue({ "zh-CN": "记忆" }, "fr-FR")).toBe("记忆");

    const presentation = getPluginPresentation(memoryPlugin(), { locale: "zh-CN" });
    expect(presentation.name).toBe("记忆");
    expect(presentation.description).toContain("Markdown");
    expect(presentation.icon).toBe("database");
    expect(presentation.features.length).toBeGreaterThan(1);
    expect(presentation.permissions[0].id).toBe("local-files");
    expect(presentation.entrypoints[0].command).toBe("memory.openPanel");
  });

  it("derives capability counts from contributes instead of duplicated page data", () => {
    const contributions = getPluginContributions(memoryPlugin(), "zh-CN");
    expect(contributions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "commands", label: "命令", count: 3 }),
      expect.objectContaining({ kind: "styles", label: "样式", count: 1 })
    ]));
  });

  it("maps runtime states to explicit user-facing status", () => {
    expect(getPluginStatus({ enabled: true, state: "active" }, "zh-CN").label).toBe("运行中");
    expect(getPluginStatus({ enabled: false, state: "disabled" }, "zh-CN").label).toBe("已停用");
    expect(getPluginStatus({ enabled: true, state: "error" }, "zh-CN").tone).toBe("error");
  });

  it("requires every built-in manifest to provide a complete bilingual presentation", () => {
    const manifests = fs.readdirSync(path.resolve("extensions"))
      .map((name) => path.resolve("extensions", name, "manifest.json"))
      .filter((file) => fs.existsSync(file));

    expect(manifests.length).toBeGreaterThanOrEqual(33);
    for (const file of manifests) {
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      const presentation = manifest.zion?.presentation || manifest.presentation;
      expect(presentation, file).toBeTruthy();
      expect(presentation.displayName?.["zh-CN"], file).toBeTruthy();
      expect(presentation.displayName?.["en-US"], file).toBeTruthy();
      expect(presentation.description?.["zh-CN"], file).toBeTruthy();
      expect(presentation.description?.["en-US"], file).toBeTruthy();
      expect(presentation.icon, file).toMatch(/^[a-z0-9-]+$/);
      expect(presentation.category, file).toMatch(/^(ai|editor|integration|productivity|system|workspace)$/);
      expect(presentation.features?.["zh-CN"]?.length, file).toBeGreaterThan(0);
      expect(presentation.features?.["en-US"]?.length, file).toBeGreaterThan(0);

      const commandIds = new Set((manifest.zion?.contributes?.commands || []).map((command) => command.id));
      for (const entrypoint of presentation.entrypoints || []) {
        expect(commandIds.has(entrypoint.command), `${file}: ${entrypoint.command}`).toBe(true);
      }
    }
  });
});

describe("plugin detail rendering", () => {
  it("renders the editor tab sections", () => {
    const plugin = memoryPlugin();
    const onToggle = vi.fn();
    const model = createPluginDetailModel(plugin, {
      locale: "zh-CN",
      onToggle,
      onReload: vi.fn(),
      runCommand: vi.fn()
    });

    const editor = document.createElement("div");
    renderPluginEditor(editor, model);
    expect(editor.textContent).toContain("概览");
    expect(editor.textContent).toContain("能力");
    expect(editor.textContent).toContain("设置");
    expect(editor.textContent).toContain("日志");

    const capabilities = [...editor.querySelectorAll(".zion-plugin-detail-tab")]
      .find((tab) => tab.textContent === "能力");
    capabilities?.click();
    expect(editor.querySelector(".zion-plugin-detail-page")?.textContent).toContain("manifest");
  });
});
