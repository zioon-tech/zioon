const TERMINAL_REFERENCE_PREFIX = "zterminal1:";

export function terminalDetailPath(sessionId: string): string {
  return `/terminal/${encodeURIComponent(sessionId)}`;
}

export function terminalRouteSessionId(routeParam: string): string {
  const value = String(routeParam || "");
  if (!value.startsWith(TERMINAL_REFERENCE_PREFIX)) return value;
  // React Router decodes route params and preserves encoded colons in doubly
  // encoded terminal references, but encoded slashes come back as literal "/".
  // Re-escape them so Runtime receives the canonical zterminal1 reference.
  return value.replace(/\//g, "%2F");
}
