import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Desktop PWA update recovery", () => {
  it("refreshes existing desktop clients without taking over Mobile", () => {
    const source = readFileSync(
      resolve("public/sw-client-refresh.js"),
      "utf8"
    );

    expect(source).toContain('self.addEventListener("activate"');
    expect(source).toContain('self.addEventListener("message"');
    expect(source).toContain("event.waitUntil(self.skipWaiting())");
    expect(source).toContain("upgradingExistingWorker");
    expect(source).toContain("void client.navigate(client.url)");
    expect(source).not.toContain("await client.navigate(client.url)");
    expect(source).toContain('url.pathname.startsWith("/mobile/")');
    expect(source.indexOf("await self.clients.claim()")).toBeLessThan(
      source.indexOf("client.navigate(client.url)")
    );
  });
});
