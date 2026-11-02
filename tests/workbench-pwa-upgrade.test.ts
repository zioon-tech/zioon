import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installWorkbenchPwaUpgradeRecovery
} from "../src/runtime/workbench-pwa-upgrade";

function createHarness() {
  const workerEvents = new EventTarget();
  const windowEvents = new EventTarget();
  const documentEvents = new EventTarget();
  const registration: any = {
    active: { scriptURL: "https://example.test/sw.js", state: "activated" },
    installing: null,
    waiting: null,
    update: vi.fn(async () => {}),
    unregister: vi.fn(async () => true)
  };
  const serviceWorker: any = {
    controller: { scriptURL: "https://example.test/sw.js" },
    getRegistration: vi.fn(async () => registration),
    addEventListener: workerEvents.addEventListener.bind(workerEvents),
    removeEventListener: workerEvents.removeEventListener.bind(workerEvents),
    dispatchEvent: workerEvents.dispatchEvent.bind(workerEvents)
  };
  const reload = vi.fn();
  const replace = vi.fn();
  const setInterval = vi.fn(() => 7);
  const clearInterval = vi.fn();
  const windowObject: any = {
    location: {
      href: "https://example.test/?zionSession=test",
      pathname: "/",
      reload,
      replace
    },
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
    setInterval,
    clearInterval
  };
  const documentObject: any = {
    visibilityState: "visible",
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
    dispatchEvent: documentEvents.dispatchEvent.bind(documentEvents)
  };
  return {
    registration,
    serviceWorker,
    windowObject,
    documentObject,
    reload,
    replace,
    setInterval,
    clearInterval
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Workbench PWA upgrade recovery", () => {
  it("checks for updates at startup and when a visible page regains focus", async () => {
    const harness = createHarness();
    const postMessage = vi.fn();
    harness.registration.waiting = { postMessage };
    let now = 100_000;
    const coordinator = installWorkbenchPwaUpgradeRecovery({
      ...harness,
      now: () => now,
      minCheckIntervalMs: 30_000
    });
    await vi.waitFor(() => {
      expect(harness.registration.update).toHaveBeenCalledTimes(1);
    });
    expect(postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });

    harness.windowObject.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(harness.registration.update).toHaveBeenCalledTimes(1);

    now += 31_000;
    harness.windowObject.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => {
      expect(harness.registration.update).toHaveBeenCalledTimes(2);
    });
    expect(harness.setInterval).toHaveBeenCalledWith(
      expect.any(Function),
      5 * 60_000
    );

    coordinator.dispose();
    expect(harness.clearInterval).toHaveBeenCalledWith(7);
  });

  it("reloads after an updated worker takes control", async () => {
    const harness = createHarness();
    const previousController = harness.serviceWorker.controller;
    harness.registration.update.mockImplementation(async () => {
      harness.registration.installing = { state: "installing" };
      queueMicrotask(() => {
        harness.serviceWorker.controller = {
          scriptURL: "https://example.test/sw.js?v=next"
        };
        harness.serviceWorker.dispatchEvent(new Event("controllerchange"));
      });
    });
    const coordinator = installWorkbenchPwaUpgradeRecovery({
      ...harness,
      controllerTimeoutMs: 100
    });

    expect(await coordinator.recoverFromProtocolMismatch("6")).toBe(true);
    expect(harness.serviceWorker.controller).not.toBe(previousController);
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.registration.unregister).not.toHaveBeenCalled();
    expect(harness.replace).toHaveBeenCalledWith(
      "https://example.test/?zionSession=test&zionPwaProtocol=6"
    );
    coordinator.dispose();
  });

  it("unregisters a stuck worker before cache-busted navigation", async () => {
    const harness = createHarness();
    const coordinator = installWorkbenchPwaUpgradeRecovery({
      ...harness,
      controllerTimeoutMs: 1
    });

    expect(await coordinator.recoverFromProtocolMismatch("6")).toBe(true);
    expect(harness.registration.unregister).toHaveBeenCalledTimes(1);
    expect(harness.replace).toHaveBeenCalledWith(
      "https://example.test/?zionSession=test&zionPwaProtocol=6"
    );
    expect(harness.reload).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it("does not manage the independent Mobile PWA scope", async () => {
    const harness = createHarness();
    harness.windowObject.location.pathname = "/mobile/";
    const coordinator = installWorkbenchPwaUpgradeRecovery(harness);

    expect(await coordinator.checkForUpdate("test", true)).toBe(false);
    expect(harness.registration.update).not.toHaveBeenCalled();
    coordinator.dispose();
  });
  it("keeps the page open when preparing a protocol reload cannot save drafts", async () => {
    const harness = createHarness();
    const coordinator = installWorkbenchPwaUpgradeRecovery({
      ...harness, prepareForReload: async () => false
    });
    expect(await coordinator.recoverFromProtocolMismatch("6")).toBe(false);
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.registration.unregister).not.toHaveBeenCalled();
    coordinator.dispose();
  });
  it("does not repeatedly navigate when the requested protocol still mismatches after recovery", async () => {
    const harness = createHarness();
    harness.windowObject.location.href += "&zionPwaProtocol=6";
    const coordinator = installWorkbenchPwaUpgradeRecovery(harness);
    expect(await coordinator.recoverFromProtocolMismatch("6")).toBe(false);
    expect(harness.replace).not.toHaveBeenCalled();
    coordinator.dispose();
  });
  it("checks newly typed drafts again after waiting for an updated controller", async () => {
    const harness = createHarness();
    harness.registration.update.mockImplementation(async () => {
      queueMicrotask(() => {
        harness.serviceWorker.controller = { scriptURL: "https://example.test/sw.js?v=next" };
        harness.serviceWorker.dispatchEvent(new Event("controllerchange"));
      });
    });
    const prepareForReload = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const coordinator = installWorkbenchPwaUpgradeRecovery({
      ...harness, prepareForReload, controllerTimeoutMs: 100
    });
    expect(await coordinator.recoverFromProtocolMismatch("6")).toBe(false);
    expect(prepareForReload).toHaveBeenCalledTimes(2);
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.reload).not.toHaveBeenCalled();
    coordinator.dispose();
  });
});
