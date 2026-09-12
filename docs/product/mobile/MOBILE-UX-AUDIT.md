# Mobile Client UX Audit

审计日期：2026-09-08

## 目标

Mobile Client 面向手机上的高频查看、继续对话和短时远程操作，不复制 Desktop
Workbench 的编辑器与多面板工作流。两端共享 Runtime 的 Session、Run、canonical
transcript、Interaction Profile、Scheduler、Todo 和 Resource Host 数据。

## 本轮真实环境

- 模型：DeepSeek V4 Flash
- Runtime 插件：12 个 active，0 个启动失败
- Runtime capability：32 个
- Skills：36 个，36 个 enabled
- Resource Host：Device Connector + local-tools + Plugin Service
- 设备插件包：4 个
- Local Tools 终端：204 个，其中默认工作区 1 个

## 信息架构结论

| 一级入口 | 用户任务 | 结论 |
| --- | --- | --- |
| 对话 | 找会话、继续提问、观察 Run | 保留一级入口，是移动端主路径 |
| 工作 | 查看运行、Todo、定时任务 | 保留，但运行页只强调当前活动 Run |
| 终端 | 短时命令与远程处理 | 保留，默认只展示当前工作区 |
| 更多 | 文件、知识、能力和设置 | 保留，按内容与能力分组 |

不进入 Mobile 的 Desktop 能力仍包括 CodeMirror 编辑、分栏、拖拽、WYSIWYG、Vim、
gutter、TOC 编辑和插件开发热重载。

## 页面审计

| 页面 | 审计发现 | 本轮处理 |
| --- | --- | --- |
| 会话列表 | 固定显示“新会话”；搜索只匹配标题 | 使用首条用户消息推导标题；搜索同时匹配 preview |
| 对话 | tool 消息原始 JSON 被当作 assistant 正文 | tool result 按 `toolCallId` 合并进工具卡，不再独立显示 |
| 对话 | 工具卡只有“已记录”，无法判断结果 | 增加执行中/成功/失败、摘要、参数和结果展开 |
| 对话 | 长 Run 会同时显示 transcript 与 SSE 的重复卡片 | 活跃 Run 的 assistant/tool 由 SSE 独占，完成后切换到 canonical transcript |
| 对话 | Run 完成时先清空 projection，可能短暂闪空 | canonical transcript 刷新完成后再清理 live projection |
| 对话 | 流式更新始终抢滚动位置 | 仅在用户位于底部时跟随；离开底部后显示回到底部按钮 |
| 对话 | 未实现的附件按钮长期占位 | 移除不可用入口 |
| 会话操作 | “创建新会话”并没有复制上下文 | 改为真实 fork，并命名为“复制为新会话” |
| Skills 与工具 | 页面只有 capability，没有 Skills | 拆成 Skills / 工具两个视图 |
| Skills | 无法看到或切换启用状态 | 读取 Runtime skills snapshot，支持启停并同步 |
| 工具 | 不显示默认 Profile 的启用状态 | 展示 enabled/total，并支持更新 Interaction Profile |
| 工具 | 风险和权限层级不清晰 | 显示读取、写入、执行、外部操作；提权时二次确认 |
| 插件 | Plugin Service 的 `data` envelope 被解析为空 | 兼容真实响应协议 |
| 插件 | 无状态字段的包被误标为 disabled | 区分 Runtime active 插件和 Device 可用插件包 |
| 模型 | 模型多时难以选择 | 当前模型置顶并增加搜索 |
| 终端 | 直接展示 Local Tools 的全部 204 个会话 | 默认限定 Interaction Profile 的工作区终端，可切换查看全部 |
| 终端 | 新终端落到服务进程目录 | 使用默认工作区根目录创建，并同步允许的 terminal id |
| 终端 | 模型省略 `session_id` 时命令落错目录 | 唯一允许终端自动成为 broker 默认目标 |
| 文件 | `/files/entries` 文本 tree 响应被当成空数组 | 兼容真实 `{ path, results }` 响应 |
| 变更 | 没有从页面选择 Session 的入口 | 增加 Session 选择器 |
| 工作 | 刷新按钮执行整页 reload | 改为 React Query 定向刷新 |
| Run | 输出按纯文本展示 | 使用 Markdown；补充 Token 使用信息 |
| 定时任务 | 单次任务错误提交 `time` | 改为 `timestamp`；trusted automation 包含 Bash |
| 高风险操作 | 删除任务、关闭终端、吊销设备无确认 | 增加明确确认 |
| Identity / Memory | 使用旧 KV key，始终显示空 | 改用 Runtime plugin namespaced snapshot |
| 设备 | loopback 模式请求 Access Control 后空白 | 本机模式显示明确状态，远程模式才加载配对数据 |
| 设置 | 通知开关默认显示开启但未获权限 | 以真实 Notification 权限为准，并在后台完成 Run 时通知 |

