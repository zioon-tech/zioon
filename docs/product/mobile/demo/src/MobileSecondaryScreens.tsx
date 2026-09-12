import {
  Bell,
  Bot,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  Copy,
  FileCode2,
  FileText,
  FolderGit2,
  Gauge,
  History,
  Laptop,
  Mail,
  MemoryStick,
  MessageCircle,
  Pause,
  Play,
  Plug,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserRound,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

export type WorkTab = "runs" | "tasks" | "schedules";

export function SegmentedTabs<T extends string>({
  value,
  items,
  onChange,
}: {
  value: T;
  items: Array<{ value: T; label: string; badge?: number }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented-tabs" role="tablist">
      {items.map((item) => (
        <button
          type="button"
          role="tab"
          aria-selected={value === item.value}
          className={value === item.value ? "is-active" : ""}
          key={item.value}
          onClick={() => onChange(item.value)}
        >
          {item.label}
          {item.badge ? <span className="segment-badge">{item.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <span className="progress" aria-label={`进度 ${value}%`}>
      <span style={{ width: `${value}%` }} />
    </span>
  );
}

function MiniBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "blue" | "green" | "amber" | "red";
}) {
  return <span className={`badge ${tone === "neutral" ? "" : tone}`}>{children}</span>;
}

function EmptyIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="row-icon">
      <Icon size={19} aria-hidden="true" />
    </span>
  );
}

export function TasksPanel({
  completed,
  onToggleTodo,
  onContinue,
}: {
  completed: Set<string>;
  onToggleTodo: (id: string) => void;
  onContinue: () => void;
}) {
  const todos = [
    { id: "audit", label: "盘点 Workbench 移动能力" },
    { id: "prototype", label: "完善 React 交互原型" },
    { id: "api", label: "定义 Mobile Runtime API" },
  ];
  const done = todos.filter((todo) => completed.has(todo.id)).length;
  return (
    <div className="work-tab-panel">
      <div className="work-overview">
        <div>
          <strong>Mobile Client 产品化</strong>
          <span>当前会话 · Agent Task</span>
        </div>
        <MiniBadge tone="blue">{done}/{todos.length}</MiniBadge>
      </div>
      <ProgressBar value={Math.round((done / todos.length) * 100)} />
      <div className="todo-list">
        {todos.map((todo) => {
          const checked = completed.has(todo.id);
          return (
            <button
              className={`todo-row ${checked ? "is-complete" : ""}`}
              type="button"
              key={todo.id}
              onClick={() => onToggleTodo(todo.id)}
            >
              {checked ? <CheckCircle2 size={19} /> : <Circle size={19} />}
              <span>{todo.label}</span>
            </button>
          );
        })}
      </div>
      <div className="inline-actions">
        <button className="button primary flex" type="button" onClick={onContinue}>
          <Play size={16} aria-hidden="true" /> 继续任务
        </button>
      </div>

      <p className="section-label">其他任务</p>
      <div className="list">
        <div className="list-row static-row">
          <span className="row-icon"><Bot size={19} /></span>
          <span className="row-main">
            <span className="row-title-line">
              <span className="row-title">终端延迟诊断</span>
              <MiniBadge tone="green">完成</MiniBadge>
            </span>
            <span className="row-preview">Agent · 5/5 项完成</span>
          </span>
          <span className="row-meta">昨天</span>
        </div>
      </div>
    </div>
  );
}

export function SchedulesPanel({
  enabled,
  onToggle,
  onRunNow,
}: {
  enabled: Record<string, boolean>;
  onToggle: (id: string) => void;
  onRunNow: (title: string) => void;
}) {
  const tasks = [
    {
      id: "daily-summary",
      title: "每日项目摘要",
      schedule: "每天 09:00",
      next: "明天 09:00",
      mode: "Agent",
    },
    {
      id: "runtime-health",
      title: "Runtime 健康检查",
      schedule: "每 30 分钟",
      next: "22 分钟后",
      mode: "命令",
    },
    {
      id: "weekly-review",
      title: "每周会话回顾",
      schedule: "周五 18:30",
      next: "5 天后",
      mode: "Agent",
    },
  ];

  return (
    <div className="work-tab-panel">
      <div className="list">
        {tasks.map((task) => {
          const isEnabled = enabled[task.id] !== false;
          return (
            <div className="schedule-row" key={task.id}>
              <div className="schedule-main">
                <div className="row-title-line">
                  <span className="row-title">{task.title}</span>
                  <MiniBadge tone={task.mode === "Agent" ? "blue" : "neutral"}>{task.mode}</MiniBadge>
                </div>
                <div className="row-preview">{task.schedule} · {isEnabled ? task.next : "已暂停"}</div>
              </div>
              <div className="schedule-actions">
                <button
                  className="compact-action"
                  type="button"
                  aria-label={`立即运行 ${task.title}`}
                  title="立即运行"
                  onClick={() => onRunNow(task.title)}
                >
                  <Play size={17} />
                </button>
                <button
                  className={`switch ${isEnabled ? "is-on" : ""}`}
                  type="button"
                  role="switch"
                  aria-checked={isEnabled}
                  aria-label={`${isEnabled ? "暂停" : "启用"} ${task.title}`}
                  onClick={() => onToggle(task.id)}
                >
                  <span />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="screen-note">定时任务由 Runtime 执行，关闭手机页面不会中断。</p>
    </div>
  );
}

export function ScheduleEditorScreen({ onSave }: { onSave: (title: string) => void }) {
  const [title, setTitle] = useState("每日项目摘要");
  const [taskType, setTaskType] = useState<"agent" | "command">("agent");
  const [schedule, setSchedule] = useState<"daily" | "weekdays" | "interval">("daily");
  const [time, setTime] = useState("09:00");
  const [interval, setInterval] = useState("60");
  const [permission, setPermission] = useState("read-only");
  const [enabled, setEnabled] = useState(true);

  return (
    <form
      className="screen mobile-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(title.trim() || "未命名任务");
      }}
    >
      <label>
        <span>名称</span>
        <input value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <fieldset>
        <legend>任务类型</legend>
        <div className="choice-row">
          <button
            type="button"
            className={taskType === "agent" ? "is-active" : ""}
            onClick={() => setTaskType("agent")}
          >
            Agent
          </button>
          <button
            type="button"
            className={taskType === "command" ? "is-active" : ""}
            onClick={() => setTaskType("command")}
          >
            命令
          </button>
        </div>
      </fieldset>
      <label>
        <span>{taskType === "agent" ? "任务提示词" : "命令"}</span>
        <textarea
          rows={5}
          defaultValue={taskType === "agent" ? "汇总 zion-next 最近一天的变更、失败 Run 和待办。" : "npm run runtime:test"}
        />
      </label>
      <fieldset>
        <legend>运行方式</legend>
        <div className="choice-row three">
          {[
            ["daily", "每天"],
            ["weekdays", "工作日"],
            ["interval", "固定间隔"],
          ].map(([value, label]) => (
            <button
              type="button"
              className={schedule === value ? "is-active" : ""}
              key={value}
              onClick={() => setSchedule(value as typeof schedule)}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>
      <label>
        <span>{schedule === "interval" ? "间隔（分钟）" : "运行时间"}</span>
        <input
          type={schedule === "interval" ? "number" : "time"}
          min={schedule === "interval" ? 1 : undefined}
          value={schedule === "interval" ? interval : time}
          onChange={(event) => {
            if (schedule === "interval") setInterval(event.target.value);
            else setTime(event.target.value);
          }}
        />
      </label>
      <label>
        <span>权限</span>
        <select value={permission} onChange={(event) => setPermission(event.target.value)}>
          <option value="read-only">只读</option>
          <option value="workspace-write">工作区写入</option>
          <option value="trusted-automation">受信自动化</option>
        </select>
      </label>
      <div className="form-switch-row">
        <div>
          <strong>创建后启用</strong>
          <span>任务由 Runtime 调度执行</span>
        </div>
        <button
          className={`switch ${enabled ? "is-on" : ""}`}
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="创建后启用"
          onClick={() => setEnabled((value) => !value)}
        >
          <span />
        </button>
      </div>
      <div className="form-footer">
        <button className="button primary flex" type="submit"><Check size={17} />保存定时任务</button>
      </div>
    </form>
  );
}

export function SkillsScreen({
  enabled,
  onToggle,
  onRefresh,
}: {
  enabled: Record<string, boolean>;
  onToggle: (id: string) => void;
  onRefresh: () => void;
}) {
  const [query, setQuery] = useState("");
  const skills = [
    { id: "browseruse", name: "TRAE-browseruse", source: "内置", detail: "网页浏览、交互与 UI 验证" },
    { id: "review", name: "bits-code-guard", source: "全局", detail: "代码审查与缺陷检查" },
    { id: "docs", name: "lark-doc", source: "全局", detail: "飞书文档读取与编辑" },
    { id: "calendar", name: "lark-calendar", source: "全局", detail: "日程、会议室与忙闲管理" },
  ].filter((skill) => `${skill.name} ${skill.detail}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <section className="screen">
      <div className="status-strip">
        <span><CheckCircle2 size={16} /> 24 个已发现</span>
        <button type="button" onClick={onRefresh}><RefreshCw size={15} />重新扫描</button>
      </div>
      <div className="search-wrap">
        <label className="search-box">
          <Sparkles size={18} />
          <span className="sr-only">搜索 Skills</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Skills" />
        </label>
      </div>
      <div className="list">
        {skills.map((skill) => {
          const isEnabled = enabled[skill.id] !== false;
          return (
            <div className="manage-row" key={skill.id}>
              <EmptyIcon icon={Sparkles} />
              <div className="row-main">
                <div className="row-title-line">
                  <span className="row-title">{skill.name}</span>
                  <MiniBadge>{skill.source}</MiniBadge>
                </div>
                <span className="row-preview">{skill.detail}</span>
              </div>
              <button
                className={`switch ${isEnabled ? "is-on" : ""}`}
                type="button"
                role="switch"
                aria-checked={isEnabled}
                aria-label={`${isEnabled ? "停用" : "启用"} ${skill.name}`}
                onClick={() => onToggle(skill.id)}
              >
                <span />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function PluginsScreen({
  enabled,
  onToggle,
  onReload,
}: {
  enabled: Record<string, boolean>;
  onToggle: (id: string) => void;
  onReload: () => void;
}) {
  const plugins = [
    { id: "sessions", name: "Session Manager", scope: "移动可用", tone: "green" as const, detail: "会话目录与同步" },
    { id: "tools", name: "Tools", scope: "移动可用", tone: "green" as const, detail: "Context、Files 与 Changes" },
    { id: "identity", name: "Identity", scope: "Runtime", tone: "blue" as const, detail: "Biography 与项目状态" },
    { id: "toc", name: "Table of Contents", scope: "仅桌面", tone: "neutral" as const, detail: "编辑器文档目录" },
  ];
  return (
    <section className="screen">
      <div className="status-strip">
        <span><Plug size={16} /> 18 个已启用</span>
        <button type="button" onClick={onReload}><RefreshCw size={15} />重新加载</button>
      </div>
      <div className="list">
        {plugins.map((plugin) => {
          const isEnabled = enabled[plugin.id] !== false;
          const desktopOnly = plugin.scope === "仅桌面";
          return (
            <div className="manage-row" key={plugin.id}>
              <EmptyIcon icon={Plug} />
              <div className="row-main">
                <div className="row-title-line">
                  <span className="row-title">{plugin.name}</span>
                  <MiniBadge tone={plugin.tone}>{plugin.scope}</MiniBadge>
                </div>
                <span className="row-preview">{plugin.detail}</span>
              </div>
              <button
                className={`switch ${isEnabled ? "is-on" : ""}`}
                type="button"
                role="switch"
                disabled={desktopOnly}
                aria-checked={isEnabled}
                aria-label={`${isEnabled ? "停用" : "启用"} ${plugin.name}`}
                onClick={() => onToggle(plugin.id)}
              >
                <span />
              </button>
            </div>
          );
        })}
      </div>
      <p className="screen-note">“仅桌面”插件不会加载到 Mobile Client bundle。</p>
    </section>
  );
}

export function ModelsScreen({
  selected,
  thinkingEffort,
  onSelect,
  onThinkingEffort,
}: {
  selected: string;
  thinkingEffort: string;
  onSelect: (model: string) => void;
  onThinkingEffort: (effort: string) => void;
}) {
  const models = [
    { id: "DeepSeek V4 Flash", provider: "DeepSeek", context: "128K", input: "图文", state: "在线" },
    { id: "Claude Sonnet", provider: "Anthropic", context: "200K", input: "图文", state: "在线" },
    { id: "GPT-5", provider: "OpenAI", context: "400K", input: "图文", state: "在线" },
  ];
  return (
    <section className="screen">
      <div className="detail-section">
        <h2>当前交互 Profile</h2>
        <p>interactive.default · 可修改 · 37 个工具</p>
      </div>
      <p className="section-label">可用模型</p>
      <div className="list">
        {models.map((model) => {
          const active = selected === model.id;
          return (
            <button className="model-row" type="button" key={model.id} onClick={() => onSelect(model.id)}>
              <span className={`model-radio ${active ? "is-active" : ""}`}>
                {active ? <Check size={14} /> : null}
              </span>
              <span className="row-main">
                <span className="row-title-line">
                  <span className="row-title">{model.id}</span>
                  <MiniBadge tone="green">{model.state}</MiniBadge>
                </span>
                <span className="row-preview">{model.provider} · {model.context} · {model.input}</span>
              </span>
              <ChevronRight size={17} />
            </button>
          );
        })}
      </div>
      <div className="detail-section">
        <h2>思考强度</h2>
        <div className="choice-row">
          {["低", "中", "高"].map((value) => (
            <button
              type="button"
              className={value === thinkingEffort ? "is-active" : ""}
              key={value}
              onClick={() => onThinkingEffort(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

export function KnowledgeScreen({ onToast }: { onToast: (message: string) => void }) {
  const [tab, setTab] = useState<"identity" | "memory">("identity");
  return (
    <section className="screen">
      <SegmentedTabs
        value={tab}
        items={[
          { value: "identity", label: "Identity" },
          { value: "memory", label: "Memory" },
        ]}
        onChange={setTab}
      />
      {tab === "identity" ? (
        <>
          <div className="profile-summary">
            <span className="profile-avatar"><UserRound size={23} /></span>
            <div>
              <strong>用户与 Agent 身份</strong>
              <span>最后提炼于 8 分钟前</span>
            </div>
          </div>
          <p className="section-label">工作项目</p>
          <div className="list">
            <button className="list-row" type="button" onClick={() => onToast("已打开 zion-next 项目状态")}>
              <EmptyIcon icon={FolderGit2} />
              <span className="row-main">
                <span className="row-title-line"><span className="row-title">zion-next</span><MiniBadge tone="blue">进行中</MiniBadge></span>
                <span className="row-preview">移动端产品化 · 3 个待办</span>
              </span>
              <ChevronRight size={17} />
            </button>
          </div>
          <p className="section-label">最近事件</p>
          <div className="timeline-list">
            <div><span className="timeline-dot" /><strong>决策</strong><p>Mobile Client 使用独立 React 前端。</p><time>刚刚</time></div>
            <div><span className="timeline-dot" /><strong>里程碑</strong><p>远程终端已支持 WebRTC 直连。</p><time>昨天</time></div>
          </div>
        </>
      ) : (
        <>
          <div className="status-strip">
            <span><MemoryStick size={16} /> 18 条长期记忆</span>
            <button type="button" onClick={() => onToast("已新建一条 Memory")}>新建</button>
          </div>
          <div className="list">
            {[
              ["部署偏好", "优先使用公网 Relay 或 VPS 托管 Runtime", "project"],
              ["终端体验", "PTY 优先 WebRTC DataChannel 直连", "long-term"],
              ["设备权限", "终端管理必须使用 Owner scope", "security"],
            ].map(([title, detail, tag]) => (
              <button className="list-row" type="button" key={title} onClick={() => onToast(`已打开 ${title}`)}>
                <EmptyIcon icon={MemoryStick} />
                <span className="row-main">
                  <span className="row-title-line"><span className="row-title">{title}</span><MiniBadge>{tag}</MiniBadge></span>
                  <span className="row-preview">{detail}</span>
                </span>
                <ChevronRight size={17} />
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function CommentsScreen({ onToast }: { onToast: (message: string) => void }) {
  const [resolved, setResolved] = useState(false);
  return (
    <section className="screen">
      <div className="list">
        <div className="comment-thread">
          <div className="comment-head">
            <span><MessageCircle size={17} /> Mobile Client API 边界</span>
            <MiniBadge tone={resolved ? "green" : "amber"}>{resolved ? "已解决" : "待回复"}</MiniBadge>
          </div>
          <blockquote>“Mobile Client 不得通过 setDoc 或 Yjs 文本插入发送消息。”</blockquote>
          <p>是否需要为离线草稿提供单独同步 API？</p>
          <div className="comment-actions">
            <button type="button" onClick={() => onToast("回复输入框已聚焦")}>回复</button>
            <button type="button" onClick={() => setResolved((value) => !value)}>
              {resolved ? "重新打开" : "标记解决"}
            </button>
          </div>
        </div>
        <div className="comment-thread">
          <div className="comment-head">
            <span><MessageCircle size={17} /> Approval 过期状态</span>
            <MiniBadge>2 条回复</MiniBadge>
          </div>
          <blockquote>“过期、已处理和跨端处理结果实时同步。”</blockquote>
          <p>建议同时保留处理设备和时间。</p>
          <div className="comment-actions">
            <button type="button" onClick={() => onToast("已打开评论线程")}>查看线程</button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function SettingsScreen({
  values,
  onToggle,
}: {
  values: Record<string, boolean>;
  onToggle: (key: string) => void;
}) {
  const settings = [
    { key: "notifications", icon: Bell, title: "运行完成通知", detail: "后台时通过 PWA 通知" },
    { key: "approval", icon: ShieldCheck, title: "审批提醒", detail: "高风险操作到达时提醒" },
    { key: "sound", icon: Gauge, title: "结束提示音", detail: "前台完成后播放提示音" },
    { key: "mail", icon: Mail, title: "邮件结果", detail: "定时任务完成后发送摘要" },
  ];
  return (
    <section className="screen">
      <p className="section-label">通知</p>
      <div className="list">
        {settings.map((item) => {
          const Icon = item.icon;
          const enabled = values[item.key] !== false;
          return (
            <div className="manage-row" key={item.key}>
              <EmptyIcon icon={Icon} />
              <div className="row-main">
                <span className="row-title">{item.title}</span>
                <span className="row-preview">{item.detail}</span>
              </div>
              <button
                className={`switch ${enabled ? "is-on" : ""}`}
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={`${enabled ? "关闭" : "开启"} ${item.title}`}
                onClick={() => onToggle(item.key)}
              >
                <span />
              </button>
            </div>
          );
        })}
      </div>
      <p className="section-label">关于</p>
      <div className="detail-section">
        <dl className="kv">
          <dt>Client</dt><dd>Mobile Web · React</dd>
          <dt>Runtime</dt><dd>protocol v5 · 已连接</dd>
          <dt>设备</dt><dd>client:phone-demo</dd>
          <dt>版本</dt><dd>0.1.0 prototype</dd>
        </dl>
      </div>
    </section>
  );
}

export function ChangeDetailScreen({
  accepted,
  onAccept,
  onRevert,
}: {
  accepted: boolean;
  onAccept: () => void;
  onRevert: () => void;
}) {
  return (
    <section className="screen">
      <div className="detail-section">
        <div className="row-title-line">
          <FileCode2 size={18} />
          <span className="row-title">MobileClientDemo.tsx</span>
          <MiniBadge tone={accepted ? "green" : "blue"}>{accepted ? "已接受" : "+42 -8"}</MiniBadge>
        </div>
        <p className="spaced-copy">docs/product/mobile/demo/src/MobileClientDemo.tsx</p>
      </div>
      <div className="diff-view" aria-label="代码变更预览">
        <div className="diff-line context"><span>118</span><code>function MobileClientDemo() {"{"}</code></div>
        <div className="diff-line removed"><span>119</span><code>- const mobileMode = useResponsive();</code></div>
        <div className="diff-line added"><span>119</span><code>+ const [route, setRoute] = useState("chat");</code></div>
        <div className="diff-line added"><span>120</span><code>+ const runtime = useRuntimeClient();</code></div>
        <div className="diff-line context"><span>121</span><code>  return &lt;MobileShell /&gt;;</code></div>
      </div>
      <div className="detail-section">
        <h2>影响</h2>
        <p>移动页面改用独立 React 状态和 Runtime Client，不加载 Desktop Workbench 布局。</p>
      </div>
      <div className="action-bar">
        <button className="button flex" type="button" disabled={accepted} onClick={onRevert}>
          <XCircle size={17} /> Revert
        </button>
        <button className="button primary flex" type="button" disabled={accepted} onClick={onAccept}>
          <Check size={17} /> {accepted ? "已接受" : "Accept"}
        </button>
      </div>
    </section>
  );
}

export function FileDetailScreen({ onToast }: { onToast: (message: string) => void }) {
  return (
    <section className="screen file-detail-screen">
      <div className="file-meta-bar">
        <span><FileText size={16} /> Markdown · 18 KB</span>
        <button type="button" onClick={() => onToast("文件内容已复制")}><Copy size={16} />复制</button>
      </div>
      <article className="file-preview">
        <h1>Zion 移动对话与会话</h1>
        <p>移动对话用于在手机上创建、观察和继续 Zion Session。</p>
        <h2>前端边界</h2>
        <ul>
          <li>独立 Session List、Message Timeline 与 Composer。</li>
          <li>不导入 EditorCore、CodeMirror 或桌面面板系统。</li>
          <li>通过 Runtime 的结构化 projection 和 command API 工作。</li>
        </ul>
        <h2>必需接口</h2>
        <pre><code>{`GET  /v1/sessions/:id/messages
POST /v1/sessions/:id/messages
GET  /v1/runs/:id/projection/stream`}</code></pre>
        <h2>移动验收</h2>
        <p>消息发送、停止、恢复和跨端同步必须在弱网与页面后台恢复后保持幂等。</p>
      </article>
    </section>
  );
}

export function WorkTabIcon({ tab }: { tab: WorkTab }) {
  if (tab === "tasks") return <Bot size={16} />;
  if (tab === "schedules") return <CalendarClock size={16} />;
  return <History size={16} />;
}

export function WorkStatusSummary({ tab }: { tab: WorkTab }) {
  const values = {
    runs: "1 项待处理 · 1 个运行中",
    tasks: "2 个任务 · 1 个进行中",
    schedules: "3 个计划 · 2 个已启用",
  };
  return <span className="work-status-summary"><Clock3 size={14} />{values[tab]}</span>;
}

export function CodeCapabilityBadge() {
  return (
    <span className="code-capability-badge">
      <Code2 size={14} /> Runtime-owned
    </span>
  );
}
