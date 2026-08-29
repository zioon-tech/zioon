import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate } from "../extensions/dev.tools/main.js";

function createState() {
  const values = new Map();
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    onDidChange: () => ({ dispose() {} })
  };
}

function createZion(pluginManager, pluginInstaller) {
  return {
    state: createState(),
    plugins: pluginManager,
    pluginInstaller,
    i18n: {
      registerNamespace: vi.fn(() => ({ dispose() {} })),
      t: (key) => key
    },
    commands: {
      registerCommand: vi.fn(() => ({ dispose() {} })),
      executeCommand: vi.fn()
    },
    editor: {
      registerDecorator: vi.fn(() => ({ dispose() {} }))
    },
    events: {
      on: vi.fn(() => ({ dispose() {} })),
      emit: vi.fn()
    },
    statusBar: {
      registerItem: vi.fn(() => ({ dispose() {} }))
    },
    settings: {
      registerPage: vi.fn(() => ({ dispose() {} }))
    }
  };
}

class FakeWebSocket {
  constructor(url) {
    this.url = url;
  }

  close() {}
}

describe("pluginsManage development sessions", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete window.zion;
  });

  it("persists startDev and clears the record on stopDev", async () => {
    const plugin = { id: "dev.example", name: "Example", version: "1.0.0", enabled: true, state: "active" };
    const pluginManager = {
      list: vi.fn(() => [plugin]),
      installFromInfo: vi.fn(async () => plugin),
      saveDevSessionRecord: vi.fn(() => true),
      removeDevSessionRecord: vi.fn(() => true)
    };
    const pluginInstaller = {
      installFromDevBase: vi.fn(async () => ({ success: true, plugin }))
    };
    window.zion = createZion(pluginManager, pluginInstaller);

    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).endsWith("/plugins/dev/start")) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            devId: "dev-12345678",
            baseUrl: "/plugins/dev/dev-12345678",
            dir: "/tmp/dev.example"
          }
        }), { status: 200 });
      }
      if (String(url).endsWith("/plugins/dev/stop")) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await activate({ subscriptions: [] });
    const handler = window.zion.state.get("chat.toolHandlers").pluginsManage;

    const started = JSON.parse(await handler({
      action: "startDev",
      path: "/tmp/dev.example"
    }));
    expect(started).toMatchObject({ ok: true, devId: "dev-12345678", plugin: "dev.example" });
    expect(pluginManager.saveDevSessionRecord).toHaveBeenCalledWith({
      pluginId: "dev.example",
      devId: "dev-12345678",
      baseUrl: "http://127.0.0.1:8765/plugins/dev/dev-12345678",
      dir: "/tmp/dev.example"
    });

    await handler({ action: "stopDev", devId: "dev-12345678" });
    expect(pluginManager.removeDevSessionRecord).toHaveBeenCalledWith({ devId: "dev-12345678" });
  });
});
