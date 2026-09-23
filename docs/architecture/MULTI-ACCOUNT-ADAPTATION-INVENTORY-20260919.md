# 多账号适配全量盘点与改造路线

日期：2026-09-19
状态：架构盘点；用于拆解实施任务，不代表所有条目已完成
适用边界：小团队独立部署；一个 Runtime 固定绑定一个 Space

## 1. 结论

这次改造范围大，但不是“给所有表加 `user_id`”或“把 Runtime 重写成共享
多租户服务”。

当前已经完成了最重要的底座：

- 一个账号 Runtime 的数据库和数据目录不可变绑定一个 Space；
- 用户通过 OIDC 登录，通过 Membership 获得 Space 角色；
- Run 使用服务端签发的 RunGrant 和 RunPrincipal；
- 模型、工具、恢复执行和后台任务具备动态重验入口；
- Resource 身份与浏览器用户会话分离；
- Observability 使用独立、脱敏、只读的 Space 投影库。

剩余工程主要集中在四类问题：

1. **状态归属未定义**：评论、插件启用、模型选择、Agent Task、Memory、
   Identity 等历史状态没有明确是 Space 共享、用户私有还是设备偏好。
2. **浏览器 origin 不是账号边界**：`localStorage`、IndexedDB、模块内缓存和
   React Query 缓存在同一 origin 的账号之间天然共享。
3. **能力声明没有全部落到执行点**：部分插件 `requiredScopes` 仍只是展示
   元数据；后台授权的创建、替换和撤销还不是一个原子生命周期。
4. **个人数据模型缺失**：`scope=user`、`user.md` 目前只有标签或固定文件名，
   没有真实的用户命名空间。

按当前“一 Space 一 Runtime”边界，Session、Run、评论、团队 Skill、团队
Memory、模型配置和 Scheduler Task 可以继续作为 Space 共享对象。需要新增
的是创建者/操作者归因、个人态分离和所有入口的实时授权，而不是复制整套存储。

## 2. 统一归属模型

所有持久或缓存状态必须明确属于下列一种范围：

| 范围 | 含义 | 典型对象 | 隔离手段 |
| --- | --- | --- | --- |
| Deployment | 当前服务实例及运维者控制的配置 | Runtime 插件包、IdP 配置、日志 sink | OS 用户、服务配置、发布流程 |
| Space | 团队成员按角色共享 | Session、Run、评论、模型 Profile、Scheduler Task | 独立数据目录和 PostgreSQL |
| User | 同一账号跨设备持有的个人状态 | 个人 Memory、个人档案、个人默认偏好 | 服务端 `userId` 命名空间或个人 Space |
| Device | 只在当前浏览器/设备有意义 | 面板布局、字体、当前 tab、终端 UI 焦点 | 本地存储；账号切换时重绑定或清理 |
| Resource | 被配对执行节点持有 | 机器、Workspace、Terminal Session、文件系统 | Space 配对、Resource 本地策略、RunGrant |
| Run | 一次被授权执行的不可扩大能力 | Principal、Profile、Tool policy、模型请求 | RunGrant 和逐次重验 |

必须区分四个容易混淆的概念：

- **归属**：数据属于哪个 Space、User、Device、Resource 或 Run。
- **可见性**：谁可以读取该数据。
- **可变更性**：谁可以创建、修改、删除。
- **归因**：是谁触发了本次变化。

例如 Session 可以是 Space 共享对象，但每条消息和编辑操作仍应记录
`actorUserId`；这不意味着 Session 变成该用户私有。

## 3. 不可破坏的架构约束

1. **Space 是物理隔离单元**
   每个 Space 使用独立 Runtime、`PostgreSQL database`、`PostgreSQL observability tables`、
   插件数据目录、模型凭证和 Resource 配对。不能依赖请求中的 `spaceId`
   模拟隔离。

2. **客户端不能声明可信身份**
   `userId`、角色、Space、RunPrincipal 和授权范围由服务端会话与 grant
   派生。客户端传入的同名字段必须忽略或拒绝。

3. **登录会话不等于执行授权**
   浏览器 Cookie 只证明当前用户。每次 Run、Tool、子 Agent、Scheduler 和
   Project Automation 都使用独立 RunGrant。

4. **持续连接必须重验**
   SSE、WebSocket、Device relay 和长时间模型/工具调用不能只验证握手。
   Membership、角色或 grant 撤销后，下一次可中断点必须拒绝继续。

5. **浏览器存储不承载秘密或权威业务数据**
   HttpOnly Cookie、模型密钥和后台委托不能进入 JavaScript 存储。
   IndexedDB/localStorage 只能保存明确的 Device 态或可丢弃缓存。

6. **插件和 Skill 不是安全边界**
   同进程 Runtime 插件是受信服务端代码；Skill 是给模型的说明。真正授权
   必须发生在 API、Tool Broker、Resource Host 和文件执行点。

