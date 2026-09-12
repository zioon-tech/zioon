# Zion 远程部署运维交接

最后核对时间：2026-09-10

本文记录当前实际运行的单用户远程环境，供后续 Agent 排障、发布和迁移使用。
通用部署原理与从零安装步骤见
[REMOTE-SINGLE-TENANT-DEPLOYMENT.md](../architecture/REMOTE-SINGLE-TENANT-DEPLOYMENT.md)。
面向用户的单机、IP-only 和正式域名流程见
[DEPLOYMENT-MODES.md](./DEPLOYMENT-MODES.md)。

## 1. 安全规则

- 本文和 Git 仓库中不得写入任何 API Key、AccessKey Secret、Bearer Token、Cookie、
  配对 secret 或完整凭据文件。
- Agent 可以记录 secret 的用途、引用名、保存位置、权限、持有人和轮换方法，但不能
  记录 secret 值。
- 不要执行会把 secret 输出到聊天、日志或命令历史的命令，例如直接 `cat`
  `/etc/zion-next/runtime.env`、`credentials.json` 或 Keychain 项。
- 临时阿里云 AK/SK 必须由 Owner 针对当次操作明确授权；使用权限为 `0600` 的临时
  配置，完成后删除整个临时目录并确认不存在。
- Owner/Client/Resource 配对码有效期短且只能使用一次，不应作为长期凭据保存。
- 任何复制到备份介质的 `credentials.json` 或 SQLite 数据库都按 secret 处理，必须
  加密并限制访问。

## 2. 当前资产

| 项目 | 当前值 |
| --- | --- |
| 云厂商 | 阿里云 ECS |
| Region | `cn-shanghai` |
| Instance ID | `i-uf6dkbxlai8d1zr81859` |
| 公网 IP | `47.101.150.8` |
| 用户访问地址 | `https://runtime.zioon.tech` |
| 旧 Browser 地址（迁移期保留） | `https://47-101-150-8.sslip.io:8443` |
| Connector 地址 | `https://runtime.zioon.tech` |
| Runtime 监听 | `127.0.0.1:8766` |
| HTTPS Gateway | Caddy |
| Runtime 服务 | systemd `zion-runtime.service` |
| 服务器代码 | `/opt/zion-next` |
| Workbench 静态文件 | `/var/lib/zion-next/workbench-dist` |
| Runtime 数据库 | `/var/lib/zion-next/runtime.sqlite3` |
| Runtime 模型凭据 | `/var/lib/zion-next/credentials.json` |
| Runtime 环境文件 | `/etc/zion-next/runtime.env` |
| Caddy 配置 | `/etc/caddy/Caddyfile` |

2026-09-10 已启用 `runtime.zioon.tech:443`：DNS A 记录指向 `47.101.150.8`，
Caddy 已取得 Let's Encrypt 证书，安全组的 `443/443` 已放行，
`ZION_RUNTIME_PUBLIC_URL` 已切换到新域名。Runtime allowed origins 仍包含新旧三个
Origin，主 Owner Browser 和 Device Connector 已在新 Origin 重新配对。旧
`sslip.io/nip.io:8443` 暂时继续服务尚未迁移的 Browser Client；确认其他客户端均已
迁移前不要删除旧站点。

当前公开健康检查：

```bash
curl -fsS https://runtime.zioon.tech/health
# {"ok":true,"service":"zion-runtime","authRequired":true}

curl -sS -o /dev/null -w '%{http_code}\n' \
  https://runtime.zioon.tech/v1/models
# 401
```

`/health` 公开但只返回最小状态；业务接口匿名访问必须返回 `401`。

## 3. 当前拓扑

```text
Phone/Desktop Browser
  -> HTTPS :443 or :8443 (Caddy)
    -> Runtime 127.0.0.1:8766
      -> SQLite and model credential store
      -> authenticated Node Broker
        <- outbound HTTPS long poll from Device Connector

Office Mac
  -> Device Connector (LaunchAgent)
    -> local-tools 127.0.0.1:8765
    -> plugin service 127.0.0.1:8767
    -> WebRTC DataChannel for interactive PTY when ICE succeeds
```

Runtime 负责模型调用、会话、鉴权、信令和 HTTP relay。Connector 只建立出站连接；
办公 Mac 不开放公网入站端口。PTY 优先使用浏览器与 Connector 的 WebRTC
DataChannel，失败时自动回退 Runtime HTTP relay。

