# 资源与内容分享：本地交付

2026-11-22。第一版以模型分享和会话／文件夹分享为中心，已在独立产品与 Memory worktree 实现。本地预览使用原有持久数据库，未部署或发布。

## 用户体验

提供者在分享面板输入完整邮箱或账号 ID，确认匹配的用户，再直接添加授权。模型、会话和文件夹无需对方点击邀请，便进入对方相应的资源列表。邮箱只匹配身份服务确认过的地址；未注册、未验证或对应多个账号的邮箱不给予模糊授权，多账号可改用准确账号 ID。此入口不发送邮件。邀请链接仍作为折叠的可选入口，接受时须登录自己的账号。

自己的模型与收到的模型并列显示，收到的模型标明提供者。新建会话默认私密，模型提供者没有会话目录、正文或 Memory 的读取权。

Workbench 保留原有编辑器、会话树和模型选择器。会话列表顶部提供「全部／我分享的／收到的」快捷筛选，收到的会话和文件夹直接出现在原列表，并保留文件夹层级。收到的模型、会话与文件夹使用统一的小分享标记，悬浮说明提供者。

Activity Bar「分享」侧边栏采用「收到的／我分享的」两种方向，支持搜索资源或提供者、按模型／会话／文件夹筛选。列表按资源类型分组，每行显示名称、来源、权限或失效状态，以及主要操作；点击进入详情后可就地调整单人权限，或打开统一分享面板。会话和文件夹右键、会话标题栏、editor-config「管理分享」使用同一面板；从文档打开面板不会切换当前侧边栏。

分享面板上部查找、确认并添加协作者，下部列出授权用户及其当前权限，下拉即可调整查看／编辑或移除会话授权。同一用户的重复直接授权在事务内一并更新，避免旧授权维持未显示的编辑权限。来自文件夹的权限显示来源与管理入口，可进入文件夹面板再返回会话；降权被更高的继承授权阻挡时，会明确解释原因。仅继承用户在会话中不能直接修改父文件夹权限。邀请链接单独折叠，展示默认邀请权限，并可生成、复制或撤销；撤销链接不移除已有协作者。会话还可以设置私密，以暂停直接分享与文件夹继承；私密期间分享面板仍允许管理已有直接授权。

会话链接授予原始文档的查看或编辑权限。编辑者继续使用自己的模型列表，可在原文中生成回答；查看者不能编辑、上传图片或生成。文件夹分享遵循当前文件夹树，包含以后加入的会话，私密子会话不会出现在接收者的文件夹列表。

没有新增顶部空间组件，也没有联系人、群组或成员管理流程。技能、设备、插件及机器人暂不开放新的分享界面；未来有多人维护资源集合的实际需求，再加入可选空间。

## 授权与数据边界

`account_shares` 分别记录模型使用权、单篇内容和文件夹内容，以及新邀请的默认权限。`account_share_grants.role` 是每位接收者的实际权限，链接接受和直接添加共用同一授权表。直接添加没有邀请记录；现有授权在迁移时保留原角色。邀请令牌只保存摘要；默认链接七天有效、只能接受一次，接受时必须登录自己的账号。接受记录绑定接收者身份，复用同一有效接受请求是幂等的。令牌位于链接 fragment，Workbench 在登录前将其暂存在当前标签页，登录后显示邀请内容再接受。重复接受新链接不会覆盖仍生效的单人权限调整。

提供者可设置模型每月调用上限与分享有效期。服务端在派发前检查授权、来源版本与额度；派发和结果状态持久保存，用量不包含接收者私人会话的正文和目录。提供者的密钥及 endpoint 不下发到接收者。模型请求仍会到达所选模型服务，这不授予提供者产品中的会话读取权。

资源使用与内容访问独立。分享模型不会公开接收者会话；分享文档不会自动开放提供者模型、技能、插件、设备或账户设置。

共享内容请求保持接收者的账户身份，额外携带精确的文档范围。Runtime 只对该文档的读写、Run、附件、协作及文档 Memory 开放对应权限，账户模型列表、配置、会话目录、技能及设备请求仍属于接收者。

