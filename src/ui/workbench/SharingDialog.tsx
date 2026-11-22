import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Copy, Link, X, Check, Users, ArrowUpRight, ArrowLeft } from "lucide-react";
import { type createSharingClient, type Share, type DocumentParticipant } from "../../../packages/runtime-client/src/sharing.mjs";
import { currentAccountSession } from "../../../packages/account-ui/src/client";
import { markSharedWorkbenchContent } from "../../runtime/workbench-space";
import { DocumentLinkControls } from "./DocumentLinkControls";
import { useSharingRefresh } from "./sharing-refresh";

export type SharingTarget = { kind: "model" | "document" | "folder"; sourceId: string; name: string; shareId?: string; managePrivacy?: boolean };
type API = ReturnType<typeof createSharingClient>;
const labels = { model: "模型", document: "会话", folder: "文件夹" };
const active = (share: Share) => share.status === "active" && (!share.expiresAt || share.expiresAt > Date.now());

export function SharingModal({ title, onClose, children, className = "" }: { title: string; onClose(): void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    (ref.current?.querySelector("input, select, footer button") as HTMLElement | null)?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="sharing-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={ref} className={`sharing-dialog ${className}`.trim()} role="dialog" aria-modal="true" aria-label={title}
      onKeyDown={event => {
        if (event.key === "Escape") onClose();
        if (event.key === "Tab") {
          const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), summary") || []);
          if (!nodes.length) return;
          if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
          if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
        }
      }}>
      <header><h2>{title}</h2><button aria-label="关闭" onClick={onClose}><X size={16} /></button></header>
      {children}
    </section>
  </div>, document.body);
}

