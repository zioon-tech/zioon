# Agent Runtime 后端迁移清单

> 本文是执行清单，不替代架构说明。  
> 目标架构见 [AGENT-RUNTIME-BOUNDARY-STRATEGY.md](./AGENT-RUNTIME-BOUNDARY-STRATEGY.md)。
> 多端演进见 [MULTI-SURFACE-AGENT-PLATFORM.md](./MULTI-SURFACE-AGENT-PLATFORM.md)。

## 1. 迁移完成的定义

只有同时满足以下条件，才算 Runtime 已迁移：

- 普通聊天和定时任务由同一后端 AgentLoop 执行；
- 浏览器关闭后，不依赖 browser tool 的任务可以继续；
- 模型凭证不再下发浏览器；
- Run、tool call、usage 和 transcript 有后端权威状态；
- 前端通过 sequence 可重连和补事件；
- Tool Broker 在调用点强制 CapabilityPolicy；
- 插件不再通过 `chat.tools` / `chat.toolHandlers` 注册 Runtime 工具；
- 前端仍能展示现有 reasoning、工具卡片、diff 和 Session；
- local runtime 仅作为明确的离线兼容模式，不能与后端同时拥有同一 Run。
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
| Terminal context | `dev.terminal-enhanced/main.js` | host 状态 | Local Tool Host Resource |
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
| fsRead / fsTree | local-daemon | file-read | 是 |
| fsWrite / fsEdit | local-daemon | file-write | 是 |
| terminalExecute | local-daemon | process | 是 |
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
- [ ] reasoning projection tests；
- [ ] Session 文档 projection tests；
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

- [ ] 定义 `ModelAdapter`；
- [ ] 定义 `ToolBroker`；
- [ ] 定义 `RunStore`；
- [ ] 定义 `ContextProvider`；
- [ ] 抽多步 AgentLoop；
- [ ] programmatic 和普通 Chat 使用同一 AgentLoop；
- [ ] 浏览器 adapter 保持默认执行。

退出条件：Agent loop 在 Node 单测中运行，不引用 DOM。

### M3：Runtime service，约 2 周

- [ ] `POST /v1/runs`；
- [ ] abort；
- [ ] SSE event resume；
- [ ] SQLite RunStore；
- [ ] Model Registry；
- [ ] credential vault；
- [ ] usage；
- [ ] 前端 RuntimeClient；
- [ ] feature flag 双路对比。

退出条件：无工具的普通对话可完整在后端运行并投影到编辑器。

### M4：Tool Host，约 2-3 周

- [ ] Tool Registry；
- [ ] CapabilityPolicy；
- [ ] Python host 注册；
- [ ] browser host 注册；
- [ ] invocation lease；
- [ ] timeout / cancel；
- [ ] artifacts / changes；
- [ ] 工具通用 renderer；
- [ ] 移除新增工具对 `chat.toolHandlers` 的依赖。

退出条件：后端 Agent 可调用文件、终端、邮件；browser-only 工具仅在在线交互 Run 可选。

### M5：Context 和 Session，约 2-3 周

- [ ] Skills Provider；
- [ ] Memory Provider；
- [ ] Compression Provider；
- [ ] canonical transcript；
- [ ] Session projection；
- [ ] fork；
- [ ] tool/reasoning history；
- [ ] migration。

退出条件：普通 Chat 默认后端 Runtime，历史上下文与旧版本一致。

### M6：Durable 切换，约 1 周

- [ ] Scheduler 直接创建 Runtime Run；
- [ ] 不再等待 browser worker；
- [ ] durable eligibility 校验；
- [ ] 重启恢复；
- [ ] secret isolation；
- [ ] service-backed 数据迁移；
- [ ] 运维和回滚手册。

退出条件：关闭浏览器后，非 browser tool 任务仍可完成且只执行一次。

总工期取决于 fixture 和 provider 数量。建议按 9-13 周的工程量规划，而不是一次大改。

### M7：CLI 与多宿主验证，约 1-2 周

该批次在 `agent-core` 完成后即可开始，可与 M3-M6 并行，不必等待 Durable 切换。

- [ ] `zion run`；
- [ ] human / JSONL 输出；
- [ ] local / cloud profile；
- [ ] attach / resume / abort；
- [ ] stdin / stdout；
- [ ] output schema；
- [ ] device flow / workload identity；
- [ ] standalone Runtime adapter；
- [ ] CLI Tool Host；
- [ ] CI fixture。

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

- [ ] manifest 支持 `ui`、`runtime`、`tools`、`renderers`；
- [ ] entry 均可选；
- [ ] Runtime sandbox；
- [ ] tool schema validator；
- [ ] generic tool card；
- [ ] plugin-scoped storage；
- [ ] plugin-scoped secret reference；
- [ ] Capability declaration；
- [ ] host compatibility；
- [ ] install transaction；
- [ ] uninstall migration；
- [ ] hot reload 只用于开发；
- [ ] example UI-only plugin；
- [ ] example tool-only plugin；
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