7. **Observability 只提供事实**
   仅记录、脱敏、投影、受控查询和原始证据读取。诊断结论、根因假设和修复
   由上层 Agent 流程负责。

## 4. 数据归属总表

| 领域 | 当前主要存储 | 目标归属 | 当前状态 | 主要改造 |
| --- | --- | --- | --- | --- |
| 用户、Membership、登录 | `account_*` | User + Space | 已具备 | 邀请撤销、运维和审计补齐 |
| Workbench Session/Yjs | Runtime PostgreSQL | Space | 基本正确 | 增加操作者归因；明确无私密 Session ACL |
| Run/Attempt/Transcript | Runtime PostgreSQL | Space，Run 归因到 User/Service | 基本正确 | 补齐保留策略和历史 legacy 标记 |
| 评论 | 浏览器 localStorage + IndexedDB | 建议 Space | 缺口 | Runtime 持久化、作者归因、协作和迁移 |
| Agent 定义/任务 | Runtime plugin KV | Space | 部分 | 创建者/更新者、管理权限和生命周期 |
| 子 Agent | 父 Run 派生 | Run | 基本正确 | 保证 grant 上限继承和父子审计 |
| 模型 Profile | Runtime 文件 | Space | 基本正确 | 仅管理员管理；拆分个人“最近使用” |
| 模型凭证 | Runtime credential 文件/环境变量；旧浏览器 localStorage | Deployment/Space Secret | 高风险缺口 | 清除浏览器密钥，服务端 write-only |
| LLM 请求事实 | Run Ledger + Transcript | Run/Space | 部分 | 原始正文保留策略、只经受控证据读取 |
| Runtime 插件 | 启动配置 | Deployment/Space | 基本正确 | 管理权限和发布治理 |
| Workbench 插件 | localStorage + IndexedDB | Space 安装，Device 激活 | 高风险缺口 | 服务端 allowlist、账号切换隔离 |
| Tool 目录和 Policy | Runtime + Interaction Profile | Space + Run | 部分 | 执行 `requiredScopes`，统一授权交集 |
| Skill 目录 | Runtime KV/Resource 来源 | Space 安装，Run 激活 | 部分 | installed/allowed/activated 三阶段 |
| Memory | Runtime plugin KV；旧浏览器态 | Space 或 User | 高风险缺口 | 真实 owner/scope；禁止标签冒充隔离 |
| Identity `user.md` | Space 插件目录固定文件 | User/个人 Space | 高风险缺口 | 团队 Space 不注入共享个人档案 |
| Terminal/机器 | Resource Host | Resource + Space | 部分 | 创建者归因、可见性和 UI 选择隔离 |
| Scheduler | Runtime PostgreSQL + task grant | Space + Service Principal | 部分 | grant 与任务原子创建/替换/撤销 |
| Project Automation | Identity 文件 + delegation | Space + Service Principal | 部分 | 配置摘要绑定、操作者审计和回收 |
| Observability | 独立 PostgreSQL 投影 | Space | 方向正确 | 修复脱敏、修订时序和 replay 完整性 |
| 账号安全审计 | `account_audit` | Space | 已具备基础 | 扩大覆盖面、保留/导出策略 |
| 进程日志 | stderr/部署日志 | Deployment/Space | 未规范 | 结构化 Space/actor/run 字段和强脱敏 |
| CLI 凭证 | macOS Keychain | User + Runtime origin | 部分 | 非 macOS credential store |
| UI 布局和草稿 | localStorage | Device，部分应为 User | 未分类 | 建立 allowlist；身份变化时重绑定 |

## 5. 逐域分析

### 5.1 账号、Membership 与邀请

**当前**

- `PostgresAccountStore` 将一个账号数据库绑定到一个 Space。
- 外部身份以 `(issuer, subject)` 映射内部用户，不使用邮箱作为唯一键。
- 登录会话、Resource 凭证和 RunGrant 是三套独立凭证。
- 角色为 owner/admin/member/viewer，最后一个 Owner 受保护。
- 成员移除会撤销该用户现有 RunGrant。

**缺口**

- `account_invitations` 有 `revoked_at` 字段，但缺少完整的邀请列表和撤销流程。
- 安全审计目前覆盖账号核心动作，尚未覆盖所有 Space 配置、插件、模型、评论和
  Memory 变更。
- 角色是粗粒度上限，不应继续为每个新功能增加角色。新能力优先映射到稳定 scope。

**改造**

- 增加邀请查询/撤销和过期清理。
- 建立统一 `actor` 审计字段：`userId`、`sessionId`、`runId`、`grantId`、
  `source`。
- 新增控制面 API 时必须显式选择 scope；默认不能落入普通成员可写。

### 5.2 插件

**当前**

