import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jwtVerify } from "jose";
import { createAgentFsMemoryClient } from "../src/agentfs-memory-client.mjs";
import { createMemoryAccountAuthorization, memoryConnectionDirectory } from "../src/accounts/memory-account-connection.mjs";
import { importMemoryFiles } from "../../../scripts/connect-local-identity-memory.mjs";
import { contentHash } from "../../../packages/local-tools-client/src/plugin-data-files.mjs";

const cleanup = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
const baseUrl = "https://runtime.zioon.tech/memory";
const filePath = "/memory/dev.identity/user.md";
const context = {
  principal: { kind: "account", user: { id: "local-user" }, space: { id: "local-space" } },
  policy: { preset: "workspace-write", fileRoots: ["/memory/dev.identity"] }
};
const remote = {
  authenticated: true, user: { id: "remote-user" }, space: { id: "remote-space" },
  membership: { status: "active" }, scopes: ["runtime.read", "runtime.write"]
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "memory-account-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = memoryConnectionDirectory(directory, { userId: "local-user", spaceId: "local-space" });
  await mkdir(path);
  const config = {
    apiUrl: baseUrl, apiKey: "zion_account_v1.fixture", defaultOrg: "org", defaultDrive: "drive",
    zionAccount: { apiUrl: baseUrl, runtimeUrl: "https://runtime.zioon.tech", expiresAt: Date.now() + 60000 }
  };
  const binding = {
    apiUrl: baseUrl, runtimeUrl: "https://runtime.zioon.tech",
    localUserId: "local-user", localSpaceId: "local-space",
    remoteUserId: "remote-user", remoteSpaceId: "remote-space", orgId: "org", driveId: "drive"
  };
  const save = async () => {
    await writeFile(join(path, "config.json"), JSON.stringify(config));
    await writeFile(join(path, "binding.json"), JSON.stringify(binding));
  };
  await save();
  const accessControl = {
    reauthorize: vi.fn(async () => {}),
    accounts: {
      membership: vi.fn(async () => ({ role: "owner", status: "active" })),
      getUser: vi.fn(async (id) => ({ id })),
      space: vi.fn(async (id) => ({ id }))
    }
  };
  const fetchImpl = vi.fn(async () => Response.json(remote));
  const authorize = createMemoryAccountAuthorization({ directory, baseUrl, accessControl, fetchImpl });
  return { config, binding, save, accessControl, fetchImpl, authorize };
}

