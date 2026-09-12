# Zion Mobile Workbench 产品需求

本目录定义 Zion 在手机浏览器和 PWA 中的产品形态。移动端采用独立的 Mobile Client
前端，不是桌面 Workbench 的响应式分支或等比缩放。它拥有独立路由、bundle、页面和
组件树，但复用同一 Runtime、Session、Run、权限和 Resource Host。

## 文档

0. [Mobile Client 交互 Demo](./demo/index.html)
   - 基于 React、TypeScript、Vite 和 Lucide React。
   - 可点击体验会话、消息卡片、Run/审批、任务、定时任务、远程终端、文件与变更、
     Skills、插件、模型、Identity/Memory、评论、设备和设置。
1. [Workbench 到 Mobile Client 功能取舍矩阵](./WORKBENCH-MOBILE-FEATURE-MATRIX.md)
   - 逐项记录现有能力的移动价值、呈现方式、优先级和明确排除项。
2. [PRD-01：Mobile Workbench 总体体验](./PRD-01-MOBILE-WORKBENCH-SHELL.md)
   - 产品定位、用户、信息架构、导航、响应式策略和总体指标。
3. [PRD-02：移动对话与会话](./PRD-02-MOBILE-CONVERSATION.md)
   - 会话列表、消息流、Composer、流式回答、工具卡片、草稿和多端一致性。
4. [PRD-03：移动远程操作](./PRD-03-MOBILE-REMOTE-OPERATIONS.md)
   - Run Center、Approval、终端、文件、Skills、插件、设备状态和配对。
5. [Mobile Client UX 审计](./MOBILE-UX-AUDIT.md)
   - 逐页体验结论、已完成优化、对话数据一致性和验收标准。

## 建议评审顺序

1. 先确认 PRD-01 的产品边界：移动端是否接受“单主表面 + 对话优先”。
2. 再确认 PRD-02 的关键决策：Mobile Client 不加载或使用 CodeMirror。
3. 最后确认 PRD-03 的安全和能力边界：Approval、Resource Host、WebRTC/Relay 和 Owner 权限。

## 共同硬约束

- Runtime 是 Session 和 Run 的权威 owner。
- Mobile 是 Client，不在浏览器中运行长期 Agent loop。
- Mobile Client 与 Desktop Workbench 是两个前端入口，不共享桌面 Layout DOM。
- Mobile 使用结构化消息 projection 和 command API，不解析桌面会话文档格式。
- 远程 Workbench 与 Runtime 保持同源 HTTPS。
- 公网页面不得直接连接 `127.0.0.1`。
- Resource Host 只通过 Connector 提供能力并执行本地授权。
- 终端优先 WebRTC DataChannel，失败后使用 Runtime Relay。
- 高风险操作必须经过 Policy、Resource grant 和 Approval。
- 当前多设备模式不承诺数据聚合或手动设备选择。

## 推荐交付切片

| 里程碑 | 用户价值 | 主要范围 |
| --- | --- | --- |
| M0：移动可用 | 手机能够稳定导航和查看 | 单列壳层、四项导航、安全区、移动空状态 |
| M1：移动对话 | 手机能够自然继续 Agent 会话 | 消息流、Composer、Run projection、草稿 |
| M2：远程控制 | 手机能够处理运行阻塞 | Run Center、Approval、Resource 状态 |
| M3：移动运维 | 手机能够完成短远程操作 | 全屏终端、Artifact、设备管理 |
| M4：PWA 完善 | 手机成为可靠日常入口 | 推送、离线只读、后台恢复、深链接 |

每个里程碑都应独立可用，不以同时重写所有桌面插件为前提。
