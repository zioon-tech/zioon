# 多 Panel 分屏对话 — 重构与实现需求文档

> 状态：规划中 | 创建日期：2026-04-10
> 分支：`feature/multi-panel-redesign` | Worktree：`.worktrees/multi-panel-redesign/`

> 相关文档：`docs/chat-core-refactor.md`（对话渲染与 roles 内核化方案）

---

## 更新说明（2026-04-10）

- 阶段 1（解耦）已完成/大部完成：
  - `chat-doc`：消息解析、assistant block 插入/追加/收尾 → `src/chat/doc.ts`
  - `chat-runtime`：per-session run state、controller、stop/abort、兼容层 → `src/chat/runtime.ts`
  - `thinking-cards` / `tool-calls`：基于 `this.sessionId` 过滤并补齐初始化路径
  - `sessions.switch`：支持 `panelId` 预留，单 Panel 下保持兼容

- 阶段 2（分屏）当前真正重点：
  1. `PanelManager` + `SplitLayout`（布局、焦点、事件）
  2. panel-aware `activeEditor` / editor 路由（多 `EditorCore` 实例管理）
  3. `EditorHeader` Core 化（Run/Stop、路径与 tab 归属当前 panel/session）
  4. `EditorCore.dispose()` 与多实例销毁/解绑
  5. 同会话多 Panel 同步策略（防环、滚动/光标、装饰不同步）
  6. 布局持久化

- 难度评估更新：
  - 之前：`9/10`（分屏与聊天解耦并行推进，风险高）
  - 现在：`6.5–7/10`（聊天渲染与 runtime 已收敛，剩余难点主要是编辑器/工作台工程）

---
## 一、背景

Zion Next 当前是单编辑器实例架构，所有对话、流式渲染、插件操作都通过全局 `window.zion.window.activeEditor` 寻址。用户希望实现类似 VSCode 的编辑器分屏功能，每个 Panel 可以独立进行对话和流式渲染，互不干扰。

之前的分屏尝试（本 worktree）完成了 Panel 数据模型、UI 渲染、多 EditorCore 实例化等基础工作，但因为底层对话/流式逻辑与全局 editor 深度耦合，导致分屏后交互行为不符合预期（路径覆盖、流式中断、卡片错乱等），未能成功上线。

**核心教训**：不能在全局耦合的基础上直接加 Panel 层，必须先解耦对话运行与全局 editor，再引入分屏。

---

## 二、当前架构问题分析

### 2.1 全局单例耦合点

#### 显式耦合点（5 个）

| # | 耦合点 | 代码位置 | 问题描述 |
|---|--------|---------|---------|
| 1 | `getEd()` → `activeEditor` | `langchain-chat/main.js:133` | 流式 token 写入永远指向焦点 editor，焦点漂移就写错地方 |
| 2 | `sessions.currentId` | `langchain-chat/main.js:136` | 会话身份全局唯一，无法区分"哪个 Panel 在看哪个会话" |
| 3 | `registry.currentRun`（单个） | `registry.ts:81` | 同时只能有一个流式运行，无法并发 |
| 4 | `chat.streaming`（全局锁） | `registry.ts:2024` | Panel A 流式时 Panel B 无法触发对话 |
| 5 | `mountCurrentSessionPath` 全局监听 | `main.ts:108` | 监听 `sessions.currentId` 覆盖所有 Panel 的路径显示 |

#### 隐式耦合点（3 个）

| # | 耦合点 | 代码位置 | 问题描述 |
|---|--------|---------|---------|
| 6 | `attachEditor(core)` 只能调用一次 | `registry.ts:84` | 无 `detachEditor` / `dispose` 机制，无法切换或移除 editor 实例 |
| 7 | `activeEditor` 静态赋值 | `registry.ts:86` | `window.zion.window.activeEditor = new EditorProxy(core)` 是一次性赋值，非动态代理，多 Panel 下无法自动指向焦点 Panel |
| 8 | `__chatRun` 直接操作 `this.editorCore` | `registry.ts:1979` | MVP runner 绕过 `activeEditor` 代理，直接引用 `this.editorCore`，多实例下无法路由到正确 Panel |

### 2.2 问题链路示意

