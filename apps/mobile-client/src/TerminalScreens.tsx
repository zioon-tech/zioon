import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CircleAlert,
  Copy,
  FolderOpen,
  Plus,
  RefreshCw,
  Search,
  Server,
  SquareTerminal,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import {
  closeTerminalSession,
  createTerminalSession,
  listInteractionProfiles,
  listTerminalSessions,
  patchInteractionProfile,
} from "./api";
import { terminalDetailPath, terminalRouteSessionId } from "./terminal-routing";
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
import { connectPty, type PtyConnection, type PtyTransportStatus } from "./pty";
import type { TerminalSession } from "./types";

function terminalId(session: TerminalSession): string {
  return String(session.id || session.session_id || "");
}

function terminalName(session: TerminalSession): string {
  return String(session.name || session.cwd || session.initial_cwd || terminalId(session));
}

type TerminalPathInfo = {
  fullPath: string;
  root: string;
  rootLabel: string;
  projectName: string;
  relativePath: string;
};

type TerminalNodeInfo = {
  key: string;
  label: string;
  detail: string;
  kind: "local" | "ssh" | "node";
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "") || "/";
}

function basename(path: string): string {
  return trimTrailingSlash(path).split("/").filter(Boolean).at(-1) || path || "/";
}

function shortHome(path: string): string {
  const homePrefix = "/Users/";
  if (!path.startsWith(homePrefix)) return path;
  const parts = path.split("/");
  if (parts.length < 4) return path;
  return `~${path.slice(`/Users/${parts[2]}`.length) || "/"}`;
}

function pathInfo(session: TerminalSession): TerminalPathInfo {
  const fullPath = String(session.cwd || session.initial_cwd || "~");
  const explicitRoot = String(session.projectRoot || session.project_root || "").trim();
  const explicitName = String(session.projectName || session.project_name || "").trim();
  const normalized = trimTrailingSlash(fullPath);
  if (explicitRoot) {
    const root = trimTrailingSlash(explicitRoot);
    const relativePath = normalized.startsWith(`${root}/`)
      ? normalized.slice(root.length + 1) || "."
      : ".";
    return {
      fullPath,
      root,
      rootLabel: shortHome(root),
      projectName: explicitName || basename(root),
      relativePath,
    };
  }
  const worktreeMatch = normalized.match(/^(.*?\/\.worktrees\/([^/]+))(?:\/(.*))?$/);
  if (worktreeMatch) {
    return {
      fullPath,
      root: worktreeMatch[1],
      rootLabel: shortHome(worktreeMatch[1]),
      projectName: worktreeMatch[2],
      relativePath: worktreeMatch[3] || ".",
    };
  }
  const dotWorktreeMatch = normalized.match(/^(.*?\/([^/]+))\/\.worktree\/[^/]+(?:\/(.*))?$/);
  if (dotWorktreeMatch) {
    return {
      fullPath,
      root: dotWorktreeMatch[1],
      rootLabel: shortHome(dotWorktreeMatch[1]),
      projectName: dotWorktreeMatch[2],
      relativePath: dotWorktreeMatch[3] ? `.worktree/.../${dotWorktreeMatch[3]}` : ".worktree",
    };
  }
  const gitsMatch = normalized.match(/^(.*?\/gits\/([^/]+))(?:\/(.*))?$/);
  if (gitsMatch) {
    return {
      fullPath,
      root: gitsMatch[1],
      rootLabel: shortHome(gitsMatch[1]),
      projectName: gitsMatch[2],
      relativePath: gitsMatch[3] || ".",
    };
  }
  const downloadsMatch = normalized.match(/^(.*?\/Downloads\/([^/]+))(?:\/(.*))?$/);
  if (downloadsMatch) {
    return {
      fullPath,
      root: downloadsMatch[1],
      rootLabel: shortHome(downloadsMatch[1]),
      projectName: downloadsMatch[2],
      relativePath: downloadsMatch[3] || ".",
    };
  }
  const root = normalized === "~" ? "~" : normalized.replace(/\/[^/]+$/, "") || "/";
  return {
    fullPath,
    root,
    rootLabel: shortHome(root),
    projectName: basename(normalized),
    relativePath: ".",
  };
}

