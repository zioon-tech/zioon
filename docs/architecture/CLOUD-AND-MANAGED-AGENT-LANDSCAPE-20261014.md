# Cloud / Managed Agent 方案调研与 Zion 演进建议

> 日期：2026-10-14
>
> 状态：架构决策输入
>
> 范围：Cloud Agent 产品、Managed Agent Runtime、Agent Sandbox /
> Computer Use 基础设施，以及 Zion 从单 ECS 向可上线架构演进的建议。

## 1. 执行结论

### 1.1 对“每个在线 Agent 是否都需要一台机器”的回答

不是每个用户长期独占一台物理机，也通常不是每个用户长期独占一台 ECS。

当前主流实现是：

- 账户、Session、Run、事件、记忆和策略保存在常驻控制面；
- 每个活跃 Session、Run 或 Attempt 获得一个逻辑隔离环境；
- 隔离环境通常是 microVM、容器或受限 Worker；
- 工作时按秒计费，空闲后暂停、快照或销毁；
- 恢复时重新挂载工作区、Artifact 和凭证代理；
- 一个物理宿主可以承载大量相互隔离的逻辑环境。

因此行业里的“一次会话一台机器”通常指**一个隔离的逻辑执行环境**，不等于购买一台
长期运行的云主机。

### 1.2 对 Zion 的建议

Zion 不应把完整 Agent 产品交给某一家 Managed Agent 平台，也不应在当前单 ECS
内部自行运行每个用户的任意命令。建议采用：

> **Zion 自有账户优先控制面 + Zion 自有 Agent Engine +
> 可替换的 Managed Sandbox + Device Node 私有资源执行。**

具体边界：

- Zion 继续拥有 Account、Space、Identity、Memory、Session、Run Ledger、
  Approval、Tool Policy、Plugin Desired State 和审计记录；
- 云端代码、Shell、文件加工和浏览器任务放入按 Attempt 创建的隔离 Sandbox；
- 本地文件、登录态、内网、设备和用户私有凭据继续由 Device Connector 执行；
- Managed Agent 只作为低风险任务的可选执行后端和产品基准，不成为 Zion
  唯一的状态权威；
- 当前 1.8 GiB ECS 只适合验证，不适合承载正式控制面、PostgreSQL、构建和任意
  Agent 执行。近期至少升级到 4 GiB，稳健运行建议 8 GiB，并把执行负载移出 ECS。

### 1.3 首选验证顺序

1. **阿里云 Agent Sandbox**：国内链路、按秒计费、microVM、休眠/快照、
   E2B API 兼容，最适合做 Zion 第一版 Sandbox Provider POC。
2. **E2B**：作为事实上的通用 Sandbox API 参照和海外备选。
3. **百炼 Managed Agents**：用于验证“全托管 Agent”产品体验和非设备型任务，
   不先迁移 Zion 的核心状态。
4. **AWS AgentCore Runtime / Microsoft Foundry Hosted Agents**：适合作为未来
   托管 Zion Runtime worker 的参考；是否采用取决于目标区域和企业客户云栈。
5. Runloop、Daytona、Blaxel、Cloudflare Sandbox 保留为专项备选，不需要首期
   同时接入。

生产采用任何供应商前，必须重新核实地域、配额、SLA、正式商用状态、数据驻留和
网络能力。本文记录的是 2026-10-14 的官方公开信息。

## 2. 必须先区分的三类产品

| 层级 | 平台替用户管理什么 | 典型产品 | 是否适合作为 Zion 底座 |
| --- | --- | --- | --- |
| Cloud Agent 产品 | 完整 Agent、UI、执行环境、协作和交付流程 | GitHub Agent HQ、Claude Code Cloud、Cursor Background Agents、Devin、Replit Agent | 主要用于产品对标，通常不提供足够的底层控制 |
| Managed Agent Runtime | Agent endpoint、会话、扩缩容、身份、事件、工具，有的允许自带 Agent 代码 | 百炼 Managed Agents、AWS AgentCore、Microsoft Foundry、Gemini Managed Agents | 可托管整个 Agent 或 Zion worker，但会引入更强平台绑定 |
| Managed Sandbox | 隔离计算、文件、进程、网络、快照，不拥有 Agent 决策循环 | 阿里云 Agent Sandbox、E2B、Runloop、Daytona、Blaxel、Cloudflare Sandbox | 最适合当前 Zion，能保留产品与状态所有权 |

