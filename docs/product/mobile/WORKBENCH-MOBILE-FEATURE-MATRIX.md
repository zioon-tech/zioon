# Workbench 到 Mobile Client 功能取舍矩阵

- 状态：Draft
- 日期：2026-09-07
- 目的：明确哪些 Workbench 能力进入 Mobile Client、采用何种形态，以及哪些能力明确留在桌面。
- 依据：当前 `core-observability` worktree 的核心命令、Activity Bar、Side Bar、
  Auxiliary Bar、Bottom Panel、Settings 与插件实现。

## 1. 结论

Mobile Client 不按 Workbench 的插件位置复制界面，而按用户任务重新聚合：

| Mobile 一级入口 | 聚合能力 |
| --- | --- |
| 对话 | Session、消息、模型、工具模式、上下文、Thinking、Tool Card、Artifact |
| 工作 | Run、Approval、Agent Task、Todo、Scheduler、运行日志 |
| 终端 | Terminal Manager、Enhanced Terminal、连接状态与快捷键 |
| 更多 | Files、Changes、Comments、Skills、Plugins、Models、Identity、Memory、Devices、Settings |

桌面插件的注册位置只代表桌面布局，不决定移动端入口。移动端应通过结构化
`mobile contribution` 或核心映射表呈现能力。

## 2. 优先级定义

| 优先级 | 定义 |
| --- | --- |
| P0 | 移动端核心闭环，没有它就无法完成远程对话与控制 |
| P1 | 高频辅助能力，Beta 前应具备 |
| P2 | 低频管理或诊断能力，可进入高级页面 |
| Desktop | 依赖复杂编辑、鼠标或多栏布局，不进入 Mobile Client |

## 3. 会话与对话

| Workbench 能力 | 当前实现 | 移动价值 | Mobile 形态 | 优先级 |
| --- | --- | --- | --- | --- |
| 会话列表与切换 | `dev.session-manager` Sidebar | 核心入口 | 全屏列表、搜索、状态分组 | P0 |
| 新建会话 | `zion.sessions.new` | 核心 | 顶部新建按钮，直接聚焦 Composer | P0 |
| 重命名 | `zion.sessions.rename` | 高频整理 | 会话菜单内联编辑 | P1 |
| 删除 | `zion.sessions.delete` | 必要管理 | 危险操作确认页 | P1 |
| Clone / Fork | Session commands | 复杂任务延续 | 会话菜单，解释差异 | P1 |
| 文件夹与标签树 | Session Sidebar | 桌面信息密度高 | 筛选抽屉，不常驻 | P1 |
| 活动热力图 | Session Sidebar | 低频洞察 | 会话统计页 | P2 |
| Import / Export | Session commands | 迁移与备份 | 系统文件选择/分享 | P2 |
| 多标签页 | Editor tabs | 手机价值低 | 不保留；使用页面返回栈 | Desktop |
| 多面板分屏 | PanelManager | 手机不可用 | 不进入移动端 | Desktop |
| 文档源码编辑 | CodeMirror | 不符合移动聊天心智 | 结构化消息流 | Desktop |
| Chat Run / Stop / Retry | `dev.langchain-chat` | 核心 | Composer 发送/停止、错误卡片重试 | P0 |
| 模型切换 | Model Switcher | 高频 | Composer 底部抽屉 | P0 |
| Thinking effort | Chat model controls | 有用但次级 | 模型详情中的强度选项 | P1 |
| Tool enablement | `dev.tools` | 重要安全控制 | 工具模式 + 工具明细抽屉 | P0 |
| Context 资源 | `dev.tools.context` | 直接影响回答 | Composer 上下文抽屉 | P0 |
| Thinking Card | `dev.thinking` | 需要观察过程 | 默认折叠摘要 | P0 |
| Tool Call Card | Chat annotations | 需要观察执行 | 状态卡片，可展开参数与结果 | P0 |
| Sticky user header / overview rail | 编辑器导航插件 | 长会话有价值 | “上一问/下一问/回到最新” | P1 |
| Slash commands | `dev.slash-commands` | 熟练用户有价值 | Composer `/` 菜单 | P1 |
| Roles 行编辑 | `dev.roles` | 依赖文档语法 | 不暴露；由结构化消息模型处理 | Desktop |

## 4. 工作、运行与自动化

