import { describe, expect, it, vi } from "vitest";
import {
  createMacOsKeychainCredentialStore
} from "../src/cli-credential-store.mjs";
import {
  loginWithOAuthDeviceFlow,
  resolveOAuthDeviceCredential
} from "../src/oauth-device-flow.mjs";

function response(status, value) {
  return new globalThis.Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const auth = {
  type: "device_code",
  deviceAuthorizationUrl: "https://id.example.test/oauth/device/code",
  tokenUrl: "https://id.example.test/oauth/token",
  clientId: "zion-cli",
  scope: "runtime.run offline_access"
};

describe("OAuth device flow", () => {
  it("polls RFC 8628 and stores the resulting credential", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, {
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://id.example.test/activate",
        expires_in: 600,
        interval: 1
      }))
      .mockResolvedValueOnce(response(400, {
        error: "authorization_pending"
      }))
      .mockResolvedValueOnce(response(200, {
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "runtime.run"
      }));
    const credentialStore = {
      set: vi.fn(async () => {})
    };
    const emitted = [];

    const credential = await loginWithOAuthDeviceFlow({
      profileName: "cloud",
      auth,
      credentialStore,
      fetchImpl,
      emit: (event) => emitted.push(event),
      now: () => 1000,
      sleep: async () => {}
    });

    expect(credential).toMatchObject({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: 3_601_000
    });
    expect(credentialStore.set).toHaveBeenCalledWith(
      "cloud",
      expect.objectContaining({ accessToken: "access-secret" })
    );
    expect(emitted).toEqual([
      expect.objectContaining({
        type: "auth.deviceCode",
        userCode: "ABCD-EFGH",
        verificationUri: "https://id.example.test/activate"
      }),
      expect.objectContaining({
        type: "auth.completed",
        profileName: "cloud"
      })
    ]);
    expect(fetchImpl.mock.calls[0][1].body).not.toContain("access-secret");
  });

  it("refreshes an expired Keychain credential", async () => {
    const credentialStore = {
      get: vi.fn(async () => ({
        tokenType: "Bearer",
        accessToken: "expired",
        refreshToken: "refresh-secret",
        expiresAt: 900
      })),
      set: vi.fn(async () => {})
    };
    const credential = await resolveOAuthDeviceCredential({
      profileName: "cloud",
      auth,
      credentialStore,
      fetchImpl: vi.fn(async () => response(200, {
        access_token: "refreshed",
        token_type: "Bearer",
        expires_in: 3600
      })),
      now: () => 1000
    });

    expect(credential).toMatchObject({
      accessToken: "refreshed",
      refreshToken: "refresh-secret",
      expiresAt: 3_601_000
    });
    expect(credentialStore.set).toHaveBeenCalledOnce();
  });

  it("stores OAuth credentials in macOS Keychain without shell execution", async () => {
    const calls = [];
    const store = createMacOsKeychainCredentialStore({
      execFileImpl: vi.fn(async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "find-generic-password") {
          return {
            stdout: JSON.stringify({
              accessToken: "keychain-secret",
              expiresAt: 4000
            })
          };
        }
        return { stdout: "" };
      })
    });

    await store.set("cloud", {
      accessToken: "keychain-secret",
      expiresAt: 4000
    });
    await expect(store.get("cloud")).resolves.toMatchObject({
      accessToken: "keychain-secret"
    });
    await expect(store.delete("cloud")).resolves.toBe(true);
    expect(calls.every((call) => call.command === "security")).toBe(true);
    expect(calls[0].args).toContain("add-generic-password");
  });
});
