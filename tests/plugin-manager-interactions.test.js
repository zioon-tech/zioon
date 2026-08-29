import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate } from "../extensions/dev.plugins/main.js";
import { createPluginDetailModel, getPluginOriginInfo, renderPluginEditor } from "../extensions/dev.plugins/plugin-details.js";

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
    path: "/extensions/dev.memory",
    enabled: true,
    state: "active",
    manifest
  };
}

describe("plugin manager detail navigation", () => {
  let container;
  let plugin;
  let pluginManager;
  let openFileTab;
  let inspectorOpen;
  let registeredView;
  let mounted;

  beforeEach(async () => {
    plugin = memoryPlugin();
    openFileTab = vi.fn(() => `file:plugin-detail:${plugin.id}`);
    inspectorOpen = vi.fn();
    pluginManager = {
      list: vi.fn(() => [plugin]),
      getStats: vi.fn(() => ({ total: 1, enabled: plugin.enabled ? 1 : 0, active: 1, errors: 0 })),
      enable: vi.fn(async () => {
        plugin.enabled = true;
        plugin.state = "active";
      }),
      disable: vi.fn(async () => {
        plugin.enabled = false;
        plugin.state = "disabled";
      }),
      on: vi.fn(),
      off: vi.fn()
    };

    window.zion = {
      plugins: pluginManager,
      i18n: {
        getLocale: vi.fn(() => "zh-CN"),
        registerNamespace: vi.fn(() => ({ dispose: vi.fn() })),
        t: vi.fn((key) => key)
      },
      commands: {
        executeCommand: vi.fn(),
        registerCommand: vi.fn(() => ({ dispose: vi.fn() }))
      },
      activityBar: {
        activateItem: vi.fn(),
        registerItem: vi.fn(() => ({ dispose: vi.fn() }))
      },
      sideBar: {
        registerView: vi.fn((view) => {
          registeredView = view;
          return { dispose: vi.fn() };
        })
      },
      panels: {
        list: vi.fn(() => []),
        openFileTab
      },
      inspector: {
        open: inspectorOpen
      }
    };

    await activate({ subscriptions: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    mounted = registeredView.component.render(container);
  });

  afterEach(() => {
    mounted?.dispose?.();
    container?.remove();
    delete window.zion;
  });

  it("opens or focuses the stable editor detail tab from click and keyboard activation", () => {
    container.querySelector(".zion-plugin-manager-row").click();

    expect(openFileTab).toHaveBeenCalledTimes(1);
    expect(openFileTab).toHaveBeenLastCalledWith(expect.objectContaining({
      id: "file:plugin-detail:dev.memory",
      ownerId: "plugins.manager",
      focus: true
    }));
    expect(inspectorOpen).not.toHaveBeenCalled();
    expect(container.querySelector(".zion-plugin-manager-row").classList.contains("is-selected")).toBe(true);

    container.querySelector(".zion-plugin-manager-row").click();
    expect(openFileTab).toHaveBeenCalledTimes(2);
    expect(openFileTab.mock.calls[1][0].id).toBe(openFileTab.mock.calls[0][0].id);

    const event = new window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true
    });
    container.querySelector(".zion-plugin-manager-row").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(openFileTab).toHaveBeenCalledTimes(3);
  });

  it("controls plugin state from the row settings menu without opening plugin details", async () => {
    expect(container.querySelector(".zion-plugin-manager-row input[type='checkbox']")).toBeNull();
    expect(container.querySelector(".zion-plugin-manager-row-status")).toBeNull();
    expect(container.querySelector(".zion-plugin-manager-row")?.dataset.status).toBe("active");

    const menu = container.querySelector(".zion-plugin-manager-row-menu");
    const trigger = menu.querySelector(".zion-plugin-manager-row-menu-trigger");
    expect(trigger.querySelector(".codicon-kebab-vertical")).toBeTruthy();
    trigger.click();
    const disableItem = Array.from(menu.querySelectorAll(".zion-plugin-manager-row-menu-item"))
      .find((item) => item.textContent.includes("停用插件"));
    disableItem.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(pluginManager.disable).toHaveBeenCalledWith("dev.memory");
    expect(openFileTab).not.toHaveBeenCalled();
    expect(inspectorOpen).not.toHaveBeenCalled();
  });

  it("shows plugin origin in the sidebar and detail page", () => {
    const row = container.querySelector(".zion-plugin-manager-row");
    expect(row?.dataset.origin).toBe("builtin");
    expect(row?.querySelector(".zion-plugin-origin-badge")).toBeNull();
    expect(row?.querySelector(".zion-plugin-manager-row-meta")?.textContent).toContain("内置");

    const zipPlugin = {
      ...plugin,
      id: "dev.zip-plugin",
      origin: "external",
      path: "file:dev.zip-plugin.zip"
    };
    expect(getPluginOriginInfo(zipPlugin, "zh-CN")).toMatchObject({
      id: "external",
      shortLabel: "ZIP",
      label: "ZIP/外部安装"
    });

    const devPlugin = {
      ...plugin,
      id: "dev.local-plugin",
      origin: "dev",
      sourceDir: "/Users/test/.zion-next/plugins/dev.local-plugin"
    };
    const detail = document.createElement("div");
    renderPluginEditor(detail, createPluginDetailModel(devPlugin, {
      locale: "zh-CN",
      onToggle: vi.fn(),
      onReload: vi.fn(),
      runCommand: vi.fn()
    }));

    expect(detail.querySelector(".zion-plugin-detail-origin")).toBeNull();
    expect(detail.textContent).toContain("开发热更新");
  });

  it("controls plugin state from the detail page", async () => {
    const detail = document.createElement("div");
    const onToggle = vi.fn(async (enabled) => {
      plugin.enabled = enabled;
      plugin.state = enabled ? "active" : "disabled";
    });

    renderPluginEditor(detail, createPluginDetailModel(plugin, {
      locale: "zh-CN",
      onToggle,
      onReload: vi.fn(),
      runCommand: vi.fn()
    }));

    expect(detail.querySelector(".zion-plugin-detail-toggle input")).toBeNull();
    const disableButton = Array.from(detail.querySelectorAll(".zion-plugin-detail-button"))
      .find((button) => button.textContent.includes("停用插件"));
    disableButton.click();
    await Promise.resolve();
    expect(onToggle).toHaveBeenCalledWith(false);

    detail.replaceChildren();
    renderPluginEditor(detail, createPluginDetailModel(plugin, {
      locale: "zh-CN",
      onToggle,
      onReload: vi.fn(),
      runCommand: vi.fn()
    }));

    const enableButton = Array.from(detail.querySelectorAll(".zion-plugin-detail-button"))
      .find((button) => button.textContent.includes("启用插件"));
    enableButton.click();
    await Promise.resolve();
    expect(onToggle).toHaveBeenLastCalledWith(true);
  });
});
