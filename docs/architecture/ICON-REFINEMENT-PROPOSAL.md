# Icon Refinement Proposal

> 目标：重新审视 Zion Editor 的整体图标视觉。上一轮已解决“来源混用”的工程问题，但 codicon 本身偏硬、偏 VS Code 工具感，和当前更轻、更圆润的界面语言不完全匹配。本方案先定义要改成什么样，再进入实现。

## 1. 当前判断

### 1.1 已改善的问题

- 大部分面板图标已从手写 SVG / unicode 字符统一到 codicon。
- 图标尺寸、语义和 DOM 结构比之前稳定。
- 暗/亮主题下图标继承 `currentColor`，主题适配没有明显问题。

### 1.2 仍然不好看的原因

- **codicon 气质偏硬**：线条直、转角硬、符号密度高，适合 VS Code 原生 UI，但放在当前界面里显得“工程味”重。
- **局部图标语义太工具化**：`fold/unfold`、`list-tree`、`layout-panel`、`layout-sidebar-right` 这类符号识别没问题，但视觉上不够轻。
- **按钮容器没有完全替图标减压**：部分 header / toolbar 图标裸露在界面上，hover 背景、留白、透明度没有统一到一个更柔和的系统。
- **仍有尾巴来源混杂**：少数模块还存在 unicode 箭头、闪电符号、registry 内联 SVG。即使不显眼，也会破坏整体一致性。

## 2. 推荐方向

### 2.1 不建议继续“纯 codicon 精修”

只靠 opacity、尺寸和 hover 背景能缓解，但不能解决 codicon 本身的硬朗气质。继续在 codicon 内换 glyph，收益有限。

### 2.2 推荐：建立一套 Zion Icon System

采用一套更轻、更圆润的线性图标作为主视觉，集中注册、集中渲染、集中控制样式。

建议图标风格：

- **线性 outline**
- **圆角端点 / 圆角连接**
- **统一 1.75px 或 2px stroke**
- **默认 16px 视口，工具按钮内 14px/16px 两档**
- **颜色继承 `currentColor`**
- **默认 opacity 0.72，hover/focus/active 提升到 0.95/1**

推荐候选：

| 方案 | 风格 | 优点 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| Lucide | 线性、圆角、现代工具型 | 轻、干净、图标语义足够全，和当前 UI 更搭 | 需要引入一套中心化 SVG registry | **推荐** |
| Phosphor regular | 更软、更消费级 | 观感亲和 | 部分编辑器语义不如 Lucide 精准 | 可选 |
| Remix Icon line | 中性、密度较高 | 覆盖广 | 部分 glyph 偏重 | 备选 |
| 继续 codicon | VS Code 原生感 | 低风险、现有可复用 | 审美改善有限 | 不推荐作为主方案 |

## 3. 目标视觉

### 3.1 图标本体

- 线条更轻：从 codicon 的硬黑块感，改为细线 outline。
- 轮廓更圆：箭头、关闭、更多、复制、布局、文件夹等都走圆角端点。
- 密度更低：复杂图标优先选简洁语义，不追求 VS Code 式精确。
- 状态更安静：默认不要过亮，hover/active 再显性。

### 3.2 按钮容器

统一三类 icon button：

| 类型 | 尺寸 | 图标尺寸 | 用途 |
| --- | --- | --- | --- |
| `iconButton.sm` | 22x22 | 14 | inline widget、tag/heatmap 小按钮 |
| `iconButton.md` | 26x26 | 15/16 | 面板 toolbar、session row action |
| `iconButton.lg` | 30x30 | 16 | editor header、activity/workbench 主入口 |

统一状态：

- default: `color: var(--dim)` / `opacity: 0.72`
- hover: `background: var(--hover-bg)` / `color: var(--fg)` / `opacity: 1`
- active/selected: `background: var(--active-bg)` / `color: var(--accent)`
- focus: `box-shadow: var(--focus-ring)`

### 3.3 不做的事

- 不引入彩色图标。
- 不让每个插件自己带一套 SVG。
- 不继续在业务代码里散落 `<svg>` path。
- 不把文件类型图标做成高饱和 logo；文件树仍保持低调。

## 4. 图标映射建议

