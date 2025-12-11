# Changelog — Zion Next (CM6)

本文档记录项目的可见变更，便于团队与开源社区追踪迭代。采用“Unreleased + 版本”两层结构。

## Unreleased

- Added
  - 新增扩展 `dev.langchain-chat`：基于 LangChain + DeepSeek 实现真实流式对话（兼容原有快捷键与菜单）。
  - 新增模型提供者 `deepseek`，支持 `deepseek-chat` 模型（API Key 可后续在配置面板填写）。
  - 角色索引共享：dev.roles 发布状态键 `roles.index`（包含角色块范围与预览），供扩展读取。
  - TOC 模式：支持“按角色分组”为顶级目录（可一键开关），各级标题保持折叠能力；移除原 “User Messages” 区块。
  - 角色扩展：dev.roles 支持基于角色前缀（如 user/assistant/system）自动注册自定义折叠服务，实现角色区块一键折叠（通过 foldService）。
  - 搜索替换扩展：新增 dev.search-replace 扩展，基于 @codemirror/search 官方包实现 VS Code 风格的搜索替换功能
  - 支持快捷键：Ctrl+F 搜索、Ctrl+H 搜索替换、Enter/Shift+Enter 导航、Alt+Enter 选择所有匹配、Esc 关闭
  - Minimap 扩展：新增 dev.minimap，右侧缩略图（canvas 渲染，点击/拖拽跳转，主题自适应）
  - 新增 when 条件：`searchReplaceVisible` 用于搜索/替换面板聚焦时的快捷键控制
  - 替换面板（Replace）：实现替换输入框、Replace / Replace All 操作与折叠切换；支持回填上次替换文本（state key: `searchReplace.replace`）
  - 布局调整：搜索面板改为相对于编辑器容器的右上角定位（避免覆盖顶部状态栏），折叠按钮靠近匹配计数以匹配 VS Code 布局习惯
  - UI 优化：控件更紧凑（较小的按钮内边距、较小字号），使用图标替代不必要文字（如 ▾/▴/↑/↓），并保留 tooltip 以保证可访问性
  - 同步与兼容：替换值会同步到 CM6 的 SearchQuery（通过 `setSearchQuery` command），避免唤起默认 CM6 面板并保证 find/replace 行为一致
  - API（预留）：`models.registerProvider()` 模型提供者注册表（仅注册与枚举，后续版本接入模型选择与调用）。
  - Core Commands：新增 `zion.showExtensions`（打开扩展面板）、`zion.reloadExtensions`（重载扩展/刷新页面）。
  - 状态栏：新增 “Reload” 按钮，便于开发阶段快速重载。
  - 设计/计划：新增 ADR《ADR-2024-08-08 — WYSIWYG Markdown（Obsidian 风格）实施方案》，拆解功能与阶段性实现计划。
  - WYSIWYG：新增无序列表渲染（-/*/+ 开头的行，替换标记为圆点“•”，保留行内文本用于其它内联装饰）。
  - WYSIWYG：新增有序列表渲染（“1. text” 等，替换数字标记为样式化编号，保留行内文本）。
  - WYSIWYG：新增代码块行级样式渲染（``` 围栏与内容行统一背景与等宽字体，避免跨行替换）。
  - 语法高亮：围栏代码块接入 @codemirror/language-data，实现常见语言的语法高亮（如 js/ts/json/yaml 等）。
  - WYSIWYG：支持表格渲染（管道风格，header+separator+rows，按行 flex 布局显示）。
  - WYSIWYG：支持公式渲染（KaTeX，内联 `$...# Changelog — Zion Next (CM6)

本文档记录项目的可见变更，便于团队与开源社区追踪迭代。采用“Unreleased + 版本”两层结构。


 渲染（不跨行替换，保持编辑稳定）。
  - 主题：新增全局 Light/Dark 主题系统（CSS 变量 + data-theme），状态栏"Theme"按钮与命令 zion.toggleTheme/zion.setTheme，持久化 localStorage('zion.theme')。
  - 编辑器：通过 Compartment 动态切换 CM6 主题（Dark 使用 oneDark，Light 使用默认主题）。
  - WYSIWYG：新增模式开关（核心命令 zion.setWysiwyg / zion.toggleWysiwyg），状态栏按钮与持久化 localStorage('zion.wysiwyg')。
  - 编辑器：新增运行时特性开关（核心命令 zion.setLineNumbers / zion.toggleLineNumbers、zion.setActiveLineHighlight / zion.toggleActiveLineHighlight、zion.setSyntaxHighlight / zion.toggleSyntaxHighlight、zion.setAutoIndent / zion.toggleAutoIndent、zion.setFolding / zion.toggleFolding、zion.setLineWrap / zion.toggleLineWrap），支持持久化 localStorage 并通过扩展控制。
  - 示例：新增 dev.wysiwyg-toggle 扩展（快捷键 Mod-Shift-w 切换所见即所得）。
  - 示例：新增 dev.editor-config 扩展（快捷键与状态栏项示例，用于切换行号/语法高亮/自动缩进/活动行高亮/折叠/行包装）。
- Changed
  - 文档：Extensions.md 增补 Models 提供者预留 API；Development.md 在 Registry 小节补充 models.registerProvider；Changelog 记录以上变更。
  - 类型：将 Keybinding.when 限定为 "editorFocus" | "hasSelection"，与 Menus.when 对齐。
  - 扩展面板：显示扩展版本号（读取 manifest.version）。
  - 类型：Registry 采纳公共类型（MenuItem/Decorator/MessageContributor），移除重复定义。
  - 示例：新增 dev.sample-messages（消息贡献者）、dev.paste-rich2plain（富文本→纯文本）、dev.paste-codefence（自动包裹代码块）。
  - 菜单：补充 when 条件示例（hasSelection）与 tab/context 菜单项。
  - 测试：引入 Vitest 最小测试集（EventBus、Registry Keymap、PasteHandlers 顺序）。
  - 工程：加入 ESLint + Prettier 脚本；GitHub Actions 跑 lint+test+build。
  - 文档：Development.md 增加“WYSIWYG Markdown 实现计划（Obsidian 风格）”章节；Roadmap.md 补充 WYSIWYG 相关里程碑。
  - 状态栏（Topbar）：窄屏自适应优化——支持横向滚动、隐藏滚动条（hover 显示）、收紧间距与字号，避免拥挤换行。
- Docs
  - 新增：docs/Changelog.md，规范变更记录流程。
  - 更新：README 增加“进一步阅读”链接至 Roadmap 与 Changelog。
  - 更新：Development.md 增加“变更记录流程”章节。
  - 新增：UI/UX 设计原则文档（docs/UI-UX-Principles.md）。
  - 更新：Extensions.md 增加“扩展变更记录与版本兼容”章节。
  - 更新：Extensions.md 增加“模型提供者”示例代码。
  - 更新：Extensions.md 增加“Paste Handlers 高级示例（JSON->YAML、URL）”。
  - 新增：ADR-2024-08-08-wysiwyg-markdown.md（所见即所得 Markdown 方案与计划）。
  - 更新：明确 WYSIWYG 为核心实现（内部 ViewPlugin），扩展仅能通过命令进行开关，无法直接替换渲染管线；后续如有开放视觉扩展挂载点会在文档中明确记录。
- Guidance
  - 明确扩展 API 变更时的记录与兼容建议。
- Examples
  - 新增：dev.sample-menu（右键菜单与命令示例）。
  - 新增：dev.decorator-hello（装饰器示例，在编辑器右上角挂载按钮）。
  - 新增：dev.sample-messages（消息贡献者示例，注入系统信息并提供演示命令）。
  - 新增：dev.sample-status（状态栏示例，点击插入标记文本）。
  - 新增：dev.sample-models（模型提供者示例）。
  - 新增：dev.paste-plus（粘贴处理高级示例：JSON->YAML、URL 转链接）。
  - 新增：dev.toc（Markdown 内容目录 TOC：命令、快捷键、状态栏按钮、右键菜单；点击目录跳转到标题）。
- Changed
  - API：实现 `menus.show(menuId, x, y)`，支持在指定坐标显示编辑器右键菜单（当前支持 `editor/context`）。
  - 示例：调整 `dev.sample-messages` 快捷键为 `Mod-Shift-y`，避免与 `dev.sample-menu` 冲突。
  - 主题：扩展默认跟随主题（var(--panel/--border/--fg/--accent)）；并支持扩展自定义变量覆盖（如 dev.toc 使用 --ext-toc-*，dev.decorator-hello 使用 --ext-hello-*）。
- Fixed
  - WYSIWYG：修复代码块渲染在跨视口滚动时丢失的问题（全文扫描围栏并按行级装饰）。
  - WYSIWYG：避免跨行 replace，修复粘贴后报错（“Decorations that replace line breaks…”）。
  - WYSIWYG：代码围栏识别遵循 CommonMark 规则（仅“纯回撇/波浪”行闭合；` ```lang ` 不再错误闭合围栏），修复嵌套/相邻围栏误判。
  - 状态栏：重复调用 statusBar.registerItem(id) 时就地更新文本/提示/点击行为，不再移除并重插导致位置跳动。

## 0.1.x

- Added
  - 扩展注册中心：`commands` / `keybindings` / `statusBar`。
  - 事件总线（EventBus）与状态总线（StateBus）：支持插件间互动（发布/订阅与共享状态）。
  - 自动扫描并加载 `/extensions/**/extension.json`，扩展管理面板（启用/禁用，错误红点）。
  - 粘贴处理链：`editor.registerPasteHandler`，扩展可拦截并处理剪贴板内容。
  - 消息贡献者管道：`messages.registerContributor`，在 chat 前后注入/转换消息。
  - 轻量装饰器扩展点：`editor.registerDecorator`，在编辑器就绪后注入 UI/逻辑。
  - 右键菜单扩展点：`menus.register` + `attachContextMenu`（支持 `editorFocus` / `hasSelection` 条件）。
- Changed
  - `EditorProxy` 暴露更多只读/安全方法，用于扩展交互（例如 `replaceSelection/getSelection/replaceRange/getCursor/setCursor/focus`）。
  - `src/main.ts` 增加扩展自动加载、状态栏“Extensions”入口与错误提示。
- Docs
  - README / GettingStarted / Extensions / Development / Roadmap 首版文档。
- Examples
  - dev.sample-hello：命令/快捷键/状态栏按钮示例。
  - dev.paste-demo：粘贴处理示例（插入时间戳）。

> 注：版本号以 package.json 为准；日常迭代请在 “Unreleased” 增量记录，发布时将其落版至新版本条目。