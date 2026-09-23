# Zion 多 Node 与多用户平台战略

- 状态：Draft for decision
- 日期：2026-09-07
- 范围：产品定位、用户、商业模式、多 Node 调度、多租户、安全与实施路线
- 依赖：
  - `docs/architecture/ZION-DISTRIBUTED-RUNTIME-PRODUCT-ARCHITECTURE.md`
  - `docs/architecture/ADR-0003-REMOTE-ACCESS-AND-DEVICE-PAIRING.md`
  - `docs/architecture/WORKBENCH-RUNTIME-CAPABILITY-MIGRATION.md`

## 0. 执行结论

Zion 不应该定位成“另一个 OpenClaw”，也不应该先做公共算力市场。

建议定位为：

> 面向个人与团队的可信 Agent 工作网络。任务可以从任意 Client 发起，在用户授权的
> 本地电脑、服务器、GPU 机器或云 Runtime 上持续执行；会话、审批、证据和结果在
> 多端保持一致。

近期最有机会的切入点不是大众聊天助手，而是：

1. 拥有多台开发设备、服务器或 GPU 机器的技术个人；
2. 3-30 人的 AI 原生研发团队、工作室和交付团队；
3. 需要“数据不出设备，但任务可远程发起和审计”的企业研发团队。

核心商业价值不是“接入更多模型”，而是同时解决：

- 任务应该在哪台机器执行；
- 数据和凭证不应离开哪台机器；
- 谁能批准什么操作；
- 设备离线后任务如何等待、恢复或迁移；
- 多人如何观察、接手和审计同一个任务；
- 一个插件如何可靠地部署到 Runtime、Resource Host 和 Workbench。

近期产品应坚持以下边界：

- 先做同一 Owner 或同一可信团队的多 Node，不直接做敌对多租户共享执行进程；
- Control Plane 可以多租户，Runtime 执行先按 Space 使用隔离 cell；
- 模型声明资源需求，不直接挑选 Node；
- Resource Host 保留本地授权和最终否决权；
- 高风险副作用没有 Approval 时必须失败关闭；
- 公共 Node 市场至少推迟到身份、计费、沙箱、保险和争议处理成熟以后。

## 1. 如果现在注册更多 Node，会发生什么

当前实现可以登记多个 Node，但还不能称为完整的多 Node 产品。

### 1.1 已具备的基础

- Node 使用独立 `nodeId` 和 `instanceId` 注册；
- Node 发布 Capability 和 Resource；
- `projectId -> nodeId -> resourceId` binding 可以持久化；
- Node presence、离线判断、调用 lease 和 Runtime receipt 已存在；
- Resource credential 与 Node identity 绑定；
- Connector 只建立出站连接，本机服务不暴露公网；
- Tool policy 可以携带文件根目录和 terminal session 范围；
- Runtime、Workbench 和 Resource Host 已经有明确的逻辑边界。

### 1.2 当前多 Node 行为

当前 `NodeBroker.availableTargets()`：

1. 有 `projectId` 时找所有 project binding；
2. 没有 `projectId` 时枚举全部 Node；
3. 过滤在线状态和所需 Capability；
4. 按 `nodeId` 字典序排序；
5. `selectTarget()` 直接取第一项。

这意味着第二台 Node 接入后，系统虽然“能选一台”，但不能保证“选对一台”。

### 1.3 当前主要缺口

| 缺口 | 当前后果 |
| --- | --- |
| 无显式 Space / tenant namespace | Session、Run、Node 和 KV 不能形成真正租户边界 |
| Node 选择只取排序第一项 | 相同能力可能被路由到错误电脑 |
| 无容量、负载、延迟和成本信息 | 无法做合理调度或排队 |
| Resource 没有 revision / replica 语义 | 不能判断两个同名项目是否是同一数据版本 |
| 无 placement record | 事后无法解释“为什么选择这台机器” |
| 无 Attempt owner lease | 不能安全地在 Runtime Host 间迁移 Agent loop |
| pending invocation 主要在内存 | Runtime 重启时未完成调用不能完整恢复 |
| Device receipt 不是 durable | Device 与 Runtime 同时故障时仍可能重复副作用 |
| 无 Approval Provider | 远程 write/edit/Bash 缺少完整的人类授权闭环 |
| 无 Node affinity | 同一会话的连续调用可能跨设备漂移 |
| 无明确资源选择器 | 无 `projectId` 的请求可能落到任意在线 Node |
| 相同工具名按首个结果合并 | 多版本或多实现冲突没有协商机制 |

因此，在修复这些问题前，生产环境应继续维持“一台主要 Resource Host”的约束。

## 2. 产品判断

### 2.1 不要做什么

如果 Zion 只是提供：

- 一个聊天框；
- 一组 Skills；
- 一个能执行 Bash 的远程节点；
- 一个插件市场；
- 一键部署 VPS；

那么它会直接进入 OpenClaw、Cursor、GitHub Copilot、Claude Code、Codex 和自动化
平台的拥挤竞争区，缺少成立理由。

