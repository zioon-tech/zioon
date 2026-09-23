# CodeMirror 对话编辑器：产品差异化、交互质量与组件化评审

日期：2026-09-16

研究基线：`feature/core-observability`，HEAD `0d763dac` 及本轮研究时的工作区源码。

范围：桌面 Workbench 对话编辑器、富渲染、卡片、上下文编译、协作投影、导入导出与直接依赖。移动端只讨论共享契约，不把桌面验证外推为移动端验证。

性质：方案研究与代码审查；本轮没有修改产品实现。

## 1. 核心判断

**这套编辑器值得继续作为产品核心投入。最有价值的资产，是将可编辑文档、模型上下文和执行过程放进同一个工作对象。** 用户可以阅读回答、修改历史、选择局部内容、观察工具执行，再从编辑后的文档继续提问。这比单项 Markdown 渲染能力更有辨识度。

当前判断如下：

| 问题 | 判断 | 依据 |
| --- | --- | --- |
| 产品形态有没有差异化？ | 有，而且组合价值明显 | 同一文本同时承载角色、输入、回答、卡片顺序与上下文来源 |
| 能否称为市场唯一？ | 本轮证据不能支持绝对唯一 | Live Preview、AI 文档编辑、分支会话、Markdown 组件均有公开先例；没有找到足以证明全部组合完全等价的样本，也没有穷尽市场 |
| 是否应换掉 CodeMirror？ | 没有充分理由 | 文本事务、选区、撤销、扩展机制与 Yjs 绑定，符合当前核心模型 |
| 当前体验主要短板是什么？ | 内容安全、光标/选区反馈、滚动所有权、位置映射、流式确认和渲染一致性 | 已发现图片导入覆盖新输入、隐藏源码 caret 不可见、一次提交多次抢滚、归档丢卡片、图表编辑位置过期等具体路径 |
| 高内聚低耦合是否足够？ | 部分内核已较内聚，完整产品边界还不够 | projector、纯历史算法较独立；富渲染和编排仍混入宿主服务与全局状态 |
| 能否抽成组件或包？ | 可以渐进提取；目前适合内部复用，尚不能直接承诺宿主无关发布 | 本轮独立 HTML 已挂载 `EditorCore`；尚未通过独立包安装、稳定 CSS contract、双实例和完整归档验证 |
| 是否已经支持 Obsidian 式用户 CSS？ | 尚未支持 | 已有主题与插件注入 API，但没有普通用户 snippet 目录、启停、热更新、诊断和安全恢复流程 |

近期应先解决“会不会改坏内容、看到的内容是否可信、能否完整带走”，随后统一阅读与编辑行为，最后进行包提取。增加更多渲染语法不应抢在这些工作之前。

## 2. 研究方法与证据边界

本轮结合当前源码、已有测试、隔离函数探针、浏览器夹具与公开官方资料。全文区分四种证据：

- **浏览器复现**：使用当前源码的独立夹具，操作按钮并读取 DOM/文档状态。
- **静态确认/隔离探针**：有具体输入与完整调用路径；不等于真实 Workbench 中已录屏复现。
- **待验证风险**：机制值得关注，但尚无充分运行时证据，不当作必现故障。
- **设计边界**：当前有意选择的能力或限制，需要产品取舍。

主流程针对当前源码运行 **18 个测试文件、118 项用例，全部通过**：前端 15 文件/89 项，Runtime 3 文件/29 项。覆盖图片事务、WYSIWYG、角色解析、卡片、历史编译、会话加载、协作与投影。它们不是全仓回归，也没有覆盖本报告全部新发现。

测试必须排除 `.deploy-tmp`：Vitest 的路径过滤会匹配部署目录中的旧源码副本。首次包含这些副本的统计已剔除。Runtime 测试使用自己的 Vitest 配置；误用 Node test runner 的失败不算产品缺陷。

追加交互专项又排除 `.deploy-tmp` 与 `artifacts`，重跑 5 个相关文件、18 项用例并通过；它们与前述 118 项有重叠，不重复累计。现有用例仍没有覆盖隐藏 delimiter 的 caret/selection 几何、AX Tree 或用户 CSS snippet 生命周期。

浏览器夹具直接加载 `EditorCore.ts`、`src/styles.css` 与 KaTeX CSS，不加载真实会话或 Runtime。第一轮截图工具没有取得可靠图像，因此前序结论没有依赖截图。追加交互审查进一步使用 Chromium 测量了隐藏源码位置的 caret/selection 几何、公式 Widget 选区、computed style 和 Accessibility Tree，并检查了隔离夹具截图；仍**没有完成真实 VoiceOver/NVDA、中文输入法、移动触控或生产 Workbench 的像素回归**。对应场景在第 12 节列为后续验收。

针对“渲染标题末尾按 `Cmd+Shift+Left` 后选区不可见”的追加专项，夹具又加载了生产 `roles()` 扩展，并覆盖首行/非首行/角色块/折行标题、粗体、行内代码、公式和链接。结果不是所有标题无条件失败：H1 可见末尾的原生快捷键在当前隔离构建中有正常高亮；当边界端点是零几何 delimiter 时则稳定失败。完整按键序列与矩形数据见[键盘边界专项结果](../../.trae/editor-interaction-review-20260916/keyboard-boundary/keyboard-boundary-results.md)。

本轮原始证据、分组笔记与夹具位于 [研究工作目录](../../.trae/editor-review-20260916/verification-notes.md)。后续源码变化时，应重新核对本文行号。

阅读导航：第 3—6 节讨论产品与能力；第 7—8 节梳理根因与 34 类问题；第 9—11 节评估架构、样式扩展和独立化；第 12—14 节给出验收与实施路线。Runtime 尾部输出约束另列第 10.1 节，不混入渲染缺陷计数。

## 3. 差异化应怎样准确表达

### 3.1 产品对象是“可继续推理的会话文档”

当前模型由四部分组成：

1. **可编辑的正文**：用户输入与 assistant 输出处于同一份文本中，历史可以修改、重组、选择和引用。
2. **显式的会话结构**：角色行、assistant ID、thinking/tool marker 为文本附加会话语义。
3. **按顺序交错的执行记录**：思考、工具调用和正文可以在一轮中交替出现，位置参与历史重建。
4. **面向下一次运行的编译**：文档、卡片 payload、上下文边界与模型策略一起生成请求。

因此核心资产包括文档格式、上下文编译器、稳定身份、投影规则和交互政策。CodeMirror 提供的是能承载这些资产的编辑基础。

推荐的产品描述：

> 一款以可编辑 Markdown 文档承载 AI 对话与执行过程的工作台。用户在同一文档中阅读、修改和继续推理，并通过即时渲染查看公式、图表、图片及工具结果。

可以进一步强调“完整活动行保持渲染”“执行记录与正文统一排序”“上下文边界可控”，但必须准确说明各自实际语义。

### 3.2 公开相邻产品与可学习之处

下表只使用官方页面明确记载的能力。“未证明相同”不意味着对方不支持。

