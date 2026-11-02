# 04 · 数据模型与记忆四象限（最终方案）

> 演化路径：状态卡规则投影 → 五层数据模型 → Taskwarrior/GTD 调研借鉴 → projects 文件夹方案 → 记忆四象限定稿。
> 本文件是当前定稿方向，落地形态：**作为 dev.identity（Biography）插件的新特性**，数据放 `~/.zion-next/memory/projects/`。

## 4.1 现有数据模型的三个根本缺陷

1. **事实与状态混在一条记录里**。`kind`（事件性质）+`summary`（发生了什么）是不可变历史事实；`state`（现在是什么样）是可变状态视图。生命周期、一致性要求、写入者完全不同，硬塞一起是混乱之源。
2. **用 project 字符串做实体键**。"红果下载器"和"红果下载"是两个实体，状态分裂。project 是标签，不是实体；实体需要稳定 ID。
3. **没有"修订"和"追溯"**。状态字段的值无从知晓来源、修改者、修改原因——所以出现"旧 nextAction 残留"（状态没有清除的语义来源，只能靠 TTL 猜）。

## 4.2 中间产物：五层数据模型（讨论中段提出，被后续方案简化）

核心原则：① 事实与状态分离（事件=不可变 WAL，状态=可变物化视图）② 实体用稳定 ID、名称是别名 ③ 状态=物化+覆盖（每个值可追溯）。

```
L0 对话原文（session 文档，不可变）
L1 事实事件流（重构 events.jsonl，fact 用动作而非分类）：
   goal_set / decision_made / milestone_reached / progress_reported /
   blocker_encountered / blocker_resolved / preference_stated / grant_changed / state_override
L2 事项（tasks.json）：id/aliases/goal/status/autonomy/entry/modified
L3 状态（物化视图）：每个字段 {value, source: derived|model|user, fromFacts[], confidence}
L4 授权（grants）：level(none|explore|routine|full) + allowed/forbidden 动作列表
L5 意图（intents，较长期，建议第一版砍掉）
```

三个决策点（当时提出）：状态存储形态（内嵌 vs revision 链，倾向内嵌）；意图层是否纳入（倾向砍）；fact 动作集 9 个是否收窄到 6 个（倾向收窄）。

## 4.3 项目管理语言调研（Taskwarrior / GTD / Jira / Letta）

### Taskwarrior（任务领域数据模型的黄金标准，RFC 化 JSON）

核心字段：`uuid / description / status / entry / start / end / due / until / wait / modified / scheduled / recur / project / priority / depends / tags / annotations / UDA`

五个核心设计思想：

| 设计 | 内容 | 治我们的什么病 |
|---|---|---|
| 显式状态 vs 派生状态分离 | 显式仅 pending/completed/deleted/waiting；ACTIVE/BLOCKED/OVERDUE/READY 等全是计算出的虚拟标签，不存储 | 我们 status 混了 5 个值语义不清 |
| waiting 机制 | status=waiting + wait 日期，到期自动回 pending | "等素材群消息"不再靠词表猜，日期自动激活 |
| 时间字段体系 | entry/start/due/scheduled/wait/end 各有语义 | nextStep 带 due，逾期进入 overdue 派生态——nextAction 残留的根治是时间语义而非 TTL |
| annotations | 不可变、带时间戳的追加式备注 | =我们事件流的单任务版，验证 append-only 方向 |
| UDA | 核心字段固定 + 任意扩展，客户端保留未知字段 | nextStep/blocker/owner 就是 UDA |

### GTD（方法论，与心智设计直接对应）

| GTD 概念 | 对应 |
|---|---|
| Next Action（"必须是能立即执行的具体动作"） | nextStep，且给出蒸馏质量标准：模糊的"推进项目"不合格 |
| Waiting For（等待他人清单） | pending/blocker，独立一等清单 |
| Project（任何需多步完成的目标） | Task 实体 |
| Weekly Review（每周回顾所有项目） | 我们的心跳（自动化了） |
| Inbox（收集箱） | 收件箱/杂思箱 |

### 其他

- Jira：Epic→Story→Subtask 层级 + workflow 状态机（transitions/conditions）——层级对当前粒度过度设计，不借鉴。
- Letta/MemGPT：memory blocks（label/description/value/limit、read_only、共享块）——印证 identity_context 注入块设计；"块描述决定模型如何使用"值得留意。

### 吸收与不吸收（明确判断）

**吸收 5 条**：显式状态收窄（pending/completed/deleted/waiting + 派生状态计算得出）；waitUntil 机制；nextStep 带 due；blocker 实体化（{value, since, resolvedAt} 生命周期）；schema 核心固定 + UDA 扩展。
**不吸收 2 条**：Jira 三层层级；Taskwarrior recurrence 模板（循环任务由 scheduler 管）。

