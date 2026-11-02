import React from "react";
import { createRoot } from "react-dom/client";
import { MobileApp } from "./MobileApp";
import "./styles.css";
import "xterm/css/xterm.css";

const visualViewport = window.visualViewport;
let viewportFrame = 0;
function syncViewportHeight() {
  const height = visualViewport?.height || window.innerHeight;
  if (Number.isFinite(height) && height > 0) {
    document.documentElement.style.setProperty(
      "--app-height",
      `${Math.round(height)}px`,
    );
  }
}
function scheduleViewportSync() {
  window.cancelAnimationFrame(viewportFrame);
  viewportFrame = window.requestAnimationFrame(syncViewportHeight);
}

syncViewportHeight();
window.addEventListener("resize", scheduleViewportSync, { passive: true });
window.addEventListener("orientationchange", scheduleViewportSync, { passive: true });
window.addEventListener("pageshow", scheduleViewportSync, { passive: true });
visualViewport?.addEventListener("resize", scheduleViewportSync, { passive: true });
visualViewport?.addEventListener("scroll", scheduleViewportSync, { passive: true });

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MobileApp />
  </React.StrictMode>,
);
