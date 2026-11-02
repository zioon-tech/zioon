# 账号、执行授权与 Skill 观测工作区

日期：2026-09-18
状态：首版本地实现与验证完成；真实 IdP / 容器部署验证待环境就绪；尚未迁移生产数据
工作树：`feature/core-observability`

## 产品目标

用户通过账号登录 Workbench、Mobile 和 CLI。同一人的不同登录设备具有同一
用户身份。Runtime 在接受任务和执行工具时自动验证权限；模型不声明 userId、
角色或权限，也不接触认证凭证。

运行诊断以 `run-diagnostics` Skill、已有 Bash/read 工具和实际 JSONL 文件为
主要入口。查询脚本只是常用方法，模型可以自由组合授权数据。专用诊断 Tool
退出默认模型工具集，既有诊断 HTTP API 继续服务产品界面。

## 首版边界及依据

当前 Runtime 的 Workbench KV、模型凭证、插件实例、Yjs 文档、终端服务和
Scheduler 都是实例级状态。首版将一个 Runtime 固定绑定一个 Space，多个
账号通过 Membership 进入这个 Space。Space 内的数据明确为成员共享；
个人资料放在独立个人 Space。不同 Space 使用不同 Runtime、数据库、插件
数据目录和 Resource Host 执行环境。不同权限的用户不能通过共享 Bash
宿主机间接读取控制面数据。

数据库持久保存 Space 绑定，禁止将已绑定数据库换一个配置冒充另一 Space。
提供可重复启动的部署配置和双实例隔离验证。暂不实现共享进程内任意切换
租户、自动容器调度或项目级私密文档 ACL；这些能力不能靠请求中的 spaceId
或插件状态命名约定来模拟。

该选择复用已有单实例存储，避免一次重写所有业务表。将来共享 Control Plane
可按稳定 Space ID 路由到实例，账号与执行身份协议可以继续使用。

## 认证

- 采用标准 OpenID Connect，通过 `openid-client` 6.x 完成 discovery、
  Authorization Code + S256 PKCE、nonce/state 验证及 Device Authorization。
- ZITADEL 是推荐提供方，也允许兼容的 OIDC Provider；用户、Membership
  和资源 ID 不使用供应商 Organization ID。
- 外部身份按完整 `(issuer, subject)` 唯一映射内部 userId，邮箱仅作展示。
  不以同名、同邮箱或第一个公网登录者自动建立 Owner 关系。
- 首个 Owner 由服务器管理员的 bootstrap 命令预先指定 issuer/subject。
  现有数据归属该实例 Space，历史 Run 的未知发起者保持 legacy 标记，
  不伪造为新 Owner 曾经发起。
- 浏览器只保存 Host-only、Secure、HttpOnly Cookie；OIDC 临时关联 Cookie
  支持跨站回调所需 SameSite=Lax，最终业务 Cookie 可保持 Strict。
- 登录事务有时限、浏览器绑定、单次消费；使用固定配置的回调 URL，
  不相信 Host/X-Forwarded-* 拼出认证地址。returnTo 仅允许本站相对路径。
- 用户会话与 Resource Device 凭证分开。退出登录撤销本登录会话，
  不删除设备身份、不撤销其他用户会话。
- OIDC/Account 模式下禁止旧 Owner/Client 配对凭证绕过账号登录。
  Resource 配对保留，新增邀请记录绑定发起用户与 Space。
- Provider access token 的签名、issuer、audience、有效期和预期 scope
  均须验证；ID token 不作为 API access token。

## 账号和成员管理

首版角色为 owner、admin、member、viewer：

| 角色 | 共享会话/Run | 执行任务 | 管理模型/资源/任务策略 | 管理成员 |
| --- | --- | --- | --- | --- |
| owner | 读写 | 授权范围内 | 是 | 是 |
| admin | 读写 | 授权范围内 | 是 | 非 Owner 成员 |
| member | 读写 | 受 Profile 上限约束 | 否 | 否 |
| viewer | 只读 | 否 | 否 | 否 |

