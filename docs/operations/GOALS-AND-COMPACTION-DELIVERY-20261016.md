# 持续目标与上下文压缩交付
flowchart TB
    U["Workbench / 手机 / CLI"] --> C["Zion：账户、Agent、任务、策略与调度"]
    C --> S["按需沙箱：Shell、浏览器、用户插件"]
    C --> D["Device：本地文件、内网、登录态"]
    C --> P["PostgreSQL：任务状态、事件、租约"]
    S --> W["隔离持久工作区"]
    S --> O["OSS：附件、产物、版本"]
日期：2026-10-16；编辑器交互更新：2026-10-17。实施工作树：`.worktrees/core-observability`。本次完成本地代码集成与验证，尚未发布到生产环境。调研依据见 [Harness 调研](../architecture/GOALS-AND-COMPACTION-RESEARCH-20261016.md)。

## 持续目标

新增双入口插件 `dev.goal`。在用户消息中输入 `/goal 完整目标`，沿用原来的发送快捷键启动；命令面板「持续目标：开始」会先在文档末尾准备新的用户消息块，填写后再发送。普通聊天不会创建目标，service 委派 Run 中的模型生成文本也不能激活目标。支持 `/goal-status`、`/goal-pause`、`/goal-resume`、`/goal-cancel`。

目标入口挂在现有编辑器标题栏，不再安装 CodeMirror `showPanel`。没有目标时不显示额外栏；有目标时只显示紧凑的状态/目标和一个主要操作：运行中「暂停」，停止时「继续」，完成或取消后「新目标」。点击状态激活标准 Auxiliary Bar 的「持续目标」视图，按需查看进展、下一步、可选计划、验收引用、用量与运行记录；预算和运行轮数不占常驻标题栏。状态入口悬浮或键盘聚焦时显示状态、完整目标、下一步和点击用途。

暂停、继续、调整属于会话操作，不写入当前光标。开始操作只追加新用户块，保留原选区内容及撤销历史，并先闭合未完成的代码围栏，防止目标落入代码块；已有未结束目标时拒绝重复准备启动消息。详情表单在轮询时保留输入，Escape 关闭 Auxiliary Bar 并归还焦点。各面板控制绑定自己的 editor/session，切换 Panel 或 Session 时 Auxiliary Bar 跟随当前编辑器，丢弃切换会话或账户前的异步响应；插件卸载移除标题栏入口、Auxiliary Bar 注册点和轮询。运行中的状态每四秒刷新，仅刷新可见页面，不承担自动续跑。

`status` command 支持只读的 `view=records` 和 `view=run`。列表使用一次 PostgreSQL 查询读取最多 32 轮的必要元数据和 240 字符输出预览，避免逐 Run 读取完整 payload；单轮输出按 6000 字符分页读取，并校验目标归属、账户和 Session。点击记录会以 `EditorView.scrollIntoView` 定位文档中已有的 assistant Run 标记，保持选区；文档没有投影时仍可在检查面板查看持久结果，不重新插入聊天内容。结果中也包含运行停止原因及工具操作的待确认状态。

权威状态保存在 PostgreSQL 的 Runtime 插件私有 KV，按账户、Space、Session 隔离。完整 objective 与用户提供的 criteria 不允许模型改写。旧目标完成或取消后，新目标启动会保存旧目标历史。

用户可先暂停，再通过检查面板「调整目标」修改目标。运行尚未收尾时禁用修改，服务端也拒绝修改；保存后记录旧 objective/criteria，清空过期进展、计划及验收证据，保留工具操作日志和累计预算。默认验收条件随 objective 更新；显式提供的独立验收条件保留，除非用户另外指定新条件。

状态区分 `active`、`paused`、`interrupted`、`blocked`、`budget_exhausted`、`completed` 和 `cancelled`。模型通过 `goalManage` 读取、报告进展、提交按 criterion 索引关联的证据、报告阻塞或核验未知结果；不能创建目标、增加预算或缩小目标。完成证据标注为模型报告，不构成独立的客观验收保证。

Runtime 新增通用 controller 生命周期：

- `beforeStart`：持久接纳目标与 Run 关联。
- `beforeTurn` / `beforeModel`：执行前检查状态与预算，包括摘要服务的已观察用量。
- `beforeStop`：字符串表示继续，`null` 表示接受当前边界停止，`undefined` 表示不接管。
- `beforeTool` / `afterTool`：检查停止状态，在插件决定的工作流范围中记录待执行操作与实际结果；停止原因由 Runtime 传播取消，已有结果则可阻止重复执行。
- `afterRun` / `continuationFailed`：完成会话持久化后申请续 Run，或保留停止原因。

自然 Stop 可继续同一 Run；达到 Run 上限时交由服务端接纳新 Run。会话互斥、授权复查、规范会话消息、事件流及文档投影均沿用 Runtime 管线，浏览器不负责循环执行。后续 Run 使用原任务授权，权限撤销后不能继续。