- Runtime 插件由进程启动配置决定，属于部署级受信代码。
- Runtime plugin state 通过
  `runtime.plugins.<plugin>.<namespace>.<key>` 写入 Space 的 Workbench KV。
- Workbench 插件的安装记录、启用状态和开发会话保存在 origin 级
  localStorage；ZIP 插件脚本保存在 origin 级 IndexedDB。
- Workbench 初始化会恢复已安装插件并自动激活启用项。

**风险**

- 同一浏览器从账号 A 切换到账号 B 时，会继续使用 A 留下的插件代码、开发目录和
  启用状态。
- “已安装”“被 Space 管理员允许”“当前会话激活”目前混成一个 `enabled`。
- Workbench 插件运行在同一页面，可访问页面能力和带 Cookie 的 API；不能把它描述
  成安全沙箱。

**目标**

```text
installed  = Deployment/Space 已安装并验证的插件版本
allowed    = Space 管理策略允许该插件向哪些角色/Profile 暴露能力
activated  = 当前 Device/Session 实际加载或当前 Run 选中的能力
```

**改造**

- Runtime 插件保持部署级配置，不做用户级热切换。
- Workbench 插件安装/升级/开发模式只允许管理员，服务端保存 Space allowlist 和版本。
- IndexedDB 只作为按 `spaceId + pluginId + version + digest` 缓存的代码副本。
- UI 启用偏好可为 Device/User 态，但不能扩大 Space allowlist。
- 账号身份变化时停止插件、清空模块缓存并重新 bootstrap；不能只刷新角色文本。

### 5.3 Tool

**当前**

- Tool 可来自 Runtime core、Runtime plugin 或 Resource Node。
- Interaction Profile 给出上限，RunGrant 固化发行时的 Profile/角色上限，
  执行时再与当前角色和当前 Profile 相交。
- Receipt lookup 前已经增加授权重验，避免撤销后通过缓存结果绕过。
- 插件 manifest 的 `requiredScopes` 已规范化并展示在 Tool definition 中。

**缺口**

- `RuntimePluginService.listTools()` 和 `invoke()` 只检查 allowedTools 和 preset，
  尚未实际检查 `requiredScopes`。
- Receipt replay 虽然会重新验证 grant 和 Tool 名，但发生在插件 minimum preset、
  requiredScopes 和 Resource 参数边界检查之前；Profile 收紧后仍可能返回旧结果。
- Runtime plugin Tool 当前跳过 `AnalysisToolBroker` 的 Resource 路由检查；
  `terminalManage` 等插件工具可能绕过部署级 Resource execution 总开关。
- 部分插件内部只检查 preset，依赖外层 Tool Broker 正确传递 principal。
- Tool 注册状态是实例级，Tool 可见性和可调用性不能只靠前端隐藏。

**改造**

- Tool Broker 在列举和调用时统一计算：

```text
Membership 当前 scopes
∩ RunGrant scopes/policy
∩ 当前 Interaction Profile
∩ Tool requiredScopes/minimumPreset
∩ Resource 本地策略
```

- Runtime plugin 不自行解析用户身份；统一消费 Broker 传入的可信 meta。
- 每个外部副作用 Tool 记录 actor、grant、Resource、参数摘要和结果类别。

### 5.4 Skill

**当前**

- Runtime 从插件和 Resource 来源建立 Skill catalog，快照保存在 Space KV。
- Interaction Profile/Session 选择启用 Skill。
- Skill 可以说明如何组合通用 Tool，但本身不授予权限。

**目标**

- `installed`：Space 可发现的 Skill 内容和来源。
- `allowed`：管理员/Profile 允许当前角色使用的 Skill。
- `activated`：FTS Top-K 或用户显式选择后，进入当前 Run 上下文的 Skill。

**改造**

- Skill 来源、版本和 digest 作为 Space 配置管理；Resource 离线时保留的只能是缓存说明。
- activated 结果属于 Run/Session，不写成整个 origin 的全局开关。
- Skill 中声明的 Tool、文件和命令仍须经过 RunGrant；不得根据 Skill 名绕过。
- 继续使用 Top-K 检索，避免把所有已安装 Skill 注入上下文。

### 5.5 模型与凭证

**当前**

- Runtime 模型 Profile 和 Interaction Profile 位于当前 Runtime 数据目录。
- Runtime credential provider 使用环境变量或权限为 `0600` 的服务端文件。
- 对外 API 只返回 `credentialConfigured`，不回读密钥。
- 旧 Workbench provider、模型设置页和 `modelsManage` 仍会把 API Key 明文写入
  localStorage。

**目标**

- 模型 Profile 是 Space 配置，只允许 admin/owner 管理。
- 模型凭证是 Deployment/Space secret；首版不做个人 BYOK。
- Session 可以固定模型；“最近使用的模型”可以是 User/Device 偏好。

**改造**

