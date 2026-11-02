# 持续目标与上下文压缩：Harness 调研和 Zion 集成设计

调研日期：2026-10-16。目标是将持续目标执行和可靠上下文压缩作为 Zion 插件交付；Runtime 只承担通用执行生命周期、持久化、授权、取消与计量。本文记录设计依据，实施与验证结果另列，不能以此文档代表已经实现。

## 一手资料

开源仓库以实际取得的 commit 固定，避免将旧版本经验当成当前实现。

| Harness | 阅读材料 | 可借鉴机制 | 不直接采用 |
|---|---|---|---|
| Codex | [goal extension](https://github.com/openai/codex/tree/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/ext/goal)、[compact.rs](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/compact.rs)、[handoff prompt](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/prompts/templates/compact/prompt.md) | 目标持久化与状态、显式目标创建、用量计量、空闲时原子接纳续轮、预算不足独立于完成；压缩是交接，保留当前目标与重要请求，重新注入权威系统上下文 | 依赖 OpenAI 私有压缩接口；把持续目标缩成单次Run成功；把工具文本当用户目标 |
| Claude Code / Agent SDK | [agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)、[hooks](https://code.claude.com/docs/en/hooks)、[context window](https://code.claude.com/docs/en/context-window)、[Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | 接近上下文预算时自动压缩，外部持久状态与摘要区分；Stop可延续，Pre/PostCompact扩展；预算与停止控制独立于模型文案 | 闭源内部不能宣称复刻；不能仅凭“约95%”和关键词拼接称为Claude级压缩 |
| Claude Code 官方 Ralph 插件 | [stop hook](https://github.com/anthropics/claude-code/blob/main/plugins/ralph-wiggum/hooks/stop-hook.sh) | 演示用插件阻止自然Stop并继续任务；持久记录循环状态、可取消 | 纯completion promise文本不是验收证据；无限重复相同prompt会烧预算和放大副作用 |
| OpenCode | [compaction](https://github.com/anomalyco/opencode/blob/61bfcbdaff3f1ced4e00bf88bf4b5732ad061e20/packages/core/src/session/compaction.ts)、[config plugin](https://github.com/anomalyco/opencode/blob/61bfcbdaff3f1ced4e00bf88bf4b5732ad061e20/packages/core/src/config/plugin/compaction.ts) | 当前实现区分auto/manual/overflow，保留近期上下文，结构化checkpoint更新；预留输出空间，溢出重试逐级缩小；可选provider native compaction；未知窗口不盲目自动压缩 | 网络旧文仍引用旧packages/opencode路径与旧常量，不能照搬；不能无配对地剪tool消息 |
| Pi coding agent | [compaction](https://github.com/badlogic/pi-mono/blob/5ab7fe74c400097b386662205cd93900695b8a71/packages/coding-agent/src/core/compaction/compaction.ts)、[extensions](https://github.com/badlogic/pi-mono/blob/5ab7fe74c400097b386662205cd93900695b8a71/packages/coding-agent/docs/extensions.md) | 核心精简、扩展负责工作流；真实LLM摘要、保留recent tokens、用实际usage加尾部估算；read/modified文件跟踪；摘要与分支切点持久化；agent settle阶段扩展 | 不能把内存缓存当持久会话；不能只统计JSON字符数就宣称精确tokens |
| Aider | [repo map](https://aider.chat/docs/repomap.html)、[options](https://aider.chat/docs/config/options) | 对话历史软预算、摘要模型独立配置；文件内容/仓库符号按相关性组织，当前文件可重新读取 | 其编辑协议和反射循环不等于通用工具Harness，不宜整体迁移 |
| Manus | [官方工程文章](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) | 稳定prefix、可恢复输出裁剪、文件系统外部记忆、todo目标回顾、保留失败经验 | 文章不代表可审计的开源完整实现；推理服务logit masking并非通用API可实现；URL保留也不保证网页可重取 |

共性：持续工作靠生命周期与权威状态，压缩靠证据保留与可恢复交接。两者都不是增加一句“继续工作”或把旧消息截成前100字。

## 调研时的 Zion 代码现状与确定缺口

- `packages/runtime/src/agent-engine.ts`：当一轮无tool call，直接写message/run completed并settle，没有可供插件拦截的before-finish机制。
- `apps/runtime/src/runtime-plugin-service.mjs`：插件已有context provider、tool、postProcessor、document projector、持久state namespace；postProcessor在server的Run completed后才运行，不能以此安全实现Stop veto。
- `extensions/dev.context-compression/runtime.js`：post-stage provider按静态设置压缩每轮messages，但没有模型摘要调用或持久checkpoint复用。
- `strategies/claude-code.js`：所谓generateSummary实际关键词提取与fallback拼接，未调用LLM；通过助手文案中“完成/成功”推测已完成，会污染事实。
- `strategies/progressive.js`：对非空输出记`status=ok`，可能把失败变成功；`viewer_tool=viewToolResult`缺乏已注册恢复工具的保证。
- 默认阈值95%、固定128k窗口与粗略字符计量，未可靠计入完整工具schema、输出预留、各模型窗口和真实usage。
- 支持多策略名称不等于执行质量：auto甚至可能落到未注册runtime策略；先改善真实默认路径，UI不得继续暗示与外部产品质量等价。

最近线上分析也支持这些方向：GLM交互Run模型请求数中位5/P95 29；最近100个请求体中位195KB；最高思考强度占51%。压缩效果需以任务连续性、失败事实保留、配对完整性和请求大小验证，不能只测“token减少”。

## 目标插件交付要求

插件建议名`dev.goal`，UI和Runtime双入口，显式`/goal <objective>`及start/status/pause/resume/cancel操作；普通聊天不自动变goal。主目标文本保持完整，用户补充修正可更新上下文，不能由模型缩小目标。

权威记录至少包含goal ID、owner/space/session、完整objective、status、revision、当前run关联、创建/更新时间、用量、可选用户预算、进展与完成证据。必须持久化到现有PostgreSQL控制面。预算耗尽、用户暂停、进程中断、真实阻塞和完成分开，不得用“完成”覆盖。

模型获得读状态和报告进展/完成/阻塞能力；完成要携带可检查的证据和目标条件对应关系。模型声明不是客观验证保证，UI应清楚展示验收事实。阻塞须核验重复条件，空响应/没有进展不能无限续轮。已有命令未确定结果时只观察同一handle/receipt，不重复执行。

Runtime新增通用生命周期扩展（接口名实施时确定）：执行前/自然Stop前/停止后，或等价的controller协议。插件决定是否继续；Runtime负责互斥接纳、同一授权范围、取消传播、模型/工具预算、不重放已执行副作用、计量与状态持久化。不能以浏览器定时器或Run完成后的无授权递归fetch实现。

刷新与Runtime重启后能看到并恢复目标。自动恢复必须辨别上个Run仍活跃、已中断和结果未知，不允许并行启动同一目标。达到某个执行安全上限后应保留未完成目标、显示原因并支持恢复，不能偷偷将目标标记完成。

## 压缩插件交付要求

保留现有插件ID与配置兼容，新增真正的结构化交接策略作为默认可靠路径；旧策略可以保留名称兼容，但必须去除“空输出/非空输出推断成功”与不存在的恢复工具承诺。

流水线：

1. 计算窗口预算，使用真实模型能力/usage能用则用，保守估算明确标识；预留输出与压缩余量。system与tool schema计入预算。
2. 优先裁剪旧的、已完成的工具输出，保留状态、精确call ID、证据引用、错误和恢复地址。提供实际可用且有会话权限边界的恢复工具。
3. 仍超预算时，调用现有模型服务生成交接摘要：完整目标、用户约束与更正、确定决策、已完成/活跃/阻塞事实、精确文件/符号/错误、后续动作和不确定结果。
4. system原样保留；最新用户请求和近期完整tool-call/tool-result组保留。摘要是历史数据，不能被提升成比原system更高权限的指令。
5. 摘要与切点/内容hash持久化，下轮复用并只合并新增历史，避免每个tool轮次重新摘要或越压越失真。原始会话历史、Yjs及receipt不删除。
6. 调用摘要失败、取消、结果过大或校验失败时，保留原上下文并报告失败；不得把假摘要写为成功。无授权/不确定副作用不得恢复执行。
7. `/compact`的手动行为与自动压缩使用同一Runtime管线，状态与节省量可见；不能只删浏览器本地消息。

摘要调用通过host的模型服务进行，采用当前/配置模型且不递归走主对话压缩。保留parent cancellation、权限及用量观察。大历史分块和溢出恢复需明确限制与失败行为。

## 验证与落地原则

需要实际覆盖：普通chat不续轮；goal自然Stop继续直到显式完成；暂停/取消即时停；预算耗尽不宣称完成；无进展收敛；权限/owner/space隔离；刷新/重启恢复；不重复副作用；压缩保留system/用户更正/失败与未知结果/tool配对；可恢复输出；摘要缓存跨轮复用；摘要失败取消回退；中英文与大输出；手动命令实际走Runtime。

与Codex/Claude的“质量相当”不能凭单元测试或策略名字宣称，需任务级对照和长程执行记录。首个交付应准确说明已实现机制、验证范围和仍需实测的模型行为。

工作树已有大量未提交改动，全部保留。直接修复当前实现，不覆盖已有登录、设备生命周期或会话一致性修改。用户偏好代码/HTTP验证，本次不使用浏览器自动化。先完成本地实现与必要检查，再决定线上启用窗口，不能在活跃Run中重启服务。

## 实施结果

已实现 `dev.goal` 和持久化 Runtime handoff 管线。交付接口、验证记录与明确限制见 [GOALS-AND-COMPACTION-DELIVERY-20261016.md](../operations/GOALS-AND-COMPACTION-DELIVERY-20261016.md)。上面的缺口描述保留为调研基线，不代表实施后的当前行为。
