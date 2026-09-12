const DEFAULT_UPDATE_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MIN_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_CONTROLLER_TIMEOUT_MS = 4_000;
const PROTOCOL_UPGRADE_QUERY = "zionPwaProtocol";

type ServiceWorkerRegistrationLike = {
  active?: { scriptURL?: string; state?: string } | null;
  installing?: {
    scriptURL?: string;
    state?: string;
    postMessage?(message: unknown): void;
  } | null;
  waiting?: {
    scriptURL?: string;
    state?: string;
    postMessage?(message: unknown): void;
  } | null;
  update(): Promise<unknown>;
  unregister(): Promise<boolean>;
};

type ServiceWorkerContainerLike = {
  controller?: { scriptURL?: string } | null;
  getRegistration(scope?: string): Promise<ServiceWorkerRegistrationLike | undefined>;
  addEventListener?(type: string, listener: EventListener): void;
  removeEventListener?(type: string, listener: EventListener): void;
};

type WindowLike = {
  location: {
    href: string;
    pathname: string;
    reload(): void;
    replace(url: string): void;
  };
  addEventListener?(type: string, listener: EventListener): void;
  removeEventListener?(type: string, listener: EventListener): void;
  setInterval?(handler: TimerHandler, timeout?: number): number;
  clearInterval?(id: number): void;
};

type DocumentLike = {
  visibilityState?: string;
  addEventListener?(type: string, listener: EventListener): void;
  removeEventListener?(type: string, listener: EventListener): void;
};

type UpgradeCoordinator = {
  checkForUpdate(reason?: string, force?: boolean): Promise<boolean>;
  recoverFromProtocolMismatch(expectedProtocol?: string): Promise<boolean>;
  dispose(): void;
};

let activeCoordinator: UpgradeCoordinator | null = null;

function isDesktopPath(pathname: string): boolean {
  return pathname !== "/mobile" && !pathname.startsWith("/mobile/");
}

function cacheBustedUpgradeUrl(href: string, expectedProtocol: string): string {
  const url = new URL(href);
  url.searchParams.set(
    PROTOCOL_UPGRADE_QUERY,
    expectedProtocol || String(Date.now())
  );
  return url.toString();
}

function waitForControllerChange(
  serviceWorker: ServiceWorkerContainerLike,
  previousController: unknown,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (changed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      serviceWorker.removeEventListener?.("controllerchange", onChange);
      resolve(changed);
    };
    const onChange = () => finish(serviceWorker.controller !== previousController);
    serviceWorker.addEventListener?.("controllerchange", onChange);
    timer = setTimeout(
      () => finish(serviceWorker.controller !== previousController),
      Math.max(100, timeoutMs)
    );
  });
}

export function installWorkbenchPwaUpgradeRecovery({
  serviceWorker = globalThis.navigator?.serviceWorker as ServiceWorkerContainerLike,
  windowObject = globalThis.window as unknown as WindowLike,
  documentObject = globalThis.document as unknown as DocumentLike,
  now = () => Date.now(),
  updateIntervalMs = DEFAULT_UPDATE_INTERVAL_MS,
  minCheckIntervalMs = DEFAULT_MIN_CHECK_INTERVAL_MS,
  controllerTimeoutMs = DEFAULT_CONTROLLER_TIMEOUT_MS
}: {
  serviceWorker?: ServiceWorkerContainerLike;
  windowObject?: WindowLike;
  documentObject?: DocumentLike;
  now?: () => number;
  updateIntervalMs?: number;
  minCheckIntervalMs?: number;
  controllerTimeoutMs?: number;
} = {}): UpgradeCoordinator {
  if (activeCoordinator) return activeCoordinator;
  if (
    !serviceWorker?.getRegistration
    || !windowObject?.location
    || !isDesktopPath(String(windowObject.location.pathname || ""))
  ) {
    return {
      async checkForUpdate() { return false; },
      async recoverFromProtocolMismatch() { return false; },
      dispose() {}
    };
  }

  let disposed = false;
  let lastCheckAt = 0;
  let checkPromise: Promise<boolean> | null = null;
  let recoveryPromise: Promise<boolean> | null = null;

  const checkForUpdate = async (
    _reason = "manual",
    force = false
  ): Promise<boolean> => {
    if (disposed) return false;
    const checkedAt = now();
    if (
      !force
      && lastCheckAt
      && checkedAt - lastCheckAt < Math.max(0, minCheckIntervalMs)
    ) {
      return false;
    }
    if (checkPromise) return checkPromise;
    lastCheckAt = checkedAt;
    checkPromise = (async () => {
      const registration = await serviceWorker.getRegistration("/");
      if (!registration) return false;
      await registration.update();
      (registration.waiting || registration.installing)?.postMessage?.({
        type: "SKIP_WAITING"
      });
      return true;
    })().catch(() => false).finally(() => {
      checkPromise = null;
    });
    return checkPromise;
  };

  const recoverFromProtocolMismatch = async (
    expectedProtocol = ""
  ): Promise<boolean> => {
    if (disposed) return false;
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => {
      const previousController = serviceWorker.controller;
      const registration = await serviceWorker.getRegistration("/");
      if (!registration) {
        windowObject.location.replace(cacheBustedUpgradeUrl(
          windowObject.location.href,
          expectedProtocol
        ));
        return true;
      }

      const controllerChanged = waitForControllerChange(
        serviceWorker,
        previousController,
        controllerTimeoutMs
      );
      let updateStarted = false;
      try {
        await registration.update();
        updateStarted = true;
        registration.waiting?.postMessage?.({ type: "SKIP_WAITING" });
      } catch {}

      if (updateStarted && await controllerChanged) {
        windowObject.location.reload();
        return true;
      }

      await registration.unregister().catch(() => false);
      windowObject.location.replace(cacheBustedUpgradeUrl(
        windowObject.location.href,
        expectedProtocol
      ));
      return true;
    })().catch(() => false);
    return recoveryPromise;
  };

  const checkWhenVisible = () => {
    if (
      documentObject?.visibilityState
      && documentObject.visibilityState !== "visible"
    ) {
      return;
    }
    void checkForUpdate("visible");
  };
  const checkWhenOnline = () => {
    void checkForUpdate("online");
  };
  const checkWhenFocused = () => {
    void checkForUpdate("focus");
  };

  documentObject?.addEventListener?.("visibilitychange", checkWhenVisible);
  windowObject.addEventListener?.("online", checkWhenOnline);
  windowObject.addEventListener?.("focus", checkWhenFocused);
  const intervalId = windowObject.setInterval?.(
    checkWhenVisible,
    Math.max(30_000, updateIntervalMs)
  );

  const coordinator: UpgradeCoordinator = {
    checkForUpdate,
    recoverFromProtocolMismatch,
    dispose() {
      if (disposed) return;
      disposed = true;
      documentObject?.removeEventListener?.(
        "visibilitychange",
        checkWhenVisible
      );
      windowObject.removeEventListener?.("online", checkWhenOnline);
      windowObject.removeEventListener?.("focus", checkWhenFocused);
      if (intervalId != null) windowObject.clearInterval?.(intervalId);
      if (activeCoordinator === coordinator) activeCoordinator = null;
    }
  };
  activeCoordinator = coordinator;
  void checkForUpdate("startup", true);
  return coordinator;
}

export function requestWorkbenchProtocolUpgrade(
  expectedProtocol = ""
): Promise<boolean> {
  const coordinator = activeCoordinator
    || installWorkbenchPwaUpgradeRecovery();
  return coordinator.recoverFromProtocolMismatch(expectedProtocol);
}
