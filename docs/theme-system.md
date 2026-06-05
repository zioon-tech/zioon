# Zion Next 主题系统设计文档

## 背景

Zion Next 已经具备基础的深浅色能力：

- `src/styles.css` 顶部定义了一批 CSS variables，如 `--bg`、`--panel`、`--fg`、`--accent`。
- `:root[data-theme="light"]` 提供浅色主题覆盖。
- `src/main.ts` 中负责读取 `localStorage("zion.theme")`，设置 `data-theme`，刷新编辑器主题，并更新 PWA `theme-color`。
- `EditorCore.setTheme()` 负责 CodeMirror 主题切换。
- 部分插件和 UI 模块通过 `getComputedStyle(document.documentElement)` 或 `:root[data-theme="light"]` 自行适配主题。

但是从“频繁调整主题”的角度看，目前实现还不够清晰：

- 真实颜色值散落在 `styles.css`、SettingsPanel 注入样式、Command Palette 注入样式、插件样式、CodeMirror theme、Terminal theme 等多个位置。
- 主题状态逻辑和主应用启动逻辑耦合在 `main.ts` 中。
- 部分组件直接写 light/dark override，而不是消费统一 token。
- PWA 静态 manifest、HTML 初始 `theme-color`、运行时 `meta[name="theme-color"]` 没有统一来源。
- 插件没有明确的主题接入规范，导致每个插件可能自定义一套颜色。

因此需要把当前“能切换主题”的实现升级为“可维护、可扩展、可频繁调试”的主题系统。

## 目标

1. 让主题成为 Settings 中的正式功能，而不是散落在状态栏、命令和本地存储中的隐式能力。
2. 支持用户选择 `System`、`Light`、`Dark`，并在 `System` 下跟随系统色彩方案。
3. 建立稳定的 token 分层，让后续调整主题主要修改 token 文件，而不是全局搜索颜色值。
4. 统一 app shell、编辑器、WYSIWYG、弹窗、PWA 外壳、插件面板的主题来源。
5. 保留已有 token 名称的兼容层，避免一次性大规模破坏现有样式。
6. 为插件提供清晰主题约定，避免插件各自维护 light/dark 颜色。
7. 为未来的 accent color、自定义主题、主题导入导出预留空间。

## 非目标

第一阶段不做以下内容：

- 不做完整主题市场。
- 不支持用户在 UI 中编辑每一个 token。
- 不做多套复杂内置主题，例如 Dracula、GitHub Dark、Nord 等。
- 不要求一次性消灭所有硬编码颜色。
- 不重写所有插件样式。

这些能力可以在基础主题系统稳定后逐步加入。

## 同类产品参考

### VS Code / Cursor

- 将主题作为核心偏好项，入口在 Settings 和 Command Palette。
- 支持 Color Theme、File Icon Theme、Product Icon Theme。
- 支持跟随系统主题，或分别指定 Light/Dark 主题。
- 扩展主题通过 token / semantic token 接入，不建议扩展随意硬编码颜色。

### Obsidian

- 将主题放在 Appearance 中。
- 主题设置不仅包含 Light/Dark，还包含 Accent color、字体、CSS snippets、界面密度等。
- 适合知识库/编辑器类产品，因为“阅读和编辑体验”属于外观的一部分。

### Notion / Linear / Slack

- 用户层面保持克制，通常只有 System / Light / Dark。
- 复杂视觉能力不直接暴露给普通用户。
- 强调整体一致性，而不是细粒度颜色编辑。

### 对 Zion Next 的启发

Zion Next 更接近 VS Code + Obsidian：

- 它有编辑器、插件、面板、命令面板、PWA 外壳，主题必须是系统能力。
- 它又有 Markdown/WYSIWYG 阅读体验，标题大小、字体、代码块、选择色等也属于 Appearance。
- 用户设置应保持简单，开发者调主题应依赖 token。

## 当前主题耦合点

### `src/styles.css`

当前 `styles.css` 顶部定义基础 token：

- `--bg`
- `--panel`
- `--border`
- `--fg`
- `--dim`
- `--accent`
- `--selection-bg`
- `--editor-tab-active-bg`
- `--panel-active-border`
- `--md-code-bg`

问题：

