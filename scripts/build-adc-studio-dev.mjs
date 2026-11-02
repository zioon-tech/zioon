import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(repository, "extensions/dev.adc-studio");
const destination = process.env.ADC_STUDIO_DEV_DIR || resolve(homedir(), ".zion-next/plugins/dev.adc-studio");
const nodeId = process.env.ADC_STUDIO_SOURCE_NODE || "node:jx3wjqj1hy";
const runtimeOrigin = process.env.ADC_STUDIO_RUNTIME_ORIGIN || "https://runtime.zioon.tech";
const devId = `dev-${createHash("sha256").update(destination).digest("hex").slice(0, 8)}`;
const entry = new URL(`/v1/device-services/plugin-service/plugins/dev/${devId}/main.js`, runtimeOrigin);
entry.searchParams.set("node_id", nodeId);
const require = createRequire(resolve(repository, "package.json"));
const { build, context } = require("esbuild");
await mkdir(destination, { recursive: true });
const options = { entryPoints: [resolve(source, "workbench-dev.mjs")], outfile: resolve(destination, "main.js"),
  bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true,
  define: { ADC_STUDIO_DEV_ENTRY: JSON.stringify(entry.href) },
  plugins: [{
    name: "text-assets",
    setup(build) {
      build.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace(/\?raw$/, "")), namespace: "text-assets" }));
      build.onLoad({ filter: /.*/, namespace: "text-assets" }, async args =>
        ({ contents: await readFile(args.path, "utf8"), loader: "text", watchFiles: [args.path] }));
    }
  }] };
const manifest = { name: "dev.adc-studio", version: "0.1.2",
  description: "ADC Studio 开发面板，复用当前账户已有 ADC 连接。",
  zion: { manifestVersion: 2, id: "dev.adc-studio", name: "ADC Studio · 开发", version: "0.1.2",
    entries: { workbench: "./main.js" }, hosts: { workbench: true, runtime: false },
    contributes: { commands: [{ id: "adc-studio.open", title: "ADC Studio: 打开设备工作台" }] },
    activationEvents: ["onStartupFinished"] } };
await writeFile(resolve(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
if (process.argv.includes("--watch")) {
  const watcher = await context(options); await watcher.watch();
  console.log(`Watching ADC Studio source: ${source}\nDevelopment directory: ${destination}`);
} else await build(options);
if (process.argv.includes("--pack")) {
  const JSZip = require("jszip"), zip = new JSZip();
  const portable = { ...manifest, zion: { ...manifest.zion, entries: { workbench: "./main.js" } } };
  zip.file("manifest.json", JSON.stringify(portable, null, 2));
  zip.file("main.js", await readFile(resolve(destination, "main.js")));
  const output = resolve(repository, "../../ADC-STUDIO-20261025/ADC-Studio-dev-0.1.2.zip");
  await writeFile(output, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  console.log(`Development bootstrap ZIP: ${output}`);
}
console.log(JSON.stringify({ source, destination, devId, nodeId, entry: entry.href }, null, 2));
