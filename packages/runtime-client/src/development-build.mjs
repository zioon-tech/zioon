import { normalizePluginManifest } from "../../plugin-sdk/src/manifest.mjs";
import { parse } from "acorn";

const invalid = (message) => Object.assign(new Error(message), { statusCode: 422, code: "invalid_development_build" });
export function buildFilePath(value) {
  if (typeof value !== "string" || value.startsWith("/") || value.includes("\\") || /^[a-z]+:/i.test(value)) {
    throw invalid("Build file must be a relative path");
  }
  const parts = [];
  for (const part of String(value).replace(/^\.\//, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw invalid("Build file is outside the source directory");
      parts.pop();
    } else parts.push(part);
  }
  const path = parts.join("/");
  if (!/^[a-zA-Z0-9_.\/-]+$/.test(path) || !/\.(?:mjs|js|cjs|json|md|txt|css|html)$/.test(path)
    || parts.some((p) => ["node_modules", ".git"].includes(p) || /^(?:\.env|credentials|secrets)(?:\.|$)/i.test(p))) {
    throw invalid("Build files must be credential-free built JavaScript or text assets");
  }
  return path;
}
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
};
export function normalizeDevelopmentBuild(input) {
  if (!input || input.schemaVersion !== 1 || !input.manifest || !input.files
    || typeof input.files !== "object" || Array.isArray(input.files)
    || Object.keys(input).some((key) => !["schemaVersion", "manifest", "files"].includes(key))) {
    throw invalid("Expected a manifest and built text files");
  }
  let contract;
  try { contract = normalizePluginManifest(input.manifest); }
  catch { throw invalid("Build manifest is invalid"); }
  const files = {};
  if (Object.keys(input.files).length > 64) throw invalid("At most 64 build files are supported");
  for (const name of Object.keys(input.files).sort()) {
    if (name !== buildFilePath(name) || typeof input.files[name] !== "string" || input.files[name].includes("\0")) throw invalid("Invalid build file");
    files[name] = input.files[name].replace(/\r\n/g, "\n");
  }
  for (const entry of Object.values(contract.entries)) {
    if (!Object.hasOwn(files, buildFilePath(entry))) throw invalid(`Build entry is missing: ${entry}`);
  }
  const normalized = { schemaVersion: 1, manifest: canonical(input.manifest), files };
  if (new TextEncoder().encode(JSON.stringify(normalized)).length > 250000) throw invalid("Development build exceeds 250KB; bundle dependencies");
  if (contract.entries.runtime && (contract.runtimeApiVersion !== 2 || contract.name.length > 100
    || new TextEncoder().encode(JSON.stringify(normalized)).length > 190000)) {
    throw invalid("Runtime development requires API 2, a name within 100 characters and a build within 190KB including metadata");
  }
  return normalized;
}

function moduleDependencies(source) {
  let tree;
  try { tree = parse(source, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true }); }
  catch { throw invalid("Development JavaScript must be built, valid module or CommonJS syntax"); }
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    let value;
    if (["ImportDeclaration", "ExportAllDeclaration", "ExportNamedDeclaration", "ImportExpression"].includes(node.type)) value = node.source?.value;
    if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "require") value = node.arguments?.[0]?.value;
    if (typeof value === "string" && /^\.\.?\//.test(value)) found.push(value);
    for (const [key, child] of Object.entries(node)) {
      if (["start", "end", "type"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child === "object") walk(child);
    }
  };
  walk(tree);
  return found;
}
// Read a bounded, literal dependency graph from the governed source service.
// A changing source never becomes the new successful build.
export async function collectDevelopmentBuild(read) {
  const revision = async () => {
    try { return JSON.parse(await read("__revision")).revision; }
    catch (error) { if (error.statusCode === 404) return null; throw error; }
  };
  const before = await revision();
  const manifestText = await read("manifest.json");
  const manifest = JSON.parse(manifestText);
  const contract = normalizePluginManifest(manifest);
  const files = {};
  let bytes = new TextEncoder().encode(manifestText).length;
  async function visit(input) {
    const name = buildFilePath(input);
    if (Object.hasOwn(files, name)) return;
    if (Object.keys(files).length >= 64) throw invalid("Build module limit exceeded; bundle dependencies");
    files[name] = await read(name);
    bytes += new TextEncoder().encode(files[name]).length;
    if (bytes > 250000) throw invalid("Build exceeds 250KB; bundle dependencies");
    if (!/\.(mjs|js|cjs)$/.test(name)) return;
    const parent = name.slice(0, name.lastIndexOf("/") + 1);
    for (const dependency of moduleDependencies(files[name])) await visit(`${parent}${dependency}`);
  }
  for (const entry of Object.values(contract.entries)) await visit(entry);
  const plugin = manifest.zion || manifest;
  for (const asset of [...(plugin.contributes?.styles || []), ...(plugin.assets || [])]) await visit(asset);
  const after = await revision();
  if (before !== after) throw invalid("Source changed during build; try again after the write completes");
  if (before === null) {
    if (manifestText !== await read("manifest.json")) throw invalid("Source manifest changed during build");
    for (const [path, content] of Object.entries(files)) {
      if (content !== await read(path)) throw invalid("Source changed during build; retry after the write completes");
    }
  }
  return normalizeDevelopmentBuild({ schemaVersion: 1, manifest, files });
}
