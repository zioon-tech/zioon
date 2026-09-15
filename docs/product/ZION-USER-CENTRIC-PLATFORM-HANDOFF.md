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

## 16. 后续讨论草案：Space Files 与 Identity 试点

- 日期：2026-09-13
- 状态：候选设计，待用户确认；不是已批准规格，也不代表以下能力已经实现
- 本轮范围：核对当前代码，讨论用户体验、文件型 Node、插件复用和试点边界
- 实施状态：仅追加讨论内容，未修改业务代码、迁移数据或变更部署

### 16.1 建议结论与产品承诺

建议推进，并选择 `dev.identity` 作为第一个使用者。但应把目标定义为：

> 用户拥有一个持久的 Space 资料空间。Identity 是其中一种具有专门规则的数据。
> Node 决定服务入口或执行位置，不决定这些资料归谁，也不决定资料的生命周期。

“给虚拟文件系统一个 node id”可以作为兼容现有工具的入口方案；不能只增加一个 Node，
然后继续把唯一数据保存在它所在进程或机器的普通目录里。稳定地址、可用性和持久性是
三个独立问题。

普通用户看到“我的记忆”“项目资料”和“已保存”，不需要选择记忆 Node，也不需要
创建终端。高级用户和模型工具可以看到资源标识、文件版本、存储服务与执行节点。
文件型 Node 不应出现在“新建终端”的执行节点列表里。

“电脑关闭仍可使用”指客户端能连接到存储服务时，记忆可以继续读取、编辑和查询。
自动蒸馏还需要可用的 Runtime 和模型；执行脚本还需要有权限的真实执行 Node。
客户端也没有网络时，只能使用明确标识的缓存和待同步草稿。

### 16.2 本轮源码核对

以下为当前工作树事实，不以旧的数据流文档代替实际实现：

| 能力 | 当前实现与限制 | 设计影响 |
| --- | --- | --- |
| 初始化和读写 | `extensions/dev.identity/main.js:264-354` 从终端和 home 解析物理路径，缺少 home 时要求创建本地终端 | 初始化记忆必须脱离终端发现 |
| Identity 上下文 | `main.js:622-799` 优先读文件、失败时使用 Runtime snapshot，并缓存会话快照 | 快照是投影；需统一跨端版本与刷新规则 |
| Runtime 文件来源 | `apps/runtime/src/main.mjs:715-723` 仍配置 `identityMemoryRoot` 和委托工具文件服务 | “Runtime 接管”不等于“Space 权威存储” |
| Runtime 事件追加 | `extensions/dev.identity/runtime.js:182-239` 读取完整事件，再写回事件文件与 digest | 该函数本身不是事务化 append，多写者不能仅靠本地去重避免覆盖 |
| 历史检索 | Biography Skill 调用 Python，脚本通过本机 `Path.open` 读 JSONL | 换成虚拟路径后，现有脚本不会自动获得远程访问能力 |
| 项目工作记忆 | `projects-core.js:6-21` 包括项目目录、索引、收集箱、待处理项与维护约定 | 不能只迁移 identity/user/digest 三个文件 |
| 自动推进授权 | `identity-runtime-shared.js` 与 `identity-runtime-state.js` 维护单独的授权文档和待审批变更 | 文档内容、授权事实、任务执行状态应继续分开 |
| 运行后处理 | `apps/runtime/src/server.mjs:620-689` 在完成回调中调用插件，异常进入报告路径 | 当前这条调用路径不等于可恢复的持久蒸馏队列 |
| 引用记录 | `main.js:3670-3700` 的浏览器处理分支记录引用，Runtime 接管时会提前返回；Runtime Biography 后处理未看到等价引用记录 | 试点需把引用覆盖纳入跨端验收 |
| Node 路由 | `apps/runtime/src/node-broker.mjs:273-298,358-374` 按任务目标筛选工具，并拒绝不同的调用目标 | 执行节点与文件来源必须分开建模 |

特别注意：现有 `identityManage.clear` 清的是 snapshot，不能在新产品中直接解释为
“删除我的全部记忆”；`patch_files` 也不等同于已经提交权威文件。

### 16.3 所有权：Space、Resource、Node 各管什么

- `Space`：数据的归属、安全和配额边界。不能仅由请求正文里的 `spaceId` 决定权限。
- `Resource`：一份资料的稳定身份、范围和访问策略；更换数据库、Node 或镜像后不变。
- `Node`：提供能力的逻辑服务入口或执行位置。文件服务可以提供 Node 适配，但不必模拟设备。
- `Mount`：把 Resource 映射到当前工作空间的路径；挂载本身不授予访问权限。
- `Revision`：一次已提交版本；不能拿客户端时间戳、文件 mtime 或终端 generation 代替。

