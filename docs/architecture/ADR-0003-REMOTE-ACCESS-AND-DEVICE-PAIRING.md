# ADR-0003：远程访问、设备配对与 Resource Host 通道

- 状态：Accepted
- 日期：2026-09-05
- 范围：Workbench、Mobile、CLI、Runtime Host、Resource Host、Relay
- 依赖：
  - [ADR-0001-MODULAR-MONOLITH-AGENT-RUNTIME.md](./ADR-0001-MODULAR-MONOLITH-AGENT-RUNTIME.md)
  - [ADR-0002-REALTIME-SESSION-COLLABORATION.md](./ADR-0002-REALTIME-SESSION-COLLABORATION.md)
  - [ZION-DISTRIBUTED-RUNTIME-PRODUCT-ARCHITECTURE.md](./ZION-DISTRIBUTED-RUNTIME-PRODUCT-ARCHITECTURE.md)

## 背景

现有实现已经具备：

- 可独立部署的 Runtime Host；
- HTTP、SSE 和 Hocuspocus/Yjs WebSocket；
- `NodeBroker`、`device-connector` 和出站 HTTP long poll；
- Runtime 调用租约、取消、Runtime 侧持久化 receipt；
- Resource Host 对 workspace、terminal 和工具范围的二次收窄。

但当前安全边界只适用于本机和私有测试：

- Runtime 主 API 没有 Client 认证；
- Runtime 只接受 loopback Browser Origin；
- 所有 Resource Host 共用一枚静态 Bearer token；
- 静态 token 同时允许注册 Node、领取调用、提交结果和列出所有 Node；
- 没有设备配对、独立凭证、吊销、轮换和远程审批；
- Runtime 凭证文件仍是本机 `0600` 过渡实现；
- Device 侧 receipt 没有跨进程持久化。

因此，直接把 Runtime 绑定到 `0.0.0.0` 或将其端口暴露到公网不可接受。

## 决策

### 1. 保持逻辑角色分离

```text
Phone / Browser / CLI
  -> same-origin HTTPS Access Gateway
    -> Runtime HTTP + SSE + Yjs

Runtime
  -> Node Broker
    -> Relay delivery
      -> outbound HTTPS Resource Connector
        -> loopback local-tools
```

- Client 负责发起命令和投影状态。
- Runtime 负责 Session、Run、状态和调度。
- Resource Host 持有本机工具、数据和最终授权。
- Access Gateway 负责认证、Origin、限流和路由。
- Relay 负责出站连接、presence、投递和 ACK，不解释 Agent、Session 或 CRDT 语义。

第一阶段 Access Gateway 和 Relay adapter 可以与 `apps/runtime` 同进程，但模块、凭证
和授权边界必须独立。`@zion/runtime` Core 不感知账号、Cookie、配对码或 Relay。

### 2. 单用户、单 Space 起步

第一阶段不建设用户注册、组织、邀请成员或第三方 Identity Provider。部署实例隐含一个
Space 和一个 Owner，但仍区分三类主体：

| 主体 | 用途 | 默认权限 |
| --- | --- | --- |
| Owner Client | 管理配对、设备和全部 Workbench 状态 | `client.*`, `pairing.manage`, `device.manage` |
| Client Device | Workbench、Mobile、CLI | `session.*`, `run.*`, `collaboration.*` |
| Resource Device | 电脑或未来手机上的 Tool Host | `node.connect`，不能读取 Session |

Client credential 不能注册 Resource Host，Resource credential 不能读取 Session 或
创建 Run。已授权 Client 可以通过 Runtime 使用在线 Resource Host 暴露的受限设备
服务；列出设备、创建配对邀请和吊销设备只允许 Owner。

### 3. 使用一次性配对邀请，不使用长期房间密码

配对流程：

1. Owner 在已认证 Workbench 或 Runtime 主机 CLI 创建邀请；
2. Runtime 生成不可预测的 `pairingId`、QR secret 和人工短码；
3. 邀请绑定目标角色、权限、有效期和最大尝试次数；
4. 新设备生成自己的稳定 `deviceId`，通过 HTTPS 提交 secret 或短码；
5. Runtime 原子消费邀请并签发该设备专属 credential；
6. secret、短码和 credential 在服务端只保存摘要；
7. 邀请使用一次后立即失效，设备可以独立吊销。

默认值：

