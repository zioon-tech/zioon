# Workbench CodeMirror 对话投影评审

日期：2026-09-15
范围：`feature/core-observability` 当前 HEAD `0544c944` 及未提交改动
状态：核心重构已实现并完成本地端到端验证

## 1. 结论

CodeMirror 对话的核心价值不是“在编辑器里显示聊天”，而是“会话本身就是一份可编辑文档”：

- 用户可以在任意历史位置编辑、选中、继续运行。
- 光标决定本次模型上下文边界。
- 思考、正文、工具调用在同一文档时间线上交错出现。
- marker 提供稳定身份，CodeMirror decoration 只负责富展示。
- 文档的可见顺序同时决定阅读顺序和下一次请求的语义顺序。

当前 Runtime 迁移破坏了最后一条：正文由 Runtime 写入，thinking/tool marker 仍由 Workbench 写入，两条异步链没有共同提交边界。最新改动减少了正文双写，但没有形成真正的单投影器，反而增加了 `documentWriter`、`documentTextWriter`、`textOwner`、pending decoration、writer lease、owner/observer 等隐式协调状态。

现在至少存在三类问题：

1. 已发生的历史正文丢失：数据库 revision 能证明非空文档被 collaboration 写成空。
2. 当前仍可触发的打开空白：协作同步超时后，Workbench 既不接管 snapshot，也不完成 Yjs hydration。
3. 当前流式顺序仍不可靠：Runtime 写正文，Workbench 写 marker，`message -> tool` 可以在 Yjs 中落成 `tool -> message`。

因此不建议继续在现有链路上补锚点和布尔开关。应保留 Runtime 作为执行事实源，但增加一个唯一的 Conversation Document Projector，统一把有序 Run 事件投影到 Yjs 文档。

## 2. 原始产品模型

### 2.1 文档是会话本体

`src/chat/doc.ts` 把纯文本解析为 role message，并在光标之后插入 assistant block。这个模型与普通聊天产品不同：

- 上下文不是固定消息列表，而是“当前光标之前的文档快照”。
- 用户可以改写历史，不必复制到新线程。
- 可以在文档中间继续对话，后续旧内容通过 continuation boundary 隔离。

相关实现：

- `src/chat/doc.ts:254-304`：从文档解析消息。
- `src/chat/doc.ts:306-367`：按光标插入带稳定 ID 的 assistant block。
- `extensions/dev.langchain-chat/main.js:2073-2154`：从光标前文档编译 Runtime 请求。

### 2.2 marker 是结构，widget 是视图

思考和工具调用在文档中留下轻量 marker：

```text
assistant <!-- zion-assistant:id=run-1 --> 正文 A
思考 <!-- zion-thinking:id=thinking:run-1:1 -->
调用 read <!-- zion-tool:id=tool:run-1:call-1 -->
正文 B
```

CodeMirror decoration 把 marker 渲染为卡片。marker 的位置表达事件顺序；annotation 保存卡片 payload、展开状态和工具结果。`from/to` 只是缓存，稳定身份来自 marker ID。

`src/chat/widget-history.ts` 再按 marker 位置把文档还原为模型可接受的 assistant/reasoning/tool 消息序列。这说明 marker 不是装饰细节，而是会话语义的一部分。

### 2.3 原始不变量

1. 文档可独立阅读、编辑和导出。
2. 可见顺序等于语义顺序。
3. 光标是上下文边界。
4. marker ID 是身份，字符坐标不是身份。
5. 前台和后台运行最终生成同一种文档结构。
6. 流式临时状态可以丢，durable 文档不能丢。

## 3. 当前实现

### 3.1 提交

`extensions/dev.langchain-chat/main.js`：

1. 读取 CodeMirror 光标前内容。
2. `parseMessages` 解析 role 文本。
3. `reconstructWidgetHistoryMessages` 把 marker + annotations 重新编译为 reasoning/tool 历史。
4. 创建 Yjs relative anchor。
5. 向 Runtime 创建 Run，并声明 `documentProjection.textOwner = "runtime"`。

### 3.2 正文

`apps/runtime/src/server.mjs` 独立消费 Run events，并调用 `collaboration-service.applyRunEvent`。

`apps/runtime/src/collaboration-service.mjs`：

- 收集 `message.delta`。
- 到 `message.completed` 或 terminal event 时才 flush。
- 通过 `session-document-projector.js` 写入 Y.Text。
- 在 Y.Map `runs` 中记录 `lastSequence`、`textOwner` 和 `committedOutputLength`。

