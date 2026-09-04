# Terminal 资源管理与模型上下文设计

> 状态：设计草案，待评审  
> 日期：2026-08-22  
> 范围：`dev.terminal-manager`、`dev.terminal-enhanced`、Chat 消息上下文、Local Tools Session API

## 1. 结论先行

`dev.terminal-manager` 最终不应只是 Terminal Session 列表，而应成为 Zion 的执行环境管理器。
它管理三层对象：

```text
Machine
  └─ Workspace
       └─ Terminal Session
```

其中：

- **Machine** 表示本机或一台远程机器，是 CPU、内存、GPU、磁盘等资源的归属主体。
- **Workspace** 表示机器上的项目或工作目录，优先使用 Git 仓库根目录。
- **Terminal Session** 表示 Workspace 中一个可交互、可执行命令的短生命周期实例。

本设计作出以下核心决策：

1. 保留全局 `terminal.activeSessionId`，但只表示底部 Terminal Panel 当前显示的 Session。
2. 不增加 Chat 与 Terminal 的绑定模型。
3. 不再向每次模型请求注入最近 16 个 Session。
4. 每次请求注入紧凑但较完整的 Machine + Workspace 目录，使模型始终知道有哪些项目和机器。
5. 不增加“候选上下文层”或新的 `search_sessions` 工具。
6. 继续使用并改造现有 `terminalManage`：模型需要具体 Session 时，通过带过滤条件的 `list`
   等现有 action 获取。
7. Terminal Manager 统一拥有 Session API、标准化、资源目录和生命周期逻辑，其他插件不再各自
   直接拼接 `/sessions` 请求。
8. 第一阶段可从现有 Session 数据派生 Machine 和 Workspace；机器真实身份及 CPU/GPU 等信息
   在后续通过 Local Tools 的机器接口补齐。

---

## 2. 当前现状

### 2.1 真实数据规模

2026-08-22 从本地 `GET /sessions` 获取的数据：

| 指标 | 数量 |
|---|---:|
| Terminal Sessions | 165 |
| `active: true` | 148 |
| 可推断机器连接身份 | 6 |
| `Machine + cwd` 组合 | 100 |
| 超过 30 天无活动 | 37 |
| 同一机器、同一 CWD 最大 Session 数 | 22 |

这说明当前主要问题不是 Session 不够，而是大量 Session 缺少机器、项目和生命周期结构。

`active: true` 也不能解释为“用户正在使用”：本机 147 个 Session 全部为 `active: true`。
它更接近“服务端进程仍然存在或连接仍可用”。

### 2.2 当前服务端 Session 数据

当前 `/sessions` 返回的主要字段只有：

```ts
type RawTerminalSession = {
  id: string;
  type: "local" | "ssh";
  cwd?: string;
  last_activity?: number | string;
  active?: boolean;
  ssh_host?: string;
  ssh_user?: string;
  ssh_port?: number;
};
```

缺失的信息包括：

- 稳定 `machineId`
- 机器名称、系统、CPU、内存、GPU、磁盘
- `workspaceRoot`、Git 仓库和项目名称
- Session 创建时间、Shell、命令和用途
- Session 所有者，例如用户、Agent、Scheduler 或插件
- 精确生命周期，例如 busy、idle、disconnected、stale

### 2.3 当前 Terminal Manager

当前插件存在以下结构问题：

1. `session-tools.js` 超过 1300 行。
2. 文件前半部分保留了一套无人调用的旧浮层 `installTerminalManagerPanel()`。
3. Sidebar 将所有 Session 平铺，并按 `last_activity` 排序。
4. 本地 Session 标题主要来自 CWD basename，大量同名项无法区分。
5. Session 创建、刷新、关闭、重连和更新 CWD 的请求逻辑在以下位置重复：
   - `main.js` 的 `terminalManage` handler
   - `main.js` 的 commands
   - `session-tools.js` 的旧浮层
   - `session-tools.js` 的 Sidebar
6. `terminal.sessions` 被多个入口独立写入，容易产生覆盖和状态不一致。
7. “更多”按钮默认隐藏，只在 hover、focus 或 selected 时出现。
8. `set_cwd` 使用 `cd "${cwd}"` 拼接 Shell 命令，路径包含引号时会失败，并存在命令注入风险。
9. 当前测试只验证两个平铺 Session 和搜索，没有覆盖大规模列表、分组、陈旧 Session、
   机器识别和状态同步。

