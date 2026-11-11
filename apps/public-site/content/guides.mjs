const p = (text) => ({ type: "paragraph", text });
const list = (...items) => ({ type: "list", items });
const code = (text, language = "sh", title = "终端") => ({ type: "code", text, language, title });
const note = (text, title = "使用提示") => ({ type: "note", text, title });
const table = (headers, rows) => ({ type: "table", headers, rows });
const s = (id, title, ...blocks) => ({ id, title, blocks });
const staged = process.env.ZIOON_SITE_RELEASE_STATE !== "published";
const releaseNote = () => note(staged
  ? "本页对应 CLI 0.3.0 与 Runtime Hook 更新。发行包已准备；正式服务完成部署核验后会更新本提示。"
  : "CLI 0.3.0 与本文对应的接口已发布。实际可用插件、模型和工具以当前账号的安装记录与权限为准。", "发行状态");

export const guides = [
  {
    slug: "capabilities", title: "Zioon 能做什么", group: "开始使用", minutes: 5,
    description: "从对话、文件与工具，到记忆、持续任务和插件，选择完成工作的入口。",
    keywords: "能力 功能 产品 模型 Agent goals 工具 多入口",
    sections: [
      s("work", "从一个目标开始",
        p("Zioon 把会话、模型和工具接在一起。你可以分析材料、写作、处理代码、生成文件，再沿着同一段工作的上下文继续。实际读写与命令执行使用账户沙箱或你授权的设备。"),
        table(["能力", "可以怎样使用", "操作说明"], [
          ["会话与编辑器", "组织材料、多轮讨论，保留工作记录。", "[工作台与会话](/docs/workbench/)"],
          ["文件与进程", "读取项目、修改文件、运行已授权工具。", "[执行资源](/docs/execution/)"],
          ["长期记忆", "管理偏好、项目约定和长期资料。", "[Memory](/docs/memory/)"],
          ["任务与 Run", "提交、跟踪、停止和接续执行。", "[任务与自动化](/docs/tasks/)"],
          ["Skill、插件、MCP", "增加工作方法，连接专业工具与外部服务。", "[扩展](/docs/extensions/)"]
        ])),
      s("entrances", "同一账号，多种工作方式",
        table(["入口", "适合谁", "主要操作"], [
          ["Workbench", "围绕材料持续工作的人", "会话、编辑、工具结果、插件界面。"],
          ["Zioon CLI", "终端用户和脚本", "聊天、Run、Session、扩展管理、API 请求。"],
          ["HTTP API / Node SDK", "开发者", "提交任务、读取事件和结果、调用已安装插件。"],
          ["Agent Skill", "使用其他 Agent 的人", "让 Agent 按官方流程使用 Zioon CLI。"],
          ["ADC CLI / MCP", "需要操作自己的设备的人", "发现授权设备与工具，执行并查询回执。"],
          ["Memory CLI", "需要读写长期资料的人", "浏览、搜索、编辑同一份记忆文件。"]
        ]),
        p("你在 CLI 中看到的会话和插件，来自所选 Runtime 与当前账号。不同环境的账号和数据可能独立；切换端点不会自动迁移内容。")),
      s("models", "选择模型与工作配置",
        p("运行可以选择服务端已经配置的模型、Agent 或交互配置。模型配置和工具权限共同决定一次运行的能力。模型提供商、密钥与可用配置由当前部署和账号设置管理。"),
        p("`--runtime-profile` 选择服务地址；`--profile` 选择服务端交互配置；`--model-profile` 选择已配置模型。不要把这三个参数当作同一个选项。")),
      s("next", "按现在要完成的事继续",
        list("[第一次使用](/docs/quickstart/)", "[安装 CLI](/docs/cli/)", "[把 Zioon 交给其他 Agent 使用](/docs/agent-skill/)", "[开发插件](/docs/plugin-development/)", "[通过 API 集成](/docs/api/)"))
    ]
  },
  {
    slug: "tasks", title: "任务、Run 与自动化", group: "工作台与任务", minutes: 5,
    description: "提交明确目标，跟踪执行状态，并管理已配置的定时任务。",
    keywords: "Run task scheduler cron 计划任务 定时 自动化 目标 goal",
    sections: [
      s("submit", "提交和跟踪",
        p("Workbench 的一次提交、CLI 的 `run` 和 API 的 `POST /v1/runs` 都产生可跟踪的 Run。保留返回的 ID，查看输出、错误与最终状态。"),
        code('zioon run "分析这个项目的发布准备情况。" --session SESSION_ID --jsonl\nzioon attach RUN_ID --jsonl\nzioon abort RUN_ID --reason "停止本次工作"'),
        note("退出终端监听或关闭网页不等于停止服务端任务。写入结果不确定时先检查实际文件，再继续。")),
      s("waiting", "等待外部回复",
        p("Run 的 waiting 状态表示正在等待输入或审批，尚未完成。查看等待原因后填写回复，或明确停止该任务。会话保留给这个 Run，恢复使用原运行 ID。"),
        p("接入与回复方式见 [Runtime Hook 与 Webhook](/docs/runtime-hooks/)。")),
      s("scheduled", "管理已配置的定时任务",
        p("通过 Scheduler 插件配置自动化任务后，可以在 CLI 查看、触发一次或取消某次任务 Run。任务 ID 与 Run ID 是不同对象。"),
        code("zioon task list\nzioon task get TASK_ID\nzioon task run TASK_ID\nzioon task runs TASK_ID\nzioon task cancel RUN_ID --reason \"取消本次执行\""),
        p("CLI 当前提供已有任务的查看和运行控制；创建与修改定时配置使用已安装 Scheduler 的界面或获准接口。任务运行使用它已登记的执行资源与权限。")),
      s("goals", "让复杂工作持续推进",
        p("需要多步推进时，给出目标、交付物与验收条件，在同一会话中追加约束。部署启用目标或工作流插件时，可以用插件提供的目标管理能力跟踪进展。"),
        code("准备这个项目的发布。\n交付物：可安装包、使用文档、核验记录和回滚步骤。\n请持续推进，直到交付物齐全；遇到必须由我处理的登录或外部阻塞，再说明具体原因。", "text", "目标示例"),
        note("插件是否启用以当前账号和 Runtime 为准。先查看安装列表和工具定义，再使用其命令。"))
    ]
  },
  {
    slug: "cli", title: "安装与使用 Zioon CLI", group: "命令行与 Agent", minutes: 6,
    description: "安装独立发行包，登录你的账号，从终端聊天、提交任务和使用插件。",
    keywords: "安装 命令行 zion zioon npm Node Windows Linux macOS 登录 下载",
    sections: [
      s("install", "安装独立发行包",
        releaseNote(),
        p("需要 Node.js 22.5 或更新版本与 npm，支持 macOS、Linux 和 Windows。安装包包含 CLI、Node SDK 与官方 Skill，不依赖 Zioon 源码目录。"),
        code("npm install --global https://zioon.tech/downloads/zioon-cli-0.3.0.tgz\nzioon --version\nzioon --help"),
        p("版本输出为 `zioon 0.3.0`。`zion` 是相同命令的别名。`@zioon/cli` 是包内模块名，当前通过官网固定制品安装。"),
        p("也可以下载 [CLI 安装包](/downloads/zioon-cli-0.3.0.tgz)、[SHA-256 清单](/downloads/SHA256SUMS)、[Unix 安装脚本](/downloads/install.sh) 或 [Windows 安装脚本](/downloads/install.ps1)。脚本使用用户目录安装，并打印需加入 PATH 的路径。")),
      s("user-install", "没有全局安装权限时",
        p("macOS / Linux 可安装到自己的目录："),
        code('npm install --global --prefix "$HOME/.local" https://zioon.tech/downloads/zioon-cli-0.3.0.tgz\nexport PATH="$HOME/.local/bin:$PATH"\nzioon --version'),
        p("Windows PowerShell 可使用："),
        code('$zioonPrefix = Join-Path $env:LOCALAPPDATA "Zioon\\cli"\nnpm install --global --prefix $zioonPrefix https://zioon.tech/downloads/zioon-cli-0.3.0.tgz\n$env:Path = "$zioonPrefix;$env:Path"\nzioon --version', "powershell", "Windows PowerShell"),
        p("这些 PATH 设置对当前终端有效。后续可将打印的目录加入用户 PATH。")),
      s("login", "登录一次",
        code("zioon auth login zioon-cloud\nzioon auth status zioon-cloud"),
        p("登录命令打印确认地址与代码。打开地址，使用自己的账号确认本次 CLI 登录，保持终端运行直到完成。内置 `zioon-cloud` 使用正式 Runtime；已有端点配置与默认选择会保留。"),
        p("macOS 使用 Keychain，Linux 使用仅当前用户可读的文件，Windows 使用当前用户的 DPAPI 加密。登录不会把凭据打印到终端。")),
      s("chat", "开始对话与接回会话",
        code('zioon chat --no-tools --no-terminal-context --title "第一次 CLI 对话"\nzioon session list --limit 10\nzioon chat --session SESSION_ID\nzioon run "把前面的计划整理成三项行动。" --session SESSION_ID --jsonl'),
        p("输入 `/session` 查看当前会话 ID，输入 `/exit` 退出聊天。把示例 ID 替换为实际返回值。需要已授权工具时启动 `zioon chat`。")),
      s("editing", "编辑、模型和图片",
        code("zioon chat --continue\nzioon chat --image screenshot.png"),
        p("使用多行输入、Tab 命令补全和历史搜索。`/model` 选择模型，`/settings` 查看配置。回复会渲染 Markdown、代码块和表格；工具活动单独展示。"),
        p("图片可拖入终端，或使用 Ctrl+V、`/paste` 从剪贴板添加。macOS 用 Ctrl+Cmd+Shift+4 将截图放入剪贴板，成功后会显示 `[Image 1]`。图片可与文字混发；发送失败时草稿与附件会保留。选择支持图片的模型。")),
      s("plugins", "查看和调用已安装插件",
        code("zioon extensions list\nzioon extensions list --host runtime\nzioon extensions show dev.agent-device-cloud --host runtime\nzioon extensions call dev.agent-device-cloud --host runtime \\\n  --tool adc_status --args '{}'"),
        p("账户扩展与完整 Runtime 插件使用不同宿主。ADC 插件需先安装，并在其界面完成自己的授权；`adc_status` 返回未连接也是有效状态。详见 [跨入口使用插件](/docs/plugin-invocation/)。"),
        code("zioon api GET /v1/account/me\nzioon auth logout zioon-cloud"))
    ]
  },
  {
    slug: "cli-reference", title: "CLI 命令参考", group: "命令行与 Agent", minutes: 5,
    description: "查找会话、Run、端点、任务、扩展与 API 的主要命令。",
    keywords: "help 参数 命令 session attach resume abort auth profile api jsonl",
    sections: [
      s("commands", "日常命令",
        table(["命令", "用途"], [
          ["zioon chat", "交互式聊天。"], ["zioon run PROMPT", "提交任务并跟踪到终态。"],
          ["zioon attach RUN_ID", "接回某次 Run 的输出。"], ["zioon resume RUN_ID", "恢复中断 Run，或携带 wait-id 回复等待请求。"],
          ["zioon abort RUN_ID", "显式停止 Run。"], ["zioon session list / get / transcript", "查看会话与记录。"],
          ["zioon session fork / attach / watch", "分叉会话或跟踪其运行与事件。"],
          ["zioon task list / get / run / runs / cancel", "管理已有自动化任务的执行。"],
          ["zioon auth login / status / logout", "管理命令行登录。"], ["zioon profile list / show", "查看端点配置。"],
          ["zioon extensions --help", "扩展初始化、发布、安装与调用。"],
          ["zioon api --help", "使用现有账号发送 JSON API 请求。"]
        ])),
      s("options", "常用参数",
        table(["参数", "作用"], [
          ["--runtime-profile NAME", "选择本地端点配置。"], ["--url URL --account", "以账号登录访问指定 Runtime。"],
          ["--profile ID", "选择有权限的服务端交互配置。"], ["--model-profile ID", "选择已有模型配置。"],
          ["--session ID", "在既有会话中提交工作。"], ["--project ID", "选择已经绑定和授权的设备项目。"],
          ["--preset", "read-only、workspace-write 或 trusted-automation。"],
          ["--tool / --file-root", "进一步限定工具和文件范围，不增加权限。"],
          ["--jsonl", "输出可解析 JSON Lines。"], ["--raw-events", "读取原始诊断事件。"]
        ])),
      s("config", "端点配置",
        p("端点配置位于 `~/.zion-next/cli.json`。发行版内置正式地址，已有配置覆盖内置默认值。需要开发环境时，把真实地址登记为单独 profile："),
        code('{\n  "version": 1,\n  "defaultProfile": "zioon-cloud",\n  "profiles": {\n    "dev": {\n      "url": "http://127.0.0.1:18080",\n      "auth": { "type": "account" }\n    }\n  }\n}', "json", "端点配置示例"),
        code("zioon auth login dev\nzioon extensions list --runtime-profile dev"),
        p("配置文件只保存地址和认证方式。自动化工作负载可使用部署已注册的 bearer 环境变量或 token-file profile；账号登录与执行资源授权仍独立。")),
      s("exit", "脚本如何判断结果",
        table(["退出码", "含义"], [["0", "命令成功；run / attach 的 Run 已完成。"], ["1", "命令或 Run 失败。"], ["2", "Run 中断。"], ["3", "Run 等待回复，尚未完成。"], ["130", "Run 已停止。"]]),
        p("检查最终 `run.snapshot` 的 `run.status` 与输出。交互式聊天内某轮失败会显示错误，可继续输入。`api` 的 HTTP 成功不代表返回的 Run 已完成。"))
    ]
  },
  {
    slug: "agent-skill", title: "让其他 Agent 使用 Zioon", group: "命令行与 Agent", minutes: 4,
    description: "安装官方 Skill，让你的 Agent 按相同账号、权限和回执流程使用 Zioon。",
    keywords: "Skill Agent Claude Codex Cursor TRAE 安装 SKILL.md skills",
    sections: [
      s("download", "安装官方 Skill",
        releaseNote(),
        p("下载 [完整 Skill 包](/downloads/zioon-skill-0.3.0.tar.gz)，解压后保留 `zioon/SKILL.md` 和 `references/commands.md`。将整个 `zioon` 文件夹放入当前 Agent 支持的 Skill 目录。"),
        p("支持官网发现协议的 skills 安装器也可以直接从本站安装；它需要 Node.js 22.20 或更新版本："),
        code("npx skills@latest add https://zioon.tech --skill zioon"),
        p("TRAE 项目级目录为 `.trae/skills/zioon/`；其他宿主使用自己的 Skill 导入或目录约定。完整安装包含 references，不要只复制正文。"),
        p("独立 [SKILL.md](/downloads/SKILL.md) 适合预览。CLI npm 包也内置 `skills/zioon/`，内容与官网下载相同。")),
      s("start", "第一次交给 Agent 使用",
        code("帮我使用 Zioon。\n先检查 zioon CLI 和当前登录状态。\n登录需要我确认时，给我地址和代码。\n然后列出我的会话与已安装插件，说明现在可以继续哪项工作。", "text", "示例请求"),
        p("Skill 会检查真实 CLI 与账号状态，发现现有会话和工具，再按你的要求调用。网页登录和授权确认由你完成。")),
      s("use", "让 Agent 接续和开发",
        code("在 Zioon 中找到上次的发布会话，接着整理验收清单。\n\n查看已经安装的 ADC 插件有哪些工具，并读取它的连接状态。\n\n创建一个 hello 工具插件，先离线校验和打包，再给我查看安装结果。", "text", "常用请求"),
        note("Skill 是操作指令，不提供额外账号或设备权限。它不会让其他 Agent 自动访问你的电脑；文件任务仍使用已授权执行资源。")),
      s("ecosystem", "ADC 与 Memory 的 Skill",
        p("独立设备管理可安装 [ADC 官方 Skill](https://adc.zioon.tech/docs/integrations/)。长期记忆读写使用 [Memory CLI 文档](https://memory.zioon.tech/docs)。Zioon Skill 负责会话、Run 和插件生命周期，避免混用三个产品的命令。"))
    ]
  },
  {
    slug: "adc-cli", title: "ADC：设备 CLI 与 MCP", group: "命令行与 Agent", minutes: 4,
    description: "独立使用 ADC 管理授权设备，也可以通过 Zioon 的 ADC 插件调用设备能力。",
    keywords: "ADC adc CLI MCP OAuth 设备 file.read Skill",
    sections: [
      s("install", "选择连接方式",
        p("ADC 提供设备 Connector、CLI、MCP 和官方 Skill。安装与版本信息以 [ADC 集成文档](https://adc.zioon.tech/docs/integrations/) 和 [设备连接文档](https://adc.zioon.tech/docs/device-connector/) 为准。"),
        note("不要猜测 ADC 的 npm registry 包名。当前公开集成页提供官方插件包和 Skill 安装入口；CLI 需按 ADC 的当前发行说明安装。")),
      s("cli", "已安装 CLI 后",
        code("adc --help\nadc login --url https://adc.zioon.tech\nadc access list --json\nadc connect ACCESS\nadc node list --json\nadc tool list --json\nadc tool show file.read --json"),
        p("`ACCESS` 替换为你选择的真实授权。先发现设备与工具，再按工具 schema 发起调用。执行后保留 invocation ID，查询回执。"),
        code("adc invoke file.read --node NODE_ID \\\n  --args '{\"path\":\"/path/to/authorized/README.md\"}' --json\nadc invocation status INVOCATION_ID --json")),
      s("mcp", "在其他 Agent 中使用",
        p("ADC OAuth MCP 入口为 `https://adc.zioon.tech/mcp`。由客户端引导登录，选择已有 Agent 授权与设备。Skill 安装命令及要求见官方文档："),
        code("npx skills@latest add https://adc.zioon.tech --skill agent-device-cloud"),
        p("该 Skill 安装器需要 Node.js 22.20 或更新版本。设备权限与实际执行仍由 ADC 检查。")),
      s("zioon", "在 Zioon 中调用 ADC",
        p("安装完整 ADC Runtime 插件后，在 Workbench 的 ADC 入口完成 OAuth 连接。CLI / API 可调用插件已注册工具："),
        code("zioon extensions show dev.agent-device-cloud --host runtime\nzioon extensions call dev.agent-device-cloud --host runtime \\\n  --tool adc_status --args '{}'"),
        p("插件连接状态、ADC CLI 登录与 Zioon 账号登录是独立步骤。参见 [跨入口使用插件](/docs/plugin-invocation/)。"))
    ]
  },
  {
    slug: "memory-cli", title: "Memory：记忆文件 CLI", group: "命令行与 Agent", minutes: 5,
    description: "安装 agent-fs 和 Zioon 登录适配，在终端读写与网页相同的记忆文件。",
    keywords: "agent-fs agentfs Memory Bun 安装 登录 记忆 cat grep write log",
    sections: [
      s("install", "安装固定版本",
        p("先按 [Bun 官方文档](https://bun.sh/docs/installation) 安装 Bun，再安装 Memory 当前公开支持的 agent-fs 版本与登录适配："),
        code('mkdir -p "$HOME/.local/share/zioon-agent-fs"\nbun add --cwd "$HOME/.local/share/zioon-agent-fs" @desplega.ai/agent-fs@0.18.5\ncurl -fsSL https://memory.zioon.tech/downloads/agentfs-login.mjs \\\n  -o "$HOME/.local/share/zioon-agent-fs/agentfs-login.mjs"\ncurl -fsSL https://memory.zioon.tech/downloads/install-agentfs-login.mjs \\\n  -o "$HOME/.local/share/zioon-agent-fs/install-agentfs-login.mjs"\nbun "$HOME/.local/share/zioon-agent-fs/install-agentfs-login.mjs" \\\n  --upstream-cli "$HOME/.local/share/zioon-agent-fs/node_modules/@desplega.ai/agent-fs/dist/cli.js"'),
        p("本段是 macOS / Linux 的公开安装流程。安装后将 `~/.local/bin` 加入 PATH；其他平台与最新兼容信息见 [Memory 官方文档](https://memory.zioon.tech/docs)。")),
      s("login", "登录一次",
        code("~/.local/bin/agent-fs login --api-url https://memory.zioon.tech\n~/.local/bin/agent-fs auth status"),
        p("打开显示的链接，确认自己的账号与验证码。登录适配保存服务地址、凭据与默认存储位置，后续不需要重复设置环境变量。")),
      s("files", "查看、搜索和编辑",
        code('agent-fs ls /memory/dev.identity\nagent-fs cat /memory/dev.identity/profile.md\nagent-fs grep "项目" /memory/dev.identity\nagent-fs write /memory/dev.identity/notes.md --content "今天的协作笔记"\nagent-fs log /memory/dev.identity/notes.md'),
        p("写入实际修改你的记忆文件，并留下版本记录。运行示例前确认文件路径和内容。网页与 CLI 可以看到同一份内容。"),
        note("网络中断后先读取文件确认是否已经写入，再决定是否重试。长期记忆适合保存稳定规则与资料，临时进度留在会话中。")),
      s("logout", "退出登录",
        code("agent-fs logout"),
        p("该命令撤销并移除当前 CLI 登录。网页登录可通过控制台的退出操作结束。"))
    ]
  },
  {
    slug: "extensions", title: "扩展：Skill、插件与 MCP", group: "插件与 API", minutes: 6,
    description: "了解扩展类型、安装记录与执行宿主，找到正确的开发和调用路径。",
    keywords: "扩展 marketplace 插件 Skill MCP 私有 安装 host runtime",
    sections: [
      s("marketplace", "独立插件市场",
        p("[打开 Zioon 插件市场](https://marketplace.zioon.tech/)，浏览插件、技能与 MCP。公开目录无需登录；安装、连接配置、私有开发与贡献使用和 Workbench 相同的 Zioon 账户。"),
        p("安装记录在网站、Workbench 与 CLI 之间共用。在详情页查看版本、启停、服务连接与验证结果。Workbench 的插件市场入口会打开独立网站。")),
      s("types", "三类扩展",
        releaseNote(),
        table(["类型", "内容", "使用方式"], [
          ["Skill", "SKILL.md 中的操作指令", "作为已安装的工作方法参与 Agent 任务。"],
          ["账户代码插件", "工具、上下文、生命周期、后台任务、模型与可选界面", "默认在账户工作区执行，需要设备依赖时选择已配对设备。"],
          ["MCP", "stdio 或 Streamable HTTP 工具服务", "安装后首次使用自动准备和发现工具。"],
          ["完整 Runtime 插件", "Runtime tools、commands、hooks 与可选 Workbench UI", "由完整插件安装器加载；CLI 使用 --host runtime。"]
        ]),
        p("账户插件的后端使用独立 Host，静态界面由 Workbench 按账户加载。平台内置插件仍由 Runtime 管理；账户代码不会加载到平台服务器进程。")),
      s("lifecycle", "从开发到安装",
        code("zioon extensions init my-method --kind skill\nzioon extensions validate my-method\nzioon extensions pack my-method --out my-method-0.1.0.zion.json\nzioon extensions upload my-method-0.1.0.zion.json\nzioon extensions install LISTING_ID@0.1.0\nzioon extensions list\nzioon extensions status LISTING_ID"),
        p("编辑生成的内容后再校验和打包。上传返回真实 ID，上传本身不安装。固定版本内容不可覆盖，修改后提高版本号。上传版本属于当前账号的私有制品。"),
        code("zioon extensions disable LISTING_ID\nzioon extensions enable LISTING_ID\nzioon extensions uninstall LISTING_ID")),
      s("execution", "代码与 MCP 的执行",
        code("zioon extensions configure LISTING_ID --node NODE_ID --root /workspace\nzioon extensions probe LISTING_ID\nzioon extensions call LISTING_ID --tool hello --args '{\"name\":\"Zioon\"}'"),
        p("首次调用会自动准备固定 MCP SDK 和 Host。`prepare`、`probe` 可用于排障。账号需具备资源与 write / Bash 权限；设备连接与公开设置在扩展详情中配置。"),
        p("如果默认交互配置没有允许 `extensionsCall`，为 prepare、probe 和 call 添加 `--profile PROFILE_ID`，选择已经授权该能力的实际配置。CLI 请求不会扩大服务端配置的权限。"),
        note("安装和配置变化后，首次使用自动重新绑定。插件不增加设备权限，也不会回退到平台服务器执行。")),
      s("next", "继续开发和调用",
        list("[开发工具插件与 MCP](/docs/plugin-development/)", "[通过 Workbench、CLI 和 API 调用](/docs/plugin-invocation/)", "[使用 Node SDK](/docs/sdk/)"))
    ]
  },
  {
    slug: "plugin-development", title: "开发插件与 MCP 工具", group: "插件与 API", minutes: 8,
    description: "从 hello 工具开始，完成离线开发、打包、账户安装和真实调用。",
    keywords: "SDK runtime API 2 manifest 开发 hello runtime.mjs MCP plugin",
    sections: [
      s("scaffold", "创建工具插件",
        code("zioon extensions init my-tool --kind plugin\nzioon extensions dev my-tool"),
        p("模板带有 handler、SDK helper 和 npm 脚本。编辑 `runtime.mjs` 后自动构建，成功版本安装到当前账户，Workbench 可直接调试。源码保存在账户工作区；构建失败继续使用上一个成功版本。")),
      s("tool", "注册一个工具",
        code('import { defineToolPlugin } from "./plugin-runtime.mjs";\nexport const runtimePluginApiVersion = 2;\nexport const activateRuntimePlugin = defineToolPlugin({\n  name: "hello", description: "Say hello",\n  inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },\n  execution: { effect: "read", idempotency: "safe" },\n  async invoke({ name }) { return { ok: true, content: "Hello, " + name }; }\n});', "javascript", "runtime.mjs"),
        p("工具 effect 声明实际行为：`read`、`write`、`process` 或 `external`。平台负责权限检查、超时、取消与 durable receipt。只读示例可声明 read；不要把写入伪装成只读。")),
      s("package", "校验、打包与安装",
        code("zioon extensions publish my-tool\nzioon extensions publish my-tool --public\nzioon extensions install LISTING_ID@0.1.0\nzioon extensions call LISTING_ID --tool hello --args '{\"name\":\"Zioon\"}'"),
        p("`publish` 发布当前账户的固定私有版本；`--public` 提交同一制品审核，要求提供来源 URL，审核通过后其他账号可安装。开发构建与发布版本分别保存，互不覆盖。"),
        p("制品最多 64 个 UTF-8 文件、200KB；Runtime 开发构建含元数据最多 190KB。第三方依赖需 bundle。更新时同时提高两个 manifest 的版本。`validate`、`pack --out` 与 `upload` 可用于离线构建。")),
      s("model", "内网模型与设备依赖",
        code("zioon extensions init intranet-model --kind model\nzioon extensions dev intranet-model\nzioon extensions configure LISTING_ID --node NODE_ID"),
        p("模型 handler 接收请求 body，返回 HTTP Response；平台负责 JSON/SSE、usage、取消和流量回压。仅 JSON 的服务声明 `supportsStreaming: false`。模型请求走所选设备，文件和 Bash 仍可使用账户工作区。"),
        p("公开设置通过 settingsSchema 声明。密钥保存在执行端私有文件，`--credentials-file` 只登记连接引用；模型模块固定上游地址并拒绝重定向。")),
      s("mcp", "接入 MCP",
        code("zioon extensions init my-mcp --kind mcp --transport stdio\nzioon extensions init my-http-mcp --kind mcp --transport http"),
        p("stdio 模板提供最小服务，HTTP 模板提供 endpoint 配置。共享设备支持打包的 Node stdio 入口，并限制其文件与进程权限；其他可执行程序需账户独立工作区。当前支持工具发现与调用；resources / prompts 和服务专属 OAuth 需另外接入。"),
        p("凭据值保留在 Node 本地私有文件。`configure --credentials-file` 只登记绝对路径；HTTP 凭据绑定扩展与精确 endpoint，连接不跟随重定向。")),
      s("full", "开发完整 Runtime 插件",
        p("账户 SDK API 2 可注册工具、必要上下文、Run controllers、完成后后台处理、持久 jobs/events、模型和命令；可附带 Workbench 静态界面。声明所有实际能力。平台内置完整插件继续从 `/v1/capabilities/tools` 发现。"),
        p("与会话无关的连接或设置命令可声明 `requiresSession: false`；依赖会话的命令保持默认要求。UI 应显示等待状态与持久错误，避免在新会话中静默失败。"),
        p("Host、配置、版本和资源 epoch 由平台管理。必要上下文失败会阻止模型请求；后台处理通过持久 outbox 执行。静态 UI、Skill 与声明的模型目录在执行工作区休眠时仍可读取。"))
    ]
  },
  {
    slug: "plugin-invocation", title: "跨入口使用已安装插件", group: "插件与 API", minutes: 7,
    description: "在 Workbench、CLI、HTTP API 与 SDK 中发现并调用同一账号可用的插件能力。",
    keywords: "插件 调用 ADC cli api Workbench installed tools host runtime",
    sections: [
      s("discover", "先发现实际能力",
        p("在 Workbench 查看插件安装与启用状态。CLI 分别列出账户扩展和完整 Runtime 插件，再读取工具 schema："),
        code("zioon extensions list\nzioon extensions show LISTING_ID\nzioon extensions list --host runtime\nzioon extensions show dev.agent-device-cloud --host runtime\nzioon api GET /v1/capabilities/tools"),
        table(["安装形式", "CLI 参数", "执行请求"], [
          ["账户代码 / MCP 扩展", "默认宿主", "metadata.extensionInvocation"],
          ["完整 Runtime SDK 插件", "--host runtime", "metadata.pluginToolInvocation"],
          ["Skill", "安装后在 Agent 工作中使用", "不是直接工具 call"]
        ])),
      s("workbench", "在 Workbench 使用",
        p("插件可提供侧栏、命令和对话工具。在对话中提出任务时，模型只能选择当前运行获准的工具。插件的连接或设置命令可以独立于会话运行；ADC“连接 ADC”用于完成它自己的 OAuth。"),
        note("能看到插件界面不等于已经完成第三方连接。以插件显示的状态和实际工具返回为准。")),
      s("personal-files", "修改已安装的文件",
        p("在插件市场详情中打开「个人文件」，编辑并保存，再点击「重新加载」。Skill 可包含正文、references 和 scripts。文件保存在你的账户工作区；后续 Sandbox 启动仍能读取。"),
        code("zioon extensions files LISTING_ID\nzioon extensions read LISTING_ID --path SKILL.md\nzioon extensions write LISTING_ID --path SKILL.md --file ./SKILL.md --source-hash ACTUAL_HASH\nzioon extensions reload LISTING_ID --source-hash ACTUAL_HASH_AFTER_SAVE"),
        p("使用实际返回的文件路径和内容 hash。重新加载通过校验后，后端代码和 Workbench 界面一起使用同一份私有 revision。原安装记录和来源版本保留，个人修改不会公开发布。校验失败时，上一份生效版本继续可用。"),
        p("「恢复发布版」切回原发布内容并保留个人目录。更新来源版本时确认切换，或使用 `extensions install LISTING_ID@VERSION --switch-source`；现有编辑目录会保留供后续比较。")),
      s("cli", "在终端直接调用",
        code("zioon extensions call LISTING_ID --tool hello --args '{\"name\":\"Zioon\"}'\nzioon extensions call dev.agent-device-cloud --host runtime \\\n  --tool adc_status --args '{}'"),
        p("命令通过 Run 提交，返回 Run ID、状态与工具输出。服务端检查工具是否属于所选插件、交互配置是否允许调用，并记录执行回执。若默认交互配置未授权该工具，使用你有权限且允许该工具的真实 `--profile`。")),
      s("api", "通过 API 调用完整插件",
        p("先获取工具目录，再构造请求。以下是已安装 ADC 插件的状态工具示例；保存为 `plugin-run.json`，使用真实允许该工具的交互配置："),
        code('{\n  "prompt": "Read ADC connection status",\n  "interactionProfileId": "YOUR_ALLOWED_PROFILE_ID",\n  "policy": { "preset": "read-only", "allowedTools": ["adc_status"] },\n  "metadata": {\n    "pluginToolInvocation": {\n      "pluginId": "dev.agent-device-cloud",\n      "tool": "adc_status",\n      "arguments": {}\n    }\n  }\n}', "json", "plugin-run.json"),
        code("zioon api POST /v1/runs --data-file plugin-run.json\nzioon attach RUN_ID --jsonl"),
        p("账户扩展使用 snapshot 中真实的 listing ID、executionEpoch 和执行配置，由 SDK 的 `extensionRunRequest` 构造请求。完整插件使用 `runtimePluginToolRequest`，避免把两种请求混在一起。")),
      s("receipts", "相同授权与回执",
        p("CLI、API、SDK 和 Workbench 复用服务端 Run 与工具执行路径。插件安装不绕过账户、项目和设备权限；超时或取消后收到 `execution_outcome_unknown` 时，先检查实际结果。"),
        p("`adc_status` 返回 `connected: false` 说明尚未连接；Run 完成只证明状态查询完成，不能推断设备任务已经执行成功。"))
    ]
  },
  {
    slug: "api", title: "HTTP API 与认证", group: "插件与 API", minutes: 7,
    description: "完成客户端登录，提交 Run、跟踪事件与读取结果，并复用插件调用协议。",
    keywords: "HTTP API auth bearer OAuth device start poll SSE curl token 202",
    sections: [
      s("cli", "先用 CLI 发送请求",
        code("zioon auth login zioon-cloud\nzioon api GET /v1/account/me\nzioon api GET /v1/marketplace/snapshot\nzioon api GET /v1/capabilities/tools"),
        p("`api` 自动使用当前端点的已保存登录，只打印 JSON。可以用 `--data` 或 `--data-file` 提交 JSON；请求不跟随重定向，不自动重试。")),
      s("auth", "自己的 HTTP 客户端如何登录",
        p("正式服务地址为 `https://runtime.zioon.tech`。交互客户端使用账户设备确认流程；不要从另一个 CLI 的凭据文件复制令牌。"),
        table(["接口", "客户端动作"], [
          ["POST /v1/account/device/start，body {}", "取得 flowToken、verificationUriComplete、userCode、expiresAt 与 interval。"],
          ["用户打开 verificationUriComplete", "登录并确认该客户端请求。"],
          ["POST /v1/account/device/poll，body {flowToken}", "按服务返回间隔轮询，pending 时继续。"],
          ["取得 token 与 expiresAt", "以 Authorization: Bearer token 访问获准接口，安全保存本客户端凭据。"],
          ["POST /v1/account/logout，body {}", "带当前凭据撤销登录。"]
        ]),
        p("flowToken 与登录 token 都是私密数据。设备流程失效后重新开始。非交互服务使用部署管理员已经注册和授权的 workload / bearer 客户端，不使用网页登录 cookie 充当永久密钥。")),
      s("run", "提交和跟踪 Run",
        code('zioon api POST /v1/runs --data \'{\"prompt\":\"用三句话整理本周目标。\"}\'\nzioon api GET /v1/runs/RUN_ID\nzioon attach RUN_ID --jsonl'),
        table(["方法与路径", "用途"], [
          ["POST /v1/runs", "提交任务；202 返回 runId。"], ["GET /v1/runs/{id}", "读取快照和终态。"],
          ["GET /v1/runs/{id}/projection/stream?after=0", "用于显示的合并 SSE 事件。"],
          ["GET /v1/runs/{id}/events?after=0", "读取原始事件。"],
          ["GET /v1/runs/{id}/events/stream?after=0", "原始诊断 SSE。"],
          ["GET /v1/runs/{id}/transcript", "读取完整记录。"],
          ["POST /v1/runs/{id}/abort", "显式停止。"],
          ["POST /v1/runs/{id}/resume", "恢复可恢复的中断任务。"]
        ]),
        note("HTTP 202 只表示任务已接受。检查快照中的 run.status：completed、failed、interrupted 或 aborted。")),
      s("session", "会话与插件接口",
        table(["接口", "用途"], [
          ["GET /v1/sessions", "列出当前账户可见的会话。"],
          ["POST /v1/sessions", "创建会话。"],
          ["POST /v1/sessions/{id}/messages", "在会话中提交消息。"],
          ["GET /v1/sessions/{id}/transcript", "读取会话记录。"],
          ["GET /v1/marketplace/snapshot", "账户扩展与安装版本。"],
          ["GET /v1/capabilities/tools", "真实工具定义与插件归属。"]
        ]),
        p("插件工具通过 `POST /v1/runs` 进入相同授权与回执流程。详见 [跨入口使用插件](/docs/plugin-invocation/)。")),
      s("events", "断线与不确定结果",
        p("保存最后处理的事件序号，重连时使用 `after` 接续。优先使用投影流显示输出，诊断时读取原始事件。"),
        p("取消或超时不保证某次写入没有发生。遇到 `execution_outcome_unknown` 时检查文件、进程或外部服务，再决定是否继续。"))
    ]
  },
  {
    slug: "sdk", title: "Node SDK 集成", group: "插件与 API", minutes: 5,
    description: "在自己的 Node 应用中使用相同账号、Run 客户端与扩展请求构造器。",
    keywords: "JavaScript Node SDK TypeScript import createAccountRuntimeClient",
    sections: [
      s("install", "在项目中安装",
        releaseNote(),
        code("npm install https://zioon.tech/downloads/zioon-cli-0.3.0.tgz\nnpx zioon auth login zioon-cloud"),
        p("包的模块名为 `@zioon/cli`，可在 Node.js 22.5 或更新版本中使用。SDK 复用当前系统用户已经保存的账号登录，不返回令牌。")),
      s("run", "提交和读取任务",
        code('import { createAccountRuntimeClient } from "@zioon/cli";\n\nconst { runtime } = await createAccountRuntimeClient();\nconst { runId } = await runtime.createRun({\n  prompt: "整理这次发布需要准备的材料。"\n});\nconst run = await runtime.followRun(runId, (event) => {\n  console.log(event.type);\n});\nconsole.log(run.status, run.output);\nif (run.status !== "completed") process.exitCode = 1;', "javascript", "run.mjs"),
        p("`runtimeProfile` 可选择已有端点；`baseUrl` 可指定另一个已经单独登录的 Runtime。SDK 需要现有授权，不在程序启动时自动完成网页登录。")),
      s("extension", "调用账户扩展",
        code('import { createAccountRuntimeClient, extensionRunRequest } from "@zioon/cli";\n\nconst { runtime, extensions } = await createAccountRuntimeClient();\nconst snapshot = await extensions.snapshot();\nconst entry = snapshot.entries.find((item) => item.id === "LISTING_ID");\nif (!entry?.installation?.config) throw new Error("Install and configure the extension first");\nconst request = extensionRunRequest(entry, "call", {\n  tool: "hello", arguments: { name: "Zioon" }\n});\nconst { runId } = await runtime.createRun(request);\nconst run = await runtime.followRun(runId, () => {});\nconsole.log(run.status, run.output);', "javascript", "extension.mjs"),
        p("完整 Runtime 插件使用 `runtimePluginToolRequest(pluginId, discoveredTool, args, profileId)`。discoveredTool 必须来自真实工具目录，并属于所选插件。")),
      s("scope", "SDK 的范围",
        p("当前提供 Node ESM 客户端、扩展请求构造器与 Run 流订阅函数。SDK 认证层用于 Node CLI 环境；浏览器应用使用现有网页登录与获准接口，不把本机凭据文件打包进页面。"),
        p("更多端点与失败状态见 [HTTP API](/docs/api/)。"))
    ]
  },
  {
    slug: "faq", title: "常见问题", group: "参考", minutes: 4,
    description: "处理安装、登录、设备权限和插件调用中最常见的问题。",
    keywords: "FAQ 401 404 离线 登录 command not found 权限 错误 extensions",
    sections: [
      s("cli", "找不到 zioon 命令",
        p("确认 Node.js 与 npm 可用，查看安装使用的 prefix，并把其命令目录加入 PATH。Unix 通常为 prefix/bin，Windows 为 prefix 本身。重开终端后运行 `zioon --version`。"),
        p("如果仍指向开发源码，可以先用完整命令路径检查，再按当前发行方式安装。`zion` 与 `zioon` 是别名，可能被已有其他命令占用。")),
      s("login", "401 或登录确认无效",
        p("运行 `zioon auth status zioon-cloud`，必要时重新登录。使用登录命令打印的完整确认链接，包含本次确认代码；过期流程需重新开始。"),
        p("正式与开发 Runtime 使用独立端点配置。检查 `zioon profile show`，不要混用不同环境的账号和确认链接。")),
      s("files", "为什么读不到本机文件",
        p("CLI 所在目录不会自动授予云端文件权限。确认任务运行在正确沙箱或授权设备，并核对项目、目录和设备在线状态。见 [执行资源](/docs/execution/)。")),
      s("plugins", "已安装插件，却无法调用",
        list("查看是否启用以及工具是否实际注册。",
          "账户代码 / MCP 扩展需要配置授权 Node 并成功 probe。",
          "完整 Runtime 插件使用 --host runtime。",
          "交互配置和账号必须允许该工具。",
          "ADC 等外部服务还需要完成插件自己的连接授权。"),
        p("`extensions list` 为空表示当前账户没有这类安装；还可检查 `--host runtime`。API 404 时核对 Runtime 版本、端点与所用安装类型。")),
      s("outcome", "超时后要不要重试",
        p("收到 `execution_outcome_unknown` 时先读取实际结果。只读查询通常可以重新进行；写入、进程或外部动作可能已经发生，需要先核对对应文件、进程或回执。"))
    ]
  },
  {
    slug: "changelog", title: "更新与版本说明", group: "参考", minutes: 3,
    description: "本次 CLI、官网文档和插件跨入口能力的交付范围。",
    keywords: "版本 release 更新 0.3.0 官网 CLI 插件 Hook Webhook",
    sections: [
      s("cli-hooks", "2026.11 · CLI 0.3.0 与执行扩展",
        list("终端支持 Markdown 排版、多行与中文输入、会话续接、草稿恢复、模型选择、工具状态和历史搜索。",
          "图片可粘贴、拖入或按路径添加，多图与文字一起发送；上传失败保留草稿。",
          "统一 Hook 支持执行边界控制和持久等待，CLI、工作台与移动端可回复并恢复任务。",
          "Webhook 事件与投递事务入库，支持签名、有限重试、租约恢复与人工重放。"),
        p("完整配置见 [Runtime Hook 与 Webhook](/docs/runtime-hooks/)。macOS 截图粘贴使用 Ctrl+V，或输入 /paste；截图需先保存到剪贴板。")),
      s("installed-files", "2026.10 · 已安装扩展的个人文件",
        releaseNote(),
        list("CLI 0.2.1 和插件市场支持查看、编辑、保存、重新加载与恢复已安装文件。",
          "个人源文件保存在账户工作区；成功校验后的 revision 存入私有 OSS。",
          "后端和 Workbench 使用同一份生效 revision，原安装记录及来源版本保留。",
          "Skill 包可包含 references 与 scripts，更新来源版本时保留已有编辑目录。")),
      s("marketplace", "2026.10 · 独立插件市场",
        p("[marketplace.zioon.tech](https://marketplace.zioon.tech/) 提供独立目录、详情、已安装管理、私有开发、公开贡献与审核。使用统一 Zioon 登录和同一份账户安装数据。"),
        p("独立界面采用 React、Ant Design 和 TanStack Query。公开浏览、安装管理与代码执行保持各自的既有权限边界。")),
      s("release", "2026.10 · CLI 与完整使用文档",
        releaseNote(),
        list("Zioon CLI 0.2.0：一函数模板、账户开发自动安装、固定私有发布与公开审核。",
          "终端：chat、Run / Session 控制、定时任务查看与触发、扩展生命周期。",
          "开发者：认证 JSON API 命令、Node SDK 与官方 Agent Skill。",
          "官网：十九篇文档，覆盖能力、工作台、执行资源、三类 CLI、扩展开发与跨入口调用。")),
      s("plugins", "插件调用与连接改进",
        list("完整 Runtime 插件可从 CLI 发现并通过 Run 调用工具。",
          "API / SDK 复用同一工具授权、执行与 durable receipt 路径。",
          "与会话无关的插件命令支持独立执行，修复 ADC 新会话连接入口无响应。",
          "插件 JavaScript 模块入口支持 .mjs，连接错误可持续查看。"),
        p("ADC 的完整连接与设备调用仍需要用户完成 ADC OAuth 与设备授权。状态工具完成不等于设备调用已经验证。")),
      s("bounds", "当前范围",
        p("私有扩展属于当前账号；公开 Skill、代码和 MCP 通过同一审核流程发布。后端默认使用账户工作区，设备依赖需配对授权。MCP resources / prompts 和服务专属 OAuth 需另外接入。正式服务可用能力以当前账号安装与权限为准。"),
        p("安装包和 Skill 的固定版本与 SHA-256 见 [发行清单](/downloads/release.json)。"))
    ]
  }
];