原文开放不等于开放此前私密任务中的隐藏上下文。接收者的 Session 返回值仅保留基本信息；只有按共享文档范围创建的 Run 与输入快照可以进入共享任务日志。此前私人配置、Identity 上下文、私密输入快照和运行详情不会因后续分享而开放。

内容编辑、直接授权、接受、权限调整、撤销、隐私和文件夹树变化在相同的数据库事务锁下校验。服务端同时使用接收者权限计算收到目录、参与者、HTTP 读取／写入、生成、附件及 WebSocket 协作；降为只读后已经连接的写入者也无法继续写入。共享文档的生成使用持久队列；撤销会阻止后续读写与派发，并终止权限失效的协作连接。授权修改审计记录包含操作者、目标用户和修改后的角色。编辑者上传的图片绑定原始共享文档，其他账户和其他文档不能借此访问附件。

## Workbench 的接入方式

共享文档以提供者与物理文档 ID 组成的限定 ID 存在于本地编辑器、草稿与缓存。传输层将限定 ID 转成原文地址，同时保持接收者账户 header 不变。会话列表通过独立的展示投影合并收到的资源；接收的共享文档不会写入接收者持久私密目录，不参与本人目录的重命名、删除、拖放与批量选择。

`GET /v1/sharing/content` 返回权限校验后的收到内容树与本人有效分享节点 ID。目录投影不返回正文或私人元数据；私密、撤销、过期与停用提供者被过滤，重叠文件夹／单篇授权取最高权限并去重。接收者看不到未授权的祖先目录。刷新分享或页面重新可见时重新读取，页面可见时每十五秒更新；打开原文仍由原生载入接口再次校验权限。

Run 与文档关联按账户持久保存，刷新后可继续打开历史任务。模型选择器打开或分享状态改变时重新加载自己的资源目录。发送前查询本人文档的分享状态，即使通过 CLI 分享了已经打开的文档，也会停止附加浏览器中的个人 Identity、角色和技能上下文。

会话标题栏的头像紧邻重命名按钮左边，保留它之前的其他按钮顺序，仅显示当前已连接这份文档的其他用户。悬浮或点击可查看姓名、文档权限及文件夹继承来源。人数较多时折叠为 `+N`，窄分屏自动减少头像数量。自己、离线或无法确认在线状态的授权用户不显示头像；没有其他在线用户时不占位。

editor-config 的「会话访问权限」列出完整有效授权用户，分别标明阅读／编辑权限、直接会话授权或文件夹继承，以及是否在此文档中；离线用户也列出。所有者可通过下拉直接调整权限，或进入统一的「管理分享」面板查看全部来源，并设置隐私；接收者看不到所有者的邀请令牌与管理按钮。此处的阅读／编辑表示权限，不声称有尚未实现的历史访问日志。

参与者由当前文档及其祖先文件夹的有效分享授权计算，重复授权取最高权限；私密子会话仅返回所有者，失效、撤销和停用账号不在列表中。在线身份来自服务端已认证且仍有权访问该文档的 WebSocket 连接，多窗口去重；客户端 awareness 只触发刷新，不作为身份或权限证据。头像详情不包含邮箱和私人资料。页面隐藏时暂停轮询，切换文档时取消旧请求，每个分屏独立绑定自己的会话。

共享文档有独立的 Memory 命名空间，提供者和接收者读取同一篇文档的 Memory，个人 Memory 不自动搬入。Identity 文件请求绑定发起时的文档，切换文档后的旧响应不能更新新文档缓存。共享文档不使用个人会话 Identity 快照，浏览器自动传记处理不向共享文档写入个人内容。

## CLI 与公共接口

日常命令：

```sh
zioon share sources
zioon share model <model-id> --limit 500
zioon share preview '<邀请链接>'
zioon share accept '<邀请链接>'
zioon share received
zioon share sent
zioon share document <session-id> --role editor
zioon share folder <folder-id> --role viewer
zioon chat --shared <share-id>
zioon chat --shared <folder-share-id> --document <session-id>
zioon share revoke <share-id> --recipient <account-id>
zioon share private <session-id> on
```