### 2.2 应该做什么

Zion 应把“工作和资源的关系”做成一等产品对象：

```text
用户目标
  -> Session / Run
  -> 可解释的 Placement
  -> 唯一 Attempt owner
  -> 本地或云端 Resource
  -> Approval
  -> Artifact / Evidence
  -> 可恢复、可接手、可审计的结果
```

用户购买的不是 Node 数量，而是：

- 在任何设备发起工作；
- 安全使用散落在多台设备上的数据、登录态、GPU 和工具；
- 任务不会因为网页关闭而消失；
- 团队能看见任务状态、成本、证据和责任人；
- 设备离线或失败时有明确语义。

### 2.3 产品名称层面的心智

可使用以下内部定位检验功能优先级：

- `Personal Agent Fabric`：个人多设备执行网络；
- `Team Agent Operations`：团队 Agent 作业、审批和接力；
- `Private Capability Mesh`：企业私有能力与数据的安全接入层。

不建议使用“算力网络”作为主要定位。算力只是资源之一，Zion 的价值还包括本地数据、
浏览器登录态、终端会话、审批、上下文连续性和可验证结果。

## 3. 用户与首个市场

### 3.1 用户分层

| 用户 | 典型资源 | 核心痛点 | 付费意愿 | 优先级 |
| --- | --- | --- | --- | --- |
| 多设备技术个人 | Laptop、家用服务器、云 VPS | 远程继续任务、机器间选择、隐私 | 中 | P0 |
| AI 原生研发团队 | 成员电脑、CI、GPU、测试机 | 共享任务、审批、成本、设备亲和 | 高 | P0 |
| 交付/咨询工作室 | 多客户项目、隔离环境 | 客户数据隔离、证据和交付审计 | 高 | P1 |
| 企业研发平台团队 | 内网、代码库、集群、审批系统 | 合规、SSO、策略和私有部署 | 很高但周期长 | P1 |
| 内容与媒体团队 | 工作站、GPU、素材库 | 大文件本地处理和长任务 | 中高 | P2 |
| 普通消费者 | 手机、家庭电脑 | 通用个人助理 | 低且获客昂贵 | 暂缓 |
| 公共算力供需双方 | 陌生人的设备 | 成本和利用率 | 不确定且风险极高 | 不做 |

### 3.2 Beachhead

首个明确场景建议是“可信研发小队的多机任务”：

> 用户从手机或任意 Workbench 发起代码调查、修复或评测任务。Zion 根据项目绑定把
> 工作放到持有该仓库的电脑或服务器；需要写入或执行命令时请求审批；任务在后台持续；
> 最终返回 diff、测试报告和完整证据。

该场景同时验证：

- 多 Node placement；
- 项目数据亲和；
- 长任务；
- Approval；
- Artifact；
- 多人观察和接手；
- 可量化的时间节省。

不要选择“跨设备问天气”作为多 Node 样板，它无法证明平台价值。

### 3.3 如何从一个人服务到更多用户

增长路径应是 `个人 -> 可信小队 -> 企业 Space`，而不是把单用户 Runtime 直接公开给
所有注册用户：

1. **个人自助**：托管 Control Plane，用户通过一次性链接连接自己的电脑；
2. **邀请协作**：Owner 邀请同事加入 Space，成员共享任务但不自动共享全部资源；
3. **项目模板**：把可重复的项目绑定、工具策略和审批规则保存为模板；
4. **团队扩散**：个人完成的 Run 可以邀请 Reviewer，并自然转为团队订阅；
5. **企业接入**：OIDC/SCIM、BYOC、KMS、审计导出和集中策略；
6. **生态扩展**：开放协议、Connector 和 Plugin SDK，托管 Control Plane 收费。

Onboarding 必须把复杂度压缩成三个动作：

```text
创建 Space -> 配对一台 Node -> 选择一个 Project 并完成首个 Run
```

第一个成功任务应在 10 分钟内发生。Node、模型、插件和权限配置不能同时暴露给新用户。

### 3.4 未来想象空间

如果基础能力成立，Zion 可以逐步成为：

- **个人计算资源层**：手机发起任务，家中电脑、公司开发机和云服务器按资源条件接力；
- **团队 Agent 作业系统**：任务有 owner、预算、审批、状态、证据和交接，而不是散落在聊天窗口；
- **企业私有能力入口**：数据库、内网 API、GPU、浏览器登录态只通过受控 Resource Host 暴露；
- **垂直执行网络**：媒体制作、模型评测、实验室设备、边缘采集等有明显数据本地性的任务；
- **多宿主插件平台**：一次发布同时定义 Runtime 规划、Device 执行和 Workbench 展示；
- **可信能力交易层**：企业内部团队可以发布有审计和配额的能力服务。

最后一项不等于开放陌生人设备市场。早期只做同一 Space 或企业内部的可信能力共享。
公共市场需要额外解决恶意计算、数据责任、支付争议、内容合规和设备可信证明。

