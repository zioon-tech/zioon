const pluginId = "dev.agent-device-cloud";
const text = (en, zh) => navigator.language.startsWith("zh") ? zh : en;
const serviceOrigin = "https://adc.zioon.tech";

export async function activate(context) {
  const zion = window.zion;
  const disposables = context.subscriptions ?? [];
  const requests = new Set();
  let container, statusItem, disposed = false, generation = 0, busy = "";
  let state = { connected: false, devices: [], tasks: [], links: {
    devices: `${serviceOrigin}/devices`, access: `${serviceOrigin}/access`, approvals: `${serviceOrigin}/approvals`
  } };

  const runtimeUrl = () => {
    if ((zion.state?.get?.("runtime.mode") ?? localStorage.getItem("zion.runtime.mode")) === "browser") {
      throw new Error(text("Connect Zion Runtime first.", "请先连接 Zion Runtime。"));
    }
    return String(zion.state?.get?.("runtime.baseUrl") || localStorage.getItem("zion.runtime.baseUrl")
      || location.origin).replace(/\/+$/, "");
  };
  const command = async (args) => {
    const controller = new AbortController();
    requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 50000);
    try {
      const response = await fetch(`${runtimeUrl()}/v1/plugins/${pluginId}/commands`, {
        method: "POST", credentials: "include", redirect: "error",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(args)
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error || text("ADC request failed.", `ADC 请求失败（${response.status}）。`));
      return value.result;
    } finally { clearTimeout(timer); requests.delete(controller); }
  };
  const element = (tag, value) => {
    const node = document.createElement(tag);
    if (value) node.textContent = value;
    return node;
  };
  const showError = (error) => {
    state = { ...state, message: error?.message || String(error), error: true };
    render();
  };
  const link = (parent, label, href) => {
    const anchor = element("a", label);
    anchor.href = href; anchor.target = "_blank"; anchor.rel = "noopener noreferrer";
    parent.append(anchor);
  };
  const refresh = async () => {
    const current = ++generation;
    try {
      const value = await command({ action: "status" });
      if (disposed || busy || current !== generation) return;
      state = { ...value, links: value.links || state.links };
    } catch (error) {
      if (disposed || busy || current !== generation) return;
      state = { ...state, message: error.message, error: true };
    }
    render();
    statusItem?.dispose?.();
    statusItem = zion.bottomStatusBar?.registerItem?.({
      id: "adc.status", text: state.connected ? "ADC" : text("ADC · connect", "ADC · 待连接"),
      tooltip: text("ADC devices and tasks", "ADC 设备与任务"), priority: 55,
      onClick: () => zion.sideBar?.showView?.("adc.devices")
    });
  };
  const action = async (name, operation) => {
    if (busy) return;
    generation++;
    busy = name;
    state = { ...state, message: name === "connect"
      ? text("Preparing ADC sign-in…", "正在准备 ADC 登录…") : text("Working…", "正在处理…"), error: false };
    render();
    try { await operation(); }
    catch (error) { showError(error); }
    finally { busy = ""; if (!disposed) render(); }
  };
  const button = (parent, label, name, operation) => {
    const node = element("button", label);
    node.type = "button"; node.disabled = Boolean(busy);
    node.onclick = () => action(name, operation);
    parent.append(node);
  };
  const connect = async () => {
    const redirect = new URL(location.href);
    redirect.search = ""; redirect.hash = "";
    const value = await command({ action: "connect", redirectUri: redirect.href });
    const destination = new URL(value.authorizeUrl);
    if (destination.origin !== serviceOrigin || destination.pathname !== "/api/auth/oauth2/authorize") {
      throw new Error(text("ADC returned an invalid sign-in URL.", "ADC 返回了无效的登录地址。"));
    }
    state = { ...state, message: text("Opening ADC sign-in…", "正在打开 ADC 登录页…"),
      authorizeUrl: destination.href, error: false };
    render();
    location.assign(destination.href);
  };
  function render() {
    if (!container || disposed) return;
    container.replaceChildren();
    container.classList.add("adc-sidebar");
    const header = element("header");
    header.append(element("strong", "ADC"), element("span", state.connected
      ? text("Connected", "已连接") : text("Connection required", "待连接")));
    container.append(header);
    if (state.message) {
      const notice = element("p", state.message);
      notice.setAttribute("role", state.error ? "alert" : "status");
      container.append(notice);
    }
    if (state.authorizeUrl) {
      const fallback = element("a", text("Continue to ADC sign-in", "继续前往 ADC 登录"));
      fallback.href = state.authorizeUrl;
      container.append(fallback);
    }
    const controls = element("nav");
    if (state.connected) button(controls, text("Disconnect", "断开连接"), "disconnect", async () => {
      await command({ action: "disconnect" });
      busy = ""; await refresh();
    });
    else button(controls, busy === "connect" ? text("Connecting…", "正在连接…") : text("Connect ADC", "连接 ADC"), "connect", connect);
    button(controls, text("Refresh", "刷新"), "refresh", async () => { busy = ""; await refresh(); });
    container.append(controls);
    if (state.connected) {
      container.append(element("p", state.access || "ADC"));
      const label = element("label", text("Device", "设备"));
      const select = element("select");
      select.setAttribute("aria-label", text("Choose device", "选择设备"));
      select.disabled = Boolean(busy);
      const empty = element("option", text("Choose device", "选择设备")); empty.value = ""; select.append(empty);
      for (const device of state.devices || []) {
        const option = element("option", `${device.label} · ${device.platform} · ${device.online ? text("online", "在线") : text("offline", "离线")}`);
        option.value = device.nodeId; select.append(option);
      }
      select.value = state.selectedNodeId || "";
      select.onchange = () => select.value && action("select", async () => {
        await command({ action: "select", nodeId: select.value });
        busy = ""; await refresh();
      });
      label.append(select); container.append(label);
      const device = state.devices?.find((item) => item.nodeId === state.selectedNodeId);
      if (device) {
        const roots = element("ul");
        for (const root of device.roots || []) roots.append(element("li", root.path || root.label || root.rootId));
        if (roots.childElementCount) container.append(roots);
      }
      if (!state.devices?.length) container.append(element("p", text(
        "No authorized devices. Update this connection's access.", "尚未授权设备，请更新此连接的授权。")));
    }
    const links = element("nav");
    link(links, text("Set up devices", "接入设备"), state.links.devices);
    link(links, text("Authorization settings", "授权设置"), state.links.access);
    link(links, text("Review approvals", "查看审批"), state.links.approvals);
    container.append(links, element("h3", text("Tasks", "任务")));
    if (!state.tasks?.length) container.append(element("p", text("No ADC tasks in this connection.", "此连接暂无 ADC 任务。")));
    for (const task of state.tasks || []) {
      const detail = element("details");
      detail.append(element("summary", `${task.status} · ${task.jobId || task.invocationId}`));
      if (task.reviewUrl) link(detail, text("Review approval", "审批此操作"), task.reviewUrl);
      detail.append(element("pre", JSON.stringify(task.receipt || task.output || task.error || {}, null, 2)));
      container.append(detail);
    }
  }
  disposables.push(zion.sideBar.registerView({
    id: "adc.devices", pluginId, title: "ADC", icon: "$(remote)", order: 45, location: "sidebar",
    component: { render(node) { container = node; render(); void refresh(); } }
  }));
  disposables.push(zion.activityBar.registerItem({
    id: "adc.activity", pluginId, icon: "$(remote)", tooltip: "ADC", sideBarViewId: "adc.devices", order: 45
  }));
  disposables.push(zion.commands.registerCommand("adc.refresh", refresh));
  disposables.push(zion.commands.registerCommand("adc.open", () => zion.sideBar?.showView?.("adc.devices")));
  for (const name of ["sessions/changed", "chat/runFinished", "runtime/sessionRunEvent"]) {
    disposables.push(zion.events?.on?.(name, () => { if (!busy) void refresh(); }));
  }
  const focused = () => { if (!busy) void refresh(); };
  window.addEventListener("focus", focused);
  disposables.push({ dispose() {
    disposed = true;
    requests.forEach((request) => request.abort());
    statusItem?.dispose?.(); container?.replaceChildren();
    window.removeEventListener("focus", focused);
  } });
  const callback = new URL(location.href);
  if (callback.searchParams.get("state")?.startsWith("adc_")
    && (callback.searchParams.has("code") || callback.searchParams.has("error"))) {
    const code = callback.searchParams.get("code"), state_ = callback.searchParams.get("state");
    for (const name of ["code", "state", "error", "error_description", "iss"]) callback.searchParams.delete(name);
    history.replaceState(null, "", callback.href);
    try {
      if (!code) throw new Error(text("ADC sign-in was cancelled.", "ADC 登录已取消。"));
      await command({ action: "finish", code, state: state_ });
    } catch (error) {
      showError(error);
      return {};
    }
  }
  void refresh();
  return {};
}
