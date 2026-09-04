# Zion Client / Runtime 分离方案

> 状态：当前交付架构
> 日期：2026-09-03
> 范围：将 `zion-next` 收敛为展示与交互 Client，将 Agent 执行迁移到可独立运行的 Runtime。

## 1. 目标

近期只解决一个问题：

> 即使 `zion-next` 页面关闭，已经提交给 Runtime 的任务仍可继续执行、持久化和恢复；
> 页面重新打开后只负责重新连接并展示结果。

当前不建设：

- 多 Runtime 调度；
- 公网 Relay；
- Control Plane 集群；
- Runtime Federation；
- 多宿主插件市场；
- 通用分布式计算。

这些能力可以在未来复用同一协议扩展，但不能阻塞 Client / Runtime 分离。

## 2. 最小架构

```text
┌─────────────────────────────────────────────┐
│ zion-next Workbench                         │
│                                             │
│ Editor / Session UI / Cards / Approval UI   │
│ RuntimeClient / Yjs Editor / UI Projection  │
└──────────────────────┬──────────────────────┘
                       │ HTTP + SSE + Yjs WebSocket
                       │
┌──────────────────────▼──────────────────────┐
│ Standalone Runtime                          │
│                                             │
│ Agent loop / Model / Context / Tool Broker  │
│ Run Store / Session Feed / Collaboration    │
│ Scheduler worker / Credentials              │
└──────────────────────┬──────────────────────┘
                       │ local adapter / MCP
┌──────────────────────▼──────────────────────┐
│ Local capabilities                          │
│ files / terminal / browser / external APIs  │
└─────────────────────────────────────────────┘
```

部署上可以全部位于同一台电脑，但必须是独立生命周期：

```text
zion-next 关闭  !=  Runtime 停止
```

## 3. 职责边界

### 3.1 zion-next

只负责：

- 编辑器与 Session 展示；
- 用户输入；
- Run/Stop、审批等交互；
- RunEvent 到卡片、状态栏等 UI 状态的投影；
- CodeMirror 与 Runtime Yjs 文档的绑定；
- Runtime 连接状态；
- 浏览器独有能力的可选桥接。

不得继续承担：

- Agent loop；
- 模型凭证；
- 权威 Run 状态；
- 长任务生命周期；
- Scheduler Agent worker；
- 非浏览器工具的实际执行。

### 3.2 Runtime

负责：

- 接收 RunRequest；
- Agent loop 和模型调用；
- ContextProvider；
- Tool Broker；
- timeout、cancel、checkpoint 和 resume；
- Run、Attempt、Event、Usage 持久化；
- Session 文档、树、KV、revision 和 durable event feed；
- Hocuspocus/Yjs 房间与 CRDT 持久化；
- raw Run log 到跨端 Client Projection Stream 的合批与背压；
- 模型完成后向协同文档提交最终 assistant block；
- Scheduler 任务执行；
- 凭证和本机能力访问。

Runtime 必须能通过 CLI/API 独立运行和测试，不导入 DOM、CodeMirror、
`window.zion` 或浏览器存储。

## 4. 最小协议

Workbench 只依赖以下稳定接口：

```typescript
interface RuntimeClient {
  createRun(request: RunRequest): Promise<AcceptedRun>;
  getRun(runId: string): Promise<RunRecord>;
  getEvents(runId: string, afterSequence?: number): Promise<RunEvent[]>;
  subscribe(runId: string, options?: {
    afterSequence?: number;
    signal?: AbortSignal;
    mode?: "raw" | "projection";
    reasoningMode?: "stream" | "summary" | "none";
  }): AsyncIterable<RunEvent>;
  abort(runId: string, reason?: string): Promise<void>;
}
```

Session 发现和协同编辑使用独立协议：

```text
GET /v1/workbench-state/snapshot
GET /v1/workbench-state/events?after={sequence}
GET /v1/workbench-state/events/stream?after={sequence}
GET /v1/sessions/{sessionId}/active-run
GET /v1/runs/{runId}/projection?after={sequence}
GET /v1/runs/{runId}/projection/stream?after={sequence}
WS  /v1/collaboration
```

