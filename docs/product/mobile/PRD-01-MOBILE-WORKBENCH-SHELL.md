# PRD-01：Zion Mobile Client 总体体验

- 状态：Draft
- 日期：2026-09-06
- 产品形态：独立 Mobile Web Client / PWA
- 适用范围：手机浏览器、安装到主屏幕的 PWA、窄屏桌面窗口
- 关联文档：
  - [PRD-02：移动对话与会话](./PRD-02-MOBILE-CONVERSATION.md)
  - [PRD-03：移动远程操作](./PRD-03-MOBILE-REMOTE-OPERATIONS.md)
  - [ADR-0002：Runtime 实时会话与协同文档](../../architecture/ADR-0002-REALTIME-SESSION-COLLABORATION.md)
  - [ADR-0003：远程访问、设备配对与 Resource Host 通道](../../architecture/ADR-0003-REMOTE-ACCESS-AND-DEVICE-PAIRING.md)

## 1. 产品摘要

Zion Mobile Client 是与 Desktop Workbench 并列的移动交互表面，不是桌面 IDE 的
响应式分支或等比缩小版。
它服务于用户离开主力电脑后的高频需求：

- 查看 Agent 当前在做什么；
- 继续已有会话或快速发起新任务；
- 审批高风险操作；
- 查看结果、Diff、文件和运行状态；
- 在必要时进入远程终端完成短操作。

移动端复用 Runtime 持有的 Session、Run、权限和设备状态。Client 只负责交互与投影，
不成为新的 Agent Runtime，也不复制一套独立业务数据。

### 1.1 已确认产品决策：独立前端

Mobile Client 使用独立的：

- URL 入口和 PWA `start_url`；
- 构建产物与按需加载边界；
- App Shell、路由和页面栈；
- 消息流、Composer、Run、终端和设置组件；
- 移动插件 contribution。

Mobile Client 不加载或复用：

- CodeMirror；
- Desktop Workbench 的 PanelManager 和 SplitLayout；
- Activity Bar、Sidebar、Auxiliary Bar、Inspector 或 Bottom Panel DOM；
- 面向鼠标、右键、拖拽和键盘快捷键的桌面插件 UI。

两端共享：

- 同源认证和 Client identity；
- Runtime Client SDK；
- Session、Run、Event、Approval 和 Device Service 协议；
- i18n、主题 token、图标和无业务状态的基础组件；
- 权限判断、错误分类和遥测 schema。

建议使用同一域名下的稳定入口：

```text
/             Desktop Workbench
/mobile/      Mobile Client
```

首次从手机访问根路径时可以建议进入 `/mobile/`，并记住用户选择。切换产品表面只改变
前端入口，不能创建另一份 Session、Run 或 credential。

## 2. 背景与问题

当前 Workbench 已支持公网 Runtime、跨设备 Session、远程工具和终端，但手机端仍采用
桌面布局模型：

- Activity Bar 被简单搬到底部，入口数量随插件增长并横向滚动；
- Sidebar、Auxiliary Bar 和 Bottom Panel 只是改成覆盖层；
- 会话正文仍是 CodeMirror 文档，发送消息依赖定位 `user` 行和编辑器命令；
- 标签栏、分栏、状态栏和桌面快捷键继续占据移动首屏；
- 控件普遍小于推荐触控尺寸，软键盘和安全区处理不完整；
- 多层面板同时存在，返回路径和当前层级不清晰。

这使“远程打开并继续对话”虽然技术可行，但无法形成稳定、低学习成本的移动工作流。

## 3. 产品目标

### 3.1 目标

1. 用户从冷启动到进入最近会话不超过两次点击。
2. 用户能够单手完成查看回复、发送消息、停止运行和审批操作。
3. 所有主要页面采用单主表面，不要求理解桌面面板系统。
4. 手机、桌面和 CLI 看到同一 Session 与 Run 状态。
5. 网络切换、页面切后台或 Resource Host 离线时，状态必须明确且可恢复。
6. 保留现有桌面 Workbench，不因移动改造降低桌面效率。

### 3.2 成功指标

首个可用版本上线四周后，以完成配对并至少打开过一次移动端的用户为统计范围：

| 指标 | 目标 |
| --- | --- |
| 移动端打开后进入可交互会话的成功率 | >= 98% |
| 首次可交互时间 p75 | <= 2.5 秒 |
| 从启动到发送第一条消息的中位步骤数 | <= 2 |
| 移动端发送消息成功率 | >= 99% |
| 运行状态在多端间可见延迟 p95 | <= 1 秒 |
| 因遮挡、溢出导致的关键操作不可达率 | 0 |
| 7 日内再次使用移动端的用户占比 | 相比现状提升 30% |

## 4. 非目标

首版不建设：

