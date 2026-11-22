import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { JSDOM, VirtualConsole } from "jsdom";
import postcss from "postcss";

// Run with node --experimental-vm-modules after building. No browser UI is used.
const repository = fileURLToPath(new URL("../../", import.meta.url));
const dist = resolve(repository, "dist");
const htmlFile = process.argv[2];
const url = process.argv[3] || `http://127.0.0.1:55672/share/${"a".repeat(43)}`;
const payload = { state: "read", title: "构建阅读器检查", markdown: "user 提问\nassistant **回答**\n# 方案",
  cards: { tools: [], thinking: [] }, mode: "public", role: null };
const html = htmlFile ? await readFile(htmlFile, "utf8")
  : (await readFile(resolve(dist, "share-reader.html"), "utf8"))
    .replace("<!--SHARE_TITLE-->", payload.title).replace("<!--SHARE_FALLBACK-->", '<p id="reader-build-fallback">后备正文</p>')
    .replace("<!--SHARE_DATA-->", JSON.stringify(payload));
const virtualConsole = new VirtualConsole(), errors = [];
virtualConsole.on("jsdomError", error => errors.push(error.message));
const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
const window = dom.window, requests = [], pendingModules = new Map();
const context = dom.getInternalVMContext();
Object.assign(window, { TextEncoder, TextDecoder, structuredClone, AbortController, AbortSignal,
  fetch: async request => {
    requests.push(String(request));
    const path = new URL(String(request), url).pathname;
    if (path === "/v1/account/me") return new Response(JSON.stringify({ authenticated: false }));
    if (path.includes("/presence")) return new Response(JSON.stringify({ visitId: "v".repeat(43), ttlMs: 45000,
      selfVisitorId: "self", visitors: [{ id: "peer", name: "匿名访客", role: "visitor", kind: "anonymous", online: true }] }));
    return new Response("");
  } });
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
const tokens = new Map(), typography = [];
// Resolve the font properties from the delivered styles. JSDOM has no layout or CSS-variable engine.
for (const match of html.matchAll(/href="(\/assets\/[^"]+\.css)"/g)) {
  const css = postcss.parse(await readFile(resolve(dist, "." + match[1]), "utf8"));
  css.walkRules(rule => {
    if (rule.selector === ":root") rule.walkDecls(decl => {
      if (decl.prop.startsWith("--")) tokens.set(decl.prop, decl.value);
    });
    if (rule.selector === "html,body" || rule.selector === ".public-reader") rule.walkDecls(decl => {
      if (/^(font(?:-family|-size|-weight)?|line-height)$/.test(decl.prop)) typography.push([decl.prop, decl.value]);
    });
  });
}
const resolveToken = value => value.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g,
  (_match, name, fallback) => resolveToken(tokens.get(name) || fallback || ""));
for (const [name, value] of typography) window.document.body.style.setProperty(name, resolveToken(value));

function load(file) {
  if (!pendingModules.has(file)) pendingModules.set(file, (async () => {
    const source = await readFile(file, "utf8");
    return new vm.SourceTextModule(source, { context, identifier: pathToFileURL(file).href,
      initializeImportMeta: meta => { meta.url = pathToFileURL(file).href; },
      importModuleDynamically: async (specifier, parent) => {
        const child = await linker(specifier, parent);
        if (child.status === "unlinked") await child.link(linker);
        if (child.status === "linked") await child.evaluate();
        return child;
      }
    });
  })());
  return pendingModules.get(file);
}
function linker(specifier, parent) {
  const file = specifier.startsWith("/") ? resolve(dist, "." + specifier)
    : resolve(dirname(fileURLToPath(parent.identifier)), specifier);
  return load(file);
}
try {
  await new Promise(resolve => setImmediate(resolve));
  const entry = /<script type="module"[^>]+src="([^"]+)"/.exec(html)?.[1];
  assert(entry, "The delivered page must contain its built entry");
  const module = await load(resolve(dist, "." + entry));
  await module.link(linker); await module.evaluate();
  if (module.namespace.publicReader) await module.namespace.publicReader;
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const bodyStyle = window.getComputedStyle(window.document.body);
  const lineBoxPixels = bodyStyle.lineHeight.endsWith("px") ? parseFloat(bodyStyle.lineHeight)
    : parseFloat(bodyStyle.fontSize) * parseFloat(bodyStyle.lineHeight);
  assert(lineBoxPixels > 12 && lineBoxPixels < 32, `Reader inherited line box must be usable: ${lineBoxPixels}px`);
  assert(window.document.querySelector(".public-reader-header"), "The actual built entry must mount the header");
  assert(window.document.querySelector(".cm-editor"), "The actual built entry must mount CodeMirror");
  assert.equal(window.document.querySelector(".cm-content").getAttribute("contenteditable"), "false");
  assert.equal(window.document.getElementById("public-document"), null);
  const header = window.document.querySelector(".zion-editor-header");
  assert.equal(header.firstElementChild.getAttribute("data-action"), "outline");
  assert(header.firstElementChild.nextElementSibling.classList.contains("zion-editor-session-path"));
  assert.equal(window.document.querySelector(".public-reader-brand circle").getAttribute("fill"), "#80acff");
  window.document.querySelector('[data-action="find"]').click();
  const input = window.document.querySelector("#search-input");
  input.value = "assistant"; input.dispatchEvent(new window.Event("input"));
  assert.match(window.document.querySelector("#match-count").textContent, /^0\/[1-9]\d*$/);
  window.document.querySelector('[data-search-control="next-btn"]').click();
  assert.match(window.document.querySelector("#match-count").textContent, /^1\/[1-9]\d*$/);
  window.document.querySelector('[data-action="split"]').click();
  window.document.querySelector(".zion-editor-header-split-menu button").click();
  assert.equal(window.document.querySelectorAll(".cm-editor").length, 2);
  assert(window.document.querySelector('.zion-split-container[data-direction="horizontal"]'));
  for (const content of window.document.querySelectorAll(".cm-content"))
    assert.equal(content.getAttribute("contenteditable"), "false");
  const last = window.document.querySelectorAll(".zion-panel")[1];
  last.querySelector('[data-action="split"]').click();
  window.document.querySelectorAll(".zion-editor-header-split-menu button")[1].click();
  assert.equal(window.document.querySelectorAll(".cm-editor").length, 3);
  assert(window.document.querySelector('.zion-split-container[data-direction="vertical"]'));
  window.document.querySelectorAll('[data-action="close-panel"]')[2].click();
  window.document.querySelectorAll('[data-action="close-panel"]')[1].click();
  assert.equal(window.document.querySelectorAll(".cm-editor").length, 1);
  assert(requests.every(request => {
    const path = new URL(request, url).pathname;
    return path.startsWith("/assets/") || path === "/v1/account/me" || path.startsWith(new URL(url).pathname + "/presence");
  }), "Only display identity and document presence may initialize the reader");
  assert.equal(requests.filter(request => new URL(request, url).pathname.endsWith("/presence")).length, 1,
    "All splits share one page visit");
  assert(window.document.querySelector(".editor-participants-host"), "The built entry mounts the original participant header");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "PASS", builtModules: pendingModules.size, lineBoxPixels,
    header: true, editor: true, readOnly: true, search: true, splits: ["right", "down"],
    closeSplits: true, productionBrand: true, workbenchBootstrapRequests: 0, pageVisits: 1 }));
} finally { dom.window.close(); }