建议内部持久引用采用 `{ spaceId, resourceId, path }`，可变文档另有稳定 `fileId`。
UI 与 Skill 使用当前 Space 下的短路径，跨端链接使用包含 Space/Resource 的 URI。
路径是寻址方式；需要跨重命名引用时使用 `fileId`，历史引用另带 revision。

候选路径约定：

| 工作空间路径 | 用途 |
| --- | --- |
| `/memory/identity.md`、`/memory/user.md` | 当前绑定身份和用户画像的文件视图 |
| `/memory/biography/*` | 事件、引用与摘要视图 |
| `/memory/projects/*` | 试点保留现有目录结构，减少 Skill 和相对链接迁移成本 |
| `/files/*` | 用户主动保存的通用资料 |
| `/apps/{pluginId}/*` | 插件的持久业务文件，默认仅对应插件和用户可访问 |
| `/artifacts/*` | 产物访问视图，历史产物版本不可就地覆盖 |
| `/devices/{nodeAlias}/*` | 明确授权的设备资料入口，不意味着已上传或已备份 |

这些是 API 的虚拟路径，不是承诺已经存在的操作系统挂载点。路径别名必须解析到同一
Resource，不能为兼容而维护两套可写文件。

还应避免把“用户中心”实现成“这个用户所有场景共用一份无差别记忆”：

- 用户画像默认属于个人 Space；团队 Space 不自动读取个人画像和私人经历。
- Agent 身份归属于相应 Agent 的配置范围；`identity.md` 首版可以是默认 Agent 的兼容视图。
- 项目记忆属于项目所在 Space，并绑定稳定 `projectId`，不是用同名目录自动识别项目。
- 团队经历是否可进入个人记忆需要明确策略，不能因为操作者是同一个人就自动复制。
- 每次上下文选择同时受 Space、Agent、Project 与当前 Run 授权约束。

### 16.4 以 Identity 的完整功能定义数据语义

统一文件体验不代表所有路径都允许相同的写操作：

| 内容/功能 | 权威形式 | 文件与界面的写入规则 |
| --- | --- | --- |
| `identity.md` | Agent 范围的版本文档 | 条件更新，修改角色配置需要相应权限 |
| `user.md` | 用户范围的版本文档 | 条件更新；能区分用户明确陈述与模型推测 |
| `biography/events.jsonl` | 结构化事件集合，带事件 ID、序号和来源 | 查询、导出、受校验追加；拒绝通用全量覆盖 |
| `biography/digest.md` | 可重建摘要 | 默认只读；纠错修改源事件，不直接改摘要假装事实已变 |
| `biography/citations.jsonl` | 来源关系和实际引用记录 | 验证事件及来源权限后写入，可导出；已失去来源时明确标识 |
| 项目 `project.md` | 版本化工作笔记 | 首版保留 Markdown，按版本更新，保留修改者和 Run |
| `projects/index.md` | 首版为现有索引文档 | 与项目笔记同批提交；以后可迁移成派生索引，不能直接改变现有维护约定 |
| `inbox.md`、`attention.md` | 首版为版本文档 | 支持条件修改；处理一条文字待办不等于批准执行授权 |
| 模板 | 版本化模板文档 | 修改只影响后续创建，不反向重写已存在的项目 |
| 自动推进政策/审批 | 独立控制面记录 | 只由授权 API 变更；普通文件编辑不能授予执行能力 |
| 自动推进运行状态 | Task/Run 系统 | 文件中可以引用和展示，不作为运行状态的第二权威源 |
| 标签、全文/向量索引、UI 缓存、上下文快照 | 可重建投影 | 保存源版本和处理进度，不允许反向覆盖源数据 |

Memory 领域 API 和文件 API 应调用同一套校验、授权和提交逻辑。不能 UI 走数据库，
通用 `write` 走另一个对象文件，然后再依靠同步维持一致。

自动事件默认不得把 `confirmed` 写成用户已确认。用户确认、纠正、撤回都是有操作者和
来源的领域操作。事件追加保留历史事实，纠正可以引用原事件；隐私删除另有真实擦除流程，
不受“append-only”这一业务约定阻止。

### 16.5 文件型 Node：支持，但只作为服务适配

可以把 Space Files 暴露成稳定的服务型 Node，声明 `read/write/edit/append/list/search`
等文件能力，明确没有 `Bash/PTY/process/SSH` 能力。实际工具名称仍沿用 Zion 已有名称，
内部再映射到标准文件操作，不必创建另一套同义工具。

服务型 Node 的状态由存储服务健康度决定，不使用笔记本 Presence。不能为每个 Space
创建一个常驻假 Connector、假终端或独占进程；逻辑地址可由共享服务提供。
文件请求应在统一 resolver 内路由到服务 provider，不绕经 Device 的命令长轮询。