- 手机上的完整 IDE、复杂代码编辑、多人光标或多面板布局；
- 在 Desktop Workbench DOM 中持续增加移动端条件分支；
- 手机作为通用 Resource Host；
- 多租户账号、组织空间或多人权限；
- 桌面所有插件界面的逐像素移动复刻；
- 在移动浏览器内长期后台执行 Agent；
- 在浏览器端直接访问 `127.0.0.1`；
- 用移动 UI 绕过 Runtime、Run Policy、Resource Host grant 或 Approval。

## 5. 目标用户与核心场景

### 5.1 目标用户

**个人开发者 / Owner**

- 已部署自己的 Runtime；
- 一台电脑运行 Device Connector；
- 希望离开电脑后继续控制 Agent；
- 需要管理设备、审批高风险动作和查看运行结果。

**已配对 Client 用户**

- 可以查看和继续会话；
- 可以使用 Owner 已授权的设备能力；
- 不能管理设备配对和吊销。

### 5.2 Jobs to be Done

1. 当我离开电脑时，我希望在手机上继续最近会话，不重新寻找上下文。
2. 当 Agent 请求权限时，我希望看清目标和风险后立即批准或拒绝。
3. 当长任务运行时，我希望快速判断它是在执行、等待资源、等待审批还是失败。
4. 当结果涉及文件、Diff 或终端时，我希望先查看摘要，再按需进入完整视图。
5. 当本地电脑离线时，我希望知道哪些能力不可用，以及恢复后能否继续。

## 6. 产品原则

### 6.1 对话优先

默认首页是最近一次可访问的会话。会话列表是一级页面，不是常驻侧栏。

### 6.2 单表面导航

手机竖屏一次只显示一个主页面。桌面的 Side Bar、Auxiliary Bar、Inspector 和
Bottom Panel 在手机上统一映射为：

- 一级页面；
- 全屏详情页；
- 轻量底部抽屉。

不允许多个面板层叠后仍保留可交互的背景内容。

### 6.3 结果优先，过程渐进披露

回答正文和需要用户处理的动作优先。Thinking、工具日志、原始请求和调试信息默认折叠。

### 6.4 触控优先

- 主要触控目标不小于 44 x 44 CSS px；
- 不依赖 hover、右键、拖拽或键盘快捷键；
- 破坏性操作不得紧邻高频主操作；
- 可滑动区域与系统返回手势不得冲突。

### 6.5 状态诚实

界面明确区分：

- Runtime 在线 / 离线；
- Resource Host 在线 / 离线；
- 终端直连 / 中转 / 重连；
- Run 执行中 / 等待资源 / 等待审批 / 失败 / 完成；
- 本地草稿 / 已提交消息 / 已持久化结果。

## 7. 信息架构

### 7.1 一级导航

底部导航固定四项：

| 入口 | 说明 |
| --- | --- |
| 对话 | 最近会话、搜索、新建和继续会话 |
| 工作 | Run、Approval、Agent/Todo 任务和定时任务 |
| 终端 | Resource Host 上的终端会话 |
| 更多 | 文件与变更、知识、评论、Skills、插件、模型、设备与设置 |

底部导航不直接镜像 Activity Bar。插件需要声明自己的移动呈现方式，未声明时进入
“更多”，不能无限增加一级入口。

### 7.2 页面层级

```text
App Shell
├── 对话
│   ├── 会话列表
│   └── 会话详情
├── 工作
│   ├── Run 列表
│   ├── Run 详情
│   └── Approval 详情
│   ├── Agent/Todo 任务
│   └── 定时任务
├── 终端
│   ├── 终端列表
│   └── 终端详情
└── 更多
    ├── 文件与变更
    ├── Identity 与 Memory
    ├── 评论
    ├── Skills
    ├── 插件
    ├── 设备与远程访问
    ├── 模型
    └── 设置
```

### 7.3 导航规则

- 浏览器 Back 返回上一层，不直接退出当前登录会话。
- 切换一级入口时保留各入口的列表位置和筛选条件。
- 从消息卡片打开文件、终端或 Run 详情后，返回应回到原消息位置。
- 深链接必须可直接定位 Session、Run、Artifact 或 Approval。
- 页面刷新后恢复最近一级入口和详情对象；已失效对象显示明确空状态。

## 8. 设备与断点策略

### 8.1 手机竖屏

- 宽度小于 768px 且主要输入方式为 coarse pointer；
- 单列页面栈；
- 固定底部导航；
- 会话详情显示固定 Composer；
- 所有桌面面板转为全屏页或底部抽屉。

### 8.2 手机横屏

- 保持单主表面；
- 终端可以隐藏底部导航并使用全部可视高度；
- 不自动进入桌面多栏模式；
- Composer、虚拟按键栏和系统安全区仍必须可见。

### 8.3 平板

