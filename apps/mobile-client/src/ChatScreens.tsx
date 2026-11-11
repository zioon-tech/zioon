import { accountCan } from "../../../packages/account-ui/src/client";
import {
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Clipboard,
  Copy,
  Cpu,
  Edit3,
  Ellipsis,
  ExternalLink,
  FileCheck2,
  FileDiff,
  Info,
  MessageCirclePlus,
  MessageSquare,
  Paperclip,
  Plus,
  Reply,
  RotateCcw,
  Search,
  Share2,
  Sparkles,
  Square,
  Undo2,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useNavigate, useParams } from "react-router-dom";
import {
  abortRun,
  resumeRun,
  createSession,
  forkSession,
  getActiveRun,
  getSession,
  getSessionArtifacts,
  getSessionMessages,
  skillsSnapshotQueryOptions,
  listCapabilityTools,
  listInteractionProfiles,
  listModels,
  listSessionSummaries,
  RuntimeApiError,
  sendSessionMessage,
  updateSessionConfiguration,
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
  contentText,
} from "./components";
import {
  buildConversationItems,
  meaningfulSessionTitle,
  parseToolArguments,
  parseToolResult,
  summarizeToolCall,
  toolResultOk,
  projectionIsPersisted,
  type ConversationBlock,
  type ConversationItem,
} from "./conversation";
import type {
  AssistantToolCall,
  Artifact,
  CapabilityPolicy,
  CapabilityTool,
  ChangeSet,
  RuntimeModelProfile,
  SessionConfigurationPatch,
  SessionMessage,
  SessionRecord,
  SessionSummary,
} from "./types";
import {
  useRunProjection,
  type RunProjectionState,
} from "./useRunProjection";

type QuickPrompt = {
  label: string;
  prompt: string;
  icon: LucideIcon;
};

type UserHistoryItem = {
  id: string;
  index: number;
  content: string;
  preview: string;
  createdAt?: number;
  answered: boolean;
};

type SessionConfigTab = "model" | "tools" | "skills";
type SessionListFilter = "all" | "running" | "scheduled" | "archived";

function runtimeModelLabel(profile: RuntimeModelProfile): string {
  return profile.label || profile.model || profile.id;
}

function sessionCapabilityRisk(tool: CapabilityTool): {
  label: string;
  tone: "green" | "blue" | "amber" | "red" | "neutral";
} {
  if (tool.risk === "external-effect") return { label: "外部操作", tone: "red" };
  if (tool.risk === "execute") return { label: "执行", tone: "amber" };
  if (tool.risk === "write") return { label: "写入", tone: "blue" };
  if (tool.name.endsWith("Manage")) return { label: "管理", tone: "blue" };
  if (tool.policy?.minimumPreset === "trusted-automation") {
    return { label: "执行", tone: "amber" };
  }
  if (tool.policy?.minimumPreset === "workspace-write") {
    return { label: "写入", tone: "blue" };
  }
  return { label: "读取", tone: "green" };
}

function policyWithEnabledTools(
  current: CapabilityPolicy,
  catalog: CapabilityTool[],
  enabled: string[],
): CapabilityPolicy {
  const rank = { "read-only": 1, "workspace-write": 2, "trusted-automation": 3 };
  let preset: CapabilityPolicy["preset"] = "read-only";
  for (const tool of catalog) {
    if (!enabled.includes(tool.name)) continue;
    const required = tool.policy?.minimumPreset as CapabilityPolicy["preset"] | undefined;
    if (required && rank[required] > rank[preset]) preset = required;
  }
  return {
    ...current,
    preset,
    allowedTools: enabled,
  };
}

function sessionSkillIds(
  session: SessionRecord | undefined,
  fallback: string[],
): string[] {
  const skills = session?.metadata?.skills;
  if (
    skills
    && typeof skills === "object"
    && !Array.isArray(skills)
    && Array.isArray((skills as { enabled?: unknown }).enabled)
  ) {
    return (skills as { enabled: unknown[] }).enabled
      .map(String)
      .filter(Boolean);
  }
  return fallback;
}

function sessionTitle(session?: SessionRecord): string {
  return meaningfulSessionTitle(session?.title, session?.id, session?.metadata)
    || "未命名会话";
}

function formatTimestamp(timestamp?: number): string {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function dateKey(timestamp?: number): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function formatDateDivider(timestamp?: number): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameLocalDay(date, now)) return "今天";
  if (isSameLocalDay(date, yesterday)) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function compactText(value: string, limit = 120): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeText(node.props.children);
  }
  return "";
}

async function writeClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function changeOperationLabel(operation: ChangeSet["operation"]): string {
  if (operation === "created") return "新增";
  if (operation === "deleted") return "删除";
  if (operation === "patch") return "补丁";
  return "修改";
}

function artifactSummaryText({
  artifacts,
  changes,
}: {
  artifacts: Artifact[];
  changes: ChangeSet[];
}): string {
  if (!artifacts.length && !changes.length) return "当前会话还没有产物";
  const lines = [
    `${changes.length} 个文件变更，${artifacts.length} 个产物`,
    ...changes.slice(0, 8).map((change) =>
      `- ${changeOperationLabel(change.operation)} ${change.path} (+${change.addedLines} -${change.removedLines})`,
    ),
  ];
  if (changes.length > 8) lines.push(`- 还有 ${changes.length - 8} 个变更`);
  return lines.join("\n");
}

function SessionRow({ session }: { session: SessionSummary }) {
  const navigate = useNavigate();
  const displayTitle = meaningfulSessionTitle(session.title, session.id, session.metadata)
    || session.lastMessage?.content.slice(0, 36)
    || "未命名会话";
  const source = String(session.metadata?.source || session.metadata?.requestSource || "");
  const scheduled = source.includes("scheduler") || source.includes("scheduled");
  return (
    <button
      className="session-row"
      type="button"
      onClick={() => navigate(`/chat/${encodeURIComponent(session.id)}`)}
    >
      <span
        className={`session-accent ${session.activeRun ? "is-running" : ""}`}
        aria-hidden="true"
      />
      <span className="row-main">
        <span className="row-title-line">
          <span className="row-title">{displayTitle}</span>
          {session.activeRun ? <Badge tone="blue">运行中</Badge> : null}
          {scheduled ? <Badge>定时</Badge> : null}
          {session.status === "archived" ? <Badge tone="neutral">归档</Badge> : null}
        </span>
        <span className="row-preview">
          {session.activeRun
            ? "正在运行"
            : session.lastMessage?.content || "还没有消息"}
        </span>
      </span>
      <span className="session-row-meta">
        <time>{formatRelativeTime(session.updatedAt)}</time>
        <ChevronRight size={15} aria-hidden="true" />
      </span>
    </button>
  );
}

