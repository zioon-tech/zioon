import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App, Alert, Avatar, Badge, Breadcrumb, Button, Descriptions, Dropdown, Empty, Form, Input,
  InputNumber, Modal, Pagination, Segmented, Select, Skeleton, Space, Spin, Switch, Table, Tabs, Tag, Tooltip
} from "antd";
import {
  ArrowLeft, ArrowRight, BookOpen, Check, CheckCircle2, ChevronDown, Code2, Copy,
  Download, ExternalLink, FileText, FolderCode, Globe2, LayoutGrid, LogOut, Package,
  Plug, Search, Settings2, ShieldCheck, SlidersHorizontal, Terminal, Upload, UserRound, X
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError, login, request, runtimePath } from "./api";
import type { Account, Connection, Contribution, Entry, Kind, Run, Schema, Snapshot } from "./types";
import { InstallationFiles } from "./installation-files";
import { WebsiteFiling } from "../../../packages/account-ui/src/WebsiteFiling";
import "./filing-layout.css";

const names: Record<string, string> = { skill: "技能", plugin: "插件", mcp: "MCP", workbench: "界面组件", model: "模型" };
const statuses: Record<string, string> = {
  ready: "已就绪", disabled: "已停用", partially_ready: "部分就绪",
  configuration_required: "待设置", connection_required: "待连接", validation_required: "待验证",
  host_required: "等待客户端", draft: "草稿", submitted: "待审核", published: "已发布",
  changes_requested: "待修改", private: "私有"
};
const KindIcon = ({ kind, size = 22 }: { kind: string; size?: number }) =>
  kind === "skill" ? <BookOpen size={size} /> : kind === "mcp" ? <Plug size={size} /> : <Package size={size} />;
const Status = ({ value }: { value: string }) => <Tag bordered={false}
  color={["ready", "published"].includes(value) ? "success" : ["disabled", "draft", "private"].includes(value) ? "default" : "processing"}>
  {statuses[value] || value}
</Tag>;
type MarketContext = { account?: Account; snapshot?: Snapshot; loading: boolean; error: unknown;
  busy: boolean; operate: (path: string, body?: unknown, method?: string) => Promise<boolean>;
  refresh: () => Promise<unknown>; authenticated: boolean };
const Market = createContext<MarketContext>(null!);
const useMarket = () => useContext(Market);

