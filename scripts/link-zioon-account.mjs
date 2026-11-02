#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { memoryConnectionDirectory } from "../apps/runtime/src/accounts/memory-account-connection.mjs";

/** Explicit proof of both current sessions. Credentials stay in private local
 * configuration and HTTPS request bodies; they are never printed or bundled. */
export async function linkZioonAccount({
  memoryUrl = "https://memory.zioon.tech", runtimeUrl = "https://runtime.zioon.tech",
  adcSessionFile = join(homedir(), ".config/adc/config.json.session"),
  runtimeConfigFile, linkRuntime = false
} = {}) {
  for (const value of [memoryUrl, runtimeUrl]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash
      || url.username || url.password) throw new Error("Use the service's HTTPS origin");
  }
  if (!runtimeConfigFile) {
    const directory = join(homedir(), ".zion-next/sandbox-demo");
    const local = JSON.parse(await readFile(join(directory, "account.json"), "utf8"));
    runtimeConfigFile = join(memoryConnectionDirectory(join(directory, "runtime/memory-connections"), local), "config.json");
  }
  const adc = JSON.parse(await readFile(adcSessionFile, "utf8"));
  const runtime = JSON.parse(await readFile(runtimeConfigFile, "utf8"));
  if (adc.url !== "https://adc.zioon.tech" || typeof adc.token !== "string"
    || !runtime.apiKey?.startsWith("zion_account_v1.") || runtime.zionAccount?.runtimeUrl !== runtimeUrl) {
    throw new Error("Valid ADC and Runtime account sessions are required");
  }
  async function request(url, token, body) {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000),
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`Account link failed: HTTP ${response.status}, ${result.error || result.code || "unavailable"}`);
    return result;
  }
  const identity = await request(`${adc.url}/api/v1/me`, adc.token);
  const old = await request(`${runtimeUrl}/v1/account/me`, runtime.apiKey);
  if (identity.kind !== "session" || !identity.user?.id || !old.authenticated
    || old.membership?.status !== "active") throw new Error("Both identities must be active account sessions");
  await request(`${memoryUrl}/zion/accounts/link`, adc.token, { runtimeToken: runtime.apiKey });
  if (linkRuntime) {
    await request(`${runtimeUrl}/v1/account/identity/link`, runtime.apiKey, { adcToken: adc.token });
    const verified = await request(`${runtimeUrl}/v1/account/me`, runtime.apiKey);
    if (verified.user.id !== old.user.id || verified.space.id !== old.space.id
      || verified.accountIdentity?.subject !== identity.user.id) throw new Error("Linked account verification failed");
  }
  const memory = await request(`${memoryUrl}/auth/me`, runtime.apiKey);
  if (memory.defaultDriveId !== runtime.defaultDrive || memory.defaultOrgId !== runtime.defaultOrg) {
    throw new Error("Memory drive changed unexpectedly");
  }
  return { linked: true, adcUserId: identity.user.id, runtimeUserId: old.user.id,
    memoryDriveId: memory.defaultDriveId };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 1 || args[0] !== "--include-runtime")) throw new Error("Use --include-runtime only for an explicitly planned Runtime migration");
    console.log(JSON.stringify(await linkZioonAccount({ linkRuntime: args[0] === "--include-runtime" }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
