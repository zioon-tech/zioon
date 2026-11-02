# Zion Next 主题与样式体系

> 本文档面向插件开发者和主题创作者，解释 Zion Next 的样式架构、CSS 变量系统以及如何创建自定义主题。

---

## 目录

1. [整体架构](#1-整体架构)
2. [CSS 变量（Design Tokens）](#2-css-变量design-tokens)
3. [内置主题预设](#3-内置主题预设)
4. [插件扩展的样式管理](#4-插件扩展的样式管理)
5. [创建自定义主题](#5-创建自定义主题)
6. [ThemeVariant API](#6-themevariant-api)
7. [主题注册全流程示例](#7-主题注册全流程示例)
8. [CSS 变量完整清单](#8-css-变量完整清单)

---

## 1. 整体架构

```
┌─────────────────────────────────────────────────┐
│ src/styles.css（~4200 行）                        │
│                                                   │
│  :root { }           ← 暗色默认变量值              │
│  [data-theme="light"] ← 亮色覆盖                   │
│  [data-theme="dark"][data-theme-variant="…"] ← 预设│
│  全局排版 / Gutters / Context Menu                │
└─────────────────────────────────────────────────┘
         ↕ CSS 层叠（变量继承）
┌─────────────────────────────────────────────────┐
│ extensions/*/styles.css（15 个扩展）              │
│                                                   │
│  每个扩展独立的 CSS，通过 Vite 构建时自动打包       │
│  （import.meta.glob("/extensions/**/styles.css"） │
└─────────────────────────────────────────────────┘
         ↕ 同一份 CSS 变量
┌─────────────────────────────────────────────────┐
│ 第三方插件 contributes.styles（运行时加载）         │
│  PluginManager.autoLoadStyles() 自动注入           │
│  停用时自动清理                                    │
└─────────────────────────────────────────────────┘
```

**关键原则：所有 UI 组件以 CSS 自定义属性（`var(--xxx)`）引用设计 token，绝不硬编码颜色值。**

### 主题切换链路

```
ThemeManager.setSelection("github-dark")
  → localStorage 持久化
  → document.documentElement 设置 data-theme 和 data-theme-variant
  → CSS 层叠自动应用对应变量值
  → 触发 theme/changed 事件（插件可监听）
  → 更新状态栏和命令面板显示
```

---

## 2. CSS 变量（Design Tokens）

### 核心层（5 个必覆盖变量）

| 变量名 | 作用 | 使用场景 |
|--------|------|---------|
| `--bg` | 全局背景色 | 编辑器、工作台背景 |
| `--panel` | 面板背景色 | 侧边栏、底部面板、设置面板 |
| `--border` | 边框色 | 所有 `border` 属性 |
| `--fg` | 前景（文字）色 | 所有 `color` 属性 |
| `--accent` | 强调色 | 按钮、选中项、链接、焦点 |

覆盖这 5 个变量可以改变整个应用的外观。建议同时覆盖 `--dim`（次级文字不透明度）和 `--ok`（成功/完成状态色）。

### 派生层

派生变量通过 `color-mix()` 从核心变量计算得出，无需逐个覆盖：

```css
--hover-bg: color-mix(in srgb, var(--fg) 6%, transparent);
--active-bg: color-mix(in srgb, var(--accent) 10%, transparent);
--focus-ring: 0 0 0 1px color-mix(in srgb, var(--accent) 48%, transparent);
```

### 间距体系（4px 网格）

| 变量 | 值 | 用途 |
|------|----|------|
| `--space-1` | 4px | 最小间距 |
| `--space-2` | 8px | 紧凑间距 |
| `--space-3` | 12px | 标准间距 |
| `--space-4` | 16px | 宽松间距 |
| `--space-5` | 24px | 大间距 |
| `--space-6` | 32px | 超大间距 |

### 字体栈

```css
--font-sans: "SF Pro Text", -apple-system, BlinkMacSystemFont, ...;
--font-mono: "Fira Code", "JetBrains Mono", "SF Mono", ...;
```

建议自定义主题时优先覆盖字体栈，视觉差异化最大。

---

## 3. 内置主题预设

内置 10 套主题变体（`data-theme-variant`），定义在 `src/styles.css` 中：

| variant | 基色 | 风格 |
|---------|------|------|
| `default`（空值） | dark / light | 核心默认 |
| `visual-studio-dark` | dark | VS Code 风格 |
| `github-dark` | dark | GitHub Dark |
| `github-light` | light | GitHub Light |
| `catppuccin-mocha` | dark | 柔和暖色暗色 |
| `catppuccin-latte` | light | 柔和奶油浅色 |
| `tokyo-night` | dark | 蓝紫科技感 |
| `rose-pine-dawn` | light | 暖纸张感 |
| `everforest-light` | light | 护眼米绿 |
| `kanagawa-lotus` | light | 日式纸张感 |
| `xiaohongshu` | light | 暖白珊瑚红 |
| `wechat` | light | 清爽浅绿 |

---

## 4. 插件扩展的样式管理

### 4.1 内置扩展的 CSS

每个内置扩展的样式单独存放在自己的 `styles.css` 中，通过 `import.meta.glob` 在 Vite 构建时自动打包：

```typescript
// src/main.ts
import.meta.glob("/extensions/**/styles.css", { eager: true });
```

### 4.2 第三方插件的 CSS

第三方插件通过 `manifest.json` 声明：

```json
{
  "zion": {
    "contributes": {
      "styles": ["./theme.css"]
    }
  }
}
```

PluginManager 在 `activate()` 时自动 `fetch()` 并注入 `<style>`，在 `deactivate()` 时自动清理。

### 4.3 运行时样式注入 API

```typescript
window.zion.styles.register(id: string, css: string): Disposable
window.zion.styles.registerStylesheet(id: string, url: string): Disposable
```

返回的 `Disposable` 调用 `dispose()` 时自动移除注入的样式。

---

## 5. 创建自定义主题

### 最低模板

一个主题插件只需 3 个文件：

```
extensions/my-theme/
├── manifest.json
├── main.js
└── theme.css
```

#### manifest.json

```json
{
  "name": "my-theme",
  "version": "0.0.1",
  "zion": {
    "id": "my-theme",
    "name": "My Theme",
    "version": "0.0.1",
    "main": "./main.js",
    "contributes": {
      "styles": ["./theme.css"]
    },
    "activationEvents": ["onStartupFinished"],
    "engines": { "zion": ">=1.0.0" }
  }
}
```

#### main.js

```javascript
export async function activate(ctx) {
  const disp = window.zion.theme.registerVariant("my-theme", {
    title: "My Theme",
    baseTheme: "dark",       // "dark" | "light" | "system"
    css: ""                   // 样式在 theme.css 中
  });
  ctx.subscriptions.push(disp);
}
```

#### theme.css

```css
:root[data-theme="dark"][data-theme-variant="my-theme"] {
  --bg: #0d1117;
  --panel: #161b22;
  --border: #30363d;
  --fg: #c9d1d9;
  --accent: #58a6ff;
  --ok: #3fb950;
  --dim: rgba(201, 209, 217, 0.60);
  --font-sans: "IBM Plex Sans", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
}
```

### CSS 隔离机制

自定义主题的 CSS 需要包裹在正确的属性选择器中，确保不会泄露到其他主题：

```css
/* ✅ 正确：只在 my-theme 激活时生效 */
:root[data-theme="dark"][data-theme-variant="my-theme"] {
  --bg: #0a0015;
}

/* ✅ 如需覆盖具体组件（该组件没使用 CSS 变量） */
:root[data-theme="dark"][data-theme-variant="my-theme"] .zion-some-class {
  background: linear-gradient(...);
}

/* ❌ 错误：会在所有暗色主题下生效 */
:root[data-theme="dark"] {
  --bg: #0a0015;
}
```

---

## 6. ThemeVariant API

### `window.zion.theme.registerVariant(id, opts)`

注册一个自定义主题变体，使其出现在主题选择器和命令面板中。

#### 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 主题标识符，同时也是 `data-theme-variant` 属性值 |
| `opts.title` | `string` | 主题选择器中显示的名称 |
| `opts.baseTheme` | `"dark" \| "light" \| "system"` | 基础主题，决定变量初始值 |
| `opts.css` | `string` | CSS 变量覆盖语句（无需属性选择器包装） |

#### 返回值

`{ dispose(): void }` — 插件停用时调用以清理 CSS 和注销主题。

#### 完整 API 清单

```typescript
window.zion.theme = {
  // 读取
  getPreference(): "system" | "light" | "dark"
  getSelection(): string           // 当前选中项 ID
  getResolvedTheme(): "light" | "dark"
  getVariant(): string

  // 设置
  setSelection(selection: string)
  setPreference(preference: "system" | "light" | "dark")
  setVariant(variant: string)

  // 注册
  registerVariant(id: string, opts: {
    title: string
    baseTheme: "system" | "light" | "dark"
    css: string
  }): Disposable

  // 快捷
  toggle()
  refresh()
  getToken(name: string): string   // 读取当前 CSS 变量值
}
```

---

## 7. 主题注册全流程示例

```javascript
// my-awesome-theme/main.js

const THEME_ID = "solarized-light";

export async function activate(ctx) {
  // 1. 注册主题变体（注入 CSS + 注册到选择器）
  const themeDisp = window.zion.theme.registerVariant(THEME_ID, {
    title: "Solarized Light",
    baseTheme: "light",
    css: ""  // 样式来自 contributes.styles 加载的 theme.css
  });
  ctx.subscriptions.push(themeDisp);

  // 2. 注册切换命令（可选）
  const cmdDisp = window.zion.commands.registerCommand(
    "myTheme.apply",
    () => {
      window.zion.theme.setSelection(THEME_ID);
      window.zion.notification.show("切换到 Solarized Light", {
        type: "success"
      });
    }
  );
  ctx.subscriptions.push(cmdDisp);

  // 3. 监听主题变化（可选）
  const listenerDisp = window.zion.events.on("theme/changed", (event) => {
    console.log("主题切换:", event.preference, event.variant);
  });
  ctx.subscriptions.push(listenerDisp);
}
```

```css
/* my-awesome-theme/theme.css */

/* 深色变体（可选） */
:root[data-theme="dark"][data-theme-variant="solarized-dark"] {
  --bg: #002b36;
  --panel: #073642;
  --border: #586e75;
  --fg: #839496;
  --accent: #268bd2;
  --ok: #859900;
}

/* 浅色变体 */
:root[data-theme="light"][data-theme-variant="solarized-light"] {
  --bg: #fdf6e3;
  --panel: #eee8d5;
  --border: #93a1a1;
  --fg: #657b83;
  --accent: #268bd2;
  --ok: #859900;
}
```

---

## 8. CSS 变量完整清单

> 按类别分组。带 `★` 的为核心变量，自定义主题推荐覆盖。

### 8.1 颜色核心 ★

| 变量 | 暗色默认值 | 说明 |
|------|-----------|------|
| `--bg` | `#282c34` | 全局背景 |
| `--panel` | `#282a36` | 面板背景 |
| `--border` | `#44475a` | 边框 |
| `--fg` | `#d1d5db` | 前景文字 |
| `--dim` | `rgba(209,213,219,0.60)` | 次级文字 |
| `--accent` | `#6272a4` | 强调色 |
| `--accent-rgb` | `98, 114, 164` | 强调色 RGB（用于 `rgba()`） |
| `--ok` | `#50fa7b` | 成功/完成状态 |

### 8.2 字体 ★

| 变量 | 说明 |
|------|------|
| `--font-sans` | 无衬线字体栈 |
| `--font-mono` | 等宽字体栈 |
| `--editor-font-size` | 编辑器字号 |
| `--editor-line-height` | 编辑器行高 |
| `--editor-content-font-family` | 编辑器内容字体 |
| `--editor-content-font-size` | 编辑器内容字号 |
| `--editor-content-line-height` | 编辑器内容行高 |
| `--editor-text-fg` | 编辑器文字颜色 |

### 8.3 间距

| 变量 | 值 |
|------|----|
| `--space-1` | `4px` |
| `--space-2` | `8px` |
| `--space-3` | `12px` |
| `--space-4` | `16px` |
| `--space-5` | `24px` |
| `--space-6` | `32px` |

### 8.4 交互状态

| 变量 | 说明 |
|------|------|
| `--hover-bg` | 悬停背景 |
| `--active-bg` | 激活背景 |
| `--active-border-left` | 激活左边界 |
| `--focus-ring` | 焦点环 |
| `--transition-fast` | 快速过渡（80ms） |
| `--transition-normal` | 正常过渡（150ms） |

### 8.5 角色 Token ★

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `--role-user-fg` | `#4caf50` | 用户角色前景 |
| `--role-user-bg` | `rgba(76,175,80,0.18)` | 用户角色背景 |
| `--role-user-border` | `rgba(76,175,80,0.25)` | 用户角色边框 |
| `--role-assistant-fg` | `#2196f3` | 助手角色前景 |
| `--role-assistant-bg` | `rgba(33,150,243,0.12)` | 助手角色背景 |
| `--role-assistant-border` | `rgba(33,150,243,0.22)` | 助手角色边框 |
| `--role-system-fg` | `#9e9e9e` | 系统角色前景 |
| `--role-system-bg` | `rgba(158,158,158,0.18)` | 系统角色背景 |
| `--role-system-border` | `rgba(158,158,158,0.28)` | 系统角色边框 |

### 8.6 编辑器

| 变量 | 说明 |
|------|------|
| `--editor-bg` | 编辑器背景 |
| `--editor-gutter-bg` | 行号区域背景 |
| `--editor-gutter-fg` | 行号文字色 |
| `--editor-gutter-border` | 行号区域边框 |
| `--editor-gutter-active-bg` | 行号区域激活行背景 |
| `--editor-gutter-active-fg` | 行号区域激活行文字色 |
| `--editor-fold-hover-bg` | 折叠标记悬停背景 |

### 8.7 面板系统

| 变量 | 说明 |
|------|------|
| `--panel-header-height` | 面板标题栏高度 |
| `--panel-header-padding` | 面板标题栏内边距 |
| `--panel-header-font` | 面板标题栏字体 |
| `--panel-header-border` | 面板标题栏边框 |
| `--list-item-height` | 列表项高度 |
| `--list-item-padding` | 列表项内边距 |
| `--list-item-hover-bg` | 列表项悬停背景 |
| `--list-item-active-bg` | 列表项激活背景 |
| `--list-item-icon-size` | 列表项图标大小 |
| `--list-item-gap` | 列表项间距 |

### 8.8 面板活跃状态

| 变量 | 说明 |
|------|------|
| `--panel-active-border` | 面板活跃边框色 |
| `--panel-active-glow` | 面板活跃发光色 |
| `--panel-active-shadow` | 面板活跃投影 |

### 8.9 文件浏览 / 预览

| 变量 | 说明 |
|------|------|
| `--files-explorer-bg` | 文件树背景 |
| `--files-preview-bg` | 文件预览背景 |
| `--files-header-bg` | 文件头部背景 |
| `--files-tab-bg` | 文件标签背景 |
| `--files-tab-hover-bg` | 文件标签悬停背景 |
| `--files-tab-active-bg` | 文件标签激活背景 |
| `--files-splitter-bg` | 分割线颜色 |
| `--files-muted-fg` | 文件次级文字 |

### 8.10 活动栏 / 侧边栏 / 辅助栏 / 底栏

| 变量 | 说明 |
|------|------|
| `--activitybar-item-hover-bg` | 活动栏项悬停背景 |
| `--activitybar-item-active-bg` | 活动栏项激活背景 |
| `--auxbar-tab-hover-bg` | 辅助栏标签悬停背景 |
| `--auxbar-tab-active-bg` | 辅助栏标签激活背景 |
| `--sidebar-tab-active-bg` | 侧边栏标签激活背景 |
| `--sidebar-tab-active-border` | 侧边栏标签激活边框 |
| `--bottompanel-tab-active-bg` | 底栏标签激活背景 |

### 8.11 自定义扩展变量

扩展可以定义自己的 CSS 变量（以 `--ext-` 或 `--sessions-` 等前缀命名），这些变量同样可被主题覆盖：

| 变量 | 默认值推导 | 所属扩展 |
|------|-----------|---------|
| `--ext-toc-bg` | `var(--editor-bg)` | dev.toc |
| `--ext-toc-fg` | `color-mix(...)` | dev.toc |
| `--ext-toc-active-fg` | `var(--accent)` | dev.toc |
| `--ext-toc-hover` | `color-mix(...)` | dev.toc |
| `--ext-toc-role-user` | `var(--role-user-fg)` | dev.toc |
| `--ext-toc-role-assistant` | `var(--role-assistant-fg)` | dev.toc |
| `--ext-toc-role-system` | `var(--role-system-fg)` | dev.toc |
| `--sessions-current-bg` | `color-mix(...)` | dev.session-manager |
| `--sessions-heatmap-active` | `var(--ok)` | dev.session-manager |
| `--sessions-heatmap-empty` | `color-mix(...)` | dev.session-manager |

### 8.12 滚动条

| 变量 | 说明 |
|------|------|
| `--scrollbar-thumb` | 滚动条滑块 |
| `--scrollbar-thumb-hover` | 滚动条滑块悬停 |
| `--scrollbar-track` | 滚动条轨道 |

---

## 附录 A：常见问题

### 我的主题 CSS 不生效

检查以下顺序：

1. **属性选择器是否正确？**
   ```css
   /* 对暗色基座的主题 */
   :root[data-theme="dark"][data-theme-variant="my-theme"] { }

   /* 对亮色基座的主题 */
   :root[data-theme="light"][data-theme-variant="my-theme"] { }
   ```

2. **优先级是否足够？**
   内置主题的 CSS 在 `src/styles.css` 中，`registerVariant` 注入的 `<style>` 在 `<head>` 末尾。如果仍有冲突，使用 `color-mix()` 或 `!important`（慎用）。

3. **`registerVariant()` 是否被调用？**
   检查浏览器控制台是否有 `[theme-demo] 已注册主题` 之类的日志。

### 如何在 JS 运行时监听主题变化？

```javascript
const disp = window.zion.events.on("theme/changed", (event) => {
  console.log("新主题:", event.preference, event.variant);
  console.log("解析结果:", event.resolvedTheme);
  console.log("来源:", event.source);
});
```

### 如何在 Webview / iframe 中跟随主题？

```css
/* Webview HTML */
body {
  background: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-editor-foreground, #d4d4d4);
}
```

对于未使用 CSS 变量的 iframe，可通过 `postMessage` 或定期读取 `getComputedStyle(document.documentElement).getPropertyValue('--bg')` 同步。

---

## 附录 B：完整示例项目

参见 `extensions/dev.theme-demo/`，这是一个可直接运行的 Neon Glow 霓虹主题插件，演示了：

- `manifest.json` 声明
- `registerVariant()` API 调用
- 完整的 CSS 变量覆盖
- 命令注册和菜单注册