guides.push({
  slug: "runtime-hooks", title: "Runtime Hook 与 Webhook", group: "插件与 API",
  minutes: 7, description: "在执行边界接入控制逻辑，等待外部输入，并可靠接收运行事件。",
  keywords: "Hook Webhook 暂停 恢复 审批 HTTP 脚本 afterRun waitId",
  sections: [
    s("lifecycle", "执行边界",
      p("Hook 支持 beforeStart、beforeTurn、beforeModel、beforeTool、afterTool、beforeStop 和 afterRun。控制逻辑按顺序执行，各自有超时和失败策略。旧插件回调仍然兼容。"),
      table(["阶段", "可返回的决定"], [
        ["启动、每轮、模型前", "pass、deny、pause"],
        ["工具前", "pass、deny、pause、replace-tool-result"],
        ["工具后", "pass，记录执行事实"],
        ["停止前", "pass、deny、pause、continue、accept-stop"],
        ["Run 收尾", "pass、continue-run"]
      ]),
      note("单次 Run 完成、插件收尾完成与整个持续目标完成是不同事实。afterRun 不会在等待状态触发。")),
    s("waiting", "等待、回复和取消",
      p("pause 会持久保存等待原因和执行边界，状态为 waiting，会话仍由该 Run 占用。CLI、工作台与移动端显示等待回复，不将其当作成功或失败。"),
      code("zioon api GET /v1/runs/RUN_ID\nzioon resume RUN_ID --wait-id WAIT_ID --input-file response.json\nzioon abort RUN_ID --reason \"停止本次任务\""),
      p("从快照读取当前等待 ID，根据该 Hook 要求填写 response.json。POST /v1/runs/RUN_ID/resume 接收 waitId 和 input；过期或重复等待会被拒绝。工作台可在输入区填写回复后发送，移动端使用等待回复区域。"),
      note("在外部副作用执行中发生崩溃时，需要先核对已有执行结果，再恢复；Runtime 不会盲目重放该工具。")),
    s("adapters", "HTTP 与脚本 Hook",
      p("部署管理员使用 ZION_RUNTIME_HOOKS_FILE 指定适配器配置。HTTP 请求与响应均签名，签名帮助接收方验证原始消息与时效。脚本在独立进程中执行，需要 ZION_RUNTIME_ALLOW_SCRIPT_HOOKS 明确启用和绝对模块路径。"),
      p("接口契约位于 Runtime 的 protocol.ts；签名辅助函数由 plugin-sdk/runtime-extension-signature 提供。配置超时为 1—60000 毫秒，默认 fail-closed。密钥由服务器凭据引用提供，不写入公开配置。"),
      code('[{"id":"approval","type":"http","stages":["beforeTool"],"endpoint":"https://hooks.example.com/approval","secretRef":"ZION_HOOK_SECRET_APPROVAL","timeoutMs":10000,"failurePolicy":"fail-closed"}]', "json")),
    s("webhooks", "可靠接收事件",
      p("Webhook 订阅与每次投递持久保存在 PostgreSQL；运行事件和待投递记录在同一事务中提交。后台 worker 签名、重试并租约领取任务。接收方按事件 ID 去重。"),
      code("zioon api GET /v1/webhooks\nzioon api GET /v1/webhooks/deliveries"),
      p("管理权限限定在所属账户。POST /v1/webhooks 创建订阅，PATCH /v1/webhooks/ID 开关订阅；POST /v1/webhooks/deliveries/ID/replay 以明确理由重放，GET 同路径的 replays 查看审计。支持的事件以 GET /v1/webhooks 返回的 eventTypes 为准。"),
      p("部署管理员先设置至少 32 字节的 ZION_WEBHOOK_SECRET_* 密钥，并通过 ZION_WEBHOOK_SECRET_BINDINGS 配置 Space ID 到可用密钥引用的 JSON 映射。创建、启用、重放和投递均校验此绑定，Webhook 不接受 ZION_HOOK_SECRET_*。"),
      code('ZION_WEBHOOK_SECRET_BINDINGS=\'{"SPACE_ID":["ZION_WEBHOOK_SECRET_EVENTS"]}\'\n\nzioon api POST /v1/webhooks --data \'{"endpoint":"https://events.example.com/zioon","secretRef":"ZION_WEBHOOK_SECRET_EVENTS","eventTypes":["run.waiting","run.resumed","run.finalized"]}\''),
      note("订阅用于记录通知事实。需要暂停或控制工具执行时使用 Hook；第三方机器人平台仍需单独的渠道适配器。"))
  ]
});
