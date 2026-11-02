// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deploymentConfig,
  updateEnvironment
} from "../scripts/configure-runtime-deployment.mjs";
import {
  normalizeRuntimeOrigin,
  replaceRuntimeUrlArgument
} from "../scripts/migrate-device-connector-origin.mjs";

describe("Runtime deployment configuration", () => {
  it("keeps single-machine mode on loopback without Caddy", () => {
    expect(deploymentConfig({
      mode: "local",
      runtimePort: 8766
    })).toMatchObject({
      publicOrigin: "http://127.0.0.1:8766",
      connectorOrigin: null,
      caddyfile: ""
    });
  });

  it("derives TLS hostnames from an IP-only deployment", () => {
    const config = deploymentConfig({
      mode: "ip",
      publicIp: "203.0.113.10",
      runtimePort: 8766,
      httpsPort: 8443
    });

    expect(config.publicOrigin).toBe("https://203-0-113-10.sslip.io:8443");
    expect(config.connectorOrigin).toBe("https://203-0-113-10.nip.io:8443");
    expect(config.caddyfile).toContain("reverse_proxy 127.0.0.1:8766");
    expect(config.caddyfile).not.toContain("/observability/");
  });

  it("generates an authenticated observability route without exposing ingest paths", () => {
    const config = deploymentConfig({
      mode: "domain",
      domain: "runtime.example.com",
      runtimePort: 8766,
      observabilityPort: 16686
    });

    expect(config.caddyfile).toContain(
      "@observabilityMcp path /observability/api/ai/mcp/*"
    );
    expect(config.caddyfile).toContain("respond @observabilityMcp 404");
    expect(config.caddyfile).toContain(
      "@observabilityOtlp path /observability/api/otlp/*"
    );
    expect(config.caddyfile).toContain("respond @observabilityOtlp 404");
    expect(config.caddyfile).toContain(
      "uri /v1/access/authorize/observability"
    );
    expect(config.caddyfile).toContain(
      "reverse_proxy 127.0.0.1:16686"
    );
    expect(config.caddyfile).toContain("header_up -Cookie");
    expect(config.caddyfile).toContain("header_up -Authorization");
    expect(config.caddyfile).toContain(
      "handle {\n\t\treverse_proxy 127.0.0.1:8766"
    );
  });

  it("keeps explicit legacy origins during domain migration", () => {
    const config = deploymentConfig({
      mode: "domain",
      domain: "runtime.example.com",
      publicIp: "203.0.113.10",
      legacyOrigins: ["https://203-0-113-10.sslip.io:8443"]
    });

    expect(config.publicOrigin).toBe("https://runtime.example.com");
    expect(config.allowedOrigins).toEqual([
      "https://runtime.example.com",
      "https://203-0-113-10.sslip.io:8443"
    ]);
    expect(config.caddyfile).toContain("https://runtime.example.com {");
    expect(config.caddyfile).toContain(
      "https://203-0-113-10.sslip.io:8443 {"
    );
  });

  it("updates only the managed Runtime environment keys", () => {
    expect(updateEnvironment(
      "NODE_ENV=production\nZION_RUNTIME_PUBLIC_URL=https://old.example\nSECRET=x\n",
      {
        ZION_RUNTIME_PUBLIC_URL: "https://runtime.example.com",
        ZION_RUNTIME_ALLOWED_ORIGINS: "https://runtime.example.com"
      }
    )).toBe(
      "NODE_ENV=production\n"
      + "ZION_RUNTIME_PUBLIC_URL=https://runtime.example.com\n"
      + "SECRET=x\n"
      + "ZION_RUNTIME_ALLOWED_ORIGINS=https://runtime.example.com\n"
    );
  });

  it("pins persistent single-node Jaeger storage and a metadata-only pipeline", () => {
    const compose = readFileSync(
      resolve("deploy/otel-collector/compose.yaml"),
      "utf8"
    );
    const jaeger = readFileSync(
      resolve("deploy/otel-collector/jaeger.yaml"),
      "utf8"
    );
    const collector = readFileSync(
      resolve("deploy/otel-collector/config.yaml"),
      "utf8"
    );

    expect(compose).toContain("jaeger:2.20.0");
    expect(compose).toContain("jaeger-data:/badger");
    expect(compose).toContain("127.0.0.1:16686:16686");
    expect(compose).toContain("127.0.0.1:4318:4318");
    expect(jaeger).toContain("ephemeral: false");
    expect(jaeger).toContain("spans: 168h");
    expect(collector).not.toContain("debug:");
    expect(collector).toContain("exporters: [otlp_http/jaeger]");
  });
});

describe("Device Connector origin migration", () => {
  it("normalizes an HTTPS origin", () => {
    expect(normalizeRuntimeOrigin("https://runtime.example.com/"))
      .toBe("https://runtime.example.com");
    expect(() => normalizeRuntimeOrigin("http://runtime.example.com"))
      .toThrow("must use HTTPS");
  });

  it("replaces the Runtime URL and removes accidental duplicate URLs", () => {
    expect(replaceRuntimeUrlArgument([
      "/usr/local/bin/node",
      "/workspace/apps/device-connector/src/main.mjs",
      "--runtime-url",
      "https://old.example:8443",
      "https://stale.example:8443",
      "--local-tools-url",
      "http://127.0.0.1:8765"
    ], "https://runtime.example.com")).toEqual([
      "/usr/local/bin/node",
      "/workspace/apps/device-connector/src/main.mjs",
      "--runtime-url",
      "https://runtime.example.com",
      "--local-tools-url",
      "http://127.0.0.1:8765"
    ]);
  });
});
