import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const directory = join(repository, ".runtime-data/spaces-preview");
const logs = "/tmp/zioon-sharing-permissions-20261122";
const destination = resolve(repository, "../../ZIOON-SPACES-20261121");
const evidence = join(destination, "分享验证证据/直接分享与权限管理");
await mkdir(evidence, { recursive: true });
const clean = value => value.replace(/\u001b\[[0-9;]*m/g, "");
const frontend = clean(await readFile(join(logs, "frontend-final.log"), "utf8"));
assert.match(frontend, /\b31 passed\b/);
const backend = clean(await readFile(join(logs, "backend-final.log"), "utf8"));
for (const [file, count] of [["account-sharing.integration.test.js", 19], ["account-content.integration.test.js", 6], ["sharing-cli.test.js", 5]]) {
  assert.ok(backend.includes(`✓ tests/${file} (${count} tests)`), `Missing successful suite: ${file}`);
}
assert.match(clean(await readFile(join(logs, "backend-http-final.log"), "utf8")), /\b7 passed\b/);
const types = await readFile(join(logs, "types-delivery.log"), "utf8");
assert.equal((types.match(/error TS/g) || []).length, 25);
assert.ok(!types.includes("SharingDialog") && !types.includes("DocumentAccess"));
const build = await readFile(join(logs, "build-delivery.log"), "utf8");
assert.ok(build.includes("built in") && build.includes("files generated"));
for (const name of ["sharing-permissions-native-http-ws.json", "sharing-permissions-native-dom.json",
  "sharing-permissions-native-restart.json", "sharing-native-restart.json", "sharing-layout-native-dom.json"]) {
  assert.equal(JSON.parse(await readFile(join(directory, "acceptance", name), "utf8")).status, "PASS", name);
  await copyFile(join(directory, "acceptance", name), join(evidence, name));
}
for (const [source, name] of [
  ["frontend-final.log", "frontend.log"], ["backend-final.log", "backend-grants-and-regression.log"],
  ["backend-http-final.log", "backend-http-final.log"], ["native-http-ws.log", "native-http-ws.log"],
  ["restart.log", "restart.log"], ["build-delivery.log", "build.log"], ["types-delivery.log", "types-baseline.log"]
]) await copyFile(join(logs, source), join(evidence, name));
await writeFile(join(evidence, "verification.json"), JSON.stringify({ status: "PASS",
  frontendTests: 31, backendSuites: [
    { file: "account-sharing.integration.test.js", tests: 19, status: "PASS" },
    { file: "account-content.integration.test.js", tests: 6, status: "PASS" },
    { file: "sharing-cli.test.js", tests: 5, status: "PASS" },
    { file: "account-sharing.e2e.test.js", tests: 7, status: "PASS", evidence: "backend-http-final.log" }
  ], backendTests: 37, build: "PASS", types: { diagnostics: 25, baselineUnchanged: true },
  evidenceNote: "Backend suites are recorded across two runs. The original regression log includes an earlier HTTP assertion failure; the corrected seven-case HTTP suite passed in backend-http-final.log."
}, null, 2));
await copyFile(join(repository, "docs/product/RESOURCE-AND-CONTENT-SHARING.md"), join(destination, "设计与架构.md"));
await writeFile(join(destination, "直接分享与权限管理.md"), `# 直接分享与权限管理 · 本地验收

2026-11-22。已更新 [本地 Workbench](http://127.0.0.1:55672/)，同一套账号、会话、模型和 Memory 数据继续使用。未发布。

## 当前体验

1. **头像位置**：当前文档的其他在线用户头像紧邻重命名按钮左侧。重命名按钮之前已有的控件顺序保留。
2. **指定对象**：在会话、文件夹或模型的分享面板输入完整邮箱或账号 ID，点击「查找」，确认用户姓名与账号 ID，再点击「添加」。无需接收者打开邀请链接，收到内容进入其既有会话列表，收到模型进入模型选择器。
3. **权限管理**：面板列出协作者，下拉修改「可查看／可编辑」并直接保存；移除在面板内确认。editor-config 也可就地修改，或打开同一「管理分享」面板。模型授权保持「可使用」。
4. **继承来源**：文件夹权限单独标明。更高的继承编辑权限会阻止不真实的会话降权，并提示管理对应文件夹；进入文件夹管理后可返回会话。移除直接会话授权时明确提示继承权限保留。
5. **邀请链接**：作为折叠的可选入口保留，默认七天、一人接受。展示新邀请权限，生成、复制和撤销都在面板内完成；撤销链接不移除已有协作者。
6. **入口一致**：文档内的分享与 editor-config 使用同一面板，打开不会切换当前侧边栏；分享侧边栏详情也能直接改单人权限。

邮箱仅匹配已注册且经过身份服务验证的账号。未注册／未验证地址不能直接授权；多个账号匹配同一邮箱时改用精确账号 ID。这个流程不发送邮件，可继续使用邀请链接让未注册用户注册后接受。

添加协作者沿用面板中显示的分享有效期与模型额度。已有有效期／模型额度的统一修改、委托管理和历史阅读日志未在此轮新增。阅读／编辑栏表示权限，头像表示当前文档的实时参与者。

## 建议检查

- 刷新 Workbench（Cmd+Shift+R），使用提供者账号右键一个会话选择分享，输入接收者的示例邮箱，确认姓名后添加。保持面板打开，检查协作者是否出现，再用接收者查看原会话列表。
- 在同一面板将接收者改为只读，接收者仍可读取，但不能修改或生成。恢复编辑权限后重新打开协作连接再检查编辑。
- 打开共享文件夹中的子会话，检查继承来源与管理入口；试着将继承编辑权限改为查看，应看到明确的文件夹权限提示。
- 在 editor-config 修改单人权限，点击「管理分享」，应回到相同的协作者面板。
- 两个账号打开同一共享会话，检查头像与重命名按钮的位置。授权但未在文档中的用户只在完整权限列表显示。

保留用户已经修改的示例标题，不强制恢复原示例名称。真实预览检查用临时内容进行授权、降权和继承验证，结束后撤销这些临时分享并删除临时文档；已有示例保持原状。

## 验证

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 分享面板、权限修改、editor-config、头像、传输与两个实际预览 DOM 用例 | 31 项通过 | [前端日志](分享验证证据/直接分享与权限管理/frontend.log) |
| 原生 PostgreSQL 分享与身份校验 | 19 项通过 | [原始日志](分享验证证据/直接分享与权限管理/backend-grants-and-regression.log) |
| 原生协作／内容／Memory 回归及 CLI | 6 + 5 项通过 | [原始日志](分享验证证据/直接分享与权限管理/backend-grants-and-regression.log) |
| 真实 OIDC／HTTP 直接授权、降权、移除与原有链路 | 7 项通过 | [最终 HTTP 日志](分享验证证据/直接分享与权限管理/backend-http-final.log) |
| 持久预览内实际 WebSocket 降权、直接接收、继承与模型边界 | 6 个检查通过 | [回执](分享验证证据/直接分享与权限管理/sharing-permissions-native-http-ws.json) |
| 原生分享入口与 editor-config 的直接授权交互 | 8 个检查通过 | [回执](分享验证证据/直接分享与权限管理/sharing-permissions-native-dom.json) |
| 直接授权、单人降权与无邀请记录在重启后保留 | 6 个检查通过 | [回执](分享验证证据/直接分享与权限管理/sharing-permissions-native-restart.json) |
| 原有会话、授权、个人／共享 Memory 和模型目录重启保留 | 8 个检查通过 | [回执](分享验证证据/直接分享与权限管理/sharing-native-restart.json) |
| Vite 构建 | 通过 | [日志](分享验证证据/直接分享与权限管理/build.log) |
| TypeScript | 保留既有 25 项诊断，新增实现未增加诊断 | [完整日志](分享验证证据/直接分享与权限管理/types-baseline.log) |

后端 37 项成功用例来自两次运行；原始回归日志保留了先前 HTTP 测试断言失败，修正后的完整七项 HTTP 用例在最终日志中通过。[验证汇总](分享验证证据/直接分享与权限管理/verification.json)保留对应关系。前端原生日志可能包含异步测试 act 提示，用例全部通过；它不是浏览器视觉验收。

飞书公开交互、邮箱分享的实际限制与本地取舍见 [飞书分享交互分析](飞书分享交互分析.md)。技术说明见 [设计与架构](设计与架构.md)。
`);
const record = join(destination, "验证记录.md");
const previous = await readFile(record, "utf8");
const marker = "## 直接分享与权限管理（2026-11-22）";
if (!previous.includes(marker)) await writeFile(record, `${previous.trimEnd()}\n\n${marker}\n\n[本轮验收](直接分享与权限管理.md)：账号／已验证邮箱直接授权、协作者就地改权限、文件夹来源与真实降权、头像紧邻重命名左侧、原生协作和重启持久化。前端 31 项、后端 37 项成功用例，构建通过，TypeScript 保持 25 项基线诊断。\n`);
console.log(JSON.stringify({ status: "PASS", document: join(destination, "直接分享与权限管理.md"), evidence }, null, 2));
