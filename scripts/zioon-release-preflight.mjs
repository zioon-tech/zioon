#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve, join, relative, sep } from "node:path";

export function replaceZioonCaddyBlock(text, replacement) {
  let quoted = false, escaped = false, comment = false, depth = 0, start = -1;
  const blocks = [];
  let lineStart = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\n") { comment = false; lineStart = index + 1; }
    if (comment) continue;
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quoted) { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (char === "#") { comment = true; continue; }
    if (char === "{") {
      if (depth === 0) {
        const host = text.slice(lineStart, index).trim();
        const hosts = host.split(",").map((value) => value.trim().replace(/^https:\/\//, ""));
        start = hosts.includes("zioon.tech") && hosts.every((value) => ["zioon.tech", "www.zioon.tech"].includes(value))
          ? lineStart : -1;
      }
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth < 0) throw new Error("Unbalanced Caddy configuration");
      if (depth === 0 && start !== -1) { blocks.push([start, index + 1]); start = -1; }
    }
  }
  if (depth || quoted) throw new Error("Unbalanced Caddy configuration");
  if (blocks.length !== 1) throw new Error("Expected one Zioon homepage host block; inspect routing before deployment");
  const [[begin, end]] = blocks;
  return text.slice(0, begin) + replacement.trimEnd() + text.slice(end);
}

export async function checkReleaseDependencies(productionRoot, stage) {
  const graph = JSON.parse(await readFile(join(stage, "dependencies.json"), "utf8"));
  const missing = [];
  for (const path of graph.sourceFiles) {
    const file = resolve(stage, "source", path);
    if (!file.startsWith(resolve(stage, "source") + sep) || !(await stat(file).catch(() => null))?.isFile()) {
      missing.push(`source:${path}`);
    }
  }
  const stageRequire = createRequire(resolve(stage, "source/packages/sandbox/package.json"));
  for (const item of graph.externalImports) {
    const require = createRequire(resolve(productionRoot, item.importer));
    try { require.resolve(item.package); }
    catch {
      // Candidate-only dependency staging is permitted for the sandbox SDK.
      // Its package lock is in the signed source manifest.
      if (item.package === "e2b") {
        try { stageRequire.resolve("e2b"); continue; } catch {}
      }
      missing.push(`package:${item.package} (from ${item.importer})`);
    }
  }
  if (missing.length) throw new Error(`Production dependency preflight failed:\n${[...new Set(missing)].join("\n")}`);
  return { sourceModules: graph.sourceFiles.length, externalImports: graph.externalImports.length };
}

const argv = process.argv.slice(2);
if (argv[0] === "--caddy") {
  await writeFile(argv[3], replaceZioonCaddyBlock(await readFile(argv[1], "utf8"), await readFile(argv[2], "utf8")));
} else if (argv[0] === "--dependencies") {
  console.log(JSON.stringify(await checkReleaseDependencies(argv[1], argv[2])));
} else if (argv[0] === "--verify-parser") {
  const original = '# { unmatched comment\nruntime.zioon.tech {\n  header X-Test "} quoted brace"\n}\nzioon.tech {\n  redir https://adc.zioon.tech{uri}\n  # } ignored comment\n}\nauth.zioon.tech {\n  reverse_proxy localhost:9999\n}\n';
  const updated = replaceZioonCaddyBlock(original, "zioon.tech {\n  file_server\n}");
  assert.ok(updated.includes('header X-Test "} quoted brace"'));
  assert.ok(updated.endsWith('auth.zioon.tech {\n  reverse_proxy localhost:9999\n}\n'));
  assert.ok(!updated.includes("redir https://adc"));
  assert.ok(replaceZioonCaddyBlock("https://zioon.tech, https://www.zioon.tech {\n redir https://adc.zioon.tech{uri} 308\n}", "zioon.tech {\n file_server\n}").includes("file_server"));
  assert.throws(() => replaceZioonCaddyBlock("zioon.tech, adc.zioon.tech {\n}", ""));
  assert.throws(() => replaceZioonCaddyBlock("zioon.tech {}\nzioon.tech {}", ""));
  console.log("Caddy route parser verified: exact host, quoted braces, comments, sibling routes and rejection cases");
}
