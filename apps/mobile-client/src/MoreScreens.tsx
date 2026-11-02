import {
  Bell,
  Check,
  ChevronRight,
  Clipboard,
  Cpu,
  FileCode2,
  FileDiff,
  FileText,
  Folder,
  FolderOpen,
  Grid2X2,
  KeyRound,
  Laptop,
  LogOut,
  MemoryStick,
  MessageCircle,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  Wrench,
} from "lucide-react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PluginDataFiles } from "./PluginDataFiles";
import { AccountPanel } from "../../../packages/account-ui/src/AccountPanel";
import { accountCan, currentAccountSession } from "../../../packages/account-ui/src/client";
import { runtimeBaseUrl } from "./api";
import {
  createPairing,
  getAccessSession,
  getHealth,
  getSessionArtifacts,
  skillsSnapshotQueryOptions,
  listCapabilityTools,
  listDeviceNodes,
  listDevices,
  listFiles,
  listInteractionProfiles,
  listModels,
  listPlugins,
  listSessionSummaries,
  listTerminalSessions,
  logout,
  MEMORY_SNAPSHOT_KEY,
  patchInteractionProfile,
  readFile,
  readWorkbenchKV,
  revokeDevice,
  RuntimeApiError,
  updateSkillsSnapshot,
} from "./api";
import {
  Badge,
  EmptyState,
  ErrorState,
  formatRelativeTime,
  IconButton,
  LoadingState,
  MobilePage,
  SectionLabel,
  SegmentedControl,
} from "./components";
import type {
  AccessDevice,
  CapabilityTool,
  ChangeSet,
  FileEntry,
  PluginRecord,
  RuntimeModelProfile,
  TerminalSession,
} from "./types";

type MoreItem = {
  path: string;
  icon: typeof FolderOpen;
  title: string;
  description: string;
  tone?: string;
};

const accountRoleLabel: Record<string, string> = {
  owner: "所有者",
  admin: "管理员",
  member: "成员",
  viewer: "只读"
};

