# 账号与 Space 部署

**只想在本地从注册开始体验？请看 [本地体验步骤](LOCAL-TRYOUT.md)。**
下面主要面向部署配置；自动登录虚构账号的 fixture 不包含真实注册。

本目录中的双 Space 启动器用于本地 PostgreSQL 验收。生产仍采用一个 Runtime
进程绑定一个 `ZION_SPACE_ID`，但账号与 Runtime 权威数据统一存入 PostgreSQL。
所有模式都要求 PostgreSQL。账号产品语义是 account-first：每个用户先拥有
个人 Space，再按需创建或加入团队 Space。

PostgreSQL 全量数据导入、校验、切流和回滚步骤见
[PostgreSQL 全量迁移](../../docs/operations/POSTGRES-ACCOUNT-MIGRATION.md)。

## 1. 配置 OIDC

推荐使用托管或自行维护的 ZITADEL，复用它的账号、MFA、恢复与登录策略。
Zion 使用 `openid-client` 处理 OIDC，不保管用户密码。

在 ZITADEL Project 中创建 OIDC 应用：

- 启用 Authorization Code、PKCE S256 和 Device Authorization grant。
- 本实现默认使用 public client（token endpoint authentication method 为
  `none`），所有 code flow 都有 PKCE。也支持 `client_secret_post`，
  对应 `ZION_OIDC_CLIENT_SECRET`；不要把 secret 写到前端或配置样例。
- 精确登记回调：
  `https://team-a.zion.example.com/v1/account/callback`；
  第二空间另建应用或增加
  `https://team-b.zion.example.com/v1/account/callback`。
  浏览器和 Mobile 共用这一回调，登录后会返回原页面。
- scopes 为 `openid profile email`。确认 discovery 中包含
  `device_authorization_endpoint`，否则 CLI 登录会明确报不支持。
- `issuer` 必须与 discovery 的 issuer 完全一致；
  `ownerSubject` 使用该应用下已验证的 ID token `sub`，不要用邮箱代替。
  pairwise subject 提供方尤其需要使用应用实际发出的 sub。

参考：
https://zitadel.com/docs/guides/integrate/login/oidc/oauth-recommended-flows
https://zitadel.com/docs/guides/integrate/login/oidc/device-authorization

不要求另建“API audience”。可选的 RFC 9068 `at+jwt` token exchange 是
独立入口，需要显式配置 `ZION_OIDC_API_AUDIENCE` / `ZION_OIDC_API_SCOPE`，
并确认提供方实际发出该格式的 token。默认 CLI 通过 Runtime Device flow
获取 Runtime 会话凭证，不直接把 IdP token 当作 API 凭证。

## 2. 本地启动两个 PostgreSQL Space

需要 Node.js 22.18+、npm 和 ripgrep。先在仓库根目录构建：

```sh
npm ci
npm run runtime:build
npm run build:all
cp deploy/accounts/space-a.example.json deploy/accounts/space-a.local.json
cp deploy/accounts/space-b.example.json deploy/accounts/space-b.local.json
```

编辑两份 local.json，填写真实域名、issuer、clientId、ownerSubject。
dataDirectory 相对于配置文件解析；两份样例使用独立数据目录与端口。
同时设置 `ZION_DATABASE_URL`，两个 Runtime 可连接同一 PostgreSQL 集群，
所有业务表通过 `space_id` 隔离。
然后为每个空间绑定首次 Owner：

```sh
node deploy/accounts/start-space.mjs deploy/accounts/space-a.local.json bootstrap
node deploy/accounts/start-space.mjs deploy/accounts/space-b.local.json bootstrap
```

分别在两个终端/服务单元中启动：

```sh
node deploy/accounts/start-space.mjs deploy/accounts/space-a.local.json
```

```sh
node deploy/accounts/start-space.mjs deploy/accounts/space-b.local.json
```

启动器默认使用 Echo 引擎供验收。接入真实模型时，在每个服务单元分别设置
`ZION_RUNTIME_ENGINE=openai`、`ZION_RUNTIME_MODEL_URL`、
`ZION_RUNTIME_MODEL_ID` 及 `ZION_RUNTIME_API_KEY`，或使用 Runtime 模型设置。

TLS 反向代理分别转发至 127.0.0.1:8866 / 8867，保留 Host/Origin，
支持 WebSocket Upgrade 和 SSE 流式响应，关闭 SSE 缓冲；
公开地址必须与 publicUrl 一致。每个 Space 使用独立主机名：Cookie 不区分
端口，生产不能依赖同主机不同端口隔离浏览器身份。

例如已有 Caddy 实例可配置：

```caddyfile
team-a.zion.example.com {
  reverse_proxy 127.0.0.1:8866
}
team-b.zion.example.com {
  reverse_proxy 127.0.0.1:8867
}
```

这是路由/数据目录分离示例。生产中为两个 Runtime 配置不同 OS 用户或独立
服务容器，每个只可读写自己的 dataDirectory、模型凭证与插件数据。
不向任意插件开放控制面权限；同进程插件仍属于可信代码。
样例不自动连接 Resource Host、不加载外部插件、不导入旧 local-tools 状态，
也不允许账号执行宿主机工具。需要 Resource 时，为每个 Space 使用独立
节点、目录与凭证，显式开启 `ZION_ACCOUNT_ALLOW_RESOURCE_EXECUTION=1`
并配置 Resource 本地权限；启动器故意固定关闭此开关，需要在审核后的
服务配置中直接启动 Runtime。普通成员始终不能执行任意 Resource 工具。

## 3. 浏览器、Mobile、CLI

