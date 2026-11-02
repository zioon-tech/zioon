# Zion Next 线上使用记录分析

只读分析，未修改线上配置、删除数据或发起新的模型任务。采样截至 2026-10-16 01:04 左右（北京时间）；Run 窗口约为此前7天，模型请求体抽样取最近24小时的100条。统计包含实际使用、历史排查和验证任务，不能直接作为纯用户成功率。

## 使用与稳定性

按 Run 创建时间去重，共223条：

| 来源 | 完成 | 失败 | 中止 | 中断 | 合计 |
|---|---:|---:|---:|---:|---:|
| interactive-chat | 127 | 15 | 26 | 1 | 169 |
| scheduler-worker | 46 | 3 | 0 | 0 | 49 |
| session-message | 3 | 0 | 0 | 0 | 3 |
| agent-task | 0 | 1 | 0 | 0 | 1 |
| runtime-cli | 1 | 0 | 0 | 0 | 1 |

交互失败15/169约8.9%，但集中在10月12—14日；10月15日48条完成、10条中止，无失败。26条中止中19条原因是`user`，7条是`cancelled-during-preparation`，不能把全部中止算作系统故障。另有1条`runtime-restart`中断。

当前快照：Runtime/身份服务/Caddy active，Runtime自10月14日01:13启动以来自动重启计数0；主机负载约0.1，MemAvailable约924MiB/1870MiB。Swap已占约711MiB，但不能据此认定当前内存不足。磁盘40G、使用93%、可用2.7G，是更明确的容量问题。

## 等待发生在哪

GLM-5.3占155/169条交互Run。

| 指标 | 样本数 | 中位数 | P95 |
|---|---:|---:|---:|
| 服务端Run创建到首个model.request | 155 | 257ms | 2955ms |
| 服务端Run创建到首段思考 | 123 | 6546ms | 21094ms |
| 服务端Run创建到首段正文 | 117 | 35332ms | 167556ms |
| GLM完成Run总耗时 | 124 | 164383ms | 970558ms |
| 每个GLM Run模型请求数 | 155 | 5 | 29 |
| 每个GLM Run工具调用数 | 155 | 6 | 30 |

首段正文可能发生在若干工具轮次之后；整轮耗时包含模型、工具和多轮推理，不能称为单次模型延迟。以上不包含用户点击到POST之前的客户端耗时，也不是完整的前端体感时间。

最近24小时100条模型请求体抽样：

- 序列化请求体中位195029字节，P95为555620字节，最大815173字节。
- messages中位30条，P95为64条；tools中位17个，P95为34个。
- system内容中位11474字符。
- 51条显式`reasoning_effort=max`，49条没有该字段。未做同任务对照，不能直接证明max造成全部延迟。

建议优先用同类任务比较低/高思考强度，并按任务减少注入工具和无关历史。保留用户显式选择的高强度；只给轻量任务合理默认值。长工具轮次期间显示“正在执行什么”和阶段耗时，降低只有思考卡片、长时间没有正文的困惑。

## 故障与建议

### 1. 磁盘容量：最高优先级

主要目录：`/var`约23.6GiB，`/usr`约5GiB，`/opt`约2.7GiB。其中`/var/lib/zion-next`约13.4GiB、PostgreSQL目录约6.5GiB、journald约1.9GiB，ADC releases约1.8GiB。

`/var/lib/zion-next/runtime.sqlite3`单文件13633560576字节，约12.7GiB，修改时间停留在迁移期，检查时没有进程打开它。生产Runtime使用PostgreSQL。

建议核验SQLite→PostgreSQL迁移完整性、归档备份和回滚需求后，将旧SQLite移出线上系统盘。不能仅凭“无打开句柄”直接删除。随后给发布备份、journald和原始Run事件设置明确保留策略。

当前PostgreSQL较大关系：

| 表 | 含索引/TOAST的大小 |
|---|---:|
| runtime_run_events | 约2.59GiB，约395万行 |
| runtime_run_checkpoints | 约1.11GiB，7360行 |
| runtime_invocation_receipts | 约1.03GiB |
| runtime_scheduler_runs | 约471MiB |
| runtime_workbench_session_revisions | 约315MiB |

原始事件和checkpoint保留到9月初；模型请求明细有2000行/256MiB等上限，但这些上限不覆盖所有大表。`PostgresRunStore.runStorageMaintenanceBatch`目前直接返回complete，不能作为原始Run数据已有定期清理的证明。引入保留/归档时必须保留活动Run恢复点、必要修订和防重复执行的receipt语义；不能清空receipt来省空间。普通DELETE通常也不会直接把关系文件空间归还系统盘。

