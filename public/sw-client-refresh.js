const upgradingExistingWorker = Boolean(self.registration.active);

self.addEventListener("message", (event) => {
  if (event.data?.type !== "SKIP_WAITING") return;
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  if (!upgradingExistingWorker) return;
  event.waitUntil((async () => {
    await self.clients.claim();
    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });
    windows.forEach((client) => {
      const url = new URL(client.url);
      if (
        url.origin !== self.location.origin
        || url.pathname === "/mobile"
        || url.pathname.startsWith("/mobile/")
      ) {
        return;
      }
      client.postMessage({ type: "ZION_WORKBENCH_UPDATE_AVAILABLE" });
    });
  })());
});
