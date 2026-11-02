# 扩展市场本地体验

日期：2026-10-24。分支：`feature/extension-marketplace`。

工作目录：`/Users/bytedance/Downloads/zion-next/.worktrees/extension-marketplace`。

## 打开

工作台市场：<http://127.0.0.1:18866/?marketplace=1>。

第一次先用 `marketplace@example.test` 在本地注册，密码自行设置：

<http://127.0.0.1:18080/register?email=marketplace%40example.test&return_to=http%3A%2F%2F127.0.0.1%3A18866%2Fv1%2Faccount%2Flogin%3FreturnTo%3D%2F%3Fmarketplace%3D1>

页面会直接显示本地验证码。此账号和线上账号相互独立。该轻量本地 Runtime 服务这个测试账号的 Space；其他测试账号需要加入同一 Space。共享 Space 内的扩展安装仍按账户隔离。

登录后可从“插件”侧栏的“扩展市场”进入，也可用命令 `zion.marketplace.show`。

## 已完成

- 7 个精选条目：4 个独立 Skill、2 个套件、1 个 GitHub MCP 配方。
- 搜索、类型与用途筛选、组件内容、发布者、来源与版本详情。
- PostgreSQL 账户安装、启停、卸载、已发布版本切换，内容摘要与旧客户端 revision 检查。
- 安装的 Skill 在现有技能 HTTP 目录、Runtime 上下文和 `skillsList` 中可见；个人安装不会写入共享 Space 的技能快照。
- 文档套件复用 PluginManager 启用内置目录插件；卸载恢复浏览器之前的状态。
- 贡献保存、修改草稿、提交审核；审核发布不可变版本。审核需明确配置的 reviewer，普通个人账户 owner 不自动获得市场审核权。
- `zion` / `zioon extensions` 离线创建、校验、打包纯 Skill，上传账户私有版本并安装、启停、查看、切换与卸载；市场“我的开发”仅显示自己的私有版本。
- 私有 SDK runtime API 2 工具插件与 MCP stdio/Streamable HTTP 制品的打包、上传和安装；CLI/市场配置执行 Node、准备 MCP SDK、验证实际工具并通过普通 Run 调用。MCP 凭据只保存执行端文件引用，HTTP 连接禁止重定向。

完整命令示例：[Skill、代码插件与 MCP 开发使用](file:///Users/bytedance/Downloads/zion-next/ZION-CLI-EXTENSIONS-USAGE-20261024.md)。

官方 GitHub MCP 条目仍为配置说明，未包含可执行制品。个人可上传自己的 MCP 制品，配置授权设备与本地凭据后使用。公开贡献首版仍只接受 SKILL.md；私有代码插件只支持工具 API，其他 SDK hooks 和浏览器界面需要后续宿主适配。市场安装不新增工具或执行目标权限。

本地脚本保持 `ZION_ACCOUNT_ALLOW_RESOURCE_EXECUTION=0`。执行需先为测试账户绑定并授权实体设备或账户沙箱，再配置资源执行及 Run 的 `trusted-automation`、`write`、`Bash`、`extensionsCall`。平台 ECS 始终不是用户执行目标。当前私有执行宿主接受 POSIX 绝对目录；Windows 路径还未适配。

本地使用 echo 测试引擎，不调用生产模型。此环境可验证市场与账户 API、安装状态和技能读取，聊天不会生成真实模型回答。

## 重启与停止

```sh
cd /Users/bytedance/Downloads/zion-next/.worktrees/extension-marketplace
npm run marketplace:local
```

缺构建产物时先运行：

```sh
npm run runtime:build
npm run build:all
```

`Ctrl-C` 停止账号服务和 Runtime，数据保留在 `.marketplace-local`，目录已加入 `.gitignore`。独立 PostgreSQL 监听 `127.0.0.1:55439`，数据库名 `zion_marketplace`。脚本会验证实例数据目录，拒绝使用其他实例占用的同一端口。

此机器复用 core-observability 已安装的 PostgreSQL 二进制，只在当前 worktree 初始化独立数据库。其他环境可设置 `ZION_MARKETPLACE_POSTGRES_BIN` 为 PostgreSQL `bin` 目录。

停止独立数据库：

```sh
/Users/bytedance/Downloads/zion-next/.worktrees/core-observability/.account-data/postgres/toolchain/bin/pg_ctl -D /Users/bytedance/Downloads/zion-next/.worktrees/extension-marketplace/.marketplace-local/postgres stop
```

审核人员由 `ZION_MARKETPLACE_REVIEWER_IDS`（逗号分隔的账户 user ID）配置。审核人不能发布自己的贡献。此版本没有自动发布或部署步骤。

## 验证

最新代码/MCP 集成：52 项 Runtime/CLI/账户回归与 6 项市场 DOM 集成通过，Workbench/Mobile 构建通过。9 项执行集成实际运行 Node 子进程中的 SDK 插件、stdio MCP 和 HTTP MCP fixture，覆盖回执、结果不确定后的重复阻止、配置变更取消、凭据脱敏、HTTP 重定向拒绝与撤权。fixture 通过 NodeBroker 分发；没有调用生产 Node 或云沙箱。

此前首版 96 项；Skill CLI 集成后的 127 项通过：

- Marketplace PostgreSQL/HTTP/Runtime 集成 6 项。
- 现有 Skills HTTP 7 项、账户访问控制 9 项。
- 市场 DOM 交互 5 项、技能状态 27 项、插件详情 7 项、PluginManager 15 项。
- Runtime 插件服务 10 项、控制面 HTTP 11 项。
- 私有 Skill CLI/HTTP/Runtime 4 项、命令子进程与安装器 4 项。
- Chat CLI 15 项、OAuth 3 项、CLI Runtime 3 项、账号登录隔离端到端 1 项。

账号集成文件中的 deployment launcher 场景未计入本轮通过数：继承的 `start-space.mjs` 没有转发 Memory bridge 配置，导致 dev.identity 启动失败。独立市场网站与生产部署前需单独修复部署配置。本轮没有宣称整个仓库的全量测试通过。

真实本地 HTTP smoke：Workbench 200；7 个市场条目；安装后 Skill 正文可读取；同 Space 另一账户看不到该 Skill；卸载成功。Runtime TypeScript、Workbench 和 mobile 构建通过。未使用浏览器自动化；没有对外部署或生产调用。

重新执行相关测试：

```sh
cd apps/runtime
ZION_TEST_POSTGRES_URL=postgresql://zion@127.0.0.1:55439/zion_marketplace npm exec -- vitest run tests/marketplace.integration.test.js tests/skills-catalog-http-handler.test.js tests/account-access-control.test.js tests/runtime-plugin-service.test.js tests/runtime-control-plane-http.test.js
ZION_TEST_POSTGRES_URL=postgresql://zion@127.0.0.1:55439/zion_marketplace npm exec -- vitest run tests/extensions-cli.integration.test.js tests/cli-entry.integration.test.js tests/chat-cli.test.js tests/oauth-device-flow.test.js tests/runtime-cli-e2e.test.js
cd ../..
npm exec -- vitest run tests/marketplace-ui.integration.test.js tests/skills-runtime-state.test.js tests/plugin-details.test.js tests/plugin-manager-state.test.ts
```

当前基线源码快照共有 260 项，复制后校验源工作区仍一致。基线 provenance 在 `.marketplace-local/baseline.json`。顺带补齐了基线 `dev.goal` 缺失的中英文 features 元数据，使现有插件详情回归通过。
