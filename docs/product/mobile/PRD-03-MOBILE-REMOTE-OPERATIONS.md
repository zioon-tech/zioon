# PRD-03：Zion 移动远程操作

- 状态：Draft
- 日期：2026-09-06
- 产品形态：独立 Mobile Client 的运行、审批、终端、文件与设备管理
- 上位文档：[PRD-01：Mobile Workbench 总体体验](./PRD-01-MOBILE-WORKBENCH-SHELL.md)
- 关联文档：
  - [PRD-02：移动对话与会话](./PRD-02-MOBILE-CONVERSATION.md)
  - [Zion 单租户远程部署](../../architecture/REMOTE-SINGLE-TENANT-DEPLOYMENT.md)
  - [ADR-0003：远程访问、设备配对与 Resource Host 通道](../../architecture/ADR-0003-REMOTE-ACCESS-AND-DEVICE-PAIRING.md)

## 1. 产品摘要

移动远程操作由独立 Mobile Client 提供，让用户在不接触主力电脑的情况下查看
Runtime 与 Resource Host 状态、
处理 Agent 阻塞、操作远程终端、检查文件结果，并管理已配对设备。

它不是远程桌面，也不是把桌面 Workbench 的所有插件面板搬到手机。产品重点是：

- 快速判断系统是否健康；
- 明确一个 Run 正在哪个 Runtime 和 Resource Host 上执行；
- 对高风险操作进行可信审批；
- 在终端和文件视图中完成短、明确、可恢复的操作；
- 在连接降级时让用户知道“慢在哪里”和“哪些能力不可用”。

## 2. 背景

当前远程架构已经支持：

- 同源 HTTPS Workbench 与 Runtime；
- Owner、Client、Resource 三类设备身份；
- Device Connector 通过出站 HTTPS 提供本机能力；
- Runtime 经 Device Service gateway 访问本机工具和插件；
- 终端优先使用 WebRTC DataChannel，失败后回退 HTTP Relay；
- Resource credential、设备吊销和最小 scope；
- Session 与 Run 跨设备同步。

但现有手机体验仍暴露桌面式 Side Bar、Bottom Panel 和设置弹窗，且 Runtime 在线、
Resource Host 在线、终端直连和工具可用性之间缺少清晰区分。

## 3. 目标

1. 用户在 5 秒内判断当前 Run 是否健康以及阻塞原因。
2. 待审批操作从通知或 Run 页面进入后，可在一个页面完成判断与处理。
3. 手机终端在 WebRTC 直连时达到可接受的逐字符反馈，在 Relay 时明确提示。
4. Resource Host 离线时，受影响的工具和文件操作不产生误导性重试。
5. Owner 能安全地查看、配对和吊销设备；普通 Client 不看到不可执行的管理动作。
6. 文件、Diff 和 Artifact 可阅读，但不把手机变成完整代码 IDE。

## 4. 非目标

- 远程桌面或屏幕控制；
- 手机上运行 Device Connector 或暴露本机工具；
- 绕过 Resource Host 本地 grant；
- 在没有 Approval Provider 时开放无人值守高风险写操作；
- 首版支持多设备聚合文件系统；
- 首版支持用户手动合并多个 Resource Host 的数据；
- 在手机上提供复杂 Git GUI、项目级代码编辑或多终端平铺。

## 5. 信息架构

### 5.1 运行

```text
运行
├── 需要我处理
│   ├── 等待审批
│   └── 等待资源
├── 正在运行
├── 失败
└── 最近完成
```

### 5.2 终端

```text
终端
├── 当前 Resource Host
├── 终端会话列表
└── 全屏终端
```

### 5.3 更多

```text
更多
├── 文件与 Artifact
├── Skills
├── 插件
├── 设备与远程访问
├── 模型
└── 设置
```

## 6. 全局状态模型

移动端必须区分以下连接：