不能把这三类方案放在一张“功能最多者胜出”的表里。Cloud Agent 是最终产品，
Managed Agent Runtime 是应用托管平台，Sandbox 是计算基础设施。

## 3. Cloud Agent 产品观察

| 产品 | 官方公开的执行形态 | 值得 Zion 借鉴的模式 |
| --- | --- | --- |
| GitHub Agent HQ | 多个 Agent 异步并行，日志、评论、草稿和 PR 作为可审查 Artifact | Agent 输出进入现有协作与 Review 流程，不另造不可审计的结果通道 |
| Claude Code Cloud | Cloud Session 在 Anthropic 托管或组织自托管环境中运行；电脑关闭后继续；支持跨终端和云端接续 | Environment 是可保存配置，Session 是运行实例；凭据通过代理注入，不进入 VM |
| Cursor Background Agents | 每个后台任务使用独立远程环境执行代码任务 | 交互式本地 Agent 与异步云任务是同一产品的两种 Placement |
| Devin Managed Devins | 协调者拆分任务，每个子任务在独立 VM 中运行；完成或需要输入时唤醒协调者 | 子任务使用粗粒度事件唤醒，不由父 Agent 持续轮询 |
| Replit Agent | Checkpoint 同时保存项目文件、会话上下文、环境配置、Agent Memory，可选数据库状态 | Checkpoint 是工作状态与 Agent 状态的组合，但生产数据库仍需独立恢复机制 |

共同趋势不是“聊天页面上云”，而是：

1. 异步 Session；
2. 隔离工作环境；
3. 可重连事件历史；
4. Artifact / Diff / PR 交付；
5. 人工 Review 和 Approval；
6. 多个独立任务并行，而不是多个 Agent 共享一份可变工作区。

## 4. Managed Agent Runtime 对比

| 平台 | Agent Loop 所有权 | 隔离与状态 | 工具、记忆和身份 | 对 Zion 的意义 |
| --- | --- | --- | --- | --- |
| 百炼 Managed Agents | 平台托管 | 独立云端容器；Session 和 SSE Event 服务端持久化；可中断续接 | Command、File、Memory Store、MCP、Skill、Scheduled Task | 国内最快的完整产品验证路径，但 Zion 会让出较多 Session 和执行语义 |
| AWS Bedrock AgentCore Harness | 平台托管 | 每 Session 独立 microVM，可自定义环境 | 托管编排、工具执行、Memory、Gateway、Identity、Browser、Code Interpreter、OTel | 完整度最高的行业架构参照之一 |
| AWS Bedrock AgentCore Runtime | Zion 可自带框架和模型 | 每 Session 独立 microVM；异步长任务；可持久化文件系统 | Identity、Observability、MCP/A2A；也可单独使用各模块 | 可在未来托管 Zion Agent worker，而不是重写 Agent |
| Microsoft Foundry Hosted Agents | Zion 可自带代码、框架或容器 | 平台管理 endpoint、扩缩容、Session State 和生命周期；`$HOME` 与文件可跨轮次保留 | Entra Identity、Toolbox、Observability、Responses/Invocations 协议 | 适合 Azure 企业客户和自带 Agent 代码场景 |
| Gemini API Managed Agents | 平台托管 | 单 endpoint 驱动隔离云 Sandbox；支持 background execution 和环境复用 | 内置代码/文件/Web、Remote MCP、自定义函数、网络凭据刷新 | API 极简，适合独立任务；对 Zion 自定义执行语义控制较弱 |

Managed Agent 的价值是少做编排、扩缩容、会话和观测。代价是：

- Session、Tool Call、Retry、Checkpoint 的语义由平台定义；
- Approval、unknown outcome、durable receipt 等 Zion 语义可能无法完整表达；
- Identity、Memory、Skill、Artifact 更容易被拆成供应商专有资源；
- Device Node 的本地策略和数据局部性需要额外桥接；
- 迁移到另一个平台时不只是换一个模型 endpoint。

因此 Zion 首期不采用“Managed Agent 替代 Runtime”的路线。

## 5. Sandbox 基础设施对比