export function Marketplace() {
  const client = useQueryClient(), { message } = App.useApp();
  const location = useLocation(), navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const accountQuery = useQuery({ queryKey: ["account"], queryFn: ({ signal }) =>
    request<Account>("/api/auth/session", { signal }), refetchInterval: 15000 });
  const account = accountQuery.data, authenticated = account?.authenticated === true;
  const identity = authenticated ? account.user?.id : "public";
  const previousIdentity = useRef(identity);
  useEffect(() => {
    if (previousIdentity.current !== identity) {
      const obsolete = (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== "account"
        && !(query.queryKey[0] === "market" && query.queryKey[1] === identity);
      void client.cancelQueries({ predicate: obsolete });
      client.removeQueries({ predicate: obsolete });
      previousIdentity.current = identity;
    }
    if (!authenticated && account?.sharedAuthenticated && account.generation
      && !new URLSearchParams(location.search).has("loginError")) {
      const key = `zioon.sso.marketplace.${account.generation}`;
      let last = 0;
      try {
        last = Number(sessionStorage.getItem(key));
        if (Date.now() - last > 60000) sessionStorage.setItem(key, String(Date.now()));
      } catch { /* Session bootstrap still works if browser storage is unavailable. */ }
      if (Date.now() - last > 60000) login();
    }
  }, [account, authenticated, identity, client, location.search]);
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "visible") void accountQuery.refetch();
    };
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [accountQuery.refetch]);
  const snapshotQuery = useQuery({
    queryKey: ["market", authenticated ? account.user?.id : "public"], enabled: !accountQuery.isPending,
    queryFn: ({ signal }) => request<Snapshot>(authenticated
      ? runtimePath("/v1/marketplace/snapshot") : "/api/catalog", { signal }),
  });
  useEffect(() => {
    client.removeQueries({ predicate: (query) => query.queryKey[0] === "market"
      && query.queryKey[1] !== (authenticated ? account?.user?.id : "public") });
  }, [authenticated, account?.user?.id, client]);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [location.pathname]);
  const refresh = () => snapshotQuery.refetch();
  const operate = async (path: string, body?: unknown, method = "POST") => {
    if (!authenticated) { login(); return false; }
    if (busy) return false;
    setBusy(true);
    try {
      await request(runtimePath(path), { method, body });
      await refresh();
      message.success("已保存");
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await client.invalidateQueries({ queryKey: ["account"] });
        message.error("登录已失效，请重新登录");
      } else {
        if (error instanceof ApiError && error.code === "revision_conflict") await refresh();
        message.error(error instanceof Error ? error.message : "操作没有完成");
      }
      return false;
    } finally { setBusy(false); }
  };
  const logout = async () => {
    await request("/api/auth/logout", { method: "POST", body: {} });
    client.clear(); navigate("/"); await accountQuery.refetch();
  };
  const menu = { items: [
    { key: "account", label: "账户设置", icon: <UserRound size={16} /> },
    { key: "workbench", label: "打开 Workbench", icon: <ExternalLink size={16} /> },
    { type: "divider" as const },
    { key: "logout", label: "退出 Zioon", icon: <LogOut size={16} /> }
  ], onClick: ({ key }: { key: string }) => {
    if (key === "logout") void logout().catch(() => message.error("退出未完成"));
    else window.open(key === "workbench" ? "https://runtime.zioon.tech/"
      : account?.capabilities?.loginSettingsUrl || "https://auth.zioon.tech/account", "_blank", "noopener,noreferrer");
  } };
  return <Market.Provider key={identity} value={{ account, authenticated, snapshot: snapshotQuery.data, busy, operate, refresh,
    loading: accountQuery.isPending || snapshotQuery.isPending, error: accountQuery.error || snapshotQuery.error }}>
    <header className="site-header"><div className="header-inner">
      <Link to="/" className="brand" aria-label="Zioon 插件市场首页"><span className="brand-mark">Z</span><strong>Zioon</strong><span className="brand-divider" /><span>插件市场</span></Link>
      <nav className="main-nav" aria-label="主导航">
        <NavLink to="/" end>发现</NavLink><NavLink to="/installed">已安装</NavLink><NavLink to="/developer">开发者</NavLink>
      </nav>
      <div className="header-actions"><a className="docs-link" href="https://zioon.tech/docs/" target="_blank" rel="noreferrer">文档<ExternalLink size={13} /></a>
        {accountQuery.isPending ? <Spin size="small" /> : authenticated
          ? <Dropdown menu={menu} trigger={["click"]}><Button className="account-button"><Avatar size={24}>{(account?.user?.name || "Z").slice(0, 1)}</Avatar>
            <span>{account?.user?.name || "我的账户"}</span><ChevronDown size={13} /></Button></Dropdown>
          : <Button type="primary" onClick={() => login()}>登录 Zioon</Button>}
      </div>
    </div></header>
    <main className="page-shell">
      {new URLSearchParams(location.search).has("loginError") && <Alert showIcon type="warning" closable
        message="登录未完成，请重新登录 Zioon。" style={{ marginBottom: 24 }} />}
      {accountQuery.error && <Alert type="error" showIcon message="账户服务暂时不可用" action={<Button onClick={() => accountQuery.refetch()}>重试</Button>} />}
      <Routes>
        <Route path="/" element={<Catalog />} />
        <Route path="/installed" element={<Catalog installed />} />
        <Route path="/plugins/:id" element={<Detail />} />
        <Route path="/developer" element={<Developer />} />
        <Route path="*" element={<Empty description="页面不存在"><Link to="/">返回插件市场</Link></Empty>} />
      </Routes>
    </main>
    <footer className="site-footer"><div><Link to="/" className="footer-brand">Zioon</Link><span>插件、技能与 MCP，随你的账户一起使用。</span></div>
      <div><a href="https://zioon.tech/">官网</a><a href="https://zioon.tech/docs/">开发文档</a><a href="https://runtime.zioon.tech/">Workbench <ExternalLink size={12} /></a></div>
      <WebsiteFiling /></footer>
  </Market.Provider>;
}

