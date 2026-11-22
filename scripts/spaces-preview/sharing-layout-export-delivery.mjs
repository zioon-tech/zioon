import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const directory = join(repository, ".runtime-data/spaces-preview");
const destination = resolve(repository, "../../ZIOON-SPACES-20261121");
const evidence = join(destination, "分享验证证据/分享界面调整");
await mkdir(evidence, { recursive: true });
for (const name of ["sharing-layout-native-dom.json", "sharing-native-restart.json"]) {
  const receipt = JSON.parse(await readFile(join(directory, "acceptance", name), "utf8"));
  if (receipt.status !== "PASS") throw new Error(`Incomplete acceptance: ${name}`);
  await copyFile(join(directory, "acceptance", name), join(evidence, name));
}
for (const [source, name] of [
  ["sharing-layout-dom-tests.log", "frontend.log"],
  ["sharing-layout-model-list-tests.log", "model-list.log"],
  ["sharing-layout-native-integration.log", "backend-index.log"],
  ["sharing-layout-native-regressions.log", "backend-regressions.log"],
  ["sharing-layout-actual-dom.log", "native-dom.log"],
  ["sharing-layout-restart.log", "restart.log"],
  ["sharing-layout-build.log", "build.log"],
  ["sharing-layout-types.log", "types-baseline.log"]
]) await copyFile(join(directory, source), join(evidence, name));
await copyFile(join(repository, "docs/product/RESOURCE-AND-CONTENT-SHARING.md"), join(destination, "设计与架构.md"));
await writeFile(join(destination, "分享界面调整.md"), `# 分享界面调整 · 本地验收

2026-11-22。已更新 [本地 Workbench](http://127.0.0.1:55672/)，继续使用同一套账号、会话、分享授权与 Memory 数据。未发布。

## 当前体验

1. **标题栏参与者**：头像在现有右侧按钮的左边，只显示正在这份文档中的其他用户。授权但离线的用户不展示；在线状态暂不可用时隐藏；没有其他在线用户时不占位。悬浮／点击仍可查看姓名、权限与文件夹继承来源。
2. **editor-config**：「会话访问权限」列出包括离线者在内的有效授权用户，分别展示阅读和编辑权限、授权来源及是否在当前文档中。所有者可分享会话、设置隐私、进入授权与邀请管理；接收者没有这些管理按钮。阅读／编辑栏表示权限。
3. **会话列表**：顶部有「全部／我分享的／收到的」快捷筛选。收到的会话和文件夹直接列入原列表，文件夹保留层级，点击会话使用原编辑器读取原文。私密、撤销、过期或来自停用提供者的内容不会进入收到的目录。
4. **分享侧边栏**：「收到的／我分享的」两种方向，按模型／会话／文件夹分组；支持资源或提供者搜索、类型筛选。每行只显示资源信息和主要操作。点击进入详情后查看权限、提供者、有效期，管理授权用户、邀请和撤销。
5. **收到来源标记**：模型选择器、会话、文件夹及分享列表使用同一个小分享图标，悬浮显示提供者。自己的资源不增加收到标记。

收到的目录使用独立展示投影，不写入自己的持久目录。收到的文件夹和会话不能通过自己的目录菜单重命名、删除、拖放或加入批量操作。重叠授权取最高权限、同一篇文档去重；不同提供者的同名 ID 使用限定地址隔离。

## 建议体验

- 刷新 Workbench（Cmd+Shift+R），用接收者登录，直接在会话侧边栏切换三种筛选并展开「一起处理的事情」；只有共同清单出现，私密笔记不出现。
- 从会话列表打开「一起做旅行计划」，再进入分享侧边栏点击相应资源，检查列表与详情的层级、来源和权限。
- 提供者与接收者分别打开旅行会话；头像应在按钮左边。关闭其中一方的最后一个文档窗口后，该头像消失，editor-config 仍保留该用户有效的阅读／编辑权限。
- 检查模型选择器中的「对象分享的模型」旁的小分享标记，悬浮查看提供者。
- 用提供者进入「我分享的」详情，查看成员和邀请，尝试撤销单人授权。接收者刷新分享或后续操作时失去对应访问；会话列表在页面可见时每十五秒更新。

## 本轮验证

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 标题栏、完整权限、会话筛选／层级／目录操作与既有分享回归 | 69 项通过 | [前端日志](分享验证证据/分享界面调整/frontend.log) |
| 模型选择器来源图标及会话筛选持久化 | 6 项通过（其中 3 项会话检查与前端日志重叠） | [日志](分享验证证据/分享界面调整/model-list.log) |
| 原生 PostgreSQL 目录投影、重叠权限、私密／过期／停用／撤销 | 13 项通过 | [日志](分享验证证据/分享界面调整/backend-index.log) |
| 原生 HTTP、真实账号、WebSocket、编辑／生成及 Memory 边界回归 | 14 项通过 | [日志](分享验证证据/分享界面调整/backend-regressions.log) |
| 持久预览、实际 Session Manager、实际 editor-config、真实 WS 连接及分享详情 | 10 个检查通过 | [回执](分享验证证据/分享界面调整/sharing-layout-native-dom.json) |
| 同数据库重启及原文、授权、Memory 保留 | 8 个检查通过 | [回执](分享验证证据/分享界面调整/sharing-native-restart.json) |
| Vite 构建 | 通过 | [日志](分享验证证据/分享界面调整/build.log) |
| TypeScript | 保留原有 25 项诊断，新增实现未增加诊断 | [完整日志](分享验证证据/分享界面调整/types-baseline.log) |

真实预览验收保留已在线用户的连接：测试连接关闭后，恢复先前在线头像，并隐藏本次测试后已离线的用户。没有使用浏览器自动化；自动检查不替代人工视觉、滚动与布局体验。预览仍在运行。
`);
const record = join(destination, "验证记录.md");
const previous = await readFile(record, "utf8");
const marker = "## 分享界面调整（2026-11-22）";
if (!previous.includes(marker)) await writeFile(record, `${previous.trimEnd()}\n\n${marker}\n\n本轮验证与证据见 [分享界面调整](分享界面调整.md)。包括会话目录投影、三种筛选、editor-config 完整权限、仅在线头像与左侧位置、资源来源标记及新的分享详情。\n`);
console.log(JSON.stringify({ status: "PASS", document: join(destination, "分享界面调整.md"), evidence }, null, 2));
