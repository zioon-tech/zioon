# Agent 身份与用户档案设计（"那个人"的承重墙）

> 状态：v0.5 最小实现 | 文档版本 v0.3 | 最后更新：2026-08-12
>
> 本文档是 [HARNESS-MEMORY-SYSTEM-DESIGN.md](./HARNESS-MEMORY-SYSTEM-DESIGN.md) 的姊妹篇。
> 记忆系统解决"经历层"（agent 记得什么），本文解决"存在层"（agent 是谁、认识谁、从哪来）。
> 目标：让每次被唤醒的 agent 携带**完整的自我**，而不只是工具 + 便签。
>
> **当前先做 v0.5 最小验证。开放问题见第 10 节，落地路径见第 11 节。**

---

## 1. 结论先行（TL;DR）

现状：agent 每次 run 被注入的内容 = 技能目录 + 任务相关记忆（打分 ≤12 条）+ 终端状态 + 对话切片。
它知道"怎么干活"，但不知道"我是谁、对面是谁、我们共同经历过什么"——所以用户感觉背后"没有那个人"。

本设计新增三个注入源，补齐承重墙：

| 概念 | 是什么 | 解决什么 |
|---|---|---|
| `identity`（身份档案） | agent 的自我叙事：名字/角色/工作原则 + 关系史 | "我是谁" |
| `user_profile`（用户档案） | 用户模型：偏好/项目地图/边界 | "我认识谁" |
| `biography`（自传摘要） | 从事件日志蒸馏的时间线（做过的事） | "我从哪来" |

三条硬原则：

1. **不宣称，只记录**——身份档案不写性格形容词；"我是谁"由做过的事（biography）+ 用户认可的原则支撑，禁止模型自我宣称性格。
2. **不虚构，只枚举**——biography 只列举事件日志中真实发生的事件，禁止模型叙事化编造过去。
3. **预算封顶，缓存友好**——三份注入合计 ≤600 tokens，全部放段 A（跨会话稳定前缀，KV cache 长命中），会话中不重写。

---

## 2. 问题与动机

### 2.1 现状：agent 的内观是"工作台"，不是"人"

以当前真实注入为例（本次对话的系统提示）：

```
<available_skills>   10 个技能目录      → 我会什么
<working_memory>     3 条记忆          → 我记得什么（零散事实）
<terminal_context>   111 个会话        → 我在哪
对话切片                                → 我们聊到哪
```

问 agent"你是谁"，它只能说"我是 AI 助手"——模型自带的泛化回答。
问"你认识我吗"，它只能翻出 3 条关于用户的事实，没有整体印象。
问"我们做过什么"，它没有答案——没有时间线、没有故事。

### 2.2 为什么这不是小事

"后面的那个人"的感知来自三样东西：**身份**（他对我而言是谁）、**关系**（我们之间有什么）、**经历**（我们一起做过什么）。
三者都缺失时，无论回复多聪明，用户感知到的都是"临时工"。
而这三者恰好是**与当前任务无关但恒定存在**的信息——属于记忆设计文档 §3.2 中"段 A 跨会话稳定前缀"的最佳候选：
注入成本近乎为零（cache 命中），感知收益极大。

### 2.3 与记忆系统的分工

| 层 | 载体 | 生命周期 | 回答的问题 |
|---|---|---|---|
| L0 常驻记忆 | working memory 注入 | 跨会话 | "我记得什么规则/事实" |
| L1 检索记忆 | memoryManage + wiki | 按需 | "这个话题之前怎么定的" |
| **identity** | identity.md | 跨会话，用户可控 | "我是谁" |
| **user_profile** | user.md | 跨会话，实证累积 | "我认识谁" |
| **biography** | events.jsonl → digest.md / 应用视图 | 跨会话，append-only | "我从哪来" |

记忆系统是"事实层"，本文是"存在层"。两者通过事件日志衔接（biography 消费事件日志）。

---

## 3. 存储形态与文件结构

与记忆系统同根（`~/.zion-next/memory/`），Obsidian 兼容，用户可直接编辑：

