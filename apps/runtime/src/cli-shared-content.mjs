import { cliJson, boundedFetch } from "./cli-run-follow.mjs";
import { conversationLineRanges, isContinuationBoundaryLine } from "../../../src/chat/session-document-format.js";

/** Native document text is the shared history; private Runtime history is never
 * appended to it. Reuse the editor's fence boundaries for quoted role examples. */
export function sharedDocumentMessages(text) {
  const messages = [];
  let role = "user", lines = [];
  const flush = () => {
    const content = lines.join("\n").trim();
    if (content) messages.push({ role, content });
    lines = [];
  };
  for (const range of conversationLineRanges(text)) {
    const line = range.line;
    if (!range.literal && isContinuationBoundaryLine(line)) { flush(); role = "user"; continue; }
    if (!range.literal && /(?:<!--\s*zion-(?:thinking|tool):id=|^\s*(?:思考|Thinking)\s*<!--)/.test(line)) continue;
    const marker = !range.literal && line.match(/^(system|user|assistant)\s+(.*)$/);
    if (marker) {
      flush(); role = marker[1];
      lines.push(marker[2].replace(/<!--\s*zion-assistant:id=[^>]+-->\s*/g, ""));
    } else lines.push(line);
  }
  flush();
  return messages.map(message => {
    if (message.role !== "user") return message;
    const parts = [], buffer = [];
    const emit = () => { if (buffer.length) { const text = buffer.join("\n").trim(); if (text) parts.push({ type: "text", text }); buffer.length = 0; } };
    for (const range of conversationLineRanges(message.content)) {
      const image = !range.literal && range.line.match(/^\s*!\[[^\]]*\]\((zion-asset:\/\/[A-Za-z0-9._:-]+|data:image\/[^)\s]+)\)\s*$/);
      if (image) { emit(); parts.push({ type: "image_url", image_url: { url: image[1] } }); }
      else buffer.push(range.line);
    }
    emit();
    return parts.some(p => p.type === "image_url") ? { ...message, content: parts } : message;
  });
}

export function createSharedChatClient({ baseUrl, headers, fetchImpl, target, privateClient, contentClient, sessionOptions }) {
  const id = encodeURIComponent(target.documentId);
  const scopedHeaders = { ...headers, "x-zioon-content-space": target.originSpaceId,
    "x-zioon-content-document": target.documentId, "x-zion-workbench-protocol": "5" };
  const request = async (path, method = "GET", body) => cliJson(await boundedFetch(fetchImpl, scopedHeaders)(
    `${baseUrl.replace(/\/+$/, "")}${path}`, { method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
  const read = () => request(`/v1/workbench-state/sessions/${id}`);
  const deny = () => { throw new Error("Open your private conversation with /new or /sessions for this action."); };
  let selectedModel = sessionOptions.model;
  return {
    ...contentClient,
    contentTarget: target,
    models: privateClient.models,
    identity: privateClient.identity,
    listSessions: privateClient.listSessions,
    createSession: deny, forkSession: deny, compression: deny, startBranch: deny,
    async getSession(documentId) {
      if (documentId !== target.documentId) return deny();
      const snapshot = await read();
      return { id: target.documentId, title: snapshot.meta?.title || target.name, model: selectedModel };
    },
    async updateSession(documentId, patch) {
      if (documentId !== target.documentId) return deny();
      selectedModel = patch.model;
      return { id: target.documentId, title: target.name, model: selectedModel };
    },
    async getTranscript() { return sharedDocumentMessages((await read()).text); },
    async getActiveRun() {
      try { return await contentClient.getActiveRun(target.documentId); }
      catch (error) { if (error.statusCode === 404) return null; throw error; }
    },
    async prepareMessage(content, clientRequestId) {
      if (target.role !== "editor") throw new Error("This shared conversation is view-only.");
      const history = sharedDocumentMessages((await read()).text);
      const messages = [...history, { role: "user", content }];
      return { sessionId: target.documentId, messages, sessionHistory: messages,
        interactionProfileId: sessionOptions.interactionProfileId,
        ...(selectedModel ? { model: selectedModel } : {}),
        conversationInput: { schemaVersion: 1, mode: "snapshot", clientRequestId } };
    },
    async sendMessage(documentId, content, clientRequestId, prepared) {
      if (documentId !== target.documentId) return deny();
      return request("/v1/runs", "POST", prepared || await this.prepareMessage(content, clientRequestId));
    },
    async getSubmission(clientRequestId) {
      try {
        const { input } = await request(`/v1/sessions/${id}/inputs/${encodeURIComponent(clientRequestId)}`);
        return input?.status === "accepted" ? { runId: input.runId } : null;
      } catch (error) { if (error.statusCode === 404) return null; throw error; }
    }
  };
}