## 4.4 最终方案：记忆四象限

**分类轴：对话里沉淀的一切，本质是"关于谁的"。**

```
                      ┌─────────────────────────────────────────────┐
                      │        memory/ 记忆四象限                     │
                      ├──────────────────┬──────────────────────────┤
                      │  关于「用户」是谁    │  关于「事项」要做什么      │
                      │  user.md（扩展）   │  projects/              │
                      │  ·价值观/信条       │  ·项目 → 项目文件夹       │
                      │  ·人生目标         │  ·杂思/idea → inbox.md  │
                      │  ·兴趣/爱好        │  ·项目经验 → 项目文件内     │
                      │  ·行为准则/偏好     │                        │
                      │  ·生活规律         │                        │
                      ├──────────────────┼──────────────────────────┤
                      │  关于「历史」发生过什么│  关于「AI」我是谁        │
                      │  biography/       │  identity.md（已有）     │
                      │  ·events 事件流    │                        │
                      │  ·lesson=经验的事实态│                        │
                      └──────────────────┴──────────────────────────┘
```

用户列举信息的落位表：

| 类型 | 落位 |
|---|---|
| 杂思、奇思妙想、idea | projects/inbox.md |
| 项目经验 | 项目文件"经验教训"小节 |
| 生活经验（作息规律等） | user.md（关于用户的事实） |
| 人生目标 / 人生信条 / 价值观 / 行为准则 / 兴趣 / 爱好 | **user.md 扩展**（不是新系统） |
| 项目本身 | projects/<名称>/ |

**关键结论**：用户列举的大部分（目标/信条/价值观/准则/兴趣）是 user.md 的扩展——user.md 现在只有"称呼/偏好/边界"三行，太薄了。

### user.md 扩展模板

```markdown
# 用户档案

## 基本信息
- 称呼：
- 角色：

## 价值观与信条
- [user-stated] 长期主义：做长期正确的事，不图短期快
- [user-stated] 反谄媚：要听真话，不要奉承

## 人生目标
- [user-stated] 想做出自己的产品

## 兴趣与爱好
- 投影仪/家庭影院折腾
- 播客

## 行为准则（协作方式）
- [user-stated] 中文交流，结论先行
- [user-stated] 宁可漏不可错

## 生活规律
- 周二上午 10 点有空盯爬虫

## 边界
（已有）
```

要点：`[user-stated]` 标记沿用现有设计，区分"用户亲口说过"与"模型推断"；价值观类只记用户**明确、反复、稳定**表达的，一次性随口说的不记（防谄媚：模型最易犯的错就是把用户某次随口的话奉承成信条）。生活规律是将来 L3 自主推进要用的时机知识。

### projects/ 结构

```
~/.zion-next/memory/projects/
├── index.md              # 全局索引（一行一项目，每次对话自动注入）
├── inbox.md              # 杂思收集箱
└── <项目名>/
    └── project.md        # 项目档案（8 小节，前门）
```

**index.md**（自动注入，几十行成本可忽略）：

```markdown
# 项目索引
| 项目 | 状态 | 优先级 | 下一步 | 更新 |
|---|---|---|---|---|
| adx爬虫 | active | high | 周二续爬 rank2 | 08-20 |
| 红果下载器 | waiting | medium | 等素材群消息 | 08-19 |
```

**inbox.md**（杂思，未成形的事项）：

```markdown
# 杂思收集箱
（未成形的想法，第二次被提及时提议立项）
- 08-18 想给投影仪装当贝市场
- 08-19 考虑对比 ArkClaw 自动化 Agent 方案
```

**project.md 完整模板**（8 小节 + frontmatter，真实数据示例）：

````markdown
---
project: adx爬虫
status: active          # active / waiting / done / archived
priority: high          # high / medium / low
owner: user             # user / zion / shared
created: 2026-08-01
updated: 2026-08-20
tags: [素材, 爬虫]
---

# adx爬虫

## 目标
爬周榜 Top50×200 部素材到 TOS，供爆款素材剪辑使用

## 当前状态
- 进度：rank2 已爬完 400/400，TOS 368 对象
- 下一步：周二续爬 rank3（用户待办，due 08-22）
- 阻塞：410 风控日限约 600 条
- 等待：无

## 计划
- [ ] 续爬 rank3-50（197 部，约 3 个月）
- [ ] 周榜 API 参数登录抓包确认后回填校验锁
- [ ] 效果分析：playNum 为 0 的改用 likeNum/exposureNum 替代

## 时间线
- 08-19 换IP+账号轮换策略生效，400/400 爬完
- 08-18 410 冷却停在 60/400
- 08-17 口径改定：周榜 Top50×200（原日榜 Top200×300）