```
用户操作：Panel A 流式中 → 点击 Panel B

当前行为（错误）：
  getEd() 返回 Panel B 的 editor
  → 流式 token 写入 Panel B ← 错误！
  → Panel A 的流式内容被截断
  → thinking/tool 卡片也插入 Panel B ← 错误！

期望行为（正确）：
  Panel A 的 RunContext 仍持有 Panel A 的 editor 引用
  → 流式 token 继续写入 Panel A ← 正确
  → Panel B 可以独立触发自己的对话 ← 正确
  → thinking/tool 卡片各自插入各自的 Panel ← 正确
```

### 2.3 受影响的插件清单

| 插件 | 耦合方式 | 影响 |
|------|---------|------|
| `dev.langchain-chat` | `getEd()` 动态取 editor，`getSessionId()` 取全局 currentId | 流式写入目标漂移，并发互斥 |
| `dev.session-manager` | `sessions.switch` 通过 `activeEditor.setValue()` 加载内容 | 切换会话只写全局 editor |
| `dev.thinking/thinking-cards` | 监听全局事件，操作 `this.view`（当前焦点 editor 的 view） | 卡片插入到焦点 Panel 而非发起对话的 Panel |
| `dev.tools/tool-calls` | 同上，ViewPlugin 绑定到 CM6 view 实例 | 工具卡片插入到焦点 Panel |
| `registry.ts` | 单个 `currentRun`，全局 `chat.streaming` | 无法并发运行 |

---

## 三、重构目标

### 3.1 核心原则

**先解耦，再分屏。** 每一步重构都在单 Panel 下可验证，不改变用户可见行为。

### 3.2 两阶段路线

```
阶段 1：重构（解耦对话运行与全局 editor）
  → 单 Panel 下，流式对话不再受焦点切换影响
  → 多 session 可并发流式
  → thinking/tool 卡片正确归属

阶段 2：分屏（在解耦基础上引入 Panel 层）
  → 多 Panel 布局
  → 每个 Panel 独立对话
  → VSCode 行为一致性
```

---

## 四、阶段 1：重构需求（解耦）

> 当前状态：本章绝大部分内容已落地，作为阶段 2 的基线与依赖说明保留在文档中。

### 4.1 R1：对话运行绑定 editor 引用

**现状**：`doRun()` 已在启动时通过 `const ed = getEd()` 捕获 editor 引用（`main.js:298`），`flushImpl` 和 `finalize` 均使用该捕获的 `ed`。但存在一个关键问题：`flushImpl` 中当 `getSessionId() !== sid`（即非活跃 session）时，token 写入走 `zion.sessions.appendAssistantToken` 路径（`main.js:477`），绕过了 `ed` 引用，直接写入 session 存储层。在多 Panel 下，此路径需要能正确路由到对应 Panel 的 editor。

**目标**：
1. 确认 `ed` 捕获机制在多 Panel 下仍然正确（✅ 已实现）
2. 明确后台 session token 写入路径在多 Panel 下的行为：`appendAssistantToken` 应能将 token 路由到绑定该 session 的 Panel editor，而非仅写入 session 存储

**改动**：

| 文件 | 改动 |
|------|------|
| `extensions/dev.langchain-chat/main.js` | 审计 `flushImpl` 的 `isActiveSession` 分支，确保后台 session 的 token 写入能正确路由到对应 Panel 的 editor（当前走 `appendAssistantToken`，多 Panel 下需确认该命令能感知 Panel 路由） |
| `extensions/dev.langchain-chat/main.js` | 审计 `doRun` 中所有通过 `ed` 操作的位置，确认无遗漏的 `getEd()` 动态调用 |

**验证**：
1. 单 Panel 下启动对话 → 流式中点击侧边栏其他会话 → 原对话继续在 editor 中渲染
2. 流式中切换到其他 session 再切回来 → 内容完整
3. （阶段 2 验证）Panel A 流式中 → 点击 Panel B → Panel A 的 token 继续写入 Panel A 的 editor

### 4.2 R2：`chat.streaming` 改为 per-session

