# PRD-02：Zion 移动对话与会话

- 状态：Draft
- 日期：2026-09-06
- 产品形态：独立 Mobile Client 的核心对话体验
- 上位文档：[PRD-01：Mobile Workbench 总体体验](./PRD-01-MOBILE-WORKBENCH-SHELL.md)
- 依赖：
  - Runtime Session Event Feed
  - Client Run Projection Stream
  - Session Message Projection
  - Session Message Command API
  - Session Document Projector

## 1. 产品摘要

移动对话用于在手机上创建、观察和继续 Zion Session。它是独立前端，采用普通消息流
和固定 Composer，bundle 中不包含 CodeMirror、Yjs editor binding 或桌面面板系统。

移动端仍操作与桌面相同的 Session：

- Runtime 持有 Session、Run 和耐久事件；
- Canonical Transcript 是已执行 Run 的不可变输入与输出记录；
- Collaborative Document 是可编辑、可协同的桌面文档表面，不是 Mobile 的读取 API；
- Mobile Client 根据 Runtime 的结构化 message/run projection 渲染消息、工具、
  审批和结果；
- 最终回答由 Runtime 的 Session Document Projector 提交到协同文档。

### 1.1 前端边界

Mobile Conversation 独立实现：

- Session List；
- Message Timeline；
- Composer；
- Thinking、Tool、Approval 和 Artifact Card；
- Run 状态恢复与移动端通知。

它不导入 Desktop Workbench 的：

- `EditorCore`；
- CodeMirror extension；
- Panel、Tab、Activity Bar 或 Inspector；
- `user ` / `assistant ` 行解析器；
- 编辑器自动插入尾部用户行的逻辑。

共享代码仅限 Runtime Client、协议类型、权限判断、i18n、主题 token 和无状态展示基础。

### 1.2 必需的 Runtime 产品接口

独立 Mobile Client 需要结构化能力，而不是读取和修改原始协同文档：

| 能力 | 输入 | 输出 |
| --- | --- | --- |
| Session 列表 | cursor、筛选 | Session 摘要与下一页 cursor |
| Message Projection | sessionId、cursor | 稳定 message ID、角色、内容、卡片引用和状态 |
| 提交消息 | sessionId、`clientRequestId`、内容、附件、运行选项 | message ID、run ID 和接受状态 |
| 活动 Run | sessionId | 当前 Run 与 projection cursor |
| Run Stream | runId、cursor | 合批后的消息、reasoning、tool 和终态事件 |
| Run 控制 | runId、operation | 幂等的 stop、retry 或 approval 结果 |

提交消息必须由 Runtime/plugin 原子完成：

1. 校验 Session、模型、权限和当前活动 Run；
2. 将结构化用户消息写入 Canonical Transcript；
3. 通过 Session Document Projector 更新桌面协同文档；
4. 创建 Run；
5. 返回稳定 message ID 与 run ID。

Mobile Client 不得通过 `setDoc`、Yjs 文本插入或模拟 CodeMirror 光标来发送消息。

## 2. 用户问题

当前手机用户要继续一次对话，通常需要：

1. 打开 Workbench；
2. 从桌面式会话树中找到 Session；
3. 理解编辑器标签和正文格式；
4. 定位到 `user` 输入行；
5. 使用桌面 Run 按钮或快捷键发送；
6. 在正文、Thinking 卡片、工具卡片和面板间寻找运行状态。

这条路径对桌面编辑场景合理，但不符合移动聊天心智。用户真正需要的是快速表达目标、
判断执行状态、处理阻塞并查看结果。

## 3. 目标

1. 用户进入已有 Session 后可立即阅读和回复。
2. 输入、发送、停止和重试始终位于拇指可达区域。
3. 流式回答、工具调用和最终持久化状态不会互相重复或跳动。
4. 多端同时打开同一 Session 时，消息顺序和 Run 状态一致。
5. 长会话仍保持流畅，用户可以快速回到最新回答或历史问题。
6. 工具细节渐进披露，但审批和错误不得隐藏。