export function MoreScreen() {
  const navigate = useNavigate();
  const account = currentAccountSession();
  const accountSummary = account?.space.kind === "team"
    ? `${account.space.name} · ${accountRoleLabel[account.membership?.role || ""] || "成员"}`
    : account?.user.email || "Zion 账号";
  const groups: Array<{ label: string; items: MoreItem[] }> = [
    {
      label: "内容与知识",
      items: [
        { path: "/files", icon: FolderOpen, title: "文件与变更", description: "工作区文件、Diff 与运行产物", tone: "blue" },
        { path: "/knowledge", icon: UserRound, title: "Identity 与 Memory", description: "身份、记忆与项目上下文" },
        { path: "/comments", icon: MessageCircle, title: "评论", description: "跨端评论线程" },
      ],
    },
    {
      label: "能力与配置",
      items: [
        { path: "/capabilities", icon: Sparkles, title: "Skills 与工具", description: "默认会话可用能力" },
        { path: "/plugins", icon: Plug, title: "插件", description: "Runtime 与设备插件" },
        { path: "/models", icon: Cpu, title: "模型", description: "默认对话模型" },
        { path: "/devices", icon: Laptop, title: "设备与远程访问", description: "配对设备与资源节点", tone: "green" },
        { path: "/settings", icon: Settings, title: "设置", description: "通知与客户端状态" },
      ],
    },
  ];
  return (
    <MobilePage title="更多" subtitle="能力与设置" className="more-page">
      {account ? (
        <button className="mobile-account-row" type="button" onClick={() => navigate("/account")}>
          <span className="mobile-account-avatar" aria-hidden="true">
            {Array.from(account.user.name || "Z").slice(0, 2).join("").toUpperCase()}
          </span>
          <span className="row-main">
            <span className="row-title">{account.user.name}</span>
            <span className="row-preview">{accountSummary}</span>
          </span>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
      ) : null}
      {groups.map((group) => (
        <section className="more-section" key={group.label}>
          <SectionLabel>{group.label}</SectionLabel>
          <div className="list more-directory">
            {group.items.filter(item => accountCan("runtime.manage")
              || !["/knowledge", "/plugins", "/files", "/comments"].includes(item.path)).map((item) => {
              const Icon = item.icon;
              return (
                <button className="more-row" type="button" key={item.path} onClick={() => navigate(item.path)}>
                  <span className={`row-icon ${item.tone || ""}`}><Icon size={19} /></span>
                  <span className="row-main">
                    <span className="row-title">{item.title}</span>
                    <span className="row-preview">{item.description}</span>
                  </span>
                  <ChevronRight size={17} />
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </MobilePage>
  );
}

export function AccountScreen() {
  const account = currentAccountSession();
  return (
    <MobilePage
      title="账号"
      subtitle={account?.space.kind === "team"
        ? account.space.name
        : account?.user.email || "Zion 账号"}
      back="更多"
      className="account-page"
    >
      <AccountPanel baseUrl={runtimeBaseUrl} variant="mobile" />
    </MobilePage>
  );
}

function terminalId(session: TerminalSession): string {
  return String(session.id || session.session_id || "");
}

function entryKind(entry: FileEntry): string {
  return entry.type || entry.kind || "file";
}

function entryPath(base: string, entry: FileEntry): string {
  if (entry.path) return entry.path;
  return `${base.replace(/\/+$/, "")}/${entry.name}`;
}

function fileSize(size?: number): string {
  if (size == null) return "文件";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function FileBrowser({
  terminalSessionId,
}: {
  terminalSessionId: string;
}) {
  const sessions = useQuery({
    queryKey: ["terminal-sessions"],
    queryFn: listTerminalSessions,
  });
  const profiles = useQuery({
    queryKey: ["interaction-profiles"],
    queryFn: listInteractionProfiles,
  });
  const [selectedSessionId, setSelectedSessionId] = useState(terminalSessionId);
  const preferredIds = profiles.data
    ?.find((profile) => profile.id === "interactive.default")
    ?.policy?.allowedTerminalSessionIds || [];
  const preferredSessions = preferredIds.length
    ? (sessions.data || []).filter((session) => preferredIds.includes(terminalId(session)))
    : (sessions.data || []);
  const selectedCandidate = sessions.data
    ?.find((session) => terminalId(session) === selectedSessionId);
  const selected = selectedCandidate && (
    terminalSessionId
    || !preferredIds.length
    || preferredIds.includes(terminalId(selectedCandidate))
  )
    ? selectedCandidate
    : preferredSessions[0];
  const selectableSessions = selected
    && !preferredSessions.some((session) => terminalId(session) === terminalId(selected))
    ? [selected, ...preferredSessions]
    : preferredSessions;
  const selectedId = selected ? terminalId(selected) : "";
  const root = String(selected?.cwd || selected?.initial_cwd || "~");
  const [path, setPath] = useState(root);
  const [openFile, setOpenFile] = useState("");
  useEffect(() => {
    if (!selectedId) return;
    setSelectedSessionId(selectedId);
    setPath(root);
    setOpenFile("");
  }, [selectedId, root]);
  const files = useQuery({
    queryKey: ["files", selectedId, path],
    queryFn: () => listFiles(selectedId, path),
    enabled: Boolean(selectedId && path),
  });
  const content = useQuery({
    queryKey: ["file", selectedId, openFile],
    queryFn: () => readFile(selectedId, openFile),
    enabled: Boolean(selectedId && openFile),
  });

  if (sessions.isLoading) return <LoadingState label="正在查找工作区" />;
  if (sessions.isError) return <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />;
  if (!selected) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="没有文件来源"
        description="创建终端后即可浏览当前工作区文件。"
      />
    );
  }
  if (openFile) {
    const markdown = /\.mdx?$/i.test(openFile);
    return (
      <div className="file-viewer">
        <button className="file-path-back" type="button" onClick={() => setOpenFile("")}>
          ‹ {openFile.split("/").pop()}
        </button>
        {content.isLoading ? <LoadingState label="正在读取文件" /> : null}
        {content.isError ? <ErrorState error={content.error} onRetry={() => void content.refetch()} /> : null}
        {content.data ? (
          markdown ? (
            <article className="markdown-document">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content.data.content}</ReactMarkdown>
            </article>
          ) : (
            <pre className="code-document"><code>{content.data.content}</code></pre>
          )
        ) : null}
      </div>
    );
  }
  return (
    <>
      <div className="resource-picker">
        <label>
          <span>终端</span>
          <select
            value={selectedId}
            onChange={(event) => {
              const next = sessions.data?.find((session) => terminalId(session) === event.target.value);
              setSelectedSessionId(event.target.value);
              setPath(String(next?.cwd || next?.initial_cwd || "~"));
              setOpenFile("");
            }}
          >
            {selectableSessions.map((session) => (
              <option value={terminalId(session)} key={terminalId(session)}>
                {session.name || session.cwd || terminalId(session)}
              </option>
            ))}
          </select>
        </label>
        <code>{path}</code>
      </div>
      {files.isLoading ? <LoadingState label="正在读取目录" /> : null}
      {files.isError ? <ErrorState error={files.error} onRetry={() => void files.refetch()} /> : null}
      {files.data ? (
        <div className="list">
          {path !== root ? (
            <button className="file-row" type="button" onClick={() => setPath(path.replace(/\/[^/]+\/?$/, "") || "/")}>
              <span className="row-icon"><Folder size={19} /></span>
              <span className="row-main"><span className="row-title">..</span></span>
            </button>
          ) : null}
          {files.data.map((entry) => {
            const fullPath = entryPath(path, entry);
            const directory = entryKind(entry) === "directory";
            return (
              <button
                className="file-row"
                type="button"
                key={fullPath}
                onClick={() => directory ? setPath(fullPath) : setOpenFile(fullPath)}
              >
                <span className="row-icon">
                  {directory ? <Folder size={19} /> : <FileText size={19} />}
                </span>
                <span className="row-main">
                  <span className="row-title">{entry.name || fullPath.split("/").pop()}</span>
                  <span className="row-preview">{directory ? "目录" : fileSize(entry.size)}</span>
                </span>
                <ChevronRight size={17} />
              </button>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

function ChangesView({ sessionId }: { sessionId: string }) {
  const sessions = useQuery({
    queryKey: ["session-summaries"],
    queryFn: () => listSessionSummaries(100),
  });
  const [selectedSessionId, setSelectedSessionId] = useState(sessionId);
  const selectedId = selectedSessionId || sessions.data?.[0]?.id || "";
  const artifacts = useQuery({
    queryKey: ["session-artifacts", selectedId],
    queryFn: () => getSessionArtifacts(selectedId),
    enabled: Boolean(selectedId),
  });
  const [selected, setSelected] = useState<ChangeSet | null>(null);
  if (sessions.isLoading) return <LoadingState label="正在读取会话" />;
  if (sessions.isError) return <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />;
  if (!selectedId) return <EmptyState icon={FileDiff} title="还没有会话" />;
  if (artifacts.isLoading) return <LoadingState label="正在读取 Changes" />;
  if (artifacts.isError) return <ErrorState error={artifacts.error} onRetry={() => void artifacts.refetch()} />;
  if (selected) {
    return (
      <div className="change-viewer">
        <button className="file-path-back" type="button" onClick={() => setSelected(null)}>
          ‹ {selected.path}
        </button>
        <div className="change-summary">
          <Badge tone="green">+{selected.addedLines}</Badge>
          <Badge tone="red">-{selected.removedLines}</Badge>
          <Badge>{selected.operation}</Badge>
        </div>
        <pre className="diff-document"><code>{selected.patch || selected.after || "No textual patch available."}</code></pre>
      </div>
    );
  }
  return (
    <>
      <div className="resource-picker">
        <label>
          <span>会话</span>
          <select
            value={selectedId}
            onChange={(event) => {
              setSelectedSessionId(event.target.value);
              setSelected(null);
            }}
          >
            {(sessions.data || []).map((session) => (
              <option value={session.id} key={session.id}>
                {session.title || session.lastMessage?.content || session.id}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!artifacts.data?.changes.length ? (
        <EmptyState icon={FileDiff} title="当前会话没有文件变更" />
      ) : (
        <div className="list">
          {artifacts.data.changes.map((change) => (
            <button className="file-row" type="button" key={change.id} onClick={() => setSelected(change)}>
              <span className="row-icon blue"><FileDiff size={19} /></span>
              <span className="row-main">
                <span className="row-title">{change.path}</span>
                <span className="row-preview">{change.operation} · +{change.addedLines} -{change.removedLines}</span>
              </span>
              <ChevronRight size={17} />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function FilesScreen() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "changes" ? "changes" : "files";
  const sessionId = params.get("session") || "";
  const terminalSessionId = params.get("terminal") || "";
  return (
    <MobilePage title="文件与变更" subtitle="当前工作区" back="更多">
      <SegmentedControl
        value={tab}
        options={[
          { value: "files", label: "文件" },
          { value: "changes", label: "变更" },
        ]}
        onChange={(value) => {
          const next = new URLSearchParams(params);
          next.set("tab", value);
          setParams(next);
        }}
      />
      {tab === "files" ? <FileBrowser terminalSessionId={terminalSessionId} /> : <ChangesView sessionId={sessionId} />}
    </MobilePage>
  );
}

function capabilityGroups(tools: CapabilityTool[]): Array<[string, CapabilityTool[]]> {
  const groups = new Map<string, CapabilityTool[]>();
  for (const tool of tools) {
    const source = tool.pluginId || tool.hostKinds?.[0] || "runtime";
    const key = source === "local-tools" || source === "device"
      ? "设备工具"
      : source === "runtime"
        ? "Runtime"
        : source.replace(/^dev\./, "");
    groups.set(key, [...(groups.get(key) || []), tool]);
  }
  return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right));
}

function capabilityRisk(tool: CapabilityTool): {
  label: string;
  tone: "green" | "blue" | "amber" | "red" | "neutral";
} {
  if (tool.risk === "external-effect") return { label: "外部操作", tone: "red" };
  if (tool.risk === "execute") return { label: "执行", tone: "amber" };
  if (tool.risk === "write") return { label: "写入", tone: "blue" };
  if (tool.name.endsWith("Manage")) return { label: "管理", tone: "blue" };
  return { label: "读取", tone: "green" };
}

function requiredPreset(tools: CapabilityTool[], enabled: string[]) {
  const rank = { "read-only": 1, "workspace-write": 2, "trusted-automation": 3 };
  let preset: keyof typeof rank = "read-only";
  for (const tool of tools) {
    if (!enabled.includes(tool.name)) continue;
    const required = tool.policy?.minimumPreset as keyof typeof rank | undefined;
    if (required && rank[required] > rank[preset]) preset = required;
  }
  return preset;
}

export function CapabilitiesScreen() {
  const queryClient = useQueryClient();
  const tools = useQuery({
    queryKey: ["capability-tools"],
    queryFn: listCapabilityTools,
  });
  const profiles = useQuery({
    queryKey: ["interaction-profiles"],
    queryFn: listInteractionProfiles,
  });
  const skills = useQuery({
    ...skillsSnapshotQueryOptions,
    refetchInterval: 3_000,
  });
  const [tab, setTab] = useState<"skills" | "tools">("skills");
  const [query, setQuery] = useState("");
  const interactive = profiles.data?.find((profile) => profile.id === "interactive.default")
    || profiles.data?.[0];
  const enabledTools = interactive?.policy?.allowedTools || [];
  const filteredTools = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return tools.data || [];
    return (tools.data || []).filter((tool) =>
      `${tool.name} ${tool.description || ""} ${tool.pluginId || ""}`
        .toLowerCase()
        .includes(value),
    );
  }, [query, tools.data]);
  const enabledSkills = new Set(skills.data?.enabled || []);
  const filteredSkills = useMemo(() => {
    const value = query.trim().toLowerCase();
    const catalog = skills.data?.catalog || [];
    if (!value) return catalog;
    return catalog.filter((skill) =>
      `${skill.name} ${skill.description || ""} ${(skill.tags || []).join(" ")}`
        .toLowerCase()
        .includes(value),
    );
  }, [query, skills.data]);
  const toggleTool = useMutation({
    mutationFn: async (name: string) => {
      if (!interactive) throw new Error("Runtime 没有默认交互配置");
      const next = enabledTools.includes(name)
        ? enabledTools.filter((item) => item !== name)
        : [...enabledTools, name];
      return await patchInteractionProfile(interactive.id, {
        policy: {
          ...interactive.policy,
          preset: requiredPreset(tools.data || [], next),
          allowedTools: next,
        },
      });
    },
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ["interaction-profiles"] });
    },
  });
  const toggleSkill = useMutation({
    scope: { id: "skills-global-selection" },
    mutationFn: (update: { id: string; enabled: boolean }) =>
      updateSkillsSnapshot({ updates: [update] }),
    async onMutate() {
      await queryClient.cancelQueries({ queryKey: ["skills-snapshot"] });
    },
    async onSuccess(snapshot) {
      // Discard any poll that started before this write was acknowledged.
      await queryClient.cancelQueries({ queryKey: ["skills-snapshot"] });
      queryClient.setQueryData(["skills-snapshot"], snapshot);
    },
    async onSettled() {
      await queryClient.invalidateQueries({ queryKey: ["skills-snapshot"] });
    },
  });
  const subtitle = tab === "skills"
    ? `${enabledSkills.size}/${skills.data?.catalog.length || 0} 已启用`
    : `${enabledTools.length}/${tools.data?.length || 0} 已启用`;
  return (
    <MobilePage title="Skills 与工具" subtitle={subtitle} back="更多">
      <SegmentedControl
        value={tab}
        options={[
          { value: "skills", label: "Skills", count: skills.data?.catalog.length },
          { value: "tools", label: "工具", count: tools.data?.length },
        ]}
        onChange={(value) => {
          setTab(value);
          setQuery("");
        }}
      />
      <div className="search-wrap">
        <label className="search-box">
          <Sparkles size={18} />
          <span className="sr-only">搜索 {tab === "skills" ? "Skills" : "工具"}</span>
          <input
            value={query}
            placeholder={tab === "skills" ? "搜索 Skills" : "搜索工具"}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      {tab === "skills" ? (
        <>
          {skills.isLoading ? <LoadingState label="正在读取 Skills" /> : null}
          {skills.isError ? <ErrorState error={skills.error} onRetry={() => void skills.refetch()} /> : null}
          {toggleSkill.isError ? (
            <ErrorState error={toggleSkill.error} onRetry={() => {
              if (toggleSkill.variables) toggleSkill.mutate(toggleSkill.variables);
            }} />
          ) : null}
          {!skills.isLoading && !filteredSkills.length ? (
            <EmptyState
              icon={Sparkles}
              title={query ? "没有匹配的 Skill" : "尚未同步 Skills"}
              description={query ? "调整关键词后重试。" : "在桌面端完成一次 Skills 扫描后会自动同步。"}
            />
          ) : null}
          {filteredSkills.length ? (
            <div className="list">
              {filteredSkills.map((skill) => {
                const enabled = enabledSkills.has(skill.id);
                return (
                  <div className="capability-row" key={skill.id}>
                    <span className="row-icon"><Sparkles size={18} /></span>
                    <span className="row-main">
                      <span className="row-title-line">
                        <span className="row-title">{skill.name || skill.id}</span>
                        {skill.source ? <Badge>{skill.source}</Badge> : null}
                      </span>
                      <span className="row-preview">{skill.description || skill.file || "Skill"}</span>
                    </span>
                    <button
                      className={`switch ${enabled ? "is-on" : ""}`}
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      aria-label={`${enabled ? "停用" : "启用"} ${skill.name || skill.id}`}
                      disabled={toggleSkill.isPending}
                      onClick={() => toggleSkill.mutate({ id: skill.id, enabled: !enabled })}
                    >
                      <span />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
        </>
      ) : (
        <>
          {tools.isLoading || profiles.isLoading ? <LoadingState label="正在读取工具" /> : null}
          {tools.isError ? <ErrorState error={tools.error} onRetry={() => void tools.refetch()} /> : null}
          {profiles.isError ? <ErrorState error={profiles.error} onRetry={() => void profiles.refetch()} /> : null}
          {capabilityGroups(filteredTools).map(([group, items]) => (
            <section key={group}>
              <SectionLabel>{group}</SectionLabel>
              <div className="list">
                {items.map((tool) => {
                  const enabled = enabledTools.includes(tool.name);
                  const risk = capabilityRisk(tool);
                  const unavailable = tool.modelInjectable === false
                    || tool.policy?.requiresApproval === true
                    || tool.name === "sendMail";
                  const unavailableText = tool.modelInjectable === false
                    ? tool.unavailableReason || "当前 Runtime 不会注入此工具"
                    : "需要额外审批或白名单";
                  return (
                    <div className="capability-row" key={tool.name}>
                      <span className="row-icon"><Wrench size={18} /></span>
                      <span className="row-main">
                        <span className="row-title-line">
                          <span className="row-title">{tool.name}</span>
                          <Badge tone={risk.tone}>{risk.label}</Badge>
                        </span>
                        <span className="row-preview">{unavailable ? unavailableText : tool.description || "Runtime 工具"}</span>
                      </span>
                      <button
                        className={`switch ${enabled ? "is-on" : ""}`}
                        type="button"
                        role="switch"
                        aria-checked={enabled}
                        aria-label={`${enabled ? "停用" : "启用"} ${tool.name}`}
                        disabled={toggleTool.isPending || (unavailable && !enabled) || !interactive}
                        onClick={() => {
                          const elevated = tool.policy?.minimumPreset === "trusted-automation"
                            || tool.risk === "external-effect";
                          if (
                            !enabled
                            && elevated
                            && !window.confirm(`启用“${tool.name}”将提高默认会话权限，是否继续？`)
                          ) {
                            return;
                          }
                          toggleTool.mutate(tool.name);
                        }}
                      >
                        <span />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </>
      )}
      {toggleTool.isError ? <div className="inline-error page-error">{toggleTool.error.message}</div> : null}
      {toggleSkill.isError ? <div className="inline-error page-error">{toggleSkill.error.message}</div> : null}
    </MobilePage>
  );
}

export function PluginsScreen() {
  const health = useQuery({
    queryKey: ["runtime-health"],
    queryFn: getHealth,
    staleTime: 30_000,
  });
  const plugins = useQuery({
    queryKey: ["plugins"],
    queryFn: listPlugins,
    refetchInterval: 30_000,
  });
  return (
    <MobilePage
      title="插件"
      subtitle={`${health.data?.runtimePlugins?.filter((plugin) => plugin.status === "active").length || 0} 运行中`}
      back="更多"
      action={<IconButton icon={RefreshCw} label="刷新" onClick={() => void plugins.refetch()} />}
    >
      {health.data?.runtimePlugins?.length ? (
        <>
          <SectionLabel>Runtime 插件</SectionLabel>
          <div className="list">
            {health.data.runtimePlugins.map((plugin) => (
              <div className="plugin-row" key={plugin.id}>
                <span className="row-icon"><Plug size={18} /></span>
                <span className="row-main">
                  <span className="row-title">{plugin.id.replace(/^dev\./, "")}</span>
                  <span className="row-preview">{plugin.version || "服务端能力"}</span>
                </span>
                <Badge tone={plugin.status === "active" ? "green" : "red"}>
                  {plugin.status === "active" ? "运行中" : plugin.status}
                </Badge>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {plugins.isLoading ? <LoadingState label="正在读取插件" /> : null}
      {plugins.isError ? <ErrorState error={plugins.error} onRetry={() => void plugins.refetch()} /> : null}
      {!plugins.isLoading && !plugins.isError && !plugins.data?.length ? (
        <EmptyState icon={Plug} title="没有发现插件" description="当前设备没有同步可用插件包。" />
      ) : null}
      {plugins.data?.length ? (
        <>
          <SectionLabel>设备插件包</SectionLabel>
          <div className="list">
            {plugins.data.map((plugin: PluginRecord) => {
              const status = plugin.status
                || (typeof plugin.enabled === "boolean"
                  ? (plugin.enabled ? "enabled" : "disabled")
                  : "available");
              return (
              <div className="plugin-row" key={plugin.id}>
                <span className="row-icon"><Plug size={18} /></span>
                <span className="row-main">
                  <span className="row-title-line">
                    <span className="row-title">
                      {plugin.name || plugin.metadata?.name || plugin.id}
                    </span>
                    <Badge tone={status === "disabled" ? "neutral" : "green"}>
                      {status === "available" ? "可用" : status}
                    </Badge>
                  </span>
                  <span className="row-preview">
                    {plugin.description
                      || plugin.metadata?.description
                      || plugin.version
                      || plugin.metadata?.version
                      || plugin.id}
                  </span>
                </span>
              </div>
              );
            })}
          </div>
        </>
      ) : null}
    </MobilePage>
  );
}

function modelLabel(profile: RuntimeModelProfile): string {
  return profile.label || profile.model || profile.id;
}

export function ModelsScreen() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const models = useQuery({
    queryKey: ["models"],
    queryFn: listModels,
  });
  const profiles = useQuery({
    queryKey: ["interaction-profiles"],
    queryFn: listInteractionProfiles,
  });
  const interactive = profiles.data?.find((profile) => profile.id === "interactive.default")
    || profiles.data?.[0];
  const selected = interactive?.modelProfileId || models.data?.activeProfileId || "";
  const filteredModels = useMemo(() => {
    const value = query.trim().toLowerCase();
    return [...(models.data?.profiles || [])]
      .filter((profile) => (
        !value
        || `${modelLabel(profile)} ${profile.providerId || ""} ${profile.model}`
          .toLowerCase()
          .includes(value)
      ))
      .sort((left, right) => (
        Number(right.id === selected) - Number(left.id === selected)
        || modelLabel(left).localeCompare(modelLabel(right))
      ));
  }, [models.data?.profiles, query, selected]);
  const select = useMutation({
    mutationFn: (modelProfileId: string) => {
      if (!interactive?.id) throw new Error("Runtime has no interaction profile");
      return patchInteractionProfile(interactive.id, { modelProfileId });
    },
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ["interaction-profiles"] });
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    },
  });
  return (
    <MobilePage title="模型" subtitle={interactive?.label || "Interaction Profile"} back="更多">
      <div className="search-wrap">
        <label className="search-box">
          <Cpu size={18} />
          <span className="sr-only">搜索模型</span>
          <input
            type="search"
            value={query}
            placeholder="搜索模型"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      {models.isLoading || profiles.isLoading ? <LoadingState /> : null}
      {models.isError ? <ErrorState error={models.error} onRetry={() => void models.refetch()} /> : null}
      {profiles.isError ? <ErrorState error={profiles.error} onRetry={() => void profiles.refetch()} /> : null}
      {filteredModels.length ? (
        <div className="list">
          {filteredModels.map((profile) => {
            const active = profile.id === selected;
            const available = profile.credentialRequired === false || profile.credentialConfigured !== false;
            return (
              <button
                className="model-row"
                type="button"
                key={profile.id}
                disabled={!available || select.isPending}
                onClick={() => select.mutate(profile.id)}
              >
                <span className={`model-radio ${active ? "is-active" : ""}`}>
                  {active ? <Check size={14} /> : null}
                </span>
                <span className="row-main">
                  <span className="row-title-line">
                    <span className="row-title">{modelLabel(profile)}</span>
                    <Badge tone={available ? "green" : "red"}>{available ? "可用" : "缺少凭证"}</Badge>
                  </span>
                  <span className="row-preview">{profile.providerId || profile.providerType || "Runtime"} · {profile.model}</span>
                </span>
                <ChevronRight size={17} />
              </button>
            );
          })}
        </div>
      ) : null}
      {select.isError ? <div className="inline-error page-error">{select.error.message}</div> : null}
    </MobilePage>
  );
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && "items" in value) {
    const items = (value as { items?: unknown }).items;
    return Array.isArray(items) ? items : [];
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function KnowledgeScreen() {
  const [view, setView] = useState<"identity" | "memory">("identity");
  const [memoryFilter, setMemoryFilter] = useState("");
  const queries = useQueries({
    queries: [{
      ...skillsSnapshotQueryOptions,
    }, {
      queryKey: ["workbench-kv", MEMORY_SNAPSHOT_KEY],
      queryFn: () => readWorkbenchKV(MEMORY_SNAPSHOT_KEY),
      staleTime: 30_000,
    }],
  });
  const skillsSnapshot = asRecord(queries[0].data);
  const memorySnapshot = asRecord(queries[1].data);
  const skills = asArray(skillsSnapshot.catalog);
  const enabledSkills = asArray(skillsSnapshot.enabled);
  const memories = asArray(memorySnapshot.items);
  const filteredMemories = useMemo(() => {
    const query = memoryFilter.trim().toLowerCase();
    if (!query) return memories;
    return memories.filter((item) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return [
        record.title,
        record.summary,
        record.content,
        record.detail,
        record.kind,
      ].some((value) => String(value || "").toLowerCase().includes(query));
    });
  }, [memories, memoryFilter]);
  const loading = queries.some((query) => query.isLoading);
  const error = queries.find((query) => query.isError)?.error;
  return (
    <MobilePage title="Identity" subtitle="用户数据空间" back="更多" className="knowledge-page">
      <section className="knowledge-overview">
        <div className="knowledge-overview-title">
          <span>User Space</span>
          <strong>dev.identity</strong>
        </div>
        <div className="knowledge-summary">
          <div><strong>{loading ? "-" : `${enabledSkills.length}/${skills.length}`}</strong><span>Skills</span></div>
          <div><strong>{loading ? "-" : memories.length}</strong><span>旧 Memory</span></div>
        </div>
      </section>
      <SegmentedControl
        value={view}
        onChange={setView}
        options={[
          { value: "identity", label: "Identity 数据" },
          { value: "memory", label: "旧 Memory", count: memories.length },
        ]}
      />
      {view === "identity" ? <PluginDataFiles pluginId="dev.identity" /> : null}
      {view === "memory" ? (
        <section className="legacy-memory-panel">
          {loading ? <LoadingState label="正在读取 Memory" /> : null}
          {error ? <ErrorState error={error} /> : null}
          {!loading && !error ? (
            <>
              <label className="memory-search">
                <Search size={16} aria-hidden="true" />
                <input
                  value={memoryFilter}
                  onChange={(event) => setMemoryFilter(event.target.value)}
                  placeholder="搜索"
                />
              </label>
              <SectionLabel>{memoryFilter.trim() ? "搜索结果" : "最近知识"}</SectionLabel>
              {!filteredMemories.length ? (
                <EmptyState
                  icon={MemoryStick}
                  title={memoryFilter.trim() ? "没有匹配项" : "还没有同步的知识"}
                />
              ) : (
                <div className="legacy-memory-list">
                  {filteredMemories.slice(0, 30).map((item, index) => {
                    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
                    const title = String(record.title || record.summary || "Memory item");
                    const preview = String(record.content || record.detail || record.kind || "")
                      .replace(/\s+/g, " ")
                      .trim();
                    return (
                      <article className="knowledge-row" key={String(record.id || index)}>
                        <span className="row-icon amber"><MemoryStick size={18} /></span>
                        <span className="row-main">
                          <span className="row-title-line">
                            <span className="row-title">{title}</span>
                            {record.kind ? <Badge>{String(record.kind)}</Badge> : null}
                          </span>
                          {preview ? <span className="row-preview">{preview.slice(0, 220)}</span> : null}
                        </span>
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          ) : null}
        </section>
      ) : null}
    </MobilePage>
  );
}

export function CommentsScreen() {
  const comments = useQuery({
    queryKey: ["workbench-kv", "zion.comments.threads.v1"],
    queryFn: () => readWorkbenchKV("zion.comments.threads.v1"),
  });
  const threads = asArray(comments.data);
  return (
    <MobilePage title="评论" subtitle={`${threads.length} 个线程`} back="更多">
      {comments.isLoading ? <LoadingState /> : null}
      {comments.isError ? <ErrorState error={comments.error} onRetry={() => void comments.refetch()} /> : null}
      {!comments.isLoading && !threads.length ? (
        <EmptyState
          icon={MessageCircle}
          title="没有可用评论线程"
          description="移动端会显示桌面端已同步的评论线程。"
        />
      ) : null}
      {threads.length ? (
        <div className="list">
          {threads.map((item, index) => {
            const thread = item as Record<string, unknown>;
            return (
              <article className="comment-card" key={String(thread.id || index)}>
                <header>
                  <strong>{String(thread.title || thread.summary || "评论线程")}</strong>
                  <Badge tone={thread.resolved ? "green" : "amber"}>
                    {thread.resolved ? "已解决" : "进行中"}
                  </Badge>
                </header>
                <blockquote>{String(thread.quote || thread.anchorText || "")}</blockquote>
                <p>{String(thread.content || thread.text || thread.summary || "")}</p>
              </article>
            );
          })}
        </div>
      ) : null}
    </MobilePage>
  );
}

function deviceTone(device: AccessDevice): "green" | "blue" | "neutral" {
  if (device.revokedAt) return "neutral";
  if (device.kind === "resource") return "green";
  if (device.kind === "owner") return "blue";
  return "neutral";
}

export function DevicesScreen() {
  const queryClient = useQueryClient();
  const [pairing, setPairing] = useState<Awaited<ReturnType<typeof createPairing>> | null>(null);
  const health = useQuery({
    queryKey: ["runtime-health"],
    queryFn: getHealth,
  });
  const remoteAccess = health.data?.authRequired === true;
  const accountMode = !!currentAccountSession();
  const access = useQuery({
    queryKey: ["access-session"],
    queryFn: getAccessSession,
    enabled: remoteAccess,
  });
  const devices = useQuery({
    queryKey: ["access-devices"],
    queryFn: listDevices,
    enabled: remoteAccess && accountCan("device.manage"),
  });
  const nodes = useQuery({
    queryKey: ["device-nodes"],
    queryFn: listDeviceNodes,
    enabled: remoteAccess && accountCan("device.manage"),
  });
  const create = useMutation({
    mutationFn: createPairing,
    onSuccess: setPairing,
  });
  const revoke = useMutation({
    mutationFn: revokeDevice,
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ["access-devices"] });
    },
  });
  const limited = devices.error instanceof RuntimeApiError && devices.error.status === 403;
  const nodeItems = asArray(asRecord(nodes.data).nodes);
  return (
    <MobilePage
      title="设备与远程访问"
      subtitle={remoteAccess ? access.data?.device?.label || (accountMode ? "资源设备" : "访问控制") : "本机直连"}
      back="更多"
    >
      {health.isLoading || (remoteAccess && access.isLoading) ? <LoadingState /> : null}
      {health.isError ? <ErrorState error={health.error} onRetry={() => void health.refetch()} /> : null}
      {health.data && !remoteAccess ? (
        <div className="permission-notice local">
          <Server size={18} />
          当前在本机运行，无需浏览器配对；文件和终端服务已连接。
        </div>
      ) : null}
      {remoteAccess && access.isError ? <ErrorState error={access.error} onRetry={() => void access.refetch()} /> : null}
      {access.data?.device ? (
        <section className="detail-section">
          <h2>当前设备</h2>
          <dl className="kv">
            <dt>名称</dt><dd>{access.data.device.label}</dd>
            <dt>类型</dt><dd>{access.data.device.kind}</dd>
            <dt>权限</dt><dd>{access.data.device.scopes.join(", ")}</dd>
            <dt>有效期</dt><dd>{new Date(access.data.expiresAt).toLocaleString()}</dd>
          </dl>
        </section>
      ) : null}
      {limited ? (
        <div className="permission-notice">
          <ShieldCheck size={18} />
          当前设备可以使用对话，但没有设备管理权限。
        </div>
      ) : null}
      {!limited && devices.data ? (
        <>
          <SectionLabel>已配对设备</SectionLabel>
          <div className="list">
            {devices.data.map((device) => (
              <div className="device-row" key={device.deviceId}>
                <span className={`row-icon ${deviceTone(device)}`}><Laptop size={18} /></span>
                <span className="row-main">
                  <span className="row-title-line">
                    <span className="row-title">{device.label}</span>
                    <Badge tone={deviceTone(device)}>{device.kind}</Badge>
                  </span>
                  <span className="row-preview">{device.platform || device.deviceId} · {formatRelativeTime(device.lastSeenAt)}</span>
                </span>
                {device.deviceId !== access.data?.device?.deviceId ? (
                  <IconButton
                    icon={Trash2}
                    label={`吊销 ${device.label}`}
                    disabled={revoke.isPending}
                    onClick={() => {
                      if (window.confirm(`吊销设备“${device.label}”？现有连接会立即失效。`)) {
                        revoke.mutate(device.deviceId);
                      }
                    }}
                  />
                ) : null}
              </div>
            ))}
          </div>
          <div className="action-bar">
            {!accountMode && <button className="button flex" type="button" onClick={() => create.mutate("client")}>
              <Plus size={17} />Client
            </button>}
            <button className="button primary flex" type="button" onClick={() => create.mutate("resource")}>
              <Plus size={17} />Resource
            </button>
          </div>
        </>
      ) : null}
      {nodeItems.length ? (
        <>
          <SectionLabel>资源节点</SectionLabel>
          <div className="list">
            {nodeItems.map((item, index) => {
              const node = asRecord(item);
              const resources = asArray(node.resources);
              return (
                <div className="device-row" key={String(node.nodeId || index)}>
                  <span className="row-icon green"><Server size={18} /></span>
                  <span className="row-main">
                    <span className="row-title-line">
                      <span className="row-title">{String(node.label || node.nodeId || "Resource")}</span>
                      <Badge tone={node.status === "online" ? "green" : "neutral"}>
                        {String(node.status || "unknown")}
                      </Badge>
                    </span>
                    <span className="row-preview">
                      {String(node.platform || "Device")} · {resources.length} 个资源
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
      {pairing ? (
        <section className="pairing-result">
          <KeyRound size={20} />
          <div><strong>{pairing.userCode}</strong><span>{pairing.kind} · {new Date(pairing.expiresAt).toLocaleTimeString()}</span></div>
          <IconButton
            icon={Clipboard}
            label="复制配对码"
            onClick={() => void navigator.clipboard.writeText(pairing.userCode)}
          />
        </section>
      ) : null}
      {create.isError ? <div className="inline-error page-error">{create.error.message}</div> : null}
      {revoke.isError ? <div className="inline-error page-error">{revoke.error.message}</div> : null}
    </MobilePage>
  );
}

export function SettingsScreen() {
  const health = useQuery({
    queryKey: ["runtime-health"],
    queryFn: getHealth,
  });
  const [notifications, setNotifications] = useState(
    localStorage.getItem("zion.mobile.notifications") === "on"
      && "Notification" in window
      && Notification.permission === "granted",
  );
  const signOut = useMutation({
    mutationFn: logout,
    onSuccess() {
      location.reload();
    },
  });
  const toggleNotifications = async () => {
    if (!notifications && "Notification" in window && Notification.permission === "default") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return;
    }
    const next = !notifications;
    setNotifications(next);
    localStorage.setItem("zion.mobile.notifications", next ? "on" : "off");
  };
  return (
    <MobilePage title="设置" subtitle="Mobile Client" back="更多">
      <SectionLabel>通知</SectionLabel>
      <div className="list">
        <div className="setting-row">
          <span className="row-icon"><Bell size={18} /></span>
          <span className="row-main">
            <span className="row-title">运行完成通知</span>
            <span className="row-preview">页面进入后台后使用系统通知</span>
          </span>
          <button
            className={`switch ${notifications ? "is-on" : ""}`}
            type="button"
            role="switch"
            aria-checked={notifications}
            aria-label="运行完成通知"
            onClick={() => void toggleNotifications()}
          >
            <span />
          </button>
        </div>
      </div>
      <SectionLabel>客户端</SectionLabel>
      <section className="detail-section">
        <dl className="kv">
          <dt>应用</dt><dd>Zion Mobile</dd>
          <dt>路径</dt><dd>{import.meta.env.BASE_URL}</dd>
          <dt>数据源</dt><dd>Runtime API</dd>
          <dt>本地状态</dt><dd>草稿与 UI 偏好</dd>
        </dl>
      </section>
      {health.data?.authRequired && !currentAccountSession() ? (
        <div className="action-bar">
          <button className="button danger flex" type="button" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
            <LogOut size={17} />退出当前设备
          </button>
        </div>
      ) : null}
    </MobilePage>
  );
}