describe("explicit online Memory account connection", () => {
  it("keeps the public prefix while binding a bridge token to the service-relative request", async () => {
    const secret = "a".repeat(32);
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    const client = createAgentFsMemoryClient({ baseUrl, secret, fetchImpl });
    await client.request(`/files/read?path=${encodeURIComponent(filePath)}`, { runContext: context });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url.pathname).toBe("/memory/zion/files/read");
    const token = options.headers.authorization.replace("Bearer zm_", "");
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    expect(payload.path).toBe(`/zion/files/read?path=${encodeURIComponent(filePath)}`);
  });

  it("reauthorizes the local account and checks the exact remote identity on each request", async () => {
    const f = await fixture();
    expect(await f.authorize({ runContext: context, filePath, write: true })).toBe("Bearer zion_account_v1.fixture");
    expect(f.accessControl.reauthorize).toHaveBeenCalledWith(context.principal, "runtime.write");
    expect(f.fetchImpl.mock.calls[0][0].href).toBe("https://runtime.zioon.tech/v1/account/me");
    f.fetchImpl.mockResolvedValueOnce(Response.json({ ...remote, space: { id: "different-space" } }));
    await expect(f.authorize({ runContext: context, filePath, write: false })).rejects.toMatchObject({
      code: "memory_connection_mismatch"
    });
  });

  it("cannot borrow another local account's saved connection", async () => {
    const f = await fixture();
    await expect(f.authorize({ runContext: {
      ...context, principal: { ...context.principal, user: { id: "another-user" } }
    }, filePath, write: false })).rejects.toMatchObject({ code: "memory_login_required" });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects local revocation and disallowed paths before using the remote credential", async () => {
    const f = await fixture();
    await expect(f.authorize({ runContext: context, filePath: "/other/file", write: false })).rejects.toThrow("grant");
    f.accessControl.reauthorize.mockRejectedValueOnce(new Error("session revoked"));
    await expect(f.authorize({ runContext: context, filePath, write: false })).rejects.toThrow("revoked");
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects expired login, altered drive and remote write denial", async () => {
    const f = await fixture();
    f.config.zionAccount.expiresAt = 1;
    await f.save();
    await expect(f.authorize({ runContext: context, filePath, write: false })).rejects.toMatchObject({ code: "memory_login_expired" });
    f.config.zionAccount.expiresAt = Date.now() + 60000;
    f.config.defaultDrive = "other-drive";
    await f.save();
    await expect(f.authorize({ runContext: context, filePath, write: false })).rejects.toMatchObject({ code: "memory_connection_mismatch" });
    f.config.defaultDrive = "drive";
    await f.save();
    f.fetchImpl.mockResolvedValueOnce(Response.json({ ...remote, scopes: ["runtime.read"] }));
    await expect(f.authorize({ runContext: context, filePath, write: true })).rejects.toMatchObject({ code: "memory_permission_denied" });
  });

  it("rechecks an execution grant's current policy before linking its identity", async () => {
    const f = await fixture();
    const principal = { version: 1, kind: "user", userId: "local-user", spaceId: "local-space", grantId: "grant" };
    f.accessControl.accounts.validateGrant = vi.fn(async () => ({ principal, scopes: remote.scopes }));
    f.accessControl.authorizeRunExecution = vi.fn(async () => ({ preset: "read-only", fileRoots: ["/memory/dev.identity"] }));
    await expect(f.authorize({ runContext: { principal, policy: context.policy }, filePath, write: true })).rejects.toThrow("denied");
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it("requires the local grant's memory scope as well as the remote account's permission", async () => {
    const f = await fixture();
    const principal = { version: 1, kind: "user", userId: "local-user", spaceId: "local-space", grantId: "grant" };
    f.accessControl.accounts.validateGrant = vi.fn(async () => ({ principal, scopes: ["run.execute"] }));
    f.accessControl.authorizeRunExecution = vi.fn(async () => context.policy);
    await expect(f.authorize({ runContext: { principal, policy: context.policy }, filePath, write: true }))
      .rejects.toMatchObject({ code: "memory_permission_denied" });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it("will not send the saved credential to a different identity origin", async () => {
    const f = await fixture();
    f.binding.runtimeUrl = "https://different.test";
    f.config.zionAccount.runtimeUrl = f.binding.runtimeUrl;
    await f.save();
    await expect(f.authorize({ runContext: context, filePath, write: false })).rejects.toMatchObject({
      code: "memory_connection_mismatch"
    });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("online Memory migration", () => {
  it("preflights every target file before writing and preserves conflicting bytes", async () => {
    const remoteRequest = vi.fn(async () => ({ content: "online memory" }));
    await expect(importMemoryFiles([{ path: "user.md", content: "local memory" }], remoteRequest)).rejects.toThrow("without overwrite");
    expect(remoteRequest).toHaveBeenCalledTimes(1);
  });

  it("uses create-only imports and verifies bytes, including a resumable identical file", async () => {
    const files = [{ path: "user.md", content: "# User\n" }];
    let stored;
    const remoteRequest = vi.fn(async (_operation, body) => {
      if (body) {
        expect(body.create_only).toBe(true);
        stored ??= body.content;
        return { content_hash: contentHash(stored) };
      }
      if (stored === undefined) throw Object.assign(new Error("missing"), { statusCode: 404 });
      return { content: stored };
    });
    await importMemoryFiles(files, remoteRequest);
    await importMemoryFiles(files, remoteRequest);
    expect(stored).toBe("# User\n");
  });
});