模型选择遵循：

```text
Workbench 选择 modelProfileId
  -> Runtime 校验 Profile 是否存在
  -> Runtime 使用该 Profile 的 Provider 与 Credential
  -> Run 回执记录 effective ModelRef
```

Workbench 的选择是用户意图，Runtime 不得静默替换成默认模型或 Echo。`auto`
模式下，尚未迁移到 Runtime 的浏览器模型暂时留在兼容路径；强制 `runtime` 模式下
必须显式报错。

约束：

- Event 必须先持久化，再发送给 Client；
- 每个 Run 的 sequence 单调递增；
- Client 重连只提交最后确认的 sequence；
- 页面卸载只 detach，不 abort Runtime Run；
- 用户主动 Stop 才调用 Runtime abort；
- Runtime 请求发送后不自动回退浏览器执行，避免重复 Run。
- Session event cursor 过期时重新读取 snapshot，不能从缺口后继续投影；
- 协同正文使用 Yjs state vector 恢复，非 CRDT 写入使用
  `expected_session_revision`；
- Runtime 是模型最终输出的协同文档 writer；生成过程是可丢弃、可恢复的
  Client projection，不是 CRDT 编辑。
- raw Run events 只用于 Runtime 审计；普通客户端使用 projection stream。
- 慢客户端通过有界队列把 backpressure 传回 SSE，不允许无界缓存。

## 5. 状态所有权

| 状态 | Owner |
|---|---|
| Run / Attempt / Event / Checkpoint | Runtime |
| Agent loop 和模型上下文 | Runtime |
| 模型与服务凭证 | Runtime |
| Tool execution receipt | Runtime 或 Tool Host |
| Session 文档、Yjs state、树、KV 与修订历史 | Runtime SQLite |
| Durable Session Event Feed | Runtime SQLite |
| Yjs 离线副本与 Awareness | Client 本地缓存；非权威 |
| UI selection、scroll、panel layout | Workbench |
| Event/Card projection | Workbench，可重建 |

过渡期允许 Browser Run Ledger 保存 Runtime Run 的索引：

```text
runtimeRunId
runtimeAttemptId
runtimeBaseUrl
workbenchSessionId
panelId
lastEventSequence
```

它只是恢复指针，不是权威执行状态。

## 6. 迁移顺序

### Step 1：独立 Runtime

状态：已完成。

- DOM-free Agent Core；
- HTTP/SSE；
- SQLite Run/Event/Checkpoint；
- CLI；
- abort、timeout 和 resume；
- 只读 local-tools。

### Step 2：Workbench opt-in

状态：已完成基础路径。

- Scheduler 的 `auto` Runtime 分支与浏览器兼容分支；
- 普通 Chat 的 `auto` Runtime 分支，支持 `text/image_url`；
- Session/Event projection；
- Run/Stop；
- sequence 重连；
- 页面卸载不终止远端 Run。
- Workbench Session 状态与 Scheduler 控制面已迁入 Runtime SQLite；
- Workbench 通过 durable Session SSE 即时发现外部 Session/Run 变化，并以
  snapshot cursor 断线续接；
- Workbench、CLI 和未来 Mobile 默认消费 Runtime 合批的 Run projection；
- `GET /v1/sessions/{sessionId}/active-run` 支持新客户端进入运行中会话；
- Session 正文已接入 Hocuspocus/Yjs 和 CodeMirror binding，浏览器 IndexedDB
  仅作为离线副本；
- Workbench 使用临时 decoration 显示流式输出，Runtime 在完成时一次提交；
- 浏览器 Run Ledger 不保存 token 事件，并在加载时删除旧 token 记录；
- service-backed Scheduler worker 随 Runtime 启动；Workbench 不再领取
  service-backed Run；
- 旧 local-tools Session、Scheduler 和 LLM 路由默认关闭。
- 首次绑定旧 Workbench Session 时导入 immutable canonical seed transcript。

统一配置：

