import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CircleAlert,
  Plus,
  RefreshCw,
  Search,
  SquareTerminal,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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
import {
  Badge,
  EmptyState,
  ErrorState,
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

export function TerminalsScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<"workspace" | "all">("workspace");
  const [query, setQuery] = useState("");
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
  const visibleSessions = (sessions.data || []).filter((session) => {
    const id = terminalId(session);
    const inWorkspace = !preferredIds.length || preferredIds.includes(id);
    if (scope === "workspace" && !inWorkspace) return false;
    const value = query.trim().toLowerCase();
    return !value || `${terminalName(session)} ${session.cwd || session.initial_cwd || ""}`
      .toLowerCase()
      .includes(value);
  });
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
      navigate(`/terminal/${encodeURIComponent(terminalId(session))}`);
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
      subtitle={sessions.data ? `${visibleSessions.length}/${sessions.data.length} 个会话` : "正在连接"}
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
              { value: "workspace", label: "当前工作区", count: preferredIds.length },
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
          <SectionLabel>会话</SectionLabel>
          <div className="list terminal-list">
            {visibleSessions.map((session) => {
              const id = terminalId(session);
              const active = session.status !== "closed" && session.active !== false;
              return (
                <article className="terminal-row" key={id}>
                  <button
                    className="terminal-row-main"
                    type="button"
                    onClick={() => navigate(`/terminal/${encodeURIComponent(id)}`)}
                  >
                    <span className={`row-icon ${active ? "green" : ""}`}>
                      <SquareTerminal size={19} />
                    </span>
                    <span className="row-main">
                      <span className="row-title-line">
                        <span className="row-title">{terminalName(session)}</span>
                        <Badge tone={active ? "green" : "neutral"}>
                          {active ? "在线" : "已关闭"}
                        </Badge>
                      </span>
                      <span className="row-preview">
                        {session.cwd || session.initial_cwd || session.type || "local"}
                      </span>
                    </span>
                  </button>
                  <IconButton
                    icon={Trash2}
                    label={`关闭 ${terminalName(session)}`}
                    disabled={close.isPending}
                    onClick={() => {
                      if (window.confirm(`关闭终端“${terminalName(session)}”？`)) {
                        close.mutate(id);
                      }
                    }}
                  />
                </article>
              );
            })}
          </div>
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
  const decoded = decodeURIComponent(sessionId);
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
      : status.transport === "disconnected"
        ? "已断开"
        : status.phase === "relay"
          ? "正在切换中转"
          : "正在协商直连";

  return (
    <MobilePage
      title={session ? terminalName(session) : "终端"}
      subtitle={transportLabel}
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
      <div className="terminal-viewport" ref={hostRef} />
      {error ? (
        <div className="terminal-error">
          <CircleAlert size={16} />{error}
        </div>
      ) : null}
    </MobilePage>
  );
}