## 4. 非目标

- 在手机上提供完整 Markdown 源码编辑器；
- 直接订阅 Yjs 文本并在客户端解析角色行；
- 支持任意位置插入或改写历史 assistant 消息；
- 在消息正文中展示全部原始 Run Event；
- 用浏览器本地状态替代 Runtime 的权威 Session；
- 在离线状态下创建一个假装已执行的 Run；
- 首版支持多人聊天、评论线程完整管理或分支可视化。

## 5. 核心用户流程

### 5.1 继续最近会话

1. 用户打开 Mobile Workbench。
2. 系统恢复最近访问的 Session。
3. 页面先显示已缓存消息，再从 event cursor 增量同步。
4. 若 Session 有活动 Run，自动 attach projection。
5. Composer 恢复该设备上的未发送草稿。
6. 用户输入并发送下一条消息。

### 5.2 新建会话

1. 用户点击“新建会话”。
2. 系统立即进入空会话页并聚焦 Composer。
3. 用户输入第一条消息并发送。
4. Runtime 创建 Session 和 Run，标题可以异步生成。
5. 标题更新不影响消息输入和流式回答。

### 5.3 运行中离开并返回

1. 用户发送消息后切换到其他页面或锁屏。
2. Runtime 继续执行。
3. 用户返回时，Client 从最后 event cursor 恢复。
4. 若 Run 已结束，直接显示完整结果。
5. 若 Run 仍在运行，继续消费 projection，不重复已有 token。

### 5.4 处理工具与审批

1. assistant 消息中出现工具调用卡片。
2. 低风险调用自动执行并显示摘要。
3. 高风险调用进入 `waiting_for_approval`，卡片提升为阻塞状态。
4. 用户打开详情，查看来源、目标、参数和影响。
5. 用户批准或拒绝，卡片实时更新。

### 5.5 网络中断后恢复

1. 页面失去网络，顶部和 Composer 显示离线状态。
2. 未发送文本继续保存在本地草稿。
3. 已点击发送但未被 Runtime 确认的请求保留 `clientRequestId`。
4. 恢复网络后先查询请求状态，再决定重试，避免重复 Run。

## 6. 页面结构

```text
┌────────────────────────────┐
│ ‹ 会话标题        状态   ⋯ │
├────────────────────────────┤
│ 日期分隔                   │
│                            │
│ 用户消息                   │
│                            │
│ Assistant 回答             │
│ ┌ Thinking 摘要        › ┐ │
│ ┌ 工具调用：readFile   ✓ ┐ │
│ ┌ Artifact：report.md  › ┐ │
│                            │
│             回到最新回答 ↓ │
├────────────────────────────┤
│ ＋  输入消息…         发送 │
│ 模型       工具模式   上下文 │
└────────────────────────────┘
```

### 6.1 顶部栏

- 返回会话列表；
- 当前会话标题；
- Run 状态或连接异常；
- 更多菜单：重命名、搜索、分享链接、归档、删除。

删除属于破坏性操作，必须进入二次确认页面，不能与重命名并排。

### 6.2 消息区域

- 单列时间线；
- 用户消息与 assistant 消息有清晰角色差异；
- 文本最大阅读宽度在平板上受限，手机上使用可用宽度；
- 代码块、表格和超长路径在消息内部横向滚动；
- 页面本身不得产生横向滚动。

### 6.3 Composer

- 固定在消息区域底部、一级导航上方；
- 输入聚焦后一级导航隐藏；
- 支持 1 至 6 行自动增高，超过后内部滚动；
- 支持附件、模型、工具模式和发送/停止；
- iOS 安全区与软键盘变化后仍完整可见。

## 7. 会话列表需求

### CONV-001：默认排序

- 默认按最后活动时间倒序；
- 运行中、待审批和失败会话可固定在顶部状态区；
- 当前设备上的置顶状态与 Runtime Session 元数据同步；
- 不使用完整标签树占据首屏。

### CONV-002：列表项