相关代码：

- `extensions/dev.terminal-manager/main.js`
- `extensions/dev.terminal-manager/session-tools.js`
- `extensions/dev.terminal-manager/styles.css`
- `tests/terminal-manager-sidebar.test.js`

### 2.4 当前 Chat 注入

当前 `extensions/dev.langchain-chat/terminal-context.js` 的行为是：

1. 读取 `terminal.activeSessionId`。
2. 读取 `terminal.sessions`。
3. 将 active Session 放在最前。
4. 其余 Session 按最近活动排序。
5. 默认最多注入 16 个，最大 32 个。
6. active Session 同时出现在 `<active_session>` 和 `<sessions>` 中。
7. 没有 active Session 时，从 `active: true` 的 Session 中推断最近一个。
8. 以普通 `user` 消息插入每次 Chat 请求。

因此当前并非真的注入全部 165 个 Session，但仍有以下问题：

- Terminal Panel 的 UI 焦点被误作 Agent 的执行选择。
- 所有 Chat 和 Panel 共用同一 active Session。
- 最近活动的 16 个 Session 不一定包含用户提到的项目。
- 同一个 Workspace 的重复 Session 占用多条上下文。
- 模型能看到 Session，却看不到完整机器和项目版图。
- SSH 地址、用户和路径被默认传给模型。

---

## 3. 目标和非目标

### 3.1 目标

Terminal Manager 应满足：

1. 用户可以先按机器、再按项目管理大量 Session。
2. 模型始终知道系统有哪些机器和项目，即使用户将项目名写错也有机会通过语义推断。
3. 模型不需要看到所有重复 Session。
4. 模型能从 Workspace 定位项目，并通过现有工具列出该项目的 Session。
5. Terminal Panel 的焦点切换不会污染其他 Chat 的执行上下文。
6. Agent 和 Scheduler 创建的 Session 有明确 owner、purpose 和清理策略。
7. 机器静态能力和动态负载可被 UI、Agent 和后续 Meta Agent 读取。
8. Session API 只有一个客户端和一个状态写入入口。

### 3.2 非目标

本阶段不做：

- 通用的万能 Resource Registry。
- 为每个 Chat 强制建立 Terminal Binding。
- 单独的“相关候选消息层”。
- 新增 `search_sessions` action。
- 在浏览器 `localStorage` 保存 CPU/GPU 历史曲线。
- 将 Terminal Manager 做成完整监控平台或进程管理器。
- 自动合并无法证明属于同一实体的 SSH 别名和 IP。

---

## 4. 领域模型

### 4.1 Machine

```ts
type TerminalMachine = {
  id: string;
  name: string;
  description: string;
  kind: "local" | "ssh";

  connection?: {
    host?: string;
    port?: number;
    user?: string;
    alias?: string;
  };

  system?: {
    hostname?: string;
    os?: string;
    arch?: string;
  };

  capacity?: {
    cpuCores?: number;
    memoryBytes?: number;
    diskBytes?: number;
    gpus?: Array<{
      id: string;
      name: string;
      memoryBytes?: number;
    }>;
  };

  usage?: {
    cpuPercent?: number;
    memoryUsedBytes?: number;
    diskUsedBytes?: number;
    gpus?: Array<{
      id: string;
      utilizationPercent?: number;
      memoryUsedBytes?: number;
    }>;
    observedAt: number;
    expiresAt: number;
  };

  status: "online" | "offline" | "unknown";
  sessionCount: number;
  workspaceCount: number;
  lastSeenAt?: number;
};
```

#### 第一阶段机器 ID

在服务端还没有稳定机器身份时：

```text
本机：local
SSH：ssh:<normalized-user>@<normalized-host>:<port>
```

这只能表达“连接身份”，不保证两个 SSH 地址不是同一台物理机器。

#### 最终机器 ID

Local Tools 后续应返回稳定机器 ID：

- 本机由 Local Tools 保存一个持久 UUID。
- SSH 优先使用远端机器指纹或受信任 agent ID。
- SSH config alias、主机名和 IP 作为连接方式，不作为最终实体 ID。
- 未拿到稳定指纹时，继续保留多个机器项，不能猜测合并。

