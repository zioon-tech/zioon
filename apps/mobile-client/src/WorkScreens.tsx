import { accountCan } from "../../../packages/account-ui/src/client";
import {
  Activity,
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleAlert,
  History,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  abortRun,
  createSchedulerTask,
  deleteSchedulerTask,
  getRun,
  getRunEvents,
  getSchedulerRun,
  getSchedulerTask,
  listModels,
  listSchedulerRuns,
  listSchedulerTasks,
  listSessionSummaries,
  listTodoLists,
  runSchedulerTask,
  updateSchedulerTask,
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
  ActiveRun,
  RunEvent,
  RunRecord,
  RuntimeModelProfile,
  SchedulerTask,
  SchedulerRun,
  TodoItem,
} from "./types";

type WorkTab = "overview" | "runs" | "tasks" | "schedules";

function runTone(status: string): "blue" | "green" | "red" | "amber" | "neutral" {
  if (status === "running" || status === "queued" || status === "retrying") return "blue";
  if (status === "completed" || status === "success") return "green";
  if (status === "failed" || status === "interrupted" || status === "timed_out") return "red";
  if (status === "aborted") return "amber";
  return "neutral";
}

function runStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: "排队中",
    running: "运行中",
    retrying: "重试中",
    completed: "已完成",
    success: "成功",
    failed: "失败",
    timed_out: "超时",
    cancelled: "已取消",
    aborted: "已停止",
    interrupted: "已中断",
  };
  return labels[status] || status;
}

function formatDateTime(value?: number): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatCount(value?: number): string {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function runDuration(run: SchedulerRun): string {
  if (!run.startedAt) return "—";
  const end = run.completedAt || Date.now();
  return formatDurationMs(end - run.startedAt);
}

function formatDurationMs(duration: number): string {
  const seconds = Math.max(0, Math.round(duration / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const minuteRemainder = minutes % 60;
    return minuteRemainder ? `${hours} 小时 ${minuteRemainder} 分` : `${hours} 小时`;
  }
  return remaining ? `${minutes} 分 ${remaining} 秒` : `${minutes} 分`;
}

function runTriggerLabel(trigger?: string): string {
  if (trigger === "manual") return "手动运行";
  if (trigger === "schedule") return "按计划运行";
  return trigger || "运行";
}

function schedulerEventLabel(event: NonNullable<SchedulerRun["events"]>[number]): {
  title: string;
  detail: string;
  tone: "green" | "blue" | "red" | "amber" | "neutral";
} {
  const type = String(event.type || "event");
  const data = event.data || {};
  const content = typeof data.content === "string" ? data.content : "";
  const error = typeof data.error === "string" ? data.error : "";
  if (type.includes("error") || error) {
    return { title: "异常", detail: error || type, tone: "red" };
  }
  if (type.includes("tool")) {
    const name = String(data.name || data.toolName || data.tool || "工具调用");
    return { title: name, detail: content || type, tone: "blue" };
  }
  if (type.includes("message")) {
    return { title: "模型输出", detail: content || type, tone: "green" };
  }
  if (type.includes("run") || type.includes("task")) {
    return { title: runStatusLabel(String(data.status || type)), detail: type, tone: "neutral" };
  }
  return { title: type, detail: content || JSON.stringify(data).slice(0, 160), tone: "neutral" };
}

function eventTime(event: NonNullable<SchedulerRun["events"]>[number]): string {
  return formatDateTime(event.timestamp || event.ts);
}

function runtimeEventLabel(event: RunEvent): {
  title: string;
  detail: string;
  tone: "green" | "blue" | "red" | "amber" | "neutral";
} {
  const type = String(event.type || "event");
  const data = event.data || {};
  const content = typeof data.content === "string" ? data.content : "";
  const error = typeof data.error === "string" ? data.error : "";
  if (type.includes("error") || error) {
    return { title: "异常", detail: error || type, tone: "red" };
  }
  if (type.includes("tool")) {
    const name = String(data.name || data.toolName || data.tool || "工具调用");
    return { title: name, detail: content || type, tone: "blue" };
  }
  if (type.includes("message") || type.includes("assistant")) {
    return { title: "模型输出", detail: content || type, tone: "green" };
  }
  if (type.includes("run")) {
    return { title: runStatusLabel(String(data.status || type)), detail: type, tone: "neutral" };
  }
  return { title: type, detail: content || JSON.stringify(data).slice(0, 160), tone: "neutral" };
}

function runtimeEventTime(event: RunEvent): string {
  return formatDateTime(event.timestamp);
}

function schedulerRunOutput(run: SchedulerRun): string {
  const finalMessage = [...(run.events || [])]
    .reverse()
    .find((event) => event.type === "message.completed");
  const content = finalMessage?.data?.content;
  return typeof content === "string" && content.trim()
    ? content
    : run.output || "";
}

function ActiveRuns({
  sessions,
  activeRuns,
}: {
  sessions: Array<{ id: string; title: string; updatedAt: number }>;
  activeRuns: Array<ActiveRun | null | undefined>;
}) {
  const navigate = useNavigate();
  const rows = sessions.flatMap((session, index) => {
    const run = activeRuns[index];
    return run ? [{ session, run }] : [];
  });
  if (!rows.length) {
    return (
      <EmptyState
        icon={CheckCircle2}
        title="当前没有运行中的任务"
        description="从对话发送消息或立即运行定时任务后，会出现在这里。"
      />
    );
  }
  return (
    <>
      <SectionLabel>正在运行</SectionLabel>
      <div className="list work-list">
        {rows.map(({ session, run }) => (
          <button
            className="work-row"
            type="button"
            key={run.runId}
            onClick={() => navigate(`/run/${encodeURIComponent(run.runId)}`)}
          >
            <span className="row-icon blue"><Activity size={19} /></span>
            <span className="row-main">
              <span className="row-title-line">
                <span className="row-title">{session.title || "未命名会话"}</span>
                <Badge tone="blue">{runStatusLabel(run.status)}</Badge>
              </span>
              <span className="row-preview">Run {run.runId.slice(-8)}</span>
            </span>
            <ChevronRight size={17} />
          </button>
        ))}
      </div>
    </>
  );
}

function RunsTab() {
  const sessions = useQuery({
    queryKey: ["session-summaries"],
    queryFn: () => listSessionSummaries(100),
    refetchInterval: 10_000,
  });
  if (sessions.isLoading) return <LoadingState label="正在读取 Run" />;
  if (sessions.isError) return <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />;
  return (
    <ActiveRuns
      sessions={(sessions.data || []).map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))}
      activeRuns={(sessions.data || []).map((session) => session.activeRun)}
    />
  );
}