Workbench 对同一 `message.delta` 不再写正文：

- `documentWriter: true`
- `documentTextWriter: false`
- `appendAssistantToken: async () => true`

它只通过 pending CodeMirror decoration 即时显示尚未同步到 Yjs 的文本。

### 3.3 思考和工具

Runtime 发出 `reasoning.*`、`tool.*` 事件，但不把对应 marker 写入 Yjs。

Workbench 的 `projectRunEventToSession` 把这些事件翻译成旧的 `chat/reasoning*` 和 `chat/tool*` 事件。随后：

- `src/chat/annotations.ts` 更新卡片 payload。
- live editor plugin 或 `extensions/dev.session-manager/main.js` 写 marker。
- `writerLeases` 决定前台 editor 还是 background transformDoc 写入。

因此当前不是“Runtime 统一写文档”，而是：

```text
Runtime -> assistant 正文
Workbench -> thinking/tool marker
Workbench -> card annotations
Workbench -> pending 正文 decoration
```

### 3.4 打开与恢复

会话正文同时存在两份：

- `runtime_workbench_documents.text`：普通 session snapshot。
- `runtime_collaboration_documents.state_blob`：Yjs state。

Runtime `onLoadDocument` 用 `updatedAt` 比较决定返回哪一份。Workbench 新建空 editor slot 后，collaboration decorator 会立刻设置 `zionCollaborationBound=true`；之后普通 `session-load` 会被 `SessionDocumentRuntime` 和 `EditorCore.setValue` 拒绝，只允许 collaboration hydration 改正文。

这使“谁拥有文档”在连接完成前就被宣布，而不是在权威状态完成 hydration 后才切换。

## 4. 已确认问题

### 4.1 历史数据已被清空

当前 `.runtime-data/runtime.sqlite3` 中：

- `u1gfl7`（“界面科学”）revision 8 有 3,184 字符。
- revision 9 的 reason 为 `collaboration`，正文变为 0。
- 当前 session snapshot 与 Yjs state 均为 0。
- 浏览器实际打开该会话，editor、state cache、Yjs 都是 0。

`icsn4v` 也有相同轨迹：revision 540 为 3 字符，revision 541 被 collaboration 清为 0。

当前库 861 个 Workbench 文档中有 427 个为空；其中能从 revision history 明确证明“曾非空、后变空”的有 2 个。多数旧会话没有 canonical Runtime messages，不能依靠 transcript reconcile 恢复。

### 4.2 打开会话仍有空白路径

`collaboration-client.js:453-471` 在 5 秒超时后只恢复可编辑状态：

- 不清除 `zionCollaborationBound`。
- 不应用已经加载的 SQLite snapshot。
- provider 后续成功也因 `timedOut` 直接退出。

而 `src/session/document-runtime.ts:70-75` 和 `src/editor/EditorCore.ts:578-604` 会因为 ownership 标记拒绝 `session-load`。因此 Runtime 暂时不可达时，一个有正文的新 slot 可以永久保持空白，直到销毁重建。

### 4.3 正文与卡片顺序仍可能反转

Workbench 依 Run event 顺序插入 thinking/tool marker，Runtime 在另一条异步链写正文。两条链没有 sequence barrier。

真实 Run `run_mu2lvtfy_nfuilvoq` 中，正文 delta 的 source sequence 先于 tool request，但最终文档尾部出现了正文尾字符落在 tool marker 后面的情况。根因不是锚点算法不够复杂，而是两个 writer 对同一有序事件流独立提交。

### 4.4 增量正文算法不满足终态语义

最新改动用 `committedOutputLength` 对终态 `output` 做 `slice(previousOutputLength)`。这只在“新 output 严格以前一版 output 为前缀”时成立。

工具轮中，已提交的当前 turn 文本可能是 `final answer`，终态聚合 output 却是 `intermediate textfinal answer`。直接按旧长度切片会得到错误后缀，并造成重复或截断。

### 4.5 reconcile 会被陈旧元数据禁用

只要 Y.Map 中存在 `textOwner=runtime` 和整数 `committedOutputLength`，reconcile 就无条件跳过该 run。若 Y.Text 被 replace、清空或截断，但 runs map 仍保留，canonical assistant message 也无法修复正文。

### 4.6 pending 清除不是可靠 ack

