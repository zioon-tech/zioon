import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDown, Users, LockKeyhole, X, Plus, Copy, ArrowUpRight, Settings2, RefreshCw, Check, Search } from "lucide-react";
import { createSpacesClient } from "../../../packages/runtime-client/src/spaces.mjs";
import { currentAccountSession } from "../../../packages/account-ui/src/client";
import { workbenchSpaceUrl } from "../../runtime/workbench-space";
import { readWorkbenchRuntimeConfig } from "../../runtime/workbench-runtime-config";
import "./spaces-workbench.css";
import { AssetPreview, sharedDocumentUrl } from "./SharedDocument";

type Row = Record<string, any>;
const roles: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员", viewer: "只读成员",
  manager: "可管理", editor: "可编辑", commenter: "可评论" };
const kinds: Record<string, string> = { model: "模型", skill: "技能", plugin: "插件", device: "设备" };
const protections: Record<string, string> = { restricted: "指定成员", space: "空间内共享", external: "允许外部分享" };
const errors: Record<string, string> = {
  space_revision_conflict: "空间设置已更新，请刷新后重试。",
  document_acl_conflict: "分享设置已被其他人修改，请刷新后重试。",
  source_revision_conflict: "文档内容已变化，请重新检查要分享的内容。",
  document_review_stale: "原文已变化，请重新检查后分享。",
  publication_disallowed: "请先允许空间公开发布，并把文档设为允许外部分享。",
  personal_space_private: "个人空间保持私密，请创建共享空间。",
  recipient_not_found: "未找到这位联系人，请检查联系人代码。",
  already_member: "这位联系人已经在空间中。",
  invalid_default_model: "默认模型必须对整个空间开放。",
  source_document_busy: "文档仍有任务在运行，结束后可以移动。",
  document_not_found: "文档已删除或你没有访问权限。",
  capability_source_changed: "来源资源已变化，请由提供者重新授权。",
  document_contains_unapproved_assets: "正文包含未勾选的附件，请删除引用或选择对应附件。",
  external_grant_disallowed: "空间尚未允许外部联系人，或外部联系人被授予了编辑权限。",
  restricted_requires_named_people: "指定成员级别只能分享给具名成员。",
};
const message = (error: any) => errors[error?.code] || errors[error?.message] || error?.message || "操作失败，请重试";
const date = (value: any) => value ? new Date(Number(value)).toLocaleString("zh-CN") : "—";
const enc = encodeURIComponent;

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="zs-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function Empty({ children }: { children: ReactNode }) { return <p className="zs-empty">{children}</p>; }
function RowItem({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return <div className="zs-row"><div><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</div><div className="zs-actions">{children}</div></div>;
}
function Dialog({ title, subtitle, onClose, children, wide = false }: {
  title: string; subtitle?: string; onClose(): void; children: ReactNode; wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = ref.current!; node.showModal(); return () => node.close(); }, []);
  return <dialog ref={ref} className={`zs-dialog ${wide ? "zs-wide" : ""}`} onCancel={onClose}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="zs-icon" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>
    {children}
  </dialog>;
}
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState("");
  return <><button onClick={() => { void navigator.clipboard.writeText(value).then(() => setCopied(true)).catch(() => setError("请选中并复制链接")); }}>
    {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "已复制" : "复制"}</button>{error && <small>{error}</small>}</>;
}

function ResourceSettings({ resource, members, groups, save, busy }: {
  resource: Row; members: Row[]; groups: Row[]; save(body: Row): Promise<void>; busy: boolean
}) {
  const [audience, setAudience] = useState(resource.audienceMode);
  const [selected, setSelected] = useState<string[]>((resource.grants || []).map((g: Row) => `${g.subjectType}|${g.subjectId}`));
  const [limit, setLimit] = useState(String(resource.limits?.monthlyCalls ?? "")), [days, setDays] = useState("keep");
  const options = [...members.map(m => ({ key: `user|${m.id}`, name: m.name })),
    ...groups.map(g => ({ key: `group|${g.id}`, name: `群组 · ${g.name}` }))];
  return <details className="zs-resource-settings"><summary>授权设置</summary>
    <form onSubmit={event => { event.preventDefault(); void save({
      expectedRevision: resource.revision, audienceMode: audience,
      grants: selected.map(key => { const [subjectType, subjectId] = key.split("|"); return { subjectType, subjectId }; }),
      monthlyCalls: limit === "" ? null : Number(limit),
      ...(days === "keep" ? {} : { ttlMs: days ? Number(days) * 86400000 : null })
    }); }}>
      <Field label="谁可以使用"><select value={audience} onChange={e => setAudience(e.target.value)}>
        <option value="space">空间所有成员</option><option value="specific">指定成员或群组</option></select></Field>
      {audience === "specific" && <div className="zs-checks">{options.map(option => <label key={option.key}>
        <input type="checkbox" checked={selected.includes(option.key)} onChange={e => setSelected(e.target.checked
          ? [...selected, option.key] : selected.filter(key => key !== option.key))} />{option.name}</label>)}</div>}
      <Field label="每月调用上限"><input type="number" min={0} step={1} value={limit} onChange={e => setLimit(e.target.value)} /></Field>
      <Field label="授权有效期"><select value={days} onChange={e => setDays(e.target.value)}>
        <option value="keep">保持现有期限</option><option value="">长期有效</option>
        {[1, 7, 30, 90].map(day => <option key={day} value={day}>{day} 天</option>)}</select></Field>
      <small>当前有效期：{resource.expiresAt ? date(resource.expiresAt) : "长期有效"}</small>
      <button className="zs-primary" disabled={busy || (audience === "specific" && !selected.length)}>保存授权</button>
    </form>
  </details>;
}