数据引用不应只保存这个 `nodeId`。同一文件服务可以挂载多类 Resource；迁移 provider
后文件引用和授权仍应成立。平台可按需暴露文件 Node 的高级信息，而普通用户看到的
始终是“我的记忆/资料”。

需要同时修改工具目录边界：现有 NodeBroker 按名字取工具定义，不能让文件 provider
与设备 provider 用不同 schema 抢占同一个 `read`。公共文件工具使用统一、版本化的
schema，由 resolver 选择后端。没有任何设备在线时，这些服务端文件工具仍须可发现。

### 16.6 Bash：执行位置与数据位置必须独立

`cat`、`grep`、Python 即使只读取文件，也需要进程执行环境。文件型 Node 不应通过
解析命令字符串来冒充一个“精简 Bash”。对它直接执行 Bash 应返回明确的
`CAPABILITY_UNSUPPORTED`，不能偷偷借用其他机器。

建议两条路径：

1. 普通记忆查询与修改，直接走文件或 Memory API，不依赖 Bash。
2. 必须使用脚本时，在有权限的真实 Node 上物化指定版本和子树，执行后提交受控变更。

以下是候选契约示意，不是当前已经支持的参数：

```js
read({
  node_id: "space-files",
  resource_id: "memory-resource",
  path: "user.md"
});

Bash({
  node_id: "authorized-worker",
  command: "python analyze.py /work/memory",
  input_mounts: [{
    resource_id: "memory-resource",
    snapshot_revision: "r42",
    source_path: "projects/example",
    target_path: "/work/memory",
    mode: "read-only"
  }]
});
```

后台需分别验证执行 Node 授权、源数据读权限、目标环境是否允许接收这些数据，以及
最终写回权限。能读个人记忆，不代表可以把它物化到任意团队 Node 或第三方执行环境。
短期授权不得放进模型上下文、命令字符串或日志。

可写物化目录保存 base revision；执行完成只产生 ChangeSet，再按预期版本提交。
项目笔记与索引可在同一 provider 的事务内一起提交；跨 provider 不承诺原子提交。
冲突返回可合并的差异，不用最后完成的脚本覆盖其他客户端的新内容。
事件流、摘要、授权记录等受保护路径不能因为导出到普通目录就绕过写入规则。

现有 `RunRequest.target.nodeId` 同时限制所有委托工具。建议增加独立的执行目标与
Resource grants：指定服务器执行的 Run，可以读取已授权的 Space 记忆，同时仍不能
转到另一台服务器执行，也不能读取未授权的设备资料。不能通过放宽现有 Node 校验来实现。
旧策略没有新 Resource grants 时，不自动获得跨 Resource 权限。

完整 FUSE、实时双向文件挂载和任意 POSIX 程序兼容均不进入第一版。

### 16.7 最小通用文件契约

平台提供按授权上下文绑定的 `context.files`，插件不自行传递数据库连接、租户身份、
终端选择或宿主机路径。最低应覆盖：

- `stat/list/read`：返回类型、支持的操作、版本、来源与可用状态。
- `write/edit`：已有文件要求 `expectedRevision`；创建要求“必须不存在”。
- `append`：带 `operationId`，并由集合 provider 校验记录，不开放无规则的字节追加。
- `glob/grep/search`：限定范围、结果数量、执行时间与分页；完整性和索引新鲜度必须可见。
- `mkdir/move/delete`：通用文档 provider 按能力支持；Memory 的特殊路径可以拒绝。
- `commit`：同一支持事务的 provider 内提交一组变更，不把多个 HTTP 写入伪装成原子事务。
- `changes`：基于可恢复 cursor 获取增量和删除标记；用于缓存失效和可选镜像。
- `materialize`：后续阶段提供快照、资源清单、base revision 和受限写回能力。

长 JSONL 视图按固定集合版本分页或流式导出。第一页不是“完整文件”；read 工具遇到
截断需返回 cursor/范围，不可把部分事件悄悄用于覆盖完整集合。
全文索引可以异步，但按 ID 查询和刚写入的确认读取应直接访问权威源。

错误至少区分：`NOT_FOUND`、`PERMISSION_DENIED`、`RESOURCE_UNAVAILABLE`、
`REVISION_CONFLICT`、`CAPABILITY_UNSUPPORTED`、`QUOTA_EXCEEDED`。
先做授权再返回可见资源状态，避免通过搜索、文件存在性或错误详情泄露其他 Space。

路径必须经统一规范化并在解析后检查边界。Device provider 还要处理符号链接逃逸；
不允许通过 `/devices` 或路径别名绕过同一 Resource 的授权。

### 16.8 存储与一致性：先做小而完整的实现

Memory 试点不需要先造全功能分布式文件系统。候选持久结构为：

