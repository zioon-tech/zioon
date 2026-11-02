import { describe, expect, it } from "vitest";
import { resolvePluginDataHost } from "../src/plugin-data-host.mjs";

describe("plugin data host configuration", () => {
  it("preserves legacy auto routing without pretending it is unambiguous", () => {
    expect(resolvePluginDataHost({
      host: "auto",
      nodeId: "node:data",
      toolMode: "node"
    })).toEqual({
      mode: "auto",
      localFiles: true,
      locationNodeId: "node:data",
      requireNode: true,
      ambiguousLegacyRouting: true
    });
  });

  it("makes Runtime filesystem hosting explicit and rejects Node metadata", () => {
    expect(resolvePluginDataHost({
      host: "runtime",
      toolMode: "sandbox"
    })).toEqual({
      mode: "runtime",
      localFiles: true,
      locationNodeId: "",
      requireNode: false,
      ambiguousLegacyRouting: false
    });
    expect(() => resolvePluginDataHost({
      host: "runtime",
      nodeId: "node:data",
      toolMode: "sandbox"
    })).toThrow("must not declare");
  });

  it("requires an explicit Node and a Broker-backed tool mode", () => {
    expect(resolvePluginDataHost({
      host: "node",
      nodeId: "node:data",
      toolMode: "sandbox"
    })).toEqual({
      mode: "node",
      localFiles: false,
      locationNodeId: "node:data",
      requireNode: true,
      ambiguousLegacyRouting: false
    });
    expect(() => resolvePluginDataHost({
      host: "node",
      toolMode: "sandbox"
    })).toThrow("requires ZION_PLUGIN_DATA_NODE_ID");
    expect(() => resolvePluginDataHost({
      host: "node",
      nodeId: "node:data",
      toolMode: "local"
    })).toThrow("requires node or sandbox");
  });

  it("binds managed plugin data to the account sandbox without a static Node id", () => {
    expect(resolvePluginDataHost({
      host: "managed",
      toolMode: "sandbox"
    })).toEqual({
      mode: "managed",
      localFiles: false,
      locationNodeId: "",
      requireNode: false,
      ambiguousLegacyRouting: false,
      managed: true,
      accountVolume: true
    });
    expect(() => resolvePluginDataHost({
      host: "managed",
      nodeId: "node:static",
      toolMode: "sandbox"
    })).toThrow("must not declare");
    expect(() => resolvePluginDataHost({
      host: "managed",
      toolMode: "node"
    })).toThrow("requires sandbox tool mode");
  });

  it("rejects unknown host modes", () => {
    expect(() => resolvePluginDataHost({ host: "object-store" }))
      .toThrow("auto, runtime, node, or managed");
  });
});
