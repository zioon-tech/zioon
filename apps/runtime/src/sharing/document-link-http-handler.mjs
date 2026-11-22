import { accountError } from "../accounts/account-policy.mjs";
import { renderPublication, escapeHtml } from "../spaces/publication-renderer.mjs";
import { documentReaderPayload } from "./document-reader.mjs";
export { documentReaderPayload } from "./document-reader.mjs";

const headers = {
  "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};
const readerHeaders = { ...headers, "content-security-policy": "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'" };
const scriptJson = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char =>
  `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
const page = (response, status, title, markdown, options = {}) => {
  response.writeHead(status, { ...headers, "content-type": "text/html; charset=utf-8" });
  response.end(renderPublication({ title, markdown, revision: 1 }, { brand: "Zioon · 分享会话", footerHtml: "", ...options }));
};
async function readForm(request) {
  if (!String(request.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded")) {
    throw accountError(415, "invalid_form");
  }
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw accountError(413, "request_too_large");
    chunks.push(chunk);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  return { role: form.get("role") || "viewer", message: form.get("message") || "" };
}

export function createDocumentLinkHttpHandler({ sharing, accessControl, readDocumentAsset, readReaderTemplate }) {
  return async (request, response, url) => {
    if (!/^\/share(?:\/|$)/.test(url.pathname)) return false;
    try {
      const match = /^\/share\/([A-Za-z0-9_-]{43})(?:\/(request|content|assets\/([A-Za-z0-9_-]{1,256})))?$/.exec(url.pathname);
      if (!match) throw accountError(404, "document_link_unavailable");
      const [, id, action, assetId] = match, path = `/share/${id}`;
      if (action === "request" && request.method === "POST") {
        const principal = await accessControl.requireLogin(request);
        await sharing.links.request(principal.user.id, id, await readForm(request));
        response.writeHead(303, { ...headers, location: path }); response.end(); return true;
      }
      if (request.method !== "GET" && request.method !== "HEAD" || action === "request") throw accountError(405, "method_not_allowed");
      let userId = null;
      try { userId = (await accessControl.requireLogin(request)).user.id; }
      catch (error) { if (error.statusCode !== 401) throw error; }
      const value = await sharing.links.view(id, userId);
      if (action === "content") {
        response.writeHead(200, { ...readerHeaders, "content-type": "application/json; charset=utf-8" });
        response.end(request.method === "HEAD" ? undefined : JSON.stringify(documentReaderPayload(value)));
        return true;
      }
      if (assetId) {
        if (value.state !== "read" || !new Set([...value.markdown.matchAll(/zion-asset:\/\/([A-Za-z0-9_-]+)/g)].map(m => m[1])).has(assetId)) {
          throw accountError(404, "asset_not_found");
        }
        const asset = await readDocumentAsset(value.ownerId, value.originSpaceId, value.documentId, assetId);
        const current = await sharing.links.view(id, userId);
        if (current.state !== "read" || ![...current.markdown.matchAll(/zion-asset:\/\/([A-Za-z0-9_-]+)/g)].some(m => m[1] === assetId)) {
          throw accountError(404, "asset_not_found");
        }
        if (!["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(asset.mediaType)
          || asset.content.length > 16 * 1024 * 1024) throw accountError(404, "asset_not_found");
        response.writeHead(200, { ...headers, "content-type": asset.mediaType, "content-length": asset.content.length });
        response.end(request.method === "HEAD" ? undefined : asset.content); return true;
      }
      if (request.method === "HEAD") { response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" }); response.end(); return true; }
      if (value.state === "login") page(response, 200, "此链接需要访问权限", "请登录已注册账号。已有权限可直接阅读，尚无权限可向所有者申请。", {
        footerHtml: `<a href="/v1/account/login?returnTo=${encodeURIComponent(path)}">登录并继续</a>`
      });
      else if (value.state === "request") {
        const pending = value.request?.status === "pending";
        page(response, 200, pending ? "访问申请已提交" : "申请访问此会话",
          pending ? "所有者批准后，刷新此链接即可阅读。会话也会出现在你的会话列表中。"
            : value.request?.status === "rejected" ? "所有者未通过上次申请。你可以补充说明后重新申请。" : "此会话仅对已授权账号开放。请向所有者申请查看或编辑权限。",
          { footerHtml: pending ? `<a href="${path}">刷新访问状态</a>` : `<form method="post" action="${path}/request">
            <label>申请权限 <select name="role"><option value="viewer">可查看</option><option value="editor">可编辑</option></select></label>
            <label>申请说明（选填）<textarea name="message" maxlength="1000"></textarea></label><button type="submit">发送访问申请</button></form>` });
      } else if (readReaderTemplate) {
        const imageUrl = source => /^zion-asset:\/\/[A-Za-z0-9_-]{1,256}$/.test(source || "")
          ? `${path}/assets/${source.slice(13)}` : null;
        const article = renderPublication({ title: value.title, markdown: value.markdown.replace(/<!--\s*zion-(?:assistant|thinking|tool):id=[\s\S]*?-->/g, ""), revision: 1 },
          { imageUrl, footerHtml: "" }).match(/<article>([\s\S]*)<\/article>/)?.[1] || "";
        const fallback = `<div class="public-reader-shell"><header class="public-reader-header">
          <a class="public-reader-brand" href="/">Zioon</a><div class="public-reader-heading">
          <span class="public-reader-title">${escapeHtml(value.title)}</span>
          <span class="public-reader-mode">${value.mode === "public" ? "公开" : "已授权"} · 只读</span></div></header>
          <div class="public-reader-layout"><aside></aside><main class="public-reader-document"><div class="public-reader-document-meta">会话</div>
          <h1>${escapeHtml(value.title)}</h1><article class="public-reader-fallback">${article}</article>
          <noscript>启用 JavaScript 后可展开思考与工具记录、使用目录和查找。</noscript></main></div></div>`;
        const template = (await readReaderTemplate()).replace(/<link\b[^>]*rel="manifest"[^>]*>/g, "")
          .replace(/<script\b[^>]*id="vite-plugin-pwa:register-sw"[^>]*><\/script>/g, "");
        const html = template.replace("<!--SHARE_TITLE-->", () => escapeHtml(value.title))
          .replace("<!--SHARE_FALLBACK-->", () => fallback)
          .replace("<!--SHARE_DATA-->", () => scriptJson(documentReaderPayload(value)));
        response.writeHead(200, { ...readerHeaders, "content-type": "text/html; charset=utf-8" });
        response.end(html);
      } else page(response, 200, value.title, value.markdown, {
        imageUrl: url => /^zion-asset:\/\/[A-Za-z0-9_-]{1,256}$/.test(url || "") ? `${path}/assets/${url.slice(13)}` : null,
        footerHtml: `当前会话 · ${value.mode === "public" ? "公开阅读" : "已授权阅读"}${value.role
          ? ` · <a href="/?shareLink=${escapeHtml(id)}">${value.role === "editor" || value.role === "owner" ? "在工作台编辑" : "在工作台打开"}</a>` : ""}`
      });
    } catch (error) {
      if (url.pathname.endsWith("/content")) {
        response.writeHead(error.statusCode || 500, { ...readerHeaders, "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ state: "unavailable" }));
      } else page(response, error.statusCode || 500, "暂时无法访问", error.statusCode ? error.message : "请稍后重试。");
    }
    return true;
  };
}
