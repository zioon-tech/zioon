import { createSharingClient } from "../../../packages/runtime-client/src/sharing.mjs";
import { createSpacesClient } from "../../../packages/runtime-client/src/spaces.mjs";
import { currentAccountSession } from "../../../packages/account-ui/src/client";
import { isSharedWorkbenchDocument, sharedWorkbenchDocument } from "../../runtime/workbench-space";
import { readWorkbenchRuntimeConfig } from "../../runtime/workbench-runtime-config";
import { subscribeSharingContentChanges } from "./sharing-refresh";
import { createParticipantsHeader, type HeaderParticipant } from "./editor-participants-view";
export { participantInitial } from "./editor-participants-view";

type Subscription = { dispose(): void } | (() => void) | void;
type MountOptions = {
  sessionId(): string | null | undefined;
  subscribe?(refresh: () => void): Subscription[];
  pollMs?: number;
};
export function mountEditorParticipants(header: HTMLElement, options: MountOptions) {
  const view = createParticipantsHeader(header);
  let disposed = false, key = "", people: HeaderParticipant[] = [], currentId = "", canManage = false;
  let scope = { localId: "", documentId: "", originSpaceId: "", baseUrl: "", accountSpaceId: "" };
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const render = () => {
    const captured = { ...scope }, capturedKey = key;
    view.render({ scopeKey: key, people, canManage }, {
      onUpdate: async (person, role) => {
        if (disposed || key !== capturedKey) throw new Error("会话已切换，请重新打开参与者信息");
        await createSharingClient({ baseUrl: captured.baseUrl, headers: { "x-zioon-space-id": captured.accountSpaceId } })
          .updateDocumentCollaborator(captured.documentId, person.id, role);
        window.zion?.events?.emit?.("sharing/changed", {});
        if (!disposed && key === capturedKey) await refresh();
      }, onManage: grant => {
        if (grant) void window.zion?.commands?.executeCommand?.("zion.sharing.create",
          { kind: "folder", sourceId: grant.sourceId, name: grant.name, shareId: grant.shareId });
        else void window.zion?.commands?.executeCommand?.("zion.sharing.manage", { sourceId: captured.localId });
      } });
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!disposed && document.visibilityState !== "hidden") timer = setTimeout(refresh, options.pollMs ?? 5000);
  };
  async function refresh() {
    clearTimeout(debounce); clearTimeout(timer);
    if (disposed) return;
    const account = currentAccountSession();
    currentId = options.sessionId() || "";
    const shared = sharedWorkbenchDocument(currentId);
    const documentId = shared?.documentId || currentId;
    const originSpaceId = shared?.originSpaceId || account?.space.id || "";
    const baseUrl = readWorkbenchRuntimeConfig().baseUrl;
    scope = { localId: currentId, documentId, originSpaceId, baseUrl, accountSpaceId: account?.space.id || "" };
    const nextKey = `${account?.user.id}:${account?.sessionId}:${baseUrl}:${originSpaceId}:${documentId}`;
    if (key !== nextKey) {
      controller?.abort(); controller = null; key = nextKey; people = []; canManage = false; render();
    }
    if (!account || !documentId || documentId.startsWith("file:") || isSharedWorkbenchDocument(currentId) && !shared) return;
    if (document.visibilityState === "hidden") {
      controller?.abort(); controller = null;
      people = []; render(); return;
    }
    if (controller) return;
    const request = new AbortController(); controller = request;
    try {
      if (account.space.kind === "team") {
        const result = await createSpacesClient({ baseUrl, spaceId: originSpaceId, signal: request.signal }).document(documentId, "presence");
        if (disposed || request.signal.aborted || key !== nextKey || options.sessionId() !== currentId) return;
        canManage = false;
        people = (result.visitors || []).filter((person: any) => person.online === true && person.id !== result.selfVisitorId)
          .map((person: any) => ({ ...person, inherited: false, visitor: true }));
        render(); return;
      }
      const result = await createSharingClient({ baseUrl, signal: request.signal,
        headers: { "x-zioon-space-id": account.space.id } }).participants(documentId, originSpaceId);
      if (disposed || request.signal.aborted || key !== nextKey || options.sessionId() !== currentId) return;
      if (result.documentId !== documentId || result.originSpaceId !== originSpaceId || result.selfId !== account.user.id) {
        throw new Error("Participant scope mismatch");
      }
      canManage = result.participants.find(person => person.id === account.user.id)?.role === "owner";
      people = [...new Map((result.visitors || result.participants).filter(person => person.id !== account.user.id &&
        person.id !== result.selfVisitorId && person.online === true)
        .map(person => [person.id, person])).values()].sort((a, b) =>
        Number(b.online === true) - Number(a.online === true) || a.name.localeCompare(b.name, "zh-CN"));
      render();
    } catch (error: any) {
      if (disposed || request.signal.aborted || key !== nextKey) return;
      people = [];
      render();
    } finally {
      if (controller === request) { controller = null; schedule(); }
    }
  }
  const invalidate = () => {
    if (!disposed) { clearTimeout(debounce); debounce = setTimeout(refresh, 200); }
  };
  const presenceChanged = (payload: { sessionId?: string }) => { if (payload?.sessionId === currentId) invalidate(); };
  const subscriptions = [
    ...(options.subscribe?.(() => void refresh()) || []),
    subscribeSharingContentChanges(invalidate),
    window.zion?.events?.on?.("collaboration/presenceChanged", presenceChanged)
  ];
  window.addEventListener("zion-account-changed", refresh);
  document.addEventListener("visibilitychange", refresh);
  const dispose = () => {
    if (disposed) return;
    disposed = true; controller?.abort(); clearTimeout(timer); clearTimeout(debounce);
    window.removeEventListener("zion-account-changed", refresh);
    document.removeEventListener("visibilitychange", refresh);
    window.removeEventListener("pagehide", dispose);
    for (const subscription of subscriptions) {
      if (typeof subscription === "function") subscription(); else subscription?.dispose();
    }
    view.dispose();
  };
  window.addEventListener("pagehide", dispose);
  void refresh();
  return { dispose, refresh };
}
