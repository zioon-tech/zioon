# CLI 0.3.0 与 Runtime 扩展集成

本次将独立预览 CLI 和 Runtime Hook 开发线合入当前生产代码。开发与验证在 `migration/cli-hooks-20261111` 的隔离工作树中完成。

## 行为变化

- CLI：Markdown 排版、多行与中文输入、会话续接、草稿恢复、模型选择、工具状态、历史搜索、附件和截图输入。
- Runtime：统一 Hook 决策、顺序与超时；持久等待、精确 waitId 恢复及取消；HTTP 和独立脚本适配器；可靠 Webhook。
- Workbench、移动端：展示等待状态并回复恢复。官网：CLI 0.3.0、更新记录、Hook 与 Webhook 配置说明。
- SDK：导出 `resumeRun`；签名辅助函数位于 `plugin-sdk/runtime-extension-signature`。

集成保留现有生产代码的账户授权、模型元数据、扩展绑定、个人安装文件编辑及 Run outbox。数据库迁移使用 `006_runtime_webhooks.sql`，不占用已有 `005_runtime_run_outbox.sql`。

## 管理员配置

没有配置时不启用外部 Hook，也没有 Webhook 订阅。HTTP Hook 通过 `ZION_RUNTIME_HOOKS_FILE` 配置；独立脚本必须设置 `ZION_RUNTIME_ALLOW_SCRIPT_HOOKS=1`。签名密钥至少 32 字节。

Webhook 只接受 `ZION_WEBHOOK_SECRET_*`。管理员设置 `ZION_WEBHOOK_SECRET_BINDINGS`，值为 Space ID 到密钥引用数组的 JSON 映射。创建、启用、重放和每次投递都会重新验证绑定。不要把密钥值写入适配器配置、数据库订阅或版本库。

取消等待任务时，Runtime 从持久化的扩展计划构造终态通知，和等待状态 CAS、Run 事件、检查点清理在同一事务内提交。它不会重新启动暂停的工具或模型。恢复后的 `attempt.started` 作为 `run.resumed` Webhook 的事实来源，两者保留相同事件 ID。

## 验证与发布

本地完成 Runtime、Workbench、移动端、管理站、门户、插件市场、协议和 SDK 验证；官网检查包含导航、搜索、代码片段及安装包 SHA-256。新集成回归覆盖跨账户密钥引用、密钥撤销后投递与重放、暂停持久化期间取消、重启后终态 outbox、最终回复和 afterRun 尝试幂等键。

GitHub CI 增加 Linux/macOS PTY 与 Windows ConPTY 检查。三平台均验证中文多行输入、模型选择、中文附件路径、图片上传与停止；Unix 另验证草稿恢复、外部编辑器、丢失发送响应恢复与会话续接。

正式发布使用产品仓库 `Production release` 流水线，指定成功的 main 分支 `Zioon CI` run ID。各受影响组件先运行 `check-only=true`，再正式切换；部署脚本负责健康检查和失败回滚。Runtime 先于网页与官网部署，官网最后发布。

线上安装包、页面版本、资源与健康结果以及流水线链接保存在工作区 `ZIOON-RELEASE-20261111/` 的发布记录。
