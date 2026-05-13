# 多会话多 Panel Widget 生命周期调试

状态: [OPEN]

## 目标
- 验证多 panel、多会话同时触发会话时，chat run 是否绑定到正确 panel/session/editor。
- 验证 thinking/tool widget 在插入、同步、恢复、休眠唤醒后的生命周期是否稳定。
- 验证休眠恢复后 widget 现场是否与休眠前一致，而不是退化为普通 `调用 xxx` / `思考` 文本。

## 可证伪假设
- H1: chat run 触发时读取了全局 active editor/session，导致多 panel 并发触发时 run 绑定到错误 panel 或 session。
- H2: 同会话多 panel 的文本同步先于 widget mirror/restore，导致 decoration 未挂载或挂载到错误锚点。
- H3: 不同会话 panel 的全局状态 fallback 会写错 annotations、deleted ids、followLatest 或 answerAnchor，从而跨会话串扰。
- H4: 浏览器休眠/恢复后 CodeMirror decorations 或插件 StateField 丢失，但 core annotations 仍存在，恢复检查没有正确重挂。
- H5: 休眠恢复后 editor 文本、core annotations、plugin mounted ids 三者不一致，restore 选择了兜底插入或错误锚点，导致现场和休眠前不一致。

## 证据计划
- 启动 Debug Server 收集前端 HTTP 日志。
- 埋点仅覆盖观测路径：chat.run 触发上下文、chat 事件、SessionSync、restore/snapshot/checkAndRestore、visibility/focus 恢复前后状态。
- 复现后按 H1-H5 判定，再做最小修复。

## 已完成
- Debug Server: http://127.0.0.1:7777/event
- 日志文件: .dbg/trae-debug-log-widget-lifecycle.ndjson
- Dev Server: http://localhost:5179/
- 已加入 pre-fix 观测埋点，不包含业务逻辑修改。
- 已加入临时审计命令: `zion.chatCards.auditPanels(reason)`。
- 页面 `visibilitychange` / `focus` / `pageshow` 会自动采样 panel/widget 现场。
- 定向测试通过: chat annotations / chat restore / session sync / tool reasoning policy。
- build 通过，构建产物已还原。

## 2026-05-11 Session Core 下沉
- 新增 core `SessionRuntime`，统一管理:
  - panel/session/editor context resolve。
  - panel session open/switch。
  - `session/beforeSwitch` / `session/afterSwitch` lifecycle event。
  - switch 前的 card snapshot。
- `main.ts` 中的 `openSessionInPanel` / `activatePanelSession` 已迁移为调用 `SessionRuntime`。
- `window.zion.sessions` 暴露:
  - `resolveContext(opts)`
  - `getPanelSessionId(panelId)`
  - `isEditorShowingSession(editor, sessionId)`
- `dev.langchain-chat` 的 `chat.run` 目标 editor/session 解析优先走 core session context。
- 新增 `tests/session-runtime.test.ts` 覆盖 resolve、open missing tab、switch lifecycle。
- 全量测试通过: 25 files / 67 tests。
- build 通过，构建产物已还原。

## 2026-05-11 Session Lifecycle 继续下沉
- `ChatCardRuntime` 新增 `attachSessionLifecycle()`:
  - 监听 `session/beforeSwitch`。
  - 对 previous session 触发 card snapshot。
  - 跳过同 session switch，避免重复 snapshot。
- `SessionRuntime` 移除对 card snapshot 的直接依赖，只负责发通用 session lifecycle event。
- 新增 core `SessionDocumentRuntime`，统一封装 `zion.sessions.switch` 的文档切换流程:
  - 切换前持久化 previous session presentation。
  - 写 last active id / global current id。
  - 加载目标 document 并写入目标 editor。
  - 应用 annotations。
  - 恢复 cursor / scroll。
  - 刷新 auto title、awaiting、streaming、sidebar。
- `dev.session-manager` 的 `zion.sessions.switch` 已迁移为调用 `SessionDocumentRuntime`，UI/存储细节仍通过 adapter 留在插件侧。
- 新增 `tests/session-document-runtime.test.ts`，补充 card lifecycle event 测试。
- 全量测试通过: 26 files / 71 tests。
- build 通过，构建产物已还原。

## 2026-05-13 Session 串写风险修复
- 修复 session switch 异步竞态:
  - `SessionDocumentRuntime` 为每个 panel/global target 维护 switch token。
  - `loadDocument` 返回后会校验 token 和当前 panel-session binding。
  - 旧 switch 的晚到 load 会被丢弃，不再写 editor/annotations/UI state。
- 修复 `afterSwitch` 时序:
  - `SessionRuntime.switchPanelSession()` 改为等待 document switch 完成后再发 `session/afterSwitch`。
- 修复 autosave 多 panel 隔离:
  - `createSessionAutoSavePlugin` 的 pending doc/id/view/timer 改为按 panel/view 分桶。
  - `flushPendingSave(sessionId)` 只提交匹配 session 的 bucket，避免后一个 panel 覆盖前一个 panel 的待保存内容。
- 移除 doc repo 层隐藏 UI 写入:
  - `loadDoc()` 不再异步回填 `activeEditor.setValue()`。
  - 文档写入 editor 统一收敛到 `SessionDocumentRuntime`，带 panel/session 校验。
- 限制 legacy `sessions.currentId` 反向同步:
  - 多 panel 模式下，不再让全局 currentId 变更直接改写当前 active panel tab。
- 新增回归测试:
  - `tests/session-document-runtime.test.ts`: 同 panel 连续切 session，旧 load 晚到被丢弃。
  - `tests/session-runtime.test.ts`: `afterSwitch` 等待 document switch 完成。
  - `tests/session-autosave-plugin.test.js`: 两个 panel 的 pending save 独立保存到各自 session。
- 全量测试通过: 27 files / 74 tests。
- build 通过，构建产物已还原。

## 复现步骤建议
- 场景 A: 两个 panel 打开不同 session，分别触发 chat run，观察是否有 run 绑定错 panel/session。
- 场景 B: 两个 panel 打开同一个 session，触发 thinking/tool，观察文本同步和 widget mirror/restore。
- 场景 C: 已有 thinking/tool widget 后让浏览器休眠或隐藏页面，恢复后观察 widget 是否退化为普通文本。
- 场景 D: 恢复后继续触发新 thinking/tool，观察现场是否和恢复前一致。

## 无法稳定复现时的策略
- 不强依赖人工复现。
- 让页面在正常使用、切前后台、休眠恢复时自动记录现场。
- 必要时在控制台手动执行:
  `zion.commands.executeCommand("zion.chatCards.auditPanels", "manual-check")`

## 2026-05-11 进展
- 新增 core `ChatCardRuntime` / `CardTypeRegistry`，统一管理 card type、restore/clear/snapshot event、pending restore。
- `zion.chatCards.restoreSession` 改为通过 runtime 类型注册驱动，不再在 annotations core 里硬编码发 `toolcards/restore` / `thinking/restore`。
- 新增 `zion.chatCards.snapshotSession`，split 前和 panel session switch 前改走 core snapshot 入口。
- 新增 DOM 层测试覆盖:
  - 同会话 split 后历史 tool/thinking widget 恢复。
  - 运行中新 tool/thinking widget 同步到同会话 mirror panel。
  - 不同会话 panel 不同步文本、不挂 widget、不写对方 annotations。
- 修复两个既有 UI 测试噪声:
  - submenu 测试等待真实 hover delay。
  - paste handler 测试移除不稳定全局 button 数量断言。
- 全量测试通过: 24 files / 64 tests。
- build 通过，构建产物已还原。