- 桌面访问 `/`，手机访问 `/mobile/`，账号管理访问 `/account`。
- 所有者在账号页生成邀请链接，成员用自己的账号登录后接受。
  链接只显示一次且默认一天过期，不会自动发送给别人。
- 角色：所有者、管理员、成员、访客。空间数据共享，访客只读。
- 账号页可以撤销单个登录、管理成员角色、撤销单次 Run/后台任务授权。
  最后一个所有者不能移除。移除成员也会撤销其现有授权。
- Scheduler/Project 自动化配置保存时创建至多 30 天的授权。到期或撤销后
  需由有权管理员重新保存配置授权；不会静默续期或用浏览器 Cookie 执行。
- PWA 的 Service Worker 不缓存认证导航和 API；部署后须让已有 PWA
  更新到新 Service Worker，再测试登录。

CLI 配置 `~/.zion-next/cli.json`：

```json
{
  "version": 1,
  "defaultProfile": "team-a",
  "profiles": {
    "team-a": {
      "url": "https://team-a.zion.example.com",
      "auth": { "type": "account" }
    },
    "team-b": {
      "url": "https://team-b.zion.example.com",
      "auth": { "type": "account" }
    }
  }
}
```

```sh
npm run runtime:cli -- auth login team-a
npm run runtime:cli -- auth status team-a
npm run runtime:cli -- session list --runtime-profile team-a
npm run runtime:cli -- chat --runtime-profile team-a
npm run runtime:cli -- auth logout team-a
```

无 profile 时使用 `--account --url https://...`，登录和后续命令都带这两个
参数。认证 profile 不允许通过 `--url` 改到另一 origin。
macOS 复用 Keychain，按 Runtime origin 存凭证，不打印 token。
非 macOS 目前复用原有 bearer env / workload token-file 接口，尚无交互式
OS credential-store adapter；不要把 token 写入 CLI JSON。Logout 会撤销
服务端会话后删除 Keychain 条目；网络不可用时保留凭证供重试。
浏览器凭证只在 HttpOnly Cookie 中，不存 localStorage。

## 4. 模型观测查询

PostgreSQL 账号模式把脱敏字段白名单写入同库的
`obs_runs`、`obs_events`、`obs_stages`，并以强制 RLS 固定到当前 Space。
Run Event 到达后使用内存 debounce 批量追赶；空闲时不轮询。

`run-diagnostics` Skill 指导模型使用两个 Runtime 事实接口：

- `observabilityQuery`：查询 `obs_runs`、`obs_events` 和 `obs_stages`；
- `observabilityRawRead`：按 Run 和事件序号读取必要的原始工具证据。

SQL 只允许单条 `SELECT` / `WITH ... SELECT`，并限制时间、返回行数和输出
字节。PostgreSQL 查询使用只读事务和 Space RLS，且拒绝
`SUPERUSER` / `BYPASSRLS` 连接角色。原始证据强制脱敏并记录账号审计。
两种调用都会重新验证当前 Run grant、成员状态和
`observability.read`。

默认保留 7 天、数据库上限 256 MiB。可按部署规模设置：

```text
ZION_OBSERVABILITY_RETENTION_DAYS
ZION_OBSERVABILITY_MAX_BYTES
ZION_OBSERVABILITY_DEBOUNCE_MS
ZION_OBSERVABILITY_QUERY_TIMEOUT_MS
ZION_OBSERVABILITY_QUERY_MAX_ROWS
ZION_OBSERVABILITY_QUERY_MAX_BYTES
```

该路径不要求 Docker、ripgrep 或宿主 Shell。旧 JSONL/容器实现仅保留为源码
回滚资产，不是账号 Runtime 的默认部署组成。

模型流式输出不逐 delta 写入 PostgreSQL。Workbench 继续按约 40 ms 更新，
SSE 使用每 50 ms 或 256 字符一个 live chunk。活跃 Run 的重连数据只保留在
有界内存中；重连时缺失内容按阶段快速补齐，Run 结束 30 秒后释放。完整结果
由 transcript、`message.completed` 和 Run output 持久化。

`message.delta` / `reasoning.delta` 不作为权威持久事实保留。

## 5. 本地验收与实际验证范围

无需真实 IdP 的临时验收（fixture 只监听 loopback，所有身份为虚构测试身份）：

```sh
cd apps/runtime
npx vitest run tests/account-clients.e2e.test.js
cd ../..
node scripts/preview-account-fixture.mjs
```

预览命令打印桌面和 Mobile 地址，Ctrl-C 清理临时数据库。
可加 `--viewer` / `--member` 验证不同角色。先等 `build:all` 完成再启动预览，
Runtime 启动时确定 Mobile 挂载，构建中清空 dist 可能让它暂时无法发现 Mobile。
该 IdP 自动批准虚构身份，不能用于任何真实用户或生产数据。

端到端测试启动真实签名 OIDC fixture 和两个独立 Runtime 子进程，覆盖：
Code + PKCE 浏览器回调、Mobile returnTo、CLI Device flow、聊天与 Run、
不同登录单独退出、Space 跨库/跨 Cookie 拒绝、邀请、只读与移除成员、
grant 查询和撤销。另有 Yjs/流/执行层/投影专项集成测试。

真实容器测试：

```sh
cd apps/runtime
ZION_TEST_ANALYSIS_DOCKER_HOST=unix:///var/run/docker.sock \
  npx vitest run tests/account-analysis.integration.test.js
```

开发机目前只有 Docker CLI，无 daemon，因此该真实容器用例未运行；
其他快照、子进程、路由拒绝、输出限额与撤销测试已运行。
真实 ZITADEL 注册、生产 TLS/反向代理、跨主机部署和数据迁移尚未执行。
