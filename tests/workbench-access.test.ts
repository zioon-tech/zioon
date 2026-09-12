import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureWorkbenchRuntimeAccess
} from "../src/runtime/workbench-access";
import {
  WORKBENCH_RUNTIME_BASE_URL_STORAGE_KEY,
  WORKBENCH_RUNTIME_MODE_STORAGE_KEY
} from "../src/runtime/workbench-runtime-config";
import {
  registerRemoteAccessSettings
} from "../src/settings/RemoteAccessSettings";

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  (window as any).zion = undefined;
  localStorage.clear();
  localStorage.setItem(
    WORKBENCH_RUNTIME_BASE_URL_STORAGE_KEY,
    window.location.origin
  );
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("Workbench remote access bootstrap", () => {
  it("registers an Owner-facing device management page", () => {
    const registerPage = vi.fn(() => ({ dispose() {} }));
    (window as any).zion = {
      settings: { registerPage },
      i18n: { getLocale: () => "en-US" }
    };

    registerRemoteAccessSettings();

    expect(registerPage).toHaveBeenCalledWith(expect.objectContaining({
      id: "services.remote-access",
      category: "services",
      title: "Devices & Remote Access",
      sections: [
        expect.objectContaining({
          settings: [
            expect.objectContaining({
              id: "remote-access.manager",
              kind: "custom"
            })
          ]
        })
      ]
    }));
  });

  it("exchanges a QR fragment without persisting its secret in the URL", async () => {
    window.history.replaceState(
      {},
      "",
      "/#pairing_id=pairing%3Atest&pairing_secret=secret"
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({
          ok: true,
          service: "zion-runtime",
          authRequired: true
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/v1/access/session")) {
        return new Response(JSON.stringify({ error: "Authentication required" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/v1/access/pair")) {
        return new Response(JSON.stringify({
          paired: true,
          device: { deviceId: "client:test", kind: "client" }
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await ensureWorkbenchRuntimeAccess(
      document.getElementById("app") as HTMLElement
    );

    const pairCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/v1/access/pair")
    );
    expect(JSON.parse(String(pairCall?.[1]?.body))).toMatchObject({
      pairingId: "pairing:test",
      secret: "secret",
      device: {
        deviceId: expect.stringMatching(/^client:/)
      }
    });
    expect(window.location.hash).toBe("");
    expect(localStorage.getItem("zion.access.deviceId")).toMatch(/^client:/);
    expect(localStorage.getItem("zion.access.credential")).toBeNull();
    expect(localStorage.getItem(WORKBENCH_RUNTIME_MODE_STORAGE_KEY)).toBe(
      "runtime"
    );
  });
});
