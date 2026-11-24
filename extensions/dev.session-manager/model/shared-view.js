import { createSharingClient } from "../../../packages/runtime-client/src/sharing.mjs";
import { currentAccountSession } from "../../../packages/account-ui/src/client";
import { readWorkbenchRuntimeConfig } from "../../../src/runtime/workbench-runtime-config";
import { registerSharedWorkbenchDocument, sharedWorkbenchDocument, workbenchStorage } from "../../../src/runtime/workbench-space";
import "../../../src/ui/workbench/shared-resource-marker.css";

export const isReceivedNode = id => /^shared-(?:document|folder):/.test(String(id || ""));

/** Received operations use the original owner's authorized folder endpoint. */
export function createSharedSessionView({ loadTree, getIndex, loadMeta, onChange }) {
  let received = [], sentIds = new Set(), index = new Map(), timer, controller, disposed = false;
  let revision = 0;
  let filter = workbenchStorage.getItem("zion.sessions.sharingFilter") || "all";
  if (!["all", "sent", "received"].includes(filter)) filter = "all";
  let loading = false, error = "";
  const moving = new Map();
  const project = node => {
    const sharing = { received: true, providerName: node.providerName, shareId: node.shareId, role: node.role,
      folderShareId: node.folderShareId, editable: node.role === "editor" && !!node.folderShareId };
    if (node.type === "session") {
      const document = registerSharedWorkbenchDocument({ originSpaceId: node.originSpaceId, documentId: node.id,
        role: node.role, title: node.title, providerName: node.providerName });
      const result = { ...node, id: document.localId, sharing };
      index.set(result.id, result); return result;
    }
    const result = { ...node, id: `shared-folder:${encodeURIComponent(node.originSpaceId)}:${encodeURIComponent(node.id)}`,
      sharing, children: (node.children || []).map(project) };
    index.set(result.id, result); return result;
  };
  const pruneSent = node => {
    if (!node) return null;
    if (node.type === "session") return sentIds.has(node.id) ? node : null;
    const children = (node.children || []).map(pruneSent).filter(Boolean);
    return children.length || sentIds.has(node.id) ? { ...node, children } : null;
  };
  const view = {
    get revision() { return revision; },
    get filter() { return filter; },
    get loading() { return loading; },
    get error() { return error; },
    get moving() { return moving; },
    setMoving(id, parent, active) {
      if (active) { moving.set(id, parent); error = ""; }
      else moving.delete(id);
      revision++; onChange?.();
    },
    entry(id) { return index.get(id); },
    openAncestors(id, setOpen) {
      const walk = (node, parents) => {
        if (node.id === id) { parents.forEach(parent => setOpen(parent.id, true)); return true; }
        return (node.children || []).some(child => walk(child, [...parents, node]));
      };
      return received.some(node => walk(node, []));
    },
    setFilter(value) {
      if (!["all", "sent", "received"].includes(value)) return;
      filter = value; workbenchStorage.setItem("zion.sessions.sharingFilter", value);
      revision++; onChange?.();
    },
    tree() {
      const own = loadTree() || { id: "root", type: "folder", children: [] };
      if (filter === "received") return { ...own, children: received };
      if (filter === "sent") return pruneSent(own) || { ...own, children: [] };
      return { ...own, children: [...(own.children || []), ...received] };
    },
    index() {
      const own = getIndex() || [];
      if (filter === "received") return [...index.values()].filter(node => node.type === "session");
      if (filter === "sent") return own.filter(node => sentIds.has(node.id));
      return [...own, ...[...index.values()].filter(node => node.type === "session")];
    },
    meta(id) { return index.get(id) || loadMeta(id); },
    reportError(cause) {
      error = cause?.message || "共享文件夹操作失败，请重试";
      revision++; onChange?.();
    },
    async mutate(id, input) {
      const entry = index.get(id);
      if (!entry?.sharing?.editable) throw new Error("此操作需要文件夹编辑权限");
      const account = currentAccountSession();
      if (!account) throw new Error("请先登录");
      const original = node => ({ id: node.type === "folder"
        ? decodeURIComponent(node.id.split(":").slice(2).join(":"))
        : sharedWorkbenchDocument(node.id)?.documentId,
        type: node.type, ...(node.children ? { children: node.children.map(original) } : {}) });
      const resolveId = localId => {
        const node = index.get(localId);
        if (!node || node.originSpaceId !== entry.originSpaceId) throw new Error("只能在同一共享文件夹内移动");
        return original(node).id;
      };
      const body = { ...input, id: original(entry).id, operationId: crypto.randomUUID(),
        ...(input.action === "rename" ? { expectedTitle: entry.title } : {}),
        ...(input.action === "delete" && entry.type === "folder" ? { expectedTree: original(entry) } : {}),
        ...(input.parentId ? { parentId: resolveId(input.parentId) } : {}) };
      if (input.action === "move") {
        const parentOf = node => {
          if ((node.children || []).some(child => child.id === id)) return node;
          for (const child of node.children || []) { const parent = parentOf(child); if (parent) return parent; }
          return null;
        };
        const parent = received.map(parentOf).find(Boolean);
        if (parent) body.expectedParentId = original(parent).id;
      }
      try {
        const result = await createSharingClient({ baseUrl: readWorkbenchRuntimeConfig().baseUrl,
          headers: { "x-zioon-space-id": account.space.id } }).mutateFolder(entry.sharing.folderShareId, body);
        await view.refresh();
        if (result.type === "folder") return `shared-folder:${encodeURIComponent(entry.originSpaceId)}:${encodeURIComponent(result.id)}`;
        if (result.type === "session") return registerSharedWorkbenchDocument({ originSpaceId: entry.originSpaceId,
          documentId: result.id, role: "editor", title: result.title, providerName: entry.sharing.providerName }).localId;
        return result;
      } catch (cause) {
        await view.refresh();
        view.reportError(cause);
        throw cause;
      }
    },
    async refresh() {
      controller?.abort(); clearTimeout(timer);
      const account = currentAccountSession();
      if (!account || disposed) return;
      const request = new AbortController(); controller = request; loading = true;
      try {
        const result = await createSharingClient({ baseUrl: readWorkbenchRuntimeConfig().baseUrl,
          headers: { "x-zioon-space-id": account.space.id }, signal: request.signal }).content();
        if (disposed || request.signal.aborted) return;
        index = new Map(); received = result.received.map(project); sentIds = new Set(result.sentIds); error = "";
      } catch (cause) {
        if (disposed || request.signal.aborted) return;
        received = []; index = new Map(); sentIds.clear();
        error = "分享列表暂不可用";
      } finally {
        if (!disposed && !request.signal.aborted) {
          loading = false; revision++; onChange?.();
          timer = setTimeout(() => { if (document.visibilityState !== "hidden") void view.refresh(); }, 15000);
        }
      }
    },
    start(zion) {
      disposed = false;
      const saved = workbenchStorage.getItem("zion.sessions.sharingFilter");
      filter = ["all", "sent", "received"].includes(saved) ? saved : "all";
      const refresh = () => { void view.refresh(); };
      const visible = () => {
        if (document.visibilityState !== "hidden") refresh();
        else { clearTimeout(timer); controller?.abort(); }
      };
      const subscriptions = ["sharing/changed", "sharing/documentAccessChanged"].map(topic => zion?.events?.on?.(topic, refresh));
      document.addEventListener("visibilitychange", visible);
      return { dispose() {
        disposed = true; clearTimeout(timer); controller?.abort();
        document.removeEventListener("visibilitychange", visible);
        subscriptions.forEach(subscription => subscription?.dispose());
      } };
    }
  };
  return view;
}
