# Zioon 账户插件开发与运行

账户插件由 Workbench、CLI 和 API 共用。开发者编写函数，平台负责 Host、账户工作区、生命周期、取消、运行记录和后台任务。用户模块只在账户工作区或已授权设备的独立进程执行。

## 从一个函数开始

CLI 先登录目标 Runtime：

```sh
zioon auth login zioon-cloud
zioon extensions init my-tool --kind plugin
zioon extensions dev my-tool
```

第三条命令保持运行，编辑 `my-tool/runtime.mjs` 后自动构建。也可以在项目目录运行 `npm run dev`。模板已经带有 SDK helper 和脚本，不需要配置 Host、同步目录或依赖准备步骤。

```js
import { defineToolPlugin } from "./plugin-runtime.mjs";
export const runtimePluginApiVersion = 2;
export const activateRuntimePlugin = defineToolPlugin({
  name: "hello",
  description: "Say hello",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false
  },
  execution: { effect: "read", idempotency: "safe" },
  async invoke({ name }) {
    return { ok: true, content: "Hello, " + name };
  }
});
```

成功构建自动安装到当前账户，Workbench 通过同一账户发现。模型可以用 `extensionsCall` 调用工具；开发者也可以从市场的“开发调试”或 CLI 调用。源码保存到账户 AgenticFS 的 `/workspace/.zion/plugins/{pluginId}`，不可变构建存对象存储。

注册、成功构建和开发安装关系属于 `marketplace_accounts` 的同一 PostgreSQL 事务。构建或提交失败时仍使用上一个成功构建。新构建切换 epoch，运行中的旧版本明确失效。开发版本使用独立的 `development.*` namespace，不覆盖发布版本；保留最近八个构建。

```sh
zioon extensions dev list
zioon extensions dev build my-tool
zioon extensions dev stop my-tool
zioon extensions publish my-tool
```

`publish` 验证并发布当前账户的私有版本，返回固定版本、listing ID 和 digest。版本内容不可改写；更新时同时修改 `zion-extension.json` 和 `manifest.json` 的版本号。`pack --out` 和 `upload` 仍支持离线构建及独立上传。

`zioon extensions publish my-tool --public` 将同一制品提交市场审核，要求声明无凭据的 HTTPS `sourceUrl`。返回 `submitted` 后等待审核；通过后其他账户才能看到并安装。Skill、代码插件和 MCP 共用此流程。

## 本地设备与内网模型

已有 Connector 的设备可以直接作为源码来源：

```sh
zioon extensions dev start /absolute/project --node node-id --watch
```

默认执行位置仍为账户工作区。需要内网访问时，在市场“连接与设置”选择对应设备，或使用：

```sh
zioon extensions configure listing-id --node node-id
```

新版 Connector 上报工作目录，可自动选用；旧 Connector 可补 `--root /absolute/workspace`。账户未开通工作区、设备离线或权限不足均明确报错。平台服务器不能承接用户执行。

模型模板：

```sh
zioon extensions init intranet-model --kind model
zioon extensions dev intranet-model
```

模型声明包含 Provider ID 和模型元数据，实际 `request(body, context)` 在所选设备上执行并返回 `Response`，或 `{ status, headers, body }`。`body` 支持字符串、字节数组和异步迭代器。请求和响应沿 Connector 的结构化 Host 通道传输，复用已有 OpenAI Compatible Engine 的 JSON/SSE、工具调用、usage 和完成解析。

`supportsStreaming: false` 的模型收到 `stream: false`；仅支持 JSON 的服务不需要实现 SSE。`context.abortSignal` 传给上游 fetch，Runtime 负责取消、撤权检查和流量回压。模型设备与 Run 的工具设备独立：内网模型可在个人设备上请求，而 Bash、文件和其他工具继续在账户工作区执行。

模型选择作为账户默认保存在 PostgreSQL；新的 Workbench/CLI 客户端和没有显式模型的新对话使用同一选择。`PUT /v1/models/selection` 接收 `profileId` 和可选 `interactionProfileId`，`profileId: null` 恢复平台默认。选择只影响当前账户；已有会话的显式模型和恢复中的 Run 继续使用原模型。无恢复检查点的 Run 返回 `run_checkpoint_unavailable`，必须新建 Run。

普通 Run 开始时保存工具扩展的版本、epoch 和已验证 schema，并在 `extensionsCall` 描述中提供目录。目录读取不启动 Host；调用时固定原 epoch，安装或设置变更后明确失效。可选上下文可通过 `metadata.contextProviders` 选择；在能力声明中设置 `required: false` 和对应 provider ID，可以在首次激活前跳过未选中的上下文。必需上下文仍在模型请求前执行。

账户插件数据位于 `/workspace/.zion/plugin-data/.account-extensions/{accountHash}/{listingHash}`，避免与内置插件和其他账户冲突。SDK 的 `data`、`state` 与 `locations.data` 使用同一路径。旧 Host 数据在首次激活时原子迁移；如果新旧目录同时存在，返回 `extension_data_migration_conflict`，避免覆盖数据。

## 服务连接与公开设置

