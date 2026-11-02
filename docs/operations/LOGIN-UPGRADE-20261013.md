# Zion 登录升级

工作目录：`.worktrees/core-observability`，分支 `feature/core-observability`。
参考实现：`agent-device-cloud/apps/control-plane/src/auth.ts` 和
`agent-device-cloud/apps/console/src/auth-ui.tsx`。

本次保留现有 OIDC issuer、client、邮箱 subject 和账户数据关联，升级当前独立身份服务：

- 邮箱注册、真实邮件验证码、重新发送及找回密码。
- 生产页面不再显示验证码；开发模式必须显式开启。
- GitHub OAuth 通过经过验证的邮箱创建身份。已有邮箱账户必须先登录后关联，
  不自动合并账户。
- 会话、授权事务、一次性授权码、设备流程、GitHub state 和签名密钥均存入 PostgreSQL，
  服务重启不再清空登录状态。
- 密码重置撤销身份服务及同库 Runtime 的登录会话。
- 注册及新密码为 12–128 字符，现有密码仍可登录。
- 账号页面增加登录方式管理入口；身份页支持浅色、深色和移动端。

新增配置见 `deploy/systemd/runtime.env.example`：
`ZION_SMTP_URL`、`ZION_SMTP_FROM`、`ZION_GITHUB_CLIENT_ID`、
`ZION_GITHUB_CLIENT_SECRET`、`ZION_GITHUB_CALLBACK_URL`、
`ZION_IDENTITY_DEVELOPMENT`。值仅存于服务器环境文件。

当前部署复用 ADC 邮件通道和 GitHub OAuth App。该 App 仍使用 ADC 回调地址，
Caddy 仅将 `/api/auth/callback/github?state=zion_*` 分流回 Zion；
其他请求继续进入 ADC。Zion 验证自己的 state 与浏览器 Cookie。
日后更换独立 OAuth App 时，可删除该分流并把 callback URL 设为
`https://<zion-origin>/idp/github/callback`。

验证：真实 PostgreSQL 和 HTTP 集成测试覆盖注册、投递内容隐私、重发限频、
密码重置、会话撤销、重启后会话和 JWKS 保持、PKCE、GitHub 浏览器绑定、
未验证 GitHub 邮箱拒绝、state 重放拒绝及账号客户端端到端流程。
GitHub 实际授权需要用户本人完成；上线检查仅验证跳转地址、回调分流及
未授权回调拒绝。SMTP 启动检查会验证连接和凭据，实际收信由用户注册验证。

代码备份：`/var/lib/zion-next/backups/auth-complete-20261013`。
网关及环境备份：`/var/lib/zion-next/backups/auth-complete-20261013-config`。
回滚时恢复这两个目录内对应文件并重启身份服务、reload Caddy。
新增数据库表可保留，旧版本不读取；已有账号表没有 destructive migration。

后续修正：真实 ECS 请求 `github.com/login/oauth/access_token` 连接超时，
`api.github.com` 可达。仅验证授权跳转不足以证明 GitHub 登录可用。
没有部署 n37 专用隧道；相关草稿代码已删除。身份服务使用 Undici
`EnvHttpProxyAgent`，遵循标准 `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY`，
仅身份服务需要代理时可在该 systemd unit 的 EnvironmentFile 中配置。
当前尚无可用代理出口，GitHub 实际登录仍受网络阻塞。

`auth-modern-20261013` 统一登录、注册、验证、重置和登录方式管理页的字号、
控件、留白及深浅主题，增加密码显示、提交反馈、返回恢复和重发倒计时。
关联操作绑定发起时的已登录身份，邮箱不一致不会创建另一个账户。
授权失败与成功返回登录方式页面，并显示具体提示。
