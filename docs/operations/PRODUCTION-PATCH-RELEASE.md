# Production Patch Release

本文记录 Zion 单用户生产环境的日常小步发布流程。适用于源码补丁、Workbench
`dist/` 静态产物、文档补丁，以及这几类变更的组合。

生产资产、目标 ECS 和安全规则见
[REMOTE-DEPLOYMENT-RUNBOOK.md](./REMOTE-DEPLOYMENT-RUNBOOK.md)。

## 适用范围

使用 `npm run deploy:patch`：

- 修改 `/opt/zion-next` 下的少量源码或测试文件；
- 替换 `/var/lib/zion-next/workbench-dist`；
- 不需要改 Caddy、数据库 schema、模型凭据或插件数据迁移；
- 可选同步安装 `deploy/systemd/*.service` 模板和 `dev.identity` Runtime 插件 zip；
- 可以接受脚本在远端创建 `/var/lib/zion-next/backups/<release>` 备份。

不要用这个脚本：

- 首次部署或重装服务器；
- 修改 `/etc/zion-next/*.env` 或 `/etc/caddy/Caddyfile`；
- 发布 `dev.identity` 之外的外部 Runtime 插件 zip，或执行插件数据迁移；
- 需要 PostgreSQL 结构迁移或批量数据修复。

这些场景仍按完整运维 runbook 单独处理。

## 一条命令发布

先在本地完成必要测试和构建：

```bash
npm run build:all
npm run deploy:patch -- \
  --release <release-id> \
  --dist \
  --files <path> \
  --files <path>
```

上面默认只是 dry run：生成 `.deploy-tmp/<release-id>/` 下的源码包、dist 包和远端脚本，
不会连接生产。

确认输出后执行生产发布：

```bash
printf '%s\n' "$ALIYUN_ECS_CREDENTIAL" | npm run deploy:patch -- \
  --execute \
  --release <release-id> \
  --dist \
  --files <path> \
  --files <path>
```

`ALIYUN_ECS_CREDENTIAL` 是当次临时 AK/SK 的拼接值：

```text
<AccessKeyId><AccessKeySecret>
```

也可以使用分开的环境变量：

```bash
ALIYUN_ACCESS_KEY_ID=<id> \
ALIYUN_ACCESS_KEY_SECRET=<secret> \
npm run deploy:patch -- --execute ...
```

不要把 AK/SK 写入文档、脚本、`.env`、shell history 或发布包。

## 常用发布类型

### Workbench 前端和源码补丁

```bash
npm run deploy:patch -- \
  --execute \
  --build \
  --dist \
  --identity-plugin .deploy-tmp/<release-id>/identity/dev.identity-0.1.10.zip \
  --install-systemd-units \
  --files extensions/dev.skills/skills-runtime-state.js \
  --files apps/runtime/src/skills-catalog-http-handler.mjs \
  --files tests/skills-runtime-state.test.js \
  --files apps/runtime/tests/skills-catalog-http-handler.test.js \
  --require-marker runtime.skillsSourceFingerprint \
  --require-marker runtime.skillsEnabledFingerprint \
  --forbid-marker workbench-state/kv
```

`--build` 配合 `--dist` 会先运行 `npm run build:all`，确保桌面和 `/mobile/` 产物
同源。`--dist` 会打包当前 `dist/` 并在远端原子替换
`/var/lib/zion-next/workbench-dist`。

### 纯文档补丁

```bash
npm run deploy:patch -- \
  --execute \
  --no-restart \
  --files docs/operations/HANDOFF-SKILLS-SYNC-20260915.md
```

`--no-restart` 适合纯文档、测试样例或不会被运行中服务加载的文件。

### 文件清单发布

变更较多时先写文件清单：

```text
# /tmp/zion-release-files.txt
extensions/dev.skills/skills-runtime-state.js
apps/runtime/src/skills-catalog-http-handler.mjs
tests/skills-runtime-state.test.js
apps/runtime/tests/skills-catalog-http-handler.test.js
```

再发布：

```bash
npm run deploy:patch -- \
  --execute \
  --build \
  --dist \
  --files-from /tmp/zion-release-files.txt
```

## 脚本会做什么

本地：

- 校验文件都在仓库内且是普通文件；
- 可选运行 `--test '<command>'`；
- 可选运行构建：带 `--dist` 时运行 `npm run build:all`，否则运行 `npm run build`；
- 用 `COPYFILE_DISABLE=1 tar --no-xattrs` 打包，避免 macOS AppleDouble 文件；
- 生成 `.deploy-tmp/<release>/remote-deploy.sh`；
- dry run 时只生成包，不连接生产。

远端：

- 通过 ECS Cloud Assistant 创建 `/tmp/zion-<release>`；
- 分片上传发布包；
- 重组并校验 sha256；
- 备份被覆盖的源码文件；
- 如包含 `--dist`，备份完整 Workbench dist 并先组装 next 目录；
- 如包含 `--identity-plugin`，备份并安装 `/var/lib/zion-next/plugins/dev.identity`；
- 如包含 `--install-systemd-units`，备份并安装清单里的 `deploy/systemd/*.service`；
- 对 `.js` 和 `.mjs` 源文件执行 `node --check`；
- 按需停止并重启 `zion-runtime`；
- 检查本机 `/health`、公网 `/health` 和匿名 `/v1/skills/snapshot` 为 `401`；
- 确认 `caddy`、`zion-local-tools`、`zion-plugin-host`、
  `zion-cloud-device-connector` 都是 active；
- 成功后清理远端 staging，保留 `/var/lib/zion-next/backups/<release>`。

失败时：

- 恢复已备份源码；
- 如果 dist 已切换，恢复旧 dist；
- 如果 Identity 插件已安装，恢复旧插件目录；
- 如果 systemd unit 已安装，恢复旧 unit 并 `daemon-reload`；
- 重启 `zion-runtime`；
- 返回非零退出码。

## 发布后人工确认

```bash
curl -k -fsS https://47-101-150-8.nip.io:8443/health
curl -k -sS -o /dev/null -w '%{http_code}\n' \
  https://47-101-150-8.nip.io:8443/v1/skills/snapshot
```

预期：

```text
/health -> 200
/v1/skills/snapshot without auth -> 401
```

如果发布了前端 dist，继续检查：

```bash
curl -k -fsS https://47-101-150-8.nip.io:8443/ \
  | rg -o 'assets/extensions/dev\.skills/main-[^"]+\.js'
```

浏览器里旧 tab 可能还受 Service Worker 缓存影响。先完全关闭页面重新打开；必要时连续
刷新两次。不要优先清除全部站点数据，因为这会删除配对 Cookie。

## 回滚

每次发布都会保留：

```text
/var/lib/zion-next/backups/<release>/files
/var/lib/zion-next/backups/<release>/workbench-dist
```

手工回滚源码：

```bash
sudo systemctl stop zion-runtime
sudo tar -C /var/lib/zion-next/backups/<release>/files -cf - . \
  | sudo tar -C /opt/zion-next -xf -
sudo chown -R zion:zion /opt/zion-next
sudo systemctl start zion-runtime
```

手工回滚 dist：

```bash
sudo systemctl stop zion-runtime
sudo rm -rf /var/lib/zion-next/workbench-dist
sudo cp -a /var/lib/zion-next/backups/<release>/workbench-dist \
  /var/lib/zion-next/workbench-dist
sudo chown -R zion:zion /var/lib/zion-next/workbench-dist
sudo systemctl start zion-runtime
```

回滚后仍要重新跑 `/health` 和匿名 `401` 检查。