成员邀请使用一次性高熵 token，服务端只保存摘要。邀请不通过聊天工具发送，
由已登录管理员复制分享链接。接受邀请需要账号登录。最后一个 Owner 不能
被移除或降级。成员删除、降级、邀请和任务授权变更写独立安全审计记录。

身份认证成功但没有 Membership 的用户只能查看自己的身份和接受邀请；
不能查询 Space 的会话、模型、设备、KV、观测数据或协同房间。

## 执行身份与授权

登录会话不等于任务授权。引入服务端创建的 RunPrincipal 和持久 RunGrant：

```text
Authenticated User + Space Membership
  -> RunGrant（权限上限、有效期、撤销状态、来源）
  -> RunPrincipal（user/service、Space、grantId、委托来源）
  -> Run / Attempt / ToolInvocation / ContextProvider / PostProcessor
```

- HTTP 请求不能设置可信 principal；接受请求时覆盖并拒绝跨 Space 输入。
- 每次调用模型、工具及恢复 Run 都重新检查主体、成员关系和 grant。
- 执行权限是当前成员能力、固定任务 grant、当前 Profile/Run Policy
  及 Resource 本地授权的交集，任何一层不能扩大上游权限。
- 角色提升不会自动扩大已发出的 grant；降级和移除立即限制后续调用。
- 子 Run 继承父 grant 上限并保留 parentRunId。
- 定时任务和 Project Automation 使用显式持久委托，不能保存浏览器 Cookie
  充当后台授权。旧任务没有授权时必须重新绑定后才能在账号模式中运行。
- 用户退出浏览器不会取消已批准的后台委托。撤销 grant 或移除成员会阻止
  后续调用；正在执行的外部副作用不能承诺撤回。
- 现有 Receipt 仅在鉴权通过后才能返回，避免缓存绕过撤销。
- API、SSE、Yjs、Device Service 和模型工具采用同一权限决定。
  WebSocket 和持续流必须重验，不能只检查初次握手。
- 第三方 Runtime 插件仍被视为受信服务端代码；不能把同进程插件隔离
  宣称为多租户安全沙箱。管理员控制可加载插件。

## Skill 观测数据

PostgreSQL RunStore 继续持有执行事实，OTel 继续描述观测到的时间。
JSONL 是可重新生成的分析投影，不反向写入 Run 状态。

```text
<observability-root>/
  manifest.json
  daily/YYYY-MM-DD/
    runs-000001.jsonl
    events-000001.jsonl
    stages-000001.jsonl
```

- 输出 Run 摘要、低频语义事件及阶段耗时；不复制 token delta、reasoning、
  请求/回复全文、工具参数/结果、Cookie、凭证或未经分类的错误原文。
- 错误使用稳定类别和受控错误代码，未知原因显式 unknown。
- 所有记录包含 schemaVersion、Space、Run/Attempt、时间及来源，
  并保留可关联的事件 sequence；版本和字段缺失不能伪造。
- 按天和文件大小轮转，有保留期、总容量上限、重启恢复游标、
  截断/覆盖信息和磁盘错误降级。观测导出失败不改变 Run 业务结果。
- 运行中可从语义事件查看最后阶段；完成时补充 Trace，区分未采样、
  后端不可用和暂未索引。
- 查询脚本流式读取，默认有时间窗口和输出限制。结果标明覆盖范围、
  数据截止点及丢失/截断状态，不把样本统计称为全量统计。
- 不提前引入 Parquet、DuckDB、向量数据库或 Incident 平台；真实体量
  需要时再扩展文件查询后端。

## Bash 和文件边界

Skill 不是授权机制。知道 userId、设置环境变量、使用目录前缀或把 chmod
设为只读都不能约束任意 Bash。读取文件的进程需要真实 OS 隔离。

