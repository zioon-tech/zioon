import { Buffer } from "node:buffer";
import { safeExtensionPath } from "../../../../packages/runtime-client/src/extension-package.mjs";

const contentTypes = { js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript",
  css: "text/css", html: "text/html", json: "application/json", md: "text/markdown", txt: "text/plain" };

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  response.end(body);
}

async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256000) throw Object.assign(new Error("提交内容超过 256KB"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    const value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw Object.assign(new Error("请求内容必须为 JSON 对象"), { statusCode: 400 }); }
}

export function createMarketplaceHttpHandler({ service, jobs, connections }) {
  return async (request, response, url) => {
    if (!url.pathname.startsWith("/v1/marketplace/")) return false;
    try {
      const principal = request.zionPrincipal;
      const userId = principal?.kind === "account" ? principal.user?.id : "";
      if (!userId) throw Object.assign(new Error("请先登录账户"), { statusCode: 401, code: "authentication_required" });
      const path = url.pathname.slice("/v1/marketplace/".length);
      if (principal.space?.kind === "team") {
        if (request.method === "GET" && path === "snapshot") {
          json(response, 200, await service.snapshot(""));
          return true;
        }
        throw Object.assign(new Error("请在私人空间管理自己的扩展，再明确分享到当前空间"), {
          statusCode: 409, code: "personal_extension_requires_personal_space"
        });
      }
      const resource = path.match(/^releases\/([^/]+)\/([^/]+)\/(artifact|files\/(.+))$/);
      const revisionResource = path.match(/^installations\/([^/]+)\/revisions\/([a-f0-9]{64})\/files\/(.+)$/);
      const match = path.match(/^installations\/([^/]+)$/);
      const config = path.match(/^installations\/([^/]+)\/config$/);
      const submit = path.match(/^contributions\/([^/]+)\/submit$/);
      const contribution = path.match(/^contributions\/([^/]+)$/);
      if (request.method === "GET" && (resource || revisionResource)) {
        const release = revisionResource ? await service.installationRevisionFor(userId,
          decodeURIComponent(revisionResource[1]), revisionResource[2])
          : await service.releaseFor(userId, decodeURIComponent(resource[1]),
            decodeURIComponent(resource[2]), { content: true });
        if (resource?.[3] === "artifact") {
          if (!release.artifact) throw Object.assign(new Error("此版本没有可下载的制品"), { statusCode: 404, code: "artifact_not_found" });
          json(response, 200, { artifact: release.artifact });
        } else {
          const name = safeExtensionPath(decodeURIComponent(revisionResource?.[3] || resource[4]));
          const content = name === "manifest.json" && release.artifact?.plugin
            ? JSON.stringify(release.artifact.plugin) : name === "__revision" ? JSON.stringify({ revision: release.contentRef.digest })
              : name === "SKILL.md" && release.artifact?.body ? release.artifact.body
                : release.artifact?.files?.[name] ?? release.installationAssets?.[name];
          if (typeof content !== "string") throw Object.assign(new Error("制品文件不存在"), { statusCode: 404, code: "artifact_file_not_found" });
          response.writeHead(200, { "content-type": `${contentTypes[name.split(".").pop()] || "text/plain"}; charset=utf-8`,
            "content-length": Buffer.byteLength(content), "cache-control": "private, max-age=0, must-revalidate",
            etag: `"${release.contentRef.digest}"`, "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox" });
          response.end(content);
        }
      } else if (request.method === "GET" && path === "snapshot") {
        json(response, 200, await service.snapshot(userId));
      } else if (request.method === "GET" && path === "connections" && connections) {
        json(response, 200, { connections: await connections(principal) });
      } else if (request.method === "GET" && path === "jobs" && jobs) {
        json(response, 200, { jobs: await jobs.list(userId) });
      } else if (config && request.method === "PUT") {
        const input = await body(request);
        if (connections && !(await connections(principal)).some((c) => c.nodeId === input.config?.nodeId)) {
          throw Object.assign(new Error("请选择当前账户可用的工作区或设备"), { statusCode: 403, code: "extension_node_denied" });
        }
        json(response, 200, await service.configure(userId, decodeURIComponent(config[1]), input));
      } else if (match && request.method === "POST") {
        json(response, 200, await service.install(userId, decodeURIComponent(match[1]), await body(request)));
      } else if (match && ["PATCH", "DELETE"].includes(request.method)) {
        json(response, 200, await service.change(userId, decodeURIComponent(match[1]), await body(request), request.method === "DELETE"));
      } else if (request.method === "POST" && path === "private-releases") {
        json(response, 201, await service.uploadPrivate(userId, principal.user.name, await body(request)));
      } else if (request.method === "POST" && path === "contributions") {
        json(response, 201, await service.saveContribution(userId, principal.user.name, await body(request)));
      } else if (request.method === "GET" && contribution) {
        json(response, 200, { contribution: await service.contributionFor(userId, decodeURIComponent(contribution[1])) });
      } else if (request.method === "POST" && submit) {
        json(response, 200, await service.submit(userId, decodeURIComponent(submit[1]), await body(request)));
      } else if (request.method === "GET" && path === "review") {
        json(response, 200, { contributions: await service.reviewQueue(userId) });
      } else if (request.method === "POST" && path === "review") {
        const input = await body(request);
        json(response, 200, await service.review(userId, String(input.userId || ""), String(input.id || ""), input));
      } else json(response, 404, { error: "市场接口不存在", code: "endpoint_not_found" });
    } catch (error) {
      const duplicate = error.code === "23505";
      json(response, duplicate ? 409 : Number(error.statusCode) || 500, {
        error: duplicate ? "此版本已发布，请使用新版本号" : error.statusCode ? error.message : "市场请求失败，请稍后重试",
        code: duplicate ? "release_immutable" : error.code || "marketplace_error"
      });
    }
    return true;
  };
}