| 状态 | 含义 | 影响 |
| --- | --- | --- |
| Client -> Runtime | Workbench 是否连接权威服务 | Session、Run 和设置 |
| Client -> Collaboration | 当前 Session 是否实时同步 | 文档和最终消息 |
| Runtime -> Resource Host | 本机能力是否在线 | 文件、工具、终端发现 |
| Client -> Terminal WebRTC | PTY 是否点对点直连 | 终端交互延迟 |
| Client -> Terminal Relay | PTY 是否经 Runtime 中转 | 可用但延迟较高 |

不得只显示一个笼统的“在线”绿点。

### OPS-001：全局状态入口

- 正常时顶部显示一个紧凑状态图标；
- 任一关键连接异常时显示短文案；
- 点击进入状态详情页；
- 状态详情列出 Runtime、协同、Resource Host 和当前终端通道；
- 每项提供最后成功时间、错误类别和可执行恢复动作。

### OPS-002：能力可用性

- 每个工具入口根据当前授权与 Host presence 计算可用状态；
- 不可用入口保留可见，但显示原因；
- 只有明确永久不适用的能力才隐藏；
- 恢复在线后自动刷新 capability catalog；
- 不将浏览器 Client 误标记为 Resource Host。

## 7. Run Center

### 7.1 列表项

每个 Run 至少显示：

- 用户可理解的标题；
- 来源 Session；
- 当前状态；
- 已运行时间或完成时间；
- 模型；
- 执行位置；
- 当前阻塞原因；
- 工具调用和失败数量摘要。

### OPS-010：状态分组

优先顺序：

1. `waiting_for_approval`
2. `waiting_for_resource`
3. `running`
4. `failed`
5. `completed`
6. `aborted`

同一 Run 只出现在一个分组中。状态变化时列表位置可以变化，但用户正在查看详情时不得
被强制返回列表。

### OPS-011：Run 详情

详情页包含：

- 目标和来源；
- 开始时间、耗时和终态；
- Runtime Host 与 Resource Host；
- 模型与 usage；
- 按时间排序的步骤摘要；
- 工具调用；
- Approval；
- Artifact；
- 错误与恢复建议；
- 停止、重试或返回 Session 的动作。

原始事件日志属于诊断视图，默认不进入主流程。

### OPS-012：运行控制

- 运行中提供停止；
- 等待资源时可以取消或继续等待；
- 失败后可重试；
- 重试创建新 Run，并关联原 Run；
- 已完成 Run 不显示停止；
- 所有控制动作必须幂等并反馈是否由其他 Client 先处理。

### OPS-013：等待资源

当 Resource Host 离线或能力缺失时显示：

- 所需能力；
- 期望 Host；
- 最后在线时间；
- 当前是否允许继续等待；
- 取消 Run；
- 打开设备状态。

首版不得自动选择另一个设备并假装访问相同数据。

## 8. Approval Center

### 8.1 产品原则

Approval 是独立安全边界，不是普通确认弹窗。它必须让用户在手机上理解“谁要在什么
设备上，对什么资源，执行什么操作”。

### OPS-020：审批内容

审批详情至少包含：

- Session 与 Run；
- 请求发起时间和过期时间；
- Runtime Host；
- Resource Host；
- 工具和规范化 operation；
- 目标路径、终端、收件人或外部服务；
- 关键参数摘要；
- 风险级别；
- 预期影响；
- 请求所依据的 Policy。

敏感值默认遮蔽，但用户可以在明确操作后查看。

### OPS-021：审批动作

- `批准本次`；
- `拒绝`；
- 后续版本可提供有边界的临时授权；
- 不提供无期限“永远允许”；
- 批准和拒绝不能仅靠颜色区分；
- 重复点击、跨端处理和过期均返回明确终态。

### OPS-022：审批通知

- 通知点击后直达审批详情；
- 锁屏通知不显示完整命令、路径或正文；
- 已由其他 Client 处理的通知自动失效；
- 高风险审批不支持从通知快捷按钮直接批准。

### OPS-023：审批审计