function todoProgress(todos: TodoItem[]): { done: number; total: number } {
  return {
    done: todos.filter((todo) => todo.status === "completed").length,
    total: todos.length,
  };
}

function TasksTab() {
  const navigate = useNavigate();
  const todos = useQuery({
    queryKey: ["todo-lists"],
    queryFn: listTodoLists,
    refetchInterval: 8_000,
  });
  if (todos.isLoading) return <LoadingState label="正在读取任务" />;
  if (todos.isError) return <ErrorState error={todos.error} onRetry={() => void todos.refetch()} />;
  if (!todos.data?.length) {
    return (
      <EmptyState
        icon={Bot}
        title="还没有结构化任务"
        description="Agent 调用 todoWrite 后，任务进度会在这里跨端同步。"
      />
    );
  }
  return (
    <>
      <SectionLabel>Agent 与 Todo</SectionLabel>
      <div className="list work-list">
        {todos.data.map((list) => {
          const progress = todoProgress(list.todos);
          return (
            <button
              className="task-card"
              type="button"
              key={list.ownerId}
              onClick={() => {
                if (list.sessionId) navigate(`/chat/${encodeURIComponent(list.sessionId)}`);
              }}
            >
              <div className="task-card-head">
                <span>
                  <Bot size={18} />
                  <strong>{list.taskId || list.sessionId || "Agent Task"}</strong>
                </span>
                <Badge tone={progress.done === progress.total ? "green" : "blue"}>
                  {progress.done}/{progress.total}
                </Badge>
              </div>
              <div className="progress"><span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
              <div className="todo-preview">
                {list.todos.slice(0, 4).map((todo) => (
                  <span className={todo.status === "completed" ? "is-done" : ""} key={todo.id || todo.content}>
                    {todo.status === "completed" ? <CheckCircle2 size={15} /> : <Circle size={15} />}
                    {todo.content}
                  </span>
                ))}
              </div>
              <small>更新于 {formatRelativeTime(list.updatedAt)}</small>
            </button>
          );
        })}
      </div>
    </>
  );
}

function scheduleLabel(task: SchedulerTask): string {
  if (task.schedule.kind === "daily") return `每天 ${task.schedule.time || "09:00"}`;
  if (task.schedule.kind === "weekdays") return `工作日 ${task.schedule.time || "09:00"}`;
  if (task.schedule.kind === "interval") return `每 ${task.schedule.intervalMinutes || 60} 分钟`;
  if (task.schedule.kind === "once") {
    return task.schedule.timestamp
      ? new Date(task.schedule.timestamp).toLocaleString()
      : "单次";
  }
  return task.schedule.kind;
}

function schedulerModelLabel(
  task: SchedulerTask,
  profiles: RuntimeModelProfile[] = [],
): string {
  if (task.taskType === "command") return "";
  if (!task.modelProfileId) return "继承默认模型";
  return profiles.find((profile) => profile.id === task.modelProfileId)?.label
    || task.modelProfileId;
}

