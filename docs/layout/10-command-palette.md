# 10 全局命令台（Command Palette）

## 背景

Zion Next 当前已经具备命令系统与快捷键系统：

- 命令注册与执行：通过 `window.zion.commands.registerCommand/executeCommand`（实现见 [registry.ts](file:///Users/bytedance/Downloads/zion-next/src/ext/registry.ts#L1240-L1260)）
- 编辑器内快捷键映射：通过 `window.zion.keybindings.register` 下发到 CodeMirror（实现见 [registry.ts](file:///Users/bytedance/Downloads/zion-next/src/ext/registry.ts#L1262-L1306)）
- 已有“局部命令面板”能力：
  - Slash 命令面板（编辑器内输入 `/` 触发）：[dev.slash-commands/main.js](file:///Users/bytedance/Downloads/zion-next/extensions/dev.slash-commands/main.js)
  - Terminal 快速选择器/历史面板： [panel.js](file:///Users/bytedance/Downloads/zion-next/extensions/dev.terminal-enhanced/panel.js)

但缺少一个“全局入口 + 全量命令可检索”的统一命令台：用户通过 `Cmd+K`（Mac）/ `Ctrl+K`（Win/Linux）打开，输入关键词搜索任意命令并触发，从而形成“无记忆负担”的高效操作方式。

## 目标与非目标

**目标（MVP）**

1. `Mod-K` 一键打开/关闭命令台（`Mod`=Mac 的 Cmd / Win/Linux 的 Ctrl）
2. 支持搜索所有可用命令（至少覆盖 manifest 声明的 commands + 运行时注册的 commands）
3. 支持键盘导航与执行（↑/↓、Enter 执行、Esc 关闭）
4. 记录最近执行（Recent），提升重复操作效率

**非目标（MVP 不做）**

- 为每个命令提供参数输入/引导（后续版本再做）
- 做到“跨上下文精确 when 规则评估”（先做基础过滤/提示）
- 复杂的可视化分组编辑、拖拽排序等高级个性化

## 用户场景

- 我记得“有个命令能做某件事”，但不记得快捷键/菜单位置：`Mod-K` → 搜索 → Enter 执行
- 想快速触发插件能力（导出、切换模型、打开某面板等），不想离开键盘
- 新用户通过命令台探索系统能力（命令描述、分类、快捷键提示）

## 交互设计

### 入口与关闭

- 快捷键：`Mod-K` toggle
- 关闭：
  - `Esc`
  - 点击遮罩（可选，默认开启）
  - 执行命令后自动关闭（MVP 默认关闭；后续可提供“按住 Shift 执行但不关闭”等增强）

### 布局（Overlay）

- 位置：视窗居中靠上（参考 VSCode），避免遮挡底部面板与状态栏
- 结构：
  - 顶部：输入框（自动聚焦），右侧提示：`↑↓ 选择 · Enter 执行 · Esc 关闭`
  - 中部：结果列表（虚拟滚动可后置）
  - 底部（可选）：当前选中项的详细信息（完整描述、来源插件、快捷键、when 条件）

### 列表项信息层级

每个命令项建议展示：

- 主标题：命令标题（title）
- 次要信息：描述（description）或命令 ID（id，弱化显示）
- 右侧：快捷键（若存在）
- 辅助：分类（category）或来源（pluginId）

### 状态与反馈

- 无结果：显示“没有找到匹配的命令”
- 不可用命令（when 不满足 / 当前上下文不支持）：
  - MVP：可以选择“隐藏”或“置灰不可执行”；推荐 MVP 先置灰并在右侧提示原因（例如 `editorFocus`）
  - 执行不可用项时：不执行，并给出轻量提示（toast 或列表内提示）

## 搜索与排序

### 匹配字段

MVP 的匹配字段与权重建议：

1. title（最高）
2. 关键词命中 description
3. 命令 id（用于高级用户快速定位）
4. category / pluginId（低权重）

匹配规则建议支持：

- 前缀匹配（快速、可解释）
- 包含匹配（覆盖更广）
- 轻量 fuzzy（可复用 [dev.slash-commands](file:///Users/bytedance/Downloads/zion-next/extensions/dev.slash-commands/main.js) 的过滤与排序方式；后续再升级更强的 scoring）

### 排序策略

综合排序建议（从高到低）：

1. Recent（最近执行的命令置顶，且在有搜索词时仍可给予轻量加权）
2. 匹配分数（title 前缀 > title 包含 > desc 命中 > id 命中）
3. 用户固定（Pin，后续版本）
4. 分类/字典序兜底

## 命令数据模型（面向产品与开发的一致口径）

建议命令在“可展示层”统一成如下结构（MVP 可部分缺省）：

- `id: string`（执行入口）
- `title: string`（展示名）
- `description?: string`
- `category?: string`
- `keybinding?: string | string[]`
- `when?: string`（MVP 先覆盖已支持的 when：`editorFocus`/`hasSelection`/`searchReplaceVisible`）
- `source?: { pluginId?: string; kind: "manifest" | "runtime" }`

执行语义：

- 统一调用 `window.zion.commands.executeCommand(id, ...args)`  
  MVP 仅对无参数命令做“直接执行”，参数命令后续用“二段式”或“动态子菜单”补齐。

## 命令来源与覆盖范围

### MVP：两条来源并行

1. **manifest contributes.commands**  
   优点：天然带 title/description 等展示信息；可在插件未激活时也可被发现  
   缺点：当前系统未把 contributes 自动转成运行时命令，可能存在“展示了但执行不了”的情况

2. **运行时 registerCommand**  
   优点：可执行性强  
   缺点：缺少 title/description（当前 API 仅 `id + handler`），展示质量不足

### 建议的产品策略（MVP）

- **默认展示：manifest 命令 + 已注册运行时命令**
- 对于“manifest 有，但运行时未注册”的命令：
  - MVP：展示但置灰，并提示“插件未激活/命令未注册”
  - 后续：引入“按需激活插件并再执行”的能力（需要与插件 activationEvents 打通）

## 快捷键设计与技术约束（需要在评审里明确）

当前 `window.zion.keybindings.register` 主要作用于编辑器（CodeMirror）内；而命令台是全局能力，理想状态应在“Workbench 级别”捕获 `Mod-K`。

评审建议结论（便于后续开发落地）：

- **命令台的 toggle 快捷键必须是全局监听**（document/window keydown），不依赖编辑器聚焦
- 编辑器内的 keymap 系统继续保留（两者互补）
- 如 `Mod-K` 与已有插件快捷键冲突：
  - 全局优先打开命令台
  - 命令台内再提供“搜索快捷键/命令”解决可发现性问题

## 可用性细节（MVP 必须）

- IME：输入法组合输入期间不触发选中变化/执行（可参考 slash 面板对 `compositionstart/end` 的处理）
- 键盘：
  - `↑/↓`：移动选中
  - `Enter`：执行
  - `Esc`：关闭并恢复之前焦点
  - `Tab`：可选，用于补全（后续）
- 焦点管理：关闭后恢复到触发前的 activeElement（编辑器/输入框/面板）

## 持久化与个性化（MVP 范围）

- Recent：localStorage 记录最近 N 条 `commandId`（建议 N=20）
- 未来：
  - Pin 固定命令
  - 用户自定义别名（alias）
  - 自定义排序/隐藏命令（适用于团队定制发行版）

## 风险与开放问题（本次评审需要拍板）

1. **命令的“可执行性”定义**：manifest 贡献的命令是否允许在未注册 handler 时展示？MVP 推荐“展示但置灰”
2. **命令元信息来源**：是否允许升级 `registerCommand` 接口以携带 title/description？  
   - 推荐做“向后兼容扩展”（例如新增 `registerCommandMeta` 或支持 `registerCommand(id, fn, meta?)`）
3. **命令参数**：哪些命令需要参数？采用“二段式输入”还是“动态子菜单”？  
   - 可复用 slash 命令的 `params/submenu` 模式，作为后续统一交互
4. **与 Slash 命令关系**：是否在 Cmd+K 的结果里也展示 Slash commands？  
   - 推荐：MVP 先只覆盖 `window.zion.commands`，并提供一条入口命令“打开 Slash 命令面板”

## 版本拆分（建议）

- **MVP（本次要做）**：全局 `Mod-K` 打开/关闭、搜索与执行、Recent、基础不可用提示
- **V1**：更好的 fuzzy scoring、展示快捷键、when 评估更准确、分组与更多信息
- **V2**：参数输入、插件按需激活、Pin/alias、可配置范围（仅当前插件/仅编辑器相关等）