记录：

- Approval ID；
- operation 摘要；
- 请求与处理时间；
- 决策；
- 决策 Client；
- 绑定 invocation ID；
- 最终执行结果。

审计视图不显示 credential 或未脱敏 secret。

## 9. 移动终端

### 9.1 页面结构

```text
┌────────────────────────────┐
│ ‹ 终端名       直连  设备 ⋯ │
├────────────────────────────┤
│                            │
│        Terminal Canvas     │
│                            │
├────────────────────────────┤
│ Esc Ctrl Alt Tab  ↑  ↓  ⌨ │
└────────────────────────────┘
```

进入终端详情后隐藏全局底部导航，避免与终端键盘栏竞争空间。

### OPS-030：会话列表

- 显示当前 Resource Host；
- 显示会话名称、cwd、状态和最后活动时间；
- 支持创建、切换和关闭；
- 关闭终端属于破坏性操作，需要确认；
- Resource Host 离线时保留只读列表和最后状态。

### OPS-031：连接建立

1. Client 通过 Runtime 完成鉴权和信令。
2. 优先协商 WebRTC DataChannel。
3. 建立成功后显示“直连”。
4. ICE/STUN 超时后自动回退 Relay。
5. Relay 模式显示“中转”，并说明可能存在延迟。
6. 网络恢复时可以重新协商，但不得丢失终端 Session。

普通 Client 使用终端业务接口所需的已授权 scope；终端和设备管理接口不得混淆。

### OPS-032：输入

- 点击终端画布聚焦系统键盘；
- 提供 `Esc`、`Ctrl`、`Alt`、`Tab`、方向键和收起键盘；
- 组合键采用锁定一次或按住两种可理解状态；
- 支持粘贴，并在超长或多行命令前提示；
- 不默认启用自动纠错和首字母大写；
- 支持横屏；
- 不把输入逐字符写入产品日志。

### OPS-033：显示

- 自动适配可视行列；
- 键盘打开、地址栏变化和旋转后重新发送 resize；
- 字号可调，默认不小于 13px；
- 支持滚动历史、复制和搜索；
- 用户查看历史时，新输出不强制滚到底部；
- 提供“回到底部”动作。

### OPS-034：连接状态

至少区分：

- 正在连接；
- WebRTC 直连；
- Relay 中转；
- 正在重连；
- Resource Host 离线；
- credential 或 scope 被拒绝；
- Session 已关闭。

逐字符回显延迟指标需要按直连和中转分别统计。

### OPS-035：安全

- Web 页面不得连接 `127.0.0.1`；
- WebRTC 信令和 Relay 均经 Runtime 鉴权；
- DataChannel 到期后重新协商；
- Resource credential 被吊销时立即关闭通道；
- 终端切换必须受 Resource Host grant 限制；
- App 进入后台时保持有限时间连接，超时后安全重连。

## 10. 文件与 Artifact

### OPS-040：文件浏览

- 显示当前 Resource Host 和 workspace；
- 支持目录浏览、搜索和最近文件；
- 首版默认只读；
- 大目录分页加载；
- 离线时保留路径上下文，不显示陈旧内容为最新；
- 路径显示可以缩略，但详情可复制。

### OPS-041：Viewer

支持：

- Markdown；
- 纯文本和代码；
- 图片；
- PDF；
- Diff；
- Run Artifact。

要求：

- 全屏显示；
- 代码和表格内部横向滚动；
- 超大文件使用截断预览并显示已加载大小；
- 下载和分享需要明确动作；
- 返回恢复来源 Session 或 Run 的消息位置。

### OPS-042：文件修改

MVP 不提供自由编辑。后续若支持：

- 必须显示目标 Host 和 workspace；
- 使用明确的 Save；
- 冲突使用 revision/ETag 检测；
- 写入遵循 Run policy、Resource grant 和 Approval；
- 不允许把移动端缓存静默覆盖较新文件。

### OPS-043：多设备限制

