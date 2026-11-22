import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const directory = join(repository, ".runtime-data/spaces-preview");
const destination = resolve(repository, "../../ZIOON-SPACES-20261121");
const config = JSON.parse(await readFile(join(directory, "config.local.json"), "utf8"));
const evidence = JSON.parse(await readFile(join(directory, "acceptance/config.json"), "utf8"));
const owner = config.accounts[0], headers = { authorization: `Bearer ${owner.token}`,
  "x-zioon-space-id": config.teamSpaceId, "x-zion-workbench-protocol": "5", "content-type": "application/json" };
const catalog = await (await fetch(config.runtimeUrl + "/v1/workbench-state/catalog", { headers })).json();
const sampleIds = [config.sharedDocumentId, config.guestDocumentId, config.restrictedDocumentId];
const rows = new Map(catalog.index.map(row => [row.id, row]));
const leaf = id => ({ id, type: "session", title: rows.get(id).title });
const verified = catalog.index.filter(row => !sampleIds.includes(row.id));
const tree = { id: "root", type: "folder", title: "会话", children: [
  ...sampleIds.filter(id => rows.has(id)).map(leaf),
  { id: "folder-preview-validation", type: "folder", title: "验证记录", children: verified.map(row => leaf(row.id)) }
] };
const stored = await fetch(config.runtimeUrl + "/v1/workbench-state/tree", { method: "PUT", headers,
  body: JSON.stringify({ tree, index: catalog.index, base_tree: catalog.tree, expected_revision: catalog.revision }) });
if (!stored.ok || (await stored.json()).ok === false) throw new Error("Could not organize preview examples");

await mkdir(join(destination, "验证证据"), { recursive: true });
await writeFile(join(directory, "示例账号.local.md"), `# 本地示例账号\n\n仅用于此隔离预览，与真实账号无关。\n\n` +
  config.accounts.map(account => `- **${account.name}**：${account.email}\n  密码：\`${account.password}\`\n`).join("\n"),
  { mode: 0o600 });
