import {
  readWorkbenchRuntimeConfig,
  WORKBENCH_RUNTIME_BASE_URL_STORAGE_KEY,
  WORKBENCH_RUNTIME_MODE_STORAGE_KEY
} from "./workbench-runtime-config";
import {
  accountRequest, pendingInvitation, setAccountSession, type AccountSession
} from "../../packages/account-ui/src/client";
import { installWorkbenchSpaceTransport, pinWorkbenchSpace, lockWorkbenchSpace, requestedWorkbenchSpace } from "./workbench-space";
import { captureSharingInvitation } from "../ui/workbench/SharingWorkbench";

const WORKBENCH_DEVICE_ID_KEY = "zion.access.deviceId";

type PairingInput = {
  pairingId?: string;
  secret?: string;
  userCode?: string;
};

type AccessHealth = {
  available: boolean;
  authRequired: boolean;
  authMode?: string;
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
  let health: AccessHealth = { available: false, authRequired: false };
  try {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { accept: "application/json" },
      credentials: "include",
      signal: AbortSignal.timeout(2500)
    });
    const body = await response.json().catch(() => null);
    health = {
      available: response.ok && body?.service === "zion-runtime",
      authRequired: body?.authRequired === true,
      authMode: body?.authMode || body?.accessControl
    };
  } catch {
    // A cold account Runtime or a failed health probe does not identify the
    // deployment as a legacy, unauthenticated Workbench.
  }
  if (health.available && (!health.authRequired || health.authMode)) return health;
  try {
    // The account gateway serves config without starting a user Runtime.
    const response = await fetch(`${baseUrl}/v1/account/config`, {
      headers: { accept: "application/json" },
      credentials: "include",
      signal: AbortSignal.timeout(2500)
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body?.mode === "accounts-v1") {
      return { available: true, authRequired: true, authMode: body.mode };
    }
  } catch { /* Keep the original health result for legacy/local hosts. */ }
  return health;
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

function renderUnavailableSpace(host: HTMLElement): Promise<void> {
  host.replaceChildren();
  const shell = document.createElement("main");
  shell.className = "zion-pairing-shell";
  const panel = document.createElement("section");
  panel.className = "zion-pairing-panel";
  const title = document.createElement("h1");
  title.textContent = "暂时无法进入这个空间";
  const message = document.createElement("p");
  message.textContent = "空间链接无效，或当前账号已失去访问权限。你可以返回自己的空间继续工作。";
  const button = document.createElement("button");
  button.textContent = "返回我的空间";
  button.onclick = () => {
    const url = new URL(location.href);
    url.pathname = "/";
    url.hash = "";
    for (const key of ["space", "session", "zionSession", "spaceInvite"]) url.searchParams.delete(key);
    location.assign(url);
  };
  panel.append(title, message, button);
  shell.append(panel);
  host.append(shell);
  // Navigation replaces the page. Never mount a Workbench with an unverified scope.
  return new Promise(() => {});
}

function renderUnavailableRuntime(host: HTMLElement): Promise<void> {
  host.replaceChildren();
  const shell = document.createElement("main");
  shell.className = "zion-pairing-shell";
  const panel = document.createElement("section");
  panel.className = "zion-pairing-panel";
  const title = document.createElement("h1");
  title.textContent = "暂时无法连接工作台";
  const message = document.createElement("p");
  message.textContent = "连接恢复后可以继续。请稍后重试。";
  const button = document.createElement("button");
  button.textContent = "重试";
  panel.append(title, message, button);
  shell.append(panel);
  host.append(shell);
  return new Promise((resolve, reject) => {
    button.addEventListener("click", () => {
      button.disabled = true;
      void ensureWorkbenchRuntimeAccess(host).then(resolve, reject);
    });
  });
}

export async function ensureWorkbenchRuntimeAccess(
  host: HTMLElement
): Promise<void> {
  captureSharingInvitation();
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
  if (!health.available) {
    if (config.mode === "runtime" || requestedWorkbenchSpace()) return renderUnavailableRuntime(host);
    return;
  }
  if (!health.authRequired) return;
  requireSameOrigin(config.baseUrl);
  persistRuntimeTarget(config.baseUrl);
  if (health.authMode === "accounts-v1") {
    try { installWorkbenchSpaceTransport(config.baseUrl); }
    catch { return renderUnavailableSpace(host); }
    const invitation = pendingInvitation();
    let unavailable = false;
    const account = await accountRequest<AccountSession>(config.baseUrl, "me").catch(error => {
      unavailable = !!requestedWorkbenchSpace() && [403, 404].includes(error.status);
      return null;
    });
    if (unavailable) return renderUnavailableSpace(host);
    if (account) setAccountSession(account);
    const profileReturn = location.pathname === "/account";
    if (account?.membership?.status === "active"
      && !invitation
      && profileReturn) {
      history.replaceState(history.state, "", "/");
    }
    const requiresGate = account?.membership?.status !== "active" || !!invitation;
    if (requiresGate) {
      const [{ createRoot }, { createElement }, { AccountPanel }] = await Promise.all([
        import("react-dom/client"), import("react"), import("../../packages/account-ui/src/AccountPanel")
      ]);
      host.classList.add("zion-account-gate");
      const root = createRoot(host);
      await new Promise<void>(resolve => {
        root.render(createElement(AccountPanel, {
          baseUrl: config.baseUrl,
          variant: "gate",
          onContinue: (session: AccountSession) => {
            setAccountSession(session);
            if (location.pathname === "/account") history.replaceState(history.state, "", "/");
            resolve();
          }
        }));
      });
      root.unmount();
      host.classList.remove("zion-account-gate");
    }
    // Re-enter the gate if membership or role changes. Backend checks remain
    // authoritative between polls, including existing collaboration streams.
    let identity = !requiresGate && !profileReturn && account
      ? account
      : await accountRequest<AccountSession>(config.baseUrl, "me");
    // Existing owners may still keep their work in a pre-personal-space
    // Runtime. Preserve that authenticated selection on login/profile return.
    // A non-owner team selection still returns to the user's own resources.
    const personal = identity.spaces?.find(space => space.kind === "personal");
    if (!requestedWorkbenchSpace() && identity.membership?.role !== "owner"
      && personal && personal.id !== identity.space.id) {
      const response = await fetch(`${config.baseUrl}/v1/account/me`, {
        headers: { accept: "application/json", "x-zioon-space-id": personal.id }, credentials: "include"
      });
      if (!response.ok) throw new Error("暂时无法进入你的工作台");
      identity = await response.json();
    }
    pinWorkbenchSpace(identity, config.baseUrl);
    const pinnedUrl = new URL(location.href);
    pinnedUrl.searchParams.set("space", identity.space.id);
    history.replaceState(history.state, "", pinnedUrl);
    setAccountSession(identity);
    let accessChanged = false;
    const requireReentry = () => {
      if (accessChanged) return;
      accessChanged = true;
      lockWorkbenchSpace();
      // Do not flush old-space edits through a cookie that now belongs to
      // another account. Preserve them locally before leaving the old page.
      const drafts = (window.zion?.panels?.listEditors?.() || []).map((entry: any) => {
        const editor = window.zion?.panels?.getEditorBySession?.(entry.panelId, entry.sessionId);
        return editor ? {
          sessionId: entry.sessionId,
          text: editor.getValue()
        } : null;
      }).filter(Boolean);
      try {
        localStorage.setItem(`zion.access.drafts:${identity.user.id}:${identity.space.id}`, JSON.stringify(drafts));
      } catch {}
      window.zion?.state?.set?.("workbench.accessChanged", true);
      const gate = document.createElement("dialog");
      const message = document.createElement("p");
      message.textContent = "账户或访问权限已变化。当前内容已保留，请重新进入工作台。";
      const button = document.createElement("button");
      button.textContent = "重新进入";
      button.onclick = () => {
        const url = new URL(location.href);
        for (const key of ["space", "session", "zionSession"]) url.searchParams.delete(key);
        location.assign(url);
      };
      const download = document.createElement("button");
      download.textContent = "下载保留的内容";
      download.onclick = () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(drafts, null, 2)], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = "zion-session-drafts.json";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      gate.append(message, download, button);
      gate.addEventListener("cancel", event => event.preventDefault());
      document.body.appendChild(gate);
      gate.showModal();
    };
    const checkIdentity = () => {
      if (accessChanged) return;
      void accountRequest<AccountSession>(config.baseUrl, "me").then(next => {
        if (next.user.id !== identity.user.id || next.space.id !== identity.space.id
          || next.membership?.status !== identity.membership?.status
          || next.membership?.role !== identity.membership?.role
          || JSON.stringify([...next.scopes].sort()) !== JSON.stringify([...identity.scopes].sort())) requireReentry();
      }).catch((error) => { if ([401, 403, 404].includes(error.status)) requireReentry(); });
    };
    window.setInterval(checkIdentity, 15_000);
    window.addEventListener("focus", checkIdentity);
    window.addEventListener("online", checkIdentity);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) checkIdentity(); });
    return;
  }
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
