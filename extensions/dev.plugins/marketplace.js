import { workbenchStorage as localStorage } from "../../src/runtime/workbench-space.ts";
import { readWorkbenchRuntimeConfig } from "../../src/runtime/workbench-runtime-config.ts";
import { createExtensionsClient } from "../../packages/runtime-client/src/extensions.mjs";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const kindLabel = { skill: "技能", plugin: "代码插件", mcp: "MCP", workbench: "Workbench 插件" };
const statusLabel = { ready: "可用", disabled: "已停用", partially_ready: "部分可用",
  configuration_required: "待设置", connection_required: "待连接服务", validation_required: "已启用", host_required: "等待宿主", draft: "草稿",
  submitted: "待审核", published: "已发布", changes_requested: "待修改" };

export function mountMarketplace(container, { fetchImpl = fetch, baseUrl = readWorkbenchRuntimeConfig().baseUrl,
  pluginManager = window.zion?.plugins } = {}) {
  const root = document.createElement("section");
  root.className = "zion-marketplace";
  root.innerHTML = `<header class="zm-header"><div><span class="zm-eyebrow">ZION / EXTENSIONS</span>
    <h1>扩展市场</h1><p>找到适合你的能力，添加到账户，在工作中使用。</p></div>
    <button type="button" data-action="refresh" aria-label="刷新扩展市场"><span class="codicon codicon-refresh" aria-hidden="true"></span></button></header>
    <nav class="zm-tabs" aria-label="市场视图">
      <button data-tab="discover" class="is-selected" aria-current="page">发现</button>
      <button data-tab="installed">已添加 <span data-count></span></button>
      <button data-tab="private">我的开发</button><button data-tab="contributions">我的贡献</button>
    </nav><div class="zm-message" role="status" aria-live="polite"></div>
    <div class="zm-filters"><input type="search" aria-label="搜索扩展" placeholder="搜索名称、用途或发布者">
      <select aria-label="扩展类型"><option value="">所有类型</option><option value="skill">技能</option><option value="plugin">代码插件</option><option value="mcp">MCP</option></select>
      <select aria-label="用途分类"><option value="">所有用途</option></select></div>
    <div class="zm-content"><div class="zm-list" aria-label="扩展列表"></div><article class="zm-detail" aria-label="扩展详情"></article></div>
    <div class="zm-contributions" hidden></div>`;
  container.replaceChildren(root);
  const q = (selector) => root.querySelector(selector);
  const message = q(".zm-message"), list = q(".zm-list"), detail = q(".zm-detail");
  const search = q('input[type="search"]'), selects = root.querySelectorAll(".zm-filters select");
  let snapshot = { entries: [], contributions: [], categories: [], revision: 0 }, tab = "discover", selectedId = "", busy = false, disposed = false;
  let unsaved = null;
  let executionResult = null;
  let connections = [], connectionError = "";
  const hostErrors = new Map();
  const controller = new AbortController();
  const client = createExtensionsClient({ baseUrl, fetchImpl, credentials: "include", signal: controller.signal });

  function notify(text, error = false) {
    if (disposed) return;
    message.textContent = text;
    message.classList.toggle("is-error", error);
  }
  async function api(path, method = "GET", body) {
    return client.request(path, { method, body });
  }
  async function refresh() {
    const next = await api("snapshot");
    if (disposed) return;
    if (!Array.isArray(next.entries) || !Array.isArray(next.categories) || !Array.isArray(next.contributions)) {
      throw new Error("市场响应不完整，请刷新后重试");
    }
    snapshot = next;
    if (snapshot.entries.some((e) => e.installation && (e.installedRelease || e).artifact && ["plugin", "mcp"].includes(e.kind))) {
      try {
        const result = await client.connections();
        connections = Array.isArray(result.connections) ? result.connections : [];
        connectionError = "";
      } catch (error) { connectionError = error.message; }
    }
    await reconcileBuiltin();
    q("[data-count]").textContent = String(snapshot.entries.filter((entry) => entry.installation).length);
    const previous = selects[1].value;
    selects[1].innerHTML = `<option value="">所有用途</option>${snapshot.categories.map((c) => `<option>${esc(c)}</option>`).join("")}`;
    selects[1].value = previous;
    render();
  }
  async function reconcileBuiltin() {
    if (!pluginManager?.list) return;
    const key = `zion.marketplace.host-cache.${snapshot.accountId}`;
    let claims = {};
    try { claims = JSON.parse(localStorage.getItem(key) || "{}"); } catch {}
    const desired = new Map();
    for (const entry of snapshot.entries.filter((item) => item.installation)) {
      for (const c of (entry.installedRelease || entry).components.filter((item) => item.kind === "workbench")) {
        desired.set(c.pluginId, (desired.get(c.pluginId) || false) || entry.installation.enabled);
      }
    }
    for (const id of new Set([...Object.keys(claims), ...desired.keys()])) {
      // Only platform-listed Workbench components may be activated.
      if (id !== "dev.toc") continue;
      const plugin = pluginManager.list().find((p) => p.id === id);
      if (!plugin) { hostErrors.set(id, "当前 Workbench 没有此内置插件"); continue; }
      if (!(id in claims) && desired.has(id)) claims[id] = plugin.enabled === true;
      const enabled = desired.has(id) ? desired.get(id) : claims[id];
      try {
        if (plugin.enabled !== enabled) {
          if (enabled) await pluginManager.enable(id); else await pluginManager.disable(id);
        }
        hostErrors.delete(id);
        if (!desired.has(id)) delete claims[id];
      } catch (error) { hostErrors.set(id, error.message || "Workbench 激活失败"); }
    }
    try { localStorage.setItem(key, JSON.stringify(claims)); } catch {}
  }
  async function perform(operation, success = "") {
    if (busy || disposed) return;
    busy = true; root.setAttribute("aria-busy", "true");
    root.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try { await operation(); await refresh(); if (success) notify(success); }
    catch (error) {
      if (error.code === "revision_conflict") await refresh().catch(() => {});
      notify(error.message, true);
    } finally {
      busy = false; root.removeAttribute("aria-busy");
      root.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    }
  }
  function render() {
    if (disposed) return;
    root.querySelectorAll("[data-tab]").forEach((button) => {
      const active = button.dataset.tab === tab;
      button.classList.toggle("is-selected", active);
      if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    });
    q(".zm-filters").hidden = tab === "contributions";
    q(".zm-content").hidden = tab === "contributions";
    q(".zm-contributions").hidden = tab !== "contributions";
    if (tab === "contributions") { renderContributions(); return; }
    renderList(); renderDetail();
  }
  function renderList() {
    const query = search.value.trim().toLowerCase();
    const entries = snapshot.entries.filter((entry) =>
      (tab !== "installed" || entry.installation)
      && (tab !== "private" || entry.visibility === "private")
      && (tab !== "discover" || entry.visibility !== "private")
      && (!selects[0].value || entry.kind === selects[0].value)
      && (!selects[1].value || entry.category === selects[1].value)
      && `${entry.name} ${entry.summary} ${entry.publisher.name}`.toLowerCase().includes(query));
    if (!entries.some((entry) => entry.id === selectedId)) selectedId = entries[0]?.id || "";
    list.innerHTML = entries.length ? `<div class="zm-list-caption">${entries.length} 项${tab === "installed" ? "账户扩展" : tab === "private" ? "私有扩展" : "精选扩展"}</div>` + entries.map((entry) =>
      `<button type="button" class="zm-row ${selectedId === entry.id ? "is-selected" : ""}" data-entry="${esc(entry.id)}" aria-pressed="${selectedId === entry.id}">
        <span class="zm-type-mark" aria-hidden="true"><span class="codicon codicon-${entry.kind === "skill" ? "book" : entry.kind === "mcp" ? "plug" : "extensions"}"></span></span>
        <span class="zm-row-copy"><strong>${esc(entry.name)}</strong><span>${esc(entry.summary)}</span>
          <small>${esc(kindLabel[entry.kind])} · ${esc(entry.category)} · ${entry.visibility === "private" ? "仅自己可见" : esc(entry.publisher.name)}</small></span>
        ${entry.installation ? `<span class="zm-state">${esc(statusLabel[entry.installation.status])}</span>` : ""}</button>`).join("")
      : `<div class="zm-empty"><h2>${tab === "private" && !query ? "还没有上传私有扩展" : tab === "installed" && !query ? "还没有添加扩展" : "没有匹配的扩展"}</h2>
        <p>${tab === "private" ? "通过 zion extensions upload 上传 Skill、代码插件或 MCP，然后添加到账户进行测试。" : tab === "installed" ? "从发现页选择一项能力，添加后会跟随你的账户。" : "试试其他关键词或用途分类。"}</p>
        ${tab === "installed" ? '<button data-action="discover">浏览市场</button>' : ""}</div>`;
  }
  function renderDetail() {
    const entry = snapshot.entries.find((entry) => entry.id === selectedId);
    if (!entry) { detail.innerHTML = ""; return; }
    const install = entry.installation;
    const release = entry.installedRelease || entry;
    const statuses = install?.components || [];
    const allBuiltin = (release.components || []).filter((c) => c.kind === "workbench");
    const actual = allBuiltin.map((c) => pluginManager?.list?.().find((p) => p.id === c.pluginId));
    detail.innerHTML = `<div class="zm-detail-heading"><span class="zm-eyebrow">${esc(kindLabel[entry.kind])} / ${esc(entry.category)}</span>
      <h2>${esc(entry.name)}</h2><p>${esc(entry.summary)}</p></div>
      <div class="zm-byline">${esc(entry.publisher.name)}${entry.visibility === "private" ? " · 仅自己可见" : entry.publisher.origin === "official" ? " · 官方精选" : " · 社区贡献"}
        <span>v${esc(install?.version || entry.version)}</span></div>
      ${entry.visibility === "private" ? '<p class="zm-muted">私有开发版本仅在你的账户内使用，尚未公开到市场。</p>' : ""}
      <div class="zm-actions">${install
        ? `<button data-action="toggle">${install.enabled ? "停用" : "启用"}</button><button data-action="remove" class="zm-subtle">卸载</button>`
        : `<button data-action="install" class="zm-primary">添加到账户</button>`}
        ${install?.status === "configuration_required" ? '<span class="zm-state">待配置</span>' : ""}</div>
      ${install?.notice ? `<p class="zm-notice">${esc(install.notice)}</p>` : ""}
      <section><h3>你会获得</h3><p>${esc(release.description)}</p>
        ${(release.components || []).map((c) => {
          const state = statuses.find((s) => s.id === c.id);
          const host = c.kind === "workbench" && pluginManager?.list?.().find((p) => p.id === c.pluginId);
          const label = host && install?.enabled ? (host.status === "active" ? "当前 Workbench 运行中" : `当前 Workbench：${host.status || "未激活"}`)
            : state ? statusLabel[state.status] : kindLabel[c.kind];
          return `<div class="zm-component"><div><strong>${esc(c.name)}</strong><span>${esc(kindLabel[c.kind])}</span></div>
            <small>${esc(hostErrors.get(c.pluginId) || label)}</small></div>${c.requirements ? `<ul>${c.requirements.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
            ${c.kind === "mcp" && !release.artifact ? `<p class="zm-notice">此条目仅提供连接说明。请通过 CLI 上传 MCP 制品，再配置执行设备。</p>` : ""}
            ${state?.uiStatus === "host_adapter_required" ? '<p class="zm-muted">工具能力可跨端调用；此插件的 Workbench 界面仍需宿主适配。</p>' : ""}
            ${c.body ? `<details><summary>查看 SKILL.md</summary><pre>${esc(c.body)}</pre></details>` : ""}`;
        }).join("")}
        ${install && allBuiltin.length ? `<button data-action="prepare-host">${actual.every((p) => p?.status === "active") ? "同步 Workbench 状态" : "在当前 Workbench 启用"}</button><p class="zm-muted">运行状态以当前 Workbench 的插件管理器为准。</p>` : ""}
      </section>${install && release.artifact && ["plugin", "mcp"].includes(release.kind) ? `
      <section><h3>连接与设置</h3><p class="zm-muted">默认在账户工作区运行。需要内网服务时，选择能访问该服务的设备。</p>
        <form class="zm-host-form zm-form-grid">
          <label>运行位置<select name="nodeId" required>${connections.map((c) =>
            `<option value="${esc(c.nodeId)}"${c.nodeId === (install.config?.nodeId || "managed:account") ? " selected" : ""}>${esc(c.label)}${c.status === "offline" ? " · 离线" : c.status === "unprovisioned" ? " · 尚未开通" : ""}</option>`).join("")}</select></label>
          ${connectionError ? `<p class="zm-notice">${esc(connectionError)}</p>` : ""}
          ${Object.entries(release.artifact.plugin?.settingsSchema?.properties || {}).map(([key, property]) => {
            const value = install.config?.settings?.[key] ?? property.default ?? "";
            const required = release.artifact.plugin.settingsSchema.required?.includes(key) ? "required" : "";
            return `<label>${esc(property.title || key)}${property.type === "boolean"
              ? `<select name="setting:${esc(key)}"><option value="true"${value === true ? " selected" : ""}>开启</option><option value="false"${value !== true ? " selected" : ""}>关闭</option></select>`
              : property.enum ? `<select name="setting:${esc(key)}">${property.enum.map((v) => `<option${v === value ? " selected" : ""}>${esc(v)}</option>`).join("")}</select>`
                : `<input name="setting:${esc(key)}" value="${esc(value)}" ${required} ${property.type !== "string" ? 'type="number"' : ""}>`}
              ${property.description ? `<small>${esc(property.description)}</small>` : ""}</label>`;
          }).join("")}
          <details><summary>${esc(release.artifact.plugin?.connection?.label || "设备连接")}与高级设置</summary>
            <label>设备上的工作目录<input name="workspaceRoot" required value="${esc(install.config?.workspaceRoot || connections.find((c) => c.nodeId === "managed:account")?.workspaceRoot || "")}" placeholder="使用所选设备的工作目录"></label>
            <label>设备上的服务凭据文件（可选）<input name="credentialsFile" value="${esc(install.config?.credentialsFile || "")}" placeholder="填写设备上的私有凭据文件路径"></label>
            ${release.artifact.plugin?.connection?.envKeys?.length ? `<p class="zm-muted">此服务需要 ${esc(release.artifact.plugin.connection.envKeys.join("、"))}。凭据仅保存在所选设备。</p>` : ""}
          </details>
          <button type="submit">保存设置</button>
        </form>
        ${install.enabled && install.config ? `<p class="zm-muted">在对话中使用插件，运行环境与依赖会自动准备。</p><details><summary>开发调试</summary>
          <button data-action="extension-probe">检查连接与能力</button>
        ${install.validation?.tools?.length ? `<form class="zm-call-form">
          <label>工具<select name="tool">${(install.validation?.tools || []).map((tool) => `<option>${esc(tool.name)}</option>`).join("")}</select></label>
          <label>参数 JSON<textarea name="arguments" rows="4" spellcheck="false">{}</textarea></label><button type="submit">调用工具</button>
        </form>` : ""}</details>` : ""}
        ${executionResult?.listingId === entry.id ? `<details open><summary>最近执行结果</summary><pre>${esc(executionResult.output)}</pre></details>` : ""}
      </section>` : ""}<section><h3>版本与来源</h3>
        <label class="zm-version">${entry.visibility === "private" ? "已上传版本" : "已发布版本"} <select aria-label="选择版本">${entry.versions.map((v) => `<option value="${esc(v.version)}"${v.version === (install?.version || entry.version) ? " selected" : ""}>${esc(v.version)}</option>`).join("")}</select></label>
        ${install ? '<button data-action="version">切换版本</button>' : ""}
        <p>${esc(release.changelog)}</p><p>${entry.sourceUrl ? `<a href="${esc(entry.sourceUrl)}" target="_blank" rel="noopener noreferrer">查看源代码 ↗</a> · ` : ""}${esc(entry.license)}</p>
        <details><summary>内容摘要</summary><code>${esc(install?.digest || entry.digest)}</code></details>
      </section>${install ? "<p class='zm-muted'>安装记录保存在账户中，换设备后可以继续管理。</p>" : ""}`;
  }
  function draftFields(c) {
    const m = c?.manifest;
    return m ? { id: c.id, slug: m.id.slice(m.publisher.id.length + 1), name: m.name,
      summary: m.summary, category: m.category, sourceUrl: m.sourceUrl, version: m.version,
      license: m.license, body: m.components[0].body, description: m.description, changelog: m.changelog } : {
      slug: "", name: "", summary: "", category: "研究写作", sourceUrl: "", version: "1.0.0",
      license: "MIT", body: "---\nname: my-skill\ndescription: 说明技能适用的任务\n---\n\n# 我的技能\n", changelog: "首个版本"
    };
  }
  function renderContributions() {
    const d = unsaved || draftFields();
    q(".zm-contributions").innerHTML = `<div class="zm-contribute-copy"><h2>分享你的方法</h2>
      <p>首版接受标准 SKILL.md。保存草稿后提交审核，发布者身份绑定当前账户。</p></div>
      <div class="zm-contribution-list">${snapshot.contributions.length ? snapshot.contributions.map((c) =>
        `<div class="zm-contribution-row"><div><strong>${esc(c.manifest.name)}</strong><small>v${esc(c.manifest.version)} · ${esc(statusLabel[c.status])}</small>
          ${c.feedback ? `<p>${esc(c.feedback)}</p>` : ""}</div>
          ${["draft", "changes_requested"].includes(c.status) ? `<div><button data-edit="${esc(c.id)}">编辑</button><button data-submit="${esc(c.id)}">提交审核</button></div>` : ""}</div>`).join("")
        : '<p class="zm-muted">还没有贡献。从下面保存你的第一份技能草稿。</p>'}</div>
      <form class="zm-form"><h3>${d.id ? "编辑草稿" : "新建技能草稿"}</h3><div class="zm-form-grid">
        ${[["name", "名称", 100], ["slug", "标识（小写字母与短横线）", 60], ["summary", "一句话用途", 300],
          ["sourceUrl", "源代码 HTTPS 链接", 1000], ["version", "版本", 40], ["license", "许可证", 80]].map(([key, label, max]) =>
          `<label>${label}<input name="${key}" value="${esc(d[key])}" maxlength="${max}" required ${key === "sourceUrl" ? 'type="url"' : ""}></label>`).join("")}
        <label>用途分类<select name="category">${snapshot.categories.map((category) => `<option${category === d.category ? " selected" : ""}>${esc(category)}</option>`).join("")}</select></label></div>
        <label>SKILL.md<textarea name="body" rows="12" required maxlength="100000" spellcheck="false">${esc(d.body)}</textarea></label>
        <div class="zm-actions"><button class="zm-primary" type="submit">保存草稿</button>${d.id ? '<button type="button" data-action="new-draft">新建另一份</button>' : ""}</div>
      </form>${snapshot.canReview ? '<section class="zm-review"><h3>待审核贡献</h3><button data-action="review-queue">加载审核队列</button><div class="zm-review-list"></div></section>' : ""}`;
  }
  function captureDraft() {
    const form = q(".zm-form");
    if (!form) return;
    unsaved = { ...(unsaved || {}), ...Object.fromEntries(new FormData(form)) };
  }
  search.oninput = () => { renderList(); renderDetail(); };
  selects.forEach((select) => { select.onchange = () => { renderList(); renderDetail(); }; });
  root.addEventListener("input", (event) => { if (event.target.closest(".zm-form")) captureDraft(); });
  root.addEventListener("submit", (event) => {
    if (event.target.matches(".zm-host-form")) {
      event.preventDefault();
      const entry = snapshot.entries.find((item) => item.id === selectedId);
      const values = Object.fromEntries(new FormData(event.target));
      const config = { nodeId: values.nodeId, workspaceRoot: values.workspaceRoot, credentialsFile: values.credentialsFile };
      if (!config.credentialsFile) delete config.credentialsFile;
      const schema = (entry.installedRelease || entry).artifact.plugin?.settingsSchema;
      if (schema) config.settings = Object.fromEntries(Object.entries(schema.properties)
        .filter(([key]) => values[`setting:${key}`] !== "" || schema.required?.includes(key))
        .map(([key, p]) => [key,
        p.type === "boolean" ? values[`setting:${key}`] === "true"
          : p.type === "string" ? values[`setting:${key}`] : Number(values[`setting:${key}`])]));
      void perform(() => client.configure(entry.id, config, snapshot.revision), "设置已保存，可以在对话中使用。");
      return;
    }
    if (event.target.matches(".zm-call-form")) {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.target));
      void perform(() => executeExtension("call", { tool: values.tool, arguments: JSON.parse(values.arguments) }), "工具调用完成。");
      return;
    }
    if (!event.target.matches(".zm-form")) return;
    event.preventDefault(); captureDraft();
    void perform(async () => {
      const result = await api("contributions", "POST", { ...unsaved, expectedRevision: snapshot.revision });
      unsaved = draftFields(result.contribution);
    }, "草稿已保存，可以提交审核。");
  });
  root.addEventListener("change", (event) => {
    if (event.target.matches('.zm-host-form [name="nodeId"]')) {
      const selected = connections.find((c) => c.nodeId === event.target.value);
      const field = q('.zm-host-form [name="workspaceRoot"]');
      field.value = selected?.workspaceRoot || "";
      q('.zm-host-form [name="credentialsFile"]').value = "";
    }
  });
  async function executeExtension(action, input = {}) {
    const entry = snapshot.entries.find((item) => item.id === selectedId);
    const accepted = await client.startExecution(entry, action, input);
    notify("正在执行，请稍候…");
    for (let attempt = 0; attempt < 1200 && !controller.signal.aborted; attempt++) {
      const { run } = await client.getExecution(accepted.runId);
      if (["completed", "failed", "aborted", "interrupted"].includes(run.status)) {
        executionResult = { listingId: entry.id, output: run.output || run.error || run.status };
        if (run.status !== "completed") throw new Error(run.error || `扩展执行${run.status}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`执行仍在进行，请在会话中查看 Run ${accepted.runId}`);
  }
  root.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || busy) return;
    if (button.dataset.tab) { if (tab === "contributions") captureDraft(); tab = button.dataset.tab; render(); return; }
    if (button.dataset.entry) { selectedId = button.dataset.entry; renderList(); renderDetail(); return; }
    if (button.dataset.edit) {
      void perform(async () => {
        const result = await api(`contributions/${encodeURIComponent(button.dataset.edit)}`);
        unsaved = draftFields(result.contribution);
      }, "草稿已载入。");
      return;
    }
    if (button.dataset.submit) { void perform(() => api(`contributions/${button.dataset.submit}/submit`, "POST", { expectedRevision: snapshot.revision }), "已提交审核。审核完成前不会在市场公开。"); return; }
    const entry = snapshot.entries.find((item) => item.id === selectedId);
    const action = button.dataset.action;
    if (action === "discover") { tab = "discover"; render(); return; }
    if (action === "new-draft") { unsaved = null; renderContributions(); return; }
    if (action === "refresh") { void perform(async () => {}, "已同步账户扩展。"); return; }
    if (action === "extension-prepare" || action === "extension-probe") {
      void perform(() => executeExtension(action === "extension-prepare" ? "prepare" : "probe"), action === "extension-prepare" ? "依赖已准备，可以验证工具。" : "验证完成，工具已可调用。");
      return;
    }
    if (action === "install" || action === "version") {
      const version = detail.querySelector(".zm-version select").value;
      const release = entry.versions.find((v) => v.version === version);
      void perform(() => api(`installations/${encodeURIComponent(entry.id)}`, "POST", {
        version, digest: release.digest, expectedRevision: snapshot.revision
      }), action === "install" ? "已添加到账户。准备状态见详情。" : "版本已切换。");
    } else if (action === "toggle") {
      void perform(() => api(`installations/${encodeURIComponent(entry.id)}`, "PATCH", {
        enabled: !entry.installation.enabled, expectedRevision: snapshot.revision
      }), entry.installation.enabled ? "已停用。" : "已启用。");
    } else if (action === "remove") {
      void perform(() => api(`installations/${encodeURIComponent(entry.id)}`, "DELETE", { expectedRevision: snapshot.revision }), "已从账户卸载。");
    } else if (action === "prepare-host") {
      void perform(async () => {
        for (const c of (entry.installedRelease || entry).components.filter((c) => c.kind === "workbench")) {
          if (entry.installation.enabled) await pluginManager.enable(c.pluginId);
          else await pluginManager.disable(c.pluginId);
        }
      }, "已同步当前 Workbench，运行状态见详情。");
    } else if (action === "review-queue") {
      void perform(async () => {
        const result = await api("review");
        // Store content until refresh finishes; render from a separate callback.
        root.reviewQueue = result.contributions;
      }).then(() => {
        const host = q(".zm-review-list");
        if (!host) return;
        host.innerHTML = (root.reviewQueue || []).map((c) =>
          `<div class="zm-review-item"><strong>${esc(c.manifest.name)} · ${esc(c.manifest.publisher.name)}</strong>
            <p>${esc(c.manifest.summary)}</p><a href="${esc(c.manifest.sourceUrl)}" target="_blank" rel="noopener noreferrer">来源 ↗</a>
            <details><summary>查看提交内容</summary><pre>${esc(c.manifest.components[0].body)}</pre><code>${esc(c.digest)}</code></details>
            <button data-review="${esc(c.id)}" data-decision="publish">发布</button>
            <button data-review="${esc(c.id)}" data-decision="changes_requested">退回修改</button></div>`).join("") || "<p>没有待审核贡献。</p>";
      });
    } else if (button.dataset.review) {
      const c = root.reviewQueue.find((item) => item.id === button.dataset.review);
      void perform(() => api("review", "POST", { userId: c.userId, id: c.id, digest: c.digest,
        decision: button.dataset.decision }), "审核结果已保存。");
    }
  });
  notify("正在读取账户扩展…");
  void perform(async () => {}, "账户扩展已同步。");
  return { dispose() { disposed = true; controller.abort(); root.remove(); } };
}

export function openMarketplace() {
  return window.open("https://marketplace.zioon.tech/", "_blank", "noopener,noreferrer");
}
