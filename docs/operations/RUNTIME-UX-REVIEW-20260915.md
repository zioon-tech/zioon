# Runtime / Multi-Node UX Review

状态：本地实现和隔离验证完成；本轮未发布生产，未使用云凭证。

## 结论

旧实现没有保证持续跨端刷新。Workbench 和 Mobile 的 Skills 页面可以一直显示旧状态；
Workbench 对话开始前没有可取消的准备态。除了慢，还发现了选择丢失、并发受理和正文
重复写入问题。详细发现见仓库 `.reviews/runtime-ux-20260915/report.md`。

## Skills 契约

- Runtime 是全局 catalog、sources、enabled 的权威，成功返回的空快照也有效。
- 单项开关只发送 `updates: [{ id, enabled }]`，不同 ID 的操作互不覆盖；
  同 ID 最后一次提交生效，重试是幂等的。
- 源扫描与选择写入分开排队、分开确认。源不可用、transient 内容和上传中的新技能
  不能吞掉显式开关操作。
- Workbench 和 Mobile 在前台约每 3 秒（Skills 页面）或 5 秒（其他已挂载视图）刷新，
  focus/online/回前台触发刷新；后台暂停，失败退避。网络请求耗时另计。
- 刷新只有 GET，不触发扫描或写回。串行协调写入，避免旧响应覆盖新操作。
- 新对话由 Runtime 读取当前全局默认值；明确的会话覆盖（包括空列表）继续保留。
- 本地未确认意图仅存在当前页面内存里，不是持久化离线队列。
- **直接修改 Node 磁盘上的 SKILL.md 仍需源端扫描**；本轮没有引入文件 watcher。
  扫描发布完成后，其他前台客户端在刷新周期内可见。

## 对话契约

- 提交后立即显示本地准备态并占用会话；Stop 能取消准备过程，取消后可立即重试。
- 准备态是 CodeMirror 装饰，不是 Yjs 消息。恢复观察者不能接管未受理完成的本地提交。
- 服务端不同提交入口共享会话受理预约，避免异步准备期间同时受理两个 Run。
- 模型配置/目录并行读取，复用已有目录；LLM 请求详情异步补全，不阻塞正文流。
- Runtime 已合批的推理片段不再由浏览器二次缓冲。
- 新 Workbench 声明 `metadata.documentProjection.textOwner = "runtime"`。
  正文只有 Runtime 持久化；浏览器只展示未确认片段，卡片事件与正文写入权限分离。
- Runtime 在 message-complete 检查点按已提交长度追加新后缀，保留交错工具/推理标记；
  transcript reconcile 不再重复写入已经确认的正文。
- Mobile 提交中立即显示状态，离线时显示等待网络。
- Identity 复用本轮脚手架检查已读取的档案，不加跨运行缓存；常态每轮读取从 14 次降至 8 次。

## 验证

使用内存 PostgreSQL、模拟模型、隔离浏览器上下文和 loopback HTTP，不包含真实用户数据。

| 检查 | 结果 |
| --- | --- |
| Workbench 根测试全量（排除历史发布包和审查产物） | 155 文件，847 测试通过 |
| Runtime 包 | 50 文件，325 测试通过 |
| Mobile 包 | 6 文件，35 测试通过；TypeScript 检查通过 |
| Skills/backend/projection/collaboration/plugin 定向回归 | 5 文件，70 测试通过 |
| Identity/chat/reload 定向回归 | 7 文件，73 测试通过；与上一行有重叠，不相加 |
| Skills 协议/缓存集成 | 17 场景通过；新技能上传中操作另有 7 场景 |
| 受理、取消、详情加载、会话覆盖集成 | 31 场景通过 |
| 准备态归属 | 重复提交、恢复延后、取消、立即重试和旧 finally 隔离通过 |
| 正文单写者 | 迟到 SSE、只读 owner/observer、多轮卡片、重复 reconcile、失败/取消等 7 场景 |
| 桌面/移动构建 | 成功，产物仅写 `.reviews/runtime-ux-20260915/` |

三个独立 suite 合计 1207 个测试通过，定向重跑不重复计数。

浏览器采样（不是生产 SLA）：

- 准备态约 4ms 可见；受控延迟下 Run 受理从约 1.75s 降到约 0.36s。
- 同一测试的最终答案由重复两份变为一份；重复点击只创建一个 Run。
- 准备阶段取消后没有 Run POST，也没有残留 assistant 文档。
- Mobile -> Workbench 开关传播 4.107s；Workbench -> Mobile 2.318s。
- Identity 每文件模拟 20ms 延迟时，中位耗时约 307ms -> 174ms。

浏览器断言和截图实际取得，但浏览器退出时被沙箱报告 `/` 文件访问限制，命令退出码
非零，不能声称浏览器执行环境完全无异常。父流程单测报告 `utree flush` 也受到外部
目录写入限制；Vitest 结果不受影响。

## 发布边界

本轮没有提交 Git、覆盖生产或复用此前临时 AK/SK。发布前仍需：

1. 复核当前 dirty worktree，限定文件清单，避免带入并行开发的无关内容。
2. 一起发布 Runtime core 和新 Workbench/Mobile bundle；旧页面仍使用原兼容协议，
   旧全量 enabled 写入和正文双写风险只有页面升级后才能消除。
3. Identity 在生产使用外部插件包，必须重新打包/安装，单改 `/opt` 下源码不代表生效。
4. 常规发布生成完整 desktop + mobile dist，勿把本次隔离测试目录当成发布目录。
5. 已配对客户端验收 Skills、对话首反馈、Stop、恢复、工具卡片和最终正文一致性。

可复现脚本位于 `.reviews/runtime-ux-20260915/`：
`verify-skills-cross-client.mjs`、`verify-chat-backend.mjs post-fix`、
`verify-preparing-ownership.mjs`、`verify-identity-preflight.mjs post-fix`、
`runtime-text-owner-probe.mjs`、`probe.mjs`、`verify-browser-skills.mjs`。

可选调试埋点由 `__zionUxProbe` 控制，默认关闭；仅记录隔离场景的阶段和时间。
调试记录保持 OPEN，等待人工确认效果后再清理，未进入发布包。
