# Zion 用户中心平台方向 Handoff

- 状态：Discussion handoff，供后续设计与实现继续使用
- 日期：2026-09-13
- 范围：Zion Runtime、Workbench、Mobile、Device/local-tools、MCP、Memory、Artifact 与 Virtual Workspace
- 相关文档：
  - `docs/product/ZION-MULTI-NODE-PLATFORM-STRATEGY.md`
  - `docs/architecture/ZION-DISTRIBUTED-RUNTIME-PRODUCT-ARCHITECTURE.md`
  - `docs/architecture/MULTI-NODE-TERMINAL-ROUTING.md`
  - `docs/architecture/RUNTIME-LOCAL-TOOLS-BOUNDARY.md`

## 0. 本次讨论的方向修正

此前架构讨论主要从 Runtime、Node、Resource 和多机调度出发。后续应改为：

```text
用户场景
  -> 产品承诺
  -> 用户可见的状态与操作
  -> 数据所有权和安全边界
  -> 内部架构
  -> 具体代码实现
```

目标不是让普通用户理解分布式 Agent 基础设施，而是让用户获得一个始终可访问、
可以安全使用其资料和计算资源的智能工作空间。

产品北极星：

> 用户登录 Zion 后，Agent、会话、记忆和任务始终存在。无论从手机、网页、电脑、
> CLI 或其他 Agent 进入，都可以继续工作；需要本地或企业资料时，Zion 在授权范围
> 内使用正确的数据位置。设备离线时，系统明确等待、使用允许的副本或提示用户，
> 不静默切换到错误数据。

技术用户仍可查看 Node、Resource、Capability、Revision 和 Placement；普通用户不应
被迫理解这些概念。

## 1. 用户看到的产品，而不是基础设施

| 用户产品 | 用户认知 | 内部职责 |
| --- | --- | --- |
| Zion Web / Workbench | 完整工作空间 | Runtime Client、协作编辑和管理界面 |
| Zion Mobile | 对话、任务、审批、通知和结果 | Mobile Client |
| Zion Desktop | “让 Zion 使用这台电脑” | Device Agent、local tools、审批和自动更新 |
| Zion Server | “把这台服务器连接到 Zion” | Headless Device Agent |
| Zion Cloud | 电脑关闭后仍可工作 | 托管 Runtime Cell、模型、CPU/GPU 和存储 |
| Zion CLI / API / Skill | 让人或其他 Agent 使用 Zion | Service Account、Task API 和事件接口 |

普通个人用户默认只有一个“我的 Zion”。`Space` 在个人模式中隐藏，在团队模式中
显示为“工作区”。

建议普通用户只看到：

- Agent；
- 对话；
- 任务；
- 已连接的设备；
- 已连接的资料；
- 云端算力；
- 权限与审批；
- 套餐与用量。

以下术语保留为内部或高级模式概念：

- Runtime Host；
- Node；
- Resource；
- Capability；
- Replica；
- Placement；
- Attempt；
- lease 和 receipt。

## 2. 首次使用的目标路径

理想的普通用户路径：

1. 打开网页或 App 并登录；
2. 立即获得托管 Runtime、基础模型和跨端会话；
3. 需要本机资料时点击“连接这台电脑”；
4. Desktop 安装 Device Agent，用户选择允许访问的目录和能力；
5. 需要服务器时复制一条安装命令并输入一次性配对码；
6. 需要更强模型、更多并发或 GPU 时直接购买额度；
7. 在手机上继续对话、审批高风险操作并查看结果。

产品目标：

- 首次登录到第一次有效对话少于一分钟；
- 连接一台电脑或服务器少于三分钟；
- 普通用户界面不出现 `node_id`、`resource_id`、`session_id`；
- 浏览器关闭不导致后台任务消失；
- 设备离线不能被误报为文件不存在或工具成功；
- 同一任务可在 Web、Desktop 和 Mobile 上观察与继续。

## 3. Runtime 的产品含义

### 3.1 Runtime 不是一台固定服务器

用户拥有的是一个逻辑 Runtime，而不是一台永久分配的机器：

```text
一个 User/Space 一个逻辑 Runtime
不等于
一个 User/Space 一台常驻服务器
```

