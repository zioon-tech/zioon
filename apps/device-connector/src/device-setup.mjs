import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";

function normalizedId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizedPath(value) {
  let raw = String(value || "").trim();
  if (raw === "~" || raw.startsWith("~/")) {
    raw = raw === "~" ? homedir() : resolve(homedir(), raw.slice(2));
  }
  return resolve(raw).replace(/\/+$/, "");
}

function isInside(root, path) {
  const value = relative(normalizedPath(root), normalizedPath(path));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

export function resolveDeviceWorkspaceRoot({
  configured = "",
  initialCwd = "",
  cwd = "."
} = {}) {
  return normalizedPath(configured || initialCwd || cwd);
}

async function responseJson(response, action) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      body?.error
      || body?.detail
      || `${action} failed: HTTP ${response.status}`
    );
  }
  return body;
}

export function defaultDeviceProjectId(workspaceRoot) {
  return normalizedId(basename(normalizedPath(workspaceRoot))) || "workspace";
}

export function defaultDeviceResourceId(projectId) {
  return `workspace:${normalizedId(projectId) || "workspace"}`;
}

export function normalizeLocalToolsUrl(value) {
  const url = new URL(String(value || ""));
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("Device Connector local-tools URL must use loopback");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Device Connector local-tools URL must use HTTP or HTTPS");
  }
  return url.toString().replace(/\/+$/, "");
}

export async function ensureDeviceTerminalSessions({
  localToolsUrl,
  workspaceRoot,
  additionalRoots = [],
  sessionIds = [],
  fetchImpl = globalThis.fetch
}) {
  const explicit = [...new Set(
    (Array.isArray(sessionIds) ? sessionIds : [])
      .map(String)
      .filter(Boolean)
  )];
  if (explicit.length) return explicit;
  const baseUrl = normalizeLocalToolsUrl(localToolsUrl);
  const listed = await responseJson(
    await fetchImpl(new URL("/sessions", baseUrl), {
      method: "GET",
      headers: { accept: "application/json" }
    }),
    "List local terminal sessions"
  );
  const allowedRoots = [...new Set([
    workspaceRoot,
    ...(Array.isArray(additionalRoots) ? additionalRoots : [])
  ].map(normalizedPath))];
  const matching = (Array.isArray(listed?.sessions) ? listed.sessions : [])
    .filter((session) =>
      session?.active !== false
      && session?.id
      && session?.cwd
      && allowedRoots.some((root) => isInside(root, session.cwd))
    )
    .map((session) => String(session.id));
  if (matching.length) return [...new Set(matching)];

  const created = await responseJson(
    await fetchImpl(new URL("/sessions", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "local",
        initial_cwd: normalizedPath(workspaceRoot)
      })
    }),
    "Create local terminal session"
  );
  const sessionId = String(created?.session?.id || "").trim();
  if (!sessionId) {
    throw new Error("local-tools returned no terminal Session id");
  }
  return [sessionId];
}
