# zioon.tech 正式域名切换

## 实测现状

- 用户确认 ICP 备案审核通过。
- `runtime.zioon.tech` A 记录指向 `47.101.150.8`；HTTPS 证书验证通过；首页和 `/health` HTTP200。
- `adc.zioon.tech` 首页和 `/health` HTTP200，是独立设备管理控制台。
- `zioon.tech` 与 `www.zioon.tech` 暂无 A/AAAA 记录。
- Caddy 已有 runtime/adc 两个正式域名站点，保留 nip.io/sslip.io 临时入口。
- Runtime canonical origin 已切换为 `https://runtime.zioon.tech`，OIDC issuer 为 `https://runtime.zioon.tech/idp`。
- `/v1/account/login` 登录跳转和 Runtime callback 均使用正式域名。

## 建议地址

| 用途 | 地址 |
|---|---|
| Workbench 与 Runtime | https://runtime.zioon.tech |
| 移动 Workbench | https://runtime.zioon.tech/mobile/ |
| 设备管理控制台 | https://adc.zioon.tech |
| 品牌主入口 | https://zioon.tech，确定目标后设置跳转或首页 |

两个子域名已启用，主域名按用户要求暂不处理。无需迁移数据库或改变 n37 模型隧道。

## Runtime 切换实施顺序

1. 备份 `/etc/zion-next/runtime.env`、Caddy 配置、身份服务配置；记录当前服务状态与活跃 Run。
2. 将 `ZION_RUNTIME_PUBLIC_URL` 改为 `https://runtime.zioon.tech`。
3. 将 `ZION_OIDC_ISSUER` 改为 `https://runtime.zioon.tech/idp`。保留旧 allowed origins，正式域名已在列表中。
4. 核对身份服务启动时使用的 issuer/callback、GitHub OAuth App 实际 callback、ADC 的共享 GitHub callback 桥接及 `ADC_PUBLIC_URL`。不得只替换 Runtime URL 就宣告 OAuth 完成。
5. 选择空闲窗口重启使用这些环境值的 Runtime/身份服务，按需要 reload Caddy。已有流式 Run、WebSocket 和 SSE 可能短暂断开。
6. 检查新入口首页、移动入口、health；匿名业务接口401；登录302 的 issuer 与 callback 使用正式域名；完成一次真实登录和模型请求；检查会话和 Node 连通。
7. Connector 旧临时地址保留可用，随后逐台迁移到新地址。Node 凭据/Keychain/已配对记录可能按 origin 分组，应遵循已有 origin 迁移流程，不能仅替换字符串或重新配对全部节点。
8. 新域名 Cookie、localStorage、IndexedDB、Service Worker 与旧域名隔离，用户需在新入口重新登录；服务端会话数据库不变。确认旧页面没有未同步输入。
9. 旧入口兼容期内保持服务；不要把 Connector API/WebSocket 的旧 URL 全部强制重定向。验收后迁移默认文档、安装脚本及下载配置。
10. 回滚：恢复备份环境值并重启对应服务，继续使用原 nip.io 地址；不涉及数据回滚。

## 主域名

确定主域名用途后，可在阿里云 DNS 添加 `@` 和 `www` A 记录到 `47.101.150.8`，初期 TTL600。Caddy 添加对应 HTTPS 站点，自动签发证书。跳转目标应显式选为 Workbench 或控制台。

## 备案通过后的事项

- 官网/首页底部展示实际 ICP 备案号并链接 `https://beian.miit.gov.cn/`；不得编造备案号。
- 按阿里云官方说明，网站开通之日起30日内在 `https://beian.mps.gov.cn/#/` 提交公安联网备案，审核后添加公安备案号与链接。
- 如果备案接入商不是当前阿里云接入，需要核对是否完成阿里云接入备案；备案通过后是否已解除拦截以实际访问为准，本次 runtime/adc 已可访问。
- 后续监控正式域名 TLS、HTTPS/登录/模型可用性，并保持域名和证书续期。对外业务范围、备案主体与实际服务内容应按实际情况维护。

参考：

- https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/icp-filing-application-overview
- https://help.aliyun.com/zh/icp-filing/basic-icp-service/the-public-security-network-for-record-and-cancellation

## 本次实施结果

