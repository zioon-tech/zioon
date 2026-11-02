import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeviceAccessManager,
  FileDeviceAccessPolicyStore,
  normalizeDevicePath,
  pathInsideDeviceRoot
} from "../src/device-access-policy.mjs";

const temporaryRoots = [];

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "zion-device-access-"));
  temporaryRoots.push(root);
  return root;
}

function sessionsResponse(sessions) {
  return new Response(JSON.stringify({ sessions }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function invocation(path, overrides = {}) {
  return {
    policy: {
      preset: "read-only",
      allowedTools: ["read"],
      fileRoots: [],
      allowedTerminalSessionIds: []
    },
    toolCall: {
      id: "call:read",
      name: "read",
      arguments: { path }
    },
    ...overrides
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Device access policy", () => {
  it("normalizes home paths without broadening parent boundaries", () => {
    expect(normalizeDevicePath("~/projects/app", "/Users/test"))
      .toBe("/Users/test/projects/app");
    expect(pathInsideDeviceRoot(
      "/Users/test/projects/app/src/index.js",
      "/Users/test/projects",
      "/Users/test"
    )).toBe(true);
    expect(pathInsideDeviceRoot(
      "/Users/test/projects-other/secret",
      "/Users/test/projects",
      "/Users/test"
    )).toBe(false);
  });

  it("persists owner-managed policy with restricted file permissions", () => {
    const root = temporaryRoot();
    const policyPath = join(root, "state", "device-access.json");
    const store = new FileDeviceAccessPolicyStore({
      path: policyPath,
      home: root,
      defaults: {
        scope: "selected-roots",
        selectedRoots: ["~/projects"]
      },
      now: () => 1234
    });

    expect(store.get()).toMatchObject({
      scope: "selected-roots",
      selectedRoots: [join(root, "projects")]
    });
    expect(JSON.parse(readFileSync(policyPath, "utf8"))).toMatchObject({
      scope: "selected-roots",
      selectedRoots: [join(root, "projects")]
    });
    expect(statSync(policyPath).mode & 0o777).toBe(0o600);

    store.update({
      scope: "registered-projects",
      permissions: { execute: false }
    });

    expect(JSON.parse(readFileSync(policyPath, "utf8"))).toMatchObject({
      scope: "registered-projects",
      permissions: { read: true, write: true, execute: false },
      updatedAt: 1234
    });
    expect(statSync(policyPath).mode & 0o777).toBe(0o600);

    store.update({ permissions: { read: false } });
    expect(store.get().permissions).toEqual({
      read: false,
      write: true,
      execute: false
    });
  });

  it("automatically grants active registered projects and their sessions", async () => {
    const home = temporaryRoot();
    const workspace = join(home, "workspace");
    const project = join(home, "projects", "demo");
    const nested = join(project, "packages", "app");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const manager = new DeviceAccessManager({
      localToolsUrl: "http://127.0.0.1:8765",
      workspaceRoot: workspace,
      scope: "registered-projects",
      home,
      policyPath: join(home, "device-access.json"),
      fetchImpl: vi.fn(async () => sessionsResponse([
        { id: "project-session", type: "local", cwd: nested, active: true },
        { id: "ssh-session", type: "ssh", cwd: "/remote/project", active: true },
        { id: "closed", type: "local", cwd: project, active: false }
      ]))
    });

    const state = await manager.state({ force: true });
    expect(state.discoveredProjects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        root: project,
        sessionIds: ["project-session"]
      }),
      expect.objectContaining({
        root: "/remote/project",
        sessionIds: ["ssh-session"]
      })
    ]));
    expect(state.effectiveRoots).toContain(project);
    expect(state.allowedTerminalSessionIds).toEqual([
      "project-session",
      "ssh-session"
    ]);
    await expect(manager.authorizeInvocation(
      invocation(join(project, "README.md"))
    )).resolves.toMatchObject({
      fileRoots: expect.arrayContaining([project])
    });

    const relativeCall = invocation("src/index.js");
    relativeCall.toolCall.arguments.session_id = "project-session";
    await expect(manager.authorizeInvocation(relativeCall)).resolves.toMatchObject({
      allowedTerminalSessionIds: expect.arrayContaining(["project-session"])
    });
    expect(relativeCall.toolCall.arguments.path).toBe(join(nested, "src/index.js"));
  });

  it("records denied paths and supports one-time or permanent approval", async () => {
    const home = temporaryRoot();
    const workspace = join(home, "workspace");
    const external = join(home, "external", "project");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(external, { recursive: true });
    const manager = new DeviceAccessManager({
      localToolsUrl: "http://127.0.0.1:8765",
      workspaceRoot: workspace,
      home,
      policyPath: join(home, "device-access.json"),
      fetchImpl: vi.fn(async () => sessionsResponse([]))
    });
    const call = invocation(join(external, "README.md"));

    await expect(manager.authorizeInvocation(call)).rejects.toMatchObject({
      code: "DEVICE_ACCESS_APPROVAL_REQUIRED"
    });
    let state = await manager.state();
    expect(state.pendingRequests).toHaveLength(1);

    await manager.approveRequest(state.pendingRequests[0].id, {
      scope: "once"
    });
    await expect(manager.authorizeInvocation(call)).resolves.toMatchObject({
      fileRoots: expect.arrayContaining([external])
    });
    await expect(manager.authorizeInvocation(call)).rejects.toMatchObject({
      code: "DEVICE_ACCESS_APPROVAL_REQUIRED"
    });

    state = await manager.state();
    await manager.approveRequest(state.pendingRequests[0].id, {
      scope: "directory"
    });
    await expect(manager.authorizeInvocation(call)).resolves.toMatchObject({
      fileRoots: expect.arrayContaining([external])
    });
  });

  it("keeps sensitive locations blocked in home mode until approved", async () => {
    const home = temporaryRoot();
    const workspace = join(home, "workspace");
    const sensitiveFile = join(home, ".ssh", "config");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const manager = new DeviceAccessManager({
      localToolsUrl: "http://127.0.0.1:8765",
      workspaceRoot: workspace,
      scope: "home",
      home,
      policyPath: join(home, "device-access.json"),
      fetchImpl: vi.fn(async () => sessionsResponse([]))
    });

    await expect(manager.authorizeInvocation(
      invocation(sensitiveFile)
    )).rejects.toThrow("sensitive path requires Owner approval");
    const [{ id }] = (await manager.state()).pendingRequests;
    await manager.approveRequest(id, { scope: "directory" });
    await expect(manager.authorizeInvocation(
      invocation(sensitiveFile)
    )).resolves.toMatchObject({
      fileRoots: expect.arrayContaining([home])
    });
  });
});
