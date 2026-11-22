import { useEffect, useRef, useState } from "react";
import { Copy, Link, Check } from "lucide-react";
import { type createSharingClient, type DocumentLink, type DocumentAccessRequest } from "../../../packages/runtime-client/src/sharing.mjs";

type API = ReturnType<typeof createSharingClient>;
export function DocumentLinkControls({ api, documentId, privateDocument, prepare, onChanged }: {
  api: API; documentId: string; privateDocument: boolean; prepare?(): Promise<void>; onChanged(): void;
}) {
  const [link, setLink] = useState<DocumentLink | null>(null);
  const [requests, setRequests] = useState<DocumentAccessRequest[]>([]);
  const [roles, setRoles] = useState<Record<string, "viewer" | "editor">>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmPublic, setConfirmPublic] = useState(false);
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const readSequence = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    const version = ++generation.current;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (pending.current) { timer = setTimeout(refresh, 5000); return; }
      const sequence = ++readSequence.current;
      try {
        const [result, pending] = await Promise.all([api.documentLink(documentId), api.accessRequests(documentId)]);
        if (generation.current === version && sequence === readSequence.current) { setLink(result.link || null); setRequests(pending.requests || []); setError(""); }
      } catch (cause) { if (generation.current === version && sequence === readSequence.current) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (generation.current === version) { setLoading(false); timer = setTimeout(refresh, 5000); } }
    };
    void refresh();
    return () => { generation.current++; clearTimeout(timer); };
  }, [api, documentId]);
  const perform = async (action: () => Promise<void>) => {
    if (pending.current) return;
    const version = generation.current;
    pending.current = true; readSequence.current++; setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (cause) { if (generation.current === version) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; if (generation.current === version) setBusy(false); }
  };
  const changeMode = (mode: DocumentLink["mode"]) => void perform(async () => {
    await prepare?.();
    const result = await api.setDocumentLink(documentId, mode);
    setLink(result.link); setCopied(false); setConfirmPublic(false);
    setNotice(mode === "public" ? "公开阅读已开启。" : mode === "disabled" ? "链接已关闭，已有账号授权保留。" : "链接仅对已授权账号开放。");
    onChanged();
  });
  return <section className="sharing-document-link" aria-label="链接与访问申请">
    <h3><Link size={14} />链接分享</h3>
    <p className="sharing-muted">固定链接可重复分享。受限时需登录并获得授权；公开时任何人都可阅读。</p>
    {loading ? <p role="status">正在读取链接设置…</p> : <>
      <label className="sharing-inline-label">链接访问<select aria-label="链接访问范围" disabled={busy}
        value={link?.mode || "disabled"} onChange={event => {
          const mode = event.target.value as DocumentLink["mode"];
          if (mode === "public") setConfirmPublic(true); else changeMode(mode);
        }}><option value="disabled">关闭链接</option><option value="restricted">仅已授权账号</option>
        <option value="public" disabled={privateDocument}>互联网上任何人可阅读</option></select></label>
      {(!link || link.mode === "disabled") && <button disabled={busy} onClick={() => changeMode("restricted")}>创建受限分享链接</button>}
      {confirmPublic && <div className="sharing-inline-confirm" role="alert">
        <p>开启后，拿到链接的任何人都可阅读当前会话正文和其中的图片，后续修改也会显示。</p>
        <button disabled={busy} onClick={() => setConfirmPublic(false)}>取消</button>
        <button disabled={busy || privateDocument} onClick={() => changeMode("public")}>开启公开阅读</button>
      </div>}
      {link && link.mode !== "disabled" && <div className="sharing-copy-row">
        <input readOnly aria-label="会话分享链接" value={link.url} onFocus={event => event.target.select()} />
        <button aria-label="复制会话分享链接" disabled={busy} onClick={() => void perform(async () => {
          try { await navigator.clipboard.writeText(link.url); setCopied(true); }
          catch { throw new Error("请选中链接手动复制"); }
        })}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "已复制" : "复制"}</button>
      </div>}
      {privateDocument && <p className="sharing-notice">会话已设为私密，链接阅读与访问申请均已暂停。</p>}
      {link?.mode === "public" && !privateDocument && <p className="sharing-muted">
        当前允许匿名阅读。移除协作者只取消账号授权；如需限制阅读，请将链接改为受限或关闭。
      </p>}
      <h3>访问申请<span>{requests.length}</span></h3>
      {!requests.length && <p className="sharing-muted">暂无待处理申请。</p>}
      {requests.map(request => <div className="sharing-access-request" key={request.id}>
        <strong>{request.name || "未命名用户"}</strong><small>{request.userId}</small>
        <p>申请{request.role === "editor" ? "编辑" : "查看"}{request.message ? ` · ${request.message}` : ""}</p>
        <div className="document-access-actions">
          <select aria-label={`${request.name} 的批准权限`} disabled={busy || privateDocument}
            value={roles[request.id] || request.role} onChange={event => setRoles({ ...roles, [request.id]: event.target.value as "viewer" | "editor" })}>
            <option value="viewer">可查看</option><option value="editor">可编辑</option>
          </select>
          <button disabled={busy || privateDocument || link?.mode === "disabled"} onClick={() => void perform(async () => {
            await api.decideAccess(documentId, request.id, "approved", roles[request.id] || request.role);
            setRequests((await api.accessRequests(documentId)).requests); onChanged(); setNotice("已批准，会话会出现在对方的会话列表中。");
          })}>批准</button>
          <button disabled={busy || privateDocument || link?.mode === "disabled"} onClick={() => void perform(async () => {
            await api.decideAccess(documentId, request.id, "rejected");
            setRequests((await api.accessRequests(documentId)).requests); onChanged(); setNotice("已拒绝申请。");
          })}>拒绝</button>
        </div>
      </div>)}
    </>}
    {error && <p role="alert" className="sharing-error">{error}</p>}
    {notice && <p role="status" className="sharing-success">{notice}</p>}
  </section>;
}