Workbench 用 `assistantBlock.includes(pendingText)` 判断 Runtime 是否已经提交。短 token、标点或重复文本很容易命中旧正文，导致 pending decoration 提前消失。正确的确认条件应是 projection sequence/offset，而不是字符串包含关系。

## 5. 结构性原因

### 5.1 两个事实源

Yjs state 和 session snapshot 都能反向覆盖对方，仲裁依据是墙上时钟。时间戳不能表达因果，也不能证明内容完整。

### 5.2 两个 durable writer

Runtime 写正文，Workbench 写卡片 marker。两者来自同一 event stream，却没有同一事务和 happens-before 关系。

### 5.3 一个布尔值承担多个语义

`documentWriter` 同时影响：

- 是否写正文。
- 是否写 marker。
- 是否持久化 annotation。
- observer 是否只展示。

新增 `documentTextWriter` 只是继续拆布尔值，没有形成明确 capability。

### 5.4 transient 与 durable 混在同一投影函数

`projectRunEventToSession` 同时负责：

- 状态机。
- CodeMirror 临时输出。
- durable marker。
- annotations。
- usage/inspector。
- owner/observer replay。

这使任何事件顺序优化都可能影响存储、恢复和 UI。

## 6. 建议架构

### 6.1 Runtime Run Engine

只负责执行并产生不可变、有序、可重放的领域事件：

```text
run.started
reasoning.started/delta/completed
message.delta/completed
tool.requested/completed
run.completed/failed/aborted
```

它不感知 CodeMirror、panel、decoration、展开状态。

### 6.2 Conversation Document Aggregate

每个 session 一个串行 aggregate，唯一负责 durable Run 投影：

- 接收按 sequence 排序的 Run event。
- 在一个 Yjs transaction 中写正文、marker、card payload 和 projected sequence。
- 用户编辑仍通过 Yjs 协作进入同一 aggregate。
- 对每个 `(sessionId, runId, eventId)` 幂等。

建议 Y.Doc 结构：

```text
Y.Text("content")       // user/assistant 文本和稳定 marker
Y.Map("cards")         // cardId -> payload/status
Y.Map("runProjection") // runId -> lastEventSequence/output checkpoint
```

marker 与 payload 同事务提交，避免“有 marker 无数据”或“有数据无 marker”。

### 6.3 Workbench Conversation View

只负责：

- 把 Y.Text 绑定到 CodeMirror。
- 根据 marker + `Y.Map("cards")` 渲染 decoration。
- 维护展开状态、选区、滚动等纯 UI 状态。
- 在 durable projection 尚未确认时显示 transient pending layer。

Workbench 不再为 Runtime Run 写正文或 marker。

### 6.4 Prompt Compiler

纯函数：

```text
document snapshot + card payload snapshot + cursor boundary + model capabilities
  -> model messages
```

主编辑器、评论、Browser fallback、Runtime 都复用同一编译器。这样“用户看到的内容”和“模型收到的历史”才不会漂移。

### 6.5 Snapshot Store

`runtime_workbench_documents.text` 应是 Yjs 的派生 checkpoint，而不是第二个可反向覆盖 Yjs 的权威源：

- Yjs state 存在时永远以 state/version 为准。
- 仅在该 session 从未创建 Yjs state 时，从 snapshot bootstrap 一次。
- 禁止用 `updatedAt` 双向仲裁。
- 空内容覆盖非空内容必须携带明确用户删除意图或匹配 expected revision。
- 保留可操作的 revision restore。

## 7. 建议实施顺序

### Phase 0：先止损和恢复

1. 备份 `.runtime-data/runtime.sqlite3`。
2. 禁止无明确 delete intent 的 non-empty -> empty collaboration checkpoint。
3. collaboration 超时时撤销 ownership，并显示 SQLite snapshot。
4. 提供 revision 恢复工具，先恢复已确认损坏的 `u1gfl7`；`icsn4v` 需确认 3 字符是否用户主动删除。

### Phase 1：统一 Run 投影

1. Runtime projector 处理全部 message/reasoning/tool 边界。
2. 将 marker 和 card payload 放入同一 Yjs transaction。
3. Workbench 删除 Runtime Run 的 marker 写入和 writer lease 分支。
4. pending layer 使用 `lastProjectedSequence` 清除，不做字符串匹配。

### Phase 2：收敛协议

1. 删除 `documentWriter/documentTextWriter/textOwner` 布尔组合。
2. 明确 `projectionOwner` 和 `projectionAckSequence` 协议。
3. owner/recovery 都使用同一幂等 projector，不再在 `main.js` 维护排他 Map。
4. 移除临时 debug fetch，改为结构化可开关 tracing。