- 版本文档及修订记录：身份、画像、项目笔记、索引和收集箱。
- 事件与引用表：Space、事件 ID、提交序号、来源、payload、纠正/删除关系。
- 操作回执：幂等键、请求摘要和结果，与数据变更在同一事务中提交。
- 后处理任务与投影进度：蒸馏状态、失败重试、digest/index 已处理的版本。
- Resource 元数据：归属、挂载映射、授权和存储 provider 配置。

首版可用当前 Runtime 环境里的 SQLite 适配器，但数据目录必须持久化并有独立备份。
业务层只依赖服务接口，不依赖 Cell 本地文件路径。单机 SQLite 试点不等于已经具备
主机故障下的高可用；面向正式托管承诺时需验证备份恢复、灾难恢复及数据库部署方案。

Markdown 小文档可直接入库。大附件进入 Artifact/Object Store，数据库保存元数据和
引用。不能把一个不断覆盖的 `events.jsonl` 对象当成事务事件数据库。
对象内容上传完成后才发布可见引用，失败的孤立对象另行清理。

核心写入规则：

- 同一 `eventId/operationId`、相同规范化请求重试，返回原结果；不同请求复用同一 ID，
  返回冲突，不能当作“已经写过”静默跳过。
- 文档版本由服务端控制；并发编辑返回冲突，必要时对不重叠修改做三方合并。
- `occurredAt` 表示事实发生时间，提交序号表示存储顺序，二者不混用。
- “已保存”只在权威事务提交后返回；摘要刷新失败不回滚已经保存的事实。
- 投影携带源版本；刚提交的事件立即可查，digest 尚未追平时明确处理状态。
- 服务不可用时不能自动转到本地权威写入，更不能把失败当成空文件初始化。

启动只取小型上下文和列表页，Biography 历史按需查询；不再为标签预热拉取完整事件流。
缓存键包含 Space、Resource、访问范围和版本；退出登录和切换 Space 不复用旧身份缓存。

### 16.9 持续记忆不只是持续存储

关闭浏览器之后，新的会话经历、引用和项目工作记忆仍要能形成。因此试点需要把
“Run 完成后的记忆加工”变成可恢复任务，而不只是挪动存储位置。

建议在完成状态持久化时记录 outbox；如果 Run 与 Memory 分属不同存储，先在 Run
存储中提交 outbox，再由 Memory inbox 幂等消费。首版数据库任务表和 worker 即可，
不必预先引入独立消息平台。

任务唯一键包含 Space、源 Run、处理器及规则版本。蒸馏结果一旦选定就持久化，
提交失败重试该结果，避免每次重新调用模型产生不同事实。允许至少一次投递，
依靠事务与幂等达到一次逻辑生效，不宣称跨系统物理 exactly-once。

输入来自 Runtime canonical transcript，来源 Session/Run 从可信调用上下文取得，
不能盲信模型提交的 provenance。任务执行和最终写入前重新检查删除、隐私和授权状态。
引用提取应覆盖 Runtime 路径，并验证引用事件存在且可访问。

现有代码对部分 `scheduled/agent/task` 会话有排除规则。第一阶段不把它们全部放开：
后续按来源类型和用户授权决定哪些结果进入项目记忆、哪些值得进入个人长期记忆，
避免自动任务输出被再次蒸馏、递归累积，或把未执行计划当成事实。

上下文建议改为“每个新 Run 选择最新已提交版本，Run 内固定版本并记录来源”，避免
整个长会话永久使用旧快照。权限撤销和隐私删除优先于快照稳定性；恢复 Run 时需重验。
对已有历史会话正文中的内容，删除 Memory 并不会自动抹去历史对话，需单独定义删除范围。

### 16.10 本地投影与断网行为

建议默认不强制下载全量本地镜像。用户开启后，首版只提供只读镜像和完整导出；
本地可编辑同步作为后续能力，不与权威存储迁移同时引入。

| 状态 | 用户体验与数据行为 |
| --- | --- |
| 电脑关闭，手机联网 | 直接读写 Space 权威记忆，不提示寻找电脑 |
| 电脑离线，本地镜像可读 | 显示镜像时间和版本，不宣称已取得云端最新内容 |
| 客户端完全断网 | 保留待同步草稿；没有服务端回执就不显示“已保存到 Space” |
| 云端不可用但设备在线 | 可使用允许的缓存；不能无提示地启用第二个权威写入位置 |
| 本地重连，云端已有更新 | 按 base revision 合并或提示冲突；禁止按 mtime 决定赢家 |

将来允许本地编辑时，同步器必须记录 base revision、操作 ID、删除标记和同步 cursor。
文件系统 watcher 只是发现候选变更，不能直接把整个目录覆盖上传。
删除记忆后，旧镜像、旧快照和待处理任务不得把内容重新写回。

注销或撤销设备后，阻止后续同步与下载，并尽力清理受管缓存；不能保证擦除已离线设备
或用户自行导出的文件。不能把只读投影等同于可远程撤回的内容。

### 16.11 插件如何复用

