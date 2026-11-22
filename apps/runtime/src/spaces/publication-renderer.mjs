import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";

export const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safeLink = (value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
};

/** Render an immutable, human-reviewed projection. Raw HTML and remote images
 * never become active content. Images must be copied into this publication. */
export function renderPublication(publication, options = {}) {
  const definitions = new Map();
  const ast = fromMarkdown(publication.markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const visitDefinitions = (node) => {
    if (node.type === "definition") definitions.set(node.identifier.toLowerCase(), node);
    for (const child of node.children || []) visitDefinitions(child);
  };
  visitDefinitions(ast);
  const render = (node) => {
    const children = () => (node.children || []).map(render).join("");
    switch (node.type) {
      case "root": return children();
      case "text": case "inlineCode": return node.type === "inlineCode"
        ? `<code>${escapeHtml(node.value)}</code>` : escapeHtml(node.value);
      case "html": return escapeHtml(node.value);
      case "paragraph": return `<p>${children()}</p>`;
      case "heading": return `<h${node.depth}>${children()}</h${node.depth}>`;
      case "emphasis": return `<em>${children()}</em>`;
      case "strong": return `<strong>${children()}</strong>`;
      case "delete": return `<del>${children()}</del>`;
      case "break": return "<br>";
      case "thematicBreak": return "<hr>";
      case "blockquote": return `<blockquote>${children()}</blockquote>`;
      case "code": return `<pre><code>${escapeHtml(node.value)}</code></pre>`;
      case "list": return node.ordered ? `<ol start="${Number(node.start) || 1}">${children()}</ol>` : `<ul>${children()}</ul>`;
      case "listItem": return `<li>${node.checked == null ? "" : `<input type="checkbox" disabled${node.checked ? " checked" : ""}> `}${children()}</li>`;
      case "link": case "linkReference": {
        const value = node.type === "link" ? node : definitions.get(node.identifier.toLowerCase());
        const href = safeLink(value?.url);
        return href ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow">${children()}</a>` : children();
      }
      case "image": case "imageReference": {
        const value = node.type === "image" ? node : definitions.get(node.identifier.toLowerCase());
        if (options.imageUrl) {
          const url = options.imageUrl(value?.url);
          return url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(node.alt)}" loading="lazy">`
            : `<span>${escapeHtml(node.alt || "[图片不可用]")}</span>`;
        }
        const prefix = `/p/${publication.id}/assets/`;
        return value?.url?.startsWith(prefix) && /^[A-Za-z0-9_-]+$/.test(value.url.slice(prefix.length))
          ? `<img src="${escapeHtml(value.url)}" alt="${escapeHtml(node.alt)}" loading="lazy">`
          : `<span>${escapeHtml(node.alt || "[图片未公开]")}</span>`;
      }
      case "table": {
        const rows = node.children || [];
        const row = (r, header) => `<tr>${(r.children || []).map((cell, i) => {
          const tag = header ? "th" : "td", alignment = ["left", "right", "center"].includes(node.align?.[i]) ? node.align[i] : "left";
          return `<${tag} style="text-align:${alignment}">${(cell.children || []).map(render).join("")}</${tag}>`;
        }).join("")}</tr>`;
        return `<div class="table"><table><thead>${rows[0] ? row(rows[0], true) : ""}</thead><tbody>${rows.slice(1).map((r) => row(r, false)).join("")}</tbody></table></div>`;
      }
      case "definition": return "";
      default: return children();
    }
  };
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(publication.title)} · Zioon</title><style>
  :root{color-scheme:light dark;--bg:#faf9f6;--fg:#252824;--sub:#7a7e76;--line:#dedfd7;--accent:#477358;--code:#eeeee7}
  @media(prefers-color-scheme:dark){:root{--bg:#191c19;--fg:#e0e4da;--sub:#9ca393;--line:#393e33;--accent:#a0c6a5;--code:#272c25}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.8 system-ui,-apple-system,"PingFang SC",sans-serif}
  main{max-width:800px;margin:64px auto;padding:0 32px}header{border-bottom:1px solid var(--line);padding-bottom:24px;margin-bottom:32px}
  .brand{font-size:13px;letter-spacing:.06em;color:var(--sub)}h1{font-size:32px;line-height:1.35;margin:14px 0 0}h2,h3,h4{line-height:1.45;margin:32px 0 12px}
  p,ul,ol,blockquote,pre{margin:0 0 20px}article{overflow-wrap:anywhere}a{color:var(--accent);text-underline-offset:3px}
  code{background:var(--code);padding:2px 5px;border-radius:4px;font:14px/1.6 ui-monospace,monospace}pre{background:var(--code);padding:18px;overflow:auto;border-radius:8px}pre code{padding:0}
  blockquote{border-left:3px solid var(--accent);padding:4px 0 4px 20px;color:var(--sub)}blockquote p:last-child,li>p{margin-bottom:0}li{margin:5px 0}
  .table{overflow:auto;margin:24px 0}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:10px 14px;border-bottom:1px solid var(--line)}th{font-weight:600}
  img{max-width:100%;height:auto;border-radius:8px}hr{border:0;border-top:1px solid var(--line);margin:28px 0}footer{font-size:12px;color:var(--sub);border-top:1px solid var(--line);margin-top:48px;padding:20px 0 32px}
  @media(max-width:600px){main{margin:28px auto;padding:0 20px}h1{font-size:26px}body{font-size:15px}}@media print{body{background:white;color:black}main{margin:0;max-width:none}}
  button,select,textarea{font:inherit;color:var(--fg);background:var(--code);border:1px solid var(--line);border-radius:6px;padding:6px 12px}button{cursor:pointer}label{display:block;margin:12px 0}textarea{display:block;width:100%;min-height:80px}
  </style></head><body><main><header><div class="brand">${escapeHtml(options.brand || "Zioon · 公开分享")}</div><h1>${escapeHtml(publication.title)}</h1></header><article>${render(ast)}</article><footer>${options.footerHtml ?? `发布版本 ${publication.revision} · 此页面展示经过确认的副本`}</footer></main></body></html>`;
}