首版提供身份感知的只读分析环境：控制面根据 grant 选择投影快照，沙箱
只挂载该快照、Skill 脚本和必要执行工具，并拥有独立可写临时目录；
不挂载 Runtime 数据库、OIDC 凭证、全量宿主机目录或容器管理 socket。
使用成熟容器/系统沙箱执行器，不靠解析 Bash 字符串鉴权。沙箱不可用时
清楚失败，可继续用受控 read，不能自动退回不隔离 Shell。

授权还要检查执行节点是否允许接收该数据。任意个人/团队 Node 的相同
路径不代表同一 Resource。过期快照清理不等于能远程撤回已读取内容。

## 迁移与发布

默认保持旧单 Owner 配对模式。启用账号模式必须显式提供 OIDC issuer、
clientId、固定 public URL、Space ID 及已 bootstrap 的 Owner。
先在临时数据库和本地 OIDC fixture 完成验证，再由操作者配置真实提供方。
不能直接改生产数据目录权限或把旧 Client 都升级为成员。

本轮交付本地源码、迁移命令、启动/IdP 配置说明和验证工具；真实生产
IdP 注册、账号绑定、数据迁移和发布需要具体环境配置，单独执行。

## 验收

1. 两个账号登录同一 Space，在不同浏览器保持独立会话；退出只影响自己。
2. 未加入 Space 的账号即使猜中 ID，也不能读取 API、SSE、Yjs、KV 和文件。
3. 两个绑定不同 Space 的实例不共享数据库、状态、文件或凭证。
4. 请求伪造 principal/role/grant 被覆盖或拒绝；member 不能通过 Profile
   更新、模型工具、Device relay 或恢复旧 Run 提升权限。
5. 用户被移除或 grant 被撤销后，下一次模型/工具/流请求被拒绝。
6. 已授权后台任务可跨登录会话继续，恢复时仍要重新验证 grant。
7. 诊断 Skill 能查询跨会话 Run；不需要专用模型 Tool。
8. JSONL 不含敏感 fixture，导出支持容量、轮转、重启、缺失和失败降级。
9. Bash 分析环境不能读取控制面秘密或其他 Space，不能修改观测源数据。
10. 旧配对模式及当前 Workbench/Mobile/Runtime 回归通过。

## 复用资料

- https://github.com/panva/openid-client
- https://github.com/panva/jose
- https://zitadel.com/docs/guides/integrate/login/oidc/oauth-recommended-flows
- https://zitadel.com/docs/guides/integrate/login/oidc/device-authorization
- `ADR-0003-REMOTE-ACCESS-AND-DEVICE-PAIRING.md`
- `PLUGIN-DATA-LOCATIONS.md`

## 实现进度与已验证范围

已落盘：

- `apps/runtime/src/accounts/`：OIDC code + PKCE/nonce/state、Device Authorization、
  可选 RFC 9068 access-token 交换、独立会话、成员邀请、Owner 保护、RunGrant、
  资源配对邀请绑定和本地 bootstrap 命令。OIDC 复用 openid-client/jose。
- `main.mjs` 的 `ZION_RUNTIME_AUTH_MODE=accounts` 装配；默认仍是 pairing。
  账号模式必须提前 bootstrap。数据库不可更换 Space，默认插件数据根目录
  改为当前数据库目录下的 `plugins`，不自动导入旧 local-tools 状态。
- RunPrincipal 进入 RunRecord、ContextProvider、模型请求、ToolInvocation、
  插件 meta 和子 Agent；执行前重验，Receipt 返回前重验。
- Scheduler HTTP/插件创建更新时可发出 30 天 task grant，Worker 传递 grant。
  旧任务无 grant 会被执行核心拒绝。Project Automation 的委托另存账号表，
  绑定权限配置摘要；配置改变需重新授权，持久委托不会随浏览器退出消失。
- 协同支持初始 readOnly 配置和发送前同步鉴权；账号 viewer 的真实
  WebSocket 写入拒绝与移除后不再接收广播已通过专项集成测试。
- Grant 保存发行时的 Profile 和角色能力，执行中与当前 Profile/角色相交；
  角色提升不会扩大旧 grant。直接插件模型调用逐次重验，Identity 文件服务
  对物理叶路径重验，当前 Profile 收紧后禁止后续写入。
