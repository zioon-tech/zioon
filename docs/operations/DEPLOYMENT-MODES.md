# Zion 部署模式指南

本文是部署入口。先选择模式，再执行对应流程。Runtime 在所有生产模式下都只监听
loopback；公网访问统一由 HTTPS Gateway 提供。

## 1. 选择模式

| 场景 | 模式 | 公网基础设施 | 入口 |
| --- | --- | --- | --- |
| 只在当前电脑开发和使用 | `local` | 无 | `http://127.0.0.1` |
| 有公网服务器和 IP，暂时没有域名 | `ip` | ECS/VPS、Caddy、开放端口 | `sslip.io/nip.io:8443` |
| 有公网服务器和正式域名 | `domain` | ECS/VPS、DNS、Caddy、开放端口 | `https://<domain>` |

快速查看某种模式的配置计划：

```bash
npm run deploy:configure -- --mode local

npm run deploy:configure -- \
  --mode ip \
  --public-ip 203.0.113.10

npm run deploy:configure -- \
  --mode domain \
  --domain runtime.example.com \
  --public-ip 203.0.113.10
```

上述命令默认只是 dry run，不修改系统。只有显式增加 `--apply` 才会写入服务器配置。

## 2. 模式 A：单机

适用于开发、调试或只在当前电脑使用。无需域名、DNS、Caddy、TLS、安全组或
Device Connector。

仅启动开发页面：

```bash
npm install
npm run dev
```

需要在本机验证 Runtime、访问控制和移动端时：

```bash
npm run remote:start -- --local
```

该模式只允许当前电脑访问。不要把 Runtime 改为监听 `0.0.0.0`。

## 3. 模式 B：只有公网 IP

浏览器 HTTPS 不能直接依赖裸 IP 自动签发证书，因此使用映射到该 IP 的
`sslip.io`/`nip.io` 主机名：

```text
Browser:   https://203-0-113-10.sslip.io:8443
Connector: https://203-0-113-10.nip.io:8443
Runtime:   http://127.0.0.1:8766
```

### 3.1 云端准备

1. 在安全组中开放 TCP `80` 和 `8443`。
2. 安装 Node.js、Caddy，并按
   [单租户远程部署](../architecture/REMOTE-SINGLE-TENANT-DEPLOYMENT.md)
   安装 Runtime 与 systemd unit。
3. 在服务器仓库目录执行 dry run：

```bash
npm run deploy:configure -- \
  --mode ip \
  --public-ip 203.0.113.10
```

4. 确认输出后，以 root 应用：

```bash
sudo npm run deploy:configure -- \
  --mode ip \
  --public-ip 203.0.113.10 \
  --apply
```

脚本会：

- 生成并校验 Caddy 配置；
- 保持 Runtime 监听 `127.0.0.1:8766`；
- 更新 `ZION_RUNTIME_PUBLIC_URL` 和 `ZION_RUNTIME_ALLOWED_ORIGINS`；
- 备份原配置；
- reload Caddy、restart Runtime，并检查本机 `/health`。

### 3.2 首次配对

在 Runtime 主机创建首个 Owner：

```bash
sudo -u zion env \
  PATH=/usr/local/bin:/usr/bin:/bin \
  ZION_DATABASE_URL="$ZION_DATABASE_URL" \
  ZION_RUNTIME_PUBLIC_URL=https://203-0-113-10.sslip.io:8443 \
  npm run runtime:access -- \
  pair create --kind owner --delivery cookie
```

打开输出的 URL 或输入一次性代码。随后在 Workbench 的
“设置 → 服务 → 设备与远程访问”创建“工具电脑”配对码，并在拥有项目文件的电脑运行：

```bash
npm run device:connect -- \
  --runtime-url https://203-0-113-10.nip.io:8443 \
  --pairing-code XXXX-XXXX-XXXX
```

## 4. 模式 C：正式域名

推荐用于长期远程访问：