- 删除所有浏览器 API Key 持久化和运行时读取路径。
- 提供一次性迁移：用户确认后将旧 key 写入 Runtime write-only API，再删除本地 key。
- 账号模式下前端 provider 只使用 Runtime Profile，不直接向模型厂商发送请求。
- 凭证文件纳入备份、权限和密钥轮换流程；后续有需要再接 OS keyring/KMS。

### 5.6 LLM 请求、响应和 Transcript

**当前**

- Run Ledger 保存 `model.request`，Transcript 保存完成消息、reasoning、tool call
  和结果。
- Observability 长期投影只保存 provider/model、数量、耗时、usage 和稳定错误类别。
- 插件直接模型调用在开始和流式处理中重复验证当前 Run 授权。

**归属**

- 请求/响应属于 Run 和 Space，不属于“模型配置的创建者”。
- `principal.userId` 用于归因，不能作为查询时由客户端提供的过滤条件。
- 模型凭证不属于 request event，也不能写入错误正文。

**缺口**

- 完整 `model.request` 会重复保存消息和 Tool Schema，Ledger 尚无明确保留/压缩策略。
- 原始错误和响应头必须在进入 Ledger 前分类，不能依赖下游观测投影补救。

**改造**

- 为 request payload、checkpoint、transcript 分别制定保留期和容量预算。
- 原始证据读取只能通过当前 Space 的受控 Raw Read，并逐次重验和审计。
- 不向模型提供 Runtime 主库 SQL、模型凭证或任意日志文件读取。

### 5.7 Session、对话与协作

**当前**

- Session 文档、树、Yjs state、Transcript 和消息投影以 Runtime PostgreSQL 为权威。
- 首版产品语义明确为 Space 内成员共享，viewer 只读。
- Yjs 握手和广播路径已经支持只读和 Membership 动态重验。
- Workbench state SSE 在循环内重验当前登录身份。

**缺口**

- Session/Workbench mutation 主要记录 source client 和 revision，缺少统一
  `actorUserId` 归因。
- 当前没有“仅本人可见 Session”ACL。不能让 UI 图标暗示已经具备私密对话。
- Mobile 同角色账号切换不会刷新内存身份和 Query cache，后续请求已按新 Cookie
  执行，但页面仍显示旧账号状态。
- viewer 仍可从新增的根级拖放入口乐观修改 Session tree；服务端虽拒绝写入，
  客户端不回滚并会阻塞后续持久化队列。
- reload 准备超过固定超时后会绕过 durable flush，慢网络下可能丢失待提交编辑。

**改造**

- 保持 Session 为 Space 共享，不给所有 Session 表增加 owner 过滤。
- 在消息、创建、重命名、删除、恢复和 fork 事件中补充 actor 审计。
- 身份指纹至少包含 `space.id + user.id + sessionId + membership.revision`；
  任一变化都清理内存缓存并重新 bootstrap。
- 私密 Session 作为未来独立 ACL 方案，不在当前角色模型上打补丁。

### 5.8 评论

**当前**

- 评论索引保存在 `zion.comments.threads.v1` localStorage。
- 评论正文和记录归档保存在 `zion.sessions.db` IndexedDB。
- 评论 Agent Run 使用 `comment:<id>` Session，但传入
  `skipSessionPersistence: true`。

**问题**

- 评论没有进入 Runtime 权威存储，不能在团队成员和设备间可靠共享。
- 同一浏览器切换账号会直接看到上一个账号留下的评论状态。
- 没有作者、编辑者、删除者和解决者身份，也无法做服务端权限检查。

**目标**

评论是 Space 共享 Session 的协作对象，因此推荐定义为 Space 数据：

- Thread：`spaceId/sessionId/anchor/createdBy/createdAt/status`；
- Comment message：`threadId/authorUserId/body/createdAt/editedAt`；
- Resolve/delete：记录 actor 和 revision；
- 评论 Agent Run：继承发起人的 RunGrant，不能成为无主体后台身份。

浏览器只保留当前展开项、草稿和滚动位置。现有 localStorage/IndexedDB 数据由
当前用户显式导入，不自动宣称属于 bootstrap Owner。

### 5.9 Agent 与子 Agent

**当前**

- Agent Task 快照保存在 Runtime plugin KV，因此实际上是 Space 共享状态。
- 子 Agent 由父 Run 启动，传递父 principal、parentRunId 和收窄后的 policy。
- 子任务不能获得父任务未拥有的 Tool、文件根、终端或收件人权限。

**缺口**

- Agent Task 没有明确的 `createdBy/updatedBy` 和编辑权限语义。
- Space 共享任务与用户临时任务没有区分。
- 任务状态更新来自插件异步回调，需保证 Runtime 重启后的运行态收敛。

**改造**