每项至少显示：

- 标题；
- 最后一条消息或结果摘要；
- 最近更新时间；
- Run 状态；
- 未查看标记；
- 与 Resource Host 相关的阻塞提示。

列表项整体可点击，更多操作使用独立按钮，触控区域不得重叠。

### CONV-003：搜索与筛选

- 支持按标题和消息内容搜索；
- 支持状态筛选：运行中、待审批、失败、已完成；
- 标签、日期和来源放入筛选抽屉；
- 筛选状态可清除，返回列表后保持。

### CONV-004：新建

- 列表页提供固定或悬浮的新建入口；
- 空状态提供唯一主按钮“新建会话”；
- 新建成功前保留用户首条草稿；
- 重复点击不能创建多个空 Session。

## 8. 消息模型与渲染

### CONV-010：消息类型

移动端至少支持：

| 类型 | 默认表现 |
| --- | --- |
| `user` | 普通消息块，可复制 |
| `assistant` | Markdown 正文，可包含引用对象 |
| `system` | 默认折叠的上下文说明 |
| `reasoning` | 折叠摘要，不默认流式展开 |
| `tool` | 状态卡片 |
| `approval` | 高优先级操作卡片 |
| `artifact` | 文件、Diff、图片或报告卡片 |
| `error` | 可恢复错误卡片 |
| `continuation` | 不直接展示内部 boundary |

### CONV-011：消息状态

用户消息状态：

- `draft`：仅本机存在；
- `submitting`：已发出，等待 Runtime 接受；
- `accepted`：已创建 Run；
- `failed`：提交失败，可安全重试。

assistant 消息状态：

- `streaming`；
- `waiting_for_resource`；
- `waiting_for_approval`；
- `completed`；
- `failed`；
- `aborted`。

状态文案必须描述下一步，不只显示错误码。

### CONV-012：流式回答

- 使用 Client Run Projection Stream；
- 连续 delta 按帧或时间窗合批渲染；
- 自动跟随仅在用户位于底部时开启；
- 用户向上滚动后停止抢占位置，并显示“回到最新回答”；
- Run 完成后以最终 `message.completed` 内容校准；
- 不把临时 token 写入浏览器 Run Ledger 或协同文档；
- 恢复连接后按原始 event sequence 去重。

### CONV-013：Markdown

- 支持标题、列表、引用、链接、代码块、表格、图片和数学公式；
- 代码块显示语言、复制和横向滚动；
- Mermaid 等高成本内容默认显示预览，按需展开；
- 外部链接明确离开当前应用；
- 超长单词、URL 和文件路径不得撑破页面。

### CONV-014：历史定位

- 支持跳到上一条/下一条用户消息；
- 支持回到最新回答；
- 从会话搜索进入时高亮匹配位置；
- 从 Artifact 或 Run 详情返回时恢复原消息锚点；
- 消息锚点使用稳定 ID，不使用易变化的 DOM index。

## 9. Composer 需求

### CONV-020：文本输入

- 默认占一行，最多自动增长至六行；
- 手机上的 Enter 输入换行，点击发送按钮发送；
- 外接键盘支持 `Cmd/Ctrl+Enter` 发送；
- 输入法组合状态下不得误发送；
- 输入字号不小于 16px，避免 iOS 自动缩放；
- 发送后立即清空 Composer，但在提交失败时可恢复原文。

### CONV-021：草稿

- 草稿按 `deviceId + sessionId` 保存；
- 草稿仅保存在当前 Client，不默认跨设备同步；
- 切换 Session 后分别恢复；
- 成功接受消息后删除对应草稿；
- Session 被删除或权限撤销后清理草稿；
- 草稿内容不得进入产品埋点。

### CONV-022：发送

- 发送前必须存在有效 Session、Runtime 连接和非空内容或附件；
- 每次提交生成稳定 `clientRequestId`；
- 按钮在提交中显示进度，不能重复点击；
- Runtime 接受后将本地乐观消息与权威消息合并；
- 连接未知时先查询请求状态，不能直接重复创建 Run。

