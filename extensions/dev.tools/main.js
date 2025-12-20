import { installToolCallCards } from "./tool-calls.js";
import { installToolSwitcher } from "./tool-switcher.js";
import { installMailConfigPanel } from "./mail-config.js";

export async function activate(ctx) {
  // 注册默认工具与处理器
  registerDefaultTools();

  // 提供“从文档解析工具定义”的命令
  const dispParse = window.zion.commands.registerCommand("tools.parseFromContent", (content) => {
    const s = typeof content === "string" ? content : "";
    return parseToolsFromDocument(s);
  });
  ctx.subscriptions.push(dispParse);

  // 注入工具调用卡片（ViewPlugin）
  const dispDec = window.zion.editor.registerDecorator({
    id: "dev.tools.tool-cards",
    apply(editor) {
      editor.addVisualExtension(installToolCallCards());
      return { dispose() {} };
    }
  });
  ctx.subscriptions.push(dispDec);

  // 工具切换器面板（搜索/键盘导航/Enter 切换/Esc 关闭）
  let toolSwitcher = null;
  const dispSwitcher = window.zion.editor.registerDecorator({
    id: "dev.tools.switcher",
    apply(editor) {
      toolSwitcher = installToolSwitcher();
      return { dispose() { toolSwitcher?.dispose?.(); toolSwitcher = null; } };
    }
  });
  ctx.subscriptions.push(dispSwitcher);

  // 打开/关闭工具切换器命令
  const dispOpen = window.zion.commands.registerCommand("tools.openSwitcher", async () => {
    ensureEnabledTools();
    toolSwitcher?.open?.();
  });
  const dispClose = window.zion.commands.registerCommand("tools.closeSwitcher", () => {
    toolSwitcher?.close?.();
  });
  ctx.subscriptions.push(dispOpen, dispClose);

  // 邮件配置面板
  let mailPanel = null;
  const dispMailPanel = window.zion.editor.registerDecorator({
    id: "dev.tools.mail-config",
    apply(editor) {
      mailPanel = installMailConfigPanel();
      return { dispose() { mailPanel?.dispose?.(); mailPanel = null; } };
    }
  });
  ctx.subscriptions.push(dispMailPanel);

  const openMailCfg = window.zion.commands.registerCommand("tools.openMailConfig", () => {
    mailPanel?.open?.();
  });
  const closeMailCfg = window.zion.commands.registerCommand("tools.closeMailConfig", () => {
    mailPanel?.close?.();
  });
  ctx.subscriptions.push(openMailCfg, closeMailCfg);

  // 状态栏按钮：Tools
  let toolsBtnDisp = null;
  let mailBtnDisp = null;
  const updateToolsBtn = () => {
    const all = window.zion.state.get("chat.tools") || [];
    const enabled = window.zion.state.get("chat.enabledTools");
    const enabledNames = Array.isArray(enabled) ? enabled : all.map(t => t?.function?.name).filter(Boolean);
    const n = enabledNames.filter(Boolean).length;
    toolsBtnDisp?.dispose?.();
    toolsBtnDisp = window.zion.statusBar.registerItem({
      id: "dev.tools.button",
      text: `Tools: ${n}`,
      tooltip: "Manage enabled tools (Search / ↑↓ / PgUp/PgDn / Home/End / Enter / Esc)",
      onClick: () => window.zion.commands.executeCommand("tools.openSwitcher")
    });

    // 邮件配置按钮
    mailBtnDisp?.dispose?.();
    const mailBase = (window.zion.state.get("mail.baseUrl") || localStorage.getItem("zion.mail.baseUrl") || "http://127.0.0.1:8765");
    mailBtnDisp = window.zion.statusBar.registerItem({
      id: "dev.mail.button",
      text: "MailCfg",
      tooltip: `Configure mail (base: ${mailBase})`,
      onClick: () => window.zion.commands.executeCommand("tools.openMailConfig")
    });
  };

  // ② 在「扩展全部加载完」后统一初始化启用列表（支持持久化）
  const off = window.zion.events.on('extensions:loaded', () => {
    try {
      const all = window.zion.state.get("chat.tools") || [];
      const names = all.map(t => t?.function?.name).filter(Boolean);

      // 从 localStorage 读取持久化的启用列表与用户是否自定义过
      let persisted = [];
      try { persisted = JSON.parse(localStorage.getItem("zion.enabledTools") || "[]"); } catch {}
      const userCustomized = localStorage.getItem("zion.enabledTools.userCustomized") === "1";

      const filtered = Array.isArray(persisted) ? persisted.filter(n => names.includes(n)) : [];
      let finalEnabled = filtered;

      if (!Array.isArray(persisted) || persisted.length === 0) {
        // 首次或无持久化：默认全开，并记录为“未自定义”
        finalEnabled = names.slice();
        try { localStorage.setItem("zion.enabledTools.userCustomized", "0"); } catch {}
      } else if (!userCustomized) {
        // 用户未自定义过：自动把新增工具也打开
        finalEnabled = Array.from(new Set([...filtered, ...names]));
      }

      window.zion.state.set("chat.enabledTools", finalEnabled);
      window.zion.state.set("chat.toolsKnownNames", names.slice());
    } catch {}
  });
  ctx.subscriptions.push({ dispose: () => off.dispose?.() });

  updateToolsBtn();

  // 持久化启用列表到 localStorage，并在每次变更时更新状态按钮
  const persistEnabledTools = () => {
    try {
      const enabled = window.zion.state.get("chat.enabledTools") || [];
      localStorage.setItem("zion.enabledTools", JSON.stringify(enabled));
      const names = (window.zion.state.get("chat.tools") || []).map(t => t?.function?.name).filter(Boolean);
      const customized = Array.isArray(enabled) && enabled.length < names.length;
      localStorage.setItem("zion.enabledTools.userCustomized", customized ? "1" : "0");
    } catch {}
  };

  ctx.subscriptions.push(
    window.zion.state.onDidChange("chat.tools", () => { ensureEnabledTools(); updateToolsBtn(); }),
    window.zion.state.onDidChange("chat.enabledTools", () => { persistEnabledTools(); updateToolsBtn(); })
  );
}

