# Zion Next 全局样式优化方案

> 面向维护者的一次性视觉打磨方案。目标：在**不改动任何功能、不重构 DOM 结构**的前提下，
> 通过收敛离散的样式取值、补齐并强制使用已有的设计 token，把整体观感从"能用"提升到"精致统一"。
>
> 关联文档：[主题与样式体系](./THEME-DESIGN-GUIDE.md)（讲"怎么用"），本文讲"当前哪里不统一、怎么收敛"。

---

## 0. 一句话结论

骨架和 token 体系已经很扎实（VS Code 式 workbench + 分层 token + 11 套主题预设）。
"丑"不是架构问题，而是**执行层面缺乏约束**：同一视觉属性在成百上千处各写各的值，
且**已定义的语义 token 几乎没被使用**。收敛这批离散值，就是最高性价比的全局提升。

---

## 1. 量化诊断（现状数据）

以下为 `src/` + `extensions/` 全量 CSS 统计（统计口径为字面出现次数）。

### 1.1 圆角 border-radius — 至少 12 种取值

| 取值 | 出现次数（合并写法后约） | 建议归档 |
|------|------|---------|
| `6px` | ~80 | `--radius-md` |
| `4px` | ~52 | `--radius-sm` |
| `999px` | ~35 | `--radius-pill` |
| `8px` | ~11 | `--radius-lg` |
| `5px` / `7px` / `9px` | ~20 | 就近归入 sm/md |
| `3px` / `2px` / `1px` | ~24 | `--radius-sm` 或 0 |
| `10px` / `12px` | ~14 | `--radius-lg` |

**问题**：`2px` 和 `6px` 在同类控件上混用，卡片/按钮/菜单圆角不成体系。

### 1.2 字号 font-size — 20+ 种取值

主力集中在 `12px`(~116) / `11px`(~106) / `10px`(~44) / `13px`(~28)，
但混入了 `9.5 / 10.5 / 11.5 / 12.5px` 等**非整数半档**，以及 `8 / 9 / 15 / 17px` 等孤值。

**问题**：字号碎片化导致缺乏排版节奏；且整体偏小（11px 是主力），正文可读性和高级感都受影响。

### 1.3 阴影 box-shadow — 86 种不同写法

全项目出现 **86 种互不相同的 box-shadow 字符串**（`src/styles.css` 内就有 48+ 处）。
**没有任何 elevation/shadow token**。

**问题**：浮层、菜单、对话框、激活态各自定义阴影，层级（elevation）关系混乱、不可预测。

### 1.4 硬编码颜色 — 239 处

`rgba(255,255,255,…)` 与 `rgba(0,0,0,…)` 合计出现 **239 次**。

**问题**：这些值不随主题变化，是浅色主题（小红书/微信/GitHub Light 等）下"发灰、串色、脏"的主因。

### 1.5 已有 token 的采用率 — 几乎为零 ⚠️

| Token 组 | 已定义 | 实际被 `var()` 引用次数 |
|---------|-------|------------------------|
| `--text-title/body/secondary/meta/caption` | ✅ | **1** |
| `--space-1 ~ --space-6` | ✅ | **2** |
| `--radius-*` | ❌ 未定义 | — |
| `--elevation-* / --shadow-*` | ❌ 未定义 | — |

**这是本方案的核心结论**：设计系统建好了，但没人用。所有优化的第一步都应回到"让 token 被真正引用"。

---

## 2. 收敛目标（Design Token 扩充）

在 [`src/styles.css`](../../src/styles.css) 的 `:root` 中补齐两组缺失 token，并明确既有 token 的使用边界。

### 2.1 新增：圆角

```css
:root {
  --radius-sm: 4px;    /* 输入框、小按钮、菜单项 */
  --radius-md: 6px;    /* 卡片、面板内容块、下拉框 */
  --radius-lg: 8px;    /* 浮层、对话框、大卡片 */
  --radius-pill: 999px;/* 标签 chip、开关 */
}
```
收敛映射：`1/2/3px → sm`，`5px → md`，`7px → md`，`9/10/12px → lg`，`999px → pill`。

### 2.2 新增：阴影 / 层级（elevation）