## 4. 线上版本基线

当前本地开发基线：

```text
worktree: /Users/bytedance/Downloads/zion-next/.worktrees/core-observability
branch:   feature/core-observability
HEAD:     76a9d45bc98370b181dd93bd0df64dca06bc46f5
Node:     v22.18.0
npm:      10.9.3
```

当前线上 Workbench：

```text
desktop index SHA-256:
508cb1c7a7636d548c1122bbdb23399e4943884dad80cfb39245242fde7dff71

mobile index SHA-256:
6dc63f1e8e01bf84c571fa36d66a8b5411f1370c221b02464eff358049608177

root Service Worker SHA-256:
b7c5af0b23edc94a3239fcfb8327a3d33a54e946dcf46a8a140529bca52615b4

Service Worker client refresh SHA-256:
27857522323ce143a0c4f53a7baf621327ce35e481dcca688bff969b68d86111

terminal bundle:
assets/extensions/dev.terminal-enhanced/main-yMeVDA1X.js
```

2026-09-08 发布前的 Runtime SQLite 备份：

```text
/var/lib/zion-next/backups/runtime-20260907T192642Z.sqlite3
```

当前办公 Mac Plugin Host 已发布的外迁 Identity 插件：

```text
development source: extensions/dev.identity
local Runtime package target:
/Users/bytedance/.zion-next/plugins/dev.identity
published package:
/Users/bytedance/.zion-local-tools/plugins/dev.identity/dev.identity-0.1.7.zip
version: 0.1.7
ZIP SHA-256:
45ade805ee163837039b8345e42a362a07c94dd32eb003b889713c072250d0c6
```

ECS Runtime 外部插件目录为 `/var/lib/zion-next/plugins`。`dev.identity`
采用 external-only 策略；该目录缺包时 Runtime 必须报告插件失败，不能回退到
`/opt/zion-next/extensions/dev.identity`。截至 2026-09-09，本机 Plugin Host 已更新
到 `0.1.7`，ECS 端仍需在获得当次阿里云授权后部署并验证。

重要：当前线上是 `feature/core-observability` 未提交工作树的构建/源码快照，不是仅由
上述 `HEAD` 可重现的发布。后续 Agent 部署前必须检查 `git status` 和
`git diff --check`，不得用 `git archive HEAD` 覆盖线上新增功能。

## 5. 云端服务

systemd 单元模板位于
[`deploy/systemd/zion-runtime.service`](../../deploy/systemd/zion-runtime.service)。
实际服务使用：

```text
user/group: zion:zion
working directory: /opt/zion-next
database: /var/lib/zion-next/runtime.sqlite3
workbench dist: /var/lib/zion-next/workbench-dist
runtime plugins: dev.session-manager,dev.skills,dev.tools,dev.plugins,
                 dev.terminal-manager,dev.identity,dev.memory,dev.agents,
                 dev.scheduler,dev.langchain-chat,dev.mail,dev.context-compression
engine: openai
tool mode: node
access control: enabled
identity memory root: /Users/bytedance/.zion-next/memory
external Runtime plugin root: /var/lib/zion-next/plugins
```

远程 Runtime 的 Identity 文件实际位于配对 Device，而不在 ECS 用户目录。必须在
`/etc/zion-next/runtime.env` 中显式配置：

```bash
ZION_IDENTITY_MEMORY_ROOT=/Users/bytedance/.zion-next/memory
```

不要依赖 Runtime 服务用户的 `HOME`；否则 post-processor 会错误访问
`/home/zion/.zion-next/memory`，并被 Device 访问策略拒绝。

登录服务器后常用命令：

```bash
sudo systemctl status zion-runtime --no-pager
sudo journalctl -u zion-runtime -n 200 --no-pager
sudo systemctl restart zion-runtime

sudo systemctl status caddy --no-pager
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

不要让 Runtime 监听公网地址，也不要设置
`ZION_RUNTIME_ALLOW_INSECURE_REMOTE=1`。

## 6. 办公 Mac 服务

### Device Connector

```text
LaunchAgent: ~/Library/LaunchAgents/dev.zion.device-connector.plist
label:       dev.zion.device-connector
nodeId:      node:jx3wjqj1hy
runtime:     https://runtime.zioon.tech
workspace:   /Users/bytedance/Downloads/zion-next/.worktrees/core-observability
stdout:      ~/Library/Logs/Zion/device-connector.log
stderr:      ~/Library/Logs/Zion/device-connector-error.log
access:      ~/.zion-next/device-access.json
```

检查和重启：

```bash
launchctl print gui/$(id -u)/dev.zion.device-connector
tail -n 100 ~/Library/Logs/Zion/device-connector-error.log

