# Runtime 沙箱集成交付

日期：2026-10-18；持久 HOME 更新：2026-10-20；共享并发更新：2026-10-24。分支：`feature/sandbox-runtime-integration`。
工作区：`/Users/bytedance/Downloads/zion-next/.worktrees/sandbox-runtime-integration`。

## 本次实现

Runtime 增加显式 `sandbox` 工具模式，仅账户认证环境可以启用。默认 local/node 模式不变。
沙箱现在以账户级 Managed Node 出现在 `terminalInventory` 中，复用统一的 `Bash`、`read`、
`write`、`edit`、`glob`、`grep`、`tree` 工具和现有 Terminal UI。旧
`sandboxBash`、`sandboxRead`、`sandboxWrite` 仅保留调用兼容，不再注入模型。
沙箱模式同时启动 Device Node 网关：无目标调用默认进入 Managed Node，显式 Device
`node_id` 或全局 `session_id` 仍走 Connector；Device 离线时不会回退到云端。

账户由服务器签发的 grant 解析，绑定到运营配置中指定的 workspace 与独立 AgenticFS Access Point。
客户端不能指定账户、云端角色或挂载。设备目标、越界路径、受限命令策略与未绑定账户均在创建前拒绝。
`write/edit` 至少需要 `workspace-write`，`Bash` 需要 `trusted-automation`；Profile 需显式允许统一工具。
文件工具接受 VM 内规范化绝对路径，并受账户 grant 的 `fileRoots` 限制；
读写通过 Python 再校验解析后的路径，文本大小受限；write 同步文件及父目录。
Terminal cwd 同样支持 `/root`、`/tmp` 等 VM 内路径。默认工作目录仍为 `/workspace`。
大文件参数先写入 VM 内 `/tmp` 的随机临时载荷，避免超过 Provider 的 32 KiB 命令上限；
执行完成删除；中断后的临时载荷可能留在 `/tmp`，随实例回收清除，不写入 AgenticFS。
Bash 在隔离 MicroVM 中以 root 执行，可访问该 MicroVM 全盘，挂载角色是持久数据隔离的关键。

PostgreSQL 存储 `runtime_sandbox_workspaces`、`runtime_sandbox_operations` 与
`runtime_sandbox_terminals`。
同账户的普通 Bash/read/write/edit/glob/grep/tree 持有共享 workspace advisory lock，可以跨会话、
跨 broker 并发；创建、准备 HOME、恢复、暂停和释放使用独占生命周期锁。
每个 invocation 另有独占 claim，覆盖执行及结果持久化，重复调用等待已有结果。
执行连接使用独立 ownership pool，避免占满 Runtime 查询池后阻塞授权。
创建前持久化 scope/epoch/requestKey，创建后持久化 handle；
workspace.active 保留初始化及旧版本恢复记录，operation.active 保存每次调用的执行 UUID/PID。
正常完成工具后保存结果并清空该操作的 active，保留 instance 和其他活跃操作。实例 epoch 只在新建时递增。
同账户跨会话复用工作区实例，保留临时文件、安装依赖和后台进程。
默认空闲 2 分钟暂停，30 分钟未使用销毁；下一次调用恢复或重建，AgenticFS 文件继续保留。
Runtime 在首次执行前将 AgenticFS `/workspace/.zion/home` bind mount 到 `/root`，
让 HOME 内的 CLI、工具链、Git 配置、用户 rc 和缓存随重建保留。
初始化在工作区 advisory lock 下执行，检查真实 NFS 挂载、原子写入初始化标记及环境文件；
挂载或初始化失败按未知结果处理并销毁 VM，不回退到临时 HOME。
初次从模板或旧实例的 `/root` 非覆盖式迁移，后续不重新导入模板用户数据。
已有初始化标记但 HOME 丢失时失败，不重建空目录继续执行。
`Bash` 与 Provider PTY 使用同一 login shell、HOME、XDG 路径和用户工具 PATH，
共用 `~/.config/zion/env.sh`。默认 `npm install -g` 写入 `~/.local`；
已有 NVM 时由该环境文件加载 NVM 并取消 npm prefix，其他工具链初始化也可放在这里。
移除当前 Aliyun 模板在 `/etc/profile` 中重复 source 用户 rc 的入口，避免初始化多次执行。
内部文件命令绕过用户 rc，用户启动输出不会破坏文件工具 JSON。
`/tmp`、`/usr`、`/etc`、`/var` 属于 VM 临时系统；apt 安装需要基础模板或明确重建流程。
挂载和网络配置指纹持久化；修改已使用工作区的绑定会拒绝启动该工作区的新操作，需显式迁移。

