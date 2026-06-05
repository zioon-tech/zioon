# 工具产物查看与 Changes 面板改造方案

## 背景

当前会话里的工具调用已经可以通过内联卡片展开查看结果，但对 `edit`、`write`、`apply_patch` 这类会改变文件的工具来说，信息组织还偏“调试输出”：

- 工具卡片主要承载请求参数和响应结果，缺少“这是一次文件变更”的强语义。
- `edit` 展示为 Search / Replace 两个文本块，不像代码审阅里常见的文件级 diff。
- `write` 展示新文件内容，但缺少语言高亮、文件头、变更统计和跳转入口。
- 多个文件被修改时，用户需要在聊天流里逐个展开工具卡片，无法获得“本轮会话改了哪些文件”的整体视图。
- 展开卡片样式混合了大量 inline style 和少量全局 CSS，视觉一致性和后续维护成本都不理想。

用户提到的 Paseo 方案提供了一个有价值的方向：不一定引入完整编辑器，而是把“语法分析/高亮”和“轻量级原生展示”拆开。对我们这个 Web-only 项目来说，不必照搬 React Native 的 `<Text>` 渲染，但可以学习它的产品分层：聊天流只放摘要，完整产物进入独立查看区。

## 现状盘点

### 工具卡片

入口在 `extensions/dev.tools/tool-calls.js`：

- `installToolCallCards()` 作为 CodeMirror `ViewPlugin` 注入每个聊天编辑器。
- `chat/toolCall` 插入一个 `ToolInlineWidget`，显示“调用 xxx”和简短摘要。
- 点击内联 widget 触发 `toggleInline`，在行尾插入 `ToolCallCardWidget`。
- `ToolCallCardWidget` 渲染请求参数、响应结果、状态 badge，以及 `edit` / `write` 的 Accept / Revert 按钮。
- `createEditDiffView()` 当前只对 `old_string` / `new_string` 做 word diff，并分成 Search / Replace 两块。
- `createWritePreviewView()` 当前按行号展示 `content`，没有高亮和文件元信息。
- `createPatchView()` 会根据 `+` / `-` / `@@` / `***` 给 patch 行上背景色，但仍然是纯文本行级展示。

### 持久化数据

工具调用数据存储在 session annotations：

- 类型定义在 `src/chat/annotations.ts`，`SessionAnnotations.tools` 保存工具调用列表。
- `dev.tools/main.js` 暴露了 `window.zion.tools.getAllToolCalls()`、`getToolCall()`、`findToolCalls()`。
- `tool-calls.js` 的 `toolcards/snapshot` 会把当前会话工具卡片快照写回 `ann.tools`。
- `toolActions` 保存 Accept / Revert 等用户动作，可用于 Changes 面板标记状态。

这意味着 Changes 面板的 MVP 不需要重新设计存储模型，可以先从当前 session annotations 派生。

### 右侧辅助栏

右侧 tab 的注册能力已经存在：

- `window.zion.auxiliaryBar.registerView()` 支持插件注册右侧 view。
- `src/ui/workbench/runtime.ts` 里 `AuxiliaryBarRuntime` 支持 `registerView`、`activateView`、`show`、`hide`、`setWidth`。
- `extensions/dev.terminal-enhanced/main.js` 已经演示了同一个功能同时注册到底部 panel 和右侧 auxiliary bar。
- `src/main.ts` 当前注册了一个 `core.context` 占位 view。

所以 Changes tab 可以优先作为 `dev.tools` 的 auxiliaryBar view 落地，不需要改布局内核。

## 参考设计

### Paseo 可借鉴点

Paseo 的核心不是“用了 @lezer”，而是把代码查看拆成四层：

- 解析层：按语言得到 token / CST，不绑定编辑器。
- 高亮层：把 token 映射为 GitHub 风格配色。
- 展示层：代码块、文件预览、diff 视图复用统一 token 渲染。
- 产物层：Changes / FilePane / DiffViewer 负责组织文件、状态、滚动和操作。

我们可以沿用这个分层，但在 Web 环境里更适合选择：

- MVP：先用现有 DOM + CSS + 简单 tokenizer / diff 结构，快速把信息架构做对。
- 第二阶段：引入 Shiki 或 CodeMirror language packages 做高亮。
- 不建议一开始引入 Monaco，因为我们只需要展示和审阅，不需要完整 IDE 编辑体验。

### Paseo Changes 面板补充调研

进一步查看 `getpaseo/paseo` 开源仓库后，Changes 面板的真实形态比“右侧文件列表 + 详情”更接近 GitHub PR diff：

- 面板主体是一个连续的文件 diff 流，不是 master-detail 两栏。
- 每个文件是一个可折叠 section，文件头展示 basename、目录、New / Deleted badge 和 `+x -y` 统计。
- 展开的文件头会作为 sticky header，长 diff 滚动时仍能知道当前文件。
- 顶部工具区提供 diff layout、隐藏空白、换行、展开/收起全部等偏好，并会持久化。
- diff body 支持 unified / side-by-side 两种布局；移动端或窄屏降级为 unified。
- 大 diff 使用列表虚拟化和高度估算，避免整个面板一次性渲染所有文件内容。
- 代码 token 高亮在 diff line 中按 token 渲染，行号 gutter 和代码内容分离，方便 hover / review comment。