```text
Browser:   https://runtime.example.com
Connector: https://runtime.example.com
Runtime:   http://127.0.0.1:8766
```

### 4.1 DNS 和网络

1. 添加 A 记录：`runtime.example.com -> <服务器公网 IPv4>`。
2. 等待权威 DNS 和公共递归 DNS 都返回目标 IP。
3. 在安全组中开放 TCP `80` 和 `443`。
4. 中国内地服务器必须完成 ICP 备案；更换为非标准端口不能替代备案。

验证 DNS：

```bash
dig +short runtime.example.com A
```

### 4.2 新部署

在服务器仓库目录先 dry run：

```bash
npm run deploy:configure -- \
  --mode domain \
  --domain runtime.example.com \
  --public-ip 203.0.113.10
```

确认后应用：

```bash
sudo npm run deploy:configure -- \
  --mode domain \
  --domain runtime.example.com \
  --public-ip 203.0.113.10 \
  --apply
```

`--apply` 会在写入前校验域名 A 记录。确需先配置服务器再添加 DNS 时，可显式增加
`--skip-dns-check`，但证书要等 DNS 生效后才能签发。

### 4.3 从 IP 模式迁移

迁移期间保留旧 Origin，避免现有 Browser 和 Connector 同时失效：

```bash
sudo npm run deploy:configure -- \
  --mode domain \
  --domain runtime.example.com \
  --public-ip 203.0.113.10 \
  --legacy-origin https://203-0-113-10.sslip.io:8443 \
  --legacy-origin https://203-0-113-10.nip.io:8443 \
  --apply
```

验证新域名后：

1. 在旧或新 Owner Workbench 中创建新的 Browser 配对码。
2. 在新域名完成 Browser 配对。
3. 吊销旧 Resource Device，创建新的“工具电脑”配对码。
4. 在工具电脑运行：

```bash
npm run device:migrate-origin -- \
  --runtime-url https://runtime.example.com
```

脚本会隐藏读取配对码、备份并更新 LaunchAgent plist、交换并保存新 Keychain
credential、重启 Connector，并在成功后删除旧 Origin 的 Keychain credential。

迁移前可检查计划：

```bash
npm run device:migrate-origin -- \
  --runtime-url https://runtime.example.com \
  --dry-run
```

如果新 Origin credential 已经写入 Keychain，但之前的手工操作在 plist 中留下了重复
URL，可直接修复并重载，无需再次配对：

```bash
npm run device:migrate-origin -- \
  --runtime-url https://runtime.example.com \
  --repair
```

## 5. 验收

任一远程模式都必须验证：

```bash
curl -fsS https://<public-origin>/health
# {"ok":true,"service":"zion-runtime","authRequired":true}

curl -sS -o /dev/null -w '%{http_code}\n' \
  https://<public-origin>/v1/models
# 401
```

域名模式还应检查证书：

```bash
echo | openssl s_client \
  -connect runtime.example.com:443 \
  -servername runtime.example.com 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

最后在已配对 Workbench 中确认：

- 会话列表可读取；
- 模型对话可流式返回；
- 工具电脑在线；
- Skills 和插件可用；
- 终端可连接。

## 6. 安全与回滚

- 不把 AK/SK、模型 Key、配对码或 bearer credential 写入仓库和 shell history。
- `deploy:configure -- --apply` 只适用于由 Zion 独占 Caddyfile 的服务器。
- 脚本修改系统配置前会创建 `.before-zion-<timestamp>` 备份。
- Connector credential 与 Runtime Origin 绑定，更换域名必须重新配对。
- 旧 Origin 至少保留到所有 Browser 和 Connector 完成迁移并通过验收。
- Runtime 始终监听 `127.0.0.1:8766`，禁止直接暴露公网。

当前生产实例的具体地址、服务路径和版本基线见
[远程部署运维交接](./REMOTE-DEPLOYMENT-RUNBOOK.md)。