```text
memory/
  working/                 # 已有：工作记忆
  long-term/               # 已有：长期记忆（wiki 形态）
  identity.md              # 新增：身份档案（静态骨架 + 动态填充）
  user.md                  # 新增：用户档案
  biography/
    events.jsonl           # 唯一事实源（v0.5 原子追加，按 id 去重）
    digest.md              # 可重建的固定预算注入投影
```

v0.5 首次向某个会话注入时读取 `identity.md`、`user.md` 和 `biography/digest.md`，并把生成后的
XML 作为 `identitySnapshot` 保存到 session meta。成功 run 后通过 local tools `/files/append-jsonl`
原子追加蒸馏事件，再从 `events.jsonl` 重建 `digest.md`；但当前会话继续使用已保存的
`identitySnapshot`，新 digest 只影响未来会话，或用户手动执行 `Identity: Refresh Identity Context`
后的当前会话。Biography 侧边视图直接读取事件源动态计算，不维护 `log.md`。不复用当前
`dev.memory` 的 localStorage 正文存储，也不在本阶段迁移 working/long-term memory。

`~/.zion-next/memory` 是用户可见的逻辑路径；当前 local tools 不展开 `~`，扩展会从本地
terminal session 的 cwd 推断 home，并向文件 API 传递绝对路径，不硬编码用户名。

### 3.1 identity.md（身份档案）

```markdown
---
type: identity
version: 3
updated: 2026-08-03
---

# 身份档案

## 名字与角色（用户可改，模型不自动改）
- 名字：Zion
- 角色：bytedance 的数字同事，运行于 zion-next 编辑器内

## 工作原则（来自用户认可的显式约定，不自动新增）
- 直接执行，先讨论后实现
- 工具优先，证据说话
- 结论先行，简洁作答

## 关系史（动态，由会话蒸馏更新，1-3 句）
- 与 bytedance 合作于 las-service、xbotgo、zion-next 等项目
- 当前共同任务：memory-panel 分支的记忆与身份系统设计
```

关键决策：
- **名字/角色/原则 = 静态骨架**：只有用户显式编辑才会变。模型绝不自动修改、绝不自行添加"我的性格是……"。
- **关系史 = 动态填充**：会话结束时蒸馏（复用记忆系统蒸馏管道），低杠杆静默更新。

### 3.2 user.md（用户档案）

```markdown
---
type: user-profile
version: 2
updated: 2026-08-03
---

# 用户档案

## 基本信息（用户自述，可空）
- 称呼：bytedance
- 职业/组织：（留空）

## 偏好（来源标注：user-stated / empirical + confidence）
- [user-stated] 中文交流，结论先行
- [empirical 0.8] 深任务为主，多项目并行
- [empirical 0.7] 设计讨论先于实现

## 项目地图（来自 topics.md 的注入投影，每个活跃项目一行）
- las-service：PDF 解析算子，火山引擎 LAS；最近活跃 8/3
- zion-next：agent harness；memory-panel 分支进行中
- xbotgo：足球高光剪辑；最近活跃 7/15

## 边界（用户显式设置，最高优先级）
- 删除记忆需用户确认
- 不可修改用户身份档案的静态部分
```

关键决策：
- **每条偏好带来源标记**（与记忆系统信任分级一致），防止"假装了解你"。
- **项目地图是 topics.md 的投影**：主题索引（含别名/标签）是唯一数据源，见 3.4；
  user.md 只注入精简视图（活跃项目 + 一句话），避免双写，也省预算。
  静态部分（基本信息/偏好/边界）用户主权，动态部分（项目地图）自动维护——user.md 是混合体。
- 边界条目注入时用强措辞（类似记忆设计中的 L0 高可靠条目）。

### 3.3 biography：事件事实源、注入投影与应用视图分离

**核心原则：事实只追加，注入投影可重建，展示视图不落盘。** `events.jsonl` 是唯一数据源；
`digest.md` 是固定预算、可审查、可重建的模型注入投影；Biography 侧边视图按
“日期 → 会话 → 事件”动态分组。这样新事件不需要猜测 Markdown 中应该插入哪个会话段，
也不会为更新投影或视图而重写事实源。