对我们当前 Web 插件架构，第一轮更适合先学习它的信息架构：

- 把 Changes 从“文件列表 + 详情区”调整为连续文件 section。
- 默认展开当前会话文件改动，并支持 Expand / Collapse All。
- 文件头保留 basename + dir + status badge + diff stat。
- 先实现 unified diff 和 wrap lines 偏好；side-by-side、hide whitespace、sticky review comment 作为后续增强。

### 同类产品模式

从 Cursor、Claude Code、Windsurf 一类 coding agent 的交互可以总结出几个共同点：

- 聊天流里保留“做了什么”的一句话摘要，不强迫用户在对话中审 diff。
- 文件变更集中进 Changes / Modified Files / Review 面板。
- 文件列表先显示路径、增删行、状态，再进入文件级 diff。
- diff 默认是 unified view，必要时支持 split view。
- 对 AI 生成文件，用户最关心的是 Accept / Reject / Open File，而不是原始工具 JSON。

## 目标体验

### 聊天流

聊天流里的工具调用应该更像“执行日志”，而不是主查看器：

- 默认显示一行紧凑摘要：状态、工具名、文件路径、变更规模。
- 展开后展示轻量预览：最多 80-120 行，适合快速确认。
- 对 `edit`、`write`、`apply_patch` 增加“Open in Changes”入口。
- 响应结果默认折叠到次要区域，除非失败时直接展示错误原因。

### Changes Tab

右侧 panel 注册一个 `Changes` tab，用来查看当前会话所有文件修改：

- 顶部 summary：`N files changed`、`+x -y`、本会话状态。
- 文件列表：按路径分组展示 `created` / `modified` / `deleted` / `patch`。
- 文件项：路径、basename、工具来源、时间、状态、增删行数。
- 详情区：点击文件后展示 diff 或完整文件内容。
- 操作区：`Accept`、`Revert`、`Open File`、`Copy Patch`。
- 空状态：提示“本会话还没有文件修改”，并可展示最近工具调用。

### 视觉原则

- 代码区域使用 GitHub 风格 token 配色，与用户提到的 Paseo 保持一致认知。
- diff 背景使用低饱和绿/红，避免大面积高亮导致疲劳。
- 路径和行号使用 mono 字体，标题和按钮使用 UI 字体。
- 信息层级从强到弱：文件状态 > 路径 > diff > 原始 tool result。
- 所有卡片、列表、按钮迁移到 CSS class，减少 inline style。

## 推荐技术路线

### 代码高亮

建议分阶段推进：

| 阶段 | 方案 | 理由 |
|---|---|---|
| MVP | 不引入高亮库，先做统一 CodeBlock / DiffBlock CSS | 快速改善结构和视觉，风险最低 |
| V1 | Shiki 预渲染 HTML | Web-only 展示最省心，主题质量高，不需要编辑能力 |
| V2 | CodeMirror language packages + @lezer | 如果未来需要 token 级交互、行内选择、折叠、局部更新 |
| 不推荐 | Monaco | 对只读产物查看过重，包体积和集成成本不划算 |

如果只解决“展示代码”和“diff 审阅”，Shiki 是更直接的选择；如果后续希望在 diff 中做 AST 级导航、符号级定位，再考虑 @lezer。

### 数据模型

新增一个派生层，不破坏现有 `ann.tools`：

```ts
type FileArtifact = {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: "edit" | "write" | "apply_patch" | string;
  path: string;
  kind: "created" | "modified" | "deleted" | "patch" | "unknown";
  before?: string;
  after?: string;
  patch?: string;
  status: "pending" | "accepted" | "reverted" | "failed" | "unknown";
  addedLines?: number;
  removedLines?: number;
  createdAt?: number;
};
```

派生规则：

- `write`：`after = args.content`，如果结果成功则视为 `created` 或 `modified`；是否能确认 created 取决于 tool result 是否返回文件存在信息。
- `edit`：`before = args.old_string`，`after = args.new_string`，视为 `modified`；短期先展示片段 diff，长期通过文件快照升级为文件 diff。
- `apply_patch`：从 patch 文本解析 path、hunk、增删行，视为 `patch`。
- `toolActions[toolCallId]`：映射为 `accepted` / `reverted`。
- `deletedToolIds`：只影响聊天流隐藏，不应从 Changes 面板中彻底删除，除非用户选择清理会话记录。

### 组件拆分

建议在 `extensions/dev.tools` 内新增：