物理 Runtime Cell 可以：

- 有 Run 时启动；
- 空闲后休眠；
- 从持久状态恢复；
- 在主机之间迁移；
- 按套餐限制并发和保温时间；
- 将重计算任务委派给独立 CPU/GPU Worker。

Agent Loop 通常是 I/O 密集型，不需要为每位用户分配 GPU。GPU 只应按任务用于本地
模型、视频、图像、训练或评测。

### 3.2 当前远程 Runtime 是组合部署

当前单机 Runtime 同时承担：

- 公网 API；
- Access Control；
- Session 与 Run；
- Agent Loop；
- Model Gateway；
- SSE；
- Node Broker；
- Device Service HTTP relay；
- Runtime Plugin；
- Workbench state；
- SQLite 持久化。

这适合单 Owner POC，不适合直接作为多用户服务。未来外部仍可只有一个 Zion URL，
但内部应拆分逻辑职责：

```text
Workbench / Mobile / CLI / Agent API
                  |
           Public API Gateway
                  |
      +-----------+-------------+
      |           |             |
Control Plane  Event Gateway  Device Gateway
      |           |             |
      |           |          Connectors
      |
  Scheduler ---- Runtime Cell Pool
                  |
        Model Gateway / Job Workers

Session/Run metadata -> PostgreSQL
Transient dispatch  -> Redis or durable queue
Large bytes         -> Object/Artifact Store
```

### 3.3 默认资源和商业分层

不应为每位注册用户预留常驻进程或固定 CU。建议：

| 套餐 | Runtime 行为 |
| --- | --- |
| Free | 共享 Cell、单 Run、可排队、快速休眠 |
| Personal Pro | 更高并发、更长保温时间、更多存储 |
| Team | Space 隔离、共享任务、审批、审计和预算 |
| Dedicated | 独立 Cell、固定区域、企业策略或 BYOC |
| Managed Compute | CPU/GPU Job 按规格和时长计费 |

模型费用、托管 Runtime、GPU、存储和 Artifact 流量可以分别计量。普通设备数量不应
成为主要收费轴。

## 4. 网络 I/O 与扩展原则

单机未来的主要瓶颈很可能不是 Agent 推理，而是：

- SSE/WebSocket 长连接；
- Connector 长轮询或持久连接；
- 模型流式响应代理；
- 文件上传和下载；
- 插件包分发；
- PTY/WebRTC relay；
- 大型 Tool Result；
- 多端协作文档更新。

必须把控制面和大数据面分开：

- 大文件通过签名 URL 在 Device、Client 和对象存储之间传输；
- 插件包通过对象存储和 CDN 分发；
- 大型 Tool Result 转成 Artifact，只在 Event 中返回摘要和 ID；
- 文件变更优先传 Patch，而不是完整目录；
- PTY 优先点对点，Relay 使用独立可扩展服务；
- 模型流量由独立 Model Gateway 处理；
- Device Gateway 单独维护 Connector 连接和 Presence；
- Runtime Cell 只处理 Agent 状态、上下文和小型控制消息。

在多用户开放前，最低限度需要：

- 每 User/Space 并发限制；
- Run 队列和背压；
- API rate limit；
- 请求体、结果体和上下文大小限制；
- 每类流量的 bytes、连接数、延迟和错误率指标；
- Model、Device、Artifact 的独立熔断；
- 任务不能因为子工具失败而上报成功。

## 5. 数据可用性是核心问题

多 Node 只能解决“在线时应该去哪台机器”，不能解决“关机后资料是否存在”。

物理事实：

> 如果资料只存在于一台已关机的电脑上，任何调度系统都无法继续读取它。

每个重要资料源都必须选择一种可用性策略：

| 用户选项 | 内部语义 | 离线行为 |
| --- | --- | --- |
| 仅设备在线时使用 | `exclusive-local` | Run 进入 `waiting_for_resource` |
| 随时可读 | `replicated-readonly` | 使用带时间和 revision 的只读副本 |
| 随时继续工作 | `portable-workspace` | 使用可写云副本，随后同步或合并 |
| 云服务资料 | `cloud` | 通过服务端 OAuth/API 访问 |

用户不需要看到 consistency 枚举，但必须看到清晰状态：