## 产物与资源
- 数据：s3://tos/adx/rank2/（368 对象，45.74GB）
- 脚本：/data/adx_crawler/rank2.py、strategy.py
- 榜单快照：TOS 20260802 / 20260805 目录
- 分析文档：飞书《ADX 周榜爬取口径》

## 使用姿势
- 节奏：每天约 2 部、600 条内收手，隔天重登
- 周二上午 10 点开跑，人在场盯验证码
- 续爬：0 播放并列翻页漂移时改走 resume-zero-tie

## 经验教训
- 两份榜单快照仅重合 142/200，找旧剧要搜 0805 快照
- 素材仅投流切片，无正片
- 900s 节流也撑不住单剧 8 页连续请求

## 关联
- 下游项目：爆款素材剪辑
- 相关项目：红果下载器（同为 TOS 素材管线）
- 记忆索引：[[memory:...]]（关键会话）
````

小节语义与更新频率：

| 小节 | 回答的问题 | 更新频率 | 谁写 |
|---|---|---|---|
| 目标 | 是什么、为什么做 | 几乎不变 | 立项时定 |
| 当前状态 | 现在在哪、卡在哪、下一步 | **高频**（每次有进展） | 模型对话中维护 |
| 计划 | 未来还要做什么 | 中频（勾选/追加） | 模型+用户 |
| 时间线 | 最近发生了什么（倒序，保留 ~15 条，更早滚入 biography） | **高频**（追加） | 模型对话中维护 |
| 产物与资源 | 东西在哪（路径/链接） | 低频 | 模型+用户 |
| 使用姿势 | 怎么操作（命令/节奏/约定） | 低频 | 模型+用户 |
| 经验教训 | 什么不能做、踩过的坑 | 低频 | 模型 |
| 关联 | 还能索引到哪里 | 低频 | 模型 |

复杂度控制：**复杂度不来自小节数量，来自语义不固定**。8 小节各有唯一职责、格式固定，模型写起来比自由发挥更稳（Taskwarrior 思想：核心结构固定，内容自由）。

一个项目一个子文件夹（非单文件）：对齐 skills 心智模型；项目自己的产物（脚本/报告/配置）可自然放入文件夹；project.md 永远是前门。

### 晋升机制（四象限串起来）

| 流转 | 触发条件 | 动作 |
|---|---|---|
| 杂思 → 项目 | 同一想法第二次被提及 | 模型提议立项，用户确认后建文件夹 |
| 项目 → 归档 | status 改 done/archived | 从 index 活跃区折叠 |
| 对话 → 项目经验 | 踩坑/解决时 | 顺手写进"经验教训"小节 |
| 对话 → user.md | 稳定规律/反复表达的价值观 | 低频谨慎写入，带 [user-stated] |
| 一切 → biography | 对话结束（现有蒸馏） | 完整历史，可追溯 |

经验的两个形态：biography 的 lesson 事件是"事实态"（某次发生了什么），项目文件/用户画像里的经验是"沉淀态"（以后怎么做）——同一经验，一个可追溯、一个可复用。

## 4.5 注入与维护姿势

**自动注入**（每次对话，低成本）：identity.md + user.md + projects/index.md + biography digest。
**按需读取**：发现与某项目相关 → read 该项目 project.md（像 skills 的用法）。
**维护规则**（写进注入提示）：

1. 项目有实质进展（决策/里程碑/阻塞变化/完成子任务）→ 更新 project.md 对应小节
2. 新想法第一次出现 → 记 inbox.md 一句话；第二次出现 → 提议立项
3. 用户稳定表达的价值观/规律 → 更新 user.md（低频、谨慎、必须 [user-stated]）
4. 其他一切 → 现有蒸馏兜底进 biography

**维护频率分层**：project.md 是"活"的（天天变），user.md 是"稳"的（几周变一次），identity.md 几乎不变——模型知道每层的粘度，写起来才有分寸。

## 4.6 明确砍掉的部分（防过度设计）

**通用知识库（跨项目技术经验，如"lark-cli 要传 --spreadsheet-token"）第一版不做独立文件。** 理由：它最难（如何判断一条 lesson 是"通用的"？去重怎么做？），且 biography 的 lesson 事件已覆盖可查。等 projects 跑顺后，若发现"模型总在跨项目重复踩坑"，再从 lesson 提炼晋升。

## 4.7 最终版图

```
~/.zion-next/memory/
├── identity.md        # 我是谁（不变）
├── user.md            # 用户是谁（扩展 7 小节）
├── biography/         # 发生过什么（不变）
│   ├── events.jsonl
│   └── digest.md
└── projects/          # 要做什么（新）
    ├── index.md
    ├── inbox.md
    └── <项目>/
        └── project.md
```

落地形态：dev.identity 插件新特性，新增 projects 目录的读写 + index 注入 + 维护提示；user.md 是模板扩展；biography/identity 不动。
