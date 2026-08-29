import { afterEach, describe, expect, it, vi } from "vitest";
import { activate } from "../extensions/dev.terminal-manager/main.js";

function createState() {
  const values = new Map();
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    onDidChange: () => ({ dispose() {} })
  };
}

function createZion() {
  return {
    state: createState(),
    i18n: {
      registerNamespace: vi.fn(() => ({ dispose() {} })),
      t: (key) => key
    },
    messages: { registerContributor: vi.fn(() => ({ dispose() {} })) },
    commands: {
      registerCommand: vi.fn(() => ({ dispose() {} })),
      executeCommand: vi.fn()
    },
    activityBar: { registerItem: vi.fn(() => ({ dispose() {} })) },
    sideBar: {
      registerView: vi.fn(() => ({ dispose() {} })),
      show: vi.fn(),
      hide: vi.fn(),
      activateView: vi.fn()
    },
    slash: { registerCommand: vi.fn(() => ({ dispose() {} })) }
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.zion;
});

describe("terminal machine management tool", () => {
  it("lists concrete session ids separately from machine ids", async () => {
    window.zion = createZion();
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).endsWith("/sessions")) {
        return new globalThis.Response(JSON.stringify({
          sessions: [{ id: "one", type: "local", cwd: "/workspace/project", active: true }]
        }), { status: 200 });
      }
      if (String(url).endsWith("/machines")) {
        return new globalThis.Response(JSON.stringify({ machines: [] }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await activate({ subscriptions: [] });
    const handler = window.zion.state.get("chat.toolHandlers").terminalManage;

    const listed = JSON.parse(await handler({
      action: "list",
      machine_id: "machine:local"
    }));

    expect(listed.session_id_field).toContain("sessions[].session_id");
    expect(listed.session_id_field).toContain("Do not use machine_id");
    expect(listed.sessions[0]).toMatchObject({
      session_id: "one",
      id: "one",
      session_type: "local",
      machine_id: "machine:local"
    });
  });

  it("gets and updates machine information through terminalManage", async () => {
    window.zion = createZion();
    let savedMachines = [];
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if (String(url).endsWith("/sessions")) {
        return new globalThis.Response(JSON.stringify({
          sessions: [{ id: "one", type: "local", cwd: "/workspace/project", active: true }]
        }), { status: 200 });
      }
      if (String(url).endsWith("/machines")) {
        return new globalThis.Response(JSON.stringify({ machines: savedMachines }), { status: 200 });
      }
      if (String(url).includes("/machines/") && options.method === "PATCH") {
        savedMachines = [{
          id: "machine:local",
          name: "Build Mac",
          kind: "local",
          description: "32 GB build machine",
          updated_at: 123
        }];
        return new globalThis.Response(JSON.stringify({
          machine: savedMachines[0]
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await activate({ subscriptions: [] });
    const handler = window.zion.state.get("chat.toolHandlers").terminalManage;

    const before = JSON.parse(await handler({
      action: "get_machine",
      machine_id: "machine:local"
    }));
    expect(before.machine.description).toContain("暂无机器资源信息");

    const after = JSON.parse(await handler({
      action: "update_machine",
      machine_id: "machine:local",
      name: "Build Mac",
      description: "32 GB build machine"
    }));
    expect(after.machine).toMatchObject({
      name: "Build Mac",
      description: "32 GB build machine"
    });

    const allMachines = JSON.parse(await handler({
      action: "list_machines"
    }));
    expect(allMachines).toMatchObject({
      total: 1,
      returned: 1,
      truncated: false,
      machines: [{
        id: "machine:local",
        name: "Build Mac",
        description: "32 GB build machine",
        session_count: 1,
        available_session_count: 1
      }]
    });
  });
});