### Phase 3：回归矩阵

必须覆盖：

- reasoning -> text -> tool -> text 的实时与刷新后顺序一致。
- 工具轮没有 `message.completed` 时仍能在 tool marker 前提交正文。
- Runtime/Workbench 任一方延迟或断连。
- 在光标中间发起 Run，后续旧文本不被移动或覆盖。
- 多 panel 同 session。
- owner 与 observer 同时发现 Run。
- non-empty 文档不能被无意写空。
- revision restore 后 Yjs metadata 不阻止正文修复。

## 8. 取舍

如果继续保留“Runtime 写正文、Workbench 写 marker”，短期可以增加 flush barrier 和 ack，但它仍需要跨进程协调，长期会反复出现顺序问题。

更稳妥的边界是：

> Runtime 拥有执行事实；Conversation Document Aggregate 拥有会话事实；Workbench 只拥有交互和展示。Run 产生的所有 durable 内容只能经过一个 projector。

这保留了 CodeMirror 对话最有价值的部分，也让移动端、后台任务和多端协作共享同一份可验证结果。

## 9. 已落地实现

### 9.1 单一 durable projector

`dev.session-manager.chat-document` 现在统一消费有序 Runtime 事件，并在一次 Yjs transaction 中更新：

- `Y.Text("content")`：assistant 正文及 thinking/tool marker。
- `Y.Map("cards")`：思考与工具卡片 payload。
- `Y.Map("runProjection")`：每个 Run 的 `lastSequence`、状态和投影进度。

Runtime 不再只写正文，Workbench 也不再为 Runtime Run 写 durable marker。`reasoning -> text -> tool -> text` 的可见顺序由同一事件序列、同一投影器和同一文档事务决定。

### 9.2 协作协议与恢复

- collaboration protocol 从 5 升级到 6，旧页面必须刷新后重连。
- `reasoning.delta` 与 `message.delta` 可短暂批处理；边界事件会立即 flush，保证工具 marker 不会越过前一段正文。
- collaboration state 为空但 session snapshot 非空时，禁止空 state 覆盖 snapshot，并从 snapshot 重新 bootstrap Yjs。
- Workbench 只有在远端 hydration 成功后才取得 collaboration ownership；超时会撤销 ownership 并保留已加载 snapshot。
- 卡片 payload 直接从 `Y.Map("cards")` hydration，刷新不依赖本地旧 annotation。

### 9.3 Workbench 视图职责

Workbench 现在只负责 Yjs/CodeMirror 绑定、marker decoration 和 transient pending：

- pending 以 `runProjection.lastSequence` 为确认条件，不再用正文 substring 猜测提交完成。
- owner/observer、writer lease、`textOwner`、`documentTextWriter` 等双写协调分支已移除。
- Runtime Run 使用 `documentWriter: false` 投影旧事件 API，仅保留状态、inspector 和 UI 事件兼容层。

### 9.4 已验证不变量

自动化覆盖：

- 空白会话 hydration 与连接超时 fallback。
- 非空 snapshot 不被较新的空 Yjs state 覆盖。
- reasoning、正文、工具和后续正文严格按 sequence 投影。
- 工具轮中间正文不被 terminal aggregate 覆盖。
- stale run metadata 不阻止 transcript reconcile。
- pending 仅在对应 projected sequence 被确认后消失。

隔离浏览器夹具使用真实 Runtime HTTP、Hocuspocus、Yjs 和 CodeMirror，确定性产生：

```text
思考 -> 第一段正文 -> read 工具 -> 最终正文
```

实测字符位置依次为 112、166、214、271；刷新前后文本长度均为 301，两类卡片 DOM 各 1 个，pending 为 0。截图：

`/.dbg/workbench-conversation-projector-v6.png`

### 9.5 历史数据修复

恢复前已创建会话级 SQLite 备份：

`/.runtime-data/backups/workbench-sessions-u1gfl7-icsn4v-before-restore-20260915.sqlite3`

- `u1gfl7`：从最后一个非空 revision 8 恢复 3,184 字，生成 revision 15。
- `icsn4v`：从最后一个非空 revision 540 恢复 3 字，生成 revision 546。
- 两个会话均已重新 bootstrap collaboration state；snapshot 与 Yjs 正文逐字相等，state hash 校验通过。