### 4.2 Workspace

```ts
type TerminalWorkspace = {
  id: string;
  machineId: string;
  name: string;
  root: string;

  repository?: {
    type: "git";
    remote?: string;
    branch?: string;
  };

  sessionCount: number;
  availableSessionCount: number;
  staleSessionCount: number;
  lastActivityAt?: number;
};
```

Workspace 的推荐定义：

1. 优先使用 Git repository root。
2. 非 Git 目录使用规范化 CWD。
3. 同一 Git 仓库的子目录归并到同一个 Workspace。
4. Worktree 保持独立 Workspace，因为它拥有独立工作目录和分支状态。
5. 只有名称冲突时，消息目录才追加短路径提示。

第一阶段后端只有 CWD 时，可以先按 `machineId + normalized cwd` 分组。后续由 Local Tools
补充 `workspace_root`、`repo_name` 和 `repo_remote`，再平滑归并。

### 4.3 Terminal Session

```ts
type TerminalSession = {
  id: string;
  machineId: string;
  workspaceId: string;
  cwd: string;

  shell?: string;
  command?: string;
  purpose?: string;

  owner?: {
    type: "user" | "agent" | "scheduler" | "plugin";
    id?: string;
    runId?: string;
  };

  connectionStatus: "connected" | "disconnected" | "closed" | "unknown";
  activityStatus: "busy" | "idle" | "unknown";

  createdAt?: number;
  lastActivityAt?: number;
  pinned?: boolean;
};
```

必须拆开：

- `connectionStatus`：Session 是否仍能执行命令。
- `activityStatus`：Session 是否正在执行任务。
- `terminal.activeSessionId`：UI 当前显示哪个 Session。
- `stale`：根据最后活动时间派生的管理状态，不是服务端连接状态。

`active: boolean` 在兼容阶段仅映射到 `connectionStatus`，不得再解释为“当前使用中”。

---

## 5. 状态和所有权

### 5.1 状态总线

建议保留和新增：

```text
terminal.sessions
terminal.inventory
terminal.machineProfiles
terminal.activeSessionId
```

其中：

```ts
type TerminalInventory = {
  version: 1;
  revision: string;
  generatedAt: number;
  machines: TerminalMachine[];
  workspaces: TerminalWorkspace[];
};
```

- `terminal.sessions`：标准化后的 Session 数组，兼容现有消费者。
- `terminal.inventory`：Machine 和 Workspace 的派生只读视图。
- `terminal.machineProfiles`：由 Local Tools 持久化的机器名称和描述。
- `terminal.activeSessionId`：底部 Terminal Panel 当前焦点。

`terminal.inventory` 不复制 Session 全量内容，只保留 Machine 和 Workspace 聚合统计。

### 5.2 单一写入入口

`dev.terminal-manager` 是 Terminal Session 和 Inventory 的前端所有者：

```text
Local Tools API
  -> terminal-service
  -> normalize sessions
  -> publish terminal.sessions
  -> derive terminal.inventory
  -> publish terminal.inventory
```

其他插件：

- 可以读取 `terminal.sessions` 和 `terminal.inventory`。
- 创建、关闭、重连和更新 Session 必须调用 commands 或 `terminalManage`。
- 不应直接请求 `/sessions` 后再写 `terminal.sessions`。

### 5.3 `terminal.activeSessionId`

保留它的原因是底部 Terminal Panel 需要一个全局焦点：

```text
terminal.activeSessionId = 用户当前在 Terminal Panel 中查看和交互的 Session
```

它只服务 Terminal UI，不进入模型上下文，也不参与 Agent 的 Session 选择。

### 5.4 终端感知工具的执行目标

`Bash`、`terminalExecute`、`tree`、`read`、`write`、`edit`、`glob` 和 `grep`
必须显式携带 `session_id`。工具 Schema 和 Handler 都要执行该约束；缺失时返回错误，
提示模型使用 Terminal Inventory 中匹配 Workspace 的 `preferred_session_id`，或调用
`terminalManage action=list` 获取具体 Session。

`machine_id`、`workspace_id` 和 `session_id` 必须严格区分：