```text
季度规划
权威位置：工作电脑
当前副本：2026-09-13 10:32
状态：设备离线，正在使用只读副本
```

禁止：

- 把设备离线误报成文件不存在；
- 静默切换到同路径的另一台机器；
- 使用旧副本而不显示新鲜度；
- 在不知道 base revision 时覆盖重新上线的设备数据。

### 5.1 企业资料

企业数据可能禁止上传个人云。此时应在企业网络内部署常开的 Zion Gateway 或
Resource Host：

```text
Mobile / Web
  -> Zion Runtime
    -> Enterprise Gateway
      -> Git、文档、数据库、GPU、内网 API
```

员工笔记本关闭后，共享企业资料仍可用；未同步的个人本地内容明确等待设备。

## 6. Resource 的当前定义

### 6.1 Resource 不是 TerminalSession

`TerminalSession` 是短生命周期、有状态的执行句柄：

- Connector 重启后可能失效；
- SSH 重连可能产生新 Session；
- cwd、环境变量和进程不断变化；
- 不适合作为项目、资料或记忆的长期身份。

合理关系：

```text
Resource
  -> Replica / Attachment
    -> TerminalSession
```

### 6.2 近期只实现 Workspace Resource

当前 Zion 尚未正式接入数据库、浏览器身份、云盘或 GPU Resource，因此第一阶段可以
只实现文件系统 Workspace：

```text
ResourceLocator = nodeId + canonicalRootPath
ResourceId      = 为该 locator 生成并持久化的稳定 ID
```

示例：

```json
{
  "resourceId": "workspace:abc123",
  "nodeId": "work-mac",
  "kind": "workspace",
  "root": "/Users/me/work/project-a"
}
```

约束：

- Resource 边界是 Connector 授权的 workspace root，不是任意文件路径；
- 文件使用 Resource 内相对路径；
- cwd 变化不创建新 Resource；
- 不同 `nodeId + root` 默认是不同 Resource；
- 两台机器上的同一个 Git 仓库，第一阶段仍视为不同 Resource；
- 以后只有在 revision、remote 和同步规则明确后，才把它们关联为同一 Resource 的
  多个 Replica。

当前 global terminal reference 是第一阶段精确路由句柄，可以继续使用，但不应成为
未来数据模型的中心。

## 7. Memory Store、Artifact Store 与本地资料

### 7.1 三类存储

| 存储 | 用途 | 示例 |
| --- | --- | --- |
| Memory Store | 小型、可查询、持续更新的权威状态 | Identity、偏好、memory events、project memory |
| Artifact Store | 大型、基本不可变的内容 | 文件、图片、视频、Patch、报告、模型结果、备份 |
| Resource Source | 用户原始资料的权威位置 | 工作电脑目录、Git 仓库、企业系统 |

Artifact Store 不是 Memory Store。它可以保存 Memory 导出包和历史快照，但不应直接
承担高频 append、去重、版本冲突和查询。

### 7.2 dev.identity 当前状态

当前本地布局：

```text
~/.zion-next/memory/
├── identity.md
├── user.md
├── biography/events.jsonl
├── biography/digest.md
└── projects/*.md
```

当前语义：

- `events.jsonl` 是完整 Biography 的事实源；
- `digest.md` 是可重建投影；
- Workbench 会把部分渲染后的 Identity snapshot 同步到 Runtime KV；
- 本地读取失败时可以使用 Runtime snapshot 降级；
- Runtime snapshot 不包含完整 `events.jsonl`；
- 新事件的追加和完整历史查询仍依赖本地文件；
- 电脑关机时数据不是被删除，而是权威事件源不可访问；
- 电脑损坏或丢失时，未备份事件可能永久丢失。

因此当前 Runtime snapshot 是缓存和兼容路径，不是完整的云端权威 Memory。

### 7.3 Identity/Memory 目标模型

```text
Identity Memory Service
├── identity profile       versioned document
├── user profile           versioned document
├── biography events       append-only canonical event stream
├── project memories       scoped structured records
├── citations              provenance relationships
└── digest                 rebuildable projection

Artifact Store
├── uploaded source files
├── large attachments
├── generated reports
└── versioned Memory exports/backups

Local ~/.zion-next/memory
└── optional mirror, export and editing surface
```

