# 03 · mind-lab 沙盒实验：设计、四轮结果与关键发现

> 位置：`~/Downloads/mind-lab/`（完全独立于 zion-next 仓库，零第三方依赖，纯 Python 3.11 标准库）。
> 目的：用真实模型 + ground truth 世界，量化验证「对话 → 蒸馏(state) → 投影 → 心跳 → 收件箱」环路，把"蒸馏 state 可靠吗"从哲学问题变成有数字的问题。每改一版契约立即看到数字变化。

## 3.1 实验设计

```
三个模型角色（复用现有 DeepSeek 配置，请求显式 thinking=disabled）：
  assistant  = deepseek-v4-pro   (temp 0.3)  扮 Zion：有工具调用（agentic 循环）
  distiller  = deepseek-v4-flash (temp 0.0)  复刻 identity 蒸馏契约（含 state 铁律）
  user       = deepseek-v4-flash (temp 0.7)  扮虚拟用户"阿澄"（短剧素材运营）

虚拟世界 world.json（ground truth，两层）：
  意图层：3 个事项（adx爬虫 / 红果下载器 / 音视频生成日报）
         {project, goal, trueStatus, trueNextAction, trueBlockers}  ← 裁判对照基准
  实体层：爬虫进度/TOS对象数/剧集网盘状态/日报落盘日/文件系统  ← 工具真实改变

每天循环：
  早间心跳(仿真时钟) → 用户模型开场(可感知收件箱) → 对话 ≤5 轮
  （助手 agentic 回复含 [TOOL:name]{args} 标记 → 工具真实执行 → 结果回填）
  → 每轮蒸馏 → 投影状态卡 → 天末用户模型更新 world 意图层
  → 次日用户模型判定收件箱条目相关性

评估：
  裁判模型对每条带 state 的事件打分：correct / partial / wrong / hallucinated
  指标：project 空值率、串项目数、state 裁判分布、心跳触发、收件箱相关率
```

工具集（11 个，执行确定性改变 world）：run_crawler / check_crawler_status / dedupe_and_enrich / check_tos / search_drama / verify_download / list_files / read_file / write_file / generate_daily_report / notify_user。风控等用 day 做伪随机种子，可复现。

## 3.2 四轮结果对比

| 指标 | R1（4天） | R2（6天） | R3（8天，+工具） | R4（8天，+后处理） |
|---|---|---|---|---|
| 事件数 | 6 | **1（漏记严重）** | 20 | 16 |
| project 空值 | 2/6 (33%) | - | **0/20** | **0/16** |
| 串项目事件 | 未检出 | - | 2 条（D18 红果→adx） | **0** |
| state 裁判 | partial 4 | - | partial 7 / wrong 4 / correct 1 | partial 8 / **wrong 2 (17%)** / correct 2 |
| hallucinated | **0** | - | **0** | **0** |
| 心跳触发 | 0 | 0 | 0 | 0（见发现 5） |

## 3.3 契约演化轨迹（铁律 v0→v4）

| 版本 | 变更 | 触发原因 |
|---|---|---|
| v0 | 三铁律：只写明确出现 / owner 必填 / project 一致 | 初始设计 |
| v1 | +铁律4：status 仅表示整个 project 终态，子任务完成不得写 done；+铁律5：明确下一步才提 nextAction | 冒烟测试：模型把"完成某剧下载"写成 status=done（会把整卡标完成） |
| v2 | +铁律6：对话中反复出现的项目名必须用作 project，不许留空；+去重条款 | R1：2/6 事件 project="" |
| v3 | +记录正例/负例（决定/完成/确认 vs 盯着/收到/稍后） | R2：20 轮只有 1 条事件（"尚未完成的计划不记录"被过度泛化） |
| v4 | +铁律7：state 只描述本事件 project 的状态，绝不允许跨项目写下一步 | R3：D12 把红果的 nextAction 写进 adx 事件 |

## 3.4 六个关键发现（按对生产的指导价值排序）

