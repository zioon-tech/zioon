import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileModelProfileStore } from "../src/model-profile-store.mjs";

describe("FileModelProfileStore", () => {
  it("persists imported profiles without credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-model-profiles-"));
    const path = join(directory, "profiles.json");
    try {
      const store = new FileModelProfileStore(path);
      store.upsert({
        id: "custom",
        providerId: "user.dynamic",
        providerType: "openai",
        endpoint: "http://127.0.0.1:9000/v1/chat/completions",
        model: "custom-model",
        credentialRef: "model.custom"
      });
      const reopened = new FileModelProfileStore(path);

      expect(reopened.list()).toEqual([
        expect.objectContaining({
          id: "custom",
          model: "custom-model",
          credentialRef: "model.custom"
        })
      ]);
      expect(JSON.stringify(reopened.list())).not.toContain("secret");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(reopened.delete("custom")).toMatchObject({
        id: "custom",
        model: "custom-model"
      });
      expect(reopened.list()).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
