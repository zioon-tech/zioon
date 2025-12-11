# UI/UX 设计原则（Zion Next）

本原则用于指导核心与扩展在 UI/UX 设计上的统一与协作，确保一致、清晰、可访问与高性能。

## 目标与通用原则
- 一致性：控件风格、间距、字号、阴影、圆角与图标尺寸保持一致，沿用现有样式规范。
- 清晰性：优先简洁的视觉层级与信息密度，避免冗余文字；图标配合悬浮提示（tooltip）。
- 可访问性：为交互控件添加 aria-label 与合理的 focus 样式；保持键盘可达性与快捷键提示。
- 性能优先：减少不必要的重排与重绘，使用轻量 DOM 与增量更新；避免在滚动/输入热路径做重度操作。
- 可扩展：扩展通过 EditorProxy 与注册中心接入，使用 Disposable 清理资源，不侵入核心渲染管线。
- 主题适配：所有扩展 UI 跟随全局 CSS 变量（Dark/Light），支持扩展私有变量并提供回退。

## 主题与色彩（Theming）
- 使用 CSS 变量：var(--panel)、var(--border)、var(--fg)、var(--accent) 等。
- 扩展自定义变量需提供回退，例如：var(--ext-toc-bg, var(--panel))。
- 对比度：确保文字与背景在 Light/Dark 下均清晰；边框与阴影用于分隔层次但不抢镜。

## 控件与交互
- 按钮（Button）：
  - 优先使用内联 SVG 图标（14x14），图标仅代表动作，悬浮显示 tooltip 文案。
  - 为按钮添加 aria-label，padding 紧凑（例如 4px），font-size 12px。
  - 状态：hover 有轻微对比提升；禁用态（disabled）透明度降低并移除 pointer 事件。
- 面板（Panel/Overlay/Sidepanel）：
  - 统一样式：背景 var(--panel)，边框 1px var(--border)，圆角 6px，阴影 0 8px 24px rgba(0,0,0,0.35)。
  - 关闭行为：点击空白处关闭 overlay；侧边面板使用显式“收起”按钮。
  - 内容区域使用小字号（12–13px）与紧凑间距，保证信息密度与舒适度。
- 列表（List/TOC）：
  - 层级缩进：按照语义层级使用 padding-left 逐级缩进（如每级 12px）。
  - 行交互：整行可点击，指针样式为 pointer；文字过长使用省略。
- 悬浮提示（Tooltip）：
  - 所有图标按钮需设置 title 与 aria-label，以保证发现性与可访问性。

## 图标（Icons）
- 内联 SVG：优先使用简单、语义明确的 SVG 图层，尺寸统一（14x14）。
- 常用图标参考：
  - 折叠/收起：Chevron/Arrow（例如向左 ◀ 的 chevron-left）
  - 复制：Clipboard
  - 插入：Plus
  - 上/下一项：Up/Down
  - 关闭：×
- 图标颜色跟随控件的文本颜色 var(--fg)，不使用图片资源以保证主题一致与清晰缩放。

## 布局与响应式
- 编辑器区域内扩展 UI 采用 position:absolute + 相对容器（保持在编辑器内定位），避免遮挡顶部状态栏。
- 侧边面板（如 TOC）使用 flex 布局与编辑器并排，避免覆盖编辑器内容：
  - wrapper（相对定位容器） > sidepanel（左） + editor（右）
  - 打开时 wrapper.display = flex，sidepanel.display = block；关闭时 sidepanel.display = none。
- 宽度与高度：面板最小宽度 280–320px，最大高度 65vh；支持滚动。
- 视口适配：小屏时面板应保持可用（滚动、自动换行），避免固定尺寸导致溢出。

## 键盘与快捷键
- 使用 Mod 前缀跨平台（例如 Mod-Shift-w），避免与浏览器/系统级快捷键冲突（如 Cmd+W）。
- 当控件浮层可见时（如搜索/替换），快捷键限定在特定状态（when 条件），不要干扰编辑器基础操作。

## 状态与反馈
- 复制到剪贴板等动作需要轻量反馈（例如暂时改变按钮样式或通过状态栏提示）。
- 长时操作（如网络请求）需加入加载状态与取消机制（未来扩展可引入统一的 toast/loader）。

## 扩展开发规范（UI/UX）
- 使用 editor.registerDecorator 注入轻量 UI/行为；重度渲染请使用 editorProxy.addVisualExtension（ViewPlugin/Decoration）。
- 所有注册返回 Disposable，并在 deactivate 时释放资源与还原 DOM。
- 不直接操作核心 WYSIWYG 渲染管线；仅通过命令控制开关（zion.setWysiwyg / zion.toggleWysiwyg）。
- DOM 查找采用稳定的容器：编辑器宿主元素设置 position:relative，再挂载扩展面板。

## 示例参考
- dev.search-replace：紧凑面板与图标按钮、tooltip、绝对定位相对编辑器容器。
- dev.toc：侧边目录面板（flex 布局）、标题行右上角按钮组（内联 SVG + aria-label + tooltip）。

> 注：本原则将随迭代更新，请在提交涉及 UI 的变更时同步审阅此文档，并在 PR 描述中说明遵循点与例外情况。