- `machine_id`：机器标识，例如 `machine:local`，只能用于 `terminalManage` 的机器查询、
  更新或 Session 列表过滤。
- `workspace_id`：项目/工作目录标识，例如 `workspace:...`，只能用于筛选或创建 Session。
- `session_id`：某个具体终端会话的标识，只有它可以传给 `Bash`、`terminalExecute`
  和文件类终端工具。

`local` 和 `ssh` 是 Session 类型，不是 `session_id`。工具入口必须拦截 `local`、`ssh`、
`machine:*`、`workspace:*` 这类误填值，并返回可用的 `session_id` 候选，避免请求到底层
执行接口后才得到 `session not found`。

禁止从 `terminal.activeSessionId`、最近使用 Session 或第一个可用 Session 自动补全
工具参数。Edit/Write 工具卡的接受与回退也必须复用原调用记录的
`executionContext.terminalSession.id`，旧记录缺少执行目标时应拒绝操作。

浏览器 File System Access 支持的 `fsRead`、`fsWrite`、`fsEdit` 和 `fsTree`
由用户授权句柄确定目标，不属于终端感知工具，不要求 `session_id`。

---

## 6. 模型消息上下文

### 6.1 最终策略

每次模型请求只注入：

1. 完整但紧凑的 Machine 目录。
2. 完整但紧凑的 Workspace 名称目录。
3. 每个 Machine 和 Workspace 的 Session 数量。
4. 每个有可用 Session 的 Workspace 至少一个 `preferred_session_id`。
5. 如何调用现有 `terminalManage` 的简短说明。

不注入：

- 所有 Session 行。只注入每个 Workspace 的首选可用 Session，避免上下文膨胀。
- 相关候选层。
- Terminal Panel 当前 active Session。
- Session 命令历史或输出。
- SSH 密钥、Token 等机密。
- 默认情况下的完整 SSH 地址和用户。

### 6.2 示例

```xml
<terminal_inventory
  version="1"
  revision="8f2c"
  machine_count="6"
  workspace_count="100"
  session_count="165">
  <instructions>
    Workspace names may approximately match user wording.
    Use a workspace preferred_session_id directly for Bash/terminalExecute/read/write/edit/glob/grep/tree when it matches the intended project.
    session_id means a concrete terminal session id. Do not use machine_id, workspace_id, or type values such as local/ssh as session_id.
    Use terminalManage action=list with a machine_id or workspace_id only when no suitable preferred_session_id is visible or a different session is needed.
  </instructions>

  <machine
    machine_id="machine:local"
    name="本机"
    status="online"
    sessions="147"
    available="147"
    disconnected="0"
    workspaces="85"
    preferred_session_id="local-abc123">
    <description>暂无机器资源信息。请检测后通过 terminalManage 的 update_machine action 覆盖此描述。</description>
    <workspace
      workspace_id="workspace:local:zion-next"
      name="zion-next"
      sessions="3"
      available="3"
      disconnected="0"
      preferred_session_id="local-abc123" />
    <workspace
      workspace_id="workspace:local:zion-local-tools"
      name="zion-local-tools"
      sessions="22"
      available="22"
      disconnected="0"
      preferred_session_id="local-def456" />
  </machine>

  <machine
    machine_id="machine:gpu-dev"
    name="GPU 开发机"
    status="online"
    sessions="10"
    available="8"
    disconnected="2"
    workspaces="8"
    preferred_session_id="ssh-abc123">
    <workspace
      workspace_id="workspace:gpu-dev:video-generation"
      name="video-generation"
      sessions="4"
      available="1"
      disconnected="3"
      preferred_session_id="ssh-abc123" />
  </machine>
</terminal_inventory>
```

### 6.3 为什么注入项目目录

模型处理用户输入时拥有完整项目名称，可以完成：

- 将拼写错误映射到正确项目。
- 根据对话语义区分相似项目。
- 知道项目位于本机还是远程机器。
- 知道已有多少 Session。
- 知道可直接用于执行工具的首选 `session_id`。
- 在首选 Session 不匹配时，知道可以调用工具列出该项目的具体 Session。

这保留了当前“用户提到项目名，模型马上知道相关终端”的体验，但不再依赖最近 16 个 Session
恰好包含目标项目。

### 6.4 上下文预算

