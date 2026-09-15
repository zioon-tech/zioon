import { describe, expect, it, vi } from "vitest";
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
});