function SpacesWorkbench() {
  const identity = currentAccountSession()!;
  const baseUrl = readWorkbenchRuntimeConfig().baseUrl;
  const api = useRef(createSpacesClient({ baseUrl, spaceId: identity.space.id })).current;
  const [spaces, setSpaces] = useState<Row[]>(identity.spaces || []);
  const [open, setOpen] = useState(false), [panel, setPanel] = useState(new URL(location.href).searchParams.has("spaceInvite") ? "invite" : "");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [documentId, setDocumentId] = useState("");
  const [inviteToken, setInviteToken] = useState(new URL(location.href).searchParams.get("spaceInvite") || "");
  const [name, setName] = useState("");
  useEffect(() => {
    void api.list().then(result => setSpaces(result.spaces)).catch(error => setError(message(error)));
    const update = () => {
      const context = window.zion?.sessions?.resolveContext?.() as any;
      setDocumentId(String(context?.sessionId || window.zion?.state?.get?.("sessions.currentId") || ""));
    };
    update();
    const disposables = ["session/afterSwitch", "panel/focusChanged", "panel/tabsChanged"].map(topic => window.zion?.events?.on?.(topic, update));
    const timer = setInterval(update, 1500);
    return () => { clearInterval(timer); for (const disposable of disposables) disposable?.dispose?.(); };
  }, [api]);
  async function action(fn: () => Promise<void>) {
    setBusy(true); setError("");
    try { await fn(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  async function navigate(id: string) {
    await action(async () => {
      await window.zion?.commands?.executeCommand?.("zion.sessions.prepareForReload");
      location.assign(workbenchSpaceUrl(id));
    });
  }
  return <div className="zs-shell">
    <div className="zs-switcher">
      <button className="zs-space-button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {identity.space.kind === "team" ? <Users size={16} /> : <LockKeyhole size={16} />}
        <strong>{identity.space.kind === "personal" ? "个人空间" : identity.space.name}</strong><ChevronDown size={14} />
      </button>
      {open && <div className="zs-space-menu">
        <span className="zs-eyebrow">我的空间</span>
        {spaces.map(space => <button key={space.id} disabled={busy} onClick={() => { setOpen(false); void navigate(space.id); }}>
          {space.kind === "team" ? <Users size={16} /> : <LockKeyhole size={16} />}
          <span>{space.kind === "personal" ? "个人空间" : space.name}<small>{roles[space.membership?.role] || ""}</small></span>
          {space.id === identity.space.id && <Check size={15} />}
        </button>)}
        <div className="zs-divider" />
        <button onClick={() => { setOpen(false); setPanel("create"); }}><Plus size={16} />创建共享空间</button>
        <button onClick={() => { setOpen(false); setPanel("invite"); }}><Users size={16} />接受邀请</button>
      </div>}
    </div>
    <span className="zs-space-hint">{identity.space.kind === "team" ? "仅使用本空间授权的资源" : "你的会话与资源默认私密"}</span>
    <div className="zs-toolbar-actions">
      <button onClick={() => setPanel("contacts")}><Users size={15} /><span>联系人</span></button>
      <button onClick={() => setPanel("manage")}><Settings2 size={15} /><span>空间管理</span></button>
      <button className="zs-share" disabled={!documentId} onClick={() => setPanel("share")}><ArrowUpRight size={15} />分享文档</button>
    </div>
    {error && <div className="zs-toolbar-error" role="alert">{error}<button className="zs-icon" onClick={() => setError("")}><X size={14} /></button></div>}
    {panel === "create" && <Dialog title="创建共享空间" subtitle="邀请成员，共同使用你选择的模型、技能、插件和设备。" onClose={() => setPanel("")}>
      <form onSubmit={event => { event.preventDefault(); void action(async () => { const result = await api.create(name); location.assign(workbenchSpaceUrl(result.space.id)); }); }}>
        <Field label="空间名称"><input autoFocus required maxLength={160} placeholder="例如：一起生活" value={name} onChange={e => setName(e.target.value)} /></Field>
        <p className="zs-note">新空间不会自动继承个人会话或资源。创建后可逐项添加。</p>
        {error && <p role="alert" className="zs-error">{error}</p>}
        <footer><button type="button" onClick={() => setPanel("")}>取消</button><button className="zs-primary" disabled={busy}>{busy ? "创建中…" : "创建空间"}</button></footer>
      </form>
    </Dialog>}
    {panel === "invite" && <Dialog title="接受空间邀请" subtitle="邀请只能由指定的联系人使用。" onClose={() => setPanel("")}>
      <form onSubmit={event => { event.preventDefault(); void action(async () => {
        let token = inviteToken.trim(); try { token = new URL(token).searchParams.get("spaceInvite") || token; } catch {}
        const result = await api.accept(token); location.assign(workbenchSpaceUrl(result.space.id));
      }); }}>
        <Field label="邀请链接或代码"><input autoFocus required value={inviteToken} onChange={event => setInviteToken(event.target.value)} /></Field>
        {error && <p role="alert" className="zs-error">{error}</p>}
        <footer><button className="zs-primary" disabled={busy}>接受并进入</button></footer>
      </form>
    </Dialog>}
    {panel === "contacts" && <Contacts api={api} onClose={() => setPanel("")} />}
    {panel === "manage" && <SpaceManager api={api} identity={identity} baseUrl={baseUrl} onClose={() => setPanel("")} />}
    {panel === "share" && <DocumentSharing api={api} identity={identity} documentId={documentId} spaces={spaces}
      baseUrl={baseUrl} onClose={() => setPanel("")} />}
  </div>;
}

function Contacts({ api, onClose }: { api: ReturnType<typeof createSpacesClient>; onClose(): void }) {
  const [rows, setRows] = useState<Row[]>([]), [code, setCode] = useState(""), [own, setOwn] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const load = async () => { const value = await api.contacts(); setRows(value.contacts); setOwn(value.contactCode); };
  useEffect(() => { void load().catch(error => setError(message(error))); }, [api]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true); setError(""); try { await fn(); await load(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  return <Dialog title="联系人" subtitle="用联系人代码添加对方，再邀请到空间或分享文档。" onClose={onClose}>
    <div className="zs-contact-code"><span>我的联系人代码</span><code>{own}</code><CopyButton value={own} /></div>
    <form className="zs-inline-form" onSubmit={event => { event.preventDefault(); void action(() => api.addContact(code.trim())).then(() => setCode("")); }}>
      <input aria-label="对方的联系人代码" required placeholder="粘贴对方的联系人代码" value={code} onChange={event => setCode(event.target.value)} />
      <button disabled={busy}><Plus size={15} />添加</button>
    </form>
    {error && <p className="zs-error" role="alert">{error}</p>}
    {!rows.length && <Empty>还没有联系人。让对方复制自己的联系人代码发给你。</Empty>}
    {rows.map(row => <RowItem key={row.id} title={row.name} subtitle={row.id}>
      <button disabled={busy} onClick={() => void action(() => api.removeContact(row.id))}>移除</button>
    </RowItem>)}
  </Dialog>;
}

function SpaceManager({ api, identity, baseUrl, onClose }: {
  api: ReturnType<typeof createSpacesClient>; identity: any; baseUrl: string; onClose(): void
}) {
  const [tab, setTab] = useState("members"), [policy, setPolicy] = useState<Row>({});
  const [data, setData] = useState<Row>({}), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [recipient, setRecipient] = useState(""), [role, setRole] = useState("member"), [invite, setInvite] = useState("");
  const [groupName, setGroupName] = useState(""), [groupMembers, setGroupMembers] = useState<string[]>([]);
  const [origin, setOrigin] = useState(""), [sources, setSources] = useState<Row[]>([]), [sourceId, setSourceId] = useState("");
  const [root, setRoot] = useState(""), [tools, setTools] = useState<string[]>([]), [limit, setLimit] = useState("");
  const [resourceAudience, setResourceAudience] = useState("space"), [resourcePeople, setResourcePeople] = useState<string[]>([]);
  const [resourceDays, setResourceDays] = useState(""), [nextOwner, setNextOwner] = useState("");
  const [budgetScope, setBudgetScope] = useState("space"), [budgetLimit, setBudgetLimit] = useState("");
  const [search, setSearch] = useState("");
  const loadSequence = useRef(0);
  const manager = ["owner", "admin"].includes(identity.membership?.role), personal = identity.space.kind === "personal";
  const load = async () => {
    const sequence = ++loadSequence.current;
    const described = await api.describe();
    let next: Row = {};
    if (tab === "members") {
      const [members, invitations, contacts] = await Promise.all([api.get("members"),
        manager && !personal ? api.get("invitations") : { invitations: [] }, api.contacts()]);
      next = { ...members, ...invitations, ...contacts };
    } else if (tab === "groups") next = { ...(await api.get("groups")), ...(await api.get("members")) };
    else if (tab === "resources") next = { ...(await api.get("capabilities")), ...(await api.list()),
      ...(await api.get("members")), ...(await api.get("groups")) };
    else if (tab === "settings" && !personal) next = { ...(await api.get("members")), ...(await api.get("ownership")) };
    else if (tab === "usage") next = { ...(await api.get("usage")), ...(await api.get("members")) };
    else if (tab === "knowledge") next = await api.get("knowledge", new URLSearchParams({ q: search }).toString());
    else if (tab === "audit") next = await api.get("audit");
    if (sequence === loadSequence.current) { setPolicy(described.space); setData(next); }
  };
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    void load().catch(error => { if (active) setError(message(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [tab]);
  async function action(fn: () => Promise<unknown>, text = "已保存") {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); await load(); setNotice(text); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  const source = sources.find(row => `${row.kind}:${row.id}` === sourceId);
  return <Dialog title={personal ? "个人空间" : identity.space.name} subtitle={personal ? "仅你可以使用，默认私密。" : `${roles[identity.membership.role]} · 成员共同管理会话与已授权的资源`} onClose={onClose} wide>
    <div className="zs-manager">
      <nav aria-label="空间管理">{[
        ["members", "成员"], ["groups", "群组"], ["resources", "共享资源"], ["knowledge", "知识与记忆"], ["usage", "用量"], ["settings", "设置"], ["audit", "活动记录"]
      ].filter(([id]) => (!personal || ["members", "settings", "knowledge", "audit"].includes(id)) && (id !== "audit" || manager)).map(([id, label]) =>
        <button key={id} aria-current={tab === id ? "page" : undefined} onClick={() => { setData({}); setTab(id); }}>{label}</button>)}</nav>
      <section className="zs-content" aria-busy={loading || busy}>
        <div className="zs-section-heading"><h3>{({ members: "空间成员", groups: "成员群组", resources: "共享资源", knowledge: "知识与记忆", usage: "本月用量", settings: "空间设置", audit: "活动记录" } as Row)[tab]}</h3>
          <button className="zs-icon" aria-label="刷新" disabled={busy || loading} onClick={() => void action(load, "已刷新")}><RefreshCw size={15} /></button></div>
        {error && <p className="zs-error" role="alert">{error}</p>}{notice && <p className="zs-success" role="status">{notice}</p>}
        {loading ? <p className="zs-note">正在读取…</p> : <>
          {tab === "members" && <>
            {manager && !personal && <form className="zs-form-block" onSubmit={event => { event.preventDefault(); void action(async () => {
              const input = recipient.includes("@") ? { email: recipient } : { userId: recipient };
              const { invitation } = await api.mutate("invitations", "POST", { ...input, role });
              const url = new URL(baseUrl); url.searchParams.set("spaceInvite", invitation.token); setInvite(url.toString());
            }, "邀请已创建，请把链接发给对方"); }}>
              <Field label="邀请联系人"><input list="zs-contact-list" required placeholder="联系人代码或已验证的邮箱" value={recipient} onChange={e => setRecipient(e.target.value)} />
                <datalist id="zs-contact-list">{(data.contacts || []).map((c: Row) => <option key={c.id} value={c.id}>{c.name}</option>)}</datalist></Field>
              <Field label="成员权限"><select value={role} onChange={e => setRole(e.target.value)}>{(identity.membership.role === "owner" ? ["member", "viewer", "admin"] : ["member", "viewer"]).map(r => <option key={r} value={r}>{roles[r]}</option>)}</select></Field>
              <button disabled={busy} className="zs-primary">创建邀请</button>
              {invite && <div className="zs-link"><input aria-label="邀请链接" readOnly value={invite} /><CopyButton value={invite} /></div>}
            </form>}
            {(data.members || []).map((member: Row) => <RowItem key={member.id} title={`${member.name}${member.id === identity.user.id ? "（你）" : ""}`} subtitle={roles[member.role]}>
              {manager && member.role !== "owner" && member.id !== identity.user.id && <select aria-label={`${member.name}的权限`} disabled={busy || (member.role === "admin" && identity.membership.role !== "owner")}
                value={member.role} onChange={event => void action(() => api.mutate(`members/${enc(member.id)}`, "PATCH", { role: event.target.value, expectedRevision: member.revision }))}>
                {(identity.membership.role === "owner" ? ["member", "viewer", "admin"] : ["member", "viewer"]).map(r => <option key={r} value={r}>{roles[r]}</option>)}
              </select>}
              {manager && member.role !== "owner" && member.id !== identity.user.id && <button disabled={busy} onClick={() => void action(() =>
                api.mutate(`members/${enc(member.id)}`, "PATCH", { role: member.role, status: "removed", expectedRevision: member.revision }), "已移除成员，现有访问将失效")}>移除</button>}
            </RowItem>)}
            {(data.invitations || []).filter((row: Row) => row.status === "pending").map((row: Row) =>
              <RowItem key={row.id} title={row.email || row.userId || "待接受邀请"} subtitle={`${roles[row.role]} · 有效至 ${date(row.expiresAt)}`}>
                <button disabled={busy} onClick={() => void action(() => api.mutate(`invitations/${enc(row.id)}`, "DELETE"), "邀请已撤销")}>撤销邀请</button>
              </RowItem>)}
          </>}
          {tab === "groups" && <>
            <p className="zs-note">分享给群组后，成员变更会同步影响文档和资源访问。</p>
            {manager && <form className="zs-form-block" onSubmit={event => { event.preventDefault(); void action(() => api.mutate("groups", "POST", { name: groupName, members: groupMembers }), "群组已创建"); }}>
              <Field label="群组名称"><input required value={groupName} onChange={e => setGroupName(e.target.value)} placeholder="例如：家人" /></Field>
              <div className="zs-checks">{(data.members || []).map((m: Row) => <label key={m.id}><input type="checkbox" checked={groupMembers.includes(m.id)}
                onChange={e => setGroupMembers(e.target.checked ? [...groupMembers, m.id] : groupMembers.filter(id => id !== m.id))} />{m.name}</label>)}</div>
              <button disabled={busy} className="zs-primary">创建群组</button>
            </form>}
            {!(data.groups || []).length && <Empty>还没有群组。</Empty>}
            {(data.groups || []).map((g: Row) => <div className="zs-group" key={g.id}>
              <RowItem title={g.name} subtitle={`${g.members.length} 位成员`}>{manager && <button disabled={busy} onClick={() => void action(() => api.mutate(`groups/${enc(g.id)}`, "DELETE"))}>删除</button>}</RowItem>
              {manager && <div className="zs-checks">{(data.members || []).map((m: Row) => <label key={m.id}><input type="checkbox" disabled={busy} checked={g.members.includes(m.id)}
                onChange={e => void action(() => api.mutate(`groups/${enc(g.id)}`, "PUT", { name: g.name, expectedRevision: g.revision,
                  members: e.target.checked ? [...g.members, m.id] : g.members.filter((id: string) => id !== m.id) }))} />{m.name}</label>)}</div>}
            </div>)}
          </>}
          {tab === "resources" && <>
            <p className="zs-note">只显示本空间可用的资源。提供者的密钥和个人配置保留在来源空间。</p>
            {(data.capabilities || []).map((r: Row) => <RowItem key={r.id} title={r.name}
              subtitle={`${kinds[r.kind]} · ${r.provider?.name || ""} · ${r.status === "active" ? "可用" : r.status === "disabled" ? "已暂停" : "已撤销"}${r.limits?.monthlyCalls != null ? ` · ${r.limits.monthlyCalls} 次/月` : ""}`}>
              {manager && r.kind === "model" && r.status === "active" && r.audienceMode === "space" && <button disabled={busy}
                onClick={() => void action(() => api.update({ expectedRevision: policy.revision, defaultBindingId: r.id }))}>{policy.defaultBindingId === r.id ? "默认模型" : "设为默认"}</button>}
              {manager && r.status !== "revoked" && (r.status === "active" || r.provider?.id === identity.user.id) && <button disabled={busy} onClick={() => void action(() => api.mutate(`capabilities/${enc(r.id)}`, "PATCH",
                { expectedRevision: r.revision, status: r.status === "active" ? "disabled" : "active" }))}>{r.status === "active" ? "暂停" : "恢复"}</button>}
              {manager && r.status !== "revoked" && <button disabled={busy} onClick={() => void action(() => api.mutate(`capabilities/${enc(r.id)}`, "PATCH",
                { expectedRevision: r.revision, status: "revoked" }), "授权已撤销")}>撤销</button>}
              {r.provider?.id === identity.user.id && r.status !== "revoked" && <ResourceSettings key={`${r.id}:${r.revision}`} resource={r}
                members={data.members || []} groups={data.groups || []} busy={busy}
                save={body => action(() => api.mutate(`capabilities/${enc(r.id)}`, "PATCH", body))} />}
            </RowItem>)}
            {!(data.capabilities || []).length && <Empty>尚未添加共享资源。管理员可以从自己的个人空间逐项授权。</Empty>}
            {manager && <form className="zs-form-block" onSubmit={event => { event.preventDefault(); if (!source) return; void action(() => api.mutate("capabilities", "POST", {
              originSpaceId: origin, originResourceId: source.id, kind: source.kind, name: source.name, transferApproved: true,
              audienceMode: resourceAudience, grants: resourcePeople.map(key => { const [subjectType, subjectId] = key.split("|"); return { subjectType, subjectId }; }),
              allowedTools: tools.length ? tools : undefined, dedicatedRoot: root || undefined,
              limits: { monthlyCalls: limit === "" ? null : Number(limit) }, ttlMs: resourceDays ? Number(resourceDays) * 86400000 : undefined
            }), "资源已加入空间"); }}>
              <h4>添加资源</h4>
              <Field label="来源空间"><select required value={origin} onChange={event => {
                const id = event.target.value; setOrigin(id); setSources([]); setSourceId(""); setRoot(""); setTools([]);
                if (id) void action(async () => setSources((await api.get("sources", new URLSearchParams({ origin: id }).toString())).sources), "");
              }}><option value="">选择你的个人空间</option>{(data.spaces || []).filter((s: Row) => s.membership?.role === "owner" && s.kind === "personal").map((s: Row) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
              <Field label="资源"><select required value={sourceId} onChange={event => { setSourceId(event.target.value); setTools([]); }}>
                <option value="">选择要共享的资源</option>{sources.map(s => <option key={`${s.kind}:${s.id}`} value={`${s.kind}:${s.id}`}>{kinds[s.kind]} · {s.name}</option>)}</select></Field>
              {source?.requiresDedicatedRoot && <>
                <Field label="专用共享目录" hint="只授权这个目录。插件需要与已验证的工作目录一致。"><input required placeholder="/shared/workspace" value={root} onChange={event => setRoot(event.target.value)} /></Field>
                <div className="zs-checks">{(source.tools || []).map((tool: string) => <label key={tool}><input type="checkbox" checked={tools.includes(tool)}
                  onChange={event => setTools(event.target.checked ? [...tools, tool] : tools.filter(t => t !== tool))} /><code>{tool}</code></label>)}</div>
              </>}
              <Field label="月度调用上限" hint="留空为不单独限制；空间和成员预算仍然生效。"><input type="number" min={0} step={1} value={limit} onChange={e => setLimit(e.target.value)} /></Field>
              <Field label="使用范围"><select value={resourceAudience} onChange={e => setResourceAudience(e.target.value)}><option value="space">空间所有成员</option><option value="specific">指定成员或群组</option></select></Field>
              {resourceAudience === "specific" && <div className="zs-checks">{[
                ...(data.members || []).map((m: Row) => ({ key: `user|${m.id}`, name: m.name })),
                ...(data.groups || []).map((g: Row) => ({ key: `group|${g.id}`, name: `群组 · ${g.name}` }))
              ].map(option => <label key={option.key}><input type="checkbox" checked={resourcePeople.includes(option.key)} onChange={e => setResourcePeople(e.target.checked
                ? [...resourcePeople, option.key] : resourcePeople.filter(key => key !== option.key))} />{option.name}</label>)}</div>}
              <Field label="授权有效期"><select value={resourceDays} onChange={e => setResourceDays(e.target.value)}><option value="">长期有效</option>{[1, 7, 30, 90].map(day => <option key={day} value={day}>{day} 天</option>)}</select></Field>
              <p className="zs-note">添加后，本空间的成员可使用所选资源；调用数据会发送给资源提供方，并记录用量。</p>
              <button className="zs-primary" disabled={busy || !source || (!!source.requiresDedicatedRoot && !tools.length) || (resourceAudience === "specific" && !resourcePeople.length)}>授权给此空间</button>
            </form>}
          </>}
          {tab === "knowledge" && <>
            <p className="zs-note">会话记忆按文档隔离。只有经过检查的知识摘要会进入空间知识；检索仍遵循原文权限。</p>
            <form className="zs-inline-form" onSubmit={event => { event.preventDefault(); void action(load, ""); }}><input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索知识摘要" aria-label="搜索知识" /><button disabled={busy}><Search size={15} />搜索</button></form>
            {!(data.sources || []).length && <Empty>还没有可见的知识摘要。在文档的分享面板中可选择“加入空间知识”。</Empty>}
            {(data.sources || []).map((s: Row) => <RowItem key={s.id} title={s.title} subtitle={s.text || s.projectionText || "已检查的文档摘要"}>
              <a href={workbenchSpaceUrl(identity.space.id, s.documentId)}>打开原文</a>
              {manager && <button disabled={busy} onClick={() => void action(() => api.mutate(`knowledge/${enc(s.id)}`, "DELETE"))}>移除</button>}
            </RowItem>)}
          </>}
          {tab === "usage" && <>
            <p className="zs-note">按模型或工具调用计数。运行前预留，结果确认后结算；未知结果保留占用，避免重复执行。</p>
            {(data.budgets || []).map((b: Row) => <RowItem key={b.scopeKey} title={b.scopeKey === "space" ? "整个空间" : (data.members || []).find((m: Row) => `member:${m.id}` === b.scopeKey)?.name || b.scopeKey}
              subtitle={`已用 ${b.committed} · 预留 ${b.reserved} · 上限 ${b.hardLimit}`} />)}
            {manager && <form className="zs-form-block" onSubmit={event => { event.preventDefault(); const previous = (data.budgets || []).find((b: Row) => b.scopeKey === budgetScope);
              void action(() => api.mutate("budgets", "PUT", { scopeKey: budgetScope, hardLimit: Number(budgetLimit), expectedRevision: previous?.revision || 0 })); }}>
              <Field label="预算范围"><select value={budgetScope} onChange={event => setBudgetScope(event.target.value)}><option value="space">整个空间</option>
                {(data.members || []).map((m: Row) => <option key={m.id} value={`member:${m.id}`}>{m.name}</option>)}</select></Field>
              <Field label="本月调用上限"><input type="number" required min={0} step={1} value={budgetLimit} onChange={event => setBudgetLimit(event.target.value)} /></Field>
              <button className="zs-primary" disabled={busy}>保存预算</button>
            </form>}
            <h4>最近调用</h4>
            {(data.reservations || []).map((r: Row) => <RowItem key={r.id} title={`${kinds[r.kind] || "调用"} · ${r.state}`}
              subtitle={`预留 ${r.ceiling || 0} · 实际 ${r.actual ?? "待确认"}`} />)}
            {!(data.reservations || []).length && <Empty>本月还没有调用记录。</Empty>}
          </>}
          {tab === "settings" && <><form onSubmit={event => { event.preventDefault(); void action(() => api.update({
            expectedRevision: policy.revision, name: policy.name, allowExternal: !!policy.allowExternal, allowPublic: !!policy.allowPublic
          })); }}>
            <Field label="空间名称"><input required disabled={!manager || personal} value={policy.name || ""} onChange={e => setPolicy({ ...policy, name: e.target.value })} /></Field>
            {!personal && <>
              <label className="zs-toggle"><input type="checkbox" disabled={!manager} checked={!!policy.allowExternal} onChange={e => setPolicy({ ...policy, allowExternal: e.target.checked })} /><span>允许分享给空间外的指定联系人<small>外部访客只能查看或评论指定文档。</small></span></label>
              <label className="zs-toggle"><input type="checkbox" disabled={!manager} checked={!!policy.allowPublic} onChange={e => setPolicy({ ...policy, allowPublic: e.target.checked })} /><span>允许发布公开阅读副本<small>每次发布都要检查正文和附件；关闭后现有链接失效。</small></span></label>
              {manager && <button className="zs-primary" disabled={busy}>保存设置</button>}
            </>}
            {personal && <p className="zs-note">个人空间的会话只属于你。要共同使用，请在空间菜单创建共享空间。</p>}
          </form>
            {!personal && identity.membership.role === "owner" && <form className="zs-form-block" onSubmit={event => {
              event.preventDefault(); void action(() => api.mutate("ownership", "POST", { toUserId: nextOwner }), "所有权邀请已发出，等待对方接受");
            }}><h4>转交空间所有权</h4><p className="zs-note">指定成员接受后成为所有者，你将保留管理员权限。</p>
              <Field label="新所有者"><select required value={nextOwner} onChange={e => setNextOwner(e.target.value)}><option value="">选择成员</option>
                {(data.members || []).filter((m: Row) => m.id !== identity.user.id).map((m: Row) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
              <button disabled={busy || !nextOwner}>发送转交邀请</button></form>}
            {(data.transfers || []).map((transfer: Row) => <RowItem key={transfer.id} title="待接受的所有权邀请" subtitle={`有效至 ${date(transfer.expiresAt)}`}>
              {transfer.toUserId === identity.user.id && <button disabled={busy} onClick={() => void action(async () => {
                await api.mutate(`ownership/${enc(transfer.id)}/accept`, "POST", {}); location.reload();
              })}>接受所有权</button>}</RowItem>)}
          </>}
          {tab === "audit" && <>
            {(data.events || []).map((event: Row) => <RowItem key={event.sequence || event.id} title={event.action} subtitle={`${date(event.createdAt)} · ${event.actorName || event.actorId || ""}`} />)}
            {!(data.events || []).length && <Empty>尚无活动记录。</Empty>}
          </>}
        </>}
      </section>
    </div>
  </Dialog>;
}

function DocumentSharing({ api, identity, documentId, spaces, baseUrl, onClose }: {
  api: ReturnType<typeof createSpacesClient>; identity: any; documentId: string; spaces: Row[]; baseUrl: string; onClose(): void
}) {
  const [tab, setTab] = useState("access"), [snapshot, setSnapshot] = useState<Row | null>(null);
  const [members, setMembers] = useState<Row[]>([]), [groups, setGroups] = useState<Row[]>([]), [contacts, setContacts] = useState<Row[]>([]);
  const [grants, setGrants] = useState<Row[]>([]), [protection, setProtection] = useState("restricted"), [audience, setAudience] = useState("specific");
  const [subject, setSubject] = useState(""), [grantRole, setGrantRole] = useState("viewer"), [comments, setComments] = useState<Row[]>([]), [comment, setComment] = useState("");
  const [reviewedText, setReviewedText] = useState(""), [title, setTitle] = useState(""), [destination, setDestination] = useState("");
  const [reviewed, setReviewed] = useState(false), [assets, setAssets] = useState<string[]>([]), [mode, setMode] = useState("copy");
  const [publications, setPublications] = useState<Row[]>([]), [link, setLink] = useState(""), [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const load = async () => {
    const doc = await api.document(documentId);
    setSnapshot(doc); setGrants(doc.grants || []); setProtection(doc.document.protection); setAudience(doc.document.audienceMode);
    const [memberData, groupData, contactData, commentData] = await Promise.all([
      api.get("members"), api.get("groups"), api.contacts(), api.document(documentId, "comments")]);
    setMembers(memberData.members); setGroups(groupData.groups); setContacts(contactData.contacts); setComments(commentData.comments);
    if (doc.access.role === "manager") setPublications((await api.document(documentId, "publications")).publications);
    return doc;
  };
  useEffect(() => { void load().catch(error => setError(message(error))); }, [documentId]);
  async function action(fn: () => Promise<unknown>, text = "已保存", refresh = true) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); if (refresh) await load(); setNotice(text); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  const manager = snapshot?.access?.role === "manager", personal = identity.space.kind === "personal";
  const assetIds = [...new Set([...String(snapshot?.content?.text || "").matchAll(/zion-asset:\/\/([A-Za-z0-9_-]+)/g)].map(m => m[1]))];
  async function beginReview(nextTab: string) {
    await action(async () => {
      await window.zion?.commands?.executeCommand?.("zion.sessions.flushRunInput", documentId);
      const doc = await load(); setTitle(doc.content.title); setReviewedText(doc.content.text); setAssets([]); setReviewed(false); setLink("");
      requestId.current = crypto.randomUUID(); setTab(nextTab);
    }, "", false);
  }
  return <Dialog title="分享文档" subtitle={snapshot ? `${protections[snapshot.document.protection]} · 你${roles[snapshot.access.role] || "可查看"}` : "正在读取文档权限…"} onClose={onClose} wide>
    <div className="zs-sharing-tabs" role="tablist">{[
      ["access", "访问权限"], ["comments", "评论"], ...(manager ? [["transfer", "共享副本"], ["knowledge", "加入空间知识"], ["publish", "公开发布"]] : [])
    ].map(([id, label]) => <button role="tab" key={id} aria-selected={tab === id} disabled={busy}
      onClick={() => ["transfer", "knowledge", "publish"].includes(id) ? void beginReview(id) : setTab(id)}>{label}</button>)}</div>
    <div className="zs-sharing-body">
      {error && <p className="zs-error" role="alert">{error}</p>}{notice && <p className="zs-success" role="status">{notice}</p>}
      {snapshot && tab === "access" && <>
        {personal && <p className="zs-note">这篇文档位于个人空间。要与他人协作，请通过“共享副本”把检查过的内容放入共享空间。</p>}
        <Field label="安全等级"><select disabled={!manager || personal || busy} value={protection} onChange={event => {
          setProtection(event.target.value); if (event.target.value === "restricted") { setAudience("specific"); setGrants(grants.filter(g => g.subjectType === "user")); }
        }}>{Object.entries(protections).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field>
        <Field label="谁可以访问"><select value={audience} disabled={!manager || protection === "restricted" || busy || personal} onChange={event => setAudience(event.target.value)}>
          <option value="specific">仅以下指定的人或群组</option><option value="space">空间的所有成员</option></select></Field>
        <p className="zs-note">{audience === "space" ? "新加入空间的成员也能访问；管理员可管理，成员可编辑，只读成员可查看。" : "空间管理员不会自动获得这篇文档的访问权。"}</p>
        {grants.map((g: Row) => <RowItem key={`${g.subjectType}:${g.subjectId}`} title={(g.subjectType === "group" ? groups : [...members, ...contacts]).find(m => m.id === g.subjectId)?.name || g.subjectId}
          subtitle={g.subjectType === "group" ? "群组" : "联系人"}>
          <select disabled={!manager || personal || busy} aria-label="文档权限" value={g.role} onChange={event => setGrants(grants.map(row => row === g ? { ...row, role: event.target.value } : row))}>
            {(g.subjectType === "user" && !members.some(m => m.id === g.subjectId) ? ["viewer", "commenter"] : ["viewer", "commenter", "editor", "manager"]).map(r => <option key={r} value={r}>{r === "viewer" ? "可查看" : roles[r]}</option>)}</select>
          {manager && !personal && <button disabled={busy} onClick={() => setGrants(grants.filter(row => row !== g))}>移除</button>}
        </RowItem>)}
        {manager && !personal && <>
          <div className="zs-inline-form"><select aria-label="添加共享对象" value={subject} onChange={e => setSubject(e.target.value)}>
            <option value="">添加联系人或群组</option>{[...members, ...(protection === "external" ? contacts.filter(c => !members.some(m => m.id === c.id)) : [])].map(m => <option key={m.id} value={`user|${m.id}`}>{m.name}</option>)}
            {protection !== "restricted" && groups.map(g => <option key={g.id} value={`group|${g.id}`}>群组 · {g.name}</option>)}
          </select><select value={grantRole} aria-label="新增对象的权限" onChange={e => setGrantRole(e.target.value)}>{(subject.startsWith("user|") && !members.some(m => `user|${m.id}` === subject) ? ["viewer", "commenter"] : ["viewer", "commenter", "editor", "manager"]).map(r => <option key={r} value={r}>{r === "viewer" ? "可查看" : roles[r]}</option>)}</select>
            <button disabled={!subject || busy} onClick={() => { const [subjectType, subjectId] = subject.split("|");
              const external = subjectType === "user" && !members.some(m => m.id === subjectId);
              const role = external && !["viewer", "commenter"].includes(grantRole) ? "viewer" : grantRole;
              if (!grants.some(g => g.subjectType === subjectType && g.subjectId === subjectId)) setGrants([...grants, { subjectType, subjectId, role }]); setSubject(""); }}>添加</button></div>
          <footer><button className="zs-primary" disabled={busy} onClick={() => void action(() => api.mutateDocument(documentId, "access", "PUT", {
            expectedRevision: snapshot.document.aclRevision, protection, audienceMode: audience, grants
          }), "分享设置已保存，现有连接会重新校验权限")}>保存分享设置</button></footer>
        </>}
        <div className="zs-link"><input aria-label="文档链接" readOnly value={sharedDocumentUrl(baseUrl, identity.space.id, documentId)} /><CopyButton value={sharedDocumentUrl(baseUrl, identity.space.id, documentId)} /></div>
      </>}
      {snapshot && tab === "comments" && <>
        {!comments.length && <Empty>还没有评论。</Empty>}
        {comments.map(c => <div className="zs-comment" key={c.id}><RowItem title={c.authorName || members.find(m => m.id === c.authorId)?.name || c.authorId} subtitle={date(c.createdAt)}>
          {(c.authorId === identity.user.id || manager) && <button disabled={busy} onClick={() => void action(() => api.mutateDocument(documentId, `comments/${enc(c.id)}`, "DELETE"))}>删除</button>}</RowItem><p>{c.body}</p></div>)}
        {["commenter", "editor", "manager"].includes(snapshot.access.role) && <form onSubmit={event => { event.preventDefault(); void action(async () => {
          await api.mutateDocument(documentId, "comments", "POST", { body: comment }); setComment("");
        }, "评论已添加"); }}><Field label="添加评论"><textarea required value={comment} onChange={event => setComment(event.target.value)} /></Field><button className="zs-primary" disabled={busy}>评论</button></form>}
      </>}
      {snapshot && manager && ["transfer", "knowledge", "publish"].includes(tab) && <>
        <p className="zs-note">{tab === "transfer" ? "检查下面的内容后创建一篇新文档。新文档只向你开放，之后可设置成员权限。"
          : tab === "knowledge" ? "选择适合复用的知识摘要。摘要不会扩大原文的访问范围，原文变更后需要重新检查。"
          : "发布一份固定版本的阅读副本。任何获得链接的人都能阅读；后续原文编辑不会更新副本。"}</p>
        <Field label={tab === "knowledge" ? "知识标题" : "副本标题"}><input value={title} required onChange={e => { setTitle(e.target.value); setReviewed(false); requestId.current = crypto.randomUUID(); }} /></Field>
        {tab === "transfer" && <div className="zs-two-fields">
          <Field label="目标空间"><select required value={destination} onChange={e => { setDestination(e.target.value); requestId.current = crypto.randomUUID(); }}>
            <option value="">选择共享空间</option>{spaces.filter(s => s.kind === "team" && s.membership?.role !== "viewer").map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="处理方式"><select value={mode} onChange={e => { setMode(e.target.value); setReviewed(false); requestId.current = crypto.randomUUID(); }}>
            <option value="copy">保留原文，创建副本</option><option value="move">移动文档，原文链接失效</option></select></Field>
        </div>}
        {tab === "publish" && <Field label="链接有效期"><select value={days} onChange={e => setDays(e.target.value)}>
          <option value="1">1 天</option><option value="7">7 天</option><option value="30">30 天</option></select></Field>}
        <Field label={tab === "knowledge" ? "要加入空间的知识摘要" : "要分享的正文"} hint="可在这里删掉不适合分享的内容。此处修改不会改变原文。">
          <textarea className="zs-review-text" value={reviewedText} onChange={e => { setReviewedText(e.target.value); setReviewed(false); requestId.current = crypto.randomUUID(); }} />
        </Field>
        {!!assetIds.length && tab !== "knowledge" && <div className="zs-assets"><h4>选择允许带入副本的图片</h4>
          {assetIds.map(id => <label key={id}><input type="checkbox" checked={assets.includes(id)} onChange={e => { setAssets(e.target.checked ? [...assets, id] : assets.filter(a => a !== id)); setReviewed(false); requestId.current = crypto.randomUUID(); }} />
            <span>图片 <code>{id}</code></span><AssetPreview baseUrl={baseUrl} spaceId={identity.space.id} assetId={id} /></label>)}
        </div>}
        <label className="zs-toggle"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} /><span>我已检查正文和所选附件{mode === "move" && tab === "transfer" && "，并确认原文将被移除"}</span></label>
        <footer><button disabled={busy} onClick={() => void beginReview(tab)}>重新读取原文</button>
          <button className="zs-primary" disabled={busy || !reviewed || !title.trim() || !reviewedText.trim() || (tab === "transfer" && !destination)}
            onClick={() => void action(async () => {
              if (tab === "transfer") {
                const result = await api.transfer(destination, { requestId: requestId.current, sourceSpaceId: identity.space.id, sourceDocumentId: documentId,
                  sourceRevision: snapshot.content.revision, sourceAclRevision: snapshot.document.aclRevision, title, markdown: reviewedText, reviewed: true, mode, approvedAssetIds: assets });
                setLink(workbenchSpaceUrl(destination, result.document.id)); setReviewed(false);
              } else if (tab === "knowledge") {
                await api.mutateDocument(documentId, "knowledge", "POST", { sourceRevision: snapshot.content.revision, title, text: reviewedText, reviewed: true }); setReviewed(false);
              } else {
                const result = await api.mutateDocument(documentId, "publications", "POST", { sourceRevision: snapshot.content.revision, title, markdown: reviewedText, reviewed: true,
                  approvedAssetIds: assets, ttlMs: Number(days) * 86400000 }); setLink(new URL(result.publication.path, baseUrl).toString()); setReviewed(false);
                setPublications((await api.document(documentId, "publications")).publications);
              }
            }, tab === "transfer" ? "共享副本已创建，仅你可访问。进入副本后设置分享权限。" : tab === "knowledge" ? "知识摘要已加入空间。" : "阅读副本已发布。", false)}>
            {busy ? "处理中…" : tab === "transfer" ? (mode === "move" ? "确认移动" : "创建共享副本") : tab === "knowledge" ? "加入空间知识" : "发布阅读副本"}
          </button></footer>
        {link && <div className="zs-link"><input aria-label="副本链接" readOnly value={link} /><CopyButton value={link} /><a target="_blank" rel="noopener noreferrer" href={link}>打开 <ArrowUpRight size={14} /></a></div>}
        {tab === "publish" && publications.filter(p => p.status === "active").map(p => <RowItem key={p.id} title={p.title} subtitle={`有效至 ${date(p.expiresAt)}`}>
          <a target="_blank" rel="noopener noreferrer" href={new URL(p.path || `/p/${p.id}`, baseUrl).toString()}>查看副本</a>
          <button disabled={busy} onClick={() => void action(() => api.mutate(`publications/${enc(p.id)}`, "DELETE"), "公开链接已撤销")}>撤销</button>
        </RowItem>)}
      </>}
    </div>
  </Dialog>;
}

export function mountSpacesWorkbench(host: HTMLElement) {
  if (!currentAccountSession()) return null;
  const mount = document.createElement("div"); mount.className = "zion-spaces-mount";
  host.prepend(mount);
  host.classList.add("zion-has-spaces");
  const root = createRoot(mount); root.render(<SpacesWorkbench />);
  return { dispose() { root.unmount(); mount.remove(); host.classList.remove("zion-has-spaces"); } };
}
