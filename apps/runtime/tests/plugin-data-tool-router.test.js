import { describe, expect, it, vi } from "vitest";
import { createPluginDataLocations } from "../src/plugin-data-locations.mjs";
import { PluginDataToolRouter } from "../src/plugin-data-tool-router.mjs";

function host(label) {
  return {
    supportedToolNames: ["read", "write", "Bash"],
    getToolDefinitions: vi.fn(() => [{ name: "read" }]),
    listTools: vi.fn(async () => [{ name: "read" }]),
    invoke: vi.fn(async () => ({ ok: true, content: label })),
    registeredTargets: vi.fn(() => [{ id: label }]),
    isOnline: vi.fn(() => true)
  };
}

function invocation(path, {
  name = "read",
  userId = "user:alice",
  spaceId = "space:one"
} = {}) {
  return {
    principal: { userId, spaceId },
    policy: { preset: name === "read" ? "read-only" : "workspace-write" },
    toolCall: {
      name,
      arguments: { path }
    }
  };
}

describe("PluginDataToolRouter", () => {
  it("routes configured plugin paths to the data host and other paths normally", async () => {
    const delegated = host("delegated");
    const dataHost = host("data");
    const router = new PluginDataToolRouter({
      delegated,
      dataHost,
      locations: createPluginDataLocations({ root: "/srv/data" }),
      pluginIds: ["dev.identity"]
    });

    await expect(router.invoke(invocation("/srv/data/dev.identity/user.md")))
      .resolves.toMatchObject({ content: "data" });
    await expect(router.invoke(invocation("/workspace/project/readme.md")))
      .resolves.toMatchObject({ content: "delegated" });
    await expect(router.invoke(invocation("/srv/data/dev.identity/script.sh", {
      name: "Bash"
    }))).resolves.toMatchObject({ content: "delegated" });
  });

  it("allows only the authenticated account's scoped plugin path", async () => {
    const delegated = host("delegated");
    const dataHost = host("data");
    const locations = createPluginDataLocations({
      root: "/srv/data",
      scope: "account"
    });
    const router = new PluginDataToolRouter({
      delegated,
      dataHost,
      locations,
      pluginIds: ["dev.identity"]
    });
    const aliceRoot = locations.forPlugin("dev.identity", invocation("/")).data.root;
    const bobRoot = locations.forPlugin(
      "dev.identity",
      invocation("/", { userId: "user:bob" })
    ).data.root;

    await expect(router.invoke(invocation(`${aliceRoot}/user.md`)))
      .resolves.toMatchObject({ content: "data" });
    await expect(router.invoke(invocation(`${bobRoot}/user.md`)))
      .rejects.toThrow("outside the authenticated account scope");
    expect(delegated.invoke).not.toHaveBeenCalled();
  });

  it("routes the explicit legacy fallback for reads and rejects legacy writes", async () => {
    const delegated = host("delegated");
    const dataHost = host("data");
    const router = new PluginDataToolRouter({
      delegated,
      dataHost,
      locations: createPluginDataLocations({
        root: "/srv/data",
        scope: "account",
        legacyReadAccountId: "user:alice"
      }),
      pluginIds: ["dev.identity"]
    });
    const legacyPath = "/srv/data/dev.identity/user.md";

    await expect(router.invoke(invocation(legacyPath)))
      .resolves.toMatchObject({ content: "data" });
    await expect(router.invoke(invocation(legacyPath, { name: "write" })))
      .rejects.toThrow("outside the authenticated account scope");
  });

  it("marks managed account-volume file calls and fences Node or terminal overrides", async () => {
    const managed = host("managed");
    const root = "/workspace/.zion/plugin-data/dev.identity";
    const router = new PluginDataToolRouter({
      delegated: managed,
      dataHost: managed,
      locations: createPluginDataLocations({
        root: "/workspace/.zion/plugin-data",
        scope: "account",
        accountVolume: true,
        resolveNodeId: () => "managed:alice"
      }),
      pluginIds: ["dev.identity"]
    });

    await router.invoke(invocation(`${root}/user.md`));
    expect(managed.invoke).toHaveBeenCalledWith(expect.objectContaining({
      target: { nodeId: "managed:alice" },
      toolCall: expect.objectContaining({
        arguments: expect.objectContaining({
          path: `${root}/user.md`,
          _plugin_data: true
        })
      })
    }), undefined);
    await expect(router.invoke({
      ...invocation(`${root}/user.md`),
      toolCall: {
        name: "read",
        arguments: {
          path: `${root}/user.md`,
          node_id: "node:other"
        }
      }
    })).rejects.toThrow("bound Node");
    await expect(router.invoke({
      ...invocation(`${root}/user.md`),
      toolCall: {
        name: "read",
        arguments: {
          path: `${root}/user.md`,
          session_id: "terminal:other"
        }
      }
    })).rejects.toThrow("omit terminal");
  });

  it("preserves delegated discovery and target helpers", async () => {
    const delegated = host("delegated");
    const router = new PluginDataToolRouter({
      delegated,
      dataHost: host("data"),
      locations: createPluginDataLocations({ root: "/srv/data" }),
      pluginIds: ["dev.identity"]
    });

    await expect(router.listTools({ policy: {} })).resolves.toEqual([{ name: "read" }]);
    expect(router.getToolDefinitions()).toEqual([{ name: "read" }]);
    expect(router.registeredTargets("project", "read")).toEqual([{ id: "delegated" }]);
    expect(router.isOnline("node")).toBe(true);
  });
});