```css
:root {
  --elevation-1: 0 1px 2px rgba(0,0,0,0.12);              /* 贴附元素、hover 抬起 */
  --elevation-2: 0 2px 8px rgba(0,0,0,0.24);              /* 菜单、popover */
  --elevation-3: 0 8px 24px rgba(0,0,0,0.32);             /* 对话框、命令面板 */
}
:root[data-theme="light"] {
  --elevation-1: 0 1px 2px rgba(0,0,0,0.06);
  --elevation-2: 0 2px 8px rgba(0,0,0,0.10);
  --elevation-3: 0 8px 24px rgba(0,0,0,0.14);
}
```
把 86 种 box-shadow 归到这 3 档（外加"激活面板"用已有的 `--panel-active-shadow`）。

### 2.3 强制使用：字号

统一走已有的 `--text-*`，删除半档与孤值：

| 场景 | Token | 值 |
|------|-------|----|
| 面板标题 / 区块标题 | `--text-title` | 13px/600 |
| 正文 / 列表项 | `--text-body` | 13px/400 |
| 次级信息 / 输入框 | `--text-secondary` | 12px/400 |
| meta / 面包屑 / tab | `--text-meta` | 11px/400 |
| 徽标 / 角标 | `--text-caption` | 10px/500 |

> 建议：把当前大量 `11px` 的正文类上调到 `--text-secondary`(12) 或 `--text-body`(13)，提升可读性。

### 2.4 强制使用：间距

手写的 `6/8/10/12px` 内边距、间隙统一走 `--space-2`(8) / `--space-3`(12)，4px 网格已就绪。

### 2.5 强制使用：交互态与颜色

- hover 底 → `--hover-bg`；激活底 → `--active-bg`；焦点环 → `--focus-ring`
- 239 处 `rgba(255,255,255,…)` / `rgba(0,0,0,…)` → 改用 `color-mix(in srgb, var(--fg) N%, transparent)` 或上述交互 token

---

## 3. 分批落地计划（每批可独立验证、独立回滚）

> 全程纯样式，不触碰 JS 逻辑 / DOM 结构 / 功能。建议按批次改、按批次截图对比。

### 批次 A — 补齐 token（零风险，无视觉变化）
- 在 `:root` 与 `[data-theme="light"]` 补 `--radius-*`、`--elevation-*`。
- 此批**只新增定义、不替换引用**，产物上无任何视觉变化，作为后续批次的地基。

### 批次 B — 外壳收敛（最显眼，优先）
范围：活动栏、侧栏、编辑器 tab 栏、辅助栏 tab、底部状态栏。
- 圆角 → `--radius-*`；hover/active/focus → 交互 token；字号 → `--text-*`。
- 外壳是用户第一眼看到的部分，统一后"像一个产品"的感觉立刻出现。

### 批次 C — 浮层收敛
范围：命令面板、右键菜单、popover、下拉、通知、对话框。
- box-shadow → `--elevation-2/3`；圆角 → `--radius-md/lg`。

### 批次 D — 硬编码颜色清理
- 全库 `rgba(255,255,255…)` / `rgba(0,0,0…)` → 主题安全写法。
- 重点回归浅色主题（小红书/微信/GitHub Light）串色问题。

### 批次 E — 扩展插件对齐
范围：`extensions/dev.*` 各自的 `styles.css`。
- 复用同一批 token；跨插件图标统一为 codicon（消除自绘 SVG 描边图标与字体图标混用）。

### 批次 F — 编辑器本体（WYSIWYG / CodeMirror）
范围：`src/editor/**` + 与编辑器渲染相关的 `src/styles.css` 段与扩展卡片 CSS。见下方 §6 专项诊断。

---

## 6. 编辑器专项诊断（WYSIWYG / CodeMirror）

编辑器样式为**三层混合**：(a) `oneDark` CodeMirror 主题只提供基础配色；
(b) `wysiwyg.ts` 通过 `cm-md-*` / `cm-role-*` className 打装饰，样式在 `src/styles.css` 手写；
(c) 少量 `EditorView.theme` JS 对象 + DOM 内联样式（自动补全、选区工具条、部分 widget）。

正文配色大量走了 `--md-*` / `--role-*` / `--selection-bg` token，主题适配基础不错。
问题集中在以下**破坏一致性的硬编码与越权覆盖**：

