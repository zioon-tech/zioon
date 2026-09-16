# OTel / Jaeger 访问凭证设计

> Status: Proposed after current-code review
> Date: 2026-09-16
> Scope: `runtime.zioon.tech`, Jaeger UI/API, Runtime pairing credentials,
> Caddy authorization and Agent observability access

## 1. 结论

结合现有代码，第一阶段推荐把 Jaeger 暴露为：

```text
https://runtime.zioon.tech/observability/
```

而不是立即使用独立的 `observe.zioon.tech`。

原因是当前 Browser/Workbench 凭证是 Host-only 的
`__Host-zion_session` Cookie。它可以自动发送到同一域名的
`/observability/`，但按浏览器安全规则不能发送给另一个子域名。

建议权限：

- 已配对 Owner：允许进入完整 Jaeger UI；
- 普通 Client：只允许通过 Runtime API 读取脱敏、Run-scoped 诊断摘要；
- Resource Device：只保留 `node.connect`，不能读取观测数据；
- Agent Tool：由 Runtime 服务端查询，不获得 Browser Cookie 或 Jaeger 凭证；
- 匿名访问：拒绝。

第一阶段不需要给用户再创建一套 Jaeger 用户名和密码。现有 Owner 配对凭证即可
复用，但需要增加一个专用 Runtime 鉴权端点和 Caddy 路由。

## 2. 当前凭证实现

### 2.1 凭证类型

[`apps/runtime/src/sqlite-access-store.mjs`](../../apps/runtime/src/sqlite-access-store.mjs)
定义三类设备：

| Kind | 默认 scopes | 用途 |
|---|---|---|
| `owner` | `runtime.read/write`、`collaboration.write`、`pairing.manage`、`device.manage` | 管理者浏览器 |
| `client` | `runtime.read/write`、`collaboration.write` | 普通 Workbench/Mobile |
| `resource` | `node.connect` | Device Connector |

凭证格式：

```text
zion_v1.<credential-id>.<random-secret>
```

SQLite 只保存：

- credential ID；
- secret 的 SHA-256 digest；
- device、scope、创建/过期/吊销时间。

数据库文件尝试设置为 `0600`。认证比较使用 timing-safe compare。默认期限：

- 配对邀请：5 分钟；
- credential：30 天；
- 配对密钥错误尝试：5 次；
- HTTP 配对速率：每来源地址每分钟 20 次。

当前没有 refresh token。Credential 过期后需要重新配对。

### 2.2 Browser Cookie

[`apps/runtime/src/access-control.mjs`](../../apps/runtime/src/access-control.mjs)
将 Browser credential 写为：

```text
__Host-zion_session=<zion_v1 credential>
Path=/
HttpOnly
Secure
SameSite=Strict
Max-Age=<remaining lifetime>
```

安全属性意味着：

- JavaScript 不能读取 Cookie；
- 只通过 HTTPS 发送；
- 跨站请求不会自动携带；
- `__Host-` Cookie 不能设置 `Domain`；
- Cookie 只属于签发它的 host。

因此：

```text
runtime.zioon.tech Cookie
  -> runtime.zioon.tech/observability  可以携带
  -> observe.zioon.tech                不会携带
```

这不是配置遗漏，而是 `__Host-` Cookie 的安全目标。

### 2.3 配对流程

现有流程已经适合复用：

1. Owner/服务器创建一次性 pairing；
2. pairing secret 放在 URL fragment，浏览器请求不会自动把 fragment 发给服务器；
3. Workbench/Mobile JavaScript 调用 `POST /v1/access/pair` 交换；
4. Runtime 设置 HttpOnly Cookie；
5. 浏览器清除地址栏 fragment；
6. 后续请求通过 Cookie 认证；
7. Owner 可在设备列表吊销设备和该设备的全部 credentials。

Workbench 的
[`src/runtime/workbench-access.ts`](../../src/runtime/workbench-access.ts)
明确要求远程 Workbench 与 Runtime 使用相同 HTTPS Origin。

Mobile 的
[`apps/mobile-client/src/AuthBoundary.tsx`](../../apps/mobile-client/src/AuthBoundary.tsx)
和 API 客户端也统一使用 `credentials: "include"`。

## 3. 为什么不能直接公开 Jaeger

Jaeger 本身不知道 Zion 的：

- Owner/Client/Resource；
- Session、Project、Run visibility；
- 设备吊销；
- Interaction Profile；
- `runtime.read` / `device.manage`。

直接公开 `16686` 会绕过 Runtime Access Control。直接公开 `4318` 更危险，因为它是
telemetry 写入端点，不是 UI。

线上必须保持：

```text
127.0.0.1:4318  Collector ingest only
127.0.0.1:16686 Jaeger query/UI only
公网 :443       Caddy controlled route only
```

