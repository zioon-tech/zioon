import { afterEach, describe, expect, it } from "vitest";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { CancellationController } from "../../../packages/runtime/src/index";
import { startMultiNodeFixture } from "./helpers/multi-node-fixture.mjs";
import { LocalToolsTerminalInventoryContextProvider } from "../../../extensions/dev.terminal-manager/runtime.js";

let fixture;
afterEach(async () => {
  await fixture?.close();
  fixture = null;
});

describe("multi-Node terminal HTTP and Connector integration", () => {
  it("discovers two identical native IDs and executes read/write/edit/Bash on the selected Node", async () => {
    fixture = await startMultiNodeFixture();
    const response = await fetch(`${fixture.url}/v1/device-services/local-tools/sessions`);
    expect(response.status).toBe(200);
    const inventory = await response.json();
    expect(inventory.sessions).toHaveLength(2);
    const mac = inventory.sessions.find((s) => s.nodeId === "node:mac");
    const cloud = inventory.sessions.find((s) => s.nodeId === "node:cloud");
    expect(mac.id).not.toBe(cloud.id);
    const cloudNode = fixture.nodes.find((n) => n.name === "cloud");
    const macNode = fixture.nodes.find((n) => n.name === "mac");
    let sequence = 0;
    async function invoke(name, args, session = cloud) {
      const id = `integration:${++sequence}`;
      return fixture.broker.invoke({
        invocationId: id, runId: "integration:run", attemptId: "integration:attempt",
        projectId: "fixture",
        policy: { preset: "trusted-automation", allowedTools: [name], allowedTerminalSessionIds: [session.id] },
        toolCall: { id, name, arguments: { ...args, session_id: session.id } }
      }, new CancellationController().signal);
    }
    const cloudPath = join(cloudNode.directory, "README.md");
    expect((await invoke("read", { path: cloudPath })).content).toContain("cloud original");
    expect((await invoke("write", { path: cloudPath, content: "cloud updated" })).ok).toBe(true);
    expect((await invoke("edit", { path: cloudPath, old_string: "updated", new_string: "edited" })).ok).toBe(true);
    expect(await readFile(cloudPath, "utf8")).toBe("cloud edited");
    expect(await readFile(join(macNode.directory, "README.md"), "utf8")).toBe("mac original");
    const bash = await invoke("Bash", { command: "pwd" });
    expect(bash.ok).toBe(true);
    expect(JSON.parse(bash.content).output).toBe(await realpath(cloudNode.directory));
    const denied = await invoke("write", { path: join(macNode.directory, "README.md"), content: "wrong" });
    expect(denied.ok).toBe(false);
    expect(await readFile(join(macNode.directory, "README.md"), "utf8")).toBe("mac original");

    const relayed = await fetch(`${fixture.url}/v1/device-services/local-tools/sessions/${encodeURIComponent(cloud.id)}/exec`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "pwd" })
    });
    expect(relayed.status).toBe(200);
    expect((await relayed.json()).output).toBe(await realpath(cloudNode.directory));
    const fileRelay = await fetch(`${fixture.url}/v1/device-services/local-tools/files/write`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: cloud.id, path: cloudPath, content: "cloud relay" })
    });
    expect(fileRelay.status).toBe(200);
    expect(await readFile(cloudPath, "utf8")).toBe("cloud relay");
    expect(await readFile(join(macNode.directory, "README.md"), "utf8")).toBe("mac original");
    const provider = new LocalToolsTerminalInventoryContextProvider({ service: fixture.terminalService });
    const messages = await provider.contribute([{ role: "user", content: "inspect" }], {
      runId: "integration:context", request: { policy: { allowedTerminalSessionIds: [cloud.id] } },
      signal: new CancellationController().signal
    });
    expect(messages[0].content).toContain(cloud.id);
    expect(messages[0].content).not.toContain(mac.id);
    const refreshed = await provider.contribute(messages, {
      runId: "integration:context", request: { policy: { allowedTerminalSessionIds: [cloud.id] } },
      signal: new CancellationController().signal
    });
    expect(refreshed.filter((message) => message.contextProviderId === provider.id)).toHaveLength(1);
    expect(refreshed.at(-1)).toEqual({ role: "user", content: "inspect" });

    await cloudNode.connector.stop();
    fixture.broker.disconnectNode(cloudNode.nodeId, cloudNode.instanceId);
    const afterOffline = await fixture.terminalService.listInventory();
    expect(afterOffline.sessions.map((s) => s.nodeId)).toEqual(["node:mac"]);
    await expect(invoke("read", { path: cloudPath })).rejects.toThrow("offline");
    expect(macNode.calls.filter((call) => call.path.startsWith("/files/"))).toHaveLength(0);
  }, 20_000);

  it("requires explicit create targets and routes management without changing native IDs", async () => {
    fixture = await startMultiNodeFixture();
    const base = `${fixture.url}/v1/device-services/local-tools`;
    const ambiguous = await fetch(`${base}/sessions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "local" })
    });
    expect(ambiguous.status).toBe(409);
    const response = await fetch(`${base}/sessions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "local", node_id: "node:cloud" })
    });
    expect(response.status).toBe(200);
    const { session } = await response.json();
    expect(session.nodeId).toBe("node:cloud");
    const got = await fetch(`${base}/sessions/${encodeURIComponent(session.id)}`);
    expect((await got.json()).session.id).toBe(session.id);
    const closed = await fetch(`${base}/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
    expect(closed.status).toBe(200);
    const remaining = await fixture.terminalService.listSessions();
    expect(remaining).toHaveLength(2);
    expect(remaining.every((s) => s.nativeSessionId === "same-terminal")).toBe(true);
    await expect(fixture.terminalService.createSession({
      payload: { node_id: "node:cloud" },
      runContext: { policy: { allowedTerminalSessionIds: [remaining[0].id] } }
    })).rejects.toThrow("expand");
    const cloudMachine = (await fixture.terminalService.listInventory()).machines.find((machine) => machine.nodeId === "node:cloud");
    const machine = await fixture.terminalService.getMachine({ machineId: cloudMachine.id });
    expect(machine.nodeId).toBe("node:cloud");
  }, 20_000);
});
