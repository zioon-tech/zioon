import { createRuntimeControlClient, resolveRuntimeCliTarget } from "../../../apps/runtime/src/runtime-cli.mjs";
import { resolveRuntimeCliHeaders } from "../../../apps/runtime/src/accounts/cli-account-auth.mjs";
import { createExtensionsClient } from "../../runtime-client/src/extensions.mjs";
import { createPluginDevelopmentClient } from "../../runtime-client/src/plugin-development.mjs";
export { createPluginDevelopmentClient, watchDevelopmentSource } from "../../runtime-client/src/plugin-development.mjs";
export { runtimePluginToolRequest, extensionRunRequest } from "../../runtime-client/src/extensions.mjs";
export { subscribeRunStream } from "../../runtime-client/src/run-stream.mjs";

// Node SDK reuses the CLI's saved account credential without returning the token.
export async function createAccountRuntimeClient({
  baseUrl = "https://runtime.zioon.tech", runtimeProfile, fetchImpl = globalThis.fetch,
  credentialStore, environment = process.env
} = {}) {
  const target = resolveRuntimeCliTarget({
    argv: runtimeProfile ? ["--runtime-profile", runtimeProfile] : ["--url", baseUrl, "--account"],
    environment
  });
  const headers = await resolveRuntimeCliHeaders(target, { credentialStore, fetchImpl });
  return Object.freeze({
    runtime: createRuntimeControlClient({ baseUrl: target.baseUrl, headers, fetchImpl }),
    extensions: createExtensionsClient({ baseUrl: target.baseUrl, headers, fetchImpl }),
    development: createPluginDevelopmentClient({ baseUrl: target.baseUrl, headers, fetchImpl })
  });
}
