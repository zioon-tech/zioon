import { guides } from "./guides.mjs";
const p = (text) => ({ type: "paragraph", text });
const list = (...items) => ({ type: "list", items });
const code = (text, language = "sh", title = "终端") => ({ type: "code", text, language, title });
const note = (text, title = "使用提示") => ({ type: "note", text, title });
const table = (headers, rows) => ({ type: "table", headers, rows });
const section = (id, title, ...blocks) => ({ id, title, blocks });

export const groups = ["开始使用", "工作台与任务", "命令行与 Agent", "插件与 API", "参考"];

const basics = [
  {
    slug: "quickstart", title: "快速开始", group: "开始使用", minutes: 4,
    description: "登录，创建第一个会话，给出目标，再沿着结果继续工作。",
    keywords: "入门 首次 登录 注册 怎么用 开始",
    sections: [
      section("sign-in", "使用你的 Zioon 账号",
        p("打开 [Workbench](https://runtime.zioon.tech/)，按页面提示登录或注册。官网的“开始使用”也会进入同一登录流程。已有 Workbench、Memory 或 ADC 账号时，继续使用这个账号。"),
        note("官网和文档可以直接阅读。产品入口可能仍需要完成各自的登录跳转；“同一个账号”不代表每个浏览器和命令行都自动登录。")),
      section("first-session", "创建一个会话",
        p("在工作台创建新会话，给它一个方便以后查找的标题，例如“本周项目计划”。会话保留后续讨论和任务的上下文，适合围绕一个主题持续推进。"),
        p("先用一个不需要设备或文件权限的任务体验对话："),
        code("帮我制定一个三人小团队的一周开发计划。\n目标是完成一个产品官网的首版。\n请包含每日安排、负责人分工和验收方式。", "text", "在会话中输入")),
      section("continue", "沿着结果继续",
        p("阅读回答后，在同一个会话中补充要求。尽量说清楚想改变哪部分、限制是什么、最终需要什么成果。"),
        code("把这个计划调整成四天完成。\n优先保留首页、快速开始和账号文档。\n请给出可以逐项检查的验收清单。", "text", "继续输入"),
        p("每次提交产生一次运行（Run）。你可以查看它的状态、输出和工具结果，结束后继续提出下一步。")),
      section("use-files", "让 AI 处理文件",
        p("需要读写文件或运行命令时，先确认当前账号拥有可用沙箱，或已绑定并授权自己的设备与项目。在实际执行前说明工作目录、范围和是否允许修改。"),
        note("在浏览器或 CLI 中输入一个本机路径不会自动授予访问权限。文件属于选定的执行环境。具体见 [执行资源与权限](/docs/execution/)。"),
        p("可以这样提出读取任务："),
        code("查看已授权项目中的 README 和目录结构。\n只读取文件，解释项目的启动方式和主要模块。", "text", "文件任务示例")),
      section("next", "选择下一步",
        list("[了解工作台](/docs/workbench/)：会话、编辑器、运行与成果。",
          "[使用 CLI](/docs/cli/)：在终端登录、聊天和接回已有会话。",
          "[账号与安全](/docs/account/)：密码、GitHub 和已登录会话。",
          "[遇到问题](/docs/faq/)：登录、设备离线和执行权限。"))
    ]
  },
  {
    slug: "workbench", title: "工作台与会话", group: "日常工作", minutes: 5,
    description: "围绕一个主题组织上下文，查看每次运行，保留可以继续使用的成果。",
    keywords: "Workbench 工作台 编辑器 对话 session run 文档",
    sections: [
      section("sessions", "一个主题，一个会话",
        p("会话（Session）保存工作主题与对话记录。围绕同一个任务继续提问，可以让后续运行使用已有历史；需要切换完全不同的主题时，创建新会话。"),
        p("给会话使用具体标题，例如“十月发布准备”，比“新对话”更容易查找。可以在工作台整理会话，并在 CLI 中列出和继续有权限的会话。")),
      section("editor", "在编辑器里工作",
        p("Workbench 以编辑器为中心组织会话内容。阅读和编辑已有材料，再通过对话继续修改、分析或生成内容。提交时明确指出材料和要求，减少模型猜测。"),
        code("基于上面的方案，重写“安装与登录”一节。\n读者是第一次使用产品的人。\n保留可执行命令，并说明每一步的预期结果。", "text", "继续处理材料"),
        note("会话文档与执行环境中的文件是不同对象。需要生成或修改实际文件时，明确文件名与已授权路径。")),
      section("runs", "理解一次运行",
        table(["对象", "用途"], [
          ["Session", "围绕主题保留多轮工作上下文。"],
          ["Run", "一次提交后的执行过程，有独立 ID、状态与结果。"],
          ["工具结果", "文件读取、命令执行等工具返回的事实与错误。"],
          ["成果", "回答内容，以及运行实际创建的文件或变更记录。"]
        ]),
        p("开始运行后，可以查看输出和工具执行情况。任务完成后核对结果，必要时要求补充、修正或继续。工具失败时先处理错误给出的具体原因。")),
      section("stop-and-reconnect", "停止与接续",
        p("需要终止当前任务时，使用工作台的停止操作，或通过 CLI 明确执行 `zion abort RUN_ID`。仅关闭页面或退出监听，已提交的服务端任务可能继续。"),
        p("换到终端时，登录同一 Runtime 的同一账号，使用 `zion session list` 找到会话，再用 `zion chat --session SESSION_ID` 继续。"),
        note("恢复中断任务只适用于可恢复状态。遇到写入结果不确定时，先检查文件或服务的实际结果；不要直接反复提交同一操作。详见 [Run 与 API](/docs/api/)。"))
    ]
  },
  {
    slug: "cli", title: "CLI：从终端继续", group: "开发与集成", minutes: 8, status: "开发版",
    description: "安装当前源码开发版，使用同一个账号聊天、提交任务和接续会话。",
    keywords: "命令行 安装 zion zioon chat run Node Keychain profile",
    sections: [
      section("install", "安装当前开发版",
        note("CLI 目前以源码开发版提供。这里的安装方式适用于已获得当前开发源码的用户，尚未提供公共 npm 包或独立下载器。", "发行状态"),
        p("需要 Node.js 22.5 或更新版本。在包含 `apps/runtime/bin/zion.mjs` 和本地安装脚本的当前源码根目录运行："),
        code("npm install\nnpm --prefix apps/runtime install\nnpm run runtime:build\nnode scripts/install-zion-cli-local.mjs --source .\nexport PATH=\"$HOME/.local/bin:$PATH\"\nzion --help"),
        p("安装脚本关联当前源码目录，默认配置正式 Runtime 的 `zioon-cloud` 端点。`zion` 和 `zioon` 使用同一入口。源码移动或删除后，需要重新安装关联。"),
        note("此安装脚本创建 macOS / Unix 命令链接；账号凭据目前优先支持 macOS Keychain。不要把这段命令当作 Windows 安装说明。")),
      section("login", "登录并开始对话",
        code("zion auth login zioon-cloud\nzion auth status zioon-cloud\nzion chat --no-tools --no-terminal-context --title \"第一次 CLI 对话\""),
        p("登录命令打印地址和确认代码。手动打开该地址，使用自己的 Zioon 账号确认本次命令行登录，保持终端运行直到完成。"),
        p("在 `you>` 提示中输入问题。输入 `/session` 查看会话 ID，输入 `/exit` 退出终端聊天，会话记录仍然保留。需要使用已授权工具时，启动 `zion chat`。")),
      section("run", "提交一次任务",
        code("zion run \"把这句话写得更清晰：我们需要一个统一的产品入口。\" --title \"文字改写\"\nzion run \"给一个三人团队制定一周开发计划。\" --jsonl > zioon-run.jsonl"),
        p("`run` 会提交任务、打印 Run ID 并跟踪到结束。`--jsonl` 输出接受记录、事件与最终快照，适合脚本处理。"),
        note("脚本应检查最终 `run.snapshot` 中的 `run.status`。不要仅根据命令退出或收到 HTTP 202 判断业务任务成功。")),
      section("sessions", "接回会话，控制任务",
        p("把下面的 `SESSION_ID`、`RUN_ID` 替换为列表或命令返回的真实 ID："),
        code("zion session list --limit 10\nzion session transcript SESSION_ID\nzion chat --session SESSION_ID\nzion run \"基于前面的讨论，再补充风险。\" --session SESSION_ID\nzion attach RUN_ID\nzion abort RUN_ID --reason \"停止这次任务\"\nzion resume RUN_ID"),
        p("`resume` 仅用于可恢复的中断任务。`Ctrl-C` 退出客户端或监听，不一定停止服务端 Run。")),
      section("profiles-and-files", "端点与执行目录",
        table(["参数", "含义"], [
          ["--runtime-profile", "本地端点配置，包含 Runtime 地址和认证方式。"],
          ["--profile", "服务端交互配置，例如模型与策略组合。"],
          ["--model-profile", "服务端已经配置的模型 ID。"],
          ["--project / --file-root", "选择已授权项目与文件范围，不创建新的授权。"]
        ]),
        code("zion profile list\nzion profile show zioon-cloud\nzion chat --runtime-profile zioon-cloud\nzion auth logout zioon-cloud"),
        p("CLI 连接 Runtime，不会因为在某个目录运行就自动把该目录上传或授权给云端。处理本机项目需先完成设备绑定。详见 [执行资源与权限](/docs/execution/)。"),
        p("私有 Skill、代码插件和 MCP 的开发命令见 [扩展开发](/docs/extensions/)。"))
    ]
  },
  {
    slug: "execution", title: "执行资源与权限", group: "开始使用", minutes: 6,
    description: "了解文件和命令在哪里执行，以及账号、设备和任务如何决定可用范围。",
    keywords: "沙箱 sandbox 设备 Connector 权限 本地 文件 Bash 离线 workspace ECS",
    sections: [
      section("where", "工作在哪里执行",
        table(["环境", "文件与进程的位置"], [
          ["账户沙箱", "账号隔离的工作区，通常在 /workspace。"],
          ["已授权设备", "你选择并绑定的电脑或设备，使用其实际目录。"],
          ["工作台 / CLI", "提交、查看和控制任务的入口；不会自动提供执行设备。"]
        ]),
        p("需要工具执行的任务，必须具备可用的账户沙箱，或显式选择已授权的实体设备。未开通沙箱且没有授权设备时，任务会明确拒绝执行。")),
      section("device", "使用自己的电脑",
        list("在 ADC 或现有设备入口完成 Connector 连接和账号绑定。",
          "确认设备在线，项目绑定指向正确设备与目录。",
          "授权需要的文件范围和工具能力。",
          "提交任务时选择这个项目，并核对操作范围。"),
        p("Connector 从设备主动向平台建立连接。设备保留最终权限，平台只在已授权范围内分发请求。"),
        note("账号网页登录与设备配对是两条不同链路。CLI 的 `zion device connect` 需要本地 local-tools 服务和有效配对或设备凭据，不能用 `auth login` 替代。")),
      section("scope", "权限如何生效",
        p("一次任务的可用能力由账号权限、所选 Agent / 交互配置、设备策略、文件范围和任务请求共同约束。请求参数只能进一步选择或缩小范围。"),
        p("读取项目时可以先从只读模式开始。需要修改时，再在已允许写入的项目中选择相应策略。示例中的 ID 与目录必须替换为自己的实际值："),
        code("zion chat --project PROJECT_ID --preset read-only \\\n  --tool read --tool glob --tool grep --tool tree \\\n  --file-root /path/to/your/project"),
        note("在账户沙箱中使用 `/workspace` 下的实际目录。Mac 的 `/Users/...` 路径只在执行目标确实是那台 Mac 时有意义。")),
      section("shared-work", "共享工作区中的多任务",
        p("同一账号使用同一沙箱工作区时，不同会话可能看到相同文件。给任务使用清楚的子目录、输出文件名与端口，避免同时覆盖同一文件。代码项目可以使用独立分支或 worktree。"),
        p("停止一个任务时，应通过它的 Run ID 控制。遇到“工作区忙碌”等错误，先查看当前运行与资源状态；可用并发行为以部署版本为准。")),
      section("errors", "没有资源或设备离线",
        list("没有执行资源：完成账户沙箱开通，或绑定并选择已授权设备。",
          "设备离线：检查设备上的 Connector 是否运行，以及网络和凭据状态。",
          "文件不可见：核对执行环境、项目绑定和文件根目录。",
          "权限不足：检查任务策略与设备授权，增加命令参数不会绕过限制。"),
        note("平台服务器只承载服务，不作为用户的命令执行回退环境。"))
    ]
  },
  {
    slug: "memory", title: "记忆与资料", group: "日常工作", minutes: 4,
    description: "区分当前会话上下文、长期记忆和实际文件，给持续工作准备可靠材料。",
    keywords: "Memory 长期记忆 资料 上下文 检索 历史",
    sections: [
      section("open", "打开 Memory",
        p("[Memory](https://memory.zioon.tech/) 是 Zioon 的记忆入口，与工作台使用同一个账号。按页面提示进入自己的内容与管理界面。"),
        p("长期保留的资料适合放在记忆入口管理；某一次任务的对话过程仍保留在它所属的会话中。")),
      section("distinguish", "三类内容，各有用途",
        table(["内容", "适合保存什么"], [
          ["会话上下文", "当前项目的讨论、要求和历次任务输出。"],
          ["长期记忆与资料", "以后仍有用的偏好、约定、背景和知识。"],
          ["执行文件", "项目源码、生成文档与需要实际读写的材料。"]
        ]),
        p("这些内容不会因为使用同一个账号就自动成为同一份材料。某次运行是否查询记忆，取决于该运行已配置的能力与权限。")),
      section("use", "让资料帮助当前任务",
        p("开始任务时说清楚应使用哪份资料，以及它的用途。需要核实事实时，让模型指出读取的材料或结果，确认资料仍然有效。"),
        code("按照当前项目已经确认的写作约定，整理这份说明。\n请先说明你实际使用了哪些材料。\n没有找到约定时，告诉我需要补充什么。", "text", "资料使用示例"),
        note("不要把“记得上次的事”当成检索成功的证据。确认引用内容、适用项目和更新时间。")),
      section("maintain", "维护有用的长期内容",
        list("保留稳定的偏好、规则和可重复使用的结论。",
          "规则改变时更新旧内容，避免互相冲突。",
          "临时任务进度留在会话或项目中。",
          "服务令牌与设备凭据使用对应凭据管理方式，避免写进公开材料或扩展包。"),
        p("需要继续前一次讨论时，优先找到原会话。参见 [工作台与会话](/docs/workbench/)。"))
    ]
  },
  {
    slug: "account", title: "账号与安全", group: "开始使用", minutes: 4,
    description: "使用统一账号，管理密码、GitHub 关联和已登录会话。",
    keywords: "登录 密码 GitHub OAuth 绑定 邮箱 账号 account auth 安全",
    sections: [
      section("one-account", "同一个账号，多个入口",
        p("Workbench、Memory、ADC 与 CLI 使用 Zioon 的统一账号体系。官网的登录按钮先进入 Workbench 的现有登录流程，由认证服务完成确认和回调。"),
        p("官网本身不要求登录。访问 [账号设置](https://auth.zioon.tech/account) 可以管理账号相关功能。")),
      section("password", "设置或修改密码",
        p("在工作台设置中打开“管理登录方式”，进入统一账号页面。目前这个入口涵盖密码、第三方账号关联和已登录会话。"),
        p("如果最初通过 GitHub 登录，可以按账号页面提供的流程补充所需信息并设置独立密码。以后可按页面支持的方式登录同一账号，减少对第三方登录入口的依赖。"),
        note("已有社交账号时，先登录原账号再补充登录方式。直接另外注册一个相似邮箱的账号，不等于完成关联。")),
      section("github", "关联 GitHub",
        p("在账号页面查看当前 GitHub 关联状态，按提示发起关联或完成必要验证。关联动作需要在当前账号的设置流程内进行。"),
        p("GitHub 授权页面出现回调地址错误时，属于服务端 OAuth 配置问题。保留不含敏感参数的错误描述，反馈给维护者；不要自行修改带状态参数的登录地址。")),
      section("sessions", "管理已登录会话",
        p("在账号页面查看已登录会话，并使用页面提供的退出其他设备功能。当前浏览器与 CLI 可能持有各自的登录凭据。"),
        code("zion auth status zioon-cloud\nzion auth logout zioon-cloud"),
        p("CLI 退出删除该端点的命令行凭据，不等于执行所有浏览器的统一退出。当前 macOS 开发版将 CLI 凭据保存在 Keychain，配置文件只保存端点与认证方式。"),
        p("更多登录问题见 [常见问题](/docs/faq/)。"))
    ]
  },
  {
    slug: "extensions", title: "Skill、代码插件与 MCP", group: "开发与集成", minutes: 10, status: "开发预览",
    description: "在当前开发版创建和管理账户私有扩展，了解执行配置与支持边界。",
    keywords: "扩展 插件 市场 marketplace Skill MCP stdio HTTP SDK upload install",
    sections: [
      section("status", "当前支持范围",
        note("账户私有 Skill、SDK 工具插件和 MCP 的生命周期已在本地开发版接通；正式云端尚未部署这些扩展 API。使用已配置的开发 Runtime，不要向云端重复尝试尚不存在的接口。", "开发预览"),
        table(["类型", "当前用途"], [
          ["Skill", "通过 SKILL.md 提供指令与工作方法。"],
          ["代码工具插件", "通过 SDK runtime API 2 注册和调用工具。"],
          ["MCP", "通过 stdio 或 Streamable HTTP 发现与调用工具。"]
        ]),
        p("安装记录属于账号，同一 Runtime 的 CLI、Workbench、Mobile 与 API Run 共用账户解析。需要执行代码时，仍需配置已授权设备或账户沙箱。")),
      section("skill", "创建一个 Skill",
        p("先创建本地项目并编辑生成的 `SKILL.md` 与 `zion-extension.json`。以下步骤离线执行："),
        code("zion extensions init my-research --kind skill\nzion extensions validate my-research\nzion extensions pack my-research --out my-research-0.1.0.zion.json"),
        code("---\nname: my-research\ndescription: 按证据组织研究结论\n---\n\n# 研究方法\n先明确问题和交付形式。\n为关键结论保留来源，区分事实、推断和建议。\n使用当前任务已经授权的工具完成工作。", "markdown", "SKILL.md 示例"),
        p("打包输出放在项目目录外。同一版本内容不可覆盖，修改后提高版本号并重新打包。")),
      section("install", "上传到自己的开发账号",
        p("`dev` 是示例端点名称，需要替换为自己已配置的开发 Runtime profile。登录后上传、安装："),
        code("zion auth login dev\nzion extensions upload my-research-0.1.0.zion.json --runtime-profile dev\nzion extensions install LISTING_ID@0.1.0 --runtime-profile dev\nzion extensions list --runtime-profile dev\nzion extensions status LISTING_ID --runtime-profile dev"),
        p("把 `LISTING_ID` 替换为上传返回的真实 ID。上传只创建账户私有版本，安装后才进入账户可用扩展。"),
        code("zion extensions disable LISTING_ID --runtime-profile dev\nzion extensions enable LISTING_ID --runtime-profile dev\nzion extensions uninstall LISTING_ID --runtime-profile dev"),
        note("上传新版本不会自动升级安装版本。卸载移除安装记录，已上传的私有制品仍可再次安装。")),
      section("code-and-mcp", "代码插件与 MCP 的执行",
        code("zion extensions init my-tool --kind plugin\nzion extensions init my-mcp --kind mcp --transport stdio\nzion extensions init my-http-mcp --kind mcp --transport http"),
        p("代码插件模板生成 SDK manifest 和可执行 JavaScript。MCP 模板生成 `mcp.json` 与对应服务配置。分别校验、打包、上传并安装后，再为它们配置实际执行环境："),
        code("zion extensions configure LISTING_ID \\\n  --node node:YOUR_AUTHORIZED_NODE_ID --root /workspace \\\n  --runtime-profile dev\nzion extensions probe LISTING_ID --runtime-profile dev\nzion extensions call LISTING_ID --tool hello \\\n  --args '{\"name\":\"Zioon\"}' --runtime-profile dev"),
        p("stdio MCP 在首次验证前运行 `zion extensions prepare LISTING_ID --runtime-profile dev`，在执行端安装固定 SDK。该设备需具备 Node.js、npm 与相应网络访问。"),
        note("`probe` 和 `call` 是真实执行。账号必须有资源与相应工具授权；扩展不会增加设备权限，也不会回退到平台服务器执行。")),
      section("credentials-and-limits", "凭据与支持边界",
        p("MCP 的令牌值保留在执行设备的私有凭据文件中，`configure --credentials-file` 只登记该文件的绝对路径。不要把凭据写进制品。HTTP 凭据必须绑定真实扩展 ID 和精确 endpoint，连接不跟随重定向。"),
        list("代码插件当前支持工具注册和调用，其他 SDK hooks 与 Workbench UI 宿主仍需适配。",
          "MCP 当前支持 stdio 和 Streamable HTTP 的工具发现与调用；旧 SSE、自动 OAuth、resources / prompts 尚未接入。",
          "代码与 MCP 包最多 64 个 UTF-8 文本文件、200KB，依赖与编译产物需要按当前打包规则处理。",
          "版本、配置或启停变化会清除验证状态，需要重新 probe。",
          "取消或超时后可能出现 execution_outcome_unknown，应先检查实际结果。"),
        p("公开发行和独立扩展市场仍在推进。当前状态见 [更新与版本说明](/docs/changelog/)。"))
    ]
  },
  {
    slug: "api", title: "Run 与 API", group: "开发与集成", minutes: 7,
    description: "理解提交、事件、最终状态和恢复，使用已有 Runtime 协议集成工作流。",
    keywords: "API HTTP SSE Run events projection JSONL abort resume 202 token",
    sections: [
      section("contract", "从一次提交到最终结果",
        p("Runtime 将一次任务记录为 Run。提交成功返回 `202 accepted` 和 `runId`，随后客户端查询快照或订阅事件，直到任务到达终态。"),
        table(["状态", "含义"], [
          ["completed", "本次运行完成，继续核对交付结果。"],
          ["failed", "运行失败，查看具体错误与工具结果。"],
          ["interrupted", "运行中断；仅在可恢复条件下 resume。"],
          ["aborted", "任务已经停止。"]
        ]),
        note("HTTP 202 表示任务被接受，尚不能判断任务成功。")),
      section("authentication", "认证与调用入口",
        p("正式 Runtime 位于 `https://runtime.zioon.tech`。接口访问使用现有账号或已注册客户端的认证与权限，不通过官网发放独立 API Key。"),
        p("CLI 已处理账号登录与流式跟踪，脚本集成可以先使用："),
        code("zion auth login zioon-cloud\nzion run \"整理一次发布需要准备的材料。\" --jsonl > run.jsonl\nzion attach RUN_ID --jsonl"),
        note("直接 HTTP 集成应先完成该客户端获准的认证流程。CLI 的 Keychain 凭据不是文档建议导出的共享服务密钥。")),
      section("routes", "已有接口",
        table(["方法与路径", "用途"], [
          ["POST /v1/runs", "提交任务，返回 Run ID。"],
          ["GET /v1/runs/{runId}", "查询快照；响应中的 run 包含当前状态。"],
          ["GET /v1/runs/{runId}/projection/stream?after=0", "适合界面显示的合并 SSE 事件流。"],
          ["GET /v1/runs/{runId}/events?after=0", "从事件序号读取原始事件。"],
          ["GET /v1/runs/{runId}/events/stream?after=0", "原始 SSE 事件流，用于诊断。"],
          ["GET /v1/runs/{runId}/transcript", "读取该 Run 的完整记录。"],
          ["POST /v1/runs/{runId}/abort", "显式停止任务。"],
          ["POST /v1/runs/{runId}/resume", "恢复符合条件的中断任务。"]
        ]),
        p("已认证客户端向 `POST /v1/runs` 提交的请求体示例："),
        code('{\n  "prompt": "用三句话解释本周的工作目标。",\n  "interactionProfileId": "read-only"\n}', "json", "请求体示例"),
        note("`interactionProfileId` 要替换为该 Runtime 已配置且你有权限使用的实际 ID。示例说明请求结构，不能替代权限配置。")),
      section("events", "断线、取消与不确定结果",
        p("事件序号用于断线后接续读取。保存最后处理的序号，在后续请求的 `after` 中继续；合并投影流同样保留原始事件进度。显示输出时优先使用投影流。"),
        p("停止任务通过 `abort` 发起；`resume` 创建新的恢复尝试，不能作为任意已完成任务的重放按钮。"),
        note("工具写入或进程执行中断后，可能收到 `execution_outcome_unknown`。这表示实际副作用尚不确定。先检查文件、进程或外部服务，再决定如何继续；不要盲目重试。"),
        p("会话接口可列出、读取和分叉 Session；日常接续示例见 [CLI](/docs/cli/#sessions)。"))
    ]
  },
  {
    slug: "faq", title: "常见问题", group: "参考", minutes: 5,
    description: "快速处理入口、账号、设备、CLI 和开发版扩展的常见问题。",
    keywords: "FAQ 问题 错误 401 404 command not found 离线 没权限 github",
    sections: [
      section("entrance", "应该从哪个入口开始？",
        p("第一次使用，从 [Workbench](https://runtime.zioon.tech/) 开始。管理记忆使用 [Memory](https://memory.zioon.tech/)，连接设备使用 [ADC](https://adc.zioon.tech/)。终端用户可阅读 [CLI 安装与使用](/docs/cli/)。"),
        p("这些入口使用同一个账号。官网的“开始使用”默认进入工作台。")),
      section("login", "登录失败或 GitHub 无法访问",
        p("确认正在使用正式产品地址和正确账号。CLI 出现 401 或 `Account login required` 时，运行 `zion auth status zioon-cloud`，必要时重新执行 `zion auth login zioon-cloud`。"),
        p("GitHub 起家的账号可以在已登录的账号设置中，按流程补充独立密码。不要通过另外注册一个账号来代替关联。见 [账号与安全](/docs/account/)。")),
      section("local-files", "为什么读不到电脑上的文件？",
        p("浏览器和 CLI 提交任务不会自动授权本机目录。检查设备是否绑定、Connector 是否在线、项目是否路由到这台电脑、目录与工具是否在允许范围内。"),
        p("如果任务运行在账户沙箱，使用沙箱中的实际路径，例如 `/workspace`。详见 [执行资源](/docs/execution/)。")),
      section("no-resources", "没有执行资源，或者提示权限不足",
        p("未开通沙箱的账号需要绑定并显式选择有权限的设备。平台服务器不会作为执行回退。权限不足时检查账号、交互配置、项目和设备策略。"),
        p("遇到超时或不确定结果，先核对实际文件和运行状态，再进行下一步。重复提交相同命令可能产生重复副作用。")),
      section("cli", "zion 找不到，或者没有 extensions 命令",
        p("确认 `~/.local/bin` 已加入 PATH，重新打开终端，再运行 `zion --help`。本地开发安装依赖源码目录，移动源码后需要重新关联。"),
        p("`extensions` 不存在通常表示当前命令仍指向较早源码。更新到包含扩展命令的开发版，再查看 `zion extensions --help`。当前没有通用公共 npm 安装命令。")),
      section("extensions", "扩展接口返回 404，安装后却不能调用",
        p("正式云端尚未部署账户私有扩展 API，使用已配置的开发 Runtime。上传不等于安装；代码插件和 MCP 安装后还需要执行设备配置、工具授权与成功 probe。"),
        p("修改版本或配置后重新验证。Skill 与代码工具的使用方式不同，详见 [扩展开发](/docs/extensions/)。"))
    ]
  },
  {
    slug: "changelog", title: "更新与版本说明", group: "参考", minutes: 3,
    description: "按实际可用入口说明发布与开发进度，避免混淆预览和正式服务。",
    keywords: "更新 版本 changelog release 预览 发布",
    sections: [
      section("website", "2026.10 · 官网与 Docs 首版",
        p("官网首版准备产品介绍、统一产品入口和十篇使用文档，覆盖快速开始、工作台、账号、执行资源、Memory、CLI、扩展与 API。"),
        p("文档可公开阅读，登录使用现有 Workbench 账号流程。当前网站为本地待发布版本；正式主域名路由切换尚未执行。")),
      section("available", "已有正式入口",
        list("Workbench：会话、对话、Run 与工作成果。",
          "统一账号：现有登录、账号设置与第三方账号流程。",
          "Memory：独立记忆入口。",
          "ADC：设备连接与受授权的设备能力。"),
        p("具体可用工具、模型和执行资源取决于账号权限与服务配置。服务入口不等于每个账号已开通所有能力。")),
      section("development", "当前开发版",
        list("CLI：本地源码安装，支持账号登录、聊天、Run 与 Session 控制。",
          "私有扩展：Skill、SDK 工具插件和 MCP 的初始化、校验、打包、上传、安装与配置。",
          "MCP：stdio 和 Streamable HTTP 工具发现与调用。",
          "待发布：云端扩展 API、独立扩展市场和更多插件界面适配。"),
        note("本页记录已经核实的交付范围。没有把开发预览标成所有线上账号已经可用的功能。"))
    ]
  }
];

const retained = basics.filter((doc) => ["quickstart", "account", "execution", "workbench", "memory"].includes(doc.slug)).map((doc) => ({
  ...doc, group: doc.group === "日常工作" ? "工作台与任务" : doc.group,
  sections: doc.sections.map((section) => ({ ...section, blocks: section.blocks.map((block) => block.text?.includes("当前 macOS 开发版")
    ? p("CLI 退出撤销当前端点的命令行登录。macOS 凭据保存在 Keychain，Linux 使用仅当前用户可读的私有文件，Windows 使用当前用户的 DPAPI 加密。端点配置文件只保存地址与认证方式。")
    : block) }))
}));
const order = ["quickstart", "capabilities", "account", "execution", "workbench", "tasks", "memory", "cli", "cli-reference", "agent-skill", "adc-cli", "memory-cli", "extensions", "plugin-development", "plugin-invocation", "api", "sdk", "faq", "changelog"];
export const docs = [...retained, ...guides].sort((a, b) => order.indexOf(a.slug) - order.indexOf(b.slug));
