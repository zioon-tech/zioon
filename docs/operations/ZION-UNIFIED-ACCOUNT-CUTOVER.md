# Zion 统一账号与 Memory 切换

Zion、Memory 与 CLI 共用 `https://auth.zioon.tech` 的账号后端。Zion 在自己的域名
提供邮箱、GitHub 与设备确认页面，服务端执行 PKCE、nonce 和签名校验；浏览器只获得
原有格式的 Runtime 会话。Runtime 用户 ID、Space、成员关系、会话、Run 和任务授权继续保留。

旧身份必须通过已经验证的原会话和统一账号身份显式绑定。`linkIdentity` 不按邮箱
自动合并，已绑定的 subject 和用户对应关系不可替换。已有 Runtime 会话继续有效；
新的统一登录会话绑定加密的账号 grant，重新验证上游状态，退出时撤销其 scoped grant。

正式配置：

```dotenv
ZIOON_ACCOUNT_ISSUER=https://auth.zioon.tech
ZIOON_ADC_ORIGIN=https://adc.zioon.tech
ZIOON_ACCOUNT_SESSION_KEY_FILE=/var/lib/zion-next/runtime/shared-account-session.key
ZION_OIDC_CLIENT_ID=zion-runtime
ZION_MEMORY_SERVICE_URL=https://memory.zioon.tech
ZION_MEMORY_PUBLIC_URL=https://memory.zioon.tech
ZION_MEMORY_MCP_ENABLED=0
ZION_MEMORY_BRIDGE_SECRET_FILE=/etc/zion-next/memory-bridge.key
```

会话加密密钥在第一次启动时以 `0600` 创建，后续启动复用；不能随发布覆盖。
账号服务注册精确的生产和固定本机回调。GitHub OAuth App 的登记回调继续使用原账号
后端地址，发布不修改外部登记或旧兼容路由。

本地现有账号配置可增加 `sharedAccountIssuer`、`adcOrigin`、`memoryServiceUrl`、
`memoryPublicUrl` 和 `memoryAccountConnectionsDir`。先备份数据库和数据目录，再显式
绑定现有用户；`scripts/local-accounts.mjs` 支持 `ZION_LOCAL_ACCOUNT_DIR` 和
`ZION_LOCAL_POSTGRES_ROOT` 复用现有目录。独立测试账户可以继续使用本机测试身份服务。

发布使用 `deploy/unified-accounts/build-runtime-bundle.mjs` 生成包含前后端、声明的
Runtime 依赖锁文件及实际安装的 Identity ZIP 的发布包。`release-runtime.mjs preflight`
验证文件哈希、`pg_dump` / `pg_restore` / `unzip` 和完整数据库备份权限，
在独立目录安装依赖。`apply` 停止两个写入服务，
保存 PostgreSQL、旧 Identity、Memory 元数据与对象版本，之后执行
`migrate-runtime-memory.ts`，并验证原用户与成员关系未改变。

完整 PostgreSQL 备份使用本机管理员连接，保留 FORCE RLS 策略。单个备份最多等待
十分钟，只有成功退出并完成 fsync 的快照才可继续迁移；失败时删除未完成的 dump，
恢复原服务。备份前应预留压缩快照、代码快照和新依赖所需的磁盘空间。

迁移按稳定 ID 合并事件与引用，通过原生 agent-fs FileOps 建立版本和搜索索引。
已有版本逐条核对不变；损坏 UTF-8 的原始字节保存为版本后再做最小修复。旧文件
快照永久保留为归档，切换后的 Identity 不再回退或写入它。失败时恢复代码和配置，
数据库快照不会自动覆盖切换后的新写入。

验证须覆盖真实账号后端的邮箱登录、PKCE、浏览器绑定、设备确认、会话持久化与撤销，
以及原账户 ID、Space、Memory drive、完整事件 ID、引用、文件版本、搜索和 HTTPS 健康。
仅 `systemd active` 不足以证明上线，必须等待 Runtime 与 Memory HTTP 就绪。

2026-10-23 已完成生产切换，Identity 版本为 `0.1.14`。42 个记忆文件、918 条事件和
242 条引用在线核验通过，迁移前的 26 个版本全部保留，切换后共 68 个版本。
网页登录、设备登录和已有会话共通过 181 项在线检查；桌面和移动入口的 HTML
哈希与发布包一致，云端 Connector 重启加载新版源码后确认在线。

本次完整数据库及文件备份保存在
`/var/backups/zion-unified-runtime/1792694720624`。停用的旧 SQLite 已完整压缩至
`/var/lib/zion-next/runtime.sqlite3.legacy-20260920.zst`，解压后逐字节哈希核对通过，
恢复元数据保存在同名 `.json` 文件。发布与迁移证据归档在
`artifacts/zion-unified-runtime-20261023`。涉及 Connector 源码更新的后续发布，
还应重启 `zion-cloud-device-connector.service` 并通过 `/v1/device-nodes` 核验在线状态。

同日修复了 Biography 面板的浏览器插件版本遗漏：Runtime 安装目录已升级，
但 Plugin Host 的下载目录仍登记 `0.1.10`，旧面板因此将 Memory 路径发送到本地文件接口。
浏览器发布包已补发为 `0.1.15`，通过实际下载哈希和身份、用户、摘要读取验证；
918 条事件和 242 条引用保持不变。`artifacts/zion-biography-fix-20261023` 保存修复证据。

后续发布必须同时更新 Runtime 安装目录和 Plugin Host 登记的 ZIP。发布包版本从实际
打包结果获取，不能写死版本号。`release-runtime.mjs` 在服务 HTTP 就绪后登记浏览器包，
验证下载内容，并在回滚时恢复之前的浏览器登记包；遇到独立的新发布时会保留该发布。