- QR secret：256 bit；
- 人工短码：至少 60 bit；
- 有效期：5 分钟；
- 最大失败尝试：5 次；
- 邀请：单次使用；
- Resource credential：按设备签发，不在多个设备间复用。

二维码中的 secret 放在 URL fragment，避免进入 HTTP access log、Referer 和代理查询
参数。人工短码只是 QR 不便使用时的降级方式。固定房间号可以作为公开定位符，但不能
作为认证凭证；“房间号 + 长期密码”不进入首版。

OAuth 2.0 Device Authorization Grant 适合已有 Authorization Server 和 Human
Identity 的场景。当前无账号的单 Space 配对复用其交互形态，但不伪装成 OAuth。
未来接入账号体系时，Client 登录迁移到 Authorization Code + PKCE/BFF，Resource
配对协议保持独立。

### 4. Browser 使用同源服务端会话

远程 Workbench 必须与 Access Gateway 使用同一 HTTPS origin。配对成功后：

- Gateway 设置 `Secure`、`HttpOnly`、`SameSite=Strict`、`Path=/` 的 Host-only
  session cookie；
- Browser 不把长期 Bearer token 保存进 URL、`localStorage` 或普通 IndexedDB；
- HTTP、SSE 和 WebSocket 使用同一服务端 Session；
- 所有带 Origin 的请求和 WebSocket upgrade 必须匹配显式 allowlist；
- Cookie 认证的状态变更请求必须校验 Origin；
- Yjs 在 `onAuthenticate` 后按 Session 权限授权，不能只验证连接已登录。

第一阶段允许同源 Gateway 与 Workbench 静态资源由同一反向代理提供。跨 origin
Workbench、通配 CORS 和第三方 Cookie 不在支持范围内。

### 5. Resource Host 只建立出站连接

Resource Connector 主动连接公网 Gateway/Relay，不监听公网端口，不暴露
`zion-local-tools`：

```text
Resource Connector
  -> HTTPS register / long poll / result
  -> 127.0.0.1 local-tools
```

首版保留 HTTP long poll，因为协议已经支持 lease、cancel 和 reconnect redelivery，
且容易穿过 NAT、企业代理和移动网络。后续可以切换到 WebSocket 或 HTTP/2，不改变
`node-protocol` command envelope。

每次 Node 请求必须同时满足：

- credential 属于 `resource` 设备；
- credential 未过期、未吊销；
- credential 具有 `node.connect`；
- credential 绑定的 `deviceId` 与注册 Node 一致；
- path 中的 `nodeId` 与已认证 Node 一致；
- invocation 未超过 Runtime lease；
- Tool、resource、workspace 和 terminal scope 通过 Resource Host 本地校验。

Runtime 不能通过 capability advertisement 扩大本机权限。

### 6. 凭证演进

第一阶段为了快速闭环，使用 TLS 内的高熵 opaque credential：

- 每设备独立；
- 服务端只保存 SHA-256 摘要；
- 支持到期、最后使用时间和立即吊销；
- Desktop/CLI 存入 OS Keychain；不支持 Keychain 的平台使用受限 token file；
- 日志、health、Node snapshot 和错误信息不得输出 credential。

第二阶段将 Resource credential 升级为设备持钥：

- 设备生成 Ed25519 或 P-256 私钥并保存在 Keychain/TPM/Secure Enclave；
- 配对只登记公钥；
- 短期 access token 绑定设备公钥；
- 请求使用 DPoP 风格 proof 或等价的 nonce 签名，降低 Bearer 泄漏后的重放风险；
- 支持 key rotation、attestation 和恢复。

不在首版自行实现 PAKE、Noise 或新的密码协议。若后续允许低熵长期密码或不信任
TLS 终止 Relay，必须采用经过审查的 PAKE/E2EE 库，而不是自研密码学。

### 7. 高风险调用需要独立 Approval

“设备已绑定”只证明设备身份，不等于授权任意工具。最终权限仍为：

```text
Owner/Space policy
∩ Interaction Profile
∩ Run policy
∩ Runtime policy
∩ Resource Host local grants
∩ Approval
```

- `read` 可以按明确 workspace grant 自动执行；
- `write`、`edit`、`Bash` 和外部副作用默认需要远程 Approval；
- Approval 绑定规范化 operation、资源、风险等级、过期时间和 invocation ID；
- Resource Host 在本地显示来源、目标和实际参数，并保留 kill switch；
- 无 Approval Provider 时，远程模式不得静默提升到 `trusted-automation`。