### 6.1 标题字号双路径不一致 ⚠️（优先修）
- 渲染态标题用 `var(--md-h*-size)`（[styles.css:3433-3466]），但
  `HeadingWidget` 在 [wysiwyg.ts:955-956] **内联硬编码 `1.6em..1em`** 的字号映射，绕开 token。
- 后果：同一 H1 在装饰路径与 widget 路径下尺寸可能不一致。
- 方案：widget 也读 `--md-h*-size`，删除内联 em 映射。

### 6.2 `.cm-content` 被 `!important` 二次覆盖
- [styles.css:3081-3090] 用 `--editor-content-font-*` token 设字号；
  但 [styles.css:3091-3098] `.zion-editor-slot .cm-content` 又用 `14px / 1.62 !important` 强盖。
- 后果：token 形同虚设。方案：删 `!important`，字号统一从 `--editor-content-*` / `--text-body` 出。

### 6.3 卡片圆角三套并存
| 卡片 | 位置 | 现值 | 收敛到 |
|------|------|------|--------|
| 工具调用卡 | [dev.tools/styles.css:200-247] | radius 6px | `--radius-md` |
| 思考卡 / pill | [dev.thinking/styles.css:14-111] | 卡 6px / pill 5px | `--radius-md` / `--radius-pill` |
| 代码 code span | [styles.css:3282-3295] | radius 4px | `--radius-sm` |
- border 也不一：工具卡 `color-mix(--border 56%)`，宜统一系数。

### 6.4 roles 角色 pill：值分散 + 归属错位
- pill CSS 不在 `dev.roles` 插件里，而在 [styles.css:3903-4000]：radius 4px、`padding 1px 6px`、`0.8em`。
- 颜色走 `--role-*` token（好），但尺寸是孤值，且与 tag pill（999px）不一致。
- 方案：pill 圆角 → `--radius-pill`，字号 → `--text-caption`；长期考虑把角色 pill 样式迁回 dev.roles。

### 6.5 自动补全弹窗 & 选区工具条：硬编码重灾区
- 自动补全 [AutocompleteTheme.ts:3-109]：radius `10px`、`box-shadow …rgba(0,0,0,.25)`、
  hover 死值 `rgba(98,114,164,…)` — 浅色主题下明显违和。
- 选区工具条：CSS 错位在 [dev.comments/styles.css:580-643]，radius 12px、hover `rgba(98,114,164,.16)`、
  shadow `rgba(0,0,0,.22)` 全为死值。
- 方案：阴影 → `--elevation-2`，圆角 → `--radius-lg`，hover → `--hover-bg`；
  并把选区工具条 CSS 迁回 `selection-toolbar` 自身模块（当前归属错误）。

### 6.6 收敛后编辑器应满足
- 标题：装饰态与 widget 态字号一致，均由 `--md-h*-size` 驱动。
- 正文：`.cm-content` 无 `!important`，字号单一来源。
- 卡片圆角 ≤ 2 档（md + pill）；code span 用 sm。
- 弹窗/工具条阴影走 elevation、圆角走 radius token、hover 走 `--hover-bg`。

---

## 4. 验收清单

- [ ] `--radius-*`、`--elevation-*` 已定义于暗/亮两套基座
- [ ] 外壳组件 0 处硬编码圆角 / 字号 / hover 色
- [ ] box-shadow 写法收敛到 ≤ 4 种（3 档 elevation + 面板激活）
- [ ] `rgba(255,255,255…)` / `rgba(0,0,0…)` 归零或仅存于 elevation token 定义处
- [ ] `--text-*` 引用数从 1 → 显著上升；`--space-*` 同理
- [ ] 11 套主题预设逐一目测：无发灰 / 无串色 / 对比度达标
- [ ] 明暗主题下 hover / active / focus 反馈一致
- [ ] 编辑器：标题字号装饰态/widget 态一致，均由 `--md-h*-size` 驱动
- [ ] 编辑器：`.cm-content` 无 `!important`，字号单一来源
- [ ] 编辑器：工具卡/思考卡/code span/角色 pill 圆角均走 `--radius-*`
- [ ] 编辑器：自动补全弹窗 & 选区工具条走 elevation/radius/hover token，无死值 rgba

---

## 5. 影响面与风险

