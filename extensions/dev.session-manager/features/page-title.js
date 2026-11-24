import { getSessionRunIndicatorStatus } from "./run-state.js";

export function createPageTitleManager(opts) {
  const zion = opts?.zion || window.zion;
  const defaultTitle = opts?.defaultTitle || "Zioon";
  const loadMeta = opts?.loadMeta;
  const isDefaultTitle = opts?.isDefaultTitle;

  let __favSnapshot = null;
  let __favDotKey = null;

  function snapshotFavicons() {
    if (__favSnapshot) return __favSnapshot;
    try {
      const links = Array.from(document.querySelectorAll('link[rel~="icon"]'));
      __favSnapshot = links.map((el) => ({
        el, href: el.getAttribute("href") || "", type: el.getAttribute("type")
      }));
    } catch {
      __favSnapshot = [];
    }
    return __favSnapshot;
  }

  function restoreFavicons() {
    try {
      const snap = snapshotFavicons();
      for (const it of snap) {
        try {
          if (!it?.el) continue;
          if (it.href) it.el.setAttribute("href", it.href);
          if (it.type) it.el.setAttribute("type", it.type);
          else it.el.removeAttribute("type");
        } catch {}
      }
    } catch {}
  }

  function getCssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch {
      return fallback;
    }
  }

  function setFaviconDot(color) {
    try {
      const snap = snapshotFavicons();
      let links = snap.map(s => s.el).filter(Boolean);
      if (links.length === 0) {
        const el = document.createElement("link");
        el.setAttribute("rel", "icon");
        el.setAttribute("href", "/favicon.svg?v=4");
        el.setAttribute("type", "image/svg+xml");
        document.head.appendChild(el);
        __favSnapshot = [{ el, href: "/favicon.svg?v=4", type: "image/svg+xml" }];
        links = [el];
      }

      const dotColor = String(color).replace(/[&"<>]/g, char => ({
        "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;"
      })[char]);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="none">
        <rect x="74" y="74" width="876" height="876" rx="197" fill="#2b2f32"/>
        <path d="M300 352H689L335 676H678" stroke="#f9f9f9" stroke-width="82" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="779" cy="675" r="44" fill="${dotColor}"/>
      </svg>`;
      const url = "data:image/svg+xml," + encodeURIComponent(svg);
      for (const el of links) {
        try {
          el.setAttribute("type", "image/svg+xml");
          el.setAttribute("href", url);
        } catch {}
      }
    } catch {}
  }

  function syncFaviconForRunState(sessionId) {
    try {
      const rs = zion?.state?.get(`chat.runs.${sessionId}`) || null;
        const key = getSessionRunIndicatorStatus(rs) || "idle";
      if (key === __favDotKey) return;
      __favDotKey = key;
      if (key === "idle") {
        restoreFavicons();
        return;
      }
      const accent = getCssVar("--accent", "#6272a4");
      const ok = getCssVar("--ok", "#50fa7b");
        const danger = getCssVar("--danger", "#ef4444");
        const warning = getCssVar("--warning", "#d29922");
        const color = key === "streaming"
          ? accent
          : key === "ready"
            ? ok
            : key === "error"
              ? danger
              : warning;
      setFaviconDot(color);
    } catch {}
  }

  function updatePageTitle(id) {
    const sessionId = id || zion?.state?.get("sessions.currentId");
    if (!sessionId) {
      document.title = defaultTitle;
      try { __favDotKey = null; restoreFavicons(); } catch {}
      return;
    }
    const meta = loadMeta(sessionId);
    const title = meta?.title;
    const base = (!title || isDefaultTitle(title)) ? defaultTitle : title;
    document.title = base;
    syncFaviconForRunState(sessionId);
  }

  return { updatePageTitle, syncFaviconForRunState, restoreFavicons };
}