### CONV-023：停止与重试

- 当前 Session 有活动 Run 时，发送按钮切换为停止；
- 停止必须作用于当前 Session 的当前 Run；
- 停止后保留已生成内容并标记 `aborted`；
- 失败卡片提供重试，默认复用同一用户输入但创建新 Run；
- 重试必须明确模型、工具模式或资源条件是否发生变化。

### CONV-024：附件

首版支持：

- 图片；
- 文本文件；
- 从 Zion Artifact/文件浏览器引用文件。

要求：

- 发送前显示缩略图、文件名、大小和移除动作；
- 上传进度和失败可见；
- 超限在选择后立即提示；
- 不把本机绝对路径发送为展示名称；
- 权限不足或 Resource Host 离线时说明替代方式。

### CONV-025：模型与工具模式

- Composer 次级栏显示当前模型和工具模式；
- 点击后使用底部抽屉选择；
- 模型不可用时阻止发送并给出原因；
- 工具模式至少区分“仅对话”“只读”“可修改”；
- “可修改”不自动等于高风险操作已获批准。

## 10. 工具、Thinking 与结果卡片

### CONV-030：Thinking

- 默认显示一行状态或摘要；
- 运行中可显示活动指示，但不逐 token 展开；
- 用户可展开查看完整可用内容；
- 模型未提供 reasoning 时不显示空卡片；
- `reasoning=summary|none` 必须被尊重。

### CONV-031：工具调用

折叠态显示：

- 工具名称或用户可理解的动作；
- 目标对象摘要；
- 当前状态；
- 耗时；
- 成功、失败或等待原因。

展开态可以显示规范化参数、输出摘要和关联 Artifact。敏感字段默认遮蔽。

### CONV-032：Approval

- 等待审批时卡片不能折叠到不可见；
- 明确显示来源 Session、Run、Resource Host、操作、目标和风险；
- “批准”和“拒绝”使用视觉和位置区分；
- 批准可选择仅本次或策略允许的有限范围；
- 过期、已处理和跨端处理结果实时同步；
- 重复提交必须幂等。

### CONV-033：Artifact

- 图片直接显示安全预览；
- 文件显示类型、大小、来源 Host 和更新时间；
- Diff 显示文件数、增删行与风险摘要；
- 大型内容进入独立 Viewer；
- 下载前检查权限和对象是否仍有效。

## 11. 多端一致性

### CONV-040：权威状态

- Session Directory、Run 和最终消息以 Runtime 为准；
- Mobile 不读取 CodeMirror/Yjs 文本来推断消息或活动 Run；
- 正在生成内容只来自 projection；
- 最终 assistant 内容由 Runtime projector 写入协同文档；
- Mobile 不并发执行终态 document finalization。

### CONV-041：并发发送

- 同一 Session 默认只允许一个交互 Run；
- 其他 Client 发送时收到“会话正在运行”状态；
- 用户可以停止当前 Run 后再发送；
- 后续支持队列时必须显式展示顺序，不静默排队。

### CONV-042：标题与元数据

- 标题、标签、归档和删除经 Runtime command 更新；
- 多端收到 Session event 后增量更新；
- 本地乐观更新失败时回滚并提示；
- 删除中的 Session 不能继续提交 Run。

## 12. 离线与恢复

### CONV-050：离线可读

- 已缓存消息可以只读查看；
- 未缓存历史显示离线占位；
- 附件和 Artifact 不承诺离线可用；
- 页面明确标识内容更新时间。

### CONV-051：离线草稿

- 允许继续编辑草稿；
- 禁用发送并说明“联网后可发送”；
- 网络恢复后不自动发送；
- 用户主动发送时重新检查模型、Session 和权限。

### CONV-052：恢复

- 先恢复 Session event cursor；
- 再恢复当前活动 Run projection；
- 最后刷新资源和 Approval 状态；
- cursor 过期时使用 snapshot reset；
- 恢复期间不重复插入用户或 assistant 消息。