逻辑权威归属应是 User/Space 的 Control Plane Memory Service，不是某个会休眠或迁移的
Runtime Cell。当前可先使用 Runtime 所在机器的 SQLite 实现接口，后续迁移 PostgreSQL，
但业务代码不能依赖具体数据库。

核心约束：

- 一类数据只有一个逻辑权威源；
- `eventId` 保证 append 幂等；
- Profile 写入使用 `expectedRevision`；
- 本地和云端不能成为无冲突策略的双主；
- 每条 Memory 保留 `sourceSessionId`、`sourceRunId`、来源和时间；
- digest、标签、全文索引和向量索引均可重建；
- 支持用户查看、修改、导出、删除和保留策略；
- 企业可以使用私有部署、租户密钥或禁止云副本。

## 8. Virtual Workspace / Virtual File System

### 8.1 目的

`project.md`、Identity 文件和很多知识内容仍然适合文件式交互。模型、Skill 和开发者
已经熟悉：

- `read`
- `write`
- `edit`
- `append`
- `glob`
- `grep`
- `tree`
- `Bash`

因此应在物理存储之上增加一个带权限、版本、来源和可用状态的文件语义层：

```text
/
├── memory/
│   ├── identity.md
│   ├── user.md
│   └── biography/
│       ├── events.jsonl
│       └── digest.md
├── projects/
│   └── zion/
│       ├── project.md
│       └── decisions.md
├── artifacts/
│   └── runs/...
└── devices/
    └── work-mac/...
```

调用方使用统一路径，底层可以不同：

| 虚拟路径 | 后端 |
| --- | --- |
| `/memory/identity.md` | Memory DB 中的版本化文档 |
| `/memory/biography/events.jsonl` | Event Store 序列化视图 |
| `/memory/biography/digest.md` | 自动生成投影 |
| `/projects/*/*.md` | 文档数据库或对象存储 |
| `/artifacts/*` | S3-compatible Artifact Store |
| `/devices/*` | Connector 上的真实文件系统 |

### 8.2 events.jsonl 可以是虚拟文件

保留文件交互，不要求物理上继续是 JSONL 文件：

```text
read events.jsonl
  -> 查询事件表并序列化

append events.jsonl
  -> appendEvent(eventId, payload)

write events.jsonl
  -> 默认拒绝，防止覆盖完整事件流
```

`digest.md` 同样可以是只读或受控重建的虚拟文件。

### 8.3 不立即实现完整 POSIX/FUSE

第一阶段实现 Virtual Workspace API，不应承诺完整 POSIX 语义。任意程序可能依赖：

- symlink；
- file lock；
- executable bit；
- atomic rename；
- mmap；
- watch；
- 高频随机 I/O。

建议：

```text
read/write/edit/glob/grep/tree
  -> 直接调用 Virtual Workspace API

Bash
  -> materialize 指定 revision 到临时目录
  -> 在 sandbox 执行
  -> 收集 Diff
  -> 使用 expectedRevision 提交
```

发生并发变更时拒绝覆盖并返回冲突。

### 8.4 最小接口

```ts
interface VirtualWorkspace {
  stat(path, context)
  list(path, context)
  read(path, options, context)
  write(path, content, { expectedRevision }, context)
  append(path, records, { operationId }, context)
  edit(path, patch, { expectedRevision }, context)
  search(path, query, context)
  materialize(path, revision, context)
}
```

Mount 描述底层语义：

```ts
type WorkspaceMount = {
  prefix: string;
  resourceId: string;
  backend: "memory" | "object" | "device" | "git";
  mode: "read-only" | "read-write" | "append-only";
  consistency: "cloud" | "exclusive-local" | "replicated";
};
```

Virtual Workspace 是模型和插件看到的统一视图；Resource 是路径背后的安全、归属和
Placement 边界：

```text
Virtual path
  -> Mount
  -> Resource
  -> Backend / Replica
  -> Physical storage
```

## 9. local-tools 与 MCP

### 9.1 当前事实

`zion-local-tools` 当前是 Python FastAPI 设备能力服务，负责：

