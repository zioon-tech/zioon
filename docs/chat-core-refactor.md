# 对话内核化改造方案

> 状态：草案 | 创建日期：2026-04-10
> 分支：`feature/multi-panel-redesign` | Worktree：`.worktrees/multi-panel-redesign/`

---

## 一、背景

当前对话能力主要由插件实现，尤其是：

- `extensions/dev.langchain-chat/main.js`
- `extensions/dev.langchain-chat/chat-service.js`
- `extensions/dev.roles/roles.js`
- `extensions/dev.roles/main.js`

这套结构在单编辑器模式下可以工作，但在以下场景下暴露出边界问题：

1. 多 Panel 下，流式写入、卡片渲染、header Run/Stop 等能力本质上依赖 editor/session/workbench 路由，继续放在插件层会导致职责错位
2. `langchain-chat` 同时承担了模型管理、请求编排、assistant block 插入、token flush、run 生命周期管理、header UI 注入等多重职责，文件体量和耦合度持续上升
3. `dev.roles` 中的 role 识别和装饰本质上是编辑器语法层能力，不适合长期作为业务插件维护

因此，需要将“对话文档格式、对话渲染、run 生命周期、editor 级交互”下沉到内核，将“provider、模型、请求格式、策略扩展”保留在插件层。

---

## 二、目标与边界

### 2.1 目标

本次内核化改造的目标是建立稳定的对话基础设施，使以下能力成为内核默认能力：

- 角色化文档格式解析：`system` / `user` / `assistant` / `tool`
- assistant block 的插入、定位、流式追加、结束收尾
- session 级 run 状态管理与 stop/retry
- editor header 的 Run/Stop 入口
- 多 Panel 下 session 到 editor 的写入路由
- 对外稳定 API：`window.zion.chat`、`window.zion.roles`

### 2.2 非目标

以下内容不在本次内核化范围内，仍保留在插件层：

- provider 适配与模型配置
- 模型列表、active model 管理
- reasoning policy、tool call provider 差异处理
- slash commands、设置页、模型管理 UI
- 角色配置面板与自定义角色管理 UI

### 2.3 设计原则

1. **核心只收 editor/session/render 强耦合逻辑**
2. **provider 差异不反向污染 core**
3. **单 Panel 先等价迁移，多 Panel 再放大收益**
4. **优先抽服务，再迁 UI**
5. **兼容现有事件协议，降低插件迁移成本**

---

## 三、当前问题

### 3.1 `langchain-chat` 责任过重

当前 `extensions/dev.langchain-chat/main.js` 同时负责：

- 读取当前 editor 内容
- 解析消息块
- 插入 assistant block
- 维护流式 token buffer
- 处理 finalize / stop / retry
- 发射对话事件
- 注入 editor header Run/Stop 按钮

这导致它既像“provider 插件”，又像“chat runtime”，还像“editor UI 插件”。

### 3.2 `roles` 的职责更像编辑器语法层

`extensions/dev.roles/roles.js` 主要提供：

- role line 检测
- role token decoration
- role block 高亮
- 当前行 role 切换

这些能力本质上属于编辑器层，对模型/provider 完全无关，放在插件层会增加初始化路径和后续维护复杂度。

### 3.3 多 Panel 场景需要 core 掌握写入路由

无论模型来自哪个插件，最终都需要回答这些问题：

- 当前 run 绑定哪个 session
- 这个 session 在哪个 editor 中渲染
- 背景 session 的 token 该写到哪里
- Run/Stop 按钮应该控制哪个 session

这些问题不能由某个 provider 插件单独决定，必须由内核统一控制。

---

## 四、目标架构

### 4.1 分层模型

