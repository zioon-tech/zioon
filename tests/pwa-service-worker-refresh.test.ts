import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Desktop PWA update recovery", () => {
  it("notifies existing desktop clients without navigating their drafts or taking over Mobile", () => {
    const source = readFileSync(
      resolve("public/sw-client-refresh.js"),
      "utf8"
    );

    expect(source).toContain('self.addEventListener("activate"');
    expect(source).toContain('self.addEventListener("message"');
    expect(source).toContain("event.waitUntil(self.skipWaiting())");
    expect(source).toContain("upgradingExistingWorker");
    expect(source).toContain('client.postMessage({ type: "ZION_WORKBENCH_UPDATE_AVAILABLE" })');
    expect(source).not.toContain("client.navigate");
    expect(source).toContain('url.pathname.startsWith("/mobile/")');
    expect(source.indexOf("await self.clients.claim()")).toBeLessThan(
      source.indexOf("client.postMessage")
    );
  });
});