- 文件；
- Bash；
- Terminal 和 SSH；
- Search；
- Mail；
- 内置 MCP；
- stdio MCP 子进程桥接；
- 部分历史遗留状态接口。

Zion 侧 `packages/local-tools-client` 当前静态定义：

- `read`
- `write`
- `edit`
- `glob`
- `grep`
- `tree`
- `Bash`
- `webSearch`
- `sendMail`
- `mcpListTools`
- `mcpCall`

当前 `/mcp` 的 `tools/list` 和 `tools/call` 只支持五个硬编码工具：

- `read_file`
- `write_file`
- `list_files`
- `search_content`
- `execute_command`

local-tools 还可以通过 `/mcp/stdio/start` 启动任意 stdio MCP Server，并通过
`/mcp/stdio/:sessionId/send` 转发 JSON-RPC。但该能力目前只是低层桥接：

- 不会把发现的工具注册进 Runtime catalog；
- 不会发布为 Node Capability；
- 不会自动绑定 Resource、风险等级和审批；
- Runtime 中的 `mcpCall.name` 仍限制为五个固定工具；
- 因此当前不存在完整的“只改配置即可注册设备工具”路径。

### 9.2 MCP 最新版本

截至本文日期，MCP 最新稳定协议版本是 `2026-07-28`。TypeScript 和 Python SDK 使用
v2 主版本，SDK v2 与协议日期不是同一个版本编号。

重要变化：

- 无状态协议核心；
- 移除 `initialize` handshake 和 `Mcp-Session-Id`；
- 新增 `server/discover`；
- 每个请求携带版本、client info 和 capabilities；
- Multi Round-Trip Requests 支持 `input_required`；
- Tasks 成为正式扩展；
- MCP Apps 提供沙箱交互 UI；
- `Mcp-Method`、`Mcp-Name` 支持网关路由；
- Tool/Resource list 提供 TTL 和 cache scope；
- 完整 JSON Schema 2020-12 与 structured content；
- OAuth/OIDC、Client Credentials 和 Enterprise Managed Authorization 增强；
- Roots、Sampling、Logging 和旧 HTTP+SSE 被弃用。

官方资料：

- <https://modelcontextprotocol.io/specification/2026-07-28>
- <https://modelcontextprotocol.io/specification/2026-07-28/changelog>
- <https://modelcontextprotocol.io/extensions/overview>
- <https://modelcontextprotocol.io/extensions/apps/overview>

### 9.3 MCP 与 local-tools 不是同一层

MCP 负责：

- 能力发现；
- Tool schema；
- Tool 调用和结果；
- Resources/Prompts；
- 可选 Tasks、Apps 和授权扩展。

MCP 不替 Zion 定义：

- Device 配对、撤销和 Presence；
- Node/Resource Placement；
- Terminal/PTY/SSH 生命周期；
- 设备本地 grant 和最终否决权；
- 离线等待和副本选择；
- Attempt lease；
- side-effect receipt 和恢复；
- User/Space 计费与审计。

MCP 的 Resource 主要是协议内容 URI，不等于 Zion 用于归属、调度、可用性和安全隔离
的 Resource。

### 9.4 目标 Device Agent

普通用户最终只安装一个产品：

```text
Zion Device Agent
├── Connector
│   ├── Device identity
│   ├── Presence
│   ├── Resource registration
│   └── lease / receipt transport
├── Policy / Approval
│   ├── local grants
│   └── user confirmation
├── Terminal Host
│   ├── PTY
│   ├── process
│   └── SSH
└── MCP Host Manager
    ├── built-in filesystem/shell providers
    ├── Git/database/browser providers
    └── third-party MCP servers
```

内部仍可多模块或多进程，但安装、升级、登录、运行和诊断必须是一体化体验。

### 9.5 新工具注册目标

未来应支持声明式 MCP 注册：

```json
{
  "servers": {
    "postgres": {
      "command": "uvx",
      "args": ["postgres-mcp"],
      "resourceId": "workspace:project-a",
      "risk": "read",
      "env": {
        "DATABASE_URL": {
          "secretRef": "postgres/project-a"
        }
      }
    }
  }
}
```

执行过程：