- 768px 至 1024px 可使用“列表 + 详情”双栏；
- 不默认显示 Activity Bar、Inspector 和 Bottom Panel 的桌面组合；
- 横屏时允许会话列表固定在左侧，详情占据右侧；
- 触控尺寸标准与手机一致。

### 8.4 桌面

继续使用现有 Workbench 多栏、标签、分屏和 CodeMirror 文档体验。

## 9. 核心功能需求

### MWB-001：Mobile Client 入口

- Mobile Client 使用稳定的 `/mobile/` 路由和独立 bundle。
- 手机首次访问 `/` 时可以建议切换，但不得只依赖 User-Agent 强制跳转。
- 用户可以在 Mobile Client 和 Desktop Workbench 间显式切换。
- PWA 安装入口默认使用 Mobile Client。
- 切换入口不重载 Runtime Session、不创建重复 Client credential，也不中断 Run。
- Desktop Workbench 的 `responsiveRuntime` 只负责窄窗口可用性，不承担目标移动产品。

### MWB-002：底部导航

- 固定显示四个一级入口及文字标签。
- 当前入口有颜色、图标和语义状态三重反馈，不能只依赖颜色。
- 键盘弹出时隐藏底部导航，为 Composer 或终端释放高度。
- iOS PWA 和浏览器模式均包含 `safe-area-inset-bottom`。

### MWB-003：顶部栏

- 左侧为返回或当前一级入口；
- 中间显示当前对象标题，单行截断；
- 右侧最多两个高频动作和一个更多菜单；
- 不显示桌面标签栏、分栏按钮、布局按钮或快捷键提示；
- 滚动消息时可收起非必要信息，但返回和运行状态始终可达。

### MWB-004：全局连接状态

- 顶部提供紧凑状态入口；
- 状态至少包含 Runtime、协同连接和当前 Resource Host；
- 正常状态只显示图标或短标签；
- 异常状态必须显示原因和恢复动作；
- 终端连接状态在终端页面单独展示，不能与 Runtime 在线状态混为一谈。

### MWB-005：移动页面容器

- 使用 `100dvh` 或 `visualViewport` 计算可视高度；
- 软键盘弹出后主操作不得被遮挡；
- 页面禁止产生双层纵向滚动；
- 横向滚动仅用于代码、表格和终端，不用于全局导航；
- 浏览器地址栏展开和收起时，不得造成内容跳到不可恢复的位置。

### MWB-006：覆盖层

- 简单选择使用底部抽屉；
- 复杂管理使用全屏页面；
- 抽屉支持点击遮罩、下滑或返回键关闭；
- 任一时刻最多存在一个模态覆盖层；
- 打开覆盖层时背景不可继续操作。

### MWB-007：空状态

- 没有会话时显示“新建会话”主按钮；
- 没有在线 Resource Host 时说明受影响能力，并提供设备状态入口；
- 无搜索结果时保留当前筛选并允许一键清除；
- 不向手机用户展示 `Cmd+T`、`Cmd+Enter` 等桌面提示。

### MWB-008：跨端连续性

- 手机打开 Session 时从 Runtime 获取权威状态；
- 桌面新增消息、完成 Run 或修改标题后，手机实时更新；
- 手机后台恢复后从最后 event cursor catch up；
- 同一 Session 在多端同时编辑时遵循 Yjs/Runtime 既有一致性约束；
- 正在生成的临时 projection 不被误写入持久文档。

### MWB-009：深链接与安装

- 配对链接、Session 链接和 Run 链接可在手机浏览器打开；
- 已安装 PWA 时允许用户选择在 PWA 中继续；
- PWA manifest 使用产品名称和正确主题色；
- 不在 URL query、fragment 或客户端存储中保留长期 credential。

### MWB-010：移动能力注册

插件可以注册以下移动呈现类型：

```ts
type MobileContribution =
  | { kind: "destination"; id: string; title: string; icon: string }
  | { kind: "conversation-card"; cardType: string }
  | { kind: "run-detail"; runKind: string }
  | { kind: "more-item"; id: string; title: string; icon: string };
```

- 未注册移动呈现的桌面 View 不自动进入底部导航；
- 首版可以使用核心映射表兼容现有插件；
- 插件不能自行覆盖安全区、全局返回行为或底部导航。

## 10. 全局状态与异常处理

| 状态 | 产品表现 |
| --- | --- |
| 首次加载 | 显示壳层和骨架，不展示空白画布 |
| Runtime 离线 | 保留已缓存只读内容，禁用发送并提供重试 |
| Session 同步中 | 消息列表保留，标题区显示同步状态 |
| Resource Host 离线 | 对话仍可用；相关工具、终端和文件入口标记不可用 |
| Client credential 失效 | 清除受保护页面并进入重新配对流程 |
| 权限不足 | 解释缺失 scope，不把 403 显示为普通网络失败 |
| 页面更新 | 保留草稿和当前对象，刷新后恢复 |
| 新协议不兼容 | 阻止继续提交，要求刷新并解释原因 |