目录构建遵循以下压缩顺序：

1. 优先保留策略通过 `allowedTerminalSessionIds` 显式指定的 Session 所属 Machine 和
   Workspace。
2. 对无歧义 Workspace 省略完整路径。
3. 对同名 Workspace 增加短路径或仓库信息。
4. 省略静态未知字段。
5. 机器资源使用紧凑单位，不注入完整指标对象。
6. 其余项按本机优先、最近活动优先的稳定顺序裁剪。

自动上下文默认最多包含 8 台 Machine、全局 24 个 Workspace、每台 Machine 12 个
Workspace。显式指定 Session 的父级资源不受名义上限影响。根节点通过 `truncated`、
`total_machine_count`、`total_workspace_count` 和 `total_session_count` 报告裁剪状态；
完整目录仍可通过 `terminalInventory` 或 `terminalManage action=list` 按需查询。

### 6.5 注入方式与安全

Terminal Inventory 由 Zion 在发送请求前作为独立上下文块加入消息，不与用户输入文本混写。
具体映射到不同模型协议的方式由 Chat 层处理，不作为 Terminal Manager 的领域概念。

要求：

- 对 Workspace 名称、路径和机器标签进行 XML 转义、长度限制和控制字符清理。
- 明确告诉模型这些字段是数据，不是可执行指令。
- 机器目录默认展示用户可识别别名，不展示 SSH 密钥、完整连接参数和其他凭据。

### 6.6 上下文所有权

`dev.terminal-manager` 应拥有 Inventory 的构建逻辑，并通过 Message Contributor 或后续
Context Provider 提供结构化上下文。

`dev.langchain-chat` 不应长期了解 Terminal Session 的字段和选择策略。它只负责组合已注册的
消息上下文。

---

## 7. `terminalManage` 改造

### 7.1 保留 action，不新增搜索层

继续保留：

```text
create
list
get
close
reactivate
set_cwd
list_machines
get_machine
update_machine
```

扩展可选参数：

```ts
type TerminalManageArgs = {
  action:
    | "create"
    | "list"
    | "get"
    | "close"
    | "reactivate"
    | "set_cwd"
    | "list_machines"
    | "get_machine"
    | "update_machine";

  session_id?: string;
  machine_id?: string;
  name?: string;
  description?: string;
  workspace_id?: string;
  status?: "connected" | "disconnected" | "stale";
  limit?: number;

  cwd?: string;

  // 兼容旧调用
  type?: "local" | "ssh";
  ssh_host?: string;
  ssh_user?: string;
  ssh_port?: number;
  initial_cwd?: string;
};
```

### 7.2 `list`

推荐行为：

```ts
terminalManage({
  action: "list",
  workspace_id: "workspace:local:zion-next",
  limit: 20
});
```

返回：

```json
{
  "session_id_field": "Use sessions[].session_id for Bash/terminalExecute/read/write/edit/glob/grep/tree. Do not use machine_id, workspace_id, local, or ssh as session_id.",
  "total": 3,
  "returned": 3,
  "truncated": false,
  "sessions": [
    {
      "session_id": "abc123",
      "id": "abc123",
      "session_type": "local",
      "machine_id": "machine:local",
      "workspace_id": "workspace:local:zion-next",
      "connection_status": "connected",
      "cwd": "/Users/.../zion-next",
      "last_activity_at": 1787381828
    }
  ]
}
```

约束：

- 无过滤条件时也允许调用，但默认返回数量有限的最近 Session。
- 返回 `total`、`returned` 和 `truncated`。
- 每条 Session 必须显式返回 `session_id`，可以保留兼容用 `id`，但模型提示以
  `sessions[].session_id` 为准。
- 返回中必须说明 `machine_id`、`workspace_id`、`local` 和 `ssh` 不能作为 `session_id`。
- 默认 `limit` 为 20，设置合理最大值。
- 不默认返回 SSH 凭据和无关字段。
- 输出顺序稳定，方便模型和测试判断。

### 7.3 `create`

推荐调用：

```ts
terminalManage({
  action: "create",
  machine_id: "machine:gpu-dev",
  workspace_id: "workspace:gpu-dev:video-generation"
});
```

Terminal Manager 根据机器和 Workspace 解析：

