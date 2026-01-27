# 页面设计：工作台布局（Activity Bar + Side Bar）

## Layout
- 桌面优先（desktop-first）。
- 主体采用三列布局（CSS Grid 为主，局部 Flex）：
  - 左：Activity Bar（固定宽 48px）
  - 中：Side Bar（可伸缩，默认 240px，min 180 / max 420）
  - 右：Editor Area（自适应占满剩余宽度）
- 通过 CSS 变量控制尺寸：`--activitybar-w`、`--sidebar-w`。

## Meta Information
- title: "Zion Next Workbench"
- description: "Plugin-ready workbench layout with Activity Bar and Side Bar"
- Open Graph: og:title / og:description / og:type=website

## Global Styles
- Background: `--bg`（暗色模式默认）
- Panel: `--panel`
- Border: `--border`
- Accent: `--accent`（用于选中态高亮）
- Typography:
  - Base: 13–14px
  - Mono: 12–13px（用于 id/path 等）
- Button states:
  - Default: 透明背景 + 边框/hover
  - Hover: `background: rgba(255,255,255,0.06)`（暗色）
  - Active/Selected: 左侧高亮条 + `--accent`
- Link styles: underline on hover

## Page Structure
- 顶层容器：`WorkbenchRoot`
  1. 左侧 Activity Bar 区
  2. 左侧 Side Bar 区
  3. 主编辑器区（现有 EditorCore 容器）
  4.（若存在）底部 Status Bar 保持不变

## Sections & Components

### 1) Activity Bar（左侧图标栏）
- 结构
  - 顶部：核心入口区（按 order 排序，常驻）
  - 中部：插件入口区（按 order 排序，可滚动）
  - 底部：设置/更多（可选占位）
- 单项（ActivityBarItem）
  - Icon（24px 视觉尺寸）
  - Tooltip（hover 显示）
  - Selected 状态：
    - 背景高亮 + 左侧 2px accent 竖条
- 交互
  - Click：激活 item，并触发 sideBarViewId 对应视图
  - Disabled（when=false）：置灰，不响应点击

### 2) Side Bar（左侧边栏）
- 结构
  - Header：
    - 标题（当前激活 View 的 title）
    - 可选：actions（刷新/折叠/关闭）
  - Tabs：
    - 同区域多视图切换（仅展示 when=true 的 view）
  - Content：
    - 插件视图渲染容器（空态/加载态/错误态）
  - Resize Handle：
    - 位于 Side Bar 右边缘 6px 可拖拽热区
- 交互与状态
  - Tab Click：切换 activeViewId，并与 Activity Bar 激活态同步（如存在映射）
  - 拖拽：实时更新 sidebar 宽度（可节流写入 state）
  - Empty state：当无可用 view 时展示说明（如“暂无可用视图”）

### 3) Editor Area（主编辑区）
- 保持现有 EditorCore 容器占满剩余空间。
- 与 Side Bar 的边界使用 1px border 区分。

### 4) Responsive（补充行为约束）
- >= 1024px：完整显示 Activity Bar + Side Bar。
- 768–1024px：Side Bar 默认 180px，Activity Bar 保持。
- < 768px：
  - Activity Bar 隐藏或移到底部（由实现决定；文档侧先以“隐藏”为默认约定）
  - Side Bar 以抽屉 Drawer 形式出现（从左侧滑入）。

### 5) Animation / Transition（可选）
- Side Bar show/hide：`transform` 过渡 160–200ms。
- Active 切换：背景色过渡 120ms。
