import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CancellationController } from "../../../packages/runtime/src/index";
import { createPluginFileService } from "../src/plugin-file-service.mjs";
import { createDeviceServiceClient } from "../src/device-service-client.mjs";
import { startMultiNodeFixture } from "./helpers/multi-node-fixture.mjs";

describe("plugin data on a real Connector route", () => {
  it("uses the same physical files through read/write/edit/Bash and UI with the laptop stopped", async () => {
    const fixture = await startMultiNodeFixture({ pluginData: true });
    try {
      const cloud = fixture.nodes.find((node) => node.name === "cloud");
      const laptop = fixture.nodes.find((node) => node.name === "mac");
      const root = join(cloud.directory, "dev.identity");
      const fileService = createPluginFileService({
        toolHost: fixture.broker,
        dataLocation: { nodeId: cloud.nodeId, root },
        fileClient: createDeviceServiceClient({ service: "local-tools", nodeBroker: fixture.broker })
      });
      const runContext = { projectId: "fixture", policy: { fileRoots: [root] } };
      await fileService.writeTextFiles({
        files: { user: { relativePath: "user.md", content: "original" } }, runContext
      });
      const invoke = async (name, args, target = cloud.nodeId) => {
        const id = randomUUID();
        return fixture.broker.invoke({
          invocationId: id, runId: id, attemptId: id, projectId: "fixture",
          target: { nodeId: target },
          policy: { preset: "trusted-automation", allowedTools: ["read", "write", "edit", "Bash"], fileRoots: [root] },
          toolCall: { id, name, arguments: { ...args, node_id: target } }
        }, new CancellationController().signal);
      };
      expect((await invoke("edit", { path: join(root, "user.md"), old_string: "original", new_string: "edited" })).ok).toBe(true);
      const command = `printf '%s' 'from bash' > ${JSON.stringify(join(root, "user.md"))}`;
      expect((await invoke("Bash", { command })).ok).toBe(true);
      const read = await invoke("read", { path: join(root, "user.md") });
      expect(JSON.parse(read.content).content).toBe("from bash");
      await laptop.connector.stop();
      fixture.broker.disconnectNode(laptop.nodeId, laptop.instanceId);
      const response = await fetch(`${fixture.url}/v1/device-services/local-tools/files/read?${new URLSearchParams({
        path: join(root, "user.md"), node_id: cloud.nodeId, project_id: "fixture"
      })}`);
      expect(response.status).toBe(200);
      expect((await response.json()).content).toBe("from bash");
      await Promise.all(["a", "b"].map((id) => fileService.appendJsonl({
        relativePath: "biography/events.jsonl", records: [{ id }], runContext
      })));
      const history = await fileService.readTextFiles({
        files: { events: "biography/events.jsonl" }, runContext
      });
      expect(history.files.events.trim().split("\n")).toHaveLength(2);
      await cloud.connector.stop();
      fixture.broker.disconnectNode(cloud.nodeId, cloud.instanceId);
      await expect(invoke("read", { path: join(root, "user.md") })).rejects.toThrow(/offline|No online|not registered/i);
    } finally { await fixture.close(); }
  }, 15000);
});