安全组不应放行 4317、4318、16685 或 16686。

## 4. 推荐方案：同源 Owner-only 路由

### 4.1 Runtime 鉴权端点

建议新增：

```text
GET /v1/access/authorize/observability
```

第一阶段可要求现有 `device.manage`，它只属于 Owner，且现有 Owner credential 不需要
数据库迁移：

```js
const principal = accessControl.authenticateRequest(request);
accessControl.requireScope(principal, "device.manage");
response.writeHead(204, { "cache-control": "no-store" });
response.end();
```

不要复用 `/v1/access/session` 作为长期方案。它只要求 `runtime.read`，会让所有
Client 都能查看全空间原始 Trace。

长期应引入独立 scope：

```text
observability.read
```

但这需要处理已配对 Owner 的 scope 迁移或重新配对，所以不是第一阶段最小路径。

### 4.2 Caddy 路由

当前
[`scripts/configure-runtime-deployment.mjs`](../../scripts/configure-runtime-deployment.mjs)
为每个站点生成单一 `reverse_proxy 127.0.0.1:8766`。

建议演进为等价结构：

```caddyfile
runtime.zioon.tech {
	encode zstd gzip

	@observabilityMcp path /observability/api/ai/mcp/*
	respond @observabilityMcp 404

	@observabilityOtlp path /observability/api/otlp/*
	respond @observabilityOtlp 404

	handle_path /observability/* {
		forward_auth 127.0.0.1:8766 {
			uri /v1/access/authorize/observability
		}

		reverse_proxy 127.0.0.1:16686 {
			header_up -Cookie
			header_up -Authorization
		}
	}

	handle {
		reverse_proxy 127.0.0.1:8766
	}

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		Permissions-Policy "camera=(), microphone=(), geolocation=()"
	}
}
```

关键点：

1. `forward_auth` 先把原始 Cookie 发给 Runtime 鉴权端点。
2. Runtime 返回 2xx 才允许继续。
3. 转发到 Jaeger 前必须删除 `Cookie` 和 `Authorization`。
4. Jaeger 永远不接触 Zion credential。
5. `handle_path` 去掉外部 `/observability` 前缀。
6. Jaeger v2.20 UI 会从浏览器 URL 自动识别外部前缀。
7. Browser-facing 路由禁止 MCP 和 OTLP proxy；它们不属于普通 UI。

Caddy 配置必须由现有部署脚本生成并经过 `caddy validate`，不能只在服务器上手改，
否则下次 `deploy:configure` 会覆盖。

### 4.3 未认证体验

未配对浏览器访问 `/observability/` 时，`forward_auth` 会返回 401。第一阶段可以：

- 让用户先打开 Workbench 完成配对，再进入 Jaeger；
- 或让 Caddy 的 401 页面链接回 `/`；
- 不在 Jaeger 内实现另一套登录页。

已吊销或过期的 Owner Cookie 会在下一次页面/API 请求时失效。

## 5. 普通用户与摘要 API

完整 Jaeger Owner-only，不等于普通用户完全没有观测能力。

未来：

```text
GET /v1/runs/{runId}/diagnostics
```

继续走 Runtime，同源 Cookie 和 `runtime.read`。它只返回：

- 当前用户可见 Run 的脱敏摘要；
- availability、coverage、bottleneck、findings；
- 不返回 raw Span；
- 不返回跨 Run 搜索；
- 不返回 Backend credential。

当前 Access Control 是 single-space，`runtime.read` 仍是服务级权限，并没有真正的
用户/项目级 Run ACL。多用户上线前必须增加 Run visibility resolver。

## 6. Agent Tool 和 Jaeger MCP

### 6.1 普通 Agent

普通会话中的 `observabilityInspect`：

- 由 Runtime Plugin 调用 Query Gateway；
- 复用当前 Run 的 policy、Session 和 Project 上下文；
- 只读一个明确 Run；
- 不获得 Cookie；
- 不获得 Jaeger URL 凭证；
- 输出执行二次白名单和大小限制。

### 6.2 Jaeger MCP

Jaeger v2.20 本地验证确认 `/api/ai/mcp/` 内置：

- `search_traces`；
- `get_trace_topology`；
- `get_critical_path`；
- `get_trace_errors`；
- `get_span_details`；
- service/span discovery；
- trace analysis skills。

这些能力适合受信任的运维 Agent，但不适合直接加入普通 Interaction Profile，因为
它们可以跨 Trace 搜索并读取原始 Span 详情。

建议：

- Jaeger MCP 只监听 localhost/VPC；
- Browser Caddy route 显式阻止 MCP path；
- Runtime Gateway 可以选择性调用 MCP；
- 独立运维 Agent 使用 service credential 或 mTLS；
- 不把 Owner Browser Cookie 转换为 MCP bearer token。