launchctl kickstart -k gui/$(id -u)/dev.zion.device-connector
```

LaunchAgent 中不含 Resource credential。Connector 从 macOS Keychain 读取：

```text
service: dev.zion.device-connector
account: https://runtime.zioon.tech|node:jx3wjqj1hy
```

只检查条目是否存在，不读取值：

```bash
security find-generic-password \
  -s dev.zion.device-connector \
  -a 'https://runtime.zioon.tech|node:jx3wjqj1hy' \
  >/dev/null
```

默认授权 workspace、`~/.zion-next/skills` 和 `~/.zion-next/memory`。Owner 可在
“设置 -> 服务 -> 设备与远程访问 -> Agent 项目访问”切换当前工作区、所有已登记项目、
指定目录或用户目录范围。策略写入本机 `~/.zion-next/device-access.json` 并热生效；
LaunchAgent 的 `ZION_NODE_ADDITIONAL_ROOTS` 只用于首次启动迁移。

当前办公 Mac 使用 `registered-projects`：Connector 从活跃 local/SSH terminal
workspace 自动发现项目，并优先提升到最近的 Git 根。`~/.ssh`、`~/.gnupg`、
`~/.aws`、`~/.kube`、Keychains 和浏览器 Profile 等敏感目录仍需 Owner 单独批准。

后续再次更换 Runtime Origin 时，不要手工编辑 plist 和复制 Keychain credential。
先由 Owner 吊销旧 Resource Device、创建新的“工具电脑”配对码，再运行：

```bash
npm run device:migrate-origin -- --runtime-url https://<new-runtime-domain>
```

### local-tools 和 plugin service

```text
repository:     /Users/bytedance/Downloads/zion-local-tools
local-tools:    .venv/bin/python run.py                 -> 127.0.0.1:8765
plugin service: .venv/bin/python run_plugin_host.py     -> 127.0.0.1:8767
```

健康检查：

```bash
curl -fsS http://127.0.0.1:8765/health
curl -fsS http://127.0.0.1:8767/health
lsof -nP -iTCP:8765 -iTCP:8767 -sTCP:LISTEN
```

当前这两个 Python 服务由本地终端启动，并没有 LaunchAgent/systemd 守护。关闭远程
Workbench 网页不影响它们，但退出承载进程的本地终端、Trae、用户会话或重启 Mac
后可能停止。Connector 虽会继续重启，但没有 `8765/8767` 时无法提供工具和插件。
这是当前最重要的运维缺口。

## 7. Credential 和 Secret 清单

| Secret | 用途 | 保存位置 | 当前状态/处理 |
| --- | --- | --- | --- |
| 阿里云 RAM AK/SK | Workbench CLI 管理 ECS | 不在仓库；仅当次 `/tmp` 配置 | 2026-09-10 临时配置已删除；凭据曾在会话中提供，必须轮换 |
| Cloudflare API Token | 早期 Pages/Tunnel 试验 | 不在仓库，当前部署不使用 | 建议在 Cloudflare 后台吊销或轮换 |
| DeepSeek API Key | Runtime 模型请求 | Runtime `credentials.json` 中的 `model.deepseek`，或受控环境变量 | 只通过 `credentialConfigured` 检查，不读取明文 |
| Owner/Client Cookie | 浏览器访问 Runtime | 浏览器 Host-only `Secure`、`HttpOnly` Cookie | JavaScript 和文档不可读取；按设备吊销 |
| Resource credential | Connector 注册和轮询 | macOS Keychain `dev.zion.device-connector` | 已存在；绑定 Runtime Origin 和 `nodeId` |
| Access credential 摘要 | 校验已配对设备 | `/var/lib/zion-next/runtime.sqlite3` | SQLite 只保存摘要、状态和设备绑定 |
| 一次性配对 secret | 创建设备凭据 | 短时邀请；服务端只存摘要 | 使用一次或过期后失效 |
| TLS 私钥 | Caddy HTTPS | Caddy 数据目录 | 由 Caddy 管理，不复制到仓库 |

模型 Profile 的公开标识是 `deepseek-v4-flash`，credential reference 是
`model.deepseek`。API 只应返回 `credentialConfigured: true/false`，绝不能返回 key。

安全查看 Runtime 配置项名称：

```bash
sudo sed -E 's/^([A-Z0-9_]+)=.*$/\1=<redacted>/' \
  /etc/zion-next/runtime.env