- 同一文件后续仍有大量 `rgba(...)`、`#...`、`color-mix(...)` 直接写在组件样式中。
- `:root[data-theme="light"] .some-component` 散落在不同组件附近。
- 有些颜色是语义 token，有些是组件 token，有些是布局 token，层级混杂。
- `--font-sans` 和 `--font-mono` 在顶部重复定义。

### `src/main.ts`

当前主题逻辑负责：

- 从 `localStorage("zion.theme")` 读取主题。
- 写回 `localStorage("zion.theme")`。
- 调用 `core.setTheme(t)` 和其他 panel core 的 `setTheme(t)`。
- 设置 `document.documentElement.setAttribute("data-theme", t)`。
- 刷新 WYSIWYG。
- 写入 `window.zion.state.set("ui.theme", t)`。
- 更新 `meta[name="theme-color"]`。
- 注册状态栏主题项。
- 注册 `zion.setTheme` 和 `zion.toggleTheme` 命令。

问题：

- 主题状态与 bootstrap 主流程耦合。
- 没有 `system` preference，只有 resolved theme。
- 主题命令、状态栏、PWA meta、编辑器刷新混在一个函数里。
- 后续新增设置页时容易继续向 `main.ts` 塞逻辑。

### `EditorCore` / CodeMirror

`EditorCore.setTheme(theme)` 负责编辑器主题。

问题：

- CodeMirror theme 和 CSS token 的关系不够清晰。
- 如果主题 token 调整，CodeMirror 侧可能需要手动同步。
- 插件中的 CodeMirror UI，例如 autocomplete，也有自己的 light override。

### `wysiwyg.ts`

WYSIWYG 直接读取 `document.documentElement.getAttribute("data-theme")`，并监听 `data-theme` 变化。

问题：

- 这是合理的运行时桥接，但应尽量只依赖 resolved theme。
- 更细粒度颜色应从 CSS variables 获取，而不是在 TS 中写死。

### SettingsPanel / Command Palette

这两个模块通过注入 CSS 的方式定义样式，其中包含：

- `:root[data-theme="light"] ...`
- 硬编码 `rgba(...)` 和 `#fff`
- 独立 scrollbar / hover / mask 颜色

问题：

- 它们属于核心 UI，应该优先迁移到组件 token。
- 否则以后调主题时，Settings 自身和 Command Palette 往往最容易出现不协调。

### Extensions

插件中存在多类主题接入方式：

- 使用核心 CSS variables，例如 `var(--panel)`、`var(--fg)`。
- 使用 `getComputedStyle(document.documentElement)` 读取 token，例如 terminal。
- 写入自己的 `:root[data-theme="light"]` override，例如 slash commands、image enhanced、compression settings。
- 直接写硬编码颜色。

问题：

- 没有统一规范。
- 插件作者不知道应该用哪些 token。
- 当核心主题调整后，插件可能视觉不一致。

## 推荐架构

主题系统分为四层：

```text
用户偏好层
  themePreference: system | light | dark
  resolvedTheme: light | dark

设计 Token 层
  color / typography / radius / shadow / motion / spacing

组件 Token 层
  tab / panel / cmdk / settings / editor / context-menu / toolbar

组件样式层
  只消费 token，不直接关心 light/dark
```

核心原则：

- 用户设置改变 theme preference。
- ThemeManager 解析出 resolved theme。
- DOM 只暴露 `data-theme="light|dark"`。
- 颜色只在 token 文件中定义。
- 组件 CSS 消费 token。
- 插件消费核心 token 或插件专属 token。

## 目录规划

建议新增：

```text
src/theme/
├── index.ts
├── themeManager.ts
├── pwa.ts
├── tokens.css
├── component-tokens.css
└── README.md
```

### `themeManager.ts`

负责主题状态和运行时副作用：

- 读取 `themePreference`。
- 兼容旧的 `zion.theme`。
- 监听 `prefers-color-scheme`。
- 设置 `data-theme`。
- 写入 `window.zion.state`。
- 发出 `theme/changed` 事件。
- 调用 editor refresh hook。
- 注册主题命令。

### `pwa.ts`

负责 PWA 和浏览器外壳颜色：

- 确保 `meta[name="theme-color"]` 存在。
- 从 CSS token 读取 `--app-theme-color` 或 `--color-bg-panel`。
- 在主题变化后更新 `meta[name="theme-color"]`。
- 提供 manifest 静态 fallback 建议值。

