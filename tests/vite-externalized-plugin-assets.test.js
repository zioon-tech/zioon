import { describe, expect, it, vi } from "vitest";
import { zionExtensionsPlugin } from "../vite-plugin-extensions-fixed.js";

describe("externalized plugin production assets", () => {
  it("keeps external and Runtime-only plugins out of Workbench assets", () => {
    const emitted = [];
    const plugin = zionExtensionsPlugin();
    const config = {
      build: {
        rollupOptions: {
          input: {}
        }
      }
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      plugin.config(config);
      plugin.generateBundle.call({
        emitFile(asset) {
          emitted.push(asset);
        }
      }, {}, {});
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }

    expect(emitted.some((asset) =>
      String(asset.fileName || "").startsWith("extensions/dev.identity/")
    )).toBe(false);
    expect(Object.keys(config.build.rollupOptions.input).some((name) =>
      name.startsWith("extensions/dev.byteintl-model/")
    )).toBe(false);
    expect(emitted.some((asset) =>
      String(asset.fileName || "").startsWith("extensions/dev.comments/")
    )).toBe(true);
  });
});
