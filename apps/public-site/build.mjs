import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { docs, groups } from "./content/docs.mjs";
import { site } from "./site.config.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, "dist");
const cliRelease = JSON.parse(await readFile(join(root, "downloads/release.json"), "utf8"));
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);
const arrow = '<span aria-hidden="true">↗</span>';
const link = (href, label, attributes = "") => {
  if (!href.startsWith("/") && !href.startsWith("https://")) throw new Error(`Unsupported link: ${href}`);
  if (href.startsWith("//")) throw new Error(`Protocol-relative link: ${href}`);
  return `<a href="${escape(href)}" ${attributes}>${label}</a>`;
};
const inline = (text) => {
  let result = "", position = 0;
  for (const match of text.matchAll(/`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g)) {
    result += escape(text.slice(position, match.index));
    result += match[1] !== undefined ? `<code>${escape(match[1])}</code>` : link(match[3], escape(match[2]));
    position = match.index + match[0].length;
  }
  return result + escape(text.slice(position));
};
const block = (item) => {
  switch (item.type) {
    case "paragraph": return `<p>${inline(item.text)}</p>`;
    case "list": return `<ul>${item.items.map((text) => `<li>${inline(text)}</li>`).join("")}</ul>`;
    case "note": return `<aside class="note"><strong>${escape(item.title)}</strong><p>${inline(item.text)}</p></aside>`;
    case "code": return `<div class="code-block"><div class="code-heading"><span>${escape(item.title)}</span><button type="button" class="copy-button" data-copy aria-label="复制${escape(item.title)}">复制</button></div><pre tabindex="0" aria-label="${escape(item.title)}"><code class="language-${escape(item.language)}">${escape(item.text)}</code></pre></div>`;
    case "table": return `<div class="table-scroll" role="region" aria-label="对照表" tabindex="0"><table><thead><tr>${item.headers.map((text) => `<th scope="col">${escape(text)}</th>`).join("")}</tr></thead><tbody>${item.rows.map((row) => `<tr>${row.map((text) => `<td>${inline(text)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    default: throw new Error(`Unknown content block: ${item.type}`);
  }
};

await rm(output, { recursive: true, force: true });
await mkdir(join(output, "assets"), { recursive: true });
await cp(join(root, "downloads"), join(output, "downloads"), { recursive: true });
const skillRoot = process.env.ZIOON_SKILL_SOURCE ? resolve(process.env.ZIOON_SKILL_SOURCE)
  : join(root, "../../packages/zioon-cli/skills/zioon");
await cp(skillRoot, join(output, ".well-known/skills/zioon"), { recursive: true });
const skillText = await readFile(join(skillRoot, "SKILL.md"), "utf8");
await writeFile(join(output, ".well-known/skills/index.json"), JSON.stringify({
  skills: [{ name: "zioon", description: skillText.match(/^description: (.+)$/m)[1],
    files: ["SKILL.md", "references/commands.md"] }]
}, null, 2) + "\n");
const assets = {};
for (const filename of ["site.css", "site.js"]) {
  const data = await readFile(join(root, "assets", filename));
  const parts = filename.split(".");
  const name = `${parts[0]}.${createHash("sha256").update(data).digest("hex").slice(0, 10)}.${parts[1]}`;
  await writeFile(join(output, "assets", name), data);
  assets[filename] = `/assets/${name}`;
}
await cp(join(root, "assets", site.image.file), join(output, "assets", site.image.file));
await cp(join(root, "assets", "favicon.svg"), join(output, "assets", "favicon.svg"));

const header = (isDocs) => `<header class="site-header">
  ${link("/", 'zioon<span class="brand-dot">.</span>', 'class="brand" aria-label="Zioon 首页"')}
  <button type="button" class="menu-toggle" aria-expanded="false" aria-controls="site-navigation">菜单 <span aria-hidden="true">≡</span></button>
  <nav class="site-nav" id="site-navigation" aria-label="主导航">
    ${link("/docs/capabilities/", "能力")}
    ${link(site.links.marketplace, "插件市场")}
    ${link("/docs/", "Docs", isDocs ? 'aria-current="page"' : "")}
    ${link("/docs/changelog/", "更新")}
    ${link("/docs/search/", '<span>搜索文档</span><kbd>⌘ K</kbd>', 'class="search-trigger" data-open-search')}
    ${link(site.links.login, `登录 ${arrow}`, 'class="nav-login" data-account-login')}
    ${link(site.links.login, "开始使用", 'class="button button-small" data-account-login')}
  </nav>
</header>`;

const footer = () => `<footer class="site-footer">
  <div class="footer-top"><div>${link("/", 'zioon<span class="brand-dot">.</span>', 'class="brand"')}<p>让 AI 工作持续下去。</p></div>
    <nav aria-label="产品入口">${link(site.links.workbench, `Workbench ${arrow}`)}${link(site.links.marketplace, `插件市场 ${arrow}`)}${link(site.links.memory, `Memory ${arrow}`)}${link(site.links.adc, `ADC ${arrow}`)}</nav>
    <nav aria-label="帮助">${link("/docs/quickstart/", "快速开始")}${link("/docs/account/", "账号与安全")}${link("/docs/changelog/", "版本说明")}</nav></div>
  <div class="footer-bottom"><span>© ${site.updated.slice(0, 4)} Zioon</span><span>一个账号，接着工作。</span>${link("/docs/", "阅读文档 →")}</div>
</footer>`;

const searchDialog = () => `<dialog id="search-dialog" aria-labelledby="search-title">
  <div class="search-heading"><h2 id="search-title">搜索文档</h2><button type="button" data-close-search aria-label="关闭搜索">关闭 <kbd>Esc</kbd></button></div>
  <label class="search-label" for="dialog-query">输入主题、命令或问题</label>
  <input id="dialog-query" type="search" placeholder="试试：登录、CLI、MCP…" autocomplete="off">
  <p class="search-status" id="search-status" role="status">输入关键词，查找操作说明。</p>
  <div id="dialog-results" class="search-results" aria-label="搜索结果"></div>
  <div class="search-help"><span>↑ ↓ 选择 · Enter 打开</span>${link("/docs/", "全部文档 →")}</div>
</dialog>`;

const shell = ({ path, title, description, body, isDocs = false, noindex = false }) => `<!doctype html>
<html lang="${site.language}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Zioon</title><meta name="description" content="${escape(description)}">
<meta name="theme-color" content="#f8f6f0"><meta name="color-scheme" content="light">
<meta name="robots" content="${noindex ? "noindex,follow" : "index,follow"}">
<link rel="canonical" href="${site.origin}${path}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Zioon">
<meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}">
<meta property="og:url" content="${site.origin}${path}"><meta property="og:locale" content="zh_CN">
<meta property="og:image" content="${site.origin}/assets/${site.image.file}">
<meta name="twitter:card" content="summary_large_image"><meta name="referrer" content="strict-origin-when-cross-origin">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${assets["site.css"]}"><script src="${assets["site.js"]}" defer></script>
${path === "/" ? `<link rel="preload" as="image" href="/assets/${site.image.file}" fetchpriority="high">` : ""}
</head><body class="${isDocs ? "docs-page" : "home-page"}">
<a class="skip-link" href="#main">跳到正文</a>
${header(isDocs)}${body}${footer()}${searchDialog()}
<div class="sr-only" role="status" aria-live="polite" id="copy-status"></div>
</body></html>`;

const sidebar = (slug) => `<aside class="docs-sidebar">
  <details class="docs-navigation" open><summary>文档目录</summary><nav aria-label="文档目录">
  ${groups.map((group) => `<div class="doc-nav-group"><p>${escape(group)}</p>${docs.filter((doc) => doc.group === group).map((doc) => link(`/docs/${doc.slug}/`, `${escape(doc.title)}${doc.status ? `<span class="nav-status">${escape(doc.status)}</span>` : ""}`, doc.slug === slug ? 'aria-current="page"' : "")).join("")}</div>`).join("")}
  </nav></details>
  ${link("/docs/search/", "搜索文档 →", 'class="sidebar-search" data-open-search')}
</aside>`;

const docPage = (doc, index) => {
  const previous = docs[index - 1], next = docs[index + 1];
  const body = `<div class="docs-layout">${sidebar(doc.slug)}
    <main id="main" class="doc-article" tabindex="-1">
      <div class="breadcrumb">${link("/docs/", "Docs")}<span aria-hidden="true">/</span><span>${escape(doc.group)}</span></div>
      <div class="article-meta"><span>${doc.minutes} 分钟阅读</span>${doc.status ? `<span class="text-status">${escape(doc.status)}</span>` : ""}</div>
      <h1>${escape(doc.title)}</h1><p class="article-lead">${escape(doc.description)}</p>
      <nav class="mobile-toc" aria-label="本页内容">${doc.sections.map((item) => link(`/docs/${doc.slug}/#${item.id}`, escape(item.title))).join("")}</nav>
      ${doc.sections.map((item) => `<section id="${item.id}" class="article-section"><h2>${escape(item.title)}${link(`/docs/${doc.slug}/#${item.id}`, "#", `class="heading-anchor" aria-label="链接到${escape(item.title)}"`)}</h2>${item.blocks.map(block).join("")}</section>`).join("")}
      <p class="article-updated">最后核对：${site.updated} · 能力以实际部署与账号权限为准</p>
      <nav class="page-pagination" aria-label="相邻文档">
      ${previous ? link(`/docs/${previous.slug}/`, `<span>← 上一篇</span><strong>${escape(previous.title)}</strong>`) : link("/docs/", "<span>← 文档首页</span><strong>找到你的下一步</strong>")}
      ${next ? link(`/docs/${next.slug}/`, `<span>下一篇 →</span><strong>${escape(next.title)}</strong>`) : link("/docs/quickstart/", "<span>开始使用 →</span><strong>快速开始</strong>")}</nav>
    </main>
    <aside class="docs-toc"><p>本页内容</p><nav aria-label="本页内容">${doc.sections.map((item) => link(`/docs/${doc.slug}/#${item.id}`, escape(item.title), 'data-toc-link')).join("")}</nav></aside>
  </div>`;
  return shell({ path: `/docs/${doc.slug}/`, title: doc.title, description: doc.description, body, isDocs: true });
};

const home = shell({
  path: "/", title: "让 AI 工作持续下去", description: site.description,
  body: `<main id="main" tabindex="-1">
    <section class="hero" aria-labelledby="hero-title">
      <img class="hero-image" src="/assets/${site.image.file}" data-source="${escape(site.image.source)}" width="2560" height="1440" alt="午后阳光下的安静工作室，木桌上放着电脑与纸张" fetchpriority="high">
      <div class="hero-shade"></div><div class="hero-content">
        <p class="eyebrow hero-enter">A WORKSPACE FOR CONTINUING WORK</p>
        <h1 id="hero-title" class="hero-enter"><span class="hero-brand">zioon<span class="brand-dot">.</span></span><span class="hero-promise">让 AI 工作<br>持续下去。</span></h1>
        <p class="hero-description hero-enter">会话、工具、记忆与插件，<br>在工作台、CLI 和 API 中接着完成。</p>
        <div class="hero-actions hero-enter">${link(site.links.login, `开始使用 ${arrow}`, 'class="button" data-account-login')}${link("/docs/quickstart/", '阅读文档 <span aria-hidden="true">→</span>', 'class="text-link"')}</div>
      </div>
      <div class="hero-bottom"><span>同一个账号 · 在不同入口继续</span>${link("/#product", '向下探索 <span aria-hidden="true">↓</span>')}</div>
    </section>
    <section id="product" class="section workflow-section">
      <div class="section-heading reveal"><p class="eyebrow">01 / FROM INTENT TO OUTCOME</p><h2>对话之后，<br>工作还在继续。</h2><p>一个主题留在同一个会话里。补充材料、调用工具、核对结果，再推进下一步。</p>${link("/docs/workbench/", "了解工作台 →", 'class="text-link"')}</div>
      <div class="workflow-example reveal"><div class="example-caption"><span>工作流程示例</span><span aria-hidden="true">SESSION / 01</span></div><h3>把产品想法，变成发布计划</h3>
        <ol class="workflow-steps"><li><span class="step-number">01</span><div><strong>说清楚目标</strong><p>“准备一个官网首版，包含介绍、文档和产品入口。”</p></div></li>
        <li><span class="step-number">02</span><div><strong>在上下文里推进</strong><p>补充范围，读取已授权材料，形成可以核对的内容与文件。</p></div></li>
        <li><span class="step-number">03</span><div><strong>接着完成下一步</strong><p>确认结果，再继续修改。换到 CLI，也可以接回这个会话。</p></div></li></ol>
      </div>
    </section>
    <section class="continuity-section">
      <div class="section continuity-inner"><div class="reveal"><p class="eyebrow">02 / CONTEXT THAT STAYS</p><h2>下一次开始，<br>有迹可循。</h2></div>
      <div class="continuity-details reveal"><div><span>会话</span><h3>留住这段工作的上下文</h3><p>围绕主题持续讨论，回看记录，沿着已有结果继续。</p></div><div><span>执行</span><h3>把目标落到实际材料</h3><p>在账户沙箱或已授权设备上读写文件、运行工具，并查看结果。</p></div><div><span>记忆</span><h3>管理以后仍有用的资料</h3><p>通过 Memory 管理长期内容，为后续工作准备可引用的材料。</p></div></div></div>
    </section>
    <section id="entrances" class="section entrances-section">
      <div class="entrances-heading reveal"><p class="eyebrow">03 / YOUR WAY IN</p><h2>选择顺手的入口。</h2><p>从浏览器到终端，接着完成同一段工作。</p></div>
      <div class="entrance-list reveal">
        ${[
          ["01", "Workbench", "在浏览器里组织会话、查看运行和处理成果。", site.links.workbench, "打开工作台", ""],
          ["02", "CLI", "独立安装，在终端聊天、接回会话，直接调用插件。", "/docs/cli/", "安装 CLI", `v${cliRelease.version}`],
          ["03", "Memory", "在网页或 agent-fs CLI 中管理长期记忆与资料。", "/docs/memory-cli/", "记忆与 CLI", ""],
          ["04", "ADC", "通过 CLI、MCP 或插件连接自己的设备与工具。", "/docs/adc-cli/", "连接设备", ""],
          ["05", "API", "把任务提交、事件跟踪和结果接入自己的工作流。", "/docs/api/", "阅读接口文档", ""],
          ["06", "扩展", "开发 Skill、插件和 MCP，在多个入口使用同一能力。", "/docs/extensions/", "开发与调用", ""],
          ["07", "Agent Skill", "让其他 Agent 按官方流程使用 Zioon。", "/docs/agent-skill/", "安装 Skill", ""]
        ].map(([number, title, description, href, label, status]) => `<div class="entrance-row"><span class="entrance-number">${number}</span><h3>${title}</h3><div><p>${description}</p>${status ? `<span class="text-status">${status}</span>` : ""}</div>${link(href, `${label} ${arrow}`, 'class="entrance-action"')}</div>`).join("")}
      </div>
    </section>
    <section class="docs-feature section reveal"><div><p class="eyebrow">04 / A CLEAR NEXT STEP</p><h2>从第一次使用，<br>到自己的工作方式。</h2></div><div><p>快速开始、账号、设备、CLI 与扩展。<br>按你现在要完成的事，找到操作说明。</p><div class="docs-feature-links">${link("/docs/quickstart/", "第一次使用 →")}${link("/docs/cli/", "在终端继续 →")}${link("/docs/extensions/", "开发自己的扩展 →")}</div></div></section>
    <section class="final-cta"><div class="reveal"><p class="eyebrow">LET’S KEEP WORKING</p><h2>把下一件事，<br>交给这段会话。</h2><div class="hero-actions">${link(site.links.login, `开始使用 Zioon ${arrow}`, 'class="button" data-account-login')}${link("/docs/", "先看看文档 →", 'class="text-link"')}</div></div><span class="cta-wordmark" aria-hidden="true">zioon.</span></section>
  </main>`
});

const docsHome = shell({
  path: "/docs/", title: "Docs · 使用文档", description: "从首次登录到 CLI、设备和扩展开发，按任务找到 Zioon 的操作说明。", isDocs: true,
  body: `<div class="docs-layout docs-index-layout">${sidebar("")}<main id="main" class="doc-article docs-index" tabindex="-1"><p class="eyebrow">ZIOON DOCS</p><h1>找到你的下一步。</h1><p class="article-lead">从第一次登录，到在自己的工作流中继续使用。</p>
    <div class="docs-start">${link("/docs/quickstart/", '<span>从这里开始 · 4 分钟</span><strong>创建你的第一个会话 <span aria-hidden="true">→</span></strong><p>登录，给出目标，查看结果，再继续下一步。</p>')}</div>
    ${groups.map((group) => `<section class="doc-index-group"><h2>${group}</h2>${docs.filter((doc) => doc.group === group).map((doc) => link(`/docs/${doc.slug}/`, `<div><h3>${doc.title}${doc.status ? `<span class="text-status">${doc.status}</span>` : ""}</h3><p>${doc.description}</p></div><span aria-hidden="true">→</span>`, 'class="doc-index-row"')).join("")}</section>`).join("")}
    <p class="article-updated">最后核对：${site.updated} · 开发预览见各篇版本说明。</p></main></div>`
});

const searchPage = shell({
  path: "/docs/search/", title: "搜索文档", description: "搜索 Zioon 的使用说明、CLI 命令和常见问题。", isDocs: true, noindex: true,
  body: `<div class="docs-layout docs-index-layout">${sidebar("")}<main id="main" class="doc-article" tabindex="-1"><p class="eyebrow">ZIOON DOCS</p><h1>搜索文档</h1><label class="search-label" for="page-query">输入主题、命令或问题</label><form action="/docs/search/" method="get" id="page-search-form"><input type="search" id="page-query" name="q" placeholder="登录、CLI、MCP…" autocomplete="off"><button type="submit" class="button button-small">搜索</button></form><p class="search-status" id="page-search-status" role="status">也可以直接浏览下面的文档。</p><div id="page-results" class="search-results">${docs.map((doc) => link(`/docs/${doc.slug}/`, `<strong>${doc.title}</strong><p>${doc.description}</p>`, 'class="search-result"')).join("")}</div><noscript><p>启用 JavaScript 后可按关键词筛选；也可以通过上方文档列表与目录查找。</p></noscript></main></div>`
});

const pages = new Map([["/", home], ["/docs/", docsHome], ["/docs/search/", searchPage]]);
docs.forEach((doc, index) => pages.set(`/docs/${doc.slug}/`, docPage(doc, index)));
for (const [path, html] of pages) {
  const folder = join(output, path);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "index.html"), html);
}
await writeFile(join(output, "404.html"), shell({
  path: "/404.html", title: "页面未找到", description: "返回 Zioon 首页或文档目录。", noindex: true,
  body: `<main id="main" class="not-found" tabindex="-1"><p class="eyebrow">404</p><h1>这页不在这里。</h1><p>可以回到首页，或从文档目录找到需要的说明。</p><div class="hero-actions">${link("/", "返回首页", 'class="button"')}${link("/docs/", "打开文档 →", 'class="text-link"')}</div></main>`
}));
const plain = (value) => String(value).replace(/`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
const searchEntries = docs.flatMap((doc) => [
  { title: doc.title, pageTitle: doc.title, url: `/docs/${doc.slug}/`, description: doc.description, text: `${doc.description} ${doc.keywords}`, group: doc.group },
  ...doc.sections.map((item) => ({
    title: item.title, pageTitle: doc.title, url: `/docs/${doc.slug}/#${item.id}`, group: doc.group,
    description: plain(item.blocks.filter((value) => value.type !== "code").map((value) => value.text || value.items?.join(" ") || "").join(" ")).slice(0, 140),
    text: plain(item.blocks.map((value) => value.text || value.items?.join(" ") || value.rows?.flat().join(" ") || "").join(" "))
  }))
]);
await writeFile(join(output, "search-index.json"), JSON.stringify(searchEntries));
await writeFile(join(output, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${site.origin}/sitemap.xml\n`);
await writeFile(join(output, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[...pages.keys()].filter((path) => path !== "/docs/search/").map((path) => `<url><loc>${site.origin}${path}</loc><lastmod>${site.updated}</lastmod></url>`).join("")}</urlset>\n`);
await writeFile(join(output, "build-info.json"), JSON.stringify({
  version: "0.1.0", contentDate: site.updated, canonicalOrigin: site.origin,
  pages: [...pages.keys()], searchEntries: searchEntries.length,
  authentication: "Existing Workbench login transaction",
  runtimeLogin: site.links.login, productionPublished: process.env.ZIOON_SITE_RELEASE_STATE === "published",
  cli: { version: cliRelease.version, package: `/downloads/zioon-cli-${cliRelease.version}.tgz`, dependencies: 0 },
  image: { file: `/assets/${site.image.file}`, source: site.image.source }
}, null, 2) + "\n");
console.log(`Built ${pages.size} pages + 404, ${searchEntries.length} search entries → ${output}`);