| 平台 | 隔离/生命周期 | 主要能力 | 当前判断 |
| --- | --- | --- | --- |
| 阿里云 Agent Sandbox | 独立 microVM；活跃、浅/深休眠、快照、销毁 | Code、Browser、Desktop、Mobile；E2B API 与 Kubernetes API 兼容 | **首选 POC**；上线前核实地域、配额、SLA 和产品版本边界 |
| E2B | 按需 Linux microVM；Template、Pause/Snapshot、长期 Session 取决于套餐 | Command、File、Package、Desktop/Computer Use | **API 参照和海外备选**；生态成熟，Pro 有固定月费 |
| Runloop | microVM Devbox；Blueprint、Snapshot、Suspend/Resume | 软件工程 Agent、Axon Event、Benchmark/Eval、Credential Gateway | 编码 Agent 专项能力强；Pro 固定月费较高 |
| Daytona | 独立 kernel、filesystem、network 的 Sandbox；OCI/Docker 兼容；Snapshot | 多语言 SDK/API/CLI、进程、文件、网络、持久环境 | API 清晰，适合第二轮可移植性验证 |
| Blaxel | microVM；空闲归零，保留内存/文件状态，快速恢复 | Sandbox、Batch、MCP Hosting、Agent Drive | Sandbox 有吸引力；官方价格页中的 Agent Runtime 仍标记为 coming soon |
| Cloudflare Sandbox | Container microVM 或受限 Dynamic Worker；由 Durable Object/Worker 协调 | Linux Command/File/Preview，R2 挂载，网络控制 | Workers 原生场景合适；Container Sandbox 当前为 public beta |

### 5.1 选择 Sandbox 而不是完整 Managed Agent 的原因

Zion 已经有这些难以外包且有差异化价值的能力：

- Account / Space 和跨端 Workbench；
- 自有 Agent Engine、Context Provider 和模型适配；
- Tool IR、`effect`、`idempotency`、deadline、cancel 和 lease；
- durable receipt 与 `execution_outcome_unknown`；
- Device Connector、精确 Node/Resource 路由和本地最终授权；
- Identity、Memory、Skill、Plugin 和 Scheduler；
- Session / Run / Event / Yjs 的持久化与恢复。

Sandbox Provider 只替换“在哪里执行不可信代码”，不会迫使这些能力按供应商重写。

## 6. 行业共同架构模式

```text
Account / Organization
  -> durable Control Plane
       Identity / Session / Memory / Policy / Run Ledger / Audit
  -> Run
       -> Attempt lease
            -> isolated Sandbox or Hosted Runtime session
                 filesystem / process / browser / packages
            -> Artifact upload
            -> suspend, snapshot or destroy
```

需要特别区分：

| 对象 | 生命周期 | 权威状态应放在哪里 |
| --- | --- | --- |
| Account / Space | 月到年 | Zion Control Plane |
| Session | 天到年 | Zion PostgreSQL / durable storage |
| Run | 秒到天 | Zion Run Ledger |
| Attempt | 秒到小时 | Zion Ledger + 一个执行 owner |
| Sandbox | 秒到小时，可暂停 | 供应商；Zion 只保存绑定和状态投影 |
| Tool Invocation | 毫秒到小时 | Zion Invocation Ledger / Receipt |
| Scratch files | Attempt 生命周期 | Sandbox filesystem |
| Artifact | 月到年 | Zion Object Store |
| Identity / Memory | 月到年 | Zion Account Store，不是 Sandbox |

Sandbox ID 不是 Session ID，Sandbox Snapshot 也不是 Zion Checkpoint。将这些对象直接
等同会导致供应商切换、恢复和审计失真。

## 7. Zion 当前状态与缺口

### 7.1 当前已有的正确基础

Zion 当前已经符合未来架构的主要逻辑边界：

- Workbench 是 Client，Runtime 持有 Agent loop 和权威 Run；
- Session、Run、Event、Plugin KV 和投影主要进入 PostgreSQL；
- Device Connector 主动出站，`local-tools` 不暴露公网；
- Resource Host 对本地文件、终端和敏感路径保留最终否决权；
- Tool 调用已有 policy、lease、cancel、receipt 和 unknown outcome 语义；
- Skills 已区分“可缓存的文本说明”和“只属于源 Node 的命令、凭据及依赖”；
- Identity 的 Runtime snapshot 是可重建投影，不是第二份事实源；
- 显式目标离线时失败关闭，不静默切换到同名资源。

