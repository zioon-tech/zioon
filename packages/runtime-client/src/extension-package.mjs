import { createHash } from "node:crypto";
import { normalizePluginManifest, validateToolInput } from "../../plugin-sdk/src/manifest.mjs";
import { normalizeSkillPackage, privateSkillRelease } from "./skill-package.mjs";
import { safePackagePath } from "./package-files.mjs";

const fail = (message) => { throw Object.assign(new Error(message), { statusCode: 422, code: "invalid_extension_package" }); };
export const hashExtension = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const only = (value, keys) => {
  if (!isObject(value) || Object.keys(value).some((key) => !keys.includes(key))) fail("Unsupported extension fields");
};
const text = (value, max = 1000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) fail("Invalid extension text");
  return value;
};
export function safeExtensionPath(value) {
  return safePackagePath(value);
}

export function normalizeExtensionPackage(input) {
  if (input?.kind === "skill") return normalizeSkillPackage(input);
  only(input, ["schemaVersion", "kind", "manifest", "plugin", "mcp", "files", "digest"]);
  if (input.schemaVersion !== 1 || !["plugin", "mcp"].includes(input.kind)) fail("Expected skill, plugin or mcp schemaVersion 1 package");
  const manifest = normalizeSkillPackage({ schemaVersion: 1, kind: "skill", manifest: input.manifest,
    body: "---\nname: extension\ndescription: extension\n---\n" }).manifest;
  const files = {};
  if (input.files !== undefined) {
    if (!isObject(input.files) || Object.keys(input.files).length > 64) fail("At most 64 text files are supported");
    for (const name of Object.keys(input.files).sort()) {
      safeExtensionPath(name);
      if (!/\.(?:mjs|js|cjs|json|md|txt|css|html)$/.test(name)) fail("Only built JavaScript and text assets are supported");
      if (typeof input.files[name] !== "string" || input.files[name].includes("\0")) fail("File must be UTF-8 text");
      files[name] = input.files[name].replace(/\r\n/g, "\n");
    }
  }
  let content;
  if (input.kind === "plugin") {
    if (input.mcp !== undefined) fail("Plugin cannot include an MCP definition");
    const plugin = normalizePluginManifest(input.plugin);
    if (plugin.version !== manifest.version || plugin.runtimeApiVersion !== 2 || !plugin.entries.runtime) fail("Tool plugin requires matching version and runtime API 2 entry");
    for (const entry of Object.values(plugin.entries)) {
      const name = safeExtensionPath(entry.replace(/^\.\//, ""));
      if (!Object.hasOwn(files, name)) fail(`Plugin entry not packaged: ${name}`);
    }
    if (!/\.(?:mjs|js|cjs)$/.test(plugin.entries.runtime)) fail("Runtime entry must be built JavaScript");
    if (plugin.capabilities.some((c) => c.host === "runtime"
      && !["tool", "context", "controller", "post-processor", "model", "job", "command"].includes(c.kind))) fail("Unsupported runtime contribution");
    const styles = (input.plugin.zion || input.plugin).contributes?.styles;
    if (styles !== undefined && (!Array.isArray(styles) || styles.length > 32
      || styles.some((path) => typeof path !== "string" || !path.endsWith(".css")
        || !Object.hasOwn(files, safeExtensionPath(path.replace(/^\.\//, "")))))) fail("Styles must be packaged CSS files");
    content = { plugin: { manifestVersion: plugin.manifestVersion, id: plugin.id,
      name: plugin.name, version: plugin.version, entries: plugin.entries,
      hosts: plugin.hosts, capabilities: plugin.capabilities, runtime: { apiVersion: 2 },
      ...(plugin.settingsSchema ? { settingsSchema: plugin.settingsSchema } : {}),
      ...(styles?.length ? { contributes: { styles: [...styles] } } : {}),
      ...(plugin.connection ? { connection: plugin.connection } : {}) }, files };
  } else {
    if (input.plugin !== undefined) fail("MCP cannot include a plugin definition");
    only(input.mcp, ["transport", "command", "args", "envKeys", "endpoint"]);
    const source = input.mcp;
    if (!["stdio", "http"].includes(source.transport)) fail("MCP transport must be stdio or http");
    if (source.transport === "stdio") {
      if (source.endpoint !== undefined) fail("stdio cannot declare endpoint");
      const command = text(source.command, 500);
      if (!Array.isArray(source.args) || source.args.length > 32 || source.args.some((v) => typeof v !== "string" || v.length > 2000 || v.includes("\0"))) fail("MCP args must be bounded strings");
      const envKeys = source.envKeys ?? [];
      if (!Array.isArray(envKeys) || envKeys.length > 20 || envKeys.some((key) =>
        !/^[A-Z][A-Z0-9_]{0,79}$/.test(key) || /^(?:NODE_OPTIONS|NODE_PATH|LD_|DYLD_|PATH$|HOME$)/.test(key))) fail("Invalid MCP envKeys");
      content = { mcp: { transport: "stdio", command, args: [...source.args], envKeys: [...new Set(envKeys)].sort() }, files };
    } else {
      if (source.command !== undefined || source.args !== undefined || source.envKeys !== undefined || Object.keys(files).length) fail("HTTP MCP only declares endpoint");
      let url;
      try { url = new URL(text(source.endpoint)); } catch { fail("Invalid MCP endpoint"); }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) fail("MCP endpoint must be credential-free HTTP(S), without query or fragment");
      if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) fail("Remote MCP requires HTTPS");
      content = { mcp: { transport: "http", endpoint: url.href }, files };
    }
  }
  const normalized = { schemaVersion: 1, kind: input.kind, manifest, ...content };
  if (Buffer.byteLength(JSON.stringify(normalized)) > 200000) fail("Extension artifact exceeds 200KB");
  const digest = hashExtension(normalized);
  if (input.digest !== undefined && input.digest !== digest) throw Object.assign(new Error("Extension package digest mismatch"), { statusCode: 409, code: "digest_mismatch" });
  return { ...normalized, digest };
}

export function privateExtensionRelease(input, userId, userName) {
  const artifact = normalizeExtensionPackage(input);
  if (artifact.kind === "skill") return privateSkillRelease(artifact, userId, userName);
  const { manifest } = artifact;
  const publisherId = `u${createHash("sha256").update(userId).digest("hex").slice(0, 16)}`;
  return {
    id: `private.${publisherId}.${manifest.slug}`, name: manifest.name, summary: manifest.summary,
    category: manifest.category, kind: artifact.kind, version: manifest.version,
    publisher: { id: publisherId, name: String(userName || "我的账户").slice(0, 100), origin: "private" },
    ...(manifest.sourceUrl ? { sourceUrl: manifest.sourceUrl } : {}),
    license: manifest.license, description: manifest.description, changelog: manifest.changelog,
    visibility: "private", artifact,
    components: [{ id: manifest.slug, kind: artifact.kind, name: manifest.name, description: manifest.summary }]
  };
}

export function publicExtensionRelease(input, userId, userName) {
  const artifact = normalizeExtensionPackage(input);
  if (!artifact.manifest.sourceUrl) fail("Public packages require a sourceUrl");
  const release = privateExtensionRelease(artifact, userId, userName);
  return { ...release, id: `${release.publisher.id}.${artifact.manifest.slug}`,
    publisher: { ...release.publisher, origin: "community" }, visibility: "public", artifact };
}

export function normalizeExtensionConfig(input) {
  only(input, ["nodeId", "workspaceRoot", "credentialsFile", "settings"]);
  const nodeId = text(input.nodeId, 200);
  const workspaceRoot = text(input.workspaceRoot, 500).replace(/\/+$/, "") || "/";
  if (!workspaceRoot.startsWith("/") || workspaceRoot.includes("\\") || workspaceRoot.split("/").some((part) => part === ".." || part === ".")) fail("workspaceRoot must be an absolute POSIX path on the selected Node");
  const credentialsFile = input.credentialsFile === undefined ? "" : text(input.credentialsFile, 500);
  if (credentialsFile && (!credentialsFile.startsWith("/") || credentialsFile.includes("\\") || credentialsFile.split("/").includes(".."))) fail("credentialsFile must be an absolute execution-side path");
  if (input.settings !== undefined && (!isObject(input.settings) || JSON.stringify(input.settings).length > 16000
    || Object.entries(input.settings).some(([k, v]) => /token|secret|password|credential|authorization|api_?key/i.test(k)
      || !["string", "number", "boolean"].includes(typeof v)))) fail("Settings must be public scalar values");
  return { nodeId, workspaceRoot, ...(credentialsFile ? { credentialsFile } : {}),
    ...(input.settings !== undefined ? { settings: JSON.parse(JSON.stringify(input.settings)) } : {}) };
}

export function extensionSettingsFor(config, release) {
  const schema = release?.artifact?.plugin?.settingsSchema;
  if (!schema) return config?.settings || {};
  return { ...Object.fromEntries(Object.entries(schema.properties).filter(([, p]) => p.default !== undefined)
    .map(([k, p]) => [k, p.default])), ...(config?.settings || {}) };
}
export function validateExtensionSettings(config, release) {
  const schema = release?.artifact?.plugin?.settingsSchema;
  return schema ? validateToolInput(extensionSettingsFor(config, release), schema, "settings")
    : Object.keys(config?.settings || {}).length ? ["This plugin declares no settings"] : [];
}
