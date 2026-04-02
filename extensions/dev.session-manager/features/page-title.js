export function createPageTitleManager(opts) {
  const zion = opts?.zion || window.zion;
  const defaultTitle = opts?.defaultTitle || "Zion Next (CM6) Playground";
  const loadMeta = opts?.loadMeta;
  const isDefaultTitle = opts?.isDefaultTitle;

  let __favSnapshot = null;
  let __favDotKey = null;

  function snapshotFavicons() {
    if (__favSnapshot) return __favSnapshot;
    try {
      const links = Array.from(document.querySelectorAll('link[rel~="icon"]'));
      __favSnapshot = links.map((el) => ({ el, href: el.getAttribute("href") || "" }));
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
        document.head.appendChild(el);
        __favSnapshot = [{ el, href: "" }];
        links = [el];
      }

      const d = 64;
      const canvas = document.createElement("canvas");
      canvas.width = d;
      canvas.height = d;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, d, d);
      ctx.beginPath();
      ctx.arc(d / 2, d / 2, d * 0.22, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = Math.max(2, Math.round(d * 0.05));
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.stroke();

      const url = canvas.toDataURL("image/png");
      for (const el of links) {
        try { el.setAttribute("href", url); } catch {}
      }
    } catch {}
  }

  function syncFaviconForRunState(sessionId) {
    try {
      const rs = zion?.state?.get(`chat.runs.${sessionId}`) || null;
      const streaming = !!rs?.streaming;
      const awaiting = !!rs?.awaiting;
      const aborted = !!rs?.aborted;
      const key = streaming ? "streaming" : (awaiting ? "awaiting" : (aborted ? "aborted" : "idle"));
      if (key === __favDotKey) return;
      __favDotKey = key;
      if (key === "idle") {
        restoreFavicons();
        return;
      }
      const accent = getCssVar("--accent", "#6272a4");
      const ok = getCssVar("--ok", "#50fa7b");
      const theme = (document.documentElement.getAttribute("data-theme") || "").toLowerCase();
      const abortedColor = theme === "light" ? "#dc2626" : "#ff5555";
      const color = key === "streaming" ? accent : (key === "awaiting" ? ok : abortedColor);
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