这意味着 Zion 不需要推倒重来，只需要增加新的 `cloud-sandbox` Runtime /
Resource Host 类型。

### 7.2 当前上线阻塞项

| 领域 | 当前情况 | 上线前需要补齐 |
| --- | --- | --- |
| 主机容量 | 1.8 GiB ECS 同时承载多项常驻服务 | 至少 4 GiB，稳健建议 8 GiB；执行负载外移 |
| Attempt ownership | 主要是单 Runtime 进程内 fence | active-active 前增加 PostgreSQL transactional claim |
| Device dispatch | pending/delivered 仍有内存状态，Connector receipt 主要在进程内 | durable invocation、ACK、Node outbox/receipt、epoch fencing |
| Artifact | metadata 在 PostgreSQL，blob 主要在 ECS filesystem | 迁移到 OSS/S3 兼容对象存储 |
| Credential | ECS `0600` 文件是过渡实现 | 多用户前迁移到 KMS/Vault/Secret Manager |
| Identity / Plugin Data | canonical 文件绑定到具体 Resource Node | 明确哪些成为 Account canonical，完成一次性迁移和单 writer 切换 |
| Plugin 发布 | 内置代码跟随部署，外部包和实际状态仍偏单机 | 签名包、版本化 Registry、per-host install receipt |
| Sandbox | 尚无统一 Provider / lifecycle / network contract | 新增供应商中立的 Sandbox Provider |
| 可观测性 | 已有 Runtime health 和 Tool telemetry 基础 | 增加 create/resume/exec/snapshot/upload/destroy 分段指标及成本 |

## 8. 推荐目标架构

```text
Workbench / Mobile / CLI
          |
          v
+------------------------------------------------------+
| Zion Control Plane + Agent Runtime                   |
| Account / Identity / Session / Memory / Agent Engine |
| Placement / Approval / Tool Policy / Invocation      |
| Ledger / Artifact Index / Audit                      |
+----------------------+-------------------------------+
                       |
              Placement by requirement
             /                         \
            v                           v
+--------------------------+   +--------------------------+
| Managed Cloud Sandbox    |   | Device Connector         |
| code / bash / files      |   | private files / terminal |
| browser / test / build   |   | intranet / login state   |
| no canonical user state  |   | local final authorization|
+-------------+------------+   +-------------+------------+
              |                              |
              +---------------+--------------+
                              v
                 Object Store / Artifact Store
```

### 8.1 Placement 原则

- `cloud-sandbox`：输入已经上传或可公开拉取，不依赖本地登录态；
- `device`：需要本地文件、内网、硬件、浏览器登录态或本地凭据；
- `hosted-runtime`：未来把完整 Zion worker 托管到 AgentCore/Foundry 一类平台；
- `managed-agent`：允许第三方拥有 Agent loop 的低风险独立任务。

模型只声明需求：

```json
{
  "capabilities": ["process", "filesystem"],
  "data_locality": "cloud",
  "network_profile": "package-registry-only",
  "minimum_memory_mb": 4096,
  "effect_ceiling": "write",
  "estimated_cost_limit": 2.0
}
```

Placement 选择具体供应商和环境。模型不应看到供应商密钥、全量 Node 清单或底层
Sandbox 管理接口。

### 8.2 Sandbox Provider 最小契约

```ts
interface SandboxProvider {
  create(input: CreateSandboxRequest): Promise<SandboxHandle>;
  resume(id: string): Promise<SandboxHandle>;
  exec(id: string, request: ExecRequest): Promise<ExecHandle>;
  cancel(id: string, invocationId: string): Promise<void>;
  putFiles(id: string, files: FileInput[]): Promise<void>;
  getArtifact(id: string, path: string): Promise<ArtifactInput>;
  snapshot(id: string): Promise<SandboxSnapshot>;
  suspend(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
}
```

Provider 契约还必须包含：

- 幂等 request key；
- provider operation ID；
- 明确 timeout、cancel accepted 和 terminal state；
- stdout/stderr 分段游标；
- 文件大小和路径限制；
- egress allowlist；
- Template/Image digest；
- CPU、内存、磁盘和成本上限；
- suspend/snapshot 是否包含内存、文件、进程；
- Artifact 上传完成后的校验摘要；
- 不确定结果映射到 Zion `execution_outcome_unknown`。

