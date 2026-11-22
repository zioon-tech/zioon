import { createRequestSignal } from "./request-signal.mjs";
/** Shared Spaces API used by Workbench, CLI and third-party clients. All
 * operations carry explicit scope and bounded, abortable requests. */
export function createSpacesClient({ baseUrl, spaceId = "", headers = {}, fetchImpl = globalThis.fetch, signal } = {}) {
  const origin = new URL(baseUrl).origin;
  async function request(path, { method = "GET", body, targetSpace = spaceId } = {}) {
    if (targetSpace && (targetSpace.length > 256 || /[\x00-\x20]/.test(targetSpace))) throw new Error("Invalid Space");
    const requestHeaders = new Headers(headers);
    requestHeaders.set("accept", "application/json");
    if (targetSpace) requestHeaders.set("x-zioon-space-id", targetSpace);
    else requestHeaders.delete("x-zioon-space-id");
    if (body !== undefined) requestHeaders.set("content-type", "application/json");
    const lifetime = createRequestSignal(signal);
    try {
    const response = await fetchImpl(`${origin}${path}`, {
      method, credentials: "include", redirect: "error", headers: requestHeaders,
      signal: lifetime.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(value.message || value.error || `HTTP ${response.status}`),
      { status: response.status, statusCode: response.status, code: value.code || value.error });
    return value;
    } finally { lifetime.dispose(); }
  }
  const space = (tail = "", id = spaceId) => {
    if (!id) throw new Error("Choose a Space first (--space <id>)");
    return `/v1/spaces/${encodeURIComponent(id)}${tail ? `/${tail}` : ""}`;
  };
  return {
    request,
    identity: () => request("/v1/account/me"),
    list: () => request("/v1/account/spaces"),
    create: name => request("/v1/account/spaces", { method: "POST", body: { name } }),
    describe: () => request(space()),
    update: body => request(space(), { method: "PATCH", body }),
    contacts: () => request("/v1/contacts"),
    addContact: contactId => request("/v1/contacts", { method: "POST", body: { contactId } }),
    removeContact: id => request(`/v1/contacts/${encodeURIComponent(id)}`, { method: "DELETE" }),
    accept: token => request("/v1/space-invitations/accept", { method: "POST", body: { token } }),
    get: (tail, query = "") => request(`${space(tail)}${query ? `?${query}` : ""}`),
    mutate: (tail, method, body) => request(space(tail), { method, body }),
    document: (id, tail = "") => request(space(`documents/${encodeURIComponent(id)}${tail ? `/${tail}` : ""}`)),
    mutateDocument: (id, tail, method, body) => request(space(`documents/${encodeURIComponent(id)}/${tail}`), { method, body }),
    transfer: (destinationId, body) => request(space("documents/transfer", destinationId),
      { method: "POST", body, targetSpace: destinationId })
  };
}
