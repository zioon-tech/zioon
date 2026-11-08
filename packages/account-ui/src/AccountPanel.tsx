import {
  ArrowRight,
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  KeyRound,
  LoaderCircle,
  LogIn,
  LogOut,
  RefreshCw,
  ShieldCheck,
  UserMinus,
  UserPlus,
  Users
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  accountLoginUrl, accountRequest, AccountHttpError, clearInvitation,
  pendingInvitation, setAccountSession, type AccountSession
} from "./client";
import { ZionMark } from "./ZionMark";
import { WebsiteFiling } from "./WebsiteFiling";
import "./account.css";

type Member = { id: string; name: string; email: string; role: string; status: string };
type Login = { id: string; createdAt: number; expiresAt: number };
type Grant = {
  id: string; userId: string; userName: string; purpose: string; sourceId: string;
  profileId: string; expiresAt: number; revokedAt: number | null;
};
type AccountTab = "overview" | "members" | "grants";
export type AccountPanelVariant = "gate" | "workbench" | "mobile";

const roles: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员", viewer: "访客（只读）" };
const dateTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false
});
const time = (value: number) => dateTime.format(new Date(value));
const initials = (value: string) => Array.from(String(value || "Z").trim()).slice(0, 2).join("").toUpperCase();
const errorText = (error: unknown) => {
  const code = error instanceof Error ? error.message : String(error);
  return ({
    last_owner: "至少需要保留一位所有者。",
    invalid_invitation: "邀请已失效或已被使用，请向管理员索取新邀请。",
    authentication_required: "登录已过期，请重新登录。",
    permission_denied: "当前账号没有执行此操作的权限。",
    space_runtime_mismatch: "当前账号未连接到这个 Zion，请从邀请或对应地址进入。"
  } as Record<string, string>)[code] || code;
};