| Workbench 能力 | 当前实现 | 移动价值 | Mobile 形态 | 优先级 |
| --- | --- | --- | --- | --- |
| Run 日志 | `core.output` Bottom Panel | 核心观测 | 工作 > Run 列表与详情 | P0 |
| Run 状态与控制 | Run Ledger | 核心控制 | 运行、等待、失败、完成分组 | P0 |
| Approval | 架构要求，部分流程已有 | 核心安全动作 | 高优先级审批详情页 | P0 |
| Todo 列表 | `dev.task-panel` | 适合移动追踪 | 工作 > 任务，支持状态推进 | P1 |
| Agent Task | `dev.agents` | 远程委派价值高 | 工作 > 任务，显示执行者和结果 | P1 |
| Scheduler | `dev.scheduler` | 远程管理价值高 | 工作 > 定时，启停与立即运行 | P1 |
| Context compression 状态 | `dev.context-compression` | 长会话维护 | 会话健康摘要与手动压缩 | P1 |
| 原始 Run Event | Run Log / LLM Payloads | 诊断价值 | Run 详情 > 高级诊断 | P2 |
| LLM 完整请求 | `dev.llm-payloads` | 仅调试 | 开发者模式只读 Viewer | P2 |

“工作”使用三级分段：

```text
运行 | 任务 | 定时
```

- 运行：Run 与 Approval；
- 任务：Agent Task 与 Todo；
- 定时：Scheduler Task 与执行历史。

## 5. 终端与资源

| Workbench 能力 | 当前实现 | 移动价值 | Mobile 形态 | 优先级 |
| --- | --- | --- | --- | --- |
| 终端发现/创建/关闭 | `dev.terminal-manager` | 核心 | 终端列表页 | P0 |
| PTY 交互 | `dev.terminal-enhanced` | 核心 | 全屏终端 | P0 |
| WebRTC / Relay 状态 | Terminal service | 核心诊断 | 顶部明确显示直连或中转 | P0 |
| 终端历史与搜索 | Enhanced Terminal | 高频 | 终端菜单 | P1 |
| 虚拟控制键 | 移动端新增 | 必需 | Esc/Ctrl/Alt/Tab/方向键 | P0 |
| 当前 cwd | Terminal Manager | 必需 | 列表和标题显示 | P0 |
| 切换上下文注入 | Terminal context | 有价值 | 终端详情开关 | P1 |
| 多终端平铺 | Desktop panel | 手机不可用 | 不进入移动端 | Desktop |

## 6. 文件、Changes 与 Context

| Workbench 能力 | 当前实现 | 移动价值 | Mobile 形态 | 优先级 |
| --- | --- | --- | --- | --- |
| 文件树 | `dev.tools.files` | 查看结果 | 文件页，按需展开目录 | P1 |
| 文本/Markdown/图片/PDF 预览 | Files + Inspector | 核心结果查看 | 全屏 Viewer | P0 |
| Session Changes | `dev.tools.changes` | 核心审查 | 文件 > Changes 分段 | P0 |
| Diff 摘要 | Changes Panel | 核心 | 文件数、增删行、风险摘要 | P0 |
| Accept / Revert | Search Replace Plus | 高风险但有价值 | Change 详情 + Approval | P1 |
| Context 文件/目录/URL | Context Panel | 高频 | Composer 上下文抽屉 | P0 |
| 文件授权根目录 | `dev.fs-manager` | Owner 管理 | 设备设置中的高级项 | P2 |
| 搜索替换 | `dev.search-replace` | 依赖编辑器 | 不进入移动端 | Desktop |
| 批量编辑和 gutter 操作 | Gutter / SRP | 依赖精确编辑 | 只显示结果，不提供编辑器操作 | Desktop |
| Editor Inspector | Workbench Inspector | 作为容器无移动价值 | 映射为独立 Viewer 页面 | Desktop |

## 7. 知识、身份与协作

| Workbench 能力 | 当前实现 | 移动价值 | Mobile 形态 | 优先级 |
| --- | --- | --- | --- | --- |
| Skills 目录 | `dev.skills` | 理解 Agent 能力 | Skills 列表、状态和详情 | P1 |
| Skills 扫描与同步 | `skills.scanNow` | 远程排障 | 刷新动作与同步状态 | P1 |
| Skills 路径配置 | Skills 设置 | 低频且路径复杂 | Owner 高级设置 | P2 |
| Memory 列表 | `dev.memory` | 查看长期记忆 | 知识页列表与搜索 | P1 |
| 新建 Memory | `memory.create` | 快速记录有价值 | 简化表单 | P1 |
| Memory 文件编辑 | Memory editor | 编辑复杂 | 首版只读，后续简化编辑 | P2 |
| Biography 时间线 | `dev.identity` | 了解 Agent 认知 | 知识页时间线 | P1 |
| Working Projects | Identity | 远程推进价值高 | 项目状态与请求卡片 | P1 |
| Identity 自动推进审批 | Identity | 与 Approval 重合 | 统一进入 Approval Center | P1 |
| Comments 列表与回复 | `dev.comments` | 移动审阅价值高 | 评论 Inbox 与线程页 | P1 |
| 从编辑器选区创建评论 | Comments | 依赖精确选区 | 不进入首版 | Desktop |