平台持有通用文件服务和权限边界；`dev.identity` 持有蒸馏、事件校验、项目记忆规则
与展示。不把所有插件的数据都强行转成“记忆事件”，也不让通用文件服务认识
`decision/milestone` 等 Identity 枚举。

Memory provider 的事件文件视图调用 Identity 领域操作，普通文档 provider 可以直接
保存版本文件。provider 的注册与访问由平台管理，第三方插件不能自行宣称拥有任意挂载。

候选插件体验：

- 文档插件在自己的 `/apps/{pluginId}` 保存文稿，使用平台版本、导出与删除能力。
- `dev.identity` 调用语义 API 查询经历或确认事件；模型与 Skill 也可通过文件视图阅读。
- `dev.agents` 获得当前任务相关的项目文档授权，不因此读到全部个人经历。
- `dev.scheduler` 从授权的 Space 数据生成汇总，将结果写入资料或 Artifact。
- Skill 通过统一文件工具读取所需内容，不再硬编码 `~` 或依赖安装机器的 Python。
- 需要继续使用旧查询脚本时，显式导出对应快照到真实执行 Node；默认历史查询不走此路径。

插件声明所需路径/Resource 和操作范围，经用户/组织授权后由平台注入已绑定上下文的
文件客户端。声明不是授权。授权可进一步细化为“读取项目笔记、追加结果、不能改画像”。
跨插件共享必须显式选择共享 Resource，不能互相读取私有目录。

UI 的布局、展开状态仍可放客户端缓存或现有 state API。用户业务数据不再只存插件
globalState。卸载插件默认保留用户数据并撤销插件访问，用户另行选择删除；插件升级、
重装和更换设备不改变数据身份。

### 16.12 场景推演

| 场景 | 应有行为 | 必须避免 |
| --- | --- | --- |
| 手机追问一个月前的决定，电脑已关机 | 服务端按项目、时间和来源检索完整事件，返回可访问引用 | 只有短摘要却装作检索过完整历史 |
| 手机修正画像，电脑上的旧会话继续 | 新 Run 读取新版本；已有 Run 有版本记录，敏感撤销另行失效 | 永久冻结旧会话快照，或被旧浏览器快照回写覆盖 |
| 两个 Agent 同时推进同一项目 | 事件追加幂等，文档条件更新；项目与索引同批提交或明确冲突 | 两个模型各自覆盖完整目录 |
| 定时周报仅使用云端记忆和云端模型 | Runtime 无需等待个人设备，可生成并保存报告 | 为读记忆强行选择一个终端 |
| 项目调研已完成，但测试需要离线工作电脑 | 保存已完成的调研，执行步骤明确等待所需资源 | 整个任务报成功，或偷换到同路径服务器执行 |
| 数据分析脚本需要部分项目笔记 | 授权真实 Node 接收指定版本的子树，产物另存，变更条件提交 | 把全部私人记忆自动下载到执行环境 |
| 文档插件卸载后换设备重装 | 文稿仍归 Space，重新授权后继续使用 | 将卸载插件理解成删除业务数据 |
| 同名项目同时存在于个人和团队 Space | 依稳定项目/资源身份隔离，检索与上下文遵守授权 | 通过 slug 或目录名自动合并 |
| 企业明确禁止资料进入个人云 | 使用企业 provider；未允许复制的设备资料离线时等待 | 因统一文件路径而默认复制底层所有数据 |
| 存储已满、索引延迟或服务重启 | 明确失败/延迟状态，事实提交与投影进度分别可查 | 显示成功却未保存，或因重试产生重复记忆 |

### 16.13 持久保存、隐私与授权

“永久保留”建议解释为“不随设备关机、浏览器关闭、插件卸载或执行节点迁移丢失”，
而不是无法删除或绝对不丢失。需提供版本历史、标准格式导出、加密备份、保留政策和
恢复演练；正式服务再承诺可验证的 RPO/RTO，不把单机存储宣传为永久安全。

删除至少区分清缓存、删除单条/一组记忆、删除源会话、清空整个 Memory Resource。
删除要失效索引、digest、上下文缓存和受管镜像，并防止队列重新蒸馏已被撤回的来源。
备份按明确期限清理，恢复备份后重新应用删除记录；法定保留等例外需对用户透明。

服务端管理的加密不等于端到端加密。需要云端模型处理时，服务在授权范围内会读取明文；
不能同时承诺“服务端永远看不到内容”和默认服务端全文检索/蒸馏。

Memory 中的网页摘录、历史模型结论和外部插件内容都是资料，不自动获得系统指令等级。
角色配置修改、用户确认和执行授权走明确控制入口。往 Markdown 里写 `autonomy: execute`
不能获得执行权限，往事件里写 `confirmed: true` 不能冒充用户确认。

