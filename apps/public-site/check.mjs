import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSiteServer } from "./serve.mjs";
import { docs } from "./content/docs.mjs";
import { site } from "./site.config.mjs";

// Reuse the repository's existing development dependency; the shipped site has none.
const require = createRequire(new URL("../../package.json", import.meta.url));
const { JSDOM, VirtualConsole } = require("jsdom");
const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, "dist");
const info = JSON.parse(await readFile(join(output, "build-info.json"), "utf8"));
assert.equal(
  createHash("sha256").update(await readFile(join(output, "assets/public-security-filing.png"))).digest("hex"),
  "8dfecad0dfcb3dc584f2c2447943eefb1fd65a058856eb0611e2c56ddc4c1fe1",
  "The filing icon must match the supplied official image"
);
const documents = new Map();
const titles = new Set();
let linksChecked = 0, snippetsChecked = 0, assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions++; };
const paths = [...info.pages, "/404.html"];
for (const path of paths) {
  const html = await readFile(join(output, path, path.endsWith("/") ? "index.html" : ""), "utf8");
  const dom = new JSDOM(html, { url: site.origin + path });
  const document = dom.window.document;
  documents.set(path, { dom, document, html });
  check(document.documentElement.lang === "zh-CN", `${path}: language`);
  check(document.querySelectorAll("main").length === 1, `${path}: main landmark`);
  check(document.querySelectorAll("h1").length === 1, `${path}: one heading`);
  check(document.querySelector('meta[name="description"]')?.content, `${path}: description`);
  check(document.querySelector('link[rel="canonical"]')?.href === site.origin + path, `${path}: canonical`);
  check(!titles.has(document.title), `${path}: unique title`);
  titles.add(document.title);
  const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
  check(ids.length === new Set(ids).size, `${path}: unique IDs`);
  check(document.querySelector(".skip-link")?.getAttribute("href") === "#main", `${path}: skip link`);
  check(!html.includes("/Users/bytedance") && !html.includes("marketplace@example.test"), `${path}: no maintainer-specific tutorial data`);
  for (const code of document.querySelectorAll("code.language-sh")) {
    execFileSync("bash", ["-n"], { input: code.textContent, stdio: ["pipe", "pipe", "pipe"] });
    snippetsChecked++;
  }
  for (const anchor of document.querySelectorAll("[data-account-login]")) {
    check(anchor.href === site.links.login, `${path}: existing login transaction`);
  }
  for (const script of document.querySelectorAll("script")) {
    check(script.src.startsWith(site.origin + "/assets/"), `${path}: same-origin external script`);
    check(!script.textContent.trim(), `${path}: no inline executable script`);
  }
  for (const image of document.images) {
    if (image.getAttribute("src") === "/assets/public-security-filing.png") {
      check(image.alt === "" && image.getAttribute("aria-hidden") === "true"
        && image.width === 18 && image.height === 20, `${path}: decorative official filing icon`);
      continue;
    }
    check(image.alt.length > 0 && image.width > 0 && image.height > 0, `${path}: image accessibility and size`);
    check(image.getAttribute("data-source")?.startsWith("https://copilot-cn.bytedance.net/api/ide/v1/tool_text_to_image?"), `${path}: required generated-image provenance`);
  }
}
for (const [path, { document }] of documents) {
  for (const element of document.querySelectorAll("a[href], script[src], link[href], img[src]")) {
    const attribute = ["SCRIPT", "IMG"].includes(element.tagName) ? "src" : "href";
    const url = new URL(element.getAttribute(attribute), site.origin + path);
    if (url.origin !== site.origin) continue;
    linksChecked++;
    if (documents.has(url.pathname)) {
      if (url.hash) check(documents.get(url.pathname).document.getElementById(decodeURIComponent(url.hash.slice(1))), `${path}: missing anchor ${url.href}`);
    } else {
      check((await stat(join(output, url.pathname)).catch(() => null))?.isFile(), `${path}: missing local file ${url.pathname}`);
    }
  }
}
const index = JSON.parse(await readFile(join(output, "search-index.json"), "utf8"));
check(index.length === info.searchEntries, "Search index entry count");
for (const entry of index) {
  const url = new URL(entry.url, site.origin);
  check(documents.has(url.pathname), `Search route: ${entry.url}`);
  if (url.hash) check(documents.get(url.pathname).document.getElementById(url.hash.slice(1)), `Search anchor: ${entry.url}`);
}
for (const doc of docs) {
  check(index.some((entry) => entry.url === `/docs/${doc.slug}/`), `${doc.slug}: indexed`);
  check(documents.get(`/docs/${doc.slug}/`).document.querySelector('nav[aria-label="文档目录"] a[aria-current="page"]')?.getAttribute("href") === `/docs/${doc.slug}/`, `${doc.slug}: active navigation`);
}
const sitemap = await readFile(join(output, "sitemap.xml"), "utf8");
check(!sitemap.includes("/docs/search/"), "Search page excluded from sitemap");
check(info.pages.filter((path) => path !== "/docs/search/").every((path) => sitemap.includes(`<loc>${site.origin}${path}</loc>`)), "Sitemap covers public pages");
check((await readFile(join(output, "robots.txt"), "utf8")).includes(`${site.origin}/sitemap.xml`), "Robots references sitemap");