```text
读取配置
  -> 校验包、命令和 Secret 引用
  -> 启动 MCP Server
  -> server/discover + tools/list
  -> 命名空间化工具名
  -> 发布为 Node Capability
  -> Runtime 根据 Resource 和 Policy 路由
```

模型应直接看到：

```text
postgres.query
github.create_issue
filesystem.read_file
```

不应只看到嵌套的：

```text
mcpCall(name, arguments)
```

对现有实现的建议：

- 不继续为普通新工具增加 local-tools 私有 HTTP endpoint；
- 保留成熟的 Terminal、SSH 和 PTY 能力；
- 新数据库、浏览器、Git 和 SaaS 能力优先采用 MCP；
- Connector/Device Agent 负责 MCP Server 生命周期和安全包装；
- Runtime Tool Broker 负责统一 catalog、policy、approval 和 observability；
- Workbench/Mobile 后续实现 MCP Apps Host；
- 外部 MCP Server 默认运行在 loopback/stdio，不直接暴露公网；
- 不将 Zion Resource 建立在已弃用的 MCP Roots 上。

## 10. 当前多 Node 实现的定位

最近的 Multi-Node Terminal Routing 已完成第一阶段基础：

- global terminal reference；
- Node-aware inventory；
- 显式 `node_id/resource_id`；
- ambiguity、offline 和 stale failure；
- Runtime Context Provider；
- Runtime/Workbench 共用 Device Service relay；
- Runtime 服务器上的 local-tools 也可以作为普通 Connector Node。

这些改动方向正确，但只是终端和设备调用的精确路由层，不是最终产品模型。

仍缺：

- User/Space namespace；
- 持久 Source/Resource identity；
- Resource replica 和 revision；
- Session/Project 到 Resource 的持久 binding；
- `waiting_for_resource`；
- durable dispatch 和 Device receipt；
- Virtual Workspace；
- Memory Store；
- per-Space Runtime Cell；
- 托管计算、模型 entitlement 和 usage ledger。

不应继续用 browser-wide active terminal 隐式决定 Identity、项目记忆或文件请求应去哪台
Node。

## 11. 多租户与安全边界

未来不应在当前单 Runtime 进程中简单增加 `user_id` 后宣称完成多租户。

建议：

- 公共 Control Plane 可以多租户；
- Runtime 执行按 Space 使用隔离 Cell；
- 第三方插件代码不跨敌对 Space 共进程；
- 数据库所有记录强制 User/Space scope；
- Artifact 使用独立 prefix 和 tenant encryption key；
- Secret 进入 Vault/KMS，只通过引用下发；
- Device 使用独立身份和短期 delegation；
- Resource Host 始终保留本地授权和最终否决权；
- 高风险 Tool Call 需要 Approval；
- 模型只看到当前 Run 允许的高层资料摘要，不看到完整设备拓扑；
- 所有 Memory、Artifact 和 Tool Call 都保留 provenance 和审计信息。

## 12. 建议实施顺序

### Phase A：持久记忆与跨端连续性

1. 定义 `IdentityMemoryStore` 接口；
2. 在当前 Runtime SQLite 中实现 profile/event/revision；
3. 将 `events.jsonl` 幂等导入；
4. 切换为 Runtime-first 权威写入；
5. 本地 Markdown 改为可选镜像和导出；
6. Workbench 和 Mobile 从同一 Memory API 读取；
7. 增加加密备份、导出和删除。

验收：

- 工作电脑关闭后，Identity、Biography 和 Project memory 仍可读取和追加；
- 多端不会产生双主覆盖；
- digest 可从事件完整重建；
- 用户能看到 Memory 来源和更新时间。

### Phase B：Virtual Workspace

1. 定义 Virtual Workspace API 和 Mount contract；
2. 实现 Memory backend；
3. 实现 Runtime object/local backend；
4. 实现 Device Connector backend；
5. 将 `read/write/edit/glob/grep/tree` 迁移到统一 resolver；
6. 增加 revision 和 conditional write；
7. 为 Bash 实现 materialize、diff 和 commit。

验收：

- `dev.identity` 不再理解 SQLite、S3 或 Node path；
- 同一套文件工具可操作 Memory、Project、Artifact 和 Device mount；
- 设备离线返回可操作状态，而不是路径不存在；
- 并发修改不会静默覆盖。