日志默认记录资源标识、版本、延迟和错误，不记录私密正文、访问令牌或密钥。
备份、导出和物化操作也是数据外发，需要对应授权及审计。

### 16.14 试点顺序与迁移方式

以下保留为完整目标的候选路线。根据后续对短期工作量的讨论，近期建议收缩为第 17 节的
Runtime 本机文件存储方案；本节的数据库、通用 provider 和持久任务机制不再是首版前置。

1. 建立带 Space 范围的 Memory Store：文档版本、事务事件追加、引用、幂等回执、
   直接查询与删除/导出。用当前部署做单 Owner 适配，但不把它称为已完成多租户。
2. 同时提供最小 Memory 文件 provider，接入现有文件工具及 Identity UI/Runtime。
   取消对 home、active terminal 和浏览器全局终端的依赖；所有修改提交同一 Store。
3. 将蒸馏与引用写入接到可恢复任务，统一 Workbench/Mobile 的查询和管理入口。
   自动推进授权仍由控制面处理；手机上的审批必须通过同一授权 API，而不是改文件。
4. 验证导出、只读本地镜像与最小第二使用者。第二使用者可先是普通文档插件或
   `dev.agents` 的一个项目笔记流程，用来检验通用性，而不同时迁移所有插件。
5. 基础稳定后，再增加真实 Node 的 materialize/ChangeSet、Device provider 与
   可编辑本地同步；这些不是“电脑关闭仍能管理记忆”的前置条件。

存量导入不能从 Runtime snapshot 还原完整经历。需要用户选择真实旧资料源，
并显式确认上传范围。导入包括完整事件、引用、所有项目子目录、模板、索引、
收集箱、待处理项；自动化政策单独处理并核对授权，不能从 Markdown 推导批准。

导入先进入暂存区：校验记录数、ID、内容摘要、坏行和链接。重复 ID 内容一致可去重；
不一致必须报告冲突。两台旧设备有不同版本时显示差异，不按“较新时间”自动胜出。
不能把摘要缺失的历史说成已经迁移。

切换时暂停受管旧写入并补齐增量，记录 authority generation，关闭旧 snapshot 上传等
覆盖通道，再启用新权威写入。保留旧目录作为明确标识的迁移备份，不立即删除。
无法阻止的旧客户端离线编辑不属于权威写入，重连后需进入显式导入/冲突流程。

出现问题时可以回退 UI 或暂停写入，但新 Store 接受写入后，不能直接把旧目录重新
设为权威源。数据回退必须包含反向迁移和校验，否则会丢失切换后的新增记忆。

### 16.15 验收门槛与待确认默认值

以下是拟定验收用例，本轮没有执行实现或这些测试：

- 关闭 Workbench、local-tools 和个人 Connector，手机仍可查完整历史、编辑画像、
  更新项目笔记并取得权威提交回执；有可用 Runtime/模型时可持续蒸馏新经历。
- 不存在终端时可初始化 Memory，切换活动终端不改变 Identity 数据来源。
- 同时追加、编辑、重复投递以及提交后响应丢失，都不导致丢事件、重复逻辑事件或
  静默覆盖；同一幂等键的不同请求必须冲突。
- 杀死后处理进程并重启后可恢复任务，digest 可按源记录重建，引用可跨端追溯。
- 指定执行 Node 的任务可访问已授权 Space 文件，但不能换执行 Node 或越权读其他资源；
  对文件型 Node 的 Bash 调用明确拒绝。
- 项目授权变更不能通过文件写入、恢复旧快照、旧镜像同步或模型填写字段绕过审批。
- 删除后搜索、摘要、上下文、镜像和待处理任务不会让内容重新出现；备份恢复符合删除政策。
- 本地资料导入结果可核验、可恢复，导出包含全量源数据而非只有渲染摘要。
- 启动不拉取全量 Biography，文件工具在所有设备离线时仍可发现；失败状态不伪装成空数据。
- 备份实际恢复演练成功；多 Space 的授权、搜索和缓存隔离在开放多用户前单独验收。

建议用户确认的默认值：

1. 新建个人 Space 的记忆默认存于托管服务，并清楚告知；旧本地记忆只在确认后导入，
   企业与纯本地部署遵循自身策略。
2. 本地镜像可选且首版只读；可编辑同步延后，不承诺无条件自动合并。
3. 虚拟 Node 作为兼容入口，数据长期引用依赖 Space/Resource；默认 UI 不要求用户选 Node。
4. 通用文件访问与 Memory 语义共用权威提交路径，Bash 始终需要独立授权的真实执行环境。
5. 先完成 Identity 的完整纵向体验；不把 FUSE、所有插件迁移、公共 MCP 生态或完整
   Runtime 多租户拆分列为本试点前置工作。

## 17. 短期收敛草案：真实文件、现有工具、平台绑定位置