### 2. 工具目标解析与终端恢复

交互工具调用1375次，其中198次`ok=false`，含业务命令失败、取消和保护性拒绝，并非198次平台宕机。Bash852次中129次失败；read76次中22次失败；webSearch63次中19次失败。

所有来源合计的代表性错误：

- “Ambiguous Node/resource target”：webSearch23次、Bash8次、edit4次、write2次。
- “Stale terminal reference”：两类返回合计12次。
- `node:cloud-runtime`离线：read17次、Bash4次、tree2次。
- “Command too long”：20次。
- 22次Bash超时提示子进程终止未确认。

建议会话/项目优先绑定明确Node和resource；进入模型上下文前只提供可用目标。终端实例变化后刷新inventory，对明确“未dispatch”的请求可重新解析后重试；对可能已执行或终止未确认的命令，必须查receipt/效果，不能自动重复执行。长命令可转为文件/脚本传输，避免模型反复拆分重试。

### 3. 模型能力检查与可用性

交互15次失败可归为：

- DeepSeek余额不足HTTP402：3次。
- ByteIntl链路：fetch失败1次、upstream502三次。
- HTTP429资源不足/访问过大：2次。
- 流在completion信号前结束：4次。
- GLM HTTP400 `messages.content.type 参数非法，取值范围 ['text']`：2次。

建议发送前检查provider/profile内容能力。文本模型遇到非text块应给清楚的选择提示，不能在HTTP400后让用户重试同一请求；不能静默丢掉附件。余额不足应提供可执行的充值/切换入口；429可在未输出前按明确退避策略有限重试。流中断要区分已输出内容、已执行工具与可安全重试阶段。

两个GLM400实例：`run_mv846vtj_tb0gdpkq`、`run_mv847816_w0niruom`。流中断实例包括`run_mv6dboi0_0rwz7ky3`、`run_mv6dtvwt_c2somj5l`。

### 4. 自动任务的网页抓取

49个scheduler Run中46完成、3失败，但内部webFetch出现64次http_4xx和3次timeout。完成状态不代表所有步骤有效。全来源错误中Jina代理403/422及备用代理超时重复出现。

建议按目标域名记录抓取结果与短期不可用状态，对确定403/422的相同来源避免无休止尝试；任务完成摘要应明确缺失数据。备用渠道要经过可用性验证，不将重复代理失败包装为完整巡检。

### 5. 观测可读性

观测表启用`zion.space_id`行级隔离。未设置上下文查询会返回0行；这不是投影故障。按生产上下文重查：223条Run全部投影、2681条stage，`caught_up=1`、`recovery_loss=0`，事件投影落后不足1秒。

真正的问题：

- 已投影工具阶段652条成功、116条错误的name为`unknown`，无法按真实工具归因。
- observabilityQuery出现9次错误，包含`id`/`started_at`不存在、`sqlite_master`不存在。

建议统一通用工具名/别名映射，在Skill里提供真实PostgreSQL schema与空间上下文约定，查询前先读schema，避免沿用SQLite示例。补充分阶段失败率和覆盖率，使分析能识别未知名称、缺失采样和主动取消。

### 6. 发布/重连韧性

一周Caddy error记录8509条，6101条是到Runtime8766的connection refused；大量请求是Node注册/长轮询、协作和SSE。另有1793条http2 stream closed及368条context canceled，不能全部算作业务失败。Runtime日志有2次停止超时。上述计数是请求/日志条数，不是独立事故数；尚未逐条与发布窗口对齐。

建议发布按HTTP就绪切换、客户端使用带抖动的重连退避，避免Runtime重启时注册请求风暴；把预期的流取消与真正上游不可用分开告警。当前服务无自动重启迹象，不支持把这些历史日志描述为“现在持续宕机”。

## 建议执行顺序

1. 核验并归档迁移遗留SQLite，建立磁盘容量告警及存储保留策略。
2. 修正Node目标解析、终端实例变化后的恢复和超长命令传输。
3. 补模型内容能力检查，并对轻量任务做思考强度/上下文规模对照。
4. 收敛自动任务抓取失败和观测工具名/schema问题。
5. 按发布窗口分析连接拒绝，完善HTTP就绪与重连退避。

证据来自`.dbg/recent-usage-preflight.log`、`recent-usage-analysis.log`、`recent-usage-followup.log`、`recent-usage-final-evidence.log`及`recent-scoped-observability.log`。原始对话、完整工具参数、密码和凭据没有写入本报告。
