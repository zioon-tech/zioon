import { afterEach, describe, expect, it, vi } from "vitest";
import { mountTerminalManagerSidebarViewInto } from "../extensions/dev.terminal-manager/session-tools.js";

function createState(initial = {}) {
  const values = new Map(Object.entries(initial));
  const listeners = new Map();
  return {
    get: (key) => values.get(key),
    set: (key, value) => {
      const oldValue = values.get(key);
      values.set(key, value);
      for (const callback of Array.from(listeners.get(key) || [])) callback(value, oldValue);
    },
    onDidChange: (key, callback) => {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(callback);
      return { dispose: () => listeners.get(key)?.delete(callback) };
    }
  };
}

function setupZion() {
  const state = createState({ "terminal.activeSessionId": "local-1" });
  window.zion = {
    state,
    i18n: { t: (key) => key },
    events: { on: () => ({ dispose() {} }) },
    commands: { executeCommand: vi.fn() }
  };
  return { state };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.zion;
  document.body.replaceChildren();
});

describe("terminal manager sidebar", () => {
  it("groups terminal sessions by machine and workspace", async () => {
    const { state } = setupZion();
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if (String(url).endsWith("/machines")) {
        return new globalThis.Response(JSON.stringify({ machines: [] }), { status: 200 });
      }
      if (String(url).includes("/machines/") && options.method === "PATCH") {
        return new globalThis.Response(JSON.stringify({
          machine: {
            id: "machine:local",
            name: "Build Mac",
            kind: "local",
            description: "Local build machine",
            updated_at: Date.now()
          }
        }), { status: 200 });
      }
      return new globalThis.Response(JSON.stringify({
        sessions: [
          { id: "local-1", type: "local", cwd: "/Users/test/zion-next", last_activity: Date.now(), active: true },
          { id: "local-2", type: "local", cwd: "/Users/test/zion-next", last_activity: Date.now() - 1000, active: true },
          { id: "ssh-1", type: "ssh", ssh_user: "root", ssh_host: "las-dev", cwd: "/workspace/project", last_activity: Date.now() - 2000, active: false }
        ]
      }), { status: 200 });
    }));

    const container = document.createElement("div");
    document.body.appendChild(container);
    const mounted = mountTerminalManagerSidebarViewInto(container);

    await vi.waitFor(() => {
      expect(container.querySelectorAll('[data-kind="machine"]')).toHaveLength(2);
    });

    expect(container.querySelectorAll('[data-kind="workspace"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-kind="session"]')).toHaveLength(0);
    expect(container.querySelector(".zion-terminal-manager-summary")?.textContent)
      .toBe("2 台机器 · 2 可用 · 1 已断开");
    expect(container.querySelectorAll('[data-kind="machine"] .is-available')).toHaveLength(2);
    expect(container.querySelectorAll('[data-kind="machine"] .is-disconnected')).toHaveLength(1);
    expect(state.get("terminal.inventory")?.machines).toHaveLength(2);
    expect(state.get("terminal.inventory")?.workspaces).toHaveLength(2);

    container.querySelector('[data-kind="machine"] .zion-terminal-manager-more').click();
    const machineDescription = container.querySelector('[data-kind="machine"] textarea');
    expect(machineDescription.value).toContain("暂无机器资源信息");
    machineDescription.value = "Local build machine";
    container.querySelector('[data-kind="machine"] .zion-terminal-manager-button.is-primary').click();
    await vi.waitFor(() => {
      expect(state.get("terminal.inventory")?.machines[0]?.description).toBe("Local build machine");
    });

    const localMachineRow = container.querySelector('[data-kind="machine"] .zion-terminal-manager-tree-main');
    localMachineRow.click();
    expect(container.querySelectorAll('[data-kind="workspace"]')).toHaveLength(1);

    const workspaceRow = container.querySelector('[data-kind="workspace"] .zion-terminal-manager-tree-main');
    workspaceRow.click();
    expect(container.querySelectorAll('[data-kind="session"]')).toHaveLength(2);
    expect(container.querySelector('[data-kind="session"].is-active')).toBeTruthy();

    const searchInput = container.querySelector(".zion-terminal-manager-search input");
    searchInput.value = "las-dev";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(container.querySelectorAll('[data-kind="machine"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-kind="workspace"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-kind="session"]')).toHaveLength(1);
    expect(container.querySelector('[data-kind="session"] .zion-terminal-manager-tree-title')?.textContent).toBe("ssh-1");
    expect(container.querySelector(".zion-terminal-manager-more")).toBeTruthy();

    mounted.dispose();
  });

  it("keeps saved machines visible when they have no sessions", async () => {
    setupZion();
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).endsWith("/machines")) {
        return new globalThis.Response(JSON.stringify({
          machines: [{
            id: "machine:ssh:offline",
            name: "Offline GPU",
            kind: "ssh",
            description: "GPU development machine"
          }]
        }), { status: 200 });
      }
      return new globalThis.Response(JSON.stringify({ sessions: [] }), { status: 200 });
    }));

    const container = document.createElement("div");
    document.body.appendChild(container);
    const mounted = mountTerminalManagerSidebarViewInto(container);

    await vi.waitFor(() => {
      expect(container.querySelector('[data-kind="machine"]')).toBeTruthy();
    });
    expect(container.querySelector(".zion-terminal-manager-tree-title")?.textContent)
      .toBe("Offline GPU");
    expect(container.querySelector(".zion-terminal-manager-empty")).toBeNull();

    mounted.dispose();
  });
});