export function SessionsScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SessionListFilter>("all");
  const sessions = useQuery({
    queryKey: ["session-summaries"],
    queryFn: () => listSessionSummaries(50),
    refetchInterval: 10_000,
  });
  const create = useMutation({
    mutationFn: () => createSession(),
    onSuccess(session) {
      void queryClient.invalidateQueries({ queryKey: ["session-summaries"] });
      navigate(`/chat/${encodeURIComponent(session.id)}`, {
        state: { focusComposer: true },
      });
    },
  });
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    return (sessions.data || []).filter((session) => {
      const source = String(session.metadata?.source || session.metadata?.requestSource || "");
      const scheduled = source.includes("scheduler") || source.includes("scheduled");
      const matchesFilter = filter === "all"
        || (filter === "running" && Boolean(session.activeRun))
        || (filter === "scheduled" && scheduled)
        || (filter === "archived" && session.status === "archived");
      if (!matchesFilter) return false;
      return !value || `${sessionTitle(session)} ${session.lastMessage?.content || ""} ${source}`
        .toLowerCase()
        .includes(value);
    });
  }, [filter, query, sessions.data]);
  const allSessions = sessions.data || [];
  const runningCount = allSessions.filter((session) => session.activeRun).length;
  const scheduledCount = allSessions.filter((session) => {
    const source = String(session.metadata?.source || session.metadata?.requestSource || "");
    return source.includes("scheduler") || source.includes("scheduled");
  }).length;
  const archivedCount = allSessions.filter((session) => session.status === "archived").length;

  return (
    <MobilePage
      title="Zion"
      subtitle={`${sessions.data?.length || 0} 个会话`}
      action={accountCan("runtime.write") &&
        <IconButton
          icon={MessageCirclePlus}
          label="新建会话"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        />
      }
    >
      <div className="search-wrap">
        <label className="search-box">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">搜索会话</span>
          <input
            type="search"
            value={query}
            placeholder="搜索会话"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <SegmentedControl
        value={filter}
        options={[
          { value: "all", label: "全部", count: allSessions.length },
          { value: "running", label: "运行中", count: runningCount },
          { value: "scheduled", label: "定时", count: scheduledCount },
          { value: "archived", label: "归档", count: archivedCount },
        ]}
        onChange={setFilter}
      />
      {sessions.isLoading ? <LoadingState label="正在加载会话" /> : null}
      {sessions.isError ? (
        <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : null}
      {!sessions.isLoading && !sessions.isError && filtered.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title={query ? "没有匹配的会话" : "开始第一段对话"}
          description={query ? "换一个关键词试试。" : "这里还没有会话。"}
          action={!query ? (
            <button className="button primary" type="button" onClick={() => create.mutate()}>
              <Plus size={17} />新建会话
            </button>
          ) : null}
        />
      ) : null}
      {filtered.length ? (
        <>
          <SectionLabel>最近</SectionLabel>
          <div className="list session-list">
            {filtered.map((session) => <SessionRow session={session} key={session.id} />)}
          </div>
        </>
      ) : null}
    </MobilePage>
  );
}

