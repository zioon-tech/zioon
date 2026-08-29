import { buildTerminalInventory } from "./terminal-inventory.js";
import {
  closeTerminalSession,
  createTerminalSession,
  listTerminalSessions,
  reactivateTerminalSession,
  setTerminalSessionCwd,
  updateTerminalMachine
} from "./terminal-service.js";

function t(key, fallback, values) {
  const fullKey = `dev.terminal-manager.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

function icon(name) {
  const element = document.createElement("span");
  element.className = `codicon codicon-${name}`;
  element.setAttribute("aria-hidden", "true");
  return element;
}

function iconButton(name, label, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `zion-terminal-manager-icon-button ${className}`.trim();
  button.title = label;
  button.setAttribute("aria-label", label);
  button.appendChild(icon(name));
  return button;
}

function formatLastActivity(timestamp) {
  if (!timestamp) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return t("ui.justNow", "刚刚");
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function machineIcon(machine) {
  return machine.kind === "ssh" ? "remote" : "device-desktop";
}

function sessionHaystack(session, machine, workspace) {
  return [
    session?.id,
    session?.cwd,
    session?.ssh_host,
    session?.ssh_user,
    machine?.name,
    workspace?.name,
    workspace?.root
  ].map((value) => String(value || "").toLowerCase()).join("\n");
}

export function mountTerminalManagerSidebarViewInto(container) {
  const root = document.createElement("div");
  root.className = "zion-terminal-manager-sidebar";

  const toolbar = document.createElement("div");
  toolbar.className = "zion-terminal-manager-toolbar";
  const searchWrap = document.createElement("label");
  searchWrap.className = "zion-terminal-manager-search";
  searchWrap.appendChild(icon("search"));
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = t("ui.searchSessions", "搜索机器、项目或终端");
  searchInput.setAttribute("aria-label", searchInput.placeholder);
  searchWrap.appendChild(searchInput);
  const createToggle = iconButton("add", t("ui.newTerminal", "新建终端"));
  const refreshButton = iconButton("refresh", t("ui.refresh", "刷新"));
  toolbar.appendChild(searchWrap);
  toolbar.appendChild(createToggle);
  toolbar.appendChild(refreshButton);

  const summary = document.createElement("div");
  summary.className = "zion-terminal-manager-summary";
  summary.textContent = t("ui.loading", "正在读取会话...");

  const form = document.createElement("div");
  form.className = "zion-terminal-manager-form";
  let formVisible = false;

  const field = (label, type = "text", placeholder = "") => {
    const wrapper = document.createElement("label");
    wrapper.className = "zion-terminal-manager-field";
    const title = document.createElement("span");
    title.textContent = label;
    const input = document.createElement("input");
    input.type = type;
    input.placeholder = placeholder;
    wrapper.append(title, input);
    return { wrapper, input };
  };

  const typeField = document.createElement("label");
  typeField.className = "zion-terminal-manager-field";
  const typeLabel = document.createElement("span");
  typeLabel.textContent = t("ui.type", "类型");
  const typeSelect = document.createElement("select");
  for (const type of ["local", "ssh"]) {
    const option = document.createElement("option");
    option.value = type;
    option.textContent = type;
    typeSelect.appendChild(option);
  }
  typeField.append(typeLabel, typeSelect);

  const cwdField = field(t("ui.initialCwd", "初始工作目录"), "text", "/");
  const sshHostField = field(t("ui.sshHost", "SSH 主机（或别名）"), "text", "example.com");
  const sshUserField = field(t("ui.sshUser", "SSH 用户"), "text", "root");
  const sshPortField = field(t("ui.sshPort", "SSH 端口"), "number", "22");
  const formActions = document.createElement("div");
  formActions.className = "zion-terminal-manager-form-actions";
  const submitButton = document.createElement("button");
  submitButton.type = "button";
  submitButton.className = "zion-terminal-manager-button is-primary";
  submitButton.textContent = t("ui.create", "创建终端");
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "zion-terminal-manager-button";
  cancelButton.textContent = t("ui.cancel", "取消");
  formActions.append(cancelButton, submitButton);
  form.append(
    typeField,
    cwdField.wrapper,
    sshHostField.wrapper,
    sshUserField.wrapper,
    sshPortField.wrapper,
    formActions
  );

  const message = document.createElement("div");
  message.className = "zion-terminal-manager-message";
  const list = document.createElement("div");
  list.className = "zion-terminal-manager-list";

  root.append(toolbar, summary, form, message, list);
  container.appendChild(root);

  const expandedMachines = new Set();
  const expandedWorkspaces = new Set();
  let expandedActions = "";
  let currentSessions = [];

  function showMessage(value, error = false) {
    message.textContent = String(value || "");
    message.classList.toggle("is-error", error);
    message.hidden = !value;
  }

  function syncForm() {
    form.hidden = !formVisible;
    const ssh = typeSelect.value === "ssh";
    sshHostField.wrapper.hidden = !ssh;
    sshUserField.wrapper.hidden = !ssh;
    sshPortField.wrapper.hidden = !ssh;
  }

  function openCreate(machine = null, workspace = null) {
    formVisible = true;
    typeSelect.value = machine?.kind === "ssh" ? "ssh" : "local";
    cwdField.input.value = workspace?.root || "";
    sshHostField.input.value = machine?.connection?.host || "";
    sshUserField.input.value = machine?.connection?.user || "";
    sshPortField.input.value = machine?.connection?.port || "22";
    syncForm();
    cwdField.input.focus();
  }

  function renderActions(kind, machine, workspace, session) {
    const actions = document.createElement("div");
    actions.className = "zion-terminal-manager-inline-actions";
    if (kind === "machine" || kind === "workspace") {
      const createButton = document.createElement("button");
      createButton.type = "button";
      createButton.className = "zion-terminal-manager-button";
      createButton.textContent = t("ui.newTerminal", "新建终端");
      createButton.addEventListener("click", () => openCreate(machine, workspace));
      actions.appendChild(createButton);
      if (kind === "machine") {
        const nameField = field(t("ui.machineName", "机器名称"));
        nameField.input.value = machine.name || "";

        const descriptionField = document.createElement("label");
        descriptionField.className = "zion-terminal-manager-field";
        const descriptionLabel = document.createElement("span");
        descriptionLabel.textContent = t("ui.machineDescription", "机器描述");
        const descriptionInput = document.createElement("textarea");
        descriptionInput.maxLength = 500;
        descriptionInput.rows = 4;
        descriptionInput.value = machine.description || "";
        descriptionField.append(descriptionLabel, descriptionInput);

        const saveButton = document.createElement("button");
        saveButton.type = "button";
        saveButton.className = "zion-terminal-manager-button is-primary";
        saveButton.textContent = t("ui.saveMachine", "保存机器信息");
        saveButton.addEventListener("click", async () => {
          try {
            await updateTerminalMachine(machine.id, {
              name: nameField.input.value,
              description: descriptionInput.value
            });
            expandedActions = "";
            showMessage(t("msg.machineUpdated", "已更新机器信息。"));
          } catch (error) {
            showMessage(error?.message || String(error), true);
          }
        });
        actions.append(nameField.wrapper, descriptionField, saveButton);
      }
      return actions;
    }

    const cwdInput = document.createElement("input");
    cwdInput.type = "text";
    cwdInput.value = session.cwd || "";
    cwdInput.placeholder = t("ui.cwd", "工作目录");
    const cwdButton = iconButton("check", t("ui.updateCwd", "更新目录"));
    cwdButton.addEventListener("click", async () => {
      try {
        await setTerminalSessionCwd(session.id, cwdInput.value);
        showMessage(t("msg.cwdUpdated", "已更新工作目录。"));
      } catch (error) {
        showMessage(error?.message || String(error), true);
      }
    });
    const cwdRow = document.createElement("div");
    cwdRow.className = "zion-terminal-manager-cwd";
    cwdRow.append(cwdInput, cwdButton);
    actions.appendChild(cwdRow);

    if (session.connectionStatus === "disconnected" && session.type === "ssh") {
      const reconnect = document.createElement("button");
      reconnect.type = "button";
      reconnect.className = "zion-terminal-manager-button";
      reconnect.textContent = t("ui.reconnect", "重新连接");
      reconnect.addEventListener("click", async () => {
        try {
          await reactivateTerminalSession(session.id);
          showMessage(t("msg.reconnected", "已重新连接终端会话。"));
        } catch (error) {
          showMessage(error?.message || String(error), true);
        }
      });
      actions.appendChild(reconnect);
    }

    const close = document.createElement("button");
    close.type = "button";
    close.className = "zion-terminal-manager-button is-danger";
    close.textContent = t("ui.closeSession", "关闭会话");
    close.addEventListener("click", async () => {
      try {
        await closeTerminalSession(session.id);
        expandedActions = "";
        showMessage(t("msg.closed", "已关闭终端会话。"));
      } catch (error) {
        showMessage(error?.message || String(error), true);
      }
    });
    actions.appendChild(close);
    return actions;
  }

  function makeTreeRow({
    level,
    iconName,
    title,
    tooltip,
    meta,
    availableCount,
    disconnectedCount,
    expanded,
    active,
    disconnected,
    onOpen,
    actionKey,
    actionArgs
  }) {
    const wrapper = document.createElement("div");
    wrapper.className = "zion-terminal-manager-tree-item";
    wrapper.dataset.level = String(level);
    wrapper.dataset.kind = actionArgs[0];
    wrapper.classList.toggle("is-active", Boolean(active));
    wrapper.classList.toggle("is-disconnected", Boolean(disconnected));

    const row = document.createElement("div");
    row.className = "zion-terminal-manager-tree-row";
    const main = document.createElement("button");
    main.type = "button";
    main.className = "zion-terminal-manager-tree-main";
    main.title = tooltip || title;
    main.style.setProperty("--tree-level", String(level));
    if (typeof expanded === "boolean") main.appendChild(icon(expanded ? "chevron-down" : "chevron-right"));
    else main.appendChild(icon(active ? "circle-filled" : iconName));
    if (typeof expanded === "boolean") main.appendChild(icon(iconName));
    const content = document.createElement("span");
    content.className = "zion-terminal-manager-tree-content";
    const titleElement = document.createElement("span");
    titleElement.className = "zion-terminal-manager-tree-title";
    titleElement.textContent = title;
    content.appendChild(titleElement);
    if (meta) {
      const metaElement = document.createElement("span");
      metaElement.className = "zion-terminal-manager-tree-meta";
      metaElement.textContent = meta;
      content.appendChild(metaElement);
    }
    main.appendChild(content);
    if (availableCount != null) {
      const counts = document.createElement("span");
      counts.className = "zion-terminal-manager-status-counts";
      counts.title = `${t("ui.available", "可用")} ${availableCount} · ${t("ui.disconnected", "已断开")} ${disconnectedCount || 0}`;
      const availableElement = document.createElement("span");
      availableElement.className = "is-available";
      availableElement.textContent = String(availableCount);
      counts.appendChild(availableElement);
      if (disconnectedCount > 0) {
        const disconnectedElement = document.createElement("span");
        disconnectedElement.className = "is-disconnected";
        disconnectedElement.textContent = String(disconnectedCount);
        counts.appendChild(disconnectedElement);
      }
      main.appendChild(counts);
    }
    main.addEventListener("click", onOpen);

    const more = iconButton("ellipsis", t("ui.more", "更多"), "zion-terminal-manager-more");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      expandedActions = expandedActions === actionKey ? "" : actionKey;
      render();
    });
    row.append(main, more);
    wrapper.appendChild(row);
    if (expandedActions === actionKey) {
      wrapper.appendChild(renderActions(...actionArgs));
    }
    return wrapper;
  }

  function render() {
    const machineProfiles = window.zion?.state?.get?.("terminal.machineProfiles");
    const inventory = buildTerminalInventory(currentSessions, {
      machineProfiles: Array.isArray(machineProfiles) ? machineProfiles : []
    });
    const query = searchInput.value.trim().toLowerCase();
    const activeSessionId = String(window.zion?.state?.get?.("terminal.activeSessionId") || "");
    list.replaceChildren();
    const availableCount = inventory.sessions.filter((session) => session.connectionStatus === "connected").length;
    const disconnectedCount = inventory.sessions.length - availableCount;
    summary.textContent = `${inventory.machines.length} ${t("ui.machinesUnit", "台机器")} · ${availableCount} ${t("ui.available", "可用")} · ${disconnectedCount} ${t("ui.disconnected", "已断开")}`;

    if (!inventory.machines.length) {
      const empty = document.createElement("div");
      empty.className = "zion-terminal-manager-empty";
      empty.textContent = t("ui.noSessions", "还没有终端会话。");
      list.appendChild(empty);
      return;
    }

    const workspaceById = new Map(inventory.workspaces.map((workspace) => [workspace.id, workspace]));
    const machineById = new Map(inventory.machines.map((machine) => [machine.id, machine]));
    const sessionsByWorkspace = new Map();
    for (const session of inventory.sessions) {
      if (!sessionsByWorkspace.has(session.workspaceId)) sessionsByWorkspace.set(session.workspaceId, []);
      sessionsByWorkspace.get(session.workspaceId).push(session);
    }

    let visibleMachines = 0;
    for (const machine of inventory.machines) {
      const machineWorkspaces = inventory.workspaces.filter((workspace) => workspace.machineId === machine.id);
      const matchingWorkspaces = machineWorkspaces.filter((workspace) => {
        if (!query) return true;
        if (`${machine.name}\n${workspace.name}\n${workspace.root}`.toLowerCase().includes(query)) return true;
        return (sessionsByWorkspace.get(workspace.id) || []).some((session) => (
          sessionHaystack(session, machine, workspace).includes(query)
        ));
      });
      if (query && !matchingWorkspaces.length) continue;
      visibleMachines += 1;
      const machineExpanded = query ? true : expandedMachines.has(machine.id);
      list.appendChild(makeTreeRow({
        level: 0,
        iconName: machineIcon(machine),
        title: machine.name,
        tooltip: `${machine.connection?.user ? `${machine.connection.user}@` : ""}${machine.name} · ${machine.workspaceCount} ${t("ui.workspacesUnit", "个项目")} · ${machine.sessionCount} ${t("ui.sessionsUnit", "个会话")}`,
        meta: "",
        availableCount: machine.availableSessionCount,
        disconnectedCount: machine.disconnectedSessionCount,
        expanded: machineExpanded,
        disconnected: machine.availableSessionCount === 0,
        onOpen: () => {
          if (expandedMachines.has(machine.id)) expandedMachines.delete(machine.id);
          else expandedMachines.add(machine.id);
          render();
        },
        actionKey: `machine:${machine.id}`,
        actionArgs: ["machine", machine, null, null]
      }));
      if (!machineExpanded) continue;

      for (const workspace of matchingWorkspaces) {
        const workspaceSessions = sessionsByWorkspace.get(workspace.id) || [];
        const workspaceExpanded = query ? true : expandedWorkspaces.has(workspace.id);
        list.appendChild(makeTreeRow({
          level: 1,
          iconName: "folder",
          title: workspace.name,
          tooltip: workspace.root || workspace.name,
          meta: "",
          availableCount: workspace.availableSessionCount,
          disconnectedCount: workspace.disconnectedSessionCount,
          expanded: workspaceExpanded,
          disconnected: workspace.availableSessionCount === 0,
          onOpen: () => {
            if (expandedWorkspaces.has(workspace.id)) expandedWorkspaces.delete(workspace.id);
            else expandedWorkspaces.add(workspace.id);
            render();
          },
          actionKey: `workspace:${workspace.id}`,
          actionArgs: ["workspace", machine, workspace, null]
        }));
        if (!workspaceExpanded) continue;

        for (const session of workspaceSessions) {
          if (query && !sessionHaystack(session, machineById.get(session.machineId), workspaceById.get(session.workspaceId)).includes(query)
            && !`${machine.name}\n${workspace.name}\n${workspace.root}`.toLowerCase().includes(query)) {
            continue;
          }
          list.appendChild(makeTreeRow({
            level: 2,
            iconName: "terminal",
            title: session.id,
            tooltip: `${session.id}${session.cwd ? ` · ${session.cwd}` : ""}`,
            meta: [session.connectionStatus === "disconnected" ? t("ui.disconnected", "已断开") : "", formatLastActivity(session.lastActivityAt)]
              .filter(Boolean).join(" · "),
            availableCount: null,
            active: session.id === activeSessionId,
            disconnected: session.connectionStatus === "disconnected",
            onOpen: () => {
              window.zion?.state?.set?.("terminal.activeSessionId", session.id);
              try { window.zion?.commands?.executeCommand?.("terminal.openPanel"); } catch {}
              render();
            },
            actionKey: `session:${session.id}`,
            actionArgs: ["session", machine, workspace, session]
          }));
        }
      }
    }

    if (!visibleMachines) {
      const empty = document.createElement("div");
      empty.className = "zion-terminal-manager-empty";
      empty.textContent = t("ui.noMatchingSessions", "没有匹配的机器、项目或终端。");
      list.appendChild(empty);
    }
  }

  async function refresh() {
    try {
      showMessage("");
      currentSessions = await listTerminalSessions();
      render();
    } catch (error) {
      showMessage(error?.message || String(error), true);
    }
  }

  createToggle.addEventListener("click", () => {
    formVisible = !formVisible;
    syncForm();
  });
  cancelButton.addEventListener("click", () => {
    formVisible = false;
    syncForm();
  });
  typeSelect.addEventListener("change", syncForm);
  submitButton.addEventListener("click", async () => {
    try {
      await createTerminalSession({
        type: typeSelect.value,
        initial_cwd: cwdField.input.value,
        ssh_host: sshHostField.input.value,
        ssh_user: sshUserField.input.value,
        ssh_port: sshPortField.input.value
      });
      formVisible = false;
      syncForm();
      showMessage(t("msg.created", "终端已创建。"));
    } catch (error) {
      showMessage(error?.message || String(error), true);
    }
  });
  refreshButton.addEventListener("click", refresh);
  searchInput.addEventListener("input", render);

  const sessionsDisposable = window.zion?.state?.onDidChange?.("terminal.sessions", (sessions) => {
    currentSessions = Array.isArray(sessions) ? sessions : [];
    render();
  });
  const profilesDisposable = window.zion?.state?.onDidChange?.("terminal.machineProfiles", render);
  const activeDisposable = window.zion?.state?.onDidChange?.("terminal.activeSessionId", render);

  syncForm();
  void refresh();

  return {
    dispose() {
      try { sessionsDisposable?.dispose?.(); } catch {}
      try { profilesDisposable?.dispose?.(); } catch {}
      try { activeDisposable?.dispose?.(); } catch {}
      root.remove();
    }
  };
}