- 状态：按用户确认的缩减范围完成首版代码改造与本地验证，未部署、未迁移生产数据
- 实现与运维说明：`docs/architecture/PLUGIN-DATA-LOCATIONS.md`
- 与第 16 节的关系：保留长期方向，但近期不建设完整 Space Files 或 Memory 数据库
- 用户进一步明确：选择文件存储就是为了使用 Bash/read/write/edit 和已有脚本。
  首选方案不再引入独立存储读写工具、专用查询接口或只有 API 理解的文件地址。
- 已确认目录规则：`dev.identity` 与其他插件统一使用插件数据目录，不为历史 memory
  目录保留特殊映射。部署前需明确配置数据 Node，并通过迁移命令导入旧文件。

### 17.1 直接保留文件，先解决电脑关机后的访问

在当前单 Owner、常驻远程 Runtime 的部署前提下，直接把完整 Identity 数据放在
Runtime 所在机器的持久目录是合理的短期方案。继续使用 Markdown 和 JSONL，
统一使用 `~/.zion-next/data/plugins/dev.identity/`；这里的 `~` 属于 Runtime 服务账号，
不是浏览器所在设备或当前工具执行 Node。

部署时由平台统一的数据目录配置和插件 ID 确定实际目录，并注入展开后的绝对路径，
确保它不在发布包或临时容器层内，升级不能清空，备份必须包含该目录。
其他设备复用已连接 Runtime 的认证工具通道，不直接连接机器地址或 local-tools。
底层工具本来就可能经 HTTP 传输，但这不等于需要向模型增加一套 Memory API 工具。

复用 Runtime 所在机器的真实 Connector/local-tools Node，同时提供 Bash 和文件工具，
让它们操作同一物理目录。不为记忆创建虚拟文件 Node，不把 JSONL 变成只能查询的视图，
也不把独立 Runtime 本机文件 API 作为插件作者的主要入口。

现有 `createPluginFileService` 的注入边界仍可复用，但要使用平台提供的确定位置，
替代基于路径/平台的猜测。Node、目录与设备侧授权由部署/配对过程绑定一次，
不由插件或模型辨认哪个节点的名字“看起来像云端”。

### 17.2 抽象位置，不再抽象一套读写动作

平台概念统一叫“插件数据目录”（Plugin Data Directory），位置键采用 `data`，
而不是 `memory`。这是当前用户/Space 范围内分配给插件的持久业务数据位置，
不限定内容必须是记忆，也不是所有插件共用一个无边界的目录。
当前单 Owner 部署先绑定其目录，不代表已实现多 Space 隔离。

平台只需提供一个已绑定的位置，最小信息为 `{ nodeId, root }`。开发者使用这份位置
调用原有工具，不必提前知道真实 node id、机器名称、IP、账号 home，也不必重新发现终端。
不以 `remote`、`cloud` 或 `runtime` 命名这个目录：这些是当前部署位置，不是数据用途。

已实现的位置接口。Workbench 按需异步获取，Runtime 直接解析；使用 `await` 可兼容两端。
`tools` 表示已有工具调度器，不是新增的 `context.tools` 调用方法：

```js
const data = await context.locations.data;
await tools.read({
  node_id: data.nodeId,
  path: `${data.root}/notes.md`
});
await tools.Bash({
  node_id: data.nodeId,
  command
});
```

`dev.identity` 可以在自己的数据目录保存身份、用户画像、经历、项目笔记等；
报告插件可以保存报告和附件；写作插件可以保存草稿。这些内容叫什么、目录如何组织，
由插件决定，平台只提供持久位置及访问授权。插件业务数据默认不因插件升级或卸载删除，
用户可显式清理；插件安装代码、临时文件、可丢弃缓存不属于这份持久数据。

所有插件的默认物理目录统一为 `~/.zion-next/data/plugins/{pluginId}/`，但开发者不应
拼接这个路径，应使用平台注入的 `data.root`。`dev.identity` 首版同样遵守此规则，
对应 `~/.zion-next/data/plugins/dev.identity/`；文件内部仍可保留 `identity.md`、
`user.md`、`biography/`、`projects/` 等业务结构，无需再包一层 `memory/`。

旧 `~/.zion-next/memory/` 仅作为一次性迁移来源，现有 `ZION_IDENTITY_MEMORY_ROOT` /
`--identity-memory-root` 只用于识别旧部署的数据位置，不作为新目录规则的特殊覆盖项。
迁移完成后不再回退读取旧目录，也不保留指向旧目录的特殊映射或双写。

上述 `command` 仍是普通 shell 命令，使用绑定的真实目录，路径参数需正确 shell 转义。
这里新增的是位置元数据，不是 `memoryRead/memoryWrite/memoryQuery` 等模型工具。
第一版甚至不必增加 `node_id: "runtime"` 的别名语法：直接由平台注入实际绑定即可，
不会因为机器改名而要求插件作者手工改常量。