当前 Runtime 可能按 `nodeId` 选择第一个在线 Connector。产品必须：

- 显示实际执行或浏览所使用的 Resource Host；
- 不宣称内容来自全部设备；
- 多设备手动选择未实现前，不展示无效选择器；
- 如果自动选择结果与 Session 预期 workspace 不一致，阻止高风险操作并提示。

## 11. Skills、插件与模型

### OPS-050：Skills

- 列表显示可用、不可用和来源 Host；
- 支持搜索和查看详情；
- 同步失败显示 Resource Host、服务和权限原因；
- 手机上以使用和状态查看为主，不提供复杂文件编辑。

### OPS-051：插件

- “更多”中的插件页面展示移动可用能力；
- 插件包仍通过 Runtime/Connector 的同源 Device Service 获取；
- 未声明移动 UI 的插件显示“仅桌面可用”；
- 插件错误不得导致整个移动壳层不可用；
- 插件不能直接请求手机浏览器的 localhost。

### OPS-052：模型

- 显示当前默认模型和可用状态；
- 支持切换已配置 Profile；
- API Key 只通过受保护设置流程写入，不回显完整值；
- Profile 导入失败需要区分权限、格式、Runtime 版本和网络错误；
- 模型选择在 Session、Run 和 Composer 中保持一致。

## 12. 设备与远程访问

### OPS-060：角色可见性

| 功能 | Owner | Client |
| --- | --- | --- |
| 查看自身设备 | 是 | 是 |
| 使用已授权 Device Service | 是 | 是 |
| 查看完整设备列表 | 是 | 否 |
| 创建 Client 配对 | 是 | 否 |
| 创建 Resource 配对 | 是 | 否 |
| 吊销设备 | 是 | 否 |

### OPS-061：设备列表

Owner 看到：

- 设备名称与类型；
- `deviceId` 的缩略值；
- 在线状态；
- 最后使用时间；
- scope 摘要；
- 当前能力；
- 吊销入口。

默认不显示 credential、摘要值或内部数据库字段。

### OPS-062：配对

- 创建邀请前选择 Client 或 Resource；
- 显示二维码、人工短码、有效期和单次使用说明；
- QR secret 仅位于 URL fragment；
- 配对完成后邀请立即变为已使用；
- 截图或分享配对信息前提示其短期敏感性；
- Resource 配对提供可复制的 Connector 命令。

### OPS-063：吊销

- 显示受影响能力；
- 二次确认目标设备；
- 吊销后新的 HTTP、poll、Yjs 和 WebRTC 协商必须失败；
- 页面实时更新；
- 已吊销设备重新接入必须创建新邀请。

## 13. 异常与恢复

| 场景 | 用户体验 |
| --- | --- |
| Runtime 不可达 | 全局离线页，保留缓存只读内容 |
| Resource Host 不在线 | 对话可继续；工具、终端和文件标记不可用 |
| local-tools 不可达 | 显示 Host 在线但工具服务异常 |
| plugin service 不可达 | 插件入口显示同步失败，不影响核心对话 |
| WebRTC 失败 | 自动进入 Relay，并显示连接模式 |
| Relay 延迟高 | 保持可用，显示延迟提示和重连直连动作 |
| scope 不足 | 显示缺失权限和角色，不循环重试 |
| credential 吊销 | 关闭受保护通道并进入重新配对 |
| Run 等待资源 | 保留 Run，展示 Host 和取消动作 |
| Approval 过期 | 卡片显示过期，禁止继续提交决策 |

## 14. 安全与隐私

- Runtime 和 Workbench 保持同源 HTTPS；
- Browser 使用 HttpOnly、Secure、SameSite Cookie；
- Resource Host 只建立出站连接；
- 终端与工具调用始终经过 Runtime 鉴权；
- Resource Host 对 workspace、terminal 和工具范围做本地二次校验；
- 高风险操作绑定 Approval 和 invocation ID；
- 日志与埋点不记录命令正文、终端输出、文件内容和 credential；
- 配对和吊销写入审计事件；
- 不通过放宽 CSP 或 PNA 访问 localhost。