取消或未知执行只清理对应进程组；PTY 命令只清理该终端会话，其他会话继续使用同一 VM。
工具仍返回 `execution_outcome_unknown`，不会自动重放相同未知写操作。
执行 UUID 在调用 SDK 前持久化，独立进程会话保存 PID/start time，
取消标记阻止回包延迟后的启动；后台 SDK handle 支持接收 PID、等待退出和断开输出流。
健康实例记录在 Runtime 重启后可继续复用。执行期间定时探测锁连接；
替代 broker 通过 invocation claim 区分仍在运行的调用与失去所有者的操作，并只清理失去所有者的进程。
清理未确认时保留该操作的 active/未知收据，其他普通调用仍可执行；
生命周期维护须完成清理后才能暂停或回收实例。旧版 workspace.active 与未知创建仍按 metadata 恢复。
创建回包丢失且列表为空时，不自动重建，保持阻塞并要求运营对账。
同一 Run 的相同未知写操作即使换 invocation ID 也会阻止重放。
Runtime 在 durable receipt 与进程内执行 fence 之前解析 Node 目标，request hash 包含
Node/resource/instance 绑定，避免同参数在不同执行位置共享收据。

Terminal 的逻辑 Node ID 对账户和 workspace 稳定；Terminal `session_id` 同时绑定
Node、sandbox instance、resource 和原生 PTY id。Runtime 重启会从 PostgreSQL 重新连接同一 PTY，
但 release、外部销毁、该 PTY 的未知执行或 30 分钟回收会使旧引用返回
`stale_terminal_reference`，不会指向新 VM。HTTP relay 每次请求都重新验证账户或 Run grant；
创建、恢复、关闭 PTY 使用内部最小 Bash Profile 签发短期 grant，并在操作后立即撤销。
relay 输出队列限制为 1 MiB，输入限制为 64 KiB，废弃通道默认 45 秒回收。
活跃 relay 持有 workspace activity lease，自动维护不能暂停 VM；用户主动 pause 会返回 409，
release 则关闭 relay、删除 PTY 元数据并销毁实例。
模型通过 `Bash(session_id=...)` 在同一持久 shell 内执行，随机 marker 分隔输出并回写 cwd；
模型命令执行期间拒绝交互输入，避免两方同时写 PTY。

## 运行配置

先在根目录 `npm ci`、`npm run runtime:build`，在 `packages/sandbox` 执行 `npm ci`。
除了既有账户认证、PostgreSQL、Space 和 OIDC 配置，还需：

```text
ZION_RUNTIME_TOOL_MODE=sandbox
ZION_RUNTIME_AUTH_MODE=accounts
ZION_ACCOUNT_ALLOW_RESOURCE_EXECUTION=1
ZION_SANDBOX_REGION=cn-shanghai
ZION_SANDBOX_TEMPLATE=u3sxwxk9b0l0tiphkt32
ZION_SANDBOX_BINDINGS_FILE=/absolute/private/path/bindings.json
ZION_SANDBOX_PAUSE_VERIFIED=1
ZION_SANDBOX_IDLE_PAUSE_MS=120000
ZION_SANDBOX_IDLE_DESTROY_MS=1800000
ZION_SANDBOX_TERMINAL_CHANNEL_IDLE_MS=45000
ZION_SANDBOX_TERMINAL_MAX_CHANNELS=8
E2B_API_KEY=<通过凭据管理注入>
```

