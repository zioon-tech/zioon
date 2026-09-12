import {
  Activity,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleStop,
  Copy,
  CornerDownLeft,
  Cpu,
  Ellipsis,
  Eye,
  File,
  FileCheck2,
  FileText,
  Folder,
  FolderOpen,
  Grid2X2,
  Image,
  Laptop,
  Layers3,
  MessageCircle,
  MessageCirclePlus,
  MessageSquare,
  MessagesSquare,
  Pencil,
  Plus,
  Puzzle,
  Radio,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldAlert,
  Sparkles,
  Square,
  SquareTerminal,
  Trash2,
  UserRound,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ChangeDetailScreen,
  CommentsScreen,
  FileDetailScreen,
  KnowledgeScreen,
  ModelsScreen,
  PluginsScreen,
  ScheduleEditorScreen,
  SchedulesPanel,
  SegmentedTabs,
  SettingsScreen,
  SkillsScreen,
  TasksPanel,
  WorkStatusSummary,
  type WorkTab,
} from "./MobileSecondaryScreens";

type Route =
  | "chat"
  | "chats"
  | "runs"
  | "schedule-new"
  | "run-detail"
  | "approval"
  | "terminals"
  | "terminal"
  | "more"
  | "devices"
  | "files"
  | "file-detail"
  | "change-detail"
  | "skills"
  | "plugins"
  | "models"
  | "knowledge"
  | "comments"
  | "settings";

type NavKey = "chats" | "runs" | "terminals" | "more";
type ApprovalState = "pending" | "approved" | "rejected";
type SessionState = "ready" | "running" | "approval";

type Session = {
  id: string;
  title: string;
  preview: string;
  time: string;
  state: SessionState;
};

type ToolSummary = {
  title: string;
  meta: string;
  detail: string;
  icon?: LucideIcon;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  text?: string;
  paragraphs?: string[];
  bullets?: Array<{ label: string; text: string }>;
  tool?: ToolSummary;
  artifact?: boolean;
  thinking?: {
    summary: string;
    detail: string;
  };
  todos?: Array<{
    label: string;
    done: boolean;
  }>;
  changes?: {
    files: number;
    added: number;
    removed: number;
  };
};

type TerminalLine = {
  kind: "prompt" | "dim" | "normal";
  text: string;
};

type HistoryEntry = {
  route: Route;
  sessionId: string;
  scrollTop: number;
};

type SheetOption = {
  icon: LucideIcon;
  label: string;
  message: string;
  selected?: boolean;
  onSelect?: () => void;
};

type SheetState = {
  title: string;
  options: SheetOption[];
};

type HeaderConfig = {
  title: string;
  subtitle: string;
  backLabel?: string;
  action?: {
    icon: LucideIcon;
    label: string;
    onClick: () => void;
  };
};

const ARTIFACT_IMAGE =
  "https://copilot-cn.bytedance.net/api/ide/v1/text_to_image?prompt=realistic%20daylight%20aerial%20architectural%20photography%20of%20a%20modern%20riverfront%20mixed-use%20complex%20in%20Hangzhou%20China%2C%20clear%20buildings%20and%20two%20rivers%2C%20documentary%20style%2C%20natural%20colors%2C%20no%20text&image_size=landscape_16_9";

const SESSIONS: Session[] = [
  {
    id: "jianghe",
    title: "江河汇项目地址查询",
    preview: "已整理项目位置、两组凭证用途和公开资料。",
    time: "刚刚",
    state: "ready",
  },
  {
    id: "release",
    title: "发布前回归检查",
    preview: "正在执行 Runtime 与 Connector 测试。",
    time: "3 分钟",
    state: "running",
  },
  {
    id: "terminal",
    title: "远程终端排障",
    preview: "等待批准在 office-mac 执行测试命令。",
    time: "12 分钟",
    state: "approval",
  },
  {
    id: "identity",
    title: "Identity 插件同步",
    preview: "手机端已正常读取 Biography 数据。",
    time: "昨天",
    state: "ready",
  },
];

const INITIAL_MESSAGES: Record<string, Message[]> = {
  jianghe: [
    {
      id: "jianghe-user-1",
      role: "user",
      text: "最近是不是上线了个江河汇的东西？帮我确认项目地址和两组 token 分别是做什么的。",
    },
    {
      id: "jianghe-assistant-1",
      role: "assistant",
      paragraphs: [
        "查到了。江河汇位于杭州钱江新城二期，靠近钱塘江与运河交汇区域。",
        "两者权限不同，终端管理或设备操作不能使用普通 Client 权限替代。",
      ],
      bullets: [
        { label: "Owner 配对码", text: "用于管理设备、生成邀请和吊销客户端。" },
        { label: "Client 配对码", text: "用于手机或普通浏览器访问会话与运行。" },
      ],
      tool: {
        title: "搜索公开资料",
        meta: "3 个来源 · 2.4s",
        detail: "已查询项目公开资料并核对 Runtime 配对权限说明。",
        icon: Search,
      },
      artifact: true,
    },
    {
      id: "jianghe-user-2",
      role: "user",
      text: "后续手机上就按普通对话来做，不要再让我操作编辑器。",
    },
    {
      id: "jianghe-assistant-2",
      role: "assistant",
      paragraphs: [
        "可以。移动端会作为独立 Client：使用消息流和固定输入框，读取结构化 Session projection，不加载 CodeMirror。",
      ],
      thinking: {
        summary: "已比较响应式改造与独立 Client 两种方案",
        detail: "独立 Client 可以避免桌面编辑器、面板系统和插件 DOM 对移动交互的长期约束，同时继续复用 Runtime 协议。",
      },
      tool: {
        title: "更新移动端产品方案",
        meta: "已完成",
        detail: "已将独立 Mobile Client、结构化消息接口和桌面边界写入 PRD。",
        icon: CheckCircle2,
      },
      todos: [
        { label: "盘点 Workbench 移动能力", done: true },
        { label: "完善 React 交互原型", done: true },
        { label: "定义 Mobile Runtime API", done: false },
      ],
      changes: {
        files: 4,
        added: 186,
        removed: 24,
      },
    },
  ],
  release: [
    {
      id: "release-user-1",
      role: "user",
      text: "把 Runtime 和 Connector 的回归测试跑一遍，发现问题就停下来告诉我。",
    },
    {
      id: "release-assistant-1",
      role: "assistant",
      paragraphs: ["测试正在 office-mac 上执行，当前已完成 34 / 50 个测试文件。"],
    },
  ],
  terminal: [
    {
      id: "terminal-user-1",
      role: "user",
      text: "帮我确认远程终端为什么有延迟。",
    },
    {
      id: "terminal-assistant-1",
      role: "assistant",
      paragraphs: [
        "终端已协商为 WebRTC 直连。下一步测试需要执行本机命令，正在等待你的批准。",
      ],
    },
  ],
  identity: [
    {
      id: "identity-user-1",
      role: "user",
      text: "确认手机端能不能读取 Biography。",
    },
    {
      id: "identity-assistant-1",
      role: "assistant",
      paragraphs: [
        "已经验证通过。Identity 插件可以经 Connector 读取 office-mac 上的 Biography 数据。",
      ],
    },
  ],
  new: [],
};

