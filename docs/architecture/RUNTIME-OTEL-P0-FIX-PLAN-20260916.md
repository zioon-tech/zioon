# Runtime OTel P0 修复方案

> Date: 2026-09-16
> Input:
> [Runtime OTel、Run Ledger 与 Agent 诊断能力评审](./RUNTIME-OTEL-RUNLEDGER-AGENT-DIAGNOSTICS-REVIEW-20260916.md)
> Goal: 用最小改动把当前“可运行的观测原型”修正为“结论可信、状态诚实、
> 部署可复现的单 Run 诊断能力”。
> Non-goal: 本轮不扩展为完整分布式追踪或监控平台。
>
> Implementation status (2026-09-17): 工作包 A、B、C 已实现并通过 480 项
> Runtime 相关源码测试；Jaeger 2.20 Badger 配置已通过原生校验及重启持久性
> smoke。Docker daemon 与 Caddy 二进制在本机不可用，因此容器启动和
> `caddy validate` 仍需在部署主机执行。

## 1. 方案结论

P0 只做三组改动：

1. **补齐诊断事实**：Gateway 真正读取 RunEvent，修正 timeout、policy denial、
   Trace 延迟到达和截断语义。
2. **修正耗时口径**：保留现有 Span 树，不重构流式引擎；记录异步生成器的
   consumer wait，并停止把 `chat.duration` 直接称为纯模型耗时。
3. **固化部署**：把 OTel/Caddy 配置纳入 Git 和正式部署生成器；单机 Jaeger
   使用最小持久化存储，不引入集群、Tempo、Elasticsearch 或新控制面。

本轮明确不做：

- 不替换 RunStore 或改变 RunEvent 的权威性；
- 不新增 Attempt 数据表；
- 不改造 SSE、Yjs 或 Session Projection；
- 不做 Device Connector trace propagation；
- 不增加 Metrics、OTel Logs、Dashboard 或告警平台；
- 不增加 Workbench/Mobile 复杂 UI；
- 不开放 TraceQL 或 Jaeger MCP；
- 不采集 prompt、reasoning、tool arguments/result；
- 不重构模型流为生产者/消费者队列。

## 2. 修复后的最小能力边界

P0 完成后，`observabilityInspect` 应准确支持：

- 即使 Trace Backend 未配置，也能返回 RunRecord + 安全 RunEvent 事实；
- 区分成功、失败、用户取消和 timeout；
- 识别工具调用成功、失败、receipt hit 和 policy denial；
- 识别 Context Provider 失败；
- 对已采样 Trace 展示 Attempt、模型调用链和工具 wall time；
- 显示模型调用链中有多少时间是在等待调用方消费；
- 对刚结束但尚未索引的 Trace 返回“可能仍在写入”，而不是直接断言不存在；
- 所有列表截断都显式标记；
- HTTP 默认返回摘要，Tool 可显式请求 stages/findings；
- 部署可以从已提交源码和配置重建。

P0 还应提供一个最小的 `observabilityOverview`，让模型不需要预先知道 Run ID
也能发现当前可见范围内最近的失败、超时、中断和慢 Run。

P0 完成后仍不能承诺：

- 精确拆分模型提供方排队、DNS、TLS、网络和推理时间；
- 诊断远端 Device 内部阶段；
- 诊断 Session/Yjs/文档投影；
- 查询同一 Run 的历史 Attempt；
- 跨 Run 趋势、SLO 和告警；
- 多租户对象级权限隔离；
- 将 Trace 作为审计记录。

## 3. Plugin、Tool 与 Skill 的职责边界

### 3.1 明确边界

`dev.observability` 只负责提供可靠的运行证据，不负责修复：

```text
RunStore / OTel Backend
  -> dev.observability
  -> observabilityInspect
  -> 结构化、脱敏、有限的事实
  -> 调用方模型自行分析
```

后续是否修改代码、运行测试或发布，与该插件无关。模型可以组合现有
`read/grep/edit/Bash` 等工具完成这些工作，但不应给 Observability 插件增加写入、
执行或部署能力。

这条边界应成为硬约束：

- Plugin：接入 Runtime、声明 Tool 和 Skill；
- Tool：读取并投影事实；
- Skill：告诉模型何时调用 Tool、如何解释字段；
- Model：形成结论；
- 其他工程 Tool：在各自权限下执行后续动作。

本轮不新增独立的 `runLedgerInspect` Tool。当前 Runtime 的
`GET /v1/runs/{runId}`、`/events` 和 `/transcript` 是客户端 API，并不是模型
Tool；浏览器侧 `zion.runs` 也只服务于本地日志 UI。正确的最小方案是让
`observabilityInspect` 成为统一的只读证据入口，在 Gateway 内组合
RunRecord、allowlisted RunEvents 和可选 Trace。否则模型需要调用两个 Tool
自行拼接数据，还要处理两套权限、版本和不一致状态。

### 3.2 当前 Skill 实际做了什么

`run-diagnostics` 不是可执行程序，也不会自动监听异常。当前 Skill 系统的实际流程是：

1. `dev.observability/manifest.json` 声明 Skill 路径；
2. `dev.skills` 将它物化进 Runtime Skill catalog；
3. `dev.skills.available` 只把 Skill 名称、描述和位置注入模型上下文；
4. 模型认为该 Skill 与问题相关时，再通过 `Read` 或
   `skillsList(include_body=true)` 读取完整 `SKILL.md`；
