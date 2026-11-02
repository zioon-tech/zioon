# Zion Observability Query Handoff

更新时间：2026-09-19

## 1. 当前目标

Zion 的观测能力最终服务于 Agent 自进化，而不只是人工排障。

Observability 的职责严格限定为：

```text
记录事实 -> 脱敏投影 -> 受控查询 -> 必要时读取原始证据
```

它不负责：

- 生成根因假设；
- 判断应该如何修复；
- 修改代码；
- 运行修复流程；
- 替上层模型总结问题。

外部模型读取事实后自行分析，并使用其他通用能力完成后续工作。

当前产品假设是开源后的单实例或独立部署，主要服务十几人的可信团队。
企业级能力不会放弃，但暂时只作为不能破坏的架构护栏，不是当前优化目标。

## 2. 当前实现

### 2.1 数据边界

- 权威原始数据仍位于 `PostgreSQL database`。
- 一个账号 Runtime 数据目录不可变绑定一个 Space。
- 模型不能直接查询主 Runtime PostgreSQL。
- 原始 Prompt、消息、工具参数、工具结果、任意错误文本和凭据不进入长期
  脱敏投影。

### 2.2 独立 PostgreSQL 投影

默认投影已经从 JSONL 切换为：

```text
<runtime-data>/PostgreSQL observability tables
```

公开稳定表：

- `obs_runs`
- `obs_events`
- `obs_stages`

内部表使用 `_obs_` 前缀，不属于模型查询契约。

投影字段由 `projection-records.mjs` 显式白名单构造，不传播任意 Event
payload。主要事实包括：

- Space、Run、Attempt 和事件顺序；
- Run 状态、时间、耗时和稳定终止分类；
- Tool 名称、成功状态、拒绝类型和稳定 failure code；
- Token usage；
- 脱敏后的 Session / Project 关联 hash；
- 可选 Trace stage 时间；
- Trace 证据可用状态。

### 2.3 写入方式

`PostgresRunStore.append()` 提交 Run Event 后发出进程内通知。

`PostgresObservabilityProjection`：

1. 订阅事件通知；
2. 在内存中 debounce；
3. 使用 Ledger 全局 cursor 批量追赶；
4. 每页在一个 PostgreSQL 事务中写入；
5. 没有新事件时不轮询；
6. 重启后从 durable cursor 继续；
7. 定期按保留窗口删除过期行；
8. 使用 PostgreSQL `max_page_count` 限制数据库继续增长。

默认：

- 保留 7 天；
- 最大 256 MiB；
- debounce 250 ms；
- WAL；
- `synchronous=NORMAL`；
- `wal_autocheckpoint=100`。

### 2.4 `observabilityQuery`

模型通过一个通用 Runtime Tool 查询脱敏事实：

```text
observabilityQuery(sql, params, purpose)
```

能力：

- `SELECT`；
- `WITH ... SELECT`；
- 参数绑定；
- WHERE、JOIN、GROUP BY、窗口函数和排序；
- 最多 200 行；
- 最多 128 KiB 输出；
- 默认 3 秒；
- SQL 最长 16 KiB。

执行边界：

- 数据库以 `readOnly` 打开；
- `query_only=ON`；
- 禁止加载扩展；
- 查询在一次性 Worker 中执行；
- Worker 有 V8 内存上限；
- 超时后终止 Worker；
- 禁止多语句、DDL、DML、ATTACH、PRAGMA、内部 schema 和已知的大结果
  构造函数；
- Tool 调用前后都重新验证当前授权。

每次账号查询审计记录：

- 用户；
- actor Run；
- Space；
- SQL hash；
- purpose；
- 耗时；
- 返回行数和字节；
- 是否截断。

审计不记录 SQL 原文和参数。

### 2.5 `observabilityRawRead`

当脱敏表缺少分析所需的具体工具证据时，模型可按：

```text
run_id + event_sequence
```

读取精确的：

- `arguments`
- `result`
- `error`
- 少量相邻 `context`

约束：

