# Zioon Memory 首版发布

> 这是历史账户迁移工具。日常产品发布改用私有 `zioon-tech/infra`。
> Memory 源码现位于独立 `zioon-tech/memory`；此工具通过
> `ZIOON_MEMORY_REPOSITORY` 读取其检出目录，默认使用相邻 `../memory`。

入口：`https://memory.zioon.tech`；文档 `/docs`，控制台 `/console`，登录 `/account/login`。
首页、文档、控制台与登录页使用同一套深色样式，用户界面仅呈现 Memory。

本版独立发布 Memory。账号后端复用现有 ADC BetterAuth 用户与会话，
新增账号接口使用 `https://auth.zioon.tech`。Memory 自己提供邮箱登录、
注册、GitHub 登录入口与 CLI 验证页面。邮箱密码仅在服务端请求中交给
现有账号系统，不保存到 Memory；GitHub 使用现有注册回调与原生 OAuth
state/cookies，随后以授权码、PKCE、nonce 换取 Memory 会话。
注册开关和 GitHub 可用性跟随已有账号配置。

不切换 Workbench issuer、不修改 Runtime 源码或环境、不停止旧身份服务。
账号桥挂在现有 ADC 进程，网站挂在现有 `zion-memory` 进程，
无需新增系统服务。保留现有 agent-fs 0.18.5、本地存储、端口、
Runtime Memory API 与 GitHub 回调桥。本版没有 OSS 迁移。

## 控制台

浏览目录、按文件内容搜索、新建文件、编辑与下载原文、查看版本历史。
保存检查内容 hash；并发修改返回冲突，保留编辑草稿。
浏览器仅持有 HttpOnly host-only 随机会话；访问凭据加密存放在服务端，
修改操作检查同源请求与 CSRF，所有文件接口保持账户隔离。

CLI 登录使用 Memory 的 `/v1/account/device/start` 和 `device/poll`，
用户在 Memory 页面确认验证码。成功后 `agent-fs` 将凭据、地址和
默认 drive 存入 `~/.agent-fs/config.json`。继续支持既有 Runtime 登录凭据。

## 本地构建与验证

以下 Memory 验证在独立 Memory 工作树运行；bundle 命令在 Zioon 工作树运行：

```sh
ZIOON_ACCOUNT_TEST_DEPS_DIR=/ADC源码/apps/control-plane/node_modules \
  AGENT_FS_UPSTREAM_DIR=/agent-fs源码 \
  bun apps/memory-service/scripts/verify-portal.ts

AGENT_FS_UPSTREAM_DIR=/agent-fs源码 \
  bun apps/memory-service/scripts/verify.ts

node deploy/unified-accounts/build-bundle.mjs /tmp/zioon-memory-release
node /tmp/zioon-memory-release/patch-sources.mjs adc \
  /ADC源码副本 /tmp/zioon-memory-release check memory-only
tar -czf /tmp/zioon-memory-release.tgz -C /tmp/zioon-memory-release .
```

验证使用真实 PostgreSQL、BetterAuth、Bun Memory、授权码交换、
PKCE 和实际文件存储。GitHub 检查使用原生 OAuth 发起接口，验证
授权 URL、state cookie 与 callback 拒绝；完整 GitHub 用户授权须上线后验收。

发布包不包含 ADC 控制台构建、Runtime 补丁、账号配置、数据库、
云访问凭据或工作树其他改动。每个文件在 `manifest.json` 中记录 SHA-256。

`preview.html`、`docs-preview.html`、`login-preview.html`、
`console-preview.html`、`device-preview.html` 为相互链接的离线预览。
登录与控制台标注预览状态，不向远端发请求，不展示虚构的账户或文件。

## 权限与 DNS

两条 A 记录均指向 `47.101.150.8`：`memory.zioon.tech`、`auth.zioon.tech`。
需要本台 ECS 的 root SSH 或 ECS Cloud Assistant RunCommand。
`zion-worker` 不能修改 `/etc/caddy`、Memory 部署目录或系统服务。

将发布包解压到 `/opt/zioon-memory-release`，检查 `settings.json`。
部署脚本自动发现 ADC systemd 工作目录与环境文件；无法唯一发现时
需要填入实际值。环境文件按 KEY=value 解析，不能直接 source。

## 发布步骤

```sh
cd /opt/zioon-memory-release
node release.mjs preflight
node release.mjs prepare
```

`preflight` 只读检查文件 hash、账号桥源码形状、存储和 DNS。
`prepare`：

1. 创建私有代码备份，停止 Memory 后保存完整存储快照。
2. 安装 Memory 与账号桥，在 ECS 生成并保护 RSA 签名私钥。
3. 增加 Caddy import，保留现有其他域名及 GitHub 回调配置。
4. 仅重启 ADC 以载入账号桥，确认 HTTP 就绪后 reload Caddy。
5. 启动 Memory 后端，暂不开放网站，留出原记忆数据绑定窗口。

在保存了已有 ADC 与线上 Memory 会话的本地 zion-next 工作树执行：

```sh
node scripts/link-zioon-account.mjs
```

绑定需要证明两份有效会话，不能按邮箱自动合并。绑定只在 Memory
数据库保存不可变映射，检查原 drive/org 不变。不会修改 Runtime 身份。
已有记忆账户都应绑定后再开放网站；无已有数据时跳过此步。

```sh
node release.mjs activate
```

`activate` 检查原记忆绑定覆盖率，只设置 Memory 网站地址并重启 Memory。
验证网站、登录页、readiness 和未登录控制台的 401 响应。
发布过程中等待 HTTP 就绪，不以 systemd active 代替验证。

## 回滚

失败会恢复此次修改的文件、权限与相关服务状态。也可以执行：

```sh
node release.mjs rollback /opt/zioon-memory-release/settings.json \
  /var/backups/zioon-memory-releases/实际备份目录
```

保留最新记忆数据与新增绑定，避免抹掉部署后的写入。
备份中的 `memory-snapshot` 不会自动覆盖正在使用的数据库。

## Workbench 统一登录

Runtime 的 `/v1/account/login` 直接进入 ADC 的 `/login`，复用同一个
登录、注册、邮箱验证、GitHub 和密码找回界面。Runtime 继续保管浏览器绑定的
state、PKCE、nonce、账号会话和首次登录的 Sandbox 开通。旧
`/account/login` 与 `/v1/account/shared/login` 作为兼容入口，不再呈现独立密码表单。

ADC 已登录时显示当前姓名、邮箱、继续按钮和“使用其他账号”；取消地址和产品名称
由 `/api/v1/zioon/login-context` 校验精确注册的 callback 后提供。失败和过期回调
显示手动重试页面，重试产生新的浏览器绑定与交易，不自动循环。
注册、验证和重置密码的链接保留 `return_to`。

`adc-auth-ui-patch.mjs` 和 JSON 补丁保存 ADC `6fc4315` 生产源的精确变更，
应用前核对全部源文件哈希，并支持重复检查。升级 ADC 时应将相同改动合入新的
源文件并重新生成哈希；不匹配时拒绝应用。Memory-only 发布跳过此 UI 补丁。

客户端注册文件只包含公开的产品名、回调和 scope；保留服务用户的读取权限。
ADC 就绪检查使用实际部署端口（当前为 8788），Runtime 使用 8766；
以 HTTP 成功为准。更新 console dist 时保留旧哈希 assets，让已打开的页面继续加载。
ADC 在启动时读取 app shell，必须先换好 dist 再重启，随后核对公开 `/login`
所引用的脚本哈希，而不能只核对磁盘文件。
