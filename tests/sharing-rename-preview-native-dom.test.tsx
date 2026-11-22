import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import pg from "pg";

const enabled = process.env.ZIOON_SHARING_PREVIEW_ACCEPTANCE === "1";
const native = globalThis.fetch;
describe.skipIf(!enabled)("rename synchronization in the persistent local preview", () => {
  it("updates open owner permissions, online avatar and received folder details using current titles", async () => {
    vi.resetModules(); localStorage.clear(); sessionStorage.clear();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const directory = resolve(".runtime-data/spaces-preview");
    const config = JSON.parse(readFileSync(resolve(directory, "config.local.json"), "utf8"));
    const [owner, reader, guest] = config.accounts, doc = `rename-doc-${randomUUID()}`, folderId = `rename-folder-${randomUUID()}`;
    const call = async (user: any, path: string, body?: any, method = body === undefined ? "GET" : "POST") => {
      let result!: { status: number; value: any };
      await act(async () => {
        const response = await native(config.runtimeUrl + path, { method, headers: {
          authorization: `Bearer ${user.token}`, "x-zioon-space-id": user.personalSpaceId,
          "content-type": "application/json", "x-zion-workbench-protocol": "5"
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        result = { status: response.status, value: await response.json() };
      });
      return result;
    };
    const editFolder = async (name?: string) => {
      const current = (await call(owner, "/v1/workbench-state/tree")).value;
      const tree = structuredClone(current.tree);
      const existing = tree.children?.find((node: any) => node.id === folderId);
      if (name === undefined) tree.children = (tree.children || []).filter((node: any) => node.id !== folderId);
      else if (existing) existing.title = name;
      else tree.children = [...(tree.children || []).filter((node: any) => node.id !== doc),
        { id: folderId, type: "folder", title: name, children: [{ id: doc, type: "session", title: "原会话" }] }];
      const result = await call(owner, "/v1/workbench-state/tree", { tree, base_tree: current.tree }, "PUT");
      expect(result.status).toBe(200); expect(result.value.ok).toBe(true);
    };
    const changes = new Map<string, Set<any>>(), commands = new Map<string, any>();
    const subscribe = (key: string, fn: any) => {
      if (!changes.has(key)) changes.set(key, new Set()); changes.get(key)!.add(fn);
      return { dispose: () => changes.get(key)?.delete(fn) };
    };
    (window as any).zion = {
      state: { get: () => undefined, onDidChange: subscribe },
      events: { on: subscribe, emit: (key: string, payload: any) => changes.get(key)?.forEach(fn => fn(payload)) },
      commands: { registerCommand: (id: string, fn: any) => { commands.set(id, fn); return { dispose() { commands.delete(id); } }; },
        executeCommand: vi.fn() }
    };
    localStorage.setItem("zion.runtime.baseUrl", config.runtimeUrl);
    const account = await import("../packages/account-ui/src/client");
    const { createSharingClient } = await import("../packages/runtime-client/src/sharing.mjs");
    const api = createSharingClient({ baseUrl: config.runtimeUrl, headers: {
      authorization: `Bearer ${owner.token}`, "x-zioon-space-id": owner.personalSpaceId
    }, fetchImpl: native });
    const { SharingDialog } = await import("../src/ui/workbench/SharingDialog");
    const host = document.createElement("div"), header = document.createElement("header");
    document.body.append(host, header);
    const root = createRoot(host), sockets: any[] = [], shareIds: string[] = [];
    let participants: any, workbench: any, accessDialog: any;
    const waitFor = (assertion: () => void) => vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); assertion();
    }, { timeout: 10000 });
    const invalidate = async () => act(async () => {
      changes.get("sessions.treeMem")?.forEach(fn => fn());
      await new Promise(resolve => setTimeout(resolve, 240));
    });
    const connect = async (user: any) => {
      const { HocuspocusProvider } = await import("@hocuspocus/provider"), { default: WebSocket } = await import("ws"), Y = await import("yjs");
      class Socket extends WebSocket { constructor(address: any, protocols: any) { super(address, protocols, {
        origin: config.runtimeUrl, headers: { authorization: `Bearer ${user.token}` }
      }); } }
      const document = new Y.Doc();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native rename collaboration sync timeout")), 10000);
        const provider = new HocuspocusProvider({ url: `${config.runtimeUrl.replace(/^http/, "ws")}/v1/collaboration?${new URLSearchParams({
          protocol: "6", space: user.personalSpaceId, content_space: owner.personalSpaceId, content_document: doc
        })}`, name: doc, document, token: user.token, WebSocketPolyfill: Socket as any,
          onSynced() { clearTimeout(timer); resolve(); },
          onAuthenticationFailed({ reason }) { clearTimeout(timer); reject(new Error(reason)); } });
        sockets.push({ provider, document });
      });
    };
    try {
      expect((await call(owner, `/v1/workbench-state/sessions/${doc}`, { text: "user 临时改名验证", meta: { title: "原会话" } }, "PUT")).status).toBe(200);
      await editFolder("原共享目录");
      const folder = (await call(owner, "/v1/sharing", { kind: "folder", sourceId: folderId, name: "原共享目录", role: "editor", maxClaims: 3 })).value;
      shareIds.push(folder.share.id);
      expect((await call(reader, "/v1/sharing/accept", { token: folder.invitation.token })).status).toBe(200);
      const link = (await call(owner, `/v1/sharing/documents/${doc}/link`, { mode: "restricted" }, "PUT")).value.link;
      const before = (await call(owner, "/v1/sharing?direction=sent")).value.shares.filter((s: any) => shareIds.includes(s.id));
      let bearer = owner.token;
      vi.stubGlobal("fetch", (input: any, init: RequestInit = {}) => {
        const headers = new Headers(init.headers); headers.set("authorization", `Bearer ${bearer}`);
        return native(input, { ...init, headers });
      });
      account.setAccountSession((await call(owner, "/v1/account/me")).value);
      await connect(owner); await connect(reader);
      const { mountEditorParticipants } = await import("../src/ui/workbench/EditorParticipants");
      await act(async () => { participants = mountEditorParticipants(header, { sessionId: () => doc, pollMs: 60000 }); });
      await waitFor(() => expect(header.querySelector("button")).toBeTruthy());
      await act(async () => header.querySelector<HTMLButtonElement>("button")!.click());
      await waitFor(() => expect(document.querySelector(".editor-participant-folder-name")?.textContent).toBe("原共享目录"));
      expect((await call(owner, `/v1/workbench-state/sessions/${doc}`, { meta: { title: "改名后的会话" } }, "PUT")).status).toBe(200);
      await editFolder("共同清单测试"); await invalidate();
      await waitFor(() => expect(document.querySelector(".editor-participant-folder-name")?.textContent).toBe("共同清单测试"));
      expect(document.querySelector(".editor-participants-card")?.getAttribute("role")).toBe("dialog");
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭参与者信息"]')!.click());
      await act(async () => root.render(<SharingDialog api={api} target={{ kind: "document", sourceId: doc, name: "原会话" }}
        onClose={() => {}} onChanged={() => {}} />));
      await waitFor(() => expect(document.querySelector(".sharing-target-name")?.textContent).toBe("改名后的会话"));
      await waitFor(() => expect(document.querySelector(".sharing-inherited")?.textContent).toContain("共同清单测试"));
      const input = document.querySelector<HTMLInputElement>('[aria-label="邮箱或账号 ID"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "unfinished@example.test");
        input.dispatchEvent(new Event("input", { bubbles: true })); input.focus();
      });
      await editFolder("共同清单测试（二次）"); await invalidate();
      await waitFor(() => expect(document.querySelector(".sharing-inherited")?.textContent).toContain("共同清单测试（二次）"));
      expect(input.value).toBe("unfinished@example.test"); expect(document.activeElement).toBe(input);
      expect((await call(guest, "/v1/sharing/preview", { token: folder.invitation.token })).value.share.name).toBe("共同清单测试（二次）");
      expect((await call(guest, "/v1/sharing/accept", { token: folder.invitation.token })).value.share.name).toBe("共同清单测试（二次）");
      expect((await call(reader, `/v1/sharing/links/${link.id}`)).value).toMatchObject({ title: "改名后的会话", role: "editor" });
      expect((await call(owner, `/v1/sharing/documents/${doc}/link`)).value.link).toEqual(link);
      const after = (await call(owner, "/v1/sharing?direction=sent")).value.shares;
      for (const original of before) expect(after.find((s: any) => s.id === original.id)).toMatchObject({
        id: original.id, sourceId: original.sourceId, revision: original.revision, role: original.role
      });
      await act(async () => { root.render(null); participants.dispose(); participants = null; });
      const { openDocumentAccessDialog } = await import("../src/ui/workbench/DocumentAccess");
      await act(async () => { accessDialog = openDocumentAccessDialog(doc); });
      await waitFor(() => expect(document.querySelector(".document-access-dialog .sharing-target-name")?.textContent).toBe("改名后的会话"));
      expect(document.querySelector(".document-access-dialog")?.textContent).not.toContain("Line Numbers");
      await act(async () => { accessDialog.dispose(); accessDialog = null; });
      bearer = reader.token; account.setAccountSession((await call(reader, "/v1/account/me")).value);
      const { mountSharingWorkbench } = await import("../src/ui/workbench/SharingWorkbench");
      const { sideBarRuntime } = await import("../src/ui/workbench/runtime");
      await act(async () => { workbench = mountSharingWorkbench(host); sideBarRuntime.getView("sharing.list")!.component.render(host); });
      await waitFor(() => expect(host.querySelector(`[aria-label="查看 共同清单测试（二次） 的分享详情"]`)).toBeTruthy());
      await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="查看 共同清单测试（二次） 的分享详情"]`)!.click());
      await waitFor(() => expect(host.querySelector(".sharing-folder")?.textContent).toContain("改名后的会话"));
      await editFolder("共同清单测试（三次）"); await invalidate();
      await waitFor(() => expect(host.querySelector(".sharing-inspector h2")?.textContent).toBe("共同清单测试（三次）"));
      expect(host.querySelector(".sharing-folder")?.textContent).toContain("改名后的会话");
      expect((await call(reader, "/v1/sharing/content")).value.received.find((s: any) => s.id === folderId).title).toBe("共同清单测试（三次）");
      writeFileSync(resolve(directory, "acceptance/sharing-rename-native-dom.json"), JSON.stringify({ status: "PASS", checks: [
        "online pinned avatar follows original folder rename",
        "owner dialog reads current document name with folder-only inherited access",
        "open permission dialog refresh preserves recipient draft and focus",
        "invitation preview and acceptance use the latest name",
        "stable link keeps its URL and original editor permission after rename",
        "share IDs, source IDs, revisions and permission defaults unchanged",
        "dedicated access and link dialog reads current title without editor settings",
        "received folder detail refreshes while selected",
        "received session catalog matches the current original tree"
      ] }, null, 2));
    } finally {
      await act(async () => { accessDialog?.dispose(); participants?.dispose(); workbench?.dispose(); root.unmount(); });
      sockets.forEach(({ provider, document }) => { provider.destroy(); document.destroy(); });
      host.remove(); header.remove(); account.setAccountSession(null); vi.unstubAllGlobals(); vi.restoreAllMocks();
      for (const id of shareIds) await call(owner, `/v1/sharing/${encodeURIComponent(id)}/revoke`, {});
      await call(owner, `/v1/workbench-state/sessions/${doc}`, undefined, "DELETE");
      await editFolder();
      const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM account_document_access_requests WHERE link_id IN (SELECT id FROM account_document_links WHERE origin_space_id=$1 AND document_id=$2)", [owner.personalSpaceId, doc]);
        await client.query("DELETE FROM account_document_links WHERE origin_space_id=$1 AND document_id=$2", [owner.personalSpaceId, doc]);
        await client.query("DELETE FROM account_sharing_events WHERE share_id=ANY($1::text[])", [shareIds]);
        await client.query("DELETE FROM account_share_grants WHERE share_id=ANY($1::text[])", [shareIds]);
        await client.query("DELETE FROM account_share_invitations WHERE share_id=ANY($1::text[])", [shareIds]);
        await client.query("DELETE FROM account_shares WHERE id=ANY($1::text[])", [shareIds]);
        await client.query("DELETE FROM account_document_privacy WHERE origin_space_id=$1 AND document_id=$2", [owner.personalSpaceId, doc]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); await pool.end(); }
    }
  }, 45000);
});