- SQL 层验证同 Space；
- 默认 16 KiB 分块，单次最大 32 KiB；
- cursor 续读；
- 字段名与字符串凭据强制脱敏；
- 每次成功读取记录 actor、Skill、目标、字段、字节、hash、purpose 和脱敏
  计数；
- 不创建长期 raw 投影。

### 2.6 Skill

`dev.observability` 不再注册 `observabilityInspect` 或
`observabilityOverview` 这类带判断语义的 Tool。

插件只贡献 `run-diagnostics` Skill。Skill 内容限定为：

- 公开表和字段语义；
- 参数化 SQL 示例；
- coverage、截断和修订行语义；
- 何时以及如何读取精确原始证据；
- 数据来源和证据缺失状态。

Skill 不提供固定根因规则、结论或修复工作流。

### 2.7 旧 JSONL 路径

以下实现仍暂时保留为源码和测试回滚资产：

- Docker Analysis Executor
- `obs.mjs`

默认 Runtime 不再：

- 启动 JSONL 投影；
- 创建 `/observability` 虚拟文件；
- 为查询复制 64 MiB 快照；
- 暴露 JSONL Bash 工作区；
- 依赖 Docker 或 ripgrep 完成模型观测查询。

因此新查询结果是普通 Tool JSON，不再伪装为可打开文件，也不会触发
Inspector 的 `File handle unavailable` 路径。

### 2.8 实时 delta 与永久 Ledger 分离

`message.delta` 和 `reasoning.delta` 不再写入 `runtime_run_events`。

当前链路：

```text
模型原始 delta
├─ RunHandle 内存事件流
├─ 40 ms debounce -> 协作文档 / Workbench
└─ 50 ms 或 256 字符 -> RunLiveHub -> SSE 客户端

语义事件 -> runtime_run_events
完整内容 -> transcript / message.completed / run.output
```

`RunLiveHub`：

- 每个活跃 Run 独立；
- delta 最多每 50 ms 或达到 256 字符时输出一个 live chunk；
- 默认最多保留 8 MiB 内存 replay；
- 多个 SSE 客户端可同时订阅；
- 重连按最后收到的 sequence 补缺失 chunk；
- 重连积压按阶段压成大块立即补齐，不模拟历史打字速度；
- Run 结束后保留 30 秒宽限期，覆盖快速 Run 的首次订阅和短线重连；
- 宽限期后全部释放，不写磁盘。

永久事件 sequence 允许因 transient delta 形成空洞，但仍必须严格单调递增。
Run 恢复继续使用 checkpoint，不依赖 delta。

Runtime 数据库包含一次性迁移：

- 删除历史 `message.delta` 和 `reasoning.delta`；
- 保留所有语义事件、transcript、checkpoint 和最终输出；
- 释放页先由 PostgreSQL 后续复用；
- 不在生产启动时自动 `VACUUM`，避免大库阻塞和双倍磁盘峰值。

## 3. 权限语义

账号模式下每次观测 Tool 调用必须同时满足：

```text
活跃 Membership
∩ 当前角色的 observability.read
∩ 活跃 RunGrant
∩ 当前 Interaction Profile
∩ allowedTools
```

当前 Owner、Admin 和 Member 可以执行 Run 并读取同一 Space 的观测事实。
Viewer 具有读取 scope，但不能发起模型 Run。

当前不实现：

- 单条 SQL 跨 Space；
- 平台管理员默认读取客户 Space；
- 多 Space fan-out；
- 合规级 break-glass 流程。

这些属于企业级阶段。

## 4. 性能和成本边界

本地样本：

- 主 Runtime PostgreSQL：约 50 MiB；
- Run Event：66,596 条；
- 原 JSONL 脱敏投影：约 104 KiB；
- 绝大部分 Event 是 reasoning/message delta，不进入观测投影。

因此当前观测查询层的主要问题已经从：

- 固定 2 秒轮询；
- manifest / directory fsync；
- 每次查询复制快照；
- JSONL 扫描；

收敛为：

- 事件触发的批量 PostgreSQL 写；
- 独立只读 Worker 查询；
- 小型白名单数据集。

主 Ledger 的逐 delta 成本已经移除。尚未解决的主要成本包括：

