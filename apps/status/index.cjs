const { createHmac } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const targets = [
  ["auth", "统一登录", "https://auth.zioon.tech/api/v1/zioon/session/status", b => typeof b.authenticated === "boolean"],
  ["runtime", "Runtime API", "https://runtime.zioon.tech/health", b => b.ok === true && b.service === "zion-runtime"],
  ["workbench", "Workbench", "https://workbench.zioon.tech/readyz", b => b.ok === true && b.app === "workbench"],
  ["mobile", "Mobile", "https://mobile.zioon.tech/manifest.webmanifest", b => b.name === "Zion Mobile" && b.scope === "/"],
  ["marketplace", "Marketplace", "https://marketplace.zioon.tech/health", b => b.ok === true && b.service === "zioon-marketplace"],
  ["adc", "Device Cloud", "https://adc.zioon.tech/health", b => b.ok === true && typeof b.schemaVersion === "string"],
  ["memory", "Memory", "https://memory.zioon.tech/health", b => b.ok === true && typeof b.version === "string"]
];
const security = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "Strict-Transport-Security": "max-age=31536000", "Cache-Control": "no-cache"
};
const output = (statusCode, body, type = "application/json; charset=utf-8") => ({
  statusCode, headers: { ...security, "Content-Type": type }, isBase64Encoded: false,
  body: typeof body === "string" ? body : JSON.stringify(body)
});
async function object(method, context, body, etag) {
  const bucket = process.env.STATUS_BUCKET;
  const credentials = context.credentials;
  if (!bucket || !credentials?.accessKeyId || !credentials?.accessKeySecret || !credentials.securityToken) throw new Error("Storage identity unavailable");
  const date = new Date().toUTCString(), type = body ? "application/json" : "";
  const canonical = `x-oss-security-token:${credentials.securityToken}\n`;
  const signature = createHmac("sha1", credentials.accessKeySecret)
    .update(`${method}\n\n${type}\n${date}\n${canonical}/${bucket}/status/latest.json`).digest("base64");
  return fetch(`https://${bucket}.oss-cn-shanghai.aliyuncs.com/status/latest.json`, {
    method, headers: { date, authorization: `OSS ${credentials.accessKeyId}:${signature}`,
      "x-oss-security-token": credentials.securityToken, ...(type ? { "content-type": type } : {}),
      ...(etag ? { "if-match": etag } : {}) },
    ...(body ? { body } : {}), signal: AbortSignal.timeout(6000), redirect: "error"
  });
}
async function latest(context) {
  const response = await object("GET", context);
  if (response.status === 404) return { value: null, etag: null };
  if (!response.ok) throw new Error("Status snapshot unavailable");
  return { value: await response.json(), etag: response.headers.get("etag") };
}
async function probe([id, name, url, validate]) {
  const started = Date.now();
  try {
    const response = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8000),
      headers: { accept: "application/json", "user-agent": "Zioon-Status-Monitor/1.0" } });
    const body = await response.json().catch(() => null);
    const ok = response.ok && body && validate(body);
    return { id, name, status: ok ? "operational" : "unavailable",
      checkedAt: Date.now(), latencyMs: Date.now() - started, httpStatus: response.status };
  } catch {
    return { id, name, status: "unavailable", checkedAt: Date.now(), latencyMs: Date.now() - started };
  }
}
async function check(context) {
  const started = Date.now();
  const previous = await latest(context).catch(() => ({ value: null, etag: null }));
  const components = await Promise.all(targets.map(probe));
  let incidents = previous.value?.incidents || [], incidentsCheckedAt = previous.value?.incidentsCheckedAt || null;
  try {
    const response = await fetch("https://runtime.zioon.tech/v1/status/incidents", {
      signal: AbortSignal.timeout(6000), redirect: "error", headers: { accept: "application/json" } });
    const value = await response.json();
    if (response.ok && Array.isArray(value.incidents)) {
      const sanitize = i => ({ id: i.id, title: i.title, message: i.message, status: i.status,
        impact: i.impact, components: i.components, createdAt: i.createdAt, updatedAt: i.updatedAt });
      incidents = value.incidents.map(i => ({ ...sanitize(i), updates: (i.updates || []).map(sanitize) }));
      incidentsCheckedAt = Date.now();
    }
  } catch {}
  const snapshot = { generatedAt: Date.now(), checkStartedAt: started, region: "阿里云上海 · 独立函数监测",
    staleAfterMs: 5 * 60000, components, incidents, incidentsCheckedAt, persistence: "durable",
    monitoring: "每分钟自动检查。检测验证各服务入口，不代表用户任务成功率。" };
  // Do not let an older overlapping trigger overwrite a newer snapshot.
  const current = await latest(context).catch(() => previous);
  if (current.value?.checkStartedAt > started) return current.value;
  const saved = await object("PUT", context, JSON.stringify(snapshot), current.etag);
  if (!saved.ok && saved.status !== 412) throw new Error("Status snapshot write failed");
  return snapshot;
}
exports.handler = async (rawEvent, context) => {
  const event = JSON.parse(rawEvent.toString());
  if (!event.requestContext?.http) return check(context);
  const method = event.requestContext.http.method;
  const scheme = Object.entries(event.headers || {}).find(([name]) => name.toLowerCase() === "x-forwarded-proto")?.[1]
    || event.requestContext.http.protocol;
  if (scheme === "http" || scheme === "HTTP") {
    return { statusCode: 308, headers: { ...security, Location: `https://status.zioon.tech${event.rawPath}` },
      isBase64Encoded: false, body: "" };
  }
  if (!["GET", "HEAD"].includes(method)) return output(405, { error: "method_not_allowed" });
  const path = event.rawPath;
  if (path === "/api/check") {
    try {
      const stored = (await latest(context)).value;
      if (stored) return output(200, stored);
    } catch {}
    return output(200, { generatedAt: 0, region: "阿里云上海 · 独立函数监测",
      staleAfterMs: 300000, components: targets.map(([id, name]) => ({ id, name, status: "unknown", latencyMs: 0 })),
      incidents: [], incidentsCheckedAt: null, persistence: "unavailable",
      monitoring: "每分钟自动检查；当前暂时无法读取最近的检测记录。" });
  }
  const files = { "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"], "/style.css": ["style.css", "text/css; charset=utf-8"],
    "/website-filing.css": ["website-filing.css", "text/css; charset=utf-8"],
    "/public-security-filing.png": ["public-security-filing.png", "image/png"] };
  if (!files[path]) return output(404, { error: "not_found" });
  const [file, type] = files[path];
  if (type === "image/png") {
    const body = method === "HEAD" ? "" : (await readFile(join(__dirname, file))).toString("base64");
    return { ...output(200, body, type), isBase64Encoded: true };
  }
  return output(200, method === "HEAD" ? "" : await readFile(join(__dirname, file), "utf8"), type);
};
