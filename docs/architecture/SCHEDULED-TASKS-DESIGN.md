# Zion Scheduled Tasks & Agent Automation — 设计文档

> 状态：Phase 0 / service-backed 控制面已实现 | 最后更新：2026-07-26
> 
> 基于对 Codex、Claude Code、Microsoft Agent Framework 定时任务机制的调研，
> 结合 zion-next (memory-panel 分支) 当前架构的分析。
>
> **v0.2 决策：** 浏览器定时器只提供 `local-only`、best-effort 的执行模式；
> 用户创建的持久定时任务由 zion-local-tools 作为唯一控制面和执行 owner。插件是管理、
> 观察和本地降级 UI，不是第二个独立 scheduler。
>
> **v0.3 实施状态：** 已实现 `local-only` 与 `service-backed`。后者由
> zion-local-tools 使用 SQLite 持久化 Task、occurrence、Run 和 claim lease，断开期间
> 到期的 Run 会保留为 pending，在线 Zion worker 领取后执行。后端 Agent Runtime 与模型
> 凭证尚未迁移，因此 `service-backed` 不等同于“浏览器关闭时仍在推理”；完成该迁移后才
> 将模式命名为 `durable`。
>
> Agent Runtime 的进程边界、Monorepo 方案和迁移步骤见
> [AGENT-RUNTIME-BOUNDARY-STRATEGY.md](./AGENT-RUNTIME-BOUNDARY-STRATEGY.md) 与
> [AGENT-RUNTIME-MIGRATION-CHECKLIST.md](./AGENT-RUNTIME-MIGRATION-CHECKLIST.md)。
> Desktop、Cloud、CLI 和 Device Bridge 下的任务 placement 见
> [MULTI-SURFACE-AGENT-PLATFORM.md](./MULTI-SURFACE-AGENT-PLATFORM.md)。

---

## 目录