1. **project 归属是第一风险，且有两种坏法**。空值（R1 的 33%）看得见；串项目（R3 D18：红果的搜索事件整条记到 adx 名下）看不见，直接导致状态卡 `[done] adx爬虫 next=校验红果《三十万鱼苗》链接`。契约约束不够，**最终靠规则层后处理修好（R4 串卡清零）**：PROJECT_KEYWORDS 词表（红果下载器→红果/网盘/剧/校验；adx爬虫→爬虫/410/TOS/去重）+ 冲突检测（summary+state 命中其他项目关键词且未命中自身 → 纠正 project；state.nextAction 与最终 project 冲突 → 丢弃 nextAction）。生产必须双保险：会话标签词表 + 规则层冲突检测。
2. **漏记比误记更隐蔽，需要监控指标**。R2 里"尚未完成的计划不记录"被过度泛化，明确事实（脚本路径、决定去重上传）全被拒记；误记有裁判能抓，漏记是静默的。生产应监控"蒸馏跳过率"，异常升高 = 契约过严。
3. **state 铁律整体有效：0 hallucinated，partial 是常态**。四轮没有一条状态凭空编造（最怕的污染守住了），但多数 partial（方向对、粒度粗）。坐实结论：候选态 + 用户确认回路不是可选项，是精度模型。
4. **nextAction 必须有完成清理机制，TTL 是补丁不是根治**。R4 里"去重上传"D2 已做完，但状态卡挂到仿真结束。实验用 TTL（3 天过期）修复；**根治方案在数据模型层**（04 文档）：`milestone_reached/blocker_resolved` 事实事件驱动物化器清除，或 nextStep 带 due 由时间语义判断逾期。
5. **心跳 8 天 0 触发的真正原因**：用户模型每天至少聊 2 个项目——和真实用户行为一致（高频触碰活跃事项）。**心跳的价值不在活跃事项，在用户遗忘时兜底**（修正心智定位：心跳是兜底价值，不是主力价值）。单元测试验证了冷落场景下规则正确触发（pending：待办挂 5 天 → "是否有进展？"）。
6. **工具能力让仿真质量质变，但暴露工具世界建模缺口**。"定时任务挂上→没生效→重挂"反复出现，因工具的定时任务状态没有建模（仿真基建问题，非环路问题）。

## 3.5 修复轨迹汇总

| 问题 | 修复 | 位置 |
|---|---|---|
| project 空值 | 铁律 6 + vocab 注入（蒸馏上下文带项目词表） | distill.py |
| 漏记 | 记录判断正例/负例 | 契约 |
| 串项目 | 铁律 7 + fix_project_mismatch 规则后处理 | distill.py |
| 同轮重复事件 | parse 时 project+kind+summary 前 40 字去重 | distill.py |
| JSON 截断丢事件 | max_tokens 1200→2000 + failures.jsonl 留存 | run.py |
| 旧 nextAction 残留 | NEXT_ACTION_TTL_DAYS=3（投影跳过过期待办） | project.py |
| 心跳无触发机会 | 仿真时钟修复 + 用户模型遗忘设定 + pending 词表放宽（待/等/有消息/催/安装包/链接） | heartbeat.py |
| 空转（assistant 口头承诺） | agentic 工具循环：承诺→真实执行→世界改变 | tools.py |
| 评估时间对齐 | 裁判对照 world 当天状态 | run.py |

心跳规则（规则层，零 LLM）：
- R1 stale：卡 lastActive >3 天且无 nextAction → "是否继续推进？"
- R2 pending：nextAction 命中等待词表且挂起 >2 天 → "是否有进展？"
- R3 dormant：>14 天 → "是否已结束？"
- 每日 ≤3 条；每卡每日 ≤1 条；条目带 [[memory:来源]] 可溯源；done 卡跳过

## 3.6 复跑方式

```bash
cd ~/Downloads/mind-lab
python3 run.py --days 8 --start-day 1   # 全新跑
python3 run.py --days 8 --start-day 5   # 续跑（从 data/ 恢复 world+events）
```

结构：`config.json`（模型配置）/ `lab/{llm,distill,project,heartbeat,sim,tools}.py` / `run.py` / `data/`（会话文档、events、cards、world）/ `results/rounds/rN-*`（每轮归档）/ `README.md`（完整迭代记录）。

## 3.7 实验结论对生产落地的作用

- 蒸馏契约 v4 的准确率基线：wrong ~17%、partial ~67%、correct ~17%、hallucinated 0%。真机部署后 wrong 率显著高于此 → 上下文或模型有变，立刻可察觉。
- 生产必须加"蒸馏跳过率"监控。
- 主模型直接维护状态（04 文档最终方案）的实验依据：独立蒸馏只看到最后一轮片段，是 partial/wrong 的主要来源之一；主模型有完整上下文。