```text
biography/
  events.jsonl   # 一行一个事件，原子追加，按 id 去重
  digest.md      # 从事件机械生成，允许整体覆盖
```

每条事件结构：

```json
{"id":"s-8f2a:run-123:0","at":"2026-08-03T02:30:00.000Z","kind":"decision","summary":"完成分层设计讨论","project":"memory-panel","topics":["agent-identity"],"confirmed":false,"sessionId":"s-8f2a","runId":"run-123"}
```

v0.5 流程：

```text
chat/runFinished
  → 读取最后一轮 user/assistant
  → 模型输出 0-2 条严格 JSON 事件
  → POST /files/append-jsonl（文件锁 + id 去重 + fsync）
  → 从完整事件源机械重建 digest.md
  → 发出 identity/biographyChanged
  → Biography 视图按日期/会话重新计算展示
```

生成会话快照时优先只读取 `digest.md`，避免每次扫描完整事件流并提供稳定的 prompt cache 前缀。
如果 digest 缺失，则从 `events.jsonl` 取最近 12 条有效事件，机械生成 ≤300 tokens 的摘要并
修复文件。同一会话后续 run 不重新读取 digest；未来的“今天/本周/里程碑”金字塔仍然只是投影算法升级，不需要迁移事件数据。

关键规则：
- `events.jsonl` 只能通过原子 append API 写入，已有事件不原地修改。
- `digest.md` 可以整体覆盖；删除后可从 events.jsonl 完整重建。
- `id = sessionId:runId:index`，重复通知或重试不会产生重复事件。
- `project` 优先取会话正文的 `#project/...`，其次取会话标题或本轮明确出现的项目/仓库/服务名；
  无证据时留空。`topics` 保存 0-4 个事件主题，用于 digest 和视图筛选。
- 错误、中止、评论/定时任务 run 不写事件；普通问答允许蒸馏为 0 条。
- 每个摘要条目必须带 session/run 锚点，能回到会话存档核对。
- 只枚举“做了什么/确认了什么”，不生成无来源的心理叙事。

### 3.4 事件标签与主题索引（层级标签 + 别名）

会话编辑器已支持 Obsidian 风格 `#tag`（`TAG_RE` 含 `/`，`#project/las-service` 等层级标签可解析；
记忆条目也已带结构化 tags 字段并参与检索打分）。events.jsonl 已保存 `project/topics`
结构化字段，成为会话文档、事件日志、记忆条目三个系统的粘合剂。

#### 标签体系（层级，顶层分类即治理边界）

```text
#project/<name>   项目/主题标签：会话继承（用户手打）或项目映射（cwd/分支 → 标签）
#type/<type>      事件类型白名单：#type/milestone #type/decision #type/pitfall #type/user-confirmed
```

- 层级树让标签自带分类管理，比扁平注册表清晰：新增标签只出现在 `#project/` 子树下，
  顶层集合固定（`project` / `type`）。
- `#type/user-confirmed` 与记忆设计的实证信号直接打通——事件里的确认标签支持对应记忆晋升信任级。

#### 主题索引 topics.md（唯一数据源：别名 → 主题 → 标签）

