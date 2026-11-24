import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAccountSession } from "../packages/account-ui/src/client";
import { createSharedSessionView } from "../extensions/dev.session-manager/model/shared-view.js";
import { createSharedSessionMover } from "../extensions/dev.session-manager/model/shared-move.js";
import { createSessionsListRendererFactory } from "../extensions/dev.session-manager/ui/list-renderer.js";
import { createSessionsSidebarViewManager } from "../extensions/dev.session-manager/ui/sidebar-view.js";
import { sharedWorkbenchDocument } from "../src/runtime/workbench-space";

let instance: any, subscription: any, view: any, manager: any, host: HTMLElement;
let values: Map<string, any>, commands: any, ownMeta: any, move: any, response: any;
const own = { id: "root", type: "folder", children: [
  { id: "mine", type: "folder", title: "自己的文件夹", children: [
    { id: "same", type: "session", title: "自己的会话" }, { id: "sent", type: "session", title: "已分享会话" }
  ] }
] };
beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear(); document.body.innerHTML = "";
  localStorage.setItem("zion.runtime.baseUrl", location.origin);
  setAccountSession({ user: { id: "me" }, space: { id: "mine", kind: "personal" }, sessionId: "login", scopes: ["runtime.write"] } as any);
  values = new Map(); commands = vi.fn(() => true); ownMeta = vi.fn(id => ({ id, title: id === "same" ? "自己的会话" : "已分享会话" })); move = vi.fn();
  (window as any).zion = { state: { get: (key: string) => values.get(key), set: (key: string, value: any) => values.set(key, value),
    onDidChange: () => ({ dispose() {} }) }, commands: { executeCommand: commands, list: () => ["zion.sharing.create"] },
    events: { on: () => ({ dispose() {} }) } };
  response = { received: [{ id: "remote-folder", type: "folder", title: "收到的目录", originSpaceId: "owner", providerName: "Alice", role: "viewer", shareId: "grant",
    children: [{ id: "nested", type: "folder", title: "收到的子目录", originSpaceId: "owner", providerName: "Alice", role: "viewer", shareId: "grant",
      children: [{ id: "same", type: "session", title: "原始共享会话", originSpaceId: "owner", providerName: "Alice", role: "editor", shareId: "grant" }] }] }],
    sentIds: ["sent"] };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(response))));
  const open = new Set(["root", "mine"]);
  view = createSharedSessionView({ loadTree: () => own, getIndex: () => own.children[0].children, loadMeta: ownMeta,
    onChange: () => manager?.refreshIfOpen() });
  manager = createSessionsSidebarViewManager({ zion: (window as any).zion, sharingView: view,
    getIndex: () => view.index(), loadMeta: (id: string) => view.meta(id),
    openAncestors: (id: string) => view.openAncestors(id, (id: string) => open.add(id)),
    createSessionsListRenderer: createSessionsListRendererFactory({ loadTree: () => view.tree(), getIndex: () => view.index(),
      loadMeta: (id: string) => view.meta(id), truncate: (s: string) => s, fmtTime: String, now: Date.now,
      getSelection: () => [], setSelection: vi.fn(), clearSelection: vi.fn(), isSelected: () => false,
      toggleSelection: vi.fn(), getLastSelectedId: () => null, setLastSelectedId: vi.fn(),
      isFolderOpen: (id: string) => open.has(id), setFolderOpen: (id: string, value: boolean) => value ? open.add(id) : open.delete(id),
      moveNode: move, buildSessionURL: (id: string) => `/?session=${encodeURIComponent(id)}` }) });
  subscription = view.start((window as any).zion);
  await view.refresh();
  host = document.createElement("div"); document.body.appendChild(host); instance = manager.mountInto(host); instance.render();
});
afterEach(() => { subscription?.dispose(); instance?.dispose(); manager = null; setAccountSession(null); vi.unstubAllGlobals(); });
function filter(label: string) { [...host.querySelectorAll<HTMLButtonElement>(".session-sharing-filters button")].find(button => button.textContent === label)!.click(); }
function remoteRow() { return host.querySelector<HTMLElement>('[data-session-id^="shared-document:"]')!; }
function openFolders() {
  for (const title of ["收到的目录", "收到的子目录"]) [...host.querySelectorAll<HTMLElement>(".is-folder")].find(row => row.querySelector(".zion-session-folder-name")?.textContent === title)!.click();
}
describe("received content in the native session list", () => {
  it("allows private sessions to drop into editable received folders and rejects outward, viewer and private-folder drops", async () => {
    const enable = (node: any) => { node.role = "editor"; node.folderShareId = "folder-grant"; node.children?.forEach(enable); };
    response.received.forEach(enable);
    await view.refresh(); instance.setViewMode("list"); openFolders();
    move.mockResolvedValue(true);
    const drop = (target: HTMLElement, id: string, type = "session") => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { getData: (format: string) =>
        format === "application/zion-nodes" ? JSON.stringify({ items: [{ id, type }] }) : "" } });
      target.dispatchEvent(event);
    };
    const shared = host.querySelector<HTMLElement>('[data-folder-id="shared-folder:owner:nested"]')!;
    drop(shared, "same");
    await vi.waitFor(() => expect(move).toHaveBeenCalledWith("same", "shared-folder:owner:nested"));
    move.mockClear();
    drop(host.querySelector<HTMLElement>('[data-folder-id="mine"]')!, "shared-document:owner:same");
    drop(shared, "mine", "folder");
    drop(host.querySelector<HTMLElement>(".zion-sessions-root-drop-target")!, "shared-document:owner:same");
    expect(move).not.toHaveBeenCalled();
    response.received[0].children[0].role = "viewer";
    await view.refresh();
    drop(host.querySelector<HTMLElement>('[data-folder-id="shared-folder:owner:nested"]')!, "same");
    expect(move).not.toHaveBeenCalled();
  });
  it("sends inward import to the granted destination with the private source ID and returns the received identity", async () => {
    response.received[0].role = "editor"; response.received[0].folderShareId = "folder-grant";
    await view.refresh();
    vi.mocked(fetch).mockImplementation(async (url: any, options: any) => {
      if (String(url).endsWith("/folder-operations")) {
        expect(JSON.parse(options.body)).toMatchObject({ action: "importDocument", id: "remote-folder",
          sourceDocumentId: "same", sourceRevision: 7 });
        return new Response(JSON.stringify({ ok: true, id: "moved", type: "session", title: "迁入会话" }));
      }
      return new Response(JSON.stringify(response));
    });
    expect(await view.mutate("shared-folder:owner:remote-folder", {
      action: "importDocument", sourceDocumentId: "same", sourceRevision: 7
    })).toBe("shared-document:owner:moved");
    expect(sharedWorkbenchDocument("shared-document:owner:moved")).toMatchObject({
      originSpaceId: "owner", documentId: "moved", role: "editor"
    });
  });
  it("flushes both content and autosave before import, deduplicates drags, refreshes private content and reopens the moved session", async () => {
    const order: string[] = [];
    values.set("sessions.currentId", "same");
    commands.mockImplementation(async (name: string) => { order.push(name); return true; });
    const mutate = vi.spyOn(view, "mutate").mockImplementation(async () => { order.push("import"); return "shared-document:owner:moved"; });
    const refreshOwn = vi.fn(async () => { order.push("refresh"); });
    const mover = createSharedSessionMover({ zion: (window as any).zion, view, moveOwn: move,
      isOwnSession: (id: string) => id === "same", refreshOwn, getRevision: () => 7 });
    const one = mover("same", "shared-folder:owner:remote-folder"), two = mover("same", "shared-folder:owner:remote-folder");
    expect(one).toBe(two); expect(await one).toBe(true);
    expect(order).toEqual(["zion.sessions.flushRunInput", "zion.sessions.flushPendingSave", "import", "refresh", "zion.sessions.switch"]);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith("shared-folder:owner:remote-folder", { action: "importDocument", sourceDocumentId: "same", sourceRevision: 7 });
    expect(commands).toHaveBeenLastCalledWith("zion.sessions.switch", {
      id: "shared-document:owner:moved", forceReload: true, skipPersistPrevious: true
    });
    expect(mover("shared-document:owner:same", "mine")).toBe(false);
    expect(mover("mine", "shared-folder:owner:remote-folder")).toBe(false);
    expect(move).not.toHaveBeenCalled();
  });
  it("retains the private UI and surfaces a save failure before sending an import", async () => {
    commands.mockResolvedValue(false);
    const mutate = vi.spyOn(view, "mutate"), refreshOwn = vi.fn();
    const mover = createSharedSessionMover({ zion: (window as any).zion, view, moveOwn: move,
      isOwnSession: () => true, refreshOwn, getRevision: () => 7 });
    expect(await mover("same", "shared-folder:owner:remote-folder")).toBe(false);
    expect(mutate).not.toHaveBeenCalled(); expect(refreshOwn).not.toHaveBeenCalled();
    expect(view.error).toContain("尚未保存成功"); expect(host.textContent).toContain("尚未保存成功");
  });
  it("preserves received hierarchy, qualifies colliding IDs and filters all / sent / received without altering the private tree", () => {
    const before = JSON.stringify(own);
    expect(host.textContent).toContain("自己的会话"); expect(host.textContent).toContain("收到的目录");
    filter("收到的"); expect(host.textContent).not.toContain("自己的会话"); openFolders();
    expect(remoteRow().textContent).toContain("原始共享会话");
    expect(sharedWorkbenchDocument(remoteRow().dataset.sessionId!)).toMatchObject({ documentId: "same", originSpaceId: "owner", role: "editor" });
    expect(ownMeta.mock.calls.every(([id]: string[]) => !id.startsWith("shared-"))).toBe(true);
    expect(remoteRow().querySelector(".shared-resource-marker")?.getAttribute("title")).toContain("Alice");
    filter("我分享的"); expect(host.textContent).toContain("已分享会话"); expect(host.textContent).not.toContain("原始共享会话");
    filter("全部"); expect(host.querySelectorAll(".is-session")).toHaveLength(3);
    expect(JSON.stringify(own)).toBe(before);
  });
  it("opens original documents but excludes received rows from rename/delete/drag and parent selection", async () => {
    filter("收到的"); openFolders(); const row = remoteRow(), id = row.dataset.sessionId!;
    expect(row.draggable).toBe(false);
    row.click(); await Promise.resolve();
    expect(commands).toHaveBeenCalledWith("zion.sessions.switch", id);
    commands.mockClear();
    for (const key of ["r", "c", "Delete", "Backspace"]) row.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    expect(commands).not.toHaveBeenCalled();
    expect(values.get("sessions.selectedFolderId")).toBeUndefined();
    expect(row.querySelector(".session-row-menu")?.textContent).not.toMatch(/Rename|Delete|Clone|分享会话/);
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { getData: () => JSON.stringify({ items: [{ id, type: "session" }] }) } });
    host.querySelector(".zion-sessions-list > div")!.dispatchEvent(event);
    expect(move).not.toHaveBeenCalled();
  });
  it("removes revoked content after refresh and reveals nested received sessions", async () => {
    const id = view.index().find((node: any) => node.sharing)?.id;
    instance.revealSession(id, { openAncestors: true });
    expect(remoteRow()).toBeTruthy();
    response = { received: [], sentIds: [] }; await view.refresh();
    expect(host.querySelector('[data-sharing="received"]')).toBeNull();
    expect(host.textContent).toContain("自己的会话");
  });
  it("exposes native editor folder controls and awaits folder creation before inline rename", async () => {
    const enable = (node: any) => {
      node.role = "editor"; node.folderShareId = "folder-grant";
      node.children?.forEach(enable);
    };
    response.received.forEach(enable);
    await view.refresh(); filter("收到的"); instance.render();
    const id = "shared-folder:owner:remote-folder";
    expect(view.entry(id).sharing.editable).toBe(true);
    const row = host.querySelector<HTMLElement>('[data-folder-id="shared-folder:owner:remote-folder"]')!;
    expect(row.draggable).toBe(true);
    const menu = row.querySelector(".session-row-menu")!;
    expect(menu.textContent).toMatch(/New Session/);
    expect(menu.textContent).toMatch(/Rename Folder/);
    expect(menu.textContent).toMatch(/Delete Folder/);
    expect(menu.textContent).not.toMatch(/Export Folder/);
    expect([...menu.children].some(item => item.textContent === "分享")).toBe(false);
    const before = JSON.stringify(own);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url: any, options: any) => {
      if (String(url).endsWith("/folder-operations")) {
        const input = JSON.parse(options.body);
        expect(input).toMatchObject({ action: "createFolder", id: "remote-folder", title: "New Folder" });
        expect(input.operationId).toBeTruthy();
        response.received[0].children.push({ id: "created-folder", type: "folder", title: "New Folder", children: [],
          originSpaceId: "owner", role: "editor", folderShareId: "folder-grant", shareId: "folder-grant" });
        return new Response(JSON.stringify({ ok: true, id: "created-folder", type: "folder", title: "New Folder" }));
      }
      return new Response(JSON.stringify(response));
    });
    commands.mockImplementation((name: string, input: any) =>
      name === "zion.sessions.newFolder" ? view.mutate(input.parentId, { action: "createFolder", title: "New Folder" }) : true);
    [...menu.children].find(item => item.textContent === "New Folder")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(host.querySelector('input[data-zion-inline-edit="1"]')).toBeTruthy());
    expect(host.querySelector('input[data-zion-inline-edit="1"]')?.closest(".zion-session-row")?.getAttribute("data-folder-id"))
      .toBe("shared-folder:owner:created-folder");
    expect(host.textContent).not.toContain("[object Promise]");
    expect(JSON.stringify(own)).toBe(before);
  });
  it("routes editor session rename/delete while rejecting viewer mutations before HTTP", async () => {
    await expect(view.mutate("shared-folder:owner:remote-folder", { action: "rename", title: "forbidden" })).rejects.toThrow("编辑权限");
    response.received[0].children[0].children[0].folderShareId = "editor-folder";
    await view.refresh(); filter("收到的"); instance.setViewMode("list"); openFolders();
    expect(view.entry("shared-document:owner:same").sharing).toMatchObject({ editable: true });
    let row = remoteRow();
    expect(row.draggable).toBe(true);
    expect(row.querySelector(".session-row-menu")?.textContent).toMatch(/Rename/);
    expect(row.querySelector(".session-row-menu")?.textContent).toMatch(/Delete/);
    expect(row.querySelector(".session-row-menu")?.textContent).not.toMatch(/Clone/);
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
    expect(host.querySelector('input[data-zion-inline-edit="1"]')).toBeTruthy();
    const input = host.querySelector<HTMLInputElement>('input[data-zion-inline-edit="1"]')!;
    input.value = "修改后的会话";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(commands).toHaveBeenCalledWith("zion.sessions.rename", {
      id: "shared-document:owner:same", title: "修改后的会话"
    }));
    row = remoteRow(); commands.mockClear();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
    expect(commands).not.toHaveBeenCalled();
  });
  it("sends original IDs and the observed parent for shared moves, and shows revoked-operation errors", async () => {
    const enable = (node: any) => { node.role = "editor"; node.folderShareId = "folder-grant"; node.children?.forEach(enable); };
    response.received.forEach(enable);
    await view.refresh(); filter("收到的"); instance.setViewMode("list"); openFolders();
    const requests: any[] = [];
    vi.mocked(fetch).mockImplementation(async (url: any, options: any) => {
      if (String(url).endsWith("/folder-operations")) {
        requests.push({ url: String(url), body: JSON.parse(options.body) });
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response(JSON.stringify(response));
    });
    await view.mutate("shared-document:owner:same", { action: "move", parentId: "shared-folder:owner:remote-folder" });
    expect(requests[0]).toMatchObject({ url: `${location.origin}/v1/sharing/folder-grant/folder-operations`,
      body: { id: "same", parentId: "remote-folder", expectedParentId: "nested", action: "move" } });
    vi.mocked(fetch).mockImplementation(async (url: any) => {
      if (String(url).endsWith("/folder-operations")) {
        response = { received: [], sentIds: [] };
        return new Response(JSON.stringify({ code: "share_access_revoked", error: "分享已失效" }), { status: 403 });
      }
      return new Response(JSON.stringify(response));
    });
    await expect(view.mutate("shared-document:owner:same", { action: "delete" })).rejects.toThrow("分享已失效");
    expect(view.error).toBe("分享已失效");
    expect(view.entry("shared-document:owner:same")).toBeUndefined();
    expect(host.textContent).toContain("分享已失效");
  });
});