| 项 | 说明 |
|----|------|
| 功能 | 无。纯 CSS 取值收敛，不改 JS / DOM / 交互逻辑。 |
| 回滚 | 每批次独立提交，可单批 revert。 |
| 主要风险 | 批次 D（颜色）可能在个别主题下改变观感，需逐主题目测。 |
| 不做的事 | 不重排布局、不改组件结构、不引入新依赖、不动 memory 等具体面板的功能。 |

---

## 附：统计命令（可复现）

```bash
# 圆角取值分布
grep -rhoE "border-radius: ?[0-9]+px" src extensions | sort | uniq -c | sort -rn
# 字号取值分布
grep -rhoE "font-size: ?[0-9.]+px" src extensions | sort | uniq -c | sort -rn
# 不同 box-shadow 写法数量
grep -rhoE "box-shadow: ?[^;]+" src extensions | sed 's/ *$//' | sort -u | wc -l
# 硬编码颜色次数
grep -rhcE "rgba\(255, ?255, ?255|rgba\(0, ?0, ?0" src extensions | paste -sd+ - | bc
# 语义 token 采用率
grep -rhoE "var\(--text-(title|body|secondary|meta|caption)\)" src extensions | wc -l
```

---
---

# Phase 2 — 视觉升级（观感精修）

> Phase 1（批次 A–F）已完成：token 地基补齐、外壳/浮层收敛、硬编码色清理、编辑器本体收敛、半档字号归整。
> 那一轮解决的是"**取值离散、token 没被用**"的**系统性问题**，产物已"统一"但仍谈不上"好看"。
>
> Phase 2 面向具体的**观感短板**——即维护者点名的：role 胶囊/标签带丑边框、渲染 markdown 排版难看、
> widget 廉价、session 选中色不合群、图标原始不统一。**目标是"从统一到精致"**。
>
> **两条基调（已确认）**：
> 1. **配色保持多主题 token 体系**——不引入图里的固定色板（#2563EB 等）。zion 有 11 套主题 + 明暗双色，
>    全靠 `--accent`/`--border`/`--fg` 驱动。真正的病是"很多地方绕过 token 用硬编码"，正解是**统一用法**，不是加固定色。
> 2. **图标统一纳入本轮**——需要改各面板 DOM 标记（手写 `<svg>`/unicode 字符 → codicon span），
>    **行为与功能完全不变**。这是唯一涉及 JS/DOM 的批次（批次 K），其余批次仍是纯 CSS。

---

## 7. 观感诊断（对应维护者点名的丑点）

每条都已在代码中定位到病灶，给出"现状 → 病根 → 药方"。

### 7.1 role 胶囊（user/assistant/system）带边框、方头方脑
- **现状**：[`src/styles.css:3849-3862`](../../src/styles.css) 用 `--radius-sm`(4px) + `padding 1px 6px`；
  [`src/styles.css:3929-3948`](../../src/styles.css) 每个 role 描 `1px solid` 边框。
- **病根**：胶囊用了小圆角而非 pill，且描边——视觉上像廉价按钮，跟正文抢注意力。
- **药方**：去掉 1px 边框（或降为极淡 hairline）；圆角 `--radius-sm` → `--radius-pill`；
  字号统一 `--text-caption`(10px/500)；背景保留 `--role-*-bg`（已是 token，主题安全）。

### 7.2 #标签 chip 带边框
- **现状**：[`src/styles.css:3199-3207`](../../src/styles.css) `1px solid color-mix(--accent 24%)` + `background --accent 13%` + `999px`。
- **病根**：边框 + 底色双重描边，噪声大。
- **药方**：去边框，仅保留淡 accent 底 + accent 文字；圆角硬编码 `999px` → `--radius-pill`。

### 7.3 渲染 markdown 排版难看（**最影响整体质感**）
- **现状 A｜段落无间距**：普通行 [`src/styles.css:3078-3081`](../../src/styles.css) `padding:0`，段间距**只靠行高 1.62**撑 → 一坨墙。
- **现状 B｜标题层级过平**：[`src/styles.css:106-111`](../../src/styles.css) h4/h5/h6 全 `1em` = 正文大小，
  h1 仅 1.25em，只靠 `font-weight` 区分 → "标题像加粗的段落"，没有层级感。