- `artifact-model.js`：从 `window.zion.tools.getAllToolCalls()` 生成 `FileArtifact[]`。
- `code-view.js`：统一 `CodeBlock`、`LineTable`、`DiffBlock` DOM 渲染。
- `changes-panel.js`：注册 auxiliary view 并管理列表、详情和操作。
- `tool-card-renderers.js`：逐步把 `tool-calls.js` 中的展示函数迁出。
- `tool-artifacts.css`：集中管理工具卡片和 Changes 面板样式。

长期可以把 `code-view.js` 下沉为公共能力，给 read/search/webfetch/terminal 等产物复用。

## 信息架构草图

### 工具卡片展开

```text
┌ Tool: edit                     ✓ Success ───────────┐
│ src/i18n/i18nManager.ts · modified · +3 -1           │
│                                                       │
│ @@ i18nManager.ts                                    │
│  108  const next = ...                               │
│ -109  old text                                       │
│ +109  new text                                       │
│                                                       │
│ [Open in Changes] [Accept] [Revert]                  │
└───────────────────────────────────────────────────────┘
```

### Changes Tab

```text
Changes
3 files changed                         +42 -8

Search files...

MODIFIED  src/i18n/i18nManager.ts       +12 -3
CREATED   docs/tool-artifacts.md        +80 -0
PATCH     src/styles.css                +6 -2

────────────────────────────────────────────
src/i18n/i18nManager.ts
modified · edit · accepted

@@ -104,8 +104,10 @@
  context
- removed
+ added
  context

[Open File] [Copy Patch] [Revert]
```

## 实施计划

### Phase 0：设计收敛

- 新增本文档，确认目标体验和落地边界。
- 明确 MVP 是否只覆盖当前 session，还是需要跨 session 查看。
- 确认 Accept / Revert 操作语义：是“标记接受”，还是实际写回 / 回滚文件。

### Phase 1：先把现有卡片变好

- 把 `createLineTable`、`createEditDiffView`、`createWritePreviewView`、`createPatchView` 迁到独立 renderer。
- 把 inline style 收敛到 CSS class，统一 spacing、border、背景、字体。
- `edit` 卡片改为 unified diff 样式，Search / Replace 降级为“原始参数”折叠区。
- `write` 卡片增加文件头、行数、语言推断、copy 按钮。
- 失败工具调用优先展示错误摘要，成功工具调用弱化 raw result。

### Phase 2：注册 Changes Tab

- 在 `dev.tools` 中注册 `window.zion.auxiliaryBar.registerView({ id: "dev.tools.changes", title: "Changes" })`。
- 通过 `window.zion.tools.getAllToolCalls()` 获取当前 session 工具调用。
- 监听 `chat/toolCall`、`chat/toolResult`、`toolcards/snapshot`、`toolcards/toolsUpdated`、`sessions.currentId` 变化刷新面板。
- 实现文件列表、空状态、详情 diff、Open in Changes。
- 首版只做只读查看，Accept / Revert 复用现有 `toolcards/editAccept`、`toolcards/editRevert`、`toolcards/writeAccept`、`toolcards/writeRevert` 事件。

### Phase 3：高亮与文件级 diff

- 引入 Shiki，按扩展名推断语言，预渲染 token span。
- 为 read/write/diff 共用代码高亮渲染。
- 对 `edit` 尽量补齐文件上下文：如果工具 result 或文件系统能拿到完整 before/after，则升级为文件级 diff。
- 为大文件增加虚拟滚动或截断策略，避免右侧 panel 卡顿。

### Phase 4：体验增强

- 支持文件过滤、只看未处理、只看失败。
- 支持 grouped by directory。
- 支持 Copy Patch / Copy File / Open File。
- 支持会话结束后保留 Changes 快照。
- 如果后续存在真实 git 工作区信息，可增加 working tree diff 对照。

## 风险与取舍

- `edit` 当前只有 `old_string` / `new_string`，不能天然生成完整文件 diff；MVP 需要接受“片段 diff”。
- `write` 无法可靠判断 created vs modified，除非 tool result 返回文件原状态或执行前做快照。
- `window.zion.tools.getAllToolCalls()` 依赖当前 `sessions.currentId`，多 panel / 多 session 同开时需要明确使用 active panel 还是全局 current session。
- Shiki 会增加异步初始化和包体积，需要 lazy load 到 Changes tab 打开时再加载。
- 右侧 auxiliary 默认宽度 300px，复杂 diff 可能偏窄；建议 Changes 激活时设置 420-560px，但不要强行覆盖用户宽度。
- 工具卡片里已有 Accept / Revert 事件，但“接受”目前更像标记动作；如果要真实应用或撤销，需要重新确认语义。

## 推荐下一步

建议先做 Phase 1 + Phase 2 的 MVP：

- 不先引入 Shiki / @lezer，避免技术选型阻塞体验验证。
- 先把 `dev.tools` 内部数据模型和 UI 结构理顺。
- 右侧 `Changes` tab 只展示当前会话的文件产物。
- `edit` / `write` 工具卡片加入 `Open in Changes`，把详细查看从聊天流迁出去。
- MVP 完成后再基于真实使用反馈决定是否引入 Shiki 或 @lezer。