| 样本 | 官方资料已证明的能力 | 与本产品比较的重点 |
| --- | --- | --- |
| [Obsidian Live Preview](https://obsidian.md/help/edit-and-read) / [高级语法](https://obsidian.md/help/advanced-syntax) | 编辑时隐藏多数 Markdown；光标进入后显示语法；表格、Mermaid、数学公式 | 富渲染与源码编辑已有成熟参照。我们的组合增加了会话角色、模型上下文和有序执行卡片 |
| [ChatGPT Canvas](https://help.openai.com/en/articles/9930697-what-is-the-canvas-feature-in-chatgpt-and-how-do-i-use-it) | 右侧文档/代码工作区、局部选择编辑、版本恢复、导出与沙箱预览 | 可学习修改建议、版本差异、局部编辑可发现性；官方描述的工作对象与本产品完整会话文档不完全相同 |
| [Tiptap Markdown](https://tiptap.dev/docs/editor/markdown) | Markdown 与结构化 JSON 双向转换，扩展 parser/serializer，自定义语法 | 可学习公共 schema、插件契约与包边界；它证明 Markdown 编辑器组件已有成熟生态 |
| [SillyTavern 会话管理](https://docs.sillytavern.app/usage/core-concepts/chatfilemanagement/) | 分支、checkpoint、含元数据 JSONL 与纯文本导出 | 历史分支和可迁移会话也有先例；尤其值得学习“可读导出”与“可恢复归档”的明确区分 |

**差异化来自能力组合及其完成质量。** 它并不依赖“此前没有任何类似工具”的前提。基础交互可以借鉴成熟编辑器，文档与模型执行结合后产生的新问题则需要自己的契约和验证体系。

## 4. 优势、代价与最适合的场景

| 优势 | 用户收益与典型场景 | 对应代价 |
| --- | --- | --- |
| 文档与对话共用编辑面 | 研究报告、方案讨论、长文写作中，随时把回答修成下一轮输入 | 编辑旧内容也可能改变会话结构；用户需要知道下一次模型究竟看什么 |
| 源文本持续存在 | Markdown、代码、公式定义容易精确修改、版本比较和搬运 | 视觉位置与源码位置不同；复杂选择、复制、隐藏符号必须建立映射 |
| 活动行保持渲染 | 阅读时点击、移动光标不必立刻让整段格式“散开” | 完整链接/公式/图片成为替换 Widget 后，逐字编辑入口不够明显 |
| 执行过程在正文中有位置 | 分析任务可把“解释→工具→证据→结论”连贯阅读 | marker、payload、事件序号和异步确认必须一致 |
| CodeMirror 原生编辑能力 | 多选区、快捷键、撤销、搜索、Vim 等适合高频键盘用户 | 丰富快捷键与图形 Widget、浏览器原生选择可能争夺同一操作 |
| Yjs 多视图共享内容 | 同一会话可在多个面板观察，后台执行结果进入同一文档 | 共享内容与各自选区、展开、滚动不能混成同一层状态 |
| 富内容直接参与工作 | 公式、流程图、图片、表格不用另开工具才能理解 | 本地同步、异步本地、远端渲染有不同失败方式与高度变化 |
| 插件与纯算法已有基础 | 可逐步复用 projector、历史重建、卡片生命周期 | 目前没有贯穿解析、显示、历史编译、归档的完整第三方扩展协议 |

优势最适合“连续加工知识”的任务：推导、设计评审、代码分析、实验记录、长文迭代。短问短答中，这些自由度可能增加学习成本；需要轻量默认行为，让用户无需理解 marker、角色协议和投影机制就能使用。

还有一个必须明确的语义：**修改历史文本不会撤销已经发生的工具副作用。** 文档可以改写，磁盘文件、外部调用和执行事实不因此回滚。UI 应能区分“原始运行记录”“用户修改后的上下文”，避免把可编辑历史误解为可以重新定义过去。

## 5. 当前能力清单：支持什么，支持到哪一层

| 能力 | 当前实现 | 用户体验边界 |
| --- | --- | --- |
| 标题、强调、列表、引用、任务 | Lezer 语法树、行/mark 装饰与行内 fallback；任务框可回写源码 | 自定义正则与 Markdown 语法树共同工作，并非所有 CommonMark 写法都一致 |
| Keep Focused Line Rendered | `keepActiveLineRendered`，默认 true；完整活动行继续富渲染，部分未完成结构露源码 | “focused”实际按选区所在行计算，不是操作系统焦点，也不是滚动锁定 |
| 图片 | 行内、独立图片、连续图片 gallery；导入占位、预览、拖拽、缩放等 | 锚点、DOM 元数据、资源解析需共同维护；图片可见不等于模型已获得图片输入 |
| Mermaid | 本地异步渲染；支持源码编辑、复制 SVG、PNG 导出等按钮 | 位置过期、错误空白、主题与异步生命周期需要完善 |
| UML | `plantuml` / `puml` 围栏通过编码 URL 请求 PlantUML 服务 | 本轮识别分支没有 `uml` 别名；默认依赖公网服务，不等价于本地离线 UML |
| SVG 围栏 | DOMParser 与自定义过滤后插入 SVG | 清洗与资源访问需统一政策；不能把任意 SVG 当普通文字 |
| 数学公式 | KaTeX 行内与块级渲染 | 数字开头公式被货币规则误排除；表格及卡片路径不具备相同能力 |
| 表格 | 整表 block decoration，预览、源码切换、复制与选区映射 | 是带源码编辑入口的预览；不是能直接逐格编辑的完整表格组件 |
| 思考卡片 | marker 定位、纯文本展开、状态恢复、增量 DOM 更新 | 展开后仍截断 5000 个 UTF-16 code units；不具备正文同等富渲染 |
| 工具卡片 | 类型化展示、参数/结果、部分操作与来源跳转 | 部分结果有独立 Markdown 实现；payload、复制、导出政策尚未统一 |
| 流式预览 | SSE 临时文本 Widget；Yjs 确认后移除 | 临时文本与 durable 文档采用两条 Markdown 路径；部分 ACK 存在缺口 |

主要证据：[WYSIWYG](../../src/editor/wysiwyg.ts#L1948-L2551)、[图片模型](../../src/editor/image-model.ts#L22-L129)、[图片事务](../../src/editor/image-transactions.ts#L174-L334)、[图表](../../src/editor/wysiwyg.ts#L1786-L1935)、[思考正文](../../extensions/dev.thinking/thinking-cards.js#L319-L355)。

应把三个承诺分别验证：

- **能显示**：内容能否正确渲染。
- **能编辑**：源码入口、选区、撤销、复制是否自然且准确。
- **能参与模型上下文**：文本、图片与工具记录是否以预期形式被编译进请求。

只验证第一项，不能宣称完整支持了整个交互流程。

## 6. Keep Focused Line Rendered：值得保留，也需要补齐契约

### 6.1 当前真实行为

UI 名称是 **Keep Focused Line Rendered**，Core API 是 `setWysiwygKeepActiveLineRendered`。配置通过 `ui.wysiwyg.keepActiveLineRendered` 和本地偏好保存。[实现](../../src/editor/wysiwyg.ts#L2821-L2881)

关闭时，选区覆盖行通常露出语法。开启时，完整结构继续渲染，但空标题/列表前缀、未闭合链接、部分未配对 delimiter 会露出源码，方便继续输入。

这不是统一的“所有节点一直所见即所得”：

- 表格有自己的源码编辑状态。
- 图表有独立的展开位置集合。
- 公式、完整链接和图片主要通过 Widget 替换，内部不是普通可编辑文本。
- 未完成语法启发式对反引号、粗体等做了处理，对 `_`、`$` 没有完全对称的政策。
- 多选区的所有覆盖行均参与判断；失焦后选区仍存在。

### 6.2 为什么这项能力重要

普通 Live Preview 在光标进入时展开源语法，可能改变行宽、高度与点击位置。保持完整活动行的渲染，可以减少阅读状态与编辑状态之间的突变，对长对话中的定位、比较和连续阅读有实际价值。

代价是编辑目标容易变得不明显。例如用户点击一个公式，可能不知道应在哪里修改指数；左右键在隐藏 delimiter 附近移动，也可能出现“光标移动了但看不出来”的感受。

### 6.3 建议统一为三种可理解的局部状态

| 状态 | 行为 | 用户可用入口 |
| --- | --- | --- |
| 阅读 | 保持完整渲染，不因普通点击造成大幅高度变化 | 选择文字、复制、打开链接 |
| 局部源码编辑 | 仅目标结构露源码，保留其余上下文的阅读形态 | 明确的“编辑源码”按钮或一致的快捷键 |
| 未完成输入 | 输入期间容忍不完整语法，组合输入结束后再判断渲染 | 普通键盘输入、中文输入法 |

重点是统一局部编辑、退出、Escape、选择与撤销行为，而不是为每种 Widget 再增加独立开关。全局源码模式继续作为可预测的兜底。

本轮还观察到：切换该配置后，同一选区的隐藏标记未立即刷新，WYSIWYG 关闭再开启才生效。源码中插件更新没有将 facet 变化纳入统一失效条件。此项属于设置刷新问题，应与该功能的产品价值分开看。

### 6.4 光标“存在但看不见”是确定缺陷

用户反馈的现象可以由当前实现直接解释。完整 Markdown 行保持渲染时，粗体、代码、链接和公式等源码仍保留在 CodeMirror 文档中，但对应 DOM 被压成：

```css
.cm-z-hide-syntax {
  display: inline-block;
  width: 0;
  font-size: 0;
  line-height: 0;
  overflow: hidden;
}
```

标题 marker 更直接使用 `display: none`。[隐藏样式](../../src/styles.css#L4585-L4601)

文档没有为这些范围提供 `EditorView.atomicRanges`，所以键盘光标仍会逐字符进入不可见位置。Chromium 夹具对 `**阅读与编辑同一行**` 的测量结果：

- 开标记前与两个 `*` 中间是两个不同文档位置，却落在同一零尺寸坐标。
- 闭标记前、中、后也存在多个位置共用同一坐标。
- `ArrowRight` 会继续改变 `selection.head`，但视觉 caret 可能不动或高度为 0；用户会以为按键失效。
- 单独选中隐藏的 `**` 时，逻辑选区和复制文本存在，但选区矩形为 `0x0`。
- 精确选中公式源码 `$x+2$` 时复制结果正确，视觉选区却可能从 Widget 边缘延伸到行尾，并附带零高度矩形。

追加原生键盘矩阵进一步确认：

| 起点与操作 | 逻辑结果 | 可见几何 |
| --- | --- | --- |
| H1 `# Rendered Heading` 可见末尾，`Cmd+Shift+Left` | 选中 `Rendered Heading` | 正常，`177.48 x 24.5` |
| 角色块内 H1 可见末尾，同一操作 | 选中可见标题正文 | 正常，`295.78 x 24.5` |
| 粗体关闭 `**` 之后，同一操作 | 选中 `**bold content**` | 失败，`81.77 x 0` |
| 行内代码关闭反引号之后，同一操作 | 选中完整行内代码源码 | 失败，`87.21 x 0` |
| 粗体关闭 `**` 之后，`Alt+Shift+Left` | 只选中隐藏的 `**` | 失败，`0 x 0` |
| 标题隐藏起点，`Cmd+Shift+Right` | 选中完整 H1 源码 | 异常矩形 `y=-16776980, height=16777214` |

标题本身也有自然失败序列：从末尾第一次 `Cmd+Left` 到可见内容起点，第二次到 `display:none` 的文档位置 0；此时 `coordsAtPos(0)` 为 `null`，caret 消失，接着 `Shift+Right` 选中 `#` 仍没有任何高亮。因此应将用户反馈表述为**边界命令落入隐藏源码时失败**，而不是笼统写成所有 H1 的第一次整行选择都失败。

这不是颜色不够亮，而是**逻辑位置与可见几何不一致**。增加 caret 颜色或宽度无法根治。

建议确立以下不变量：

1. Rendered 模式中，每个可到达的逻辑光标位置都必须有可见 caret。
2. 如果两个相邻位置具有完全相同的视觉坐标，其中至少一个应在当前模式中不可到达。
3. 非空选区必须具有非零、与复制语义一致的可见区域。
4. replacement Widget 的源码选区应映射到 Widget 边界，不能画到整行尾部。
5. 选区矩形必须是有限、位于编辑器合理边界内的数值，不能接受零高或千万像素级哨兵几何。

实现上不建议让零字体 DOM 继续承担完整编辑语义。更稳妥的策略是：

- **阅读态**：将隐藏 delimiter 与完整 replacement 范围设为 atomic，左右键跳过内部位置。
- **局部编辑态**：用户通过 `Enter`、`F2`、双击或统一的“编辑源码”动作，使当前 Markdown node 暂时露出源码；此时恢复逐字符 caret。
- **选择态**：选择穿过 Widget 时，额外绘制基于源码范围到可见 node 的 selection overlay。
- **边界命令**：`Home/End`、`Cmd/Alt+Arrow` 及 Shift 变体按可见语义边界移动，隐藏 delimiter 不应消耗一次“上一词/下一字符”操作。
- **全局源码态**：继续作为精确编辑和故障恢复的兜底。

这比“只要光标进入整行就全部露源码”更符合 Keep Focused Line Rendered 的产品目标，也比允许光标进入不可见字符更可预测。

### 6.5 选区高亮需要区分四种语义

当前真实选区由 `drawSelection()` 绘制，重复内容由单独的 `selectionMatchLayer` 绘制，搜索和评论又有各自高亮。基础主题中：

```text
真实选区         --selection-bg        rgba(..., 0.35)
重复内容         --selection-match-bg  rgba(..., 0.14)
普通搜索         默认复用 selection-match token
当前搜索         默认复用 selection token
评论             黄色背景/下划线
```

真实选区和重复命中使用同一色相，仅靠透明度区分；默认搜索又直接复用这两组 token。[选区 token](../../src/styles.css#L145-L153)、[重复匹配层](../../src/editor/extensions/selection-match-layer.ts#L50-L74)

这会产生三种体验问题：

1. 用户难以快速辨别“我真正选中了什么”和“系统只是提示其他相同文本”。
2. inline code、引用和 role 背景改变底色后，同一透明色的实际对比度不稳定。
3. 隐藏源码或 replacement Widget 的几何错误，会让真实选区本身消失或扩张；颜色调整不能补救。

建议把视觉语义固定为：

| 层级 | 建议视觉 | 目的 |
| --- | --- | --- |
| 当前真实选区 | 最强实色背景，必要时加 1px 内描边 | 明确用户下一次输入会替换的范围 |
| 当前搜索结果 | 不同色相 + 边框 | 明确 Enter/Replace 将作用的位置 |
| 其他搜索结果 | 同搜索色相的低强度背景 | 支持扫描，不抢主选区 |
| 重复内容匹配 | 轻底色或细下划线，避免与搜索同色 | 仅提供关联提示 |
| 评论锚点 | 独立下划线/边缘标记 | 表达持久化语义，不伪装成临时选择 |

每个主题都应在正文、inline code、引用、用户/assistant role 背景上验证，而不是只在空白编辑器背景上选择一组 rgba。高对比模式还应允许关闭次级命中，只保留真实选区。

### 6.6 键盘、读屏与输入法不是附属能力

追加审查还确认：

- 选区工具栏虽然包含可聚焦按钮，但编辑器最高优先级捕获 `Tab` 做缩进；没有从当前选区进入工具栏的键盘命令、roving tabindex 或 `Escape` 返回协议。[工具栏](../../src/editor/extensions/selection-toolbar/index.ts#L241-L259)
- 视觉隐藏的 `**`、反引号、`$x+2$` 仍进入 Chromium Accessibility Tree，KaTeX Widget 又暴露一份公式内容；读屏可能同时遇到源码与渲染结果。
- 标题起始位置对 Space 的特殊处理没有检查真实输入法 composition 状态；macOS/Windows 中文输入法的候选确认仍需实机验证。
- `Alt+Shift+Left/Right` 与 `Shift+Arrow` 会先选中隐藏 delimiter；逻辑上选区已经改变，但第一次按键没有可见反馈，下一次输入却会替换 delimiter 并改变格式。

建议将 `F6` 或明确快捷键定义为“进入当前浮动工具栏”，左右键在工具栏内导航，`Escape` 恢复原选区和编辑器焦点。无障碍层面需要选择单一表示：不能简单把全部源码 `aria-hidden`，也不能让视觉 Widget 与隐藏源码重复朗读。最终必须使用 VoiceOver/NVDA 和真实组合输入验收。

### 6.7 会话触发和 assistant 插入不应各滚一次

用户观察到“触发对话时页面滚一次，插入 assistant 时又滚一次”，代码路径可以直接解释，不需要假设浏览器随机抖动。

当前一次主会话提交至少涉及三套滚动发起者：

| 阶段 | 发起者 | 当前动作 |
| --- | --- | --- |
| 提交准备 | `chat/preparing` → collaboration pending | 插入“正在准备” Widget，rAF 后将 pending 尾部拉入视口 |
| Run 接受/assistant 结构出现 | langchain chat | 调用 `scheduleDocLineVisible()` 定位 assistant 行 |
| 首批 token/pending 确认 | collaboration 或 browser token writer | 再定位 pending/assistant 尾部；pending 清除后还会做 settled follow |
| thinking/tool 卡片增长 | 各卡片插件 | 各自在 rAF 中直接调整 `scrollTop` |

[准备事件](../../extensions/dev.langchain-chat/main.js#L2808-L2852)、[pending 跟随](../../extensions/dev.session-manager/collaboration-client.js#L149-L218)、[pending 几何](../../extensions/dev.session-manager/editor/pending-assistant-plugin.js#L94-L153)

其中 `scheduleDocLineVisible()` 不是一次调度，而是 `sync → raf1 → raf2 → 80ms → 180ms` 五次重算；`scheduleAssistantLatestVisible()` 是 `rAF + 100ms`；pending settled follow 又是立即一次加 `120ms`。这些任务分别使用 assistant 行、assistant 尾部和 pending 尾部作为目标，布局又会被 role spacer、WYSIWYG 和 Widget 高度改变，因此后一次很容易得到不同的 `scrollTop`。[多阶段行定位](../../extensions/dev.langchain-chat/main.js#L512-L566)、[assistant 尾部定位](../../extensions/dev.langchain-chat/main.js#L419-L495)

还有两个更深的问题：

1. `runFollowLatest` 默认从调用参数计算为 true，不读取用户在 preparing 期间的最新状态。用户提交后立即上滚，overview rail 会设为 false；Runtime handle 接受后又在 [Runtime 路径](../../extensions/dev.langchain-chat/main.js#L1595-L1600) 或 [Browser 路径](../../extensions/dev.langchain-chat/main.js#L2255-L2257) 覆盖回 true。
2. `chat.followLatest.${sessionId}` 是 session 级状态，但滚动属于 view。collaboration client 遍历同一 session 的全部 views 执行 follow；现有测试甚至明确断言分屏两个编辑器一起滚到 `scrollTop=324`。[多视图循环](../../extensions/dev.session-manager/collaboration-client.js#L149-L195)、[当前测试语义](../../tests/session-collaboration-client.test.ts#L764-L893)

建议把滚动改为每个 `viewId` 独立的状态机：

```text
FOLLOWING_LATEST → READING_HISTORY → SELECTING / EDITING
         ↑                 |
         └──── 用户显式“回到最新”或近底部提交 ────┘
```

一次提交只产生一个 `scrollIntentId`：

1. 提交时若目标已经可见，不滚。
2. 空间不足时只做一次最小位移，使用户问题和 pending indicator 同时可见。
3. assistant marker 到达时保持 pending 锚点的屏幕 y 坐标，不再换目标滚第二次。
4. 流式增长每帧最多一次写入；thinking/tool/图片只提交“目标变高”意图，不能直接写 `scrollTop`。
5. wheel、touch、滚动条拖动、PageUp 和选择动作立即取消该 view 的全部排队意图。
6. 分屏中只有发起 Run 且仍在跟随的 view 移动；其他 view 保留阅读位置。

不建议继续增加 `80/100/120/180ms` 补偿。应提供单一 `ConversationViewportCoordinator`，统一合并同帧请求、取消过期任务、执行前重查用户状态、维护 bottom inset，并记录 `viewId/runId/reason/before/after`。完整时序见[滚动专项笔记](../../.trae/editor-interaction-review-20260916/scroll-lifecycle/scroll-lifecycle-notes.md)。

**实现状态（2026-09-16）**：E33/E34 的最小修复已落地。[conversation-viewport.js](../../src/chat/conversation-viewport.js) 以 `EditorView` 为作用域保存 follow、interaction epoch、提交周期和待执行请求，并将 pending、assistant marker、首 token、thinking/tool 增长合并到每帧一个请求。`doRun()` 只在提交入口开启新周期；Runtime/Browser 接受 Run 时不再重写 follow。原 `sync + rAF + 80/100/120/180ms` 校正已收敛为单 rAF，首 token 与前置定位共用 initial gate。collaboration 对本地 Run 只定位发起 view，未知来源的远端更新则逐 view 检查 follow。

当前实现保留 session key 作为旧状态的初始化兼容值，但运行中的决定来自 view 本地状态；一个分屏 detach 不会改变另一个已挂载 view。用户 wheel 或离底滚动会递增 epoch 并取消该 view 的排队任务，“回到最新”或下一次明确提交才恢复。尚未在本轮引入完整的 `SELECTING/EDITING/RESTORING_SESSION` 枚举和滚动遥测，这些仍属于后续交互层治理，不影响本次重复滚动修复。

## 7. 渲染问题的共同根因

### 7.1 需要保持一致的四个层面

| 层面 | 内容 | 必须维持的关系 |
| --- | --- | --- |
| 执行事实 | 有序 RunEvent、工具请求/结果、终态 | 不能因 UI 展开或重绘而变化 |
| 会话文档 | 文本、marker、cards、投影进度 | 同一事务中形成可恢复的会话状态 |
| 临时视图 | pending、加载占位、局部编辑态 | 可丢弃；不能覆写已确认正文，也不能重复展示已确认前缀 |
| 用户交互 | 选区、焦点、滚动、折叠、复制 | 必须映射到正确实例和正确文档版本 |

当前很多表象都来自层面之间的关系没有统一：装饰区间移动了但按钮仍用旧 offset；正文确认了但 pending 仍保留旧前缀；文本导出了但卡片 payload 没有恢复；共享会话数据的事件同时改变了另一个面板的本地状态。

### 7.2 已完成的改进要继续保留

当前统一 projector 已存在，正文、thinking/tool marker、cards、runProjection 在同一 Yjs transaction 中投影。Runtime 路径的 Workbench 使用 `documentWriter:false`，不再重复写正文；pending ACK 已从子串匹配改为 sequence。

思考与工具卡增量恢复保留本地展开状态；思考 DOM 支持复用。协作超时会撤销 ownership，并保留可编辑 fallback。这些已有代码和测试支撑，不能继续按旧架构报告为未修。

证据：[projector](../../extensions/dev.session-manager/session-document-projector.js#L256-L428)、[Runtime 投影事务](../../apps/runtime/src/collaboration-service.mjs#L244-L309)、[Workbench 兼容消费](../../extensions/dev.langchain-chat/main.js#L1630-L1644)、[展开状态回归](../../tests/chat-cards-dom.test.ts#L232-L310)。

不过，“统一投影已落地”不等于所有不变量均已闭合。部分 ACK、snapshot 仲裁与输出位置仍需分别核对，见后文。

## 8. 当前问题清单与处理顺序

P1/P2 是代码审查严重度；排序同时考虑用户内容完整性。架构欠债和未测性能没有为了凑数被列为缺陷。

| ID | 当前问题 | 用户后果 | 证据等级 | 建议次序 |
| --- | --- | --- | --- | --- |
| E01 | 图片导入锚点扩张为替换范围 | 导入期间在原位置输入的新文字被删除 | 浏览器复现，P1 | 先修 |
| E02 | 图片 DOM 保存过期源码位置 | 前方输入后删除图片，可能删错文字或留下残缺语法 | 静态确认，需完整工具栏复现，P1 | 先修 |
| E03 | 会话 JSON 导入丢 annotations | 思考/工具 payload 丢失，下一轮工具历史不完整 | 隔离执行现有函数确认，P1 | 先修 |
| E04 | 文件夹归档的 children 被忽略 | 导入只产生空会话，子会话和层级未恢复却返回成功 | 隔离执行现有函数确认，P1 | 先修 |
| E05 | 部分 ACK 不裁剪 pending 前缀 | 短暂显示 `AAB`，带来重复阅读与布局变化 | 真实 client/CM/Yjs 的隔离 DOM 探针确认，P1 | 先修 |
| E06 | WebFetch Markdown 链接属性注入 | 外部工具内容可形成事件属性；执行取决于 CSP | 隔离 DOM 探针，条件性 P1 | 先修渲染边界 |
| E07 | 图表按钮仍使用旧位置 | 图表前方编辑后，“编辑”按钮不再进入源码 | 浏览器复现，P2 | 随后 |
| E08 | WYSIWYG 清理回调存取对象不一致 | 开关/销毁后窗口监听与 observer 不能正确释放 | 静态确认，P1 | 随后 |
| E09 | 语法高亮重配置丢 roleScopedFencedCode | 未闭合代码块与后续角色的隔离规则退化 | 静态确认，P1 | 随后 |
| E10 | 数字开头行内公式被排除 | `$2+2$`、`$1/2$` 保留源码 | 浏览器复现，P2 | 统一语法时修 |
| E11 | 表格/pending/卡片的 Markdown 能力不同 | 同样内容在不同位置或确认前后出现不同表现 | 部分浏览器与隔离 DOM 确认，P2 | 统一语法时修 |
| E12 | 思考展开正文固定截断 5000 code units | 长思考尾部无法阅读或从卡片完整复制 | 静态确认，P2 | 随后 |
| E13 | 思考定向 snapshot 忽略 panelId | 同会话另一面板覆盖展开状态 | 静态确认，P2 | 多实例治理时修 |
| E14 | PNG/PDF 捕获全局第一个编辑器 | 在第二面板触发时可能导出错误会话 | 隔离 DOM 与调用链确认，P1 | 导出治理时修 |
| E15 | 最后一屏截图重叠未裁剪 | 拼接/分页产物重复部分正文 | 确定区间计算，真实像素待验，P1 | 导出治理时修 |
| E16 | 多编辑器图片工具共享 current | A 工具栏可能用 B 图片的范围删除 A 的内容 | 静态确认，待双实例复现，P1 | 先修 |
| E17 | 表格可见选区映射不对称 | 嵌套格式/转义字符使评论或选择操作锚到错误源码 | 静态确认，待 DOM Range 复现，P1 | 随后 |
| E18 | 表格范围缓存遗漏结构变化 | 修改分隔行后未出现表格，或代码围栏内仍显示表格 | 静态确认，P2 | 统一失效时修 |
| E19 | 评论更新未使表格 Widget 失效 | 新增、解决、激活评论后标记不更新 | 静态确认，待评论完整链路复现，P2 | 统一失效时修 |
| E20 | 两套围栏规则不一致 | 波浪线围栏、长短反引号嵌套中的内容被错误富渲染 | 静态确认，P2 | 统一语法时修 |
| E21 | UML 显示了实际不可用的导出按钮 | 复制 SVG、导出 PNG、新窗点击后无结果 | 静态确认，P2 | 随后 |
| E22 | 活动行渲染设置未使现有装饰失效 | 切换设置后旧展示持续存在，重装后才变化 | 浏览器 DOM 与静态确认，P2 | 统一失效时修 |
| E23 | 较新文本 snapshot 重建已有 Y.Doc | 合法离线文本更新后，服务端 cards/投影进度丢失 | 内存 PostgreSQL + 真实 projector/Hocuspocus 探针确认，P1 | 先修 |
| E24 | 隐藏 Markdown 源码仍参与字符、单词和行边界命令 | caret 可消失；非空选区可为零面积或千万像素异常矩形 | Chromium 几何与原生快捷键复现，P1 | 先修交互 |
| E25 | 隐藏源码和富 Widget 重复进入无障碍树 | 读屏可能重复朗读 delimiter、源码和渲染结果 | Chromium AX Tree 确认，P1 | 先修交互 |
| E26 | 选区工具栏无键盘进入/返回协议 | 键盘用户按 Tab 只会缩进正文，无法使用 AI with selection | Chromium 焦点复现，P1 | 先修交互 |
| E27 | 主会话 H1-H3 固定字号覆盖标题设置 | 用户选择 Small/XSmall 后主要标题不变化 | 级联路径确认，P1 | 样式治理 |
| E28 | 插件停用后 contributed CSS 未清理 | 已停用插件仍持续覆盖全局 Workbench | 生命周期路径确认，P1 | 样式治理 |
| E29 | `baseTheme: system` 的主题变体无法激活 | 公开 API 的合法主题永远匹配不到 DOM | 控制流确认，P1 | 样式治理 |
| E30 | 动态注册主题不进入 Appearance 下拉框 | 开发者主题只能从命令等旁路发现 | 配置路径确认，P1 | 样式治理 |
| E31 | `Mod-d` 会接受重叠 occurrence | `aa`/`aaa` 被合并成错误的大选区 | Chromium 复现，P1 | 编辑交互 |
| E32 | 字面量正则字符的搜索计数与高亮分裂 | `.`、`*` 等可能已高亮却显示 0 results | 双实现静态确认，P1 | 编辑交互 |
| E33 | 提交、assistant 插入和 pending 交接各自滚动 | 一次触发出现两次或多段页面位移/回弹 | 已实现单帧协调与提交周期 initial gate，P1 | 已修复并有单测 |
| E34 | followLatest 使用 session 级状态且 Run 接受时重置 | 用户上滚仍被抢回；同会话分屏一起滚 | 已改为 view 级状态；Run 接受不再重置，P1 | 已修复并有分屏回归 |

### 8.1 E01/E02：位置更新必须覆盖所有消费者

图片导入开始时 `from=to=6`。之后用户输入 `NEW`，代码分别用 `mapPos(from,-1)` 和 `mapPos(to,1)` 映射，空范围变为 `[6,9]`。完成导入时又按这个范围执行替换。

本轮浏览器的实际结果：

```text
开始：before
导入尚未完成，继续输入：beforeNEW
完成：before
      ![](app://img/review-only)
结果：NEW 被删除
```

这是通过真实 begin/complete 函数构造异步窗口，不是模拟网络图片已经加载；夹具关闭了图片渲染，未发起图片请求。[锚点映射](../../src/editor/image-transactions.ts#L178-L184)、[完成事务](../../src/editor/image-transactions.ts#L305-L325)、[粘贴入口](../../extensions/dev.paste-image/main.js#L56-L94)

应区分“插入锚点”和“替换选区”。插入时保持单点、明确左右亲和性；确需替换时，保存用户最初选择与变更后的有效性，不能把上传期间的新输入自动吞入替换范围。

E02 是同一家族的另一问题：`Decoration.map` 移动了装饰位置，Widget 的 `data-image-from/to` 却仍是旧值；图片工具栏直接用旧位置删除。应在执行删除、拖拽、编辑时解析当前稳定身份，并验证目标源码。[图片元数据](../../src/editor/wysiwyg.ts#L1012-L1094)、[快速 map 路径](../../src/editor/wysiwyg.ts#L2787-L2790)

### 8.2 E03/E04：导出可读文本不等于保存完整会话

会话导出保存 `{meta,doc}`，但导入时重新构造的 meta 没有保留 annotations。marker ID 留下了，思考文本、工具参数和结果却无法从 ID 反推出。文件夹导出则保存 children，导入器没有递归处理。

这直接损害用户对“自己的工作可以带走”的信任，也阻碍未来组件独立化。[导入器](../../extensions/dev.session-manager/main.js#L2072-L2097)、[导出结构](../../extensions/dev.session-manager/main.js#L3539-L3570)

修复应同时定义版本化归档、节点类型、payload 校验与引用重映射；失败或部分恢复必须可见。不能只补一个字段后宣称任意旧版本都可无损恢复。

### 8.3 E05：sequence ACK 需要确认到片段

新机制比正文 `includes` 判断可靠，但当前只保存累计 pending 文本和最大 sequence：

| 到达步骤 | Durable | Pending | 合成可见内容 |
| --- | --- | --- | --- |
| SSE：A，seq=7 | 空 | A | A |
| SSE：B，seq=8 | 空 | AB | AB |
| Yjs：只确认 seq=7 | A | AB | AAB |
| Yjs：确认 seq=8 | AB | 清除 | AB |

SSE 与协作 WebSocket 可以分别分批到达；单次 Yjs 事务正确，并不能消除此时序。[ACK](../../extensions/dev.session-manager/collaboration-client.js#L221-L235)、[pending 累加](../../extensions/dev.session-manager/collaboration-client.js#L351-L373)、[显示位置](../../extensions/dev.session-manager/editor/pending-assistant-plugin.js#L156-L174)

跨组复核使用当前 client、真实 CodeMirror/Yjs 与伪 provider，在 jsdom 中得到 `durable=A / pending=AB / DOM=AAB`，完整 ACK 后恢复 `durable=AB / pending=null`。该探针确认状态机缺口；真实网络延迟与布局影响仍需端到端测量。SSE 聚合与 Yjs 批次没有共享确认边界，不能只凭两者默认时间间隔排除这种交错。

应保留 `{sequence,text}` 片段，确认后只移除已提交前缀。若上游合并多个事件，还应保留 sequence 与字符范围的对应关系。

修完重复问题后，还要处理 Markdown 上下文：若已确认正文以半个代码围栏或半个粗体结束，pending 只解析剩余后缀仍会显示不一致。可以基于当前 assistant block 的 durable+pending 生成临时解析结果，但不能因此新增第二个 durable writer。

### 8.4 E07/E08/E09：优化与配置必须有完整失效规则

图表前输入一个普通字符后，装饰位置移动，按钮闭包仍捕获旧 `diagramFrom`。本轮对照实验中：未编辑前方文本时点“编辑”，diagram DOM 从 1 变为 0；前方插字后点“编辑”，diagram 保持 1、隐藏源码行仍为 3。[Widget 相等性](../../src/editor/wysiwyg.ts#L1789-L1794)、[位置闭包](../../src/editor/wysiwyg.ts#L2222-L2242)

只比较 code/lang 的 `eq` 不足以代表“DOM 行为仍等价”。主题、定位方式、操作回调、评论锚点等依赖变化，也必须纳入更新政策。可以把位置解析放在点击时，减少每次编辑重建整个图表的成本。

WYSIWYG 的 cleanup 存在 view 上，destroy 却从插件实例读取，实际没有执行对应清理。[注册与清理](../../src/editor/wysiwyg.ts#L2619-L2729)、[destroy](../../src/editor/wysiwyg.ts#L2802-L2805)

语法高亮切换时重新创建 Markdown 扩展，却遗漏初次安装的角色隔离扩展。应由同一个配置工厂生成初始和重配置版本。[初始化](../../src/editor/EditorCore.ts#L505)、[重配置](../../src/editor/EditorCore.ts#L829-L840)

### 8.5 E10/E11：统一语义比统一 CSS 更重要

当前至少存在四种正文表达路径：

- 主文档：CodeMirror/Lezer + WYSIWYG。
- pending：mdast 转 DOM。
- 思考：纯文本 pre。
- 部分工具结果：正则 Markdown 转 HTML。

表格又维护独立行内解析和选区映射。本轮已确认正文 `$x+2$` 有 KaTeX、同样公式在表格中没有；数字开头公式也没有。pending 的引用式链接退化为文字、引用式图片消失，非 1 起点列表忽略起始数字。[公式规则](../../src/editor/wysiwyg.ts#L47-L60)、[pending renderer](../../src/chat/markdown-dom.js#L95-L139)

建议共享语法政策、链接/资源解析、公式识别、错误降级和源码映射契约；不同容器可以保留不同 DOM 实现。对未支持节点应保留可读源码或明确降级，不能悄悄消失。

### 8.6 E06/E12—E15：完整性也包括可读、可复制与正确导出

WebFetch renderer 将未做双引号转义的 URL 拼进 href，再写 innerHTML；隔离探针确认可以生成事件属性。Runtime CSP 可以阻止 inline handler，因此不能声称所有生产部署均可执行，但 renderer 自身仍需安全 DOM 构造和 URL 政策。[工具 Markdown](../../extensions/dev.tools/tool-calls.js#L1478-L1522)

长思考展开后仍被 `fmt(text,5000)` 截断，没有显示完整或复制原文入口。应采用按需分段或完整复制，不能让数据保存成功但用户无法访问。

定向思考 snapshot/clear 复用了面向 session 广播的过滤逻辑，应区分数据广播与面板控制。[过滤](../../extensions/dev.thinking/thinking-cards.js#L1002-L1012)、[控制事件](../../extensions/dev.thinking/thinking-cards.js#L1305-L1316)

截图导出必须传明确的 EditorView，而非全局 querySelector。最后一屏也要按实际覆盖区间裁剪：1500px 内容、1000px 视口若采样 0 和 500 再拼两张完整图，会输出 2000px，重复 500px。[目标选择](../../extensions/dev.export-editor/main.js#L223-L227)、[采样](../../extensions/dev.export-editor/main.js#L310-L320)、[拼接](../../extensions/dev.export-editor/main.js#L355-L375)

### 8.7 E16—E22：多实例、结构解析和派生缓存

图片增强插件的 `current` 在 activate 层共享，而工具栏删除闭包分别捕获自己的 view。依次操作 A、B 图片后再点 A 工具栏，可能组合成“A 的 view + B 的坐标”。这一问题需要把当前图片归属到实例，并在命令执行时再次校验。[共享状态](../../extensions/dev.image-enhanced/main.js#L844-L850)、[删除](../../extensions/dev.image-enhanced/main.js#L977-L983)

表格还有三类不同的契约：

- **source map**：渲染器递归处理 `**a _bc_ d**`，可见位置映射却未递归，选择 `bc` 可能映射成 `_b`；转义 pipe、`<br>` 也要保留原始 offset。[映射](../../src/editor/wysiwyg.ts#L170-L255)、[选择回传](../../src/editor/wysiwyg.ts#L1493-L1519)
- **结构缓存**：修改尚未识别为表格的分隔行，或在表格前引入围栏，会改变解析结果；只检查新插入字符与已知 table range 不足以决定缓存仍有效。[范围复用](../../src/editor/wysiwyg.ts#L882-L899)
- **外部依赖**：评论锚点变化不一定改变表格文本，必须有显式 revision/effect；只发 `wysiwyg-refresh`，外层表格 StateField 和 Widget 相等性仍可能返回旧值。[更新](../../src/editor/wysiwyg.ts#L925-L928)

围栏也应只有一份结构来源。当前语言层支持 tilde/backtick，并检查关闭围栏字符和长度；WYSIWYG 自己的规则只识别 backtick，且关闭长度政策不同。因此语法高亮正确并不能证明图片、公式与表格不会误渲染到代码内部。[WYSIWYG 规则](../../src/editor/wysiwyg.ts#L36-L37)、[语言层](../../src/editor/roleScopedMarkdown.ts#L28-L98)

PlantUML 通过 img URL 显示，但共用工具栏按钮依赖 `svgString`，该分支从未赋值。renderer 应声明 `canCopySvg/canExportPng/canOpen` 等能力，仅显示可执行操作；远端失败时也应有可读状态。[按钮与 UML 分支](../../src/editor/wysiwyg.ts#L1813-L1893)

这些问题说明，扩展协议至少要回答：**数据或依赖变了，哪些派生结果需要重算；实例销毁后，谁负责停止工作。** 仅开放“添加一个 Widget”无法保证扩展后的正确性。

### 8.8 E24—E32：编辑反馈与样式扩展不能只靠 CSS 覆盖

E24—E26 是焦点行渲染下最直接的交互问题。E24 的根因和浏览器证据见第 6.4 节；它不仅影响左右逐字符移动，还影响 `Home/End`、`Cmd/Alt+Arrow` 及 Shift 选区。E25/E26 则分别要求建立单一无障碍表示与完整键盘焦点协议。三者的共同原则是：**任何逻辑可操作状态都必须有可见、可感知、可撤销的反馈。**

E27 说明当前设置与最终样式已经发生漂移。Appearance 的 Small/XSmall 只改 `--md-h1-size` 至 `--md-h6-size`，基础标题规则也消费这些变量；最终主会话规则却以高特异性和 `!important` 将 H1-H3 固定为 20/18/16px。[标题设置](../../extensions/dev.editor-config/main.js#L586-L612)、[最终标题样式](../../src/styles.css#L6975-L6987) 因此标题设置在用户最常见的三级标题上不生效。

E28 是插件样式生命周期问题。`autoLoadStyles()` 记录了每个插件注入的 `<style>`，也实现了 `removePluginStyles()`；正常 `deactivate()` 路径却没有调用它。禁用、卸载、更新或热重载插件后，插件逻辑可以消失，旧 CSS 仍继续影响整个 Workbench。[停用路径](../../src/plugin/manager.ts#L1130-L1164)

E29/E30 表明主题开发者 API 与主题选择 UI 尚未闭环：

- `registerVariant(..., { baseTheme: "system" })` 是公开合法参数，但 `apply()` 在 system preference 下强制使用 `data-theme-variant="default"`，注册 CSS 永远匹配不到。[主题应用](../../src/theme/themeManager.ts#L213-L224)
- 命令面板会动态合并注册主题，Appearance 下拉框和 allowlist 却是硬编码内置主题；新主题不能从标准设置入口发现。[主题设置](../../extensions/dev.editor-config/main.js#L941-L983)

E31/E32 是与选区反馈相关的两个编辑器基础命令问题：

- `Mod-d` 只按起点排除重复 occurrence，没有排除区间重叠。文档 `aaa` 选择 `0..2` 的 `aa` 后，回绕找到 `1..3`，CodeMirror 将两个重叠范围规范化成 `0..3`；用户得到 `aaa`，不是第二个 `aa`。[多选区实现](../../src/editor/EditorCore.ts#L38-L69)
- 搜索装饰使用正确的字面量转义，面板计数维护了另一份错误转义。搜索 `.`、`*`、`[` 等字符时，可能已经存在高亮和导航结果，面板仍显示 0 results。[搜索面板](../../extensions/dev.search-replace/main.js#L657-L674)

这些问题不应通过增加更多颜色或 `!important` 修补。交互层需要稳定的 selection/source-map/focus 契约，样式层需要稳定的 token、scope 和生命周期契约。

### 8.9 E33/E34：滚动需要单一所有者和 view 级用户意图

E33 是多写者问题。pending assistant、chat Run、token writer、thinking/tool renderer 都可以直接写 `scrollTop`，并各自安排 rAF 或延迟校正。一次提交不存在可以取消旧任务的统一 intent，也没有“assistant 结构已经接管 pending 锚点”的交接协议。`forceBottom: true` 虽被调用方传入，目标函数也没有消费，说明滚动 API 的调用语义已经漂移。

E34 是状态作用域和时序问题。用户在 preparing 阶段已经上滚，Run 接受仍会把 followLatest 恢复成默认 true；同一 session 的两个 view 又共享这一个值。共享会话文档不意味着共享滚动意图。应把 follow/detached、用户交互 epoch、排队 intent 和最近目标全部放到 `editorId/viewId` 层，Run 只携带内容锚点。

最小修复不应是删掉某一个 `scrollTop`。应先指定 Coordinator 为唯一写者，再让 pending、projection、card renderer 只上报目标变化；否则删掉任一路径都会在慢 Runtime、首 token 延迟、卡片变高或分屏场景重新暴露。

本轮实现采用上述边界的最小版本：

- `src/chat/conversation-viewport.js` 统一持有 view 级状态、同帧合并、epoch 取消和提交周期 initial gate。
- chat、pending collaboration、thinking、tool 只向 Coordinator 注册 reveal 回调；旧多阶段 timer 已删除。
- Runtime 投影携带 `editorView/followCycleId`，本地提交只驱动发起 view；没有来源的恢复事件仍可更新所有处于 following 的 view。
- `tests/conversation-viewport.test.ts` 覆盖提交至首 token 一次定位、preparing 后 detach 不被 Run 接受覆盖、同 session 双 view 独立；collaboration 集成测试已改为 A detached/B following。

这次没有重写每个 renderer 内部的目标几何计算；Coordinator 已成为调度和取消的单一所有者，后续可以在不改变调用方的前提下继续统一 safe inset 与滚动审计。

## 9. 高内聚低耦合：现在的边界在哪里

### 9.1 已经做对的部分

| 模块 | 评价 | 可复用资产 |
| --- | --- | --- |
| EditorCore/Proxy | 编辑能力较集中；没有直接导入会话管理器或模型 SDK | EditorState/View 生命周期、选区、快捷键、compartment |
| restore / widget-history | 多数是纯算法或少量本地依赖 | marker 恢复、历史重建、工具消息配对 |
| session-document-projector | 职责集中，依赖 Yjs 与格式辅助函数 | 有序、幂等、统一事务的 Run 投影 |
| SessionRuntime / DocumentRuntime | 已使用 callbacks 和切换 token | 防止过期加载覆盖、加载失败处理、卡片恢复编排 |
| CardTypeRegistry | 已有 kind 与 restore/clear/snapshot 注册 | 卡片生命周期的扩展起点 |

不能用“大文件”直接推导“低内聚”。projector 约 655 行但依赖和职责相对集中；没有 import 的导出模块却可能通过全局 DOM 与宿主服务产生明显耦合。

### 9.2 阻碍独立发布的具体依赖

| 边界泄漏 | 当前代码证据 | 影响 |
| --- | --- | --- |
| 默认工具栏创建全局注册表，并调用 `chat.runSelection` | [selection-toolbar](../../src/editor/extensions/selection-toolbar/index.ts#L29-L71)、[命令调用](../../src/editor/extensions/selection-toolbar/index.ts#L131-L140) | 独立挂载仍可能创建 `window.zion`；多个应用实例共享全局 |
| 文档操作混入 Workbench 焦点政策 | [doc.ts](../../src/chat/doc.ts#L224-L248)、[follow 状态](../../src/chat/doc.ts#L404-L414) | 纯格式算法带着侧栏、终端和 panel DOM 约定 |
| WYSIWYG 读取评论锚点/工具栏/PlantUML 全局配置 | [评论](../../src/editor/wysiwyg.ts#L384-L425)、[图表服务](../../src/editor/wysiwyg.ts#L1876-L1893) | renderer 不能仅凭文档与配置工作 |
| Proxy 暴露 any/raw view，调用方穿透 core.view | [Proxy](../../src/editor/EditorProxy.ts#L68-L75)、[session-manager](../../extensions/dev.session-manager/main.js#L2927-L2936) | facade 没有形成稳定公共契约 |
| 外部扩展只有追加接口 | [Core](../../src/editor/EditorCore.ts#L857-L863) | 调用方需要自行维护 compartment 与卸载 |
| ownership 通过 DOM dataset 判定 | [DocumentRuntime](../../src/session/document-runtime.ts#L64-L75) | DOM 属性承担数据权威语义，测试和适配困难 |
| 应用编排横跨模型、会话、菜单、通知、树与持久化 | [chat 编排](../../extensions/dev.langchain-chat/main.js#L1424-L1747)、[session 全局状态](../../extensions/dev.session-manager/main.js#L455-L473) | 整个 extension 直接搬入包会携带大量宿主能力 |
| 组件样式分散于全局及容器选择器 | [基础样式](../../src/styles.css#L4548)、[slot 样式](../../src/styles.css#L6554)、[panel 样式](../../src/styles.css#L6784) | 依赖整份应用 CSS，宿主页面易受影响 |

研究中的 AST 计数显示，`dev.langchain-chat/main.js` 直接字面访问 23 类宿主服务、约 290 次；session-manager 为 16 类、约 278 次。这里只计 `window.zion.<service>` 形式，遗漏别名访问，不能当完整依赖数量；它说明编排层与内核应有不同拆分策略。

**结论：保留 EditorCore 兼容外壳，把通用 kernel、默认 preset 和 Workbench adapter 分开；不要把整个 session-manager 或 langchain-chat 打包成“编辑器依赖”。**

### 9.3 Markdown 样式是否足够用户友好

结论是：**默认视觉已经达到可用且相对成熟的基础，但还没有形成稳定、可预测、可让用户放心修改的视觉系统。**

已有优势：

- 主会话正文限制在约 720px，长对话具有合适阅读宽度。
- 角色边界、18px 会话间距、标题、引用、inline code、代码块、表格和图形已经形成明确层级。
- Light/Dark 与多个内置 variant 主要通过根 token 切换；正文、选区、caret、Markdown 和 role 均已有变量。
- 表格具备横向滚动、表头、斑马纹与 hover；图形和代码块有统一工具栏；工具/思考卡整体风格接近主文档。

主要问题不在“没有样式”，而在**同一视觉被多层规则反复定义**：

- `src/styles.css` 当前约 8,100 行，包含 248 个 `!important`；基础 `.cm-*`、`.zion-editor-slot` 和最终 `.zion-panel .zion-editor-host...` 多次覆盖同一属性。
- 正文 padding 至少经历四轮取值，最终效果依赖源序和选择器权重。
- 主题公开了 `--md-codeblock-*` 等 token，最终 panel 层却常优先消费 `--surface-*`；主题作者只看 Markdown token 清单无法完全预测结果。
- user/system role 最终颜色有硬编码，部分表头、错误态和卡片状态也绕过语义 token。
- tools/thinking 各自维护多轮“final override”，一致性依赖复制数值和加载顺序，而不是共享 card style contract。

因此当前默认主题可以继续使用，但下一步应做的是“样式治理”，不是重新设计全部视觉：

1. 删除被末尾规则完全覆盖的旧 block，保留单一生效来源。
2. 为正文、标题、引用、代码、表格、图形、role、thinking/tool card 各定义最小语义 token 集。
3. 主会话最终层继续消费这些 token，不再固定像素和主要颜色。
4. 建立 light/dark、所有内置 variant、窄宽容器和卡片状态的 computed-style/截图回归。
5. 将 selection、search、comment 和 focus 视觉作为独立语义纳入主题契约。

### 9.4 当前 CSS 能力与 Obsidian snippets 的差距

项目并非完全没有 CSS 扩展能力：

- `window.zion.theme.registerVariant()` 可注册主题选项，并注入根节点变量覆盖。
- `window.zion.styles.register(id, css)` 可在运行时注入全局 `<style>`，支持 `dispose/get/list`。
- 插件 manifest 的 `contributes.styles` 可加载静态 CSS。

这些是**插件开发者 API**，不等价于 [Obsidian CSS snippets](https://help.obsidian.md/snippets) 的普通用户能力。Obsidian 官方流程提供 snippets 目录、刷新、列表、逐项启停、持久化和保存后自动应用；当前 Workbench 没有用户 snippet 目录、UI、顺序、热更新、错误诊断、last-known-good 或 safe mode。

主题设计文档还列出了 `window.zion.styles.registerStylesheet(id, url)`，但当前公开类型与运行时仅实现 `register/get/list`。在把样式系统作为独立组件能力对外承诺前，文档、类型和实现需要由同一契约生成或至少有自动一致性检查。

浏览器 computed-style 验证进一步说明：

- 覆盖 `--md-h1-size`、`--selection-bg`、`--caret-color` 等变量可以即时生效。
- 普通 `.cm-md-h1 { color: ... }` 不能稳定覆盖最终 panel 的高特异性/`!important` 规则。
- 即使用户写出更长选择器并增加 `!important`，也会进入特异性军备竞赛；这不应被当作正式扩展方案。

建议将外观能力分成三个层级：

| 层级 | 目标用户 | 能力 | 风险边界 |
| --- | --- | --- | --- |
| Appearance Preset | 普通用户 | 字体、字号、行高、宽度、标题、选区色、密度等 token | 只允许结构化变量，最稳定 |
| CSS Snippet | 高级用户 | 本地 CSS 文件，逐项启停、排序、热更新 | 默认只作用于编辑器 scope；标为受信本地代码 |
| Theme/Plugin | 开发者 | 全局主题、组件样式和扩展逻辑 | 需要 manifest、版本和生命周期 |

推荐 snippet 产品模型：

```ts
type CssSnippet = {
  id: string;
  fileName: string;
  enabled: boolean;
  order: number;
  scope: "editor" | "workbench";
  contractVersion: 1;
  lastGoodHash?: string;
  diagnostics?: Array<{ line: number; column: number; message: string }>;
};
```

桌面端可以使用应用数据目录下的 `snippets/*.css`；Web 端可以使用 IndexedDB/文件导入提供等价管理。每个 snippet 独立加载、原子替换；解析失败保留 last-known-good，不让一个错误文件阻断 Workbench。UI 至少提供“打开目录、重新扫描、逐项启停、排序、查看错误、禁用全部自定义 CSS”。

CSS 是强能力，不是无害配置。任意 CSS 可以：

- 通过 `url()` / `@import` 发起网络请求，形成隐私泄露。
- 隐藏安全提示、工具状态或按钮，造成误操作。
- 使用昂贵 selector、filter、animation 产生渲染性能问题。
- 破坏 CodeMirror 的几何假设，重新引入 caret/selection 错位。

因此 editor scope 应是默认，global/workbench scope 需要显式风险确认；远程资源默认禁用或经过权限策略，限制单文件与总大小，并提供安全启动模式。

未来组件包应发布稳定 CSS contract：

```css
@layer reset, tokens, core, components, extensions, user;
```

- 用户普通声明位于最后的 `user` layer；迁移前需要先减少关键 `!important`，因为 important 声明的 layer 优先级与普通声明相反。
- 组件根使用稳定的 `[data-zion-editor]` / `[data-zion-component]`，内部暴露 `data-part`、`data-state`；不要要求用户依赖 CodeMirror 生成的匿名 class 或复杂 DOM 层级。
- token 需要 `cssContractVersion`、stable/experimental/deprecated 清单和至少一个大版本的 alias 迁移期。
- 插件 style registry 的 key 应包含 `{ownerId, styleId}`；当前全局 id 的 last-write-wins 与旧 disposer 删除新样式风险不适合作为公共组件契约。
- 插件停用必须移除其 contributed style，主题注册/注销和设置页选项必须保持一致。

这套方案可以达到“像 Obsidian 一样可定制”，同时避免把当前内部 CSS 类名永久冻结为公共 API。

## 10. 两个需要显式收敛的现有契约差异

### 10.1 上下文边界与输出位置是两个独立策略

此前项目约束要求 Runtime 输出强制落在文档末尾。但当前源码仍发送锚点，projector 优先解析 relative position/offset；已有测试明确支持在历史锚点处插入。本轮没有找到 `preferDocumentEnd` 实现，不能把记忆中的约束写成已实现事实。

此外，当前上下文截取为：

```js
lines.slice(0, cursor.line + 1).join("\n")
```

因此边界是**光标所在行末**，不是精确光标字符。同一行光标后面的文字也进入请求。[编译入口](../../extensions/dev.langchain-chat/main.js#L2031-L2040)、[锚点](../../extensions/dev.langchain-chat/main.js#L2148-L2173)、[投影位置](../../extensions/dev.session-manager/session-document-projector.js#L439-L469)、[中间插入测试](../../apps/runtime/tests/collaboration-service.test.js#L1163-L1186)

建议以显式字段表达：

```ts
type SubmitPolicy = {
  contextBoundary:
    | { kind: "cursor-line-end"; offset: number }
    | { kind: "cursor-offset"; offset: number };
  outputPlacement:
    | { kind: "document-end" }
    | { kind: "anchor"; anchor: DocumentAnchor };
};
```

按既有产品约束，Runtime adapter 应固定 `document-end`，并在服务端落实；局部插入如继续支持，应是明确的独立操作。输入从历史位置截取与输出落在尾部完全可以同时成立。UI 可通过轻量边界标识或上下文预览让用户确认本轮范围。

### 10.2 Yjs 与 snapshot 仍需唯一权威规则

旧投影评审记录了“PostgreSQL snapshot 只作派生 checkpoint”的目标，但当前 `collaboration-service` 加载时仍有时间戳比较，并可能从较新 snapshot 文本创建新 Y.Doc。[加载分支](../../apps/runtime/src/collaboration-service.mjs#L172-L208)

由纯文本重建不能自动保留原 Y.Map cards、runProjection 和 CRDT 身份。跨组复核通过当前真实 `PostgresWorkbenchStateStore(:memory:)`、projector 和 Hocuspocus 的隔离探针确认了 E23：

1. 保存带一个思考卡、`lastSequence=2` 的 Y.Doc。
2. 文档未驻留时，使用正确 expected revision 通过现有 session 更新接口修改文本。session head 更新，但 collaboration blob 没有同步。
3. 首次协作加载发现 snapshot 更新且文本不同，从纯文本重建 Y.Doc。
4. 加载后的 `cards=0`、`runProjection=0`；重新解码已保存 collaboration blob 仍均为 0。

这是合法文本更新的完整可达路径，不仅是抽象的架构担忧。协作超时后仍可编辑和保存时，前端也可能进入文本 PUT 路径。已有 annotations 或旧客户端可能提供额外恢复来源，但服务端权威 map 的丢失已经成立。

另一个“空 Y.Text + 非空 snapshot”的修复分支有既有回归目的，不能与正常 snapshot 仲裁混为一谈。

建议区分三条路径：

1. 没有 Yjs state 的首次 bootstrap。
2. 已有 Yjs state 的正常加载，始终以其因果状态为准。
3. 明确的修复/版本恢复命令，带来源、预期 revision 和完整状态迁移。

不能把 timestamp 新旧当成内容完整性的证明。修复应让合法文本更新进入现有 Document Aggregate，再派生 checkpoint，不能只删掉覆盖分支后忽略离线编辑。本轮没有确认真实用户会话已经因此丢失；以上是隔离内存环境复现，不代表上一轮历史事故再次发生。

角色行也是协议的一部分：当前 parser 对 fenced code 中行首 `system `、`assistant ` 等保留形式仍可能切分消息。应统一角色 grammar 与转义规则，而不是让渲染器、编译器、projector 各自依赖略有不同的正则。

## 11. 独立组件/包的目标边界

### 11.1 先形成少量稳定入口

以下为建议命名，尚未实现：

| 入口 | 职责 | 允许依赖 |
| --- | --- | --- |
| `conversation-document` | 角色/marker grammar、card schema、纯位置算法、Prompt Compiler、归档 codec | 无 DOM、无 Workbench、无网络 |
| `conversation-document/yjs` | Yjs binding、相对锚点、Run projector、checkpoint | document 协议、Yjs |
| `conversation-editor` | CM adapter、选区、交互状态、renderer registry、组件样式 | document 协议、CodeMirror |
| `conversation-editor/presets` | Markdown、公式/图表、Vim/minimap 等可选集合 | editor 公共 API 与可选渲染库 |
| Workbench adapter | 全局命令、评论、资源、模型设置、会话导航、菜单和通知 | 上述公开接口与应用服务 |

初期可用一个包的子入口验证边界，不需要一次拆出大量 npm 包。React wrapper 应是可选薄层；领域协议与默认编辑器不应因此必须依赖 React。

CodeMirror、Yjs 的 peer dependency 和版本策略需要明确，防止宿主和组件加载不同副本。Mermaid 等重依赖应按 preset 懒加载，并测量实际产物；本轮没有测得包体积，不能承诺拆分后一定减少多少。

### 11.2 组件接口应暴露能力，避免暴露整个宿主

```ts
const editor = mountConversationEditor(parent, {
  document: conversation,
  extensions: markdownPreset(),
  cardRenderers,
  assets: assetResolver,
  onSubmit: request => runtimeAdapter.start(request),
  ui: {
    requestFocus,
    shouldFollowLatest,
  },
});

const registration = editor.registerExtension(customExtension);
registration.dispose();
editor.dispose();
```

这只是接口草案。运行事件由 document aggregate 统一投影，editor 订阅文档与 pending；`onSubmit` 不得让另一个 `onToken` 同时写 CM/Yjs。

建议补齐以下端口：

- `DocumentBinding`：加载、只读、同步中、离线、恢复中的显式状态；不靠 dataset 表达权威。
- `AssetResolver`：解析、导入、取消、失败重试、释放；不直接读应用数据库。
- `InteractionPolicy`：焦点、滚动、局部源码编辑与选择策略。
- `Diagnostics`：按 run/card/view 定位事件，不把临时 debug 全局变量变成公共接口。
- `Disposable`：插件、订阅、异步任务、observer 的一致释放契约。

内容按 documentId 共享；执行按 runId 管理；选区、展开和滚动按 editorId/viewId 管理。需要共享某项 UI 偏好时，再由宿主显式同步。

### 11.3 真正可扩展的卡片协议

当前 CardTypeRegistry 主要注册恢复、清理和快照事件。它不是完整 renderer 扩展协议：collaboration-client、projector、widget-history 仍有 tool/thinking 硬编码分流。

第三方卡片至少需要贯通：

| 能力 | 契约 |
| --- | --- |
| 身份与格式 | kind、schemaVersion、稳定 card ID、所属 assistant block |
| 数据 | validate、migrate、序列化与未知类型保留 |
| 展示 | renderer、更新、销毁、fallback、局部源码/纯文本视图 |
| 运行投影 | 哪类事件更新 payload，如何保持顺序与幂等 |
| 模型历史 | 是否参与上下文，如何编译成 provider 支持的消息 |
| 搬运 | 复制、导出、导入、资源引用与必要的数据隐藏策略 |

可以先用一种“证据引用卡”验证：只通过公共接口注册，即可经历运行、刷新、上下文编译和归档往返。若仍需修改内核 switch，扩展边界尚未闭合。

### 11.4 归档与协作 checkpoint 分开

推荐 portable archive 最少包含：

```ts
interface ConversationArchiveV1 {
  format: "zion-conversation";
  version: 1;
  document: { text: string; grammarVersion: 1 };
  cards: Array<{
    id: string;
    kind: string;
    schemaVersion: number;
    assistantBlockId: string;
    payload: unknown;
  }>;
  assets: Array<{ id: string; mime: string; hash: string; path: string }>;
  metadata: { title: string };
}
```

这是分享到新会话的可移植归档。原文档的协作 checkpoint 则需要保留 Yjs 身份与状态，不能仅用这个 JSON 替代。

导出需获取同一文档版本的 text/cards；正在运行时明确等待 ACK 或标记 partial。导入应重建新 session 身份、保持内部引用一致、保留未知 card kind，并明确缺失资源。不能把活动 controller、ownership 或未完成 run 原样导入继续执行。

“可读 Markdown”“完整归档”“PNG/PDF 展示”应是三种明确的导出选项。纯文本不能保证卡片 payload 和 `app://` 图片在另一安装中恢复。

## 12. 交互质量与回归验收矩阵

以下是建议新增的验收，不是本轮全部已经测试。

| 场景 | 操作序列 | 必须满足 |
| --- | --- | --- |
| 流式顺序 | 思考→正文→工具→正文；工具轮有/无 completed；刷新 | 阅读顺序与持久化顺序一致，每个身份最多一个对应块 |
| 分段 ACK | SSE 连续 token，Yjs 只确认前缀，再完整确认 | 已确认文本恰好一次；pending 只保留未确认后缀 |
| 不完整 Markdown | 流式输出半个 fence、列表、表格、公式，再补齐 | 无内容静默丢失；补齐后正确渲染；不破坏后续角色 |
| 焦点行策略 | 开关切换、多选区、点击完整结构、Escape 返回 | 设置即时生效；局部编辑入口一致；源文档不变 |
| 隐藏 delimiter 光标 | 左右键逐个经过 `**`、反引号、链接、公式边界 | 每次逻辑位置变化都有可见 caret；Rendered 模式不进入无几何位置 |
| 键盘边界命令 | 首行/角色块/折行中的 H1、粗体、代码、公式、链接执行 `Home/End`、`Cmd/Alt+Arrow` 及 Shift 变体 | 隐藏源码不消耗可见操作；非空选区面积大于 0；矩形有限且位于编辑器内；视觉行与逻辑行语义有明确定义 |
| Widget 选区 | 正反向选择公式/链接/图片源码，跨越普通文本与 Widget | 非空选区始终可见；几何覆盖对应 Widget；复制语义明确且稳定 |
| 高亮语义 | 真实选区、重复匹配、当前/普通搜索、评论在不同背景叠加 | 五种语义可快速辨识；高对比模式可关闭次级命中 |
| 选区工具栏键盘 | 选中文本后进入工具栏、移动、执行、Escape 返回 | 不修改正文；焦点与原选区可恢复；所有鼠标动作有键盘路径 |
| 中文输入法 | 标题、列表、公式边界内组合输入，候选选择 | composition 期间不重建输入目标、不吞字、不重复提交 |
| 图片异步 | 导入中在锚点处/前后输入、切换文档、取消/重试 | 新输入完整保留；结果只写入发起文档；取消后不迟到插入 |
| 位置映射 | 图片/图表/表格前插入删除，接着编辑/删除/拖拽 | 操作始终指向当前对象；不使用失效坐标改正文 |
| 图表生命周期 | 慢渲染时切源码、删除、切主题、关闭面板 | 旧结果不回写新节点；有可读失败态和重试；测量高度更新 |
| 公式 | 数字/变量/分数/货币、块公式、表格及卡片 | 语义政策一致；货币与公式规则有明文边界 |
| 长思考/工具 | 大于 5000 字，展开、滚到底、复制 | 可访问完整内容；局部滚动不意外改变外层跟随 |
| 用户阅读控制 | 流式时上滚、选择文本、展开历史卡片、返回最新 | 用户主动阅读期间不抢回尾部；显式操作后才恢复跟随 |
| 会话触发滚动 | 近底部/中部提交，preparing→assistant marker→首 token | marker 前最多一次可感知位移；交接无第二跳；目标已可见时不滚 |
| preparing 期间脱离 | 提交后立即 wheel/touch/PageUp/拖滚动条，再等待 assistant | 16ms 内取消该 view 的排队意图；Run 接受和首 token 不抢回 |
| 同会话双面板 | A 看历史/B 跟随；分别展开；A snapshot/clear | 共享正文，各自交互状态稳定；控制命令只作用目标 |
| 复制语义 | 普通文本、渲染表格、卡片内部、跨卡片选区、Vim | 明确复制可读内容还是源码；卡片提供完整原文入口 |
| 键盘与读屏 | Tab、Enter/Space、展开/收起、加载/失败 | 按钮有名称与展开状态；不逐 token 打断宣读；隐藏语法不重复朗读 |
| 归档往返 | 文本+工具+思考+图片+未知卡片+文件夹 | 正文/payload/层级可恢复，下一次编译消息等价或明确说明差异 |
| 协作恢复 | 首次 hydration、超时、重连、重复/迟到事件、版本恢复 | 不把未确认空状态持久化；不以墙上时钟覆盖有效 Yjs |
| 导出 | 第二面板、隐藏 slot、多屏内容、异步图片/字体 | 目标正确，正文无重复裁切，失败可见 |
| 多实例销毁 | 连续挂载/销毁与 WYSIWYG 开关 | observer/listener/timer 回到基线，无旧实例响应 |
| Appearance token | 字号、行高、标题、选区、caret 和密度逐项修改 | 主会话、缓存 slot 和辅助编辑器使用相同语义 token |
| CSS snippet 生命周期 | 新建、启停、排序、保存热更新、语法错误、全部禁用 | 单项原子替换；错误保留 last-known-good；启动失败可进入 safe mode |
| 插件样式生命周期 | 启用、停用、卸载、升级、热重载含样式插件 | 对应 style 节点严格随 owner 生命周期创建和清理 |
| CSS contract | 默认/全部主题、snippet override、组件升级 | stable token/part 不漂移；弃用有版本与迁移提示 |

滚动建议形成显式状态：跟随最新、阅读历史、主动选择、局部编辑、恢复定位。自动滚动在真正执行时再检查用户状态，避免排队的 rAF 在用户已经上滚后继续抢位置。

默认等待提示继续保持轻量；不要通过增加“正在准备”等阶段文案掩盖首反馈慢。应分别记录提交→可见反馈、首事件→pending、pending→durable 的延迟。

## 13. 性能：已有优化与尚未测量的成本

已有 4000 行历史、25 次普通输入的测试，验证卡片装饰走 map 而非每次全量重建。这是有效的优化证据，但不等于整个 Workbench 的长文档输入延迟已经达标。

需要测量的具体成本：

- pending 每次更新解析整个累计文本并替换 DOM，可能影响选择与重复解析成本。
- 表格作为整表 DOM，没有行虚拟化；CM 文档虚拟化不会自动解决巨大表格。
- 图表渲染是异步任务，当前没有完整的取消/版本失效机制。
- projector 的追加 helper 存在 `ytext.toString()` 与全文 lineRanges 扫描；40ms 批处理不自动将一批里的多次扫描变成一次。
- widget-history 在多个 assistant 范围内重复扫描全文，需要随着会话/卡片规模测量。
- 语法重建、卡片恢复、评论位置和滚动测量可能在同一批事件后相继发生，不能只看单个函数耗时。

建议数据集：1 万、10 万、100 万字符；100、1000、5000 张卡片；单/双面板；短/长工具结果；真实目标设备上的连续输入与流式输出。

记录输入到绘制 p50/p95、最长主线程任务、每批投影耗时、渲染次数、跟随中非主动位移、峰值内存、dispose 后存活节点/监听数、独立包 gzip。**这些是待测指标，不是当前结果。**

可先将普通输入 p95 小于 50ms、交互反馈小于 100ms 作为讨论起点，再以目标设备基线调整；内容不丢、不重复、不错位应是零容忍的正确性门槛，不能以平均性能掩盖。

## 14. 渐进实施路线

| 阶段 | 交付 | 完成门槛 |
| --- | --- | --- |
| A：保证内容完整 | 修 E01/E02、归档导入、部分 ACK；收敛安全渲染与 snapshot 权威 | 特定输入/时序复现不再丢内容；导入不再假成功；已确认片段只出现一次 |
| B：统一交互与失效 | E33/E34 与 view 级 Scroll Coordinator 已完成；其余为 E24—E26、图表位置、cleanup、facet/语法重配置、局部源码入口、完整卡片阅读 | 滚动子项已有自动化回归；阶段整体仍需满足选区/键盘/读屏、配置失效和实例销毁门槛 |
| C：固定领域协议 | grammar、context/output policy、card schema、归档版本、Prompt Compiler | 每种入口的语义明确；显示与下一轮编译顺序一致；Runtime 尾部约束得到落实 |
| D：隔离内核与宿主 | kernel/preset/Workbench adapter；typed ports；组件 CSS contract、cascade layer 与 token manifest | 独立页面不定义也不自动创建 window.zion；两实例无串扰；主题无需依赖内部 DOM |
| D2：用户样式能力 | Appearance preset + scoped CSS snippet 管理器 + safe mode | 普通用户可逐项启停和热更新；错误 snippet 不阻断应用；插件停用不残留 CSS |
| E：提取并验证包 | exports/types、peer deps、可选重依赖、公开示例 | 用 npm pack 产物在独立消费者安装，而非依赖源码相对路径 |
| F：扩展与质量门槛 | 第三方卡片全链路接入；长文档、输入法、读屏、跨端矩阵 | 不修改内核即可扩展；目标设备性能与关键体验有持续回归 |

阶段可以部分并行，但包提取应建立在已明确的文档协议上。第一轮优先迁移纯算法与 public interface，通过 re-export 保留现有调用；不要同时改格式、存储、组件生命周期和产品交互，避免无法定位回归来源。

未来公开发布前，至少需要三种消费示例：纯本地文档编辑、mock RunEvent 流、真实 Runtime/Yjs adapter。当前独立 HTML 挂载成功只是第一个起点。

## 15. 最终建议

保留并强化“文档即对话”的核心：让可见顺序、可编辑结构、模型上下文和可恢复数据之间存在明确关系。近期改进应聚焦以下结果：

1. 用户输入和既有会话不会因异步插入、恢复或归档而损失。
2. 临时与已确认内容连续呈现，不重复、不消失，富语法有一致政策。
3. 每个可达光标位置都有可见反馈，真实选区、重复匹配、搜索和评论不会互相伪装。
4. 位置、焦点、滚动、折叠、复制和浮动工具栏在鼠标、键盘和读屏路径中都可预测。
5. Markdown 默认样式由稳定 token 和组件契约控制，普通用户可通过安全、可恢复的 CSS snippets 定制。
6. 通用领域协议与渲染内核有清晰端口，Workbench 承担应用编排。
7. 从完整归档与真实外部消费者证明可迁移、可扩展，而非仅移动文件目录。

这些工作完成后，差异化会从“功能组合很特别”进一步变为“用户愿意长期用来思考、编辑和保存成果的工具”。

## 附：证据导航

- [已有投影评审与历史修复](./WORKBENCH-CODEMIRROR-CONVERSATION-PROJECTION-REVIEW-20260915.md)：用于理解前序决策；当前状态以源码与本报告核对为准。
- [本轮验证与市场资料](../../.trae/editor-review-20260916/verification-notes.md)
- [富渲染详细笔记](../../.trae/editor-review-20260916/group/rendering-notes.md)：包括表格 source map、异步图表、图片生命周期等扩展候选。
- [流式与卡片详细笔记](../../.trae/editor-review-20260916/group/conversation-notes.md)
- [模块边界与归档详细笔记](../../.trae/editor-review-20260916/group/architecture-notes.md)
- [跨组复核与隔离探针](../../.trae/editor-review-20260916/cross-review.md)
- [优先问题及代码片段](../../.trae/editor-review-20260916/priority-findings.md)
- [HTML 审查附件](../../.trae/editor-review-20260916/report.html) / [Markdown 审查附件](../../.trae/editor-review-20260916/report.md)
- [光标与选区专项笔记](../../.trae/editor-interaction-review-20260916/group/caret-selection-notes.md)
- [键盘边界专项结果](../../.trae/editor-interaction-review-20260916/keyboard-boundary/keyboard-boundary-results.md)
- [会话触发与 assistant 插入滚动专项](../../.trae/editor-interaction-review-20260916/scroll-lifecycle/scroll-lifecycle-notes.md)
- [滚动专项 HTML 报告](../../.trae/editor-interaction-review-20260916/scroll-lifecycle/report.html) / [Markdown 报告](../../.trae/editor-interaction-review-20260916/scroll-lifecycle/report.md)
- [Markdown 与 CSS 扩展专项笔记](../../.trae/editor-interaction-review-20260916/group/markdown-css-notes.md)
- [交互专项验证记录](../../.trae/editor-interaction-review-20260916/verification-notes.md)
- [交互专项优先问题与代码片段](../../.trae/editor-interaction-review-20260916/priority-findings.md)
- [交互专项 HTML 报告](../../.trae/editor-interaction-review-20260916/report.html) / [Markdown 报告](../../.trae/editor-interaction-review-20260916/report.md)
- [交互专项测试日志](../../.trae/editor-interaction-review-20260916/focused-tests.log)
- [前端测试日志](../../.trae/editor-review-20260916/existing-tests.log)
- [Runtime 测试日志](../../.trae/editor-review-20260916/projection-tests-vitest.log)

主文档保留完整产品与架构分析；机器可读代码审查附件按 Top5 筛选，因此附件条目数不代表本报告全部问题数量。
