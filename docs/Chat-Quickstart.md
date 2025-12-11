# Chat Runner Quickstart (MVP)

本示例演示如何试用内置的最小 Chat Runner（不依赖 LangChain）：

1) 启动项目
- 安装依赖：`npm i`
- 开发服务器：`npm run dev`

2) 加载示例扩展
- 确认以下扩展已加载：
  - `extensions/dev.sample-models`（提供示例模型 provider）
  - `extensions/dev.sample-chat`（本次新增，用于快捷试用 Chat Runner）
- 加载成功后，状态栏会出现“Model: …”与“Run/Stop”按钮。

3) 选择模型（示例）
- 点击状态栏“Model: …”按钮，可在 `demo:gpt-small` 与 `demo:gpt-large` 间切换（来自 dev.sample-models）。
- 也可执行命令：
  - `models.selectDemoSmall`
  - `models.selectDemoLarge`

4) 编写对话
- 使用角色前缀编写对话内容：
  ```
  system 你是一个乐于助人的助手。
  user 请回答：2+2=
  ```
- 每个角色块以行首的 `system ` / `user ` / `assistant ` 开头，直到下一个角色行为止。

5) 运行与停止
- 快捷键：
  - Mod-Enter（Cmd/Ctrl+Enter）：运行“选区”；若无选区则运行整文档（取最新的 user 内容）
  - Esc：停止当前流式输出
  - Mod-Shift-R：重试上次提示
- 右键菜单（编辑器内）：Run Chat (Selection) / Stop Chat / Retry Chat
- 状态栏：
  - “Run”/“Stop”按钮：当前不在流式输出时显示“Run”，点击优先运行选区，否则运行整文档；流式输出中显示“Stop”。

6) 输出与事件
- Chat Runner 会在文档末尾插入一个新的 `assistant ` 区块，并以模拟 Token 的方式流式写入。
- 状态总线键：
  - `chat.runId`（当前运行 ID）
  - `chat.streaming`（是否正在流式输出）
  - `chat.error`（错误消息或 null）
- 事件：
  - `chat/runStarted`、`chat/token`、`chat/runFinished`、`chat/aborted`

> 说明：当前已支持真实流式与 Tool Calls。内置扩展会在激活时自动注册示例工具并处理工具返回，再继续追加对话输出。

7) Tool Calls 快速试用（无需自备工具）
- 已内置并自动注册到状态总线的示例工具：
  - echo(text: string)：回声返回
  - sum(numbers: number[])：求和
  - calculate(expression: string)：安全算术表达式（仅数字和 +-*/(). 空格）
- 示例 1（求和）：
  ```
  system 你是一个会在需要时调用工具的助手。
  user 请用 sum 计算 [1,2,3,4,5] 的和，并简要解释过程。
  ```
- 示例 2（表达式计算）：
  ```
  user 请用 calculate 计算 (2+3)*5，然后解释你的步骤。
  ```
- 运行后，模型触发工具调用；扩展自动执行工具，将结果以 role:"tool" 消息回填，并自动发起第二次请求继续输出，直到完成。
- 可选：也可在文档内声明工具（会与内置合并），语法示例：
  ```
  tools:echo 回声
  - text (string): 要回显的文本
  required: text
  ```
- 相关状态键（可用于自定义）：
  - `chat.tools`：已注册的工具定义（OpenAI Function schema）
  - `chat.toolHandlers`：工具处理器字典 `{ [name]: (args) => string | Promise<string> }`