function MarkdownMessage({
  content,
  collapsible = false,
  onCopyText,
}: {
  content: string;
  collapsible?: boolean;
  onCopyText?: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLong = collapsible && (
    content.length > 1800
    || content.split("\n").length > 32
  );
  return (
    <div className="markdown-message">
      <div className={`markdown-content${isLong && !expanded ? " is-collapsed" : ""}`}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            pre({ children }) {
              const code = nodeText(children).trim();
              return (
                <div className="code-block-wrap">
                  {code ? (
                    <button
                      className="code-copy"
                      type="button"
                      onClick={() => onCopyText?.(code)}
                    >
                      <Copy size={13} />复制
                    </button>
                  ) : null}
                  <pre>{children}</pre>
                </div>
              );
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
      {isLong ? (
        <button
          className="inline-expand"
          type="button"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起" : "展开全文"}
        </button>
      ) : null}
    </div>
  );
}

function DateDivider({ label }: { label: string }) {
  return <div className="date-divider"><span>{label}</span></div>;
}

function UserTurnRail({
  items,
  activeId,
  onJump,
}: {
  items: UserHistoryItem[];
  activeId: string;
  onJump: (id: string) => void;
}) {
  if (items.length < 2) return null;
  return (
    <aside className="user-turn-rail" aria-label="历史提问导航">
      <div className="user-turn-rail-track">
        {items.map((item) => (
          <button
            className={`user-turn-dot-button${item.id === activeId ? " is-active" : ""}`}
            type="button"
            aria-label={`跳到第 ${item.index} 条提问：${item.preview}`}
            data-turn={`#${item.index}`}
            title={`#${item.index} ${item.preview}`}
            onClick={() => onJump(item.id)}
            key={item.id}
          >
            <span className="user-turn-dot" />
          </button>
        ))}
      </div>
    </aside>
  );
}

function SheetAction({
  icon: Icon,
  label,
  description,
  danger = false,
  disabled = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  description?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`sheet-action${danger ? " danger" : ""}`}
      type="button"
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={18} aria-hidden="true" />
      <span>
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
    </button>
  );
}

function BottomSheetFrame({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <button className="sheet-backdrop" type="button" aria-label="关闭" onClick={onClose} />
      <section className="bottom-sheet" aria-modal="true">
        <header>
          <span>
            <strong>{title}</strong>
            {subtitle ? <small>{subtitle}</small> : null}
          </span>
          <button className="sheet-close" type="button" aria-label="关闭" onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        {children}
      </section>
    </>
  );
}

function ReasoningCard({
  content,
  live = false,
}: {
  content: string;
  live?: boolean;
}) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const preview = content.replace(/\s+/g, " ").trim().slice(0, 110);
  return (
    <div className="detail-card">
      <button
        type="button"
        aria-expanded={reasoningOpen}
        onClick={() => setReasoningOpen((value) => !value)}
      >
        <Sparkles size={17} />
        <span>
          <strong>{live ? "思考中" : "思考过程"}</strong>
          <small>{preview || (live ? "模型正在分析上下文" : "本次思考未提供摘要")}</small>
        </span>
        {reasoningOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {reasoningOpen ? <p>{content}</p> : null}
    </div>
  );
}

function toolDetailText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolActivityCard({
  call,
  result,
  status,
  onCopyText,
}: {
  call: AssistantToolCall;
  result?: SessionMessage;
  status?: Extract<ConversationBlock, { kind: "tool" }>["status"];
  onCopyText?: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const args = parseToolArguments(call);
  const effectiveResult = result;
  const resultValue = effectiveResult ? parseToolResult(effectiveResult) : null;
  const inferredOk = effectiveResult ? toolResultOk(effectiveResult) : null;
  const state = status
    || (effectiveResult ? (inferredOk === false ? "failed" : "completed") : "running");
  const summary = state === "running"
    ? "正在执行"
    : state === "interrupted"
      ? "执行已结束，未收到工具结果"
    : state === "failed"
      ? toolDetailText(resultValue).replace(/\s+/g, " ").trim().slice(0, 110) || "执行失败"
      : effectiveResult
        ? summarizeToolCall(call, effectiveResult)
        : "执行完成";
  return (
    <div className={`tool-card is-${state}`}>
      <button
        className="tool-card-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {state === "failed" ? (
          <CircleAlert size={17} />
        ) : state === "completed" ? (
          <CheckCircle2 size={17} />
        ) : (
          <Wrench size={17} />
        )}
        <span>
          <strong>{call.function.name}</strong>
          <small>{summary}</small>
        </span>
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {open ? (
        <div className="tool-card-detail">
          <div className="tool-detail-head">
            <span>参数</span>
            <button
              type="button"
              onClick={() => onCopyText?.(toolDetailText(args) || "{}")}
            >
              <Copy size={12} />复制
            </button>
          </div>
          <pre>{toolDetailText(args) || "{}"}</pre>
          {resultValue != null && resultValue !== "" ? (
            <>
              <div className="tool-detail-head">
                <span>结果</span>
                <button
                  type="button"
                  onClick={() => onCopyText?.(toolDetailText(resultValue))}
                >
                  <Copy size={12} />复制
                </button>
              </div>
              <pre>{toolDetailText(resultValue)}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AssistantBlockView({
  block,
  onCopyText,
}: {
  block: ConversationBlock;
  onCopyText: (value: string) => void;
}) {
  return (
    <div className={`assistant-block is-${block.kind}`} data-block-id={block.id}>
      {block.kind === "text" ? (
        <MarkdownMessage content={block.content} onCopyText={onCopyText} />
      ) : block.kind === "reasoning" ? (
        <ReasoningCard content={block.content} live={block.running} />
      ) : (
        <ToolActivityCard call={block.call} result={block.result} status={block.status} onCopyText={onCopyText} />
      )}
    </div>
  );
}

function AssistantTimeline({
  item,
  live,
  onCopyText,
}: {
  item: ConversationItem;
  live: boolean;
  onCopyText: (value: string) => void;
}) {
  const processId = useId();
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const last = item.blocks.at(-1);
  const finalBlock = last?.kind === "text" && last.id === item.finalBlockId ? last : undefined;
  const processBlocks = finalBlock ? item.blocks.slice(0, -1) : item.blocks;
  const collapsible = !!finalBlock && processBlocks.length > 0;
  const expanded = !collapsible || expandedFor === finalBlock.id;
  const toolCount = processBlocks.filter((block) => block.kind === "tool").length;
  const reasoningCount = processBlocks.filter((block) => block.kind === "reasoning").length;
  const textCount = processBlocks.filter((block) => block.kind === "text").length;
  const hasFailure = processBlocks.some((block) =>
    block.kind === "tool" && ["failed", "interrupted"].includes(block.status)
  );
  const summary = [
    toolCount ? `${toolCount} 次工具调用` : "",
    reasoningCount ? `${reasoningCount} 段思考` : "",
    textCount ? `${textCount} 段说明` : "",
  ].filter(Boolean).join(" · ");
  return (
    <div className="assistant-timeline">
      <div className="assistant-process" hidden={!processBlocks.length}>
        {collapsible ? (
          <button
            className={`assistant-process-toggle${hasFailure ? " has-failure" : ""}`}
            type="button"
            aria-expanded={expanded}
            aria-controls={processId}
            onClick={() => setExpandedFor(expanded ? null : finalBlock.id)}
          >
            {hasFailure ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />}
            <span>
              <strong>{hasFailure ? "执行过程包含异常" : "执行过程"}</strong>
              <small>{summary}</small>
            </span>
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        ) : null}
        <div id={processId} className="assistant-process-content" hidden={!expanded}>
          {processBlocks.map((block) => (
            <AssistantBlockView block={block} onCopyText={onCopyText} key={block.id} />
          ))}
        </div>
      </div>
      {finalBlock ? <AssistantBlockView block={finalBlock} onCopyText={onCopyText} key={finalBlock.id} /> : null}
      {live && !item.blocks.length ? <div className="typing"><span /><span /><span /></div> : null}
      {item.error ? <div className="inline-error">{item.error}</div> : null}
    </div>
  );
}

function TranscriptMessageView({
  item,
  searchMatch = false,
  focusMatch = false,
  messageRef,
  onOpenActions,
  onCopyText,
}: {
  item: ConversationItem;
  searchMatch?: boolean;
  focusMatch?: boolean;
  messageRef?: (node: HTMLElement | null) => void;
  onOpenActions: (item: ConversationItem) => void;
  onCopyText: (value: string) => void;
}) {
  const { message } = item;
  const longPressTimer = useRef<number | null>(null);
  const isUser = message.role === "user";
  const content = contentText(message.content);
  const live = !!item.status && ["connecting", "queued", "running"].includes(item.status);
  const clearLongPress = () => {
    if (longPressTimer.current != null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };
  const openActions = () => {
    clearLongPress();
    onOpenActions(item);
  };
  return (
    <article
      ref={messageRef}
      className={`message ${isUser ? "user" : "assistant"}${searchMatch ? " is-search-match" : ""}${focusMatch ? " is-history-focus" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        openActions();
      }}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse") return;
        if ((event.target as HTMLElement).closest("button, a, pre")) return;
        clearLongPress();
        longPressTimer.current = window.setTimeout(openActions, 520);
      }}
      onPointerLeave={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerUp={clearLongPress}
    >
      {!isUser ? (
        <div className="message-label-row">
          <div className="message-label">
            <span className="assistant-mark" aria-hidden="true">
              <Sparkles size={12} />
            </span>
            <span>{live ? "Zion · 正在处理" : "Zion"}</span>
          </div>
          <button
            className="message-more-button"
            type="button"
            aria-label="消息操作"
            onClick={openActions}
          >
            <Ellipsis size={16} />
          </button>
        </div>
      ) : null}
      {isUser ? (
        <div className="user-message-wrap">
          <button
            className="message-more-button"
            type="button"
            aria-label="消息操作"
            onClick={openActions}
          >
            <Ellipsis size={16} />
          </button>
          <div>
            <div className="user-bubble">{content}</div>
          </div>
        </div>
      ) : null}
      {!isUser ? (
        <AssistantTimeline item={item} live={live} onCopyText={onCopyText} />
      ) : null}
    </article>
  );
}

function ArtifactSummaryPanel({
  artifacts,
  changes,
  onOpen,
  onCopy,
  onUnavailable,
}: {
  artifacts: Artifact[];
  changes: ChangeSet[];
  onOpen: () => void;
  onCopy: () => void;
  onUnavailable: (action: string) => void;
}) {
  const totalAdded = changes.reduce((sum, change) => sum + (Number(change.addedLines) || 0), 0);
  const totalRemoved = changes.reduce((sum, change) => sum + (Number(change.removedLines) || 0), 0);
  return (
    <section className="artifact-panel" aria-label="会话产物">
      <button className="artifact-panel-main" type="button" onClick={onOpen}>
        <FileDiff size={18} />
        <span>
          <strong>{changes.length} 个文件变更</strong>
          <small>{artifacts.length} 个产物 · +{totalAdded} -{totalRemoved}</small>
        </span>
        <ChevronRight size={17} />
      </button>
      {changes.length ? (
        <div className="artifact-files">
          {changes.slice(0, 3).map((change) => (
            <button className="artifact-file-row" type="button" onClick={onOpen} key={change.id}>
              <span>{changeOperationLabel(change.operation)}</span>
              <strong>{change.path}</strong>
              <small>+{change.addedLines} -{change.removedLines}</small>
            </button>
          ))}
        </div>
      ) : null}
      <div className="artifact-actions">
        <button className="button subtle" type="button" onClick={onOpen}>
          <ExternalLink size={15} />查看 Diff
        </button>
        <button className="button subtle" type="button" onClick={onCopy}>
          <Copy size={15} />复制摘要
        </button>
        <button className="button subtle" type="button" onClick={() => onUnavailable("接受变更")}>
          <BadgeCheck size={15} />接受
        </button>
        <button className="button subtle danger" type="button" onClick={() => onUnavailable("回退变更")}>
          <Undo2 size={15} />回退
        </button>
      </div>
    </section>
  );
}

function Composer({
  value,
  running,
  disabled,
  model,
  toolCount,
  skillCount,
  quickPrompts,
  onChange,
  onAttach,
  onOpenConfig,
  onQuickPrompt,
  onSubmit,
  onStop,
}: {
  value: string;
  running: boolean;
  disabled: boolean;
  model: string;
  toolCount: number;
  skillCount: number;
  quickPrompts: QuickPrompt[];
  onChange: (value: string) => void;
  onAttach: () => void;
  onOpenConfig: (tab: SessionConfigTab) => void;
  onQuickPrompt: (prompt: string) => void;
  onSubmit: () => void;
  onStop: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.style.height = "auto";
    ref.current.style.height = `${Math.min(132, Math.max(44, ref.current.scrollHeight))}px`;
  }, [value]);
  const showQuickPrompts = !running && !value.trim() && quickPrompts.length > 0;
  return (
    <section className="composer">
      {showQuickPrompts ? (
        <div className="prompt-rail" aria-label="快捷操作">
          {quickPrompts.map((item) => {
            const Icon = item.icon;
            return (
              <button
                type="button"
                key={item.label}
                onClick={() => onQuickPrompt(item.prompt)}
              >
                <Icon size={14} aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="composer-box">
        <label className="sr-only" htmlFor="messageInput">输入消息</label>
        <textarea
          id="messageInput"
          ref={ref}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={disabled ? "Session 当前不可写" : "输入消息"}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              if (running) onStop();
              else onSubmit();
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <button
              className="attach-button"
              type="button"
              aria-label="添加上下文"
              disabled={disabled}
              onClick={onAttach}
            >
              <Paperclip size={19} />
            </button>
            <button
              className="composer-context"
              type="button"
              aria-label={`切换模型，当前 ${model}`}
              title={`模型：${model}`}
              onClick={() => onOpenConfig("model")}
            >
              <Cpu size={14} />
              <span className="composer-model">{model}</span>
              <ChevronDown size={13} />
            </button>
            <button
              className="composer-context composer-count"
              type="button"
              aria-label={`配置工具，当前启用 ${toolCount} 个`}
              title={`${toolCount} 个工具`}
              onClick={() => onOpenConfig("tools")}
            >
              <Wrench size={14} />
              <span>{toolCount} 工具</span>
            </button>
            <button
              className="composer-context composer-count"
              type="button"
              aria-label={`配置 Skills，当前启用 ${skillCount} 个`}
              title={`${skillCount} 个 Skills`}
              onClick={() => onOpenConfig("skills")}
            >
              <Sparkles size={14} />
              <span>{skillCount} Skills</span>
            </button>
          </div>
          <button
            className={`send-button ${running ? "is-stop" : ""}`}
            type="button"
            disabled={running ? false : disabled || !value.trim()}
            aria-label={running ? "停止生成" : "发送消息"}
            onClick={running ? onStop : onSubmit}
          >
            {running ? <Square size={14} /> : <ArrowUp size={18} />}
          </button>
        </div>
      </div>
    </section>
  );
}

function useStoredDraft(key: string) {
  const [state, setState] = useState(() => ({
    key,
    value: localStorage.getItem(key) || "",
  }));
  const value = state.key === key
    ? state.value
    : localStorage.getItem(key) || "";
  const setValue = useCallback((next: string) => {
    setState({ key, value: next });
  }, [key]);
  useEffect(() => {
    if (state.key !== key) return;
    if (state.value) localStorage.setItem(key, state.value);
    else localStorage.removeItem(key);
  }, [key, state]);
  return [value, setValue] as const;
}

export function ConversationScreen() {
  const { sessionId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const decodedSessionId = decodeURIComponent(sessionId);
  const draftKey = `zion.mobile.draft.${decodedSessionId}`;
  const [draft, setDraft] = useStoredDraft(draftKey);
  const [pendingUser, setPendingUser] = useState("");
  const [retryCommand, setRetryCommand] = useState<{
    content: string;
    clientRequestId: string;
  } | null>(null);
  const [runId, setRunId] = useState("");
  const [observationKey, setObservationKey] = useState(0);
  const observedActiveRun = useRef<{ sessionId: string; signature: string }>({
    sessionId: decodedSessionId, signature: "",
  });
  const [waitResponse, setWaitResponse] = useState("");
  const [finishedRuns, setFinishedRuns] = useState<Array<{ sessionId: string; projection: RunProjectionState }>>([]);
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
  const [sessionConfigOpen, setSessionConfigOpen] = useState(false);
  const [sessionConfigTab, setSessionConfigTab] = useState<SessionConfigTab>("model");
  const [sessionConfigQuery, setSessionConfigQuery] = useState("");
  const [attachOpen, setAttachOpen] = useState(false);
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const [conversationSearch, setConversationSearch] = useState("");
  const [messageActions, setMessageActions] = useState<ConversationItem | null>(null);
  const [toast, setToast] = useState("");
  const [activeUserMessageId, setActiveUserMessageId] = useState("");
  const [focusedHistoryMessageId, setFocusedHistoryMessageId] = useState("");
  const [showScrollLatest, setShowScrollLatest] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Record<string, HTMLElement | null>>({});
  const followLatestRef = useRef(true);

  const session = useQuery({
    queryKey: ["session", decodedSessionId],
    queryFn: () => getSession(decodedSessionId),
  });
  const messages = useQuery({
    queryKey: ["session-messages", decodedSessionId],
    queryFn: () => getSessionMessages(decodedSessionId),
    refetchInterval: runId || finishedRuns.some((entry) =>
      entry.sessionId === decodedSessionId && entry.projection.status === "completed"
    ) ? 4_000 : false,
  });
  const activeRun = useQuery({
    queryKey: ["active-run", decodedSessionId],
    queryFn: () => getActiveRun(decodedSessionId),
    refetchInterval: runId ? 3_000 : 8_000,
  });
  const artifacts = useQuery({
    queryKey: ["session-artifacts", decodedSessionId],
    queryFn: () => getSessionArtifacts(decodedSessionId),
    staleTime: 10_000,
  });
  const profiles = useQuery({
    queryKey: ["interaction-profiles"],
    queryFn: listInteractionProfiles,
    staleTime: 30_000,
  });
  const skills = useQuery({
    ...skillsSnapshotQueryOptions,
    refetchInterval: sessionConfigOpen && sessionConfigTab === "skills" ? 3_000 : 5_000,
  });
  const models = useQuery({
    queryKey: ["models"],
    queryFn: listModels,
    staleTime: 30_000,
    enabled: sessionConfigOpen,
  });
  const capabilityTools = useQuery({
    queryKey: ["capability-tools"],
    queryFn: listCapabilityTools,
    staleTime: 30_000,
    enabled: sessionConfigOpen,
  });

  useEffect(() => {
    if (!activeRun.isSuccess) return;
    const active = activeRun.data;
    const signature = active ? `${active.runId}:${active.attemptId || ""}:${active.status}` : "";
    const previous = observedActiveRun.current;
    if (previous.sessionId !== decodedSessionId) {
      setRunId(active?.runId || "");
    } else {
      if (active?.runId && previous.signature !== signature) setRunId(active.runId);
      if (runId && previous.signature !== signature) {
        // EOF at waiting is expected. Reobserve when another client resumes,
        // cancels or finishes the same Run, including activeRun becoming null.
        setObservationKey((value) => value + 1);
      }
    }
    observedActiveRun.current = { sessionId: decodedSessionId, signature };
  }, [activeRun.dataUpdatedAt, activeRun.isSuccess, activeRun.data?.runId,
    activeRun.data?.attemptId, activeRun.data?.status, decodedSessionId, runId]);
  const handleTerminal = useCallback((terminal: RunProjectionState) => {
    if (terminal.status === "waiting") {
      setPendingUser("");
      void queryClient.invalidateQueries({ queryKey: ["active-run", decodedSessionId] });
      return;
    }
    setFinishedRuns((current) => [
      ...current.filter((entry) => entry.projection.runId !== terminal.runId),
      { sessionId: decodedSessionId, projection: terminal },
    ]);
    setPendingUser("");
    setRunId((current) => current === terminal.runId ? "" : current);
    if (
      document.hidden
      && localStorage.getItem("zion.mobile.notifications") === "on"
      && "Notification" in window
      && Notification.permission === "granted"
    ) {
      const label = terminal.status === "completed" ? "运行已完成" : `运行${terminal.status}`;
      new Notification("Zion Mobile", {
        body: `${meaningfulSessionTitle(session.data?.title, session.data?.id, session.data?.metadata) || "会话"} · ${label}`,
      });
    }
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["session", decodedSessionId] }),
      queryClient.invalidateQueries({ queryKey: ["session-messages", decodedSessionId] }),
      queryClient.invalidateQueries({ queryKey: ["active-run", decodedSessionId] }),
      queryClient.invalidateQueries({ queryKey: ["session-artifacts", decodedSessionId] }),
      queryClient.invalidateQueries({ queryKey: ["session-summaries"] }),
    ]);
  }, [decodedSessionId, queryClient, session.data?.id, session.data?.metadata, session.data?.title]);
  const projection = useRunProjection(runId, handleTerminal, observationKey);
  useEffect(() => {
    if (!messages.data) return;
    setFinishedRuns((current) => {
      const remaining = current.filter((entry) => entry.sessionId === decodedSessionId
        && !projectionIsPersisted(messages.data!, entry.projection));
      return remaining.length === current.length ? current : remaining;
    });
  }, [decodedSessionId, messages.data, finishedRuns]);

  const send = useMutation({
    mutationFn: async (command: {
      content: string;
      clientRequestId: string;
    }) => {
      return await sendSessionMessage(decodedSessionId, {
        content: command.content,
        clientRequestId: command.clientRequestId,
      });
    },
    onMutate(command) {
      setPendingUser(command.content);
      setDraft("");
    },
    onSuccess(result) {
      setRetryCommand(null);
      setRunId(result.runId);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["session", decodedSessionId] }),
        queryClient.invalidateQueries({ queryKey: ["session-messages", decodedSessionId] }),
        queryClient.invalidateQueries({ queryKey: ["session-summaries"] }),
      ]);
    },
    async onError(error, command) {
      setRetryCommand(command);
      setDraft(command.content);
      setPendingUser("");
      if (error instanceof RuntimeApiError && error.status === 409) {
        const current = await activeRun.refetch();
        if (current.data?.runId) setRunId(current.data.runId);
      }
    },
  });
  const stop = useMutation({
    mutationFn: () => abortRun(runId),
    onSuccess() {
      setObservationKey((value) => value + 1);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["session", decodedSessionId] }),
        queryClient.invalidateQueries({ queryKey: ["session-messages", decodedSessionId] }),
        queryClient.invalidateQueries({ queryKey: ["active-run", decodedSessionId] }),
        queryClient.invalidateQueries({ queryKey: ["session-summaries"] }),
      ]);
    },
  });
  const resume = useMutation({
    mutationFn: async () => {
      const waiting = projection.waiting || activeRun.data?.waiting;
      if (!waiting?.id) throw new Error("等待请求已变化，请刷新会话。");
      let input: unknown = waitResponse;
      try { input = JSON.parse(waitResponse); } catch {}
      await resumeRun(runId, waiting.id, input);
    },
    onSuccess() {
      setWaitResponse("");
      setObservationKey((value) => value + 1);
      void queryClient.invalidateQueries({ queryKey: ["active-run", decodedSessionId] });
    },
  });
  const showToast = useCallback((message: string) => {
    setToast(message);
  }, []);
  const copyAndToast = useCallback(async (value: string, label = "已复制") => {
    const ok = await writeClipboard(value);
    showToast(ok ? label : "复制失败");
  }, [showToast]);
  const updateConfiguration = useMutation({
    mutationFn: ({
      patch,
    }: {
      patch: SessionConfigurationPatch;
      successMessage: string;
    }) => updateSessionConfiguration(decodedSessionId, patch),
    onSuccess(updated, command) {
      queryClient.setQueryData(["session", decodedSessionId], updated);
      void queryClient.invalidateQueries({ queryKey: ["session-summaries"] });
      showToast(command.successMessage);
    },
    onError(error) {
      showToast(error instanceof Error ? error.message : "会话配置更新失败");
    },
  });

  useEffect(() => {
    if (!toast) return undefined;
    const id = window.setTimeout(() => setToast(""), 1800);
    return () => window.clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !followLatestRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [
    messages.data?.length,
    pendingUser,
    projection.cursor,
    finishedRuns,
  ]);

  const submit = () => {
    const value = draft.trim();
    if (!value || runId || send.isPending) return;
    const command = retryCommand?.content === value
      ? retryCommand
      : {
          content: value,
          clientRequestId: crypto.randomUUID(),
        };
    send.mutate(command);
  };
  const firstUserMessage = messages.data?.find((message) => message.role === "user");
  const title = meaningfulSessionTitle(session.data?.title, session.data?.id, session.data?.metadata)
    || contentText(firstUserMessage?.content).replace(/\s+/g, " ").trim().slice(0, 36)
    || "新会话";
  const model = session.data?.model?.label
    || session.data?.model?.modelId
    || profiles.data?.find((profile) => profile.id === "interactive.default")?.modelProfileId
    || "Runtime 默认";
  const policy = session.data?.policy?.preset || "read-only";
  const policyLabel = policy === "trusted-automation"
    ? "受信自动化"
    : policy === "workspace-write"
      ? "工作区写入"
      : "只读";
  const running = Boolean(runId) && !["completed", "failed", "aborted", "interrupted"]
    .includes(projection.status);
  const waiting = projection.status === "waiting" ? projection.waiting : undefined;
  const currentPolicy: CapabilityPolicy = session.data?.policy || {
    preset: "read-only",
    allowedTools: [],
    maxToolCalls: 50,
    fileRoots: [],
    allowedCommandPrefixes: [],
    allowedTerminalSessionIds: [],
    allowedRecipients: [],
    maxMailPerRun: 0,
  };
  const enabledTools = currentPolicy.allowedTools;
  const enabledSkillIds = sessionSkillIds(
    session.data,
    skills.data?.enabled || [],
  );
  const selectedModelId = session.data?.model?.profileId
    || session.data?.model?.modelId
    || "";
  const configQuery = sessionConfigQuery.trim().toLowerCase();
  const configModels = useMemo(() => (
    [...(models.data?.profiles || [])]
      .filter((profile) => (
        !configQuery
        || `${runtimeModelLabel(profile)} ${profile.providerId || ""} ${profile.model}`
          .toLowerCase()
          .includes(configQuery)
      ))
      .sort((left, right) => (
        Number(right.id === selectedModelId) - Number(left.id === selectedModelId)
        || runtimeModelLabel(left).localeCompare(runtimeModelLabel(right))
      ))
  ), [configQuery, models.data?.profiles, selectedModelId]);
  const configTools = useMemo(() => (
    [...(capabilityTools.data || [])]
      .filter((tool) => (
        !configQuery
        || `${tool.name} ${tool.description || ""}`.toLowerCase().includes(configQuery)
      ))
      .sort((left, right) => (
        Number(enabledTools.includes(right.name)) - Number(enabledTools.includes(left.name))
        || left.name.localeCompare(right.name)
      ))
  ), [capabilityTools.data, configQuery, enabledTools]);
  const configSkills = useMemo(() => (
    [...(skills.data?.catalog || [])]
      .filter((skill) => (
        !configQuery
        || `${skill.name} ${skill.description || ""}`.toLowerCase().includes(configQuery)
      ))
      .sort((left, right) => (
        Number(enabledSkillIds.includes(right.id)) - Number(enabledSkillIds.includes(left.id))
        || left.name.localeCompare(right.name)
      ))
  ), [configQuery, enabledSkillIds, skills.data?.catalog]);
  const transcript = messages.data || [];
  const pendingMessage: SessionMessage[] = pendingUser && !transcript.some((message) =>
    message.role === "user" && !!runId && message.runId === runId
      && contentText(message.content) === pendingUser
  ) ? [{
      id: "pending-user", role: "user", content: pendingUser,
      sequence: (transcript.at(-1)?.sequence || 0) + 1, runId: runId || undefined,
    }] : [];
  const displayMessages = buildConversationItems(
    [...transcript, ...pendingMessage],
    [
      ...finishedRuns.filter((entry) => entry.sessionId === decodedSessionId).map((entry) => entry.projection),
      ...(runId ? [projection] : []),
    ],
  );
  const artifactBundle = artifacts.data || { artifacts: [], changes: [] };
  const userHistoryItems = useMemo<UserHistoryItem[]>(() => {
    let userIndex = 0;
    return displayMessages.flatMap((item, index) => {
      if (item.message.role !== "user") return [];
      const content = contentText(item.message.content).trim();
      if (!content) return [];
      userIndex += 1;
      const laterItems = displayMessages.slice(index + 1);
      const nextUserIndex = laterItems.findIndex((next) => next.message.role === "user");
      const responseItems = nextUserIndex >= 0
        ? laterItems.slice(0, nextUserIndex)
        : laterItems;
      const answered = responseItems.some((next) =>
        next.message.role === "assistant"
        && (
          contentText(next.message.content).trim()
          || next.message.reasoningContent
          || next.message.toolCalls?.length
        )
      );
      return [{
        id: item.message.id,
        index: userIndex,
        content,
        preview: compactText(content, 112),
        createdAt: item.message.createdAt,
        answered,
      }];
    });
  }, [displayMessages]);
  const searchValue = conversationSearch.trim().toLowerCase();
  const searchMatchIds = useMemo(() => {
    if (!searchValue) return new Set<string>();
    return new Set(displayMessages
      .filter((item) => {
        const messageText = contentText(item.message.content);
        const toolText = item.message.toolCalls
          ?.map((call) => `${call.function.name} ${call.function.arguments}`)
          .join(" ") || "";
        return `${messageText} ${toolText}`.toLowerCase().includes(searchValue);
      })
      .map((item) => item.message.id));
  }, [displayMessages, searchValue]);
  const messageActionContent = messageActions
    ? contentText(messageActions.message.content).trim()
    : "";
  const messageActionTitle = messageActions?.message.role === "user" ? "用户消息" : "ZION 回答";
  const messageActionSubtitle = messageActions
    ? [formatTimestamp(messageActions.message.createdAt), compactText(messageActionContent, 56)]
      .filter(Boolean)
      .join(" · ")
    : "";
  const appendDraft = (value: string) => {
    const next = draft.trim()
      ? `${draft.trimEnd()}\n\n${value}`
      : value;
    setDraft(next);
    followLatestRef.current = true;
    window.setTimeout(() => {
      document.getElementById("messageInput")?.focus();
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, 0);
  };
  const jumpToMessage = useCallback((messageId: string) => {
    const target = messageRefs.current[messageId];
    if (!target) return;
    followLatestRef.current = false;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    setActiveUserMessageId(messageId);
    setFocusedHistoryMessageId(messageId);
    window.setTimeout(() => {
      setFocusedHistoryMessageId((current) => current === messageId ? "" : current);
    }, 1600);
  }, []);
  const updateActiveUserAnchor = useCallback(() => {
    const scrollNode = scrollRef.current;
    if (!scrollNode || !userHistoryItems.length) return;
    const containerRect = scrollNode.getBoundingClientRect();
    const anchorTop = containerRect.top + Math.min(120, containerRect.height * 0.35);
    let nextId = "";
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const item of userHistoryItems) {
      const node = messageRefs.current[item.id];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) continue;
      const distance = Math.abs(rect.top - anchorTop);
      if (distance < bestDistance) {
        bestDistance = distance;
        nextId = item.id;
      }
    }
    if (nextId) {
      setActiveUserMessageId((current) => current === nextId ? current : nextId);
    }
  }, [userHistoryItems]);
  const sendText = (content: string) => {
    if (running || send.isPending) {
      setDraft(content);
      showToast("当前正在执行，已放到输入框");
      return;
    }
    send.mutate({
      content,
      clientRequestId: crypto.randomUUID(),
    });
  };
  const openArtifacts = () => {
    navigate(`/files?session=${encodeURIComponent(decodedSessionId)}&tab=changes`);
  };
  const unavailableAction = (action: string) => {
    showToast(`${action}需要接入移动端变更协议`);
  };
  const quickPrompts: QuickPrompt[] = useMemo(() => {
    if (artifactBundle.changes.length || artifactBundle.artifacts.length) {
      return [
        {
          label: "解释变更",
          prompt: "帮我解释本会话产生的文件变更，按风险和影响范围整理。",
          icon: FileDiff,
        },
        {
          label: "提交说明",
          prompt: "根据本会话产物生成一份 commit message、测试说明和风险提示。",
          icon: FileCheck2,
        },
        {
          label: "列下一步",
          prompt: "基于当前会话和产物，列出下一步最值得做的 3 件事。",
          icon: CheckCircle2,
        },
      ];
    }
    if (displayMessages.length > 0) {
      return [
        {
          label: "总结会话",
          prompt: "总结本会话的结论、已完成事项、未解决问题和下一步建议。",
          icon: Sparkles,
        },
        {
          label: "列下一步",
          prompt: "基于当前会话，列出下一步最值得做的 3 件事。",
          icon: CheckCircle2,
        },
        {
          label: "提炼产物",
          prompt: "把当前会话中可复用的结论整理成一份简短产物。",
          icon: FileCheck2,
        },
      ];
    }
    return [
      {
        label: "看工作区",
        prompt: "先帮我快速了解当前工作区，并告诉我可以从哪里开始。",
        icon: Search,
      },
      {
        label: "查状态",
        prompt: "检查当前 Runtime、工具、Skills 和定时任务状态。",
        icon: Wrench,
      },
    ];
  }, [
    artifactBundle.artifacts.length,
    artifactBundle.changes.length,
    displayMessages.length,
  ]);
  useEffect(() => {
    if (!userHistoryItems.length) {
      setActiveUserMessageId("");
      return;
    }
    if (!userHistoryItems.some((item) => item.id === activeUserMessageId)) {
      setActiveUserMessageId(userHistoryItems[userHistoryItems.length - 1].id);
    }
  }, [activeUserMessageId, userHistoryItems]);

  if (session.isLoading) {
    return <MobilePage title="会话" back="会话"><LoadingState /></MobilePage>;
  }
  if (session.isError || !session.data) {
    return (
      <MobilePage title="会话" back="会话">
        <ErrorState error={session.error || "Session 不存在"} onRetry={() => void session.refetch()} />
      </MobilePage>
    );
  }

  return (
    <MobilePage
      title={title}
      subtitle={waiting ? "等待回复" : running ? "正在执行" : "已连接"}
      back="会话"
      hideNav
      action={
        <div className="header-action-group">
          <IconButton
            icon={Search}
            label="搜索会话内容"
            onClick={() => setConversationSearchOpen((value) => !value)}
          />
          <IconButton icon={Info} label="会话信息" onClick={() => setSessionInfoOpen(true)} />
        </div>
      }
      footer={accountCan("run.execute") ?
        <Composer
          value={draft}
          running={running && !waiting}
          disabled={session.data.status !== "active" || send.isPending || Boolean(waiting)}
          model={model}
          toolCount={enabledTools.length}
          skillCount={enabledSkillIds.length}
          quickPrompts={quickPrompts}
          onChange={setDraft}
          onAttach={() => setAttachOpen(true)}
          onOpenConfig={(tab) => {
            setSessionConfigTab(tab);
            setSessionConfigQuery("");
            setSessionConfigOpen(true);
          }}
          onQuickPrompt={appendDraft}
          onSubmit={submit}
          onStop={() => stop.mutate()}
        /> : <div className="zion-account-readonly">只读会话</div>
      }
      className="conversation-page"
    >
      {waiting ? (
        <section className="detail-section mobile-form run-wait-response" aria-label="等待回复">
          <h2>等待回复</h2>
          <p>{waiting.reason}</p>
          {accountCan("run.execute") ? <>
            <textarea aria-label="回复内容" placeholder="回复内容（支持 JSON）"
              value={waitResponse} onChange={(event) => setWaitResponse(event.target.value)} />
            <div className="run-wait-actions">
              <button className="button primary" onClick={() => resume.mutate()} disabled={resume.isPending || stop.isPending}>提交回复</button>
              <button className="button" onClick={() => stop.mutate()} disabled={stop.isPending || resume.isPending}>停止任务</button>
            </div>
            {resume.isError ? <p role="alert">{String(resume.error instanceof Error ? resume.error.message : resume.error)}</p> : null}
          </> : null}
        </section>
      ) : null}
      <div
        className="message-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
          followLatestRef.current = nearBottom;
          setShowScrollLatest(!nearBottom);
          updateActiveUserAnchor();
        }}
      >
        {conversationSearchOpen ? (
          <div className="conversation-search">
            <label className="search-box">
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">搜索当前会话</span>
              <input
                type="search"
                value={conversationSearch}
                placeholder="搜索当前会话"
                autoFocus
                onChange={(event) => setConversationSearch(event.target.value)}
              />
            </label>
            <span>
              {searchValue ? `${searchMatchIds.size} 条匹配` : "输入关键词"}
            </span>
          </div>
        ) : null}
        {messages.isLoading ? <LoadingState label="正在读取消息" /> : null}
        {messages.isError ? (
          <ErrorState error={messages.error} onRetry={() => void messages.refetch()} />
        ) : null}
        {!messages.isLoading && displayMessages.length === 0 && !pendingUser ? (
          <EmptyState
            icon={MessageSquare}
            title="准备做什么？"
          />
        ) : null}
        {displayMessages.map((item, index) => {
          const dividerLabel = dateKey(displayMessages[index - 1]?.message.createdAt)
            !== dateKey(item.message.createdAt)
            ? formatDateDivider(item.message.createdAt)
            : "";
          return (
            <Fragment key={item.key}>
              {dividerLabel ? <DateDivider label={dividerLabel} /> : null}
              <TranscriptMessageView
                item={item}
                searchMatch={conversationSearchOpen && searchMatchIds.has(item.message.id)}
                focusMatch={focusedHistoryMessageId === item.message.id}
                messageRef={(node) => {
                  messageRefs.current[item.message.id] = node;
                }}
                onOpenActions={setMessageActions}
                onCopyText={(value) => void copyAndToast(value)}
              />
            </Fragment>
          );
        })}
        {send.isPending && !runId ? (
          <article className="message assistant" role="status">
            <div className="message-label">
              <span>{send.isPaused ? "Zion · 等待网络" : "Zion · 正在提交"}</span>
            </div>
            <div className="typing" aria-hidden="true"><span /><span /><span /></div>
          </article>
        ) : null}
        {send.isError ? (
          <div className="inline-error action-error">
            <span>{send.error instanceof Error ? send.error.message : "消息发送失败"}</span>
            {retryCommand ? (
              <button type="button" onClick={() => send.mutate(retryCommand)}>
                <RotateCcw size={14} />重试
              </button>
            ) : null}
          </div>
        ) : null}
        {artifactBundle.artifacts.length || artifactBundle.changes.length ? (
          <ArtifactSummaryPanel
            artifacts={artifactBundle.artifacts}
            changes={artifactBundle.changes}
            onOpen={openArtifacts}
            onCopy={() => void copyAndToast(artifactSummaryText(artifactBundle), "产物摘要已复制")}
            onUnavailable={unavailableAction}
          />
        ) : null}
        {showScrollLatest ? (
          <button
            className="scroll-latest"
            type="button"
            aria-label="回到最新消息"
            onClick={() => {
              followLatestRef.current = true;
              setShowScrollLatest(false);
              if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }}
          >
            <ArrowDown size={17} />
          </button>
        ) : null}
      </div>
      {!messageActions && !attachOpen && !sessionInfoOpen && !sessionConfigOpen ? (
        <UserTurnRail
          items={userHistoryItems}
          activeId={activeUserMessageId}
          onJump={jumpToMessage}
        />
      ) : null}
      {messageActions ? (
        <BottomSheetFrame
          title={messageActionTitle}
          subtitle={messageActionSubtitle}
          onClose={() => setMessageActions(null)}
        >
          <div className="sheet-actions">
            <SheetAction
              icon={Copy}
              label="复制内容"
              onClick={() => {
                void copyAndToast(messageActionContent);
                setMessageActions(null);
              }}
            />
            {messageActions.message.role === "user" ? (
              <SheetAction
                icon={Edit3}
                label="编辑并重新发送"
                description="原消息保留，内容放回输入框"
                onClick={() => {
                  setDraft(messageActionContent);
                  setMessageActions(null);
                  showToast("已放到输入框");
                  window.setTimeout(() => document.getElementById("messageInput")?.focus(), 0);
                }}
              />
            ) : (
              <>
                <SheetAction
                  icon={Reply}
                  label="引用追问"
                  description="把这条回答作为上下文"
                  onClick={() => {
                    appendDraft(`引用上面的回答继续：\n\n> ${messageActionContent.slice(0, 900).replace(/\n/g, "\n> ")}\n\n`);
                    setMessageActions(null);
                  }}
                />
                <SheetAction
                  icon={RotateCcw}
                  label="重新生成"
                  description="以新消息请求重新回答"
                  onClick={() => {
                    const target = messageActions;
                    if (!target) return;
                    const previousUser = [...(messages.data || [])]
                      .reverse()
                      .find((message) =>
                        message.role === "user"
                        && message.sequence < target.message.sequence
                      );
                    const source = contentText(previousUser?.content).trim();
                    setMessageActions(null);
                    sendText(source
                      ? `请基于这条需求重新生成一版更好的回答：\n\n${source}`
                      : "请重新生成上一条回答。");
                  }}
                />
              </>
            )}
            <SheetAction
              icon={Share2}
              label="分享"
              onClick={() => {
                setMessageActions(null);
                if ("share" in navigator && typeof navigator.share === "function") {
                  void navigator.share({ text: messageActionContent }).catch(() => copyAndToast(messageActionContent));
                } else {
                  void copyAndToast(messageActionContent, "当前浏览器不支持分享，已复制");
                }
              }}
            />
            <SheetAction
              icon={Undo2}
              label="撤回"
              description="需要补消息修订接口"
              disabled
              onClick={() => undefined}
            />
          </div>
        </BottomSheetFrame>
      ) : null}
      {attachOpen ? (
        <BottomSheetFrame
          title="添加上下文"
          subtitle="把文件、剪贴板或最近产物带入当前对话"
          onClose={() => setAttachOpen(false)}
        >
          <div className="sheet-actions">
            <SheetAction
              icon={FileDiff}
              label="从工作区选择文件"
              description="打开文件页选择路径"
              onClick={() => {
                setAttachOpen(false);
                navigate("/files");
              }}
            />
            <SheetAction
              icon={Clipboard}
              label="粘贴剪贴板文本"
              description="追加到输入框"
              onClick={async () => {
                try {
                  const value = await navigator.clipboard.readText();
                  if (value.trim()) appendDraft(value.trim());
                  showToast(value.trim() ? "已粘贴到输入框" : "剪贴板为空");
                } catch {
                  showToast("无法读取剪贴板");
                } finally {
                  setAttachOpen(false);
                }
              }}
            />
            <SheetAction
              icon={Paperclip}
              label="上传文件或照片"
              description="需要补上传接口"
              disabled
              onClick={() => undefined}
            />
          </div>
        </BottomSheetFrame>
      ) : null}
      {sessionConfigOpen ? (
        <BottomSheetFrame
          title="会话配置"
          subtitle={running ? "运行结束后可修改" : "仅影响当前会话"}
          onClose={() => setSessionConfigOpen(false)}
        >
          <div className="session-config-panel">
            <SegmentedControl
              value={sessionConfigTab}
              options={[
                { value: "model", label: "模型" },
                { value: "tools", label: "工具", count: enabledTools.length },
                { value: "skills", label: "Skills", count: enabledSkillIds.length },
              ]}
              onChange={(tab) => {
                setSessionConfigTab(tab);
                setSessionConfigQuery("");
              }}
            />
            <div className="session-config-search">
              <label className="search-box">
                <Search size={16} aria-hidden="true" />
                <span className="sr-only">
                  搜索{sessionConfigTab === "model"
                    ? "模型"
                    : sessionConfigTab === "tools" ? "工具" : "Skills"}
                </span>
                <input
                  type="search"
                  value={sessionConfigQuery}
                  placeholder={`搜索${sessionConfigTab === "model"
                    ? "模型"
                    : sessionConfigTab === "tools" ? "工具" : " Skills"}`}
                  onChange={(event) => setSessionConfigQuery(event.target.value)}
                />
              </label>
            </div>
            <div className="session-config-list">
              {sessionConfigTab === "model" ? (
                models.isLoading ? (
                  <LoadingState label="正在读取模型" />
                ) : configModels.length ? (
                  configModels.map((profile) => {
                    const selected = profile.id === selectedModelId;
                    const available = profile.credentialRequired === false
                      || profile.credentialConfigured !== false;
                    return (
                      <button
                        className={`session-config-row${selected ? " is-selected" : ""}`}
                        type="button"
                        disabled={running || updateConfiguration.isPending || !available}
                        onClick={() => updateConfiguration.mutate({
                          patch: { model: { profileId: profile.id } },
                          successMessage: `已切换到 ${runtimeModelLabel(profile)}`,
                        })}
                        key={profile.id}
                      >
                        <Cpu size={17} aria-hidden="true" />
                        <span className="row-main">
                          <span className="row-title-line">
                            <span className="row-title">{runtimeModelLabel(profile)}</span>
                            <Badge tone={available ? "green" : "red"}>
                              {available ? "可用" : "缺少凭证"}
                            </Badge>
                          </span>
                          <span className="row-preview">
                            {profile.providerId || profile.providerType || "Runtime"} · {profile.model}
                          </span>
                        </span>
                        {selected ? <CheckCircle2 size={17} /> : <ChevronRight size={16} />}
                      </button>
                    );
                  })
                ) : (
                  <div className="session-config-empty">没有匹配的模型</div>
                )
              ) : null}
              {sessionConfigTab === "tools" ? (
                capabilityTools.isLoading ? (
                  <LoadingState label="正在读取工具" />
                ) : configTools.length ? (
                  configTools.map((tool) => {
                    const enabled = enabledTools.includes(tool.name);
                    const risk = sessionCapabilityRisk(tool);
                    const unavailable = tool.modelInjectable === false
                      || tool.policy?.requiresApproval === true
                      || tool.name === "sendMail";
                    const unavailableText = tool.modelInjectable === false
                      ? tool.unavailableReason || "当前 Runtime 不会注入此工具"
                      : "需要额外审批或白名单";
                    return (
                      <div className="session-config-row" key={tool.name}>
                        <Wrench size={17} aria-hidden="true" />
                        <span className="row-main">
                          <span className="row-title-line">
                            <span className="row-title">{tool.name}</span>
                            <Badge tone={risk.tone}>{risk.label}</Badge>
                          </span>
                          <span className="row-preview">
                            {unavailable ? unavailableText : tool.description || "Runtime 工具"}
                          </span>
                        </span>
                        <button
                          className={`switch ${enabled ? "is-on" : ""}`}
                          type="button"
                          role="switch"
                          aria-checked={enabled}
                          aria-label={`${enabled ? "停用" : "启用"} ${tool.name}`}
                          disabled={running || updateConfiguration.isPending || (unavailable && !enabled)}
                          onClick={() => {
                            const next = enabled
                              ? enabledTools.filter((name) => name !== tool.name)
                              : [...enabledTools, tool.name];
                            const elevated = tool.policy?.minimumPreset === "trusted-automation"
                              || tool.risk === "external-effect";
                            if (
                              !enabled
                              && elevated
                              && !window.confirm(`启用“${tool.name}”将提高当前会话权限，是否继续？`)
                            ) {
                              return;
                            }
                            updateConfiguration.mutate({
                              patch: {
                                policy: policyWithEnabledTools(
                                  currentPolicy,
                                  capabilityTools.data || [],
                                  next,
                                ),
                              },
                              successMessage: enabled
                                ? `已停用 ${tool.name}`
                                : `已启用 ${tool.name}`,
                            });
                          }}
                        >
                          <span />
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <div className="session-config-empty">没有匹配的工具</div>
                )
              ) : null}
              {sessionConfigTab === "skills" ? (
                skills.isLoading ? (
                  <LoadingState label="正在读取 Skills" />
                ) : configSkills.length ? (
                  configSkills.map((skill) => {
                    const enabled = enabledSkillIds.includes(skill.id);
                    return (
                      <div className="session-config-row" key={skill.id}>
                        <Sparkles size={17} aria-hidden="true" />
                        <span className="row-main">
                          <span className="row-title-line">
                            <span className="row-title">{skill.name || skill.id}</span>
                            {skill.source ? <Badge>{skill.source}</Badge> : null}
                          </span>
                          <span className="row-preview">
                            {skill.description || skill.file || "Skill"}
                          </span>
                        </span>
                        <button
                          className={`switch ${enabled ? "is-on" : ""}`}
                          type="button"
                          role="switch"
                          aria-checked={enabled}
                          aria-label={`${enabled ? "停用" : "启用"} ${skill.name || skill.id}`}
                          disabled={running || updateConfiguration.isPending}
                          onClick={() => {
                            const next = enabled
                              ? enabledSkillIds.filter((id) => id !== skill.id)
                              : [...enabledSkillIds, skill.id];
                            updateConfiguration.mutate({
                              patch: { skills: { enabled: next } },
                              successMessage: enabled
                                ? `已停用 ${skill.name || skill.id}`
                                : `已启用 ${skill.name || skill.id}`,
                            });
                          }}
                        >
                          <span />
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <div className="session-config-empty">没有匹配的 Skill</div>
                )
              ) : null}
            </div>
            {running ? (
              <p className="session-config-note">当前 Run 结束后才能修改会话配置。</p>
            ) : null}
            {updateConfiguration.isError ? (
              <div className="inline-error page-error">
                {updateConfiguration.error instanceof Error
                  ? updateConfiguration.error.message
                  : "会话配置更新失败"}
              </div>
            ) : null}
          </div>
        </BottomSheetFrame>
      ) : null}
      {sessionInfoOpen ? (
        <BottomSheetFrame
          title="会话信息"
          subtitle={title}
          onClose={() => setSessionInfoOpen(false)}
        >
          <div className="sheet-body">
            <div className="sheet-status-row">
              <Badge tone={running ? "blue" : "green"}>{running ? "运行中" : "已连接"}</Badge>
              <span>{session.data.status === "active" ? "可继续对话" : "已归档"}</span>
            </div>
            <dl className="sheet-kv">
              <div><dt>模型</dt><dd>{model}</dd></div>
              <div><dt>权限</dt><dd>{policyLabel}</dd></div>
              <div><dt>消息</dt><dd>{messages.data?.filter((message) => message.role !== "tool").length || 0} 条</dd></div>
              <div><dt>工具</dt><dd>{enabledTools.length} 个</dd></div>
              <div><dt>Skills</dt><dd>{enabledSkillIds.length} 个</dd></div>
              <div><dt>产物</dt><dd>{artifactBundle.changes.length} 变更 / {artifactBundle.artifacts.length} 文件</dd></div>
              <div><dt>创建</dt><dd>{formatTimestamp(session.data.createdAt) || "-"}</dd></div>
              <div><dt>更新</dt><dd>{formatTimestamp(session.data.updatedAt) || "-"}</dd></div>
            </dl>
            {session.data.policy?.fileRoots?.length ? (
              <p className="sheet-note">工作区：{session.data.policy.fileRoots[0]}</p>
            ) : null}
            <p className="sheet-note">模型、工具与 Skills 可从输入框下方直接切换，仅影响当前会话。</p>
          </div>
          <div className="sheet-actions">
            {displayMessages.length > 0 ? (
              <>
                <SheetAction
                  icon={Sparkles}
                  label="总结本会话"
                  onClick={() => {
                    setSessionInfoOpen(false);
                    sendText("总结本会话的结论、已完成事项、未解决问题和下一步建议。");
                  }}
                />
                <SheetAction
                  icon={CheckCircle2}
                  label="列出下一步"
                  onClick={() => {
                    setSessionInfoOpen(false);
                    sendText("基于当前会话，列出下一步最值得做的 3 件事。");
                  }}
                />
              </>
            ) : null}
            <SheetAction
              icon={Copy}
              label="复制会话链接"
              onClick={() => {
                void copyAndToast(location.href, "会话链接已复制");
                setSessionInfoOpen(false);
              }}
            />
            <SheetAction
              icon={Clipboard}
              label="复制 Session ID"
              description={decodedSessionId}
              onClick={() => {
                void copyAndToast(decodedSessionId, "Session ID 已复制");
                setSessionInfoOpen(false);
              }}
            />
            <SheetAction
              icon={MessageCirclePlus}
              label="复制为新会话"
              onClick={async () => {
                const fork = await forkSession(decodedSessionId);
                setSessionInfoOpen(false);
                navigate(`/chat/${encodeURIComponent(fork.id)}`);
              }}
            />
            {artifactBundle.artifacts.length || artifactBundle.changes.length ? (
              <SheetAction
                icon={FileCheck2}
                label="查看本会话产物"
                onClick={() => {
                  setSessionInfoOpen(false);
                  openArtifacts();
                }}
              />
            ) : null}
          </div>
        </BottomSheetFrame>
      ) : null}
      {toast ? (
        <div className="mobile-toast" role="status">{toast}</div>
      ) : null}
    </MobilePage>
  );
}