### `tokens.css`

只定义基础设计 token：

- 颜色
- 字体
- 圆角
- 阴影
- 动画时间
- 层级

### `component-tokens.css`

定义组件语义 token：

- panel
- tabs
- sidebar
- command palette
- settings
- editor
- markdown
- search
- selection toolbar
- context menu
- terminal

### `src/styles.css`

保留布局和组件结构样式：

- display / flex / grid / spacing
- width / height
- position
- overflow
- border-radius 使用 token
- background/color/border 使用 token

`styles.css` 不再承担主题定义职责。

## 主题状态模型

### Preference

用户选择：

```ts
type ThemePreference = "system" | "light" | "dark";
```

存储：

```text
localStorage["zion.themePreference"]
```

### Resolved Theme

实际应用：

```ts
type ResolvedTheme = "light" | "dark";
```

写入：

```html
<html data-theme="dark">
```

状态总线：

```ts
window.zion.state.set("ui.themePreference", preference);
window.zion.state.set("ui.theme", resolvedTheme);
```

事件：

```ts
window.zion.events.emit("theme/changed", {
  preference,
  resolvedTheme,
  source
});
```

### 旧配置迁移

当前旧配置：

```text
localStorage["zion.theme"] = "light" | "dark"
```

迁移策略：

1. 如果存在 `zion.themePreference`，优先使用。
2. 如果不存在，但存在 `zion.theme`，将其作为显式 preference。
3. 如果都不存在，默认 `system`。
4. 迁移后可以保留 `zion.theme` 作为兼容写入，避免旧插件读取失败。

## ThemeManager API

建议 API：

```ts
type ThemePreference = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";

interface ThemeChangedEvent {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  source: "init" | "settings" | "command" | "system" | "migration";
}

interface ThemeManager {
  init(): void;
  dispose(): void;
  getPreference(): ThemePreference;
  getResolvedTheme(): ResolvedTheme;
  setPreference(preference: ThemePreference, source?: ThemeChangedEvent["source"]): void;
  toggle(source?: ThemeChangedEvent["source"]): void;
  refresh(): void;
}
```

### Toggle 行为

推荐：

- 当前 resolved 是 dark，toggle 切到 light preference。
- 当前 resolved 是 light，toggle 切到 dark preference。
- 如果当前 preference 是 system，toggle 也切到相反的显式 preference。

这样命令面板中的 `Toggle Theme` 行为可预测。

## Settings 集成

新增设置页：

```ts
window.zion.settings.registerPage({
  id: "core.appearance",
  title: "Appearance",
  category: "general",
  order: 10,
  keywords: ["theme", "appearance", "color", "dark", "light", "system"],
  sections: [
    {
      id: "core.appearance.theme",
      title: "Theme",
      settings: [
        {
          id: "appearance.colorTheme",
          label: "Color theme",
          description: "Choose whether Zion Next uses a light theme, a dark theme, or follows the system appearance.",
          kind: "select",
          scope: "application",
          defaultValue: "system",
          enumOptions: [
            { label: "System", value: "system" },
            { label: "Light", value: "light" },
            { label: "Dark", value: "dark" }
          ],
          getValue: () => window.zion.theme.getPreference(),
          setValue: (value) => window.zion.theme.setPreference(String(value))
        }
      ]
    }
  ]
});
```

后续可以加入：

- `appearance.headingSize`
- `appearance.editorFontSize`
- `appearance.editorLineHeight`
- `appearance.compactMode`
- `appearance.accentColor`
- `appearance.pwaThemeColorMode`

这些都放在 Appearance 中，但不要一次性暴露过多。

## Token 命名规范

### 基础颜色 token

使用 `--color-*`：

```css
:root {
  --color-bg-app: #282c34;
  --color-bg-panel: #282a36;
  --color-bg-elevated: #303240;
  --color-bg-overlay: rgba(0, 0, 0, 0.42);

  --color-border-subtle: #44475a;
  --color-border-strong: #6272a4;

  --color-text-primary: #d1d5db;
  --color-text-secondary: rgba(209, 213, 219, 0.72);
  --color-text-muted: rgba(209, 213, 219, 0.56);

  --color-accent: #6272a4;
  --color-accent-rgb: 98, 114, 164;
  --color-success: #50fa7b;
  --color-warning: #e3b341;
  --color-danger: #ff6b6b;
}
```

