#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createFileCliCredentialStore } from "../apps/runtime/src/cli-credential-store.mjs";
import { createSiteServer } from "../apps/public-site/serve.mjs";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedVersion = JSON.parse(await readFile(join(root, "packages/zioon-cli/package.json"), "utf8")).version;
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "zioon-release-verify-"));
const storePath = join(directory, "credentials");
const environment = { ...process.env, ZION_RUNTIME_CLI_CONFIG: join(directory, "cli.json"),
  ZION_RUNTIME_URL: "", ZION_RUNTIME_PROFILE: "", ZIOON_CLI_CREDENTIAL_DIR: storePath };
const site = createSiteServer();
let requests = [];
let installedFixture = false;
const personalSpace = { id: "fixture-personal", kind: "personal" };
const installation = { id: "private:fixture:skill", name: "Fixture Skill", version: "0.1.0",
  versions: [{ version: "0.1.0", digest: "fixture-source" }],
  installation: { version: "0.1.0", executionEpoch: "fixture-epoch", enabled: true } };
const server = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push({ path: req.url, method: req.method, authenticated: Boolean(req.headers.authorization),
    spaceId: req.headers["x-zioon-space-id"],
    body: body ? JSON.parse(body) : undefined });
  if (req.url === "/v1/account/device/start") {
    res.end(JSON.stringify({ flowToken: "fixture-flow", verificationUriComplete: "https://identity.test/activate?code=TEST-CODE",
      userCode: "TEST-CODE", interval: 5, expiresAt: Date.now() + 30000 }));
  } else if (req.url === "/v1/account/device/poll") {
    res.end(JSON.stringify({ token: "zion_account_v1.fixture", expiresAt: Date.now() + 60000 }));
  } else if (req.url === "/v1/account/me") {
    res.end(JSON.stringify({ user: { id: "fixture-user" }, space: personalSpace,
      spaces: [personalSpace], expiresAt: Date.now() + 60000 }));
  } else if (req.url === "/v1/runs" && req.method === "POST") {
    assert.ok(req.headers.authorization);
    res.writeHead(202); res.end('{"runId":"fixture-run"}');
  } else if (req.url.includes("/stream")) {
    res.writeHead(404); res.end("{}");
  } else if (req.url.includes("/events") || req.url.includes("/projection")) {
    res.end('{"events":[]}');
  } else if (req.url === "/v1/marketplace/snapshot") {
    res.end(JSON.stringify({ revision: 0, entries: installedFixture ? [installation] : [] }));
  } else if (req.url.includes("/v1/runs/")) {
    const status = req.url.endsWith("failed") ? "failed" : "completed";
    res.end(JSON.stringify({ run: { id: "fixture-run", status, output: "fixture-output" } }));
  } else { res.end("{}"); }
});
const close = async (target) => new Promise((done) => { target.close(done); target.closeAllConnections(); });
try {
  await new Promise((done) => site.listen(0, "127.0.0.1", done));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const siteUrl = `http://127.0.0.1:${site.address().port}`;
  const runtimeUrl = `http://127.0.0.1:${server.address().port}`;
  await run("npm", ["install", "--prefix", directory, "--ignore-scripts",
    `${siteUrl}/downloads/zioon-cli-${expectedVersion}.tgz`]);
  const entry = join(directory, "node_modules/.bin/zioon");
  const cli = async (...args) => run(process.execPath, [entry, ...args], { env: environment, timeout: 30000 });
  assert.equal((await cli("--version")).stdout.trim(), `zioon ${expectedVersion}`);
  assert.match((await cli("--help")).stdout, /api <METHOD>/);
  assert.match((await cli("profile", "list")).stdout, /https:\/\/runtime.zioon.tech/);
  const login = await cli("auth", "login", "--url", runtimeUrl, "--account");
  assert.match(login.stdout, /code=TEST-CODE/);
  assert.ok(!login.stdout.includes("zion_account_v1."));
  assert.equal((await stat(storePath)).mode & 0o777, 0o700);
  assert.equal(JSON.parse((await cli("auth", "status", "--url", runtimeUrl, "--account")).stdout).authenticated, true);
  assert.deepEqual(JSON.parse((await cli("api", "GET", "/v1/account/me", "--url", runtimeUrl, "--account")).stdout).user, { id: "fixture-user" });
  assert.equal(JSON.parse((await cli("api", "POST", "/v1/runs", "--data", '{"prompt":"fixture"}', "--url", runtimeUrl, "--account")).stdout).runId, "fixture-run");
  assert.ok(requests.some((req) => req.path === "/v1/runs" && req.authenticated && req.body.prompt === "fixture"));
  await assert.rejects(cli("api", "GET", "https://other.test/v1/account/me"));
  await cli("extensions", "init", join(directory, "my-tool"), "--kind", "plugin");
  await cli("extensions", "validate", join(directory, "my-tool"));
  await cli("extensions", "pack", join(directory, "my-tool"), "--out", join(directory, "my-tool.zion.json"));
  const artifact = JSON.parse(await readFile(join(directory, "my-tool.zion.json"), "utf8"));
  assert.equal(artifact.kind, "plugin");
  for (const kind of ["model", "mcp"]) {
    const project = join(directory, `my-${kind}`);
    await cli("extensions", "init", project, "--kind", kind);
    await cli("extensions", "validate", project);
    await cli("extensions", "pack", project, "--out", join(directory, `my-${kind}.zion.json`));
  }
  await assert.rejects(cli("attach", "failed", "--url", runtimeUrl, "--account", "--raw-events", "--jsonl"), { code: 1 });
  const skillProject = join(directory, "my-skill");
  await cli("extensions", "init", skillProject, "--kind", "skill");
  await mkdir(join(skillProject, "references"));
  await mkdir(join(skillProject, "scripts"));
  await writeFile(join(skillProject, "references/guide.md"), "Packaged reference");
  await writeFile(join(skillProject, "scripts/helper.py"), "print('packaged helper')");
  await cli("extensions", "pack", skillProject, "--out", join(directory, "my-skill.zion.json"));
  const skillArtifact = JSON.parse(await readFile(join(directory, "my-skill.zion.json"), "utf8"));
  assert.equal(skillArtifact.files["references/guide.md"], "Packaged reference");
  assert.equal(skillArtifact.files["scripts/helper.py"], "print('packaged helper')");
  const sdk = await import(pathToFileURL(join(directory, "node_modules/@zioon/cli/dist/sdk.mjs")));
  assert.equal(typeof sdk.resumeRun, "function");
  const store = createFileCliCredentialStore({ directory: storePath, platform: "linux" });
  const { runtime, extensions } = await sdk.createAccountRuntimeClient({ baseUrl: runtimeUrl, credentialStore: store });
  assert.equal((await runtime.createRun({ prompt: "sdk" })).runId, "fixture-run");
  assert.equal((await runtime.followRun("fixture-run", () => {})).status, "completed");
  assert.deepEqual((await extensions.snapshot()).entries, []);
  installedFixture = true;
  const editedFile = join(directory, "edited-skill.md");
  await writeFile(editedFile, "edited personal source");
  for (const [action, options, expectedAction] of [
    ["files", [], "workspace-prepare"],
    ["read", ["--path", "SKILL.md"], "workspace-read"],
    ["write", ["--path", "SKILL.md", "--file", editedFile, "--source-hash", "fixture-hash"], "workspace-write"],
    ["reload", ["--source-hash", "fixture-hash"], "workspace-reload"],
    ["restore", [], "workspace-restore"]
  ]) {
    requests = [];
    assert.equal(JSON.parse((await cli("extensions", action, installation.id, ...options, "--url", runtimeUrl, "--account")).stdout).status, "completed");
    const request = requests.find((req) => req.path === "/v1/runs" && req.method === "POST");
    assert.equal(request?.spaceId, personalSpace.id);
    const invocation = request?.body?.metadata?.extensionInvocation;
    assert.equal(invocation.action, expectedAction);
    assert.equal(invocation.epoch, "fixture-epoch");
    if (action === "write") assert.deepEqual(invocation.arguments,
      { path: "SKILL.md", content: "edited personal source", expectedHash: "fixture-hash" });
  }
  requests = [];
  await extensions.startExecution(installation, "workspace-reload", { arguments: { expectedHash: "fixture-hash" } });
  assert.equal(requests.at(-1).body.metadata.extensionInvocation.arguments.expectedHash, "fixture-hash");
  await chmod(storePath, 0o755);
  await assert.rejects(store.get("fixture"));
  await chmod(storePath, 0o700);
  const skillIndex = await (await fetch(`${siteUrl}/.well-known/skills/index.json`)).json();
  assert.equal(skillIndex.skills[0].name, "zioon");
  for (const path of skillIndex.skills[0].files) assert.equal((await fetch(`${siteUrl}/.well-known/skills/zioon/${path}`)).status, 200);
  const release = await (await fetch(`${siteUrl}/downloads/release.json`)).json();
  assert.equal(release.version, expectedVersion);
  for (const name of ["install.sh", "install.ps1"]) {
    const source = await (await fetch(`${siteUrl}/downloads/${name}`)).text();
    const versions = [...source.matchAll(/zioon-cli-(\d+\.\d+\.\d+)\.tgz/g)].map((match) => match[1]);
    assert.deepEqual(versions, [expectedVersion], `${name} must install the documented release`);
  }
  for (const [name, hash] of Object.entries(release.files)) {
    const bytes = Buffer.from(await (await fetch(`${siteUrl}/downloads/${name}`)).arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
  }
  const report = { passed: true, version: release.version, cleanHttpInstall: true, sourceTreeRequired: false,
    credentialFlow: "HTTP fixture with private Linux store", sdkRun: true, pluginOfflineLifecycle: true,
    apiAuthenticated: true, unsafeUrlRejected: true, failedRunExitCode: true, skillDiscovery: true, downloadHashes: true,
    installedFileCommands: true, sdkPrivateReload: true, skillAssetsPackaged: true,
    nativeWindowsTested: false, publicRegistryPublished: false, productionPublished: false };
  await writeFile(join(root, "apps/public-site/dist/cli-verification.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await close(server); await close(site);
  await rm(directory, { recursive: true, force: true });
}