插件的 `settingsSchema` 声明公开标量设置，支持字符串、数字、整数、布尔值和枚举；根必须为 object 且 `additionalProperties: false`。配置值经过服务端校验，默认值统一解析。模板函数通过 `context.settings` 读取。

```json
{
  "settingsSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "language": { "type": "string", "title": "回复语言", "enum": ["中文", "English"], "default": "中文" }
    }
  },
  "connection": { "label": "我的模型服务", "envKeys": ["MODEL_API_KEY"], "required": true }
}
```

令牌与密钥保存在所选设备上的私有 JSON 文件，文件权限为 `0600`。文件声明精确 `listingId`、可选的 `accountId`、服务 `endpoint` 和 `env`。Zioon 配置只保存文件路径；公开设置不能存 credential/token/password/API key 等字段。

```sh
zioon extensions configure listing-id --node node-id --credentials-file /absolute/private/connection.json
zioon extensions configure listing-id --settings-file ./public-settings.json
```

激活 context 包含 `credentials`，handler context 包含 `env`。这些值在设备内读取，不进入制品或模型目录。HTTP MCP 要求凭据 endpoint 与声明完全一致，禁止重定向。模型插件必须自行固定上游地址并把取消信号传给 fetch。OAuth 等服务专属登录交互由插件实现；这版通用连接接口接收设备上的凭据引用。

## 数据、生命周期和后台任务

`context.data` 提供当前插件数据目录的读写；`context.state.namespace()` 提供持久键值。账户、安装、权限、版本与资源 epoch 对 Host 进程进行隔离；更新或恢复后重新绑定句柄，数据与 durable receipt 保留。

API 还包括：

- `context.context.registerProvider`：模型请求前的必要上下文。
- `context.runs.registerController`：Run、turn、模型与工具生命周期。
- `context.runs.registerPostProcessor`：回复完成后的持久后台处理。
- `context.jobs.registerHandler` / `enqueue`：后台任务和事件触发。
- `context.events.on` / `emit`：当前账户、当前插件的事件。
- `context.runs.registerCommands`：Workbench 命令经普通 Run 和统一工具记录调用。
- `context.models.registerProvider`：账户模型贡献。

必要上下文失败会阻止模型请求。完成状态与后台任务 intent 在同一事务中写入；消费者使用 claim、lease 和 generation fence。执行端 receipt 避免消费者恢复后重复副作用。结果不确定的非安全操作标记 `execution_outcome_unknown`，不盲目重试。

任务沿用来源 Run 的权限，权限过期时明确失败。运行、模型调用和后台任务持有工作区活动 lease，空闲后平台排空 Host 并休眠。静态界面、Skill 和声明的模型目录可在工作区休眠时读取。

## API 与运行约束

| 接口 | 用途 |
| --- | --- |
| `GET /v1/marketplace/snapshot` | 当前账户版本与安装 |
| `GET /v1/marketplace/connections` | 工作区与已配对设备选择 |
| `POST /v1/marketplace/private-releases` | 上传固定制品 |
| `POST /v1/marketplace/contributions` | 保存公开 Skill、代码或 MCP 制品草稿 |
| `POST /v1/marketplace/contributions/{id}/submit` | 提交固定内容审核 |
| `POST/PATCH/DELETE /v1/marketplace/installations/{id}` | 安装、启停、卸载 |
| `PUT /v1/marketplace/installations/{id}/config` | 配置与公开设置 |
| `GET /v1/marketplace/jobs` | 当前账户后台任务状态 |
| `GET/PUT/DELETE /v1/workbench-state/plugin-development/...` | 开发注册与不可变构建 |
| `GET /v1/models` | 包含账户插件的模型目录 |

制品包含 UTF-8 JavaScript 与文本资源，最多 64 个文件、200KB；Runtime 开发构建含元数据最多 190KB，预留发布包开销。第三方依赖需 bundle。依赖图使用 JavaScript 语法解析，源码不能通过符号链接读取项目外文件。

MCP stdio 与 Streamable HTTP 共用安装路径，SDK 依赖自动准备。共享 Connector Node 的 stdio 服务必须是制品中的 Node JavaScript 入口，并使用独立文件与进程权限；其他可执行程序需账户独立工作区。代码插件使用 Node permission 与冻结的内置对象；Host 校验每个协议帧的序号与签名，并在父进程过滤凭据。执行 Node 需要 Node 22.5+。

生产必须配置 `ZION_ARTIFACT_STORE=oss` 和 OSS endpoint、bucket、访问凭据；不自动退回数据库或 ECS 本地磁盘。数据库只保留引用和元数据。`ZION_ARTIFACT_STORE=local` 仅可在显式 development 模式使用。当前 invocation fence 与工作区活动 lease 按单 Runtime 实例运行；多实例发布需要扩展 transactional invocation claim。

类型定义见 `packages/plugin-sdk/src/runtime.d.mts`，Host 合约见 `packages/plugin-sdk/src/host-contract.mjs`。ByteIntl 的独立账户制品通过 `npm run plugin:package:account-byteintl-model -- --out <new-file.json>` 构建。