- 修改生产共享环境 `/etc/zion-next/runtime.env` 中的 `ZION_RUNTIME_PUBLIC_URL` 与 `ZION_OIDC_ISSUER`，重启身份服务与 Runtime。
- Caddy 旧 ADC 的 `zion_` GitHub 回调桥接已改为正式 Runtime。`ZION_GITHUB_CALLBACK_URL` 保留已登记的 `https://adc.47-101-150-8.nip.io:8443/api/auth/callback/github`，避免未经 OAuth App 配置变更就替换外部回调。
- 两个已登录账户在新旧 issuer 下的 subject 和 user ID 完全一致，原工作空间和角色保持；未修改账户映射。
- Mac Connector 复制有效 Keychain 凭据到正式 origin，保留旧凭据；更新 LaunchAgent 并重启。
- n37 原凭据已过期、Connector 启动失败。本次仅替换该过期设备凭据，保持 `node:n37-036-207` 和项目资源 ID，写入正式 origin 凭据，更新 watchdog 并启动。
- 生产配置回滚备份：`/var/backups/zion-domain-20261014-170122/`。恢复该目录内 `runtime.env` 与 `Caddyfile`，重启身份服务与 Runtime，reload Caddy 即可恢复旧配置。设备地址回滚需同时恢复各机的启动配置及有效凭据；n37 的旧过期凭据不可用于恢复连接。
- Mac 与 n37 启动文件及凭据文件/旧 Keychain 条目已保留；节点安装脚本默认地址、n37 watchdog 源文件和生产部署健康检查默认地址已更新。
- Runtime 冷启动约26秒，健康检查需等待就绪，不能将 systemd `active` 直接作为 HTTP 可用的证据。

验收使用直接 HTTP/代码检查，没有浏览器操作。以原账户的短期身份 session 完成真实 OIDC HTTP 授权、PKCE、令牌交换、签名验证与 Runtime 账户恢复，测试 session 随后撤销。该验证不等于人工输入邮箱密码或完成 GitHub 外部授权；外部 GitHub callback 桥接已单独检查。

最终验收：正式/旧 Runtime 与正式 ADC `/health` 均200；新旧入口的受保护设备接口均200且 Mac/n37 在线；匿名设备接口401；GitHub 桥接303 到正式身份服务；使用 Runtime 模型配置和凭据请求 `gpt-5.6-sol` 返回200、有效文本，耗时2226ms。

DNS 未修改。旧 nip.io API 继续直接服务，未全局重定向；其他尚未迁移的节点可继续连接旧入口。新域名需要重新登录，原服务端会话和资源保留。

## 登录事务修复

用户反馈输入账号密码后出现 `invalid_login_transaction`。直接使用具备域名 Cookie 隔离的 HTTP CookieJar 复现：旧入口 `/v1/account/login` 设置的 `__Host-zion_login` 属于 nip.io，但 issuer 与 callback 属于 `runtime.zioon.tech`，回调无法收到该 Cookie。此前的正式入口验收没有覆盖旧入口发起登录。

修复 `AccountAccessControl.handleHttp`：HTTPS 别名与开发 loopback 一样，在创建事务之前将登录 GET307 到 canonical origin；非 canonical callback GET303 重新发起正式入口登录，不消费错误域名的事务。仅调整两个登录端点，旧 API 与 Connector 服务保持兼容。

生产已应用并重启；源码备份 `/var/backups/zion-login-origin-20261013T171318/account-access-control.mjs`。验证：新旧入口 CookieJar 均只在正式域名得到登录 Cookie；旧入口开始的完整 OIDC/PKCE/签名/账户恢复通过，Mac/n37 在线，模型200；本地19项现有身份与授权检查通过，额外直接验证 HTTPS 别名登录/旧 callback 不创建或消费事务。

已经打开的旧登录页/回调无法补回缺失 Cookie；应重新从 `https://runtime.zioon.tech/v1/account/login` 开始，不能刷新已有带 code/state 的错误回调 URL。

## 表单提交来源修复

后续反馈“请求失败 / 请从 Zion 登录页重新操作”定位到身份服务 POST Origin 检查，发生在密码校验之前。正式站点 Caddy 强制 `Referrer-Policy: no-referrer`，会使浏览器原生 POST 导航的 Origin 序列化为 `null`；身份服务拒绝该来源。直接 HTTP 重现 null Origin403、正式 Origin401（测试无效密码），确认拒绝阶段。

身份 HTML 显式返回 `Referrer-Policy: same-origin`，Caddy 正式站点的 Referrer-Policy 改为缺省设置 `?Referrer-Policy "no-referrer"`，尊重上游身份页的策略。跨域及 null Origin 拒绝规则保持。生产身份服务重启、Caddy reload；备份 `/var/backups/zion-login-form-20261013T172157/`。本地10项身份/OIDC检查通过，包含实际密码表单登录；线上登录与找回密码页只返回 same-origin 策略。同域表单进入密码校验，跨域来源仍403。

原邮箱账号已验证、active，正式/旧 issuer 均对应原 user ID 与生产 owner 权限；本次未改密码。旧打开页面仍带旧策略，需重新进入登录入口。