5. 模型按文档调用 `observabilityInspect` 并组织回答。

因此 Skill 本质上是**按需加载的操作说明和解释规则**：

- 不提供新数据；
- 不注册新执行能力；
- 不增加权限；
- 不保证模型一定选择它；
- 不会自动执行 Tool；
- 不能替代 Tool 的 schema、鉴权、脱敏或边界检查。

### 3.3 为什么当前 Skill 看起来作用不大

这个判断基本正确。当前 Tool 只有一次简单调用，而 Skill 有 105 行，大量内容与
Tool description、返回 schema 和设计文档重复。

它还有几处实际问题：

- 要求模型先获得明确 `run_id`，但没有帮助模型定位上一条 Run；
- 要求结合 Run Ledger events，但 Tool 当前不返回 events；
- 描述 `expired`、timeout、policy denial 等尚未完整实现的能力；
- Backend 未配置时 Tool 不注册，但 Skill 仍可能出现在 catalog；
- 固定回答模板和大量安全说明增加上下文，却没有增加数据能力。

所以当前 Skill 的边际价值较低，而且可能让模型高估 Tool 能力。

### 3.4 Skill 应保留，但缩成解释护栏

不建议完全删除。RunStore 与 Trace 的权威性、采样和 coverage 语义并不直观，
一个短 Skill 可以显著减少模型误判。

但 Tool 必须在完全不读取 Skill 的情况下仍然可用。所有安全和正确性约束必须由
代码强制执行，不能依赖 prompt。

建议把 Skill 收缩到约 30 行，只保留：

```text
When to use
- 用户询问某次 Run 为什么慢、失败、取消或表现异常。

Workflow
1. 用户问具体 Run 时调用 observabilityInspect。
2. 用户问“最近有什么问题”时先调用 observabilityOverview，再对最相关的
   1～3 个 Run 调用 observabilityInspect。
3. 没有 run_id 且语境指向“刚才那次”时，让 Inspect 选择当前 Session
   最近一个已结束 Run。
4. Run facts 是状态和顺序的权威来源。
5. Trace 只用于耗时和调用关系。
6. 先说明 coverage 和 limitations。
7. 最多给出三个有证据支持的结论。

Interpretation
- duration 只能说明相关性，不能单独证明根因。
- 缺失 Span 表示未知，不表示耗时为零。
- unsampled/backend unavailable 不等于 Run 失败。
- 不输出原始 Tool JSON。
```

删除：

- 完整响应模板；
- 已由 Tool 强制执行的权限和字段清单；
- 尚未实现的状态说明；
- “直接读取 RunEvent”等当前做不到的指令；
- 任何修复、部署或自我优化流程。

### 3.5 Tool 才是本轮重点

一个足够好的 `observabilityInspect` 应满足：

1. **不依赖 Skill 才能正确使用**：description 和 schema 自解释。
2. **不要求用户寻找内部 ID**：`run_id` 改为可选；缺省时选择当前 Session
   最近一个已结束且非当前的 Run。
3. **事实完整**：同时返回 RunRecord、allowlisted RunEvents 和 Trace stages。
4. **来源明确**：每个字段能区分来自 RunStore 还是 Trace。
5. **不做越权推理**：不把相关性写成根因。
6. **降级可用**：无 Backend、未采样或 Trace 丢失时仍返回 Run facts。
7. **稳定有界**：限制事件、Span、字节数和查询时间，并显式报告截断。
8. **隐私默认关闭**：不返回 prompt、reasoning、参数、结果、路径、URL 或原始错误。
9. **对 Agent 精简**：不返回无助于解释的 trace/span/internal instance ID。
10. **确定性**：相同记录产生相同结构化结果，模型只负责总结。

`run_id` 缺省解析不需要新增索引或数据库表。当前 `PostgresRunStore` 已有
`getSessionMessages(sessionId)`，可以：

```text
1. 读取当前 meta.sessionId；
2. 从后向前查找 runId != meta.runId 的最近消息；
3. 用 runs.get(candidateRunId) 验证它已经终结；
4. 没有候选时返回明确的 no-target 状态。
```

显式传入 `run_id` 时保持现有行为。

### 3.6 Tool 应返回事实，不应替模型写结论

当前 `run-diagnostic-projector.mjs` 会直接生成中文 headline 和 recommendation。
这会把查询工具变成一个规则诊断器，并导致规则、Skill、模型三处重复解释。

建议保留确定性分类，但改成结构化 signal：

```ts
signals: [{
  code: "slow_first_chunk",
  severity: "warning",
  evidence: {
    firstChunkMs: 1900,
    thresholdMs: 1000
  }
}]
```

Tool 返回：

```text
availability
sources
run facts
event facts
trace measurements
signals
coverage
limitations
```

不返回：

```text
“根因是……”
“建议修改……”
面向用户的长篇自然语言结论
```

模型是否总结、如何修复，是调用方职责。这样也方便 CLI、Workbench 和其他模型
复用同一份证据。

### 3.7 当前 Tool 的主要限制