- `storage-binding.mjs` 同时绑定真实数据库目录，账号模式的模型配置、凭证、
  Profile、插件数据及观测根目录必须在该目录内；不同数据库不能共用目录。
  账号模式默认使用仓库内 Identity 插件，避免旧 external 插件缺少身份透传。
  只提取分类字段，跳过 delta/模型请求正文，清单记录过滤、清理、缺失和重建。
  清单作为提交点，重启截掉未提交尾部；导出错误只降低观测可用性。
  Trace 延迟重试最多 5 次，每批有界；未知错误不导出原文。
- `run-diagnostics` 改用 `/observability` JSONL 与流式 `obs.mjs` 查询。
  Runtime 默认不注册两个专用诊断 Tool，可用
  `ZION_OBSERVABILITY_DIAGNOSTIC_TOOLS=1` 显式兼容旧工具入口。
- `AnalysisToolBroker` 把现有 read/glob/grep/tree 的 `/observability`、
  `/skills/run-diagnostics` 路由到当前 Space 的只读快照。快照仅复制清单
  提交过的字节，单次最多 64 MiB、并发最多 2 个；遗漏计入 snapshot 字段。
  read 最多扫描 4 MiB，搜索使用有时限的 ripgrep 子进程，输出最多 30 KB。
- 账号模式 Bash 默认走 Docker，显式 `execution_environment: "analysis"`
  也可用于兼容模式。仅挂载观测快照与 Skill，不挂载宿主控制面目录或 socket；
  无网络、无 capability、非 root、只读 rootfs、独立 32 MiB 临时目录，
  256 MiB 内存/64 个进程/1 CPU/60 秒上限。每 250 ms 重验 grant，
- 普通成员不能委托任意文件、MCP 或自定义 Node 工具。管理员调用 Resource
  还需服务器开启 `ZION_ACCOUNT_ALLOW_RESOURCE_EXECUTION=1`，Bash 需显式
  选择 `execution_environment: "resource"`，继续受原有 Resource 策略约束。
  缓存 Receipt 返回之前同样验证路由权限。分析不可用不回退宿主 Shell。
  `ZION_ANALYSIS_DOCKER_HOST` 只接受本机 Unix socket，禁止把数据传给任意
  远程 daemon；`ZION_ANALYSIS_RG` 可指定宿主 ripgrep 的绝对路径。
- `packages/account-ui`：Workbench/Mobile 共用账号页、成员邀请和角色管理、
  我的登录会话、分页任务授权列表与撤销。邀请在登录前移出 fragment，
  仅保存在当前标签页 sessionStorage；身份快照不持久化，凭证不进 JS。
  `/account` 可在 Workbench 插件启动前打开，未入空间者停留在账号门禁。
- Workbench 与 Mobile 支持账号/旧配对两种门禁；viewer 禁止编辑与发起 Run，
  账号/角色改变时重新加载，后端请求始终逐次鉴权。设备页适配账号会话，
  账号模式只生成 Resource 配对，浏览器用户通过账号邀请加入。
- CLI 支持 `auth: { type: "account" }` profile 或 `--account --url`；
  Device flow、status、服务端 logout 及普通/chat 请求共用认证。
  复用 macOS Keychain，凭证按 origin 保存，认证 profile 不可改投另一 origin；
  Keychain 错误不输出带凭证的 argv。非 macOS 沿用 env/workload 接口，
  尚未实现交互式 OS 凭证存储适配器。
- PWA 排除 `/v1`、`/health` 的导航回退，避免缓存页面拦截 OIDC 跳转；
  账号门禁采用独立滚动容器，避免工作台布局截断管理页。
- `deploy/accounts/`：两个独立 Space 配置、bootstrap/start 启动器及
  ZITADEL/TLS/CLI/分析容器操作说明。启动器已用临时 IdP 和真实子进程验证。
  `scripts/preview-account-fixture.mjs` 提供可销毁的虚构账号预览，
  支持 `--viewer` / `--member`。
