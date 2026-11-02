# 从注册开始，在本地体验账号

本地体验不需要 Docker。项目提供一个仅监听 `127.0.0.1` 的轻量开发 IdP，
用标准 OIDC 连接 Zion，账号和 Runtime 数据都保存在
`.account-data/local/`。生产环境仍接入 ZITADEL 等正式 OIDC 提供方，
不会使用这个开发 IdP。

## 启动

直接启动：

```sh
cd /Users/bytedance/Downloads/zion-next/.worktrees/core-observability
npm run accounts:local -- up
```

也可以附加邮箱，仅用于预填注册表单：

```sh
npm run accounts:local -- up alice@example.test
```

命令会同时启动本地身份服务和 Zion，并打印注册链接。打开链接后：

1. 填写姓名、预填邮箱和至少 10 位密码。
2. 注册页面会直接显示仅供本地开发使用的六位验证码。
3. 输入验证码后会自动回到 Zion。全新数据目录中的第一个已验证账号会原子
   认领个人空间并成为所有者，不需要预先创建虚构 Owner。

若本地配置已经绑定 `127.0.0.1:55432` 的项目内 PostgreSQL，启动命令会先检查
并自动启动 `.account-data/postgres/data`，随后让 Runtime 使用 PostgreSQL。
数据库 URL 保存在权限为 `0600` 的 `.account-data/local/space.local.json`；
本地体验脚本不会持久化远程地址或包含密码的 URL。

运行期间按 `Ctrl-C` 会同时停止身份服务和 Zion，数据仍会保留。

如果提示缺少构建产物，先执行一次：

```sh
npm run runtime:build
npm run build:all
```

## 体验完整流程

账号管理：<http://127.0.0.1:18866/account>
工作台：<http://127.0.0.1:18866/>
手机界面：<http://127.0.0.1:18866/mobile/>

建议按顺序体验：

1. **注册和登录**：创建第一个账号，它会立即拥有可用的个人空间。
2. **邀请第二个账号**：所有者选择“成员”并生成邀请链接；在另一个浏览器
   Profile 或无痕窗口打开链接，再注册一个不同邮箱的账号并接受邀请。
3. **共享空间**：两个账号打开工作台，查看同一空间中的会话。
   默认使用 Echo 测试回复，不需要模型密钥。
4. **角色变化**：所有者把第二个账号改为“访客（只读）”。其页面最多约
   15 秒刷新，不能编辑或发起运行；后端权限立即生效。
5. **成员移除**：移除成员后，对方只能查看自己的身份或接受新邀请。
6. **独立登录**：同一账号在两个浏览器登录，只退出其中一个会话，
   另一个会话继续有效。
7. **任务授权**：发送消息或创建定时任务后，在账号页查看和撤销授权。
8. **忘记密码**：从登录页进入找回密码，本地页面显示重置验证码。

CLI Device Flow：

```sh
npm run runtime:cli -- auth login --account --url http://127.0.0.1:18866
npm run runtime:cli -- auth status --account --url http://127.0.0.1:18866
npm run runtime:cli -- auth logout --account --url http://127.0.0.1:18866
```

## 边界

- 开发 IdP 只允许绑定 loopback，不接受局域网或公网监听。
- 密码使用随机 salt 和 scrypt 保存，但此服务没有生产级防滥用、邮件投递、
  MFA、Passkey、备份和运维能力。
- 它用于验证 Zion 的注册、OIDC、邀请、角色与授权流程，不得承载真实账号。
- 正式部署仍使用 [账号与 Space 部署说明](README.md) 中的标准 OIDC 配置。
- 观测 Bash 的 Docker 沙箱是另一项可选能力；Docker 不可用时账号功能仍能
  正常使用，只读 `read/glob/grep/tree` 仍可查询授权的观测快照。
