# Development Notes

本页记录 Zion Next MVP 的核心模块说明、架构约束与本地开发技巧。

## 核心模块

- EditorCore（`src/editor/EditorCore.ts`）
  - CodeMirror 6 编辑器实例与基础扩展（行号、选择、历史、markdown、主题）
  - Markdown：围栏代码支持语法高亮（通过 @codemirror/language-data 注入 codeLanguages）。
  - 折叠：通过 @codemirror/fold 提供折叠 gutter 支持（可运行时开关），扩展可通过 foldService 注册自定义折叠规则（如角色区块折叠）。
  - 暴露 `updateKeymap()` 以合并扩展注册的快捷键

- EditorProxy（`src/editor/EditorProxy.ts`）
  - 为扩展提供安全的编辑器操作方法（不暴露底层 CM6 实例）
  - 方法：`getValue/setValue/replaceSelection/getCursor/setCursor/focus`

- Registry（`src/ext/registry.ts`）
  - commands / keybindings / menus / status bar 的注册与管理
  - 事件总线（EventBus）与状态总线（StateBus）封装
  - 粘贴处理链（registerPasteHandler）：扩展可以拦截粘贴并返回 handled
  - 消息贡献者（messages.registerContributor）：扩展可在 chat 前后（pre/post）注入/转换消息
  - 装饰器（editor.registerDecorator）：扩展在编辑器就绪后注入轻量 UI/逻辑（返回 Disposable 清理）
  - 模型提供者注册（models.registerProvider）：预留扩展点，供后续模型管理与调用接入
  - Keybindings 支持 when 条件（"editorFocus" | "hasSelection"）
  - 右键菜单挂载（menus.register + 内置 attachContextMenu）
  - `attachEditor()` 挂载 EditorCore 并应用当前 keymap、注册粘贴监听、右键菜单与装饰器

- EventBus / StateBus（`src/core/event-bus.ts`, `src/core/state-bus.ts`）
  - 轻量级发布订阅与状态共享，支持插件间互动
  - 错误隔离（handler try/catch），避免单插件崩坏总线
  - 共享状态：`roles.index`（由 dev.roles 发布，包含角色块索引与预览，供扩展读取，例如 dev.toc 显示用户消息）

## 目录约定

```
src/
  editor/     # 编辑器内核与代理
  ext/        # 扩展注册中心与挂载
  core/       # 总线等基础设施
  types/      # 扩展 API 类型
extensions/   # 扩展示例与未来扩展
```

## 本地开发技巧

- 调试扩展
  - 浏览器控制台查看 `[ext] loaded:` 日志
  - 在扩展 `activate()` 里打印状态
  - 修改 `extension.json` 的 `main` 指向不同入口快速试验
  - 状态栏“Extensions”面板可启用/禁用扩展；加载失败时状态栏会显示 `● ExtErr(n)` 提示

- 快捷键
  - CM6 的写法使用 `Mod`（跨平台），例如 `Mod-Shift-d`
  - 避免与浏览器/系统全局快捷键冲突（如 `Cmd+W`）

- 样式
  - 编辑器容器需要撑满视口高度（`.cm-editor { height: 100% }`）
  - 状态栏按钮通过 `registerItem()` 统一渲染

## 未来演进（路线图）

- 自动扫描 extensions 目录并支持启用/禁用
- 扩展的菜单/右键贡献点
- 消息管道（getMessages）的贡献者链与 Vision 转换
- 扩展宿主（Extension Host）与权限模型
- Electron 集成（与主进程服务联动）

## 约束

- MVP 阶段不暴露底层 CM6 实例给扩展，使用 EditorProxy 保护核心
- 注册中心是单例，按页面级别管理（多编辑器时需扩展 window.zion.window 结构）
- 事件总线为同步分发，避免复杂时序问题；必要时扩展内部自行节流/防把

## 变更记录流程（Change Tracking）

为保证团队协作与开源社区可追踪，所有功能/API/文档改动请按如下规范记录：

