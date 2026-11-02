import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvironmentCredentialProvider } from "../src/environment-credential-provider.mjs";

describe("EnvironmentCredentialProvider", () => {
  it("resolves only explicitly bound environment variables", async () => {
    const provider = new EnvironmentCredentialProvider({
      environment: {
        ZION_RUNTIME_API_KEY: "secret",
        UNRELATED_SECRET: "must-not-leak"
      },
      bindings: {
        "model.default": "ZION_RUNTIME_API_KEY"
      }
    });

    await expect(provider.acquire({ ref: "model.default" })).resolves.toMatchObject({
      headers: { authorization: "Bearer secret" }
    });
    await expect(provider.acquire({ ref: "UNRELATED_SECRET" })).resolves.toBeNull();
  });

  it("supports provider-specific headers without exposing the source variable", async () => {
    const provider = new EnvironmentCredentialProvider({
      environment: { ANTHROPIC_KEY: "anthropic-secret" },
      bindings: {
        anthropic: {
          environmentVariable: "ANTHROPIC_KEY",
          header: "x-api-key",
          prefix: ""
        }
      }
    });

    const lease = await provider.acquire({ ref: "anthropic" });
    expect(lease).toMatchObject({
      headers: { "x-api-key": "anthropic-secret" }
    });
    expect(JSON.stringify(lease)).not.toContain("ANTHROPIC_KEY");
  });

  it("returns null when a bound credential is absent", async () => {
    const provider = new EnvironmentCredentialProvider({
      environment: {},
      bindings: {
        "model.default": "ZION_RUNTIME_API_KEY"
      }
    });

    await expect(provider.acquire({ ref: "model.default" })).resolves.toBeNull();
  });

  it("persists imported write-only credentials with restricted file permissions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-credentials-"));
    const storePath = join(directory, "credentials.json");
    try {
      const provider = new EnvironmentCredentialProvider({
        environment: {},
        storePath
      });
      provider.set("model.imported", {
        value: "imported-secret",
        header: "authorization",
        prefix: "Bearer "
      });
      const reopened = new EnvironmentCredentialProvider({
        environment: {},
        storePath
      });

      await expect(reopened.acquire({ ref: "model.imported" })).resolves.toMatchObject({
        headers: { authorization: "Bearer imported-secret" }
      });
      expect(reopened.has("model.imported")).toBe(true);
      expect(reopened.delete("model.imported")).toBe(true);
      expect(reopened.has("model.imported")).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