不能因供应商 API 返回超时就自动重试任意命令。Sandbox 生命周期 API 的幂等性不
等于 Sandbox 内命令的幂等性。

## 9. Skills、Plugins、Identity 和 Memory 如何处理

### 9.1 Skills

建议拆成三个对象：

1. `SkillDefinition`：名称、说明、`SKILL.md`、版本和内容 hash；
2. `SkillBundle`：经过过滤的脚本和文本资产，保存到 Zion Artifact Store；
3. `SkillBinding`：某 Account/Session 启用哪个版本，以及允许在哪类 Host 执行。

执行时：

- Runtime 按内容 hash 解析 Skill；
- 只把选中的 Bundle 只读注入 Sandbox；
- Node-local Skill 继续保留 `nodeId` provenance；
- Skill 的存在不代表目标环境有凭据、依赖或权限；
- `.env`、SSH、云凭据和登录态不得进入 Bundle 或 Snapshot。

这与当前 Multi-Node Skills 的设计一致，只是把 Runtime cache 从单 ECS 文件目录
扩展为对象存储支持的版本化 Bundle。

### 9.2 Plugins

Plugin 需要区分：

- **Package**：签名、不可变、按 digest 保存；
- **Desired State**：Account/Space 希望安装的版本；
- **Actual State**：Runtime、Sandbox Template 或 Device Node 的实际版本；
- **Plugin Data**：业务数据，不能随 Package 卸载或环境销毁。

云 Sandbox 只安装允许在该环境执行的 Plugin package。Device-only Plugin 不自动
复制到云端。每次安装需要 receipt，Sandbox Template 记录精确 package digest。

### 9.3 Identity

账户优先模式下，Identity 应成为 Account 范围的权威数据，而不是绑定到某一台
Mac 或某个 Sandbox。

推荐迁移方式：

1. 冻结旧、新 writer；
2. 从当前 `dev.identity` Plugin Data 导出并校验 hash；
3. 导入加密的 Account Data Store；
4. 重建 Runtime projection；
5. 切换到云端单一 canonical writer；
6. 验证后将旧目录改为只读归档，不长期维持双写或模糊 fallback。

Identity canonical 仍可使用可审计的版本化文件，不要求立即改成向量数据库。
PostgreSQL 保存 metadata、revision 和索引；大文本/附件进入加密对象存储。

本地路径、设备登录态和资源授权不是 Identity，应继续留在 Resource Node。

### 9.4 Memory

必须区分：

- **Account Memory**：用户长期偏好、事实、项目知识，归 Zion Account；
- **Session Memory**：会话摘要和引用，归 Session；
- **Working Memory**：当前 Attempt 的临时笔记，可在 Sandbox；
- **Resource Data**：本地文件或业务系统数据，归 Device/API Resource。

Sandbox filesystem 只能承载 Working Memory。需要长期保留的内容必须通过显式
Memory commit 写回 Zion，并记录来源、Account、revision 和 Run ID。销毁 Sandbox
不能导致长期 Memory 丢失，恢复 Snapshot 也不能回滚 Account Memory。

### 9.5 Credentials

- 模型和云 API 凭据进入 Zion Vault，以引用方式进入 Run；
- Sandbox 使用短期 token 或网络代理/header injection；
- 原始凭据不写入环境变量快照、Skill Bundle、日志或 Artifact；
- Device-local 凭据继续只保存在 Device；
- Home Assistant 等资源凭据继续按 `connectionId + exact origin` 在 Node 匹配；
- Sandbox 到本地资源必须通过受策略约束的 Tool/Subrun，不能直接建立任意内网隧道。

### 9.6 Artifacts

大型结果、补丁、压缩包、截图、测试报告和 Sandbox Snapshot 元数据进入 Artifact
Store。PostgreSQL 只保存 metadata、hash、owner、retention 和引用。

首期可使用 OSS/S3 兼容对象存储，并通过 pre-signed URL 让 Sandbox 直接上传，
避免所有大文件经过 Runtime 进程内存。

## 10. 成本基线

以下只比较 2 vCPU / 4 GiB 的公开计算单价，不含模型 token、网络、磁盘、快照、
对象存储、税费和企业折扣，不代表同等性能。