/**
 * 解析工具定义（从文档或状态），返回 OpenAI Function schema 数组
 */
function parseToolsFromDocument(content) {
  const tools = [];
  const lines = content.split("\n");
  let cur = null;
  for (const line of lines) {
    const head = line.match(/^tools?:\s*([a-zA-Z0-9_]+)\s*(.*)$/);
    if (head) {
      if (cur) tools.push(cur);
      cur = {
        type: "function",
        function: {
          name: head[1],
          description: head[2] || "",
          parameters: { type: "object", properties: {}, required: [] }
        }
      };
      continue;
    }
    if (cur) {
      const pm = line.match(/^\s*-\s+([a-zA-Z0-9_]+)\s*\((string|number|boolean|object|array)\)\s*:?\s*(.*)$/);
      if (pm) {
        cur.function.parameters.properties[pm[1]] = {
          type: pm[2],
          description: pm[3] || ""
        };
        continue;
      }
      const rm = line.match(/^\s*required:\s*(.+)$/);
      if (rm) {
        cur.function.parameters.required = rm[1].split(",").map(s => s.trim()).filter(Boolean);
        continue;
      }
      // 工具定义结束（遇到非缩进行）
      if (line.trim() && !/^\s/.test(line)) {
        tools.push(cur);
        cur = null;
      }
    }
  }
  if (cur) tools.push(cur);

  // 合并状态总线预注册工具
  const regTools = window.zion?.state?.get("chat.tools") || [];
  const merged = [...regTools, ...tools];

  // 依据启用列表过滤（chat.enabledTools），未设置则默认全启用
  const enabledNames = window.zion?.state?.get("chat.enabledTools");
  const set = Array.isArray(enabledNames) ? new Set(enabledNames) : null;
  const filtered = set ? merged.filter(t => t?.function?.name && set.has(t.function.name)) : merged;

  return filtered.length > 0 ? filtered : null;
}

/**
 * 确保 chat.enabledTools 与 chat.tools 同步
 * @param {boolean} forceAll  是否强制开启全部（忽略用户之前的手动关闭）
 */
function ensureEnabledTools(forceAll = false) {
  try {
    const all = window.zion?.state?.get("chat.tools") || [];
    const names = all.map(t => t?.function?.name).filter(Boolean);

    let cur = window.zion?.state?.get("chat.enabledTools") || [];
    let known = window.zion?.state?.get("chat.toolsKnownNames");
    const userCustomized = (() => {
      try { return localStorage.getItem("zion.enabledTools.userCustomized") === "1"; } catch { return false; }
    })();

    const isInitialized = Array.isArray(known) && known.length > 0;

    if (forceAll || !isInitialized) {
      window.zion?.state?.set("chat.enabledTools", names.slice());
      window.zion?.state?.set("chat.toolsKnownNames", names.slice());
      try { localStorage.setItem("zion.enabledTools.userCustomized", "0"); } catch {}
      return;
    }

    // 清理已不存在的工具
    const filtered = Array.isArray(cur) ? cur.filter(n => names.includes(n)) : [];

    if (userCustomized) {
      // 尊重用户选择：不自动开启新增工具
      window.zion?.state?.set("chat.enabledTools", filtered);
      window.zion?.state?.set("chat.toolsKnownNames", names.slice());
      return;
    }

    // 用户未自定义：自动开启新增工具
    const knownSet = new Set(Array.isArray(known) ? known : []);
    const newlyAdded = names.filter(n => !knownSet.has(n));
    const next = Array.from(new Set([...filtered, ...newlyAdded]));
    window.zion?.state?.set("chat.enabledTools", next);
    window.zion?.state?.set("chat.toolsKnownNames", names.slice());
  } catch {}
}

/**
 * 注册默认工具与处理器（仅在缺失时补充）
 */
