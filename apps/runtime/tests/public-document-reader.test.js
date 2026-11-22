import { describe, expect, it } from "vitest";
import { projectPublicCards } from "../../../src/chat/public-document.mjs";
import { createDocumentLinkHttpHandler, documentReaderPayload } from "../src/sharing/document-link-http-handler.mjs";

const id = "a".repeat(43), path = `/share/${id}`;
const markdown = `user 问题
assistant 回复
思考 <!-- zion-thinking:id=thought -->
调用 read <!-- zion-tool:id=tool -->
\`\`\`txt
调用 read <!-- zion-tool:id=hidden -->
\`\`\``;
const annotations = { tools: [
  { id: "tool", name: "read", args: { file_path: "/tmp/plan" }, result: "公开结果", ok: true, sessionId: "PRIVATE_SESSION", credentials: "PRIVATE_SECRET" },
  { id: "hidden", result: "HIDDEN_CARD" },
  { id: "unreferenced", result: "UNREFERENCED_CARD" }],
  thinking: [{ id: "thought", text: "公开思考", secret: "PRIVATE_SECRET" }, { id: "other", text: "PRIVATE_THOUGHT" }],
  deletedToolIds: ["PRIVATE_DELETE"], settings: { apiKey: "PRIVATE_SECRET" } };
function harness(state = "read", template = null) {
  const value = { state, title: "公开标题", markdown, cards: projectPublicCards(markdown, annotations),
    contentRevision: "hash", updatedAt: 1, mode: "public", role: null,
    ownerId: "PRIVATE_OWNER", originSpaceId: "PRIVATE_ORIGIN", documentId: "PRIVATE_DOC" };
  const handler = createDocumentLinkHttpHandler({
    sharing: { links: { view: async () => value } },
    accessControl: { requireLogin: async () => { throw Object.assign(new Error("login"), { statusCode: 401 }); } },
    ...(template ? { readReaderTemplate: async () => template } : {})
  });
  const call = async (action = "", method = "GET") => {
    const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    await handler({ method, headers: {} }, response, new URL(`https://example.com${path}${action}`)); return response;
  };
  return { value, call };
}
describe("public native reader projection and delivery", () => {
  it("only projects visible anchored records and explicitly selected display fields", () => {
    const cards = projectPublicCards(markdown, annotations);
    expect(cards.tools).toHaveLength(1); expect(cards.thinking).toHaveLength(1);
    expect(cards.tools[0].result).toBe("公开结果");
    expect(JSON.stringify(cards)).not.toMatch(/PRIVATE_|UNREFERENCED|HIDDEN_CARD/);
    const payload = documentReaderPayload(harness().value);
    expect(JSON.stringify(payload)).not.toMatch(/PRIVATE_OWNER|PRIVATE_ORIGIN|PRIVATE_DOC/);
    expect(projectPublicCards(markdown, { tools: [{ ...annotations.tools[0], assistantBlockId: "other-answer" }] }).tools).toHaveLength(0);
    const legacy = "调用 read";
    expect(projectPublicCards(legacy, { tools: [{ id: "legacy", from: 0, to: legacy.length, result: "历史记录" }] }).tools[0].result).toBe("历史记录");
  });
  it("serves scoped JSON with the same read permission decision and no body for login/request states", async () => {
    const response = await harness().call("/content");
    expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(response.body)).toMatchObject({ state: "read", markdown, cards: { thinking: [{ text: "公开思考", id: "thought" }] } });
    for (const state of ["login", "request"]) {
      expect(JSON.parse((await harness(state).call("/content")).body)).toEqual({ state });
    }
    expect((await harness().call("/content", "PUT")).status).toBe(405);
  });
  it("uses a separate native entry and escapes embedded payload boundaries and hostile titles", async () => {
    const h = harness("read", `<!doctype html><title><!--SHARE_TITLE--></title><body><!--SHARE_FALLBACK--><script id="public-document" type="application/json"><!--SHARE_DATA--></script><script src="/assets/reader.js" type="module"></script></body>`);
    h.value.title = '</title><script>alert("title")</script>';
    h.value.markdown = 'user </script><script>alert("body")</script> <!--SHARE_DATA--> $&';
    const response = await h.call();
    expect(response.status).toBe(200);
    expect(response.body).toContain('/assets/reader.js');
    expect(response.body).not.toContain('<script>alert');
    const embedded = response.body.match(/<script id="public-document" type="application\/json">([\s\S]*?)<\/script>/)[1];
    expect(JSON.parse(embedded).markdown).toBe(h.value.markdown);
    expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(response.headers["content-security-policy"]).not.toContain("unsafe-eval");
  });
});