function terminalNodeInfo(session: TerminalSession): TerminalNodeInfo {
  const nodeId = String(session.nodeId || session.node_id || "").trim();
  const nodeLabel = String(session.nodeLabel || session.node_label || "").trim();
  if (nodeId || nodeLabel) {
    return {
      key: nodeId || nodeLabel,
      label: nodeLabel || nodeId,
      detail: nodeId && nodeLabel && nodeId !== nodeLabel ? nodeId : "Runtime Node",
      kind: "node",
    };
  }
  if (session.type === "ssh" || session.ssh_host) {
    const host = String(session.ssh_host || "ssh").trim();
    const user = String(session.ssh_user || "").trim();
    return {
      key: `ssh:${host}`,
      label: user ? `${user}@${host}` : host,
      detail: session.ssh_port ? `SSH :${session.ssh_port}` : "SSH",
      kind: "ssh",
    };
  }
  return {
    key: "local",
    label: "Local Mac",
    detail: "本机终端",
    kind: "local",
  };
}

function lastActivityTime(session: TerminalSession): number | undefined {
  const raw = session.updated_at || session.last_activity || session.created_at;
  if (typeof raw === "number") return raw < 10_000_000_000 ? raw * 1000 : raw;
  if (typeof raw === "string" && raw.trim()) {
    const value = Number(raw);
    if (Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function terminalSearchText(session: TerminalSession): string {
  const info = pathInfo(session);
  const node = terminalNodeInfo(session);
  return [
    terminalName(session),
    terminalId(session),
    info.projectName,
    info.relativePath,
    info.fullPath,
    node.label,
    node.detail,
  ].join(" ").toLowerCase();
}

function terminalGroups(sessions: TerminalSession[]) {
  const groups = new Map<string, {
    node: TerminalNodeInfo;
    sessions: TerminalSession[];
  }>();
  for (const session of sessions) {
    const node = terminalNodeInfo(session);
    const current = groups.get(node.key) || { node, sessions: [] };
    current.sessions.push(session);
    groups.set(node.key, current);
  }
  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      sessions: group.sessions.sort((left, right) => {
        const leftActivity = lastActivityTime(left) || 0;
        const rightActivity = lastActivityTime(right) || 0;
        if (leftActivity !== rightActivity) return rightActivity - leftActivity;
        const leftPath = pathInfo(left);
        const rightPath = pathInfo(right);
        return leftPath.projectName.localeCompare(rightPath.projectName)
          || leftPath.relativePath.localeCompare(rightPath.relativePath)
          || terminalId(left).localeCompare(terminalId(right));
      }),
    }))
    .sort((left, right) =>
      Number(right.node.kind === "local") - Number(left.node.kind === "local")
      || left.node.label.localeCompare(right.node.label)
    );
}

