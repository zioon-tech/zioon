#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error("Zioon CLI requires Node.js >=22.5.0");
  process.exit(1);
}
process.env.ZIOON_CLI_DISTRIBUTION = "1";
const args = process.argv.slice(2);
if (["--version", "-v", "version"].includes(args[0])) {
  const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  console.log(`zioon ${metadata.version}`);
} else {
  const cli = await import("../dist/cli.mjs");
  if (args[0] === "api") {
    try {
      if (args.includes("--help") || !args[1]) {
        console.log("Usage: zioon api <GET|POST|PUT|PATCH|DELETE> /v1/path [--data '<json>' | --data-file file.json] [--runtime-profile name | --url URL --account]\nUses your existing login and permissions. Prints JSON; does not follow redirects or retry.");
      } else {
        const [method, path] = args.slice(1);
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)
          || !/^\/v1\/[A-Za-z0-9/_?=&%.,:-]+$/.test(path)
          || path.includes("..") || path.includes("//")) throw new Error("Use an HTTP method and a /v1/ API path");
        const target = cli.resolveRuntimeCliTarget({ argv: args });
        const headers = await cli.resolveRuntimeCliHeaders(target);
        const option = (name) => {
          const index = args.indexOf(name);
          if (index < 0) return undefined;
          if (!args[index + 1]) throw new Error(`${name} requires a value`);
          return args[index + 1];
        };
        if (args.includes("--data") && args.includes("--data-file")) throw new Error("Choose --data or --data-file");
        const raw = option("--data") ?? (option("--data-file") ? await readFile(option("--data-file"), "utf8") : undefined);
        const body = raw === undefined ? undefined : JSON.stringify(JSON.parse(raw));
        if (body !== undefined && method === "GET") throw new Error("GET does not accept a body");
        const response = await fetch(`${new URL(target.baseUrl).origin}${path}`, {
          method, headers: { ...headers, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
          body, redirect: "error", signal: AbortSignal.timeout(30000)
        });
        const text = await response.text();
        let value;
        try { value = JSON.parse(text); }
        catch { throw new Error(`API returned non-JSON (HTTP ${response.status})`); }
        console.log(JSON.stringify(value, null, 2));
        if (!response.ok) process.exitCode = 1;
      }
    } catch (error) {
      console.error(`zioon: ${error.message}`);
      process.exitCode = 1;
    }
  } else {
    await cli.runRuntimeCliEntry();
    if (args[0] === "--help" || args[0] === "-h") {
      console.log("Distribution commands:\n  api <METHOD> /v1/path       Send an authenticated JSON API request\n  --version                  Print the installed CLI version\n  Bundled skill              See skills/zioon/SKILL.md in this npm package");
    }
  }
}
