# ADR-0001：采用 Monorepo 模块化单体与独立 Agent Runtime

- 状态：Proposed
- 日期：2026-07-26
- 决策人：Zion maintainers
- 详细分析：[AGENT-RUNTIME-BOUNDARY-STRATEGY.md](./AGENT-RUNTIME-BOUNDARY-STRATEGY.md)
- 多端拓扑：[MULTI-SURFACE-AGENT-PLATFORM.md](./MULTI-SURFACE-AGENT-PLATFORM.md)

## 背景

Zion 当前由两个仓库组成：

- `zion-next`：Vite PWA、编辑器、插件系统、模型适配、Agent loop 和浏览器工具。
- `zion-local-tools`：FastAPI、本地文件、终端、SSH、邮件、MCP 和 Scheduler。

调度 Control Plane 已开始进入后端，但 Agent Runtime 仍在浏览器。工具 schema 和 handler
通过 `window.zion.state` 动态注册，Session 和 Run 通过浏览器事件连接。这导致新增定时任务、
权限或工具时需要跨多个插件和仓库修改。

需要同时解决：

- 浏览器关闭后仍能执行 Agent；
- 插件开发不被迫维护两个独立项目；
- browser-only 工具仍可用；
- 当前编辑器和插件资产可以渐进迁移；
- 工具权限和 Run 状态有唯一权威。

## 决策

采用**单仓库模块化单体**：

```text
apps/web
apps/desktop
apps/cli
apps/runtime
services/cloud-control
services/local-tools
packages/protocol
packages/agent-core
packages/plugin-sdk
plugins/*
```

运行时保持三个主要进程边界：

1. Web：Presentation Plane + Browser Tool Host。
2. Node/TypeScript Runtime Host：本地或云端 Agent Runtime + Control Plane API。
3. Python Local Tools：本地能力 Tool Host。

具体规则：

- Agent loop、provider normalization、reasoning policy、context pipeline、RunStore 和
  Tool Broker 抽到 deployment-neutral TypeScript `agent-core`。
- 同一个 `agent-core` 由 Local Runtime、Desktop sidecar、CLI standalone 和 Cloud Worker
  复用，不复制 Agent 实现。
- Python 服务暂不重写，通过版本化 Tool Host 协议接入 Runtime。
- 前端通过 Run API 和 SSE/WS 消费事件，不再拥有 canonical Run。
- 插件作为一个 package 发布，允许分别声明可选的 UI、Runtime、Tool 和 Renderer entry。
- Durable Task 只能引用非 browser host 工具。
- 协议由 JSON Schema / OpenAPI 生成多语言类型，禁止前后端手写重复 DTO。

## 为什么不是 Next.js

Next.js 的同仓开发体验是有价值的，但 SSR 和 Route Handler 不能解决 Agent Runtime 边界。
Zion 需要常驻 scheduler、长连接、子进程、SSH、MCP 和本地文件能力。即使使用自托管 Next.js，
仍需要独立 daemon；使用 serverless 则会削弱这些能力。

迁移当前 Vite/CodeMirror PWA 到 Next.js 成本高，且不直接改善 Agent loop、Tool Broker 或
插件协议。因此保留 Vite，使用 workspace 工具获得同等的统一开发体验。

## 为什么 Agent Core 使用 TypeScript

- 当前模型解析和 Agent loop 已是 JS/TS。
- 可先抽取纯 package，再切换进程，避免行为重写。
- Runtime 插件和 UI 插件可共享 schema、类型和测试工具。
- Python 服务可继续利用 Paramiko、邮件和现有运维积累。
- Electron/Tauri、CLI 和 Cloud 通过 adapter 提供不同宿主，不进入 Core。

## 插件开发影响

插件不要求同时实现前后端：

| 插件类型 | 所需 entry |
|---|---|
| UI 面板或主题 | `ui` |
| 消息策略或 Context Provider | `runtime` |
| 通用工具 | `tools` |
| 自定义工具展示 | `tools + renderer` |
| 完整业务插件 | 按需组合 |

安装器负责将同一个插件包中的 entry 部署到对应 host。没有自定义 UI 的工具使用平台通用卡片。

## 后果

### 正面

- 协议、前端和服务端可以原子提交。
- Agent Runtime 获得测试、持久化和 durable 执行能力。
- Python 能力无需一次性重写。
- 浏览器工具仍可参与交互式 Run。
- 插件只实现实际需要的 host。

### 负面

- 本地开发初期需要同时管理 Node Runtime 和 Python sidecar。
- 必须建设生成协议、Tool Broker 和插件多 entry 安装器。
- Session 从可编辑文本转成 canonical transcript + projection，需要兼容迁移。
- 双 Runtime 过渡期会增加测试矩阵。

### 风险控制

- 先抽纯 `agent-core`，再改变进程位置。
- 使用 golden transcript 测试锁定 provider、reasoning 和 tool loop 行为。
- 每个 Run 只能有一个 Runtime owner。
- 不允许 Runtime 插件访问 DOM。
- 不允许 UI 插件直接写 canonical transcript。

## 被拒绝的方案

### 保持双仓库

无法解决协议版本漂移和跨仓插件开发成本。

### 全量迁入 Python

需要重写已工作的模型流解析、reasoning 和插件逻辑，短期风险最高。

### Next.js 全栈重写

无法消除 daemon 和 Tool Host 需求，同时引入无关 UI 迁移。

### 所有逻辑留浏览器

无法实现真正 durable 任务，也无法安全托管模型凭证。

## 生效条件

本 ADR 经确认后，先执行：

1. 建立 monorepo 骨架；
2. 建立 `packages/protocol`；
3. 为现有 Agent loop 增加 golden tests；
4. 抽取无 DOM 的 `agent-core`；
5. 暂不改变默认 Runtime owner。
