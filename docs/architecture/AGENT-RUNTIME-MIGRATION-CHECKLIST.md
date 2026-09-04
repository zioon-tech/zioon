# Agent Runtime 后端迁移清单

> 本文是执行清单，不替代架构说明。  
> 当前交付架构见
> [ZION-CLIENT-RUNTIME-SEPARATION.md](./ZION-CLIENT-RUNTIME-SEPARATION.md)。
> 分布式扩展方向见
> [ZION-DISTRIBUTED-RUNTIME-PRODUCT-ARCHITECTURE.md](./ZION-DISTRIBUTED-RUNTIME-PRODUCT-ARCHITECTURE.md)。
> 早期边界讨论见
> [AGENT-RUNTIME-BOUNDARY-STRATEGY.md](./AGENT-RUNTIME-BOUNDARY-STRATEGY.md)。
> 多端演进见 [MULTI-SURFACE-AGENT-PLATFORM.md](./MULTI-SURFACE-AGENT-PLATFORM.md)。
> 当前兼容矩阵见
> [RUNTIME-ZION-NEXT-COMPATIBILITY.md](./RUNTIME-ZION-NEXT-COMPATIBILITY.md)。
> 近期交付顺序见
> [ZION-DISTRIBUTED-RUNTIME-PRODUCT-ARCHITECTURE.md](./ZION-DISTRIBUTED-RUNTIME-PRODUCT-ARCHITECTURE.md#15-近期交付顺序)：
> 先独立构建和验证 Runtime，通过 standalone validation gate 后再接入
> `zion-next`。

## 0. 交付顺序约束

本清单中的组件可以并行准备，但生产集成必须遵循以下顺序：

1. 使用现有实现生成 golden fixtures 和行为基线；
2. 独立构建 `protocol`、`agent-core` 和 Runtime Host；
3. 通过无 DOM、持久化、恢复、取消、幂等和故障测试；
4. 再为 `zion-next` 增加 `RuntimeClient` 和 opt-in 集成；
5. 集成验证通过后，才切换 Scheduler 和普通 Chat 的默认 owner。

Standalone 阶段不得要求 Workbench 页面在线，也不得为了尽早展示 UI 而让
`agent-core` 读取 `window.zion`、浏览器 StateBus、CodeMirror 或 `localStorage`。

本文沿用当前代码中的 `Tool Host` 名称；产品目标术语是 `Resource Host`，
工具插件目标 Entry 是 `Resource Entry`。

## 1. 迁移完成的定义

只有同时满足以下条件，才算当前 Runtime Host 迁移完成：

- 普通聊天和定时任务使用同一 `agent-core`，由 Placement 选中的
  Runtime Host 执行；
- 浏览器关闭后，不依赖 browser tool 的任务可以继续；
- 模型凭证不再下发浏览器；
- Run、Attempt、tool call、usage 和 transcript 按 Control Plane / Runtime Host
  所有权进入非 Client 的持久化权威状态；
- 前端通过 sequence 可重连和补事件；
- Tool Broker 在调用点强制 CapabilityPolicy；
- 插件不再通过 `chat.tools` / `chat.toolHandlers` 注册 Runtime 工具；
- 前端仍能展示现有 reasoning、工具卡片、diff 和 Session；
- Local、Cloud 或其他 Runtime Host 可以按 Placement 拥有 Attempt，但同一
  Attempt 同时只能有一个 owner；
- Web、Desktop、CLI 和 Cloud 使用同一 `agent-core` 与 RunEvent 协议。

---

## 2. 当前文件迁移地图

### 2.1 Agent loop

| 当前文件 | 当前职责 | 迁移目标 | 动作 |
|---|---|---|---|
| `extensions/dev.langchain-chat/main.js` | 编辑器、Agent loop、工具执行、投影混合 | `agent-core` + Web adapter | 先拆函数，不直接搬文件 |
| `extensions/dev.langchain-chat/programmatic-runner.js` | 定时任务专用 loop | 统一 AgentLoop | 删除重复 loop |
| `src/chat/runtime.ts` | 浏览器 Run controller | RuntimeClient 状态 | 保留 UI projection，移除 owner |

`main.js` 应先拆为：

```text
message-input-adapter
agent-loop
run-controller
tool-client
session-projector
editor-interaction
```

验收：`agent-loop` 单测环境中不存在 `window`、`document` 或 CodeMirror。

### 2.2 Provider 和 reasoning

| 当前文件 | 目标 |
|---|---|
| `chat-service.js` | `packages/provider-adapters` |
| `claude-provider.js` | Claude adapter |
| `gemini-provider.js` | Gemini adapter |
| `deepseek-provider.js` | OpenAI-compatible adapter config |
| `reasoning-policy.js` | Runtime reasoning policy |
| `model-config-fields.js` | 共享 model schema + UI form |
| `user-models-provider.js` | 后端 Model Registry |
| `llm-proxy.ts` | Runtime 内部 HTTP client，逐步取消浏览器代理 |

必须建立 provider golden cases：

- text-only stream；
- reasoning + text；
- interleaved reasoning + tool calls；
- parallel tool calls；
- invalid tool args；
- usage-only final chunk；
- abort；
- provider error；
- reasoning content 必须回传的模型。

### 2.3 Message Contributor

| Contributor | 当前位置 | 分类 | 目标 |
|---|---|---|---|
| Skills | `dev.skills/main.js` | 纯配置 + 文件读取 | Runtime ContextProvider |
| Memory | `dev.memory/main.js` | 持久上下文 | Runtime ContextProvider |
| Compression | `dev.context-compression/main.js` | 纯消息转换 | `agent-core/context` |
| Terminal inventory | `dev.terminal-manager/main.js` | host 状态 | Runtime ContextProvider + Local Tool Host Resource |
| Recent terminal outputs | `dev.terminal-enhanced/main.js` | browser transient state | 暂不迁移，后续改为受限 Artifact/observations |
| Comment summaries | `dev.comments/main.js` | Session 数据 | Runtime ContextProvider |

迁移后 Contributor 接口不能接收任意 `state` 和 `events`：

```typescript
interface ContextProvider {
  id: string;
  prepare(input: ContextRequest): Promise<ContextFragment[]>;
}
```

每个 Fragment 必须包含来源、token 预算、敏感级别和失效条件。

### 2.4 Tool

当前直接注册工具的插件：

```text
dev.agents
dev.editor-config
dev.fs-manager
dev.langchain-chat
dev.mail
dev.memory
dev.session-manager
dev.skills
dev.task-panel
dev.terminal-enhanced
dev.terminal-manager
dev.tools
```

逐个登记：

| Tool | Host | 风险 | Durable |
|---|---|---|---|
| webSearch / webFetch | runtime 或 local-daemon | read/network | 是 |
| memoryManage read | runtime | read | 是 |
| memoryManage write | runtime | state-write | 是 |
| sessionList / sessionGet | runtime | read | 是 |
| read / tree | local-daemon | file-read | 是 |
| write / edit | local-daemon | file-write | 是 |
| Bash | local-daemon | process | 是 |
| sendMail | local-daemon | external-delivery | 是 |
| todoWrite | runtime | state-write | 是 |
| editor selection | browser | ephemeral-read | 否 |
| File System Access handle | browser | file-read/write | 否 |

每个工具迁移必须完成：

- JSON Schema；
- tool version；
- host；
- risk class；
- timeout；
- cancel；
- idempotency 策略；
- CapabilityPolicy 字段；
- result schema；
- artifact / change set；
- 通用 renderer 或自定义 renderer；
- contract test。

### 2.5 Session 和 UI projection

| 当前能力 | 当前位置 | 迁移后 |
|---|---|---|
| 文档保存 | `dev.session-manager` | 前端草稿 / projection |
| canonical messages | 编辑器 role marker 解析 | Runtime SessionStore |
| tool annotations | `dev.tools/tool-calls.js` | RunEvent projection |
| widget history | `src/chat/widget-history.ts` | transcript 查询结果 |
| reasoning annotations | `src/chat/annotations.ts` | reasoning event projection |
| usage | `src/chat/usage.ts` | 后端记录，前端聚合显示 |

兼容策略：

1. 读取旧 Session 文档并生成初始 transcript revision。
2. 新 Run 只追加结构化消息。
3. 编辑器显示 projection。
4. 用户修改历史时创建 fork，不篡改已完成 Run。

---

## 3. 协议建设

### 3.1 `packages/protocol`

必须先定义：

- `RunRequest`
- `RunSummary`
- `RunEvent`
- `TranscriptMessage`
- `ReasoningEvent`
- `ToolDefinition`
- `ToolInvocation`
- `ToolResult`
- `Artifact`
- `ChangeSet`
- `CapabilityPolicy`
- `Task`
- `TaskRevision`
- `Occurrence`

输出：

- TypeScript types；
- JSON Schema；
- OpenAPI components；
- Python Pydantic models；
- fixture；
- compatibility test。

### 3.2 版本规则

- 事件只允许 additive change；
- 删除或重命名字段必须提升 `schemaVersion`；
- tool schema 版本与插件版本分开；
- Runtime 必须拒绝未知的 major version；
- 前端至少兼容当前和前一个 event major version。

---

## 4. 推荐实施批次

### M0：基线与防回归，约 1 周

- [ ] 保存 20 组真实会话 fixture；
- [ ] provider stream golden tests；
- [ ] tool loop golden tests；
- [x] reasoning projection tests；
- [x] Session 文档 projection tests；
- [ ] 记录当前 token usage 和延迟基线。

退出条件：可以判断迁移前后消息和事件是否等价。

### M1：Monorepo，约 1 周

- [ ] 创建 workspace 根；
- [ ] 移入 `apps/web`；
- [ ] 移入 `services/local-tools`；
- [ ] 保留 Git 历史；
- [ ] 根命令启动 web 和 Python；
- [ ] 根 CI 执行 JS、Python 和 contract tests；
- [ ] 统一 release version。

退出条件：现有功能不变，跨端修改可在一个 PR 完成。

### M2：抽 `agent-core`，约 2-3 周

- [x] 定义 `AgentEngine`（对应原计划中的 `ModelAdapter`）；
- [x] 定义 `ToolBroker`；
- [x] 定义 `RunStore`；
- [x] 定义 `ContextProvider`；
- [x] 抽多步 AgentLoop；
- [x] 使用现有 programmatic executor 生成共享 tool-loop fixture；
- [x] 补齐普通 Chat reasoning、usage、abort 和 projection fixtures；
- [x] 使用 fake adapters 和 headless scenario runner 独立执行；
- [x] 不修改 `zion-next` 默认执行路径。

退出条件：Agent loop 在 Node 单测中运行，不引用 DOM，并可在不启动
`zion-next` 的情况下完成多轮工具 Run。

### M3：Runtime service，约 2 周

- [x] `POST /v1/runs`；
- [x] abort；
- [x] SSE event resume；
- [x] SQLite RunStore；
- [x] local Model Registry 与 profile discovery；
- [ ] credential vault；
- [x] usage；
- [x] headless create / attach / abort / resume；
- [x] 进程重启恢复；
- [x] 持久 Session transcript 与连续消息 Run；
- [x] manifest-driven Runtime ContextProvider 插件生命周期；
- [x] Tool Host 故障和重复投递测试；
- [x] standalone read-only validation gate；
- [x] side-effect tools validation gate 与 durable invocation receipt。

当前 checkpoint 已完成本地 SQLite RunStore，以及 loopback-only 的 Run 创建、查询、
abort、事件补拉和 SSE 骨架；已增加 OpenAI-compatible Engine adapter、只读
local-tools Tool Broker 和 ownerless Run 的启动中断收敛。Echo Engine 仅用于协议烟测。
已增加 allowlisted environment CredentialProvider、工具轮次后的持久 checkpoint，
以及显式的 same-Run/new-Attempt resume。进程级烟测已验证 Runtime 在 checkpoint
后被强制终止、重启收敛为 `interrupted`，并在同一 Run 下创建新 Attempt 完成恢复；
事件序号、credential 隔离和工具 invocation ID 均保持预期。Runtime 现已提供不含
秘密的本地 Model Registry 和 `/v1/models` profile discovery；OS keychain/Vault
CredentialProvider 仍未完成。Runtime 现已持久化 Session 和有序 user/assistant
transcript，每条用户消息在同一 Session 下创建独立 Run，并提供可重连的交互式 CLI；
这条协议后续由 `RuntimeClient` 接入 Workbench。真实 DeepSeek V4 Flash 已验证
thinking/usage 事件、跨进程连续对话，以及通过真实 `zion-local-tools` 完成 `read`
工具循环。Runtime ContextProvider 已对齐现有 Message Contributor 的 `pre` 单次和
`post` 每轮语义；CapabilityPolicy 与现有 RunPolicy 归一化使用共享兼容测试锁定。
Terminal Inventory 已复用 `dev.terminal-manager` 的 shared domain，并通过该插件的
headless runtime entry 提供 pre-stage Provider；Runtime Host 只注入 RunPolicy
显式允许的终端 Session，不读取浏览器 StateBus。自动上下文采用确定性有界投影，
默认最多 8 台机器、24 个 Workspace 且每台机器最多 12 个 Workspace；策略显式指定
Session 的父级资源始终保留，完整目录由 `terminalInventory` 工具按需查询。该领域逻辑和 Workbench
compatibility adapter 均不属于 `@zion/runtime`。Runtime Host 现通过显式 allowlist
发现 manifest 的 `entries.runtime`，在执行前校验 API 版本和 canonical entry path，
隔离单插件激活失败并逆序释放成功激活的插件。当前 v2 支持 Tool、
ContextProvider、Run post-processor、namespaced state 和 plugin-scoped event
contribution；插件仍是可信同进程代码，不等同于安全沙箱或完整安装服务。

退出条件：Runtime 可独立完成带工具的 Run，事件和 checkpoint 可在进程重启后
恢复，且尚不依赖 Workbench 集成。

### M3.5：Workbench opt-in 集成

- [x] 定义前端 `RuntimeClient`；
- [ ] 实现 `InProcessRuntimeClient`；
- [x] 实现 `HttpRuntimeClient`；
- [x] 保留 `window.zion.chat` 兼容 facade；
- [x] Scheduler opt-in 使用 Runtime RunEvent 驱动现有 Session projection；
- [x] Scheduler feature flag 双路切换，并按 event sequence 恢复；
- [x] service-backed Scheduler Agent worker 移入 `apps/runtime`；
- [x] 默认 `auto` 模式优先健康 Runtime，离线时回退浏览器兼容执行；
- [x] 普通交互 Chat 的纯文本、只读、在线 RuntimeClient opt-in；
- [x] 普通交互 Chat 按 Browser Run Ledger 中的 Runtime identity 和 event
  sequence 重启续接；
- [x] Workbench OpenAI-compatible Model Profile 与 Credential 自动迁移；
- [x] Workbench Session 文档、树、KV 和修订历史迁入 Runtime SQLite；
- [x] Runtime SQLite durable Session Event Feed、JSON catch-up、SSE cursor
  resume 和 cursor expiry reset；
- [x] raw Run Event Log 与 Client Projection Stream 分离，支持 delta 合批、
  `Last-Event-ID`、断线重连和慢消费者 backpressure；
- [x] Workbench、CLI 默认消费 projection stream，raw stream 仅显式诊断；
- [x] Workbench 跨页面/跨 origin 增量同步、活动 Run 发现与自动 attach；
- [x] 30 秒全量 snapshot polling 降为断线和旧 Runtime 的兼容路径；
- [x] Scheduler Task、occurrence、Run、lease 和触发时钟迁入 Runtime SQLite；
- [x] local-tools 旧控制面状态的一次性幂等导入；
- [x] 浏览器模型兼容路径改走受限 Runtime Model Gateway；
- [x] 普通交互 Chat 的多模态和完整 ContextProvider 对齐：Runtime
  `TranscriptMessage` 原生保留 `text/image_url` parts；Skills、Memory、
  Identity、Compression 和 Terminal Provider 在 Runtime 执行，Comments
  等文档绑定的 UI contributor 作为当前交互的 client context 传入。

退出条件：无工具和只读工具的 Run 可由独立 Runtime 执行并投影到编辑器，
刷新页面后可以从 event sequence 续接，且关闭 feature flag 可回到原路径。

### M4：Tool Host，约 2-3 周

- [x] Device protocol v1；
- [x] Node capability discovery 与 project/resource 路由；
- [x] CapabilityPolicy 约束的 Device Connector 到现有 `zion-local-tools`；
- [x] 远程 invocation cancellation；
- [x] 新 Node instance 注册后的未完成 invocation 重投；
- [x] Device-local resource 与 terminal-session 二次授权；
- [x] replacement 后 stale Connector 停止轮询并取消本地工作；
- [x] durable Node Registry 与 Runtime-side invocation receipt；
- [x] 持久 ProjectBinding；
- [x] CapabilityPolicy；
- [ ] Python host 原生 Connector；
- [ ] browser host 注册；
- [x] invocation lease；
- [x] invocation timeout / lease expiry；
- [x] artifacts / changes；
- [x] 工具通用 renderer；
- [x] 移除新增工具对 `chat.toolHandlers` 的依赖：Runtime 工具由
  Capability Catalog + Runtime Tool Broker 动态发现和调用，
  `chat.toolHandlers` 仅保留浏览器兼容执行路径。

退出条件：后端 Agent 可调用文件、终端、邮件；browser-only 工具仅在在线交互 Run 可选。

### M5：Context 和 Session，约 2-3 周

- [x] Terminal Inventory Provider；
- [x] Skills Provider；
- [x] Memory Provider；
- [x] Compression Provider；
- [x] canonical transcript；
- [x] Session 文档持久化与 Runtime Event 到 Workbench 的 projection；
- [x] Hocuspocus/Yjs 协同文档、CodeMirror 6 binding 和浏览器 IndexedDB
  离线副本；
- [x] Yjs state 与普通 Session 文本在 Runtime SQLite 中原子投影；
- [x] Runtime 作为最终模型输出 writer，生成中内容使用临时 Client
  projection，完成后再幂等提交协同文档；
- [x] Workbench 使用 CodeMirror decoration 显示 pending assistant，不把
  token 流写入 Yjs 或 Browser Run Ledger；
- [x] reasoning 按时间/字符合批，历史 transient token events 在加载时清理；
- [x] Hocuspocus 持久化事件尾沿合并为 `document.checkpointed`；
- [x] 多客户端并发编辑、断线重连、Runtime 重启恢复和最终收敛测试；
- [x] fork；
- [x] tool/reasoning history；
- [x] 浏览器 Session 与 local-tools legacy state migration。

退出条件：普通 Chat 默认后端 Runtime，历史上下文与旧版本一致。

### M6：Durable 切换，约 1 周

- [x] Scheduler 控制面由 Runtime 持有；
- [x] Runtime 支持的任务不再等待 browser worker；
- [x] Runtime/Workbench worker 按工具能力分流；
- [x] Run/Event 与 Scheduler 状态重启恢复；
- [x] 模型 secret 与 API 响应隔离；
- [x] service-backed 数据迁移；
- [x] local-tools legacy 路由默认关闭并保留显式回滚开关；
- [x] 扩展 `write/edit/Bash/mail/web/MCP` Runtime Tool Host adapters。

退出条件：关闭浏览器后，非 browser tool 任务仍可完成且只执行一次。

总工期取决于 fixture 和 provider 数量。建议按 9-13 周的工程量规划，而不是一次大改。

### M7：CLI 与多宿主验证，约 1-2 周

该批次在 `agent-core` 完成后即可开始，可与 M3-M6 并行，不必等待 Durable 切换。

- [x] `zion run`；
- [x] human / JSONL 输出；
- [x] local / cloud profile；
- [x] attach / resume / abort；
- [x] `session attach` 活动 Run 发现与 SSE follow；
- [x] `session watch --jsonl` durable Session cursor 输出；
- [x] stdin / stdout；
- [x] output schema；
- [x] workload identity（projected token file）；
- [x] OAuth device flow；
- [x] standalone Runtime adapter；
- [x] CLI Tool Host；
- [x] CI fixture。

退出条件：CLI 不依赖 UI 即可执行同一 Agent Core，并输出与 Web 相同的 RunEvent。

### M8：Desktop，独立产品阶段

- [ ] Electron 或 Tauri shell 评估；
- [ ] Local Runtime supervisor；
- [ ] Device Tool Host；
- [ ] Keychain；
- [ ] device identity；
- [ ] tray / notification；
- [ ] 开机启动；
- [ ] 自动更新；
- [ ] sleep / wake 恢复；
- [ ] Cloud Device Bridge。

退出条件：Desktop 不复制 AgentLoop，并可作为本机 Runtime 和云端设备能力节点。

### M9：Cloud，独立平台阶段

- [ ] tenant / organization model；
- [ ] Cloud Control Plane；
- [ ] Runtime queue；
- [ ] ephemeral sandbox；
- [ ] cloud workspace；
- [ ] artifact store；
- [ ] secret vault；
- [ ] egress policy；
- [ ] device bridge；
- [ ] data residency；
- [ ] audit / quota / billing；
- [ ] Webhook / IM ingress。

退出条件：Cloud Runtime 与 Local/Desktop/CLI 使用同一协议，且租户、网络、凭证和 workspace
隔离通过安全评审。

---

## 5. 插件 SDK 清单

- [x] 产品 manifest 支持 `shared`、`skill`、`runtime`、`resource`、
  `renderer`、`workbench`、`cli`；
- [x] entry 均可选；
- [ ] Runtime sandbox；
- [x] tool schema validator；
- [x] generic tool card；
- [x] plugin-scoped storage；
- [ ] plugin-scoped secret reference；
- [ ] Capability declaration；
- [x] host compatibility；
- [ ] Install Plan；
- [ ] 每个 Host 独立安装回执；
- [ ] Desired/Actual state；
- [ ] install transaction 与 rollback；
- [ ] uninstall migration；
- [ ] 卸载时停止服务并撤销 Capability；
- [ ] hot reload 只用于开发；
- [ ] example UI-only plugin；
- [ ] example Resource-only plugin；
- [ ] example full plugin。

---

## 6. 不应在迁移中顺手做的事

- 不迁移 Vite 到 Next.js；
- 不重写 CodeMirror Session Editor；
- 不把 Python 工具全部改成 TypeScript；
- 不同时更换数据库；
- 不重新设计全部 UI；
- 不先做外部 webhook；
- 不允许新旧 Runtime 同时执行同一 Run；
- 不把 browser state 整体序列化给后端；
- 不持久化未评审的完整 reasoning。

这些工作会扩大验证面，但不帮助建立核心 Runtime 边界。

---

## 7. 每个批次的通用验收

- [ ] 单元测试；
- [ ] contract test；
- [ ] 断线和重连；
- [ ] abort；
- [ ] timeout；
- [ ] duplicate event；
- [ ] duplicate invocation；
- [ ] 权限拒绝；
- [ ] secret 不进入日志；
- [ ] 前一版本客户端兼容；
- [ ] feature flag 回滚；
- [ ] 性能不低于基线；
- [ ] 文档更新。
