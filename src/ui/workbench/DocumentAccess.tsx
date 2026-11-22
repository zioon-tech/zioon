import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createSharingClient, type DocumentParticipant } from "../../../packages/runtime-client/src/sharing.mjs";
import { currentAccountSession } from "../../../packages/account-ui/src/client";
import { currentWorkbenchDocument, sharedWorkbenchDocument } from "../../runtime/workbench-space";
import { readWorkbenchRuntimeConfig } from "../../runtime/workbench-runtime-config";
import "./sharing-workbench.css";
import { DocumentLinkControls } from "./DocumentLinkControls";
import { SharingModal } from "./SharingDialog";
import { subscribeSharingContentChanges } from "./sharing-refresh";

function DocumentAccess({ sessionId, onNavigate, onTitle }: { sessionId: string; onNavigate?(): void; onTitle?(title: string): void }) {
  const [people, setPeople] = useState<DocumentParticipant[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<DocumentParticipant | null>(null);
  const [privateDocument, setPrivateDocument] = useState(false);
  const account = currentAccountSession();
  const shared = sharedWorkbenchDocument(sessionId);
  const documentId = shared?.documentId || sessionId;
  const api = useMemo(() => createSharingClient({ baseUrl: readWorkbenchRuntimeConfig().baseUrl,
    headers: account ? { "x-zioon-space-id": account.space.id } : {} }), [account?.sessionId]);
  useEffect(() => {
    if (!account || !documentId || documentId.startsWith("file:")) { setLoading(false); return; }
    let disposed = false, timer: ReturnType<typeof setTimeout>, debounce: ReturnType<typeof setTimeout>, request: AbortController | null = null;
    const refresh = async () => {
      clearTimeout(timer); request?.abort(); request = new AbortController();
      try {
        const result = await createSharingClient({ baseUrl: readWorkbenchRuntimeConfig().baseUrl,
          headers: { "x-zioon-space-id": account.space.id }, signal: request.signal })
          .participants(documentId, shared?.originSpaceId || account.space.id);
        if (!disposed) {
          setPeople(result.participants); setError("");
          if (result.title) onTitle?.(result.title);
          if (result.participants.find(person => person.id === account.user.id)?.role === "owner") {
            setPrivateDocument((await api.documentPrivacy(documentId)).private);
          }
        }
      } catch (cause) {
        if (!disposed) { setPeople([]); setError(cause instanceof Error ? cause.message : String(cause)); }
      } finally {
        if (!disposed) { setLoading(false); timer = setTimeout(refresh, 5000); }
      }
    };
    const change = subscribeSharingContentChanges(() => { clearTimeout(debounce); debounce = setTimeout(refresh, 200); });
    void refresh();
    return () => { disposed = true; clearTimeout(timer); clearTimeout(debounce); request?.abort(); change(); };
  }, [sessionId, account?.sessionId]);
  const owner = people.find(person => person.id === account?.user.id)?.role === "owner";
  const update = async (person: DocumentParticipant, role: "viewer" | "editor" | "removed") => {
    if (busy || !owner) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const api = createSharingClient({ baseUrl: readWorkbenchRuntimeConfig().baseUrl,
        headers: { "x-zioon-space-id": account!.space.id } });
      const result = await api.updateDocumentCollaborator(documentId, person.id, role);
      setPeople((await api.participants(documentId, account!.space.id)).participants);
      setConfirm(null); setNotice(role === "removed" && result.inherited ? "会话授权已移除，文件夹继承权限仍保留。" : "权限已更新。");
      window.zion?.events?.emit?.("sharing/changed", {});
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  if (!account || !documentId || documentId.startsWith("file:")) return null;
  return <section className="document-access" aria-label="会话访问权限">
    <h3>会话访问权限</h3>
    {loading ? <p role="status">正在读取权限…</p> : <>
      {error && <p role="alert">{error}</p>}
      <table><thead><tr><th>用户</th><th>阅读</th><th>编辑</th>{owner && <th>权限</th>}</tr></thead>
        <tbody>{people.map(person => <tr key={person.id}>
          <td><strong>{person.name || "未命名用户"}{person.id === account.user.id ? "（你）" : ""}</strong>
            <small>{person.role === "owner" ? "所有者" : person.inherited ? "文件夹授权" : "会话授权"}
              {" · "}{person.online === true ? "在此文档中" : person.online === false ? "未在此文档中" : "在线状态暂不可用"}</small></td>
          <td>允许</td><td>{person.role === "viewer" ? "—" : "允许"}</td>
          {owner && <td>{person.role === "owner" ? "所有者" : <select aria-label={`${person.name} 的权限`}
            disabled={busy || !(person.grants?.some(grant => grant.kind === "document") || !person.inherited)}
            value={person.role} onChange={event => {
              const role = event.target.value as "viewer" | "editor" | "removed";
              if (role === "removed") setConfirm(person); else void update(person, role);
            }}><option value="viewer">可查看</option><option value="editor">可编辑</option>
            <option value="removed">{person.grants?.some(grant => grant.kind === "folder") ? "移除会话授权" : "移除"}</option></select>}</td>}
        </tr>)}</tbody>
      </table>
      {owner && <div className="document-access-actions">
        <button disabled={busy} onClick={() => {
          onNavigate?.();
          void window.zion?.commands?.executeCommand?.("zion.sharing.create",
            { kind: "document", sourceId: sessionId, name: documentId, managePrivacy: true });
        }}>会话隐私</button>
        <button disabled={busy} onClick={() => {
          onNavigate?.();
          void window.zion?.commands?.executeCommand?.("zion.sharing.manage", { sourceId: sessionId });
        }}>管理分享</button>
      </div>}
      {owner && <DocumentLinkControls api={api} documentId={documentId} privateDocument={privateDocument}
        prepare={async () => { await window.zion?.commands?.executeCommand?.("zion.sessions.flushRunInput", sessionId); }}
        onChanged={() => window.zion?.events?.emit?.("sharing/changed", {})} />}
      {confirm && <div role="alert" className="document-access-actions">
        <span>移除 {confirm.name} 的会话授权？{confirm.grants?.some(grant => grant.kind === "folder") ? "文件夹继承权限会保留。" : ""}</span>
        <button disabled={busy} onClick={() => setConfirm(null)}>取消</button>
        <button disabled={busy} onClick={() => void update(confirm, "removed")}>确认移除</button>
      </div>}
      {notice && <p role="status">{notice}</p>}
    </>}
  </section>;
}

export function mountDocumentAccess(container: HTMLElement, sessionId = currentWorkbenchDocument()) {
  const host = document.createElement("div"); container.appendChild(host);
  const root = createRoot(host); root.render(<DocumentAccess sessionId={sessionId} />);
  let disposed = false;
  return { dispose() { if (disposed) return; disposed = true; root.unmount(); host.remove(); } };
}

let closeAccessDialog: (() => void) | null = null;
function AccessDialog({ sessionId, initialTitle, onClose }: { sessionId: string; initialTitle: string; onClose(): void }) {
  const [title, setTitle] = useState(initialTitle);
  return <SharingModal title="访问权限与链接设置" className="document-access-dialog" onClose={onClose}>
    <p className="sharing-target-name">{title}</p>
    {sessionId && !sessionId.startsWith("file:") ? <DocumentAccess sessionId={sessionId} onNavigate={onClose} onTitle={setTitle} />
      : <p className="sharing-muted">请先打开一篇会话文档。</p>}
    <footer><button onClick={onClose}>完成</button></footer>
  </SharingModal>;
}
export function openDocumentAccessDialog(sessionId = currentWorkbenchDocument()) {
  closeAccessDialog?.();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (closeAccessDialog === dispose) closeAccessDialog = null;
    queueMicrotask(() => { root.unmount(); host.remove(); });
  };
  closeAccessDialog = dispose;
  const shared = sharedWorkbenchDocument(sessionId);
  const title = shared?.title || (window.zion?.state?.get?.(`sessions.meta.${sessionId}`) as { title?: string })?.title || "当前会话";
  root.render(<AccessDialog sessionId={sessionId} initialTitle={title} onClose={dispose} />);
  return { dispose };
}
