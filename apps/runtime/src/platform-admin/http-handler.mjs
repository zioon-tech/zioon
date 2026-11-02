import { json, readJson } from "../access-control.mjs";
import { accountError } from "../accounts/account-policy.mjs";

export function createPlatformAdminHandler({ service, access }) {
  return async (request, response, url) => {
    if (url.pathname === "/v1/status/incidents" && request.method === "GET") {
      json(response, 200, { generatedAt: Date.now(), incidents: await service.incidents() });
      return true;
    }
    if (!url.pathname.startsWith("/v1/platform-admin/")) return false;
    try {
      const principal = await access.requireLogin(request);
      const role = await service.requireRole(principal);
      const path = url.pathname.slice("/v1/platform-admin/".length);
      if (request.method === "GET") {
        const reads = { overview: () => service.overview(), accounts: () => service.accounts(),
          runs: () => service.runs(), workspaces: () => service.workspaces(), roles: () => service.roles(),
          incidents: () => service.incidents(), audit: () => service.history(),
          me: () => ({ user: { id: principal.user.id, name: principal.user.name, email: principal.user.email }, ...role }) };
        if (!reads[path]) throw accountError(404, "not_found");
        json(response, 200, await reads[path]());
        return true;
      }
      if (request.method === "PUT" && path.startsWith("roles/")) {
        json(response, 200, await service.changeRole(principal, decodeURIComponent(path.slice(6)), await readJson(request)));
        return true;
      }
      if ((request.method === "POST" && path === "incidents") || (request.method === "PUT" && path.startsWith("incidents/"))) {
        json(response, 200, await service.changeIncident(principal,
          path === "incidents" ? null : decodeURIComponent(path.slice(10)), await readJson(request)));
        return true;
      }
      throw accountError(404, "not_found");
    } catch (error) {
      json(response, error.statusCode || 503, { code: error.code || "platform_admin_unavailable",
        error: error.statusCode ? error.message : "管理服务暂时不可用" });
      return true;
    }
  };
}
