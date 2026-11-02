import { cp, readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { resolve, join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const repository = fileURLToPath(new URL("../../", import.meta.url));
// Historical account migration bundle. Memory sources now have one owner.
const memoryRepository = resolve(process.env.ZIOON_MEMORY_REPOSITORY || join(repository, "../memory"));
const output = resolve(process.argv[2] || "/tmp/zioon-memory-release-20261023");
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error("Build into an empty directory to avoid retaining files from older releases");
async function copy(source, destination, sourceRoot = repository) {
  const target = join(output, destination);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(sourceRoot, source), target, { recursive: true, dereference: true });
}
for (const name of ["adc-register.mjs", "clients.json", "patch-sources.mjs", "adc-auth-ui-patch.mjs", "adc-auth-ui-patch.json",
  "release.mjs", "migration-check.mjs", "Caddyfile", "settings.json", "README.md"]) {
  await copy(`deploy/unified-accounts/${name}`, name);
}
await copy("packages/zioon-account/src/provider.mjs", "zioon-provider.mjs");
for (const name of ["src", "web", "package.json"]) {
  await copy(`apps/memory-service/${name}`, `memory/apps/memory-service/${name}`, memoryRepository);
}
await copy("packages/account-client", "memory/packages/account-client", memoryRepository);
await copy("node_modules/jose", "memory/node_modules/jose", memoryRepository);
await copy("packages/protocol", "memory/packages/protocol", memoryRepository);
for (const name of ["agentfs-login.mjs", "install-agentfs-login.mjs"]) {
  await copy(`scripts/${name}`, `memory/scripts/${name}`);
}
const web = join(memoryRepository, "apps/memory-service/web");
const favicon = (await readFile(join(web, "favicon.svg"))).toString("base64");
const css = await readFile(join(web, "site.css"), "utf8");
const script = await readFile(join(web, "site.js"), "utf8");
const previewFiles = { "/": "preview.html", "/docs": "docs-preview.html",
  "/console": "console-preview.html", "/account/login": "login-preview.html", "/account/verify": "device-preview.html" };
const consolePreviewScript = `
document.getElementById("account-name").textContent = "未登录";
document.getElementById("login-needed").hidden = false;
const layoutButton = document.createElement("button");
layoutButton.className = "login-switch"; layoutButton.textContent = "预览工作区布局";
document.getElementById("login-needed").append(layoutButton);
layoutButton.addEventListener("click", () => {
  document.getElementById("login-needed").hidden = true;
  document.getElementById("workspace").hidden = false;
  document.getElementById("files").textContent = "登录后在这里加载你的记忆文件。";
  document.getElementById("editor-empty").querySelector("p").textContent = "本地布局预览。部署并登录后可以读取和编辑自己的文件。";
  document.querySelectorAll("#workspace button, #workspace input").forEach(el => el.disabled = true);
});`;
for (const [file, target] of [["index.html", "preview.html"], ["docs.html", "docs-preview.html"],
  ["console.html", "console-preview.html"], ["login.html", "login-preview.html"], ["device.html", "device-preview.html"]]) {
  let html = (await readFile(join(web, file), "utf8"))
    .replace('<link rel="stylesheet" href="/assets/site.css">', `<style>${css}</style>`)
    .replace(/<script[^>]*src="\/assets\/[^"]+"[^>]*><\/script>/g, "")
    .replace('href="/favicon.svg"', `href="data:image/svg+xml;base64,${favicon}"`)
    .replace(/href="(\/[^"]*)"/g, (_match, href) => {
      const hashAt = href.indexOf("#");
      const path = hashAt < 0 ? href : href.slice(0, hashAt);
      const anchor = hashAt < 0 ? "" : href.slice(hashAt);
      if (!previewFiles[path]) throw new Error(`Unmapped preview link: ${href}`);
      return `href="${previewFiles[path]}${anchor}"`;
    });
  if (file === "index.html") html = html.replace("</body>", `<script>${script}</script></body>`);
  if (["console.html", "login.html", "device.html"].includes(file)) {
    html = html.replace(/(<body[^>]*>)/, `$1<div class="preview-banner">本地预览 · 登录和文件操作将在部署后可用。 <a href="console-preview.html">控制台</a> · <a href="login-preview.html">登录页</a></div>`);
    const previewScript = file === "console.html" ? consolePreviewScript : file === "login.html"
      ? `document.getElementById("login-form").addEventListener("submit",event=>event.preventDefault());document.getElementById("social-options").hidden=false;document.getElementById("github-login").disabled=true;`
      : `document.getElementById("device-status").textContent="部署后，从终端发起登录即可在这里确认验证码。";`;
    html = html.replace("</body>", `<script>${previewScript}</script></body>`);
  }
  await writeFile(join(output, target), html);
}
const manifest = {};
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile() && entry.name !== "manifest.json") {
      const bytes = await readFile(full);
      manifest[relative(output, full)] = {
        sha256: createHash("sha256").update(bytes).digest("hex"), bytes: (await stat(full)).size
      };
    } else if (!entry.isFile()) throw new Error("Release must not contain symlinks");
  }
}
await walk(output);
await writeFile(join(output, "manifest.json"), JSON.stringify({
  format: 1, product: "Zioon Memory", scope: "memory-only",
  upstream: "aecd4c83606f45325daece46b01f0c38ad2cc0ed",
  files: manifest
}, null, 2) + "\n");
console.log(JSON.stringify({ output, files: Object.keys(manifest).length,
  scope: "memory-only", bytes: Object.values(manifest).reduce((sum, file) => sum + file.bytes, 0) }));
