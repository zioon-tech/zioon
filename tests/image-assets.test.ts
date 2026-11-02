import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_ASSET_PREFIX,
  isImageAssetUri,
  putImageAsset
} from "../src/media/image-assets";
import {
  WORKBENCH_RUNTIME_BASE_URL_STORAGE_KEY,
  WORKBENCH_RUNTIME_MODE_STORAGE_KEY
} from "../src/runtime/workbench-runtime-config";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Workbench image Assets", () => {
  it("uploads image bytes to Runtime without writing a browser Asset copy", async () => {
    localStorage.setItem(WORKBENCH_RUNTIME_MODE_STORAGE_KEY, "runtime");
    localStorage.setItem(
      WORKBENCH_RUNTIME_BASE_URL_STORAGE_KEY,
      "https://zion.example"
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      async json() {
        return {
          asset: {
            id: "asset_1",
            uri: `${IMAGE_ASSET_PREFIX}asset_1`
          }
        };
      }
    });
    vi.stubGlobal("fetch", fetchMock);
    const image = new Blob([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    ], { type: "image/png" });

    await expect(putImageAsset(image, {
      name: "screen.png",
      mimeType: "image/png"
    })).resolves.toBe(`${IMAGE_ASSET_PREFIX}asset_1`);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://zion.example/v1/assets",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: image,
        headers: {
          "content-type": "image/png",
          "x-zion-file-name": "screen.png"
        }
      })
    );
  });

  it("recognizes both canonical and legacy image references", () => {
    expect(isImageAssetUri(`${IMAGE_ASSET_PREFIX}asset_1`)).toBe(true);
    expect(isImageAssetUri("app://img/legacy")).toBe(true);
    expect(isImageAssetUri("https://example.com/image.png")).toBe(false);
  });

  it("does not silently fall back to IndexedDB in forced Runtime mode", async () => {
    localStorage.setItem(WORKBENCH_RUNTIME_MODE_STORAGE_KEY, "runtime");
    localStorage.setItem(
      WORKBENCH_RUNTIME_BASE_URL_STORAGE_KEY,
      "https://zion.example"
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(putImageAsset(
      new Blob(["image"], { type: "image/png" })
    )).rejects.toThrow("offline");
  });

  it("does not silently persist image bytes when automatic Runtime discovery fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unavailable")));

    await expect(putImageAsset(
      new Blob(["image"], { type: "image/png" })
    )).rejects.toThrow("unavailable");
  });

  it("bounds the explicit browser-only compatibility store", async () => {
    localStorage.setItem(WORKBENCH_RUNTIME_MODE_STORAGE_KEY, "browser");

    await expect(putImageAsset(
      new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: "image/png" })
    )).rejects.toMatchObject({ code: "BROWSER_IMAGE_TOO_LARGE" });
  });
});
