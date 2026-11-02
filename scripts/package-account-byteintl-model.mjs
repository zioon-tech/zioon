import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeExtensionPackage } from "../packages/runtime-client/src/extension-package.mjs";

export async function packAccountByteIntlModel() {
  const files = {};
  for (const name of ["model-provider.js", "byteintl-adapter.js"]) {
    files[name] = await readFile(new URL(`../extensions/dev.byteintl-model/${name}`, import.meta.url), "utf8");
  }
  return normalizeExtensionPackage({
    schemaVersion: 1, kind: "plugin", manifest: {
      slug: "byteintl-model", name: "ByteIntl 模型", summary: "通过已授权内网设备使用 ByteIntl 模型",
      version: "0.2.1", category: "开发", license: "UNLICENSED"
    },
    plugin: {
      manifestVersion: 2, id: "dev.byteintl-model", name: "ByteIntl 模型", version: "0.2.1",
      entries: { runtime: "./model-provider.js" }, runtime: { apiVersion: 2 },
      capabilities: [{ id: "byteintl", kind: "model", host: "runtime", models: [{
        id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite · ByteIntl", supportsStreaming: false, supportsTools: true
      }] }],
      connection: { label: "ByteIntl", envKeys: ["BYTEINTL_AK"], required: true }
    }, files
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf("--out");
  if (index < 0 || !process.argv[index + 1]) throw new Error("Usage: node scripts/package-account-byteintl-model.mjs --out <new-file.json>");
  const file = resolve(process.argv[index + 1]);
  const artifact = await packAccountByteIntlModel();
  await writeFile(file, JSON.stringify(artifact, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  process.stdout.write(JSON.stringify({ file, digest: artifact.digest, version: artifact.manifest.version }) + "\n");
}