- 团队 Agent 定义/任务作为 Space 对象，由成员在 Profile 上限内创建，管理操作写审计。
- 个人临时任务只属于当前 Session/Run，不进入 Space 任务目录。
- 子 Agent 始终复用父 grant 上限；不签发隐式“子 Agent 系统权限”。
- 父 grant 撤销或 Membership 移除后，子 Agent 下一次模型/Tool 调用失败。

### 5.10 Memory

**当前**

- Runtime Memory 是一个 Space 级 plugin KV snapshot。
- Memory item 有 `scope=user/project/workspace/agent` 标签。
- 自动注入只按 layer、enabled、pinned 和相关性选择，未按当前 principal 过滤。
- `scope=user` 没有 `ownerUserId`，因此目前只是展示标签，不是隔离。

**风险**

任一成员写入的 user Memory 都可能被注入其他成员的 Run。这既会泄露个人偏好，
也会让模型把不同用户的要求混成同一个人。

**目标**

- Team Memory：Space 共享，适用于项目规则、架构事实和团队约束。
- Personal Memory：User 私有，只注入该用户发起的 Run。
- Agent Memory：绑定稳定 Agent ID，并仍受当前 Space/User 可见性约束。
- Session 临时记忆：Run/Session 生命周期，不进入长期 Memory。

**最小实现建议**

首版不要在同一 KV 文档内用字符串前缀模拟 ACL：

1. 把现有 `project/workspace` 条目明确迁为 Space Team Memory。
2. 在团队 Space 暂停 `scope=user` 自动注入。
3. 个人 Memory 优先放入个人 Space；需要团队 Runtime 使用时，再设计受控引用。
4. 如果以后必须同库保存，再增加服务端 User store 和 owner-aware API，而不是让模型
   拼接 `users/<id>` 路径。

### 5.11 Identity

**当前**

- Identity 插件在 Space 插件目录中使用固定的 `identity.md`、`user.md` 和
  `biography/events.jsonl`。
- 每个 Session 构建稳定 Identity snapshot；新事件影响后续 Session。
- 文件访问和 Project Automation 已接入 RunGrant。

**问题**

团队 Space 中只有一份 `user.md`，无法表示多个用户。继续自动注入会把某个用户的
称呼、偏好、项目地图和边界暴露给所有成员。

**目标**

- `identity.md`：可以是 Space 共享的 Agent 身份和工作原则。
- `user.md`：必须属于登录用户或其个人 Space。
- biography：至少区分团队事实与个人关系史，不能用一个 append-only 文件混写。

**最小实现建议**

- 团队 Space 仅注入共享 Agent Identity 和 Team Context。
- 个人 `user.md`/relationship biography 留在个人 Space。
- 在个人上下文桥接未设计前，团队 Run 不注入 `user.md`，而不是假装当前固定文件
  就属于请求用户。

### 5.12 Terminal、Resource 与文件

**当前**

- Resource 使用独立配对凭证，绑定当前 Space，不随浏览器 logout 删除。
- 账号模式普通成员不能执行任意 Resource Tool；管理员还需部署开关显式开启。
- Run policy 可约束 node、file roots、command prefixes 和 terminal session IDs。
- 插件业务文件位于当前 Space 的插件数据目录。

**归属**

- Machine/Workspace/Terminal Session 属于 Resource，并通过配对归属 Space。
- 当前 Terminal Panel 选中的 Session 是 Device UI 状态，不是 Agent 授权。
- 文件内容属于 Space/Resource；创建者只用于审计，不自动形成私有 ACL。

**缺口**

- Terminal Session 数据缺少稳定的创建者、用途和生命周期主体。
- 账号切换后本地 active terminal 可能残留；服务端会拒绝越权，但 UI 会误导。
- Windows 存储边界检查对 `..\child` 的分隔符判断不完整，存在路径越界风险。

**改造**

- Resource session 增加 `createdByPrincipal`、purpose 和 cleanup policy。
- 账号身份变化时重置 active terminal 和 Resource 管理缓存。
- 使用 `path.relative` 的平台分隔符或统一 `isPathInside` 修复 Windows 路径校验。
- 不以目录名、环境变量、terminal session ID 或 node label 作为授权凭据。

### 5.13 Scheduler 与 Project Automation

**当前**

- Scheduler Task/Run 是 Runtime PostgreSQL 中的 Space 共享对象。
- 创建/更新任务时签发最长 30 天的 service RunGrant。
- Worker 使用任务保存的 principal，每次执行继续与当前 Membership/Profile 相交。
- 删除/替换任务后会尝试撤销旧 grant。
- Project Automation 将 grant 与配置 policy hash 绑定，配置变化需要重新授权。

**缺口**

- Scheduler 先签发 grant，再校验并保存 Task。任务校验、revision 冲突或写库失败时会
  遗留无任务引用的 active grant。