Mobile 的“知识”页面聚合 Identity 与 Memory，但不合并二者的数据模型。

## 8. 插件、模型与设置

| Workbench 能力 | 当前实现 | 移动价值 | Mobile 形态 | 优先级 |
| --- | --- | --- | --- | --- |
| 模型选择 | `dev.langchain-chat` | 核心 | Composer 与模型页 | P0 |
| 模型 Profile 状态 | Runtime model profile | 排障必要 | 可用性、能力和默认状态 | P1 |
| API Key 配置 | Models Settings | Owner 必需 | 受保护表单，不回显 secret | P1 |
| 插件列表与启停 | `dev.plugins` | 远程维护 | 插件状态页 | P1 |
| 移动兼容性 | 当前无 manifest 字段 | 必需新增 | “移动可用/仅桌面/Runtime”标签 | P1 |
| 插件安装 | Plugins | 风险较高 | Owner 操作 + 来源确认 | P2 |
| 插件开发与热重载 | Plugins | 桌面开发能力 | 不进入移动端 | Desktop |
| 设备与远程访问 | Core Settings | 核心 | 设备状态、配对、吊销 | P0 |
| Mail 配置 | `dev.mail` | 低频 | 设置 > 通知与邮件 | P2 |
| Service Base URL | `dev.service-baseurl` | 管理员排障 | 开发者设置 | P2 |
| 主题、语言、通知 | Core / editor config | 移动有价值 | 移动设置 | P1 |
| 编辑器外观、Vim、行号 | Editor Settings | 移动无价值 | 不进入移动设置 | Desktop |
| Theme Demo | `dev.theme-demo` | 开发示例 | 不进入产品 | Desktop |

## 9. 明确不进入移动端的能力

以下能力不能因为“Workbench 已经有”就自动出现在 Mobile Client：

- Panel split、拖拽 resize、编辑器 tabs；
- CodeMirror、Monaco、Vim、行号、fold gutter；
- WYSIWYG 切换、Markdown TOC 插入；
- 选区工具栏、gutter actions；
- 搜索替换编辑器与批量 diff 编辑；
- Editor 导出 PNG/PDF；
- 插件开发会话和热重载；
- 原始 LLM payload 作为一级入口；
- Activity Bar、Sidebar、Auxiliary Bar、Bottom Panel 本身。

必要时保留这些能力产生的结果，例如 Diff、Artifact、评论或 Run 日志，但必须使用移动
页面重新呈现。

## 10. Demo 必须覆盖

### P0 完整路径

- 会话列表、搜索、新建与消息发送；
- 模型、工具模式和上下文选择；
- Thinking、工具调用、Todo 和 Changes 卡片；
- 工作中心的 Run 列表、详情、停止和 Approval；
- 终端列表、直连状态、命令输入和虚拟按键；
- 文件、Diff 和设备状态。

### P1 可感知路径

- Agent/Todo 任务；
- 定时任务；
- Skills 列表与详情；
- 插件移动兼容性；
- 模型 Profile；
- Identity/Memory；
- 评论 Inbox；
- 移动设置。

P1 页面可以使用 mock 数据，但必须具备真实的信息层级、状态和主操作，不能只显示
“后续实现”Toast。

## 11. 正式实现边界

### 11.1 共享

- `runtime-client`；
- Session/Run/Approval/Device Service 类型；
- 认证与错误模型；
- i18n；
- 主题 token；
- 基础 Icon/Button/List/Sheet 组件。

### 11.2 不共享

- Desktop Workbench DOM；
- PanelManager；
- CodeMirror 与编辑器 extensions；
- 桌面插件 View；
- localStorage 业务状态；
- 浏览器端 Agent loop。

### 11.3 新增协议

正式实现前至少补齐：

- Session Message Projection；
- 幂等 Message Command；
- Mobile Contribution 描述；
- Approval API；
- Resource Host 显式标识；
- Changes/Artifact 移动 projection；
- Scheduler、Todo、Agent Task 的统一工作摘要。
