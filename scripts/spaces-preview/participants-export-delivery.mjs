import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const directory = join(repository, ".runtime-data/spaces-preview");
const destination = resolve(repository, "../../ZIOON-SPACES-20261121");
const evidence = join(destination, "分享验证证据/会话参与者");
await mkdir(evidence, { recursive: true });
for (const file of ["participants-native-http-ws.json", "participants-native-dom.json", "sharing-native-restart.json"]) {
  const receipt = JSON.parse(await readFile(join(directory, "acceptance", file), "utf8"));
  if (receipt.status !== "PASS") throw new Error(`Acceptance is incomplete: ${file}`);
  await copyFile(join(directory, "acceptance", file), join(evidence, file));
}
for (const [source, name] of [
  ["/tmp/zioon-participants-frontend-verified.log", "frontend.log"],
  ["/tmp/zioon-participants-backend-verified.log", "backend.log"],
  ["/tmp/zioon-participants-native-dom.log", "native-dom.log"],
  ["/tmp/zioon-participants-native-ws-verified.log", "native-ws.log"],
  ["/tmp/zioon-participants-preview-restart.log", "restart.log"],
  ["/tmp/zioon-participants-build-verified.log", "build.log"],
  ["/tmp/zioon-participants-tsc-final.log", "tsc.log"]
]) await copyFile(source, join(evidence, name));
await copyFile(join(repository, "docs/product/RESOURCE-AND-CONTENT-SHARING.md"), join(destination, "设计与架构.md"));
await writeFile(join(destination, "会话参与者.md"), `# 会话标题栏参与者 · 本地验收

2026-11-22。已更新独立 worktree 及 [本地 Workbench](http://127.0.0.1:55672/)，未发布。

在会话的 editor-header 右侧显示其他有效参与者的姓名首字头像。悬浮显示详情，点击固定信息卡；包含姓名、文档权限、文件夹继承来源，以及是否正在此文档中。账号目前没有头像上传字段，第一版使用统一的姓名头像。

## 交互

- 自己不展示；没有其他参与者时隐藏。
- 在线参与者优先展示，绿色圆点表示当前已连接这份文档；离线参与者使用灰色头像。无法确认时写明“在线状态暂不可用”。
- 常规标题栏最多四个头像，更多人数用 \`+N\` 折叠；窄分屏减少显示数量。点击 \`+N\` 展开其他参与者列表。
- 点击头像固定信息卡；Esc、关闭按钮或点击外部关闭。Esc／关闭按钮将焦点返回原头像，悬浮不会抢占编辑器焦点。
- 每个分屏绑定各自的会话，切换时取消旧请求。连接成员变化会触发刷新；页面可见时每五秒兜底刷新，页面隐藏时停止轮询。

## 权限和在线状态

成员由这份文档和祖先文件夹的有效分享授权计算，同一个人多份授权取最高权限。权限来源按实际授予最高权限的分享确定。未接受的邀请、只收到模型分享的人、无关文档成员、已撤销或过期授权、停用账号不展示。私密子会话仅允许所有者读取参与者信息。

在线身份使用服务端已认证并重新确认文档权限的 WebSocket 连接，不信任客户端填写的昵称、身份、角色或 awareness。一个账号打开多个窗口仍是一人，关闭最后一个连接后转为离线。接口只返回姓名和文档级信息，不返回邮箱、私人资料或邀请令牌。

## 建议体验

1. 用提供者和接收者分别登录两个浏览器配置／无痕窗口，打开“一起做旅行计划”。
2. 检查标题栏的其他参与者头像，悬浮／点击查看权限与在线状态。
3. 在同一账号打开第二个窗口，关闭其中一个，头像应仍为在线；关闭最后一个后应更新。
4. 分屏打开不同会话，检查参与者不串到其他会话。只有自己使用的私密会话不应出现头像。
5. 用提供者检查文件夹中的私密子会话，再检查撤销单人授权后的头像更新。

## 验证记录

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 标题栏 DOM、分屏、悬浮／点击、键盘、取消旧请求、后台暂停及分享回归 | 29 项通过 | [日志](分享验证证据/会话参与者/frontend.log) |
| 原生 PostgreSQL 权限、最高权限来源、私密子会话、真实 WS 去重／断开／身份防伪及协作回归 | 19 项通过 | [日志](分享验证证据/会话参与者/backend.log) |
| 持久预览中的真实账号、Runtime gateway 与 WebSocket | 6 步通过 | [回执](分享验证证据/会话参与者/participants-native-http-ws.json) |
| 实际 Session Manager + 真实 Runtime 的标题栏 DOM | 6 个检查通过 | [回执](分享验证证据/会话参与者/participants-native-dom.json) |
| 原文、授权、私密历史、个人／文档 Memory 重启保留 | 8 个检查通过 | [回执](分享验证证据/会话参与者/sharing-native-restart.json) |
| Workbench 生产构建 | 通过 | [日志](分享验证证据/会话参与者/build.log) |

TypeScript 全量检查仍有原有的 25 项错误，本次功能未新增类型错误：[日志](分享验证证据/会话参与者/tsc.log)。各套件覆盖有重叠，不累计为独立检查总数。

本轮通过代码、原生 DOM、HTTP 与 WebSocket 验证；视觉、悬浮手感和真实浏览器多窗口体验仍请在本地预览亲自验收。
`);
console.log(`Participants acceptance exported to ${destination}`);