function AuthGate({ description }: { description: string }) {
  return <div className="auth-gate"><div className="large-icon"><UserRound size={28} /></div><h2>使用你的 Zioon 账户</h2>
    <p>{description}</p><Button type="primary" size="large" onClick={() => login()}>登录 Zioon <ArrowRight size={16} /></Button>
    <span>与 Workbench 使用同一个账户。</span></div>;
}

function Catalog({ installed = false }: { installed?: boolean }) {
  const { snapshot, authenticated, loading, error, refresh } = useMarket();
  const [search, setSearch] = useState(""), [kind, setKind] = useState(""), [category, setCategory] = useState("");
  const [page, setPage] = useState(1);
  const all = snapshot?.entries || [];
  const entries = useMemo(() => all.filter((entry) =>
    (installed ? !!entry.installation : entry.visibility !== "private")
    && (!kind || entry.kind === kind) && (!category || entry.category === category)
    && `${entry.name} ${entry.summary} ${entry.publisher.name}`.toLowerCase().includes(search.toLowerCase().trim())),
  [all, installed, kind, category, search]);
  useEffect(() => setPage(1), [kind, category, search, installed]);
  if (installed && !authenticated && !loading) return <AuthGate description="查看和管理已安装的插件，连接服务，继续在 Workbench 或 CLI 中使用。" />;
  return <div className="catalog-page">
    <section className="page-heading"><div><span className="eyebrow">{installed ? "YOUR COLLECTION" : "ZIOON MARKETPLACE"}</span>
      <h1>{installed ? "已安装" : "插件市场"}</h1><p>{installed ? "管理你的插件、连接与版本。" : "找到需要的插件、技能和 MCP，添加到你的工作中。"}</p></div>
      {!installed && <Link to="/developer" className="developer-shortcut"><Code2 size={18} /><span>发布你的插件</span><ArrowRight size={16} /></Link>}
    </section>
    <div className="catalog-tools"><Input size="large" prefix={<Search size={19} />} allowClear
      placeholder="搜索插件、用途或发布者" aria-label="搜索插件" value={search} onChange={(event) => setSearch(event.target.value)} />
      <Segmented options={[{ label: "全部", value: "" }, { label: "插件", value: "plugin" }, { label: "技能", value: "skill" }, { label: "MCP", value: "mcp" }]}
        value={kind} onChange={(value) => setKind(String(value))} /></div>
    <div className="catalog-layout"><aside className="category-nav"><h2><SlidersHorizontal size={15} />用途分类</h2>
      {["", ...(snapshot?.categories || [])].map((name) => <button key={name} className={category === name ? "selected" : ""}
        onClick={() => setCategory(name)}>{name || "所有用途"}<span>{all.filter((e) => (!name || e.category === name)
          && (installed ? e.installation : e.visibility !== "private")).length}</span></button>)}
      <div className="side-note"><ShieldCheck size={19} /><strong>同一账户，统一管理</strong><p>添加的扩展可以在支持它的 Workbench、CLI 和 API 中使用。</p></div>
    </aside><section className="catalog-results" aria-live="polite">
      <div className="results-heading"><span>{entries.length} 项{installed ? "已安装扩展" : "可发现扩展"}</span>
        <Button type="text" size="small" onClick={() => refresh()}>刷新目录</Button></div>
      {error ? <Alert type="error" showIcon message="目录暂时无法加载" action={<Button onClick={() => refresh()}>重试</Button>} />
        : loading ? <div className="plugin-grid">{[0, 1, 2, 3, 4, 5].map((i) => <div className="plugin-card" key={i}><Skeleton active avatar paragraph={{ rows: 2 }} /></div>)}</div>
        : entries.length ? <><div className="plugin-grid">{entries.slice((page - 1) * 12, page * 12).map((entry) =>
          <Link to={"/plugins/" + encodeURIComponent(entry.id)} key={entry.id} className="plugin-card">
            <div className="card-top"><div className={"plugin-icon " + entry.kind}><KindIcon kind={entry.kind} /></div>
              {entry.installation ? <Status value={entry.installation.status} /> : <span className="kind-label">{names[entry.kind]}</span>}</div>
            <h2>{entry.name}</h2><p>{entry.summary}</p><div className="card-bottom"><span>{entry.publisher.name}
              {entry.publisher.origin === "official" && <Tooltip title="官方发布"><Badge color="#1677ff" /></Tooltip>}</span>
              <span>{entry.category}<ArrowRight size={15} /></span></div>
          </Link>)}</div><Pagination current={page} pageSize={12} total={entries.length} onChange={setPage} hideOnSinglePage showSizeChanger={false} /></>
          : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={installed ? "还没有符合条件的已安装扩展" : "没有找到匹配的扩展"}>
            <Button onClick={() => { setSearch(""); setKind(""); setCategory(""); }}>清除筛选</Button>
          </Empty>}
    </section></div>
  </div>;
}

