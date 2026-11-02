import { hashExtension } from "../../../../packages/runtime-client/src/extension-package.mjs";

const fail = (code) => { throw Object.assign(new Error(code), { code, statusCode: 409 }); };
export function extensionToolCatalog(snapshot) {
  const catalog = snapshot.entries.filter((entry) => entry.installation?.enabled
    && ["plugin", "mcp"].includes(entry.installedRelease?.artifact?.kind)).map((entry) => ({
    listingId: entry.id, name: entry.name, kind: entry.installedRelease.artifact.kind,
    version: entry.installation.version, epoch: entry.installation.executionEpoch,
    artifactDigest: entry.installedRelease.artifactDigest,
    tools: entry.installation.validation?.epoch === entry.installation.executionEpoch
      ? entry.installation.validation.tools : [],
    validationRequired: entry.installation.validation?.epoch !== entry.installation.executionEpoch
  }));
  if (catalog.length > 100 || Buffer.byteLength(JSON.stringify(catalog)) > 100000) fail("extension_tool_catalog_budget");
  return catalog;
}
export function assertExtensionToolCatalog(catalog, snapshot) {
  if (!Array.isArray(catalog) || catalog.length > 100) fail("extension_tool_catalog_invalid");
  const current = extensionToolCatalog(snapshot);
  for (const entry of catalog) {
    const installed = current.find((candidate) => candidate.listingId === entry.listingId);
    // Discovery validation can improve later; executable bytes and config stay fixed.
    if (!installed || hashExtension([entry.epoch, entry.artifactDigest]) !== hashExtension([
      installed.epoch, installed.artifactDigest])) fail("extension_tool_catalog_changed");
  }
  return catalog;
}

export function extensionContextEnabled(handler, listingId, request) {
  if (handler.required !== false) return true;
  const selection = request.metadata?.contextProviders;
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) return true;
  const id = `extension:${listingId}:${handler.id}`;
  if (Array.isArray(selection.disabled) && selection.disabled.includes(id)) return false;
  return !Array.isArray(selection.enabled) || !selection.enabled.length || selection.enabled.includes(id);
}
