# Zion UI Visual System V2

> 目标：把 `icon-comparison.html` 中更完整、更现代的视觉语言落回 zion-next。Phase 3 不再是局部“修丑点”，而是一次受控的整体 UI pass：先做主壳样板，再推广到插件面板。

## 1. 设计判断

前两轮已经把很多旧问题收敛到 token：圆角、hover、active、role pill、markdown、widget、session 选中态、codicon 来源统一。但整体仍不够“完整”，原因是样式系统还没有统一到同一种视觉语言。

`icon-comparison.html` 好看的核心不是某一个图标，而是整套节奏一致：

- surface 层级统一：背景、panel、soft panel、浮层有明确层次。
- 边框更轻：大量使用低透明度 border，而不是硬描边。
- shadow 更克制：只给浮层/卡片提供空间关系，不制造厚重感。
- 圆角更现代：小按钮 6px，卡片 10px，大容器 16px。
- icon button 有容器节奏：默认安静，hover/active 再显性。
- 文字层级收敛：标题、正文、meta、chip 都有明确尺寸和颜色。

## 2. Phase 3 范围

### 2.1 先做样板

样板只覆盖三个最高频区域：

1. **Workbench shell**
   - activitybar
   - sidebar / auxbar / bottompanel 外壳
   - panel header / tab / action

2. **Editor header**
   - tab/header bar
   - header action button
   - icon spacing / hover / active

3. **Right context panel**
   - section header
   - tree row
   - file/context/task row
   - copy / chevron / status button

### 2.2 暂不全量铺开

样板确认后，再迁移：

- session-manager 内部列表
- files/memory panel
- TOC toolbar
- thinking/tool-call cards
- terminal / comments / agents / model switcher
- icon system registry

## 3. Visual Tokens

### 3.1 Surface

新增或强化以下语义 token：

```css
--surface-bg: var(--bg);
--surface-panel: var(--panel);
--surface-panel-soft: color-mix(in srgb, var(--panel) 88%, var(--bg));
--surface-raised: color-mix(in srgb, var(--panel) 94%, var(--bg));
--surface-overlay: color-mix(in srgb, var(--panel) 96%, var(--bg));
--surface-border: color-mix(in srgb, var(--border) 46%, transparent);
--surface-border-soft: color-mix(in srgb, var(--border) 28%, transparent);
```

目标：

- 大背景保持安静。
- 面板不再全靠硬分割线，而是靠轻边框 + subtle surface 区分。
- header 使用 `--surface-panel-soft`，内容区使用 `--surface-panel`。

### 3.2 Radius

沿用现有 radius token，但解释更明确：

| token | 值 | 用途 |
| --- | --- | --- |
| `--radius-sm` | 6px | icon button、row、input |
| `--radius-md` | 10px | card、toolbar、panel item |
| `--radius-lg` | 16px | popover、major surface |
| `--radius-pill` | 999px | tag、role、status pill |

如果老 token 当前是 4/6/8，可以在 Phase 3 样板中先通过局部 selector 使用更大的 radius，不立刻全局改值，避免影响过大。

### 3.3 Elevation

```css
--elevation-soft: 0 1px 2px rgba(0,0,0,0.06);
--elevation-panel: 0 8px 28px rgba(0,0,0,0.10);
--elevation-overlay: 0 18px 56px rgba(0,0,0,0.18);
```

暗色主题下 shadow 只用于浮层和 panel active，不给所有区域加阴影。

### 3.4 Icon Button

三档：

| 类型 | 尺寸 | 图标尺寸 | 用途 |
| --- | --- | --- | --- |
| small | 24x24 | 14 | inline、tree row |
| medium | 28x28 | 15/16 | toolbar、panel action |
| large | 30x30 | 16 | editor header、activitybar |

统一状态：

```css
color: color-mix(in srgb, var(--fg) 64%, transparent);
background: transparent;
border-radius: var(--radius-sm);
```

hover:

```css
background: var(--hover-bg);
color: var(--fg);
```

active/selected:

```css
background: var(--active-bg);
color: var(--accent);
```

### 3.5 List Row

```css
min-height: 28px;
padding: 3px 8px;
border-radius: var(--radius-sm);
gap: 8px;
```

hover 使用 `--hover-bg`，selected 使用 `--active-bg` + 文本/图标 accent。

普通列表 item **不使用左侧高亮条**。左侧 2px indicator 只保留给一级导航，例如 activitybar 当前入口；session row、context tree row、文件树 row、TOC row 都应使用整行柔和底色表达选中态。

## 4. 样板落地策略

### 4.1 CSS 优先，不动行为

样板阶段只改 CSS。图标仍可暂时是 codicon，先把“壳、按钮、行、层级”调到 `icon-comparison.html` 的视觉节奏。

### 4.2 保持主题体系

不引入固定色板。所有颜色仍走现有多主题 token：

- `--bg`
- `--panel`
- `--border`
- `--fg`
- `--dim`
- `--accent`
- `--hover-bg`
- `--active-bg`

V2 token 是语义别名，不替代主题系统。

### 4.3 样板验收

- 亮色主题：界面更轻，panel/header 不发灰，边框不硬。
- 暗色主题：层次更清晰，panel 不糊成一片，hover/active 不刺眼。
- header / context panel / sidebar 三块看起来属于同一个系统。
- 不改变布局尺寸的大结构，不影响按钮点击和插件渲染。

## 5. 后续路线

1. **V2-A：主壳样板**
   - `src/styles.css`
   - workbench shell / activitybar / sidebar / auxbar / bottompanel / editor header

2. **V2-B：右侧 context panel 样板**
   - `extensions/dev.tools/styles.css`
   - section / tree / row / file item / status pill

3. **V2-C：图标系统**
   - 从 codicon 迁移到中心化 `ZionIcon`
   - 先替换 header + context + session + TOC 的高频图标

4. **V2-D：插件面板推广**
   - session-manager
   - files/memory
   - thinking/tool-call
   - terminal/comments/agents/model switcher

## 6. 当前样板改动原则

- 不改命令、不改事件、不改 DOM 结构。
- 不大幅改变内容密度，避免影响编辑效率。
- 使用 scoped selectors，避免一次性影响所有插件。
- 每轮必须做亮/暗主题截图。