function Detail() {
  const { id = "" } = useParams(), { snapshot, loading, authenticated, busy, operate, refresh } = useMarket();
  const { modal, message } = App.useApp();
  const entry = snapshot?.entries.find((item) => item.id === id);
  const [version, setVersion] = useState(""), [configOpen, setConfigOpen] = useState(false);
  const [runId, setRunId] = useState("");
  useEffect(() => { setVersion(""); setRunId(""); }, [id]);
  const runQuery = useQuery({ queryKey: ["run", runId], enabled: !!runId,
    queryFn: () => request<{ run: Run }>(runtimePath("/v1/runs/" + encodeURIComponent(runId))),
    refetchInterval: (query) => ["completed", "failed", "aborted", "interrupted"].includes(query.state.data?.run.status || "") ? false : 1000 });
  useEffect(() => { if (runQuery.data?.run.status === "completed") void refresh(); }, [runQuery.data?.run.status]);
  if (loading) return <Skeleton active paragraph={{ rows: 9 }} />;
  if (!entry) return <Empty description="这个插件不存在，或需要登录后查看。"><Button onClick={() => login()}>登录查看</Button><Link to="/">返回市场</Link></Empty>;
  const install = entry.installation, release = entry.installedRelease || entry;
  const selected = entry.versions.find((v) => v.version === (version || entry.version));
  const installVersion = async () => {
    if (!selected) return;
    const change = () => operate("/v1/marketplace/installations/" + encodeURIComponent(entry.id), {
      version: selected.version, digest: selected.digest, expectedRevision: snapshot?.revision,
      ...(install?.workspace ? { discardWorkspace: true } : {})
    });
    if (install?.workspace && selected.version !== install.version) modal.confirm({
      title: "切换来源版本？", content: "新版本将使用新的个人副本。当前修改文件保留在原目录，不会自动合并。",
      okText: "切换", cancelText: "取消", onOk: async () => { await change(); }
    });
    else await change();
  };
  const uninstall = () => modal.confirm({ title: "卸载 " + entry.name + "？", content: "这会从你的账户移除此扩展，之后可以重新添加。",
    okText: "卸载", cancelText: "取消", okButtonProps: { danger: true },
    onOk: async () => { if (!await operate("/v1/marketplace/installations/" + encodeURIComponent(entry.id),
      { expectedRevision: snapshot?.revision }, "DELETE")) throw new Error("卸载未完成"); } });
  const probe = async () => {
    if (!install?.config) { setConfigOpen(true); return; }
    try {
      const accepted = await request<{ runId: string }>(runtimePath("/v1/runs"), {
        method: "POST", body: { prompt: "Extension probe: " + entry.name, interactionProfileId: "interactive.default",
          policy: { preset: "trusted-automation", allowedTools: ["extensionsCall", "write", "Bash"],
            fileRoots: [install.config.workspaceRoot, ...(install.config.credentialsFile ? [install.config.credentialsFile] : [])] },
          metadata: { source: "marketplace", extensionInvocation: {
            action: "probe", listingId: entry.id, epoch: install.executionEpoch
          } } }
      });
      setRunId(accepted.runId);
    } catch (error) { message.error(error instanceof Error ? error.message : "连接验证未完成"); }
  };
  const tools = install?.validation?.tools || install?.components?.flatMap((c) => c.tools || []) || [];
  return <div className="detail-page"><Breadcrumb items={[{ title: <Link to="/">插件市场</Link> }, { title: entry.name }]} />
    <section className="detail-heading"><div className={"plugin-icon detail-icon " + entry.kind}><KindIcon kind={entry.kind} size={36} /></div>
      <div className="detail-title"><div className="title-tags"><span>{names[entry.kind]}</span>{entry.visibility === "private" && <Tag>仅自己可见</Tag>}</div>
        <h1>{entry.name}</h1><p>{entry.summary}</p><div className="publisher-line"><span>{entry.publisher.name}</span>
          {entry.publisher.origin === "official" && <span className="verified"><ShieldCheck size={14} />官方</span>}<span>·</span><span>{entry.category}</span></div></div>
      <div className="detail-primary">{install ? <><Status value={install.status} />
        {install.updateAvailable && <Button type="primary" loading={busy} onClick={installVersion}>更新至 {entry.version}</Button>}
        {release.kind !== "skill" && <Button onClick={() => setConfigOpen(true)} icon={<Settings2 size={15} />}>连接与设置</Button>}</>
        : <Button type="primary" size="large" loading={busy} icon={<Download size={18} />} onClick={() => authenticated ? installVersion() : login()}>添加到账户</Button>}
        <span>{install ? `已安装 v${install.version}` : "添加后跟随你的 Zioon 账户"}</span></div>
    </section>
    <div className="detail-layout"><section className="detail-content"><Tabs items={[
      { key: "description", label: "介绍", children: <article className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}
        components={{ img: () => null, a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>{entry.description || entry.summary}</ReactMarkdown>
        <h3>包含的能力</h3><div className="capability-list">{entry.components.map((component) =>
          <div key={component.id}><KindIcon kind={component.kind} size={18} /><div><strong>{component.name}</strong>
            <p>{component.description || names[component.kind] || component.kind}</p>
            {component.requirements?.map((requirement) => <span className="requirement" key={requirement}>{requirement}</span>)}</div></div>)}</div>
        {entry.artifact?.plugin?.capabilities?.flatMap((capability) => capability.models || []).map((model) =>
          <div className="model-line" key={model.id}><Plug size={18} /><strong>{model.name || model.id}</strong>
            <Tag bordered={false}>{model.supportsTools ? "支持工具" : "文本模型"}</Tag></div>)}
      </article> },
      { key: "versions", label: "版本记录", children: <div className="versions">{entry.versions.map((item) =>
        <section key={item.version}><h3>v{item.version}{install?.version === item.version && <Tag>当前安装</Tag>}</h3>
          <p>{item.changelog || "此版本没有提供更新说明。"}</p></section>)}</div> },
      { key: "tools", label: "工具", children: tools.length ? <div className="tools-list">{tools.map((tool) =>
        <div key={tool.name}><code>{tool.name}</code><p>{tool.description || "已由扩展注册的工具。"}</p></div>)}</div>
        : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={install ? "此扩展未注册工具，或尚未验证连接。" : "添加并验证后可以查看注册的工具。"} /> },
      ...(install ? [{ key: "files", label: "个人文件", children: <InstallationFiles key={entry.id} entry={entry} refresh={refresh} /> }] : [])
    ]} />
    {runId && <Alert style={{ marginTop: 24 }} showIcon type={runQuery.data?.run.status === "failed" ? "error" : runQuery.data?.run.status === "completed" ? "success" : "info"}
      message={runQuery.error ? "无法读取验证状态，请到 Workbench 查看运行记录。" : runQuery.data?.run.status === "completed" ? "连接验证完成" : runQuery.data?.run.status === "failed" ? "连接验证未完成" : "正在验证连接"}
      description={runQuery.data?.run.error || (runQuery.data?.run.status === "completed" ? "工具和模型声明已读取。" : "验证状态会自动更新。")} />}
    </section><aside className="detail-sidebar">
      <h2>插件信息</h2><Descriptions column={1} size="small" colon={false} items={[
        { key: "version", label: "版本", children: <Select aria-label="选择插件版本" value={version || entry.version} onChange={setVersion}
          options={entry.versions.map((v) => ({ value: v.version, label: "v" + v.version }))} /> },
        { key: "license", label: "许可", children: entry.license || "未声明" },
        { key: "type", label: "类型", children: names[entry.kind] },
        { key: "publisher", label: "发布者", children: entry.publisher.name }
      ]} />
      {install && version && version !== install.version && <Button block loading={busy} onClick={installVersion}>安装选中版本</Button>}
      {entry.sourceUrl && <a className="sidebar-link" href={entry.sourceUrl} target="_blank" rel="noreferrer"><Code2 size={16} />查看源代码<ExternalLink size={14} /></a>}
      <a className="sidebar-link" href="https://zioon.tech/docs/" target="_blank" rel="noreferrer"><FileText size={16} />开发与使用文档<ExternalLink size={14} /></a>
      {install && <div className="installation-actions"><h2>账户安装</h2><div className="enabled-row"><span>启用插件</span>
        <Switch checked={install.enabled} disabled={busy} onChange={(enabled) => operate("/v1/marketplace/installations/" + encodeURIComponent(entry.id), { enabled, expectedRevision: snapshot?.revision }, "PATCH")} /></div>
        {release.artifact && release.kind !== "skill" && <Button block icon={<CheckCircle2 size={16} />} disabled={busy || (!!runId && !["completed", "failed", "aborted", "interrupted"].includes(runQuery.data?.run.status || ""))} onClick={probe}>验证连接</Button>}
        <Button block type="primary" href="https://runtime.zioon.tech/" target="_blank" icon={<ExternalLink size={16} />}>在 Workbench 使用</Button>
        <Button block type="text" danger onClick={uninstall} disabled={busy}>卸载插件</Button></div>}
      <div className="sidebar-note"><ShieldCheck size={18} /><p>插件使用现有账户权限。实际能力由插件及已连接的执行设备提供。</p></div>
    </aside></div>
    <Configuration entry={entry} open={configOpen} close={() => setConfigOpen(false)} />
  </div>;
}

function SchemaFields({ schema }: { schema?: Schema }) {
  return <>{Object.entries(schema?.properties || {}).map(([name, property]) =>
    <Form.Item key={name} name={["settings", name]} label={property.title || name} extra={property.description}
      valuePropName={property.type === "boolean" ? "checked" : "value"}
      rules={schema?.required?.includes(name) ? [{ required: true, message: "请填写此设置" }] : []}>
      {property.enum ? <Select options={property.enum.map((v) => ({ value: v, label: String(v) }))} />
        : property.type === "boolean" ? <Switch />
          : ["number", "integer"].includes(property.type || "") ? <InputNumber style={{ width: "100%" }} precision={property.type === "integer" ? 0 : undefined} /> : <Input />}
    </Form.Item>)}</>;
}

function Configuration({ entry, open, close }: { entry: Entry; open: boolean; close: () => void }) {
  const { authenticated, snapshot, busy, operate } = useMarket(), [form] = Form.useForm();
  const connections = useQuery({ queryKey: ["connections"], enabled: open && authenticated,
    queryFn: () => request<{ connections: Connection[] }>(runtimePath("/v1/marketplace/connections")) });
  const release = entry.installedRelease || entry;
  const schema = release.artifact?.plugin?.settingsSchema;
  const connection = release.artifact?.plugin?.connection;
  useEffect(() => {
    if (!open) return;
    const config = entry.installation?.config;
    form.setFieldsValue({ nodeId: config?.nodeId || "managed:account", workspaceRoot: config?.workspaceRoot || "/workspace",
      credentialsFile: config?.credentialsFile || "", settings: config?.settings || Object.fromEntries(
        Object.entries(schema?.properties || {}).filter(([, p]) => p.default !== undefined).map(([k, p]) => [k, p.default])) });
  }, [open, entry, form, schema]);
  const save = async () => {
    const value = await form.validateFields();
    const config = { nodeId: value.nodeId, workspaceRoot: value.workspaceRoot,
      ...(value.credentialsFile?.trim() ? { credentialsFile: value.credentialsFile.trim() } : {}),
      ...(schema ? { settings: value.settings || {} } : {}) };
    if (await operate("/v1/marketplace/installations/" + encodeURIComponent(entry.id) + "/config",
      { config, expectedRevision: snapshot?.revision }, "PUT")) close();
  };
  return <Modal title="连接与设置" open={open} onCancel={close} onOk={() => save().catch(() => {})} confirmLoading={busy}
    okText="保存设置" cancelText="取消" destroyOnHidden width={520}>
    <p className="modal-description">配置 {entry.name} 的使用位置和服务连接。</p>
    {connections.error && <Alert type="error" showIcon message="无法读取可用连接" description="请确认账户权限，或稍后重试。" />}
    <Form form={form} layout="vertical">
      <Form.Item name="nodeId" label="使用位置" rules={[{ required: true }]}><Select loading={connections.isPending}
        options={connections.data?.connections.map((item) => ({ value: item.nodeId, label: item.label + (item.status === "offline" ? " · 离线" : "") }))}
        onChange={(value) => form.setFieldValue("workspaceRoot", connections.data?.connections.find((c) => c.nodeId === value)?.workspaceRoot || "/workspace")} /></Form.Item>
      <Form.Item name="workspaceRoot" label="工作目录" rules={[{ required: true, message: "请选择可用的工作目录" }]}><Input /></Form.Item>
      <Form.Item name="credentialsFile" label={connection?.label ? connection.label + " 连接文件" : "服务连接文件"}
        extra="填写所选设备上的私有连接文件路径。密钥保存在设备上。"
        rules={connection?.required ? [{ required: true, message: "此插件需要服务连接" }] : []}><Input placeholder="/absolute/private/connection.json" /></Form.Item>
      <SchemaFields schema={schema} />
    </Form>
  </Modal>;
}

function Developer() {
  const { authenticated, snapshot, loading } = useMarket();
  const [tab, setTab] = useState("private");
  return <div className="developer-page"><section className="page-heading"><div><span className="eyebrow">BUILD WITH ZIOON</span>
    <h1>开发者</h1><p>从一个函数开始，发布并管理你的扩展。</p></div>
    <a className="developer-shortcut" href="https://zioon.tech/docs/" target="_blank" rel="noreferrer">开发文档 <ExternalLink size={16} /></a></section>
    <div className="developer-guide"><Terminal size={24} /><div><h2>创建、开发、发布</h2><p>开发命令会将成功构建同步到你的账户，可以在 Workbench 中调试。</p>
      <Command value={"zioon extensions init my-plugin --kind plugin\nzioon extensions dev my-plugin\nzioon extensions publish my-plugin"} /></div></div>
    {!authenticated && !loading ? <AuthGate description="登录后管理私有插件、发布版本，并提交到公开市场。" /> : <Tabs activeKey={tab} onChange={setTab} items={[
      { key: "private", label: "我的插件", children: <PrivatePlugins /> },
      { key: "contributions", label: "公开贡献", children: <Contributions /> },
      ...(snapshot?.canReview ? [{ key: "review", label: "市场审核", children: <Review /> }] : [])
    ]} />}
  </div>;
}

function Command({ value }: { value: string }) {
  const { message } = App.useApp();
  return <div className="command"><pre>{value}</pre><Button type="text" aria-label="复制命令" icon={<Copy size={16} />}
    onClick={() => navigator.clipboard.writeText(value).then(() => message.success("命令已复制")).catch(() => message.error("复制未完成，请手动选择命令"))} /></div>;
}

function ArtifactUpload({ publicRelease = false }: { publicRelease?: boolean }) {
  const { snapshot, operate, busy } = useMarket(), { message } = App.useApp();
  const [artifact, setArtifact] = useState<unknown>(), [filename, setFilename] = useState("");
  const read = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 256000) throw new Error("制品不能超过 256KB");
      setArtifact(JSON.parse(await file.text())); setFilename(file.name);
    } catch (error) { setArtifact(undefined); setFilename(""); message.error(error instanceof Error ? error.message : "无法读取制品"); }
  };
  return <div className="upload-section"><div><Upload size={20} /><h3>{publicRelease ? "提交公开插件" : "上传私有版本"}</h3></div>
    <p>{publicRelease ? "上传打包后的制品，保存为贡献草稿，再提交审核。公开制品需声明源代码地址。" : "上传打包后的 .zion.json 制品，只对你的账户可见。"}</p>
    <div className="upload-actions"><label className="file-input"><input type="file" accept=".json" onChange={(e) => read(e.target.files?.[0])} />
      <Upload size={15} />{filename || "选择制品文件"}</label><Button type="primary" disabled={!artifact} loading={busy} onClick={async () => {
        if (await operate("/v1/marketplace/" + (publicRelease ? "contributions" : "private-releases"),
          { artifact, expectedRevision: snapshot?.revision })) { setArtifact(undefined); setFilename(""); }
      }}>{publicRelease ? "保存贡献草稿" : "上传私有版本"}</Button></div></div>;
}

