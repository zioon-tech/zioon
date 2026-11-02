import { createHash } from "node:crypto";

export const CATEGORIES = ["研究写作", "开发", "文档", "数据", "外部服务"];
export const BUILTIN_COMPONENTS = new Set(["dev.toc"]);
export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const researchBody = `---
name: evidence-research
description: 基于来源证据完成调研、对比与研究结论。
---
# 证据研究
先明确问题、适用范围和交付形式。把待验证判断列成清单。
优先使用官方文档、原始数据与第一方说明，记录网址、日期和直接支持的判断。
对关键结论交叉验证；只有一个来源时明确标注。区分事实、推断与建议。
不要编造访问量、工期、市场份额或无法访问的来源内容。
输出先给结论，再给证据、局限与可执行建议；所有实质性外部判断附来源。
工具只按当前会话已授权范围使用；本技能不新增网络、文件或命令权限。
`;
const writingBody = `---
name: clear-writing
description: 把研究材料整理成清晰、可追溯的中文文档。
---
# 清晰写作
确定读者要做的决定，然后用一句话写出文档结论。
每个段落只发展一个观点，先说判断，再连接支撑它的事实。
保留数据来源、日期、边界和不确定性。不要把推测改写成事实。
减少套话、重复总结和没有作用的标题；有可比较的数据时才用表格。
完成后检查关键数字、链接与引用是否一致，列出尚未解决的问题。
`;
const reviewBody = `---
name: change-review
description: 检查代码变更的逻辑、边界、授权和恢复行为。
---
# 变更检查
先理解变更想改变的行为、调用者与数据边界，阅读相关调用路径。
重点检查账户隔离、输入验证、并发更新、失败恢复、幂等和不可逆副作用。
用具体触发条件说明缺陷，并给出文件位置、严重程度、置信度和修复建议。
不要把格式偏好当作缺陷；没有证据时保留不确定性。
验证应针对用户行为和风险，不应只复述实现。遵守当前工具与执行目标的授权。
`;
const meetingBody = `---
name: meeting-actions
description: 将会议材料整理成决策、行动和待确认事项。
---
# 会议行动整理
从用户提供且授权读取的会议材料中提取结论，不自行搜索私人会议。
区分已决定事项、讨论提议和待确认问题。保留必要的原文依据。
行动项包括动作、负责人和期限；未提及负责人或时间时写“待确认”。
输出简洁的会议摘要、决策与行动清单。发送或共享前遵循当前用户授权。
`;

const skill = (id, name, description, body) => ({ id, kind: "skill", name, description, body });
const entry = (id, name, summary, category, kind, components, description) => ({
  id, name, summary, category, kind, version: "1.0.0",
  publisher: { id: "zion", name: "Zion", origin: "official" },
  sourceUrl: "https://github.com/2812427914/zion-next",
  license: "MIT", description: description || summary, changelog: "首个精选版本。",
  components
});

export const OFFICIAL_RELEASES = [
  entry("zion.evidence-research", "证据研究", "带着来源和边界，完成可信的调研结论。", "研究写作", "skill",
    [skill("evidence-research", "证据研究", "事实核查、来源比较和研究输出", researchBody)]),
  entry("zion.clear-writing", "清晰写作", "把零散材料整理成读者可以行动的文档。", "文档", "skill",
    [skill("clear-writing", "清晰写作", "中文文档结构与证据检查", writingBody)]),
  entry("zion.change-review", "变更检查", "从真实调用路径检查授权、并发和失败恢复。", "开发", "skill",
    [skill("change-review", "变更检查", "代码风险与行为验证", reviewBody)]),
  entry("zion.meeting-actions", "会议行动", "提取决策、负责人、期限和待确认事项。", "文档", "skill",
    [skill("meeting-actions", "会议行动", "会议决策与行动清单", meetingBody)]),
  entry("zion.research-kit", "研究工作台", "从证据研究到清晰成稿，一次添加两项技能。", "研究写作", "plugin",
    [skill("evidence-research", "证据研究", "检索与证据判断", researchBody),
      skill("clear-writing", "清晰写作", "整理与交付", writingBody)],
    "组合套件包含两项声明式技能，共用一个版本。技能指令通过现有技能目录供 Agent 按需读取。"),
  entry("zion.document-kit", "文档工作台", "清晰写作配合文档目录，更快检查长文结构。", "文档", "plugin",
    [skill("clear-writing", "清晰写作", "整理与交付", writingBody),
      { id: "outline", kind: "workbench", name: "文档目录", pluginId: "dev.toc" }],
    "包含清晰写作技能与 Zion 已内置的目录插件。目录是否运行由当前 Workbench 实际加载状态决定。"),
  entry("zion.github-mcp", "GitHub MCP", "为代码任务添加 GitHub 工具服务的连接意图。", "外部服务", "mcp",
    [{ id: "github", kind: "mcp", name: "GitHub", endpoint: "https://api.githubcopilot.com/mcp/",
      requirements: ["选择已授权的执行设备或沙箱", "在执行端配置 GitHub 凭据并验证连接"],
      support: "configuration_required" }],
    "GitHub 官方 MCP 服务配方。此版保存连接意图和配置要求；凭据与受控连接尚未接通，添加后保持待配置。")
];

export function normalizeContribution(input, publisher) {
  const text = (key, max) => {
    const value = typeof input?.[key] === "string" ? input[key].trim() : "";
    if (!value || value.length > max) throw Object.assign(new Error(`${key} 必须为 1–${max} 字符`), { statusCode: 422, code: "invalid_contribution" });
    return value;
  };
  const slug = text("slug", 60);
  if (!/^[a-z][a-z0-9-]{1,59}$/.test(slug)) throw Object.assign(new Error("标识使用小写字母、数字和短横线"), { statusCode: 422 });
  const version = text("version", 40);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Object.assign(new Error("版本格式为 x.y.z"), { statusCode: 422 });
  const name = text("name", 100), summary = text("summary", 300);
  const body = text("body", 100000);
  if (!/^---\r?\n[\s\S]+?\r?\n---(?:\r?\n|$)/.test(body) || !/^name:\s*\S+/m.test(body)
    || !/^description:\s*\S+/m.test(body)) throw Object.assign(new Error("SKILL.md 需包含 name 和 description 的 frontmatter"), { statusCode: 422 });
  const sourceUrl = text("sourceUrl", 1000);
  let source;
  try { source = new URL(sourceUrl); } catch { throw Object.assign(new Error("请输入有效来源链接"), { statusCode: 422 }); }
  if (source.protocol !== "https:" || source.username || source.password) throw Object.assign(new Error("来源必须是无凭据的 HTTPS 链接"), { statusCode: 422 });
  if (!CATEGORIES.includes(input.category)) throw Object.assign(new Error("请选择有效分类"), { statusCode: 422 });
  return {
    id: `${publisher.id}.${slug}`, name, summary, category: input.category,
    kind: "skill", version, publisher, sourceUrl: source.href,
    license: text("license", 80), description: String(input.description || summary).slice(0, 20000),
    changelog: String(input.changelog || "首个版本").slice(0, 4000),
    components: [skill(slug, name, summary, body)]
  };
}