插件自己持久数据的位置，与用户当前工作仓库的位置是两份独立绑定。切换仓库执行 Node
不改变插件数据位置；不能把所有省略 node id 的工具调用都改成 Runtime 本机，也不能把
原生 shell 的 `~` 改成跨机器全局路径。

### 17.3 Skill 和 UI 继续使用文件

平台通过现有上下文贡献机制告诉模型当前任务获准访问的插件数据目录及所属 Node，
插件补充自己的业务说明和脚本位置，无需新增一个“查询数据位置”的模型工具。
Skill 继续调用 Bash/read/write/edit，使用真实路径，保持 Python、rg、jq 等文件处理方式。

Biography 的既有 Python 查询脚本可以继续使用，但须确认脚本和 Python 已部署到
数据所在 Node，并将它的输入路径指向绑定目录。项目维护提示词也改为使用平台提供的
`data.root`，不再硬编码 `~/.zion-next/memory`。无需以新的 Memory 查询 API 替换这些脚本。

Workbench/Mobile 的界面仍可通过现有认证文件通道读写和分页展示；这些内部传输调用
不需要变成模型工具。自动蒸馏、界面操作、工具调用必须指向相同目录。

保留现有执行与文件授权。知道记忆 Node 和目录不等于获得服务器任意 shell 权限；
Bash 仍受原有命令策略、审批与设备侧 sandbox/grant 限制。当前强绑定某个执行 Node
的 Run 若未获准访问记忆 Node，应明确拒绝；不能用位置注入绕过现有目标校验。
需要同时操作仓库 Node 和记忆 Node 的流程，必须显式配置相应授权。

### 17.4 不能省掉的小范围保障

- 允许 Bash 直接管理真实文件，不再要求所有修改必须经专用 API。自动追加和推荐的
  修改脚本需遵守同一跨进程文件锁约定；读-改-写全程持锁，更新使用原子替换，
  事件 ID 做去重与冲突检查。锁必须由工具写入和后台蒸馏共同遵守，仅 Runtime 内存队列
  不够。可将规范写法放进 Skill 脚本，不增加模型工具。
- 任意 Bash 命令仍可能绕过协作式文件锁。不能同时承诺无限制原地写入与强并发一致性；
  不遵守约定的命令属于普通文件操作风险，备份和原子写入不能消除丢更新问题。
  第一版不宣称任意命令或多个 Runtime 写者都安全。
- 摘要继续作为可重建文件，不要求和事件文件做跨文件数据库事务；源事件保存后，
  摘要失败可明确报告并重建。自动推进授权继续使用现有控制记录，不迁成可编辑文件授权。
- Bash 修改不会触发某个专用 API 的回调，因此新 Run/界面刷新应检查源文件变更并刷新
  上下文或摘要，不能无限复用旧 snapshot。短期可按需检查，不必先建设分布式文件监听。
- 从明确选定的旧数据位置一次性迁入完整事件、引用、项目子目录等，目标为统一的
  `dev.identity` 数据目录。核对数量及内容并保留备份；目标已有内容时先检查冲突，
  不直接覆盖。切换后停用旧目录权威写入和旧 snapshot 上传覆盖路径，不做持续双向同步。
- Workbench、Mobile、Runtime 的读取与修改统一走此存储，缓存只用于加速。
  迁文件本身不会自动完成手机管理入口，也不会自动修复所有 Skill 调用。
- 对访问失败、写入冲突和蒸馏失败给出真实状态，不因为文件小就假定没有并发。

### 17.5 明确不做与验收边界

首版不做：虚拟 Node、Memory 数据库、通用 VFS/provider registry、FUSE、Bash 物化、
本地双向同步、跨机器自动迁移、完整多租户、持久蒸馏队列与高可用集群。
不增加一套 Memory 读写/查询工具，也不以 `storage://` 等虚拟 URI 作为 Bash 的文件路径。
Runtime 重启中尚未完成的后台蒸馏不因此获得恢复保证，不能混同于已保存文件的持久性。

验收聚焦：个人电脑及其服务关闭后，其他客户端仍能通过原有 Bash/read/write/edit
访问完整 Identity 文件；插件无需硬编码真实 Node；切换执行位置不改变记忆位置；
规范写入路径的并发与重试不静默覆盖数据；Bash 修改后上下文可刷新；
未经授权不能跨 Node 执行；升级保留数据且备份可恢复。
首版默认不生成本地镜像，仅保留迁移备份和按需导出。

该方案解决的是“个人电脑不在线”，不是“Runtime 服务器不在线”。服务器故障时仍可能
不可访问，磁盘损坏依赖独立备份恢复。正式引入 Runtime 迁移/休眠、多用户共享或更高
可用性承诺时，再推进第 16 节的存储服务分离，而不是预先支付全部平台建设成本。