## 4. 与 OpenClaw 及相邻产品的比较

### 4.1 OpenClaw 的真实优势

根据 2026-09-07 的官方仓库和文档，OpenClaw 已经具备：

- 成熟的聊天渠道生态；
- Gateway、Node、Cloud Worker、Sandbox 和插件体系；
- 设备配对、命令审批、Operator scope 和安全审计；
- Node 硬件状态、版本兼容与多平台 companion app；
- ClawHub 和更成熟的社区分发；
- 团队 Session owner、participants 和 presence；
- 每租户独立 Gateway cell 的实验性 Fleet。

这些都是 Zion 当前不能声称领先的地方。

### 4.2 OpenClaw 的官方边界

OpenClaw 官方安全文档明确：

- 一个 Gateway 是一个可信操作域；
- 同 Gateway 的多人协作不是敌对多租户隔离；
- 不互信用户应使用独立 Gateway、OS user、容器、VM 或物理机；
- Fleet 当前是单机上的实验性 cell 管理器；
- Fleet 尚不提供跨机器 cell 管理、共享入口、租户自助门户、计费平面。

这留下了一个真实但不轻松的机会：

> 在不牺牲每租户执行隔离的前提下，提供共享的身份、任务目录、Placement、计费、
> 审批和 Artifact Control Plane。

### 4.3 差异化矩阵

| 维度 | OpenClaw | GitHub Copilot / Cursor | Zion 应争取的位置 |
| --- | --- | --- | --- |
| 第一入口 | IM 渠道和个人助手 | IDE、GitHub 和代码 | 持久协作 Workbench + Mobile + CLI |
| 核心对象 | Agent / Gateway / Session | Repository task / PR | Run / Attempt / Resource / Artifact |
| 本地设备 | 成熟 Node 与 companion app | 主要是 IDE 或云 Agent | 用户私有 Resource Host 与云 Runtime 混合 |
| 多租户 | 每租户隔离 Gateway cell | 厂商托管租户 | 共享 Control Plane + 每 Space 执行 cell |
| 跨设备任务 | Gateway 转发或 cloud worker | 云端代码任务 | 数据感知 Placement + 可恢复 Attempt |
| 协作 | Owner、participant、presence | PR、review、team context | 实时共享 Session、审批、接手、证据 |
| 插件 | 成熟生态和市场 | MCP、规则、Marketplace | 多宿主 package Desired/Actual 状态 |
| 安全卖点 | 成熟的单信任域加固 | 企业身份和集中策略 | 用户/Space/Run/Runtime/Resource 多层权限交集 |
| 当前成熟度 | 高 | 高 | 早期，需要集中验证 |

### 4.4 必须诚实的结论

Zion 当前没有总体优势。只有当以下三件事真正做成时，差异化才成立：

1. 多 Node placement 能稳定选择正确资源；
2. 多人协作是授权边界，不只是头像和 UI；
3. 每次高风险执行都有可验证 Approval、receipt 和 Artifact。

仅仅把 Gateway 与 Node 分离已经不是差异化，OpenClaw 也有 Node、Sandbox 和 Cloud
Worker。Zion 必须证明的是跨独立 Runtime 的通用 Placement、以工作成果为中心的
协作界面，以及可以承载不同 Space 的共享 Control Plane。

如果这三项没有完成，Zion 应被视为一个有特色的 Workbench，而不是平台。

## 5. 目标产品模型

### 5.1 Identity 与租户

```text
Human
  -> Membership(role, scopes)
    -> Space
      -> Session
      -> Project
      -> RuntimeCell[]
      -> ResourceNode[]
      -> PluginDesiredState[]
```

建议角色：

| 角色 | 权限 |
| --- | --- |
| Space Owner | 计费、成员、设备、策略、删除与导出 |
| Admin | Node、插件、模型和审批策略 |
| Operator | 创建 Run、调用已授权能力、处理审批 |
| Reviewer | 查看任务、Artifact、审计和批准指定操作 |
| Observer | 只读 Session 和 Run |
| Resource Device | 只提供被批准的 Capability，不能读取 Space |

### 5.2 Node 不是用户，也不是完整 Runtime

Node 应有明确类型：

```text
runtime
  可以获得 Attempt lease，执行 Agent loop

resource
  暴露文件、终端、GPU、浏览器、传感器或业务能力

client
  提供交互、Approval 和前台能力

gateway
  聚合一组轻设备或局域网资源
```

一台机器可以承担多个角色，但凭证、Capability 和 lease 分别管理。

### 5.3 Resource 语义

Resource 不能只是一个字符串。至少需要：

```ts
type ResourceDescriptor = {
  resourceId: string;
  spaceId: string;
  nodeId: string;
  kind: "workspace" | "terminal" | "gpu" | "browser" | "device" | "service";
  projectId?: string;
  revision?: string;
  replicaGroupId?: string;
  consistency: "exclusive-local" | "replicated" | "portable" | "cloud";
  trustZone: string;
  labels: Record<string, string>;
  localGrantVersion: string;
};
```