## 对话数据一致性

### 权威数据

1. `POST /v1/sessions/:id/messages` 创建幂等消息命令。
2. `/v1/runs/:id/projection/stream` 提供运行中的轻量 SSE projection。
3. `/v1/sessions/:id/transcript` 提供完成后和跨端恢复时的 canonical transcript。
4. Desktop Workbench 的 Yjs 文档只负责编辑器表示，不作为 Mobile 数据源。

### 映射规则

| Runtime 数据 | Mobile | Desktop |
| --- | --- | --- |
| user message | 右侧用户气泡 | `user` 文档块 |
| assistant content | Markdown 回答 | `assistant` 文档块 |
| reasoning | 默认折叠的思考卡 | Thinking card |
| assistant tool call | 工具卡参数与状态 | Tool call card |
| tool result | 合并到对应工具卡 | Tool call card result |
| run terminal event | 刷新 canonical transcript | 完成文档 projection |

Mobile 不展示独立 `role=tool` 消息，也不把工具 JSON 混入 assistant 正文。工具卡关联键
始终是 canonical `toolCallId`。活跃 Run 的中间步骤来自 SSE；Run 结束后由 canonical
transcript 一次性接管，避免重复与闪空。

Desktop 文档正文与 Mobile 最终回答都来自同一个 Runtime Run。Desktop 的历史卡片
依赖 Workbench card annotations，而 Mobile 可直接从 canonical transcript 恢复，因此
Mobile 不依赖 Desktop 页面是否在线。

## 安全与操作边界

- Mobile 新会话明确绑定 `interactive.default`。
- 工具启用会同步更新默认 Interaction Profile，只影响之后创建的 Session。
- `sendMail` 不允许从通用工具开关直接启用，仍需先配置收件人白名单与额度。
- Bash、写文件和 Device 工具继续受 preset、file roots、terminal ids 与 Device grant
  的交集约束。
- 本机 loopback 模式不显示无意义的配对管理；远程 HTTPS 模式保留 Owner/Client 权限。

## 验收标准

- 会话标题和 preview 可区分，不出现批量“新会话”。
- tool result 不以裸 JSON 消息出现。
- 同一 Run 在 live 与 canonical 阶段不重复显示。
- 思考与工具详情默认折叠，点击可查看完整数据。
- 用户向上滚动时流式内容不抢滚动位置。
- Skills、工具、插件、模型、终端和文件页面均使用真实 Runtime/Device 数据。
- 当前工作区是终端和文件页默认范围。
- Mobile 最终回答与 Desktop Runtime 文档中的 assistant 内容一致。

## 第二轮：用户导向优化

### 参考模式

