import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { adcAuthUiPlan } from "./adc-auth-ui-patch.mjs";

function once(text, before, after, label) {
  if (text.includes(after)) return text;
  if (text.split(before).length !== 2) throw new Error(`Source differs at ${label}; no files applied`);
  return text.replace(before, after);
}
function region(text, start, end, replacement, label) {
  const first = text.indexOf(start), last = text.indexOf(end, first + start.length);
  if (first < 0 || last < 0 || text.indexOf(start, first + 1) >= 0) {
    throw new Error(`Source differs at ${label}; no files applied`);
  }
  return text.slice(0, first) + replacement + text.slice(last);
}
export async function adcPlan(root, payload, { includeConsole = true } = {}) {
  const changes = [];
  async function edit(path, transform) {
    const before = await readFile(join(root, path), "utf8"), after = transform(before);
    if (before !== after) changes.push({ path, before, after });
  }
  async function add(path, source) {
    let before = null;
    try { before = await readFile(join(root, path), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (before !== source) changes.push({ path, before, after: source });
  }
  await edit("apps/control-plane/src/main.ts", (text) => {
    text = once(text, 'import { createAccessService } from "./access.ts";',
      'import { createAccessService } from "./access.ts";\nimport { registerZioonAccounts } from "./zioon-register.mjs";', "ADC imports");
    text = once(text, "const app = await createControlPlane({",
      "const access = createAccessService(authentication, new IdentityStore(store.pool));\nconst app = await createControlPlane({", "ADC access");
    text = once(text, "  access: createAccessService(authentication, new IdentityStore(store.pool)),",
      "  access,", "ADC shared access");
    return once(text, "await app.listen({ port, host });",
      "await registerZioonAccounts(app, access);\nawait app.listen({ port, host });", "ADC registration");
  });
  if (includeConsole) changes.push(...await adcAuthUiPlan(root));
  await add("apps/control-plane/src/zioon-register.mjs", await readFile(join(payload, "adc-register.mjs"), "utf8"));
  await add("apps/control-plane/src/zioon-register.d.mts",
    'import type { FastifyInstance } from "fastify";\nimport type { AccessService } from "./access.ts";\nexport function registerZioonAccounts(app: FastifyInstance, access: AccessService): Promise<void>;\n');
  await add("apps/control-plane/src/zioon-provider.mjs", await readFile(join(payload, "zioon-provider.mjs"), "utf8"));
  return changes;
}

export async function runtimePlan(root, payload) {
  const fragments = JSON.parse(await readFile(join(payload, "runtime-fragments.json"), "utf8"));
  const changes = [];
  async function edit(path, transform, optional = false) {
    let before;
    try { before = await readFile(join(root, path), "utf8"); }
    catch (error) { if (optional && error.code === "ENOENT") return; throw error; }
    const after = transform(before);
    if (after !== before) changes.push({ path, before, after });
  }
  await edit("apps/runtime/src/accounts/postgres-account-store.mjs", (text) => {
    if (text.includes("  async identityForUser(")) {
      const after = region(text, "  async identityForUser(", "  async personalSpace(", fragments.storeMethods,
        "Runtime account identity methods");
      if (after !== text) throw new Error("Runtime identity methods differ; inspect before applying");
      return text;
    }
    return once(text, "  async personalSpace(", `${fragments.storeMethods}  async personalSpace(`, "Runtime identity store");
  });
  await edit("apps/runtime/src/accounts/account-access-control.mjs", (text) => {
    if (!text.includes("sharedAccountIssuer =")) {
      text = once(text, 'servedSpaceId = "",',
        'servedSpaceId = "", adcOrigin = "", sharedAccountIssuer = "",', "Runtime constructor");
    }
    if (!text.includes("this.adcOrigin =")) {
      text = once(text, "    this.oidc = oidc;", `    this.oidc = oidc;\n${fragments.accessProperties}`, "Runtime identity origins");
    }
    text = text.replace('if (!this.oidc.secureCookies && request.method === "GET"', 'if (request.method === "GET"');
    if (!text.includes("accountIdentity: await")) {
      text = once(text, "authenticated: true, mode: this.mode, user: principal.user, space: principal.space,",
        "authenticated: true, mode: this.mode, user: principal.user, space: principal.space,\n            accountIdentity: await this.accounts.identityForUser?.(userId, this.sharedAccountIssuer || this.oidc.issuer) || null,", "Runtime account identity");
    }
    text = text.replace("identityForUser?.(userId, this.oidc.issuer)", "identityForUser?.(userId, this.sharedAccountIssuer || this.oidc.issuer)");
    if (!text.includes('path === "/v1/account/identity/link"')) {
      text = once(text, '        } else if (request.method === "POST" && ["/v1/account/logout", "/v1/access/logout"].includes(path)) {',
        fragments.linkRoute + '        } else if (request.method === "POST" && ["/v1/account/logout", "/v1/access/logout"].includes(path)) {',
        "Runtime identity link");
    }
    return text;
  });
  await edit("apps/runtime/src/main.mjs", (text) => {
    if (text.includes("sharedAccountIssuer: process.env.ZIOON_ACCOUNT_ISSUER")) return text;
    return once(text, "      servedSpaceId: runtimeSpaceId",
      '      adcOrigin: process.env.ZIOON_ADC_ORIGIN || "",\n      sharedAccountIssuer: process.env.ZIOON_ACCOUNT_ISSUER || "",\n      servedSpaceId: runtimeSpaceId',
      "Runtime identity configuration");
  });
  await edit("apps/runtime/src/accounts/memory-delegation.mjs", (text) => {
    if (text.includes("const accountIdentity =")) {
      return text.replace("identityForUser?.(userId, accessControl.oidc?.issuer)",
        "identityForUser?.(userId, accessControl.sharedAccountIssuer || accessControl.oidc?.issuer)");
    }
    return once(text, "  return { authenticated: true, user, space, membership, scopes };",
      '  const accountIdentity = await accessControl.accounts.identityForUser?.(userId, accessControl.sharedAccountIssuer || accessControl.oidc?.issuer) || null;\n  return { authenticated: true, user, space, membership, scopes, accountIdentity };',
      "Runtime delegated identity");
  }, true);
  return changes;
}
export async function applyPlan(root, changes) {
  // First verify every original; never apply a partial plan to drifted sources.
  for (const change of changes) {
    let value = null;
    try { value = await readFile(join(root, change.path), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (value !== change.before) throw new Error(`Source changed: ${change.path}`);
  }
  for (const change of changes) {
    const path = join(root, change.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, change.after);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  try {
    const [kind, root, payload, mode, scope] = process.argv.slice(2);
    if (!["adc", "runtime"].includes(kind) || !root || !payload || !["check", "apply"].includes(mode)) {
      throw new Error("Usage: node patch-sources.mjs adc|runtime ROOT PAYLOAD check|apply");
    }
    const changes = kind === "adc" ? await adcPlan(root, payload, { includeConsole: scope !== "memory-only" })
      : await runtimePlan(root, payload);
    if (mode === "apply") await applyPlan(root, changes);
    console.log(JSON.stringify({ kind, mode, files: changes.map((value) => value.path) }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