显式「继续」通过 scoped plugin command 的 `startRun` 接纳一个新 Run，按当前账户重新授权，保留之前的模型、思考配置、设备与 policy 上限。仅从已提交的 canonical transcript 建立输入，忽略客户端传来的草稿/messages。Runtime 以新的用户消息及 assistant 边界投影继续指令，不覆盖空白或未发送的草稿；Yjs 重复投影保持幂等。重复继续受 Session 接纳互斥保护。

Run 已终止但会话仍在收尾时，新提交等待持久化完成，避免短暂的虚假 409；服务关闭也等待工作流状态收尾。旧续轮的接纳失败不会覆盖已经启动的新用户 Run。

默认每次启动或恢复最多接纳 8 个 Run；首次停止建立进展基线，其后连续 3 个停止边界没有新进展，或同一阻塞条件连续出现 3 次时停止。用户可选累计 token 预算；预算耗尽不会标记完成，恢复需提供大于已用量的新预算。预算根据模型返回 usage 在模型和工具执行前检查，已发出的模型请求可能越过软预算，不承诺服务端计费的硬截断。

模型工作协议按「检查当前事实和用户更正 → 选择下一步 → 执行 → 验证」推进。`goalManage.progress` 可报告 `nextAction`、可选简短 `plan` 和证据；不要求固定步骤规划器。停止边界只比较成功工具结果的指纹与去重后的证据引用，修改进度文字、重复相同读取或重复引用不会重置停滞计数。长任务通过原工具 handle 等待和核验，不能把仍在运行解释成完成；摘要交接后需要细节时调用 `compressionRecall`。

进程重启将活动目标恢复为 `interrupted`，显式恢复后先检查已有执行结果。非安全幂等操作在执行前写入目标范围的操作日志；同一工具、目标设备与规范化参数的 pending/unknown 操作会跨 Run 阻止重放。已知结果的操作可按任务需要再次执行。核验需要后续成功的读取证据和解释；模型对“已核验”的理解仍需人工复核。

## 可靠交接压缩

保留插件 ID `dev.context-compression`，Runtime 统一使用 `handoff` 管线，旧策略名称保留配置兼容。默认阈值由 0.95 改为 0.85。移除了旧 Claude 名称策略中的关键词“完成”推断；无摘要模型时保留历史。旧 Progressive 实现不再通过非空文本推断成功，也不再承诺不存在的 `viewToolResult`。

当前流程：

1. 优先使用 Runtime 模型 profile 的 limits；Workbench 导入模型时传递已解析的 limits。未配置时使用明确标记的设置回退值。
2. 计入 system、目标指令、完整工具定义、输出预留和余量。采用对中英文分别加权的保守字符估算，状态明确标注不是精确 tokenizer。
3. 只裁剪已成功、已有持久原文且恢复工具在当前 policy 中可用的旧工具结果。保留 call ID、实际 status、预览和恢复 locator。
4. 超预算时通过 Runtime 模型服务生成结构化 JSON 交接，包含 intent、constraints、decisions、completed、active、blocked、references、next、uncertain。摘要调用禁用工具，不递归压缩，传递取消、输出预算、权限检查和 usage。
5. 原 system 和最新用户请求保留，近期工具调用和结果作为完整组保留。失败及未知结果的原文事实单独保留，不依赖摘要模型自觉记住。
6. checkpoint、原历史 prefix hash、切点、保留用户请求与恢复 locator 持久化。跨轮、跨 Run、刷新和重启可复用；需要再压缩时合并增量历史。稳定 JSON 序列化避免 PostgreSQL JSONB 字段重排破坏缓存。
7. 摘要无效、过大、失败或取消时，Runtime 保留原上下文；失败不提交摘要或裁剪 locator。相同失败输入自动退避 60 秒，手动压缩不受退避限制。

`compressionRecall` 根据持久 Run 原文按页恢复输出，每页最多 16000 字符，重新检查账户、Space、Session 和内容 hash。原 Session、Run transcript、Yjs、tool receipt 不删除。

`/compact` 和「压缩对话（手动）」通过 `POST /v1/plugins/dev.context-compression/commands` 使用相同 Runtime 管线。会话有活动 Run 时拒绝手动压缩；手动压缩不改写编辑器或规范会话历史。状态和估算节省量可见。

## 验证

使用 Node 22、真实 PostgreSQL 测试 schema、HTTP 和代码级 UI 检查。模型使用确定性测试引擎与摘要响应，未对外部生产模型做质量评测。没有使用浏览器自动化。验证命令从相应工作目录运行：

```sh
# 仓库根目录
node node_modules/typescript/bin/tsc -p packages/runtime/tsconfig.json
node node_modules/vite/bin/vite.js build
node node_modules/vitest/vitest.mjs run tests/goal-plugin.test.js tests/context-compression-runtime.test.js tests/context-compression-plugin.test.js tests/interactive-runtime-backend.test.js tests/model-limits.test.js

# packages/runtime
node ../../node_modules/vitest/vitest.mjs run tests

# apps/runtime
node ../../node_modules/vitest/vitest.mjs run tests/goal-compaction.integration.test.js tests/plugin-model-service.test.js tests/runtime-control-plane-http.test.js tests/account-execution.integration.test.js tests/interaction-profile-store.test.js tests/runtime-plugin-service.test.js tests/server.test.js
```