| 限制 | 影响 |
|---|---|
| 必须提供 `run_id` | 用户和模型通常不知道内部 ID |
| 只读 RunRecord，不读 RunEvent | 业务失败和事件顺序缺失 |
| 只支持单 Run | 不能主动发现最近异常或趋势 |
| 只查询最新 Attempt | resume 前的 Trace 不可达 |
| active Run 不查询 Trace | 不能实时解释当前执行 |
| 无 Backend 时不注册 | RunStore fallback 也无法使用 |
| Trace 只有三类 Span | 看不到 Context、Projection、Device |
| `chat` wall time 有调用方等待 | 可能误报模型慢 |
| 不暴露已有 HTTP status 等安全字段 | 失败分类过粗 |
| 无查询限流和真实流式字节限制 | 可能放大 Backend 压力 |
| Tool 输出包含 trace/attempt ID | 会进入外部模型上下文 |
| visibility 只适合 single-space | 不能作为多租户 ACL |

### 3.8 “看见各种问题”需要另一个查询入口

`observabilityInspect` 应继续专注单 Run。不要把列表、趋势和单 Run 细节全部塞进
一个 Tool。

P0 增加一个只读 `observabilityOverview`：

```ts
observabilityOverview({
  window_minutes?: number, // 默认 30，上限 1440
  limit?: number,          // 默认 10，上限 50
  min_duration_ms?: number // 默认 30000
})
```

它只扫描当前 Project；没有 Project 时退化到当前 Session。它负责列出：

- failed；
- timeout；
- interrupted；
- 超过固定时长阈值；
- 长时间没有新事件的 active Run；
- Trace missing；
- Query Backend 当前是否可用。

Overview 不逐条查询 Jaeger，避免 N+1 请求。它只根据 RunStore 和
`zionTelemetry` metadata 返回候选 Run ID、状态、时长、最后事件时间、采样状态和
问题代码；模型再针对其中一个调用 `observabilityInspect`。

它不做任意查询、不读取内容、不修改系统，也不直接判断根因。

这两个 Tool 足以形成最小的观测消费面：

```text
observabilityOverview -> 找问题
observabilityInspect  -> 看证据
模型                   -> 总结
其他 Tool              -> 按已有权限执行后续工作
```

这已经是“模型能主动看到近期问题”的最小闭环。比较、趋势、告警和任意时间范围
搜索仍不进入 P0。

### 3.9 与后续修复的关系

Observability 插件不需要知道“怎么修”。模型拿到证据后，可以自行决定是否：

- 继续读取代码；
- 查询日志；
- 提出假设；
- 使用已有修改工具；
- 运行测试或 benchmark；
- 请求用户批准其他操作。

这些行为受调用 Run 的 Interaction Profile 和 CapabilityPolicy 约束。当前默认
Profile 是 `read-only`，所以默认情况下只能分析，不能修改。

本方案不新增修复 Skill、不新增修复 Tool，也不设计自治发布系统。未来若要提高
自动化程度，应在通用 Agent 执行、审批和发布体系中处理，而不是扩张
`dev.observability`。

### 3.10 典型调用示例

以下示例描述 P0 完成后的目标行为。当前实现只支持显式
`observabilityInspect({ run_id })`，且尚未包含完整 RunEvent facts。

#### 示例一：用户只说“刚才为什么这么慢”

模型不应要求用户先寻找 Run ID，而是直接调用：

```json
{
  "include_stages": true,
  "include_findings": true
}
```

Tool 使用调用上下文中的 `sessionId`，找到当前诊断 Run 之前最近一个已终结 Run，
返回：

```json
{
  "availability": "ready",
  "sources": {
    "runRecord": true,
    "runEvents": true,
    "trace": true
  },
  "ledger": {
    "status": "completed",
    "eventCount": 148,
    "attemptCount": 1,
    "tools": [
      { "name": "read", "status": "completed", "turn": 1 }
    ]
  },
  "trace": {
    "durationMs": 9200,
    "stages": [
      {
        "kind": "model",
        "name": "deepseek-v4",
        "durationMs": 7600,
        "activeDurationMs": 7100,
        "consumerWaitMs": 500,
        "firstChunkMs": 4100
      },
      {
        "kind": "tool",
        "name": "read",
        "durationMs": 180
      }
    ]
  },
  "coverage": ["run-events", "attempt", "model", "tool"],
  "limitations": [
    "Provider queueing, network and inference are not independently separated."
  ]
}
```

模型可以总结：

```text
这次 Run 共约 9.2 秒，最大的可观测阶段是模型调用链，活动时间约 7.1 秒，
首个数据块约 4.1 秒。read 工具仅约 180 毫秒，不是主要等待来源。
当前还不能区分模型提供方排队、网络和实际推理时间。
```

模型不能总结：

```text
DeepSeek 服务器排队导致了 4.1 秒延迟。
```

因为现有证据只能证明首块慢，不能证明具体根因。

#### 示例二：用户问“最近系统有什么问题”

模型先调用：

```json
{
  "window_minutes": 60,
  "limit": 10,
  "min_duration_ms": 30000
}
```

对应 Tool：`observabilityOverview`。

返回：

