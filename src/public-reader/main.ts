import "../styles.css";
import "../../extensions/dev.tools/styles.css";
import "../../extensions/dev.thinking/styles.css";
import "../../extensions/dev.toc/styles.css";
import "katex/dist/katex.min.css";
import "./reader.css";
import { mountPublicReader, type PublicDocument } from "./reader";
import { setDisplayPreferenceViewer } from "../editor/display-preferences";

const host = document.getElementById("public-reader");
const boot = document.getElementById("public-document");
async function start() {
  if (!host || !boot || !/^\/share\/[A-Za-z0-9_-]{43}\/?$/.test(location.pathname)) return null;
  try {
    const response = await fetch("/v1/account/me", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(5000) });
    const identity = response.ok ? await response.json() : null;
    setDisplayPreferenceViewer(identity?.authenticated && typeof identity.user?.id === "string" ? identity.user.id : "",
      typeof identity?.space?.id === "string" ? identity.space.id : undefined);
  } catch { setDisplayPreferenceViewer(""); }
  const path = location.pathname.replace(/\/$/, "");
  const document = JSON.parse(boot.textContent || "{}") as PublicDocument;
  boot.remove();
  return mountPublicReader(host, document, { path,
    presence: { url: `${path}/presence`, onAccessLost: () => location.reload() },
    refresh: async () => {
      const response = await fetch(`${path}/content`, { credentials: "same-origin", cache: "no-store",
        signal: AbortSignal.timeout(10000) });
      if (response.status === 404 || response.status === 403 || response.status === 401) return { state: "unavailable" };
      if (!response.ok) throw new Error("refresh_failed");
      return response.json();
    }, onAccessLost: () => location.reload()
  });
}
export const publicReader = start();
