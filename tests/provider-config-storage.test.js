import { describe, expect, it, vi } from "vitest";
import {
  compactProviderConfig,
  saveProviderConfigPatch
} from "../extensions/dev.langchain-chat/provider-config-storage.js";

function memoryStorage(initial = {}, failOnce = false) {
  const values = new Map(Object.entries(initial));
  let shouldFail = failOnce;
  return {
    values,
    getItem: vi.fn((key) => values.get(key) ?? null),
    removeItem: vi.fn((key) => values.delete(key)),
    setItem: vi.fn((key, value) => {
      if (shouldFail) {
        shouldFail = false;
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      values.set(key, String(value));
    })
  };
}

describe("provider config storage", () => {
  it("drops unrelated payloads and bounds model descriptions", () => {
    const compact = compactProviderConfig({
      label: "DeepSeek",
      thinkingEffort: "high",
      unrelatedPayload: "x".repeat(100_000),
      modelDescriptions: {
        "deepseek-v4-flash": "d".repeat(1000)
      }
    });

    expect(compact).toMatchObject({
      label: "DeepSeek",
      thinkingEffort: "high"
    });
    expect(compact.unrelatedPayload).toBeUndefined();
    expect(compact.modelDescriptions["deepseek-v4-flash"]).toHaveLength(500);
  });

  it("reclaims the disposable health cache and retries a quota failure", () => {
    const storage = memoryStorage({
      "zion.deepseek.config": JSON.stringify({ thinkingMode: "auto" }),
      "zion.models.health.v1": "cached"
    }, true);

    const config = saveProviderConfigPatch(
      "zion.deepseek.config",
      {
        thinkingMode: "on",
        thinkingEffort: "high"
      },
      { storage }
    );

    expect(config).toMatchObject({
      thinkingMode: "on",
      thinkingEffort: "high"
    });
    expect(storage.removeItem).toHaveBeenCalledWith("zion.models.health.v1");
    expect(JSON.parse(storage.values.get("zion.deepseek.config"))).toMatchObject({
      thinkingMode: "on",
      thinkingEffort: "high"
    });
  });
});