```json
{
  "scope": {
    "kind": "project",
    "id": "project-1"
  },
  "window": {
    "since": 1789567200000,
    "until": 1789570800000
  },
  "totals": {
    "inspected": 42,
    "problems": 3,
    "failed": 1,
    "timeout": 1,
    "interrupted": 0,
    "slow": 1,
    "stalled": 0
  },
  "runs": [
    {
      "runId": "run-timeout",
      "status": "aborted",
      "durationMs": 60000,
      "traceState": "queryable",
      "signals": ["timeout", "slow"]
    },
    {
      "runId": "run-model-429",
      "status": "failed",
      "durationMs": 1200,
      "traceState": "queryable",
      "signals": ["failed"]
    }
  ],
  "truncated": false
}
```

模型选择最值得解释的 1～3 个 Run，再分别调用：

```json
{
  "run_id": "run-timeout",
  "include_stages": true,
  "include_findings": true
}
```

这解决了“人不可能一直盯着每个 Run”的问题。Overview 找问题，Inspect 看证据。

#### 示例三：工具被策略拒绝

Run Ledger 提供：

```text
sequence 6: tool.requested, name=Bash
sequence 7: tool.denied, denialType=policy
sequence 8: turn.completed
```

OTel 提供：

```text
没有 execute_tool Bash Span
Attempt wall time = 2.4s
```

模型可以准确总结：

```text
Bash 没有实际执行。Run 在执行器授权阶段被 CapabilityPolicy 拒绝，
这不是 Tool Host 故障。
```

这里 Run Ledger 证明“发生了拒绝及其顺序”，OTel 证明“没有进入实际工具执行”。

#### 示例四：模型请求返回 HTTP 429

Run Ledger 提供：

```text
run.status=failed
terminalReason=failed
最后一个业务阶段是 model request
```

OTel 提供：

```text
chat.status=error
chat.errorType=model_error
chat.httpStatus=429
```

模型可以总结：

```text
Run 因模型调用失败而终止，模型端返回 HTTP 429。证据指向提供方限流，
没有 Tool 执行失败。
```

Tool 不需要返回 HTTP body、请求 URL 或 API key。

#### 示例五：Collector 或 Jaeger 不可用

Run Ledger 提供：

```text
run.status=completed
tools=[read:completed]
usage.input=1200
usage.output=180
```

Trace 查询返回：

```text
availability=backend-unavailable
```

模型应总结：

```text
这次业务 Run 已成功完成；当前不可用的是 Trace 查询链路。
仍可确认执行终态和工具结果，但不能分析阶段耗时。
```

模型不得把 Backend 故障描述成 Run 失败。

#### 示例六：用户反馈会话内容错序或空白

`observabilityOverview` 找到一个 completed Run，`observabilityInspect` 显示模型和
工具都成功，但 limitations 包含：

```text
Session/Yjs/document projection is not instrumented.
```

模型应回答：

```text
现有证据显示 Runtime Run 已完成，模型和工具阶段没有失败；但当前 Trace 不覆盖
Session/Yjs 文档投影，因此不能判断页面空白或消息错序的根因。下一步应检查
projection 事件和客户端状态。
```

然后模型可以使用其他已有代码或调试工具继续排查。Observability Tool 到这里结束，
不负责修改。

#### 示例七：模型后续修复

模型从 Tool 获得：

```text
事实：Run failed
事实：Bash 未执行
事实：denialType=policy
限制：没有用户授权信息
```

后续模型可以：

```text
1. 使用 read/grep 查看 Interaction Profile 和 policy 配置；
2. 判断是配置错误还是预期拒绝；
3. 如果当前 Run 有 workspace-write 权限，再使用 edit 修改；
4. 使用 Bash 运行测试；
5. 把 diff 和验证结果交给用户。
```

这些行为全部属于调用方模型及其他 Tool，不属于 `dev.observability`。

## 4. 工作包 A：补齐 Run 事实与状态语义

### 4.1 修改范围

- `packages/runtime/src/protocol.ts`
- `packages/runtime/src/memory-run-store.ts`
- `apps/runtime/src/postgres-run-store.mjs`
- `apps/runtime/src/observability/observability-service.mjs`
- `apps/runtime/src/observability/run-diagnostic-projector.mjs`
- `apps/runtime/src/observability/observability-http-handler.mjs`
- `extensions/dev.observability/runtime.js`
- `extensions/dev.observability/skills/run-diagnostics/SKILL.md`
- `apps/runtime/tests/observability-service.test.js`
- `apps/runtime/tests/observability-plugin.test.js`

不新增存储表或业务数据迁移；只允许增加
`runtime_runs(status, updated_at)` 查询索引。

### 4.2 Gateway 读取顺序

保持先授权、后读取事件，避免为不可见 Run 加载内容：

```text
1. runs.get(runId)
2. 检查 Run 是否存在
3. Tool 调用时检查 same Run / Session / Project
4. runs.getEvents(runId)
5. 立即投影为安全 facts，丢弃原始 event data
6. 根据采样和状态决定是否查询 Trace
7. 合并 facts + trace projection
```

`RuntimeObservabilityService` 构造时将 `runs.getEvents` 视为首选能力。为兼容测试
double 或未来精简 Store，如果没有该方法，仍返回 RunRecord-only 结果，并在
limitations 中明确：

```text
RunEvent details were unavailable.
```

### 4.3 增加安全的 Run facts 投影

先直接放在 `run-diagnostic-projector.mjs`，不新建抽象层。只有当文件继续明显增长
时再拆分。

建议输出：

