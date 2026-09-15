# Zion 单租户远程部署

本文对应
[ADR-0003](./ADR-0003-REMOTE-ACCESS-AND-DEVICE-PAIRING.md)
的第一阶段实现。目标是让手机和电脑通过同一个 HTTPS Workbench 访问 Runtime，同时
让办公电脑上的 `local-tools` 只通过出站连接提供能力。

当前阿里云实例、服务路径、Credential 存放位置、发布和排障流程见
[远程部署运维交接](../operations/REMOTE-DEPLOYMENT-RUNBOOK.md)。该文档记录实际环境，
本文只描述通用部署方法。

面向部署使用者的模式选择、可执行命令和验收步骤见
[部署模式指南](../operations/DEPLOYMENT-MODES.md)。只有公网 IP 和已有正式域名是两套
不同流程，不应混用端口、证书地址或 Connector credential。

本文描述当前可执行流程。Runtime/Node 安装产品化、稳定设备身份、可靠投递、生命周期
治理和规模化连接平面的后续演进见
[Node Control Plane 演进路线图](./NODE-CONTROL-PLANE-ROADMAP.md)。

## 拓扑

```text
Internet
  -> https://zion.example.com
    -> TLS reverse proxy
      -> /v1/* and /health -> 127.0.0.1:8766 Runtime
      -> /*               -> Workbench dist/

Office Mac
  ->  Device Connector
    -> outbound HTTPS https://zion.example.com/v1/device-nodes/*
      -> Node Broker
  -> loopback http://127.0.0.1:8765 local-tools
```

Runtime 和 `local-tools` 都不需要监听公网地址。

## 最短路径

以下便捷方式仅适用于允许运行 `cloudflared` 的非办公主机。macOS 首次安装：

```bash
brew install cloudflared
```

之后在项目根目录运行：

```bash
npm run remote:start
```

该命令会构建 Workbench、创建仅出站的临时 HTTPS Tunnel、启动 Runtime，并在终端
显示 Owner/Client 配对二维码与短码。无需配置路由器或开放本机端口。

手机直接扫描终端二维码，不需要和 Runtime 主机处于同一局域网。首次进入后，在
Workbench 的“设备与远程访问”页为办公电脑生成“工具电脑”短码，再在办公电脑的
项目目录执行页面给出的命令即可。`--local` 仅用于本机调试，它生成的
`127.0.0.1` 地址不能被手机访问。

### 公司设备限制与 Cloudflare Pages

若公司终端安全策略禁止 `cloudflared`，不要在办公电脑运行 Tunnel 或公网 Runtime。
办公电脑只运行 Device Connector，通过普通出站 HTTPS 连接外部 Runtime：

```text
Cloudflare Pages / 外部 HTTPS Gateway
  -> 外部 Runtime Host
  <- 公司电脑上的 Device Connector（仅出站 HTTPS）
  -> 公司电脑上的 local-tools（仅 loopback）
```

Cloudflare API token 可通过 Wrangler 上传 Workbench 静态资源，不会启动
`cloudflared` 常驻进程：

```bash
CLOUDFLARE_API_TOKEN=... npx wrangler pages deploy <workbench-dist> \
  --project-name zion-next \
  --branch <preview-branch>
```

Pages 不能运行当前 Node Runtime、SQLite、SSE 或 Hocuspocus 服务。单独部署前端
只提供静态预览；完整远程访问仍需把 Runtime 部署到外部服务器，并让 Workbench 的
`/health`、`/v1/*` 与 WebSocket 路径通过同一 HTTPS Origin 到达 Runtime。

## 1. 构建 Workbench

```bash
npm ci
npm run build
```

生产域名使用 HTTPS 时，Workbench 默认把当前 origin 作为 Runtime URL。不要为远程
部署把 `zion.runtime.baseUrl` 指向另一个站点；当前 Browser 会话要求同源。

## 2. 启动 Runtime

```bash
export ZION_RUNTIME_ACCESS_CONTROL=1
export ZION_RUNTIME_PUBLIC_URL=https://zion.example.com
export ZION_RUNTIME_ALLOWED_ORIGINS=https://zion.example.com
export ZION_RUNTIME_TOOL_MODE=node
export ZION_RUNTIME_ENGINE=openai
export ZION_RUNTIME_MODEL_PROFILE=deepseek-v4-flash
export ZION_RUNTIME_DEEPSEEK_API_KEY='<secret-manager-injected-value>'
export ZION_RUNTIME_EXTERNAL_PLUGIN_ROOT=/var/lib/zion-next/plugins
export ZION_RUNTIME_EXTERNAL_PLUGINS=dev.identity

npm run runtime:serve -- \
  --host 127.0.0.1 \
  --port 8766 \
  --workbench-dist ./dist \
  --runtime-plugins dev.session-manager,dev.skills,dev.tools,dev.plugins,dev.terminal-manager,dev.identity
```

保持 Runtime 监听 `127.0.0.1`。不要在生产使用
`ZION_RUNTIME_ALLOW_INSECURE_REMOTE=1`。

`dev.identity` 不从仓库 `extensions/` 回退。部署 Runtime 前必须把与 Workbench
Plugin Host 相同版本的 ZIP 解包到
`/var/lib/zion-next/plugins/dev.identity`：

```bash
npm run plugin:install:runtime -- \
  --archive /tmp/dev.identity-0.1.7.zip \
  --plugin-root /var/lib/zion-next/plugins \
  --plugin-id dev.identity
```

## 3. 配置 HTTPS Gateway

以下 Caddy 配置展示路由要求，部署时替换域名和静态目录：

```caddyfile
zion.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8766

  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
  }
}
```

