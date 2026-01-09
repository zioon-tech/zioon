import { installTerminalManagerPanel } from "./session-tools.js";

export async function activate(ctx) {
  // 注册 terminalManage 工具 schema 到 chat.tools
  try {
    const terminalManageTool = {
      type: "function",
      function: {
        name: "terminalManage",
        description: "Manage persistent terminal sessions (local or SSH). Supports actions: create/list/get/close/set_cwd. For SSH, provide ssh_host, ssh_user?, ssh_port?.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create","list","get","close","set_cwd"], description: "Management action" },
            type: { type: "string", enum: ["local","ssh"], description: "Session type (default local)" },
            ssh_user: { type: "string", description: "SSH username (ssh sessions)" },
            ssh_host: { type: "string", description: "SSH host (ssh sessions)" },
            ssh_port: { type: "number", description: "SSH port (default 22)" },
            initial_cwd: { type: "string", description: "Initial working directory" },
            session_id: { type: "string", description: "Target session id (get/close/set_cwd)" },
            cwd: { type: "string", description: "New working directory (set_cwd)" }
          },
          required: ["action"],
          additionalProperties: false
        }
      }
    };
    const existing = window.zion?.state?.get("chat.tools") || [];
    const existNames = new Set(existing.map(t => t?.function?.name).filter(Boolean));
    const merged = existing.slice();
    if (!existNames.has("terminalManage")) merged.push(terminalManageTool);
    window.zion.state.set("chat.tools", merged);
  } catch (e) {
    console.warn("[dev.terminal-manager] register tool schema failed", e);
  }

  // 注册 terminalManage 处理器（迁移自 dev.tools）
  try {
    const handlers = { ...(window.zion?.state?.get("chat.toolHandlers") || {}) };
    if (!handlers.terminalManage) {
      handlers.terminalManage = async (args) => {
        try {
          const action = String(args?.action || "").trim();
          const readBase = () => {
            const st1 = window.zion?.state?.get("localTools.baseUrl");
            if (typeof st1 === "string" && st1.trim()) return st1.trim();
            try {
              const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
              if (s) return s.trim();
            } catch {}
            return "http://127.0.0.1:8765";
          };
          const base = readBase().replace(/\/$/, "");

          if (action === "create") {
            const type = String(args?.type || "local").trim();
            const ssh_user = typeof args?.ssh_user === "string" ? args.ssh_user.trim() : undefined;
            const ssh_host = typeof args?.ssh_host === "string" ? args.ssh_host.trim() : undefined;
            const ssh_port = typeof args?.ssh_port === "number" ? args.ssh_port : undefined;
            const initial_cwd = typeof args?.initial_cwd === "string" ? args.initial_cwd.trim() : undefined;
            const payload = { type, ssh_user, ssh_host, ssh_port, initial_cwd };
            const res = await fetch(`${base}/sessions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) return `HTTP ${res.status}: ${await res.text().catch(() => "")}`;
            // 更新状态
            const list = (window.zion?.state?.get("terminal.sessions") || []).slice();
            if (data?.session?.id) list.push(data.session);
            window.zion?.state?.set("terminal.sessions", list);
            window.zion?.state?.set("terminal.activeSessionId", data?.session?.id || null);
            return JSON.stringify(data, null, 2);
          }

          if (action === "list") {
            const res = await fetch(`${base}/sessions`, { method: "GET" });
            const data = await res.json().catch(() => null);
            if (!res.ok) return `HTTP ${res.status}: ${await res.text().catch(() => "")}`;
            window.zion?.state?.set("terminal.sessions", data?.sessions || []);
            return JSON.stringify(data, null, 2);
          }

          if (action === "get") {
            const sid = String(args?.session_id || "").trim();
            if (!sid) return "Missing session_id";
            const res = await fetch(`${base}/sessions/${encodeURIComponent(sid)}`, { method: "GET" });
            const data = await res.json().catch(() => null);
            if (!res.ok) return `HTTP ${res.status}: ${await res.text().catch(() => "")}`;
            return JSON.stringify(data, null, 2);
          }

          if (action === "close") {
            const sid = String(args?.session_id || "").trim();
            if (!sid) return "Missing session_id";
            const res = await fetch(`${base}/sessions/${encodeURIComponent(sid)}`, { method: "DELETE" });
            const data = await res.json().catch(() => null);
            if (!res.ok) return `HTTP ${res.status}: ${await res.text().catch(() => "")}`;
            // 更新状态
            const list = (window.zion?.state?.get("terminal.sessions") || []).filter(s => s?.id !== sid);
            window.zion?.state?.set("terminal.sessions", list);
            const cur = window.zion?.state?.get("terminal.activeSessionId");
            if (cur === sid) window.zion?.state?.set("terminal.activeSessionId", null);
            return JSON.stringify(data, null, 2);
          }

          if (action === "set_cwd") {
            const sid = String(args?.session_id || "").trim();
            const cwd = String(args?.cwd || "").trim();
            if (!sid) return "Missing session_id";
            if (!cwd) return "Missing cwd";
            const res = await fetch(`${base}/sessions/${encodeURIComponent(sid)}/exec`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ command: `cd "${cwd}"` })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) return `HTTP ${res.status}: ${await res.text().catch(() => "")}`;
            // 更新状态中的该会话 cwd（如果存在）
            const list = (window.zion?.state?.get("terminal.sessions") || []).slice();
            for (let i = 0; i < list.length; i++) {
              if (list[i]?.id === sid) {
                list[i] = { ...list[i], cwd };
                break;
              }
            }
            window.zion?.state?.set("terminal.sessions", list);
            return JSON.stringify(data, null, 2);
          }

          return "Unknown action";
        } catch (e) {
          return `terminalManage error: ${e?.message || String(e)}`;
        }
      };
    }
    window.zion.state.set("chat.toolHandlers", handlers);
  } catch (e) {
    console.warn("[dev.terminal-manager] register handler failed", e);
  }

  // 面板与命令/状态栏
  let panel = null;
  const dispDec = window.zion.editor.registerDecorator({
    id: "dev.terminal.manager.panel",
    apply(editor) {
      panel = installTerminalManagerPanel();
      return { dispose() { panel?.dispose?.(); panel = null; } };
    }
  });
  ctx.subscriptions.push(dispDec);

  const openCmd = window.zion.commands.registerCommand("terminal.openManager", () => { panel?.open?.(); });
  const closeCmd = window.zion.commands.registerCommand("terminal.closeManager", () => { panel?.close?.(); });
  ctx.subscriptions.push(openCmd, closeCmd);

  let statusDisp = null;
  const updateStatus = () => {
    const sid = window.zion?.state?.get("terminal.activeSessionId");
    statusDisp?.dispose?.();
    statusDisp = window.zion.statusBar.registerItem({
      id: "dev.terminal.button",
      text: `Terminal${sid ? `: ${sid}` : ""}`,
      tooltip: "Open Terminal Manager",
      onClick: () => window.zion.commands.executeCommand("terminal.openManager")
    });
  };
  updateStatus();
  ctx.subscriptions.push(window.zion.state.onDidChange("terminal.activeSessionId", () => updateStatus()));

  // 启动时同步一次会话列表，确保“注入终端上下文”时能拿到全部会话
  (async () => {
    try {
      const readBase = () => {
        const st1 = window.zion?.state?.get("localTools.baseUrl");
        if (typeof st1 === "string" && st1.trim()) return st1.trim();
        try {
          const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
          if (s) return s.trim();
        } catch {}
        return "http://127.0.0.1:8765";
      };
      const base = readBase().replace(/\/$/, "");
      const res = await fetch(`${base}/sessions`, { method: "GET" });
      const data = await res.json().catch(() => null);
      if (res.ok && data && Array.isArray(data.sessions)) {
        window.zion?.state?.set("terminal.sessions", data.sessions);
      }
    } catch {}
  })();
}