const server = createSiteServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let httpChecked = 0;
try {
  for (const path of info.pages) {
    const response = await fetch(origin + path);
    check(response.status === 200, `${path}: HTTP 200`);
    check(response.headers.get("content-type")?.startsWith("text/html"), `${path}: HTML content type`);
    check(response.headers.get("x-robots-tag") === "noindex, nofollow", `${path}: preview not indexed`);
    httpChecked++;
  }
  const redirect = await fetch(origin + "/docs/cli?q=login", { redirect: "manual" });
  check(redirect.status === 308 && redirect.headers.get("location") === "/docs/cli/?q=login", "Directory redirect preserves query");
  const missing = await fetch(origin + "/missing-page");
  check(missing.status === 404 && (await missing.text()).includes("这页不在这里"), "Useful real 404");
  check((await fetch(origin + "/docs/", { method: "HEAD" })).status === 200, "HEAD supported");
  check((await fetch(origin + "/", { method: "POST" })).status === 405, "Preview rejects writes");
  check((await fetch(origin + "/%ZZ")).status === 400, "Malformed URL rejected");
  check((await fetch(origin + "/%2e%2e%2fpackage.json")).status === 400, "Encoded path traversal rejected");
  check((await fetch(origin + "/site.config.mjs")).status === 404, "Source not served");
  httpChecked += 7;

  const source = await readFile(join(root, "assets/site.js"), "utf8");
  const windows = [];
  const interactivePage = (path, { mobile = false, failSearch = false } = {}) => {
    const errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (error) => errors.push(error.message));
    const dom = new JSDOM(documents.get(path).html, { url: origin + path, runScripts: "outside-only", virtualConsole });
    const window = dom.window;
    windows.push(window);
    window.matchMedia = (query) => ({ matches: query.includes("680px") && mobile, addEventListener() {} });
    window.fetch = (path) => failSearch ? Promise.reject(new Error("Offline")) : fetch(origin + path);
    window.HTMLElement.prototype.scrollIntoView = () => {};
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event("close")); };
    window.eval(source);
    return { window, document: window.document, errors };
  };
  const waitFor = async (condition) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Interaction check timed out");
  };
  try {
    const mobilePage = interactivePage("/docs/cli/", { mobile: true });
    const { window, document } = mobilePage;
    const menu = document.querySelector(".menu-toggle");
    check(!document.querySelector(".docs-navigation").open, "Mobile docs menu initially collapsed");
    menu.click();
    check(menu.getAttribute("aria-expanded") === "true", "Mobile menu opens");
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    check(menu.getAttribute("aria-expanded") === "false", "Escape closes mobile menu");
    menu.click();
    const trigger = document.querySelector("[data-open-search]");
    trigger.focus();
    trigger.click();
    check(document.querySelector("#search-dialog").open, "Search opens");
    check(document.activeElement.id === "dialog-query", "Search input receives focus");
    const input = document.querySelector("#dialog-query");
    input.value = "MCP";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await waitFor(() => document.querySelectorAll("#dialog-results a").length > 0);
    check([...document.querySelectorAll("#dialog-results a")].some((a) => a.pathname === "/docs/extensions/"), "MCP search finds extensions");
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    check(document.querySelector('#dialog-results a[aria-current="true"]'), "Keyboard selects search result");
    document.querySelector("[data-close-search]").click();
    check(document.activeElement === menu, "Closing mobile search restores visible focus");
    let clipboardText = "";
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (text) => { clipboardText = text; } } });
    const copy = document.querySelector("[data-copy]");
    copy.click();
    await waitFor(() => copy.textContent === "已复制");
    check(clipboardText === copy.closest(".code-block").querySelector("pre code").textContent, "Copied shell content exactly preserves newlines");
    check(document.querySelector("#copy-status").textContent.includes("已复制"), "Copy announces success");
    check(mobilePage.errors.length === 0, "No client errors during mobile interactions");

    const searchPage = interactivePage("/docs/search/");
    check(searchPage.document.querySelector(".docs-navigation").open, "Desktop docs menu open");
    await waitFor(() => searchPage.document.querySelectorAll("#page-results a").length === docs.length);
    const query = searchPage.document.querySelector("#page-query");
    query.value = "完全不存在的关键词abcdefg";
    query.dispatchEvent(new searchPage.window.Event("input", { bubbles: true }));
    await waitFor(() => searchPage.document.querySelector("#page-search-status").textContent.includes("没有找到"));
    check(searchPage.document.querySelectorAll("#page-results a").length === 0, "Empty search explicit");
    query.value = "登录";
    query.dispatchEvent(new searchPage.window.Event("input", { bubbles: true }));
    await waitFor(() => searchPage.document.querySelectorAll("#page-results a").length > 0);
    check([...searchPage.document.querySelectorAll("#page-results a")].some((a) => a.pathname === "/docs/account/" || a.pathname === "/docs/cli/"), "Chinese login search works");
    searchPage.document.querySelector("#page-search-form").dispatchEvent(new searchPage.window.Event("submit", { bubbles: true, cancelable: true }));
    check(new URL(searchPage.window.location.href).searchParams.get("q") === "登录", "Search query can be shared");
    const failurePage = interactivePage("/docs/search/", { failSearch: true });
    await waitFor(() => failurePage.document.querySelector("#page-search-status").textContent.includes("暂时无法"));
    check(failurePage.document.querySelectorAll("#page-results a").length === docs.length, "Offline search retains static fallback");
    check(searchPage.errors.length === 0 && failurePage.errors.length === 0, "No client errors on search and offline fallback");
  } finally {
    windows.forEach((window) => window.close());
  }
} finally {
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  documents.forEach(({ dom }) => dom.window.close());
}
const report = {
  passed: true, pages: paths.length, documents: docs.length, searchEntries: index.length,
  localLinksChecked: linksChecked, shellSnippetsChecked: snippetsChecked,
  httpChecks: httpChecked, assertions,
  browserAutomation: false, productionMutation: false,
  interactionEnvironment: "jsdom with native dialog and media-query stubs",
  visualScreenshotVerification: false
};
await writeFile(join(output, "verification.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
