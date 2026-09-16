import { Buffer } from "node:buffer";

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

function diagnosticsRunId(pathname) {
  const match = String(pathname || "").match(
    /^\/v1\/runs\/([^/]+)\/diagnostics$/
  );
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

function includesOption(url, name, fallback = false) {
  const include = url.searchParams.get("include");
  if (include == null || include === "") return fallback;
  return new Set(
    include.split(",").map((value) => value.trim()).filter(Boolean)
  ).has(name);
}

export function createObservabilityHttpHandler({
  service,
  canViewExternalTrace = () => false
} = {}) {
  if (!service?.diagnoseRun || !service?.status) {
    throw new Error("Observability HTTP Handler requires a service");
  }
  return async (request, response, url) => {
    if (
      request.method === "GET"
      && url.pathname === "/v1/observability/status"
    ) {
      json(response, 200, await service.status());
      return true;
    }

    const runId = diagnosticsRunId(url.pathname);
    if (request.method !== "GET" || !runId) return false;
    const diagnostic = await service.diagnoseRun(runId, {
      includeStages: includesOption(url, "stages", false),
      includeFindings: includesOption(url, "findings", false),
      includeExternalUrl: canViewExternalTrace(request.zionPrincipal)
    });
    if (!diagnostic) {
      json(response, 404, { error: "Run not found" });
      return true;
    }
    json(response, 200, { diagnostic });
    return true;
  };
}