export function AccountPanel({
  baseUrl = "", returnTo = location.pathname + location.search,
  onContinue, onLogin, variant = "workbench"
}: {
  baseUrl?: string;
  returnTo?: string;
  onContinue?: (session: AccountSession) => void;
  onLogin?: (url: string) => void;
  variant?: AccountPanelVariant;
}) {
  const [me, setMe] = useState<AccountSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invitation, setInvitation] = useState(pendingInvitation);
  const [inviteRole, setInviteRole] = useState("member");
  const [inviteResult, setInviteResult] = useState<{ url: string; expiresAt: number } | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [sessions, setSessions] = useState<Login[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [page, setPage] = useState(0);
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<AccountTab>("overview");
  const [loginPhase, setLoginPhase] = useState<"redirecting" | "manual">("redirecting");
  const [loginError, setLoginError] = useState("");
  const loginStarted = useRef(false);
  const loginTimeout = useRef<number | null>(null);
  const request = useCallback(<T,>(path: string, body?: unknown, method?: string) =>
    accountRequest<T>(baseUrl, path, body, method), [baseUrl]);
  const beginLogin = useCallback(() => {
    loginStarted.current = true;
    setLoginError("");
    setLoginPhase("redirecting");
    if (loginTimeout.current !== null) window.clearTimeout(loginTimeout.current);
    loginTimeout.current = window.setTimeout(() => {
      setLoginPhase("manual");
      loginTimeout.current = null;
    }, 4_500);
    try {
      const url = accountLoginUrl(baseUrl, returnTo);
      if (onLogin) onLogin(url);
      else location.replace(url);
    } catch (reason) {
      if (loginTimeout.current !== null) window.clearTimeout(loginTimeout.current);
      loginTimeout.current = null;
      setLoginPhase("manual");
      setLoginError(errorText(reason));
    }
  }, [baseUrl, onLogin, returnTo]);
  const refresh = useCallback(async () => {
    setError("");
    try {
      const account = await request<AccountSession>("me");
      setMe(account);
      setAccountSession(account);
      const [logins, people, permissions] = await Promise.all([
        request<{ sessions: Login[] }>("sessions"),
        account.space.kind === "team" && account.scopes.includes("members.manage")
          ? request<{ members: Member[] }>("members") : Promise.resolve({ members: [] }),
        account.scopes.includes("runtime.read")
          ? request<{ grants: Grant[] }>(`grants?limit=20&offset=${page * 20}`)
          : Promise.resolve({ grants: [] })
      ]);
      setSessions(logins.sessions);
      setMembers(people.members);
      setGrants(permissions.grants);
    } catch (reason) {
      if (reason instanceof AccountHttpError && reason.status === 401) {
        setMe(null);
        setAccountSession(null);
      } else setError(errorText(reason));
    } finally { setLoading(false); }
  }, [request, page]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => {
    if (loginTimeout.current !== null) window.clearTimeout(loginTimeout.current);
  }, []);
  useEffect(() => {
    if (loading || me || error || loginPhase === "manual" || loginStarted.current) return;
    beginLogin();
  }, [beginLogin, error, loading, loginPhase, me]);
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await refresh(); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      await request("logout", {});
      clearInvitation();
      setAccountSession(null);
      beginLogin();
    } catch (reason) {
      setError(errorText(reason));
      setBusy(false);
    }
  };
  const active = me?.membership?.status === "active";
  const mayManage = me?.space.kind === "team"
    && me.scopes.includes("members.manage");
  const tabs = useMemo(() => [
    { id: "overview" as const, label: "账号" },
    ...(mayManage ? [{ id: "members" as const, label: "成员", count: members.length }] : []),
    ...(active ? [{ id: "grants" as const, label: "授权", count: grants.length }] : [])
  ], [active, grants.length, mayManage, members.length]);

  useEffect(() => {
    if (!tabs.some((item) => item.id === tab)) setTab("overview");
  }, [tab, tabs]);

  if (loading) {
    return <div className={`zion-account zion-account--${variant} is-loading`} role="status">
      <LoaderCircle className="zion-account-spin" size={20} aria-hidden="true" />
      <span>正在检查登录状态</span>
    </div>;
  }

  if (!me) {
    const statusError = Boolean(error && !loginStarted.current);
    const redirecting = loginPhase === "redirecting" && !statusError;
    const title = statusError
      ? "无法确认登录状态"
      : redirecting
        ? "正在转到安全登录"
        : "未能打开登录页";
    const description = statusError
      ? "暂时无法检查账号状态，请稍后重试。"
      : redirecting
        ? invitation ? "正在保留邀请并打开登录页。" : "即将使用你的 Zion 账号继续。"
        : "浏览器没有完成跳转，请重试。";
    return <main className={`zion-account zion-account--${variant} is-gate`}>
      <div className="zion-account-gate-bar">
        <ZionMark className="zion-account-mark" />
        <strong>Zion</strong>
        <span className="zion-account-gate-status">Workbench</span>
      </div>
      <div className={`zion-account-gate-content ${redirecting ? "is-redirecting" : ""}`}
        role="status" aria-live="polite">
        <div className="zion-account-gate-icon">
          {redirecting
            ? <LoaderCircle className="zion-account-spin" size={20} aria-hidden="true" />
            : <ShieldCheck size={22} aria-hidden="true" />}
        </div>
        <h1>{title}</h1>
        <p>{description}</p>
        {statusError
          ? <button className="zion-account-button" disabled={busy} onClick={() => void refresh()}>
            <RefreshCw size={16} aria-hidden="true" />
            重试
          </button>
          : !redirecting
            ? <button className="zion-account-button is-primary" disabled={busy} onClick={beginLogin}>
              <LogIn size={16} aria-hidden="true" />
              重新打开登录页
            </button>
            : null}
        {statusError || loginError
          ? <p role="alert" className="zion-account-error">{loginError || error}</p>
          : null}
      </div>
      <footer className="zion-account-filing"><WebsiteFiling /></footer>
    </main>;
  }

  const personal = me.space.kind !== "team";
  const role = active
    ? personal ? "已登录" : roles[me.membership!.role] || me.membership!.role
    : "等待加入";
  const currentLogin = sessions.find((session) => session.id === me.sessionId);
  const activeOwnerCount = members.filter(member =>
    member.status === "active" && member.role === "owner"
  ).length;

  return <div className={`zion-account zion-account--${variant}`}>
    <header className="zion-account-header">
      <div className="zion-account-avatar" aria-hidden="true">{initials(me.user.name)}</div>
      <div className="zion-account-identity">
        <h1>{me.user.name}</h1>
        <p>{me.user.email || role}</p>
      </div>
      <span className={`zion-account-role ${me.membership?.role === "viewer" ? "is-readonly" : ""}`}>
        {role}
      </span>
      <button
        className="zion-account-icon-button"
        type="button"
        title="刷新账号状态"
        aria-label="刷新账号状态"
        disabled={busy}
        onClick={() => void refresh()}
      >
        <RefreshCw size={16} aria-hidden="true" />
      </button>
    </header>

    {invitation ? <section className="zion-account-invitation">
      <div>
        <strong>收到一份团队邀请</strong>
        <span>接受后将加入团队并进入对应环境。</span>
      </div>
      <div className="zion-account-actions">
        <button className="zion-account-button is-primary" disabled={busy} onClick={() => void perform(async () => {
          const accepted = await request<{ membership: unknown; space?: { id: string } }>(
            "invitations/accept",
            { token: invitation }
          );
          if (accepted.space) await request("spaces/select", { spaceId: accepted.space.id });
          clearInvitation();
          setInvitation("");
          setNotice("邀请已接受");
          if (accepted.space) location.reload();
        })}>
          <Check size={15} aria-hidden="true" />
          接受
        </button>
        <button className="zion-account-button" disabled={busy} onClick={() => {
          clearInvitation();
          setInvitation("");
        }}>忽略</button>
      </div>
    </section> : null}

    {active && onContinue ? <section className="zion-account-entry">
      <div>
        <strong>{personal ? "登录成功" : me.space.name}</strong>
        <span>{personal ? "继续进入 Zion" : `团队 · ${role}`}</span>
      </div>
      <button className="zion-account-button is-primary" disabled={busy} onClick={() => onContinue(me)}>
        进入
        <ArrowRight size={15} aria-hidden="true" />
      </button>
    </section> : null}

    <nav className="zion-account-tabs" aria-label="账号管理">
      {tabs.map((item) => <button
        key={item.id}
        type="button"
        className={tab === item.id ? "is-active" : ""}
        aria-current={tab === item.id ? "page" : undefined}
        onClick={() => setTab(item.id)}
      >
        {item.label}
        {item.count != null ? <span>{item.count}</span> : null}
      </button>)}
    </nav>

    <div className="zion-account-content">
      {tab === "overview" ? <>
        <section className="zion-account-section">
          <h2>登录方式</h2>
          <div className="zion-account-security-row">
            <ShieldCheck size={20} aria-hidden="true" />
            <div><strong>邮箱与 GitHub</strong><p>{me.capabilities?.loginSettingsUrl
              ? "查看关联状态或修改密码" : "使用统一账号登录 Zion 与 Memory"}</p></div>
            {me.capabilities?.loginSettingsUrl ? <a className="zion-account-button"
              href={new URL(me.capabilities.loginSettingsUrl, baseUrl || location.origin).href}>管理登录方式<ChevronRight size={15} aria-hidden="true" /></a> : null}
          </div>
        </section>
        {!personal ? <section className="zion-account-section">
          <h2>当前团队</h2>
          <div className="zion-account-list">
            <div className="zion-account-list-row">
              <span className="zion-account-row-icon"><Users size={16} aria-hidden="true" /></span>
              <span className="zion-account-row-main">
                <strong>{me.space.name}</strong>
                <small>{role}</small>
              </span>
              {!active
                ? <span className="zion-account-status is-muted">未加入</span>
                : me.membership?.role === "viewer"
                  ? <span className="zion-account-status is-muted">只读</span>
                  : <span className="zion-account-status is-ok">已连接</span>}
            </div>
          </div>
        </section> : null}

        <section className="zion-account-section">
          <h2>登录设备</h2>
          <div className="zion-account-list">
            {sessions.map((session) => <div className="zion-account-list-row" key={session.id}>
              <span className="zion-account-row-icon"><ShieldCheck size={16} aria-hidden="true" /></span>
              <span className="zion-account-row-main">
                <strong>{session.id === me.sessionId ? "当前设备" : `其他设备 · ${session.id.slice(-6)}`}</strong>
                <small>{time(session.createdAt)} · 有效至 {time(session.expiresAt)}</small>
              </span>
              {session.id === me.sessionId ? <span className="zion-account-status is-ok">当前</span>
                : <button
                    className="zion-account-icon-button"
                    type="button"
                    title="退出这台设备"
                    aria-label="退出这台设备"
                    disabled={busy}
                    onClick={() => void perform(() => request("sessions/revoke", { sessionId: session.id }))}
                  ><LogOut size={15} aria-hidden="true" /></button>}
            </div>)}
            {!sessions.length ? <div className="zion-account-empty">没有其他登录设备</div> : null}
          </div>
        </section>
        <div className="zion-account-footer-actions">
          <button className="zion-account-button is-danger" disabled={busy} onClick={() => void logout()}>
            <LogOut size={15} aria-hidden="true" />
            退出当前账号
          </button>
          {currentLogin ? <span>本次登录有效至 {time(currentLogin.expiresAt)}</span> : null}
        </div>
      </> : null}

      {tab === "members" && mayManage ? <section className="zion-account-section">
        <div className="zion-account-section-heading">
          <div><h2>团队成员</h2><p>{members.length} 位成员</p></div>
          <div className="zion-account-invite-controls">
            <select value={inviteRole} disabled={busy} aria-label="邀请角色"
              onChange={event => setInviteRole(event.target.value)}>
              {Object.entries(roles).filter(([role]) => role !== "owner").map(([value, label]) =>
                <option key={value} value={value}>{label}</option>)}
            </select>
            <button className="zion-account-button" disabled={busy} onClick={() => void perform(async () => {
              setInviteResult(await request("invitations", { role: inviteRole }));
            })}>
              <UserPlus size={15} aria-hidden="true" />
              邀请
            </button>
          </div>
        </div>
        {inviteResult ? <div className="zion-account-invite-result">
          <div>
            <strong>一次性邀请链接</strong>
            <span>有效至 {time(inviteResult.expiresAt)}</span>
          </div>
          <input aria-label="邀请链接" readOnly value={inviteResult.url}
            onFocus={event => event.currentTarget.select()} />
          <button className="zion-account-icon-button" type="button" title="复制邀请链接"
            aria-label="复制邀请链接" disabled={busy} onClick={() => {
              void navigator.clipboard.writeText(inviteResult.url)
                .then(() => setNotice("邀请链接已复制"))
                .catch(() => setError("复制失败，请手动选择链接"));
            }}><Copy size={15} aria-hidden="true" /></button>
        </div> : null}
        <div className="zion-account-list">{members.map(member => {
          const lastOwner = member.role === "owner" && activeOwnerCount === 1;
          const protectedOwner = member.role === "owner"
            && (me.membership?.role !== "owner" || lastOwner);
          return <div className="zion-account-list-row" key={member.id}>
            <span className="zion-account-avatar is-small" aria-hidden="true">{initials(member.name)}</span>
            <span className="zion-account-row-main">
              <strong>{member.name}{member.id === me.user.id ? "（你）" : ""}</strong>
              <small>{member.email || (member.status === "active" ? "团队成员" : "已移除")}</small>
            </span>
            {member.status === "active" ? <>
              <select aria-label={`${member.name}的角色`} value={member.role}
                title={lastOwner ? "至少需要保留一位所有者" : undefined}
                disabled={busy || protectedOwner}
                onChange={event => void perform(async () => {
                  await request(`members/${encodeURIComponent(member.id)}`,
                    { role: event.target.value }, "PATCH");
                })}>
                {Object.entries(roles).filter(([role]) => role !== "owner" || me.membership?.role === "owner" || protectedOwner)
                  .map(([role, label]) => <option key={role} value={role}>{label}</option>)}
              </select>
              <button className="zion-account-icon-button is-danger" type="button"
                title={lastOwner ? "至少需要保留一位所有者" : `移除 ${member.name}`}
                aria-label={`移除 ${member.name}`}
                disabled={busy || protectedOwner}
                onClick={() => {
                  if (confirm(`移除“${member.name}”？其现有任务授权也将撤销。`)) void perform(() =>
                    request(`members/${encodeURIComponent(member.id)}`, { role: member.role, status: "removed" }, "PATCH"));
                }}><UserMinus size={15} aria-hidden="true" /></button>
            </> : <span className="zion-account-status is-muted">已移除</span>}
          </div>;
        })}</div>
      </section> : null}

      {tab === "grants" && active ? <section className="zion-account-section">
        <div className="zion-account-section-heading">
          <div><h2>任务授权</h2><p>{
            personal ? "当前账号"
              : me.scopes.includes("runtime.manage") ? "当前团队" : "由你发起"
          }</p></div>
        </div>
        <div className="zion-account-list">
          {grants.map(grant => {
            const expired = grant.expiresAt <= Date.now();
            const inactive = !!grant.revokedAt || expired;
            return <div className="zion-account-list-row" key={grant.id}>
              <span className="zion-account-row-icon"><KeyRound size={16} aria-hidden="true" /></span>
              <span className="zion-account-row-main">
                <strong>{grant.purpose === "task" ? "后台任务" : "单次运行"} · {grant.userName}</strong>
                <small>{grant.sourceId || grant.profileId || grant.id.slice(-8)}</small>
              </span>
              <span className={`zion-account-status ${inactive ? "is-muted" : "is-ok"}`}>
                {grant.revokedAt ? "已撤销" : expired ? "已过期" : "有效"}
              </span>
              <button className="zion-account-icon-button is-danger" type="button"
                title="撤销授权" aria-label="撤销授权"
                disabled={busy || inactive}
                onClick={() => {
                  if (confirm("撤销这项任务授权？")) {
                    void perform(() => request("grants/revoke", { grantId: grant.id }));
                  }
                }}><Ban size={15} aria-hidden="true" /></button>
            </div>;
          })}
          {!grants.length ? <div className="zion-account-empty">暂无授权记录</div> : null}
        </div>
        <div className="zion-account-pagination">
          <button className="zion-account-icon-button" type="button" title="上一页" aria-label="上一页"
            disabled={busy || page === 0} onClick={() => setPage(page - 1)}>
            <ChevronLeft size={15} aria-hidden="true" />
          </button>
          <span>第 {page + 1} 页</span>
          <button className="zion-account-icon-button" type="button" title="下一页" aria-label="下一页"
            disabled={busy || grants.length < 20} onClick={() => setPage(page + 1)}>
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </div>
      </section> : null}
    </div>

    {!active && !invitation ? <div className="zion-account-empty">
      当前账号还不能访问这个团队。
    </div> : null}
    {error ? <p role="alert" className="zion-account-error">{error}</p> : null}
    {notice ? <p role="status" className="zion-account-notice">{notice}</p> : null}
    <footer className="zion-account-filing"><WebsiteFiling /></footer>
  </div>;
}