## 13. 通知

支持以下通知：

- Run 完成；
- Run 失败；
- 等待审批；
- 等待 Resource Host；
- Resource Host 恢复后 Run 可继续。

要求：

- 默认只对后台页面或已安装 PWA 推送；
- 点击通知深链到对应 Session 和卡片；
- 通知不包含敏感文件内容或命令参数；
- 用户可以按类型关闭；
- 同一 Run 的重复事件合并。

## 14. 可访问性

- 消息按时间顺序进入可访问树；
- 流式更新不逐 token 打断屏幕阅读器；
- Run 终态使用一次 live announcement；
- 卡片展开状态可通过键盘和辅助技术识别；
- 发送、停止、批准、拒绝有独立可读名称；
- 代码块支持无水平手势时的复制替代；
- 动画遵循 `prefers-reduced-motion`。

## 15. 性能

- 初次只渲染最近 30 条消息；
- 历史向上加载并保持视觉锚点；
- 长消息和大型卡片延迟渲染；
- projection 合批频率不超过屏幕刷新需求；
- 10,000 条历史消息的 Session 仍可在 3 秒内打开最近内容；
- 后台 Session 不订阅正文 token 流，只订阅轻量状态事件。

## 16. 产品指标与埋点

### 16.1 漏斗

```text
mobile_session_opened
  -> mobile_composer_focused
  -> mobile_message_submit_started
  -> mobile_message_submit_accepted
  -> mobile_run_first_projection
  -> mobile_run_terminal
```

### 16.2 质量指标

- 消息提交接受率；
- 重复 Run 率；
- 首 token 延迟；
- projection 恢复成功率；
- 自动跟随被用户主动关闭的比例；
- 草稿恢复成功率；
- Approval 完成时长；
- 长会话内存和滚动性能。

埋点只记录 ID、状态、耗时和粗粒度类型，不记录消息正文。

## 17. 分阶段范围

### MVP

- 最近会话列表；
- 普通消息流；
- 文本 Composer；
- 发送、停止、重试；
- 流式 assistant projection；
- 工具调用折叠卡片；
- Runtime 离线和恢复；
- 本机分 Session 草稿。

### Beta

- 搜索和筛选；
- 图片与文件附件；
- Approval 卡片；
- Artifact Viewer；
- PWA 通知；
- 历史消息窗口化。

### Later

- 会话分支可视化；
- 评论线程移动管理；
- 语音输入；
- 跨设备草稿；
- 离线编辑队列；
- 多 Run 排队。

## 18. 验收标准

1. 用户可在 390px 宽度设备上从最近会话到发送消息不超过两次点击。
2. 输入法候选、换行和发送互不冲突。
3. 软键盘打开后 Composer 和发送按钮完整可见。
4. 用户上滚后流式回答不强制拉回底部。
5. 断网重连不会重复用户消息、assistant 内容或 Run。
6. 同一 Session 在桌面和手机上的最终消息顺序一致。
7. Run 在后台完成后，回到页面可以恢复终态和完整输出。
8. 工具失败、等待资源和等待审批具有不同且明确的状态。
9. 空会话不显示桌面快捷键说明，只显示新建主动作。
10. 10,000 条历史消息不会一次性进入 DOM。

## 19. 依赖与风险

| 风险 | 处理 |
| --- | --- |
| 现有 Session 以编辑文档为主要展示 | Runtime/plugin 增加结构化 message projection |
| Mobile 与 Desktop 形成两套消息语义 | 共用 Canonical Transcript 和服务端 projector |
| 临时流式内容与 Yjs 最终内容重复 | 严格遵循单 document writer |
| 弱网下重复提交 | `clientRequestId` + Runtime 幂等查询 |
| 工具卡片缺少稳定 ID | 依赖 annotations/blocks 稳定锚点演进 |
| 超长 Session 性能下降 | 消息级分页和窗口化 |
| 移动端修改历史消息造成语义冲突 | 首版历史只读，仅允许继续对话 |
