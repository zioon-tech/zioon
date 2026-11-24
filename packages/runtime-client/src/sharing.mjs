import { createRequestSignal } from "./request-signal.mjs";
/** Account sharing never changes the caller's account or resource catalog. */
export function sharingToken(value) {
  const raw = String(value || "").trim();
  const token = /^https?:\/\//.test(raw) ? new URLSearchParams(new URL(raw).hash.slice(1)).get("share") : raw;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("邀请链接无效");
  return token;
}

export function createSharingClient({ baseUrl, headers = {}, fetchImpl = globalThis.fetch, signal } = {}) {
  const origin = new URL(baseUrl).origin;
  async function request(path = "", method = "GET", body) {
    const h = new Headers(headers);
    h.set("accept", "application/json");
    if (body !== undefined) h.set("content-type", "application/json");
    const lifetime = createRequestSignal(signal);
    try {
      const response = await fetchImpl(`${origin}/v1/sharing${path}`, {
        method, headers: h, credentials: "include", redirect: "error", signal: lifetime.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(value.error || `HTTP ${response.status}`),
        { code: value.code, status: response.status, statusCode: response.status });
      return value;
    } finally {
      lifetime.dispose();
    }
  }
  const documentLinkRequest = async (...args) => {
    const value = await request(...args);
    // A deployment can retain a legacy Runtime public URL. Keep browser links
    // on the client's established origin so reader preferences share storage.
    if (value.link && /^[A-Za-z0-9_-]{43}$/.test(value.link.id || "")) {
      value.link = { ...value.link, url: `${origin}/share/${value.link.id}` };
    }
    return value;
  };
  const id = value => encodeURIComponent(String(value));
  return {
    list: (direction = "received") => request(`?direction=${id(direction)}`),
    sources: () => request("/sources"),
    content: () => request("/content"),
    mutateFolder: (shareId, body) => request(`/${id(shareId)}/folder-operations`, "POST", body),
    create: body => request("", "POST", body),
    resolveRecipient: recipient => request("/recipients/resolve", "POST", { recipient }),
    addRecipient: (shareId, body) => request(`/${id(shareId)}/recipients`, "POST", body),
    updateRecipient: (shareId, recipientId, role) => request(`/${id(shareId)}/recipients/${id(recipientId)}`, "PUT", { role }),
    updateDocumentCollaborator: (documentId, recipientId, role) => request(`/documents/${id(documentId)}/collaborators/${id(recipientId)}`, "PUT", { role }),
    updateSourceCollaborator: (kind, sourceId, recipientId, role) => request(`/resources/${id(kind)}/${id(sourceId)}/collaborators/${id(recipientId)}`, "PUT", { role }),
    preview: token => request("/preview", "POST", { token: sharingToken(token) }),
    accept: token => request("/accept", "POST", { token: sharingToken(token) }),
    invite: (shareId, body = {}) => request(`/${id(shareId)}/invitations`, "POST", body),
    revoke: (shareId, body = {}) => request(`/${id(shareId)}/revoke`, "POST", body),
    leave: shareId => request(`/${id(shareId)}/leave`, "POST", {}),
    documents: shareId => request(`/${id(shareId)}/documents`),
    participants: (documentId, originSpaceId) => request(`/documents/${id(documentId)}/participants${originSpaceId ? `?origin=${id(originSpaceId)}` : ""}`),
    documentLink: documentId => documentLinkRequest(`/documents/${id(documentId)}/link`),
    setDocumentLink: (documentId, mode) => documentLinkRequest(`/documents/${id(documentId)}/link`, "PUT", { mode }),
    accessRequests: documentId => request(`/documents/${id(documentId)}/requests`),
    decideAccess: (documentId, requestId, status, role) => request(`/documents/${id(documentId)}/requests/${id(requestId)}`, "PUT", { status, role }),
    openLink: linkId => request(`/links/${id(linkId)}`),
    documentPrivacy: documentId => request(`/documents/${id(documentId)}/privacy`),
    privacy: (documentId, value) => request(`/documents/${id(documentId)}/privacy`, "PUT", { private: value })
  };
}