### 4.1 全局基础动作

| 语义 | 当前常见 codicon | 建议新图标 | 说明 |
| --- | --- | --- | --- |
| 新增 | `add` | `plus` | 轻量加号 |
| 关闭 | `close` | `x` | 圆角端点，避免硬叉 |
| 编辑/重命名 | `edit` | `pencil` | 更直观 |
| 删除 | `trash` | `trash-2` | 线性垃圾桶 |
| 复制 | `copy` | `copy` | 保持语义 |
| 确认 | `check` | `check` | 线性 check |
| 更多 | `ellipsis` | `more-horizontal` | row action 统一 |
| 外链/打开 | `link-external` | `external-link` | 更轻 |
| 运行 | `play` | `play` | 保持 |
| 停止 | `debug-stop` | `square` | 避免 debug 语义 |

### 4.2 展开/折叠/导航

| 语义 | 当前 | 建议 | 说明 |
| --- | --- | --- | --- |
| 展开 | `chevron-right` | `chevron-right` | 但改为圆角线性 |
| 收起/展开中 | `chevron-down` | `chevron-down` | 统一 14px |
| 上一项 | `chevron-left` | `chevron-left` | heatmap/nav |
| 下一项 | `chevron-right` | `chevron-right` | heatmap/nav |
| 折叠全部 | `fold` | `fold-vertical` 或 `panel-top-close` | 当前 `fold` 偏硬 |
| 展开全部 | `unfold` | `unfold-vertical` 或 `panel-top-open` | 和折叠全部成对 |

### 4.3 布局/面板

| 语义 | 当前 | 建议 | 说明 |
| --- | --- | --- | --- |
| 分屏 | `split-horizontal` | `columns-2` | 更干净 |
| 底部面板 | `layout-panel` | `panel-bottom` | 更明确 |
| 右侧面板 | `layout-sidebar-right` | `panel-right` | 更明确 |
| editor layout | `editor-layout` | `layout-template` | 用在布局选择菜单 |
| 目录/TOC | `list-tree` | `list-tree` 或 `list-collapse` | Lucide 版更轻 |

### 4.4 文件/上下文

| 语义 | 当前 | 建议 | 说明 |
| --- | --- | --- | --- |
| 文件夹 | `folder` | `folder` | 线性圆角 |
| 文件夹打开 | `folder-opened` | `folder-open` | 线性圆角 |
| 文件 | `file` | `file` | 默认文件 |
| Markdown | `markdown` | `file-text` | 不强调品牌 glyph |
| JSON/配置 | `json` / `settings` | `braces` / `settings` | JSON 更像结构 |
| 代码文件 | `file-code` | `file-code` | 保持 |
| 图片 | `file-media` | `image` | 更直观 |
| 压缩包 | `file-zip` | `file-archive` | 更直观 |
| 锁文件 | `lock` | `lock` | 保持 |
| 数据库/记忆 | `database` | `database` | 保持 |

### 4.5 业务面板

| 区域 | 当前 | 建议 |
| --- | --- | --- |
| Agents | `hubot` | `bot` |
| Memory | `database` | `database` |
| Comments | `comment-discussion` | `messages-square` |
| Tags | `tag` | `tag` |
| Heading | `list-tree` / `symbol-property` | `heading` / `list-tree` |
| Tasks | `check` / `circle-large-outline` / `play` | `check-circle` / `circle` / `play-circle` |
| Model / 智能体 | `zap` | `sparkles` 或 `bot` |
| Theme | `gear` / status text | `palette` |

## 5. 需要清理的范围

### 5.1 已知 codicon 使用集中区

- `src/main.ts`
- `src/ui/workbench/workbench.ts`
- `src/editor/extensions/selection-toolbar/index.ts`
- `extensions/dev.toc/main.js`
- `extensions/dev.session-manager/ui/list-renderer.js`
- `extensions/dev.session-manager/ui/sidebar-view.js`
- `extensions/dev.tools/context-panel.js`
- `extensions/dev.tools/files-panel.js`
- `extensions/dev.tools/tool-calls.js`
- `extensions/dev.memory/main.js`
- `extensions/dev.comments/main.js`
- `extensions/dev.agents/main.js`
- `extensions/dev.terminal-enhanced/panel.js`
- `extensions/dev.langchain-chat/model-switcher.js`

