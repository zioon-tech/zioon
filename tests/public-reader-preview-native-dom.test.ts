import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { mountPublicReader } from "../src/public-reader/reader";

const enabled = process.env.ZIOON_SHARING_PREVIEW_ACCEPTANCE === "1";
const nativeFetch = globalThis.fetch;
describe.skipIf(!enabled)("public reader on the persistent local preview", () => {
  it("loads the delivered reader entry, displays persisted cards anonymously and follows permission changes", async () => {
    const directory = resolve(".runtime-data/spaces-preview");
    const config = JSON.parse(readFileSync(resolve(directory, "config.local.json"), "utf8"));
    const owner = config.accounts[0], doc = `reader-check-${randomUUID()}`;
    const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "PUT") => {
      const response = await nativeFetch(config.runtimeUrl + path, { method,
        headers: { authorization: `Bearer ${owner.token}`, "x-zioon-space-id": owner.personalSpaceId,
          "x-zion-workbench-protocol": "5", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const text = `user 分享中的完整会话\nassistant <!-- zion-assistant:id=public-answer --> **回答内容**\n思考 <!-- zion-thinking:id=public-thought -->\n调用 read <!-- zion-tool:id=public-tool -->`;
    const meta = { title: "阅读页临时验收", secret: "HIDDEN_CONFIGURATION",
      annotations: { thinking: [{ id: "public-thought", text: "需要保留的详细思考", assistantBlockId: "public-answer" }],
        tools: [{ id: "public-tool", name: "read", args: { file_path: "/tmp/result.md" }, result: "1: 工具结果详情", ok: true, assistantBlockId: "public-answer" },
          { id: "unreferenced-tool", result: "HIDDEN_TOOL" }] } };
    let main: any, revoked: ReturnType<typeof mountPublicReader> | null = null;
    const checks: string[] = [];
    try {
      expect((await call(`/v1/workbench-state/sessions/${doc}`, { text, meta })).status).toBe(200);
      const created = await call(`/v1/sharing/documents/${doc}/link`, { mode: "public" });
      const path = `/share/${created.value.link.id}`;
      const response = await nativeFetch(config.runtimeUrl + path), html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toMatch(/src="\/assets\/share-reader-[^"]+\.js"/);
      expect(html).not.toMatch(/HIDDEN_CONFIGURATION|HIDDEN_TOOL|registerSW.js/);
      expect(html).not.toMatch(/modulepreload[^>]+vendor\/mermaid/);
      const assetPaths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]);
      for (const assetPath of assetPaths) expect((await nativeFetch(config.runtimeUrl + assetPath, { method: "HEAD" })).status).toBe(200);
      checks.push("actual native share HTML and its entry/style/preload assets served successfully", "no unrelated metadata, orphan cards or public-page service worker registration");
      const requests: string[] = [];
      vi.stubGlobal("fetch", (url: any, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (init?.method && init.method !== "GET") headers.set("origin", config.runtimeUrl);
        requests.push(String(url)); return nativeFetch(new URL(String(url), config.runtimeUrl), { ...init, headers });
      });
      const ambientZion = (window as any).zion;
      const previousPath = location.pathname;
      (window as any).zion = undefined;
      history.replaceState({}, "", path);
      document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)![1];
      try {
        vi.resetModules();
        main = await import("../src/public-reader/main");
        main = { publicReader: await main.publicReader };
        expect(main.publicReader).toBeTruthy();
        expect(main.publicReader.core.constructor.name).toBe("EditorCore");
        expect(document.querySelector(".zion-panel .zion-editor-slot > .zion-toc-layout > .cm-editor")).toBe(main.publicReader.view.dom);
        expect(document.querySelector(".public-reader-shell h1")).toBeNull();
        document.querySelector<HTMLButtonElement>('[data-action="outline"]')!.click();
        document.querySelector<HTMLButtonElement>('[aria-label="按角色分组 TOC"]')!.click();
        await vi.waitFor(() => expect(document.querySelectorAll('.zion-toc-list [data-toc-kind="block"]')).toHaveLength(2));
        expect(document.querySelector(".cm-role-token-assistant")).toBeTruthy();
        expect(document.querySelector(".cm-md-strong")?.textContent).toBe("回答内容");
        document.querySelector<HTMLButtonElement>('[data-card-id="public-thought"] button')!.click();
        document.querySelector<HTMLButtonElement>('[data-card-id="public-tool"] button')!.click();
        expect(document.querySelector(".zion-tool-call-inline-text")?.textContent).toBe("调用 read");
        expect(document.querySelector(".zion-thinking-card-body")?.textContent).toBe("需要保留的详细思考");
        expect(document.querySelector(".zion-tool-read-text")?.textContent).toContain("工具结果详情");
        document.querySelector<HTMLButtonElement>('[data-action="find"]')!.click();
        const find = document.querySelector<HTMLTextAreaElement>("#search-input")!;
        find.value = "工具结果详情"; find.dispatchEvent(new Event("input"));
        expect(document.querySelector("#match-count")?.textContent).toBe("0/1");
        document.querySelector<HTMLButtonElement>('[data-search-control="next-btn"]')!.click();
        expect(document.querySelector("#match-count")?.textContent).toBe("1/1");
        expect(document.querySelector("#regex")).toBeTruthy();
        expect(document.querySelector("#replace-input")).toBeNull();
        main.publicReader.view.dispatch({ changes: { from: 0, insert: "FORBIDDEN" } });
        expect(main.publicReader.view.state.doc.toString()).toBe(text);
        expect(requests.every(url => url === "/v1/account/me" || url.startsWith(`${path}/presence`))).toBe(true);
        checks.push("delivered boot payload initializes the actual reader entry with only viewer identity and document presence",
          "actual EditorCore, panel/TOC layout and native search controls initialize from the delivered entry",
          "persisted roles, Markdown, thought and read-result cards render in native DOM", "document mutation rejected");
        await call(`/v1/workbench-state/sessions/${doc}`, { text: text + "\n新增内容", meta: { ...meta, title: "已修改的会话标题" } });
        await main.publicReader.refresh();
        expect(document.querySelector(".public-reader-title")?.textContent).toBe("已修改的会话标题");
        expect(main.publicReader.view.state.doc.toString()).toContain("新增内容");
        expect(document.querySelector(".zion-thinking-card-body")).toBeTruthy();
        expect(requests.every(url => url === "/v1/account/me" || url === `${path}/content` || url.startsWith(`${path}/presence`))).toBe(true);
        checks.push("anonymous refresh reads current title/body and preserves expanded detail");
        const json = await (await nativeFetch(config.runtimeUrl + path + "/content")).json();
        main.publicReader.dispose();
        const host = document.createElement("div"); document.body.replaceChildren(host);
        const onAccessLost = vi.fn();
        revoked = mountPublicReader(host, json, { path, refresh: async () => (await nativeFetch(config.runtimeUrl + path + "/content")).json(), onAccessLost });
        await call(`/v1/sharing/documents/${doc}/link`, { mode: "restricted" });
        expect(await (await nativeFetch(config.runtimeUrl + path + "/content")).json()).toEqual({ state: "login" });
        await revoked.refresh();
        expect(onAccessLost).toHaveBeenCalledOnce(); expect(document.querySelector(".cm-editor")).toBeNull();
        await call(`/v1/sharing/documents/${doc}/privacy`, { private: true });
        expect((await nativeFetch(config.runtimeUrl + path + "/content")).status).toBe(404);
        checks.push("restricted access immediately closes anonymous JSON and clears the reader on refresh", "private content returns 404");
      } finally {
        main?.publicReader?.dispose(); revoked?.dispose(); document.body.replaceChildren();
        (window as any).zion = ambientZion; history.replaceState({}, "", previousPath); vi.unstubAllGlobals();
      }
      writeFileSync(resolve(directory, "acceptance/public-reader-native-dom.json"), JSON.stringify({ status: "PASS", checks }, null, 2));
    } finally {
      await call(`/v1/workbench-state/sessions/${doc}`, undefined, "DELETE");
    }
  }, 45000);
});
