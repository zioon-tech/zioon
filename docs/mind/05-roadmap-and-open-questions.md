# 05 · 落地路线与待决事项

## 5.1 已定事项

- ✅ 记忆四象限体系（04 文档）为定稿方向
- ✅ 作为 dev.identity（Biography）插件新特性，数据放 `~/.zion-next/memory/projects/`
- ✅ projects 目录结构：index.md（全局索引）+ inbox.md（杂思）+ <项目>/project.md（8 小节档案）
- ✅ 主模型直接维护项目文件（对话中更新），biography 蒸馏保留为历史兜底
- ✅ user.md 扩展（价值观/信条/人生目标/兴趣/行为准则/生活规律/边界），[user-stated] 标记
- ✅ 一项目一子文件夹
- ✅ 通用知识库、Jira 层级、Taskwarrior recurrence、意图层 L5 第一版不做
- ✅ mind-lab 契约 v4 基线：wrong ~17% / partial ~67% / correct ~17% / hallucinated 0%

## 5.2 待决事项（带建议倾向）

| # | 事项 | 背景 | 建议倾向 |
|---|---|---|---|
| 1 | 项目文件 status 枚举 | 讨论中定过 active/waiting/done/archived；Taskwarrior 是 pending/completed/deleted/waiting | 按 Taskwarrior 思想：显式状态收窄（active/waiting/done/archived 已是派生语义，可保留）+ 派生状态（overdue/idle）计算得出不存储 |
| 2 | nextStep 是否带 due 字段 | 调研后建议加（逾期可精确判断，替代 TTL 猜） | 模板中"下一步：xxx（用户待办，due 08-22）"已隐含；正式 schema 需定字段形态 |
| 3 | 时间线保留条数与裁剪 | 项目文件不无限膨胀 | 保留 ~15 条，更早依赖 biography events；裁剪动作由模型维护时顺手做 |
| 4 | index.md 注入的规模上限 | 项目数增长后的注入成本 | 全量注入（一行一项目）；>50 项目时只注入 active/waiting，archived 折叠 |
| 5 | 杂思→项目的晋升确认方式 | "第二次提及时提议立项" | 对话中口头提议、用户确认后建文件夹；不做 UI |
| 6 | user.md 价值观的写入触发标准 | 防谄媚关键 | 仅用户明确、反复（≥2 次独立表达）、稳定的才记；带 [user-stated]；模型推断不写价值观区 |
| 7 | 验证方式 | projects 方案先在 mind-lab 跑对比 vs 直接原型 | **倾向直接原型**：方案复杂度已低到不需要仿真验证，真机跑两周拿真实数据更有意义 |
| 8 | scheduled 会话蒸馏是否放开 | 感知带宽缺口（定时任务产出不进记忆） | 倾向放开 scheduled（保留 comment/agent/task 排除），配更严契约（例行成功不记） |
| 9 | confirmed 确认回路 | 现状只是 prompt 约束，无 UI | projects 方案下确认回路的紧迫性下降（主模型直接写文件，用户可看到并改文件即纠正）；UI 后置 |
| 10 | 心跳的 LLM 层 | 规则层（零 LLM）已验证；LLM 层（flags→自然语言条目）未对比 | 后置；先只上规则层 |
| 11 | 项目文件并发写 | 多会话同时写同一 project.md | edit 精确字符串替换，失败报错重试；单机单用户概率低 |
| 12 | 状态卡/项目卡的命名收敛 | 讨论中"状态卡"演化为"项目档案 project.md" | 以 04 文档为准 |

## 5.3 建议落地路线（M1 → M2 → M3）

**M1 · projects 读写与注入（dev.identity 内）**
- memoryRoot 下加 projects/ 初始化（index.md、inbox.md、_template 或无模板）
- 注入：identity_context 增加 `<projects_index>` 块（index.md 内容）
- system 提示增加维护指引（4 条维护规则 + 8 小节语义 + 频率分层）
- 模型按需 read project.md / inbox.md（无需新工具，走现有文件读写）

**M2 · 维护闭环验证（真机两周）**
- 观察指标：project.md 更新率（对话提到项目后文件是否同步）、格式漂移率、user.md 写入质量、inbox 使用率
- 与 mind-lab 基线对比：串项目、漏记在活文档模式下是否下降
- 冷启动收益：新会话开场模型能接上多少项目上下文（用户重述量下降）

**M3 · 心跳与收件箱接入（复用既有设计）**
- 规则层心跳扫 projects（updated 时间戳、nextStep 逾期、waiting 到期）
- 产出提醒到 inbox（文件），用户勾选回写
- 心跳价值定位：兜底（用户遗忘时），非主力

**后续 · 自主探索（L3）**
- 用户在任务状态之上的下一步愿景：对用户授权（autonomy 字段）的任务，系统自主推进——了解 todo、设计实验、迭代，用户只做验收
- 依赖：M1/M2 验证状态精度 + 授权模型（allowed/forbidden 动作）明确
- mind-lab 已有 agentic 工具循环和"探索域成功路径"设计，可作为自主循环的验证床

## 5.4 风险清单

1. **模型忘记更新文件**（实验证据：蒸馏漏记 20 轮）→ system 指引 + 更新前先读（看到旧状态有更新压力）+ 以后可加心跳比对"对话提到的项目 vs 文件 updated 时间戳"
2. **价值观提取谄媚化**（把随口说当信条）→ [user-stated] + 反复表达标准 + 低频写入
3. **格式漂移**（frontmatter 写坏、小节长乱）→ 索引扫描容错跳过解析失败文件；模板约束
4. **项目名碎片化重现**（红果下载器 vs 红果下载）→ 文件夹名即实体名，由用户或模型稳定命名；index 是唯一权威列表
5. **注入预算**（identity+user+index+digest 总量）→ 各块字符上限照现有（700/700/2600）+ index 每行极短
6. **与 biography 重复**（时间线与 events 重叠）→ 接受低成本冗余：projects 给当前工作，biography 给追溯；时间线裁剪为窗口视图
7. **多写者竞态**（并发会话写同文件）→ edit 精确替换失败重试；append 由 local tools 按 id 去重

## 5.5 相关资产索引

- mind-lab：`~/Downloads/mind-lab/`（实验代码 + results/rounds/r2-r4 归档 + README 迭代记录）
- 现有实现：`extensions/dev.identity/main.js`、`identity-core.js`（tag-tree-panel worktree）
- 现有记忆：`~/.zion-next/memory/`（identity.md / user.md / biography/）
- 本讨论文档：`docs/mind/`（本目录）
