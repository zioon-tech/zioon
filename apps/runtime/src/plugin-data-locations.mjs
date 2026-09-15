import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_PLUGIN_DATA_DIRECTORY,
  normalizeDataLocation,
  validatePluginId
} from "../../../packages/plugin-sdk/src/data-location.mjs";

export function createPluginDataLocations({
  root = DEFAULT_PLUGIN_DATA_DIRECTORY,
  nodeId = "",
  requireNode = false,
  home = homedir()
} = {}) {
  const configured = String(root || "");
  const absoluteRoot = resolve(configured.startsWith("~/")
    ? `${home}/${configured.slice(2)}`
    : configured);
  return Object.freeze({
    forPlugin(pluginId) {
      const id = validatePluginId(pluginId);
      if (requireNode && !String(nodeId || "").trim()) {
        const error = new Error("Configure ZION_PLUGIN_DATA_NODE_ID for the Runtime-hosted data Node");
        error.statusCode = 503;
        throw error;
      }
      return Object.freeze({
        data: normalizeDataLocation({ nodeId, root: `${absoluteRoot}/${id}` })
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
        body = locations.forPlugin(decodeURIComponent(match[1]));
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