`revision` 和 `consistency` 决定是否允许换 Node。两个路径相同但 Git revision 不同的
目录不是可互换资源。

## 6. 推荐部署架构

### 6.1 近期：共享控制平面，每 Space 一个执行 cell

```text
                         +----------------------+
Clients ----------------> Access Gateway       |
                         +----------+-----------+
                                    |
                         +----------v-----------+
                         | Shared Control Plane |
                         | Identity / Registry  |
                         | Placement / Billing  |
                         | Audit / Notification |
                         +----+-------------+---+
                              |             |
                    +---------v--+       +--v---------+
                    | Space A    |       | Space B    |
                    | Runtime    |       | Runtime    |
                    | isolated   |       | isolated   |
                    +-----+------+       +------+-----+
                          |                     |
                    Resource Nodes        Resource Nodes
```

共享 Control Plane 可以多租户，但 Agent loop、插件代码、模型凭证和临时执行状态先
按 Space 隔离。这比一开始在同一 Runtime 进程中实现敌对租户隔离更可信。

### 6.2 为什么不立即上 Kubernetes

前 100 个付费 Space 的瓶颈大概率是产品、授权和任务可靠性，不是容器调度。

建议演进：

1. 单进程模块化 Control Plane + systemd/container cell；
2. PostgreSQL + 对象存储；
3. cell supervisor 和队列；
4. 只有当 cell 数量、弹性和故障域要求证明需要时再上 Kubernetes。

不要用 Kubernetes 掩盖未定义的租户、资源和权限语义。

### 6.3 中期服务边界

| 服务 | 职责 |
| --- | --- |
| Identity Service | User、Space、Membership、Device credential |
| Registry | Runtime/Resource presence、Capability、Resource |
| Placement Service | 过滤、评分、binding 和解释 |
| Run Ledger | Run、Attempt、lease、event sequence |
| Dispatch Queue | durable outbox/inbox、ACK、redelivery |
| Approval Service | canonical operation、签署、TTL、撤销 |
| Artifact Service | blob、digest、provenance、retention |
| Usage Ledger | token、Runtime 时间、存储、网络和收费事件 |
| Runtime Cell | Agent loop、Context、Plugin Runtime entries |
| Resource Connector | 本机策略、执行、receipt、kill switch |

这些服务近期可以在同一个部署单元内实现，但接口和数据所有权必须独立。

## 7. Placement 设计

### 7.1 Node Registration v2

```ts
type NodeRegistrationV2 = {
  protocolVersion: 2;
  nodeId: string;
  instanceId: string;
  epoch: number;
  spaceId: string;
  roles: Array<"runtime" | "resource" | "client" | "gateway">;
  trustZone: string;
  region?: string;
  labels: Record<string, string>;
  capabilities: CapabilityDescriptor[];
  resources: ResourceDescriptor[];
  capacity?: {
    maxConcurrentAttempts?: number;
    cpuCount?: number;
    memoryMb?: number;
    gpuMemoryMb?: number;
  };
  load?: {
    activeAttempts: number;
    queueDepth: number;
    observedAt: number;
  };
};
```

`instanceId + epoch` 用来区分同一 Node 的新进程。旧 epoch 的结果必须拒绝。

### 7.2 Placement Request

```ts
type PlacementRequest = {
  spaceId: string;
  runId: string;
  attemptId: string;
  projectId?: string;
  requiredCapabilities: Array<{ name: string; versionRange?: string }>;
  requiredResources: string[];
  preferredNodeIds?: string[];
  trustZone?: string;
  dataResidency?: string;
  latencyClass?: "interactive" | "background" | "batch";
  deadline?: number;
  estimatedCostLimit?: number;
};
```

模型只能描述需求。最终 Node 由 Placement Service 选择，避免把设备拓扑、IP、用户名和
敏感标签注入模型上下文。

### 7.3 选择算法

先做硬过滤：

1. `spaceId` 必须一致；
2. credential、Node 和 resource 未吊销；
3. Node 在线且 heartbeat 未过期；
4. Capability 名称和版本兼容；
5. project/resource binding 匹配；
6. trust zone 和 data residency 匹配；
7. Resource local grant 覆盖请求；
8. 容量和并发上限允许；
9. Runtime/插件协议兼容。

再评分：

```text
score =
  dataLocality       * 40
  + sessionAffinity  * 25
  + latency          * 15
  + healthAndLoad    * 10
  + cost             * 10
  - versionSkewPenalty
  - recentFailurePenalty
```

权重应配置化，但首版不做自动学习。相同分数使用
`stableHash(runId, nodeId)` 决胜，不能继续按 `nodeId` 字典序取第一台。

### 7.4 Affinity 与显式选择