2026-10-16 验证结果：Runtime 核心 49 项、Runtime Host 与 PostgreSQL/HTTP 集成 68 项、Workbench 33 项，共 150 项相关测试通过；其中新增目标/压缩集成测试 13 项。这里的 TypeScript 编译指 Runtime package，前端生产构建通过。

2026-10-17 交互更新验证：Workbench 36 项、Runtime engine 15 项、Runtime Host/HTTP/PostgreSQL 50 项，共 101 项通过；另有提交准备的 2 项通过。目标/压缩集成用例现为 16 项。新增用例使用真实 CM6 EditorView、undo 和 Yjs，覆盖历史选区、未闭合围栏、同步只读、多面板、旧异步响应、卸载、草稿保护、续跑重复接纳、保留设备/模型、暂停后修改和重复证据不计为进展。Runtime 编译与 Vite 生产构建通过。

2026-10-17 标题栏/检查面板改版验证：Workbench 41 项，Runtime Host/真实 PostgreSQL 41 项，另有 control-plane、plugin service 和 interaction profile 24 项，共 106 项相关测试通过。Goal UI 9 项与目标/压缩集成 17 项包含空会话无额外界面、取消后新建、详情焦点恢复、草稿/选区/撤销保护、表单轮询保留、多标签隐藏、账户切换清空，以及运行记录输出分页和归属隔离。Runtime package 编译和最终 Vite 生产构建通过。未做浏览器自动化或截图视觉验收。

2026-10-17 Auxiliary Bar 更新验证：前端相关 58 项通过，其中 Goal UI 12 项覆盖 Auxiliary Bar 注册、点击激活/关闭、header 动态悬浮提示、Session 跟随、暂停轮询稳定性、`/goal` 补全与命令高亮；Workbench Auxiliary Bar 生命周期 5 项通过。Vite 生产构建通过，隔离测试服务返回的 Goal bundle 与本次 `dist` SHA-256 一致。

扩大检查的边界：前端全量 `tsc --noEmit` 仍报既有 JS 声明缺失及 EditorProxy 接口错误。协作测试 `resolves a Yjs relative Run anchor...` 的期望缺少存储规范化增加的 `user ` 前缀，在撤回本次 projector 改动后仍可复现；并发跑时空文档持久化测试偶发失败，单独跑通过。未将这些检查标记为全部通过，未在本次目标交互变更中修改它们。

新增集成用例覆盖普通聊天不创建目标、自然 Stop 续轮、证据完成、无进展收敛、预算停止、摘要用量计入目标预算、即时暂停、owner/Space/Session 隔离、重启恢复、跨 Run 未知操作防重放、规范会话历史、输出恢复、摘要缓存及增量复用、失败取消、私有 KV 隔离和手动压缩。

既有测试中同步更新了两个过时接口断言，并将取消 fixture 改为真实 CancellationSignal；修复了等待数据库启动时无限微任务轮询导致测试饿死的问题。客户端轻量 projection 保持无 payload，显式授权事件 detail 保留原始模型请求。

## 使用与边界

启用列表显式配置了 `ZION_RUNTIME_PLUGINS` 的部署，需要加入 `dev.goal`；`dev.context-compression` 保持原 ID。交互 profile 需要允许 `goalManage`，输出裁剪还需要 `compressionRecall`。默认本地启动、remote launcher 和账户开发脚本已包含新插件和默认工具。既有自定义 profile 保持其管理员选择，需要在其工具列表中启用这两项。

Workbench 启动目标时会自动请求所需的工作流工具，仍由 Runtime profile 的授权上限过滤，用户无需在每次启动目标时单独勾选。

这次没有迁移数据库 schema，使用现有 PostgreSQL KV 和 Run transcript。私有工作流 KV 从 Workbench snapshot 排除，并拒绝浏览器通过通用 KV 接口读写，防止跨账户读取或篡改。

当前目标互斥和工作流接纳面向单 Runtime 实例。多实例 active-active 需要数据库事务 claim，不能只依赖进程锁。超大单个历史组或超过 16 个摘要分块时保留原文并报告失败；暂不提供 provider 原生压缩接口和上下文溢出的逐级重试。

机制测试不等于与 Codex/Claude 长程执行质量相当。摘要事实质量和完成验收仍受当前模型影响，尚未进行线上长任务对照评测。生产启用应在无活动 Run 的窗口部署；本次没有重启或修改线上服务。

本地测试入口为 `http://localhost:18867`，沿用已有测试账户。2026-10-17 在确认该账户没有活动 Run 后更新了隔离测试服务；HTTP `/health` 正常，Goal 静态 bundle 与本次 dist 的 SHA-256 一致，未登录调用私有目标 command 返回 401。验证不操作浏览器，未改动原 18866 服务、工具连接进程或生产 Runtime。构建与服务检查的临时日志保存在系统临时目录。