```ts
ledger: {
  status: "completed" | "failed" | "aborted" | "interrupted";
  terminalReason?: string;
  durationMs?: number;
  eventCount: number;
  lastSequence: number;
  attemptCount: number;
  usage?: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
  tools: Array<{
    name: string;
    status: "completed" | "failed" | "denied";
    turn?: number;
  }>;
  policyDenials: Array<{
    tool: string;
    type: "policy" | "invalid_arguments" | "unknown";
    turn?: number;
  }>;
  contextFailures: Array<{
    providerId: string;
    stage: "pre" | "post" | "unknown";
    turn?: number;
  }>;
}
```

允许读取的 RunEvent：

```text
run.started
attempt.started
turn.started
turn.completed
model.usage
context.failed
tool.requested
tool.completed
tool.denied
checkpoint.created
run.completed
run.failed
run.aborted
run.interrupted
```

明确丢弃：

```text
message.delta.delta
reasoning.delta.delta
model.request.payload
tool.requested.arguments
tool.completed.result
run.failed.error 原文
context.failed.error 原文
```

只保留枚举、计数、时间、sequence、合法 identifier 和 usage 数字。

### 4.4 给 policy denial 增加结构化类型

当前两个 `tool.denied` 来源都只写自由文本 `reason`。做一个最小的 additive
RunEvent 变更：

```ts
// 参数校验失败
{
  type: "tool.denied",
  data: {
    denialType: "invalid_arguments",
    turn,
    callId,
    name,
    reason
  }
}

// CapabilityPolicy 拒绝
{
  type: "tool.denied",
  data: {
    denialType: "policy",
    turn,
    callId,
    name,
    reason
  }
}
```

诊断结果只返回 `denialType`，不返回自由文本 `reason`。旧事件没有该字段时映射为
`unknown`。

这比解析错误字符串可靠，也不需要新增事件类型。

涉及文件：

- `packages/runtime/src/agent-engine.ts`
- `src/core/run-ledger.ts`
- 对应 Agent Engine 和 Run Ledger tests

### 4.5 修正 outcome

规则固定为：

```text
completed                           -> success
failed / interrupted               -> failed
aborted + terminalReason=timeout    -> timeout
aborted + other reason              -> cancelled
其他                                -> unknown
```

RunStore 仍是唯一权威来源。Trace status 只用于：

- 发现 Run/Trace 状态不一致；
- 标记具体观测阶段失败；
- 提供低基数 `error.type`。

### 4.6 不伪造 `expired`

当前 Backend 不提供可供 Gateway 判断的 retention 边界，因此本轮不返回
`expired`。

为避免破坏已部署的 schema，保留 `availability="not-found"`，新增一个可选、
向后兼容的原因字段：

```ts
traceState: {
  reason: "pending-index" | "trace-missing" | "no-correlation";
  retryable: boolean;
}
```

判断规则：

```text
Run active
  -> availability=active

有 sampled traceId，Backend 404，Run 结束不超过 5 秒
  -> availability=not-found
  -> reason=pending-index
  -> retryable=true

有 sampled traceId，Backend 404，Run 已结束超过 5 秒
  -> availability=not-found
  -> reason=trace-missing
  -> retryable=false

没有 correlation
  -> availability=not-found
  -> reason=no-correlation

明确 unsampled
  -> availability=unsampled
```

本轮不在 Gateway 内做自动重试，避免一个诊断 Tool 长时间占用当前 Agent Run。
Workbench/CLI 后续可以按 `retryable` 决定是否重试。

### 4.7 API 默认只返回摘要

修改：

```js
includeStages: includesOption(url, "stages", false)
includeFindings: includesOption(url, "findings", false)
```

Tool 保持默认请求两者，因为它的用途就是让模型解释诊断。

### 4.8 显式报告截断

保持现有最多 20 个 stages、10 个 findings，不引入分页：

```ts
truncated: {
  stages: boolean;
  findings: boolean;
}
counts: {
  stages: number;
  findings: number;
}
```

`counts` 表示截断前数量。Tool 二次压缩时也保留这两个字段。

### 4.9 Backend 缺失时仍注册 Tool

删除 `service.enabled === false` 时不注册 Tool 的分支。只要
`observabilityService` 存在就注册。

这样：

- 无 Backend 时模型仍可读取 Run facts；
- `run-diagnostics` Skill 不会指向不存在的 Tool；
- `telemetry-disabled` 成为真实可消费状态；
- 不需要修改 Skill catalog 的生命周期模型。

这是比“动态隐藏 Skill”更小、更稳定的修复。

### 4.10 `run_id` 改为可选

Tool schema 不再要求 `run_id`。调用者明确传入时保持现有逻辑；省略时由
Observability Service 选择当前 Session 中最近一个已终结、且不是当前诊断 Run 的
Run。

最小实现直接复用 `PostgresRunStore.getSessionMessages(sessionId)`：

```text
session messages 倒序
  -> 去重 runId
  -> 排除 requester.runId
  -> runs.get(runId)
  -> 选择第一个 terminal Run
```

没有 Session 或没有历史 Run 时返回统一的 `no-target`，不猜测其他 Project 的 Run。

### 4.11 增加 `observabilityOverview`

给 RunStore 增加一个最小只读查询：

```ts
listRuns({
  since?: number;
  statuses?: RunStatus[];
  limit?: number;
}): Promise<RunRecord[]>
```