```text
+--------------------------------------------------+
|                   Plugin Layer                   |
|  langchain-chat / future providers / settings    |
|  - provider registry                             |
|  - model management                              |
|  - request transform                             |
|  - reasoning/tool-call policy                    |
+-------------------------+------------------------+
                          |
                          v
+--------------------------------------------------+
|                    Core Chat                     |
|  chat-runtime  |  chat-doc  |  roles             |
|  - run/stop    |  - parse   |  - role syntax     |
|  - controller  |  - insert  |  - decorations     |
|  - session map |  - append  |  - line mutation   |
|  - routing     |  - finalize|                     |
+-------------------------+------------------------+
                          |
                          v
+--------------------------------------------------+
|              Editor / Session / Workbench        |
|  EditorCore / EditorProxy / session-manager      |
|  header / tabs / multi-panel routing             |
+--------------------------------------------------+
```

### 4.2 核心职责划分

| 层 | 职责 | 典型文件 |
|---|---|---|
| Core Chat | 文档格式、流式写入、run 生命周期、session/editor 路由 | `src/chat/*` |
| Provider Plugin | 模型、provider、请求协议、工具调用适配 | `extensions/dev.langchain-chat/*` |
| Editor/Workbench | editor 实例、header、Panel、焦点与布局 | `src/editor/*`、`src/ui/*` |

---

## 五、Core 模块设计

### 5.1 `src/chat/types.ts`

定义 chat core 的基础类型：

```ts
export type ChatRole = "system" | "user" | "assistant" | "tool" | string;

export interface ChatMessage {
  role: ChatRole;
  content: string | any[];
}

export interface AssistantAnchor {
  sessionId: string;
  headLine: number;
  anchorPos: number;
}

export interface ChatRunState {
  runId: string | null;
  streaming: boolean;
  aborted: boolean;
  awaiting: boolean;
}
```

### 5.2 `src/chat/doc.ts`

负责对话文档模型和写入操作，不关心 provider。

建议导出：

```ts
export interface ChatDocService {
  parseMessages(text: string): ChatMessage[];
  insertAssistantBlock(editor: EditorProxy, opts: {
    sessionId: string;
    cursor?: { line: number; ch: number };
  }): AssistantAnchor;
  appendAssistantToken(editor: EditorProxy, opts: {
    sessionId: string;
    runId: string;
    token: string;
    anchor?: AssistantAnchor;
  }): void;
  finalizeAssistantBlock(editor: EditorProxy, opts: {
    sessionId: string;
    runId: string;
    ensureTrailingUser?: boolean;
  }): void;
}
```

职责包括：

- 解析 chat 文档为消息数组
- 在光标后安全插入 assistant block
- 在已有 assistant block 末尾追加 token
- finalize 时补全换行、恢复 user 占位结构
- 维护 `chat.answerHeadLine.${sessionId}` 与 `chat.answerAnchorPos.${sessionId}`

### 5.3 `src/chat/runtime.ts`

负责 run 生命周期和 session/editor 路由。

建议导出：

```ts
export interface ChatRunRequest {
  sessionId?: string;
  editor?: EditorProxy | null;
  prompt?: string;
  useSelection?: boolean;
  tools?: any[];
  providerId?: string;
  modelId?: string;
}

export interface ChatStreamAdapter {
  runStream(opts: {
    runId: string;
    sessionId: string;
    messages: ChatMessage[];
    tools?: any[];
    onToken?: (token: string) => void;
    onToolCall?: (payload: any) => void;
    onReasoningStart?: (payload: any) => void;
    onReasoningToken?: (payload: any) => void;
    onReasoningEnd?: (payload: any) => void;
    onEnd?: () => void;
    onError?: (error: any) => void;
    getController?: (controller: AbortController) => void;
  }): Promise<void>;
}

export interface ChatRuntime {
  run(req?: ChatRunRequest): Promise<void>;
  stop(sessionId?: string): void;
  retry(sessionId?: string): void;
  isStreaming(sessionId?: string): boolean;
}
```

职责包括：

- 解析 `sessionId` 与目标 editor
- 创建 runId
- 维护 per-session controller / state
- 调用 `ChatDocService` 处理 assistant block
- 调用插件提供的 `ChatStreamAdapter`
- 发射统一事件：
  - `chat/runStarted`
  - `chat/token`
  - `chat/runFinished`
  - `chat/runError`
  - `chat/aborted`