type Person = { id: string; name: string; role: string; grants: NonNullable<DocumentParticipant["grants"]> };
export function SharingDialog({ api, target: initial, onClose, onChanged }: {
  api: API; target: SharingTarget; onClose(): void; onChanged(): void;
}) {
  const [target, setTarget] = useState(initial);
  const [shares, setShares] = useState<Share[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [sources, setSources] = useState<Array<Record<string, any>>>([]);
  const [role, setRole] = useState("viewer");
  const [monthlyCalls, setMonthlyCalls] = useState(1000);
  const [durationDays, setDurationDays] = useState("");
  const [recipientInput, setRecipientInput] = useState("");
  const [recipient, setRecipient] = useState<{ id: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [privateDocument, setPrivateDocument] = useState(false);
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<{ person?: Person; shareId?: string; invitationId?: string } | null>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const refreshSequence = useRef(0);
  const refreshing = useRef(false);
  const owner = currentAccountSession()?.user;
  const reload = async (value = target) => {
    const sequence = ++refreshSequence.current;
    refreshing.current = true;
    try {
      const list = (await api.list("sent")).shares;
      const current = () => mounted.current && sequence === refreshSequence.current;
      if (!current()) return;
      const selected = list.filter(share => share.kind === value.kind && share.sourceId === value.sourceId && active(share)
        && (!value.shareId || value.kind !== "model" || share.id === value.shareId));
      setShares(selected);
      const source = list.find(share => share.id === value.shareId) || selected[0];
      const find = (node: any): any => node?.id === value.sourceId ? node : (node?.children || []).map(find).find(Boolean);
      const name = value.kind === "model" ? value.name : source?.name
        || (value.kind === "folder" ? find(window.zion?.state?.get?.("sessions.treeMem"))?.title
          : (window.zion?.state?.get?.(`sessions.meta.${value.sourceId}`) as { title?: string })?.title) || value.name;
      setTarget(previous => ({ ...previous, name, shareId: value.shareId || selected[0]?.id }));
      if (value.kind === "document") {
        const [result, privacy] = await Promise.all([api.participants(value.sourceId), api.documentPrivacy(value.sourceId)]);
        if (!current()) return;
        if (result.title) setTarget(previous => ({ ...previous, name: result.title! }));
        setPrivateDocument(privacy.private);
        const participants = result.participants.filter(person => person.role !== "owner").map(person => ({
          id: person.id, name: person.name, role: person.role, grants: person.grants || []
        }));
        // Private content suspends access; still let the owner manage existing direct grants.
        if (privacy.private) {
          const map = new Map<string, Person>();
          for (const share of selected) for (const person of share.recipients || []) {
            if (person.status !== "active") continue;
            const entry = map.get(person.id) || { ...person, grants: [] };
            entry.grants.push({ shareId: share.id, kind: "document", sourceId: value.sourceId, name: share.name, role: person.role as "viewer" | "editor" });
            if (person.role === "editor") entry.role = "editor";
            map.set(person.id, entry);
          }
          setPeople([...map.values()]);
        } else setPeople(participants);
      } else {
        const map = new Map<string, Person>();
        for (const share of selected) for (const person of share.recipients || []) {
          if (person.status !== "active") continue;
          const entry = map.get(person.id) || { ...person, grants: [] };
          entry.grants.push({ shareId: share.id, kind: value.kind as "folder", sourceId: value.sourceId, name: share.name, role: person.role as "viewer" | "editor" });
          if (person.role === "editor") entry.role = "editor";
          map.set(person.id, entry);
        }
        setPeople([...map.values()]);
      }
    } finally { if (sequence === refreshSequence.current) refreshing.current = false; }
  };
  useSharingRefresh(() => {
    if (pending.current || refreshing.current) return;
    void reload().catch(() => {});
  }, !loading && !busy);
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        let value = initial;
        if (initial.kind === "model" && !initial.sourceId) {
          const sourceList = (await api.sources()).sources;
          if (!mounted.current) return;
          setSources(sourceList);
          if (sourceList.length) { value = { ...initial, sourceId: sourceList[0].id, name: sourceList[0].name }; setTarget(value); }
        }
        if (value.sourceId) await reload(value);
      } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (mounted.current) setLoading(false); }
    })();
    return () => { mounted.current = false; };
  }, []);
  const perform = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const refresh = async () => { onChanged(); await reload(); };
  const prepare = async () => {
    if (target.kind === "document") {
      await window.zion?.commands?.executeCommand?.("zion.sessions.flushRunInput", target.sourceId);
    }
  };
  const markShared = () => {
    if (target.kind === "document") markSharedWorkbenchContent(target.sourceId);
    if (target.kind === "folder") {
      const walk = (node: any) => { if (!node) return; if (node.type === "session") markSharedWorkbenchContent(node.id); (node.children || []).forEach(walk); };
      const find = (node: any): any => node?.id === target.sourceId ? node : (node?.children || []).map(find).find(Boolean);
      walk(find(window.zion?.state?.get?.("sessions.treeMem")));
    }
  };
  const create = async (recipientId?: string) => {
    await prepare();
    const result = await api.create({ kind: target.kind, sourceId: target.sourceId, name: target.name,
      ...(target.kind === "model" ? { monthlyCalls } : { role }),
      ...(durationDays ? { durationDays: Number(durationDays) } : {}), ...(recipientId ? { recipient: recipientId } : {}) });
    markShared();
    setTarget({ ...target, shareId: result.share.id });
    return result;
  };
  const add = async () => {
    if (!recipient) return;
    // Reuse the displayed share so adding a person retains its duration and model budget.
    const existing = target.shareId && shares.find(share => share.id === target.shareId);
    if (existing) await api.addRecipient(existing.id, { recipient: recipient.id, role: target.kind === "model" ? "use" : role });
    else await create(recipient.id);
    setRecipient(null); setRecipientInput("");
    await refresh(); setNotice("已添加，对方的资源列表会显示这份分享。");
  };
  const changeRole = async (person: Person, next: string) => {
    if (next === "removed") { setConfirm({ person }); return; }
    await perform(async () => {
      if (target.kind === "document") await api.updateDocumentCollaborator(target.sourceId, person.id, next as "viewer" | "editor");
      else await api.updateSourceCollaborator(target.kind, target.sourceId, person.id, next);
      await refresh(); setNotice("权限已更新。");
    });
  };
  const inherited = (person: Person) => person.grants.filter(grant => grant.kind === "folder" && target.kind === "document");
  const direct = (person: Person) => person.grants.filter(grant => grant.kind === target.kind);
  const manageFolder = async (grant: Person["grants"][number]) => {
    const next: SharingTarget = { kind: "folder", sourceId: grant.sourceId, name: grant.name, shareId: grant.shareId };
    setTarget(next); setRecipient(null); setRecipientInput(""); setLink(""); setRole("viewer"); setLoading(true);
    await perform(async () => { try { await reload(next); } finally { setLoading(false); } });
  };
  return <SharingModal title={`分享${labels[target.kind]}`} onClose={() => { if (!busy) onClose(); }}>
    {target.kind !== initial.kind && <button disabled={busy} onClick={() => {
      setTarget(initial); setRecipient(null); setRecipientInput(""); setLink(""); setRole("viewer"); setLoading(true);
      void perform(async () => { try { await reload(initial); } finally { setLoading(false); } });
    }}><ArrowLeft size={13} />返回{labels[initial.kind]}权限</button>}
    <p className="sharing-target-name">{target.name || "选择要分享的模型"}</p>
    {sources.length > 0 && <label>模型<select disabled={busy || loading} value={target.sourceId} onChange={event => {
      const source = sources.find(item => item.id === event.target.value); if (!source) return;
      const next = { ...target, shareId: undefined, sourceId: source.id, name: source.name }; setTarget(next); setRecipient(null); setLink("");
      void perform(() => reload(next));
    }}>{sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>}
    {privateDocument && target.kind === "document" && <p className="sharing-notice">当前为私密会话，协作者访问已暂停。取消私密后授权恢复。</p>}
    {target.shareId && target.kind === "model" && shares[0] && <p className="sharing-muted sharing-hint">每月共 {shares[0].monthlyCalls} 次 · {shares[0].expiresAt ? `${new Date(shares[0].expiresAt).toLocaleDateString()} 到期` : "直到撤销"}</p>}
    {target.shareId && target.kind !== "model" && shares[0] && <p className="sharing-muted sharing-hint">新增协作者沿用当前分享有效期：{shares[0].expiresAt ? `${new Date(shares[0].expiresAt).toLocaleDateString()} 到期` : "直到撤销"}。</p>}
    <section className="sharing-invite-section" aria-label="添加协作者">
      <h3><Users size={14} />{target.kind === "model" ? "添加使用者" : "添加协作者"}</h3>
      <form onSubmit={event => { event.preventDefault(); if (loading) return; void perform(async () => {
        if (recipient) await add();
        else setRecipient((await api.resolveRecipient(recipientInput)).recipient);
      }); }}>
        <div className="sharing-recipient-input"><input aria-label="邮箱或账号 ID" placeholder="输入完整邮箱或账号 ID" value={recipientInput}
          disabled={busy || loading} onChange={event => { setRecipientInput(event.target.value); setRecipient(null); setError(""); }} />
          <button className="sharing-primary" disabled={busy || loading || !target.sourceId || !recipientInput.trim()}>
            {busy ? "处理中…" : recipient ? "添加" : "查找"}</button></div>
        {recipient && <div className="sharing-recipient-preview"><span className="sharing-person-avatar">{(recipient.name || "?").slice(0, 1)}</span>
          <span><strong>{recipient.name || "未命名用户"}</strong><small>{recipient.id}</small></span><Check size={14} /></div>}
        {target.kind !== "model" && <label className="sharing-inline-label">授予权限<select aria-label="新协作者权限" disabled={busy} value={role} onChange={event => setRole(event.target.value)}>
          <option value="viewer">可查看</option><option value="editor">可编辑</option></select></label>}
        {!target.shareId && <details className="sharing-grant-options"><summary>授权选项{target.kind === "model" ? ` · 每月 ${monthlyCalls} 次` : ""}</summary>
          {target.kind === "model" && <label>每月调用上限<input type="number" min={1} max={1000000} required disabled={busy} value={monthlyCalls} onChange={event => setMonthlyCalls(Number(event.target.value))} /></label>}
          <label>授权时长<select disabled={busy} value={durationDays} onChange={event => setDurationDays(event.target.value)}>
            <option value="">直到撤销</option><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option></select></label>
        </details>}
      </form>
      <p className="sharing-muted sharing-hint">{target.kind === "model" ? "仅授予模型使用权，对方的私密会话仍由对方自己管理。"
        : target.kind === "folder" ? "包含当前和以后加入的会话，私密子会话除外。模型和设备另行授权。"
        : "访问原会话，编辑同步到这里。模型和设备另行授权。"}</p>
    </section>
    <section className="sharing-collaborators" aria-label="协作者权限">
      <h3>{target.kind === "model" ? "已授权用户" : "协作者"}<span>{people.length + 1}</span></h3>
      {owner && <div className="sharing-collaborator"><span className="sharing-person-avatar">{(owner.name || "?").slice(0, 1)}</span>
        <span className="sharing-person-name"><strong>{owner.name || "你"}（你）</strong></span><span className="sharing-owner-label">所有者</span></div>}
      {loading ? <p className="sharing-muted" role="status">正在读取权限…</p> : people.map(person => {
        const folders = inherited(person), hasDirect = direct(person).length > 0;
        return <div className="sharing-collaborator-wrap" key={person.id}>
          <div className="sharing-collaborator"><span className="sharing-person-avatar">{(person.name || "?").slice(0, 1)}</span>
            <span className="sharing-person-name"><strong>{person.name || "未命名用户"}</strong>
              {privateDocument && target.kind === "document" && <small>私密期间暂停访问</small>}
              {!hasDirect && folders.length > 0 && <small>继承自文件夹</small>}</span>
            {target.kind === "model" ? <button disabled={busy} onClick={() => setConfirm({ person })}>可使用 · 移除</button>
              : <select aria-label={`${person.name} 的权限`} disabled={busy || !hasDirect} value={person.role}
                onChange={event => void changeRole(person, event.target.value)}>
                <option value="viewer">可查看</option><option value="editor">可编辑</option>
                <option value="removed">{folders.length ? "移除会话授权" : "移除"}</option></select>}
          </div>
          {folders.map(grant => <div className="sharing-inherited" key={grant.shareId}>
            <span>来自文件夹「{grant.name}」 · {grant.role === "editor" ? "可编辑" : "可查看"}</span>
            <button disabled={busy} onClick={() => void manageFolder(grant)}>管理<ArrowUpRight size={11} /></button></div>)}
          {person.grants.length > 1 && !folders.length && <small className="sharing-permission-note">调整权限会同步更新此用户在当前{labels[target.kind]}的 {person.grants.length} 份授权。</small>}
        </div>;
      })}
      {!loading && !people.length && <p className="sharing-muted">输入对方的邮箱或账号 ID，直接添加授权。</p>}
    </section>
    {target.kind === "document" && <DocumentLinkControls key={target.sourceId} api={api}
      documentId={target.sourceId} privateDocument={privateDocument} prepare={prepare} onChanged={() => void refresh()} />}
    <details className="sharing-link-section"><summary><Link size={14} />一次性邀请链接</summary>
      <p className="sharing-muted">链接 7 天有效，仅可由一人接受。撤销链接不会移除已经添加的协作者。</p>
      {target.kind !== "model" && <p className="sharing-muted">邀请权限：{(target.shareId ? shares.find(share => share.id === target.shareId)?.role : role) === "editor" ? "可编辑" : "可查看"}。已有协作者权限保持不变。</p>}
      <button disabled={busy || loading || !target.sourceId} onClick={() => void perform(async () => {
        const existing = target.shareId && shares.find(share => share.id === target.shareId);
        if (existing) setLink((await api.invite(existing.id)).invitation.url);
        else { const result = await create(); if (result.invitation) setLink(result.invitation.url); }
        setCopied(false); await refresh();
      })}>生成邀请链接</button>
      {link && <div className="sharing-copy-row"><input aria-label="邀请链接" readOnly value={link} onFocus={event => event.target.select()} />
        <button aria-label="复制链接" disabled={busy} onClick={() => void perform(async () => {
          try { await navigator.clipboard.writeText(link); setCopied(true); } catch { throw new Error("请选中链接手动复制"); }
        })}><Copy size={14} />{copied ? "已复制" : "复制"}</button></div>}
      {shares.flatMap(share => (share.invitations || []).filter(invite => invite.status === "active" && invite.claims < invite.maxClaims && invite.expiresAt > Date.now())
        .map((invite, index) => <div className="sharing-detail" key={invite.id}><span>邀请 {index + 1}<small>{new Date(invite.expiresAt).toLocaleDateString()} 到期 · {invite.claims}/{invite.maxClaims} 人</small></span>
          <button disabled={busy} onClick={() => setConfirm({ shareId: share.id, invitationId: invite.id })}>撤销链接</button></div>))}
    </details>
    {confirm && <div className="sharing-inline-confirm" role="alert">
      <p>{confirm.person ? `移除 ${confirm.person.name} 的${target.kind === "document" ? "会话" : labels[target.kind]}授权？${inherited(confirm.person).length ? "文件夹继承权限会保留。" : "对方将失去这份授权。"}` : "撤销这条邀请链接？已添加协作者的权限会保留。"}</p>
      <button disabled={busy} onClick={() => setConfirm(null)}>取消</button>
      <button disabled={busy} onClick={() => void perform(async () => {
        if (confirm.person) {
          if (target.kind === "document") await api.updateDocumentCollaborator(target.sourceId, confirm.person.id, "removed");
          else if (target.kind === "model" && target.shareId) await api.revoke(target.shareId, { recipientId: confirm.person.id });
          else await api.updateSourceCollaborator(target.kind, target.sourceId, confirm.person.id, "removed");
        } else if (confirm.shareId) await api.revoke(confirm.shareId, { invitationId: confirm.invitationId });
        setConfirm(null); await refresh(); setNotice("已移除授权。");
      })}>确认移除</button>
    </div>}
    {error && <p role="alert" className="sharing-error">{error}</p>}
    {notice && <p role="status" className="sharing-success">{notice}</p>}
    <footer><button disabled={busy} onClick={onClose}>完成</button></footer>
  </SharingModal>;
}