PostgreSQL 使用已有 `status`、`updated_at` 列查询，并增加：

```sql
CREATE INDEX IF NOT EXISTS runtime_runs_status_updated
ON runtime_runs(status, updated_at DESC);
```

Gateway 读取候选记录后，再按调用者的 Project/Session 做可见性过滤。候选查询最多
读取 `min(500, limit * 10)` 条，最终最多返回 50 条。

`observabilityOverview` 输出：

```ts
{
  scope: {
    kind: "project" | "session";
    id: string;
  };
  window: {
    since: number;
    until: number;
  };
  backend: {
    queryAvailable: boolean;
  };
  totals: {
    inspected: number;
    problems: number;
    failed: number;
    timeout: number;
    interrupted: number;
    slow: number;
    stalled: number;
  };
  runs: Array<{
    runId: string;
    status: string;
    durationMs?: number;
    updatedAt: number;
    traceState: "queryable" | "unsampled" | "missing" | "active";
    signals: string[];
  }>;
  truncated: boolean;
}
```

候选判断只使用确定性规则：

```text
status=failed                         -> failed
status=interrupted                    -> interrupted
status=aborted + reason=timeout       -> timeout
terminal duration >= min_duration_ms  -> slow
active 且长期无新事件                 -> stalled
sampled terminal Run 无 correlation   -> trace-missing
```

`slow` 和 `stalled` 必须回传阈值，不能伪装成绝对结论。Overview 不查询每个
Trace，不返回标题、prompt、output、error 文本、Tool 参数或结果。

Tool visibility 由 Gateway 固定为当前 Project；没有 Project 时只能查询当前
Session。调用参数不允许自行扩大 scope。

### 4.12 Tool 输出保持“事实优先”

为避免 Tool、Skill、模型三层重复做自然语言诊断：

- 保留 `findings` 字段名，避免无必要的 schema 破坏；
- finding 只包含稳定 `code`、`severity` 和结构化 `evidence`；
- 删除带因果暗示的 recommendation；
- `summary.headline` 只描述观测事实，例如“最大单个可观测阶段为 chat”；
- 根因判断和修复建议交给调用方模型。

### 4.13 工作包 A 验收

新增或修改测试：

1. Trace 不可用时仍返回 terminal reason、usage、tool summary。
2. executor policy denial 返回 `denialType=policy`。
3. 参数错误返回 `denialType=invalid_arguments`。
4. `aborted + timeout` 返回 `outcome=timeout`。
5. recent backend 404 返回 `pending-index/retryable=true`。
6. old backend 404 返回 `trace-missing/retryable=false`。
7. 不再声称可以判断 `expired`。
8. HTTP 无 `include` 时不返回 stages/findings。
9. Tool 无 Backend 时仍注册并返回 ledger-only diagnosis。
10. 结果中不存在 prompt、reasoning、arguments、result 和原始 error。
11. stage/findings 截断时返回 counts/truncated。
12. 省略 `run_id` 时选择同 Session 最近一个已终结 Run。
13. 不会选择当前诊断 Run、active Run 或其他 Session 的 Run。
14. Tool 输出不包含因果性结论或修复动作。
15. Overview 不需要 Run ID 即可发现当前范围内的问题 Run。
16. Overview 不查询 Jaeger N 次，也不能扩大到其他 Project/Session。
17. Overview 的时间窗、数量和慢/停滞阈值均被限制并回显。
18. Run 数量超过候选上限时显式返回 `truncated=true`。

## 5. 工作包 B：修正模型耗时归因

### 5.1 修改范围

- `packages/runtime/src/openai-compatible-engine.ts`
- `packages/runtime/src/telemetry.ts`
- `apps/runtime/src/telemetry/export-policy.mjs`
- `deploy/otel-collector/config.yaml`
- `apps/runtime/src/observability/run-diagnostic-projector.mjs`
- `packages/runtime/tests/genai-telemetry.test.ts`
- `apps/runtime/tests/telemetry-policy.test.js`
- `apps/runtime/tests/observability-service.test.js`

### 5.2 保留现有 Span，不重构流

`chat` Span 继续表示完整模型调用链 wall time，保持现有父子关系和测试。

只在外层异步生成器的每次 `yield` 周围累计调用方占用时间：

```ts
let consumerWaitMs = 0;

while (true) {
  const item = await context.with(active, () => iterator.next());
  if (item.done) break;
  const yieldedAt = performance.now();
  try {
    yield item.value;
  } finally {
    consumerWaitMs += performance.now() - yieldedAt;
  }
}
```

Span 结束前记录：

```text
zion.model.consumer_wait.duration
```

单位使用秒，与当前 `zion.model.credential.duration` 和 OTel duration 惯例一致。

该数值表示生成器把事件交给调用方后，等待下一次 pull 的累计时间。它主要包含
RunEvent 持久化和调用方 backpressure，但不能进一步断言是哪一个具体组件。

### 5.3 修改诊断文案

stage 增加：

```ts
consumerWaitMs?: number;
activeDurationMs?: number; // max(0, durationMs - consumerWaitMs)
```

规则：