聊天中使用 `/model`、`/shares`、`/share viewer|editor`、`/accept`、`/shared <share-id> [document-id]`。`/new` 返回自己的私密会话，`/sessions` 只列出本人会话。共享内容的草稿、模型选择与历史按接收者、提供者和文档分别保存；私密会话的 `--continue` 不会误开共享内容。

共享生成持久保存完整输入和请求 ID，回执丢失时 `/recover` 查询原请求，`/recover retry` 重用保存的输入与 ID。CLI 共享文档生成写入原文，使用原始文档历史，不拼接另一私密会话的历史。共享内容目前通过交互式 `chat --shared` 使用，单次 `run` 不接受 `--shared`，避免错误创建私密任务。

公共 SDK：`@zion/runtime-client/sharing`，提供 list、sources、content、create、resolveRecipient、addRecipient、updateRecipient、updateDocumentCollaborator、updateSourceCollaborator、preview、accept、invite、revoke、leave、documents、participants、documentPrivacy 和 privacy。请求有超时与取消支持。`create({recipient:账号ID或邮箱,...})` 直接授权，不返回 invitation。服务端接口位于 `/v1/sharing`；内容请求使用 `x-zioon-content-space` 与 `x-zioon-content-document`。

参与者元数据通过 `GET /v1/sharing/documents/:id/participants?origin=:owner-personal-id` 读取，保持调用者自己的账户 header；响应含文档范围、本人 ID 及 `{id,name,role,inherited,online}`，其中 `online:null` 表示暂时无法确认。所有者额外收到授权来源 `grants`，接收者不获得这些管理数据。权限修改使用 `/documents/:id/collaborators/:userId`，单项分享使用 `/:shareId/recipients/:userId`，模型／文件夹同资源的全部授权使用 `/resources/:kind/:sourceId/collaborators/:userId`。内部仍保留旧空间模块供兼容与未来演进，当前产品入口不依赖它们。

## 实现位置

| 范围 | 主要文件 |
| --- | --- |
| 分享授权、来源与额度 | `apps/runtime/src/sharing/` |
| 数据库迁移 | `012_account_sharing.sql`、`013_content_run_grants.sql`、`014_share_recipient_roles.sql` |
| 精确内容请求及协作持久化 | Account gateway、authorized Workbench store、collaboration persistence |
| Workbench 分享侧边栏与统一面板 | `SharingWorkbench.tsx`、`SharingDialog.tsx` |
| 会话目录展示、筛选与来源标记 | `extensions/dev.session-manager/model/shared-view.js` 与 `shared-resource-marker.ts` |
| 标题栏在线参与者与完整授权 | `EditorParticipants.tsx`、`DocumentAccess.tsx`、editor-config |
| 文档地址、缓存与请求范围 | `src/runtime/workbench-space.ts` |
| CLI | `sharing-cli.mjs`、`cli-shared-content.mjs`、chat shell |
| SDK | `packages/runtime-client/src/sharing.mjs` 与类型声明 |
| 持久本地预览 | `scripts/spaces-preview.mjs` 与 sharing seed |
| Memory 命名空间 | 独立 Memory worktree 的 `account-bindings.ts` |

## 验收边界

已验证真实本地 OIDC、原生 PostgreSQL、固定版本 Memory、Runtime 模型请求、共享文档附件、WebSocket 协作、分享 DOM、实际 Session Manager、CLI、macOS 原生 PTY 和重启持久化。模型采用本地确定性 fixture，用于检查链路与权限，不代表真实供应商质量。

没有使用浏览器自动化，DOM 和编辑器代理验收不替代人工视觉、滚动与布局检查。Windows／Linux 原生终端尚未实测。根项目 TypeScript 保留原基线的 25 项诊断，本轮新增实现未增加诊断；Vite 构建通过。
