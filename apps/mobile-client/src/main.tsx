import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry(failureCount, error) {
        const status = Number((error as { status?: number })?.status || 0);
        if ([401, 403, 404].includes(status)) return false;
        return failureCount < 2;
      },
      staleTime: 5_000,
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: false,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/mobile">
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