## 11. 权限与安全

- Owner 才能创建配对邀请、查看完整设备列表和吊销设备。
- 普通 Client 可以使用已授权的 Session、Run 和 Device Service。
- 所有请求使用同源 HTTPS 与 HttpOnly Session Cookie。
- 状态变更请求校验 Origin。
- 移动 UI 不显示完整 credential、配对 secret 或敏感环境变量。
- 截图、剪贴板和下载属于用户设备能力，敏感结果需要明确提示。
- 高风险远程操作必须进入 Approval 流程，不能用“已配对”替代授权。

## 12. 可访问性与本地化

- 满足 WCAG 2.2 AA 的核心交互要求；
- 文字和图标对比度符合主题规范；
- 所有图标按钮有可读名称；
- 支持系统字体缩放到 200%，关键操作不被裁切；
- 屏幕阅读器按“顶部栏、主内容、Composer、底部导航”顺序读取；
- 状态变化通过非打断式 live region 通知；
- 中文和英文均不得依赖固定字符宽度；
- 所有可见字符串进入现有 i18n 系统。

## 13. 性能要求

- 冷启动首个壳层绘制 p75 <= 1 秒；
- 可交互 p75 <= 2.5 秒；
- 首屏不加载终端、设置和非当前插件的大型资源；
- 消息长列表采用窗口化或分段渲染；
- 页面后台时暂停非必要动画、Presence 和高频 projection；
- 单个长会话不因历史消息数量导致线性 DOM 增长；
- 低端手机滚动帧率目标 >= 50 FPS。

## 14. 埋点与诊断

### 14.1 产品事件

- `mobile_shell_opened`
- `mobile_destination_opened`
- `mobile_session_opened`
- `mobile_first_message_sent`
- `mobile_overlay_opened`
- `mobile_back_navigation`
- `mobile_runtime_disconnected`
- `mobile_resource_unavailable`
- `mobile_recovery_succeeded`

事件不得包含消息正文、文件内容、终端输出、credential 或完整路径。

### 14.2 诊断字段

- viewport 分类；
- PWA / browser；
- Runtime protocol version；
- 当前网络类型的粗粒度枚举；
- 最近 event cursor；
- 页面恢复原因；
- 错误分类，不包含敏感 payload。

## 15. 发布阶段

### Phase 0：可用性基线

- 单列壳层；
- 固定四项导航；
- 全屏会话列表；
- 移动空状态；
- 安全区和软键盘适配；
- 隐藏桌面状态栏、分栏和快捷键提示。

### Phase 1：对话优先

- 原生消息流；
- 固定 Composer；
- Run projection、工具卡片和 Approval 卡片；
- 会话搜索、新建、重命名和草稿恢复。

### Phase 2：远程操作

- Run Center；
- 全屏终端；
- 文件和 Artifact 查看；
- 设备状态与 Owner 管理。

### Phase 3：PWA 完整体验

- 推送通知；
- 离线只读缓存；
- 后台恢复；
- 深链接和系统分享；
- 安装引导。

## 16. 验收标准

1. 在 320 x 568、390 x 844、430 x 932 三种视口下无关键内容遮挡或水平页面滚动。
2. 用户可仅用触控完成新建会话、发送、停止、查看 Run 和返回。
3. 软键盘弹出时 Composer 始终完整可见，发送后内容区恢复正确高度。
4. 所有一级入口均有文字标签，不依赖用户记忆插件图标。
5. 任意详情页使用系统返回均回到来源页面及原滚动位置。
6. Runtime 或 Resource Host 断开后 1 秒内展示正确状态。
7. 手机页面不出现桌面快捷键提示、拖拽分隔条或多面板布局按钮。
8. Owner 和普通 Client 的设备管理能力按 scope 正确区分。
9. 刷新页面不会丢失未发送草稿。
10. 桌面 Workbench 的现有多栏交互和快捷键不发生回归。

## 17. 风险与待决策

| 问题 | 建议 |
| --- | --- |
| Mobile 与 Desktop 是否共享前端组件树 | 已决定不共享页面与布局层，只共享 SDK 和基础设施 |
| 历史 Session 如何转成结构化消息 | 由 Runtime/plugin 提供消息 projection，Mobile 不解析原始文档 |
| 是否单独建设原生 App | 先交付 PWA，验证高频场景后再决定 |
| 底部导航中的第四项 | 首版使用“更多”，不要绑定具体插件 |
| 平板是否保留桌面 Activity Bar | 默认不保留，提供显式桌面模式 |
| 离线是否允许编辑并稍后提交 | 首版只保存草稿，不创建离线 Run |
| 多 Resource Host 手动选择 | 依赖设备路由能力，首版只显示实际选中的 Host |
