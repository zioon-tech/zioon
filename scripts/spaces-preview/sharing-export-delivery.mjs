import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const directory = join(repository, ".runtime-data/spaces-preview");
const destination = resolve(repository, "../../ZIOON-SPACES-20261121");
const config = JSON.parse(await readFile(join(directory, "config.local.json"), "utf8"));
const evidence = join(destination, "分享验证证据");
await mkdir(evidence, { recursive: true });
await writeFile(join(directory, "示例账号.local.md"), "# 本地分享示例账号\n\n只用于此隔离预览。\n\n" +
  config.accounts.map(account => `- **${account.name}**：${account.email}\n  密码：\`${account.password}\`\n`).join("\n"), { mode: 0o600 });
await copyFile(join(repository, "docs/product/RESOURCE-AND-CONTENT-SHARING.md"), join(destination, "设计与架构.md"));
const scratch = "/private/tmp/zioon-sharing-delivery-20261122";
for (const file of ["cli-verified.log", "content-cli-final-verified.log", "frontend-privacy-verified.log",
  "frontend-verified.log", "native-sharing-verified.log", "native-sharing-dom-final.log", "sharing-native-pty.log",
  "sharing-restart-verified.log", "sharing-final-build.log", "sharing-final-tsc.log", "direct-memory-verified.log"]) {
  await copyFile(join(scratch, file), join(evidence, file));
}
for (const file of ["sharing-http.json", "sharing-native-dom.json", "sharing-native-terminal.json", "sharing-native-restart.json"]) {
  const result = JSON.parse(await readFile(join(directory, "acceptance", file), "utf8"));
  if (result.status !== "PASS") throw new Error(`Incomplete acceptance: ${file}`);
  await copyFile(join(directory, "acceptance", file), join(evidence, file));
}
await writeFile(join(destination, "验收说明.md"), `# Zioon 资源与内容分享 · 本地验收

2026-11-22。已按收敛方向更新独立 worktree 和本地预览，当前版本未发布。

## 直接打开

- [Workbench](${config.runtimeUrl}/)：登录自己的示例账号，使用现有会话树与模型选择器。
- [示例账号与密码](file://${join(directory, "示例账号.local.md")})：分享提供者、接收者、只读访客。
- [设计与架构](设计与架构.md)。
- [验证记录](验证记录.md)。

用两个浏览器配置或无痕窗口分别登录提供者和接收者。每个人使用自己的账号，预览没有代切账号入口。

## 建议检查

1. 用接收者登录，在现有模型选择器中查看自己的模型与“对象分享的模型”，收到的模型标明提供者。在自己的会话中使用分享模型；提供者的会话列表里不应出现接收者会话。
2. 点击 Activity Bar 的「分享」，检查收到的模型、旅行会话和文件夹。打开“一起做旅行计划”，应使用原有编辑器显示原文；修改和生成的结果应同步到提供者的原文。
3. 在接收者的共享会话中切换模型，可以选择自己的本地测试模型或收到的模型。分享内容不会自动授予模型、技能或设备使用权。
4. 打开“一起处理的事情”文件夹，只显示共同清单；“文件夹里保留的私密笔记”被过滤。
5. 用提供者右键会话或文件夹，创建查看或编辑邀请。也可以从分享侧边栏创建新的模型邀请。复制链接给另一个示例账号，接受前会显示提供者、内容与权限。
6. 在「发出的」里查看接收者、邀请与模型用量。尝试作废尚未接受的邀请、撤销单人授权及撤销整项分享。对方刷新或后续操作时应失去对应权限。
7. 将文件夹子会话设为私密，接收者应无法读取；取消私密后恢复原分享权限。新建私密会话仍不自动分享。
8. 用只读访客登录，打开“只读旅行计划”，可读取原文，不能编辑或生成。

本地模型生成确定性回复与中文 Markdown 表格，用于检查权限和链路；预览中未配置凭据的平台模型会显示不可用。验收时选择“本地测试模型”或“对象分享的模型”。

## CLI

\`\`\`sh
cd "${repository}"
node scripts/spaces-preview-cli.mjs partner chat
node scripts/spaces-preview-cli.mjs owner share sources
node scripts/spaces-preview-cli.mjs owner share model spaces-local-fixture --limit 500
node scripts/spaces-preview-cli.mjs partner share received
node scripts/spaces-preview-cli.mjs partner chat --shared '${config.sharingDocumentShareId}'
node scripts/spaces-preview-cli.mjs partner chat --shared '${config.sharingFolderShareId}' --document '${config.sharingFolderDocumentId}'
node scripts/spaces-preview-cli.mjs owner share --help
\`\`\`

聊天内：\`/model\`、\`/shares\`、\`/share viewer|editor\`、\`/accept <邀请链接>\`、\`/shared <分享ID> [文档ID]\`。共享聊天中 \`/new\` 返回自己的私密聊天；\`/recover\` 检查丢失的发送回执。

## 启动、状态与停止

\`\`\`sh
cd "${repository}"
node scripts/spaces-preview.mjs status
node scripts/spaces-preview.mjs start
node scripts/spaces-preview.mjs stop
\`\`\`

当前预览已在后台运行。停止保留账号、会话、授权、原生 Memory 和 PostgreSQL 数据；重新启动使用同一套数据。日志：[本地预览目录](file://${directory})。

## 尚需人工验收

DOM 验收使用实际 Session Manager 和真实 Runtime，未使用浏览器自动化。请亲自检查视觉、编辑、滚动和多窗口体验。macOS 原生终端已验证；Windows／Linux 原生终端未实测。本轮未新增技能、设备、插件和机器人分享 UI。
`);
await writeFile(join(destination, "验证记录.md"), `# 资源与内容分享验证记录

2026-11-22。原生 PostgreSQL 16.16、Node 22.18、Bun 1.4.1、固定 agent-fs 0.18.5。以下套件有覆盖重叠，不累计为独立用例总数。

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| CLI 分享与聊天回归 | 62 项通过 | [日志](分享验证证据/cli-verified.log) |
| Runtime 内容、模型、真实 OIDC | 21 项通过 | [日志](分享验证证据/content-cli-final-verified.log) |
| 共享传输、DOM、协作与模型目录 | 71 项通过 | [日志](分享验证证据/frontend-verified.log) |
| 隐私预检、历史 Run 恢复及 Identity 回归 | 58 项通过 | [日志](分享验证证据/frontend-privacy-verified.log) |
| 原生独立 Memory | 6 项通过 | [日志](分享验证证据/direct-memory-verified.log) |
| 持久本地整栈 HTTP／CLI | 10 项通过 | [回执](分享验证证据/sharing-http.json) |
| 实际 Session Manager + 分享 DOM | 通过 | [回执](分享验证证据/sharing-native-dom.json) |
| macOS 原生 PTY | 8 步通过 | [回执](分享验证证据/sharing-native-terminal.json) |
| Runtime 与 Memory 重启 | 原文、授权、私密历史、个人与文档 Memory 保留 | [回执](分享验证证据/sharing-native-restart.json) |
| Vite 构建 | 通过 | [日志](分享验证证据/sharing-final-build.log) |
| TypeScript | 原基线 25 项诊断；本轮未增加 | [日志](分享验证证据/sharing-final-tsc.log) |

## 关键验收

- 收到的模型与自己的模型并列；提供者配置不外泄；借用模型不会授予提供者私密会话读取权。
- 编辑者通过 CLI 在原始 Workbench 文档中使用自己或借来的模型，不把另一私密会话的历史拼入。
- 模拟服务端已接受、客户端回执丢失：查询持久回执，单次提交，不重复调用。
- 文件夹分享过滤私密子会话；查看者不能修改、上传或生成。
- 文档 Memory 与双方个人 Memory 分开；撤销阻断原文、Memory、模型及协作后续访问。
- 实际 Session Manager 命令加载共享原文，限定缓存 ID，不将共享文档加入接收者个人目录。
- 已打开的本人文档通过 CLI 分享后，发送前查询服务器分享状态并跳过个人浏览器上下文。
- 刷新后恢复共享 Run 的原文路由。
- 将私密会话分享后，原文开放，但之前任务的隐藏上下文与私人 Session 配置不向接收者开放。

## 联调发现并修复

CLI 的共享生成与草稿恢复、共享 Run projection／回执授权、Identity 文件的实际 POST 写入方法、文件夹树保存版本契约，以及本地 OIDC 显示名称的重启一致性均已完成修正。

## 重跑

\`\`\`sh
cd "${repository}"
node scripts/spaces-preview/sharing-acceptance.mjs
ZIOON_SHARING_PREVIEW_ACCEPTANCE=1 npx vitest run tests/sharing-preview-native-dom.test.tsx
python3 scripts/spaces-preview/sharing-terminal-acceptance.py
node scripts/spaces-preview/sharing-restart-acceptance.mjs
\`\`\`

请顺序执行，重启时不要同时运行依赖预览的验收。脚本只修改隔离预览的样例、授权和用量。

视觉、滚动、多浏览器人工体验，以及 Windows／Linux 原生终端和真实模型供应商未实测。没有提交、推送或生产发布。
`);
console.log(`Sharing delivery exported to ${destination}`);