**现状**：
- **langchain-chat 插件**（主要路径）：已实现 per-session 运行状态。`getRunState(sid)` 读取 `chat.runs.${sid}`（`main.js:137`），`setRunState(sid, patch)` 写入 per-session 状态（`main.js:145`），`syncGlobalStreamingForActiveSession()` 将全局 `chat.streaming` 作为兼容层同步（`main.js:139`）。`runControllers` Map 已支持多 session 并发（`main.js:138`）。
- **registry.ts MVP runner**（辅助路径）：`__chatRun` / `__chatStop` 仍使用全局 `chat.streaming`（`registry.ts:2024`、`registry.ts:2077`）和单个 `currentRun`（`registry.ts:81`），无法并发。此 MVP runner 仅用于无 langchain-chat 时的回退流式，非核心路径。

**目标**：每个 session 独立的 streaming 状态，全局 `chat.streaming` 作为兼容层（所有 session 的 OR）。

**改动**：

| 文件 | 改动 | 优先级 |
|------|------|--------|
| `extensions/dev.langchain-chat/main.js` | 确认 `getRunState` / `setRunState` / `syncGlobalStreamingForActiveSession` 与 registry 的全局状态正确同步（✅ 已实现，需验证边界情况） | P0 |
| `src/ext/registry.ts` | `currentRun` → `Map<sessionId, RunContext>`；`chat.streaming` 从全局布尔改为读取 `chat.runs.${sid}.streaming` 的 OR 结果；`__chatRun` / `__chatStop` 改为按 sessionId 操作 | P1（MVP runner 改动优先级低于 langchain-chat 验证） |

**验证**：
1. Session A 对话中 → Session B 也能触发对话 → 两个同时流式
2. 全局 `chat.streaming` 在任一 session 流式时为 `true`，全部结束后为 `false`

### 4.3 R3：thinking/tool 卡片按 sessionId 过滤

**现状**：thinking-cards 和 tool-calls 已有 sessionId 过滤逻辑（`thinking-cards.js:548-549`、`tool-calls.js:1086-1088`），但过滤条件是 `payload.sessionId !== cur`，其中 `cur = window.zion?.state?.get("sessions.currentId")` 是全局 currentId。在多 Panel 下，Panel A 的 thinking ViewPlugin 应只处理 Panel A 绑定 session 的事件，而非全局 currentId 对应 session 的事件。

**目标**：卡片只处理属于自己 Panel 绑定 session 的事件。`this.sessionId` 应从 per-panel 绑定获取，而非全局 `sessions.currentId`。

**改动**：

| 文件 | 改动 |
|------|------|
| `extensions/dev.thinking/thinking-cards.js` | `onReasoningStart/Token/End` 回调中将 `cur = window.zion?.state?.get("sessions.currentId")` 改为使用 `this.sessionId`（ViewPlugin 初始化时从所属 Panel 绑定）；阶段 1 先确保 `this.sessionId` 在单 Panel 下与 `sessions.currentId` 一致 |
| `extensions/dev.tools/tool-calls.js` | `onRun/Finish/Call/Res` 回调中同样将全局 currentId 比较改为 `this.sessionId` 比较 |

**验证**：
1. Session A 流式中产生 thinking 卡片 → 切换到 Session B → 卡片继续在 Session A 的 editor 中渲染
2. Session B 的 editor 中不会出现 Session A 的 thinking 卡片

### 4.4 R4：`sessions.switch` 解耦直接 editor 操作

**现状**：`sessions.switch` 直接调用 `window.zion.window.activeEditor.setValue(text)`，分屏后无法指定目标 Panel。

**目标**：`sessions.switch` 通过事件或参数化方式加载内容，不硬编码 `activeEditor`。

**改动**：

| 文件 | 改动 |
|------|------|
| `extensions/dev.session-manager/main.js` | `dSwitch` 中 `activeEditor?.setValue(text)` 改为通过 `panelId` 参数指定目标 editor（无 panelId 时 fallback 到 `activeEditor`） |

**验证**：
1. 单 Panel 下行为不变
2. `sessions.switch({ id, panelId })` 可指定目标（为阶段 2 预留接口）

### 4.5 R5：`mountCurrentSessionPath` 解耦

**现状**：`mountCurrentSessionPath` 监听全局 `sessions.currentId`，覆盖所有 Panel 的路径显示。