### Phase C：统一 Device Agent 与 MCP

1. 把 Connector、local-tools 和 MCP supervisor 打包为一个安装产品；
2. 增加声明式 MCP Server registry；
3. 动态发现并注册 namespaced tools；
4. 建立 Tool risk、Resource binding 和 Secret reference；
5. 保留 Zion Terminal/PTY 私有协议；
6. 支持 MCP `2026-07-28`，并提供旧版本兼容适配；
7. Workbench/Mobile 增加 MCP Apps 支持。

验收：

- 安装第三方 MCP 不修改 local-tools 和 Runtime 内核；
- 新工具自动出现在 Capability catalog；
- 工具只能访问声明并授权的 Resource；
- Device 离线、撤销和重启后行为明确；
- 用户看到一个 Device Agent，而不是多个后台服务。

### Phase D：Runtime 多用户扩展

1. Gateway、Control Plane、Event Gateway 和 Device Gateway 逻辑拆分；
2. 将权威状态迁移到 PostgreSQL；
3. 引入 durable queue 和 Run admission control；
4. Artifact 迁移到对象存储和 CDN；
5. Runtime Cell 支持恢复、休眠和迁移；
6. 为 Space 提供隔离 Cell；
7. Model Gateway 和 CPU/GPU Worker 独立扩容；
8. 增加套餐、配额、成本和 usage ledger。

验收：

- 单台 Runtime Host 故障不丢失 Session、Memory 和 Run；
- 增加 Worker 后吞吐可横向扩展；
- 大文件不经过 Runtime Cell；
- 每个 Space 的状态、Secret 和插件执行隔离；
- 请求过载时排队或限流，不拖垮整个平台。

## 13. 当前不建议做的事情

- 不先建设公共陌生 Node 市场；
- 不把每个用户绑定到一台常驻 VM；
- 不用升级当前单机替代架构拆分；
- 不将 local-tools 暴露公网；
- 不把所有用户文件默认上传云端；
- 不把同路径自动视为同一 Resource；
- 不让模型自行猜 Node；
- 不把 TerminalSession 当作长期 Resource identity；
- 不把 Artifact Store 当作 Memory Database；
- 不用完整 FUSE 实现作为 Virtual Workspace 第一阶段；
- 不继续扩大通用 `mcpCall`；
- 不在 Runtime Cell 本地磁盘保存唯一权威状态；
- 不静默使用过期副本或跨 Node fallback。

## 14. 需要继续决策的问题

1. Personal Memory 默认使用 Zion 托管存储，还是要求用户明确开启？
2. 企业 Memory 是 BYOC、专属数据库，还是 tenant-key 加密共享数据库？
3. 本地 Markdown 修改与云端 Memory 修改发生冲突时，采用 merge、用户确认还是单向镜像？
4. Virtual Workspace 的第一版路径格式使用 scoped POSIX path 还是 `zion://` URI？
5. Project Markdown 是数据库文档还是对象存储对象，单文件大小上限是多少？
6. Bash materialization 支持整个 Workspace 还是按任务声明的子树？
7. 第三方 MCP Server 的包签名、版本锁定、自动更新和 SBOM 如何定义？
8. Device Agent 首版是否继续使用 Python local-tools，还是只先完成统一打包？
9. Runtime Cell 的隔离粒度是 User、Space 还是活跃 Attempt？
10. 首个托管套餐的并发、保温时间、存储和模型额度如何设置？

## 15. 建议下一次讨论的起点

不要从“继续完善 NodeBroker”开始。下一次设计应优先完成以下两个可独立评审的
规格：

1. **Identity Memory Store + Local Mirror Spec**
   - 数据模型；
   - 权威源；
   - append/revision；
   - 迁移；
   - 离线行为；
   - 隐私和删除。

2. **Virtual Workspace API Spec**
   - path namespace；
   - mount/provider contract；
   - read/write/edit/append/search；
   - revision/conflict；
   - Bash materialization；
   - Resource 和 policy 映射。

这两项完成后，再设计 MCP Provider Registry 和 Device Agent 打包。否则 MCP 工具仍然
会被迫依赖不稳定的 terminal/path 路由，Memory 也会继续与本地电脑生命周期绑定。