- [GitHub Actions run history](https://docs.github.com/en/actions/how-tos/monitor-workflows/viewing-workflow-run-history?tool=webui)
  将工作流、运行记录和单次运行日志拆成连续层级，并允许从失败记录直接重跑。
- [Material Design Lists](https://m3.material.io/components/lists/guidelines/)
  要求列表主信息位置稳定，辅助文字限制在一到三行，父子层级通过整行点击进入。
- [Material Design Transitions](https://m3.material.io/styles/motion/transitions)
  强调列表到详情的前进/后退关系，并通过短过渡维持空间连续性。
- [Mobile interruption resilience](https://userpilot.com/blog/mobile-ux-design/)
  强调移动使用天然会被打断，应保存输入与表单状态，避免用户重复劳动。
- [AI progressive disclosure](https://www.craftedbydaniel.com/blog/i-hid-the-ais-thinking-in-plain-sight-dual-channel-streaming-for-an-ai-search-chatbot-that-works-mid-call-series-part-9)
  将思考与结构化结果分离，默认保持简洁，需要时再展开过程。

### 定时任务运行历史

信息层级调整为：

```text
工作 / 自动化
  -> 定时任务详情
       -> 运行历史（全部 / 成功 / 异常）
            -> 单次运行详情
```

任务列表只保留计划、启用状态、最近结果、运行次数和“立即运行”；暂停与删除移动到
任务详情，避免每行出现三个同权重图标。任务详情包含：

- 下次执行时间、总运行次数、成功数、异常数和平均耗时。
- 任务目标或命令。
- 按状态筛选的历史记录。
- 立即运行、暂停/启用和删除。

单次运行详情优先展示最终结果，其后才是技术信息：

- 成功、失败、运行中、超时和取消状态。
- 手动/计划触发、开始与完成时间、耗时。
- 最终 Markdown 输出；失败时突出错误。
- Token 使用、事件数和底层 Run ID。
- 查看底层 Run、再次运行。

### 视觉与连续性

- “工作”默认进入自动化，而不是大部分时间为空的“当前 Run”。
- 分组列表改为 inset surface，保持统一左侧锚点和一到两行摘要。
- 状态色固定为蓝色进行中、绿色成功、红色失败、琥珀色取消/停止。
- 底部导航强化当前入口，但不使用营销式大卡片或装饰性渐变。
- 页面切换使用短距离、低幅度过渡，并尊重 `prefers-reduced-motion`。
- 会话草稿和定时任务表单草稿写入本地状态，切后台或误返回后可以继续。

## 第三轮：对话页用户动作

对话页不能只按技术对象展示 message、tool call 和 run。用户在手机上实际会围绕
“一条消息、一个回答、一次工具执行、一个产物、一个会话”反复操作。参考 ChatGPT /
Claude 的移动 Composer、飞书 / Slack 的长按消息操作、Perplexity 的来源卡片，以及
Apple HIG 的 Context Menu 原则，本轮将操作入口收敛为：

- 消息旁的 `...` 与长按打开底部操作面板。
- 用户消息支持复制、编辑并重新发送；撤回先展示为不可用，因为 Runtime 还没有消息修订
  / 撤回 API。
- Assistant 回答支持复制、引用追问、重新生成和分享；重新生成当前以新消息方式发起，后续
  应升级为真正的分支再生成协议。
- 代码块提供独立复制按钮，避免用户复制整段回答后再手动裁剪。
- Composer 左侧增加附件 / 上下文入口，当前支持跳转工作区文件和粘贴剪贴板文本；文件、
  图片上传需要后端上传协议。
- Composer 上方的模型、权限、工具与 Skills 信息变成可点击会话信息胶囊，不再作为静态
  技术尾注。
- 会话信息底部面板展示模型、权限、消息数、工具数、Skills 数、产物数、创建和更新时间。
- 产物摘要从单个跳转按钮升级为会话内产物卡，展示文件变更数量、diff 统计和最近变更；
  接受 / 回退入口保留，但明确提示需要移动端变更协议。
- 发送失败原地提供重试，不要求用户复制错误再重新发。

后续需要补的后端合约：

- 消息撤回 / 编辑历史 / 分支再生成。
- Session 重命名、归档、删除和模型切换。
- 移动端文件 / 图片上传。
- 移动端接受 / 回退变更，并同步 Desktop Changes 状态。

## 第四轮：严格审计后的细节优化

上一轮的问题是“功能入口可见”，但仍带有 Demo 痕迹：常驻消息操作按钮会干扰阅读，
每条消息显示时间会稀释正文，Composer 状态信息占位但不帮助用户继续行动，长回答在手机上
缺少阅读节奏。二次优化按真实移动使用场景收敛为：

- 消息操作按钮默认弱化，只在 hover、focus、active 或长按场景显露；用户仍可长按消息打开
  action sheet。
- 消息时间改为按日期分隔，具体时间进入消息操作面板，减少每条消息的视觉负担。
- 增加会话内搜索，搜索栏置顶在消息流内，输入后显示匹配数量并高亮匹配消息。
- 长回答自动折叠，用户需要时再展开全文，避免一条回答把整个手机屏幕拖成文档页。
- 工具详情里的参数和结果支持单独复制，便于把一次执行证据复用到别处。
- Composer 增加上下文相关快捷建议。空会话优先“看工作区 / 查状态”；已有对话优先
  “总结会话 / 列下一步 / 提炼产物”；有产物时优先“解释变更 / 提交说明 / 列下一步”。
- Run 运行时在 Composer 上方显示明确状态条和停止按钮，而不是只依赖发送按钮变成红色。
- 手机宽度下使用全屏 shell，去掉桌面预览容器的边框、圆角和投影。

仍然不应在前端假装完成的能力：

- 真正撤回消息需要 Runtime 支持消息修订和 run cancel 的原子语义。
- 真正重新生成需要分支 Run 或 message version，而不是只用新提示词模拟。
- 真正接受 / 回退变更需要变更集 apply / rollback API，并和 Desktop Changes 面板共享状态。

## 第五轮：历史提问导航

Desktop AI Chat 的 overview rail 提供“上问 / 下问 / 历史 user 消息”能力，解决的是长会话
里快速回看用户自己曾经提出过什么需求。Mobile 不适合照搬显眼右侧工具条，本轮采用
“右侧留白提问索引 + 顶部全文搜索”的组合：

- 对话内容右侧预留一条窄 gutter，把低存在感提问点放进留白里，不压正文。
- 提问索引只抽取 `role=user` 消息，不混入 assistant、
  reasoning 和 tool result。
- 每个点的视觉尺寸很小，但按钮热区足够大；点击点直接滚动到对应用户提问。
- 右侧不再放额外搜索按钮，避免和顶部全文搜索重复。
- 顶部全文搜索负责查找任意内容；右侧点阵只负责快速回到某一轮用户提问。
- 当前正在浏览的用户消息在点阵里以轻量选中态标识，滚动对话时会同步更新。

这个入口和全文搜索分工不同：

- 全文搜索用于找任意内容，包括回答、工具名和执行结果。
- 历史提问索引用于快速回到某一轮用户需求，复用和编辑仍通过消息长按操作完成。

## 第六轮：视觉语言与对话密度

本轮不继续增加功能入口，而是统一视觉层级。参考 Codex 对任务状态的稳定呈现、Claude
对正文与执行过程的渐进披露，以及成熟移动工具的单一 Composer 模式，确定为“安静的技术
编辑器”方向：

- 中性白与浅灰作为阅读画布，深墨色承载正文，青绿色只用于选中、运行和成功状态。
- 会话列表移除重复的对话图标和外层卡片，用标题、摘要、时间和轻量进入提示建立层级。
- Conversation 详情不再显示重复的一级底部导航，通过返回按钮回到会话列表。
- Reasoning 与连续 Tool Call 合并为同一执行轨迹，默认只展示工具名、状态和一行摘要。
- Assistant 正文保持无卡片排版，补齐行内代码、引用、列表、标题和代码块的阅读节奏。
- Composer 合并输入、附件、模型/权限与发送按钮，避免配置条和输入框形成多层工具栏。
- 空会话只保留一个明确问题和上下文快捷项，不展示功能说明或产品宣传文案。
- 390px 手机视口和 1024px 桌面预览均不得出现页面级横向溢出。

## 第七轮：全局 Precision Utility 视觉系统

上一轮只显著改变了会话列表和对话内容，`工作`、`终端`、`更多` 与二级设置页仍沿用
“圆角分组列表 + 彩色方块图标 + 独立描边按钮”的旧式移动设置页语言。本轮参考：

- [Linear 2026 视觉刷新](https://linear.app/now/behind-the-latest-design-refresh)：
  降低导航权重、减少无必要的图标底板和分隔线，让结构“被感知”而不是“被画出来”。
- [Vercel 2026 Dashboard 导航](https://vercel.com/changelog/dashboard-navigation-redesign-rollout)：
  移动端使用单手可达的浮动底栏，并按高频开发工作流排序入口。
- [Vercel 2026 Deployments List](https://vercel.com/changelog/redesigned-deployments-list)：
  提高列表密度，让状态、时间与对象名称能在一次扫视中建立关系。

最终采用 `Precision Utility` 方向，而不是追逐玻璃、渐变或大面积深色：

- 所有非对话列表改为边到边的信息流，移除外层圆角卡片。
- Row icon 取消彩色方形底板；颜色只表示运行、成功、警告和失败。
- Badge 从填充胶囊改为“状态点 + 文字”，降低标签对标题的干扰。
- Segmented Control 改为紧凑页签和底部指示线，数量使用弱化的等宽数字。
- 一级导航改为浮动 dock，当前入口用深色图标底座标识，不再给整格铺背景。
- `更多` 改成开放式双列工具目录，奇数末项自动跨列，避免设置页式分组卡。
- 自动化列表、终端列表、Skills、模型和设置页共享同一行高、图标尺寸和分隔规则。
- 定时任务目标使用 Markdown 渲染并支持展开，避免把 `##` 等源标记直接展示给用户。

## 第八轮：会话级模型、工具与 Skills

Composer 底部只保留当前模型、已启用工具数和已启用 Skills 数，三个入口都可以直接打开
会话配置面板。配置更新遵循以下边界：

- 模型和工具策略持久化到当前 Runtime Session，不修改 `interactive.default` 全局默认值。
- Skills 默认继承 Runtime 全局快照；用户首次调整后写入当前 Session 的 Skills 覆盖列表。
- 新配置从下一次 Run 开始生效，历史 Run 继续保留各自创建时的模型与策略。
- 活动 Run 期间允许查看配置，但禁止修改，Runtime 同时返回 `409` 防止并发写入。
- 启用高权限或外部操作工具前继续显示确认；需要审批或白名单的工具保持不可直接启用。
- 移除 Composer 上方重复的执行状态条；运行过程继续显示在消息流中，停止操作保留在发送按钮。

## 第九轮：Run 执行过程聚合

同一个 Run 会产生多个 assistant/tool 回合。此前 Live Projection 把它们放在一个过程容器，
Run 完成后 canonical transcript 却逐条渲染，造成完成前后结构跳变和卡片碎片化。

- 完成态按 `runId` 合并 reasoning、tool calls 与 tool results。
- 运行中保持展开，让用户看到当前步骤；完成后默认收起成“已完成 N 个步骤”。
- 摘要行展示工具类型与次数，例如“思考 · webSearch · webFetch ×2”。
- 最终回答始终独立、默认展开；中间的“继续搜索”“正在抓取”等叙述不再伪装成独立回答。
- 点击过程摘要后仍可逐项查看思考、参数、结果和失败状态。

## 第十轮：移动视口兼容

部分旧 Safari、Android WebView 和内嵌浏览器不能可靠处理 `100dvh`。如果同时锁定
`body` 滚动，Mobile Shell 会失去确定高度，表现为底栏落出可视区、内部列表无法滚动。

- CSS 使用 `100vh` 作为无 JavaScript 回退，根节点显式建立 `height: 100%` 高度链。
- 客户端通过 `visualViewport.height` 同步 `--app-height`，覆盖地址栏、横竖屏和软键盘变化。
- 不支持 `visualViewport` 时回退到 `window.innerHeight`。
- 根列表和消息列表启用旧 WebKit 惯性滚动，底栏保持独立 flex 区域并设置明确层级。
- 回归视口至少覆盖 `320x568`、`393x852` 与桌面 Mobile Shell。