- 普通 Run admission 也在 Session/消息持久化和 executor 启动前签发 grant；
  admission 后续失败会留下无 Run 引用的短期 grant。
- Task 缺少直接可查询的 createdBy/updatedBy 展示字段。
- 旧任务没有 grant 时的“禁用并要求重绑”需要迁移报告和 UI 状态，而不只是执行失败。
- Project Automation 选择自定义 Interaction Profile 时，当前委托仍可能按默认
  Profile 签发，导致批准时和实际启动时的权限上限不一致。
- 周期任务 grant 失效后，Worker 在验证前创建 Scheduler Session；每次触发都可能留下
  一个空的共享 Session，而不是把任务置为“需要重新授权”。

**改造**

- 预分配 Task ID，把 grant 签发、Task 写入、旧 grant 撤销放入一个事务边界或补偿流程。
- Task 记录 delegation owner、grantId、授权到期时间和 policy digest。
- 到期、成员移除、角色降低、Profile 收紧和 Resource 下线分别显示可解释状态。
- 后台委托不因浏览器 logout 自动撤销；只有明确撤销、成员移除或到期才停止。

### 5.14 Observability、日志与审计

**当前**

- `PostgreSQL observability tables` 只保存白名单事实，按 Space 固定绑定。
- `observabilityQuery` 在独立只读 Worker 中执行受限 SQL。
- `observabilityRawRead` 按 Run/sequence 读取精确原始证据并写账号审计。
- 流式 delta 不再进入永久 Ledger；完整结果由 Transcript 和 completed event 保存。

**确定缺陷**

- `server.mjs` 残留无条件调试 HTTP 上报，默认向
  `http://127.0.0.1:7777/event` 发送 Run/Session 标识和消息映射；Workbench
  Runtime backend 还有同类固定 loopback 上报，发布前必须全部删除。
- Raw Read 对字符串只使用不完整的正则脱敏，无法识别带引号 JSON 键以及
  `TOKEN/COOKIE/SECRET/CREDENTIAL` 等常见环境变量形式。
- denied Tool 会使调用序号与 `tool.requested` 数量分离；Raw Read 用后者推导
  receipt ID 时可能读不到精确持久结果，只返回截断的 Ledger fallback。
- `obs_runs` 重建修订使用当前 Run 终态，可能把历史 started 修订写成 completed。
- RunLiveHub replay 淘汰或慢消费者丢队头后，没有 gap/reset 信号，重连可能静默漏事件。
- 首次启动对历史 delta 的同步单事务删除没有批次和进度游标，大库可能长时间阻塞启动
  或产生过大的 WAL。

**边界**

- Observability 可以记录 `userId` 做归因，但所有成员查询的是同一 Space 事实。
- 进程日志属于 Deployment/Space，不应直接暴露给模型；需要的内容先分类、脱敏和审计。
- 账号安全审计与运行观测是两套数据：前者回答“谁改变了权限/配置”，后者回答
  “系统实际执行了什么”。

**改造**

- 字符串先尝试受限 JSON 解析并递归脱敏，再执行普通文本模式。
- 投影保留事件发生时的状态修订，不使用当前终态回填历史。
- replay 缺口返回显式 reset/gap，并从永久语义事件补齐可恢复部分。
- 为 Ledger request/checkpoint/transcript 和部署日志分别设置 retention/capacity。

### 5.15 CLI、Mobile 和 Workbench

**当前**

- CLI account profile 固定 Runtime origin；macOS 使用 Keychain。
- Workbench 在 `user.id`、角色或 Membership 状态变化时 reload。
- Mobile 轮询只比较 Membership 状态和 scopes。
- 大量 UI 设置、草稿、插件信息、模型配置和旧业务数据仍位于 localStorage/IndexedDB。
- CLI 的 `--account --url` 覆盖发生在默认 Profile 的 origin/credential 校验之后；
  配置了其他 origin 的默认认证 Profile 时，文档中的一次性账号命令可能被错误拒绝。

**改造**

- 统一身份指纹和 `onIdentityChanged` 行为：终止流、清 Query cache、清模块内账号态、
  重新加载插件和 Session。
- 对浏览器键做清单分类：
  - Device allowlist：主题、字体、面板布局、通知偏好；
  - User key：草稿、最近模型、个人筛选；
  - Space cache：插件代码、catalog、共享 Session replica；
  - Forbidden：token、API key、后台委托、权威评论/Memory。
- User/Space 键必须带稳定 namespace；Forbidden 键启动时迁移后删除。
- 非 macOS CLI 增加 OS credential-store adapter；没有适配器时明确失败，不落 JSON。

## 6. 横切缺口

### 6.1 浏览器身份切换协议

仅比较角色或 scopes 不够。建议统一：

```text
identityFingerprint =
  runtimeOrigin + spaceId + userId + loginSessionId + membershipRevision
```

指纹变化时：

