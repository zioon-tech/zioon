import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRuntimeCliTarget } from "../src/runtime-cli.mjs";

const exec = promisify(execFile);
const repository = new URL("../../../", import.meta.url).pathname;
const entry = new URL("../bin/zion.mjs", import.meta.url).pathname;
const installer = new URL("../../../scripts/install-zion-cli-local.mjs", import.meta.url).pathname;

describe("CLI process outcome and local command installation", () => {
  let server, url, directory;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "zion-cli-entry-"));
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url.includes("/stream")) { res.writeHead(404); res.end("{}"); return; }
      if (req.url.includes("/events")) { res.end('{"events":[]}'); return; }
      const status = req.url.split("/").at(-1);
      res.end(JSON.stringify({ run: { id: status, status, terminalReason: "fixture" } }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("returns meaningful shell exit codes and keeps Run JSONL valid", async () => {
    for (const [status, code] of [["completed", 0], ["failed", 1], ["interrupted", 2], ["aborted", 130]]) {
      let result;
      try {
        result = await exec(process.execPath, [entry, "attach", status, "--url", url, "--raw-events", "--jsonl"], {
          env: { ...process.env, ZION_RUNTIME_CLI_CONFIG: join(directory, "missing-config.json"), ZION_RUNTIME_PROFILE: "", ZION_RUNTIME_URL: "" }
        });
        expect(code).toBe(0);
      } catch (error) { expect(error.code).toBe(code); result = error; }
      expect(JSON.parse(result.stdout.trim().split("\n").at(-1))).toMatchObject({ type: "run.snapshot", run: { status } });
      expect(result.stderr).toBe("");
    }
    try {
      await exec(process.execPath, [entry, "unknown-command", "--url", url, "--jsonl"], {
        env: { ...process.env, ZION_RUNTIME_CLI_CONFIG: join(directory, "missing-config.json"), ZION_RUNTIME_PROFILE: "" }
      });
      throw new Error("Expected command failure");
    } catch (error) {
      expect(error.code).toBe(1);
      expect(error.stdout).toBe("");
      expect(JSON.parse(error.stderr.trim())).toMatchObject({ schemaVersion: 1, type: "cli.error", error: "Unknown command: unknown-command" });
    }
  });

  it("chooses an explicit URL without default profile credentials and fences explicit profile overrides", async () => {
    const config = join(directory, "target-config.json");
    await writeFile(config, JSON.stringify({ version: 1, defaultProfile: "cloud", profiles: {
      cloud: { url: "https://cloud.test", auth: { type: "bearer", env: "TEST_TOKEN" } }
    } }));
    const environment = { ZION_RUNTIME_CLI_CONFIG: config, TEST_TOKEN: "test-only" };
    const target = resolveRuntimeCliTarget({ argv: ["--url", url, "--account"], environment });
    expect(target).toMatchObject({ baseUrl: url, profileName: "", headers: {}, auth: { type: "account" } });
    expect(() => resolveRuntimeCliTarget({
      argv: ["--runtime-profile", "cloud", "--url", url], environment
    })).toThrow("different origin");
  });

  it("installs both names, preserves profiles and safely upgrades a link owned by the same repository", async () => {
    const home = join(directory, "home");
    const bin = join(home, "bin");
    await mkdir(join(home, ".zion-next"), { recursive: true });
    await mkdir(bin);
    const previous = { version: 1, defaultProfile: "mine", profiles: { mine: { url: "https://existing.test",
      auth: { type: "bearer", env: "EXISTING_TOKEN" } } } };
    await writeFile(join(home, ".zion-next/cli.json"), JSON.stringify(previous));
    await symlink(entry, join(bin, "zion"));
    await exec(process.execPath, [installer, "--source", repository, "--bin-dir", bin, "--url", url, "--profile", "local"], {
      env: { ...process.env, HOME: home }, timeout: 15000
    });
    const current = JSON.parse(await readFile(join(home, ".zion-next/cli.json"), "utf8"));
    expect(current.defaultProfile).toBe("mine");
    expect(current.profiles.mine).toEqual(previous.profiles.mine);
    expect(current.profiles.local).toEqual({ url, auth: { type: "account" } });
    expect(await readlink(join(bin, "zion"))).toBe(await readlink(join(bin, "zioon")));
    const { stdout } = await exec(process.execPath, [join(bin, "zioon"), "extensions", "--help"]);
    expect(stdout).toContain("upload <file>");
  });

  it("does not replace an unrelated command or change config after a name conflict", async () => {
    const home = join(directory, "conflict-home");
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "zioon"), "#!/bin/sh\nexit 0\n");
    await expect(exec(process.execPath, [installer, "--source", repository, "--bin-dir", bin], {
      env: { ...process.env, HOME: home }
    })).rejects.toMatchObject({ code: 1 });
    expect(await readFile(join(bin, "zioon"), "utf8")).toContain("exit 0");
    await expect(readFile(join(home, ".zion-next/cli.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