**目标**：路径显示由 EditorHeader 自管理，监听 per-panel 的 activeTabId 变化。

**改动**：

| 文件 | 改动 |
|------|------|
| `src/panel/EditorHeader.ts` | 新增 `updatePath()` 方法，监听 `panel/tabActivated` 事件更新路径 |
| `src/main.ts` | 分屏 Panel 不调用 `mountCurrentSessionPath`，由 EditorHeader 自管理 |

**验证**：
1. 单 Panel 下路径显示不变
2. 为阶段 2 分屏 Panel 的独立路径显示做好准备

---

## 五、阶段 2：分屏需求

> 前置条件：阶段 1 的单 Panel 基线已经稳定；接下来重点转向 panel/workbench/editor 生命周期。

### 5.0 当前优先级（更新）

1. `PanelManager` + `SplitLayout`
2. panel-aware `activeEditor` / editor 路由
3. `EditorHeader` Core 化
4. `EditorCore.dispose()` 与 registry 解绑
5. 同会话多 Panel 同步
6. 布局持久化

### 5.1 S1：Panel 数据模型与 PanelManager

**目标**：Panel 作为第一等公民，PanelManager 管理布局和焦点。

**核心类型**：

```typescript
interface PanelTab {
  id: string;           // = sessionId
  title: string;
  isDirty: boolean;
}

interface Panel {
  id: string;
  tabs: PanelTab[];
  activeTabId: string | null;
  editorCore: EditorCore;
  editorProxy: EditorProxy;
  hostEl: HTMLElement;
  headerEl: HTMLElement;
  tabsBarEl: HTMLElement;
}
```

**PanelManager 职责**：
- 创建/关闭/分裂 Panel
- 管理布局二叉树（SplitGroup）
- 维护 `activePanelId`（焦点）
- 事件：`panel/created`、`panel/layoutChanged`、`panel/tabActivated`、`panel/focusChanged`

### 5.2 S2：多 EditorCore 实例化与 editor 路由

**目标**：每个 Panel 拥有独立的 CM6 EditorCore 实例。

**改动**：

| 文件 | 改动 |
|------|------|
| `src/editor/EditorCore.ts` | 确保可多次实例化，新增 `dispose()` |
| `src/editor/EditorProxy.ts` | 新增 `panelId` 属性 |
| `src/ext/registry.ts` | `attachEditor(panelId, core)` 支持多实例；`activeEditor` 改为动态代理或由 panel-aware getter 提供兼容层 |

**`activeEditor` 动态代理**：

```typescript
Object.defineProperty(window.zion.window, 'activeEditor', {
  get: () => panelManager?.getActivePanel()?.editorProxy ?? null
});
```

### 5.3 S3：分屏 UI 与交互

**目标**：支持水平/垂直分屏，标签页拖拽分屏，快捷键分屏。

**交互方式**：
- `Cmd+\` → 水平分屏
- `Cmd+Shift+\` → 垂直分屏
- 拖拽标签页到 Panel 边缘 → 分屏
- `Cmd+W` → 关闭当前标签页

**布局持久化**：

分屏布局需持久化到 `localStorage`（key: `zion.panelLayout`），包含：
- Panel 数量与分裂方向（水平/垂直）
- 各 Panel 的标签页列表及活跃标签
- 各 Panel 的相对宽度/高度比例

在 `panel/layoutChanged` 事件中 debounce 500ms 保存。启动时若检测到持久化布局，恢复分屏状态；若无则单 Panel 启动。

**DOM 结构**：

```html
<div class="zion-split-container" data-direction="horizontal">
  <div class="zion-split-child">
    <div class="zion-panel" data-panel-id="panel-0">
      <div class="zion-panel-tabs-bar">...</div>
      <div class="zion-panel-header">...</div>
      <div class="zion-panel-editor-host"><!-- CM6 --></div>
    </div>
  </div>
  <div class="zion-split-handle"></div>
  <div class="zion-split-child">
    <div class="zion-panel" data-panel-id="panel-1">...</div>
  </div>