- 本地产品体验改为 `local-dev-oidc.mjs` + `scripts/local-accounts.mjs`：
  无 Docker、PostgreSQL 或邮件服务，单个 Node 进程以 PostgreSQL 保存开发账号，
  支持注册、页面内验证码、登录、密码重置和 CLI Device Flow，并通过标准
  discovery/JWKS/Code+PKCE 接入 Runtime。它强制绑定 loopback，明确不作为
  生产身份服务；生产仍可直接替换为 ZITADEL，无需改变 Zion 身份协议。

已执行验证：

| 范围 | 结果 |
| --- | --- |
| account-policy / postgres-account-store / account-access-control / oidc-provider | 30/30 |
| account-execution.integration / server / runtime-tool-broker / runtime-plugin-service / agent-runner / scheduler-worker / postgres-scheduler-store | 61/61 |
| packages/runtime 原有测试 | 46/46 |
| collaboration-service | 20/20 |
| 原有 access-control / postgres-access-store | 12/12 |
| packages/runtime TypeScript build | 通过 |
| account-authority.integration / account-collaboration.integration | 7/7 |
| Identity data-location / runtime-package / project-automation-runtime | 11/11 |
| observability-projection.integration / observability-service / postgres-run-store | 39/39 |
| account-analysis.integration | 8/8，真实 Docker 用例因无 daemon 跳过 1 项 |
| account-analysis + account-authority + policy + account-access + legacy-access + server | 57 通过，1 项跳过 |
| 最后一轮 Runtime 账号/执行/协同/投影/CLI/双进程 E2E，13 个文件 | 99 通过，真实 Docker 跳过 1 项 |
| Mobile（含账号组件、访客会话与邀请集成），7 个文件 | 38/38 |
| Workbench access/runtime-config/plugin-policy | 14/14 |
| Workbench 与 Mobile Vite 构建；Mobile TypeScript | 通过 |
| 轻量本地 IdP 注册/验证/PKCE/密码重置/Device Flow | 8/8（含原 OIDC Provider） |

OIDC 测试运行本地真实 discovery/JWKS/token fixture，覆盖签名、PKCE、
nonce/state/browser 绑定、Device flow 和 access-token audience/scope/type。
执行集成覆盖 HTTP 身份覆盖、模型运行中移除成员、Receipt 重放与恢复撤销。
客户端 E2E 使用真实签名 IdP、两个 Runtime 子进程和临时 PostgreSQL，覆盖跨
Space 拒绝、邀请前后权限、独立登录撤销、CLI Device flow/chat/Run、grant
列表与撤销，以及启动器 bootstrap/start。浏览器实际验证账号登录、邀请生成、
Workbench 进入与只读标记；发现并修复 Service Worker 拦截登录的问题。
浏览器桥接后续发生持续超时，Mobile 只读会话由 React 组件集成验证，
未把不完整的浏览器测试称为全端浏览器 E2E。
没有覆盖率门禁，本轮未统计覆盖率。Workbench 全量 TypeScript 检查仍有
已有的 JS 声明文件缺失、EditorProxy 类型和 reloadWindowPreservingWorkspace
作用域错误；新增账号代码未报告类型错误。Vite 两端构建通过。

环境验收限制：账号本地体验已经不依赖 Docker。本机有 Docker CLI、无可用
daemon，因此仅 Docker 分析沙箱仍未执行真实容器验证；已通过实际
文件/PostgreSQL/子进程验证路由、拒绝降级、输出上限、授权撤销和快照隔离；
Docker argv/env 检查使用进程 fixture，不能称为真实容器隔离验证。
配置好 daemon 和本地构建镜像后，用 `ZION_TEST_ANALYSIS_DOCKER_HOST`
启用 `account-analysis.integration.test.js` 的容器集成用例。
尚未注册真实 IdP、迁移生产数据或发布。部署步骤见
[`deploy/accounts/README.md`](../../deploy/accounts/README.md)。
