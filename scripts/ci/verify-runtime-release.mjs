import assert from "node:assert/strict";
import { sandboxConfig } from "../../packages/sandbox/src/config.mjs";
import { ManagedSandboxProvider } from "../../packages/sandbox/src/provider.mjs";

await import("../../apps/runtime/src/server.mjs");
console.log("Runtime release: HTTP dependency graph resolved");

// Exercise the lazy SDK import from the release itself without contacting a
// provider or requiring production credentials.
const provider = new ManagedSandboxProvider(sandboxConfig({
  E2B_API_KEY: "release-validation-only",
  ZION_SANDBOX_TEMPLATE: "release-validation-only"
}));
const SDK = await provider.sdk();
for (const method of ["create", "connect", "getInfo", "list", "kill"]) {
  assert.equal(typeof SDK?.[method], "function", `Sandbox SDK is missing ${method}`);
}
console.log("Runtime release: managed Sandbox SDK resolved");