</div>
```

### 5.4 S4：分屏后 VSCode 行为一致性

**目标**：分屏后每个 Panel 独立追踪自己的活跃会话，行为与 VSCode 一致。

**行为规范**：

| 操作 | 期望行为 |
|------|---------|
| 点击 Panel A 的标签页 | 只切换 Panel A 的内容，Panel B 不受影响 |
| Panel A 流式中点击 Panel B | Panel A 继续流式，Panel B 可独立操作 |
| 侧边栏点击会话 | 打开到当前聚焦的 Panel |
| 侧边栏点击已在 Panel A 打开的会话 | 在聚焦 Panel 中切换到该会话（不自动分屏，除非用户拖拽分屏） |
| 侧边栏会话高亮 | 高亮所有 Panel 中已打开的会话标签页，当前聚焦 Panel 的标签页额外高亮 |
| Panel A 的路径显示 | 显示 Panel A 的 activeTab 对应的会话路径 |
| Session 重命名 | 所有 Panel 中该 session 的标签页标题同步更新 |
| 关闭分屏 | 回到单 Panel，保留该 Panel 的标签页 |

### 5.5 S5：同会话多 Panel 同步

**场景**：同一个 Session 在多个 Panel 中打开（如 VSCode 中同一文件在左右分屏中查看）。

**核心原则：同步是底层 Panel 模块的职责，上层插件无感。**

```
架构分层：

  ┌─────────────────────────────────────────────┐
  │  上层插件（langchain-chat, thinking, tools）  │
  │  只管往自己绑定的 editor 写入，不知道其他 Panel │
  └──────────────────┬──────────────────────────┘
                     │ 写入
  ┌──────────────────▼──────────────────────────┐
  │  Panel 模块（PanelManager + SessionSync）     │
  │  检测内容变更 → 同步到其他打开同一 session 的  │
  │  Panel 的编辑器                               │
  └──────────────────┬──────────────────────────┘
                     │ 存储
  ┌──────────────────▼──────────────────────────┐
  │  Session 存储（IndexedDB + StateBus）         │
  │  sessions.doc.${id}  sessions.meta.${id}     │
  └─────────────────────────────────────────────┘
