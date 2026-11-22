import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Plus, RefreshCw, ArrowUpRight, Link, ArrowLeft, Share2, Cpu, FileText, Folder, Search } from "lucide-react";
import { createSharingClient, type Share } from "../../../packages/runtime-client/src/sharing.mjs";
import { currentAccountSession } from "../../../packages/account-ui/src/client";
import { readWorkbenchRuntimeConfig } from "../../runtime/workbench-runtime-config";
import { registerSharedWorkbenchDocument, sharedWorkbenchDocument } from "../../runtime/workbench-space";
import { activityBarRuntime, sideBarRuntime } from "./runtime";
import { SharingDialog, SharingModal as Dialog, type SharingTarget as Target } from "./SharingDialog";
import { useSharingRefresh } from "./sharing-refresh";
import "./sharing-workbench.css";

const kinds = { model: "模型", document: "会话", folder: "文件夹" };
const roleName = (share: Share) => share.kind === "model" ? "可使用" : share.role === "editor" ? "可编辑" : "可查看";
const pendingKey = "zion.sharing.pendingInvitation";
export function captureSharingInvitation() {
  const token = new URLSearchParams(location.hash.slice(1)).get("share");
  if (token) {
    // Invalid invitations open the editable review dialog instead of blocking
    // the account gate or mounting a blank Workbench.
    sessionStorage.setItem(pendingKey, token.slice(0, 256));
    history.replaceState(history.state, "", location.pathname + location.search);
  }
  return sessionStorage.getItem(pendingKey) || "";
}

