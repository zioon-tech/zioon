import { describe, expect, it } from "vitest";
import { createPluginDataLocations, createPluginLocationsHttpHandler } from "../src/plugin-data-locations.mjs";
import { dataLocationPath } from "../../../packages/plugin-sdk/src/data-location.mjs";

describe("plugin data locations", () => {
  it("binds every plugin to its own absolute directory without discovering terminals", () => {
    const locations = createPluginDataLocations({ root: "~/data/plugins", home: "/srv/zion", nodeId: "cloud" });
    expect(locations.forPlugin("dev.identity").data).toEqual({
      nodeId: "cloud", root: "/srv/zion/data/plugins/dev.identity"
    });
    expect(locations.forPlugin("dev.reports").data.root).toBe("/srv/zion/data/plugins/dev.reports");
    expect(Object.isFrozen(locations.forPlugin("dev.identity").data)).toBe(true);
  });

  it.each(["../identity", "dev/identity", "", ".", "dev..identity", "dev.identity/../../secrets"])("rejects unsafe plugin id %s", (id) => {
    expect(() => createPluginDataLocations().forPlugin(id)).toThrow("Invalid plugin id");
  });

  it("fails closed when multi-node deployment has no explicit data Node", () => {
    const locations = createPluginDataLocations({ root: "/srv/data", requireNode: true });
    expect(() => locations.forPlugin("dev.identity")).toThrow("ZION_PLUGIN_DATA_NODE_ID");
  });

  it("keeps local-only mode explicit and rejects escaping relative paths", () => {
    const data = createPluginDataLocations({ root: "/srv/data" }).forPlugin("dev.identity").data;
    expect(data.nodeId).toBe("");
    expect(dataLocationPath(data, "biography/events.jsonl")).toBe("/srv/data/dev.identity/biography/events.jsonl");
    for (const path of ["../other", "/etc/passwd", "a/../../b", "a\\..\\b", "C:/secret"]) {
      expect(() => dataLocationPath(data, path)).toThrow();
    }
  });

  it("serves only location metadata and does not allow writes", async () => {
    const handle = createPluginLocationsHttpHandler({
      locations: createPluginDataLocations({ root: "/srv/data", nodeId: "cloud" })
    });
    let status, body;
    const response = { writeHead(code) { status = code; }, end(value) { body = JSON.parse(value); } };
    const url = new URL("http://runtime/v1/plugins/dev.identity/locations");
    expect(await handle({ method: "GET" }, response, url)).toBe(true);
    expect(status).toBe(200);
    expect(body.data).toEqual({ nodeId: "cloud", root: "/srv/data/dev.identity" });
    await handle({ method: "POST" }, response, url);
    expect(status).toBe(405);
    expect(await handle({ method: "GET" }, response, new URL("http://runtime/other"))).toBe(false);
  });
});
