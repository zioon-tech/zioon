// @vitest-environment node

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimePluginService } from "../apps/runtime/src/runtime-plugin-service.mjs";
import { installRuntimePluginArchive } from "../scripts/install-runtime-plugin.mjs";
import { packageIdentityPlugin } from "../scripts/package-identity-plugin.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("external Identity Runtime package", () => {
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