Caddy 会自动代理静态 Workbench、API、SSE 和 WebSocket upgrade。若使用 Nginx，
需要显式转发 `Upgrade` 和 `Connection` header，并关闭 SSE response buffering。

专用 Runtime 主机可先 dry run，再由脚本生成、备份并应用 Caddy 与 Runtime Origin
配置：

```bash
npm run deploy:configure -- \
  --mode domain \
  --domain zion.example.com \
  --public-ip <server-ip>

sudo npm run deploy:configure -- \
  --mode domain \
  --domain zion.example.com \
  --public-ip <server-ip> \
  --apply
```

Runtime 托管的 Workbench 会发送同源 `connect-src` CSP。Skills、终端管理和本地插件
开发请求通过同源 `/v1/device-services/*` 入口进入 Runtime，再由已配对 Connector
转发到本机 loopback 服务；浏览器不会直接连接 `127.0.0.1:8765/8767`。Runtime 对
这些入口按请求方法执行 `runtime.read` / `runtime.write` 校验，因此已配对的普通
Browser Client 可以使用终端、Skills 和插件能力；设备列表、配对和吊销仍只允许
Owner。Connector 只接受预定义的本地 API 白名单。

## 4. 配对首个 Owner

在 Runtime 主机执行：

```bash
npm run runtime:access -- pair create \
  --kind owner \
  --delivery cookie \
  --public-url https://zion.example.com
```

命令输出：

- 一个 5 分钟有效、单次使用的人工码；
- 一个把 256-bit secret 放在 fragment 中的配对 URL。

在目标手机或电脑打开 URL。Workbench 会在初始化前交换邀请，设置 Host-only
`Secure`、`HttpOnly`、`SameSite=Strict` Cookie，然后删除地址栏 fragment。

## 5. 配对 Resource Host

Owner 在 Workbench 中打开：

```text
设置 -> 服务 -> 设备与远程访问 -> 工具电脑 -> 生成一次性配对
```

然后在持有项目和 `local-tools` 的电脑进入项目目录，执行界面显示的命令：

```bash
cd /absolute/path/to/zion-next
npm run device:connect -- \
  --runtime-url https://zion.example.com \
  --pairing-code XXXX-XXXX-XXXX
```

Connector 只向公网发起 HTTPS 请求，并把 Device credential 保存到 macOS Keychain
或权限为 `0600` 的平台凭证文件。`local-tools` 继续只监听 loopback。
默认使用发起 npm 命令时的目录作为 workspace，自动推导 project/resource ID，并
自动复用或创建对应的本地 terminal session。连接成功后，设置页会显示
`在线 · <数量> tools`。

已有 Connector 从旧 Origin 迁移时，先由 Owner 吊销旧 Resource Device 并创建新的
“工具电脑”配对码，再运行：

```bash
npm run device:migrate-origin -- \
  --runtime-url https://zion.example.com
```

迁移脚本会从隐藏提示读取配对码，不应把配对码写进命令行历史。

只有需要覆盖自动推导结果时才使用高级参数：

```bash
npm run device:connect -- \
  --runtime-url https://zion.example.com \
  --node-id node:office-mac \
  --project-id zion-next \
  --resource-id workspace:zion-next \
  --workspace-root /absolute/path/to/zion-next \
  --additional-roots ~/.zion-next/skills,~/.zion-next/memory \
  --terminal-sessions <local-tools-session-id>
```

macOS 常驻运行可基于
`deploy/launchd/dev.zion.device-connector.plist.example` 创建 LaunchAgent。
Credential 仍从登录用户 Keychain 读取，不写入 plist。

## 6. 验收

未认证请求必须失败：

```bash
curl -i https://zion.example.com/v1/models
# HTTP/2 401
```

公开 health 只返回最小信息：

```bash
curl -s https://zion.example.com/health
# {"ok":true,"service":"zion-runtime","authRequired":true}
```

检查已配对设备：

```bash
npm run runtime:access -- devices list
```

吊销丢失设备：

```bash
npm run runtime:access -- devices revoke node:office-mac
```

吊销后新的 HTTP、poll 和 Yjs 消息会被拒绝。已经交付给 Resource Host 的单次调用仍由
invocation lease、cancel 和 receipt 语义约束。WebRTC PTY 通道最长存活 5 分钟，
到期后必须重新通过 Runtime 鉴权协商；Resource credential 被拒绝时 Connector 会
立即关闭全部通道。

远程终端支持会话发现、创建、切换、关闭和 PTY 交互。Runtime 负责认证并通过
Node Broker 交换 WebRTC SDP；协商成功后，浏览器与 Connector 使用加密 DataChannel
直传 PTY 字节。若 ICE/STUN 无法建立连接，Workbench 自动回退同源 HTTP 长轮询，
由 Runtime 转发到 Connector。不能用放宽 CSP 或让公网页面直接请求 `localhost`
代替这两条受认证的通道。

同名活动 `deviceId` 不允许被新邀请覆盖。设备丢失 credential 或需要重新绑定时，
先由 Owner 吊销旧设备，再创建新的单次邀请。

## 当前边界

这个阶段已经适合单用户私有部署和真实跨设备验证，但还不是多租户公共 SaaS：

- 没有账号恢复、多 Owner 和组织权限；
- 没有 Device 持钥 proof，Resource credential 仍是高熵 opaque bearer；
- 没有公网 durable mailbox，Runtime 重启会中断在途远程调用；
- Device-side receipt 尚未跨进程持久化；
- `write`、`Bash` 和外部副作用还缺独立远程 Approval Provider；
- Relay 终止 TLS 时可以看到协议明文，端到端加密是后续阶段。