1. 停止 SSE/WebSocket/轮询；
2. 清空账号相关内存状态和 Query cache；
3. dispose Workbench 插件与编辑器绑定；
4. 清除 User 临时草稿；Space cache 重新校验；
5. 重新请求 account/session、catalog、Session snapshot；
6. 重新建立持续连接。

首版可直接整页 reload，避免为了无刷新切换引入复杂状态机。

### 6.2 操作者归因

Space 共享不等于匿名。以下动作至少写账号审计或领域事件：

- Session 创建、删除、恢复、fork；
- 评论创建、编辑、解决和删除；
- 模型/Profile/插件/Skill 配置变更；
- Memory/Identity 变更；
- Resource 配对、Terminal 创建/关闭；
- Scheduler/Project Automation 创建、更新、授权和撤销。

### 6.3 统一授权时机

| 时机 | 必须检查 |
| --- | --- |
| HTTP/WS/SSE 建立 | 当前登录、Membership、请求 scope |
| Run 创建 | 角色、Profile 上限、requested policy |
| 每次模型调用 | Membership、grant、当前 Profile |
| 每次 Tool 调用 | 上述条件 + Tool scope/preset + Resource policy |
| Receipt 返回 | 与真实调用相同的当前授权 |
| 子 Agent 启动 | 父 principal 和收窄 policy |
| 后台任务 claim/执行 | service grant、Membership、Profile、Resource |
| Raw evidence 读取 | Space、observability scope、actor Run、审计 |

### 6.4 迁移语义

不能把旧数据全部标成 bootstrap Owner 创建：

- 历史 Run/Session 作者未知时保留 `legacy`；
- 旧共享 Session 迁为 Space 数据；
- 旧浏览器评论、个人 Memory、`user.md` 需要用户显式认领；
- 旧 Scheduler Task 在账号模式中默认 disabled，管理员重新授权；
- 旧 Client 配对凭证不能自动升级为账号 Membership；
- 旧浏览器 API Key 只允许一次性导入 Runtime，成功后删除。

## 7. 实施依赖与分期

### 7.1 依赖关系

```text
Space 物理绑定（已完成）
  -> Account/Membership/RunGrant（已完成基础）
     -> 统一身份切换协议
     -> Tool requiredScopes 执行
     -> Scheduler/Automation 授权生命周期
     -> 评论与领域变更归因
     -> Personal Memory/Identity

Space 插件治理
  -> Workbench 插件缓存隔离
  -> Skill installed/allowed/activated
  -> 模型和 Tool 配置管理

Run Ledger
  -> Observability 投影
  -> Raw evidence
  -> retention / replay 完整性
```

### 7.2 分阶段任务

| 阶段 | 目标 | 主要任务 | 规模 |
| --- | --- | --- | --- |
| P0 | 封住确定的数据泄露和身份错配 | 删除调试上报、Raw Read 脱敏、浏览器 API Key、禁用共享个人 Identity/Memory 注入、Mobile 身份切换、Windows 路径边界 | M |
| P1 | 固化控制面授权 | Tool requiredScopes/Resource 总开关、Receipt replay、插件管理 scope、任务 grant 原子生命周期、邀请撤销 | M |
| P2 | 让共享协作语义成立 | 评论 Runtime 化、领域 actor 审计、Agent Task 归因、账号切换清缓存 | L |
| P3 | 分离个人数据 | Team/Personal Memory、团队 Identity 与个人 `user.md`、显式导入 | L |
| P4 | 插件和 Skill 治理 | Space allowlist、版本/digest、浏览器缓存 namespace、Top-K 激活 | L |
| P5 | 完整性与运维 | replay/reset、投影修订、retention、备份恢复、迁移演练 | M |

`M/L` 是相对工作包，不是人日承诺。P2、P3、P4 可以在边界接口稳定后并行。
真正的大工程是个人状态和浏览器插件治理；Space 共享的 Session/Run/Scheduler
不需要重写底层存储。

### 7.3 建议的首个可发布切片

首个多账号 beta 只承诺：

- 一个 Space 内共享 Session/Run；
- owner/admin 管理模型、插件、Resource 和 Scheduler；
- member 可在 Profile 上限内执行；
- viewer 只读；
- 团队 Space 暂不注入个人 Memory 和 `user.md`；
- 评论若未完成 Runtime 化，明确禁用或标为当前设备本地，不假装协作；
- 第三方 Workbench 插件仅管理员安装；
- 所有模型密钥只在 Runtime。

这个切片能把风险边界说清楚，同时避免在首版引入复杂的对象级 ACL。

## 8. 验收矩阵

### 8.1 Space 隔离

- 两个 Runtime 使用不同 OS 用户或容器、数据库、凭证、插件目录和 Resource。
- 配置任一数据路径指向另一 Space 时启动失败，macOS/Linux/Windows 都覆盖。
- 任何 API、Tool、SQL 和文件入口都不能用客户端 `spaceId` 跨实例读取。

