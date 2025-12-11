# Roadmap

本路线图按照阶段逐步推进，优先保证“可扩展的核心 + 快速验证”的节奏。每个阶段都可单独合并发布，降低风险。

## T0（本周 - 下周）：MVP 可用
目标：跑通 CM6 核心、扩展注册中心、示例扩展与自动加载。

- 已完成
  - CodeMirror 6 内核（EditorCore）与 EditorProxy
  - 扩展注册中心（commands / keybindings / status bar）
  - EventBus / StateBus（插件间通信）
  - 自动加载 `/extensions/**/extension.json`
  - 文档：README、GettingStarted、Extensions、Development、Roadmap

- 待办
  - 扩展禁用/启用的临时面板（前端状态级别）
  - 扩展错误托底 UI（状态栏红点 / 控制台链接）

## T1（2-4 周）：基础扩展与挂载点丰富
目标：把功能从核心分流为“内置扩展”，形成插件生态骨架。

- 挂载点
  - 粘贴处理链（editor.registerPasteHandler）MVP
  - 右键菜单/菜单栏挂载点（menus.register）
  - 消息贡献者管道（messages.registerContributor）初版

- WYSIWYG Markdown（基础）
  - 标题/列表/任务列表/引用/代码块的视觉增强（Decorations）
  - 任务列表可点击切换（Widget + 文本替换）

- 内置扩展（bundled）
  - Terminal（仅前端模拟或占位 UI，预留与 Electron 主进程桥接）
  - File Explorer（简版，读取本地虚拟树/Mock）
  - Webview Helper（占位）

- 文档与示例
  - 粘贴处理器示例（JSON->YAML、URL->引用）
  - 菜单/命令示例（右键加入书签）
  - 消息贡献者示例（注入系统信息/工具清单）
  - WYSIWYG 方案 ADR 与开发笔记（Development.md）

## T2（4-8 周）：模型/工具与 Electron 联动
目标：与主进程能力打通，形成“可工作的日常工具”。

- 模型与工具
  - models.registerProvider：注入模型配置与 chat 调用适配器
  - MCP 工具桥接（主进程统一 list/call，渲染器 UI 展示）

- WYSIWYG Markdown（增强）
  - 内联样式（粗体/斜体/行内代码）mark 装饰
  - 链接/图片的悬浮预览与点击交互
  - 块级 hover 工具条（复制/折叠/插入）

- Electron 集成（新仓库或子工程）
  - 主进程：pty、fs、watchers、open-in-vscode、open-external
  - 渲染器：与主进程 IPC 协议统一

- 内置扩展升级
  - Terminal：node-pty 打通（Electron）
  - File Explorer：本地树 + 监听变更（chokidar）

## T3（8-12 周）：安全/权限与稳定工程
目标：可对外开放的预览版，具备扩展隔离与权限雏形。

- 扩展宿主（Extension Host）雏形
  - 需要 Node 能力的扩展在宿主中运行，JSON-RPC 与渲染器通信
  - 权限声明（文件/网络/终端），用户授权 UI

- 工程化
  - 自动扫描 extensions 与禁用/启用面板
  - 基础单元测试与端到端测试
  - 构建与发布流程（CI/CD）

## 长期方向
- 消息管道：Vision 转换、上下文总线（工作区/书签/Webview/终端）
- 编辑器增强：块级装饰、冲突视图、图片标注的扩展点
- 多编辑器多窗体：`window.zion.window` 扩展为多实例管理
- 扩展市场与模板脚手架

> 注：每阶段任务都可以切小做“可合并”的 PR。优先实现挂载点与内置扩展占位，方便团队并行。