export function createSandboxHttpHandler({ broker, accessControl }) {
  return async (request, response, url) => {
    if (url.pathname !== "/v1/sandbox/workspace"
      && !/^\/v1\/sandbox\/workspace\/(?:pause|release)$/.test(url.pathname)) return false;
    const principal = await accessControl.reauthorize(request.zionPrincipal, "resource.execute");
    const accountId = principal.user.id;
    const value = request.method === "GET" && url.pathname === "/v1/sandbox/workspace"
      ? await broker.workspaceStatus(accountId)
      : request.method === "POST"
        ? await broker.controlWorkspace(accountId, url.pathname.split("/").pop())
        : null;
    response.writeHead(value ? (value.failureCode === "sandbox_workspace_busy" ? 409 : 200) : 405, {
      "content-type": "application/json", "cache-control": "no-store"
    });
    response.end(JSON.stringify(value || { error: "method_not_allowed" }));
    return true;
  };
}
