# 心智系统（Mind System）设计讨论全记录

> 主题：zion-next 如何从「纯用户输入驱动的小助手」走向「拥有心智的超级助手」。
> 本目录是 2026-08-17 起多轮讨论的完整整理，自包含，可直接带走去别处继续讨论。
> 状态：设计讨论稿。除 mind-lab 实验代码（~/Downloads/mind-lab）外，**尚未动仓库核心代码**。

## 文档地图

| 文档 | 内容 |
|---|---|
| [01-identity-plugin-dataflow.md](./01-identity-plugin-dataflow.md) | 现有 dev.identity（Biography）插件的代码级数据流梳理 |
| [02-mind-architecture.md](./02-mind-architecture.md) | 心智架构：四要素、心智环路、主动性阶梯、端到端 7 环节与卡点 |
| [03-mind-lab-experiments.md](./03-mind-lab-experiments.md) | mind-lab 沙盒实验：设计、四轮结果、关键发现、契约演化轨迹 |
| [04-data-model-and-memory-quadrants.md](./04-data-model-and-memory-quadrants.md) | 数据模型设计（五层模型）→ 记忆四象限体系（最终方案） |
| [05-roadmap-and-open-questions.md](./05-roadmap-and-open-questions.md) | 已定事项、待决事项、建议落地路线、风险清单 |

## 核心结论速览（TL;DR）

1. **记忆不是问题，循环才是**。现有 Biography 的记忆（事件流 + 摘要注入）已经很好；缺的是「面向未来的状态」和「自己的时钟」。心智化 = 补上状态层 + 心跳循环 + 分级授权，主键从 session 翻转到 user。
2. **蒸馏 state 的质量已被量化**：mind-lab 四轮实验表明——方向性错误（hallucinated）为 0，但粒度不精确（partial ~67%）、错误率可达 17-33%（wrong）。因此「候选态 + 用户确认回路」不是可选项。
3. **project 归属是第一风险**：事件整条串项目（比 project 空值更隐蔽），导致状态卡串卡。必须靠会话标签词表 + 规则层冲突检测双保险。
4. **状态提取不该靠纯规则，也不该全靠独立蒸馏**：最终方案是让**主模型直接维护「项目活文档」**（有完整上下文，比独立蒸馏只看到最后一轮更准），规则只做兜底索引，biography 事件流降级为可追溯的完整历史。
5. **最终架构 = 记忆四象限**：按「关于谁」把 memory/ 分成四个象限——用户（user.md 扩展）、事项（projects/）、历史（biography/）、AI（identity.md）。作为 dev.identity 插件的新特性落地，新增 `~/.zion-next/memory/projects/`。

## 决策时间线

1. **起点**：用户提出——对话蒸馏出的事件之外，还蕴含用户意图与事项状态；掌握它才能主动/自动帮用户完成需求，摆脱每次手动敲字触发会话。
2. **架构判断**：记忆（已有）/ 状态（半成品）/ 循环（缺失）/ 授权（缺失）四要素；主动收件箱（L2 汇报）先于自主执行（L3）；主键翻转 session → user。
3. **数据流落地**：从 tag-tree-panel worktree 实际代码逐函数梳理 identity 插件数据流，发现 scheduled/agent/task 会话被排除在蒸馏外等关键特征。
4. **端到端 7 环节**：触发面 → 蒸馏 → 投影 → 注入 → UI → 心跳 → 收件箱；识别最大卡点（蒸馏状态语义不可靠、确认回路缺失）。
5. **mind-lab 沙盒**（用户提议"设计一个小 app 自主运行验证"）：3 模型角色（助手/蒸馏/虚拟用户）+ ground truth 世界 + 裁判打分，跑 4 轮实验迭代蒸馏契约 v0→v4。
6. **数据模型质疑**（用户："状态卡不一定靠规则提取，数据模型没精心设计过"）：提出五层模型（对话/事实事件/事项/状态/授权），事实与状态分离。
7. **项目管理语言调研**（用户问"有没有项目管理的语言语法"）：Taskwarrior 数据模型（RFC 化 JSON、显式/派生状态分离、waiting 机制、时间字段体系、annotations、UDA）+ GTD 方法论，吸收 5 条、不吸收 2 条。
8. **projects 文件夹方案**（用户："像 skills 那样，一个文件夹管理所有项目"）：项目活文档 + index 自动注入 + 模型对话中直接维护；项目档案从 4 小节扩到 8 小节完整档案。
9. **四象限定稿**（用户："和 user.md/identity.md 很像，结合起来"）：最终方案见 [04](./04-data-model-and-memory-quadrants.md)。用户列举的价值观/人生目标/信条/兴趣/生活经验 → user.md 扩展；杂思/idea → projects/inbox.md；项目经验 → 项目文件；通用知识库第一版砍掉。
10. **待展开**：用户在任务状态之上提出的下一步愿景——对用户授权的任务，由系统**自主探索推进**（了解 todo、设计实验、迭代），用户只做验收。见 [05](./05-roadmap-and-open-questions.md) 待决事项。

## 关键术语

| 术语 | 含义 |
|---|---|
| WAL / 事件流 | append-only 事实日志（现 biography/events.jsonl），不可变、按 id 去重 |
| 蒸馏（distillation） | 对话结束后由模型从最后一轮交换中提取事件（独立 LLM run） |
| 投影（projection） | 从事件流物化派生视图（digest/状态卡），可全量重建 |
| 物化 + 覆盖 | 状态字段的维护模式：确定性物化（derived）+ 语义提炼（model）+ 用户覆盖（user），每个值可追溯 |
| 状态卡 → 项目档案 | 早期叫「状态卡」（投影产物），最终方案演化为「项目活文档」（主模型直接维护的文件） |
| 候选态（candidate） | 未确认（confirmed=false）的状态，只展示不下行到行动 |
| 心跳（heartbeat） | 定时扫描状态、产出提醒的循环（规则层零 LLM + 可选 LLM 层） |
| 收件箱（inbox） | 主动汇报载体：拉取式、可勾选、dismiss 是负反馈信号 |
| L0-L3 阶梯 | 主动性分级：静默观察 / 带上下文应答 / 主动汇报 / 受限自主 |
| 铁律 | 蒸馏契约中约束 state 提取的规则，演化到 7 条（见 03 文档） |
| 四象限 | 最终记忆体系：关于用户 / 关于事项 / 关于历史 / 关于 AI |

## 当前状态

- ✅ 已定：四象限记忆体系；projects 目录结构与 8 小节档案；主模型直接维护；user.md 扩展；作为 dev.identity 新特性；放在 ~/.zion-next/memory/projects
- 🧪 已验证（mind-lab）：蒸馏 state 质量基线、project 归属风险、漏记风险、nextAction 残留根因、心跳规则正确性
- ⏳ 待决：一揽子决策点见 [05](./05-roadmap-and-open-questions.md)（约 10 项）
- 🚫 明确不做（第一版）：通用知识库独立文件、Jira 式层级、Taskwarrior recurrence、意图层 L5

## 相关资产

- mind-lab 实验代码与数据：`~/Downloads/mind-lab/`（含 results/rounds/r2-r4 归档）
- 现有实现代码：`extensions/dev.identity/main.js`（2230 行）、`identity-core.js`（494 行）
- 现有记忆数据：`~/.zion-next/memory/`（identity.md / user.md / biography/）