- Session 默认粘在最近成功的 Resource/Runtime；
- Project 可以设置 primary 和 replica；
- 用户可以 pin Node；
- 需要浏览器登录态、未提交工作区或唯一设备时使用 hard affinity；
- 只有声明为 `replicated` 或 `portable` 的资源才允许自动迁移；
- 有多个不等价候选且无法判断时，向用户展示 Node picker，而不是猜测。

### 7.5 Attempt lease

```ts
type AttemptLease = {
  attemptId: string;
  runtimeNodeId: string;
  epoch: number;
  leaseTokenHash: string;
  leaseExpiresAt: number;
  renewAfter: number;
};
```

- 一个 Attempt 同时只有一个 owner；
- Event append 必须携带当前 epoch；
- lease 过期后旧 owner 的 Event、Artifact 和 side-effect receipt 被拒绝；
- 重新放置产生新 Attempt，不复用旧 owner；
- 高频远程 Tool Call 应升级为靠近 Resource 的 Subrun。

### 7.6 离线与恢复

| 情况 | 行为 |
| --- | --- |
| 唯一本地资源离线 | Run 进入 `waiting_for_resource` |
| 有已验证 replica | 创建新 Attempt 并记录迁移原因 |
| Runtime 离线 | lease 到期后从 checkpoint 恢复 |
| 只读调用超时 | 可以用同 invocation ID 重试 |
| 有副作用调用未知 | 查询 durable receipt，不盲目重试 |
| Resource revision 改变 | 要求用户确认或重新规划 |

## 8. 数据与 API 改造

### 8.1 必须加入 `space_id`

当前 PostgreSQL 表主要以 `session_id`、`run_id`、`node_id` 和 `project_id` 为主，没有
统一的租户键。多用户前必须给以下对象增加 `space_id`：

- Session、Run、Event、Checkpoint；
- Workbench document、metadata、KV、collaboration document；
- Node、Resource、Project binding；
- Interaction profile、Scheduler task；
- Plugin desired/actual state；
- Artifact、Approval、Usage。

任何查询都必须从已认证 principal 推导 `space_id`，禁止由客户端自由提交后直接使用。

### 8.2 建议新增实体

```text
spaces
memberships
runtime_hosts
resource_nodes
node_instances
resources
capability_revisions
project_resource_bindings
runs
attempts
attempt_leases
dispatch_outbox
dispatch_receipts
approvals
artifacts
plugin_desired_state
plugin_actual_state
usage_ledger
audit_events
```

### 8.3 API 草案

```text
POST /v1/spaces/:spaceId/nodes/register
POST /v1/spaces/:spaceId/nodes/:nodeId/heartbeat
GET  /v1/spaces/:spaceId/nodes
POST /v1/spaces/:spaceId/projects/:projectId/bindings

POST /v1/spaces/:spaceId/runs
POST /v1/spaces/:spaceId/runs/:runId/place
POST /v1/spaces/:spaceId/attempts/:attemptId/lease/renew
POST /v1/spaces/:spaceId/attempts/:attemptId/checkpoint

POST /v1/spaces/:spaceId/approvals
POST /v1/spaces/:spaceId/approvals/:approvalId/decision
GET  /v1/spaces/:spaceId/artifacts/:artifactId
GET  /v1/spaces/:spaceId/usage
```

所有 ID 仍需服务端鉴权。路径中的 `spaceId` 不是授权凭据。

### 8.4 存储演进

| 阶段 | 存储 |
| --- | --- |
| 单 Owner、多 Node alpha | 保留 PostgreSQL，补 schema 和事务边界 |
| 多 Space 单实例 beta | PostgreSQL + S3-compatible Artifact Store |
| 多 Control Plane 实例 | PostgreSQL、durable queue、分布式 lease |
| 跨区域 | 区域 Run Ledger、全局目录、Artifact replication |

不要直接把 Yjs 文档当作任务账本。Yjs 负责协作内容，Run Ledger 负责顺序、状态和授权。

## 9. 安全模型

### 9.1 基本原则

```text
有效权限 =
Human role
∩ Space policy
∩ Interaction profile
∩ Run policy
∩ Runtime policy
∩ Resource local grant
∩ Approval
```

每层只能收窄，不能扩大上游权限。

### 9.2 多租户隔离

首个商业版本采用：

- 共享身份、目录、计费和审计 Control Plane；
- 每 Space 独立 Runtime cell；
- 每 Space 独立数据库 schema 或强制 RLS；
- 每 Space 独立 Artifact prefix 和 encryption key；
- 不同 Space 的插件代码不进入同一执行进程；
- 高风险客户使用独立 VM/BYOC。

不要在当前单 Runtime 进程中直接加入 `user_id` 条件后宣称完成多租户。

### 9.3 Node identity

从 opaque bearer credential 演进到：

1. Node 生成不可导出的 Ed25519/P-256 私钥；
2. pairing 只登记公钥、角色和初始 Capability；
3. Control Plane 签发短期、audience-bound token；
4. 每次注册/heartbeat 使用 nonce proof；
5. Capability 扩权、trust zone 变化和 key rotation 重新审批；
6. Node revoke 立即使连接、lease 和 PTY 通道失效。