- 必须更新 docs/Changelog.md
  - 使用“Unreleased”+“版本”两层结构，列出新增/变更/修复/文档更新。
  - 代码改动对应的要点（文件/模块/扩展点）要简要描述。
- 若引入或变更扩展 API（如 messages/menus/paste/decorators）
  - 同步更新 docs/Extensions.md 的 API 参考与示例。
- 需要开发者行为调整或迁移
  - 在 docs/GettingStarted.md / docs/Development.md 增加“迁移须知”小节（简要说明）。
- 提交规范
  - PR 描述附带“Changelog 片段”（准备合并后补充至 docs/Changelog.md）。
  - 变更类型建议使用：Added / Changed / Fixed / Docs / Breaking。
- 版本与发布
  - package.json 的 version 仅在发布时更新；日常迭代以 “Unreleased” 记录。
  - 每个里程碑结束打 tag，并将“Unreleased”落版到新版本条目。

## WYSIWYG Markdown 实现计划（Obsidian 风格）

为实现“所见即所得”的 Markdown 编辑体验，采用 CodeMirror 6 的 Decorations + ViewPlugin 方案，分阶段交付。

- 当前阶段说明
  - WYSIWYG 渲染为核心内部 ViewPlugin 实现，扩展无法直接替换或挂载视觉渲染逻辑。
  - 扩展仅能通过命令 `zion.setWysiwyg(enabled)` / `zion.toggleWysiwyg()` 控制开关。
  - editor.registerDecorator 仅用于轻量 UI/行为，不影响核心 WYSIWYG 渲染管线。

- 设计原则
  1) 文档保持纯 Markdown 文本；增强通过装饰与部件实现。
  2) 所有交互（如任务切换）回写到文本（replaceRange/replaceSelection）。
  3) 性能优先：增量更新、可视范围渲染、事务映射。

- 阶段目标
  1) M1：块级增强（标题、列表、任务列表、引用、代码块的视觉与基本交互）
  2) M2：内联样式与链接/图片交互（粗体、斜体、行内代码、链接预览与点击）
  3) M3：块工具条与折叠（hover 工具条、折叠/展开、用户配置）

- 实施要点（CM6）
  1) 使用 `@codemirror/lang-markdown` 的语法树扫描节点范围。
  2) 用 `ViewPlugin` 维护 `DecorationSet`，对节点添加 `mark/widget/line` 装饰。
  3) 在 `update` 中基于 `changes` 做位置映射与增量构建。
  4) 任务列表：Widget 渲染 checkbox；点击切换时替换 `- [ ]` 与 `- [x]`。
  5) 链接：hover 展示 title/URL，点击打开或编辑。
  6) 内联：**bold**、_italic_、`code` 使用 `Decoration.mark`。
  7) 块工具条：hover 时插入浮动控件（复制/折叠/插入），通过 state 控制开关。
  8) 统一样式：遵循 oneDark 主题配色与现有 CSS 变量。
  9) 表格：支持管道风格表格（header + separator），按行渲染为 flex 布局的表格行；separator 行淡化显示。
  10) 公式：接入 KaTeX，支持内联 `$...# Development Notes

本页记录 Zion Next MVP 的核心模块说明、架构约束与本地开发技巧。

## 核心模块

- EditorCore（`src/editor/EditorCore.ts`）
  - CodeMirror 6 编辑器实例与基础扩展（行号、选择、历史、markdown、主题）
  - Markdown：围栏代码支持语法高亮（通过 @codemirror/language-data 注入 codeLanguages）。
  - 折叠：通过 @codemirror/fold 提供折叠 gutter 支持（可运行时开关），扩展可通过 foldService 注册自定义折叠规则（如角色区块折叠）。
  - 暴露 `updateKeymap()` 以合并扩展注册的快捷键

- EditorProxy（`src/editor/EditorProxy.ts`）
  - 为扩展提供安全的编辑器操作方法（不暴露底层 CM6 实例）
  - 方法：`getValue/setValue/replaceSelection/getCursor/setCursor/focus`

- Registry（`src/ext/registry.ts`）
  - commands / keybindings / menus / status bar 的注册与管理
  - 事件总线（EventBus）与状态总线（StateBus）封装
  - 粘贴处理链（registerPasteHandler）：扩展可以拦截粘贴并返回 handled
  - 消息贡献者（messages.registerContributor）：扩展可在 chat 前后（pre/post）注入/转换消息
  - 装饰器（editor.registerDecorator）：扩展在编辑器就绪后注入轻量 UI/逻辑（返回 Disposable 清理）
  - 模型提供者注册（models.registerProvider）：预留扩展点，供后续模型管理与调用接入
  - Keybindings 支持 when 条件（"editorFocus" | "hasSelection"）
  - 右键菜单挂载（menus.register + 内置 attachContextMenu）
  - `attachEditor()` 挂载 EditorCore 并应用当前 keymap、注册粘贴监听、右键菜单与装饰器

- EventBus / StateBus（`src/core/event-bus.ts`, `src/core/state-bus.ts`）
  - 轻量级发布订阅与状态共享，支持插件间互动
  - 错误隔离（handler try/catch），避免单插件崩坏总线
  - 共享状态：`roles.index`（由 dev.roles 发布，包含角色块索引与预览，供扩展读取，例如 dev.toc 显示用户消息）

## 目录约定

```
src/
  editor/     # 编辑器内核与代理
  ext/        # 扩展注册中心与挂载
  core/       # 总线等基础设施
  types/      # 扩展 API 类型
