import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import {
  DEFAULT_PLUGIN_DATA_DIRECTORY,
  normalizeDataLocation,
  validatePluginId
} from "../../../packages/plugin-sdk/src/data-location.mjs";

const PLUGIN_DATA_SCOPES = new Set(["legacy", "account"]);

function scopedPathSegment(value, label) {
  const source = String(value || "").trim();
  if (!source) {
    const error = new Error(`Account-scoped plugin data requires ${label}`);
    error.statusCode = 403;
    throw error;
  }
  return encodeURIComponent(source).replaceAll(".", "%2E");
}

function accountScope(context = {}) {
  const request = context?.request && typeof context.request === "object"
    ? context.request
    : {};
  const principal = context?.principal || request.principal || context;
  const accountId = principal?.userId || principal?.user?.id;
  const spaceId = principal?.spaceId || principal?.space?.id;
  return Object.freeze({
    accountId: String(accountId || "").trim(),
    spaceId: String(spaceId || "").trim()
  });
}

export function createPluginDataLocations({
  root = DEFAULT_PLUGIN_DATA_DIRECTORY,
  nodeId = "",
  requireNode = false,
  scope = "legacy",
  accountVolume = false,
  resolveNodeId = null,
  legacyReadAccountId = "",
  home = homedir()
} = {}) {
  const configured = String(root || "");
  const absoluteRoot = resolve(configured.startsWith("~/")
    ? `${home}/${configured.slice(2)}`
    : configured);
  const scopeMode = String(scope || "legacy").trim().toLowerCase();
  if (!PLUGIN_DATA_SCOPES.has(scopeMode)) {
    throw new Error("Plugin data scope must be legacy or account");
  }
  const legacyAccount = String(legacyReadAccountId || "").trim();
  if (accountVolume && scopeMode !== "account") {
    throw new Error("Account-volume plugin data requires account scope");
  }
  if (accountVolume && legacyAccount) {
    throw new Error("Account-volume plugin data requires explicit migration instead of legacy read fallback");
  }
  if (resolveNodeId != null && typeof resolveNodeId !== "function") {
    throw new Error("Plugin data Node resolver must be a function");
  }

  function assertNodeBinding(resolvedNodeId) {
    if (requireNode && !String(resolvedNodeId || "").trim()) {
      const error = new Error("Configure ZION_PLUGIN_DATA_NODE_ID for Node-hosted plugin data");
      error.statusCode = 503;
      throw error;
    }
  }

  return Object.freeze({
    root: absoluteRoot,
    scopeMode,
    accountVolume: accountVolume === true,
    containsPath(pathValue) {
      const candidate = resolve(String(pathValue || ""));
      const difference = relative(absoluteRoot, candidate);
      return isAbsolute(String(pathValue || ""))
        && (difference === ""
          || (!isAbsolute(difference)
            && difference !== ".."
            && !difference.startsWith("../")
            && !difference.startsWith("..\\")));
    },
    forPlugin(pluginId, context = {}, { access = "read" } = {}) {
      const id = validatePluginId(pluginId);
      const resolvedNodeId = String(
        resolveNodeId ? resolveNodeId(context) : nodeId
      ).trim();
      assertNodeBinding(resolvedNodeId);
      if (scopeMode === "legacy") {
        return Object.freeze({
          data: normalizeDataLocation({
            nodeId: resolvedNodeId,
            root: `${absoluteRoot}/${id}`
          })
        });
      }

      const mode = String(access || "read").trim().toLowerCase();
      if (!["read", "write"].includes(mode)) {
        throw new Error("Plugin data access must be read or write");
      }
      const identity = accountScope(context);
      const spaceSegment = scopedPathSegment(identity.spaceId, "spaceId");
      const accountSegment = scopedPathSegment(identity.accountId, "accountId");
      const data = normalizeDataLocation({
        nodeId: resolvedNodeId,
        root: accountVolume
          ? `${absoluteRoot}/${id}`
          : `${absoluteRoot}/scopes/${spaceSegment}/accounts/${accountSegment}/${id}`
      });
      const readFallbacks = !accountVolume
        && mode === "read"
        && legacyAccount
        && identity.accountId === legacyAccount
        ? [normalizeDataLocation({
            nodeId: resolvedNodeId,
            root: `${absoluteRoot}/${id}`
          })]
        : [];
      return Object.freeze({
        data,
        scope: identity,
        readFallbacks: Object.freeze(readFallbacks)
      });
    }
  });
}

// Mounted behind Runtime authentication; this is metadata, not a new model tool.
export function createPluginLocationsHttpHandler({ locations }) {
  return async (request, response, url) => {
    const match = url.pathname.match(/^\/v1\/plugins\/([^/]+)\/locations$/);
    if (!match) return false;
    let status = 200;
    let body;
    try {
      if (request.method !== "GET") {
        status = 405;
        body = { error: "Method not allowed" };
      } else {
        const location = locations.forPlugin(
          decodeURIComponent(match[1]),
          request.zionPrincipal
        );
        body = { data: location.data };
      }
    } catch (error) {
      status = error.statusCode || 400;
      body = { error: error.message };
    }
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store"
    });
    response.end(JSON.stringify(body));
    return true;
  };
}