### 8. Relay 信任边界

第一阶段 HTTPS 可在受信 Gateway 终止，Relay 可以看到协议明文，但不能获得本机
local-tools 凭证或绕过 Resource Host policy。后续不信任 Relay 时：

- Runtime 与 Resource Host 建立端到端加密会话；
- Relay 只看到 Space、目标 Node、message ID、TTL 和密文；
- durable mailbox 保存密文 envelope；
- 使用稳定 message/operation ID、at-least-once 投递和双侧持久化 receipt。

不要让每个 Client 与每个 Resource Host 建立全量状态同步。Runtime/Control Plane
仍是权威状态与调度 owner，Host 只接收投放给自己的最小调用和上下文。

## 威胁模型

首版防御：

- Internet 未认证访问 Runtime API；
- 恶意网站发起跨站 HTTP/WebSocket 请求；
- 配对码在线猜测和重复使用；
- 一个设备 credential 泄漏后冒充全部设备；
- 被吊销设备继续注册、poll 或提交结果；
- Runtime 将权限扩大到 Resource Host 未授权的路径或 terminal；
- 断线重投导致已确认副作用重复执行。

首版不承诺防御：

- Runtime Host、Resource Host 或 Owner 设备完全失陷；
- Workbench origin 发生任意脚本执行后的会话内操作；
- 已吊销浏览器继续读取吊销前已缓存到本机 IndexedDB 的离线副本；
- TLS 终止 Gateway 被攻破；
- 尚未交付 Device durable receipt 时，Device 与 Runtime 同时崩溃造成的极端重复执行；
- 未启用 Approval Provider 时的无人值守高风险操作。

## 运维约束

- Runtime 继续默认只绑定 loopback。
- 公网部署使用同机反向代理或独立 Gateway 提供 TLS。
- 非 loopback 直绑必须同时显式开启开发 override 和 Access Control，生产不支持明文 HTTP。
- `/health` 未认证响应只暴露最小存活信息。
- 所有远程 Origin 使用精确 allowlist，不使用 `*`，不回显任意 Origin。
- 配对、认证失败、设备吊销和高风险 Approval 写入安全审计事件。
- Access 数据与 Runtime 业务数据可以先共用 SQLite，但使用独立表和模块。

## 分阶段交付

1. **Access foundation**
   - SQLite device、credential 和 pairing store；
   - 一次性 Owner/Client/Resource 配对；
   - 每设备 opaque credential、吊销和最小 scope；
   - Node gateway 从共享 token 迁移到 Resource credential；
   - Runtime HTTP/SSE/Yjs 统一 Client 认证和精确 Origin；
   - loopback 无认证模式保持兼容。
2. **Remote action safety**
   - Approval Provider；
   - Device 侧 durable operation receipt；
   - `waiting_for_resource` / `waiting_for_approval`；
   - 本地通知与 kill switch。
3. **Public Relay**
   - Runtime 与 Resource Host 都使用出站连接；
   - durable mailbox、ACK、去重、presence 和推送；
   - credential rotation 和设备持钥 proof。
4. **Mobile Resource Host**
   - 移动端 capability catalog；
   - 相机、麦克风、位置、分享等受前台权限约束的工具；
   - 后台限制显式建模，不能伪装为常在线 Node。
5. **Account migration**
   - Human Identity、Space membership、恢复与多 Owner；
   - Workbench BFF/OIDC；
   - 现有 Device identity 和 grant 无需重建。

## 选择依据

- RFC 8628：OAuth 2.0 Device Authorization Grant
  <https://www.rfc-editor.org/rfc/rfc8628>
- RFC 10027 / BCP 247：跨设备流程安全最佳实践
  <https://www.rfc-editor.org/info/rfc10027/>
- RFC 9449：DPoP sender-constrained token
  <https://www.rfc-editor.org/info/rfc9449/>
- OWASP WebSocket Security Cheat Sheet
  <https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html>

## 不采用

- 直接公开 Runtime 或 local-tools 端口；
- 所有设备共享一枚静态 Bearer token；
- 将配对码作为长期密码；
- 把 credential 放入 URL query；
- 仅依赖 CORS 或 Origin 作为认证；
- 让 Relay 理解 Tool 或 Session 业务；
- 在 `@zion/runtime` Core 中加入 Cookie、账号或 UI 配对逻辑；
- 首版自研 PAKE、Noise、WireGuard 或完整 OAuth Server。
