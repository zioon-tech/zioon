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
      const callbacks = listeners.get(key);
      if (callbacks) {
        for (const callback of Array.from(callbacks)) callback(value, oldValue);
      }
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
  it("keeps terminal rows isolated from session list styles", async () => {
    setupZion();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      sessions: [
        { id: "local-1", type: "local", cwd: "/Users/bytedance/Downloads/zion-next", last_activity: Date.now() },
        { id: "ssh-1", type: "ssh", ssh_user: "root", ssh_host: "las-dev", cwd: "/workspace/project", last_activity: Date.now() - 1000 }
      ]
    }), { status: 200 })));

    const container = document.createElement("div");
    document.body.appendChild(container);
    const mounted = mountTerminalManagerSidebarViewInto(container);

    await vi.waitFor(() => {
      expect(container.querySelectorAll(".zion-terminal-manager-session")).toHaveLength(2);
    });

    const rows = Array.from(container.querySelectorAll(".zion-terminal-manager-session"));
    expect(rows.every((row) => !row.classList.contains("zion-session-row"))).toBe(true);
    expect(container.querySelector(".zion-terminal-manager-session.is-current")).toBeTruthy();
    expect(container.querySelector(".zion-terminal-manager-summary")?.textContent).toBe("2 个会话");

    const searchInput = container.querySelector(".zion-terminal-manager-search input");
    searchInput.value = "las-dev";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(container.querySelectorAll(".zion-terminal-manager-session")).toHaveLength(1);
    expect(container.querySelector(".zion-terminal-manager-session-title")?.textContent).toBe("root@las-dev");
    expect(container.querySelector(".zion-terminal-manager-summary")?.textContent).toBe("1/2 个会话");

    mounted.dispose();
  });
});