export function TerminalsScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<"workspace" | "all">("workspace");
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const sessions = useQuery({
    queryKey: ["terminal-sessions"],
    queryFn: listTerminalSessions,
    refetchInterval: 8_000,
  });
  const profiles = useQuery({
    queryKey: ["interaction-profiles"],
    queryFn: listInteractionProfiles,
  });
  const interactive = profiles.data?.find((profile) => profile.id === "interactive.default")
    || profiles.data?.[0];
  const preferredIds = interactive?.policy?.allowedTerminalSessionIds || [];
  const workspaceRoot = interactive?.policy?.fileRoots?.[0] || "";
  const workspaceCount = preferredIds.length || sessions.data?.length || 0;
  const visibleSessions = (sessions.data || []).filter((session) => {
    const id = terminalId(session);
    const inWorkspace = !preferredIds.length || preferredIds.includes(id);
    if (scope === "workspace" && !inWorkspace) return false;
    const value = query.trim().toLowerCase();
    return !value || terminalSearchText(session).includes(value);
  });
  const groups = useMemo(() => terminalGroups(visibleSessions), [visibleSessions]);
  const sourceCount = groups.length;
  const searching = Boolean(query.trim());
  const create = useMutation({
    mutationFn: async () => {
      const session = await createTerminalSession({
        type: "local",
        initial_cwd: workspaceRoot || undefined,
      });
      if (interactive) {
        const id = terminalId(session);
        await patchInteractionProfile(interactive.id, {
          policy: {
            ...interactive.policy,
            allowedTerminalSessionIds: [...new Set([...preferredIds, id])],
          },
        });
      }
      return session;
    },
    onSuccess(session) {
      void queryClient.invalidateQueries({ queryKey: ["terminal-sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["interaction-profiles"] });
      navigate(terminalDetailPath(terminalId(session)));
    },
  });
  const close = useMutation({
    mutationFn: async (sessionId: string) => {
      await closeTerminalSession(sessionId);
      if (interactive && preferredIds.includes(sessionId)) {
        await patchInteractionProfile(interactive.id, {
          policy: {
            ...interactive.policy,
            allowedTerminalSessionIds: preferredIds.filter((id) => id !== sessionId),
          },
        });
      }
    },
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ["terminal-sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["interaction-profiles"] });
    },
  });
  return (
    <MobilePage
      title="终端"
      subtitle={sessions.data ? `${sourceCount} 个 Node 来源 · ${visibleSessions.length}/${sessions.data.length} 个终端` : "正在连接"}
      className="terminals-page"
      action={
        <IconButton
          icon={Plus}
          label="新建终端"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        />
      }
    >
      {sessions.isLoading || profiles.isLoading ? (
        <LoadingState label="正在连接终端" />
      ) : null}
      {sessions.isError ? (
        <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : null}
      {profiles.isError ? (
        <ErrorState error={profiles.error} onRetry={() => void profiles.refetch()} />
      ) : null}
      {sessions.data?.length && !profiles.isLoading ? (
        <>
          <SegmentedControl
            value={scope}
            options={[
              { value: "workspace", label: "当前项目", count: workspaceCount },
              { value: "all", label: "全部", count: sessions.data.length },
            ]}
            onChange={setScope}
          />
          <div className="search-wrap">
            <label className="search-box">
              <Search size={18} />
              <span className="sr-only">搜索终端</span>
              <input
                type="search"
                value={query}
                placeholder="搜索终端"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
        </>
      ) : null}
      {!sessions.isLoading && !profiles.isLoading && !sessions.isError && !sessions.data?.length ? (
        <EmptyState
          icon={SquareTerminal}
          title="没有可用终端"
          description="当前设备没有可用终端，请检查设备连接状态。"
          action={
            <button className="button primary" type="button" onClick={() => create.mutate()}>
              <Plus size={17} />新建终端
            </button>
          }
        />
      ) : null}
      {!sessions.isLoading && !profiles.isLoading && Boolean(sessions.data?.length) && !visibleSessions.length ? (
        <EmptyState
          icon={SquareTerminal}
          title={query ? "没有匹配的终端" : "当前工作区没有终端"}
          description={query ? "调整关键词后重试。" : "新建终端会自动绑定当前工作区。"}
        />
      ) : null}
      {!profiles.isLoading && visibleSessions.length ? (
        <>
          {groups.map((group) => {
            const activeCount = group.sessions.filter((session) =>
              session.status !== "closed" && session.active !== false
            ).length;
            const NodeIcon = group.node.kind === "local" ? SquareTerminal : Server;
            const expanded = expandedGroups.has(group.node.key) || searching;
            const shownSessions = expanded ? group.sessions : group.sessions.slice(0, 12);
            return (
              <section className="terminal-group" key={group.node.key}>
                <header className="terminal-node-head">
                  <span className={`terminal-node-icon ${activeCount ? "is-online" : ""}`}>
                    <NodeIcon size={18} />
                  </span>
                  <span className="terminal-node-main">
                    <small className="terminal-node-label">Node</small>
                    <strong>{group.node.label}</strong>
                    <small>{group.node.detail} · {activeCount}/{group.sessions.length} 在线</small>
                  </span>
                  <span className="terminal-node-count">
                    <strong>{activeCount}</strong>
                    <small>{group.sessions.length} terminals</small>
                  </span>
                </header>
                <div className="terminal-node-body">
                  {shownSessions.map((session) => {
                    const id = terminalId(session);
                    const active = session.status !== "closed" && session.active !== false;
                    const info = pathInfo(session);
                    return (
                      <article className="terminal-row terminal-session-row" key={id}>
                        <span className={`terminal-session-marker ${active ? "is-active" : ""}`} aria-hidden="true" />
                        <button
                          className="terminal-row-main"
                          type="button"
                          title={info.fullPath}
                          onClick={() => navigate(terminalDetailPath(id))}
                        >
                          <span className="row-main">
                            <span className="row-title-line">
                              <span className="row-title">{info.projectName}</span>
                              <Badge tone={active ? "green" : "neutral"}>
                                {active ? "在线" : "已关闭"}
                              </Badge>
                            </span>
                            <span className="row-preview">{info.relativePath}</span>
                            <small className="row-foot">
                              {info.rootLabel}
                              {lastActivityTime(session) ? ` · ${formatRelativeTime(lastActivityTime(session))}` : ""}
                            </small>
                          </span>
                        </button>
                        <IconButton
                          icon={Trash2}
                          label={`关闭 ${info.projectName}`}
                          disabled={close.isPending}
                          onClick={() => {
                            if (window.confirm(`关闭终端“${info.projectName} · ${info.relativePath}”？`)) {
                              close.mutate(id);
                            }
                          }}
                        />
                      </article>
                    );
                  })}
                  {group.sessions.length > shownSessions.length ? (
                    <button
                      className="terminal-group-more"
                      type="button"
                      onClick={() => setExpandedGroups((current) => {
                        const next = new Set(current);
                        next.add(group.node.key);
                        return next;
                      })}
                    >
                      展开其余 {group.sessions.length - shownSessions.length} 个终端
                    </button>
                  ) : expanded && !searching && group.sessions.length > 12 ? (
                    <button
                      className="terminal-group-more"
                      type="button"
                      onClick={() => setExpandedGroups((current) => {
                        const next = new Set(current);
                        next.delete(group.node.key);
                        return next;
                      })}
                    >
                      收起
                    </button>
                  ) : null}
                </div>
              </section>
            );
          })}
        </>
      ) : null}
      {create.isError ? <div className="inline-error page-error">{create.error.message}</div> : null}
    </MobilePage>
  );
}

function keyData(key: string): string {
  const values: Record<string, string> = {
    Esc: "\u001b",
    Tab: "\t",
    "Ctrl-C": "\u0003",
    "↑": "\u001b[A",
    "↓": "\u001b[B",
    "←": "\u001b[D",
    "→": "\u001b[C",
  };
  return values[key] || "";
}

const TERMINAL_KEYS: Array<{ key: string; icon?: LucideIcon }> = [
  { key: "Esc" },
  { key: "Ctrl-C" },
  { key: "Tab" },
  { key: "↑", icon: ArrowUp },
  { key: "↓", icon: ArrowDown },
  { key: "←", icon: ArrowLeft },
  { key: "→", icon: ArrowRight },
];

export function TerminalDetailScreen() {
  const { sessionId = "" } = useParams();
  const decoded = terminalRouteSessionId(sessionId);
  const navigate = useNavigate();
  const hostRef = useRef<HTMLDivElement>(null);
  const connectionRef = useRef<PtyConnection | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<PtyTransportStatus>({
    transport: "connecting",
    phase: "webrtc",
  });
  const [error, setError] = useState("");
  const sessions = useQuery({
    queryKey: ["terminal-sessions"],
    queryFn: listTerminalSessions,
  });
  const session = sessions.data?.find((item) => terminalId(item) === decoded);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: {
        background: "#171b22",
        foreground: "#d8e0ea",
        cursor: "#70d6a6",
        selectionBackground: "#3b4b63",
        black: "#171b22",
        red: "#ff7b86",
        green: "#70d6a6",
        yellow: "#f0c674",
        blue: "#79a8ff",
        magenta: "#c397d8",
        cyan: "#6fd3d3",
        white: "#d8e0ea",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    terminal.writeln("Connecting to terminal...");
    terminalRef.current = terminal;
    const connection = connectPty(decoded, terminal.cols, terminal.rows);
    connectionRef.current = connection;
    const dataDisposable = connection.onData((data) => terminal.write(data));
    const transportDisposable = connection.onTransportChange((nextStatus) => {
      setStatus(nextStatus);
      if (nextStatus.phase === "connected") setError("");
    });
    connection.onError((nextError) => {
      setError(nextError.message);
      terminal.writeln(`\r\n\u001b[31m${nextError.message}\u001b[0m`);
    });
    connection.onClose(() => {
      setStatus({ transport: "disconnected" });
      terminal.writeln("\r\nConnection closed.");
    });
    const inputDisposable = terminal.onData((data) => connection.send(data));
    void connection.ready.catch((nextError) => {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    });
    const resize = new ResizeObserver(() => {
      try {
        fit.fit();
        connection.resize(terminal.cols, terminal.rows);
      } catch {
        // The terminal can resize while the page is being removed.
      }
    });
    resize.observe(host);
    return () => {
      resize.disconnect();
      inputDisposable.dispose();
      dataDisposable();
      transportDisposable();
      connection.dispose();
      terminal.dispose();
      connectionRef.current = null;
      terminalRef.current = null;
    };
  }, [decoded]);

  const transportLabel = status.transport === "webrtc"
    ? `直连${status.roundTripTimeMs != null ? ` · ${status.roundTripTimeMs}ms` : ""}`
    : status.transport === "relay"
      ? "中转连接"
      : status.transport === "ws"
        ? "WebSocket"
      : status.transport === "disconnected"
        ? "已断开"
        : status.phase === "ws"
          ? "正在切换 WebSocket"
          : status.phase === "relay"
          ? "正在切换中转"
          : "正在协商直连";

  const info = session ? pathInfo(session) : null;
  const node = session ? terminalNodeInfo(session) : null;
  const copyCwd = () => {
    if (!info?.fullPath) return;
    void navigator.clipboard.writeText(info.fullPath);
  };

  return (
    <MobilePage
      title={info?.projectName || (session ? terminalName(session) : "终端")}
      subtitle={[node?.label, info?.relativePath, transportLabel].filter(Boolean).join(" · ")}
      back="终端"
      hideNav
      className="terminal-page"
      action={
        <IconButton
          icon={RefreshCw}
          label="重新连接"
          onClick={() => navigate(0)}
        />
      }
      footer={
        <div className="terminal-keys" aria-label="终端快捷键">
          {TERMINAL_KEYS.map(({ key, icon: Icon }) => (
            <button
              type="button"
              key={key}
              aria-label={key}
              onClick={() => connectionRef.current?.send(keyData(key))}
            >
              {Icon ? <Icon size={15} /> : key}
            </button>
          ))}
        </div>
      }
    >
      {session && info && node ? (
        <section className="terminal-context">
          <div>
            <span><Server size={14} />{node.label}</span>
            <span><FolderOpen size={14} />{info.relativePath}</span>
          </div>
          <code>{info.fullPath}</code>
          <button type="button" onClick={copyCwd}>
            <Copy size={14} />复制 cwd
          </button>
        </section>
      ) : null}
      <div className="terminal-viewport" ref={hostRef} />
      {error ? (
        <div className="terminal-error">
          <CircleAlert size={16} />{error}
        </div>
      ) : null}
    </MobilePage>
  );
}
