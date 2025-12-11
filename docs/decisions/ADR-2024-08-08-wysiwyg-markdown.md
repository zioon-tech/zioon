# ADR-2024-08-08 — WYSIWYG Markdown（Obsidian 风格）实施方案

Status: Proposed  
Date: 2024-08-08  
Authors: zion-next core

## 背景与目标

我们希望将当前的纯文本 Markdown 编辑器，升级为“所见即所得（WYSIWYG）”体验，参考 Obsidian 的交互与视觉风格。在不破坏现有扩展 API（window.zion + EditorProxy）的前提下，逐步引入 CM6 的装饰（Decorations）、ViewPlugin、Transactions 等能力，实现“文本仍是 Markdown，但展示更接近最终渲染”的编辑体验。

核心原则：
- 文档始终是“Markdown 文本”，不引入隐藏的 DOM-only 内容。
- WYSIWYG 仅通过 Decorations/Widgets/Styles 实现视觉与交互增强。
- 所有交互最终体现在文本变更（replaceRange/replaceSelection 等），保证兼容粘贴处理器、消息管道与扩展生态。

## 范围与非目标

- 目标：
  - 标题、列表、任务列表、引用、代码块等的视觉增强（图标/样式/块级高亮）。
  - 任务列表（- [ ] / - [x]）的可点击切换。
  - 链接/图片的“预览型”交互（悬浮提示、可点击打开）。
  - 内联格式（粗体/斜体/行内代码）的轻量高亮。
  - 按段（Block）级别的 hover 工具条（例如复制、折叠、插入）。
- 非目标（本阶段不做或仅作为探索）：
  - 复杂表格的全功能 WYSIWYG 编辑器（后续阶段分步实现）。
  - 完整的 Markdown 渲染器替换（仍以 CM6 文本为源，Decorations 为辅）。
  - 所有 Obsidian 插件行为（仅参考交互风格）。

## 技术方案（CM6）

- 基础依赖：`@codemirror/lang-markdown` 提供语法树（syntax tree）。
- 视图插件：`ViewPlugin` + `DecorationSet` + `RangeSet` 扫描文档并渲染装饰。
- 装饰类型：
  - `Decoration.mark`：内联样式（例如粗体/斜体/行内代码）
  - `Decoration.widget`：插入前后部件（例如任务框、块工具条）
  - `Decoration.line` / 块级样式：对行/块施加背景和边框
- 事务映射：通过 `view.update` 中的 `update.changes` 进行位置映射，保持装饰与文本同步。
- 交互写回：
  - 任务列表 toggle：点击 Widget -> 替换 `- [ ]` 为 `- [x]` 或反之。
  - 链接点击：打开外部链接或在编辑器中插入/修改链接语法。
- 性能与节流：
  - 增量扫描：依据 `view.update` 的变化范围，避免全量重建。
  - 大文档优化：对块级节点进行懒加载/可视窗口范围渲染。

## 功能拆解与里程碑

M1：基础块级增强（1–2 周）
1) 标题（#、##、###...）高亮与左侧锚样式（装饰+样式）。
2) 列表项的基础样式（有序/无序符号视觉优化）。
3) 任务列表（- [ ]/- [x]）可点击切换（Widget + 文本替换）。
4) 引用（>）块的边框与背景高亮。
5) 代码块（```）区块的背景与字体。

M2：内联与链接交互（1–2 周）
1) 粗体/斜体/行内代码的内联 mark 装饰。
2) 链接的悬浮预览（标题/URL），点击打开或编辑。
3) 图片链接的小型预览（悬浮时加载，避免性能问题）。

M3：进阶块工具与配置（2 周）
1) 每个块的“hover 工具条”（复制、折叠、插入）。
2) 折叠与展开（基于语法树结构/标题层级）。
3) 用户配置与开关（在 StateBus 记录开关状态，菜单/命令控制）。

## 详细实现计划（以 PR 切分）

- PR1：引入 WYSIWYG 视图插件基础架构
  - 在 EditorCore 中新增一个 Compartment（uiComp），用于动态挂载 WYSIWYG 扩展。
  - 内置一个 ViewPlugin：遍历 markdown 语法树，生成 DecorationSet（仅标题与引用）。
  - 文档：Development.md 增加“WYSIWYG Markdown 实现计划”章节。
  - Changelog：记录“Unreleased”中的新增（设计与计划）。

- PR2：任务列表交互
  - 为 `- [ ]` / `- [x]` 渲染一个可点击的 checkbox Widget。
  - 点击时，计算行起止位置并替换文本（EditorProxy.replaceRange）。
  - 测试：添加简单 DOM 交互测试用例（Vitest + jsdom）。

- PR3：列表与代码块样式
  - 为有序/无序列表渲染符号装饰。
  - 为代码块（```）加背景与字体（主题一致性）。
  - 性能：对可视范围进行节流渲染。

- PR4：内联样式与链接交互
  - mark 装饰渲染 **bold**、_italic_、`inline code`。
  - 链接悬浮预览（title/URL），点击打开。
  - 图片悬浮预览（轻量）。

- PR5：块工具条与折叠
  - 在块 hover 时显示工具条（复制、折叠、插入）。
  - 折叠通过修改文档或在插件内记录折叠状态（state + decorations）。

每个 PR 均：
- 更新 docs/Changelog.md 的 “Unreleased”。
- 在 docs/Development.md 记录新增或变更的实现细节。
- 如涉及结构性决定，追加 ADR。

## 与现有扩展点的关系

- Decorators（window.zion.editor.registerDecorator）仍用于轻量 UI；WYSIWYG 主体以内部 ViewPlugin 实现，保持扩展 API 简洁。
- PasteHandlers 与 Messages 管道不受影响；文本仍是 Markdown。
- Menus/Keybindings 可以增加相关命令（例如切换折叠、切换 WYSIWYG 模式）。

## 风险与缓解

- 渲染性能：使用增量更新与可视区域限制，避免全量扫描。
- 文本-装饰同步：依赖事务映射（change mapping），谨慎处理多光标与批量替换。
- 浏览器差异：以现代浏览器为主，避免使用不兼容特性。

## 测试策略

- 单元：语法节点识别与范围计算。
- 交互：任务列表切换、链接点击（jsdom）。
- 视觉：快照测试或手动验证（dev server）。

## 结论

采用 CM6 的 Decorations + ViewPlugin 方案实现 Obsidian 风格的 WYSIWYG Markdown，分阶段交付，保持与现有扩展 API 的兼容。文档与 Changelog 作为变更追踪的单一事实来源。