- 维护全局兼容状态 `chat.streaming`

### 5.4 `src/chat/roles.ts`

负责 role 语法与编辑器装饰。

建议导出：

```ts
export interface RoleService {
  getPrefixes(): string[];
  setPrefixes(prefixes: string[]): void;
  setLineRole(editor: EditorProxy, role: string): void;
  toggleUserLine(editor: EditorProxy): void;
  createDecorationExtension(opts?: {
    prefixes?: string[];
    highlightBlockRoles?: string[];
  }): any;
}
```

职责包括：

- role 前缀读取与规范化
- role token decoration
- block 级高亮
- 当前行 role 切换
- 向 `EditorCore` 暴露装饰扩展

---

## 六、对外 API 设计

### 6.1 `window.zion.chat`

建议在现有基础上收敛为稳定 API：

```ts
chat?: {
  run(opts?: {
    sessionId?: string;
    editor?: EditorProxy | null;
    useSelection?: boolean;
    prompt?: string;
    providerId?: string;
    modelId?: string;
  }): Promise<void>;
  stop(sessionId?: string): void;
  retry(sessionId?: string): void;
  isStreaming(sessionId?: string): boolean;
}
```

说明：

- `chat.run()` 成为唯一入口，provider 插件不再直接操作 editor
- `sessionId` 与 `editor` 都可显式传入，为多 Panel 预留
- `providerId/modelId` 可选传入，用于覆盖当前 active model

### 6.2 `window.zion.roles`

建议新增：

```ts
roles?: {
  getPrefixes(): string[];
  setLineRole(role: string, editor?: EditorProxy | null): void;
  toggleUserLine(editor?: EditorProxy | null): void;
}
```

说明：

- `dev.roles` 变成 `window.zion.roles` 的 UI 封装层
- 其他插件若需要 role 行操作，可直接调用该稳定接口

### 6.3 `window.zion.llm`

`window.zion.llm.runStream()` 继续保留，但职责收窄为“provider/adapter 调用入口”，不再承担 editor 写回职责。

---

## 七、插件层重构方案

### 7.1 `dev.langchain-chat` 的新职责

改造后，`dev.langchain-chat` 只负责：

- provider 注册
- active model 管理
- provider 请求体组装
- stream 解析
- tool call / reasoning 协议适配
- 将 token / reasoning / tool-call 回调交给 core runtime

不再负责：

- assistant block 插入
- editor token flush
- finalize
- session 到 editor 的路由
- editor header Run/Stop 按钮渲染

### 7.2 `dev.roles` 的新职责

改造后，`dev.roles` 只负责：

- 配置 UI
- 自定义角色编辑入口
- 调用 `window.zion.roles` 的命令入口

不再负责：

- role decoration 的底层实现
- role block 的扫描与渲染

---

## 八、迁移顺序

### 阶段 A：抽 `chat-doc`

目标：从 `dev.langchain-chat/main.js` 中抽出文档解析和 assistant block 渲染逻辑。

迁移内容：

- `parseMessages`
- assistant block 插入逻辑
- token append 逻辑
- finalize 逻辑
- answer anchor 状态写入

收益：

- 降低 `main.js` 复杂度
- 后续 provider 插件复用同一套 chat 文档协议

### 阶段 B：抽 `chat-runtime`

目标：统一 run 生命周期与 session 路由。

迁移内容：

- runId 生成
- per-session run state
- stop/retry
- controller 管理
- `chat.streaming` 兼容层
- `chat/run*` 事件发射

收益：

- 多 Panel 下写入路由集中到 core
- `langchain-chat` 变成 adapter，不再直接碰 editor

### 阶段 C：header Run/Stop core 化

目标：将 editor header Run/Stop 按钮从插件迁到 workbench/core。

迁移内容：

- 去除 `dev.langchain-chat/main.js` 中的 header button 注入
- 改由 EditorHeader 或 workbench header 直接依赖 `window.zion.chat`

收益：

- 无论启用哪种 provider 插件，header 行为一致
- 多 Panel 下更容易做到“按钮跟随当前 panel/session”