### 9.4 Invocation delegation

发送给 Resource Host 的调用必须携带短期 delegation：

```text
spaceId
runId
attemptId
invocationId
nodeId
resourceId
tool + version
canonical args hash
policy digest
approvalId
lease expiry
nonce
```

Resource Host 验证 delegation 后仍执行本地 grant。Capability advertisement 永远不能
代替本地授权。

### 9.5 Approval

Approval 必须绑定 canonical operation，而不是只绑定工具名：

- command、cwd、environment digest；
- 文件真实路径、inode/content digest 或 revision；
- 邮件收件人和正文摘要；
- 外部 API host、method 和 payload digest；
- operation ID、TTL 和可用次数。

参数发生变化后旧 Approval 失效。没有可达 Approval UI 时默认拒绝。

### 9.6 Side-effect 与重放

- Runtime 和 Device 都持久化 receipt；
- 先保存结果，再 ACK；
- 相同 operation ID 返回原结果；
- 不可幂等动作必须有补偿策略或禁止自动重试；
- Node restart 后 receipt 仍存在；
- 审计区分“已投递”“已执行”“结果已确认”。

### 9.7 插件供应链

- Manifest 声明每个 Host entry 的权限；
- package digest、publisher identity、SBOM 和签名；
- 安装前生成权限 diff；
- 更新不得静默扩权；
- Runtime entry 首版 allowlist；
- 第三方高风险代码优先在 Resource sandbox/out-of-process 执行；
- Plugin Desired/Actual state 按 Host 记录；
- 支持 pin、canary、rollback 和紧急 revoke。

### 9.8 Prompt injection

不能把模型对恶意输入的抵抗力当安全边界：

- 外部网页、邮件、附件和 Tool result 标记 provenance/trust；
- 非可信内容不能改变 Tool policy；
- 凭证以 handle 形式存在，在 egress 边界注入；
- 网络出口按目标域、method 和 credential owner 限制；
- 高风险工具采用独立执行计划与审批；
- 对读取敏感信息和外发信息做组合风险检测。

## 10. 规模化路线

### 10.1 Phase 1：单 Owner 多 Node

目标：3-10 台设备，1 个 Space，最多 20 个并发 Attempt。

交付：

- Node Registration v2；
- 显式 Node/Resource picker；
- project primary/replica binding；
- deterministic Placement v1；
- session affinity；
- `waiting_for_resource`；
- durable dispatch outbox；
- Device durable receipt；
- Runtime 重启后 Connector 原地重注册，不依赖进程退出；
- Node 状态、版本、负载和最近失败 UI。

这是下一阶段最重要的工程目标。

### 10.2 Phase 2：可信团队

目标：3-30 人、10-100 个 Node。

交付：

- Space、Membership、RBAC；
- Session creator/owner/participant；
- Approval inbox；
- Usage ledger、预算和配额；
- per-Space Runtime cell；
- PostgreSQL 和 Artifact Store；
- 审计导出；
- 项目级 Node policy；
- 邀请、离职和设备吊销流程。

### 10.3 Phase 3：托管平台

目标：100-1,000 个 Space、1,000-10,000 个注册 Node。

交付：

- Stateless Access Gateway；
- 独立 Registry / Placement / Dispatch；
- cell supervisor；
- horizontal worker pools；
- OIDC/SAML、SCIM、KMS；
- regional placement 和 data residency；
- tenant-level backup/restore；
- SLA、计费和支持系统。

在这个阶段，PostgreSQL 应退出共享 Control Plane，但可以继续作为单 cell 的本地缓存。

### 10.4 Phase 4：Runtime Federation

- Runtime identity 与 Attempt lease；
- checkpoint handoff；
- delegated Subrun；
- Artifact exchange；
- 跨区域 Control Plane；
- 不可信 Relay 下的端到端加密。

不要让 Phase 4 阻塞 Phase 1 的真实用户验证。

## 11. 商业模式

### 11.1 收费对象

优先对以下价值收费：

- Always-on Control Plane；
- 团队协作和 Approval；
- 审计、备份和保留期；
- 托管 Runtime cell；
- 企业身份、策略和私有部署；
- 托管模型、云计算和 Artifact 存储的实际使用量。

不建议仅按 Node 数收费。用户贡献自己的设备，本身降低了 Zion 的计算成本；对每台
设备收费会惩罚产品的网络效应。可以限制免费套餐 Node 数，但付费核心应是活跃成员、
并发 Attempt、托管计算和治理能力。

### 11.2 价格假设

以下仅用于客户访谈和支付测试：