const INITIAL_TERMINAL_LINES: TerminalLine[] = [
  { kind: "dim", text: "Connected to office-mac · WebRTC direct · 38ms" },
  { kind: "prompt", text: "zion-next % pwd" },
  { kind: "normal", text: "/Users/dev/zion-next" },
  { kind: "prompt", text: "zion-next % git status --short" },
  { kind: "normal", text: " M apps/runtime/src/server.mjs\n?? docs/product/mobile/" },
];

const TERMINAL_RESPONSES: Record<string, string> = {
  pwd: "/Users/dev/zion-next",
  "git status": "On branch feature/core-observability\nChanges not staged for commit: 4 files",
  "git status --short": " M apps/runtime/src/server.mjs\n?? docs/product/mobile/",
  "npm test": "RUN  v2.1.8\n✓ 47 test files passed\nTest Files  47 passed (47)",
};

function IconButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className="icon-button" type="button" aria-label={label} title={label} onClick={onClick}>
      <Icon size={20} aria-hidden="true" />
    </button>
  );
}

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="back-button" type="button" onClick={onClick}>
      <ChevronLeft size={19} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function AppHeader({ config, onBack }: { config: HeaderConfig; onBack: () => void }) {
  return (
    <header className="app-header">
      <div className="header-side">
        {config.backLabel ? <BackButton label={config.backLabel} onClick={onBack} /> : null}
      </div>
      <div className="header-title">
        <strong>{config.title}</strong>
        <small>{config.subtitle}</small>
      </div>
      <div className="header-side end">
        {config.action ? (
          <IconButton
            icon={config.action.icon}
            label={config.action.label}
            onClick={config.action.onClick}
          />
        ) : null}
      </div>
    </header>
  );
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "blue" | "green" | "amber" | "red";
}) {
  return <span className={`badge ${tone === "neutral" ? "" : tone}`}>{children}</span>;
}

function StatusDot({ tone = "online" }: { tone?: "online" | "running" | "warning" | "danger" }) {
  return <span className={`status-dot ${tone === "online" ? "" : tone}`} aria-hidden="true" />;
}

function RowIcon({
  icon: Icon,
  tone = "neutral",
}: {
  icon: LucideIcon;
  tone?: "neutral" | "blue" | "green" | "amber";
}) {
  return (
    <span className={`row-icon ${tone === "neutral" ? "" : tone}`}>
      <Icon size={19} aria-hidden="true" />
    </span>
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <span className="progress" aria-label={`进度 ${value}%`}>
      <span style={{ width: `${value}%` }} />
    </span>
  );
}