- **病根**：字体/字号本身没问题（14px/1.62 合理），缺的是**段落节奏**与**标题梯度**。
- **药方**：
  - 段落节奏：给内容行补垂直间距（段间 margin，或段落上下 padding），拉开呼吸感（注意 CodeMirror 是逐行 `.cm-line`，需用 padding/margin 而非依赖 `<p>`）。
  - 标题梯度：重排 `--md-h*-size` 阶梯（如 h1 1.6 / h2 1.35 / h3 1.2 / h4 1.08 / h5 1 / h6 0.94em），
    让层级可辨；并同步修复 [`wysiwyg.ts`](../../src/editor/wysiwyg.ts) HeadingWidget 内联字号映射（§6.1，Phase 1 若未收尾则此处补齐）。

### 7.4 widget / 卡片廉价（圆角乱、小字挤、处处描边）
- **现状**：圆角 `0/4/5/6/8px` 混用，`--radius-*` token 基本没用上；
  工具卡/思考卡正文 [`dev.tools/styles.css:197-223`](../../extensions/dev.tools/styles.css) 用 `11px` 等宽字，跟 14px 正文打架；
  几乎每个 widget 都描 1px 边框，堆叠时很吵；`--md-code-bg`/`--md-codeblock-bg` token 定义了却被 `!important` 硬编码绕过。
- **药方**：圆角全归 `--radius-md`（卡片）/ `--radius-sm`(code) / `--radius-pill`(pill)；
  卡片正文字号上调（11 → 12，或按语义 token）；边框系数统一；
  让 `--md-code*-bg` token 真正生效（去掉硬编码 `!important`）。

### 7.5 session-manager 选中背景不合群
- **现状**：[`dev.session-manager/styles.css:2-15`](../../extensions/dev.session-manager/styles.css) 选中/当前态用 `--fg` 灰底
  (`color-mix(fg 9~11%)`)，而全局活动栏/侧栏 tab/编辑器头都用 `--accent` 品牌色底 (`--active-bg`)。
  且 JS 注入 [`styles.css:121`](../../extensions/dev.session-manager/styles.css) 有 `border:none !important` 会顶掉左强调条。
- **药方**：`--sessions-current-bg`/`--sessions-selected-bg` 指向 `--active-bg`（或 accent mix），对齐全局；
  加 2px accent 左强调条（对齐活动栏 `::before` 惯例）；处理 `border:none !important` 的冲突。

### 7.6 图标原始/廉价/不统一（**批次 K，改标记不改行为**）
- **现状**：三套并存——核心壳用 codicon（正规）；8 个面板各自手写 `iconSvg()` 工厂
  (`dev.memory`/`dev.agents`/`dev.comments`/`dev.toc`/`dev.terminal-enhanced`/`dev.langchain-chat` model-switcher/`dev.session-manager` list-renderer 等，viewBox 16/24 不一、描边/填充混用)；
  外加 `› ▸ ▾ ⌄ ⋯ ↑ ↓ ✕ ● ✓` 等 unicode 字符当图标。
- **好消息**：codicon 字体已通过 CDN 加载（[`index.html:11`](../../index.html)），`setCodicon`/`$()` helper 已就绪，
  **无需新增字体管线**，codicon class 到处可用。
- **药方**：把上述 `iconSvg()` 工厂与 unicode 字符逐处替换为 `codicon codicon-<name>` span
  （chevron→`chevron-right/down`、nav→`arrow-up/down`、close→`close`、overflow→`ellipsis`、
  status→`circle-filled`/`check`、add/edit/trash/eye/pin→对应 codicon）；
  随之失效的 `svg{stroke…}` CSS（如 [`dev.memory/styles.css:16`](../../extensions/dev.memory/styles.css)、
  [`dev.agents/styles.css:38-39`](../../extensions/dev.agents/styles.css)、[`dev.comments/styles.css:526-538`](../../extensions/dev.comments/styles.css)）删除。
  **仅改渲染出的图标标记，不改任何点击/命令/状态逻辑。**

---

## 8. Phase 2 分批落地（每批独立验证 + 双主题截图）

> 批次 G/H/I/J 为纯 CSS；批次 K 为标记替换（不改行为）。建议顺序 G→H→I→J→K，每批完成后暗/亮双主题截图。

### 批次 G — role 胶囊 & 标签 chip 去边框/pill 化（纯 CSS，最快见效）
对应 §7.1 + §7.2。改 4 处规则块，风险极低。

