import { describe, expect, it, vi } from "vitest";
import { createPluginLocations } from "../src/plugin/data-locations";

describe("Workbench plugin locations", () => {
  it("loads lazily and shares concurrent requests without using terminal state", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: { nodeId: "cloud", root: "/srv/data/dev.identity" }
    })));
    const state = { get: (key: string) => key === "runtime.connection" ? { backend: "runtime", baseUrl: "https://runtime.test" } : undefined };
    const locations = createPluginLocations("dev.identity", { state, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([locations.data, locations.data]);
    expect(first).toEqual({ nodeId: "cloud", root: "/srv/data/dev.identity" });
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/v1/plugins/dev.identity/locations");
  });

  it("does not reuse another Runtime's location", async () => {
    let baseUrl = "https://first.test";
    const state = { get: (key: string) => key === "runtime.connection" ? { backend: "runtime", baseUrl } : undefined };
    const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify({
      data: { nodeId: url.includes("first") ? "one" : "two", root: "/srv/data/dev.identity" }
    })));
    const locations = createPluginLocations("dev.identity", { state, fetchImpl });
    expect((await locations.data).nodeId).toBe("one");
    baseUrl = "https://second.test";
    expect((await locations.data).nodeId).toBe("two");
  });

  it("retries a failed lookup rather than selecting an active terminal", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Configure data Node" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { nodeId: "cloud", root: "/data/dev.identity" } })));
    const locations = createPluginLocations("dev.identity", {
      state: { get: () => undefined }, storage: { getItem: () => null }, fetchImpl
    });
    await expect(locations.data).rejects.toThrow("Configure data Node");
    expect((await locations.data).nodeId).toBe("cloud");
  });

  it("requires an explicit browser-only binding and validates server paths", async () => {
    const locations = createPluginLocations("dev.identity", {
      state: { get: (key: string) => key === "runtime.mode" ? "browser" : undefined }
    });
    await expect(locations.data).rejects.toThrow("not configured");
    const remote = createPluginLocations("dev.identity", {
      state: { get: () => undefined }, storage: { getItem: () => null },
      fetchImpl: async () => new Response(JSON.stringify({ data: { nodeId: "cloud", root: "../bad" } }))
    });
    await expect(remote.data).rejects.toThrow("absolute root");
  });
});