| 套餐 | 建议假设 | 内容 |
| --- | --- | --- |
| Community | 免费自托管 | 1 Owner、3 Node、BYOK、本地存储 |
| Personal Pro | ¥99-199/月 | 托管 Control Plane、10 Node、远程访问、30 天历史 |
| Team | ¥299-599/活跃用户/月 | Space、Approval、审计、共享任务、预算 |
| Managed Runtime | 按秒/小时 + 模型成本 | 隔离 cell、云任务、Artifact |
| Enterprise | ¥20 万/年起 | BYOC、SSO/SCIM、KMS、审计导出、SLA 和支持 |

模型推理建议：

- 初期 BYOK，降低现金流和毛利风险；
- 托管模型按成本透明计费并设置预算；
- 不承诺“无限 Agent 使用量”；
- 用低价模型处理分类、压缩和路由，把高价模型留给关键步骤。

### 11.3 单位经济

Zion 的结构性优势可能来自：

- Control Plane 托管成本远低于完整执行环境；
- 计算和数据主要留在用户 Resource Host；
- WebRTC 直连减少 PTY 中转流量；
- BYOK 降低模型垫资；
- 企业愿意为审计、策略和私有部署付费。

主要成本：

- 模型推理；
- Artifact 存储和出口流量；
- Always-on Runtime cell；
- 安全响应、插件审核和企业支持；
- 多平台 Connector 维护。

### 11.4 市场信号

- OpenClaw 核心免费开源，市场上已有多家第三方托管服务以约
  15-49 美元/月销售“免部署的个人实例”；
- GitHub Copilot 官方个人套餐为 10/39/100 美元，Business/Enterprise 为
  19/39 美元每用户每月，并转向使用量计费；
- Cursor Teams 官方价格为 40/120 美元每用户每月，企业版另议。

这些只能证明用户愿意为“Agent + 托管 + 管理”付费，不能证明 Zion 的具体定价。
真正应验证的是多设备 Placement、Approval 和协作是否带来可重复使用。

## 12. 可行性

### 12.1 已有资产

- 独立 Runtime Core 和 Host；
- Session/Run/Event/Checkpoint/Artifact 基础；
- Node protocol、Broker、Connector 和 project binding；
- Runtime plugin API 与 Capability catalog；
- 一次性 pairing、设备 credential 和 revoke；
- Workbench/Yjs 多端实时投影；
- Scheduler、Memory、Skills、Mail、Terminal；
- HTTPS 单租户远程部署；
- WebRTC PTY 与 HTTP fallback。

这些足以完成单 Owner 多 Node alpha，不需要重写。

### 12.2 最大技术风险

| 风险 | 判断 |
| --- | --- |
| 错误 Node 执行 | 当前最高风险，必须先做显式 binding 和 Placement |
| 多租户越权 | 不能靠 UI filter，必须有 Space scope 和执行 cell |
| Prompt injection 导致副作用 | 必须用策略、sandbox、Approval 和 egress 控制 |
| Runtime/Device 双故障重复执行 | 需要双侧 durable receipt |
| 插件供应链 | 市场上线前必须签名、SBOM、权限 diff 和 revoke |
| 长任务恢复 | 需要 Attempt lease 和可声明 checkpoint |
| 多 Node 运维 | 版本 skew、自动升级和兼容窗口必须产品化 |
| 成本失控 | 每 Run 预算、模型路由和 usage ledger 必须早做 |

### 12.3 商业风险

- OpenClaw 的生态和渠道优势很强；
- Cursor/GitHub 已占据开发者入口；
- 多 Node 可能是高兴趣、低频使用的“演示功能”；
- 企业销售周期可能远长于产品现金流；
- 用户不会为架构优雅付费，只会为可靠完成任务付费；
- 自托管用户支持成本容易吞掉订阅收入。

### 12.4 综合判断

| 目标 | 可行性 |
| --- | --- |
| 单 Owner、3-10 Node | 高，现有代码可演进 |
| 可信小团队 | 中高，需要 Space/RBAC/Approval |
| 敌对多租户共享 Runtime | 低，不建议近期做 |
| 每 Space 隔离 cell 的托管平台 | 中，可分阶段交付 |
| 公共陌生 Node 市场 | 低，风险和运营成本过高 |
| 企业 BYOC | 中高，但需要安全与交付能力 |

## 13. 90 天实施建议

### 13.1 第 1-3 周：正确选择 Node

- 升级 Device protocol v2；
- Node 增加 labels、trust zone、capacity、load、epoch；
- Resource 增加 revision、consistency 和 local grant version；
- 新增 explicit preferred node/resource；
- 替换 `nodeId` 字典序首选逻辑；
- Workbench 增加 Node/Resource 管理页面；
- 测试两个 Node 暴露同名 Tool 的选择。

主要代码：

- `packages/node-protocol/src/index.mjs`
- `apps/runtime/src/node-broker.mjs`
- `apps/runtime/src/postgres-node-state-store.mjs`
- `apps/device-connector/src/main.mjs`
- Workbench Remote Access 设置页。

### 13.2 第 4-6 周：可靠等待和恢复

