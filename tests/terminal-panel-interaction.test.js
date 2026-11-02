import { afterEach, describe, expect, it, vi } from "vitest";
import { installTerminalEnhancedPanel } from "../extensions/dev.terminal-enhanced/panel.js";

const terminals = vi.hoisted(() => []);
vi.mock("xterm", () => ({
  Terminal: class {
    constructor(options) {
      this.options = options;
      this.cols = 100;
      this.rows = 30;
      this.focus = vi.fn();
      this.paste = vi.fn();
      this.write = vi.fn();
      this.writeln = vi.fn();
      this.dispose = vi.fn();
      terminals.push(this);
    }
    loadAddon() {}
    open(container) {
      this.element = container;
      const input = document.createElement("textarea");
      container.appendChild(input);
    }
    onData(handler) {
      this.input = handler;
      return { dispose() {} };
    }
    attachCustomKeyEventHandler(handler) { this.keyHandler = handler; }
  }
}));
vi.mock("xterm-addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("xterm-addon-search", () => ({ SearchAddon: class {} }));
vi.mock("xterm-addon-web-links", () => ({ WebLinksAddon: class {} }));

let panel;
function setup(connectPty) {
  const values = new Map([
    ["terminal.activeSessionId", "one"],
    ["terminal.sessions", [{ id: "one", cwd: "/workspace", type: "local" }]]
  ]);
  const listeners = new Map();
  window.zion = {
    state: {
      get: key => values.get(key),
      set(key, value) {
        values.set(key, value);
        for (const callback of listeners.get(key) || []) callback(value);
      },
      onDidChange(key, callback) {
        if (!listeners.has(key)) listeners.set(key, new Set());
        listeners.get(key).add(callback);
        return { dispose: () => listeners.get(key).delete(callback) };
      }
    },
    events: { on: () => ({ dispose() {} }) },
    commands: { executeCommand: vi.fn() }
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  panel = installTerminalEnhancedPanel({ connectPty }, { mount: host });
  return { host, state: window.zion.state };
}
function connection() {
  let resolve;
  let reject;
  const value = {
    ws: { readyState: WebSocket.CONNECTING },
    ready: new Promise((res, rej) => { resolve = res; reject = rej; }),
    send: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    onData(handler) { this.output = handler; },
    onError(handler) { this.error = handler; },
    onClose(handler) { this.close = handler; }
  };
  return {
    value,
    open() { value.ws.readyState = WebSocket.OPEN; resolve(); },
    reject
  };
}
afterEach(() => {
  panel?.dispose();
  panel = null;
  terminals.length = 0;
  document.body.replaceChildren();
  delete window.zion;
  vi.restoreAllMocks();
});

describe("terminal panel connection lifecycle", () => {
  it("shares concurrent opens and never injects shell commands after attaching", async () => {
    const pty = connection();
    const connect = vi.fn(() => pty.value);
    setup(connect);
    panel.open();
    panel.open();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    expect(terminals).toHaveLength(1);
    pty.open();
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(pty.value.send).not.toHaveBeenCalled();
    expect(terminals[0].options.convertEol).toBe(false);
  });

  it("does not replay disconnected keystrokes after connection completes", async () => {
    const pty = connection();
    setup(() => pty.value);
    panel.open();
    await vi.waitFor(() => expect(terminals).toHaveLength(1));
    terminals[0].input("rm file\r");
    expect(document.querySelector(".zte-toast").textContent).toContain("输入未发送");
    pty.open();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(pty.value.send).not.toHaveBeenCalled();
    terminals[0].input("pwd\r");
    expect(pty.value.send).toHaveBeenCalledWith("pwd\r");
  });

  it("ignores late connection output after the panel is disposed", async () => {
    const pty = connection();
    const connect = vi.fn(() => pty.value);
    setup(connect);
    panel.open();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const terminal = terminals[0];
    panel.dispose();
    pty.open();
    pty.value.output("late output");
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(terminal.write).not.toHaveBeenCalled();
    expect(terminal.focus).not.toHaveBeenCalled();
    expect(document.querySelector(".zte-tabs-menu")).toBeNull();
  });

  it("does not reconnect or focus when its host is hidden", async () => {
    const pty = connection();
    const connect = vi.fn(() => pty.value);
    const { host } = setup(connect);
    panel.open();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    host.style.display = "none";
    pty.open();
    await new Promise(resolve => setTimeout(resolve, 30));
    pty.value.close();
    window.dispatchEvent(new Event("online"));
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(connect).toHaveBeenCalledOnce();
    expect(terminals[0].focus).not.toHaveBeenCalled();
  });

  it("retries on network recovery without sending buffered input", async () => {
    const first = connection();
    const second = connection();
    const connect = vi.fn().mockReturnValueOnce(first.value).mockReturnValue(second.value);
    setup(connect);
    panel.open();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    first.open();
    await new Promise(resolve => setTimeout(resolve, 20));
    first.value.close();
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    second.open();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(second.value.send).not.toHaveBeenCalled();
  });

  it("keeps native Home/End and paste encoding and ignores IME shortcuts", async () => {
    const pty = connection();
    setup(() => pty.value);
    panel.open();
    await vi.waitFor(() => expect(terminals).toHaveLength(1));
    pty.open();
    const handler = terminals[0].keyHandler;
    for (const key of ["Home", "End"]) {
      const event = { type: "keydown", key, preventDefault: vi.fn() };
      expect(handler(event)).toBe(true);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(handler({ type: "keydown", key: "v", ctrlKey: true })).toBe(true);
    expect(handler({ type: "keydown", key: "ArrowLeft", ctrlKey: true, isComposing: true })).toBe(true);
    expect(pty.value.send).not.toHaveBeenCalled();
  });

  it("restores history into the visible terminal without submitting it", async () => {
    const pty = connection();
    const { state } = setup(() => pty.value);
    state.set("terminal.history", [{ sessionId: "one", command: "echo hello", timestamp: Date.now() }]);
    panel.open();
    await vi.waitFor(() => expect(terminals).toHaveLength(1));
    pty.open();
    panel.openHistoryPalette();
    const row = document.querySelector(".zte-palette-row");
    expect(row).not.toBeNull();
    row.click();
    expect(terminals[0].paste).toHaveBeenCalledWith("echo hello");
    expect(pty.value.send).not.toHaveBeenCalled();
  });

  it("does not execute stale quick suggestions or IME confirmation keys", async () => {
    const pty = connection();
    const { state } = setup(() => pty.value);
    state.set("terminal.sessions", [{ id: "one", type: "local" }]);
    state.set("terminal.quickCommands", { old: "echo old" });
    panel.open();
    await vi.waitFor(() => expect(terminals).toHaveLength(1));
    pty.open();
    panel.openQuickPalette();
    await vi.waitFor(() => expect(document.querySelector(".zte-palette-row")).not.toBeNull());
    const input = document.querySelector('input[placeholder="搜索并执行命令..."]');
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    expect(pty.value.send).not.toHaveBeenCalled();
    expect(input.isConnected).toBe(true);
    input.value = "new query";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(pty.value.send).not.toHaveBeenCalled();
    expect(document.querySelector(".zte-palette-row")).toBeNull();
  });
});
