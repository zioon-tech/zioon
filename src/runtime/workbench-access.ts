import {
  readWorkbenchRuntimeConfig,
  WORKBENCH_RUNTIME_BASE_URL_STORAGE_KEY,
  WORKBENCH_RUNTIME_MODE_STORAGE_KEY
} from "./workbench-runtime-config";

const WORKBENCH_DEVICE_ID_KEY = "zion.access.deviceId";

type PairingInput = {
  pairingId?: string;
  secret?: string;
  userCode?: string;
};

type AccessHealth = {
  available: boolean;
  authRequired: boolean;
};

function pairingFromFragment(): PairingInput | null {
  const raw = globalThis.location?.hash?.replace(/^#/, "") || "";
  const query = raw.startsWith("/pair?")
    ? raw.slice(raw.indexOf("?") + 1)
    : raw;
  const values = new URLSearchParams(query);
  const pairingId = values.get("pairing_id") || "";
  const secret = values.get("pairing_secret") || "";
  if (!pairingId || !secret) return null;
  return { pairingId, secret };
}

function clearPairingFragment(): void {
  try {
    const url = new URL(globalThis.location.href);
    url.hash = "";
    globalThis.history.replaceState(globalThis.history.state, "", url);
  } catch {
    // The credential exchange already consumed the invitation.
  }
}

function workbenchDeviceId(): string {
  try {
    const existing = globalThis.localStorage.getItem(WORKBENCH_DEVICE_ID_KEY);
    if (existing) return existing;
    const id = `client:${globalThis.crypto.randomUUID()}`;
    globalThis.localStorage.setItem(WORKBENCH_DEVICE_ID_KEY, id);
    return id;
  } catch {
    return `client:${globalThis.crypto.randomUUID()}`;
  }
}

function workbenchDevice() {
  const navigatorWithHints = globalThis.navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = String(
    navigatorWithHints?.userAgentData?.platform
    || globalThis.navigator?.platform
    || ""
  );
  return {
    deviceId: workbenchDeviceId(),
    label: platform ? `${platform} Workbench` : "Browser Workbench",
    platform
  };
}

async function accessHealth(baseUrl: string): Promise<AccessHealth> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { accept: "application/json" },
      credentials: "include"
    });
    const body = await response.json().catch(() => null);
    return {
      available: response.ok && body?.service === "zion-runtime",
      authRequired: body?.authRequired === true
    };
  } catch {
    return { available: false, authRequired: false };
  }
}

async function hasAccessSession(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/v1/access/session`, {
      headers: { accept: "application/json" },
      credentials: "include"
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function exchangePairing(
  baseUrl: string,
  pairing: PairingInput
): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/access/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      ...pairing,
      device: workbenchDevice()
    })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.paired !== true) {
    throw new Error(body?.error || `Pairing failed: HTTP ${response.status}`);
  }
}

function requireSameOrigin(baseUrl: string): void {
  const runtimeOrigin = new URL(baseUrl, globalThis.location.href).origin;
  if (runtimeOrigin !== globalThis.location.origin) {
    throw new Error(
      "Remote Workbench authentication requires Workbench and Runtime "
      + "to use the same HTTPS origin"
    );
  }
}

function persistRuntimeTarget(baseUrl: string): void {
  try {
    globalThis.localStorage.setItem(
      WORKBENCH_RUNTIME_BASE_URL_STORAGE_KEY,
      baseUrl
    );
    globalThis.localStorage.setItem(
      WORKBENCH_RUNTIME_MODE_STORAGE_KEY,
      "runtime"
    );
  } catch {
    // The current page can still use the discovered Runtime for this load.
  }
  try {
    globalThis.window?.zion?.state?.set?.("runtime.baseUrl", baseUrl);
    globalThis.window?.zion?.state?.set?.("runtime.mode", "runtime");
  } catch {
    // The state service may not be initialized during the access gate.
  }
}

function renderPairingPrompt(
  host: HTMLElement,
  submit: (code: string) => Promise<void>,
  initialError = ""
): Promise<void> {
  host.innerHTML = "";
  const shell = document.createElement("main");
  shell.className = "zion-pairing-shell";
  const panel = document.createElement("section");
  panel.className = "zion-pairing-panel";
  const title = document.createElement("h1");
  title.textContent = "Connect Workbench";
  const description = document.createElement("p");
  description.textContent = "Enter the one-time code from an authorized device.";
  const form = document.createElement("form");
  form.className = "zion-pairing-form";
  const input = document.createElement("input");
  input.type = "text";
  input.name = "pairing-code";
  input.autocomplete = "one-time-code";
  input.inputMode = "text";
  input.placeholder = "XXXX-XXXX-XXXX";
  input.setAttribute("aria-label", "Pairing code");
  input.required = true;
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Connect";
  const status = document.createElement("p");
  status.className = "zion-pairing-status";
  status.setAttribute("role", "status");
  status.textContent = initialError;
  form.append(input, button);
  panel.append(title, description, form, status);
  shell.append(panel);
  host.append(shell);
  input.focus();

  return new Promise((resolve) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const code = input.value.trim();
      if (!code) return;
      input.disabled = true;
      button.disabled = true;
      status.textContent = "Connecting...";
      void submit(code).then(() => {
        resolve();
      }).catch((error) => {
        status.textContent = error instanceof Error
          ? error.message
          : String(error);
        input.disabled = false;
        button.disabled = false;
        input.select();
      });
    });
  });
}

export async function ensureWorkbenchRuntimeAccess(
  host: HTMLElement
): Promise<void> {
  let config = readWorkbenchRuntimeConfig({
    state: globalThis.window?.zion?.state,
    storage: globalThis.localStorage
  });
  let health = await accessHealth(config.baseUrl);
  const currentOrigin = globalThis.location?.origin || "";
  if (
    currentOrigin
    && currentOrigin !== config.baseUrl
    && (!health.available || !health.authRequired)
  ) {
    const sameOriginHealth = await accessHealth(currentOrigin);
    if (sameOriginHealth.available && sameOriginHealth.authRequired) {
      persistRuntimeTarget(currentOrigin);
      config = { ...config, baseUrl: currentOrigin, mode: "runtime", enabled: true };
      health = sameOriginHealth;
    }
  }
  if (!health.available || !health.authRequired) return;
  requireSameOrigin(config.baseUrl);
  persistRuntimeTarget(config.baseUrl);
  if (await hasAccessSession(config.baseUrl)) return;

  const pairing = pairingFromFragment();
  let pairingError = "";
  if (pairing) {
    try {
      await exchangePairing(config.baseUrl, pairing);
      return;
    } catch (error) {
      pairingError = error instanceof Error ? error.message : String(error);
    } finally {
      clearPairingFragment();
    }
  }
  await renderPairingPrompt(host, async (userCode) => {
    await exchangePairing(config.baseUrl, { userCode });
  }, pairingError);
}