- 增加 `waiting_for_resource`；
- 持久化 dispatch outbox；
- Device receipt 持久化；
- Node 原地重注册和 generation；
- session/resource affinity；
- 只读调用重试与副作用调用恢复测试；
- Node 离线、Runtime 重启、网络分区 E2E。

### 13.3 第 7-9 周：Approval 和 Artifact

- canonical operation；
- Approval inbox、TTL、撤销；
- Device 本地审批和 kill switch；
- Artifact blob + digest + provenance；
- diff、测试报告和日志使用 Artifact reference；
- 每个 Tool Call 的成本和耗时记录。

### 13.4 第 10-12 周：首批团队验证

- 选择 3-5 个真实团队；
- 每个团队至少有 2 台 Resource Host；
- 只验证一个研发工作流；
- 每周复盘成功率、错误路由、审批次数和节省时间；
- 不在此阶段建设公共插件市场和 Kubernetes 平台。

## 14. 成功指标与停止条件

### 14.1 产品指标

- 首次配对到成功执行小于 5 分钟；
- 多 Node 用户周留存高于单 Node 用户；
- 30% 以上活跃 Run 使用远程或第二 Node；
- 90% 以上 Placement 无需人工纠正；
- Resource 离线后的恢复成功率高于 95%；
- 高风险动作 100% 有 Approval 或明确拒绝；
- 团队每周至少有一个 Run 被他人观察、审批或接手；
- 用户能指出 Zion 替代的具体人工流程和时间。

### 14.2 商业指标

- 10 个设计合作伙伴中至少 3 个愿意付费；
- Personal 用户月均基础设施毛利为正；
- Team 版毛利不依赖限制用户使用；
- 企业客户为治理/私有部署付费，而不是只购买定制开发；
- 支持工时不超过订阅收入可承受范围。

### 14.3 停止或转向条件

出现以下情况时，不应继续投入通用多 Node 平台：

- 用户只把它当远程桌面或 SSH 替代；
- 第二 Node 使用率长期低于 10%；
- 用户不愿为 Approval、审计或后台持续运行付费；
- 可靠 Placement 需要大量人工配置仍无法解释；
- 大部分价值来自单一垂直工作流。

最后一种情况不一定失败，可能意味着应收缩为垂直产品。

## 15. 近期必须做出的决策

1. **首个用户是谁**：建议锁定 3-30 人 AI 研发团队，而不是普通消费者。
2. **首个工作流是什么**：建议是跨本地仓库和云端 Runtime 的长代码任务。
3. **租户隔离方式**：建议共享 Control Plane、每 Space 独立 Runtime cell。
4. **收费主轴**：建议席位 + 托管 Runtime/模型用量，不按普通 Node 数收费。
5. **是否开源**：至少协议、Connector 和 Plugin SDK 应开放，Control Plane 可商业化。
6. **是否做公共 Node 市场**：建议明确否决到 Phase 4 以后。
7. **是否立即上 Kubernetes**：建议否，先用 cell supervisor 验证产品。
8. **是否保存完整明文事件**：企业版需支持客户密钥或端到端加密 Artifact。

## 16. 建议的下一步

立刻进入一个六周技术里程碑：

> 两台真实 Resource Host 同时在线时，用户可以看到资源差异，将 Project 固定到指定
> Node；Node 离线后 Run 明确等待，恢复后继续；任何写入都经过审批；全过程有
> placement explanation、receipt 和测试 Artifact。

这是 Zion 从“远程 Workbench”迈向“可信 Agent 工作网络”的最小可信证明。

## 17. 调研来源

官方和一手资料：

- OpenClaw README：<https://github.com/openclaw/openclaw>
- OpenClaw Security：<https://docs.openclaw.ai/gateway/security>
- OpenClaw Multi-tenant hosting：
  <https://docs.openclaw.ai/gateway/multi-tenant-hosting>
- OpenClaw Nodes：<https://docs.openclaw.ai/nodes>
- OpenClaw Multi-user mode：<https://docs.openclaw.ai/concepts/multi-user>
- OpenClaw Plugins：<https://docs.openclaw.ai/plugins>
- GitHub Copilot plans：<https://docs.github.com/en/copilot/get-started/plans>
- GitHub usage-based billing：
  <https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/>
- Cursor Teams pricing：<https://cursor.com/docs/account/teams/pricing>
- NIST SP 800-207 Zero Trust Architecture：
  <https://csrc.nist.gov/pubs/sp/800/207/final>
- SPIFFE workload identity：<https://spiffe.io/docs/latest/spiffe-about/overview/>
- SLSA supply-chain specification：<https://slsa.dev/spec/v1.0/>
- OWASP Top 10 for LLM Applications：
  <https://owasp.org/www-project-top-10-for-large-language-model-applications/>

市场信号，非官方 OpenClaw 定价：

- <https://tryopenclaw.ai/pricing/>
- <https://useopenclaw.ai/pricing/>
- <https://openclawcloud.app/pricing>

第三方价格只能说明托管需求和价格区间，不能代表 OpenClaw 官方商业策略。
