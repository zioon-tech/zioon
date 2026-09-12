import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkbenchStaticHttpHandler
} from "../src/workbench-static-http-handler.mjs";

const resources = [];

async function createHarness() {
  const directory = mkdtempSync(join(tmpdir(), "zion-workbench-static-"));
  mkdirSync(join(directory, "assets"));
  mkdirSync(join(directory, "mobile"));
  mkdirSync(join(directory, "mobile", "assets"));
  writeFileSync(
    join(directory, "index.html"),
    "<!doctype html><title>Zion</title>",
    "utf8"
  );
  writeFileSync(join(directory, "assets", "app.js"), "export {};\n", "utf8");
  writeFileSync(
    join(directory, "mobile", "index.html"),
    "<!doctype html><title>Zion Mobile</title>",
    "utf8"
  );
  writeFileSync(
    join(directory, "mobile", "assets", "mobile.js"),
    "export {};\n",
    "utf8"
  );
  const handler = await createWorkbenchStaticHttpHandler({ root: directory });
  const server = createServer(async (request, response) => {
    const url = new URL(
      request.url || "/",
      `http://${request.headers.host || "127.0.0.1"}`
    );
    if (!await handler(request, response, url)) {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const result = {
    directory,
    server,
    url: `http://127.0.0.1:${address.port}`
  };
  resources.push(result);
  return result;
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await new Promise((resolve) => resource.server.close(resolve));
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("Workbench static HTTP handler", () => {
  it("serves Workbench and immutable assets with security headers", async () => {
    const harness = await createHarness();

    const document = await fetch(`${harness.url}/`);
    expect(document.status).toBe(200);
    expect(document.headers.get("content-type")).toContain("text/html");
    expect(document.headers.get("x-frame-options")).toBe("DENY");
    expect(document.headers.get("content-security-policy")).toContain(
      "connect-src 'self'"
    );
    await expect(document.text()).resolves.toContain("<title>Zion</title>");

    const asset = await fetch(`${harness.url}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(asset.headers.get("content-type")).toContain("text/javascript");
  });

  it("uses the SPA fallback without swallowing Runtime routes", async () => {
    const harness = await createHarness();

    const page = await fetch(`${harness.url}/session/example`);
    expect(page.status).toBe(200);
    await expect(page.text()).resolves.toContain("<title>Zion</title>");

    const api = await fetch(`${harness.url}/v1/models`);
    expect(api.status).toBe(404);
  });

  it("serves the independent Mobile SPA without falling back to Workbench", async () => {
    const harness = await createHarness();

    const redirect = await fetch(`${harness.url}/mobile`, {
      redirect: "manual"
    });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/mobile/");

    const index = await fetch(`${harness.url}/mobile/`);
    expect(index.status).toBe(200);
    await expect(index.text()).resolves.toContain("<title>Zion Mobile</title>");

    const route = await fetch(`${harness.url}/mobile/chat/session-1`);
    expect(route.status).toBe(200);
    await expect(route.text()).resolves.toContain("<title>Zion Mobile</title>");

    const asset = await fetch(`${harness.url}/mobile/assets/mobile.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
  });
});