- 完整 `model.request` 重复保存消息和 Tool Schema；
- checkpoint、transcript 和 Ledger 缺少明确保留策略。

这些应由 Runtime Ledger roadmap 处理，不应塞进 Observability 插件。

## 5. 当前验证

已覆盖：

- 白名单投影不包含 Prompt、工具参数、结果和秘密字段；
- PostgreSQL 查询支持筛选、排序和聚合；
- DML、DDL、PRAGMA、内部 schema 和多语句拒绝；
- 行数、字节和超时上限；
- 超时 Worker 可终止，后续查询正常；
- 事件通知 + debounce；
- durable cursor 重启续传且不重复；
- Space grant 动态重验；
- 查询审计；
- Raw Read 的 Space 隔离、脱敏、分块和审计；
- 无隔离执行器时不暴露旧 JSONL 文件工作区；
- 插件只贡献 Skill，不注册诊断结论 Tool。
- delta 不进入永久 Run Ledger；
- 实时流按 40～50 ms 更新；
- 活跃 Run 内存 replay 支持 sequence 重连；
- 重连积压按阶段快速补齐；
- 历史 delta 一次性清理且迁移幂等；
- 永久语义事件允许 sequence 空洞并拒绝回退。

本地真实数据验证：

- 迁移前 `runtime_run_events`：77,806 行，其中 delta 77,264 行；
- 迁移后：542 行，delta 为 0；
- 本地离线 `VACUUM` 后主库从 58 MiB 降至 27 MiB；
- 真实模型 Run 的 SSE 收到 7 个合并 live delta；
- 同一 Run 永久 Ledger 只写入 9 个语义事件，delta 为 0；
- 最终回答、transcript 和观测投影均正常。

## 6. Roadmap

### Phase 1：验证模型能否使用事实

当前最高优先级。

1. 用真实失败 Run 验证模型能否自行写出有效 SQL。
2. 验证模型是否能正确理解 revision、coverage 和 trace 缺失。
3. 验证模型是否只在必要时调用 Raw Read。
4. 收集失败案例，调整 schema、字段名和 Skill 说明。
5. 根据真实使用结果决定是否需要 CLI/Python 辅助查询。

验收不是“插件能输出诊断报告”，而是：

> 外部模型能使用该插件提供的事实，自行完成有效分析。

### Phase 2：小团队稳定性

1. 对真实数据量测试查询延迟、WAL 和磁盘增长。
2. 完善 retention 与 quota 的边界测试。
3. 给 Query Result / Raw Evidence 增加更清晰的 UI 展示。
4. 为 projection schema 增加显式版本迁移。
5. 处理损坏数据库的自动重建。
6. 决定何时删除旧 JSONL 回滚代码。

### Phase 3：Runtime Ledger 成本

独立于 Observability 插件推进：

1. ~~delta 聚合或短期化~~：已改为纯内存 live replay。
2. ~~语义事件与实时流分离~~：已完成。
3. model request payload 保留策略；
4. checkpoint 压缩；
5. Ledger、receipt 和 raw evidence 的生命周期策略。

### Phase 4：Skill / Capability 扩展

插件数量增长后再推进：

1. Skill 的 installed / allowed / activated 状态；
2. Top-K Skill 检索；
3. 少量固定 Runtime Capability 入口；
4. CLI/Python 只通过 Runtime Broker 获取能力；
5. 短期、Run 绑定、可撤销的 capability lease；
6. 第三方 Plugin Host 隔离。

### Phase 5：企业级补强

自观测使用效果得到验证后再实现：

- 细粒度 RBAC；
- 多 Space fan-out；
- 平台运维聚合与 break-glass；
- 高可用调度；
- 冷热分层和对象存储；
- 合规审计和 SIEM；
- 插件市场权限审核；
- 第三方插件进程隔离。

## 7. 下一步

不要继续预设更多诊断 Tool。

下一步应启动真实 Runtime，制造或选择一组已有失败 Run，让模型只依赖：

- `run-diagnostics` Skill；
- `observabilityQuery`；
- `observabilityRawRead`；

完成分析。根据模型实际遇到的字段缺失、SQL 使用困难和证据不足，再调整
schema 与 Skill。