- local 或 ssh
- SSH alias、host、user、port
- initial CWD

模型不需要重新拼装连接参数。

旧的 `type + ssh_host + ssh_user + ssh_port + initial_cwd` 在迁移阶段继续支持。

### 7.4 `get`

`get` 保持按 `session_id` 获取单个 Session，但返回标准化对象，并明确：

- Machine
- Workspace
- 连接状态
- 活动状态
- owner 和 purpose
- 创建与最后活动时间

### 7.5 `close` 和 `reactivate`

保持现有能力，但需要：

- 操作后统一刷新 Session 和 Inventory。
- 不允许各调用方自行修改 `terminal.sessions`。
- `close` 返回被关闭 Session 的身份。
- 关闭 active Session 时，由 Terminal Panel 选择下一个可用 Session。

### 7.6 `get_machine` 和 `update_machine`

- `list_machines` 一次返回全部机器描述和 Session、Workspace 聚合信息。
- `get_machine + machine_id` 返回机器描述及当前 Session、Workspace 聚合信息。
- `update_machine + machine_id` 修改机器显示名称和描述。
- 描述最大 500 字符，由 Local Tools 持久化。
- 未配置描述时使用明确的待检测提示，使模型知道可以检测环境并回写。
- 机器档案不依赖 Session 存活；全部 Session 关闭后仍然保留。

### 7.7 `set_cwd`

目标设计必须使用结构化后端接口：

```text
PATCH /sessions/{id}
{
  "cwd": "/path"
}
```

不能继续通过字符串拼接执行：

```sh
cd "${cwd}"
```

如果后端暂时没有 PATCH 接口，兼容层必须使用严格的 Shell 参数编码，并尽快移除。

### 7.8 Tool 描述

Tool 描述应明确：

- Machine 和 Workspace 目录已经在消息上下文中。
- 需要具体 Session 时，使用 `list + workspace_id`。
- 不应无条件调用无过滤 `list`。
- 执行危险命令前必须确认 Machine、Workspace 和 Session。

---

## 8. Sidebar 设计

### 8.1 信息架构

默认视图：

```text
终端                                      +  ···
搜索机器、项目或终端

▾ 本机                                  147
  CPU 18% · 内存 21/64G
  ▾ zion-next                              3
      dev server                         1m
      Agent · 修复调度器                 12m
  ▸ zion-local-tools                      22
  ▸ restyle-case                           9

▾ GPU 开发机                              10
  GPU 74% · 显存 42/80G
  ▸ video-generation                       4

▸ 已断开                                  17
▸ 陈旧会话                                37
```

设计规则：

- 默认只展开机器和常用 Workspace。
- Session 仅在 Workspace 展开后渲染。
- 不使用卡片。
- 不显示“运行中”等冗余文字。
- 状态通过图标、颜色和弱化透明度表达。
- Machine、Workspace 和 Session 行右侧垂直三点始终显示。
- 搜索匹配机器名称、Workspace 名称、路径和 Session ID。
- 大量 Session 使用按组延迟渲染或虚拟列表。

### 8.2 Toolbar

Toolbar 只保留：

- 搜索
- 新建 Terminal
- 页面级垂直三点菜单

刷新可以放入页面级菜单，或在连接异常时显示。

当前“注入上下文”Checkbox 从 Sidebar 移除。Terminal Inventory 是系统上下文能力，不应让用户
在 Session 管理列表中控制。若需要隐私开关，应放入 Terminal 设置中。

### 8.3 Machine 行

显示：

- 名称
- 状态图标
- Session 数
- 紧凑资源摘要

菜单：

- 新建 Terminal
- 刷新机器信息
- 重命名显示名称
- 关闭空闲 Session
- 查看详情

### 8.4 Workspace 行

显示：

- 项目名称
- Session 数
- 最近活动或异常状态

菜单：

- 新建 Terminal
- 打开 Files
- 关闭空闲 Session
- 复制路径

### 8.5 Session 行

显示：

- purpose 或简短名称
- 最近活动时间
- 连接、忙碌或断开状态
- owner 图标

菜单：

- 在 Terminal Panel 中打开
- 固定
- 重连
- 修改工作目录
- 关闭

点击 Session 时才更新 `terminal.activeSessionId` 并在 Terminal Panel 中显示。