### 阶段 D：roles core 化

目标：将 role 语法/装饰下沉为编辑器基础能力。

迁移内容：

- role prefix 识别
- decoration extension
- 当前行 role 操作

收益：

- role 文档格式成为默认语法能力
- 其他插件可直接依赖该能力

---

## 九、和多 Panel 重构的关系

本方案是 `docs/multi-panel-refactor.md` 的前置架构补充。

对应关系如下：

| 多 Panel 诉求 | 内核化方案如何支撑 |
|---|---|
| 流式 token 不能漂移到别的 Panel | `chat-runtime` 持有 session/editor 绑定，统一写入路由 |
| 背景 session 的 token 继续写入原位置 | `chat-doc` 和 runtime 共同维护 assistant anchor |
| Run/Stop 应和当前 Panel 对齐 | header 按钮迁到 core，直接依赖当前 panel/session |
| thinking / tool-calls 不应绑全局 currentId | 统一事件协议继续保留，插件只消费 `sessionId` |
| 多 provider 并存 | provider 继续留插件层，core 不感知具体模型厂商 |

---

## 十、兼容性与风险

### 10.1 兼容性要求

1. 单 Panel 行为不变
2. 现有事件名尽量不变
3. 现有 `chat.run` / `chat.stop` / `chat.retry` 命令名不变
4. 现有 `thinking-cards` / `tool-calls` 优先做到“无需大改即可接入”

### 10.2 风险点

1. `parseMessages` 一旦 core 化，就会成为稳定协议，后续修改成本升高
2. provider 的 tool-call / reasoning 差异很大，若抽象过度会让 core 变脏
3. 迁移混合期会出现“渲染在 core、卡片仍在插件”的双层结构，需要明确事件协议边界
4. header 按钮 core 化后，需要定义“当前无 provider 可用”的降级行为

### 10.3 降级策略

- 若未注册任何可用 provider：
  - Run 按钮显示 disabled，或弹出模型配置提示
- 若插件未适配新 `ChatStreamAdapter`：
  - 保留旧路径一段时间，通过 feature flag 切换

---

## 十一、验收标准

### 11.1 架构验收

- [ ] `langchain-chat` 不再直接调用 editor 的 assistant block 渲染逻辑
- [ ] `dev.roles` 不再直接持有底层 decoration 实现
- [ ] `window.zion.chat` 成为唯一稳定的对话运行入口
- [ ] `window.zion.roles` 成为唯一稳定的 role 操作入口

### 11.2 行为验收

- [ ] 单 Panel 下聊天行为与当前一致
- [ ] 流式 / 非流式回答均通过 core 渲染
- [ ] 多 session 并发流式仍可正确维护状态
- [ ] 后续多 Panel 接入时，不需要让 provider 插件感知 Panel 概念

### 11.3 工程验收

- [ ] `extensions/dev.langchain-chat/main.js` 文件职责明显收敛
- [ ] 核心 chat 能力具备清晰的模块边界与类型定义
- [ ] 新增 API 已补充到 `src/types/zion.d.ts`

---

## 十二、推荐落地顺序

建议按以下顺序推进：

1. 先做 `chat-doc`
2. 再做 `chat-runtime`
3. 再迁 header Run/Stop
4. 最后迁 `roles`

原因：

- `chat-doc` 和 `chat-runtime` 是多 Panel 的真正前置
- header 按钮迁移依赖 `window.zion.chat` 收敛完成
- `roles` 虽然也适合进 core，但对多 Panel 的阻塞程度低于聊天 runtime

---

## 十三、结论

“角色插件”和“对话渲染”都适合逐步内核化，但方式应是：

- **渲染先内核化**
- **provider 继续插件化**
- **roles 随后内核化**

最终目标不是“去插件化”，而是建立一套清晰分层：

- core 负责 editor/session/render
- plugin 负责 provider/model/policy

这样既能支撑多 Panel，又能保留后续多模型、多 provider、多策略扩展的灵活性。