type ManageTarget = { sourceId?: string; shareId?: string; direction?: string };
type API = ReturnType<typeof createSharingClient>;
const available = (share: Share) => share.status === "active" && (!share.expiresAt || share.expiresAt > Date.now());
const stateName = (share: Share) => share.status !== "active" ? "已撤销" : !available(share) ? "已过期" : "";
const KindIcon = ({ kind }: { kind: Share["kind"] }) => kind === "model" ? <Cpu size={16} /> : kind === "folder" ? <Folder size={16} /> : <FileText size={16} />;
function SharingPanel({ api, subscribe, subscribeManage }: { api: API; subscribe(fn: (target: Target) => void): () => void;
  subscribeManage(fn: (target: ManageTarget) => void): () => void }) {
  const [direction, setDirection] = useState("received");
  const [kindFilter, setKindFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [shares, setShares] = useState<Share[]>([]);
  const selected = shares.find(share => share.id === selectedId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refreshSequence = useRef(0);
  const refreshing = useRef(false);
  const managedSelection = useRef<ManageTarget | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [token, setToken] = useState(() => captureSharingInvitation());
  const [acceptOpen, setAcceptOpen] = useState(() => !!captureSharingInvitation());
  const [preview, setPreview] = useState<Share | null>(null);
  const invitationState = useRef({ token, acceptOpen });
  invitationState.current = { token, acceptOpen };
  const refreshingInvitation = useRef(false);
  const [privateDocument, setPrivateDocument] = useState(false);
  const [folder, setFolder] = useState<{ share: Share; tree: any } | null>(null);
  const [confirm, setConfirm] = useState<{ share: Share; recipientId?: string; invitationId?: string; leave?: boolean } | null>(null);
  const refreshModels = () => {
    window.zion?.events?.emit?.("sharing/changed", {});
  };
  const reload = async (value = direction, manage?: ManageTarget, quiet = false) => {
    if (quiet && refreshing.current) return;
    const sequence = ++refreshSequence.current;
    refreshing.current = true;
    if (!quiet) setLoading(true);
    try { const result = await api.list(value); if (sequence === refreshSequence.current) {
      setShares(result.shares); if (!quiet) setError("");
      const next = manage || managedSelection.current;
      if (next) {
        setSelectedId(result.shares.find(share => next.shareId ? share.id === next.shareId : share.sourceId === next.sourceId)?.id || "");
        managedSelection.current = null;
      }
    } }
    catch (cause) { if (!quiet && sequence === refreshSequence.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (sequence === refreshSequence.current) { refreshing.current = false; setLoading(false); } }
  };
  useEffect(() => { void reload(); }, [direction]);
  useSharingRefresh(() => {
    void reload(direction, undefined, true);
    if (!acceptOpen || !preview || refreshingInvitation.current) return;
    refreshingInvitation.current = true;
    const current = () => invitationState.current.acceptOpen && invitationState.current.token === token;
    void api.preview(token).then(result => { if (current()) setPreview(result.share); })
      .catch(cause => { if (current()) { setPreview(null); setError(cause instanceof Error ? cause.message : String(cause)); } })
      .finally(() => { refreshingInvitation.current = false; });
  }, !busy && !loading);
  const perform = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await work(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const create = (next: Target) => {
    setTarget(next); setError("");
    if (next.managePrivacy) void perform(async () => { setPrivateDocument((await api.documentPrivacy(next.sourceId)).private); });
  };
  useEffect(() => subscribe(create), []);
  useEffect(() => subscribeManage(next => {
    if (next.sourceId && next.direction !== "received") {
      create({ kind: "document", sourceId: next.sourceId,
        name: (window.zion?.state?.get?.(`sessions.meta.${next.sourceId}`) as { title?: string })?.title || next.sourceId });
      return;
    }
    const value = next.direction === "received" ? "received" : "sent";
    managedSelection.current = next;
    setDirection(value); setQuery(""); setKindFilter("all"); setSelectedId(next.shareId || "");
    // The direction effect may also load; only the newest response is applied.
    void reload(value, next);
  }), []);
  useEffect(() => {
    let disposed = false;
    setFolder(previous => previous?.share.id === selectedId ? previous : null);
    if (selected?.kind === "folder" && direction === "received" && available(selected)) {
      void api.documents(selected.id).then(result => { if (!disposed) setFolder(result); })
        .catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    } else setFolder(null);
    return () => { disposed = true; };
  }, [selected, direction]);
  useEffect(() => {
    if (acceptOpen && token) void perform(async () => { setPreview((await api.preview(token)).share); });
  }, []);
  const close = () => { if (!busy) { setTarget(null); setAcceptOpen(false); setPreview(null); setConfirm(null); } };
  const openDocument = async (share: Share, documentId = share.sourceId, title = share.name) => {
    const participants = await api.participants(documentId, share.originSpaceId);
    const access = participants.participants.find(person => person.id === participants.selfId);
    const document = registerSharedWorkbenchDocument({
      originSpaceId: share.originSpaceId, documentId, role: access?.role === "editor" ? "editor" : "viewer",
      title, providerName: share.owner.name
    });
    // The native loader rechecks authorization; never seed content from a share list.
    const opened = await window.zion?.commands?.executeCommand?.("zion.sessions.switch", document.localId);
    if (opened === false) throw new Error("暂时无法打开分享会话，请刷新分享列表");
  };
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("shareLink");
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return;
    void perform(async () => {
      const view = await api.openLink(id);
      if (view.role === "owner") await window.zion?.commands?.executeCommand?.("zion.sessions.switch", view.documentId);
      else {
        const document = registerSharedWorkbenchDocument({ originSpaceId: view.originSpaceId, documentId: view.documentId,
          role: view.role, title: view.title, providerName: "" });
        const opened = await window.zion?.commands?.executeCommand?.("zion.sessions.switch", document.localId);
        if (opened === false) throw new Error("暂时无法打开会话，请刷新后重试");
      }
      const url = new URL(location.href); url.searchParams.delete("shareLink");
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
      refreshModels();
    });
  }, []);
  const tree = (node: any, share: Share): ReactNode => !node ? <p>这个文件夹暂时没有可访问的会话。</p>
    : node.type === "session" ? <button className="sharing-document" key={node.id}
      onClick={() => void perform(() => openDocument(share, node.id, node.title))}><span>{node.title}</span><ArrowUpRight size={14} /></button>
    : <div className="sharing-folder" key={node.id}><strong>{node.title}</strong>{(node.children || []).map((child: any) => tree(child, share))}</div>;

  return <div className="sharing-panel">
    {!selected && <><div className="sharing-tabs" role="tablist" aria-label="分享方向">
      {["received", "sent"].map(value => <button role="tab" aria-selected={direction === value} key={value}
        onClick={() => { setSelectedId(""); setDirection(value); }}>{value === "received" ? "收到的" : "我分享的"}</button>)}
      <button className="sharing-icon" title="刷新分享" aria-label="刷新分享" disabled={busy || loading}
        onClick={() => void reload()}><RefreshCw size={14} /></button>
    </div>
    <div className="sharing-toolbar">
      <button onClick={() => create({ kind: "model", sourceId: "", name: "" })}><Plus size={14} />分享模型</button>
      <button onClick={() => { setAcceptOpen(true); setPreview(null); setError(""); }}><Link size={14} />接受邀请</button>
    </div>
    <div className="sharing-search"><Search size={13} aria-hidden="true" /><input aria-label="搜索分享" placeholder="搜索资源或提供者"
      value={query} onChange={event => setQuery(event.target.value)} />
      <select aria-label="资源类型" value={kindFilter} onChange={event => setKindFilter(event.target.value)}>
        <option value="all">全部类型</option>{Object.entries(kinds).map(([kind, name]) => <option key={kind} value={kind}>{name}</option>)}
      </select></div></>}
    {error && <p className="sharing-error" role="alert">{error}</p>}
    {selected ? <div className="sharing-inspector">
      <button className="sharing-back" onClick={() => { setSelectedId(""); setError(""); }}><ArrowLeft size={14} />返回{direction === "received" ? "收到的分享" : "我的分享"}</button>
      <div className="sharing-resource-heading"><KindIcon kind={selected.kind} /><h2>{selected.name}</h2>
        {direction === "received" && <Share2 size={12} className="shared-resource-marker" aria-label="收到的分享" />}</div>
      <dl><div><dt>类型</dt><dd>{kinds[selected.kind]}</dd></div><div><dt>{direction === "sent" && selected.kind !== "model" ? "邀请权限" : "权限"}</dt><dd>{roleName(selected)}</dd></div>
        <div><dt>提供者</dt><dd>{direction === "sent" ? "你" : selected.owner.name || "提供者"}</dd></div>
        <div><dt>有效期</dt><dd>{stateName(selected) || (selected.expiresAt ? new Date(selected.expiresAt).toLocaleDateString() : "直到撤销")}</dd></div>
        {selected.kind === "model" && <div><dt>每月额度</dt><dd>{direction === "sent" && selected.usage ? `${selected.usage.calls} / ` : ""}{selected.monthlyCalls} 次</dd></div>}
      </dl>
      <div className="sharing-inspector-actions">
        {direction === "received" ? <button disabled={busy || !available(selected)} onClick={() => void perform(async () => {
          if (selected.kind === "model") await window.zion?.commands?.executeCommand?.("models.openSwitcher");
          else if (selected.kind === "document") await openDocument(selected);
          else await window.zion?.commands?.executeCommand?.("zion.sessions.showSidebar");
        })}>{selected.kind === "model" ? "选择模型" : selected.kind === "folder" ? "在会话列表查看" : "打开会话"}<ArrowUpRight size={13} /></button>
          : available(selected) && <button disabled={busy} onClick={() => create({
            kind: selected.kind, sourceId: selected.sourceId, name: selected.name, shareId: selected.id
          })}><Share2 size={13} />管理分享</button>}
      </div>
      {direction === "received" && selected.kind === "folder" && available(selected) && <section><h3>文件夹内容</h3>
        {folder ? tree(folder.tree, folder.share) : <p className="sharing-muted" role="status">正在读取会话…</p>}</section>}
      {direction === "sent" && <><section><h3>已授权用户</h3>
        {!(selected.recipients || []).length && <p className="sharing-muted">还没有添加协作者。</p>}
        {(selected.recipients || []).map(recipient => <div className="sharing-detail" key={recipient.id}>
          <span>{recipient.name || "未命名用户"}<small>{recipient.status === "active" ? roleName({ ...selected, role: recipient.role }) : "已撤销"}</small></span>
          {recipient.status === "active" && available(selected) && selected.kind !== "model" && <select
            aria-label={`${recipient.name} 的权限`} disabled={busy} value={recipient.role}
            onChange={event => { const role = event.target.value; void perform(async () => {
              await api.updateRecipient(selected.id, recipient.id, role); refreshModels(); await reload();
            }); }}><option value="viewer">可查看</option><option value="editor">可编辑</option></select>}
          {recipient.status === "active" && available(selected) && <button disabled={busy} onClick={() => setConfirm({ share: selected, recipientId: recipient.id })}>撤销</button>}
        </div>)}</section>
        <section><h3>邀请链接</h3>{!(selected.invitations || []).length && <p className="sharing-muted">暂无邀请链接。</p>}
          {(selected.invitations || []).map((invitation, i) => <div className="sharing-detail" key={invitation.id}>
            <span>邀请 {i + 1}<small>{invitation.claims}/{invitation.maxClaims} 人 · {invitation.status !== "active" ? "已撤销" : invitation.claims >= invitation.maxClaims ? "已用完" : invitation.expiresAt <= Date.now() ? "已过期" : `${new Date(invitation.expiresAt).toLocaleDateString()} 到期`}</small></span>
            {invitation.status === "active" && invitation.expiresAt > Date.now() && invitation.claims < invitation.maxClaims && available(selected) &&
              <button disabled={busy} onClick={() => setConfirm({ share: selected, invitationId: invitation.id })}>撤销链接</button>}
          </div>)}</section></>}
      <div className="sharing-danger-zone">{direction === "received" ? <button disabled={busy} onClick={() => setConfirm({ share: selected, leave: true })}>移除收到的分享</button>
        : available(selected) && <button disabled={busy} onClick={() => setConfirm({ share: selected })}>撤销整个分享</button>}</div>
    </div> : loading ? <p className="sharing-muted" role="status">正在读取分享…</p>
      : !shares.length ? <p className="sharing-muted sharing-empty">{direction === "received" ? "获得分享后，模型可在模型选择器使用，会话和文件夹会加入会话列表。" : "分享模型，或右键会话、文件夹添加协作者。"}</p>
        : <div className="sharing-resource-list">{Object.entries(kinds).map(([kind, name]) => {
          const items = shares.filter(share => share.kind === kind && (kindFilter === "all" || kindFilter === kind) &&
            `${share.name} ${share.owner.name}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
          return !items.length ? null : <section key={kind}><h3>{name}<span>{items.length}</span></h3>{items.map(share =>
            <div className="sharing-row" key={share.id}>
              <button className="sharing-row-main" onClick={() => setSelectedId(share.id)} aria-label={`查看 ${share.name} 的分享详情`}>
                <KindIcon kind={share.kind} /><span><strong>{share.name}</strong><small>
                  {direction === "received" ? share.owner.name || "提供者" : `${(share.recipients || []).filter(person => person.status === "active").length} 人已授权`}
                  {" · "}{stateName(share) || roleName(share)}</small></span>
                {direction === "received" && <Share2 size={12} className="shared-resource-marker" aria-label="收到的分享" />}
              </button>
              {direction === "received" && <button className="sharing-row-action" disabled={busy || !available(share)}
                onClick={() => void perform(async () => {
                  if (share.kind === "model") await window.zion?.commands?.executeCommand?.("models.openSwitcher");
                  else if (share.kind === "folder") setSelectedId(share.id);
                  else await openDocument(share);
                })} title={share.kind === "model" ? "选择模型" : "打开"} aria-label={share.kind === "model" ? "选择模型" : "打开"}><ArrowUpRight size={14} /></button>}
            </div>)}</section>;
        })}{!shares.some(share => (kindFilter === "all" || kindFilter === share.kind) &&
          `${share.name} ${share.owner.name}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) &&
          <p className="sharing-muted sharing-empty">没有匹配的分享。</p>}</div>}
    {target?.managePrivacy && <Dialog title="会话隐私" onClose={close}><p>{target.name}</p>
      <label className="sharing-toggle"><input type="checkbox" checked={privateDocument} disabled={busy} onChange={event => setPrivateDocument(event.target.checked)} />设为私密</label>
      <p className="sharing-muted">私密会话仅你可访问。已有会话分享和文件夹继承授权会暂停；取消私密后，这些授权恢复。</p>
      {error && <p role="alert" className="sharing-error">{error}</p>}
      <footer><button disabled={busy} onClick={close}>取消</button><button className="sharing-primary" disabled={busy} onClick={() => void perform(async () => {
        await api.privacy(target.sourceId, privateDocument); window.zion?.state?.set?.(`sharing.private.${target.sourceId}`, privateDocument);
        setTarget(null); refreshModels(); await reload();
      })}>{busy ? "正在保存…" : "保存"}</button></footer>
    </Dialog>}
    {target && !target.managePrivacy && <SharingDialog key={`${target.kind}:${target.sourceId}:${target.shareId || ""}`}
      api={api} target={target} onClose={() => setTarget(null)} onChanged={() => { refreshModels(); void reload(); }} />}
    {acceptOpen && <Dialog title="接受分享邀请" onClose={close}>
      <form onSubmit={event => { event.preventDefault(); void perform(async () => {
        if (!preview) { setPreview((await api.preview(token)).share); return; }
        await api.accept(token); sessionStorage.removeItem(pendingKey); setToken(""); setAcceptOpen(false); setPreview(null);
        refreshModels(); setDirection("received"); await reload("received");
      }); }}>
        <label>邀请链接<input autoFocus required value={token} onChange={event => { setToken(event.target.value); setPreview(null); }} placeholder="粘贴分享邀请链接" /></label>
        {preview && <div className="sharing-review"><strong>{preview.name}</strong><p>{preview.owner.name} 分享的{kinds[preview.kind]} · {roleName(preview)}</p>
          <p>{preview.kind === "model" ? `每月最多 ${preview.monthlyCalls} 次。接受后可在模型选择器中使用，你的私密会话保持私密。` : "仅授予内容访问权限，不包含对方的模型和设备。"}</p></div>}
        {error && <p role="alert" className="sharing-error">{error}</p>}
        <footer><button type="button" disabled={busy} onClick={close}>取消</button><button className="sharing-primary" disabled={busy || !token}>{busy ? "正在处理…" : preview ? "接受分享" : "查看邀请"}</button></footer>
      </form>
    </Dialog>}
    {confirm && <Dialog title={confirm.leave ? "移除收到的分享" : confirm.invitationId ? "撤销邀请链接" : "撤销授权"} onClose={close}>
      <p>{confirm.share.name}：{confirm.leave ? "移除后你将无法继续访问。" : confirm.invitationId ? "这条链接将无法被接受，已接受者的权限保留。" : confirm.recipientId ? "这位接受者将失去访问权限。" : "所有接受者将失去访问权限，邀请链接也将失效。"}</p>
      {error && <p role="alert" className="sharing-error">{error}</p>}
      <footer><button onClick={close} disabled={busy}>取消</button><button disabled={busy} className="sharing-primary" onClick={() => void perform(async () => {
        if (confirm.leave) await api.leave(confirm.share.id);
        else await api.revoke(confirm.share.id, { ...(confirm.recipientId ? { recipientId: confirm.recipientId } : {}), ...(confirm.invitationId ? { invitationId: confirm.invitationId } : {}) });
        setConfirm(null); refreshModels(); await reload();
      })}>{busy ? "正在处理…" : "确认"}</button></footer>
    </Dialog>}
  </div>;
}

export function mountSharingWorkbench(_host: HTMLElement) {
  if (!currentAccountSession()) return null;
  const api = createSharingClient({ baseUrl: readWorkbenchRuntimeConfig().baseUrl });
  const mount = document.createElement("div"), root = createRoot(mount);
  let openTarget: ((target: Target) => void) | null = null;
  let manageTarget: ((target: ManageTarget) => void) | null = null;
  const pending: Target[] = [];
  const pendingManage: ManageTarget[] = [];
  root.render(<SharingPanel api={api} subscribe={fn => { openTarget = fn; pending.splice(0).forEach(fn); return () => { openTarget = null; }; }}
    subscribeManage={fn => { manageTarget = fn; pendingManage.splice(0).forEach(fn); return () => { manageTarget = null; }; }} />);
  const disposables = [
    activityBarRuntime.registerItem({ id: "sharing.activity", pluginId: "core.sharing", icon: "$(share-2)", tooltip: "分享", sideBarViewId: "sharing.list", order: 25 }),
    sideBarRuntime.registerView({ id: "sharing.list", pluginId: "core.sharing", title: "分享", icon: "$(share-2)", order: 25,
      component: { render(container: HTMLElement) { container.replaceChildren(mount); } } }),
    window.zion?.commands?.registerCommand?.("zion.sharing.create", (target: Target) => {
      if (!target?.sourceId || sharedWorkbenchDocument(target.sourceId)) return;
      if (openTarget) openTarget(target); else pending.push(target);
    }),
    window.zion?.commands?.registerCommand?.("zion.sharing.manage", (target: ManageTarget = {}) => {
      if (!target.sourceId || target.direction === "received") { sideBarRuntime.activateView("sharing.list"); sideBarRuntime.show(); }
      if (manageTarget) manageTarget(target); else pendingManage.push(target);
    }),
  ];
  if (captureSharingInvitation()) { sideBarRuntime.activateView("sharing.list"); sideBarRuntime.show(); }
  return { dispose() { root.unmount(); disposables.forEach(disposable => disposable?.dispose()); mount.remove(); } };
}