- `durationMs` 继续表示 `chat` wall time；
- `activeDurationMs` 表示扣除可测 consumer wait 后的调用链活动时间；
- 不使用“模型推理耗时”；
- 使用“模型调用链 wall time”或“模型调用链活动时间”；
- 当 consumer wait 超过 `chat.duration` 的 20%，增加
  `model_consumer_backpressure` finding；
- `dominant_stage` 改称“最大单个可观测阶段”，不声称它等于类别总瓶颈。

本轮不计算复杂 critical path，也不按模型/工具类别聚合。

### 5.4 顺手暴露已有安全字段

不新增采集，只把 Trace 中已有且安全的字段投影出来：

```ts
httpStatus?: number;
credentialMs?: number;
toolOk?: boolean;
artifactCount?: number;
changeCount?: number;
```

这样 Agent 至少可以区分：

- HTTP 401/403：认证或授权类问题；
- HTTP 429：限流；
- HTTP 5xx：上游服务错误；
- credential wait 高；
- Tool 返回 `ok=false`；
- Tool 是否产生 artifact/change。

仍不返回 URL、错误正文、headers 或资源内容。

### 5.5 工作包 B 验收

1. 在 fake RunStore 的每次 append 中注入固定延迟。
2. 断言 `chat.duration > activeDurationMs`。
3. 断言 `consumerWaitMs` 能覆盖注入的调用方等待。
4. 断言慢持久化不会被描述成纯模型耗时。
5. 断言 HTTP 429、500 能进入安全诊断字段。
6. 断言 credential duration、artifact/change count 正常投影。
7. 断言新增字段通过应用侧和 Collector allowlist。
8. 继续执行全量内容泄漏测试。

## 6. 工作包 C：固化部署和单机持久化

### 6.1 先形成可复现提交

在继续部署前，把当前未提交的 observability 改动按边界拆成三个 commit：

```text
1. feat(runtime): add bounded otel instrumentation
2. feat(observability): add run diagnostics gateway and plugin
3. ops(observability): add collector, jaeger and protected access
```

不要把编辑器滚动、会话修复和其他 debug artifacts 混入这些 commit。

发布产物记录：

```text
git commit SHA
source archive SHA-256
workbench dist SHA-256
Collector image digest
Jaeger image digest
effective runtime.env key names，不记录 secret values
```

### 6.2 Caddy 路由进入正式生成器

给 `scripts/configure-runtime-deployment.mjs` 增加一个窄参数：

```text
--observability-port <port>
```

未提供时维持原行为。提供时为每个远程 site 生成：

```caddyfile
@observabilityMcp path /observability/api/ai/mcp/*
respond @observabilityMcp 404

@observabilityOtlp path /observability/api/otlp/*
respond @observabilityOtlp 404

redir /observability /observability/ 308

handle_path /observability/* {
  forward_auth 127.0.0.1:8766 {
    uri /v1/access/authorize/observability
  }
  reverse_proxy 127.0.0.1:16686 {
    header_up -Cookie
    header_up -Authorization
  }
}

handle {
  reverse_proxy 127.0.0.1:8766
}
```

保持 `vite.config.ts` 已有 `/observability` navigation denylist。

测试：

- 无参数时生成结果与旧行为兼容；
- 有参数时存在 forward auth；
- 明确阻断 MCP 和 OTLP path；
- 转发 Jaeger 前删除 Cookie/Authorization；
- 普通 Runtime route 仍走 8766；
- `caddy validate` 在部署前执行。

### 6.3 单机 Jaeger 采用 Badger，不引入外部集群

当前用户量和部署规模不需要 Elasticsearch、Kafka 或 Tempo 集群。最小方案是
Jaeger all-in-one + Badger：

- 增加一个受版本控制的 `deploy/otel-collector/jaeger.yaml`；
- 配置 `ephemeral: false`；
- 使用一个 Docker named volume；
- 初始 trace TTL 设为 7 天；
- 不配置 archive storage；
- 不要求备份 Trace，RunStore 仍是权威事实；
- 删除生产 pipeline 的 debug exporter。

官方 Jaeger v2.20 明确支持单机 all-in-one + Badger，并说明它适合无法水平扩展的
中小规模场景：