| 平台 | 公开价格换算 | 1,000 活跃小时示例 | 固定费用 |
| --- | ---: | ---: | --- |
| 阿里云 Agent Sandbox Default，中国内地 | 约 ¥0.312 / 小时 | 约 ¥312 | 官方页为按量付费 |
| E2B，2 vCPU / 4 GiB | 约 $0.1656 / 小时 | 约 $165.6 | Pro $150/月；Hobby 有时长/并发限制 |
| Runloop Devbox，2 vCPU / 4 GiB | 约 $0.3168 / 小时 | 约 $316.8 | Pro $250/月；Basic 无月费但能力不同 |
| Blaxel Sandbox，4 GiB | 约 $0.1656 / 活跃小时 | 约 $165.6 | Pay-as-you-go；Snapshot 另计 |

这个模型说明了两个事实：

- 沙箱适合突发、间歇任务，不能让空闲环境一直保持 active；
- 成本控制需要 TTL、自动 suspend、单 Run 预算、Account quota 和异常用量告警，
  不能只依靠供应商账单。

## 11. 分阶段落地路径

### Phase 0：先稳定当前正式入口

- ECS 升级到至少 4 GiB，稳健目标 8 GiB；
- PostgreSQL、Runtime、Caddy 建立备份、恢复和健康告警；
- 保持现有单进程逻辑边界，不为尚不存在的规模先拆微服务；
- 明确 ECS 不运行来自多用户的任意 Bash。

### Phase 1：Sandbox POC

- 新增供应商中立 `SandboxProvider`；
- 先实现阿里云 Agent Sandbox，使用 E2B 兼容面时仍保留 Zion 自有类型；
- 只开放 `read/process/write` 的测试工作流；
- 一个 Attempt 绑定一个 Sandbox，Run 内复用，空闲 suspend，终态 destroy；
- Template 固定 Node、Python、Git 和 Zion Tool Host 版本；
- 建立 create、ready、exec、artifact、suspend、destroy 和费用指标。

POC 不允许生产凭据、不访问 Device、不执行不可补偿外部副作用。

### Phase 2：可靠执行和状态外移

- PostgreSQL transactional invocation claim；
- Sandbox operation ID、ACK、receipt 和 reconcile；
- Artifact blob 迁移到 OSS/S3；
- Credential 迁移到 Vault/KMS；
- Network deny-by-default 和 domain allowlist；
- Snapshot retention、销毁证明和 orphan reaper；
- Account / Run / Sandbox quota。

只有这一阶段完成后，Sandbox 才可承载正式写操作。

### Phase 3：Account 数据收敛

- Skills 转为 versioned Bundle；
- Plugins 转为 signed Package + Desired/Actual State；
- Identity 从绑定 Node 一次性迁移到 Account canonical store；
- Memory 明确 Account、Session、Working、Resource 四类 owner；
- 停止 ECS filesystem 作为 Artifact 和 Account data 的唯一副本。

迁移完成后删除长期双写路径，避免形成新的混合状态。

### Phase 4：Placement 与混合执行

- 增加 `cloud-sandbox`、`device`、`hosted-runtime`、`managed-agent` profile；
- 基于 capability、data locality、trust zone、effect 和 cost 做 Placement；
- 需要本地资源的工作创建 Device Subrun，不逐个跨公网转发底层文件操作；
- 明确 `waiting_for_resource`、`waiting_for_approval` 和 unknown outcome；
- Workbench 展示执行位置、资源状态、费用和可审查 Artifact，但不泄漏内部租户实现。

### Phase 5：按真实指标扩展

- 只有高可用或负载指标触发时才拆 Connection Gateway 和 Runtime worker；
- active-active 前必须完成共享 Invocation Ledger 和 Attempt fencing；
- 可选择把 Zion worker 部署到 AgentCore Runtime / Foundry Hosted Agents；
- 对完全独立、低风险任务增加百炼/Gemini Managed Agent backend；
- 通过同一套 Zion Run/Event/Artifact 协议向 Client 投影。

## 12. 上线门槛

Sandbox 路径上线前至少满足：

1. 一个 Attempt 任一时刻只有一个 owner；
2. Runtime 重启后可以恢复、等待或 reconcile，不静默重跑写操作；
3. Sandbox egress 默认拒绝，允许规则可审计；
4. Secret 不进入 Sandbox image、snapshot、日志和 Artifact；
5. Artifact 上传有 hash、size、owner 和 retention；
6. Sandbox 超时、失联和销毁失败有告警及 orphan reaper；
7. Account/Run 有并发、时长、CPU、内存和费用上限；
8. 跨 Account 隔离通过测试；
9. Device Resource 不因云 Sandbox 存在而放宽本地授权；
10. 供应商故障不会导致 Zion Session、Identity、Memory 或 Run Ledger 丢失。

