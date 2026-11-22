import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAccountSession } from "../packages/account-ui/src/client";
import { createSharedSessionView } from "../extensions/dev.session-manager/model/shared-view.js";
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
});