bindings 文件是数组，每项包含 `accountId`、`workspaceId`、`storageMetadata`、`storageNetwork`。
`storageMetadata` 的 AgenticFS、VPC、role 结构可由已有 `scripts/agenticfs-poc-config.mjs` 生成。
每个账户必须使用独立 Access Point 和限定角色，不能让多个部署给同一持久挂载配置不同工作区身份。
不要把 PoC A/B 挂载分配给真实用户；目前仅供集成验证。
API Key 仅在进程内使用，未写入配置、操作表或交付证据。
阿里云开启自动暂停时 timeout 最低 600 秒。Runtime 主动执行短空闲暂停，云端 600 秒自动暂停
作为 SIGKILL 或电脑休眠的兜底；关闭 Runtime 后长期回收定时器不运行，已暂停实例仍有存储费用。
未验证 pause 的模板空闲时销毁，保留外部工作区文件。
深休眠恢复/销毁请求超时为 60 秒；工具平台 deadline 覆盖恢复加命令执行时间。

账户接口：`GET /v1/sandbox/workspace` 查看自己的实例，
`POST /v1/sandbox/workspace/pause` 暂停，`POST /v1/sandbox/workspace/release` 销毁；
都重新验证账户与 `resource.execute`，执行中操作返回 busy，不打断正在运行的命令或 Terminal。

## 验证与证据

使用本机 PostgreSQL 的随机独立 schema；每项结束后删除 schema。
真实 main 入口：独立 OIDC、echo engine、端口 18892/18893、临时数据目录，验证启动及 `/health`。
HTTP Run：真实账户会话 → 真实 Runtime Server → AgentExecutor → RuntimeToolBroker → SandboxToolBroker → 阿里云二代 MicroVM → AgenticFS。
自动集成测试模型使用确定性工具调用 fixture；本地体验另用真实 DeepSeek 验证跨对话复用与暂停恢复。

回归命令：

```sh
cd apps/runtime
npx vitest run tests/sandbox-runtime.integration.test.js tests/runtime-tool-broker.test.js tests/account-execution.integration.test.js tests/node-broker.test.js
ZION_SANDBOX_LIVE_TEST=1 npx vitest run tests/sandbox-runtime.integration.test.js
```

