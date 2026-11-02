import { mountTerminalManagerSidebarViewInto } from "./session-tools.js";
import {
  buildTerminalInventoryContextXml,
  filterTerminalSessions
} from "./terminal-inventory.js";
import {
  closeTerminalSession,
  createTerminalSession,
  ensureTerminalSessions,
  getTerminalMachine,
  getTerminalSession,
  listTerminalSessions,
  reactivateTerminalSession,
  setTerminalSessionCwd,
  updateTerminalMachine
} from "./terminal-service.js";

const I18N_NS = "dev.terminal-manager";
const I18N_MESSAGES = {
  "zh-CN": {
    "category.terminal": "终端",
    "cmd.openManager": "打开终端管理器",
    "cmd.closeManager": "关闭终端管理器",
    "cmd.newSameLevel": "同级新建会话",
    "ui.terminal": "终端",
    "ui.refresh": "刷新会话",
    "ui.sessions": "终端会话",
    "ui.loading": "正在读取会话...",
    "ui.newTerminal": "新建终端",
    "ui.collapseNew": "收起新建",
    "ui.searchSessions": "搜索机器、项目或终端",
    "ui.create": "创建终端",
    "ui.cancel": "取消",
    "ui.injectContext": "在对话中注入终端上下文",
    "ui.injectContextShort": "注入上下文",
    "ui.type": "类型",
    "ui.sshUser": "SSH 用户",
    "ui.sshHost": "SSH 主机（或别名）",
    "ui.sshHostTitle": "可以使用 SSH config 别名（如 las-dev）或直接填写主机名（如 101.126.47.38）",
    "ui.sshPort": "SSH 端口",
    "ui.initialCwd": "初始工作目录",
    "ui.noSessionsSummary": "还没有终端会话。可以先新建一个本地终端。",
    "ui.summaryActive": "共 {count} 个会话，当前使用 {name}。",
    "ui.summaryNoActive": "共 {count} 个会话，还没有当前终端。",
    "ui.noSessions": "还没有终端会话。点击“新建终端”创建一个本地会话。",
    "ui.noMatchingSessions": "没有匹配的终端会话。",
    "ui.sessionsUnit": "个会话",
    "ui.machinesUnit": "台机器",
    "ui.workspacesUnit": "个项目",
    "ui.available": "可用",
    "ui.disconnected": "已断开",
    "ui.sshSession": "SSH 会话",
    "ui.localTerminal": "本地终端",
    "ui.local": "本地",
    "ui.cwdUnset": "未设置工作目录",
    "ui.unknown": "未知",
    "ui.justNow": "刚刚",
    "ui.current": "当前",
    "ui.more": "更多",
    "ui.collapse": "收起",
    "ui.cwd": "工作目录",
    "ui.updateCwd": "更新目录",
    "ui.machineName": "机器名称",
    "ui.machineDescription": "机器描述",
    "ui.saveMachine": "保存机器信息",
    "ui.openTerminal": "打开终端",
    "ui.reconnect": "重新连接",
    "ui.closeSession": "关闭会话",
    "msg.closeFailed": "关闭终端失败，请稍后再试。",
    "msg.closeFailedWithError": "关闭终端失败：{message}",
    "msg.cwdFailed": "更新工作目录失败，请稍后再试。",
    "msg.cwdFailedWithError": "更新工作目录失败：{message}",
    "msg.cwdUpdated": "已更新工作目录。",
    "msg.reconnected": "已重新连接终端会话。",
    "msg.reconnectFailed": "重新连接失败，请稍后再试。",
    "msg.reconnectFailedWithError": "重新连接失败：{message}",
    "msg.refreshFailed": "刷新终端列表失败。",
    "msg.refreshFailedWithError": "刷新终端列表失败：{message}",
    "msg.createFailed": "创建终端失败，请检查填写内容。",
    "msg.createFailedWithError": "创建终端失败：{message}",
    "msg.created": "终端已创建，并设为当前会话。",
    "msg.closed": "已关闭终端会话。",
    "msg.machineUpdated": "已更新机器信息。"
  },
  "en-US": {
    "category.terminal": "Terminal",
    "cmd.openManager": "Open Terminal Manager",
    "cmd.closeManager": "Close Terminal Manager",
    "cmd.newSameLevel": "New Session at Same Level",
    "ui.terminal": "Terminal",
    "ui.refresh": "Refresh sessions",
    "ui.sessions": "Terminal Sessions",
    "ui.loading": "Loading sessions...",
    "ui.newTerminal": "New Terminal",
    "ui.collapseNew": "Collapse",
    "ui.searchSessions": "Search machines, projects, or terminals",
    "ui.create": "Create Terminal",
    "ui.cancel": "Cancel",
    "ui.injectContext": "Inject terminal context into chat",
    "ui.injectContextShort": "Inject context",
    "ui.type": "Type",
    "ui.sshUser": "SSH User",
    "ui.sshHost": "SSH Host (or alias)",
    "ui.sshHostTitle": "Use an SSH config alias (for example las-dev) or direct hostname (for example 101.126.47.38)",
    "ui.sshPort": "SSH Port",
    "ui.initialCwd": "Initial CWD",
    "ui.noSessionsSummary": "No terminal sessions yet. Create a local terminal first.",
    "ui.summaryActive": "{count} sessions, currently using {name}.",
    "ui.summaryNoActive": "{count} sessions, no current terminal.",
    "ui.noSessions": "No terminal sessions yet. Click \"New Terminal\" to create a local session.",
    "ui.noMatchingSessions": "No matching terminal sessions.",
    "ui.sessionsUnit": "sessions",
    "ui.machinesUnit": "machines",
    "ui.workspacesUnit": "projects",
    "ui.available": "Available",
    "ui.disconnected": "Disconnected",
    "ui.sshSession": "SSH Session",
    "ui.localTerminal": "Local Terminal",
    "ui.local": "Local",
    "ui.cwdUnset": "No working directory",
    "ui.unknown": "unknown",
    "ui.justNow": "just now",
    "ui.current": "Current",
    "ui.more": "More",
    "ui.collapse": "Collapse",
    "ui.cwd": "Working Directory",
    "ui.updateCwd": "Update CWD",
    "ui.machineName": "Machine Name",
    "ui.machineDescription": "Machine Description",
    "ui.saveMachine": "Save Machine",
    "ui.openTerminal": "Open Terminal",
    "ui.reconnect": "Reconnect",
    "ui.closeSession": "Close Session",
    "msg.closeFailed": "Failed to close terminal. Try again later.",
    "msg.closeFailedWithError": "Failed to close terminal: {message}",
    "msg.cwdFailed": "Failed to update working directory. Try again later.",
    "msg.cwdFailedWithError": "Failed to update working directory: {message}",
    "msg.cwdUpdated": "Working directory updated.",
    "msg.reconnected": "Terminal session reconnected.",
    "msg.reconnectFailed": "Reconnect failed. Try again later.",
    "msg.reconnectFailedWithError": "Reconnect failed: {message}",
    "msg.refreshFailed": "Failed to refresh terminal list.",
    "msg.refreshFailedWithError": "Failed to refresh terminal list: {message}",
    "msg.createFailed": "Failed to create terminal. Check the form values.",
    "msg.createFailedWithError": "Failed to create terminal: {message}",
    "msg.created": "Terminal created and set as current session.",
    "msg.closed": "Terminal session closed.",
    "msg.machineUpdated": "Machine information updated."
  }
};

