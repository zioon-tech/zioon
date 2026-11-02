import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginFilesHttpHandler } from "../src/plugin-files-http-handler.mjs";

const servers = [];

async function start(handler) {
  const server = createServer(async (request, response) => {
    request.zionPrincipal = {
      kind: "account",
      user: { id: "user:owner" },
      space: { id: "space:one" }
    };
    if (!await handler(
      request,
      response,
      new URL(request.url, "http://runtime.test")
    )) {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise((resolve) => server.close(resolve))
  ));
});

describe("plugin files HTTP handler", () => {
  it("serves relative plugin files through an authenticated execution context", async () => {
    const fileService = {
      readTextFile: vi.fn(async ({ relativePath }) => ({
        path: `/workspace/.zion/plugin-data/dev.identity/${relativePath}`,
        content: "# User",
        contentHash: "hash:read",
        missing: false
      })),
      writeTextFile: vi.fn(async ({ relativePath }) => ({
        path: `/workspace/.zion/plugin-data/dev.identity/${relativePath}`,
        contentHash: "hash:write",
        written: true,
        created: false
      })),
      listEntries: vi.fn(async () => ({
        path: "/workspace/.zion/plugin-data/dev.identity/projects",
        entries: [{
          name: "zion-next",
          path: "/workspace/.zion/plugin-data/dev.identity/projects/zion-next",
          type: "directory"
        }],
        missing: false
      })),
      readJsonlPage: vi.fn(async () => ({
        path: "/workspace/.zion/plugin-data/dev.identity/biography/events.jsonl",
        content: '{"id":"event:2"}',
        contentHash: "hash:jsonl",
        startLine: 2,
        endLine: 2,
        previousOffset: 1,
        hasPrevious: true,
        hasMore: false,
        missing: false
      })),
      appendJsonl: vi.fn(async () => ({
        ok: true,
        appended: ["event:3"],
        skipped: []
      }))
    };
    const withRunContext = vi.fn(async (_actor, _request, operation) =>
      await operation({
        principal: { userId: "user:owner", spaceId: "space:one" },
        policy: { fileRoots: ["/workspace/.zion/plugin-data/dev.identity"] }
      })
    );
    const baseUrl = await start(createPluginFilesHttpHandler({
      pluginId: "dev.identity",
      fileService,
      withRunContext
    }));

    const read = await fetch(
      `${baseUrl}/v1/plugins/dev.identity/files/read?path=user.md`
    ).then((response) => response.json());
    expect(read).toMatchObject({
      content: "# User",
      content_hash: "hash:read"
    });

    const entries = await fetch(
      `${baseUrl}/v1/plugins/dev.identity/files/entries?path=projects`
    ).then((response) => response.json());
    expect(entries.entries[0]).toMatchObject({
      name: "zion-next",
      type: "directory"
    });

    const page = await fetch(
      `${baseUrl}/v1/plugins/dev.identity/files/read-jsonl`
      + "?path=biography%2Fevents.jsonl&offset=2&limit=1"
    ).then((response) => response.json());
    expect(page).toMatchObject({
      content: '{"id":"event:2"}',
      start_line: 2,
      has_previous: true
    });

    const write = await fetch(
      `${baseUrl}/v1/plugins/dev.identity/files/write`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "user.md",
          content: "# Updated",
          expected_hash: "hash:read"
        })
      }
    ).then((response) => response.json());
    expect(write).toMatchObject({
      written: true,
      content_hash: "hash:write"
    });
    expect(fileService.writeTextFile).toHaveBeenCalledWith(expect.objectContaining({
      relativePath: "user.md",
      expectedHash: "hash:read"
    }));

    const append = await fetch(
      `${baseUrl}/v1/plugins/dev.identity/files/append-jsonl`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "biography/events.jsonl",
          records: [{ id: "event:3" }]
        })
      }
    ).then((response) => response.json());
    expect(append.appended).toEqual(["event:3"]);
    expect(withRunContext).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "account" }),
      expect.objectContaining({
        pluginId: "dev.identity",
        access: "write",
        toolNames: ["read", "write"]
      }),
      expect.any(Function)
    );
  });

  it("rejects absolute and escaping paths before calling the file service", async () => {
    const fileService = {
      readTextFile: vi.fn(),
      writeTextFile: vi.fn(),
      listEntries: vi.fn(),
      readJsonlPage: vi.fn(),
      appendJsonl: vi.fn()
    };
    const baseUrl = await start(createPluginFilesHttpHandler({
      pluginId: "dev.identity",
      fileService,
      withRunContext: vi.fn()
    }));

    for (const path of ["/etc/passwd", "../other/user.md"]) {
      const response = await fetch(
        `${baseUrl}/v1/plugins/dev.identity/files/read?path=${encodeURIComponent(path)}`
      );
      expect(response.status).toBe(400);
    }
    expect(fileService.readTextFile).not.toHaveBeenCalled();
  });
});
