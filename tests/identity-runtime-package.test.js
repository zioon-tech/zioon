// @vitest-environment node

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimePluginService } from "../apps/runtime/src/runtime-plugin-service.mjs";
import { installRuntimePluginArchive } from "../scripts/install-runtime-plugin.mjs";
import {
  packageIdentityPlugin,
  publishIdentityPluginArchive
} from "../scripts/package-identity-plugin.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("external Identity Runtime package", () => {
  it("registers the built ZIP and verifies the bytes served by Plugin Host", async () => {
    const root = await mkdtemp(join(tmpdir(), "zion-identity-publish-test-"));
    temporaryRoots.push(root);
    const packaged = await packageIdentityPlugin({
      install: false,
      archiveDirectory: root
    });
    let catalog = {
      file_hash: "previous-archive",
      metadata: { version: "0.1.7" }
    };
    let served;
    let uploads = 0;
    const server = createServer(async (request, response) => {
      if (request.url === "/plugins/dev.identity") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: catalog }));
      } else if (request.url === "/plugins/upload") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const incoming = new Request("http://localhost/plugins/upload", {
          method: "POST",
          headers: request.headers,
          body: Buffer.concat(chunks)
        });
        const form = await incoming.formData();
        served = Buffer.from(await form.get("file").arrayBuffer());
        catalog = {
          file_hash: createHash("sha256").update(served).digest("hex"),
          metadata: JSON.parse(form.get("metadata"))
        };
        uploads += 1;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ success: true, metadata: catalog }));
      } else if (request.url === "/plugins/dev.identity/download") {
        response.end(served);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const options = {
        archivePath: packaged.archivePath,
        serviceBaseUrl: `http://127.0.0.1:${server.address().port}`
      };
      const published = await publishIdentityPluginArchive(options);
      expect(published).toMatchObject({
        version: packaged.version,
        archiveSha256: packaged.archiveSha256,
        uploaded: true,
        downloadVerified: true
      });
      expect(served.equals(await readFile(packaged.archivePath))).toBe(true);
      await expect(publishIdentityPluginArchive(options))
        .resolves.toMatchObject({ uploaded: false, downloadVerified: true });
      expect(uploads).toBe(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("builds, installs, and activates the Runtime entry from the ZIP", async () => {
    const root = await mkdtemp(join(tmpdir(), "zion-identity-package-test-"));
    temporaryRoots.push(root);
    const packaged = await packageIdentityPlugin({
      install: false,
      archive: true,
      archiveDirectory: join(root, "archives")
    });
    const installed = await installRuntimePluginArchive({
      archivePath: packaged.archivePath,
      pluginRoot: join(root, "plugins"),
      expectedPluginId: "dev.identity"
    });

    expect(installed).toMatchObject({
      id: "dev.identity",
      version: packaged.version,
      runtimeEntry: "dist/runtime.js"
    });
    expect(JSON.parse(
      await readFile(join(installed.installDirectory, "manifest.json"), "utf8")
    )).toMatchObject({
      version: packaged.version,
      zion: {
        entries: {
          ui: "./dist/main.js",
          runtime: "./dist/runtime.js"
        }
      }
    });
    expect((await stat(
      join(installed.installDirectory, "dist", "runtime.js")
    )).size).toBeGreaterThan(50_000);

    const service = new RuntimePluginService({
      pluginRoots: [{
        path: join(root, "plugins"),
        origin: "external"
      }],
      enabledPluginIds: ["dev.identity"],
      externalizedPluginIds: ["dev.identity"],
      configByPluginId: {
        "dev.identity": {
          fileService: {
            readTextFiles: async ({ fileRoot, files }) => ({
              fileRoot,
              files: Object.fromEntries(
                Object.keys(files).map((key) => [key, ""])
              )
            }),
            writeTextFiles: async () => ({ written: [] })
          },
          modelService: {
            generateText: async () => "{\"events\":[]}"
          },
          biography: {
            enabled: true,
            memoryRoot: "/tmp/zion-identity-memory"
          }
        }
      }
    });
    const snapshot = await service.start();
    try {
      expect(snapshot.plugins).toEqual([
        expect.objectContaining({
          id: "dev.identity",
          version: packaged.version,
          origin: "external",
          status: "active",
          contextProviderIds: ["dev.identity.context"],
          postProcessorIds: ["dev.identity.biography"],
          toolNames: [
            "identityContext",
            "identityManage",
            "projectAutomationManage"
          ]
        })
      ]);
    } finally {
      await service.stop();
    }
  });
});