## 7. 独立 `observe.zioon.tech` 的条件

长期使用独立域名是更清晰的安全边界，但不能直接复用当前 Cookie。

可选方案：

### 方案 A：OIDC / SSO Proxy

```text
observe.zioon.tech
  -> oauth2-proxy / ALB OIDC / Zero Trust
  -> Jaeger
```

优点：

- 独立域名、独立角色和审计；
- 适合开发/运维组织；
- 不耦合 Zion pairing。

代价：

- 第二套身份系统；
- 需要 OIDC Client、回调 URL 和用户/组映射。

### 方案 B：Zion 一次性授权交换

Runtime 为 Owner 生成短时、单用途 code，`observe.zioon.tech` 交换成自己的
Host-only Cookie。

优点是仍使用 Zion 设备身份；缺点是需要新增完整的跨域授权协议、防重放、audience、
redirect allowlist 和独立 session store。现阶段不值得。

### 方案 C：Basic Auth

只适合短期内部验证。它不能复用设备吊销、scope 或审计，并会带来共享密码维护问题。

## 8. 凭证运维

### 8.1 创建 Owner

服务器现有命令：

```bash
cd /opt/zion-next
sudo -u zion env \
  ZION_RUNTIME_DB=/var/lib/zion-next/runtime.sqlite3 \
  ZION_RUNTIME_PUBLIC_URL=https://runtime.zioon.tech \
  npm run runtime:access -- pair create \
    --kind owner \
    --delivery cookie
```

Owner 打开一次性链接后，同一个 Browser Profile 即可访问 Workbench 和
`/observability/`。不用把 Cookie 或 secret 复制给 Jaeger。

### 8.2 吊销

```bash
sudo -u zion env \
  ZION_RUNTIME_DB=/var/lib/zion-next/runtime.sqlite3 \
  npm run runtime:access -- devices list

sudo -u zion env \
  ZION_RUNTIME_DB=/var/lib/zion-next/runtime.sqlite3 \
  npm run runtime:access -- devices revoke <device-id>
```

吊销设备会同时吊销该设备所有 credential。

### 8.3 备份

访问凭证 digest 在 Runtime SQLite 中。备份 Runtime 数据库时必须加密；Jaeger 不应
持有这些凭证。Credential raw secret 只存在于 Browser Cookie 或 Resource Host
credential store。

## 9. 上线前验收

### Runtime

- 匿名 `/health` 只返回最小信息；
- 匿名 `/v1/access/authorize/observability` 返回 401；
- Client 返回 403；
- Owner 返回 204；
- 已吊销 Owner 返回 401；
- endpoint 不返回 credential、device list 或内部错误。

### Caddy

- `/observability/` 未认证不可访问；
- Owner 可加载 HTML、静态资源和 Query API；
- `/observability/api/ai/mcp/` 返回 404；
- `/observability/api/otlp/` 返回 404；
- Jaeger upstream 收不到 Cookie/Authorization；
- 4318/16686 从公网不可达；
- Caddy 配置通过 `caddy validate`。

### Browser

- 同一已配对 Profile 无需第二次登录；
- 隐私模式/新 Browser 要重新配对；
- 退出或吊销后 Jaeger 同时失效；
- Trace 深链接不能绕过鉴权；
- Workbench 不因 Jaeger 不可用而失败。

## 10. 推荐阶段

### A. 本地

保持现在的 loopback Jaeger，不启用认证。

### B. 线上内部试用

1. 增加 Owner-only auth endpoint。
2. Jaeger/Collector 只监听 loopback。
3. Caddy 暴露 `/observability/`。
4. 使用现有 Owner Cookie。
5. 使用低采样率和短保留期。

### C. 普通用户摘要

增加 Run-scoped Query Gateway；普通 Client 不进入 Jaeger。

### D. 独立观测域名

当需要多人运维、组织角色和长期审计时，再引入 `observe.zioon.tech` + OIDC/SSO。

## 11. 最终判断

当前代码可以复用现有凭证，但前提是 Jaeger 先放在
`runtime.zioon.tech/observability/` 同源路径下。

不要：

- 共享 Cookie 到子域；
- 让 Jaeger 直接验证 Zion token；
- 把 16686/4318 开到公网；
- 给普通 Client 完整 Jaeger；
- 直接暴露 Jaeger MCP。

应当：

- Caddy `forward_auth` 到 Runtime；
- 完整 UI 先限制 Owner；
- 转发 Jaeger 前剥离凭证 Header；
- 普通用户和模型走 Runtime 的脱敏诊断摘要；
- 未来独立域名时使用正式 OIDC/SSO。
