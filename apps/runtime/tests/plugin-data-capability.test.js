import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPluginDataFileHost } from "../../../packages/local-tools-client/src/plugin-data-files.mjs";
import { createDeviceServiceClient } from "../src/device-service-client.mjs";

describe("plugin data capability", () => {
  it.each(["1", ""])("rejects old Connector version %s before dispatching a mutation", async (version) => {
    const broker = {
      registeredTargets: () => [{
        node: { registration: { nodeId: "cloud", capabilities: [{ name: "zion.internal.deviceService", version }] } }
      }],
      invoke: vi.fn()
    };
    const client = createDeviceServiceClient({ service: "local-tools", nodeBroker: broker });
    await expect(client.request("/files/write?plugin_data_version=1", {
      method: "POST", body: { path: "/data/dev.identity/user.md", content: "changed" },
      runContext: { target: { nodeId: "cloud" } }
    })).rejects.toThrow("Update the data Node Connector");
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it("keeps runtime-hosted plugin data local in node mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "zion-plugin-data-client-"));
    try {
      const path = join(root, "dev.identity", "user.md");
      const broker = {
        registeredTargets: () => [{
          node: { registration: { nodeId: "cloud", capabilities: [] } }
        }],
        invoke: vi.fn()
      };
      const client = createDeviceServiceClient({
        service: "local-tools",
        nodeBroker: broker,
        dataFiles: createPluginDataFileHost({ root })
      });
      const result = await client.request("/files/write?plugin_data_version=1", {
        method: "POST",
        body: { path, content: "local profile" },
        runContext: { target: { nodeId: "cloud" } }
      });
      expect(result).toMatchObject({ ok: true, plugin_data_version: 1 });
      expect(await readFile(path, "utf8")).toBe("local profile");
      expect(broker.invoke).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
