import { createSharingClient } from "../../../packages/runtime-client/src/sharing.mjs";
import { currentAccountSession } from "../../../packages/account-ui/src/client";
import { readWorkbenchRuntimeConfig } from "../../../src/runtime/workbench-runtime-config";
import { registerSharedWorkbenchDocument, workbenchStorage } from "../../../src/runtime/workbench-space";
import "../../../src/ui/workbench/shared-resource-marker.css";

export const isReceivedNode = id => /^shared-(?:document|folder):/.test(String(id || ""));

/** Only rendering reads this projection. All mutations still use the private tree. */
export function createSharedSessionView({ loadTree, getIndex, loadMeta, onChange }) {
  let received = [], sentIds = new Set(), index = new Map(), timer, controller, disposed = false;
  let filter = workbenchStorage.getItem("zion.sessions.sharingFilter") || "all";
  if (!["all", "sent", "received"].includes(filter)) filter = "all";
  let loading = false, error = "";
  const project = node => {
    const sharing = { received: true, providerName: node.providerName, shareId: node.shareId, role: node.role };
    if (node.type === "session") {
      const document = registerSharedWorkbenchDocument({ originSpaceId: node.originSpaceId, documentId: node.id,
        role: node.role, title: node.title, providerName: node.providerName });
      const result = { ...node, id: document.localId, sharing };
      index.set(result.id, result); return result;
    }
    return { ...node, id: `shared-folder:${encodeURIComponent(node.originSpaceId)}:${encodeURIComponent(node.id)}`,
      sharing, children: (node.children || []).map(project) };
  };
  const pruneSent = node => {
    if (!node) return null;
    if (node.type === "session") return sentIds.has(node.id) ? node : null;
    const children = (node.children || []).map(pruneSent).filter(Boolean);
    return children.length || sentIds.has(node.id) ? { ...node, children } : null;
  };
  const view = {
    get filter() { return filter; },
    get loading() { return loading; },
    get error() { return error; },
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
      onChange?.();
    },
    tree() {
      const own = loadTree() || { id: "root", type: "folder", children: [] };
      if (filter === "received") return { ...own, children: received };
      if (filter === "sent") return pruneSent(own) || { ...own, children: [] };
      return { ...own, children: [...(own.children || []), ...received] };
    },
    index() {
      const own = getIndex() || [];
      if (filter === "received") return [...index.values()];
      if (filter === "sent") return own.filter(node => sentIds.has(node.id));
      return [...own, ...index.values()];
    },
    meta(id) { return index.get(id) || loadMeta(id); },
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
          loading = false; onChange?.();
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