sudo stat -c '%A %U:%G %n' \
  /etc/zion-next/runtime.env \
  /var/lib/zion-next/credentials.json \
  /var/lib/zion-next/runtime.sqlite3
```

推荐权限：

```text
/etc/zion-next/runtime.env          root:root 0600
/var/lib/zion-next/credentials.json zion:zion 0600
/var/lib/zion-next/runtime.sqlite3  zion:zion 0600
```

如果需要轮换模型 Key，优先在 Workbench 模型设置中重新提交；Runtime 会覆盖
`model.deepseek`，浏览器不会获得旧值或新值。若改用环境变量，则把
`ZION_RUNTIME_DEEPSEEK_API_KEY` 放入受保护的 Runtime 环境文件或云端 Secret
Manager，随后重启 Runtime。

## 8. 阿里云管理入口

直接 SSH 曾返回 `Permission denied (publickey,...)`。当前可用管理路径是阿里云
Workbench CLI：

```text
Region:      cn-shanghai
Instance ID: i-uf6dkbxlai8d1zr81859
```

Agent 操作要求：

1. 向 Owner 说明 AK/SK 将短暂进入本机进程内存和权限为 `0600` 的临时配置。
2. 获得当次明确授权后，使用独立临时目录，例如
   `/tmp/zion-workbench-home` 和 `/tmp/zion-workbench-cli`。
3. 通过 Workbench CLI 执行 ECS 命令或上传文件。
4. 不把 AK/SK 放入 shell history、Git、日志、文档或命令输出。
5. 完成后删除临时 HOME、CLI 和上传到服务器 `/tmp` 的发布文件。
6. 确认临时目录不存在，再报告部署完成。

Workbench CLI 安装入口：

```text
https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh
```

仓库和本机当前不保留阿里云 AK/SK；后续 Agent 无法从本文恢复它们，这是有意的。
既有 RAM 用户和自定义策略名称未记录，后续不能假设其权限范围；重新授权时应在阿里云
控制台核对并使用满足 ECS Workbench 操作的最小权限。

2026-09-10 验证的 RAM 用户 `zion-test` 可读取目标 ECS，并可通过 Workbench CLI
执行实例命令，但调用 Alidns `DescribeDomainRecords` 返回 `403 Forbidden.RAM`。
自动管理 `zioon.tech` 前必须补充仅限目标域名的最小 Alidns 权限；不要因此扩大 ECS
或其他云资源权限。

## 9. 发布流程

### 发布前

```bash
cd /Users/bytedance/Downloads/zion-next/.worktrees/core-observability
git status --short
git diff --check
npm ci
npm run build
npm run build:mobile
npm run plugin:package:identity
npm run runtime:test
```

根据改动范围补跑 Workbench 测试。当前源码依赖 `werift@0.24.4`；服务器安装生产依赖
时必须保留它：

```bash
npm install --omit=dev --no-audit --no-fund
test -d node_modules/werift
```

### 发布到服务器

1. 将源码、`dist/` 和 `dev.identity-0.1.7.zip` 分别上传到服务器 `/tmp`
   下的新目录。
2. 不要原地覆盖正在服务的 `workbench-dist`；先组装 next 目录。
3. 保留 Runtime SQLite 和 credential store，不要随源码包覆盖。
4. 将源码安装到 `/opt/zion-next`，静态文件原子切换到
   `/var/lib/zion-next/workbench-dist`。
5. 发布后同时验证桌面入口 `/` 与独立移动入口 `/mobile/`；两者共享同一 Runtime
   Cookie 与 `/v1/*` API，但使用不同前端 bundle。
6. 校正 owner 为 `zion:zion`。
7. 在重启 Runtime 前原子安装外部 Identity 包：

   ```bash
   sudo -u zion npm run plugin:install:runtime -- \
     --archive /tmp/dev.identity-0.1.7.zip \
     --plugin-root /var/lib/zion-next/plugins \
     --plugin-id dev.identity
   ```

8. 安装新版 systemd unit，确认包含
   `--external-plugin-root /var/lib/zion-next/plugins` 和
   `--external-runtime-plugins dev.identity`。
9. 重启 `zion-runtime`，Caddy 配置未变时无需重启 Caddy。
10. 删除服务器和本机临时发布文件。

部署包不得包含：

```text
.git/
node_modules/（应在服务器重新安装）
.env
credentials.json
runtime.sqlite3
个人 Keychain 或 Workbench CLI 配置
```

### 发布后

```bash
curl -fsS https://runtime.zioon.tech/health
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://runtime.zioon.tech/v1/models
```

还应使用已配对浏览器验证：

- 会话列表可读取；
- 在至少 `320x568` 和 `393x852` 两种移动视口确认四项底栏完整可见，列表可独立滚动且
  底栏位置不随内容滚动；iOS Safari 或内嵌 WebView 需额外检查地址栏收起和键盘弹出；
- DeepSeek 对话可流式返回；
- Skills 列表可见；
- `/health` 中 `dev.identity` 为 `version=0.1.7`、`origin=external`、
  `status=active`，且 `postProcessorIds` 包含 `dev.identity.biography`；
- 完成一次正常会话后，“LLM 请求”出现
  `source=identity-biography`、`operation=biography-distillation`；
- Identity Biography 可读取；
- 终端显示“WebRTC 直连”，并能输入、调整大小和关闭；
- 模拟 ICE 失败时显示“Runtime 中转”且仍可操作。

PWA 更新后旧 tab 可能仍使用上一版 Service Worker。完全关闭页面再重新打开；必要时
连续刷新两次。不要用清除全部站点数据作为首选，因为这会同时删除浏览器配对 Cookie。

Desktop PWA 的根作用域会覆盖整个 Origin，因此根 `vite.config.ts` 的 Workbox 配置
必须保留：

```ts
importScripts: ["/sw-client-refresh.js"],
navigateFallbackDenylist: [/^\/mobile(?:\/|$)/]
```

否则根 Service Worker 会把 `/mobile/` 导航回退到桌面 `index.html`。正确稳定态下，
桌面由 `/sw.js` 控制，移动端由 `/mobile/sw.js` 控制。2026-09-08 发布后已在全新
浏览器客户端验证 `/` 显示 `Zion Editor`，`/mobile/` 显示 `Zion Mobile`，两端均无
控制台错误。`sw-client-refresh.js` 在新根 Worker 激活时主动重新导航既有桌面 Client，
避免旧页面继续运行不兼容的 Runtime/协作协议；它明确排除 `/mobile/`。

## 10. 设备管理

Owner 可在 Workbench 的“设置 -> 服务 -> 设备与远程访问”中：

- 生成 Browser Client 配对码；
- 生成工具电脑 Resource 配对码；
- 查看设备；
- 吊销设备。
- 管理 Agent 的项目访问范围与读/写/执行权限；
- 查看自动发现的项目和实际生效目录；
- 对越界或敏感路径执行一次性批准、项目级批准或拒绝。

服务器侧使用实际 Runtime 数据库：

```bash
cd /opt/zion-next
sudo -u zion env \
  ZION_RUNTIME_DB=/var/lib/zion-next/runtime.sqlite3 \
  ZION_RUNTIME_PUBLIC_URL=https://runtime.zioon.tech \
  npm run runtime:access -- devices list
```

创建 Owner 邀请或吊销设备：

```bash
sudo -u zion env \
  ZION_RUNTIME_DB=/var/lib/zion-next/runtime.sqlite3 \
  ZION_RUNTIME_PUBLIC_URL=https://runtime.zioon.tech \
  npm run runtime:access -- pair create --kind owner --delivery cookie

sudo -u zion env \
  ZION_RUNTIME_DB=/var/lib/zion-next/runtime.sqlite3 \
  npm run runtime:access -- devices revoke <device-id>
```

Browser Client 配对码不能启动 Connector；Resource 配对码也不能登录 Workbench。

## 11. 备份和恢复

至少备份：

```text
/var/lib/zion-next/runtime.sqlite3
/var/lib/zion-next/credentials.json
/etc/zion-next/runtime.env
/etc/caddy/Caddyfile
/Users/bytedance/.zion-next/memory
/Users/bytedance/.zion-next/skills
/Users/bytedance/.zion-next/plugins
/Users/bytedance/.zion-next/device-access.json
~/Library/LaunchAgents/dev.zion.device-connector.plist
```

SQLite 备份应使用 SQLite backup API 或停服后的文件副本，避免复制到不一致状态。
包含 credentials 的备份必须加密。Keychain 中的 Resource credential不建议复制到
另一台机器；恢复后重新生成 Resource 配对并吊销旧设备更安全。

推荐恢复顺序：

1. 恢复 Runtime 数据库、credential store 和环境文件；
2. 启动 Runtime 和 Caddy；
3. 验证匿名请求仍为 `401`；
4. 启动办公 Mac 的 `8765/8767`；
5. 启动或重新配对 Connector；
6. 验证插件、Skills、模型和 WebRTC 终端。

## 12. 常见故障

### Connector 出现 `502` 或 `fetch failed`

先检查 Runtime、Caddy 和正式域名：

```bash
curl -fsS https://runtime.zioon.tech/health
sudo journalctl -u zion-runtime -n 100 --no-pager
```

短暂 `502` 可能发生在 Runtime 发布重启期间；持续出现则不是正常状态。

### 手机没有插件或 Biography 读取失败

依次检查：

```bash
curl -fsS http://127.0.0.1:8767/health
curl -fsS http://127.0.0.1:8765/health
launchctl print gui/$(id -u)/dev.zion.device-connector
```

`dev.identity` 的 UI 在每个浏览器中执行，但插件 ZIP 来自办公 Mac 的 `8767`，
Biography 数据来自该 Mac 的 `~/.zion-next/memory`。

事件蒸馏缺失时先看 Runtime 日志：

```bash
sudo journalctl -u zion-runtime -n 300 --no-pager \
  | grep -E 'runtime-plugin:dev.identity|runtime-postprocessor'
```

- 没有 `activated v... from external`：ECS 外部包未安装或未被加载；
- health 没有 `dev.identity.biography`：Runtime Entry 不完整或 Biography 被禁用；
- 有 `biography distillation started`，随后出现 `event history read failed`：
  Device Connector、Identity memory root 或目录授权有问题，模型请求尚未发出；
- `0.1.6` 及更早版本若出现 `terminal session is outside the active Device scope`，
  是蒸馏流程误把聊天 Session ID 当成终端 Session ID；升级到 `0.1.7`；
- 有 `biography distillation completed`，但面板仍无请求：检查
  `llm.request` Workbench 事件同步和页面缓存。

### 终端慢

先看终端面板连接状态：

- `WebRTC 直连`：PTY 字节不经过 Runtime；
- `Runtime 中转`：ICE/STUN 失败，使用 HTTP relay；
- `正在直连`：仍在协商。

浏览器 Network 中正常直连只会看到一次 `/pty/webrtc/offer`；出现
`/pty/relay/open` 表示已回退。

### 多台 Resource 同时在线

当前 Device Service 没有显式 `nodeId/resourceId` 选择器。无 project binding 的
请求会按 `nodeId` 排序选择第一个在线 Node，因此插件、Biography 或终端可能来自
另一台电脑。当前生产假设只有一台主要 Resource Host；扩展多设备前必须实现明确的
资源选择和会话亲和性。

## 13. 当前已知风险与下一步

- `local-tools` 和 plugin service 尚未纳入 LaunchAgent，Mac 重启后需要人工恢复。
- 当前线上来源是未提交工作树快照，应尽快形成可追踪 commit/tag。
- Runtime 的导入模型凭据仍使用服务器 `0600` 文件，长期应迁移到云 Secret Manager。
- `runtime.zioon.tech:443`、DNS、TLS、canonical URL、主 Owner Browser 和 Device
  Connector 迁移已完成；ICP备案状态仍需在阿里云控制台确认，其他 Browser Client
  迁移完成前旧 `sslip.io/nip.io:8443` 必须继续保留。
- 更换 Origin 后 Browser Cookie、PWA 和 Connector Keychain key 都不会自动迁移，
  必须让新旧域名并行并重新配对。
- 多 Resource 路由尚无显式选择器，不应把当前环境当作完整多设备产品。

## 14. Agent 接手检查表

1. 阅读本文和 ADR-0003。
2. 检查本地 `git status`，不要覆盖用户未提交修改。
3. 运行公网 `/health` 和匿名 `401` 检查。
4. 检查本机 `8765`、`8767` 和 Connector LaunchAgent。
5. 只确认 credential 是否配置，不读取或打印 secret 值。
6. 远程写操作前向 Owner 申请当次阿里云授权。
7. 发布前备份 SQLite，发布后验证模型、插件、Skills 和终端。
8. 删除所有临时凭据、CLI、归档和测试设备。