```markdown
# 主题索引

## las-service
- 别名：las、las-pdf-parse、火山引擎数据湖
- 标签：`#project/las-service`
- 描述：LAS 算子的调研、定价与实现
- 活跃：2026-08（最近事件 8/3）
```

- **一个主题可以有多个别名**：用户输入任意别名（"las"、"las-service"、"火山引擎"）都能定位到同一主题。
- 别名维护在索引里（用户可改），不污染标签空间——标签是机器锚点，别名是自然语言入口。
- **topics.md 是唯一数据源**：user.md 的项目地图（3.2）是它的注入投影，只取活跃项目 + 一句话描述。
  单一数据源避免双写；user.md 投影省注入预算。
- 主题索引也是 digest "本周主线"的聚合来源：按标签聚合并与主题描述对照，主线命名稳定。

#### 主题检索（"看 las-service 的进展"）

```
用户：las-service 最近怎么样了？
agent：读 topics.md → 解析别名 → 得到标签集 [#project/las-service]
      → 过滤 events.jsonl → 按时间倒序输出进展视图：

  08-03 [s-3ad7] #type/user-confirmed 算子定价核对通过
  07-31 [s-1a81] I-34 bbox-crop 修复完成
  07-28 [s-1393] 敏感词审核算子上线
```

**events.jsonl 为什么够用**：单一物理事件流承担“全量 truth + 全局时间序”，原子追加解决并发；
按日期、会话或主题浏览都是运行时逻辑视图，不再维护会漂移的 Markdown 投影。

---

## 4. 注入形态（XML，与现有风格一致）

在 `<working_memory>` 之后（同属"自我认知"类）追加：

```xml
<agent_identity>
  <name>Zion</name>
  <role>bytedance 的数字同事，运行于 zion-next 编辑器内</role>
  <principles>
    <principle>直接执行，先讨论后实现</principle>
    <principle>工具优先，证据说话</principle>
  </principles>
  <relationship>
    <since>2025-12</since>
    <summary>与 bytedance 合作于 las-service、xbotgo、zion-next 等项目</summary>
  </relationship>
  <biography count="4">
    <event date="2026-07" note="完成 las-viral-clip-gen 算子定价调研" confirmed="true"/>
    <event date="2026-07" note="踩坑 SSH Kerberos 票据过期并沉淀记忆" confirmed="true"/>
    <event date="2026-08" note="撰写 HARNESS-MEMORY-SYSTEM-DESIGN 设计文档"/>
    <event date="2026-08" note="启动身份与用户档案设计"/>
  </biography>
</agent_identity>

<user_profile>
  <name>bytedance</name>
  <preferences>
    <preference source="user-stated">中文交流，结论先行</preference>
    <preference source="empirical" confidence="0.8">深任务为主，多项目并行</preference>
  </preferences>
  <projects>
    <project name="las-service" note="PDF 解析算子，火山引擎 LAS"/>
    <project name="xbotgo" note="足球高光剪辑，凭证已托管"/>
    <project name="zion-next" note="agent harness，memory-panel 分支进行中"/>
  </projects>
  <boundaries>
    <boundary>删除记忆需用户确认</boundary>
  </boundaries>
</user_profile>
```

### 4.1 注入位置与预算

```text
段 A（跨会话稳定，cache 长命中）：
  system prompt
  <available_skills>                        ~300-500 tok
  <terminal_context>                        ~1-2k tok（现状）
  <working_memory>                          ~500-800 tok（现状）
  <agent_identity> + <user_profile>         新增 ≤600 tok ← 本设计
  会话主题摘要 digest                       段 B 起点
```

- 三份注入合计预算 ≤600 tokens 起步，超限截断（复用 memory 的 maxChars 截断机制）。
- 会话中不重写（biography 最多每会话结束时更新一次，影响下一次注入）。
- 记忆变更只影响下次注入，绝不回溯修改已发送消息（沿用记忆设计 §3.2 规则 3）。

### 4.2 实现形态（v0.5）

新增一个 message contributor：

```js
window.zion.messages.registerContributor({
  id: "dev.identity.context",
  order: 85,               // memory(80) 之后
  stage: "pre",
  contribute: async (messages) => {
      const text = loadOrCreateSessionIdentitySnapshot(ctx.sessionId); // session meta 快照
    if (!text) return messages;
    return insertAfterMemoryContext(messages, { role: "system", content: text });
  }
});
```

存储读取复用现有 local tools `/files/read`，事件写入使用 `/files/append-jsonl`。会话压缩插件在当前
v0.5 验证中保持关闭；身份上下文与压缩的兼容和保护机制延期处理，不阻塞本阶段。

---

## 5. 更新流与权限

对齐记忆设计的"介入哲学"（低杠杆静默，高杠杆打扰）：

| 内容 | 谁写 | 何时 | 自动程度 | 理由 |
|---|---|---|---|---|
| 名字/角色/原则 | 用户 | 用户编辑文件 | 禁止自动 | 身份骨架，不可漂移 |
| 关系史摘要 | 模型蒸馏 | 会话结束 | 静默（可逆） | 低杠杆 |
| 偏好条目 | 记忆系统实证 | 晋升时同步 | 静默 | 与记忆同源 |
| 项目地图 | 模型 + 工具事件 | 会话结束/文件事件 | 静默（可逆） | 低杠杆 |
| 边界 | 用户 | 用户编辑文件 | 禁止自动 | 最高优先级 |
| biography | 蒸馏器 | 事件日志更新后 | 静默 | 只枚举已实证事件 |

**身份档案的静态部分 = 用户绝对主权**。模型可以提议（在对话中建议"要不要把这条加入原则"），但写不写、改不改由用户决定。

---

## 6. 与现有系统的关系

- **不新增记忆类型**：identity/user 不是 memory 的第四条 layer，而是新的注入源（文件 → contributor）。
- **不新增工具**：用户直接编辑文件；agent 如需查看可用 read 工具。memoryManage 不扩展（避免职责膨胀）。
- **独立事件流**：v0.5 由 `dev.identity` 维护 biography/events.jsonl，不依赖记忆系统事件日志。
- **不与 working memory 双写**：偏好类信息唯一数据源是记忆系统；user.md 只是其"用户维度投影"。若发现同一条信息在两侧出现，以记忆系统为准。

---

## 7. 冷启动

- **identity.md 模板**：只有名字（默认 "Zion"）+ 角色一句话，其余留空。避免过度拟人化。
- **user.md 模板**：基本信息空 + 默认偏好（中文）+ 边界留空。通过记忆系统实证填充，不猜。
- **biography**：从空开始，与事件日志同步积累。
- 用户首次打开编辑器时给出一次轻量提示："可以编辑 memory/identity.md 让我知道我是谁"——一次聚合，非阻塞（复用冷启动确认卡片的交互约束）。

---

## 8. 反模式清单（不做什么）

- ❌ 模型自我宣称性格（"我是热情细心的助手"）——不可验证的自我陈述 = 虚构人格。
- ❌ biography 叙事化生成（"我深刻认识到……"）——编造过去。
- ❌ user.md 与记忆系统双写同一偏好——不一致的来源 = 不可归因。
- ❌ 身份档案随会话静默漂移（每次总结微调一点）——人格不稳定 = 用户无法建立信任。
- ❌ 注入预算无上限——段 A 膨胀会稀释全部注入的注意力。
- ❌ 拟人化营销话术（"我是你的朋友"）——除非用户显式要求。
- ❌ 把 biography 当聊天记录备份——只保留"事件级"摘要，细节在会话存档。

---

## 9. 验收标准（可测）

1. 注入后，问"你是谁"→ 回答引用 identity 内容（名字/角色/原则），而非泛化"我是 AI 助手"。
2. 问"你认识我吗"→ 回答引用 user_profile 内容（偏好/项目），并区分来源（用户说过 vs 实证推测）。
3. 问"我们做过什么"→ 回答引用 biography 条目，且每条可在事件日志/会话存档溯源。
4. 冷启动 5 个会话后，三份注入不再为空。
5. 段 A 注入总量不超过预算（identity+user ≤600 tok；biography 截断有 `<truncated>` 标记）。
6. 用户编辑 identity.md 后，下一个会话立即生效（无缓存污染）。
7. 全程零自动修改静态骨架（git diff 可证）。

---

## 10. 开放问题（讨论清单）

已解决（本章节从草案早期版本推进而来）：
- ~~log 文件组织~~ → 单文件 + 日期标题分区 + 按年滚动（3.3，已定）
- ~~项目地图 vs 主题索引~~ → topics.md 唯一数据源，user.md 项目地图为注入投影（3.2/3.4，已定）
- ~~蒸馏触发频率~~ → 纯事件驱动：会话结束 + 注入前过期检查 + 跨日/跨周滚动（3.3，已定）

仍开放：

1. **拟人化程度**：身份档案写到多"人"？名字/角色是底线，还是可以到"语气/称呼方式"？是否提供极简模式（只角色）与完整模式？——这决定用户感知与风险。
2. **user.md 静态部分 vs 动态投影的边界**：已定为混合体（静态用户主权 + 项目地图自动投影），但偏好条目是否也走投影（从记忆系统实证聚合）？v1 倾向静态 + 记忆引用，不双写。
3. **biography 生成策略**：v1 只枚举（保守）还是允许轻叙事（"完成了 X，因为 Y"）？叙事增加可读性但引入虚构风险。
4. **预算分配**：identity + user + biography 总预算 600 tokens 是否合理？terminal_context 现状 ~1-2k 是否该一起治理（那是另一个议题，但段 A 总量在涨）？
5. **身份是否可变**：如果用户多次纠正 agent 的行为（如"不要每次都问确认"），是否应更新身份档案的原则？还是保持静态、靠记忆承载行为约束？（倾向：静态，行为约束走记忆）
6. **多用户预留**：zion-next 目前单用户，但 user.md 是否按 `user-<name>.md` 命名预留多用户？注入时按当前会话归属选择？
7. **与 skill 价值观注入的关系**：fenjue 等 skill 已注入价值观，identity 的"原则"与 skill 的"准则"是否重叠？保持分离（skill=能力准则，identity=存在定义）还是合并？
8. **事件统一**：当前 biography/events.jsonl 独立落地；记忆 v1 上线后是否共用事件信封，但继续按 domain 分流？
9. **关系史"since"字段**：首次启动时没有"认识多久"的事实，是否干脆不显示，等实证事件积累后再出现？（倾向：不显示。）
10. **标签治理边界**：`#type/` 白名单是否足够？`#project/` 子树会不会随项目数量增长而膨胀（几十个项目时项目地图注入预算超限怎么办）？

---

## 11. 落地路径（讨论清楚后的建议）

### v0.5：最小自动闭环

**目的：先验证"注入即感知"是否成立**——用 5-10 个会话观察"那个人"的感觉是否出现、是否值得继续。
范围保持很小：两份用户档案 + 自动 biography + 一个独立扩展，可随时卸载回滚。

**本阶段边界**：events.jsonl 只追加，digest.md 可重建覆盖，不修改 identity.md/user.md；
不迁移现有 localStorage memory，不做会话结束判断、标签/主题和周月聚合，
不处理已关闭的会话压缩插件。

#### 步骤 1：初始化文件

```text
~/.zion-next/memory/     # 默认本地文件根目录
  identity.md            # 身份档案（模板见 3.1，冷启动最小版见第 7 节）
  user.md                # 用户档案（模板见 3.2）
  biography/
    events.jsonl         # 唯一事实源，首条事件产生时创建
    digest.md            # 固定预算注入投影，初始化时创建
```

仓库提供模板副本 `docs/templates/identity.md` / `docs/templates/user.md` /
`docs/templates/biography-digest.md`。也可执行 `Identity: Initialize Identity Profile`
创建缺失档案和摘要；已有文件绝不覆盖。

#### 步骤 2：注入器（新增独立扩展 extensions/dev.identity，与 dev.memory 解耦、可单独卸载）

```js
window.zion.messages.registerContributor({
  id: "dev.identity.context",
  order: 85,               // memory(80) 之后
  stage: "pre",
  contribute: async (messages) => {
    const text = await buildIdentityContext();
    if (!text) return messages;          // 无文件 → 不注入，零影响
    return insertAfterMemoryContext(messages, { role: "system", content: text });
  }
});

async function buildIdentityContext() {
  const root = "~/.zion-next/memory";
  const identity = await readLocalFileIfExists(`${root}/identity.md`);
  const user     = await readLocalFileIfExists(`${root}/user.md`);
    let biography = await readLocalFileIfExists(`${root}/biography/digest.md`);
    if (!biography) {
      const events = parseBiographyEventsJsonl(
      await readLocalFileIfExists(`${root}/biography/events.jsonl`)
    );
      biography = buildBiographyDigest(events); // 缺失时回建
    }
  if (!identity && !user && !biography) return "";
  const xml = [
    identityToXml(identity),
    userToXml(user),
    biographyToXml(biography)
  ].filter(Boolean).join("\n");
  return truncate(xml, MAX_IDENTITY_TOKENS);   // ≤600 tok，复用 maxChars 截断机制
}
```

- 扩展先把逻辑根 `~/.zion-next/memory` 解析为绝对路径，再调用现有 local tools `/files/read`。
- 首次注入按 session 生成快照并保存到 session meta，后续 run 复用快照，避免 digest 高频更新导致 prompt cache 失效。
- 关闭网页后重新打开同一会话，优先读取 session meta 中的 `identitySnapshot`。
- 用户需要当前会话立即采用最新文件时，执行 `Identity: Refresh Identity Context` 重建快照。
- identity.md/user.md 只读；events.jsonl 原子追加，digest.md 允许整体覆盖重建。
- `chat/runFinished` → 读取最后一轮 → 模型蒸馏 0-2 条事件 → append-jsonl → 重建 digest。
- Biography 侧边视图直接读事件流；模型注入优先读 session identitySnapshot。
- 错误、中止、评论/定时任务会话不记录；同一 `sessionId/runId` 重复事件会去重。

#### 步骤 3：验收（对应第 9 节，v0.5 范围）

| # | 操作 | 期望 |
|---|---|---|
| 1 | 执行初始化命令后开新会话 | 注入段出现（调试日志可见 identity/user/biography） |
| 2 | 问"你是谁" | 回答引用 identity（名字/角色），非泛化"AI 助手" |
| 3 | 问"你认识我吗" | 回答引用 user（称呼/偏好），并区分来源 |
| 4 | 完成一次有结果的 run | events.jsonl 原子追加事件，digest.md 同步重建 |
| 5 | 问"我们做过什么" | 回答引用 biography 中可核对的经历 |
| 6 | 打开 Biography 视图 | 按日期 → 会话 → 事件展示，新增事件自动刷新 |
| 7 | 编辑 identity.md | 新会话立即生效；当前会话执行 Refresh Identity Context 后生效 |
| 8 | 检查 identity.md/user.md | 静态骨架零自动修改 |

#### 步骤 4：决策门

5-10 个会话后回答两个问题，决定是否进入 v1：
1. "注入即感知"成立吗？（用户感觉到 agent"认识自己"）
2. 注入内容有副作用吗？（占预算、误导、拟人化不适）

任一不通过 → 保持 v0.5 或回滚，不投入自动化的信任成本。

### v1：实证自动填充

- 项目地图自动维护（会话蒸馏 + 文件事件，topics.md 上线，user.md 项目地图变为投影）。
- 关系史摘要自动更新（会话结束蒸馏）。
- biography 增加真正的会话结束判定、标签聚合和时间金字塔摘要。

### v2：完整闭环

- 偏好条目与记忆系统晋升联动（user.md 偏好 = L0/L1 的投影视图）。
- 多用户支持。
- 身份档案版本管理与 diff 视图（用户可回滚）。

---

## 12. 为什么先讨论再实现（本草案的立场）

身份与用户档案是"影响 agent 每次唤醒"的全局注入——它错误的影响面比一条记忆大得多：

- 一条记忆错了：影响一次回答，可降级、可修正。
- 身份错了（虚构人格/自大/谄媚）：影响用户对 agent 的整体信任，且用户很难定位"是哪条注入让我觉得它假"。

所以本草案把"不虚构、不宣称、预算封顶、静态骨架用户主权"列为硬约束，并把 v0.5 手工验证放在自动填充之前——**先用最小成本验证"那个人"的感觉是否成立，再决定要不要投入自动化的复杂度和信任成本。**