```

**同步策略**：

| 策略 | 说明 | 适用场景 |
|------|------|---------|
| **流式写入实时同步** | Panel A 的 RunContext 写入 token 时，PanelManager 同时将 token 追加到其他打开同一 session 的 Panel 编辑器 | 流式对话中 |
| **手动编辑延迟同步** | 用户在 Panel A 中手动编辑内容，PanelManager 通过 CM6 updateListener 检测变更，debounce 300ms 后同步到其他 Panel | 用户手动输入 |
| **标签页切换时加载** | Panel 切换到某 session 标签页时，从 session 存储加载最新内容 | 切换标签页 |

**实现要点**：

1. **PanelManager 维护 session → panels 映射**：
   ```typescript
   getSessionPanels(sessionId: string): Panel[]
   ```

2. **CM6 updateListener 检测变更**：
   每个 Panel 的 EditorCore 注册 updateListener，当内容变更且非同步触发时，通知 PanelManager

3. **同步写入用 diff 而非 setValue**：
   ```typescript
   // 不要用 setValue（会丢失光标、滚动位置、装饰）
   targetPanel.editorCore.view.dispatch({
     changes: { from, to, insert }
   });
   ```

4. **防循环**：同步写入时设置标志位，避免 Panel A → Panel B → Panel A 循环触发

5. **装饰（thinking/tool 卡片）不同步**：每个 Panel 的 CM6 装饰是独立的，由各自的 ViewPlugin 管理。同步只同步文本内容。

**插件无感保证**：

| 插件行为 | 是否需要改动 | 原因 |
|---------|------------|------|
| langchain-chat 写入 token 到 boundEditor | 不需要 | PanelManager 检测到内容变更后自动同步到其他 Panel |
| thinking-cards 插入装饰到 this.view | 不需要 | 装饰是 per-view 的，不同步；切换标签页时从 annotations 恢复 |
| tool-cards 插入装饰到 this.view | 不需要 | 同上 |
| session-manager flush 保存 | 不需要 | 每个 Panel 的 flush 独立保存到同一个 session 存储 |

### 5.6 当前剩余阻塞项

- `activeEditor` 仍为单实例语义，registry 仅支持一次性 attach（需动态代理/路由改造）
- `EditorCore.dispose()`：缺少多实例销毁/监听器清理/registry 解绑的完整实现
- Header Run/Stop 仍在插件里（需迁至 workbench/header）
- `roles` 未内核化（不阻塞分屏，但影响整洁度）
- registry 中 MVP chat runner 仍在（公开入口已被插件覆盖，后续建议统一收口）

---

## 六、改动规模评估

### 阶段 1（重构，当前已落地）

| 文件 | 改动类型 | 改动量 | 风险 |
|------|---------|--------|------|
| `extensions/dev.langchain-chat/main.js` | 中改 | ~300 行 | 🟡 中 |
| `src/ext/registry.ts` | 中改 | ~60 行 | 🟡 中 |
| `extensions/dev.thinking/thinking-cards.js` | 小改 | ~30 行 | 🟡 中 |
| `extensions/dev.tools/tool-calls.js` | 小改 | ~40 行 | 🟡 中 |
| `extensions/dev.session-manager/main.js` | 小改 | ~30 行 | 🟡 中 |
| `src/chat/doc.ts` | 新增 | ~280 行 | 🟡 中 |
| `src/chat/runtime.ts` | 新增 | ~140 行 | 🟡 中 |
| `src/chat/types.ts` | 新增 | ~30 行 | 🟢 低 |
| `src/main.ts` | 小改 | ~20 行 | 🟢 低 |
| `src/types/zion.d.ts` | 小改 | ~10 行 | 🟢 低 |
| **总计** | | **~900–1000 行** | |

### 阶段 2（分屏，当前待做）

| 文件 | 改动类型 | 改动量 | 风险 |
|------|---------|--------|------|
| `src/panel/PanelManager.ts` | 新增 | ~400 行 | 🟡 中 |
| `src/panel/SplitLayout.ts` | 新增 | ~200 行 | 🟢 低 |
| `src/panel/SessionSync.ts` | 新增 | ~180 行 | 🟡 中 |
| `src/editor/EditorCore.ts` | 中改 | ~70 行 | 🔴 高 |
| `src/editor/EditorProxy.ts` | 中改 | ~50 行 | 🟡 中 |
| `src/ext/registry.ts` | 中改 | ~80 行 | 🔴 高 |
| `src/main.ts` | 大改 | ~200 行 | 🔴 高 |
| `src/ui/workbench/workbench.ts` | 大改 | ~150 行 | 🔴 高 |
| `src/styles.css` | 追加 | ~220 行 | 🟢 低 |
| `extensions/dev.session-manager/main.js` | 中改 | ~80 行 | 🟡 中 |
| header Run/Stop（workbench/header） | 新增 | ~120 行 | 🟡 中 |
| **总计** | | **~1550–1750 行** | |

---

## 七、优先级与执行顺序

```
阶段 1（重构，已完成/大部完成）
  R1: 对话运行绑定 editor 引用
  R2: chat.streaming per-session
  R3: thinking/tool 卡片 sessionId 过滤
  R4: sessions.switch 解耦
  R5: mountCurrentSessionPath 解耦

阶段 2（分屏，在重构基础上）
  S1: Panel 数据模型 + PanelManager      ← P0
  S2: 多 EditorCore 实例化与 editor 路由 ← P0
  S3: 分屏 UI 与交互                    ← P1
  S4: VSCode 行为一致性                 ← P1
  S5: 同会话多 Panel 同步               ← P1
  S6: 布局持久化                        ← P2