## 13. 不建议的路线

- 不给每个用户创建一台长期 ECS；
- 不在当前 Runtime ECS 上直接执行多用户 Bash；
- 不把 Sandbox filesystem 当成长期 Memory；
- 不把供应商 Session ID 当成 Zion Session ID；
- 不把完整 Identity 和设备凭据复制到每个 Sandbox；
- 不因供应商宣称“自动重试”就绕过 Zion receipt 和 unknown outcome；
- 不同时深度接入多个供应商后再设计抽象；
- 不先迁移到 Managed Agent，再尝试找回 Zion 的 Tool、Approval 和 Device 语义；
- 不长期维持 Identity/Memory 在 Mac、ECS 和第三方平台之间的多主双写。

## 14. 最终决策建议

建议批准以下方向：

1. **保留 Zion Runtime/Control Plane 产品所有权。**
2. **启动阿里云 Agent Sandbox POC，并以 E2B 兼容性验证 Provider 抽象。**
3. **把云 Sandbox 作为新的执行 Host，不作为新的数据权威。**
4. **并行完成 ECS 扩容、Artifact Object Store 和 Credential Vault。**
5. **在 invocation claim、receipt、egress policy 和 quota 完成前，不开放正式写操作。**
6. **使用百炼 Managed Agents 做端到端体验基准，暂不替代 Zion Agent Engine。**
7. **Device Connector 继续承担本地私有资源，不被云 Sandbox 淘汰。**

这个方案能解决当前单 ECS 无法承载真实上线负载的问题，同时保留 Zion 已经形成的
账户、设备、工具语义和跨端体验，不把产品演进锁死在单一 Managed Agent 平台。

## 15. 官方资料

### Cloud Agent 产品

- GitHub Agent HQ：
  <https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/>
- GitHub Custom Agents：
  <https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-custom-agents>
- Claude Code Cloud：
  <https://code.claude.com/docs/en/claude-code-on-the-web>
- Cursor 文档：
  <https://cursor.com/docs>
- Devin Managed Devins：
  <https://docs.devin.ai/work-with-devin/advanced-capabilities>
- Replit Checkpoints：
  <https://docs.replit.com/core-concepts/agent/checkpoints-and-rollbacks>

### Managed Agent Runtime

- 阿里云百炼 Managed Agents：
  <https://help.aliyun.com/zh/model-studio/managed-agents-introduction>
- AWS Bedrock AgentCore：
  <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html>
- AWS AgentCore Runtime：
  <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html>
- Microsoft Foundry Hosted Agents：
  <https://learn.microsoft.com/en-us/azure/ai-foundry/agents/concepts/hosted-agents>
- Google Gemini API Managed Agents：
  <https://blog.google/innovation-and-ai/technology/developers-tools/expanding-managed-agents-gemini-api/>

### Sandbox 基础设施与价格

- 阿里云 Agent Sandbox：
  <https://www.aliyun.com/product/sandbox>
- 阿里云 Agent Sandbox 计费：
  <https://help.aliyun.com/zh/agent-sandbox/product-overview/billing-overview>
- E2B Docs / Pricing：
  <https://e2b.dev/docs>
  <https://e2b.dev/pricing>
- Runloop Docs / Pricing：
  <https://docs.runloop.ai/>
  <https://runloop.ai/pricing>
- Daytona：
  <https://www.daytona.io/docs/en/>
- Blaxel Pricing：
  <https://blaxel.ai/pricing>
- Cloudflare Sandbox：
  <https://developers.cloudflare.com/sandbox/>

### Zion 内部基线

- [Client / Runtime 分离](./ZION-CLIENT-RUNTIME-SEPARATION.md)
- [分布式 Runtime 产品架构](./ZION-DISTRIBUTED-RUNTIME-PRODUCT-ARCHITECTURE.md)
- [Node Control Plane 路线图](./NODE-CONTROL-PLANE-ROADMAP.md)
- [Plugin Data Locations](./PLUGIN-DATA-LOCATIONS.md)
- [Multi-Node Skills](./MULTI-NODE-SKILLS.md)