### 8.6 陈旧 Session

`stale` 是客户端派生状态：

- 默认阈值建议为 30 天。
- 陈旧 Session 放入折叠分组。
- 支持预览后批量关闭。
- 用户 Session 不应在第一阶段自动删除。
- Agent/Scheduler 临时 Session 后续可根据 owner 策略自动释放。

---

## 9. Machine 资源采集

### 9.1 当前已实现

- Machine 连接身份和 Session/Workspace 聚合由 Terminal Manager 派生。
- Local Tools 通过 SQLite 持久化机器显示名称和描述。
- `GET /machines`、`GET /machines/{id}` 和 `PATCH /machines/{id}` 已提供。
- 未填写描述时，Inventory 使用明确的待检测提示。
- CPU、内存、GPU 和磁盘的自动采集仍属于下一阶段。

### 9.2 后端目标接口

建议 Local Tools 提供：

```text
GET /machines
GET /machines/{id}
PATCH /machines/{id}
GET /machines/{id}/metrics
```

机器详情包括：

- 稳定 ID
- hostname、OS、arch
- CPU 型号和核数
- 总内存
- GPU 名称、数量和显存
- 磁盘容量
- 支持的能力，例如 shell、gpu、docker

动态指标包括：

- CPU 使用率
- 内存使用量
- GPU 利用率和显存
- 磁盘使用量
- observedAt 和 expiresAt

### 9.3 采集原则

- 静态清单长时间缓存。
- 动态指标仅保留最新快照。
- 展开的机器高频刷新，后台机器低频刷新。
- 离线时保留最后一次快照并标记 stale。
- 不向 `localStorage` 写指标历史。
- 若未来需要历史图表，由专门监控存储负责。

---

## 10. Session 生命周期

### 10.1 用户 Session

- 默认持久保留。
- 用户可固定。
- 长期未使用时进入陈旧分组。
- 批量关闭前展示影响范围。

### 10.2 Agent Session

Agent 创建时写入：

```ts
owner: {
  type: "agent",
  id: agentId,
  runId
}
purpose: "修复 Scheduler 重复运行"
```

策略：

- 优先复用同 Machine、同 Workspace 的可用 Session。
- Run 完成后释放临时 Session。
- 若 Session 被用户固定，则不自动关闭。
- Run 记录引用 `terminalSessionId`，但 Terminal Manager 不复制 Run 历史。

### 10.3 Scheduler Session

- 默认按 Run 临时创建或租用。
- 执行结束后释放。
- 异常退出后由租约超时清理。
- 不允许无限累积为永久 Session。

---

## 11. 模块拆分

推荐目录：

```text
extensions/dev.terminal-manager/
  main.js
  terminal-service.js
  terminal-inventory.js
  terminal-context.js
  terminal-sidebar.js
  styles.css
  manifest.json
```

职责：

| 模块 | 职责 |
|---|---|
| `main.js` | 激活、commands、tool schema、状态发布 |
| `terminal-service.js` | 唯一 Local Tools HTTP 客户端 |
| `terminal-inventory.js` | 标准化以及 Machine/Workspace 分组 |
| `terminal-context.js` | 构建受限、转义后的模型目录 |
| `terminal-sidebar.js` | 树形 UI 和交互 |

现有 `installTerminalManagerPanel()` 删除，不再保留两套界面。

`dev.terminal-enhanced` 继续负责：

- Terminal Panel
- PTY 交互
- 当前 active Session 的显示

`dev.terminal-manager` 负责：

- Session 生命周期
- Machine/Workspace Inventory
- 管理 UI
- 管理工具
- 模型上下文目录

---

## 12. 迁移计划

### 阶段 1：统一数据层

1. 提取 `terminal-service.js`。
2. 所有请求收口到 service。
3. 删除无人调用的旧浮层。
4. 修复 `set_cwd` 参数安全。
5. 保持当前 UI 行为不变，先建立回归测试。

### 阶段 2：Inventory

1. 增加纯函数 `buildTerminalInventory(sessions)`。
2. 派生 Machine 和 Workspace。
3. 发布 `terminal.inventory`。
4. 增加 165 个 Session 规模的性能和稳定排序测试。

### 阶段 3：Sidebar