### 8.2 同 Space 多账号

- A/B 同时登录，共享 Session 和团队配置；每个变更能看到正确 actor。
- A logout 不影响 B，也不撤销已经批准的后台委托。
- A 被移除后，HTTP、SSE、WS、下一次模型/Tool 调用立即停止。
- 同角色 A/B 在同一浏览器切换后，不保留旧身份、查询缓存、草稿或个人 Memory。

### 8.3 插件、模型、Tool、Skill

- member 不能安装插件、写模型凭证或扩大 Interaction Profile。
- 未满足 `requiredScopes` 的 Tool 不出现在模型目录且调用失败。
- Skill 命中不会扩大 allowedTools/file roots/node。
- 浏览器存储和日志中不存在模型密钥、账号 token 和 task principal。

### 8.4 Memory、Identity、评论

- Team Memory 对 Space 成员可见；Personal Memory 只进入本人 Run。
- 团队 Space 不把 A 的 `user.md` 注入 B 的请求。
- 评论在成员设备间一致，viewer 不能写；作者和解决者可审计。
- 旧本地数据不会自动冒充某个新账号创建。

### 8.5 后台执行与 Resource

- Scheduler/Automation 到期、撤销、降级、移除成员后不能继续调用模型或 Tool。
- 任务保存失败不遗留 active grant；更新成功后旧 grant 被撤销。
- Terminal/Resource ID 只用于定位，最终仍检查 Space 配对和 Run policy。
- 子 Agent 不能获得父 Run 未拥有的能力。

### 8.6 Observability

- 投影不含 prompt、原始工具参数/结果、凭证或未知错误原文。
- Raw Read 对对象和字符串内嵌 JSON 都能脱敏，并记录 actor 审计。
- replay 丢失返回显式 gap/reset，不静默伪装为完整数据。
- Observability 不输出根因、修复建议或自动修改代码。

## 9. 明确不做

当前阶段不做：

- 共享进程承载任意多个 Space；
- 为所有业务表机械增加 `space_id/user_id`；
- 项目级或单 Session 私密 ACL；
- 用户可上传并在服务端同进程运行不受信插件；
- 跨 Space Observability 查询；
- 企业级 SCIM、组织树、计费、配额和 break-glass；
- 依赖路径前缀、环境变量或 Skill prompt 实现安全隔离；
- Observability 内置诊断、根因或修复工作流。

## 10. 需要确认的产品决策

以下决策会直接改变实现规模，进入对应阶段前应冻结：

1. 评论是 Space 协作对象，还是明确的 Device 本地便签？本方案推荐 Space。
2. 团队 Space 是否允许 Personal Memory 受控引用？首版推荐不允许。
3. 模型是否支持个人 BYOK？首版推荐只支持 Space 凭证。
4. Workbench 插件启用偏好是 User 还是 Device？安装和 allowlist 必须是 Space。
5. member 是否允许创建团队 Agent Task？建议允许受 Profile 限制的临时任务，
   持久团队任务由 admin 管理。

## 11. 主要代码证据

- 账号与 grant：`apps/runtime/src/accounts/postgres-account-store.mjs`
- 请求 scope 与执行重验：`apps/runtime/src/accounts/account-access-control.mjs`
- Space 数据目录绑定：`apps/runtime/src/accounts/storage-binding.mjs`
- Workbench 权威状态：`apps/runtime/src/postgres-workbench-state-store.mjs`
- Run/Transcript：`apps/runtime/src/postgres-run-store.mjs`
- Runtime plugin state/Tool：`apps/runtime/src/runtime-plugin-service.mjs`
- Workbench plugin 持久化：`src/plugin/manager.ts`、`src/plugin/script-store.ts`
- 评论浏览器存储：`extensions/dev.comments/main.js`
- Memory scope 和注入：`extensions/dev.memory/runtime.js`、
  `extensions/dev.memory/memory-runtime-shared.js`
- Identity 固定用户文件：`extensions/dev.identity/identity-files.js`、
  `extensions/dev.identity/runtime.js`
- Scheduler/grant：`apps/runtime/src/scheduler-http-handler.mjs`、
  `apps/runtime/src/postgres-scheduler-store.mjs`
- Terminal/Resource：`apps/runtime/src/terminal-management-service.mjs`、
  `apps/runtime/src/device-service-client.mjs`
- 模型与凭证：`apps/runtime/src/model-profile-store.mjs`、
  `apps/runtime/src/environment-credential-provider.mjs`
- Observability：`apps/runtime/src/observability/postgres-projection.mjs`、
  `apps/runtime/src/observability/raw-read.mjs`
- 身份切换：`src/runtime/workbench-access.ts`、
  `apps/mobile-client/src/AuthBoundary.tsx`