```

---

## 八、可执行任务清单

### 8.1 Task Pack A：Panel 基础骨架

**目标**：先把 Panel 容器、布局树和焦点事件搭起来，不接入聊天逻辑。

- [ ] 新增 `src/panel/PanelManager.ts`
- [ ] 新增 `src/panel/SplitLayout.ts`
- [ ] 定义 `Panel` / `PanelTab` / `SplitNode` 等核心类型
- [ ] 提供 `createPanel()` / `closePanel()` / `splitPanel()` / `focusPanel()` / `activateTab()`
- [ ] 发出基础事件：`panel/created`、`panel/layoutChanged`、`panel/tabActivated`、`panel/focusChanged`
- [ ] 在 `src/ui/workbench/workbench.ts` 中挂载基础 split DOM

**完成标准**：
- [ ] 可以在 UI 上创建两个空 Panel
- [ ] 焦点切换有明确的 `activePanelId`
- [ ] Panel 关闭/分裂不会破坏已有 DOM

### 8.2 Task Pack B：多 EditorCore 实例与 editor 路由

**目标**：让每个 Panel 拥有独立 editor，并把“当前 editor”语义从全局单例切到 panel-aware 路由。

- [ ] 每个 Panel 创建独立 `EditorCore`
- [ ] `EditorProxy` 增加 `panelId`
- [ ] `registry.ts` 支持多实例 attach
- [ ] `window.zion.window.activeEditor` 改为动态代理或兼容 getter
- [ ] 暴露 `window.zion.panels.getEditor(panelId)` 之类的显式路由 API
- [ ] 审计旧代码中所有 `activeEditor` 的使用点

**完成标准**：
- [ ] 两个 Panel 中的 editor 可以独立输入
- [ ] 焦点切换后 `activeEditor` 指向当前 Panel
- [ ] 旧插件在不感知 Panel 的情况下仍可工作

### 8.3 Task Pack C：Header Core 化

**目标**：把 header 中与对话相关的 UI 从插件迁到 core/workbench。

- [ ] 设计 panel 级 `EditorHeader`
- [ ] 将 Run/Stop 按钮迁到 workbench/header
- [ ] Run/Stop 直接调用 `window.zion.chat.run/stop/isStreaming`
- [ ] 将路径显示绑定到当前 panel 的 `activeTabId`
- [ ] tab 标题、dirty 状态、路径显示全部 panel 本地化

**完成标准**：
- [ ] Header Run/Stop 不再依赖 `langchain-chat` 注入
- [ ] 切换 panel/tab 时路径和按钮状态都正确更新

### 8.4 Task Pack D：EditorCore 生命周期

**目标**：解决多实例场景下的销毁、解绑与资源清理问题。

- [ ] 为 `EditorCore` 补齐 `dispose()`
- [ ] 清理 `EditorView`、事件监听、StateField/Compartment 关联
- [ ] Panel 关闭时正确销毁 editor 实例
- [ ] `registry` 增加 detach/unregister 逻辑

**完成标准**：
- [ ] 反复分裂/关闭 Panel 不出现僵尸 editor
- [ ] 不残留错误的 `activeEditor` / editor 引用

### 8.5 Task Pack E：同会话多 Panel 同步

**目标**：同一 session 在多个 Panel 打开时，文本同步但交互互不打扰。

- [ ] 新增 `src/panel/SessionSync.ts`
- [ ] 建立 `sessionId -> Panel[]` 映射
- [ ] 监听编辑器文本变更并做 debounce 同步
- [ ] 同步使用 CM6 `dispatch({ changes })`，禁止 `setValue`
- [ ] 增加防循环来源标记
- [ ] 明确滚动/光标策略：只跟随主动编辑的 Panel
- [ ] 明确装饰策略：thinking/tool 不做跨 Panel 同步

**完成标准**：
- [ ] 手动编辑可同步
- [ ] 流式写入可同步
- [ ] 被动同步的 Panel 不丢光标/滚动

### 8.6 Task Pack F：布局持久化与收尾

**目标**：让分屏状态可恢复，并把外围交互收口。

- [ ] 持久化 `zion.panelLayout`
- [ ] 启动时恢复 Panel 树、tabs、active、尺寸比例
- [ ] 侧边栏点击会话默认打开到当前焦点 Panel
- [ ] 统一 Session 重命名、关闭、恢复单 Panel 的行为
- [ ] 回归验收所有阶段 2 checklist

**完成标准**：
- [ ] 关闭浏览器后可恢复布局
- [ ] 侧边栏、header、tab、panel 行为保持一致

### 8.7 推荐实施顺序

1. Task Pack A
2. Task Pack B
3. Task Pack C
4. Task Pack D
5. Task Pack E
6. Task Pack F

**原因**：
- A/B 决定 panel 与 editor 的底座
- C 依赖 B 提供稳定的当前 panel/session 语义
- D 是多实例稳定性前提
- E/F 属于在底座稳定后的行为完善

---

## 九、验收标准

### 阶段 1 验收（已作为当前基线）

- [ ] 单 Panel 下启动对话 → 流式中切换侧边栏会话 → 原对话继续渲染不中断
- [ ] 单 Panel 下两个 session 可并发流式对话
- [ ] thinking 卡片只出现在发起对话的 session editor 中
- [ ] tool 卡片只出现在发起对话的 session editor 中
- [ ] 全局 `chat.streaming` 在任一 session 流式时为 `true`
- [ ] 现有单 Panel 功能全部正常（回归无破坏）

### 阶段 2 验收

- [ ] `Cmd+\` 水平分屏，两个 Panel 各自有独立编辑器
- [ ] Panel A 流式中点击 Panel B → Panel A 继续流式，Panel B 可独立操作
- [ ] Panel B 也可触发对话 → 两个 Panel 同时流式互不干扰
- [ ] 点击 Panel A 的标签页 → 只切换 Panel A 的内容
- [ ] 侧边栏点击会话 → 打开到聚焦的 Panel
- [ ] 每个 Panel 的路径显示独立
- [ ] 关闭分屏 → 回到单 Panel
- [ ] thinking/tool 卡片在各自的 Panel 中正确渲染
- [ ] 同一 session 在两个 Panel 中打开 → Panel A 手动编辑 → Panel B 内容同步更新
- [ ] 同一 session 在两个 Panel 中打开 → Panel A 流式对话 → Panel B 内容实时同步
- [ ] 同步不丢失 Panel B 的光标位置和滚动位置
- [ ] Header Run/Stop 跟随当前 panel/session，而不是由插件全局注入
- [ ] 分屏布局持久化：关闭浏览器后重新打开 → 恢复之前的分屏状态（Panel 数量、方向、标签页）

---

## 十、风险与注意事项

1. **阶段 1 不能破坏现有行为**：每一步重构后都要回归测试单 Panel 场景
2. **`activeEditor` 动态代理是兼容层**：核心路径用显式 panelId 寻址，动态代理仅保证老插件不崩
3. **Session 跟 Tab 走**：Tab 移到新 Panel → Session 也跟着走（VSCode 行为）
4. **全局 `sessions.currentId` 保留**：代表"最后活跃的会话"，用于侧边栏高亮和 URL 同步，不代表"每个 Panel 看哪个会话"
5. **CSS 布局**：分屏需要完整的 CSS 支持，之前尝试中 CSS 缺失导致编辑器消失
6. **DOM 保护**：PanelManager render 时不能 `innerHTML = ''` 销毁已有编辑器 DOM
7. **同会话同步防循环**：Panel A 写入 → 同步到 Panel B → Panel B 的 updateListener 触发 → 不能再同步回 Panel A，需要标志位或来源标记
8. **同步用 diff 不用 setValue**：`setValue()` 会重置光标、滚动位置、CM6 装饰，必须用 `dispatch({ changes })` 做增量同步
9. **装饰不同步**：thinking/tool 卡片是 CM6 Decoration，per-view 的，不同步文本时同步装饰。切换标签页时从 annotations 恢复
10. **分屏布局持久化**：分屏布局（Panel 数量、方向、各 Panel 的标签页列表和活跃标签）需持久化到 localStorage，用户关闭浏览器后重新打开应恢复之前的分屏状态（与 VSCode 行为一致）。持久化 key 建议 `zion.panelLayout`，在 PanelManager 的 `layoutChanged` 事件中 debounce 500ms 保存
11. **`activeEditor` 审计**：改为动态代理后，需审计所有 `window.zion.window.activeEditor` 的使用点，确保没有长期缓存引用后跨 Panel 使用的情况。当前代码中 `langchain-chat` 的 `const ed = getEd()` 是在 `doRun` 开始时一次性缓存的（正确行为：绑定到整个流式生命周期），但需与动态代理行为明确区分——动态代理每次 `get` 返回当前焦点 Panel 的 editor，而 `doRun` 的 `ed` 是启动时的快照
