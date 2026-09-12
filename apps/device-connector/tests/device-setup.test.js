import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  defaultDeviceProjectId,
  defaultDeviceResourceId,
  ensureDeviceTerminalSessions,
  normalizeLocalToolsUrl,
  resolveDeviceWorkspaceRoot
} from "../src/device-setup.mjs";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("Device setup", () => {
  it("derives stable defaults from the current workspace", () => {
    expect(resolveDeviceWorkspaceRoot({
      initialCwd: "/workspace/actual-project",
      cwd: "/workspace/apps/device-connector"
    })).toBe("/workspace/actual-project");
    expect(resolveDeviceWorkspaceRoot({
      configured: "/workspace/explicit",
      initialCwd: "/workspace/actual-project",
      cwd: "/workspace/apps/device-connector"
    })).toBe("/workspace/explicit");
    expect(defaultDeviceProjectId("/workspace/Zion Next")).toBe("zion-next");
    expect(defaultDeviceResourceId("zion-next")).toBe("workspace:zion-next");
  });

  it("only accepts a loopback local-tools endpoint", () => {
    expect(normalizeLocalToolsUrl("http://127.0.0.1:8765/")).toBe(
      "http://127.0.0.1:8765"
    );
    expect(() => normalizeLocalToolsUrl("http://192.168.1.20:8765"))
      .toThrow("must use loopback");
  });

  it("reuses matching sessions and creates one when needed", async () => {
    const reuseFetch = vi.fn(async () => jsonResponse({
      sessions: [
        { id: "other", cwd: "/workspace/other", active: true },
        { id: "match", cwd: "/workspace/project/subdir", active: true },
        {
          id: "additional",
          cwd: `${homedir()}/customer/project`,
          active: true
        },
        {
          id: "inactive-additional",
          cwd: `${homedir()}/customer/old`,
          active: false
        }
      ]
    }));
    await expect(ensureDeviceTerminalSessions({
      localToolsUrl: "http://127.0.0.1:8765",
      workspaceRoot: "/workspace/project",
      additionalRoots: ["~/customer"],
      fetchImpl: reuseFetch
    })).resolves.toEqual(["match", "additional"]);

    const createFetch = vi.fn(async (_url, init = {}) => (
      init.method === "POST"
        ? jsonResponse({ session: { id: "created" } })
        : jsonResponse({ sessions: [] })
    ));
    await expect(ensureDeviceTerminalSessions({
      localToolsUrl: "http://localhost:8765",
      workspaceRoot: "/workspace/project",
      fetchImpl: createFetch
    })).resolves.toEqual(["created"]);
    expect(JSON.parse(createFetch.mock.calls[1][1].body)).toEqual({
      type: "local",
      initial_cwd: "/workspace/project"
    });
  });
});
