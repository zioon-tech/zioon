# 扩展市场本地首版

当前本地原型视觉：复用 Workbench 的编辑区、字体、色彩与边界，以紧凑列表为主。最终市场采用独立网站；本原型用于验证账户、安装与开发链路。

内容：发现、已添加、我的开发、我的贡献四个视图；私有上传仅出现在自己的开发目录与安装记录中。先讲用途，再展示类型、发布者、版本、组件和准备状态。首版精选内容明确来源，不使用虚构下载量、评分或安全认证。

交互：搜索和分类直接过滤；详情展示内容与配置要求；添加、启停、卸载和切换已发布版本都有真实账户 API。贡献保存草稿、提交审核；提交不直接成为公开条目。

账户安装以 user ID 为键，PostgreSQL 是事实来源。不可变 release 带内容 SHA-256，安装事务采用账户行锁，revision 防止旧客户端覆盖新修改。共享 Space 不共享个人安装。

私有版本使用 `marketplace_private_releases`，主键为 `(user_id, listing_id, version)`；公开发布表保持独立。私有 ID 由服务端账户摘要与 slug 生成，客户端不能声明 owner 或官方发布者。只查询当前账户的私有制品；安装、切换版本与技能投影复用同一条账户链路。同一版本禁止不同内容，相同制品可重复上传；上传不自动安装或升级。

CLI 的 `extensions` 与 Workbench 市场使用 `packages/runtime-client/src/extensions.mjs` 的共享 API client。离线项目包括 Skill、SDK runtime API 2 工具插件、MCP stdio 或 Streamable HTTP 定义。JSON 制品按稳定字段顺序规范化并计算摘要，服务端重新校验。Node 专用的 `extension-package` 校验元数据、制品、路径与内容大小；原 `skill-package` 保持兼容，浏览器使用 `extensions`。

执行配置保存 Node ID、绝对工作目录和可选的执行端凭据文件引用。每次版本、配置或启停改变生成新的执行 epoch 并清除验证目录；probe 结果只在 epoch 未改变时提交。运行中持续检查 epoch，变化时取消子调用。HTTP 凭据绑定账户扩展 ID 和精确 endpoint，禁止重定向；stdio 只从本地文件读取声明的 envKeys，子进程不继承控制面凭据。

`ExtensionInvocationEngine` 将 CLI/市场操作作为普通 Run 的确定性工具调用处理，普通聊天继续交给原引擎。`extensionsCall` 通过 RuntimeToolBroker 对同 Run 的 staging write 和 Bash 子调用逐次授权、分发并保存回执。目标必须是已授权实体 Node 或该账户 Managed Node；平台 Node 与 Runtime 本机回退均拒绝。私有 JS 和不可信参数 schema 的实际校验在执行端子进程完成，Runtime 不 import 用户代码。

现有 Run 内的 invocation fence、deadline、取消和 unknown-outcome receipt 处理同样适用于扩展及子调用。取得旧回执前仍重查账户授权、安装启用状态及 epoch。MCP SDK 在显式 prepare 中安装，禁用 npm 生命周期脚本；stdio 服务每次调用后关闭，无后台连接残留。

`zion` / `zioon` 共用 CLI entry；Run 失败、打断、取消分别返回 1、2、130，JSONL 错误写 stderr。显式 URL 不使用默认端点的凭据；显式 profile 保留 origin 绑定。本地安装器保留 profiles，并只升级同仓库开发链接。

Skill 使用现有 Runtime 技能模型，以账户安装的动态目录覆盖读取结果；不把个人安装写入共享 Space 快照。Runtime 上下文和 skillsList 从已授权 Run 的 principal 解析账户，浏览器不得通过 transientCatalog 冒充市场安装。

公开精选目录仍以声明式 Skill、白名单内置 Workbench 组件和配置说明为主；官方 GitHub MCP 配方不包含可执行制品。个人私有上传支持代码工具插件和 MCP 制品，实际验证通过后显示可用。社区审核提交仍只接受 Skill。其他 SDK hooks、Workbench/renderer 界面、MCP resources/prompts、OAuth 自动授权和公开代码发行需后续适配。

本地目录：`.worktrees/extension-marketplace`，基于 sandbox-runtime-integration HEAD 08af0024 与当前源代码快照。原工作区不修改。`.marketplace-local/baseline.json` 记录复制来源与摘要；不复制部署配置、凭据、日志和线上数据。使用独立 PostgreSQL 数据库和本地账号服务，不注册域名或部署。
