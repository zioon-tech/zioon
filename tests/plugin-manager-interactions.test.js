import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate } from "../extensions/dev.plugins/main.js";

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

  it("toggles plugin state without opening plugin details", async () => {
    const toggle = container.querySelector(".zion-plugin-manager-row input[type='checkbox']");
    toggle.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(pluginManager.disable).toHaveBeenCalledWith("dev.memory");
    expect(openFileTab).not.toHaveBeenCalled();
    expect(inspectorOpen).not.toHaveBeenCalled();
  });
});
