import { beforeEach, describe, expect, it, vi } from "vitest";
let ensureWorkbenchRuntimeAccess: typeof import("../src/runtime/workbench-access").ensureWorkbenchRuntimeAccess;
import {
  WORKBENCH_RUNTIME_BASE_URL_STORAGE_KEY,
  WORKBENCH_RUNTIME_MODE_STORAGE_KEY
} from "../src/runtime/workbench-runtime-config";
import {
  registerRemoteAccessSettings
} from "../src/settings/RemoteAccessSettings";

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  (window as any).zion = undefined;
  localStorage.clear();
  localStorage.setItem(
    WORKBENCH_RUNTIME_BASE_URL_STORAGE_KEY,
    window.location.origin
  );
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
  ({ ensureWorkbenchRuntimeAccess } = await import("../src/runtime/workbench-access"));
});

describe("Workbench remote access bootstrap", () => {
  it.each([
    { role: "owner", requested: false, expected: "space:legacy" },
    { role: "member", requested: false, expected: "space:personal" },
    { role: "member", requested: true, expected: "space:legacy" }
  ])("selects the correct home after profile return: %j", async ({ role, requested, expected }) => {
    if (requested) history.replaceState({}, "", "/?space=space%3Alegacy");
    const identity = {
      user: { id: "user:one", name: "子航", email: "one@example.test" },
      space: { id: "space:legacy", kind: "team" },
      membership: { role, status: "active" },
      spaces: [{ id: "space:personal", kind: "personal", membership: { role: "owner", status: "active" } }],
      scopes: ["runtime.read", "runtime.write"]
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), location.origin).pathname;
      if (path === "/health") return Response.json({
        service: "zion-runtime", authRequired: true, authMode: "accounts-v1"
      });
      if (path === "/v1/account/me") return Response.json(
        new Headers(init?.headers).get("x-zioon-space-id") === "space:personal"
          ? { ...identity, space: { id: "space:personal", kind: "personal" }, membership: { role: "owner", status: "active" } }
          : identity
      );
      if (path === "/v1/sessions") return Response.json({ sessions: [{ id: "existing-session" }] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "setInterval").mockReturnValue(0);
    await ensureWorkbenchRuntimeAccess(document.getElementById("app")!);
    expect(new URL(location.href).searchParams.get("space")).toBe(expected);
    await fetch(location.origin + "/v1/sessions");
    const call = fetchMock.mock.calls.at(-1)!;
    expect(new Headers(call[1]?.headers).get("x-zioon-space-id")).toBe(expected);
  });

  it("waits for retry without mounting an unscoped Workbench when discovery is unavailable", async () => {
    history.replaceState({}, "", "/?space=space%3Aone");
    let available = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), location.origin).pathname;
      if (!available) return Response.json({ error: "Unavailable" }, { status: 503 });
      if (path === "/health") return Response.json({
        service: "zion-runtime", authRequired: true, authMode: "accounts-v1"
      });
      if (path === "/v1/account/me") return Response.json({
        user: { id: "user:one" }, space: { id: "space:one", kind: "personal" },
        membership: { role: "owner", status: "active" },
        scopes: ["runtime.read", "runtime.write"]
      });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "setInterval").mockReturnValue(0);
    const host = document.getElementById("app")!;
    let entered = false;
    const access = ensureWorkbenchRuntimeAccess(host).then(() => { entered = true; });
    await vi.waitFor(() => expect(host.textContent).toContain("暂时无法连接工作台"));
    expect(entered).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/v1/account/me"))).toBe(false);
    available = true;
    host.querySelector("button")!.click();
    await access;
    expect(entered).toBe(true);
    const response = await fetch(`${location.origin}/v1/account/me`);
    expect(response.ok).toBe(true);
    const call = fetchMock.mock.calls.at(-1) as unknown as [unknown, RequestInit];
    expect(new Headers(call[1].headers).get("x-zioon-space-id")).toBe("space:one");
  });

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

  it("enters the Workbench directly after account login returns to the bridge route", async () => {
    window.history.replaceState({}, "", "/account");
    const identity = {
      authenticated: true,
      mode: "accounts-v1",
      user: { id: "user:one", name: "Local User", email: "local@example.test" },
      space: { id: "space:one", name: "Local", kind: "personal" },
      membership: { role: "owner", status: "active" },
      scopes: ["runtime.read", "runtime.write"],
      sessionId: "session:one",
      expiresAt: Date.now() + 60_000
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path === "/health") {
        return new Response(JSON.stringify({
          service: "zion-runtime",
          authRequired: true,
          authMode: "accounts-v1"
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path === "/v1/account/me") {
        return new Response(JSON.stringify(identity), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "setInterval").mockReturnValue(1);

    await ensureWorkbenchRuntimeAccess(
      document.getElementById("app") as HTMLElement
    );

    expect(window.location.pathname).toBe("/");
    expect(document.getElementById("app")?.classList.contains("zion-account-gate")).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/v1/account/me"))).toHaveLength(2);
  });
  it("preserves old-account editor content and waits for explicit reentry when scopes change", async () => {
    const identity = {
      user: { id: "old-user" }, space: { id: "old-space" },
      membership: { role: "owner", status: "active" },
      scopes: ["runtime.read", "runtime.write"]
    };
    let changed = false;
    vi.stubGlobal("fetch", vi.fn(async input => {
      const path = new URL(String(input), window.location.origin).pathname;
      return new Response(JSON.stringify(path === "/health"
        ? { service: "zion-runtime", authRequired: true, authMode: "accounts-v1" }
        : { ...identity, scopes: changed ? ["runtime.read"] : identity.scopes }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }));
    let poll: () => void;
    vi.spyOn(window, "setInterval").mockImplementation(handler => { poll = handler as () => void; return 1; });
    const showModal = vi.fn();
    const original = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = showModal;
    const set = vi.fn();
    (window as any).zion = {
      state: { set },
      panels: {
        listEditors: () => [{ panelId: "p", sessionId: "s" }],
        getEditorBySession: () => ({ getValue: () => "unsaved input" })
      }
    };
    try {
      await ensureWorkbenchRuntimeAccess(document.getElementById("app") as HTMLElement);
      changed = true;
      poll!();
      await vi.waitFor(() => expect(showModal).toHaveBeenCalledOnce());
      expect(set).toHaveBeenCalledWith("workbench.accessChanged", true);
      expect(JSON.parse(localStorage.getItem("zion.access.drafts:old-user:old-space")!))
        .toEqual([{ sessionId: "s", text: "unsaved input" }]);
      expect(document.querySelector("dialog")?.textContent).toContain("重新进入");
      const dialog = document.querySelector("dialog")!;
      expect(dialog.className).toBe("zion-access-change-dialog");
      expect(dialog.getAttribute("aria-labelledby")).toBe(dialog.querySelector("h2")?.id);
      expect(dialog.textContent).toContain("1 个会话已保留");
      expect(document.activeElement?.textContent).toBe("重新进入");
      const cancel = new Event("cancel", { cancelable: true });
      dialog.dispatchEvent(cancel);
      expect(cancel.defaultPrevented).toBe(true);
      poll!();
      await Promise.resolve();
      expect(showModal).toHaveBeenCalledOnce();
    } finally {
      HTMLDialogElement.prototype.showModal = original;
    }
  });
});