1. [背景](#1-背景)
2. [业界调研摘要](#2-业界调研摘要)
3. [zion-next 当前架构盘点](#3-zion-next-当前架构盘点)
4. [设计目标与原则](#4-设计目标与原则)
5. [整体架构](#5-整体架构)
6. [Core 需要新增的能力](#6-core-需要新增的能力)
7. [插件设计：dev.scheduler](#7-插件设计devscheduler)
8. [交互设计](#8-交互设计)
   - 8.5 [Run 结果的双视图：Run Detail + Session Editor](#85-run-结果的双视图run-detail--session-editor)
9. [输入/输出协议](#9-输入输出协议)
10. [实施路线](#10-实施路线)
11. [开放问题](#11-开放问题)
12. [附录：调研原始笔记](#12-附录调研原始笔记)

---

## 1. 背景

### 1.1 需求

用户需要 zion-next 能够：

- 定时自动执行 Agent 任务（"每天早上 9 点检查 stale PR"）
- 支持外部事件触发（飞书 @zion、GitHub webhook）
- 长时间运行的 Agent 任务不因浏览器关闭而中断
- 能查看任务执行历史、暂停/恢复/修改定时任务

### 1.2 约束

- zion-next 是**浏览器 PWA**，无原生 cron、无 daemon 进程
- zion-local-tools 是后端服务，可以运行常驻进程，但 Agent 运行时目前在前端
- 核心层（`src/core/`）目前只有 EventBus + StateBus，极简设计
- 插件系统已经成熟，可以承载大部分新能力

### 1.3 参考：已有 Roadmap

`AGENT-PLATFORM-ROADMAP.md` 已经规划了四阶段演进，Phase 1 正是 "Backend Job Scheduler"。本文档将它收敛为一个可演进的任务平台：后端保存任务定义、决定触发和执行所有权；前端负责配置、可视化和本地降级执行。这样“浏览器关闭后仍执行”不是后续补丁，而是第一版产品契约。

---

## 2. 业界调研摘要

### 2.1 OpenAI Codex

**两套定时体系：**

| 表面 | 运行位置 | 交互 |
|------|---------|------|
| Mac/Windows App **Automations** | 本地隔离 worktree | sidebar 配置 prompt + schedule → Triage 收件箱 |
| CLI `codex exec` | CI runner / cron | stdout JSONL + exit code → 下游 pipeline |

**关键设计：**
- `--json` 输出 JSONL 事件流（`thread.started` → `turn.started` → `item.*` → `turn.completed`）
- `--output-schema` 约束最终输出为结构化 JSON Schema
- `--sandbox` 三档：read-only / workspace-write / danger-full-access
- `codex exec resume --last` 跨 cron 触发保持上下文
- `CODEX_API_KEY` 环境变量做 headless 认证
- Thread Automations：附着在特定对话线程上，上下文跨运行累积

**JSONL 事件类型：**

| 事件 | 含义 | 关键字段 |
|------|------|----------|
| `thread.started` | 会话开始 | `thread_id` (UUID) |
| `turn.started` | Agent turn 开始 | — |
| `item.started` | 工具调用/消息开始 | `item.id`, `item.type`, `item.command` |
| `item.completed` | 工具调用/消息完成 | `item.type`, `item.text` |
| `turn.completed` | turn 结束 | `usage: {input_tokens, cached_input_tokens, output_tokens}` |
| `turn.failed` | turn 失败 | error 详情 |

`item.type`：`agent_message` / `command_execution` / `reasoning` / `file_change` / `mcp_tool_call` / `web_search` / `plan_update`

### 2.2 Anthropic Claude Code

**三层调度模型：**

| | Routines（云端） | Desktop Scheduled Tasks | `/loop`（会话内） |
|---|---|---|---|
| 运行位置 | Anthropic 云 | 你的机器 | 你的机器 |
| 需要开机 | ❌ | ✅ | ✅ |
| 需要打开 session | ❌ | ❌ | ✅ |
| 最小间隔 | 1 小时 | 1 分钟 | 1 分钟 |
| 权限 | 全自动 | 可配置 | 继承 session |
| 跨重启持久 | ✅ | ✅ | `--resume` 恢复（7天过期） |

**关键设计：**
- 底层三个工具：`CronCreate(cron, prompt, recurring)` / `CronList` / `CronDelete`
- 自然语言调度：`/loop every weekday at 9am` → Claude 转换为 cron 表达式
- 自适应间隔：`/loop check the deploy`（不指定间隔）→ Claude 根据观察动态选 1min-1h
- Jitter：循环任务偏移 0-30min，一次性任务偏移 0-90s（防止惊群效应）
- 7 天自动过期
- Thread Automations：Standalone（独立运行）vs Thread（保持上下文累积）
- Routines 支持三种 trigger：Schedule / API / GitHub

### 2.3 Harness Engineering（OpenAI 团队实践）

OpenAI 用 Codex 从零构建百万行代码产品的核心原则：

1. **Brain / Hands 解耦** — Harness 是控制面，Sandbox 是执行面（可重建）
2. **Session ≠ Context Window** — Session 是 event log（永久记录），Context 是每次 inference 的工作区
3. **Agent-to-Agent Review** — PR review 几乎全部 agent 完成
4. **定期 doc-gardening agent** — 扫描过时文档自动开修复 PR
5. **知识进 Repo** — agent 需要的信息全在仓库里（markdown、schema、plan）

### 2.4 可借鉴模式总结

| 模式 | 来源 | 适用 zion-next？ |
|------|------|-----------------|
| 双层调度（前端 loop + 后端 cron） | Codex + Claude Code | ✅ 核心模式 |
| 自然语言 → cron 转换 | Claude Code `/loop` | ✅ 交互甜点 |
| JSONL 事件流 | Codex `--json` | ✅ 可观测性基础 |
| `--output-schema` 结构化输出 | Codex | ✅ 下游消费必需 |
| Thread 上下文保持 | Claude Code | ✅ 与 memory 面板天然契合 |
| Sandbox 三档 | Codex | ✅ 安全基线 |
| 7 天过期 + Jitter | Claude Code | ✅ 小而精 |
| Triage/Inbox 审核 | Codex | ✅ UI 模式 |

---

## 3. zion-next 当前架构盘点

### 3.1 已有基础

```
┌─────────────────────────────────────────────┐
│                 zion-next (PWA)              │
│                                              │
│  ┌─────────┐  ┌──────────┐  ┌────────────┐ │
│  │EventBus │  │ StateBus │  │  Registry   │ │
│  │ pub/sub │  │ reactive │  │ commands +  │ │
│  │ events  │  │  state   │  │ menus +     │ │
│  └─────────┘  └──────────┘  │ keybindings │ │
│                              │ + message   │ │
│  ┌──────────────────────┐   │ contributors│ │
│  │   PluginManager      │   │ + tools     │ │
│  │   lifecycle +        │   └────────────┘ │
│  │   sandbox + hot-reload│                  │
│  └──────────────────────┘                  │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │  Message Contributor Pipeline        │   │
│  │  pre: memory context injection       │   │
│  │  → LLM call                          │   │
│  │  post: (TBD)                         │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │  Tool Registration (StateBus)        │   │
│  │  chat.tools + chat.toolHandlers      │   │
│  │  chat.enabledTools                   │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  30+ extensions (dev.memory 等)              │
└─────────────────────────────────────────────┘
```

### 3.2 关键缺口（对定时任务而言）

| # | 缺口 | 严重程度 | 备注 |
|---|------|---------|------|
| 1 | **无编程式 Chat 执行** | 🔴 阻塞 | `chat.run()` 依赖编辑器选中文本，无法接受纯 prompt 字符串 |
| 2 | **Chat 执行生命周期事件不完整** | 🔴 阻塞 | 有 `chat/runStarted`/`chat/runFinished`，但缺少 turn 级、tool call 级事件 |
| 3 | **Tool call 不可观测** | 🟡 重要 | tool handler 是 fire-and-forget，无前后事件 |
| 4 | **无 Run 持久化存储** | 🟡 重要 | 运行记录没有持久化，无法查看历史 |
| 5 | **无结构化输出支持** | 🟡 重要 | LLM 请求不支持 `response_format` |
| 6 | **无 Sandbox 级别执行时强制** | 🟢 增强 | PluginSandboxOptions 定义了但 chat 层未使用 |
| 7 | **无后台运行感知** | 🟢 增强 | 没有状态 key 来追踪 background runs |
| 8 | **无 Session resume API** | 🟢 增强 | SessionRuntime 有切换能力但缺少 chat.resume |

---

## 4. 设计目标与原则

### 4.1 目标

1. **持久任务可靠执行**：浏览器关闭、标签页休眠或刷新不改变已经接受的任务定义。
2. **安全地执行 Agent**：任务的可用工具、文件根目录、网络目标和凭证按 run 强制校验。
3. **单一事实来源**：Task、Run、事件与执行 owner 均可查询、可审计、可迁移。
4. **渐进体验**：默认使用预设时间和只读能力；cron、线程、结构化输出和写权限按需展开。

### 4.2 设计原则

- **Control plane / execution plane 分离**：后端持久化任务、发放执行 lease；执行器可为后端 worker 或 local-only 浏览器，但同一 occurrence 只能有一个 owner。
- **Run 是一等对象**：`runId` 由执行服务产生，Task、occurrence、task revision、thread 与权限策略不可变地关联到该 Run。
- **事件是 canonical transcript**：内存事件流、数据库记录、WebSocket 推送和 JSONL 导出使用同一版本化 envelope；JSONL 是导出格式，不是唯一存储模型。
- **Progressive disclosure**：默认简单（填 prompt + 选时间），高级选项折叠。
- **Safe by default**：默认只读、禁止隐式外发和写入；策略在工具执行点强制，不依赖模型遵守 prompt。

---

## 5. 整体架构

### 5.1 运行模式与产品承诺

| 模式 | 适用场景 | owner | 可靠性承诺 | 可用权限 |
|---|---|---|---|---|
| `durable`（目标） | 浏览器关闭时仍需完成的 Agent 任务 | zion-local-tools Agent worker | 重启后恢复并完成推理；按 misfire policy 处理 | 后端 CapabilityPolicy 强制 |
| `service-backed`（已实现） | 可靠保存触发、允许稍后执行 | zion-local-tools 控制面 + 浏览器 worker | 触发和 pending Run 不丢失；执行等待在线 Zion | 浏览器 ToolGateway 强制 |
| `local-only`（已实现） | 本地预览、开发、暂时离线 | 浏览器当前 profile 的 leader tab | 页面存活期间 best-effort；不补偿 | read-only / workspace-write / trusted-automation |

浏览器不能创建“看似持久、实际依赖标签页”的任务。UI 必须明确区分
`service-backed` 的“触发持久化、执行等待在线 worker”和真正 `durable` 的后端执行。

```
┌──────────────────────────────────────────────────────────────────────┐
│                     zion-local-tools：控制面 + 默认执行面              │
│                                                                       │
│  Task API + Postgres              Scheduler / owner lease             │
│  ┌────────────────────┐           ┌─────────────────────────────┐   │
│  │ Task revisions     │──occurrence│ timezone / DST / misfire /  │   │
│  │ Run index/events   │           │ overlap / retry / idempotency│   │
│  │ CapabilityPolicy   │           └──────────────┬──────────────┘   │
│  └────────────────────┘                          │                  │
│                                                    ▼                  │
│                                         Agent Runtime + Tool Gateway  │
│                                         policy enforced per call      │
└──────────────────────────────────────┬───────────────────────────────┘
                                       │ REST + WebSocket / SSE
┌──────────────────────────────────────▼───────────────────────────────┐
│                         zion-next（管理与观察）                        │
│  dev.scheduler：任务配置、状态、Run Detail、JSONL 导出、Session Fork   │
│  Core Run API：RunHandle、事件桥接、CapabilityPolicy、只读 transcript  │
│  IndexedDB：UI cache、离线读取、local-only runs（非 durable 主存储）   │
│                                                                       │
│  可选 local-only runner：leader tab + setTimeout；只读且页面存活时运行 │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 6. Core 需要新增的能力

以“最小必需集”原则，只列插件自己做不了的能力。所有 API 以 Run 为边界，不允许
插件伪造或重映射 runId。

### 6.1 P0（必须 — 无此能力插件无法工作）

#### 6.1.1 编程式 Chat 执行

```typescript
// 新增 API；调用即获得唯一的真实运行身份
window.zion.chat.execute(request: ChatExecuteRequest): RunHandle

interface ChatExecuteRequest {
  prompt: string;                 // 不依赖编辑器状态，纯文本 prompt
  task?: { id: string; revision: number; occurrenceId: string };
  executionMode: "durable" | "service-backed" | "local-only";
  policy: CapabilityPolicy;       // Core/后端已解析，调用方不得自行放大权限
  /** 结构化输出约束 */
  responseFormat?: {
    type: "json_schema";
    json_schema: object;
  };
  /** 超时（ms），超时自动 abort */
  timeout?: number;
  thread?: { id: string; expectedVersion: number };
}

interface RunHandle {
  runId: string;
  completion: Promise<RunCompletion>;
  abort(reason: "timeout" | "user" | "superseded"): Promise<void>;
  events: AsyncIterable<RunEvent>;
}
```

`RunHandle` 是事件、超时、中止、存储和 UI 关联的唯一来源。`chat.execute` 不接受
调用方任意指定的 runId；后端场景由服务端发号，local-only 场景由 Core 发号。

**与现有 `chat.run()` 的区别：**
- 不读取编辑器文本
- 不解析 role markers
- 接受纯 prompt 字符串
- 返回包含真实 `runId`、事件流、完成结果和中止能力的 `RunHandle`

#### 6.1.2 生命周期与策略强制

```
run.started / turn.started / message.delta / message.completed
tool.requested / tool.completed / tool.denied
turn.completed / run.completed / run.failed / run.aborted
```

每个事件都有 `eventId`、单调递增 `sequence`、`schemaVersion`、`runId` 和 `ts`。
Core 通过 `RunHandle.events` 提供无丢失消费，随后可镜像到 `window.zion.events` 供 UI
订阅；插件不得依赖全局广播来保证持久化。

工具调用必须经过 `ToolGateway.authorize(runId, tool, args)`。它基于冻结的
`CapabilityPolicy` 校验工具 allowlist、文件根目录、网络主机、写入/外发确认与凭证范围，
并把拒绝结果记录为 `tool.denied`。sandbox 是 UI 预设，不是授权实现。

#### 6.1.3 Run Abort

```typescript
await runHandle.abort("timeout")
```

### 6.2 P1（应该 — 大幅提升体验）

#### 6.2.1 结构化输出支持

利用 LLM Provider 的 `response_format` 能力：

```typescript
// 在 chat.execute 的 options 中支持
{
  responseFormat: {
    type: "json_schema",
    json_schema: {
      type: "object",
      properties: {
        findings: { type: "array", items: { ... } },
        nothing_to_report: { type: "boolean" }
      },
      required: ["findings", "nothing_to_report"],
      additionalProperties: false
    }
  }
}
```

最终的 `agent_message` 会被约束为符合 schema 的 JSON 字符串。

#### 6.2.2 Run Event Cache 与导出

durable run 的权威存储在后端；前端只维护可清理、可补齐的 IndexedDB cache。Core 可提供
统一查询接口，插件负责离线显示和 JSONL 导出：

```typescript
interface RunStore {
  resume(runId: string, afterSequence?: number): AsyncIterable<RunEvent>;
  query(runId: string, afterSequence?: number): Promise<RunEvent[]>;
  exportJsonl(runId: string): Promise<Blob>;
}
```

local-only run 可完整落 IndexedDB，但必须标记 `local-only`、应用 retention，且不得与
durable 历史合并为同一权威记录。

### 6.3 P2（增强 — 锦上添花）

#### 6.3.1 Background Run 状态

```typescript
// StateBus key
state.set("chat.backgroundRuns", [
  { runId: "r1", taskId: "t1", status: "running", startedAt: ... },
  { runId: "r2", taskId: "t2", status: "completed", startedAt: ... }
]);
```

让 sidebar / status bar 可以渲染 "⏳ 2 background tasks"。

#### 6.3.2 Session Resume API

```typescript
// 恢复之前的对话上下文继续执行
window.zion.chat.resume(runId: string, followUpPrompt: string): string
```

#### 6.3.3 只读 Session 模式

定时 run 产生的 session 应该是只读的，防止用户误编辑历史运行记录。

```typescript
// SessionRuntime 新增
sessionRuntime.openReadOnly(runId: string, messages: RoleMessage[]): string
// 返回 sessionId，该 session 不可编辑、不显示输入框
```

仅需在现有 SessionRuntime 上加一个 `readOnly` 标记，编辑器层根据此标记隐藏输入框 + 禁用编辑。

#### 6.3.4 Session Fork

用户浏览只读的 run session 时，可以 "Fork 为交互会话" 继续追问 agent。

```typescript
// SessionRuntime 新增
sessionRuntime.fork(runId: string): string
// 创建新 session，初始消息 = run 的历史消息
// 新 session 可编辑，标记 forkedFrom: runId
```

---

## 7. 插件设计：dev.scheduler

### 7.1 插件结构

```
extensions/dev.scheduler/
├── manifest.json
├── main.js                  # activate/deactivate, 注册命令/面板/tool
├── lib/
│   ├── task-api.js          # 后端 Task / Run REST 客户端
│   ├── run-stream.js        # WebSocket/SSE 断线续传 + IndexedDB cache
│   ├── local-runner.js      # 仅 local-only：leader lease + 只读 RunHandle
│   ├── natural-schedule.js  # "每工作日9点" → cron 转换
│   └── event-store.js       # canonical event cache + JSONL 导出
├── ui/
│   ├── scheduler-panel.js   # 主面板：任务列表 + 新建/编辑 + 历史
│   ├── task-editor.js       # 新建/编辑表单
│   ├── run-history.js       # 运行历史列表
│   └── run-detail.js        # 单次运行详情（event log 回放）
└── styles.css
```

### 7.2 核心模块职责

#### task-api.js 与 run-stream.js

`task-api.js` 对接后端的 Task API。创建、更新、暂停都带 `revision`，服务端采用
乐观并发控制，避免两个面板覆盖彼此的设置。`run-stream.js` 按 `runId + sequence` 断线
续传事件，先写 IndexedDB cache，再更新 UI；服务端仍是历史与审计的权威来源。

```typescript
await taskApi.update(task.id, task.revision, patch);
for await (const event of runStream.resume(runId, lastSequence)) {
  await eventStore.append(event); // dedupe by eventId
}
```

#### local-runner.js

local runner 只接受 `executionMode: "local-only"` 和固定只读 policy。它使用
`navigator.locks` 优先、BroadcastChannel 兜底获取 profile 内 leader lease；失去 lease、
页面隐藏过久或时钟跳变后停止，不补偿错过任务。它通过 `chat.execute()` 获取真实
`RunHandle`，不生成 runId，也不以全局 EventBus 作为日志来源。

#### natural-schedule.js

```javascript
// 自然语言时间描述 → cron 转换策略

// 策略 1：预设模式匹配
const PRESETS = {
  "每小时":   "0 * * * *",
  "每天":     "0 9 * * *",
  "每周":     "0 9 * * 1",
  "每工作日": "0 9 * * 1-5",
};

// 策略 2：正则 + 模板
const PATTERNS = [
  { regex: /每(\d+)分钟/,    build: (m) => `*/${m} * * * *` },
  { regex: /每(\d+)小时/,    build: (m) => `0 */${m} * * *` },
  { regex: /每天\s*(\d+):(\d+)/, build: (h, m) => `${m} ${h} * * *` },
  { regex: /每周(一|二|三|四|五|六|日)/,
    build: (day) => `0 9 * * ${DAY_MAP[day]}` },
  // ...
];

// 策略 3：后端受约束解析 fallback
async function toCron(humanReadable) {
  // 先尝试预设 + 正则
  const matched = matchPreset(humanReadable) || matchPattern(humanReadable);
  if (matched) return matched;

  // LLM 必须返回受 JSON Schema 约束的候选；后端再解析、校验并回传预览。
  return taskApi.parseSchedule({ text: humanReadable, timeZone });
}
```

不能直接信任模型返回的 cron。保存前服务端必须校验字段范围、最短间隔、时区和未来
触发预览；UI 显示“解释后的时间、时区、下三次触发”，用户确认后才写入。

### 7.3 注册的命令和工具

```javascript
// 命令
"scheduler.openPanel"       // 打开 scheduler 面板
"scheduler.create"          // 新建定时任务
"scheduler.runNow"          // 立即运行指定任务
"scheduler.togglePause"     // 暂停/恢复

// Tool（供 LLM 调用；默认只允许 draft）
{
  name: "scheduleManage",
  description:
    "管理定时任务：创建、列表、暂停、删除、查看运行历史",
  parameters: {
    action: ["list", "draft", "history"],
    id: { type: "string" },
    prompt: { type: "string" },
    schedule: { type: "string" },
  }
}
```

模型只能生成任务草稿或读取历史。`create/update/delete/pause/resume/runNow` 是有副作用
的控制面操作，必须由用户在 UI 审阅后以显式 confirmation token 提交；不能因网页、
邮件或 memory 中的提示词而直接创建高权限自动任务。

---

## 8. 交互设计

### 8.1 主面板布局

```
┌──────────────────────────────────────────────────────┐
│  ⏰ Scheduled Tasks                       [+ New]    │
│  ┌──────────────────────────────────────────────────┤
│  │ 搜索定时任务...                                    │
│  ├──────────────────────────────────────────────────┤
│  │                                                    │
│  │ ▼ Active (2)                                       │
│  │  ┌────────────────────────────────────────────┐   │
│  │  │ ● PR Review                                 │   │
│  │  │   每工作日 09:00  ·  read-only               │   │
│  │  │   下次: 明天 09:02 (jitter +2m)              │   │
│  │  │   上次: ✓ 成功 · 今天 09:01 · 4500 tokens   │   │
│  │  │   [暂停] [立即运行] [编辑] [···]            │   │
│  │  ├────────────────────────────────────────────┤   │
│  │  │ ● Doc Gardener                              │   │
│  │  │   每周一 08:00  ·  workspace-write          │   │
│  │  │   下次: 下周一 08:17                         │   │
│  │  │   上次: ✓ 成功 · 6天前 · 已开 PR #234      │   │
│  │  │   [暂停] [立即运行] [编辑] [···]            │   │
│  │  └────────────────────────────────────────────┘   │
│  │                                                    │
│  │ ▼ Paused (1)                                       │
│  │  ┌────────────────────────────────────────────┐   │
│  │  │ ○ Deploy Watcher                            │   │
│  │  │   每 30 分钟  ·  read-only                  │   │
│  │  │   [恢复] [编辑] [删除]                      │   │
│  │  └────────────────────────────────────────────┘   │
│  │                                                    │
│  │ ▼ History (5)                       [Clear All]    │
│  │  ┌────────────────────────────────────────────┐   │
│  │  │ ...（最近 5 次运行记录）                     │   │
│  │  └────────────────────────────────────────────┘   │
│  └────────────────────────────────────────────────────│
└──────────────────────────────────────────────────────┘
```

### 8.2 新建/编辑任务弹窗

```
┌───────────────────────────────────────────┐
│  New Scheduled Task                   [✕]  │
│                                            │
│  Prompt                                    │
│  ┌───────────────────────────────────────┐│
│  │ 检查 GitHub 上超过 3 天未 review     ││
│  │ 的 PR，列出作者、天数、紧急程度。    ││
│  │ 如果 PR 超过 7 天，标记为 high       ││
│  │ urgency。                             ││
│  └───────────────────────────────────────┘│
│                                            │
│  Schedule                                  │
│  ┌───────────────────────────────────────┐│
│  │ [每工作日 ▾]  at  [09:00]            ││
│  │ 或输入: "every Monday and Thursday"  ││
│  │                                       ││
│  │ 预览: 0 9 * * 1-5                    ││
│  │ 下次运行: 2025-07-24 09:02 (+2m)     ││
│  └───────────────────────────────────────┘│
│                                            │
│  ▶ Advanced (折叠)                         │
│  ┌───────────────────────────────────────┐│
│  │ Permissions: [● read-only]             ││
│  │              [○ workspace-write]       ││
│  │ Roots:       [workspace/src     ]      ││
│  │ Writes:      [confirm each change]     ││
│  │                                       ││
│  │ Output:   [● chat message]            ││
│  │           [○ structured JSON]          ││
│  │           [JSON Schema: (可选)]        ││
│  │                                       ││
│  │ Thread:   [ ] 保持上下文              ││
│  │           (每次运行记住上次结果)       ││
│  │                                       ││
│  │ Timeout:  [300] 秒                    ││
│  └───────────────────────────────────────┘│
│                                            │
│  [Cancel]              [Save] [Save & Run] │
└───────────────────────────────────────────┘
```

### 8.3 单次运行详情

```
┌───────────────────────────────────────────┐
│  Run Detail: PR Review #42            [✕]  │
│  2025-07-23 09:01:23 · 4.5s · Exit 0      │
│  ┌───────────────────────────────────────┐│
│  │ Timeline                               ││
│  │                                        ││
│  │ ● run.started             09:01:23    ││
│  │ ● turn.started (turn 1)   09:01:23    ││
│  │ ● tool.called             09:01:24    ││
│  │   memoryManage.search                  ││
│  │   query: "PR stale"                    ││
│  │ ● tool.result             09:01:25    ││
│  │   3 memories found                     ││
│  │ ● tool.called             09:01:25    ││
│  │   web_search "GitHub PR API"           ││
│  │ ● tool.result             09:01:27    ││
│  │   HTTP 200, 3 results                  ││
│  │ ● turn.completed          09:01:27    ││
│  │   input: 4500, output: 320 tokens      ││
│  │ ● run.completed           09:01:27    ││
│  │   exitCode: 0                          ││
│  │   summary: "发现 3 个 stale PR"       ││
│  └───────────────────────────────────────┘│
│                                            │
│  Final Output:                             │
│  ┌───────────────────────────────────────┐│
│  │ {                                       ││
│  │   "findings": [                         ││
│  │     {"pr": "#123", "author": "alice",  ││
│  │      "days_stale": 5, "urgency":"med"},││
│  │     ...                                 ││
│  │   ],                                    ││
│  │   "nothing_to_report": false            ││
│  │ }                                       ││
│  └───────────────────────────────────────┘│
└───────────────────────────────────────────┘
```

### 8.4 状态栏集成

```
┌──────────────────────────────────────────────────────┐
│ ...  ⏰ 2 scheduled  ● 1 running     Ln 42, Col 12   │
└──────────────────────────────────────────────────────┘
```

点击 "2 scheduled" → 打开 scheduler 面板
点击 "1 running" → 打开运行中的 run 详情

### 8.5 Run 结果的双视图：Run Detail + Session Editor

#### 设计结论：JSONL Event Log 为单一数据源，多种视图消费

一次定时 run 的底层就是一次完整的 Agent 对话（prompt → message
contributors → LLM → tool calls → reply）。这和用户在编辑器里手动触发
`chat.run()` 是同一条执行路径，区别只在触发方式。所以 run 天然就是一个
**Session**。

但"把 run 当 session 看"和"把 run 当 session 编辑"是两回事。自动运行的
session 应该是只读的——你不能"编辑"一次已经发生的历史运行。同时，用户需要
元数据视图（时间线、token 用量、exit code）来快速判断运行质量。

因此采用**双视图、渐进展开**的模式：

```
                    ┌─────────────────────────────┐
                    │     JSONL Event Log          │
                    │   (IndexedDB, 不可变)        │
                    │   run.started                │
                    │   turn.started               │
                    │   tool.called                │
                    │   tool.result                │
                    │   turn.completed             │
                    │   run.completed              │
                    └──────────┬──────────────────┘
                               │
               ┌───────────────┼───────────────┐
               ▼               ▼               ▼
        ┌────────────┐  ┌────────────┐  ┌────────────┐
        │ Scheduler  │  │  Session   │  │ 下游消费者 │
        │ Panel 摘要 │  │  Editor    │  │ (Slack,    │
        │ (默认视图) │  │ 查看完整   │  │  PR, 通知) │
        │            │  │ 对话       │  │            │
        └────────────┘  └────────────┘  └────────────┘
```

#### 三个消费入口

**入口 1 — Scheduler Panel 摘要行（默认）**

用户最常做的事是"看一眼上次运行是否成功"：

```
上次: ✓ 成功 · 09:01 · 4820 tokens · [查看详情] [在编辑器中打开]
上次: ✗ 失败 · 08:30 · timeout · [查看详情] [在编辑器中打开]
```

- 点击 `[查看详情]` → 打开 Run Detail 面板（入口 2）
- 点击 `[在编辑器中打开]` → 在 Session 编辑器中打开只读对话（入口 3）
- 失败的 run 用红色高亮，一眼可见

**入口 2 — Run Detail 面板（结构化时间线）**

适合快速扫描运行质量和对比多次运行：

```
┌───────────────────────────────────────────┐
│  Run Detail: PR Review #42           [✕]  │
│  09:01:23 · 4.5s · Exit 0 · 4820 tokens   │
│  ┌───────────────────────────────────────┐│
│  │ Timeline                               ││
│  │                                        ││
│  │ ● run.started             09:01:23    ││
│  │ ● turn.started (turn 1)   09:01:23    ││
│  │ ● tool.called             09:01:24    ││
│  │   web_search                           ││
│  │ ● tool.result             09:01:27    ││
│  │ ● turn.completed          09:01:27    ││
│  │ ● run.completed           09:01:27    ││
│  └───────────────────────────────────────┘│
│                                            │
│  [在 Session 编辑器中查看完整对话]          │
└───────────────────────────────────────────┘
```

面板底部始终有一个跳转到 Session Editor 的按钮。

**入口 3 — Session Editor（完整对话，只读 + Fork）**

用户想看 agent 的完整思考过程、或基于运行结果继续追问时使用。

自动 run 的 session 与手动 session 有视觉区分：

```
┌─────────────────────────────────────────────┐
│ ⏰ PR Review · 2025-07-23 09:01 · 自动运行  │  ← 特殊 header
│ read-only · policy v3                       │
│─────────────────────────────────────────────│
│                                              │
│ user                                         │
│ 检查 GitHub 上超过 3 天未 review 的 PR，    │
│ 列出作者、天数、紧急程度。                  │
│                                              │
│ assistant                                    │
│ 我来检查。首先需要获取 GitHub 上的 PR 列表… │
│                                              │
│ [tool: web_search]                           │
│ [tool result: 3 PRs found]                   │
│                                              │
│ assistant                                    │
│ 发现 3 个超过 3 天未 review 的 PR：         │
│ - #123 by alice · 5 days · medium urgency    │
│ - #456 by bob · 7 days · high urgency        │
│ - #789 by carol · 4 days · medium urgency    │
│                                              │
└─────────────────────────────────────────────┘
│ [Fork 为交互会话]                             │
└─────────────────────────────────────────────┘
```

关键行为：

| 行为 | 说明 |
|------|------|
| **只读** | 自动 run 的 session 不可编辑（不可修改历史消息、不可删除） |
| **Fork 为交互会话** | 用户点击 → 创建一个新的可编辑 session，内容从这条 run 的历史消息开始。用户可以继续追问 agent |
| **Header 元数据** | 显示触发方式（⏰ = 定时 / 🔔 = webhook / 🖐 = 手动）、时间、执行模式与 policy 版本 |
| **消息格式复用** | tool call 的渲染、markdown 预览等完全复用现有 session 编辑器的能力，零额外开发 |

#### 为什么不把 Session Editor 作为唯一视图

| 需求 | Session Editor 能满足吗？ |
|------|--------------------------|
| 看 agent 说了什么 | ✅ |
| 看 tool call 链路 | ✅（现有工具调用展示） |
| 看运行时元数据（耗时、token、exit code） | ❌ 不是 session 编辑器的职责 |
| 快速对比两次运行的差异 | ❌ 需要打开两个 session tab 来回切换 |
| 自动化告警（"这次 run 超时了"） | ❌ 需要解析 session 文档 |
| 基于结果继续追问 agent | ✅（Fork 后） |

**结论：Session Editor 是"看对话内容"的最佳视图，但不是"看运行质量"的最佳视图。两者互补。**

#### 实现要点

1. **JSONL → Session 文档转换**：EventLogStore 提供一个 `toSessionMessages(runId)` 方法，将 JSONL event log 翻译为编辑器 role 消息数组。`tool.called` + `tool.result` 翻译为现有的工具调用消息格式。

2. **只读 Session**：SessionRuntime 需要支持 `readOnly: true` 的 session 模式。编辑器不显示输入框，不可修改内容。

3. **Fork 操作**：`sessionRuntime.fork(runId)` → 创建新 session，初始消息 = run 的历史消息，标记 `forkedFrom: runId`。

4. **自动 run 的 session 不污染 session 列表**：默认在 session 列表里折叠或标记，用户可以选择"在列表中显示"。

---

## 9. 输入/输出协议

### 9.1 Task、调度和权限策略

Task 是后端持久化资源，更新必须传递 `revision`。调度表达式以 IANA 时区解释，服务端
生成 `occurrenceId`；该 ID 是外部副作用的去重键，而非 runId 的替代品。

```typescript
interface ScheduledTask {
  id: string;
  revision: number;
  executionMode: "durable" | "service-backed" | "local-only";
  prompt: string;
  schedule: {
    type: "cron" | "interval" | "once";
    expression: string;
    timeZone: string;             // IANA，例如 Asia/Shanghai
    humanReadable: string;
    jitterSeconds: number;        // 确定性、受上限约束
    misfirePolicy: "skip" | "run-once" | "catch-up";
    maxCatchUp: number;
    overlapPolicy: "forbid" | "queue" | "replace";
  };
  policy: CapabilityPolicy;
  thread?: { id: string; expectedVersion: number };
  output?: { mode: "chat" | "structured"; schema?: object };
  timeoutSeconds: number;
  retry: { maxAttempts: number; backoffSeconds: number[] };
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface CapabilityPolicy {
  version: number;
  preset: "read-only" | "workspace-write" | "trusted-automation";
  allowedTools: string[];
  fileRoots: string[];           // workspace-write 时显式声明
  allowedHosts: string[];
  allowedCommandPrefixes: string[];
  allowedTerminalSessionIds: string[];
  allowedRecipients: string[];
  maxMailPerRun: number;
  maxToolCalls: number;
}
```

持久任务的 `overlapPolicy` 默认 `forbid`，misfire 默认 `skip`；`local-only` 固定为
`skip + forbid + maxAttempts=1`。DST 前后、时钟回拨、服务重启和 owner 切换都必须由
同一 scheduler 依据该配置计算。每个 occurrence 最多产生一个活跃 Run；重试产生新的
attempt/runId，但共享 occurrenceId。

### 9.2 Run、事件和存储

Run 是不可变执行记录。后端在事务中创建 Run 和 owner lease，再开始执行；worker 续租
失败必须停止。Run summary 建索引用于任务列表，事件按 `(runId, sequence)` 排序存储；
IndexedDB 只缓存已确认事件并可随时从后端补齐。

```typescript
interface RunEvent<T = unknown> {
  schemaVersion: 1;
  eventId: string;               // 去重键
  runId: string;
  taskId: string;
  taskRevision: number;
  occurrenceId: string;
  sequence: number;              // 每个 run 单调递增
  type:
    | "run.started" | "turn.started"
    | "message.delta" | "message.completed"
    | "tool.requested" | "tool.completed" | "tool.denied"
    | "turn.completed" | "run.completed" | "run.failed" | "run.aborted";
  ts: number;
  data: T;
}
```

`message.completed` 保存最终 assistant 内容；`tool.*` 保存 call ID、经脱敏的参数/结果
摘要与 policy decision；`run.completed` 保存 final output、usage 和 completion reason。
因此同一事件流可用于 Run Detail、只读 Session、Fork、审计和 JSONL 导出。原始密钥、
Authorization header、完整敏感工具输出不得写入事件。

### 9.3 Output Schema 示例（structured mode）

当用户选择 "structured JSON" 输出模式：

```json
{
  "type": "object",
  "properties": {
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "source": { "type": "string" },
          "summary": { "type": "string" },
          "urgency": { "type": "string", "enum": ["high", "medium", "low"] },
          "suggested_action": { "type": "string" }
        },
        "required": ["source", "summary", "urgency"]
      }
    },
    "nothing_to_report": { "type": "boolean" }
  },
  "required": ["findings", "nothing_to_report"],
  "additionalProperties": false
}
```

---

## 10. 实施路线

### Phase 0：Run 与权限基础（预计 1-2 周）

```
□ `chat.execute(request) -> RunHandle`，RunHandle.events / completion / abort
□ 版本化 RunEvent、message completed、tool requested/completed/denied
□ ToolGateway + CapabilityPolicy 在工具调用点强制执行
□ 只读 transcript 存储与脱敏规则
```

**验收：** 在 console 触发一个只读 run，RunHandle 的 runId 与全部事件一致；尝试调用
未授权写工具会得到 `tool.denied`，且不产生副作用。

### Phase 1：后端 durable 控制面（预计 2-3 周）

```
□ Task / revision / Run / event 数据模型与 REST API
□ Scheduler：timezone、DST、misfire、overlap、occurrenceId、owner lease
□ 只读 durable worker（无外发、无 workspace 写入）
□ `dev.scheduler` 面板：创建、预览下三次触发、暂停、历史列表
□ WebSocket/SSE 事件推送与从 sequence 续传
```

**验收：** 创建 durable 只读任务后关闭浏览器，任务仍只执行一次；服务重启、双标签、
夏令时边界和运行超时均符合任务配置，UI 重连后能补齐完整记录。

### Phase 2：可观测性与安全操作（预计 2-3 周）

```
□ Run Detail、事件 cache、JSONL 导出、token 用量和 retention job
□ 只读 Session 与 Fork，基于 canonical transcript
□ workspace-write policy：文件根目录 allowlist + 每次变更确认
□ 控制面 confirmation token：修改、删除、立即执行均需显式确认
□ 审计：任务 revision、policy decision、操作者、owner 与 retry 链路
```

**验收：** 历史 run 能完整回放 assistant 输出和工具时间线；Fork 使用相同 transcript；
任一敏感字段不出现在 API、UI cache 或 JSONL 导出。

### Phase 3：增强调度与 local-only（预计 2-3 周）

```
□ 自然语言时间解析：schema 约束、服务端校验、预览后确认
□ Structured output + 服务端 schema 校验
□ Thread：expectedVersion、单 task 串行与上下文压缩
□ local-only runner：leader lease、只读限制、明确状态栏提示
□ 状态栏和 Session 列表区分 durable/local-only
```

**验收：** 输入“每工作日早上 9 点”后，用户能核对时区和三次预览；结构化输出经校验；
local-only 任务在页面关闭或失去 leader 后不伪装为仍在运行。

### Phase 4：外部触发与受控交付（独立评审后）

```
□ Webhook ingress：签名验证、重放防护、请求限流
□ 外部投递：目标 allowlist、审批策略、secret isolation
□ 失败告警、配额、并发限制和运行成本预算
```

**验收：** 外部事件不能越过 CapabilityPolicy；重复 webhook 或重试不会造成重复副作用。

---

## 11. 开放问题

1. **Task 主存储与部署边界**
   - 单用户 local-tools 默认 SQLite 是否足够，还是直接采用 Postgres？
   - 建议：接口与迁移按 Postgres 设计；开发环境允许 SQLite，但 owner lease 与唯一
     occurrence 约束不能依赖进程内 map。

2. **Thread 上下文的增长与冲突**
   - thread run 需要明确 `expectedVersion` 和单任务串行；冲突时失败或重新调度，不能静默合并。
   - 建议：v1 限制单个 thread 同时一个 active run，并在压缩前生成可审计 checkpoint。

3. **与 memory 面板的联动**
   - memory context 注入必须属于 Run 的 context snapshot，并记录引用的 memory revision。
   - 建议：默认复用 memory 策略，任务级 override 需要用户确认，不能允许 memory 内容扩大工具权限。

4. **数据保留与隐私**
   - 事件 transcript、工具结果和 Fork 会增长很快，且可能包含敏感工作区内容。
   - 建议：Task 可配置 retention；服务端默认过期清理，导出前脱敏，删除任务不自动删除审计记录。

---

## 12. 附录：调研原始笔记

### A. Codex CLI `codex exec` 完整 flags

| Flag | 说明 |
|------|------|
| `PROMPT` | 任务指令；用 `-` 从 stdin 读取 |
| `--json` | stdout 输出 JSONL 流 |
| `-o PATH` / `--output-last-message PATH` | 最终消息写入文件 |
| `--output-schema PATH` | JSON Schema 约束结构化输出 |
| `--ephemeral` | 不持久化 session |
| `--full-auto` | workspace-write + on-request approvals |
| `-s MODE` / `--sandbox MODE` | read-only / workspace-write / danger-full-access |
| `--yolo` | 无 sandbox，无 approvals |
| `-C PATH` / `--cd PATH` | 设置 workspace root |
| `--add-dir PATH` | 额外写权限目录 |
| `--skip-git-repo-check` | 允许在非 Git 目录运行 |
| `-m NAME` / `--model NAME` | 覆盖模型 |
| `-c KEY=VALUE` / `--config KEY=VALUE` | 行内配置覆盖 |
| `-i PATH` / `--image PATH` | 附加图片 |

### B. Claude Code `/loop` 底层工具

| 工具 | 功能 |
|------|------|
| `CronCreate` | 创建任务：5-field cron + prompt + 是否循环 |
| `CronList` | 列出所有定时任务 |
| `CronDelete` | 按 8 位 ID 删除任务 |

### C. Agent Harness 设计原则（Anthropic 2026）

1. Brain / Hands 解耦：Harness 是控制面，Sandbox 是可重建的执行面
2. Session 是 event log：不在 context window 内的持久化记录
3. Context Builder：每次 turn 动态组装高信号 context
4. Sandbox 不持有长期凭证
5. Trace / Eval 贯穿全流程

### D. 参考链接

- [Codex CLI Automations and Scheduled Tasks](https://codex.danielvaughan.com/2026/03/27/codex-cli-automations-scheduled-tasks/)
- [Codex exec JSONL Reference](https://codex.danielvaughan.com/2026/04/08/codex-exec-jsonl-reference/)
- [Codex as a Proactive Teammate](https://codex.danielvaughan.com/2026/05/15/codex-proactive-teammate-thread-automations-scheduled-monitoring-durable-views/)
- [Claude Code Scheduled Tasks](https://code.claude.com/docs/en/scheduled-tasks)
- [Claude Code Routines](https://code.claude.com/docs/en/routines)
- [Harness Engineering (OpenAI)](https://openai.com/index/harness-engineering/)
- [Anthropic Agent Harness Architecture](https://luhuidev.medium.com/anthropics-2026-agent-harness-architecture-from-agent-loop-to-agent-runtime-6da6db4f3f47)
- [Microsoft Agent Framework Harness](https://devblogs.microsoft.com/agent-framework/the-microsoft-agent-framework-harness-is-now-released/)

---

## 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2025-07-23 | v0.1 | 初稿：业界调研 + 架构分析 + 设计方案 + 实施路线 |