浅色覆盖：

```css
:root[data-theme="light"] {
  --color-bg-app: #ffffff;
  --color-bg-panel: #ffffff;
  --color-bg-elevated: #f8f8fa;
  --color-bg-overlay: rgba(0, 0, 0, 0.18);

  --color-border-subtle: #dcdfe6;
  --color-border-strong: #3b82f6;

  --color-text-primary: #2a2a2a;
  --color-text-secondary: rgba(42, 42, 42, 0.72);
  --color-text-muted: rgba(42, 42, 42, 0.55);

  --color-accent: #3b82f6;
  --color-accent-rgb: 59, 130, 246;
  --color-success: #16a34a;
}
```

### 兼容 alias

短期保留旧 token：

```css
:root {
  --bg: var(--color-bg-app);
  --panel: var(--color-bg-panel);
  --border: var(--color-border-subtle);
  --fg: var(--color-text-primary);
  --dim: var(--color-text-muted);
  --accent: var(--color-accent);
  --accent-rgb: var(--color-accent-rgb);
  --ok: var(--color-success);
}
```

这样可以逐步迁移，不需要一次性改完整个 CSS。

### 组件 token

组件 token 使用组件名前缀：

```css
:root {
  --panel-bg: var(--color-bg-panel);
  --panel-border: var(--color-border-subtle);
  --panel-text: var(--color-text-primary);

  --tab-bg: transparent;
  --tab-bg-hover: color-mix(in srgb, var(--color-border-subtle) 34%, transparent);
  --tab-bg-active: var(--color-bg-panel);
  --tab-text: var(--color-text-primary);
  --tab-close-fade: linear-gradient(90deg, transparent, var(--tab-bg-active) 44%, var(--tab-bg-active));

  --cmdk-bg: var(--color-bg-panel);
  --cmdk-mask-bg: var(--color-bg-overlay);
  --cmdk-item-hover-bg: color-mix(in srgb, var(--color-accent) 12%, transparent);
  --cmdk-item-selected-bg: color-mix(in srgb, var(--color-accent) 16%, transparent);

  --settings-bg: var(--color-bg-panel);
  --settings-sidebar-bg: color-mix(in srgb, var(--color-bg-panel) 92%, black 8%);
  --settings-search-bg: var(--color-bg-elevated);

  --editor-bg: var(--color-bg-panel);
  --editor-selection-bg: color-mix(in srgb, var(--color-accent) 35%, transparent);
}
```

### 禁止事项

组件 CSS 中避免：

```css
.some-component {
  background: rgba(59, 130, 246, 0.14);
}
```

推荐：

```css
.some-component {
  background: var(--some-component-selected-bg);
}
```

如果没有合适 token，先新增 token，再使用 token。

## CSS 文件拆分

建议入口顺序：

```css
@import "./theme/tokens.css";
@import "./theme/component-tokens.css";
@import "./styles.css";
```

如果当前构建链路不方便 CSS import，也可以在 `index.html` 中临时引入：

```html
<link rel="stylesheet" href="/src/theme/tokens.css" />
<link rel="stylesheet" href="/src/theme/component-tokens.css" />
<link rel="stylesheet" href="/src/styles.css" />
```

最终建议由 `styles.css` 顶部 import：

```css
@import "./theme/tokens.css";
@import "./theme/component-tokens.css";
```

## CodeMirror 接入

CodeMirror 不能完全只靠全局 CSS，因为部分样式来自 `EditorView.theme()`。

推荐策略：

1. `EditorCore.setTheme(resolvedTheme)` 继续存在，但只接收 resolved theme。
2. 颜色尽量从 CSS variables 获取。
3. 对 CodeMirror 内部必须 JS 配置的颜色，建立一个集中映射函数。

示例：

```ts
function readThemeTokens() {
  const cs = getComputedStyle(document.documentElement);
  return {
    bg: cs.getPropertyValue("--editor-bg").trim(),
    fg: cs.getPropertyValue("--color-text-primary").trim(),
    selection: cs.getPropertyValue("--editor-selection-bg").trim(),
    caret: cs.getPropertyValue("--editor-caret-color").trim()
  };
}
```

注意：

- 不要在多个 extension 中重复读取 `--panel`、`--fg`。
- 可以提供 `window.zion.theme.getToken(name)`，作为插件和编辑器扩展的统一入口。