- [Jaeger v2.20 Badger](https://www.jaegertracing.io/docs/2.20/storage/badger/)

这满足当前单用户需求，也避免为了“生产”直接引入外部数据库。

### 6.4 采样策略

P0 不引入 tail sampling。

当前单用户环境需要按 Run 自助诊断，100% sampling 有明确产品价值，因此不应在
没有代表性基准时机械降到 10%。本轮只做：

1. 在部署配置中显式设置采样率；
2. 将环境标记为 `single-user-pilot`；
3. 用真实 PostgreSQL、两次模型调用和一次 Tool 调用跑 30 次；
4. 同时比较 SDK disabled、Collector healthy、Collector unavailable；
5. 如果绝对额外 p95 小于 20 ms 且 event-loop lag/RSS 可接受，可暂时保留 100%；
6. 未通过则降采样，但明确 Agent 诊断可用率会同步下降。

不要用当前 2～3 ms 的纯内存 synthetic Run 的百分比作为唯一上线门禁。

### 6.5 P0 暂不增加完整 pipeline health

完整 exporter/Collector/backend 分层健康属于 P1。本轮只修正文案和字段名：

```text
queryBackend.available
```

不要再用笼统的：

```text
observability.available
```

运维文档明确 `/v1/observability/status` 只检测 Jaeger Query API，不证明 Collector
接收和 exporter 投递健康。

### 6.6 工作包 C 验收

1. 从 clean checkout 可以 build 并运行全部 OTel tests。
2. `deploy:configure` 生成完整 observability Caddy route。
3. 未认证访问 `/observability/` 返回 401。
4. Client credential 不能进入 Jaeger UI。
5. Owner credential 可以进入 Jaeger UI。
6. `/observability/api/ai/mcp/*` 和 `/observability/api/otlp/*` 返回 404。
7. 公网端口不暴露 4318、16686。
8. 重启 Jaeger 后 smoke Trace 仍存在。
9. 超过 7 天的数据按 TTL 清理。
10. Runtime、Collector 或 Jaeger 任一不可用时，RunStore 写入和 Run 完成不受影响。

## 7. 提交顺序

### Commit 0：冻结当前基线

只提交已经验证的 OTel 首批实现及其文档，不夹带其他未完成改动。

目的：

- 让线上状态可重建；
- 为后续每个修复提供可回滚基线；
- 避免继续从 `.deploy-tmp` 发布不可追踪快照。

### Commit 1：诊断事实与状态

包含工作包 A。

回滚风险低：不修改 PostgreSQL 业务字段或数据；唯一 DDL 是可删除的 Run 查询索引，
不影响 Run 执行。

### Commit 2：模型调用链耗时

包含工作包 B。

独立提交便于做 A/B benchmark。如果性能或语义不符合预期，可单独回滚该属性，
不影响诊断 facts。

### Commit 3：部署固化

包含工作包 C。

先在本机或临时端口验证，再更新 ECS。Badger volume 和 Caddy 配置必须在切换前
备份；Runtime OTel 可随时通过 `OTEL_SDK_DISABLED=1` 停用。

## 8. 文件级修改清单

| 文件 | 最小修改 |
|---|---|
| `packages/runtime/src/agent-engine.ts` | 增加 `denialType` |
| `packages/runtime/src/protocol.ts` | 增加有界 `listRuns` 查询契约 |
| `packages/runtime/src/memory-run-store.ts` | 实现测试/嵌入场景的 `listRuns` |
| `packages/runtime/src/openai-compatible-engine.ts` | 累计 consumer wait |
| `packages/runtime/src/telemetry.ts` | 定义 consumer wait attribute |
| `apps/runtime/src/postgres-run-store.mjs` | 实现 `listRuns` 和查询索引 |
| `apps/runtime/src/telemetry/export-policy.mjs` | allowlist 新数值字段 |
| `apps/runtime/src/observability/observability-service.mjs` | 读取 events；最近 Run 解析；Overview；traceState |
| `apps/runtime/src/observability/run-diagnostic-projector.mjs` | ledger facts、timeout、截断、准确文案 |
| `apps/runtime/src/observability/observability-http-handler.mjs` | 默认 summary-only |
| `extensions/dev.observability/manifest.json` | 声明 Overview Tool |
| `extensions/dev.observability/runtime.js` | 注册 Overview/Inspect；Inspect 的 `run_id` 可选 |
| `extensions/dev.observability/skills/run-diagnostics/SKILL.md` | 缩短为两种 Tool 的解释护栏 |
| `apps/runtime/src/interaction-profile-store.mjs` | 默认 read-only Profile 加入 Overview |
| `apps/runtime/src/main.mjs` | 升级默认 Toolset version |
| `src/core/run-ledger.ts` | 保留结构化 `denialType` |
| `deploy/otel-collector/config.yaml` | allowlist 新字段；移除生产 debug exporter |
| `deploy/otel-collector/jaeger.yaml` | 单机 Badger + 7 天 TTL |
| `deploy/otel-collector/compose.yaml` | 挂载配置和持久 volume |
| `scripts/configure-runtime-deployment.mjs` | 生成受保护 observability route |
| `tests/deployment-scripts.test.js` | Caddy 配置回归 |
| 现有 telemetry/observability tests | 增加上述验收用例 |

不修改：

- PostgreSQL 业务表及其已有字段；
- `packages/node-protocol`；
- `apps/device-connector`；
- Workbench/Mobile UI；
- Session/Yjs projector；
- RunEvent sequence 和持久化顺序。

## 9. 完成定义

P0 只有在以下条件全部满足时才结束：

- Gateway 的 `source.runLedger=true` 对应真实 RunEvent facts；
- 模型无需预先知道 Run ID，也能发现当前范围内近期问题；
- policy denial、timeout 和 Trace 暂未索引不会被错误解释；
- `chat.duration` 不再被表述为纯模型推理时间；
- Tool 在无 Trace Backend 时仍可给出 ledger-only 结论；
- API 默认响应和文档一致；
- 所有截断均显式可见；
- OTel 内容泄漏测试继续通过；
- 现有 Runtime 相关 466 个源码测试继续通过；
- 真实 smoke 仍形成 4-span Trace；
- Caddy 配置可由仓库脚本重建；
- Jaeger 重启不丢失保留期内 Trace；
- 相关代码和配置已提交，不再依赖 `.deploy-tmp` 作为事实源。

达到这些条件后再进入 P1。P1 才处理 Attempt 历史、完整 pipeline health、查询
限流与缓存重构；P2 再处理 Device、Projection、Metrics 和 Logs。