```text
zion.runtime.mode = auto | runtime | browser
zion.runtime.baseUrl = http://127.0.0.1:8766
```

默认模式是 `auto`：自动发现本机 Runtime，在线时使用 Runtime，离线时在迁移期
回退浏览器兼容路径。普通用户不需要修改配置；`runtime` 和 `browser` 仅用于强制
部署模式与故障排查。

旧的 Chat/Scheduler 独立开关只保留兼容，不再扩展。

### Step 3：补齐常用能力

按真实使用频率迁移，不追求一次性全量：

1. Workbench 模型选择映射为 Runtime `modelProfileId`，Runtime 严格校验并返回
   effective ModelRef；现有 OpenAI-compatible 配置可自动导入，Claude/Gemini
   Provider adapter 和系统 Keychain 实现尚未完成；
2. Skills、Memory、Identity、Terminal 和 Compression ContextProvider 已迁移；
3. `write/edit/Bash` 已有 Runtime receipt，但异步 Approval 仍待实现；
4. 图片消息已支持，附件和外部 Artifact Store 仍待实现；
5. 浏览器专属工具改为显式 Client Capability。

### Step 4：Runtime 成为默认

条件：

- 普通 Chat 和 Scheduler 的高频路径通过；
- Runtime 不可用时给出明确错误；
- 不发生静默双执行；
- 重启、取消和事件补拉稳定；
- 凭证不再下发浏览器 Agent。

切换后安装程序负责启动 Runtime，`auto` 应稳定解析为 Runtime。浏览器 Agent 暂时
保留为显式兼容模式。

### Step 5：删除浏览器 Agent

至少经过一个稳定版本后：

- 删除浏览器模型调用；
- 删除浏览器 Agent loop；
- 删除重复的 Tool 执行路径；
- `window.zion.chat` 只保留 RuntimeClient facade；
- 清理仅为双路径存在的兼容代码。

## 7. 完成标准

满足以下条件即可认为 Client / Runtime 分离完成：

1. `zion-next` 不持有模型凭证；
2. 所有 Agent Run 都由 Runtime 创建和执行；
3. 关闭页面不影响已接受的非浏览器任务；
4. 重开页面可按 sequence 恢复；
5. Scheduler Agent 任务不依赖在线浏览器 worker；
6. Client 只能投影状态，不能成为 Run owner；
7. Runtime 可被 CLI 或其他 Client 独立使用；
8. 多个 Workbench 可实时发现 Session 和 attach 活跃 Run；
9. 多编辑器并发、离线和重连后 Yjs 文档收敛到 Runtime SQLite。

## 8. 模型配置迁移

Workbench 中已有的模型选择仍然有效。Runtime 模式下：

1. Workbench 查询 Runtime Model Profile；
2. 已存在对应 Profile 时直接使用；
3. 不存在且当前 Provider 是 OpenAI-compatible 时，自动导入现有 endpoint、模型参数
   和 Credential；
4. Runtime 持久化 Profile，并通过 write-only Credential API 保存密钥；
5. Runtime 返回 effective ModelRef，Workbench 用它进行展示和审计；
6. Claude、Gemini 或暂不支持的 Provider 在 `auto` 模式下继续走浏览器兼容路径。

当前 Credential Store 使用仅本机可读的 `0600` 文件，接口不会返回密钥。这是从
浏览器 `localStorage` 迁出的过渡实现；后续替换为 OS Keychain/Vault 时不改变
Model Profile API。

## 9. 与分布式架构的关系

[ZION-DISTRIBUTED-RUNTIME-PRODUCT-ARCHITECTURE.md](./ZION-DISTRIBUTED-RUNTIME-PRODUCT-ARCHITECTURE.md)
保留为未来扩展方向。

当前本地实现不需要 Control Plane、Relay、Placement 或 Runtime Federation。未来
增加公网和 Mobile 时，Relay 只负责认证、路由、限流和 HTTP/SSE/WebSocket 传输，
不解释 Session 或 CRDT 业务语义；Workbench、CLI 和 Mobile 继续复用同一 cursor、
RunEvent 和 Yjs 协议。