function localDateTimeValue(timestamp: number): string {
  const value = new Date(timestamp);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

type SchedulerDraft = {
  title?: string;
  taskType?: "agent" | "command";
  instruction?: string;
  kind?: "daily" | "weekdays" | "interval" | "once";
  time?: string;
  onceAt?: string;
  intervalMinutes?: string;
  preset?: "read-only" | "workspace-write" | "trusted-automation";
  modelProfileId?: string;
};

const SCHEDULER_DRAFT_KEY = "zion.mobile.scheduler-draft.v1";

function readSchedulerDraft(): SchedulerDraft {
  try {
    const value = JSON.parse(localStorage.getItem(SCHEDULER_DRAFT_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function SchedulesTab() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tasks = useQuery({
    queryKey: ["scheduler-tasks"],
    queryFn: listSchedulerTasks,
    refetchInterval: 10_000,
  });
  const models = useQuery({
    queryKey: ["models"],
    queryFn: listModels,
    staleTime: 60_000,
  });
  const runs = useQuery({
    queryKey: ["scheduler-runs"],
    queryFn: () => listSchedulerRuns(),
    refetchInterval: 10_000,
  });
  const runNow = useMutation({
    mutationFn: runSchedulerTask,
    onSuccess(run) {
      void queryClient.invalidateQueries({ queryKey: ["scheduler-runs"] });
      navigate(
        `/scheduler/${encodeURIComponent(run.taskId)}/runs/${encodeURIComponent(run.id)}`,
      );
    },
  });

  if (tasks.isLoading) return <LoadingState label="正在读取定时任务" />;
  if (tasks.isError) return <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />;
  if (!tasks.data?.length) {
    return (
      <EmptyState
        icon={CalendarClock}
        title="还没有定时任务"
        description="创建自动化后，即使离开页面也会按计划执行。"
        action={accountCan("runtime.manage") &&
          <button className="button primary" type="button" onClick={() => navigate("/scheduler/new")}>
            <Plus size={17} />新建任务
          </button>
        }
      />
    );
  }
  return (
    <>
      <SectionLabel>计划</SectionLabel>
      <div className="list work-list">
        {tasks.data.map((task) => {
          const taskRuns = (runs.data || []).filter((run) => run.taskId === task.id);
          const latest = taskRuns[0];
          const failed = taskRuns.filter((run) =>
            ["failed", "timed_out", "interrupted"].includes(run.status)).length;
          return (
            <article className="schedule-row" key={task.id}>
              <button
                className="schedule-main"
                type="button"
                onClick={() => navigate(`/scheduler/${encodeURIComponent(task.id)}`)}
              >
                <span className={`row-icon ${task.enabled ? "blue" : ""}`}>
                  <CalendarClock size={19} />
                </span>
                <span className="row-main">
                  <span className="row-title-line">
                    <span className="row-title">{task.title || "未命名任务"}</span>
                    <Badge tone={task.enabled ? "blue" : "neutral"}>
                      {task.enabled ? "已启用" : "已暂停"}
                    </Badge>
                  </span>
                  <span className="row-preview">
                    {task.taskType === "command"
                      ? `命令 · ${scheduleLabel(task)}`
                      : `Agent · ${schedulerModelLabel(task, models.data?.profiles)} · ${scheduleLabel(task)}`}
                  </span>
                  <small className="row-foot">
                    {latest
                      ? `最近 ${runStatusLabel(latest.status)} · ${formatRelativeTime(latest.completedAt || latest.startedAt || latest.createdAt)}`
                      : "尚未运行"}
                    {taskRuns.length ? ` · ${taskRuns.length} 次` : ""}
                    {failed ? ` · ${failed} 次失败` : ""}
                  </small>
                </span>
                <ChevronRight size={17} />
              </button>
              <button
                className="schedule-quick-run"
                hidden={!accountCan("runtime.manage")}
                type="button"
                aria-label={`立即运行 ${task.title}`}
                disabled={runNow.isPending}
                onClick={() => runNow.mutate(task.id)}
              >
                <Play size={17} />
              </button>
            </article>
          );
        })}
      </div>
      {runNow.isError ? <div className="inline-error page-error">{runNow.error.message}</div> : null}
    </>
  );
}

function OverviewTab() {
  const navigate = useNavigate();
  const sessions = useQuery({
    queryKey: ["session-summaries"],
    queryFn: () => listSessionSummaries(100),
    refetchInterval: 10_000,
  });
  const tasks = useQuery({
    queryKey: ["scheduler-tasks"],
    queryFn: listSchedulerTasks,
    refetchInterval: 10_000,
  });
  const runs = useQuery({
    queryKey: ["scheduler-runs"],
    queryFn: () => listSchedulerRuns("", 40),
    refetchInterval: 10_000,
  });
  const todos = useQuery({
    queryKey: ["todo-lists"],
    queryFn: listTodoLists,
    refetchInterval: 10_000,
  });
  const loading = sessions.isLoading || tasks.isLoading || runs.isLoading || todos.isLoading;
  const error = sessions.error || tasks.error || runs.error || todos.error;
  const activeSessions = (sessions.data || []).filter((session) => session.activeRun);
  const failedRuns = (runs.data || []).filter((run) => isSchedulerRunFailure(run.status));
  const activeSchedulerRuns = (runs.data || []).filter((run) => isSchedulerRunActive(run.status));
  const enabledTasks = (tasks.data || []).filter((task) => task.enabled);
  const activeTodos = (todos.data || []).filter((list) =>
    list.todos.some((todo) => todo.status !== "completed")
  );

  if (loading) return <LoadingState label="正在汇总运行状态" />;
  if (error) {
    return (
      <ErrorState
        error={error}
        onRetry={() => {
          void sessions.refetch();
          void tasks.refetch();
          void runs.refetch();
          void todos.refetch();
        }}
      />
    );
  }

  return (
    <>
      <section className="work-command-center">
        <div className="work-metric-grid">
          <button type="button" onClick={() => navigate("/work?tab=runs")}>
            <strong>{activeSessions.length + activeSchedulerRuns.length}</strong>
            <span>运行中</span>
          </button>
          <button type="button" onClick={() => navigate("/work?tab=schedules")}>
            <strong>{enabledTasks.length}</strong>
            <span>自动化</span>
          </button>
          <button className={failedRuns.length ? "is-danger" : ""} type="button">
            <strong>{failedRuns.length}</strong>
            <span>异常</span>
          </button>
          <button type="button" onClick={() => navigate("/work?tab=tasks")}>
            <strong>{activeTodos.length}</strong>
            <span>待办</span>
          </button>
        </div>
      </section>

      <SectionLabel>正在运行</SectionLabel>
      {!activeSessions.length && !activeSchedulerRuns.length ? (
        <div className="work-empty-line">
          <CheckCircle2 size={16} />当前没有运行中的任务
        </div>
      ) : (
        <div className="list work-list">
          {activeSessions.slice(0, 4).map((session) => (
            <button
              className="work-row"
              type="button"
              key={session.activeRun?.runId || session.id}
              onClick={() => {
                if (session.activeRun?.runId) navigate(`/run/${encodeURIComponent(session.activeRun.runId)}`);
              }}
            >
              <span className="row-icon blue"><Activity size={19} /></span>
              <span className="row-main">
                <span className="row-title-line">
                  <span className="row-title">{session.title || "未命名会话"}</span>
                  <Badge tone="blue">{runStatusLabel(session.activeRun?.status || "running")}</Badge>
                </span>
                <span className="row-preview">会话 Run · {session.activeRun?.runId.slice(-8)}</span>
              </span>
              <ChevronRight size={17} />
            </button>
          ))}
          {activeSchedulerRuns.slice(0, 4).map((run) => (
            <button
              className="work-row"
              type="button"
              key={run.id}
              onClick={() => navigate(`/scheduler/${encodeURIComponent(run.taskId)}/runs/${encodeURIComponent(run.id)}`)}
            >
              <span className="row-icon blue"><CalendarClock size={19} /></span>
              <span className="row-main">
                <span className="row-title-line">
                  <span className="row-title">{run.task?.title || run.taskId}</span>
                  <Badge tone="blue">{runStatusLabel(run.status)}</Badge>
                </span>
                <span className="row-preview">{runTriggerLabel(run.trigger)} · {formatDateTime(run.startedAt || run.createdAt)}</span>
              </span>
              <ChevronRight size={17} />
            </button>
          ))}
        </div>
      )}

      <SectionLabel>需要关注</SectionLabel>
      {!failedRuns.length ? (
        <div className="work-empty-line">
          <CheckCircle2 size={16} />最近没有失败的自动化运行
        </div>
      ) : (
        <div className="list work-list">
          {failedRuns.slice(0, 6).map((run) => (
            <button
              className="work-alert-row"
              type="button"
              key={run.id}
              onClick={() => navigate(`/scheduler/${encodeURIComponent(run.taskId)}/runs/${encodeURIComponent(run.id)}`)}
            >
              <span className="row-icon red"><CircleAlert size={19} /></span>
              <span className="row-main">
                <span className="row-title-line">
                  <span className="row-title">{run.task?.title || run.taskId}</span>
                  <Badge tone="red">{runStatusLabel(run.status)}</Badge>
                </span>
                <span className="row-preview">{run.error || "打开运行日志查看失败位置"}</span>
              </span>
              <ChevronRight size={17} />
            </button>
          ))}
        </div>
      )}

      <SectionLabel>自动化</SectionLabel>
      {!enabledTasks.length ? (
        <div className="work-empty-line">
          <CalendarClock size={16} />没有启用的定时任务
        </div>
      ) : (
        <div className="list work-list">
          {enabledTasks.slice(0, 4).map((task) => (
            <button
              className="work-row"
              type="button"
              key={task.id}
              onClick={() => navigate(`/scheduler/${encodeURIComponent(task.id)}`)}
            >
              <span className="row-icon blue"><CalendarClock size={19} /></span>
              <span className="row-main">
                <span className="row-title">{task.title || "未命名任务"}</span>
                <span className="row-preview">
                  {scheduleLabel(task)}
                  {task.nextRun ? ` · 下次 ${formatDateTime(task.nextRun)}` : ""}
                </span>
              </span>
              <ChevronRight size={17} />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function WorkScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = (["overview", "runs", "tasks", "schedules"].includes(params.get("tab") || "")
    ? params.get("tab")
    : "overview") as WorkTab;
  return (
    <MobilePage
      title="工作"
      subtitle={tab === "overview" ? "运行中心" : tab === "runs" ? "当前运行" : tab === "tasks" ? "Agent 与 Todo" : "自动化"}
      className="work-page"
      action={tab === "schedules" && accountCan("runtime.manage") ? (
        <IconButton icon={Plus} label="新建定时任务" onClick={() => navigate("/scheduler/new")} />
      ) : (
        <IconButton
          icon={RefreshCw}
          label="刷新"
          onClick={() => {
            void Promise.all([
              queryClient.invalidateQueries({ queryKey: ["session-summaries"] }),
              queryClient.invalidateQueries({ queryKey: ["todo-lists"] }),
              queryClient.invalidateQueries({ queryKey: ["scheduler-tasks"] }),
              queryClient.invalidateQueries({ queryKey: ["scheduler-runs"] }),
            ]);
          }}
        />
      )}
    >
      <SegmentedControl
        value={tab}
        options={[
          { value: "overview", label: "概览" },
          { value: "schedules", label: "自动化" },
          { value: "tasks", label: "待办" },
          { value: "runs", label: "运行" },
        ]}
        onChange={(value) => setParams({ tab: value })}
      />
      {tab === "overview" ? <OverviewTab /> : null}
      {tab === "runs" ? <RunsTab /> : null}
      {tab === "tasks" ? <TasksTab /> : null}
      {tab === "schedules" ? <SchedulesTab /> : null}
    </MobilePage>
  );
}

type SchedulerRunFilter = "all" | "success" | "attention";

function isSchedulerRunActive(status: string): boolean {
  return ["queued", "running", "retrying"].includes(status);
}

function isSchedulerRunFailure(status: string): boolean {
  return ["failed", "timed_out", "interrupted", "cancelled", "aborted"].includes(status);
}

function SchedulerRunRow({
  run,
  taskId,
}: {
  run: SchedulerRun;
  taskId: string;
}) {
  const navigate = useNavigate();
  const active = isSchedulerRunActive(run.status);
  const success = ["success", "completed"].includes(run.status);
  return (
    <button
      className="scheduler-run-row"
      type="button"
      onClick={() => navigate(
        `/scheduler/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(run.id)}`,
      )}
    >
      <span className={`run-status-dot ${runTone(run.status)}`}>
        {active ? (
          <Activity size={18} />
        ) : success ? (
          <CheckCircle2 size={18} />
        ) : (
          <CircleAlert size={18} />
        )}
      </span>
      <span className="row-main">
        <span className="row-title-line">
          <span className="row-title">{runTriggerLabel(run.trigger)}</span>
          <Badge tone={runTone(run.status)}>{runStatusLabel(run.status)}</Badge>
        </span>
        <span className="row-preview">
          {formatDateTime(run.startedAt || run.createdAt)} · {runDuration(run)}
        </span>
      </span>
      <ChevronRight size={17} />
    </button>
  );
}

export function SchedulerTaskDetailScreen() {
  const { taskId = "" } = useParams();
  const decoded = decodeURIComponent(taskId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<SchedulerRunFilter>("all");
  const [instructionOpen, setInstructionOpen] = useState(false);
  const task = useQuery({
    queryKey: ["scheduler-task", decoded],
    queryFn: () => getSchedulerTask(decoded),
  });
  const models = useQuery({
    queryKey: ["models"],
    queryFn: listModels,
    staleTime: 60_000,
  });
  const runs = useQuery({
    queryKey: ["scheduler-runs", decoded],
    queryFn: () => listSchedulerRuns(decoded, 100),
    refetchInterval: (query) => {
      const value = query.state.data as SchedulerRun[] | undefined;
      return value?.some((run) => isSchedulerRunActive(run.status)) ? 2_000 : 10_000;
    },
  });
  const runNow = useMutation({
    mutationFn: () => runSchedulerTask(decoded),
    onSuccess(run) {
      void queryClient.invalidateQueries({ queryKey: ["scheduler-runs"] });
      navigate(`/scheduler/${encodeURIComponent(decoded)}/runs/${encodeURIComponent(run.id)}`);
    },
  });
  const toggle = useMutation({
    mutationFn: (value: SchedulerTask) =>
      updateSchedulerTask(value.id, { ...value, enabled: !value.enabled }),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ["scheduler-task", decoded] });
      void queryClient.invalidateQueries({ queryKey: ["scheduler-tasks"] });
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteSchedulerTask(decoded),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ["scheduler-tasks"] });
      navigate("/work?tab=schedules", { replace: true });
    },
  });

  if (task.isLoading || runs.isLoading) {
    return <MobilePage title="定时任务" back="自动化"><LoadingState /></MobilePage>;
  }
  if (task.isError || !task.data) {
    return (
      <MobilePage title="定时任务" back="自动化">
        <ErrorState error={task.error || "任务不存在"} onRetry={() => void task.refetch()} />
      </MobilePage>
    );
  }
  if (runs.isError) {
    return (
      <MobilePage title={task.data.title || "定时任务"} back="自动化">
        <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
      </MobilePage>
    );
  }

  const allRuns = runs.data || [];
  const successRuns = allRuns.filter((run) => ["success", "completed"].includes(run.status));
  const attentionRuns = allRuns.filter((run) => isSchedulerRunFailure(run.status));
  const finished = allRuns.filter((run) => run.startedAt && run.completedAt);
  const averageDuration = finished.length
    ? Math.round(finished.reduce((sum, run) =>
      sum + ((run.completedAt || 0) - (run.startedAt || 0)), 0) / finished.length)
    : 0;
  const visibleRuns = filter === "success"
    ? successRuns
    : filter === "attention"
      ? attentionRuns
      : allRuns;
  const taskRecord = task.data;
  const instruction = taskRecord.taskType === "command"
    ? taskRecord.command
    : taskRecord.prompt;
  const instructionCollapsible = Boolean(
    instruction
    && (instruction.length > 360 || instruction.split("\n").length > 8),
  );

  return (
    <MobilePage
      title={taskRecord.title || "定时任务"}
      subtitle={taskRecord.enabled ? "已启用" : "已暂停"}
      back="自动化"
      action={accountCan("runtime.manage") && (
        <IconButton
          icon={Play}
          label="立即运行"
          disabled={runNow.isPending}
          onClick={() => runNow.mutate()}
        />
      )}
    >
      <section className="scheduler-overview">
        <div className="scheduler-overview-head">
          <span className={`row-icon ${taskRecord.enabled ? "blue" : ""}`}>
            <CalendarClock size={20} />
          </span>
          <div>
            <strong>{scheduleLabel(taskRecord)}</strong>
            <span>
              {taskRecord.taskType === "command"
                ? "命令任务"
                : schedulerModelLabel(taskRecord, models.data?.profiles)}
              {" · "}
              {taskRecord.nextRun
                ? `下次 ${formatDateTime(taskRecord.nextRun)}`
                : taskRecord.enabled ? "等待下次排期" : "任务已暂停"}
            </span>
          </div>
          <Badge tone={taskRecord.enabled ? "blue" : "neutral"}>
            {taskRecord.enabled ? "已启用" : "已暂停"}
          </Badge>
        </div>
        <div className="scheduler-metrics">
          <div><strong>{allRuns.length}</strong><span>总运行</span></div>
          <div><strong>{successRuns.length}</strong><span>成功</span></div>
          <div className={attentionRuns.length ? "is-danger" : ""}>
            <strong>{attentionRuns.length}</strong><span>异常</span>
          </div>
          <div><strong>{averageDuration ? formatDurationMs(averageDuration) : "—"}</strong><span>平均耗时</span></div>
        </div>
      </section>

      {instruction ? (
        <section className="detail-section scheduler-instruction">
          <h2>{taskRecord.taskType === "command" ? "命令" : "任务目标"}</h2>
          <article
            className={`markdown-document scheduler-instruction-content${instructionCollapsible && !instructionOpen ? " is-collapsed" : ""}`}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{instruction}</ReactMarkdown>
          </article>
          {instructionCollapsible ? (
            <button
              className="scheduler-instruction-toggle"
              type="button"
              onClick={() => setInstructionOpen((value) => !value)}
            >
              {instructionOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {instructionOpen ? "收起目标" : "展开目标"}
            </button>
          ) : null}
        </section>
      ) : null}

      <SectionLabel>运行历史</SectionLabel>
      <SegmentedControl
        value={filter}
        options={[
          { value: "all", label: "全部", count: allRuns.length },
          { value: "success", label: "成功", count: successRuns.length },
          { value: "attention", label: "异常", count: attentionRuns.length },
        ]}
        onChange={setFilter}
      />
      {!visibleRuns.length ? (
        <EmptyState
          icon={History}
          title={allRuns.length ? "没有该状态的运行" : "还没有运行记录"}
          description={allRuns.length ? "切换筛选条件查看其他记录。" : "立即运行后，状态和结果会保存在这里。"}
        />
      ) : (
        <div className="list scheduler-run-list">
          {visibleRuns.map((run) => (
            <SchedulerRunRow run={run} taskId={decoded} key={run.id} />
          ))}
        </div>
      )}

      <div className="scheduler-actions" hidden={!accountCan("runtime.manage")}>
        <button
          className="button"
          type="button"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(taskRecord)}
        >
          {taskRecord.enabled ? <Pause size={17} /> : <Play size={17} />}
          {taskRecord.enabled ? "暂停任务" : "启用任务"}
        </button>
        <button
          className="button danger"
          type="button"
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`删除定时任务“${taskRecord.title || "未命名任务"}”及其配置？`)) {
              remove.mutate();
            }
          }}
        >
          <Trash2 size={17} />删除任务
        </button>
      </div>
      {runNow.isError ? <div className="inline-error page-error">{runNow.error.message}</div> : null}
      {toggle.isError ? <div className="inline-error page-error">{toggle.error.message}</div> : null}
      {remove.isError ? <div className="inline-error page-error">{remove.error.message}</div> : null}
    </MobilePage>
  );
}

export function SchedulerRunDetailScreen() {
  const { taskId = "", schedulerRunId = "" } = useParams();
  const decodedTaskId = decodeURIComponent(taskId);
  const decodedRunId = decodeURIComponent(schedulerRunId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const run = useQuery({
    queryKey: ["scheduler-run", decodedRunId],
    queryFn: () => getSchedulerRun(decodedRunId),
    refetchInterval: (query) => {
      const value = query.state.data as SchedulerRun | undefined;
      return value && isSchedulerRunActive(value.status) ? 2_000 : false;
    },
  });
  const rerun = useMutation({
    mutationFn: () => runSchedulerTask(decodedTaskId),
    onSuccess(nextRun) {
      void queryClient.invalidateQueries({ queryKey: ["scheduler-runs"] });
      navigate(
        `/scheduler/${encodeURIComponent(decodedTaskId)}/runs/${encodeURIComponent(nextRun.id)}`,
        { replace: true },
      );
    },
  });

  if (run.isLoading) {
    return <MobilePage title="运行记录" back="任务"><LoadingState /></MobilePage>;
  }
  if (run.isError || !run.data) {
    return (
      <MobilePage title="运行记录" back="任务">
        <ErrorState error={run.error || "运行记录不存在"} onRetry={() => void run.refetch()} />
      </MobilePage>
    );
  }

  const record = run.data;
  const active = isSchedulerRunActive(record.status);
  const success = ["success", "completed"].includes(record.status);
  const taskTitle = record.task?.title || "定时任务";
  const output = schedulerRunOutput(record);
  return (
    <MobilePage
      title={taskTitle}
      subtitle={`${runTriggerLabel(record.trigger)} · ${runStatusLabel(record.status)}`}
      back="任务"
    >
      <div className={`scheduler-run-hero is-${runTone(record.status)}`}>
        <span className={`run-status-dot ${runTone(record.status)}`}>
          {active ? <Activity size={22} /> : success ? <CheckCircle2 size={22} /> : <CircleAlert size={22} />}
        </span>
        <div>
          <strong>{runStatusLabel(record.status)}</strong>
          <span>{formatDateTime(record.startedAt || record.createdAt)} · {runDuration(record)}</span>
        </div>
      </div>

      {record.error ? (
        <section className="scheduler-error">
          <CircleAlert size={18} />
          <div><strong>运行失败</strong><p>{record.error}</p></div>
        </section>
      ) : null}

      {output ? (
        <section className="detail-section scheduler-output">
          <h2>运行结果</h2>
          <article className="markdown-document">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{output}</ReactMarkdown>
          </article>
        </section>
      ) : active ? (
        <LoadingState label="任务正在执行" />
      ) : (
        <EmptyState icon={History} title="本次运行没有输出" />
      )}

      <section className="detail-section">
        <h2>执行信息</h2>
        <dl className="kv">
          <dt>触发方式</dt><dd>{runTriggerLabel(record.trigger)}</dd>
          <dt>计划时间</dt><dd>{formatDateTime(record.scheduledFor)}</dd>
          <dt>开始时间</dt><dd>{formatDateTime(record.startedAt)}</dd>
          <dt>完成时间</dt><dd>{formatDateTime(record.completedAt)}</dd>
          <dt>运行耗时</dt><dd>{runDuration(record)}</dd>
          <dt>事件</dt><dd>{record.eventCount ?? record.events?.length ?? "—"}</dd>
          <dt>Run ID</dt><dd>{record.id}</dd>
        </dl>
      </section>

      {record.events?.length ? (
        <section className="detail-section">
          <h2>运行日志</h2>
          <div className="run-timeline">
            {record.events.map((event, index) => {
              const item = schedulerEventLabel(event);
              return (
                <article className={`run-timeline-item ${item.tone}`} key={event.eventId || `${event.type}:${index}`}>
                  <span className="run-timeline-dot" />
                  <div>
                    <strong>{item.title}</strong>
                    <small>{eventTime(event)}</small>
                    {item.detail ? <p>{item.detail}</p> : null}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {record.usage ? (
        <section className="detail-section">
          <h2>模型消耗</h2>
          <div className="usage-grid">
            <div><strong>{formatCount(record.usage.inputTokens)}</strong><span>输入</span></div>
            <div><strong>{formatCount(record.usage.outputTokens)}</strong><span>输出</span></div>
            <div><strong>{formatCount(record.usage.reasoningTokens)}</strong><span>思考</span></div>
            <div><strong>{formatCount(record.usage.cacheReadTokens)}</strong><span>缓存读取</span></div>
          </div>
        </section>
      ) : null}

      <div className="action-bar">
        {record.sessionId ? (
          <button
            className="button primary flex"
            type="button"
            onClick={() => navigate(`/chat/${encodeURIComponent(record.sessionId!)}`)}
          >
            <History size={17} />{active ? "查看实时会话" : "查看会话"}
          </button>
        ) : record.chatRunId ? (
          <button
            className="button flex"
            type="button"
            onClick={() => navigate(`/run/${encodeURIComponent(record.chatRunId!)}`)}
          >
            <History size={17} />查看旧 Run
          </button>
        ) : active ? (
          <button className="button flex" type="button" disabled>
            <Activity size={17} />正在准备会话
          </button>
        ) : null}
        <button
          className="button flex"
          type="button"
          disabled={rerun.isPending || active}
          hidden={!accountCan("runtime.manage")}
          onClick={() => rerun.mutate()}
        >
          <RotateCcw size={17} />再次运行
        </button>
      </div>
      {rerun.isError ? <div className="inline-error page-error">{rerun.error.message}</div> : null}
    </MobilePage>
  );
}

export function RunDetailScreen() {
  const { runId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const decoded = decodeURIComponent(runId);
  const run = useQuery({
    queryKey: ["run", decoded],
    queryFn: () => getRun(decoded),
    refetchInterval: (query) => {
      const value = query.state.data as RunRecord | undefined;
      return value && ["queued", "running"].includes(value.status) ? 2_000 : false;
    },
  });
  const events = useQuery({
    queryKey: ["run-events", decoded],
    queryFn: () => getRunEvents(decoded),
    enabled: Boolean(decoded),
    refetchInterval: () =>
      run.data && ["queued", "running"].includes(run.data.status) ? 2_000 : false,
  });
  const stop = useMutation({
    mutationFn: () => abortRun(decoded),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ["run", decoded] });
      void queryClient.invalidateQueries({ queryKey: ["run-events", decoded] });
    },
  });
  if (run.isLoading) {
    return <MobilePage title="Run" back="工作"><LoadingState /></MobilePage>;
  }
  if (run.isError || !run.data) {
    return (
      <MobilePage title="Run" back="工作">
        <ErrorState error={run.error || "Run 不存在"} onRetry={() => void run.refetch()} />
      </MobilePage>
    );
  }
  const record = run.data;
  const running = ["queued", "running"].includes(record.status);
  return (
    <MobilePage title={record.title || "Run 详情"} subtitle={runStatusLabel(record.status)} back="工作">
      <div className="run-hero">
        <span className={`row-icon ${running ? "blue" : runTone(record.status)}`}>
          {running ? <Activity size={20} /> : record.status === "completed" ? <CheckCircle2 size={20} /> : <CircleAlert size={20} />}
        </span>
        <div>
          <strong>{runStatusLabel(record.status)}</strong>
          <span>更新于 {formatRelativeTime(record.updatedAt)}</span>
        </div>
      </div>
      <section className="detail-section">
        <h2>执行信息</h2>
        <dl className="kv">
          <dt>Run ID</dt><dd>{record.id}</dd>
          <dt>Session</dt><dd>{record.sessionId || "—"}</dd>
          <dt>模型</dt><dd>{record.model?.label || record.model?.modelId || "Runtime 默认"}</dd>
          <dt>策略</dt><dd>{record.policy?.preset || "—"}</dd>
          <dt>工具上限</dt><dd>{record.policy?.maxToolCalls ?? "—"}</dd>
        </dl>
      </section>
      {record.output ? (
        <section className="detail-section">
          <h2>结果</h2>
          <article className="markdown-document">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{record.output}</ReactMarkdown>
          </article>
        </section>
      ) : null}
      {events.data?.length ? (
        <section className="detail-section">
          <h2>运行日志</h2>
          <div className="run-timeline">
            {events.data.map((event) => {
              const item = runtimeEventLabel(event);
              return (
                <article className={`run-timeline-item ${item.tone}`} key={event.eventId}>
                  <span className="run-timeline-dot" />
                  <div>
                    <strong>{item.title}</strong>
                    <small>{runtimeEventTime(event)}</small>
                    {item.detail ? <p>{item.detail}</p> : null}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : events.isError ? (
        <div className="inline-error page-error">
          {events.error instanceof Error ? events.error.message : "运行日志加载失败"}
        </div>
      ) : null}
      {record.usage ? (
        <section className="detail-section">
          <h2>Token</h2>
          <dl className="kv">
            <dt>输入</dt><dd>{formatCount(record.usage.inputTokens)}</dd>
            <dt>输出</dt><dd>{formatCount(record.usage.outputTokens)}</dd>
            <dt>思考</dt><dd>{formatCount(record.usage.reasoningTokens)}</dd>
            <dt>缓存读取</dt><dd>{formatCount(record.usage.cacheReadTokens)}</dd>
          </dl>
        </section>
      ) : null}
      {record.error ? <div className="inline-error page-error">{record.error}</div> : null}
      <div className="action-bar">
        {record.sessionId ? (
          <button className="button flex" type="button" onClick={() => navigate(`/chat/${encodeURIComponent(record.sessionId!)}`)}>
            返回会话
          </button>
        ) : null}
        <button
          className="button danger flex"
          type="button"
          disabled={!running || stop.isPending}
          hidden={!accountCan("run.execute")}
          onClick={() => stop.mutate()}
        >
          <Square size={15} />停止
        </button>
      </div>
    </MobilePage>
  );
}

export function SchedulerEditorScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [initialDraft] = useState(readSchedulerDraft);
  const [title, setTitle] = useState(initialDraft.title || "");
  const [taskType, setTaskType] = useState<"agent" | "command">(initialDraft.taskType || "agent");
  const [instruction, setInstruction] = useState(initialDraft.instruction || "");
  const [kind, setKind] = useState<"daily" | "weekdays" | "interval" | "once">(initialDraft.kind || "daily");
  const [time, setTime] = useState(initialDraft.time || "09:00");
  const [onceAt, setOnceAt] = useState(
    initialDraft.onceAt || localDateTimeValue(Date.now() + 60 * 60_000),
  );
  const [intervalMinutes, setIntervalMinutes] = useState(initialDraft.intervalMinutes || "60");
  const [preset, setPreset] = useState<"read-only" | "workspace-write" | "trusted-automation">(
    initialDraft.preset || "read-only",
  );
  const [modelProfileId, setModelProfileId] = useState(
    initialDraft.modelProfileId || "",
  );
  const models = useQuery({
    queryKey: ["models"],
    queryFn: listModels,
    staleTime: 60_000,
  });
  const availableModels = (models.data?.profiles || []).filter((profile) =>
    profile.credentialRequired === false
    || profile.credentialConfigured === true
  );
  const selectedModelAvailable = !modelProfileId
    || availableModels.some((profile) => profile.id === modelProfileId);
  const effectivePreset = taskType === "command" ? "trusted-automation" : preset;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  useEffect(() => {
    if (!title && !instruction) {
      localStorage.removeItem(SCHEDULER_DRAFT_KEY);
      return;
    }
    localStorage.setItem(SCHEDULER_DRAFT_KEY, JSON.stringify({
      title,
      taskType,
      instruction,
      kind,
      time,
      onceAt,
      intervalMinutes,
      preset,
      modelProfileId: taskType === "agent" ? modelProfileId : "",
    }));
  }, [
    title,
    taskType,
    instruction,
    kind,
    time,
    onceAt,
    intervalMinutes,
    preset,
    modelProfileId,
  ]);
  const create = useMutation({
    mutationFn: () => createSchedulerTask({
      title: title.trim(),
      taskType,
      executionMode: "service-backed",
      prompt: taskType === "agent" ? instruction.trim() : "",
      command: taskType === "command" ? instruction.trim() : "",
      modelProfileId: taskType === "agent" ? modelProfileId : "",
      schedule: {
        kind,
        timeZone,
        ...(kind === "interval"
          ? { intervalMinutes: Math.max(1, Number(intervalMinutes) || 60) }
          : kind === "once"
            ? { timestamp: new Date(onceAt).getTime() }
            : { time }),
      },
      capability: {
        preset: effectivePreset,
        allowedTools: effectivePreset === "read-only"
          ? []
          : effectivePreset === "trusted-automation"
            ? ["write", "edit", "Bash"]
            : ["write", "edit"],
        maxToolCalls: 50,
      },
      timeoutSeconds: 300,
      enabled: true,
    }),
    onSuccess(task) {
      localStorage.removeItem(SCHEDULER_DRAFT_KEY);
      void queryClient.invalidateQueries({ queryKey: ["scheduler-tasks"] });
      navigate(`/scheduler/${encodeURIComponent(task.id)}`, { replace: true });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !instruction.trim()) return;
    create.mutate();
  };
  return (
    <MobilePage title="新建定时任务" subtitle="自动化" back="自动化">
      <form className="mobile-form" onSubmit={submit}>
        <label>
          <span>名称</span>
          <input required maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <fieldset>
          <legend>任务类型</legend>
          <SegmentedControl
            value={taskType}
            options={[
              { value: "agent", label: "Agent" },
              { value: "command", label: "命令" },
            ]}
            onChange={setTaskType}
          />
        </fieldset>
        {taskType === "agent" ? (
          <label>
            <span>模型</span>
            <select
              value={modelProfileId}
              onChange={(event) => setModelProfileId(event.target.value)}
            >
              <option value="">继承 scheduled.default</option>
              {!selectedModelAvailable ? (
                <option value={modelProfileId}>
                  {modelProfileId}（当前不可用）
                </option>
              ) : null}
              {availableModels.map((profile) => (
                <option value={profile.id} key={profile.id}>
                  {profile.label || profile.id}
                </option>
              ))}
            </select>
            {models.isError ? (
              <small className="form-help">模型列表暂不可用，可继续使用默认模型</small>
            ) : null}
          </label>
        ) : null}
        <label>
          <span>{taskType === "agent" ? "任务提示词" : "命令"}</span>
          <textarea required rows={6} value={instruction} onChange={(event) => setInstruction(event.target.value)} />
        </label>
        <label>
          <span>运行方式</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="daily">每天</option>
            <option value="weekdays">工作日</option>
            <option value="interval">固定间隔</option>
            <option value="once">单次</option>
          </select>
        </label>
        <label>
          <span>
            {kind === "interval" ? "间隔（分钟）" : kind === "once" ? "执行时间" : "时间"}
          </span>
          <input
            type={kind === "interval" ? "number" : kind === "once" ? "datetime-local" : "time"}
            min={kind === "interval" ? 1 : undefined}
            value={kind === "interval" ? intervalMinutes : kind === "once" ? onceAt : time}
            onChange={(event) => {
              if (kind === "interval") setIntervalMinutes(event.target.value);
              else if (kind === "once") setOnceAt(event.target.value);
              else setTime(event.target.value);
            }}
          />
        </label>
        <label>
          <span>权限</span>
          <select
            value={effectivePreset}
            disabled={taskType === "command"}
            onChange={(event) => setPreset(event.target.value as typeof preset)}
          >
            <option value="read-only">只读</option>
            <option value="workspace-write">工作区写入</option>
            <option value="trusted-automation">受信自动化</option>
          </select>
          {taskType === "command" ? <small className="form-help">命令任务需要受信自动化权限</small> : null}
        </label>
        {create.isError ? <div className="inline-error">{create.error.message}</div> : null}
        <button className="button primary submit-button" type="submit" disabled={create.isPending}>
          <CalendarClock size={17} />保存定时任务
        </button>
      </form>
    </MobilePage>
  );
}