function registerDefaultTools() {
  try {
    const defaultTools = [
      // TodoWrite: 结构化待办列表
      {
        type: "function",
        function: {
          name: "todoWrite",
          description: "Create or update a structured todo list for the current session",
          parameters: {
            type: "object",
            properties: {
              todos: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    content: { type: "string", minLength: 1 },
                    status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                    activeForm: { type: "string", minLength: 1 }
                  },
                  required: ["content", "status", "activeForm"],
                  additionalProperties: false
                },
                description: "The updated todo list"
              }
            },
            required: ["todos"],
            additionalProperties: false
          }
        }
      },
      // WebFetch: 抓取网页并转为markdown文本
      {
        type: "function",
        function: {
          name: "webFetch",
          description: "Fetch a URL and convert HTML to markdown-like text",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", format: "uri", description: "The URL to fetch content from" },
              prompt: { type: "string", description: "What to extract or summarize from the page (informational)" }
            },
            required: ["url", "prompt"],
            additionalProperties: false
          }
        }
      },
      // WebSearch: 简易网页搜索（DuckDuckGo代理）
      {
        type: "function",
        function: {
          name: "webSearch",
          description: "Search the web and return a list of relevant results",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 2, description: "The search query to use" },
              allowed_domains: { type: "array", items: { type: "string" }, description: "Only include results from these domains (optional)" },
              blocked_domains: { type: "array", items: { type: "string" }, description: "Exclude results from these domains (optional)" }
            },
            required: ["query"],
            additionalProperties: false
          }
        }
      },
      // LocalSearch: 本地超快搜索服务（通过 HTTP 调用本地 Python 服务）
      {
        type: "function",
        function: {
          name: "localSearch",
          description: "Fast local search via external Python service. Configure base URL in localStorage 'zion.localSearch.baseUrl' or state 'localSearch.baseUrl'.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1, description: "Search query" },
              top_k: { type: "number", description: "Max results to return (default 10)" },
              allowed_domains: { type: "array", items: { type: "string" }, description: "Only include results from these domains (optional)" },
              blocked_domains: { type: "array", items: { type: "string" }, description: "Exclude results from these domains (optional)" }
            },
            required: ["query"],
            additionalProperties: false
          }
        }
      },
      // Glob: Fast file pattern matching
      {
        type: "function",
        function: {
          name: "glob",
          description: "Fast file pattern matching. Returns matching file paths sorted by modification time.",
          parameters: {
            type: "object",
            properties: {
              pattern: { type: "string", description: "Glob pattern (e.g., **/*.js)" },
              path: { type: "string", description: "Directory to search (optional, default cwd)" },
              session_id: { type: "string", description: "Optional terminal session ID (local/ssh)" }
            },
            required: ["pattern"],
            additionalProperties: false
          }
        }
      },
      // Grep: ripgrep powered content search
      {
        type: "function",
        function: {
          name: "grep",
          description: "Powerful content search via local Python service (ripgrep-backed).",
          parameters: {
            type: "object",
            properties: {
              pattern: { type: "string", description: "Regex pattern to search" },
              path: { type: "string", description: "File or directory to search (default cwd)" },
              glob: { type: "array", items: { type: "string" }, description: "Glob filters (e.g., *.js, **/*.tsx)" },
              output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Output mode (default files_with_matches)" },
              B: { type: "number", description: "Lines to show before each match (content mode)" },
              A: { type: "number", description: "Lines to show after each match (content mode)" },
              C: { type: "number", description: "Lines to show before/after each match (content mode)" },
              n: { type: "boolean", description: "Show line numbers (content mode, default true)" },
              i: { type: "boolean", description: "Case insensitive (default false)" },
              type: { type: "string", description: "File type hint (rg --type js/py/rust...)" },
              head_limit: { type: "number", description: "Limit output to first N lines/entries" },
              offset: { type: "number", description: "Skip first N lines/entries" },
              multiline: { type: "boolean", description: "Enable multiline search (rg -U --multiline --multiline-dotall)" },
              session_id: { type: "string", description: "Optional terminal session ID (local/ssh)" }
            },
            required: ["pattern"],
            additionalProperties: false
          }
        }
      },
      // Read: read file content (local or session-aware)
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file's content (supports local or SSH session via local tools service).",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path to read" },
              offset: { type: "number", description: "Start line (1-based, optional)" },
              limit: { type: "number", description: "Number of lines to read (optional)" },
              session_id: { type: "string", description: "Optional terminal session ID (local/ssh)" }
            },
            required: ["path"],
            additionalProperties: false
          }
        }
      },
      // Write: overwrite a file (local or session-aware)
      {
        type: "function",
        function: {
          name: "write",
          description: "Write content to a file (supports local or SSH session via local tools service).",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path to write" },
              content: { type: "string", description: "Content to write" },
              session_id: { type: "string", description: "Optional terminal session ID (local/ssh)" }
            },
            required: ["path", "content"],
            additionalProperties: false
          }
        }
      },
      // Edit: exact string replacement in a file (local or session-aware)
      {
        type: "function",
        function: {
          name: "edit",
          description: "Edit a file by exact string replacement (supports local or SSH session via local tools service).",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path to edit" },
              old_string: { type: "string", description: "Exact string to replace" },
              new_string: { type: "string", description: "Replacement string" },
              replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
              session_id: { type: "string", description: "Optional terminal session ID (local/ssh)" }
            },
            required: ["path", "old_string", "new_string"],
            additionalProperties: false
          }
        }
      },
      // Tree: directory tree (local or session-aware)
      {
        type: "function",
        function: {
          name: "tree",
          description: "Get directory tree structure (supports local or SSH session via local tools service).",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Directory path" },
              max_depth: { type: "number", description: "Maximum traversal depth (default 1)" },
              session_id: { type: "string", description: "Optional terminal session ID (local/ssh)" }
            },
            required: ["path"],
            additionalProperties: false
          }
        }
      },
      // Bash: execute local shell command via Python service
      {
        type: "function",
        function: {
          name: "Bash",
          description: "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.\n\nBefore executing the command, please follow these steps:\n\n1. Directory Verification:\n   - If the command will create new directories or files, first use the LS tool to verify the parent directory exists and is the correct location\n   - For example, before running \"mkdir foo/bar\", first use LS to check that \"foo\" exists and is the intended parent directory\n\n2. Command Execution:\n   - Always quote file paths that contain spaces with double quotes (e.g., cd \"path with spaces/file.txt\")\n   - Examples of proper quoting:\n     - cd \"/Users/name/My Documents\" (correct)\n     - cd /Users/name/My Documents (incorrect - will fail)\n     - python \"/path/with spaces/script.py\" (correct)\n     - python /path/with spaces/script.py (incorrect - will fail)\n   - After ensuring proper quoting, execute the command.\n   - Capture the output of the command.\n\nUsage notes:\n  - The command argument is required.\n  - You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 120000ms (2 minutes).\n  - It is very helpful if you write a clear, concise description of what this command does in 5-10 words.\n  - If the output exceeds 30000 characters, output will be truncated before being returned to you.\n  - VERY IMPORTANT: Avoid using search commands like `find` and `grep`. Instead use Grep, Glob.\n  - When issuing multiple commands, use ';' or '&&'. DO NOT use newlines (except inside quoted strings).\n  - Prefer absolute paths over 'cd' unless the user requests it explicitly.",
          parameters: {
            type: "object",
            properties: {
              command: {
                type: "string",
                description: "The command to execute"
              },
              timeout: {
                type: "number",
                description: "Optional timeout in milliseconds (max 600000)"
              },
              description: {
                type: "string",
                description: "Clear, concise description of what this command does in 5-10 words"
              },
              dangerouslyDisableSandbox: {
                type: "boolean",
                description: "Set this to true to dangerously override sandbox mode and run commands without sandboxing."
              },
              session_id: {
                type: "string",
                description: "Optional terminal session ID to execute within (see terminalManage)"
              }
            },
            required: ["command"],
            additionalProperties: false
          }
        }
      },
      // ToolsManage: 管理工具启用状态与查询
      {
        type: "function",
        function: {
          name: "toolsManage",
          description: "工具管理（list/get/enable/disable/set_enabled/sync）。list 显示全部工具及启用状态；enable/disable/set_enabled 控制 chat.enabledTools。",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["list","get","enable","disable","set_enabled","sync"], description: "操作类型" },
              name: { type: "string", description: "工具名称（get/enable/disable时可用）" },
              names: { type: "array", items: { type: "string" }, description: "工具名称数组（enable/disable/set_enabled时可用）" }
            },
            required: ["action"],
            additionalProperties: false
          }
        }
      },
      // SendMail: 发送邮件
      {
        type: "function",
        function: {
          name: "sendMail",
          description: "Send an email to specified recipients. Supports HTML/plain text and attachments. Requires mail service configuration.",
          parameters: {
            type: "object",
            properties: {
              to: { 
                type: "array", 
                items: { type: "string" }, 
                description: "Recipient email addresses (required)" 
              },
              cc: { 
                type: "array", 
                items: { type: "string" }, 
                description: "CC email addresses (optional)" 
              },
              bcc: { 
                type: "array", 
                items: { type: "string" }, 
                description: "BCC email addresses (optional)" 
              },
              subject: { 
                type: "string", 
                description: "Email subject (required)" 
              },
              body: { 
                type: "string", 
                description: "Email body content (required)" 
              },
              html: { 
                type: "boolean", 
                description: "Whether body is HTML format (default: false)" 
              },
              attachments: { 
                type: "array", 
                items: { 
                  type: "object",
                  properties: {
                    filename: { type: "string" },
                    content: { type: "string", description: "Base64 encoded content" },
                    content_type: { type: "string" }
                  },
                  required: ["filename", "content"]
                },
                description: "Email attachments (optional)"
              }
            },
            required: ["to", "subject", "body"],
            additionalProperties: false
          }
        }
      },
    ];

    // 合并到 chat.tools（避免重复）
    const existing = window.zion?.state?.get("chat.tools") || [];
    const existNames = new Set(existing.map(t => t?.function?.name).filter(Boolean));
    const merged = existing.slice();
    for (const t of defaultTools) {
      const nm = t?.function?.name;
      if (nm && !existNames.has(nm)) merged.push(t);
    }
    window.zion.state.set("chat.tools", merged);

    // 为示例工具补充处理器（若未自定义）
    const handlers = { ...(window.zion?.state?.get("chat.toolHandlers") || {}) };


    // WebFetch
    if (!handlers.webFetch) {
      handlers.webFetch = async (args) => {
        const raw = String(args?.url || "").trim();
        if (!raw) return "Missing url";
        const url = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
        const cache = window.zion?.state?.get("webfetch.cache") || {};
        const now = Date.now();
        const ttl = 15 * 60 * 1000; // 15 min
        try {
          // 清理过期缓存
          Object.keys(cache).forEach(k => {
            const it = cache[k];
            if (!it?.ts || now - it.ts > ttl) delete cache[k];
          });
          // 命中缓存
          if (cache[url] && now - cache[url].ts < ttl) {
            return cache[url].md.slice(0, 12000);
          }

          // 通过 r.jina.ai 代理抓取，规避浏览器 CORS
          const proxied = `https://r.jina.ai/${url}`;
          const res = await fetch(proxied, { redirect: "follow" });
          if (!res.ok) return `HTTP ${res.status}: ${await res.text().catch(() => "")}`;
          const text = await res.text();

          // 合成 markdown-like 文本（带标题与来源）
          const header = `# Fetched: ${url}\n\n`;
          const cleaned = String(text || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
          let md = header + cleaned;

          // 缓存并返回（限制长度）
          cache[url] = { ts: now, md };
          window.zion.state.set("webfetch.cache", cache);
          return md.slice(0, 12000);
        } catch (e) {
          return `WebFetch error: ${e?.message || String(e)}`;
        }
      };
    }
    // WebSearch
    if (!handlers.webSearch) {
      handlers.webSearch = async (args) => {
        const query = String(args?.query || "").trim();
        if (!query) return "Missing query";
        const allowed = Array.isArray(args?.allowed_domains) ? args.allowed_domains.map(d => String(d).toLowerCase()) : [];
        const blocked = Array.isArray(args?.blocked_domains) ? args.blocked_domains.map(d => String(d).toLowerCase()) : [];
        try {
          // 使用 DuckDuckGo lite 版，经 r.jina.ai 代理规避 CORS
          const searchUrl = `https://r.jina.ai/http://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
          const res = await fetch(searchUrl);
          if (!res.ok) return `HTTP ${res.status}: ${await res.text().catch(() => "")}`;
          const txt = await res.text();

          // 1) 优先从 markdown 中提取 [title](url) 形式（r.jina.ai 常返回为 markdown/纯文本）
          const mdLinks = Array.from(txt.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g))
            .map(m => ({ title: (m[1] || "").trim(), url: m[2] }))
            // 过滤掉指向搜索页自身的链接
            .filter(it => it.title && it.url && !/duckduckgo\.com\/.*\?q=/i.test(it.url));

          // 2) 如果 markdown 提取过少，回退解析 HTML 的 <a href="http...">title</a>
          let raw = mdLinks.slice();
          if (raw.length < 3) {
            try {
              const doc = new DOMParser().parseFromString(txt, "text/html");
              doc.querySelectorAll('a[href^="http"]').forEach(a => {
                const href = a.getAttribute("href") || "";
                const title = (a.textContent || "").trim();
                if (href && title && !/duckduckgo\.com\/.*\?q=/i.test(href)) {
                  raw.push({ title, url: href });
                }
              });
            } catch { /* ignore parse fallback errors */ }
          }

          // 3) 去重与域名过滤
          const seen = new Set();
          const results = [];
          for (const it of raw) {
            if (!it?.url || !it?.title) continue;
            if (seen.has(it.url)) continue;
            seen.add(it.url);
            let host = "";
            try { host = new URL(it.url).hostname.toLowerCase(); } catch {}
            if (blocked.length && host && blocked.some(b => host.includes(b))) continue;
            if (allowed.length && host && !allowed.some(a => host.includes(a))) continue;
            // 再次防御性过滤掉搜索页本身
            if (/duckduckgo\.com\/.*\?q=/i.test(it.url)) continue;

            results.push(it);
            if (results.length >= 8) break;
          }

          return JSON.stringify({ query, results }, null, 2);
        } catch (e) {
          return `WebSearch error: ${e?.message || String(e)}`;
        }
      };
    }

    // LocalSearch (external Python service)
    if (!handlers.localSearch) {
      handlers.localSearch = async (args) => {
        const query = String(args?.query || "").trim();
        if (!query) return "Missing query";
        const topK = typeof args?.top_k === "number" && args.top_k > 0 ? Math.min(args.top_k, 50) : 10;
        const allowed = Array.isArray(args?.allowed_domains) ? args.allowed_domains.map(d => String(d).toLowerCase()) : [];
        const blocked = Array.isArray(args?.blocked_domains) ? args.blocked_domains.map(d => String(d).toLowerCase()) : [];

        const readBase = () => {
          const st = window.zion?.state?.get("localSearch.baseUrl");
          if (typeof st === "string" && st.trim()) return st.trim();
          try {
            const s = localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        const base = readBase();
        let url = `${base.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&k=${topK}`;
        // pass domain filters to server (it also filters)
        try {
          allowed.forEach(d => { url += `&allowed_domains=${encodeURIComponent(d)}`; });
          blocked.forEach(d => { url += `&blocked_domains=${encodeURIComponent(d)}`; });
        } catch {}

        // cache
        const cache = window.zion?.state?.get("localSearch.cache") || {};
        const key = `${base}|${query}|${topK}|${allowed.join(",")}|${blocked.join(",")}`;
        const now = Date.now();
        const ttl = 10 * 60 * 1000; // 10 min
        try {
          Object.keys(cache).forEach(k => {
            const it = cache[k];
            if (!it?.ts || now - it.ts > ttl) delete cache[k];
          });
        } catch {}
        if (cache[key] && now - cache[key].ts < ttl) {
          return JSON.stringify(cache[key].data, null, 2);
        }

        try {
          const res = await fetch(url, { method: "GET" });
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return `HTTP ${res.status}: ${txt}`;
          }
          const data = await res.json().catch(() => null);
          let results = [];

          if (data && Array.isArray(data.results)) {
            results = data.results.map((it) => ({
              title: String(it.title || it.name || "").trim(),
              url: String(it.url || it.link || "").trim(),
              snippet: String(it.snippet || it.summary || it.description || "").trim()
            })).filter(r => r.title && r.url);
          } else if (Array.isArray(data)) {
            results = data.map((it) => ({
              title: String(it.title || it.name || "").trim(),
              url: String(it.url || it.link || "").trim(),
              snippet: String(it.snippet || it.summary || it.description || "").trim()
            })).filter(r => r.title && r.url);
          } else {
            // Fallback: attempt text links [title](url)
            const text = typeof data === "string" ? data : await res.text().catch(() => "");
            const mdLinks = Array.from(String(text).matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g))
              .map(m => ({ title: (m[1] || "").trim(), url: m[2], snippet: "" }));
            results = mdLinks;
          }

          // domain filters
          const filtered = results.filter(it => {
            let host = "";
            try { host = new URL(it.url).hostname.toLowerCase(); } catch {}
            if (blocked.length && host && blocked.some(b => host.includes(b))) return false;
            if (allowed.length && host && !allowed.some(a => host.includes(a))) return false;
            return true;
          }).slice(0, topK);

          const out = { query, results: filtered };
          cache[key] = { ts: now, data: out };
          window.zion?.state?.set("localSearch.cache", cache);
          return JSON.stringify(out, null, 2);
        } catch (e) {
          return `LocalSearch error: ${e?.message || String(e)}`;
        }
      };
    }

    // Glob (local/remote via local tools service, session-aware)
    if (!handlers.glob) {
      handlers.glob = async (args) => {
        const pattern = String(args?.pattern || "").trim();
        const path = String(args?.path || "").trim();
        const sessionId = String(args?.session_id || "").trim();
        if (!pattern) return "Missing pattern";

        const readBase = () => {
          const st1 = window.zion?.state?.get("localTools.baseUrl");
          if (typeof st1 === "string" && st1.trim()) return st1.trim();
          try {
            const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        const base = readBase();
        let url = `${base.replace(/\/$/, "")}/files/glob?pattern=${encodeURIComponent(pattern)}`;
        if (path) url += `&path=${encodeURIComponent(path)}`;
        if (sessionId) url += `&session_id=${encodeURIComponent(sessionId)}`;

        try {
          const res = await fetch(url, { method: "GET" });
          if (!res.ok) return `HTTP ${res.status}: ${await res.text().catch(() => "")}`;
          const data = await res.json().catch(() => null);
          const results = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
          return JSON.stringify({ pattern, path: path || undefined, session_id: sessionId || undefined, results }, null, 2);
        } catch (e) {
          return `Glob error: ${e?.message || String(e)}`;
        }
      };
    }

    // Grep (local/remote via local tools service, ripgrep-backed)
    if (!handlers.grep) {
      handlers.grep = async (args) => {
        const pattern = String(args?.pattern || "").trim();
        if (!pattern) return "Missing pattern";
        const path = String(args?.path || "").trim();
        const sessionId = String(args?.session_id || "").trim();
        const outputMode = String(args?.output_mode || "files_with_matches");
        const B = typeof args?.B === "number" ? args.B : undefined;
        const A = typeof args?.A === "number" ? args.A : undefined;
        const C = typeof args?.C === "number" ? args?.C : undefined;
        const n = args?.n === undefined ? true : !!args?.n;
        const i = !!args?.i;
        const type = typeof args?.type === "string" ? String(args.type).trim() : "";
        const headLimit = typeof args?.head_limit === "number" ? args.head_limit : undefined;
        const offset = typeof args?.offset === "number" ? args.offset : undefined;
        const multiline = !!args?.multiline;

        const readBase = () => {
          const st1 = window.zion?.state?.get("localTools.baseUrl");
          if (typeof st1 === "string" && st1.trim()) return st1.trim();
          try {
            const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        const base = readBase();
        let url = `${base.replace(/\/$/, "")}/files/grep?pattern=${encodeURIComponent(pattern)}&output_mode=${encodeURIComponent(outputMode)}`;
        if (path) url += `&path=${encodeURIComponent(path)}`;
        const glb = Array.isArray(args?.glob) ? args.glob : (typeof args?.glob === "string" && args?.glob.trim() ? [args.glob] : []);
        const defaultExcludes = ["!**/node_modules/**","!**/.git/**","!**/dist/**","!**/build/**","!**/.next/**","!**/.cache/**","!**/.venv/**","!**/venv/**","!**/target/**","!**/out/**","!**/coverage/**","!**/.tox/**","!**/.pytest_cache/**","!**/.idea/**","!**/.vscode/**","!**/tmp/**"];
        const mergedGlobs = (glb && glb.length > 0) ? Array.from(new Set([...glb, ...defaultExcludes])) : defaultExcludes;
        try {
          mergedGlobs.forEach(g => { url += `&glob=${encodeURIComponent(String(g))}`; });
        } catch {}
        if (B != null) url += `&B=${B}`;
        if (A != null) url += `&A=${A}`;
        if (C != null) url += `&C=${C}`;
        if (n != null) url += `&n=${n ? "true" : "false"}`;
        if (i) url += `&i=true`;
        if (type) url += `&type=${encodeURIComponent(type)}`;
        if (headLimit != null) url += `&head_limit=${headLimit}`;
        if (offset != null) url += `&offset=${offset}`;
        if (multiline) url += `&multiline=true`;
        if (sessionId) url += `&session_id=${encodeURIComponent(sessionId)}`;

        try {
          const res = await fetch(url, { method: "GET" });
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return `HTTP ${res.status}: ${txt}`;
          }
          const data = await res.json().catch(() => null);
          const results = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
          return JSON.stringify({ pattern, path: path || undefined, session_id: sessionId || undefined, output_mode: outputMode, results }, null, 2);
        } catch (e) {
          return `Grep error: ${e?.message || String(e)}`;
        }
      };
    }

    // Read (local tools service, session-aware)
    if (!handlers.read) {
      handlers.read = async (args) => {
        const path = String(args?.path || args?.file_path || "").trim();
        const sessionId = String(args?.session_id || "").trim();
        const offset = typeof args?.offset === "number" ? args.offset : undefined;
        const limit = typeof args?.limit === "number" ? args.limit : undefined;
        if (!path) return "Missing path";

        const readBase = () => {
          const st1 = window.zion?.state?.get("localTools.baseUrl");
          if (typeof st1 === "string" && st1.trim()) return st1.trim();
          try {
            const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        const base = readBase();
        let url = `${base.replace(/\/$/, "")}/files/read?path=${encodeURIComponent(path)}`;
        if (offset != null) url += `&offset=${offset}`;
        if (limit != null) url += `&limit=${limit}`;
        if (sessionId) url += `&session_id=${encodeURIComponent(sessionId)}`;

        try {
          const res = await fetch(url, { method: "GET" });
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return `HTTP ${res.status}: ${txt || data?.error || "read failed"}`;
          }
          const content = typeof data?.content === "string" ? data.content : "";
          return content;
        } catch (e) {
          return `Read error: ${e?.message || String(e)}`;
        }
      };
    }

    // Write (local tools service, session-aware)
    if (!handlers.write) {
      handlers.write = async (args) => {
        const path = String(args?.path || args?.file_path || "").trim();
        const content = String(args?.content ?? "");
        const sessionId = String(args?.session_id || "").trim();
        if (!path) return "Missing path";

        const readBase = () => {
          const st1 = window.zion?.state?.get("localTools.baseUrl");
          if (typeof st1 === "string" && st1.trim()) return st1.trim();
          try {
            const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        const base = readBase();
        const url = `${base.replace(/\/$/, "")}/files/write`;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path, content, session_id: sessionId || undefined })
          });
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return `HTTP ${res.status}: ${txt || data?.error || "write failed"}`;
          }
          return JSON.stringify(data, null, 2);
        } catch (e) {
          return `Write error: ${e?.message || String(e)}`;
        }
      };
    }

    // Edit (local tools service, session-aware)
    if (!handlers.edit) {
      handlers.edit = async (args) => {
        const path = String(args?.path || args?.file_path || "").trim();
        const old_string = String(args?.old_string ?? "");
        const new_string = String(args?.new_string ?? "");
        const replace_all = !!args?.replace_all;
        const sessionId = String(args?.session_id || "").trim();
        if (!path) return "Missing path";
        if (!old_string) return "Missing old_string";

        const readBase = () => {
          const st1 = window.zion?.state?.get("localTools.baseUrl");
          if (typeof st1 === "string" && st1.trim()) return st1.trim();
          try {
            const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        const base = readBase();
        const url = `${base.replace(/\/$/, "")}/files/edit`;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path, old_string, new_string, replace_all, session_id: sessionId || undefined })
          });
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return `HTTP ${res.status}: ${txt || data?.error || "edit failed"}`;
          }
          return JSON.stringify(data, null, 2);
        } catch (e) {
          return `Edit error: ${e?.message || String(e)}`;
        }
      };
    }

    // Tree (local tools service, session-aware)
    if (!handlers.tree) {
      handlers.tree = async (args) => {
        const path = String(args?.path || "").trim();
        const depth = typeof args?.max_depth === "number" ? args.max_depth : 1;
        const sessionId = String(args?.session_id || "").trim();
        if (!path) return "Missing path";

        const readBase = () => {
          const st1 = window.zion?.state?.get("localTools.baseUrl");
          if (typeof st1 === "string" && st1.trim()) return st1.trim();
          try {
            const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        const base = readBase();
        let url = `${base.replace(/\/$/, "")}/files/entries?path=${encodeURIComponent(path)}&max_depth=${depth}`;
        if (sessionId) url += `&session_id=${encodeURIComponent(sessionId)}`;

        try {
          const res = await fetch(url, { method: "GET" });
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return `HTTP ${res.status}: ${txt || data?.error || "tree failed"}`;
          }
          // 直接返回 tree 的文本结果
          const results = typeof data?.results === "string" ? data.results : "";
          return results;
        } catch (e) {
          return `Tree error: ${e?.message || String(e)}`;
        }
      };
    }

    // Bash (local tools) with session support
    if (!handlers.Bash) {
      handlers.Bash = async (args) => {
        const command = String(args?.command || "").trim();
        if (!command) return "Missing command";
        const timeout = typeof args?.timeout === "number" ? Math.min(Math.max(args.timeout, 1), 600000) : undefined;
        const sessionId = String(args?.session_id || "").trim();
        const dangerouslyDisableSandbox = !!args?.dangerouslyDisableSandbox;

        const readBase = () => {
          const st1 = window.zion?.state?.get("localTools.baseUrl");
          if (typeof st1 === "string" && st1.trim()) return st1.trim();
          try {
            const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        const base = readBase();
        const baseClean = base.replace(/\/$/, "");

        try {
          // 如果带有 session_id，则调用 sessions/{id}/exec
          if (sessionId) {
            const urlSess = `${baseClean}/sessions/${encodeURIComponent(sessionId)}/exec`;
            const res = await fetch(urlSess, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ command, timeout, dangerouslyDisableSandbox })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
              const txt = typeof data === "string" ? data : (await res.text().catch(() => ""));
              return `HTTP ${res.status}: ${txt}`;
            }
            if (!data) return "Empty response";
            // sandbox blocked message unify
            if (data.error && typeof data.error === 'string' && data.error.includes('blocked_by_sandbox')) {
              const patternMatch = data.error.match(/pattern[:\s]+(.+)$/);
              const matchedPattern = patternMatch ? patternMatch[1].trim() : 'unknown pattern';
              const errorMsg = `Command blocked by sandbox security rules.\n` +
                              `Reason: The command contains "${matchedPattern}" which matches a restricted pattern.\n` +
                              `Command: ${command}\n` +
                              `Session: ${sessionId}\n` +
                              `\nTo bypass this restriction, you can:\n` +
                              `1. Use a different path that doesn't contain restricted keywords\n` +
                              `2. Add "dangerouslyDisableSandbox": true to the command arguments\n` +
                              `3. Configure the local service to allow dangerous commands (ZION_ALLOW_DANGEROUS=1)`;
              return JSON.stringify({
                command,
                session_id: sessionId,
                ok: false,
                error: data.error,
                sandbox_blocked: true,
                user_message: errorMsg,
                sandbox: data.sandbox || true,
                cwd: typeof data.cwd === "string" ? data.cwd : undefined
              }, null, 2);
            }
            const out = {
              command,
              session_id: sessionId,
              exit_code: typeof data.exit_code === "number" ? data.exit_code : undefined,
              timeout_ms: typeof data.timeout_ms === "number" ? data.timeout_ms : undefined,
              duration_ms: typeof data.duration_ms === "number" ? data.duration_ms : undefined,
              stdout: String(data.stdout ?? ""),
              stderr: String(data.stderr ?? ""),
              ok: !!data.ok,
              truncated: !!data.truncated,
              ...(data.error ? { error: data.error } : {}),
              ...(data.sandbox !== undefined ? { sandbox: data.sandbox } : {}),
              ...(typeof data.cwd === "string" ? { cwd: data.cwd } : {})
            };
            return JSON.stringify(out, null, 2);
          }

          // 否则走原 /bash
          const url = `${baseClean}/bash`;
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command, timeout, dangerouslyDisableSandbox })
          });
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return `HTTP ${res.status}: ${txt}`;
          }
          const data = await res.json().catch(() => null);
          if (!data) return "Empty response";

          if (data.error && typeof data.error === 'string' && data.error.includes('blocked_by_sandbox')) {
            const patternMatch = data.error.match(/pattern[:\s]+(.+)$/);
            const matchedPattern = patternMatch ? patternMatch[1].trim() : 'unknown pattern';
            const errorMsg = `Command blocked by sandbox security rules.\n` +
                            `Reason: The command contains "${matchedPattern}" which matches a restricted pattern.\n` +
                            `Command: ${command}\n` +
                            `\nTo bypass this restriction, you can:\n` +
                            `1. Use a different path that doesn't contain restricted keywords\n` +
                            `2. Add "dangerouslyDisableSandbox": true to the command arguments\n` +
                            `3. Configure the local service to allow dangerous commands (ZION_ALLOW_DANGEROUS=1)`;
            return JSON.stringify({
              command,
              ok: false,
              error: data.error,
              sandbox_blocked: true,
              user_message: errorMsg,
              sandbox: data.sandbox || true,
              cwd: typeof data.cwd === "string" ? data.cwd : undefined
            }, null, 2);
          }

          const out = {
            command,
            exit_code: typeof data.exit_code === "number" ? data.exit_code : undefined,
            timeout_ms: typeof data.timeout_ms === "number" ? data.timeout_ms : undefined,
            duration_ms: typeof data.duration_ms === "number" ? data.duration_ms : undefined,
            stdout: String(data.stdout ?? ""),
            stderr: String(data.stderr ?? ""),
            ok: !!data.ok,
            truncated: !!data.truncated,
            ...(data.error ? { error: data.error } : {}),
            ...(data.sandbox !== undefined ? { sandbox: data.sandbox } : {}),
            ...(typeof data.cwd === "string" ? { cwd: data.cwd } : {})
          };
          return JSON.stringify(out, null, 2);
        } catch (e) {
          return `Bash error: ${e?.message || String(e)}`;
        }
      };
    }

    // ToolsManage: 管理工具启用状态与查询
    if (!handlers.toolsManage) {
      handlers.toolsManage = async (args) => {
        try {
          const action = String(args?.action || "").trim();
          const regTools = window.zion?.state?.get("chat.tools") || [];
          const allNames = regTools.map(t => t?.function?.name).filter(Boolean);
          const enabled = window.zion?.state?.get("chat.enabledTools");
          const enabledSet = new Set(Array.isArray(enabled) ? enabled : allNames);

          const uniqNamesFromArgs = () => {
            let arr = [];
            const n1 = typeof args?.name === "string" ? [String(args.name).trim()] : [];
            const n2 = Array.isArray(args?.names) ? args.names.map(s => String(s).trim()) : [];
            arr = [...n1, ...n2].filter(Boolean);
            return Array.from(new Set(arr));
          };

          if (action === "list") {
            const out = regTools.map(t => ({
              name: t?.function?.name,
              description: t?.function?.description || "",
              enabled: enabledSet.has(t?.function?.name)
            })).filter(it => it.name);
            return JSON.stringify({ tools: out, enabled: Array.from(enabledSet) }, null, 2);
          }

          if (action === "get") {
            const nm = String(args?.name || "").trim();
            if (!nm) return "Missing name";
            const item = regTools.find(t => t?.function?.name === nm);
            if (!item) return `Tool not found: ${nm}`;
            return JSON.stringify(item.function || item, null, 2);
          }

          if (action === "enable") {
            const toEnable = uniqNamesFromArgs().filter(n => allNames.includes(n));
            if (toEnable.length === 0) return "No valid tool names to enable";
            toEnable.forEach(n => enabledSet.add(n));
            window.zion?.state?.set("chat.enabledTools", Array.from(enabledSet));
            // 更新已知列表，防止被自动清理
            window.zion?.state?.set("chat.toolsKnownNames", allNames);
            return JSON.stringify({ enabled: Array.from(enabledSet) }, null, 2);
          }

          if (action === "disable") {
            const toDisable = uniqNamesFromArgs().filter(n => allNames.includes(n));
            if (toDisable.length === 0) return "No valid tool names to disable";
            toDisable.forEach(n => enabledSet.delete(n));
            window.zion?.state?.set("chat.enabledTools", Array.from(enabledSet));
            window.zion?.state?.set("chat.toolsKnownNames", allNames);
            return JSON.stringify({ enabled: Array.from(enabledSet) }, null, 2);
          }

          if (action === "set_enabled") {
            const list = Array.isArray(args?.names) ? args.names.map(s => String(s).trim()).filter(Boolean) : [];
            const inter = list.filter(n => allNames.includes(n));
            window.zion?.state?.set("chat.enabledTools", inter);
            window.zion?.state?.set("chat.toolsKnownNames", allNames);
            return JSON.stringify({ enabled: inter }, null, 2);
          }

          if (action === "sync") {
            try { ensureEnabledTools(); } catch {}
            const cur = window.zion?.state?.get("chat.enabledTools") || [];
            return JSON.stringify({ enabled: cur }, null, 2);
          }

          return "Unknown action";
        } catch (e) {
          return `toolsManage error: ${e?.message || String(e)}`;
        }
      };
    }

    // 移除 terminalManage 处理器（迁移到 dev.terminal-manager 扩展中）

    // SendMail: 发送邮件（本地服务，SMTP）
    if (!handlers.sendMail) {
      handlers.sendMail = async (args) => {
        try {
          const base = (() => {
            const st = window.zion?.state?.get("mail.baseUrl");
            if (typeof st === "string" && st.trim()) return st.trim();
            try { const s = localStorage.getItem("zion.mail.baseUrl") || ""; if (s) return s.trim(); } catch {}
            return "http://127.0.0.1:8765";
          })().replace(/\/$/, "");

          // 推送（或刷新）服务端配置：读取 SMTP 设置并发送到服务端
          const cfg = {
            provider: "smtp",
            smtp_host: "",
            smtp_port: 587,
            smtp_username: "",
            smtp_password: "",
            smtp_use_tls: true,
            from_email: "",
            from_name: ""
          };
          try {
            cfg.smtp_host = (localStorage.getItem("zion.mail.smtp.host") || "").trim();
            const p = (localStorage.getItem("zion.mail.smtp.port") || "").trim();
            const pn = parseInt(p || "587", 10); cfg.smtp_port = isNaN(pn) ? 587 : pn;
            cfg.smtp_username = (localStorage.getItem("zion.mail.smtp.username") || "").trim();
            cfg.smtp_password = (localStorage.getItem("zion.mail.smtp.password") || "");
            const tlsRaw = (localStorage.getItem("zion.mail.smtp.useTls") || "").toLowerCase();
            cfg.smtp_use_tls = tlsRaw === "1" || tlsRaw === "true" || tlsRaw === "yes";
            cfg.from_email = (localStorage.getItem("zion.mail.fromEmail") || "").trim() || "zion@zion.ai";
            cfg.from_name = (localStorage.getItem("zion.mail.fromName") || "").trim() || "Zion AI";
            if (cfg.smtp_host) {
              await fetch(`${base}/mail/config`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(cfg)
              }).catch(() => {});
            }
          } catch {}

          // 映射参数：兼容 content/body
          const to = Array.isArray(args?.to) ? args.to.map(String).filter(Boolean) : [];
          const subject = String(args?.subject || "").trim();
          const body = String((args?.body ?? args?.content ?? "")).trim();
          const html = !!args?.html;
          const cc = Array.isArray(args?.cc) ? args.cc.map(String).filter(Boolean) : undefined;
          const bcc = Array.isArray(args?.bcc) ? args.bcc.map(String).filter(Boolean) : undefined;

          if (!to.length) return "Missing to";
          if (!subject) return "Missing subject";
          if (!body) return "Missing body";

          const payload = { to, subject, body, html, cc, bcc };
          const res = await fetch(`${base}/mail/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          const txt = await res.text();
          if (!res.ok) {
            // 尝试解析错误
            let detail = "";
            try { const j = JSON.parse(txt); detail = j?.detail ? JSON.stringify(j.detail) : txt; } catch { detail = txt; }
            return `HTTP ${res.status}: ${detail}`;
          }
          return txt;
        } catch (e) {
          return `sendMail error: ${e?.message || String(e)}`;
        }
      };
    }

    window.zion.state.set("chat.toolHandlers", handlers);

    // 同步启用列表（默认启用全部；新增/移除时更新）
    try { ensureEnabledTools(); } catch {}
  } catch (e) {
    console.warn("[dev.tools] registerDefaultTools failed", e);
  }
}