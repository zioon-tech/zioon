import { workbenchStorage as localStorage } from "../../../src/runtime/workbench-space.ts";
export function createSessionUrlModel(opts) {
  const urlSessionKey = opts?.urlSessionKey || "zionSession";
  const urlSessionAltKey = opts?.urlSessionAltKey || "session";
  const lsLastKey = opts?.lsLastKey || "zion.sessions.lastActiveId";

  function getSessionIdFromURL() {
    try {
      const url = new URL(window.location.href);
      const q = url.searchParams.get(urlSessionKey) || url.searchParams.get(urlSessionAltKey);
      if (q) return String(q);
      const hash = (url.hash || "").replace(/^#/, "");
      if (!hash) return null;
      const hp = new window.URLSearchParams(hash.startsWith("?") ? hash.slice(1) : hash);
      const h = hp.get(urlSessionKey) || hp.get(urlSessionAltKey);
      return h ? String(h) : null;
    } catch {
      return null;
    }
  }

  function setSessionIdToURL(id, opts2) {
    try {
      const url = new URL(window.location.href);
      if (id) url.searchParams.set(urlSessionKey, String(id));
      else url.searchParams.delete(urlSessionKey);
      const next = url.toString();
      const push = !!opts2?.push;
      const st = { ...(window.history.state || {}), zionSessionId: id || null };
      if (push) window.history.pushState(st, "", next);
      else window.history.replaceState(st, "", next);
    } catch {}
  }

  function buildSessionURL(id) {
    try {
      const url = new URL(window.location.href);
      if (id) url.searchParams.set(urlSessionKey, String(id));
      else url.searchParams.delete(urlSessionKey);
      url.searchParams.delete(urlSessionAltKey);
      return url.toString();
    } catch {
      return window.location.href;
    }
  }

  function getLastActiveId() {
    const fromUrl = getSessionIdFromURL();
    if (fromUrl) return fromUrl;
    return localStorage.getItem(lsLastKey) || null;
  }

  function setLastActiveId(id, opts2) {
    try { setSessionIdToURL(id, opts2); } catch {}
    try {
      if (id) localStorage.setItem(lsLastKey, id);
      else localStorage.removeItem(lsLastKey);
    } catch {}
  }

  return { getSessionIdFromURL, setSessionIdToURL, buildSessionURL, getLastActiveId, setLastActiveId };
}
