export type AccountSession = {
  authenticated: true;
  mode: "accounts-v1";
  user: { id: string; name: string; email: string };
  space: { id: string; name: string; kind?: "personal" | "team" };
  membership: { role: string; status: string } | null;
  spaces?: Array<{
    id: string;
    name: string;
    kind: "personal" | "team";
    membership: { role: string; status: string };
  }>;
  capabilities?: { teamSpaces?: boolean };
  scopes: string[];
  sessionId: string;
  expiresAt: number;
};

export class AccountHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function accountRequest<T>(
  baseUrl: string, path: string, body?: unknown, method = body === undefined ? "GET" : "POST"
): Promise<T> {
  const response = await fetch(`${baseUrl}/v1/account/${path}`, {
    method, credentials: "include",
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new AccountHttpError(response.status, data.error || `HTTP ${response.status}`);
  return data as T;
}

// UI hints only; the Runtime revalidates every request. Never persist this
// identity snapshot or credentials in client storage.
let current: AccountSession | null = null;
export function setAccountSession(value: AccountSession | null) {
  current = value;
  if (typeof document !== "undefined") {
    document.documentElement.dataset.zionAccountReadonly =
      value && !value.scopes.includes("runtime.write") ? "true" : "false";
    globalThis.dispatchEvent(new Event("zion-account-changed"));
  }
}
export function currentAccountSession() { return current; }
export function accountCan(scope: string) { return !current || current.scopes.includes(scope); }

const invitationKey = "zion.account.pendingInvitation";
export function pendingInvitation(): string {
  const token = new URLSearchParams(location.hash.slice(1)).get("invite");
  if (token) {
    // Invitation survives the IdP round trip only in this tab. It must never
    // be copied into returnTo, referrers, account cookies or localStorage.
    try { sessionStorage.setItem(invitationKey, token); } catch { return token; }
    history.replaceState(history.state, "", location.pathname + location.search);
    return token;
  }
  try { return sessionStorage.getItem(invitationKey) || ""; } catch { return ""; }
}
export function clearInvitation() {
  try { sessionStorage.removeItem(invitationKey); } catch { /* unavailable storage */ }
  if (new URLSearchParams(location.hash.slice(1)).has("invite")) {
    history.replaceState(history.state, "", location.pathname + location.search);
  }
}

export type AccountAuthNotice = "cancelled" | "logged-out" | "";

export function accountAuthNotice(): AccountAuthNotice {
  const value = new URLSearchParams(location.search).get("zionAuth");
  return value === "cancelled" || value === "logged-out" ? value : "";
}

function accountReturnTo(value: string) {
  try {
    const target = new URL(value, location.origin);
    if (target.origin !== location.origin || !String(value).startsWith("/")) return value;
    target.searchParams.delete("zionAuth");
    // Browser-only state such as invitation tokens must not cross the IdP boundary.
    target.hash = "";
    return target.pathname + target.search;
  } catch {
    return value;
  }
}

function accountUiTheme(): "light" | "dark" {
  const selected = document.documentElement.dataset.theme;
  if (selected === "light" || selected === "dark") return selected;
  const colorScheme = getComputedStyle(document.documentElement).colorScheme;
  if (colorScheme === "light") return "light";
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function accountLoginUrl(baseUrl: string, returnTo: string) {
  const target = new URL(baseUrl || location.origin, location.href);
  if (target.origin !== location.origin) throw new Error("请从 Runtime 的同源地址打开 Zion 后登录。");
  return `${target.origin}/v1/account/login?${new URLSearchParams({
    returnTo: accountReturnTo(returnTo),
    uiTheme: accountUiTheme()
  })}`;
}