extensions/   # 扩展示例与未来扩展
```

## 本地开发技巧

- 调试扩展
  - 浏览器控制台查看 `[ext] loaded:` 日志
  - 在扩展 `activate()` 里打印状态
  - 修改 `extension.json` 的 `main` 指向不同入口快速试验
  - 状态栏“Extensions”面板可启用/禁用扩展；加载失败时状态栏会显示 `● ExtErr(n)` 提示

- 快捷键
  - CM6 的写法使用 `Mod`（跨平台），例如 `Mod-Shift-d`
  - 避免与浏览器/系统全局快捷键冲突（如 `Cmd+W`）

- 样式
  - 编辑器容器需要撑满视口高度（`.cm-editor { height: 100% }`）
  - 状态栏按钮通过 `registerItem()` 统一渲染

## 未来演进（路线图）

- 自动扫描 extensions 目录并支持启用/禁用
- 扩展的菜单/右键贡献点
- 消息管道（getMessages）的贡献者链与 Vision 转换
- 扩展宿主（Extension Host）与权限模型
- Electron 集成（与主进程服务联动）

## 约束

- MVP 阶段不暴露底层 CM6 实例给扩展，使用 EditorProxy 保护核心
- 注册中心是单例，按页面级别管理（多编辑器时需扩展 window.zion.window 结构）
- 事件总线为同步分发，避免复杂时序问题；必要时扩展内部自行节流/防把

## 变更记录流程（Change Tracking）

为保证团队协作与开源社区可追踪，所有功能/API/文档改动请按如下规范记录：

- 必须更新 docs/Changelog.md
  - 使用“Unreleased”+“版本”两层结构，列出新增/变更/修复/文档更新。
  - 代码改动对应的要点（文件/模块/扩展点）要简要描述。
- 若引入或变更扩展 API（如 messages/menus/paste/decorators）
  - 同步更新 docs/Extensions.md 的 API 参考与示例。
- 需要开发者行为调整或迁移
  - 在 docs/GettingStarted.md / docs/Development.md 增加“迁移须知”小节（简要说明）。
- 提交规范
  - PR 描述附带“Changelog 片段”（准备合并后补充至 docs/Changelog.md）。
  - 变更类型建议使用：Added / Changed / Fixed / Docs / Breaking。
- 版本与发布
  - package.json 的 version 仅在发布时更新；日常迭代以 “Unreleased” 记录。
  - 每个里程碑结束打 tag，并将“Unreleased”落版到新版本条目。

## WYSIWYG Markdown 实现计划（Obsidian 风格）

为实现“所见即所得”的 Markdown 编辑体验，采用 CodeMirror 6 的 Decorations + ViewPlugin 方案，分阶段交付：

- 设计原则
  1) 文档保持纯 Markdown 文本；增强通过装饰与部件实现。
  2) 所有交互（如任务切换）回写到文本（replaceRange/replaceSelection）。
  3) 性能优先：增量更新、可视范围渲染、事务映射。

- 阶段目标
  1) M1：块级增强（标题、列表、任务列表、引用、代码块的视觉与基本交互）
  2) M2：内联样式与链接/图片交互（粗体、斜体、行内代码、链接预览与点击）
  3) M3：块工具条与折叠（hover 工具条、折叠/展开、用户配置）

- 实施要点（CM6）
  1) 使用 `@codemirror/lang-markdown` 的语法树扫描节点范围。
  2) 用 `ViewPlugin` 维护 `DecorationSet`，对节点添加 `mark/widget/line` 装饰。
  3) 在 `update` 中基于 `changes` 做位置映射与增量构建。
  4) 任务列表：Widget 渲染 checkbox；点击切换时替换 `- [ ]` 与 `- [x]`。
  5) 链接：hover 展示 title/URL，点击打开或编辑。
  6) 内联：**bold**、_italic_、`code` 使用 `Decoration.mark`。
  7) 块工具条：hover 时插入浮动控件（复制/折叠/插入），通过 state 控制开关。
 与单行块 `$...$` 渲染（不跨行替换，保持编辑稳定）。

- 交付与追踪
  1) 每个 PR 更新 docs/Changelog.md 的 “Unreleased”。
  2) 如涉及结构性变更，补充 ADR 文档（docs/decisions/**）。
  3) 在 tests/ 中加入相应的交互测试用例（Vitest + jsdom）。

## 主题系统（Light / Dark）

- 原则
  1) 使用 CSS 变量定义全局配色，通过 data-theme 切换变量集。
  2) CM6 编辑器主题通过 Compartment 动态切换（Dark 用 oneDark，Light 使用默认主题）。
  3) 主题切换不影响扩展 API，扩展无需感知底层实现。

- 实施细节（本次）
  1) 样式：src/styles.css 增加 :root[data-theme="light"] 变量覆盖；保留 :root 为 Dark 默认值。
  2) EditorCore：新增 themeComp 与 setTheme(theme) 方法，内部用 Compartment.reconfigure(oneDark | []) 切换。
  3) 启动：main.ts 读取 localStorage('zion.theme')，设置 document.documentElement 的 data-theme；注册命令 zion.setTheme / zion.toggleTheme；状态栏“Theme”按钮。
  4) 状态：通过 window.zion.state.set('ui.theme', theme) 对外发布，便于扩展感知。

- 后续计划
  - 支持自定义主题的注册/选择（扩展可贡献主题包）。
  - WYSIWYG 装饰在 Light 下的细节优化（对比度、边框）。
  - 主题在多窗口/多编辑器实例下的同步策略。

## WYSIWYG：核心 vs 扩展（决策）

- 当前阶段（MVP）WYSIWYG 采用核心内部 ViewPlugin 实现，理由：
  - 性能与稳定性：属于输入/滚动热路径，需与编辑器事务紧耦合（增量映射、可视范围重建）。
  - 统一体验：标题/列表/代码块等视觉规则需与主题、粘贴链等内核能力协同演进。
- 扩展参与方式：
  - 通过命令 zion.setWysiwyg / zion.toggleWysiwyg 实现开关；示例扩展 dev.wysiwyg-toggle 仅调用开关命令。
  - 可用 editor.registerDecorator 注册轻量装饰与行为（不修改核心 WYSIWYG 渲染管线）。
- 未来演进（可插拔愿景）：
  - 后续可能开放 editor.registerVisualExtension(ext: CM6 Extension) 等注册点，允许替换或叠加特定渲染模块（目前仅支持命令控制）。
  - 在保证性能与安全的前提下，引入“首方/三方 WYSIWYG 模块”的切换能力（非 MVP 范围）。

=======