云端实测项：HTTP 文件写入和 fsync；实例销毁后的读取一致性；账户 B 看不到 A 文件；
运行中取消、终止确认、无延迟写文件；真实 NFS 挂载；测试文件和实例清理。
云端检查结果保存在同目录 `SANDBOX-RUNTIME-LIVE-EVIDENCE-20261018.json`。
新增真实实例 ID 一致性、`/tmp` 和后台 HTTP 服务的暂停恢复、手动 release 后文件恢复。
Managed Node 重点回归 81 项通过，1 项云端测试默认跳过；启用真实云测试后 15/15 通过。
Terminal 前端 relay/context/inventory 17/17 通过，sandbox provider 11/11 通过。
真实 SDK 额外验证了 Runtime 重启后重连同一 PTY、marker 命令、HTTP relay、resize 和 disconnect。
[生命周期证据](computer:///Users/bytedance/Downloads/zion-next/ZION-SANDBOX-LIFECYCLE-EVIDENCE-20261018.json)
记录真实模型复用与暂停结果。Runtime 构建、main 语法检查及 diff whitespace 检查通过。
全量 Runtime 套件的 OIDC 并发超时单独复跑后 7/7 通过；Device 工具启动预置问题修复后 2/2 通过。
仍有一个继承基线的 collaboration-service Yjs anchor 断言稳定失败，与本次沙箱路径无关。
数据库故障场景：授权撤销后的缓存访问拒绝、跨 broker 锁、账户并行、
取消后的持久未知结果、销毁未确认时阻止写入、创建与 handle 保存之间的崩溃窗口、
创建超时且列表为空、挂载绑定改变拒绝、跨会话/broker 复用、空闲暂停/销毁、
维护任务不干扰执行、shutdown 取消、云端实例过期、真实 PostgreSQL 锁连接终止。

## 明确边界

这是可运行的显式集成版本，未部署生产。继承了 core-observability 的未提交代码基线，
不要把整个 worktree diff 当成本次沙箱变更；本次新增 `apps/runtime/src/sandbox/`、
集成测试和本文，main 的沙箱导入、模式校验、broker 接线和 host 信息为本次改动。
基线清单位于 `/tmp/zion-sandbox-integration-baseline.json`。

目前每账户一个预配置 Managed Node，尚未实现任务/Session 多工作区分配、自动 Access Point 创建、
备份恢复与配额告警、工作区管理 UI、WebRTC 直连或第三方插件隔离。Managed Terminal
使用现有已认证 HTTP relay；前端 WebRTC 协商会收到 501 后自动降级。
持久恢复测试覆盖 durable active 的崩溃窗口、broker 替换与真实数据库断连，未做真实 Runtime SIGKILL 注入。
advisory lock 需要直连或 session pooling，不能使用 transaction pooling。
Runtime 全平台仍有进程级 invocation fence；本次工作区锁不代表整个平台已具备 active-active 执行能力。
操作表尚未加入自动保留期清理；每个活跃 invocation 占用独立 ownership pool 的一个连接，
部署仍需规划数据库连接容量。共享执行不引入文件/端口冲突检查、强制 worktree 或 Session 专属 VM。
元数据对账为空的未知创建需要人工介入，目前没有运营 reconcile API。
现有 ManagedSandboxProvider 保留 `zion.poc=1` 元数据，尚未切换生产资源命名空间。

## 本地体验启动

在本 worktree 执行 `npm run sandbox:local -- up --background`。`status`、`pause`、`release`、`stop`
子命令分别查看当前实例、暂停、销毁实例及停止本地服务。账号数据使用
`/Users/bytedance/.zion-next/sandbox-demo`，数据库使用独立 `zion_sandbox_local_demo` schema。
启动时检查 PostgreSQL；未运行时启动已安装的本地开发数据库，恢复中时等待就绪，
不重新初始化数据目录。默认可找到 core-observability 中已有数据库；其他路径通过
`ZION_SANDBOX_LOCAL_POSTGRES_ROOT` 指定。
本地 launcher 已启用 `dev.terminal-manager`。当前体验地址为 `http://127.0.0.1:18891/`；
最终状态保留在线的本地体验 Runtime 与 schema；实例已按 30 分钟策略自动回收，
当前云端活动实例为 0，下一次工具或 Terminal 操作会按需重建。
2026-10-20 本地 launcher 已将体验账号 `interactive.default` 的旧 `/workspace` 根迁移为 `/`；
其他自定义 Profile 不自动扩大 grant。最新重点回归 74 项通过、1 项云端测试默认跳过，
Provider 11 项通过。真实 HTTP Run 与 PTY 验证 CLI、Git、环境变量在 release/rebuild 后保留、
每次加载一次、账户 B 隔离及用户 rc 输出不干扰文件 JSON；测试实例释放完毕。
证据见 `SANDBOX-HOME-LIVE-EVIDENCE-20261020.json`。

同日修复状态查询对执行的干扰：workspaceStatus 使用无锁数据库快照和云端检查，
检查后重读快照以避免 VM 替换竞态；active 时直接返回 executing，不等待 inspect。
维护对尚未到暂停/回收时间的工作区不获取执行锁。busy 明确 `dispatched=false`，
提供 `busyReason=active_operation|lifecycle_maintenance`；有 active 时返回对应工具和 invocation。
Managed machine 无终端时保留 Runtime 的 online/ready 状态，清单 revision 反映状态变化。
针对缺陷的三项测试修复前失败、修复后通过；实际 main/DeepSeek 8 次工具调用、
144 次并行状态刷新全部成功。用户原 Run 的 ls/find 在约18ms 内被拒绝，并未云端执行；
数据库未记录当时锁持有者，因此不将其表述为命令卡死。

## 2026-10-24 本地共享并发验证

真实 PostgreSQL schema 回归覆盖同账号跨 broker 并发 Bash/文件工具、并发冷创建单一实例、
重复 invocation 的收据等待与参数冲突、取消一个任务时另一个继续运行、
小 Runtime 查询池下多任务授权、暂停/释放与执行互斥、数据库 ownership 连接丢失后的定向恢复，
以及不同 PTY 同时执行和单 PTY 取消/超时。workspaceStatus 增加 `activeInvocationCount`。

该版本仅本地修改，未上线。Aliyun 实机测试默认跳过；Linux `/proc` 进程组测试在 macOS 下跳过。
上方 2026-10-18/20 的云端实测记录属于当日实现，不代表本次并发与定向清理已经通过云端实测。