## 15. 性能与可靠性

### 15.1 目标

| 指标 | WebRTC | Relay |
| --- | --- | --- |
| 终端连接成功率 | >= 95% 可协商网络 | >= 99% |
| 首次可输入时间 p75 | <= 2 秒 | <= 4 秒 |
| 本地按键回显 p75 | <= 120ms | <= 450ms |
| 状态变化可见延迟 p95 | \- | <= 1 秒 |
| Approval 提交成功率 | \- | >= 99.5% |

### 15.2 可靠性

- Terminal input/output 保持有序；
- 断线重连不重复提交控制命令；
- Invocation 使用 lease、cancel 和 receipt；
- 页面刷新不关闭服务端终端 Session；
- Resource Host 重连后 capability catalog 自动恢复；
- 慢客户端不得形成 Runtime 无界队列。

## 16. 埋点

### 16.1 运行与审批

- `mobile_run_center_opened`
- `mobile_run_detail_opened`
- `mobile_run_stop_requested`
- `mobile_run_retry_requested`
- `mobile_approval_opened`
- `mobile_approval_decided`

### 16.2 终端

- `mobile_terminal_connect_started`
- `mobile_terminal_transport_selected`
- `mobile_terminal_reconnected`
- `mobile_terminal_resize`
- `mobile_terminal_closed`

### 16.3 设备与文件

- `mobile_resource_status_opened`
- `mobile_resource_unavailable`
- `mobile_artifact_opened`
- `mobile_pairing_created`
- `mobile_device_revoked`

埋点参数仅包含 ID、状态、耗时、传输模式和错误类别。

## 17. 分阶段范围

### MVP

- Run 列表与详情；
- 等待资源和失败状态；
- 全屏终端；
- WebRTC/Relay 状态；
- 文件与 Artifact 只读 Viewer；
- 当前 Resource Host 状态；
- Owner 设备列表和吊销。

### Beta

- Approval Center；
- 配对二维码和 Resource Connector 引导；
- Skills 与插件移动状态页；
- 终端搜索、复制和虚拟按键完善；
- PWA 通知。

### Later

- 多 Resource Host 显式选择；
- Device 持钥 proof；
- durable mailbox；
- E2EE Relay；
- 文件安全编辑；
- Mobile Resource Host。

## 18. 验收标准

1. 用户能明确区分 Runtime 在线、Resource Host 在线和终端直连。
2. WebRTC 失败后自动回退 Relay，终端 Session 不丢失。
3. 终端软键盘弹出、旋转屏幕和收起地址栏后尺寸正确。
4. 普通 Client 无法看到或调用 Owner 的配对、设备列表和吊销能力。
5. Resource Host 离线时，终端和文件入口显示原因而不是无限加载。
6. Approval 详情包含操作、目标 Host、资源、风险和过期时间。
7. 同一 Approval 被其他 Client 处理后，当前页面 1 秒内更新。
8. 文件和 Diff 在 320px 宽度下不撑破页面。
9. 所有远程操作均不直接请求 `localhost`。
10. 当前多设备路由未支持手动选择时，界面始终显示实际使用的 Host。

## 19. 风险与待决策

| 问题 | 建议 |
| --- | --- |
| WebRTC 在企业网络中成功率不稳定 | Relay 必须是完整可用的降级路径 |
| Relay 终端延迟影响逐字符输入 | 显示模式和延迟，优先优化批量与 ACK |
| 移动审批信息过多 | 摘要 + 强制关键字段 + 可展开原始参数 |
| Resource Host 选择不透明 | 所有结果和操作展示实际 Host |
| 插件 UI 无移动规范 | 引入移动 contribution，未适配插件进入“仅桌面” |
| Owner 手机丢失 | 支持服务器 CLI 吊销，后续建设恢复与多 Owner |