const url = (spaceId, documentId) => `${config.runtimeUrl}/?${new URLSearchParams({
  space: spaceId, ...(documentId ? { session: documentId } : {})
})}`;
const guestUrl = `${config.runtimeUrl}/shared?${new URLSearchParams({
  space: config.teamSpaceId, document: config.guestDocumentId
})}`;
await writeFile(join(destination, "验收说明.md"), `# Zioon 共享空间 · 本地验收

已在独立产品和 Memory worktree 实现，并留下可运行的隔离预览。机器人／数字人留待后续；此版本未发布。

## 直接打开

- [共享 Workbench](${url(config.teamSpaceId, config.sharedDocumentId)})
- [所有者的个人空间](${url(owner.personalSpaceId, config.personalDocumentId)})
- [单篇访客文档](${guestUrl})
- [示例账号与密码](file://${join(directory, "示例账号.local.md")})
- [设计与架构](./设计与架构.md)
- [验证记录](./验证记录.md)

登录自己的示例账号后，地址中的空间决定当前窗口的范围。需要同时检查两个账号时，可用不同浏览器配置或无痕窗口手动登录。

## 建议检查的流程

1. 用“协作成员”登录共享 Workbench。能看到共同文档和共享资源，不能看到所有者个人资料及“仅所有者”受限文档。
2. 在文档末尾的 \`user \` 后输入“读取共享文件”，按现有聊天快捷键发送。明确标注的本地测试模型会通过共享 Node 读取专用目录，并显示工具状态。
3. 用所有者登录，打开顶部“空间管理”。检查成员邀请、角色、群组、资源授权、每月调用上限、暂停／恢复、有效期、默认模型和活动记录。
4. 用所有者打开“仅所有者 · 受限文档”，在“分享文档”里给协作成员权限；成员刷新后应能读取。取消授权后应再次不可用。
5. 用“文档访客”打开单篇链接，能阅读和评论，不能进入整个共享空间或使用它的模型、设备。
6. 在个人文档的分享面板打开“共享副本”，检查正文、选择目标空间和图片后创建。原文和个人 Memory 保留在个人空间；副本默认仅创建者可见。
7. 将合适的摘要加入空间知识。摘要遵循原文访问范围；原文变化会使旧摘要失效，需要重新审阅。
8. 检查互联网副本：先允许外部分享和公开发布，审阅正文及图片，再发布固定版本。原文编辑不会更新副本；撤销后链接失效。

顶层保留三个示例文档，联调产生的文档放在“验证记录”文件夹。用量和活动保留了真实联调记录。

## CLI

在产品 worktree 中执行：

\`\`\`sh
cd "${repository}"
node scripts/spaces-preview-cli.mjs partner chat
node scripts/spaces-preview-cli.mjs owner space list
node scripts/spaces-preview-cli.mjs owner space resources
\`\`\`

聊天内可用 \`/space\`、\`/members\`、\`/resources\`、\`/usage\`、\`/share\`。完整命令说明：

\`\`\`sh
node scripts/spaces-preview-cli.mjs owner space --help
\`\`\`

## 启动、状态和停止

\`\`\`sh
cd "${repository}"
node scripts/spaces-preview.mjs start
node scripts/spaces-preview.mjs status
node scripts/spaces-preview.mjs stop
\`\`\`

预览已在后台运行。停止保留数据和 PostgreSQL；重新启动恢复相同账号、会话、授权和 Memory。

服务日志和数据：[本地预览目录](file://${directory})。模型、设备与数据库都属于此预览，真实账号、设备和生产服务没有接入。

如果还需要停止预览专用数据库，先停止应用，再执行：

\`\`\`sh
/opt/homebrew/opt/postgresql@16/bin/pg_ctl -D "${join(directory, "postgres")}" -m fast -w stop
\`\`\`

## 验收边界

本地模型用于确定性链路验证，不代表真实模型质量。Workbench 控件已通过 DOM 与真实接口验证，交互滚动与视觉仍由你手动检查；macOS 原生终端已实测，Windows／Linux 原生终端未测。共享文档 Memory 与审阅知识已实现，自动事实提炼未开启。
`);
await copyFile(join(repository, "docs/product/SHARED-SPACES-DELIVERY.md"), join(destination, "设计与架构.md"));
const scratch = "/private/tmp/zioon-spaces-delivery-20261121";
const logs = [
  ["spaces-native-verified.log", "核心原生PostgreSQL验证.log"],
  ["spaces-persistent-native-final.log", "整栈HTTP与原生终端验证.log"],
  ["spaces-persistent-memory-final.log", "固定版本Memory验证.log"],
  ["spaces-native-restart-final.log", "整栈重启验证.log"],
  ["spaces-final-conversation-verified.log", "最终对话协作回归.log"],
  ["memory-gateway-regressions.log", "账号与Memory回归.log"],
  ["shared-default-resource-verified.log", "资源默认授权与路径验证.log"],
  ["joined-native-dom.log", "Workbench真实接口DOM验证.log"],
  ["spaces-final-delivery-build.log", "最终构建.log"],
  ["spaces-types-refined.log", "类型检查现状.log"],
  ["spaces-types-baseline.log", "原基线类型检查.log"]
];
for (const [source, target] of logs) await copyFile(join(scratch, source), join(destination, "验证证据", target));
for (const file of ["native-http.json", "native-dom.json", "native-terminal.json", "native-restart.json"]) {
  await copyFile(join(directory, "acceptance", file), join(destination, "验证证据", file));
}
await writeFile(join(destination, "验证记录.md"), `# 本地验证记录

2026-11-21。使用 PostgreSQL 16.16、Node 22、Bun 1.4.1 和固定 agent-fs 0.18.5。以下套件存在覆盖重叠，不把次数相加当作独立用例总数。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 核心 SQL／文件／Runtime／CLI | 135 项通过，18 个文件 | [完整记录](./验证证据/核心原生PostgreSQL验证.log) |
| 持久整栈 HTTP／CLI 联调 | 13 项通过 | [记录](./验证证据/整栈HTTP与原生终端验证.log) |
| macOS 原生 PTY | 聊天、工具、双空间切换、退出通过 | [回执](./验证证据/native-terminal.json) |
| Workbench 真实接口 DOM | 2 项通过 | [记录](./验证证据/Workbench真实接口DOM验证.log) |
| 固定版本独立 Memory | 13 项通过 | [记录](./验证证据/固定版本Memory验证.log) |
| 整栈重启 | 同一文档／ACL／Memory／成员／资源保留 | [回执](./验证证据/native-restart.json) |
| 最终对话、投影、协作、队列回归 | 48 项通过，5 个文件 | [记录](./验证证据/最终对话协作回归.log) |
| 账号／签名委托／Memory 回归 | 30 项通过 | [记录](./验证证据/账号与Memory回归.log) |
| Workbench 与 Runtime 构建 | 通过 | [完整输出](./验证证据/最终构建.log) |
| Git diff 空白检查 | 通过 | 交付前执行 |
| 根项目全量 TypeScript | 未通过：原基线 25 项诊断；新增代码未增加 | [现状](./验证证据/类型检查现状.log) / [基线](./验证证据/原基线类型检查.log) |

## 联调中修复的问题

- 共享资源已加入空间，普通聊天却没有启用：统一 Workbench／CLI 默认资源选择，保留单次请求缩小范围的能力。
- 共享设备虚拟路径未转换：映射 \`/shared\` 到专用目录，并在分发前拒绝目录越界和遍历。
- Memory 签名请求被个人 Runtime 校验：先验证签名与请求绑定，再按当前授权选择空间 Runtime；修正 \`me\` 与 \`memory\` 的路由前缀冲突。
- 交互 CLI 在 Run 持久化及队列调度前写入文档：等待 Run 就绪，共享占位统一在获得队列位置后插入。
- PostgreSQL 重启依赖临时参数：持久化数据目录，启动器明确设置本机地址、专用端口和短 socket 路径。

先前核心迭代还修复了协作保存的变量遮蔽、ACL 与内容事务、跨请求者操作回执、原子分支、批量导入、附件孤立文件回收、来源失效和权限撤销。完整核心回归记录保存在上表。

## 可以重跑

\`\`\`sh
cd "${repository}"
node scripts/spaces-preview/acceptance.mjs
python3 scripts/spaces-preview/terminal-acceptance.py
ZIOON_SPACES_PREVIEW_ACCEPTANCE=1 npx vitest run tests/spaces-preview-native-dom.test.tsx
node scripts/spaces-preview/restart-acceptance.mjs
\`\`\`

这些验收会产生本地示例会话和用量，按上面的顺序执行，避免额度测试与聊天测试同时修改同一账号。

没有使用浏览器自动化；DOM 验收不代表真实浏览器视觉或滚动验收。没有验证 Windows／Linux 原生终端或第三方实际供应商模型／设备。没有提交、推送、部署或发布。
`);
console.log(`Delivery documents exported to ${destination}`);