1. 改为 Machine -> Workspace -> Session 树。
2. 增加陈旧分组和批量管理。
3. 固定显示垂直三点。
4. 移除 Sidebar 的上下文 Checkbox。

### 阶段 4：消息上下文

1. Terminal Manager 构建 Machine + Workspace 目录。
2. 从 LangChain Chat 移除 Session 选择细节。
3. 将 Inventory 作为独立上下文块注入。
4. 移除最近 16 个 Session 的注入。

### 阶段 5：`terminalManage`

1. `list` 支持 `machine_id`、`workspace_id`、`status` 和 `limit`。
2. `create` 支持 Machine 和 Workspace。
3. 输出标准化、限长并标记截断。
4. 保留旧参数兼容。

### 阶段 6：机器资源

1. Local Tools 增加稳定 Machine ID。
2. 增加系统清单和动态指标接口。
3. 接入 CPU、内存、GPU 和磁盘。
4. 提供给 UI、Agent 和 Meta Agent。

---

## 13. 验收标准

### 数据

- 165 个 Session 能稳定归并为 Machine 和 Workspace。
- 同机器、同 Workspace 不重复。
- Session 顺序和 preferred Session 选择可重复测试。
- SSH alias 和 IP 在没有指纹时不被错误合并。

### UI

- 默认 DOM 不渲染全部 165 个 Session 行。
- Machine、Workspace、Session 层级清晰。
- 搜索能定位机器、项目、路径和 Session。
- 垂直三点始终可见。
- 陈旧 Session 不占据主列表。
- 当前 active Session 状态清晰但无冗余状态文案。

### 模型上下文

- 模型能看到全部 Machine 和 Workspace 名称。
- 上下文不包含全部 Session 行。
- 用户写错项目名时，模型仍能从目录中进行语义推断。
- Terminal Panel 当前 active Session 不进入模型上下文。
- 输出经过转义、限长和敏感字段过滤。
- 当前规模的 Inventory 控制在约 2000-3000 tokens。

### Tool

- `list` 不再无界返回全部 Session。
- `list + workspace_id` 能返回该项目 Session。
- `create + machine_id + workspace_id` 能解析连接和目录。
- `set_cwd` 不再拼接不安全 Shell 字符串。
- 所有操作后由统一数据层刷新状态。

### 生命周期

- 用户 Session 不被自动误删。
- 陈旧 Session 可预览和批量关闭。
- Agent/Scheduler Session 可以记录 owner 和 purpose。
- 关闭 active Session 后能选择合理替代项。

---

## 14. 已排除方案

### 仅用 Core 精确匹配项目名

排除原因：用户可能拼错项目名。模型需要看到项目目录，才能结合自然语言和对话语义判断。

### 注入相关候选层

排除原因：增加额外机制和状态。完整紧凑目录已经足以让模型识别项目。

### 新增 `search_sessions`

排除原因：现有 `terminalManage.list` 增加过滤参数即可，没有必要新增概念相近的 action。

### 继续注入最近 Session

排除原因：最近活动不等于当前任务相关，同 Workspace 重复 Session 还会浪费上下文。

### 删除 `terminal.activeSessionId`

排除原因：底部 Terminal Panel 确实需要全局焦点。问题是职责越界，不是字段本身无用。

### 直接建立通用 Resource Registry

排除原因：当前问题可以由 Terminal 领域模型解决。只有未来多个插件需要共同注册机器资源时，
再评估 Core 层机器注册能力。

---

## 15. 待评审决策

当前建议如下：

| 决策点 | 建议 |
|---|---|
| Workspace 定义 | Git root 优先，非 Git 使用规范化 CWD |
| Worktree | 保持独立 Workspace |
| 是否注入全部 Workspace 名称 | 是，路径按需压缩 |
| `terminalManage` | 改造现有 action，不新增搜索 action |
| 终端感知工具执行目标 | `session_id` 必填，禁止回退到 `terminal.activeSessionId` |
| Machine ID | 第一阶段连接身份，后续迁移到稳定指纹 |
| CPU/GPU | 后端提供快照，浏览器不保存历史 |

这些决策确认后，第一轮实现应只做“统一数据层 + Inventory + 树形 Sidebar”，不同时引入
机器监控、租约和 Agent 调度，以控制改动范围。
