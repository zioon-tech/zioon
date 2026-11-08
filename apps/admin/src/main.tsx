import { useState, useEffect, useRef, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { Activity, Users, Box, Play, ShieldCheck, History, Radio, LogOut, RefreshCw, ArrowUpRight } from "lucide-react";
import "./style.css";
import "./filing-layout.css";
import { WebsiteFiling } from "../../../packages/account-ui/src/WebsiteFiling";

type Operator = { user: { id: string; name: string; email: string }; role: string };
type Incident = { id: string; title: string; message: string; status: string; impact: string; components: string[]; revision: number; updatedAt: number };
type PageData = { tab: string; value: any; updatedAt: number };
const labels: Record<string, string> = { overview: "运行概览", accounts: "账户", workspaces: "云端工作区",
  runs: "任务运行", incidents: "事件与维护", roles: "管理员权限", audit: "操作记录" };
const components: Record<string, string> = { auth: "统一登录", runtime: "Runtime API", workbench: "Workbench",
  mobile: "Mobile", marketplace: "Marketplace", adc: "Device Cloud", memory: "Memory" };
const statuses: Record<string, string> = { investigating: "调查中", identified: "已定位", monitoring: "观察中", resolved: "已恢复", maintenance: "计划维护" };
const time = (value: any) => value ? new Date(Number(value)).toLocaleString("zh-CN", { hour12: false }) : "—";
async function api(path: string, method = "GET", body?: any) {
  const response = await fetch(`/v1/platform-admin/${path}`, { method, credentials: "same-origin",
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.code || data.error), { status: response.status });
  return data;
}
export function App() {
  const [me, setMe] = useState<Operator | null>(null), [auth, setAuth] = useState("checking");
  const [tab, setTab] = useState("overview"), [page, setPage] = useState<PageData | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const activeTab = useRef(tab), requestSequence = useRef(0);
  // A menu change renders before effects run. Only consume data belonging to
  // this menu, including during the render that initiates navigation.
  const data = page?.tab === tab ? page.value : null;
  const updated = page?.tab === tab ? page.updatedAt : 0;
  const [editing, setEditing] = useState<Partial<Incident> | null>(null);
  const load = async () => {
    if (activeTab.current !== tab) return;
    const sequence = ++requestSequence.current;
    const current = () => sequence === requestSequence.current && activeTab.current === tab;
    setBusy(true); setError("");
    try {
      const value = await api(tab);
      if (!current()) return;
      const valid = tab === "overview"
        ? value?.totals && value?.health?.process?.memory && value?.health?.database
          && Array.isArray(value.health.checks)
        : Array.isArray(value) && (tab !== "incidents" || value.every(i => Array.isArray(i?.components)));
      if (!valid) throw new Error("unexpected_page_data");
      setPage({ tab, value, updatedAt: Date.now() });
    }
    catch (e: any) {
      if (!current()) return;
      if (e.status === 401) setAuth("login");
      else if (e.status === 403) setAuth("denied");
      else setError("数据暂时无法读取，请重试。");
    } finally { if (current()) setBusy(false); }
  };
  const navigate = (next: string) => {
    if (next === activeTab.current) return;
    activeTab.current = next;
    requestSequence.current++;
    setTab(next); setEditing(null); setError(""); setBusy(false);
  };
  const authenticate = async () => {
    try { setMe(await api("me")); setAuth("ready"); }
    catch (e: any) { setAuth(e.status === 401 ? "login" : e.status === 403 ? "denied" : "unavailable"); }
  };
  useEffect(() => { void authenticate(); }, []);
  useEffect(() => {
    setPage(null);
    if (auth === "ready") void load();
    return () => { requestSequence.current++; };
  }, [tab, auth]);
  useEffect(() => {
    if (auth !== "ready") return;
    const check = () => void authenticate();
    const timer = setInterval(check, 15000);
    window.addEventListener("focus", check);
    return () => { clearInterval(timer); window.removeEventListener("focus", check); };
  }, [auth]);
  const logout = async () => {
    setBusy(true);
    try {
      const result = await fetch("/v1/account/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!result.ok) throw new Error();
      location.assign("/");
    } catch { setError("退出尚未完成，请重试。"); } finally { setBusy(false); }
  };
  const saveIncident = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!editing) return;
    const values = new FormData(event.currentTarget);
    const body = { title: values.get("title"), message: values.get("message"), status: values.get("status"),
      impact: values.get("impact"), components: values.getAll("components"), revision: editing.revision || 0 };
    setBusy(true);
    try {
      await api(editing.id ? `incidents/${encodeURIComponent(editing.id)}` : "incidents", editing.id ? "PUT" : "POST", body);
      setEditing(null); await load();
    } catch (e: any) { setError(e.message === "revision_conflict" ? "事件已被其他管理员更新，请重新打开。" : "保存失败，请检查内容后重试。"); }
    finally { setBusy(false); }
  };
  const changeRole = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget), id = String(values.get("userId"));
    const before = data?.find((r: any) => r.user_id === id);
    const role = String(values.get("role"));
    setBusy(true);
    try { await api(`roles/${encodeURIComponent(id)}`, "PUT", { role: role === "remove" ? null : role, revision: before?.revision || 0 }); await load(); }
    catch (e: any) { setError(e.message === "last_platform_owner" ? "必须保留至少一位平台负责人。" : e.message === "revision_conflict" ? "权限已变化，请刷新后重试。" : "授权失败，请检查账户 ID 和权限。"); }
    finally { setBusy(false); }
  };
  if (auth !== "ready") return <main className="gate">
    <a className="brand" href="https://zioon.tech">zioon<span>平台管理</span></a>
    <ShieldCheck size={38} strokeWidth={1.5}/>
    <h1>{auth === "checking" ? "正在验证访问权限" : auth === "denied" ? "此账户没有平台管理权限" : auth === "unavailable" ? "登录服务暂时不可用" : "登录平台管理"}</h1>
    <p>{auth === "denied" ? "平台管理员由负责人明确授权。个人账户和团队管理员权限不会授予平台访问权。" : "使用统一 Zioon 账户，登录后验证平台权限。"}</p>
    {auth === "login" ? <a className="button primary" href="/api/auth/login">使用 Zioon 登录 <ArrowUpRight size={16}/></a>
      : auth !== "checking" ? <button onClick={() => void authenticate()}>重新检查</button> : null}
    {auth === "denied" ? <button onClick={() => void logout()} disabled={busy}>退出并切换账户</button> : null}
    {error && <p role="alert">{error}</p>}
    <footer className="admin-filing"><WebsiteFiling /></footer>
  </main>;
  const icons = [Activity, Users, Box, Play, Radio, ShieldCheck, History];
  const columns: Record<string, [string, string][]> = {
    accounts: [["name", "名称"], ["email", "邮箱"], ["status", "状态"], ["workspace_count", "工作区"], ["id", "账户 ID"], ["created_at", "创建时间"]],
    workspaces: [["account_id", "账户"], ["workspace_id", "工作区"], ["status", "开通状态"], ["error_code", "错误码"], ["attempts", "尝试次数"], ["updated_at", "更新时间"]],
    runs: [["run_id", "运行 ID"], ["status", "状态"], ["space_id", "工作区"], ["created_at", "开始时间"], ["updated_at", "更新时间"]],
    roles: [["name", "名称"], ["email", "邮箱"], ["role", "平台权限"], ["user_id", "账户 ID"], ["revision", "版本"], ["updated_at", "更新时间"]],
    audit: [["action", "操作"], ["actor_id", "操作者"], ["target_id", "对象"], ["details", "变更"], ["created_at", "时间"]]
  };
  return <div className="layout">
    <aside><a className="brand" href="/">zioon<span>平台管理</span></a>
      <nav>{Object.entries(labels).map(([key, label], index) => { const Icon = icons[index]; return <button className={tab === key ? "active" : ""} key={key} onClick={() => navigate(key)}><Icon size={18}/>{label}</button>; })}</nav>
      <a className="external" href="https://status.zioon.tech" target="_blank" rel="noreferrer">公开服务状态 <ArrowUpRight size={15}/></a>
      <div className="operator"><strong>{me?.user.name || me?.user.email}</strong><span>{me?.role === "owner" ? "平台负责人" : me?.role === "operator" ? "运营管理员" : "只读管理员"}</span><button onClick={() => void logout()} disabled={busy}><LogOut size={16}/>退出登录</button></div>
    </aside>
    <main><header><div><p className="eyebrow">ZIOON ADMINISTRATION</p><h1>{labels[tab]}</h1></div><div className="refresh"><span>{updated ? `${time(updated)} 更新` : "正在读取"}</span><button onClick={() => void load()} disabled={busy}><RefreshCw size={16} className={busy ? "spin" : ""}/>刷新</button></div></header>
      {error && <p role="alert" className="notice">{error}</p>}
      {!data ? <p className="empty">{busy ? "正在加载…" : "暂时没有可用数据"}</p> : tab === "overview" ? <>
        <div className="metrics">{[["活跃账户", data.totals.accounts], ["云端工作区", data.totals.workspaces], ["执行中的任务", data.totals.running], ["24 小时失败任务", data.totals.failed_24h], ["有效登录会话", data.totals.sessions]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
        <section><div className="section-title"><h2>平台健康</h2><span className={`badge ${data.health.status}`}>{data.health.status === "ok" ? "正常" : data.health.status === "critical" ? "需立即处理" : "需关注"}</span></div>
          <div className="checks">{data.health.checks.map((c: any) => <div key={c.id}><span className={`dot ${c.status}`}/><strong>{c.id}</strong><span>{c.message}</span></div>)}</div>
          <div className="facts"><span>Runtime RSS <b>{Math.round(data.health.process.memory.rss / 1048576)} MB</b></span><span>数据库连接 <b>{data.health.database.pool?.total} / {data.health.database.pool?.max}</b></span><span>运行时间 <b>{Math.floor(data.health.uptimeSeconds / 60)} 分钟</b></span></div>
        </section>
        <p className="footnote">此页面提供平台运行元数据。用户任务的执行资源由各账户云端工作区承担。</p>
      </> : tab === "incidents" ? <>
        <div className="section-title"><p>事件说明对外公开，自动同步到独立状态页。</p>{me?.role !== "viewer" && <button className="primary" onClick={() => setEditing({ status: "investigating", impact: "minor", components: ["runtime"] })}>发布事件或维护</button>}</div>
        {editing && <section><h2>{editing.id ? "更新事件" : "发布公开事件"}</h2><form className="editor" onSubmit={saveIncident} key={editing.id || "new"}>
          <label>标题<input name="title" maxLength={160} defaultValue={editing.title} required/></label>
          <label>公开说明<textarea name="message" maxLength={3000} rows={4} defaultValue={editing.message} required/></label>
          <div className="form-row"><label>状态<select name="status" defaultValue={editing.status}>{Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>影响<select name="impact" defaultValue={editing.impact}><option value="minor">部分功能受影响</option><option value="major">主要服务受影响</option><option value="maintenance">计划维护</option></select></label></div>
          <fieldset><legend>受影响的服务</legend>{Object.entries(components).map(([key, label]) => <label key={key}><input type="checkbox" name="components" value={key} defaultChecked={editing.components?.includes(key)}/>{label}</label>)}</fieldset>
          <div className="form-row"><button className="primary" disabled={busy}>保存并公开</button><button type="button" onClick={() => setEditing(null)}>取消</button></div>
        </form></section>}
        {data.length ? data.map((i: Incident) => <article className="incident" key={i.id}><div><span className={`badge ${i.status}`}>{statuses[i.status]}</span><small>{time(i.updatedAt)}</small></div><h2>{i.title}</h2><p>{i.message}</p><div className="section-title"><small>{i.components.map(c => components[c]).join(" · ")}</small>{me?.role !== "viewer" && <button onClick={() => setEditing(i)}>更新事件</button>}</div></article>) : <p className="empty">尚未发布事件记录。</p>}
      </> : <>
        {tab === "roles" && me?.role === "owner" && <section><h2>授予或撤销平台权限</h2><p>请填写账户列表中的准确账户 ID。平台负责人可管理权限，运营管理员可发布事件，只读管理员可查看运行信息。</p><form className="form-row" onSubmit={changeRole}><label>账户 ID<input name="userId" placeholder="user:…" required/></label><label>权限<select name="role"><option value="viewer">只读管理员</option><option value="operator">运营管理员</option><option value="owner">平台负责人</option><option value="remove">撤销平台权限</option></select></label><button className="primary" disabled={busy}>保存权限</button></form></section>}
        <div className="table-wrap"><table><thead><tr>{columns[tab]?.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead><tbody>{data.map((row: any, index: number) => <tr key={index}>{columns[tab]?.map(([key]) => <td key={key} title={typeof row[key] === "string" ? row[key] : undefined}>{key.endsWith("_at") ? time(row[key]) : typeof row[key] === "object" && row[key] ? JSON.stringify(row[key]) : String(row[key] ?? "—")}</td>)}</tr>)}</tbody></table>{!data.length && <p className="empty">没有记录</p>}</div>
        <p className="footnote">仅展示最近记录。任务内容、凭据和用户文件不在平台列表中展示。</p>
      </>}
      <footer className="admin-filing"><WebsiteFiling /></footer>
    </main>
  </div>;
}
const host = document.getElementById("root");
if (host) createRoot(host).render(<App/>);