function insertAfterLeadingSystem(messages, injectedMessage) {
  const list = Array.isArray(messages) ? messages : [];
  let index = 0;
  while (index < list.length && list[index]?.role === "system") index += 1;
  return [...list.slice(0, index), injectedMessage, ...list.slice(index)];
}

export async function activate(ctx) {
  try {
    const disp = window.zion.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) ctx.subscriptions.push(disp);
  } catch {}

  try {
    const contributor = window.zion?.messages?.registerContributor?.({
      id: "dev.terminal-manager.inventory",
      order: 55,
      stage: "pre",
      contribute: async (messages) => {
        if (window.zion?.state?.get?.("chat.includeTerminalContext") === false) return messages;
        const content = buildTerminalInventoryContextXml();
        return insertAfterLeadingSystem(messages, { role: "user", content });
      }
    });
    if (contributor) ctx.subscriptions.push(contributor);
  } catch (error) {
    console.warn("[dev.terminal-manager] register inventory contributor failed", error);
  }

  // 注册 terminalManage 工具 schema 到 chat.tools
  try {
    const terminalManageTool = {
      type: "function",
      function: {
        name: "terminalManage",
        description: "Manage terminal sessions, workspaces, and machine descriptions. session_id is a concrete terminal session id for execution; machine_id identifies a machine and is only for filtering or machine metadata.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create","list","get","close","reactivate","set_cwd","list_machines","get_machine","update_machine"], description: "Management action" },
            type: { type: "string", enum: ["local","ssh"], description: "Session type for create only; this is not a session_id" },
            ssh_user: { type: "string", description: "SSH username (ssh sessions)" },
            ssh_host: { type: "string", description: "SSH host (ssh sessions)" },
            ssh_port: { type: "number", description: "SSH port (default 22)" },
            initial_cwd: { type: "string", description: "Initial working directory" },
            session_id: { type: "string", description: "Exact terminal session_id returned by terminalInventory or terminalManage list; not machine_id, workspace_id, local, or ssh" },
            node_id: { type: "string", description: "Explicit execution Node for create when no machine/workspace is selected" },
            resource_id: { type: "string", description: "Explicit resource binding for create" },
            cwd: { type: "string", description: "New working directory (set_cwd)" },
            machine_id: { type: "string", description: "Machine ID returned by terminalInventory or terminalManage list_machines; do not pass as session_id" },
            name: { type: "string", maxLength: 120, description: "Machine display name (update_machine)" },
            description: { type: "string", maxLength: 500, description: "Machine description and detected resource information (update_machine)" },
            workspace_id: { type: "string", description: "Workspace ID returned by terminalInventory or terminalManage list; do not pass as session_id" },
            status: { type: "string", enum: ["connected", "disconnected", "stale"], description: "Optional list filter" },
            limit: { type: "number", minimum: 1, maximum: 200, description: "Maximum items returned by list or list_machines" }
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
          if (action === "create") {
            return JSON.stringify({ session: await createTerminalSession(args) }, null, 2);
          }
          if (action === "list") {
            const sessions = await listTerminalSessions();
            const filtered = filterTerminalSessions(sessions, args);
            const limit = Math.min(50, Math.max(1, Number(args?.limit) || 20));
            const selected = filtered.slice(0, limit).map((session) => ({
              session_id: session.id,
              id: session.id,
              session_type: session.type,
              machine_id: session.machineId,
              workspace_id: session.workspaceId,
              cwd: session.cwd,
              connection_status: session.connectionStatus,
              stale: session.stale,
              last_activity_at: session.lastActivityAt
            }));
            return JSON.stringify({
              session_id_field: "Use sessions[].session_id for Bash/terminalExecute/read/write/edit/glob/grep/tree. Do not use machine_id, workspace_id, local, or ssh as session_id.",
              total: filtered.length,
              returned: selected.length,
              truncated: filtered.length > selected.length,
              sessions: selected
            }, null, 2);
          }
          if (action === "get") {
            return JSON.stringify({ session: await getTerminalSession(args?.session_id) }, null, 2);
          }
          if (action === "list_machines") {
            await listTerminalSessions();
            const inventory = window.zion?.state?.get?.("terminal.inventory");
            const machines = Array.isArray(inventory?.machines) ? inventory.machines : [];
            const limit = Math.min(200, Math.max(1, Number(args?.limit) || 100));
            const selected = machines.slice(0, limit).map((machine) => ({
              machine_id: machine.id,
              id: machine.id,
              name: machine.name,
              description: machine.description,
              kind: machine.kind,
              status: machine.status,
              workspace_count: machine.workspaceCount,
              session_count: machine.sessionCount,
              available_session_count: machine.availableSessionCount,
              disconnected_session_count: machine.disconnectedSessionCount,
              stale_session_count: machine.staleSessionCount,
              last_seen_at: machine.lastSeenAt
            }));
            return JSON.stringify({
              total: machines.length,
              returned: selected.length,
              truncated: machines.length > selected.length,
              machines: selected
            }, null, 2);
          }
          if (action === "get_machine") {
            return JSON.stringify({ machine: await getTerminalMachine(args?.machine_id) }, null, 2);
          }
          if (action === "update_machine") {
            return JSON.stringify({
              machine: await updateTerminalMachine(args?.machine_id, {
                name: args?.name,
                description: args?.description
              })
            }, null, 2);
          }
          if (action === "close") {
            await closeTerminalSession(args?.session_id);
            return JSON.stringify({ closed: true, session_id: args?.session_id }, null, 2);
          }
          if (action === "set_cwd") {
            await setTerminalSessionCwd(args?.session_id, args?.cwd);
            return JSON.stringify({ updated: true, session_id: args?.session_id, cwd: args?.cwd }, null, 2);
          }
          if (action === "reactivate") {
            return JSON.stringify({ session: await reactivateTerminalSession(args?.session_id) }, null, 2);
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

  // 命令/状态栏

  const refreshSessions = () => listTerminalSessions();
  const ensureSessions = () => ensureTerminalSessions();
  const createSession = (args) => createTerminalSession(args);
  const closeSession = (sessionId) => closeTerminalSession(sessionId);
  const setSessionCwd = (sessionId, cwd) => setTerminalSessionCwd(sessionId, cwd);

  const openCmd = window.zion.commands.registerCommand("terminal.openManager", () => {
    try {
      window.zion.sideBar?.show?.();
      window.zion.sideBar?.activateView?.("terminal.manager");
      try {
        window.zion.state.set("ui.activityBar.activeItemId", "terminal.activity");
      } catch {}
    } catch {}
  });
  const closeCmd = window.zion.commands.registerCommand("terminal.closeManager", () => {
    try {
      window.zion.sideBar?.hide?.();
    } catch {}
  });
  const refreshCmd = window.zion.commands.registerCommand("terminal.refreshSessions", async () => {
    try {
      return await refreshSessions();
    } catch (e) {
      return `terminal.refreshSessions error: ${e?.message || String(e)}`;
    }
  });
  const createCmd = window.zion.commands.registerCommand("terminal.createSession", async (args) => {
    try {
      return await createSession(args);
    } catch (e) {
      return `terminal.createSession error: ${e?.message || String(e)}`;
    }
  });
  const closeSessionCmd = window.zion.commands.registerCommand("terminal.closeSession", async (args) => {
    const sid = typeof args === "string" ? args : args?.session_id;
    try {
      return await closeSession(sid);
    } catch (e) {
      return `terminal.closeSession error: ${e?.message || String(e)}`;
    }
  });
  const setActiveCmd = window.zion.commands.registerCommand("terminal.setActiveSession", (args) => {
    const sid = typeof args === "string" ? args : args?.session_id;
    const sessionId = String(sid || "").trim();
    if (!sessionId) return false;
    window.zion?.state?.set("terminal.activeSessionId", sessionId);
    return true;
  });
  const setCwdCmd = window.zion.commands.registerCommand("terminal.setSessionCwd", async (args) => {
    const sid = typeof args === "object" ? args?.session_id : undefined;
    const cwd = typeof args === "object" ? args?.cwd : undefined;
    try {
      return await setSessionCwd(sid, cwd);
    } catch (e) {
      return `terminal.setSessionCwd error: ${e?.message || String(e)}`;
    }
  });
  const toggleContextCmd = window.zion.commands.registerCommand("terminal.toggleChatContext", () => {
    const cur = window.zion?.state?.get("chat.includeTerminalContext");
    const enabled = cur !== false;
    window.zion?.state?.set("chat.includeTerminalContext", !enabled);
    return !enabled;
  });
  ctx.subscriptions.push(openCmd, closeCmd, refreshCmd, createCmd, closeSessionCmd, setActiveCmd, setCwdCmd, toggleContextCmd);

  try {
    const dispItem = window.zion.activityBar.registerItem({
      id: "terminal.activity",
      pluginId: "dev.terminal-manager",
      icon: "$(remote)",
      tooltip: "Terminal",
      tooltipKey: "dev.terminal-manager.ui.terminal",
      sideBarViewId: "terminal.manager",
      order: 30
    });
    const dispView = window.zion.sideBar.registerView({
      id: "terminal.manager",
      pluginId: "dev.terminal-manager",
      title: "Terminal",
      titleKey: "dev.terminal-manager.ui.terminal",
      icon: "$(terminal)",
      order: 30,
      location: "sidebar",
      headerActions: [
        {
          id: "terminal.refresh",
          title: "Refresh sessions",
          titleKey: "dev.terminal-manager.ui.refresh",
          ariaLabel: "Refresh sessions",
          ariaLabelKey: "dev.terminal-manager.ui.refresh",
          icon: "$(loading)",
          onClick: () => {
            try {
              window.zion.commands.executeCommand("terminal.refreshSessions");
            } catch {}
          }
        }
      ],
      component: {
        render: (container) => mountTerminalManagerSidebarViewInto(container)
      }
    });
    ctx.subscriptions.push(dispItem, dispView);
  } catch {}



  // 启动时同步一次会话列表，确保“注入终端上下文”时能拿到全部会话
  (async () => {
    try {
      await refreshSessions();
    } catch {}
  })();

  // Register slash commands
  try {
    const getSessionOptions = async () => {
      const sessions = await ensureSessions();
      return (sessions || [])
        .map(s => String(s?.id || "").trim())
        .filter(Boolean)
        .map(id => ({ value: id, label: id }));
    };

    const buildSessionItems = async (opts) => {
      const mode = String(opts?.mode || "active");
      const sessions = await ensureSessions();
      const activeId = window.zion?.state?.get("terminal.activeSessionId") || null;
      const list = Array.isArray(sessions) ? sessions : [];

      if (!list.length) {
        return [
          {
            title: "No sessions",
            description: "先创建或刷新会话",
            icon: "$(info)",
            execute: () => window.zion.commands.executeCommand("terminal.openManager")
          }
        ];
      }

      return list
        .map((s) => {
          const id = String(s?.id || "").trim();
          if (!id) return null;
          const isActive = !!(activeId && id === activeId);
          const cwd = String(s?.cwd || "").trim();
          const title = isActive ? `${id} (active)` : id;
          const description = cwd ? `CWD: ${cwd}` : "";
          return {
            title,
            description,
            icon: mode === "close" ? "$(trash)" : (isActive ? "$(check)" : "$(terminal)"),
            execute: async () => {
              if (mode === "close") {
                await window.zion.commands.executeCommand("terminal.closeSession", { session_id: id });
                return;
              }
              await window.zion.commands.executeCommand("terminal.setActiveSession", { session_id: id });
            }
          };
        })
        .filter(Boolean);
    };

    const dMenu = window.zion.slash?.registerCommand?.({
      id: "terminal.menu",
      trigger: ["terminal", "term", "terminals"],
      title: "Terminal",
      description: "创建/切换/关闭会话，设置 CWD，以及打开管理器",
      category: "terminal",
      icon: "$(terminal)",
      priority: 110,
      submenu: async () => {
        const include = window.zion?.state?.get("chat.includeTerminalContext");
        const enabled = include !== false;
        return [
          {
            title: "打开终端管理器",
            description: "打开终端会话管理面板",
            icon: "$(window)",
            execute: () => window.zion.commands.executeCommand("terminal.openManager")
          },
          {
            title: "刷新会话列表",
            description: "从本地 tools 服务同步 sessions",
            icon: "$(loading)",
            execute: async () => {
              await window.zion.commands.executeCommand("terminal.refreshSessions");
            }
          },
          {
            title: "创建会话",
            description: "创建本地或 SSH 终端会话",
            icon: "$(add)",
            submenu: async () => [
              {
                title: "创建本地会话",
                description: "local session",
                icon: "$(terminal)",
                params: [
                  { name: "initial_cwd", type: "string", label: "Initial CWD", placeholder: "/" }
                ],
                execute: async (params) => {
                  await window.zion.commands.executeCommand("terminal.createSession", {
                    type: "local",
                    initial_cwd: params?.initial_cwd
                  });
                }
              },
              {
                title: "创建 SSH 会话",
                description: "ssh session",
                icon: "$(remote)",
                params: [
                  { name: "ssh_host", type: "string", label: "SSH Host", placeholder: "example.com" },
                  { name: "ssh_user", type: "string", label: "SSH User", placeholder: "root" },
                  { name: "ssh_port", type: "number", label: "SSH Port", placeholder: "22", default: 22, min: 1, max: 65535 },
                  { name: "initial_cwd", type: "string", label: "Initial CWD", placeholder: "/" }
                ],
                execute: async (params) => {
                  await window.zion.commands.executeCommand("terminal.createSession", {
                    type: "ssh",
                    ssh_host: params?.ssh_host,
                    ssh_user: params?.ssh_user,
                    ssh_port: params?.ssh_port,
                    initial_cwd: params?.initial_cwd
                  });
                }
              }
            ]
          },
          {
            title: "会话操作",
            description: "设置 Active / 关闭 / 设置 CWD",
            icon: "$(list-tree)",
            submenu: async () => [
              {
                title: "设为 Active",
                description: "切换当前 active session",
                icon: "$(check)",
                submenu: async () => await buildSessionItems({ mode: "active" }),
                execute: async () => {
                  const activeId = window.zion?.state?.get("terminal.activeSessionId") || null;
                  if (activeId) return;
                  const list = await ensureSessions();
                  const first = Array.isArray(list) ? list.find(s => String(s?.id || "").trim()) : null;
                  const id = String(first?.id || "").trim();
                  if (id) await window.zion.commands.executeCommand("terminal.setActiveSession", { session_id: id });
                }
              },
              {
                title: "关闭会话",
                description: "关闭并移除 session",
                icon: "$(trash)",
                submenu: async () => await buildSessionItems({ mode: "close" }),
                execute: async () => {
                  const list = await ensureSessions();
                  const first = Array.isArray(list) ? list.find(s => String(s?.id || "").trim()) : null;
                  const id = String(first?.id || "").trim();
                  if (id) await window.zion.commands.executeCommand("terminal.closeSession", { session_id: id });
                }
              },
              {
                title: "设置 CWD",
                description: "对指定 session 执行 cd",
                icon: "$(folder)",
                params: [
                  {
                    name: "session_id",
                    type: "select",
                    label: "Session",
                    asyncOptions: async () => await getSessionOptions()
                  },
                  { name: "cwd", type: "string", label: "CWD", placeholder: "/" }
                ],
                execute: async (params) => {
                  await window.zion.commands.executeCommand("terminal.setSessionCwd", {
                    session_id: params?.session_id,
                    cwd: params?.cwd
                  });
                }
              }
            ]
          },
          {
            title: enabled ? "关闭对话注入终端上下文" : "开启对话注入终端上下文",
            description: "chat.includeTerminalContext",
            icon: "$(zap)",
            execute: () => {
              window.zion.commands.executeCommand("terminal.toggleChatContext");
            }
          }
        ];
      },
      execute: () => window.zion.commands.executeCommand("terminal.openManager")
    });
    if (dMenu) ctx.subscriptions.push(dMenu);

    const slashCommands = [
      {
        id: "terminal.openManager",
        triggers: ["terminal-open", "term-open", "open-terminal"],
        title: "打开终端管理器",
        description: "打开终端会话管理面板",
        priority: 100
      },
      {
        id: "terminal.closeManager",
        triggers: ["terminal-close", "term-close", "close-terminal", "close-term"],
        title: "关闭终端管理器",
        description: "关闭终端会话管理面板",
        priority: 90
      },
      {
        id: "terminal.refreshSessions",
        triggers: ["terminal-refresh", "term-refresh", "terminal-list"],
        title: "刷新终端会话列表",
        description: "同步 sessions 到状态总线",
        priority: 80
      },
      {
        id: "terminal.createSession",
        triggers: ["terminal-create", "term-create", "terminal-new"],
        title: "创建终端会话",
        description: "创建本地或 SSH session",
        priority: 70,
        params: [
          {
            name: "type",
            type: "select",
            label: "Type",
            options: [
              { value: "local", label: "local" },
              { value: "ssh", label: "ssh" }
            ],
            default: "local"
          },
          { name: "initial_cwd", type: "string", label: "Initial CWD", placeholder: "/" },
          { name: "ssh_host", type: "string", label: "SSH Host", placeholder: "example.com" },
          { name: "ssh_user", type: "string", label: "SSH User", placeholder: "root" },
          { name: "ssh_port", type: "number", label: "SSH Port", placeholder: "22", default: 22, min: 1, max: 65535 }
        ],
        execute: (params) => window.zion.commands.executeCommand("terminal.createSession", params)
      },
      {
        id: "terminal.setActiveSession",
        triggers: ["terminal-active", "term-active"],
        title: "设置 Active Session",
        description: "切换当前 active session",
        priority: 60,
        submenu: async () => await buildSessionItems({ mode: "active" }),
        execute: async () => {
          const activeId = window.zion?.state?.get("terminal.activeSessionId") || null;
          if (activeId) return;
          const list = await ensureSessions();
          const first = Array.isArray(list) ? list.find(s => String(s?.id || "").trim()) : null;
          const id = String(first?.id || "").trim();
          if (id) await window.zion.commands.executeCommand("terminal.setActiveSession", { session_id: id });
        }
      },
      {
        id: "terminal.closeSession",
        triggers: ["terminal-close-session", "term-close-session"],
        title: "关闭终端会话",
        description: "关闭并移除 session",
        priority: 50,
        submenu: async () => await buildSessionItems({ mode: "close" }),
        execute: async () => {
          const list = await ensureSessions();
          const first = Array.isArray(list) ? list.find(s => String(s?.id || "").trim()) : null;
          const id = String(first?.id || "").trim();
          if (id) await window.zion.commands.executeCommand("terminal.closeSession", { session_id: id });
        }
      },
      {
        id: "terminal.setSessionCwd",
        triggers: ["terminal-cwd", "term-cwd"],
        title: "设置终端会话 CWD",
        description: "对指定 session 执行 cd",
        priority: 40,
        params: [
          {
            name: "session_id",
            type: "select",
            label: "Session",
            asyncOptions: async () => await getSessionOptions()
          },
          { name: "cwd", type: "string", label: "CWD", placeholder: "/" }
        ],
        execute: (params) => window.zion.commands.executeCommand("terminal.setSessionCwd", params)
      },
      {
        id: "terminal.toggleChatContext",
        triggers: ["terminal-context", "term-context"],
        title: "切换对话注入终端上下文",
        description: "chat.includeTerminalContext",
        priority: 30
      }
    ];

    slashCommands.forEach(cmd => {
      const d = window.zion.slash?.registerCommand?.({
        id: cmd.id,
        trigger: cmd.triggers,
        title: cmd.title,
        description: cmd.description,
        category: "terminal",
        icon: "$(terminal)",
        priority: cmd.priority,
        submenu: cmd.submenu,
        params: cmd.params,
        execute: (params) => {
          window.zion.commands.executeCommand(cmd.id, params);
        }
      });
      if (d) ctx.subscriptions.push(d);
    });
  } catch (e) {
    console.error("[dev.terminal-manager] Error registering slash commands:", e);
  }
}