## WYSIWYG 接入

WYSIWYG 当前监听 `data-theme` 是合理的。

后续建议：

- 继续使用 `data-theme` 作为粗粒度主题切换信号。
- 具体颜色尽量交给 CSS variables。
- Mermaid / PlantUML / KaTeX 如果需要 theme option，应由 themeManager 发出的 `theme/changed` 驱动刷新。
- 标题大小等视觉设置不要混在 color theme 中，应作为 Appearance 下的独立设置。

## PWA 接入

### 静态配置

需要统一：

- `vite.config.ts` 中的 PWA manifest。
- `public/manifest.json`。
- `index.html` 中的初始 `meta[name="theme-color"]`。

推荐静态兜底：

```json
{
  "theme_color": "#282a36",
  "background_color": "#282a36"
}
```

理由：

- Zion Next 默认更偏暗色编辑器。
- 暗色启动背景可以减少 PWA 启动白屏闪烁。
- 运行后会由 themeManager 动态修正 `meta[name="theme-color"]`。

### 运行时

推荐新增 token：

```css
:root {
  --app-theme-color: var(--color-bg-panel);
  --app-background-color: var(--color-bg-app);
}
```

`pwa.ts` 读取：

```ts
const themeColor = getComputedStyle(document.documentElement)
  .getPropertyValue("--app-theme-color")
  .trim();
```

## 插件主题规范

插件应遵守以下规则：

1. 优先使用核心 CSS variables。
2. 不直接写 `:root[data-theme="light"]`，除非确实需要特殊处理。
3. 不自行定义全套 light/dark 色板。
4. 插件专属 token 使用插件前缀。
5. JS 需要颜色时，通过 `window.zion.theme.getToken()` 或少数集中桥接点读取。

### 插件 CSS 示例

```css
.zion-my-plugin-panel {
  background: var(--color-bg-panel);
  color: var(--color-text-primary);
  border: 1px solid var(--color-border-subtle);
}

.zion-my-plugin-item:hover {
  background: var(--interactive-hover-bg);
}
```

### 插件专属 token

```css
:root {
  --my-plugin-card-bg: var(--color-bg-elevated);
  --my-plugin-card-border: var(--color-border-subtle);
}
```

## Settings 中的外观设置规划

### 第一版

```text
Appearance
└── Theme
    └── Color theme: System | Light | Dark
```

### 第二版

```text
Appearance
├── Theme
│   ├── Color theme
│   └── Accent color
├── Editor
│   ├── Font size
│   ├── Line height
│   └── Font family
└── Markdown
    └── Heading size: Normal | Small | Extra small
```

### 第三版

```text
Appearance
├── Theme
│   ├── Color theme
│   ├── Accent color
│   ├── Import theme
│   └── Export theme
├── Layout
│   ├── Compact mode
│   └── Panel focus highlight
└── Advanced
    ├── Custom CSS
    └── Reset appearance settings
```

## 迁移计划

### 阶段 1：抽离 ThemeManager

目标：

- 从 `main.ts` 中移出主题状态逻辑。
- 支持 `system` preference。
- 注册 Settings 的 Appearance 页面。
- 保持现有 UI 视觉不变。

任务：

- 新增 `src/theme/themeManager.ts`。
- 新增 `src/theme/pwa.ts`。
- 在 bootstrap 中初始化 ThemeManager。
- 将 `zion.setTheme`、`zion.toggleTheme` 改为调用 ThemeManager。
- 迁移旧 `localStorage("zion.theme")`。

验收：

- 现有 light/dark 切换正常。
- 选择 System 后跟随系统。
- 状态栏、命令面板、设置页操作结果一致。
- 编辑器和 WYSIWYG 刷新正常。

### 阶段 2：拆出 Token 文件

目标：

- 将 `styles.css` 顶部 token 移入 `src/theme/tokens.css`。
- 新增 `src/theme/component-tokens.css`。
- 保留旧 token alias。

任务：

- 把基础颜色改名为 `--color-*`。
- 保留 `--bg`、`--panel`、`--fg` 等兼容 alias。
- 将 tabs、panel、selection、search、markdown 的 token 移入 component tokens。

验收：

- 不改组件样式也能保持现有视觉。
- 新旧 token 同时可用。
- 主题切换无视觉回退。