function ToolCard({
  id,
  tool,
  expanded,
  onToggle,
}: {
  id: string;
  tool: ToolSummary;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const Icon = tool.icon || CheckCircle2;
  return (
    <div className="tool-card">
      <button type="button" aria-expanded={expanded} onClick={() => onToggle(id)}>
        <span className="inline-icon">
          <Icon size={18} aria-hidden="true" />
        </span>
        <span className="tool-title">{tool.title}</span>
        <span className="tool-meta">{tool.meta}</span>
        {expanded ? (
          <ChevronUp size={16} aria-hidden="true" />
        ) : (
          <ChevronDown size={16} aria-hidden="true" />
        )}
      </button>
      {expanded ? <div className="tool-detail">{tool.detail}</div> : null}
    </div>
  );
}

function ThinkingCard({
  id,
  summary,
  detail,
  expanded,
  onToggle,
}: {
  id: string;
  summary: string;
  detail: string;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="thinking-card">
      <button type="button" aria-expanded={expanded} onClick={() => onToggle(`thinking:${id}`)}>
        <Sparkles size={17} aria-hidden="true" />
        <span>
          <strong>思考摘要</strong>
          <small>{summary}</small>
        </span>
        {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {expanded ? <p>{detail}</p> : null}
    </div>
  );
}

function TodoSummaryCard({ todos }: { todos: NonNullable<Message["todos"]> }) {
  const done = todos.filter((todo) => todo.done).length;
  return (
    <div className="todo-summary-card">
      <div className="card-summary-head">
        <span><CheckCircle2 size={17} />任务进度</span>
        <Badge tone="blue">{done}/{todos.length}</Badge>
      </div>
      <ProgressBar value={Math.round((done / Math.max(1, todos.length)) * 100)} />
      <div className="compact-todos">
        {todos.map((todo) => (
          <span className={todo.done ? "is-done" : ""} key={todo.label}>
            {todo.done ? <CheckCircle2 size={15} /> : <CircleStop size={15} />}
            {todo.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function ChangesCard({
  changes,
  onOpen,
}: {
  changes: NonNullable<Message["changes"]>;
  onOpen: () => void;
}) {
  return (
    <button className="changes-card" type="button" onClick={onOpen}>
      <span className="inline-icon"><FileText size={18} /></span>
      <span>
        <strong>{changes.files} 个文件发生变更</strong>
        <small><b>+{changes.added}</b> <em>-{changes.removed}</em> · 等待审阅</small>
      </span>
      <ChevronRight size={17} />
    </button>
  );
}

function MessageView({
  message,
  expanded,
  thinkingExpanded,
  onToggleTool,
  onOpenChanges,
}: {
  message: Message;
  expanded: boolean;
  thinkingExpanded: boolean;
  onToggleTool: (id: string) => void;
  onOpenChanges: () => void;
}) {
  if (message.role === "user") {
    return (
      <article className="message user">
        <div className="message-body">{message.text}</div>
      </article>
    );
  }

  return (
    <article className="message assistant">
      <div className="message-label">ZION</div>
      <div className="message-body">
        {message.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        {message.bullets?.length ? (
          <ul>
            {message.bullets.map((item) => (
              <li key={item.label}>
                <strong>{item.label}：</strong>
                {item.text}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {message.thinking ? (
        <ThinkingCard
          id={message.id}
          summary={message.thinking.summary}
          detail={message.thinking.detail}
          expanded={thinkingExpanded}
          onToggle={onToggleTool}
        />
      ) : null}
      {message.tool ? (
        <ToolCard
          id={message.id}
          tool={message.tool}
          expanded={expanded}
          onToggle={onToggleTool}
        />
      ) : null}
      {message.todos ? <TodoSummaryCard todos={message.todos} /> : null}
      {message.changes ? <ChangesCard changes={message.changes} onOpen={onOpenChanges} /> : null}
      {message.artifact ? (
        <figure className="artifact-card">
          <div className="artifact-head">
            <span className="inline-icon">
              <Image size={18} aria-hidden="true" />
            </span>
            <figcaption className="artifact-title">江河汇位置参考</figcaption>
            <span className="artifact-meta">图片</span>
          </div>
          <img className="artifact-image" src={ARTIFACT_IMAGE} alt="杭州江河汇河岸建筑群参考图" />
        </figure>
      ) : null}
    </article>
  );
}

function TypingIndicator() {
  return (
    <article className="message assistant">
      <div className="message-label">ZION · 正在处理</div>
      <div className="typing" aria-label="正在回复">
        <span />
        <span />
        <span />
      </div>
    </article>
  );
}

function ChatScreen({
  messages,
  sending,
  isNew,
  expandedTools,
  onToggleTool,
  onOpenChanges,
}: {
  messages: Message[];
  sending: boolean;
  isNew: boolean;
  expandedTools: Set<string>;
  onToggleTool: (id: string) => void;
  onOpenChanges: () => void;
}) {
  if (isNew && messages.length === 0) {
    return (
      <section className="screen chat-screen">
        <div className="empty-state">
          <RowIcon icon={Sparkles} tone="blue" />
          <h2>开始新对话</h2>
          <p>输入第一条消息开始。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="screen chat-screen">
      <div className="chat-day">今天</div>
      {messages.map((message) => (
        <MessageView
          key={message.id}
          message={message}
          expanded={expandedTools.has(message.id)}
          thinkingExpanded={expandedTools.has(`thinking:${message.id}`)}
          onToggleTool={onToggleTool}
          onOpenChanges={onOpenChanges}
        />
      ))}
      {sending ? <TypingIndicator /> : null}
    </section>
  );
}

function SessionIcon({ state }: { state: SessionState }) {
  if (state === "running") return <RowIcon icon={Activity} tone="blue" />;
  if (state === "approval") return <RowIcon icon={ShieldAlert} tone="amber" />;
  return <RowIcon icon={MessageSquare} />;
}

function ChatsScreen({
  query,
  onQuery,
  onOpen,
}: {
  query: string;
  onQuery: (value: string) => void;
  onOpen: (sessionId: string) => void;
}) {
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return SESSIONS;
    return SESSIONS.filter((session) =>
      `${session.title} ${session.preview}`.toLowerCase().includes(normalized),
    );
  }, [query]);

  return (
    <section className="screen">
      <div className="search-wrap">
        <label className="search-box">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">搜索会话</span>
          <input
            type="search"
            value={query}
            placeholder="搜索会话"
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
      </div>
      <p className="section-label">最近</p>
      <div className="list">
        {filtered.map((session) => (
          <button
            className="list-row"
            type="button"
            key={session.id}
            onClick={() => onOpen(session.id)}
          >
            <SessionIcon state={session.state} />
            <span className="row-main">
              <span className="row-title-line">
                <span className="row-title">{session.title}</span>
                {session.state === "running" ? <StatusDot tone="running" /> : null}
                {session.state === "approval" ? <StatusDot tone="warning" /> : null}
              </span>
              <span className="row-preview">{session.preview}</span>
            </span>
            <span className="row-meta">{session.time}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function RunsScreen({
  approval,
  runStopped,
  onOpenApproval,
  onOpenRun,
  onToast,
}: {
  approval: ApprovalState;
  runStopped: boolean;
  onOpenApproval: () => void;
  onOpenRun: () => void;
  onToast: (message: string) => void;
}) {
  return (
    <div className="work-tab-panel">
      <div className="summary-strip">
        <div className="summary-item">
          <strong>{runStopped ? 0 : 1}</strong>
          <span>运行中</span>
        </div>
        <div className="summary-item">
          <strong>{approval === "pending" ? 1 : 0}</strong>
          <span>待处理</span>
        </div>
        <div className="summary-item">
          <strong>12</strong>
          <span>今日完成</span>
        </div>
      </div>

      {approval === "pending" ? (
        <>
          <p className="section-label">需要我处理</p>
          <div className="list">
            <button className="list-row" type="button" onClick={onOpenApproval}>
              <RowIcon icon={ShieldAlert} tone="amber" />
              <span className="row-main">
                <span className="row-title-line">
                  <span className="row-title">执行测试命令</span>
                  <Badge tone="amber">待审批</Badge>
                </span>
                <span className="row-preview">office-mac · npm run runtime:test</span>
              </span>
              <span className="row-meta">4:32</span>
            </button>
          </div>
        </>
      ) : null}

      <p className="section-label">正在运行</p>
      <div className="list">
        <button className="list-row" type="button" onClick={onOpenRun}>
          <RowIcon icon={runStopped ? CircleStop : Activity} tone="blue" />
          <span className="row-main">
            <span className="row-title-line">
              <span className="row-title">发布前回归检查</span>
              <Badge tone={runStopped ? "neutral" : "blue"}>{runStopped ? "已停止" : "运行中"}</Badge>
            </span>
            <span className="row-preview">
              {runStopped ? "用户已停止运行" : "Runtime 测试 68% · office-mac"}
            </span>
            <ProgressBar value={68} />
          </span>
          <span className="row-meta">6:18</span>
        </button>
      </div>

      <p className="section-label">最近完成</p>
      <div className="list">
        <button className="list-row" type="button" onClick={() => onToast("已打开 Run 摘要")}>
          <RowIcon icon={CheckCircle2} tone="green" />
          <span className="row-main">
            <span className="row-title">Identity 插件同步</span>
            <span className="row-preview">完成 · 14 个工具调用 · ¥0.12</span>
          </span>
          <span className="row-meta">昨天</span>
        </button>
      </div>
    </div>
  );
}

function WorkScreen({
  tab,
  approval,
  runStopped,
  completedTodos,
  schedules,
  onTabChange,
  onOpenApproval,
  onOpenRun,
  onToggleTodo,
  onContinueTask,
  onToggleSchedule,
  onRunSchedule,
  onToast,
}: {
  tab: WorkTab;
  approval: ApprovalState;
  runStopped: boolean;
  completedTodos: Set<string>;
  schedules: Record<string, boolean>;
  onTabChange: (tab: WorkTab) => void;
  onOpenApproval: () => void;
  onOpenRun: () => void;
  onToggleTodo: (id: string) => void;
  onContinueTask: () => void;
  onToggleSchedule: (id: string) => void;
  onRunSchedule: (title: string) => void;
  onToast: (message: string) => void;
}) {
  return (
    <section className="screen">
      <SegmentedTabs
        value={tab}
        items={[
          { value: "runs", label: "运行", badge: approval === "pending" ? 1 : 0 },
          { value: "tasks", label: "任务" },
          { value: "schedules", label: "定时" },
        ]}
        onChange={onTabChange}
      />
      <div className="work-status-bar">
        <WorkStatusSummary tab={tab} />
      </div>
      {tab === "runs" ? (
        <RunsScreen
          approval={approval}
          runStopped={runStopped}
          onOpenApproval={onOpenApproval}
          onOpenRun={onOpenRun}
          onToast={onToast}
        />
      ) : null}
      {tab === "tasks" ? (
        <TasksPanel completed={completedTodos} onToggleTodo={onToggleTodo} onContinue={onContinueTask} />
      ) : null}
      {tab === "schedules" ? (
        <SchedulesPanel enabled={schedules} onToggle={onToggleSchedule} onRunNow={onRunSchedule} />
      ) : null}
    </section>
  );
}

function RunDetailScreen({
  stopped,
  onOpenSession,
  onStop,
}: {
  stopped: boolean;
  onOpenSession: () => void;
  onStop: () => void;
}) {
  return (
    <section className="screen">
      <div className="detail-section">
        <div className="row-title-line">
          <StatusDot tone={stopped ? "online" : "running"} />
          <span className="row-title">{stopped ? "已停止" : "正在执行 Runtime 测试"}</span>
        </div>
        <ProgressBar value={68} />
        <p className="spaced-copy">34 / 50 个测试文件 · 已运行 6 分 18 秒</p>
      </div>
      <div className="detail-section">
        <h2>执行信息</h2>
        <dl className="kv">
          <dt>会话</dt><dd>发布前回归检查</dd>
          <dt>Runtime</dt><dd>aliyun-hk · 在线</dd>
          <dt>Resource Host</dt><dd>office-mac · WebRTC</dd>
          <dt>模型</dt><dd>DeepSeek V4 Flash</dd>
          <dt>策略</dt><dd>Workspace write</dd>
        </dl>
      </div>
      <div className="detail-section">
        <h2>最近步骤</h2>
        <dl className="kv">
          <dt>21:43:08</dt><dd>完成 access-control.test.js</dd>
          <dt>21:43:12</dt><dd>正在执行 collaboration-service.test.js</dd>
          <dt>下一步</dt><dd>构建 Workbench 并检查产物</dd>
        </dl>
      </div>
      <div className="action-bar">
        <button className="button flex" type="button" onClick={onOpenSession}>
          <MessageSquare size={17} aria-hidden="true" /> 返回会话
        </button>
        <button className="button danger flex" type="button" disabled={stopped} onClick={onStop}>
          <Square size={15} aria-hidden="true" /> {stopped ? "已停止" : "停止"}
        </button>
      </div>
    </section>
  );
}

function ApprovalScreen({
  state,
  onApprove,
  onReject,
}: {
  state: ApprovalState;
  onApprove: () => void;
  onReject: () => void;
}) {
  const handled = state !== "pending";
  return (
    <section className="screen">
      <div className="approval-hero">
        <span className="inline-icon">
          {handled ? <CheckCircle2 size={20} /> : <ShieldAlert size={20} />}
        </span>
        <h2>{handled ? (state === "approved" ? "已批准" : "已拒绝") : "需要批准一项远程操作"}</h2>
        <p>
          {handled
            ? "该决策已同步到 Runtime。"
            : "此命令会在 office-mac 的 zion-next workspace 中执行测试。"}
        </p>
      </div>
      <div className="detail-section">
        <h2>操作</h2>
        <div className="command-preview">npm run runtime:test</div>
      </div>
      <div className="detail-section">
        <dl className="kv">
          <dt>来源会话</dt><dd>远程终端排障</dd>
          <dt>Runtime</dt><dd>aliyun-hk</dd>
          <dt>Resource Host</dt><dd>office-mac</dd>
          <dt>工作目录</dt><dd>/Users/dev/zion-next</dd>
          <dt>风险</dt><dd><Badge tone="amber">执行本机命令</Badge></dd>
          <dt>有效期</dt><dd>{handled ? "已处理" : "剩余 4 分 32 秒"}</dd>
        </dl>
      </div>
      <div className="action-bar">
        <button className="button flex" type="button" disabled={handled} onClick={onReject}>拒绝</button>
        <button className="button primary flex" type="button" disabled={handled} onClick={onApprove}>
          <Check size={17} aria-hidden="true" /> 批准本次
        </button>
      </div>
    </section>
  );
}

function TerminalsScreen({
  transport,
  onOpenTerminal,
  onToast,
}: {
  transport: "direct" | "relay";
  onOpenTerminal: () => void;
  onToast: (message: string) => void;
}) {
  const direct = transport === "direct";
  return (
    <section className="screen">
      <p className="section-label">当前资源设备</p>
      <div className="detail-section">
        <div className="row-title-line">
          <StatusDot />
          <span className="row-title">office-mac</span>
          <Badge tone="green">在线</Badge>
        </div>
        <p className="spaced-copy">3 个终端 · 37 个工具 · 最近活动 8 秒前</p>
      </div>
      <p className="section-label">终端会话</p>
      <div className="list">
        <button className="list-row" type="button" onClick={onOpenTerminal}>
          <RowIcon icon={SquareTerminal} tone="green" />
          <span className="row-main">
            <span className="row-title-line">
              <span className="row-title">zion-next</span>
              <Badge tone={direct ? "green" : "amber"}>{direct ? "直连" : "中转"}</Badge>
            </span>
            <span className="row-preview">/Users/dev/zion-next · {direct ? "38ms" : "286ms"}</span>
          </span>
          <span className="row-meta">现在</span>
        </button>
        <button className="list-row" type="button" onClick={() => onToast("已切换到 logs 终端")}>
          <RowIcon icon={SquareTerminal} />
          <span className="row-main">
            <span className="row-title">runtime-logs</span>
            <span className="row-preview">journalctl -u zion-runtime -f</span>
          </span>
          <span className="row-meta">2 分钟</span>
        </button>
      </div>
    </section>
  );
}

function TerminalScreen({
  lines,
  command,
  onCommand,
  onSubmit,
  onKey,
}: {
  lines: TerminalLine[];
  command: string;
  onCommand: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onKey: (key: string) => void;
}) {
  const outputRef = useRef<HTMLPreElement>(null);
  const terminalKeys: Array<{ label: string; icon?: LucideIcon }> = [
    { label: "Esc" },
    { label: "Ctrl" },
    { label: "Alt" },
    { label: "Tab" },
    { label: "↑", icon: ArrowUp },
    { label: "↓", icon: ArrowDown },
    { label: "←", icon: ArrowLeft },
    { label: "→", icon: ArrowRight },
  ];

  useLayoutEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [lines]);

  return (
    <section className="terminal-screen">
      <pre className="terminal-output" ref={outputRef}>
        {lines.map((line, index) => (
          <span className={line.kind} key={`${index}-${line.text}`}>
            {line.text}
            {index < lines.length - 1 ? "\n" : ""}
          </span>
        ))}
      </pre>
      <form className="terminal-input-row" onSubmit={onSubmit}>
        <span>$</span>
        <label className="sr-only" htmlFor="terminalCommand">终端命令</label>
        <input
          id="terminalCommand"
          name="command"
          type="text"
          value={command}
          placeholder="输入命令"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => onCommand(event.target.value)}
        />
        <button className="terminal-submit" type="submit" aria-label="执行命令">
          <CornerDownLeft size={18} aria-hidden="true" />
        </button>
      </form>
      <div className="terminal-keys" aria-label="终端快捷键">
        {terminalKeys.map(({ label, icon: KeyIcon }) => (
          <button className="terminal-key" type="button" key={label} onClick={() => onKey(label)}>
            {KeyIcon ? <KeyIcon size={15} aria-label={label} /> : label}
          </button>
        ))}
      </div>
    </section>
  );
}

function MoreScreen({
  onNavigate,
  selectedModel,
}: {
  onNavigate: (route: Route) => void;
  selectedModel: string;
}) {
  const groups: Array<{
    label: string;
    items: Array<{
      target: Route;
      icon: LucideIcon;
      title: string;
      preview: string;
      tone?: "blue" | "green";
    }>;
  }> = [
    {
      label: "内容与知识",
      items: [
        { target: "files", icon: FolderOpen, title: "文件与变更", preview: "Workspace、Diff 和 Artifact", tone: "blue" },
        { target: "knowledge", icon: UserRound, title: "Identity 与 Memory", preview: "工作项目、Biography 和长期记忆" },
        { target: "comments", icon: MessageCircle, title: "评论", preview: "2 个活跃线程 · 1 个待回复" },
      ],
    },
    {
      label: "能力与配置",
      items: [
        { target: "skills", icon: Sparkles, title: "Skills", preview: "24 个可用 · office-mac" },
        { target: "plugins", icon: Puzzle, title: "插件", preview: "18 个已启用 · 2 个仅桌面" },
        { target: "models", icon: Cpu, title: "模型", preview: selectedModel },
        { target: "devices", icon: Laptop, title: "设备状态", preview: "Runtime、Connector 和终端连接", tone: "green" },
        { target: "settings", icon: Settings, title: "设置", preview: "通知、审批和客户端信息" },
      ],
    },
  ];

  return (
    <section className="screen">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="section-label">{group.label}</p>
          <div className="list">
            {group.items.map((item) => (
              <button
                className="list-row"
                type="button"
                key={item.title}
                onClick={() => onNavigate(item.target)}
              >
                <RowIcon icon={item.icon} tone={item.tone || "neutral"} />
                <span className="row-main">
                  <span className="row-title">{item.title}</span>
                  <span className="row-preview">{item.preview}</span>
                </span>
                <span className="row-meta"><ChevronRight size={17} aria-hidden="true" /></span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function DevicesScreen({
  transport,
  onToast,
}: {
  transport: "direct" | "relay";
  onToast: (message: string) => void;
}) {
  return (
    <section className="screen">
      <p className="section-label">服务</p>
      <div className="list">
        <div className="list-row static-row">
          <RowIcon icon={Server} tone="green" />
          <span className="row-main">
            <span className="row-title-line"><span className="row-title">Runtime</span><Badge tone="green">在线</Badge></span>
            <span className="row-preview">aliyun-hk · HTTPS · 72ms</span>
          </span>
          <span className="row-meta">刚刚</span>
        </div>
        <div className="list-row static-row">
          <RowIcon icon={Laptop} tone="green" />
          <span className="row-main">
            <span className="row-title-line"><span className="row-title">office-mac</span><Badge tone="green">在线</Badge></span>
            <span className="row-preview">Connector · 37 tools · plugin service</span>
          </span>
          <span className="row-meta">8 秒</span>
        </div>
      </div>
      <p className="section-label">连接</p>
      <div className="detail-section">
        <dl className="kv">
          <dt>协同会话</dt><dd><span className="device-status"><StatusDot />已连接</span></dd>
          <dt>终端通道</dt><dd><span className="device-status"><StatusDot />{transport === "direct" ? "WebRTC 直连 · 38ms" : "Runtime 中转 · 286ms"}</span></dd>
          <dt>Relay</dt><dd>{transport === "direct" ? "可用 · 当前未使用" : "当前使用中"}</dd>
          <dt>插件服务</dt><dd>office-mac:8767 · 已代理</dd>
        </dl>
      </div>
      <p className="section-label">已配对客户端</p>
      <div className="list">
        <div className="list-row static-row">
          <RowIcon icon={MessageCircle} tone="blue" />
          <span className="row-main">
            <span className="row-title-line"><span className="row-title">iPhone Safari</span><Badge tone="blue">当前设备</Badge></span>
            <span className="row-preview">Client · 最近使用 刚刚</span>
          </span>
          <span className="row-meta">在线</span>
        </div>
        <div className="list-row static-row">
          <RowIcon icon={Laptop} />
          <span className="row-main">
            <span className="row-title-line"><span className="row-title">MacBook Chrome</span><Badge>Owner</Badge></span>
            <span className="row-preview">设备管理 · 最近使用 2 小时前</span>
          </span>
          <span className="row-meta">离线</span>
        </div>
      </div>
      <div className="action-bar">
        <button className="button flex" type="button" onClick={() => onToast("已生成 Client 配对码")}>配对客户端</button>
        <button className="button primary flex" type="button" onClick={() => onToast("已生成 Resource 配对码")}>配对电脑</button>
      </div>
    </section>
  );
}

function FilesScreen({
  tab,
  onTabChange,
  onOpenFile,
  onOpenChange,
  onToast,
}: {
  tab: "files" | "changes";
  onTabChange: (tab: "files" | "changes") => void;
  onOpenFile: () => void;
  onOpenChange: () => void;
  onToast: (message: string) => void;
}) {
  const folders = ["apps", "docs", "extensions", "packages", "src"];
  return (
    <section className="screen">
      <SegmentedTabs
        value={tab}
        items={[
          { value: "files", label: "文件" },
          { value: "changes", label: "变更", badge: 4 },
        ]}
        onChange={onTabChange}
      />
      {tab === "files" ? (
        <>
          <p className="section-label">最近结果</p>
          <div className="list">
            <button className="list-row" type="button" onClick={onOpenFile}>
              <RowIcon icon={FileText} tone="blue" />
              <span className="row-main">
                <span className="row-title">PRD-02-MOBILE-CONVERSATION.md</span>
                <span className="row-preview">18 KB · 刚刚更新</span>
              </span>
              <span className="row-meta"><ChevronRight size={17} /></span>
            </button>
            <button className="list-row" type="button" onClick={() => onToast("已打开构建报告")}>
              <RowIcon icon={FileCheck2} tone="green" />
              <span className="row-main">
                <span className="row-title">runtime-test-report.html</span>
                <span className="row-preview">50 个测试文件 · 47 已通过</span>
              </span>
              <span className="row-meta"><ChevronRight size={17} /></span>
            </button>
          </div>
          <p className="section-label">Workspace</p>
          <div className="list">
            {folders.map((folder) => (
              <button className="list-row" type="button" key={folder} onClick={() => onToast(`已进入 ${folder}`)}>
                <RowIcon icon={Folder} />
                <span className="row-main"><span className="row-title">{folder}</span></span>
                <span className="row-meta"><ChevronRight size={17} /></span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="change-summary">
            <div><strong>4</strong><span>文件</span></div>
            <div className="added"><strong>+186</strong><span>新增</span></div>
            <div className="removed"><strong>-24</strong><span>删除</span></div>
          </div>
          <div className="list">
            {[
              ["MobileClientDemo.tsx", "+42 -8", true],
              ["MobileSecondaryScreens.tsx", "+96 -0", false],
              ["styles.css", "+48 -16", false],
              ["WORKBENCH-MOBILE-FEATURE-MATRIX.md", "+220 -0", false],
            ].map(([name, summary, primary]) => (
              <button
                className="list-row"
                type="button"
                key={String(name)}
                onClick={primary ? onOpenChange : () => onToast(`已打开 ${name}`)}
              >
                <RowIcon icon={FileText} tone={primary ? "blue" : "neutral"} />
                <span className="row-main">
                  <span className="row-title">{name}</span>
                  <span className="row-preview">docs/product/mobile/demo · 等待审阅</span>
                </span>
                <span className="row-meta change-count">{summary}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function Composer({
  value,
  sending,
  selectedModel,
  toolMode,
  contextEnabled,
  onChange,
  onSend,
  onSelectModel,
  onSelectToolMode,
  onToggleContext,
  onOpenSheet,
}: {
  value: string;
  sending: boolean;
  selectedModel: string;
  toolMode: string;
  contextEnabled: Set<string>;
  onChange: (value: string) => void;
  onSend: () => void;
  onSelectModel: (model: string) => void;
  onSelectToolMode: (mode: string) => void;
  onToggleContext: (id: string) => void;
  onOpenSheet: (sheet: SheetState) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(116, Math.max(44, textarea.scrollHeight))}px`;
  }, [value]);

  return (
    <section className="composer" aria-label="消息输入">
      <div className="composer-box">
        <IconButton
          icon={Plus}
          label="添加附件"
          onClick={() => onOpenSheet({
            title: "添加内容",
            options: [
              { icon: Camera, label: "拍照", message: "已选择拍照" },
              { icon: Image, label: "从相册选择", message: "已打开相册" },
              { icon: File, label: "选择文件", message: "已打开文件选择器" },
            ],
          })}
        />
        <label className="sr-only" htmlFor="messageInput">输入消息</label>
        <textarea
          ref={textareaRef}
          id="messageInput"
          rows={1}
          value={value}
          placeholder="输入消息"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <button
          className={`send-button ${sending ? "is-stop" : ""}`}
          type="button"
          aria-label={sending ? "停止生成" : "发送消息"}
          title={sending ? "停止生成" : "发送消息"}
          onClick={onSend}
        >
          {sending ? <Square size={15} /> : <ArrowUp size={20} />}
        </button>
      </div>
      <div className="composer-meta">
        <button
          className="meta-button"
          type="button"
          onClick={() => onOpenSheet({
            title: "选择模型",
            options: [
              {
                icon: Cpu,
                label: "DeepSeek V4 Flash",
                message: "已切换到 DeepSeek V4 Flash",
                selected: selectedModel === "DeepSeek V4 Flash",
                onSelect: () => onSelectModel("DeepSeek V4 Flash"),
              },
              {
                icon: Cpu,
                label: "Claude Sonnet",
                message: "已切换到 Claude Sonnet",
                selected: selectedModel === "Claude Sonnet",
                onSelect: () => onSelectModel("Claude Sonnet"),
              },
              {
                icon: Cpu,
                label: "GPT-5",
                message: "已切换到 GPT-5",
                selected: selectedModel === "GPT-5",
                onSelect: () => onSelectModel("GPT-5"),
              },
            ],
          })}
        >
          <Cpu size={15} /> {selectedModel}
        </button>
        <button
          className="meta-button"
          type="button"
          onClick={() => onOpenSheet({
            title: "工具模式",
            options: [
              {
                icon: MessageCircle,
                label: "仅对话",
                message: "已切换为仅对话",
                selected: toolMode === "仅对话",
                onSelect: () => onSelectToolMode("仅对话"),
              },
              {
                icon: Eye,
                label: "只读",
                message: "已切换为只读",
                selected: toolMode === "只读",
                onSelect: () => onSelectToolMode("只读"),
              },
              {
                icon: Wrench,
                label: "可修改",
                message: "已切换为可修改",
                selected: toolMode === "可修改",
                onSelect: () => onSelectToolMode("可修改"),
              },
            ],
          })}
        >
          <Wrench size={15} /> {toolMode}
        </button>
        <button
          className="meta-button"
          type="button"
          onClick={() => onOpenSheet({
            title: "上下文",
            options: [
              {
                icon: Folder,
                label: "Workspace · zion-next",
                message: "Workspace 上下文已更新",
                selected: contextEnabled.has("workspace"),
                onSelect: () => onToggleContext("workspace"),
              },
              {
                icon: SquareTerminal,
                label: "终端 · zion-next",
                message: "终端上下文已更新",
                selected: contextEnabled.has("terminal"),
                onSelect: () => onToggleContext("terminal"),
              },
              {
                icon: UserRound,
                label: "Identity",
                message: "Identity 上下文已更新",
                selected: contextEnabled.has("identity"),
                onSelect: () => onToggleContext("identity"),
              },
            ],
          })}
        >
          <Layers3 size={15} /> 上下文 {contextEnabled.size}
        </button>
      </div>
    </section>
  );
}

function BottomNav({
  active,
  hasAlert,
  onNavigate,
}: {
  active: NavKey;
  hasAlert: boolean;
  onNavigate: (nav: NavKey) => void;
}) {
  const items: Array<{ key: NavKey; label: string; icon: LucideIcon }> = [
    { key: "chats", label: "对话", icon: MessagesSquare },
    { key: "runs", label: "工作", icon: Activity },
    { key: "terminals", label: "终端", icon: SquareTerminal },
    { key: "more", label: "更多", icon: Grid2X2 },
  ];
  return (
    <nav className="bottom-nav" aria-label="主导航">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            className={`nav-button ${active === item.key ? "is-active" : ""}`}
            type="button"
            key={item.key}
            onClick={() => onNavigate(item.key)}
          >
            <span className="nav-icon-wrap">
              <Icon size={20} aria-hidden="true" />
              {item.key === "runs" && hasAlert ? <span className="nav-alert">1</span> : null}
            </span>
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function BottomSheet({
  sheet,
  onClose,
  onSelect,
}: {
  sheet: SheetState | null;
  onClose: () => void;
  onSelect: (option: SheetOption) => void;
}) {
  if (!sheet) return null;
  return (
    <>
      <button className="sheet-backdrop is-open" type="button" aria-label="关闭" onClick={onClose} />
      <aside className="sheet is-open" aria-modal="true">
        <div className="sheet-handle" />
        <div className="sheet-head">
          <strong>{sheet.title}</strong>
          <IconButton icon={X} label="关闭" onClick={onClose} />
        </div>
        <div className="sheet-body">
          {sheet.options.map((option) => {
            const Icon = option.icon;
            return (
              <button
                className={`sheet-option ${option.selected ? "is-selected" : ""}`}
                type="button"
                key={option.label}
                onClick={() => onSelect(option)}
              >
                <Icon size={19} aria-hidden="true" />
                <span>{option.label}</span>
                {option.selected ? <Check size={17} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </aside>
    </>
  );
}

export function MobileClientDemo() {
  const [route, setRoute] = useState<Route>("chat");
  const [currentSessionId, setCurrentSessionId] = useState("jianghe");
  const [messagesBySession, setMessagesBySession] =
    useState<Record<string, Message[]>>(INITIAL_MESSAGES);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [sessionQuery, setSessionQuery] = useState("");
  const [workTab, setWorkTab] = useState<WorkTab>("runs");
  const [approval, setApproval] = useState<ApprovalState>("pending");
  const [runStopped, setRunStopped] = useState(false);
  const [completedTodos, setCompletedTodos] = useState<Set<string>>(
    new Set(["audit", "prototype"]),
  );
  const [schedules, setSchedules] = useState<Record<string, boolean>>({
    "daily-summary": true,
    "runtime-health": true,
    "weekly-review": false,
  });
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>(INITIAL_TERMINAL_LINES);
  const [terminalCommand, setTerminalCommand] = useState("");
  const [terminalTransport, setTerminalTransport] = useState<"direct" | "relay">("direct");
  const [filesTab, setFilesTab] = useState<"files" | "changes">("files");
  const [changeAccepted, setChangeAccepted] = useState(false);
  const [skillsEnabled, setSkillsEnabled] = useState<Record<string, boolean>>({});
  const [pluginsEnabled, setPluginsEnabled] = useState<Record<string, boolean>>({});
  const [selectedModel, setSelectedModel] = useState("DeepSeek V4 Flash");
  const [thinkingEffort, setThinkingEffort] = useState("中");
  const [toolMode, setToolMode] = useState("可修改");
  const [contextEnabled, setContextEnabled] = useState<Set<string>>(
    new Set(["workspace", "terminal", "identity"]),
  );
  const [settingsValues, setSettingsValues] = useState<Record<string, boolean>>({});
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [toast, setToast] = useState("");
  const contentRef = useRef<HTMLElement>(null);
  const historyRef = useRef<HistoryEntry[]>([]);
  const restoreScrollRef = useRef<number | null>(null);
  const sendTimerRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const session = SESSIONS.find((item) => item.id === currentSessionId) || {
    id: "new",
    title: "新会话",
    preview: "",
    time: "",
    state: "ready" as const,
  };
  const messages = messagesBySession[currentSessionId] || [];

  useEffect(() => () => {
    if (sendTimerRef.current) window.clearTimeout(sendTimerRef.current);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    if (restoreScrollRef.current != null) {
      container.scrollTop = restoreScrollRef.current;
      restoreScrollRef.current = null;
    } else if (route === "chat") {
      container.scrollTop = container.scrollHeight;
    } else {
      container.scrollTop = 0;
    }
  }, [route, messages.length, sending]);

  const showToast = (message: string) => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = window.setTimeout(() => setToast(""), 1800);
  };

  const navigate = (nextRoute: Route, options: { push?: boolean; sessionId?: string } = {}) => {
    if (options.push !== false) {
      historyRef.current.push({
        route,
        sessionId: currentSessionId,
        scrollTop: contentRef.current?.scrollTop || 0,
      });
    } else {
      historyRef.current = [];
    }
    if (options.sessionId) setCurrentSessionId(options.sessionId);
    setSheet(null);
    setRoute(nextRoute);
  };

  const goBack = () => {
    const previous = historyRef.current.pop();
    if (!previous) {
      setRoute("chats");
      return;
    }
    restoreScrollRef.current = previous.scrollTop;
    setCurrentSessionId(previous.sessionId);
    setRoute(previous.route);
  };

  const appendMessage = (sessionId: string, message: Message) => {
    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: [...(current[sessionId] || []), message],
    }));
  };

  const sendMessage = () => {
    if (sending) {
      if (sendTimerRef.current) window.clearTimeout(sendTimerRef.current);
      setSending(false);
      appendMessage(currentSessionId, {
        id: `stopped-${Date.now()}`,
        role: "assistant",
        paragraphs: ["已停止本次生成。当前结果已保留。"],
      });
      return;
    }

    const value = draft.trim();
    if (!value) return;
    const targetSessionId = currentSessionId;
    appendMessage(targetSessionId, {
      id: `user-${Date.now()}`,
      role: "user",
      text: value,
    });
    setDraft("");
    setSending(true);
    sendTimerRef.current = window.setTimeout(() => {
      setSending(false);
      appendMessage(targetSessionId, {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        paragraphs: [
          "收到。我已创建新的 Run，并把当前会话和 zion-next workspace 作为上下文。",
          "下一步会先检查相关文件，再把结果同步到这个会话。",
        ],
        tool: {
          title: "创建移动消息 Run",
          meta: "已完成",
          detail: "clientRequestId 已接受，Run projection 已连接。",
          icon: CheckCircle2,
        },
      });
    }, 1300);
  };

  const runTerminalCommand = (event: FormEvent) => {
    event.preventDefault();
    const value = terminalCommand.trim();
    if (!value) return;
    setTerminalLines((current) => [
      ...current,
      { kind: "prompt", text: `zion-next % ${value}` },
      {
        kind: value.startsWith("npm") ? "normal" : "dim",
        text: TERMINAL_RESPONSES[value] || `command queued on office-mac: ${value}`,
      },
    ]);
    setTerminalCommand("");
  };

  const activeNav: NavKey =
    route === "chat" || route === "chats"
      ? "chats"
      : route === "runs" || route === "schedule-new" || route === "run-detail" || route === "approval"
        ? "runs"
        : route === "terminals" || route === "terminal"
          ? "terminals"
          : "more";

  const openSessionMenu = () => setSheet({
    title: "会话操作",
    options: [
      { icon: Pencil, label: "重命名", message: "重命名入口" },
      { icon: Search, label: "搜索消息", message: "搜索入口" },
      { icon: Archive, label: "归档", message: "会话已归档" },
      { icon: Trash2, label: "删除", message: "Demo 不会删除数据" },
    ],
  });

  const headerConfig: HeaderConfig = (() => {
    switch (route) {
      case "chat":
        return {
          backLabel: "会话",
          title: session.title,
          subtitle: "Runtime 在线",
          action: { icon: Ellipsis, label: "会话菜单", onClick: openSessionMenu },
        };
      case "chats":
        return {
          title: "对话",
          subtitle: "4 个最近会话",
          action: {
            icon: MessageCirclePlus,
            label: "新建会话",
            onClick: () => {
              setMessagesBySession((current) => ({ ...current, new: [] }));
              navigate("chat", { sessionId: "new" });
            },
          },
        };
      case "runs":
        return {
          title: "工作",
          subtitle:
            workTab === "runs"
              ? (approval === "pending" ? "1 项需要处理" : "状态已同步")
              : workTab === "tasks"
                ? "2 个任务"
                : "3 个定时计划",
          action: {
            icon: workTab === "schedules" ? Plus : RefreshCw,
            label: workTab === "schedules" ? "新建定时任务" : "刷新",
            onClick: () => {
              if (workTab === "schedules") navigate("schedule-new");
              else showToast("状态已刷新");
            },
          },
        };
      case "schedule-new":
        return {
          backLabel: "定时",
          title: "新建定时任务",
          subtitle: "Runtime Scheduler",
        };
      case "run-detail":
        return {
          backLabel: "工作",
          title: "发布前回归检查",
          subtitle: runStopped ? "已停止" : "运行中",
          action: { icon: Ellipsis, label: "运行菜单", onClick: () => showToast("运行菜单") },
        };
      case "approval":
        return {
          backLabel: "工作",
          title: "操作审批",
          subtitle: approval === "pending" ? "4 分钟后过期" : "已处理",
        };
      case "terminals":
        return {
          title: "终端",
          subtitle: "office-mac 在线",
          action: { icon: Plus, label: "新建终端", onClick: () => showToast("新终端已在 office-mac 创建") },
        };
      case "terminal":
        return {
          backLabel: "终端",
          title: "zion-next",
          subtitle: terminalTransport === "direct" ? "直连 · 38ms" : "中转 · 286ms",
          action: {
            icon: Ellipsis,
            label: "终端菜单",
            onClick: () => setSheet({
              title: "终端操作",
              options: [
                { icon: Search, label: "搜索输出", message: "终端搜索入口" },
                { icon: Copy, label: "复制最近输出", message: "已复制最近输出" },
                {
                  icon: Radio,
                  label: "WebRTC 直连",
                  message: "已切换为 WebRTC 直连",
                  selected: terminalTransport === "direct",
                  onSelect: () => setTerminalTransport("direct"),
                },
                {
                  icon: Server,
                  label: "Runtime 中转",
                  message: "已切换为 Runtime 中转",
                  selected: terminalTransport === "relay",
                  onSelect: () => setTerminalTransport("relay"),
                },
              ],
            }),
          },
        };
      case "devices":
        return {
          backLabel: "更多",
          title: "设备状态",
          subtitle: "2 个设备在线",
          action: { icon: RefreshCw, label: "刷新", onClick: () => showToast("状态已刷新") },
        };
      case "files":
        return {
          backLabel: "更多",
          title: "文件与变更",
          subtitle: "office-mac · zion-next",
          action: { icon: Search, label: "搜索文件", onClick: () => showToast("文件搜索入口") },
        };
      case "change-detail":
        return {
          backLabel: "变更",
          title: "代码变更",
          subtitle: changeAccepted ? "已接受" : "等待审阅",
        };
      case "file-detail":
        return {
          backLabel: "文件",
          title: "PRD-02-MOBILE-CONVERSATION.md",
          subtitle: "Markdown · 18 KB",
        };
      case "skills":
        return {
          backLabel: "更多",
          title: "Skills",
          subtitle: "24 个可用",
        };
      case "plugins":
        return {
          backLabel: "更多",
          title: "插件",
          subtitle: "18 个已启用",
        };
      case "models":
        return {
          backLabel: "更多",
          title: "模型",
          subtitle: selectedModel,
        };
      case "knowledge":
        return {
          backLabel: "更多",
          title: "Identity 与 Memory",
          subtitle: "Runtime 已同步",
        };
      case "comments":
        return {
          backLabel: "更多",
          title: "评论",
          subtitle: "1 个待回复",
        };
      case "settings":
        return {
          backLabel: "更多",
          title: "设置",
          subtitle: "Mobile Client",
        };
      default:
        return { title: "更多", subtitle: "能力与设置" };
    }
  })();

  const screen = (() => {
    switch (route) {
      case "chat":
        return (
          <ChatScreen
            messages={messages}
            sending={sending}
            isNew={currentSessionId === "new"}
            expandedTools={expandedTools}
            onToggleTool={(id) => {
              setExpandedTools((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onOpenChanges={() => navigate("change-detail")}
          />
        );
      case "schedule-new":
        return (
          <ScheduleEditorScreen
            onSave={(title) => {
              setWorkTab("schedules");
              goBack();
              showToast(`已保存：${title}`);
            }}
          />
        );
      case "chats":
        return (
          <ChatsScreen
            query={sessionQuery}
            onQuery={setSessionQuery}
            onOpen={(sessionId) => navigate("chat", { sessionId })}
          />
        );
      case "runs":
        return (
          <WorkScreen
            tab={workTab}
            approval={approval}
            runStopped={runStopped}
            completedTodos={completedTodos}
            schedules={schedules}
            onTabChange={setWorkTab}
            onOpenApproval={() => navigate("approval")}
            onOpenRun={() => navigate("run-detail")}
            onToggleTodo={(id) => {
              setCompletedTodos((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onContinueTask={() => {
              navigate("chat", { sessionId: "jianghe" });
              showToast("任务已继续到当前会话");
            }}
            onToggleSchedule={(id) => {
              setSchedules((current) => ({ ...current, [id]: current[id] === false }));
            }}
            onRunSchedule={(title) => showToast(`已立即运行：${title}`)}
            onToast={showToast}
          />
        );
      case "run-detail":
        return (
          <RunDetailScreen
            stopped={runStopped}
            onOpenSession={() => navigate("chat", { sessionId: "release" })}
            onStop={() => {
              setRunStopped(true);
              showToast("停止请求已发送");
            }}
          />
        );
      case "approval":
        return (
          <ApprovalScreen
            state={approval}
            onApprove={() => {
              setApproval("approved");
              showToast("已批准，本次操作继续执行");
            }}
            onReject={() => {
              setApproval("rejected");
              showToast("已拒绝本次操作");
            }}
          />
        );
      case "terminals":
        return (
          <TerminalsScreen
            transport={terminalTransport}
            onOpenTerminal={() => navigate("terminal")}
            onToast={showToast}
          />
        );
      case "terminal":
        return (
          <TerminalScreen
            lines={terminalLines}
            command={terminalCommand}
            onCommand={setTerminalCommand}
            onSubmit={runTerminalCommand}
            onKey={(key) => showToast(`${key} 已发送`)}
          />
        );
      case "devices":
        return <DevicesScreen transport={terminalTransport} onToast={showToast} />;
      case "files":
        return (
          <FilesScreen
            tab={filesTab}
            onTabChange={setFilesTab}
            onOpenFile={() => navigate("file-detail")}
            onOpenChange={() => navigate("change-detail")}
            onToast={showToast}
          />
        );
      case "change-detail":
        return (
          <ChangeDetailScreen
            accepted={changeAccepted}
            onAccept={() => {
              setChangeAccepted(true);
              showToast("变更已接受");
            }}
            onRevert={() => showToast("Revert 需要 Approval")}
          />
        );
      case "file-detail":
        return <FileDetailScreen onToast={showToast} />;
      case "skills":
        return (
          <SkillsScreen
            enabled={skillsEnabled}
            onToggle={(id) => setSkillsEnabled((current) => ({ ...current, [id]: current[id] === false }))}
            onRefresh={() => showToast("Skills 已重新扫描")}
          />
        );
      case "plugins":
        return (
          <PluginsScreen
            enabled={pluginsEnabled}
            onToggle={(id) => setPluginsEnabled((current) => ({ ...current, [id]: current[id] === false }))}
            onReload={() => showToast("插件状态已重新加载")}
          />
        );
      case "models":
        return (
          <ModelsScreen
            selected={selectedModel}
            thinkingEffort={thinkingEffort}
            onSelect={(model) => {
              setSelectedModel(model);
              showToast(`已切换到 ${model}`);
            }}
            onThinkingEffort={(effort) => {
              setThinkingEffort(effort);
              showToast(`思考强度已切换为${effort}`);
            }}
          />
        );
      case "knowledge":
        return <KnowledgeScreen onToast={showToast} />;
      case "comments":
        return <CommentsScreen onToast={showToast} />;
      case "settings":
        return (
          <SettingsScreen
            values={settingsValues}
            onToggle={(key) => setSettingsValues((current) => ({ ...current, [key]: current[key] === false }))}
          />
        );
      default:
        return <MoreScreen onNavigate={(next) => navigate(next)} selectedModel={selectedModel} />;
    }
  })();

  return (
    <div className="demo-stage">
      <section className="mobile-app" aria-label="Zion Mobile Client Demo">
        <AppHeader config={headerConfig} onBack={goBack} />
        <main className="app-content" ref={contentRef}>{screen}</main>
        {route === "chat" ? (
          <Composer
            value={draft}
            sending={sending}
            selectedModel={selectedModel}
            toolMode={toolMode}
            contextEnabled={contextEnabled}
            onChange={setDraft}
            onSend={sendMessage}
            onSelectModel={setSelectedModel}
            onSelectToolMode={setToolMode}
            onToggleContext={(id) => {
              setContextEnabled((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onOpenSheet={setSheet}
          />
        ) : null}
        {route !== "terminal" ? (
          <BottomNav
            active={activeNav}
            hasAlert={approval === "pending"}
            onNavigate={(nav) => {
              const routes: Record<NavKey, Route> = {
                chats: "chats",
                runs: "runs",
                terminals: "terminals",
                more: "more",
              };
              navigate(routes[nav], { push: false });
            }}
          />
        ) : null}
        <BottomSheet
          sheet={sheet}
          onClose={() => setSheet(null)}
          onSelect={(option) => {
            option.onSelect?.();
            setSheet(null);
            showToast(option.message);
          }}
        />
        <div className={`toast ${toast ? "is-visible" : ""}`} role="status" aria-live="polite">
          {toast}
        </div>
      </section>
    </div>
  );
}
