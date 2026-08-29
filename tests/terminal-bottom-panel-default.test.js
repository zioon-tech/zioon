import { afterEach, describe, expect, it, vi } from "vitest";
import { activate } from "../extensions/dev.terminal-enhanced/main.js";

function createState(initial = {}) {
  const map = new Map(Object.entries(initial));
  const listeners = new Map();
  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      const oldValue = map.get(key);
      map.set(key, value);
      const fns = listeners.get(key);
      if (fns) {
        for (const fn of Array.from(fns)) fn(value, oldValue);
      }
    },
    onDidChange: (key, fn) => {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
      return { dispose: () => listeners.get(key)?.delete(fn) };
    }
  };
}

function createZion(initialState = {}) {
  const state = createState(initialState);
  return {
    state,
    i18n: { registerNamespace: vi.fn(() => ({ dispose() {} })) },
    commands: {
      registerCommand: vi.fn(() => ({ dispose() {} })),
      executeCommand: vi.fn()
    },
    keybindings: { register: vi.fn(() => ({ dispose() {} })) },
    messages: { registerContributor: vi.fn(() => ({ dispose() {} })) },
    events: {
      emit: vi.fn(),
      on: vi.fn(() => ({ dispose() {} }))
    },
    bottomPanel: {
      registerView: vi.fn(() => ({ dispose() {} })),
      activateView: vi.fn(),
      hide: vi.fn(),
      getLastOpenedViewId: vi.fn(() => "")
    },
    auxiliaryBar: {
      registerView: vi.fn(() => ({ dispose() {} })),
      activateView: vi.fn(),
      hide: vi.fn()
    },
    slash: { registerCommand: vi.fn(() => ({ dispose() {} })) },
    __applyKeymap: vi.fn()
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete window.zion;
  document.body.replaceChildren();
});

describe("terminal bottom panel defaults", () => {
  it("does not steal the bottom panel when Logs is the active view", async () => {
    const zion = createZion({
      "ui.bottomPanel.activeViewId": "core.output",
      "ui.bottomPanel.visible": true
    });
    window.zion = zion;

    await activate({ subscriptions: [] });
    zion.state.set("ui.bottomPanel.visible", true);

    expect(zion.state.get("ui.bottomPanel.activeViewId")).toBe("core.output");
    expect(zion.bottomPanel.activateView).not.toHaveBeenCalledWith("terminal.enhanced.view");
  });

  it("still defaults to Terminal when no bottom panel view is active", async () => {
    const zion = createZion();
    window.zion = zion;

    await activate({ subscriptions: [] });

    expect(zion.state.get("ui.bottomPanel.activeViewId")).toBe("terminal.enhanced.view");
    expect(zion.bottomPanel.registerView).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "terminal.enhanced.view",
        icon: "$(remote)"
      })
    );
    expect(zion.auxiliaryBar.registerView).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "terminal.enhanced.aux.view",
        icon: "$(remote)"
      })
    );
  });

  it("requires terminalExecute callers to provide session_id", async () => {
    const zion = createZion({
      "terminal.activeSessionId": "ambient-session",
      "terminal.sessions": [{ id: "ambient-session", status: "running" }]
    });
    window.zion = zion;

    await activate({ subscriptions: [] });

    const tool = zion.state.get("chat.tools").find((item) => item?.function?.name === "terminalExecute");
    const handler = zion.state.get("chat.toolHandlers").terminalExecute;
    expect(tool.function.parameters.required).toContain("session_id");
    await expect(handler({ command: "pwd" })).resolves.toContain("Missing session_id");
    await expect(handler({ command: "pwd", session_id: "local" })).resolves.toContain("terminal session type");
  });
});