function PrivatePlugins() {
  const { snapshot, loading } = useMarket();
  const entries = snapshot?.entries.filter((entry) => entry.visibility === "private") || [];
  return <><ArtifactUpload />{loading ? <Skeleton active /> : entries.length ? <div className="developer-list">{entries.map((entry) =>
    <Link key={entry.id} to={"/plugins/" + encodeURIComponent(entry.id)}><div className={"plugin-icon " + entry.kind}><KindIcon kind={entry.kind} /></div>
      <div><h3>{entry.name}</h3><p>{entry.summary}</p></div><span>v{entry.version}</span>{entry.installation && <Status value={entry.installation.status} />}<ArrowRight size={16} /></Link>)}</div>
    : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有私有插件。通过 CLI 发布，或上传你的第一个制品。" />}</>;
}

function Contributions() {
  const { snapshot, operate, busy } = useMarket();
  return <><ArtifactUpload publicRelease /><Table rowKey="id" dataSource={snapshot?.contributions || []} pagination={false}
    locale={{ emptyText: "还没有公开贡献" }} columns={[
      { title: "插件", key: "name", render: (_, row: Contribution) => <div><strong>{row.manifest.name}</strong><p className="table-subtitle">{row.manifest.summary}</p></div> },
      { title: "版本", key: "version", render: (_, row: Contribution) => row.manifest.version },
      { title: "状态", dataIndex: "status", render: (value) => <Status value={value} /> },
      { title: "审核反馈", key: "feedback", render: (_, row: Contribution) => row.feedback || "—" },
      { title: "", key: "action", render: (_, row: Contribution) => ["draft", "changes_requested"].includes(row.status)
        ? <Button disabled={busy} onClick={() => operate("/v1/marketplace/contributions/" + encodeURIComponent(row.id) + "/submit",
          { expectedRevision: snapshot?.revision })}>提交审核</Button> : null }
    ]} /></>;
}

function Review() {
  const query = useQuery({ queryKey: ["review"], queryFn: () => request<{ contributions: Contribution[] }>(runtimePath("/v1/marketplace/review")) });
  const { operate, busy } = useMarket(), [selected, setSelected] = useState<Contribution>(), [feedback, setFeedback] = useState("");
  const finish = async (decision: string) => {
    if (!selected) return;
    if (await operate("/v1/marketplace/review", { id: selected.id, userId: selected.userId, digest: selected.digest, decision, feedback })) {
      setSelected(undefined); setFeedback(""); await query.refetch();
    }
  };
  return <>{query.error ? <Alert type="error" message="无法读取审核队列" /> : <Table rowKey="id" loading={query.isPending}
    dataSource={query.data?.contributions || []} pagination={false} columns={[
      { title: "插件", key: "name", render: (_, row: Contribution) => row.manifest.name },
      { title: "版本", key: "version", render: (_, row: Contribution) => row.manifest.version },
      { title: "来源", key: "source", render: (_, row: Contribution) => <a href={row.manifest.sourceUrl} target="_blank" rel="noreferrer">源代码 <ExternalLink size={12} /></a> },
      { title: "", key: "action", render: (_, row: Contribution) => <Button onClick={() => setSelected(row)}>审核</Button> }
    ]} />}
    <Modal open={!!selected} title={"审核 " + (selected?.manifest.name || "")} onCancel={() => setSelected(undefined)} footer={
      <Space><Button onClick={() => setSelected(undefined)}>取消</Button><Button disabled={!feedback.trim() || busy} onClick={() => finish("changes_requested")}>要求修改</Button>
        <Button type="primary" disabled={busy} onClick={() => finish("publish")}>批准发布</Button></Space>}>
      <p>{selected?.manifest.description}</p><Input.TextArea rows={4} aria-label="审核反馈" placeholder="审核反馈" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
    </Modal></>;
}