### 5.2 仍需纳入统一系统的尾巴

- `src/editor/EditorCore.ts`：仍有 `▾` / `▸`
- `extensions/dev.search-replace/main.js`：仍有 `▾` / `▴`
- `extensions/dev.search-replace-plus/diff-blocks.js`：仍有 `▸`
- `extensions/dev.slash-commands/main.js`：仍有 `↩︎` / `›` / `⚡`
- `extensions/dev.memory/styles.css`：仍有 CSS pseudo `content: "›"`
- `src/ext/registry.ts`：仍有内联 SVG
- `extensions/dev.export-editor/main.js`：用于导出 `foreignObject`，不是 UI 图标，不纳入替换

## 6. 实现方案

### 6.1 新增中心化 icon registry

建议新增：

- `src/ui/icons/registry.ts`
- `src/ui/icons/render.ts`
- `src/ui/icons/styles.css`

核心 API：

```ts
type ZionIconName =
  | "plus"
  | "x"
  | "pencil"
  | "trash"
  | "copy"
  | "chevron-right"
  | "chevron-down"
  | "panel-right"
  | "panel-bottom"
  | "folder"
  | "folder-open"
  | "file"
  | "bot"
  | "database"
  | "sparkles";

export function iconSvg(name: ZionIconName, options?: {
  size?: 12 | 14 | 16 | 18;
  className?: string;
  title?: string;
}): string;
```

渲染输出统一：

```html
<span class="zion-icon zion-icon-chevron-right" aria-hidden="true">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">...</svg>
</span>
```

注意：这不是回到“到处手写 SVG”。SVG path 只能存在于 registry，业务代码只传 `iconName`。

### 6.2 CSS 统一

```css
.zion-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1em;
  height: 1em;
  line-height: 1;
  color: currentColor;
  opacity: var(--icon-opacity, 0.72);
}

.zion-icon svg {
  width: 1em;
  height: 1em;
  display: block;
  stroke: currentColor;
}

.zion-icon-button {
  color: var(--dim);
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast), color var(--transition-fast), opacity var(--transition-fast);
}

.zion-icon-button:hover {
  background: var(--hover-bg);
  color: var(--fg);
}
```

### 6.3 迁移策略

分三批做，降低风险：

1. **L1：全局 icon system 基础设施**
   - 加 `src/ui/icons/*`
   - 定义 30 个基础图标
   - 保留 codicon，不立刻删除

2. **L2：最高可见区域替换**
   - editor header
   - activitybar / workbench
   - context panel
   - session manager
   - TOC toolbar
   - inline thinking/tool-call toggle

3. **L3：长尾清理**
   - files panel / memory panel
   - comments / agents / terminal / model switcher
   - search-replace / slash-commands / registry 内联 SVG / unicode 尾巴

每批都做：

- 暗/亮双主题截图
- 全局扫描：`codicon-`、`<svg`、unicode 箭头
- 按钮点按抽测
- console error 检查

## 7. 验收标准

- 主要 UI 不再依赖 codicon 作为视觉主图标。
- 图标线条统一：圆角、细线、低密度。
- 所有 icon button 的尺寸、hover、active、focus 状态一致。
- 业务代码不散落 SVG path，只使用 `iconName`。
- unicode 图标尾巴清零，除纯文本语义外不再用 `▸` / `▾` / `›` / `⚡` 充当图标。
- 暗/亮主题下图标不过亮、不发灰、不抢正文。
- 功能零回归：所有按钮、菜单、展开/折叠、复制/插入/运行/停止仍正常。

## 8. 建议先做的视觉样板

先不全量替换，建议先做一个可截图评审的小样板：

1. editor header：新增、目录、重命名、分屏、Run/Stop、设置
2. TOC toolbar：分组、折叠全部、复制、插入、收起
3. session manager：folder chevron、more、add、new-folder
4. context panel：section chevron、copy、folder/file、任务状态
5. inline widget：thinking/tool-call toggle

这五组覆盖了最常见、最容易影响观感的图标。如果这组视觉成立，再推进全量迁移。