### 阶段 3：迁移核心高频组件

优先迁移：

- editor tabs
- panel focus highlight
- command palette
- settings panel
- context menu
- selection toolbar
- search highlight

任务：

- 将硬编码颜色替换为组件 token。
- 减少散落的 `:root[data-theme="light"] .component`。
- 对每个组件补充 token 注释。

验收：

- 修改 `component-tokens.css` 即可调整上述组件视觉。
- 组件 CSS 不再直接写主要颜色值。

### 阶段 4：编辑器与渲染层统一

目标：

- CodeMirror、WYSIWYG、Markdown UI 统一消费主题 token。

任务：

- 梳理 `EditorCore.setTheme()`。
- 将 autocomplete theme 的 light override 转为 token。
- WYSIWYG 图表、表格、代码块读取 token。
- 标题大小迁移到 Appearance 设置。

验收：

- 编辑器选择色、搜索色、代码块、表格、图表在 light/dark 下统一。
- 调整 token 不需要修改 TS 逻辑。

### 阶段 5：插件治理

目标：

- 插件接入主题系统有规范。

任务：

- 暴露 `window.zion.theme` API。
- 编写插件主题接入规范。
- 优先迁移 terminal、slash commands、image enhanced、compression settings。

验收：

- 插件不再各自维护主要 light/dark 色。
- 插件能响应 `theme/changed`。

### 阶段 6：高级能力

可选能力：

- Accent color 设置。
- Custom CSS。
- Theme import/export。
- 主题预览。
- 内置多主题。

## 开发约束

新增或修改 UI 样式时遵守：

1. 先找现有 token。
2. 没有合适 token，先新增 token。
3. 组件 CSS 禁止直接写主要颜色。
4. 允许局部写透明度或临时调试色，但最终必须收敛到 token。
5. JS 中读取颜色必须通过主题 API 或集中 helper。
6. 插件样式必须以 `var(--color-*)` 或插件 token 为主。
7. `:root[data-theme="light"] .component` 只能作为过渡方案，不能成为长期写法。

## 推荐审查清单

每次涉及主题/样式的 PR 检查：

- 是否新增了硬编码颜色？
- 是否可以使用现有 token？
- 是否需要新增组件 token？
- light/dark 是否都检查过？
- PWA `theme-color` 是否受影响？
- SettingsPanel / Command Palette / Editor 是否视觉一致？
- 插件是否使用核心 token？
- 是否破坏了旧 token alias？

## 风险与注意事项

### 风险：一次性迁移过大

不要一次性改完整个 `styles.css`。应该先建立 alias，再逐步替换。

### 风险：token 太多

token 过多会变得难以维护。只有复用价值明确的颜色才提升为 token。

### 风险：用户设置和开发 token 混淆

用户设置不应该暴露所有 token。Settings 面向产品功能，token 面向开发和主题作者。

### 风险：插件破坏一致性

插件允许自定义视觉，但应继承核心 token。需要建立插件主题规范和 lint/checklist。

### 风险：PWA 缓存导致 manifest 更新不明显

manifest 改动可能受 service worker / browser cache 影响，测试时需要重新安装 PWA 或清缓存。

## 建议的第一步实现

最小可落地 PR：

1. 新增 `src/theme/themeManager.ts` 和 `src/theme/pwa.ts`。
2. 从 `main.ts` 抽离当前 `applyTheme`。
3. 新增 `themePreference = system | light | dark`。
4. 注册 `Appearance -> Color theme` 设置项。
5. 保持 `data-theme`、`ui.theme`、`zion.theme` 兼容。
6. 统一 `meta[name="theme-color"]` 更新逻辑。
7. 不改 `styles.css` 的大部分内容，只保证行为先统一。

这样可以先解决“主题作为设置功能”和“状态逻辑耦合”的问题，再逐步治理样式 token。

## 长期目标

最终状态应该是：

- 用户在 Settings 中选择主题偏好。
- ThemeManager 是唯一主题状态入口。
- `data-theme` 是唯一 DOM 主题标记。
- CSS token 是唯一颜色来源。
- 核心组件和插件消费 token。
- 编辑器和 PWA 通过主题桥接层同步。
- 频繁调主题时，主要修改 `tokens.css` 和 `component-tokens.css`，不需要深入业务逻辑。