### 批次 H — markdown 排版节奏（纯 CSS，最影响质感）
对应 §7.3。补段落间距 + 重排标题梯度 + 同步 HeadingWidget。
**风险点**：段落间距会改变纵向布局密度，需逐一回看长文档/列表/引用块，避免过松或首行错位。

### 批次 I — 编辑器 widget/卡片统一（纯 CSS）
对应 §7.4。圆角/字号/边框 token 化，让 `--md-code*-bg` 生效。

### 批次 J — session-manager 选中态对齐（纯 CSS + 处理 1 处 !important）
对应 §7.5。选中底色接入 `--active-bg` + 左强调条。

### 批次 K — 图标统一到 codicon（改标记，不改行为）
对应 §7.6。逐面板替换 `iconSvg()`/unicode → codicon，清理死 CSS。
**风险点**：这是唯一动 JS/DOM 的批次，需逐面板核对图标语义映射，改完点开每个面板确认按钮/菜单仍能点、命令仍触发。

---

## 9. Phase 2 验收清单

- [ ] role 胶囊：无硬描边、圆角走 `--radius-pill`、字号走 `--text-caption`，暗/亮主题均协调
- [ ] #标签 chip：无边框、圆角走 `--radius-pill`、accent 底色随主题
- [ ] markdown：段落间有明确呼吸感（非一坨墙）；h1–h6 层级可辨（h4/h5/h6 不再等于正文）
- [ ] 编辑器 widget/卡片：圆角 ≤ 3 档 token；卡片正文字号 ≥ 12；`--md-code*-bg` 生效
- [ ] session 选中态：与活动栏/侧栏一致的 accent 语义 + 左强调条；无 `border:none !important` 冲突残留
- [ ] 图标：目标面板均为 codicon，无手写描边 SVG / unicode 字符图标混用；死 CSS 已清
- [ ] 图标批次改后：每个面板按钮可点、命令可触发、状态显示正常（功能零回归）
- [ ] 11 套主题预设逐一目测无发灰/串色；明暗 hover/active/focus 一致

---

# Phase 3 — 方向 C 试验：Presentation Visual Layer

> 目标：参考“设计稿展示风 / Presentation 风”，在不改功能和 DOM 结构的前提下，让 Zion 从“干净 IDE”进一步靠近“产品演示截图”的观感。

## 10. 设计原则

- **舞台感**：全局背景从纯平面变成轻渐变舞台，侧栏、编辑器、右栏以浮层卡片方式落在背景上。
- **卡片化**：activitybar/sidebar/auxbar/editor/bottompanel 都获得统一圆角、柔和边界和轻阴影。
- **胶囊导航**：编辑器 tab、sidebar tab、bottom tab、header action 统一为 pill/soft-button 风格。
- **内容居中**：编辑器正文增加最大阅读宽度和更大的内边距，更像展示型文档。
- **轻信息块**：tool call / thinking 从灰描边块升级成浅色信息胶囊和轻卡片。
- **可回退**：本轮样式集中追加在 CSS 末尾，以 `Phase 3 trial` 注释标记；若方向不合适，可以整体移除这几段覆盖层。

## 11. 本轮落地范围

- `src/styles.css`
  - 新增 presentation token：`--presentation-*`
  - 覆盖 workbench 背景、activitybar、sidebar、auxbar、bottompanel、panels root、editor tab/header/content
  - 编辑器正文最大宽度 `--presentation-editor-max: 920px`
- `extensions/dev.session-manager/styles.css`
  - session 列表行卡片化
  - 当前/选中会话增加渐变底、轻阴影和更明显的左强调条
- `extensions/dev.tools/styles.css`
  - tool inline pill 和 expanded card 展示化
- `extensions/dev.thinking/styles.css`
  - thinking inline pill 和 card 与 tool-call 视觉语言对齐

## 12. 已验证

- `npm run build` 通过。
- 浏览器亮色主题截图：侧栏/编辑器/右栏出现统一浮层卡片感，tab 与工具 pill 更接近参考图。
- 浏览器暗色主题截图：暗色下边界、阴影、圆角和信息胶囊均成立。
- console 无新增 error；仍只有插件注册、command overwrite 等既有 info/warn。
