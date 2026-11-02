import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  installRuntimePluginArchive
} from "../scripts/install-runtime-plugin.mjs";
import {
  packageByteIntlModelPlugin
} from "../scripts/package-byteintl-model-plugin.mjs";

const directories = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  for (const directory of directories.splice(0).reverse()) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("ByteIntl Runtime plugin package", () => {
  it("packages and installs a self-contained Runtime plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "zion-byteintl-package-test-"));
    directories.push(root);
    const installDirectory = join(root, "local", "dev.byteintl-model");
    const archiveDirectory = join(root, "archives");
    const result = await packageByteIntlModelPlugin({
      installDirectory,
      archiveDirectory
    });

    expect(result).toMatchObject({
      id: "dev.byteintl-model",
      version: "0.1.0",
      installDirectory
    });
    expect(result.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(stat(join(installDirectory, "runtime.js")))
      .resolves.toMatchObject({ isFile: expect.any(Function) });

    const zip = await JSZip.loadAsync(await readFile(result.archivePath));
    expect(zip.file("manifest.json")).toBeTruthy();
    expect(zip.file("runtime.js")).toBeTruthy();
    expect(zip.file("byteintl-adapter.js")).toBeTruthy();
    expect(zip.file("install-profile.mjs")).toBeTruthy();
    expect(zip.file("package.json")).toBeTruthy();

    const installed = await installRuntimePluginArchive({
      archivePath: result.archivePath,
      pluginRoot: join(root, "runtime-plugins"),
      expectedPluginId: "dev.byteintl-model"
    });
    expect(installed).toMatchObject({
      id: "dev.byteintl-model",
      version: "0.1.0"
    });
    await expect(readFile(
      join(installed.installDirectory, "package.json"),
      "utf8"
    )).resolves.toContain('"type": "module"');

    const runtimePluginServiceUrl = pathToFileURL(join(
      process.cwd(),
      "apps/runtime/src/runtime-plugin-service.mjs"
    )).href;
    const childSource = `
      const { RuntimePluginService } = await import(process.argv[1]);
      const service = new RuntimePluginService({
        pluginRoots: [{ path: process.argv[2], origin: "external" }],
        enabledPluginIds: ["dev.byteintl-model"],
        externalizedPluginIds: ["dev.byteintl-model"],
        configByPluginId: {
          "dev.byteintl-model": {
            adapter: {
              model: "gpt-6-astra",
              host: "127.0.0.1",
              port: 0
            }
          }
        }
      });
      const started = await service.start();
      const stopped = await service.stop();
      process.stdout.write(JSON.stringify({ started, stopped }));
    `;
    const loaded = JSON.parse((await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      childSource,
      runtimePluginServiceUrl,
      join(root, "runtime-plugins")
    ])).stdout);
    expect(loaded.started).toMatchObject({
      state: "started",
      plugins: [{
        id: "dev.byteintl-model",
        version: "0.1.0",
        origin: "external",
        status: "active"
      }],
      failures: []
    });
    expect(loaded.stopped).toMatchObject({
      state: "stopped",
      plugins: [{
        id: "dev.byteintl-model",
        status: "stopped"
      }]
    });
  });
});
