const $ = (id) => document.getElementById(id);
const ROOT = "/memory/dev.identity";
const state = { subject: "", csrf: "", canWrite: false, directory: ROOT, path: "", content: "", hash: null, loading: 0, revision: 0, saving: false };
const date = (value) => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
const size = (bytes = 0) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
const dirty = () => state.path && $("editor").value !== state.content;
function notice(text, error = false) {
  $("notice").textContent = text;
  $("notice").classList.toggle("error", error);
  $("notice").hidden = false;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => { $("notice").hidden = true; }, error ? 12000 : 4000);
}
function lockedUi() {
  $("save").disabled = !state.canWrite || !dirty() || state.saving;
  $("save-state").textContent = state.saving ? "正在保存…" : dirty() ? "有未保存的编辑" : "已保存";
}
function signedOut() {
  ++state.loading; ++state.revision;
  state.csrf = ""; state.canWrite = false;
  $("account-name").textContent = "未登录";
  $("logout").hidden = true; $("login-needed").hidden = false;
  $("new-file").hidden = true; $("empty-create").hidden = true;
  $("editor").readOnly = true;
  $("files").replaceChildren();
  if (!dirty()) {
    $("workspace").hidden = true;
    $("editor").value = ""; state.path = ""; state.content = ""; state.hash = null;
  }
  lockedUi();
}
window.addEventListener("zioon:session", event => {
  if (!event.detail.authenticated || (dirty() && state.subject &&
    state.subject !== event.detail.local?.accountSubject)) {
    const draft = dirty();
    const wasLoggedIn = !!state.csrf;
    signedOut();
    if (draft) {
      event.preventDefault();
      if (wasLoggedIn) notice("登录已结束，草稿已保留。请先下载草稿，再重新登录。", true);
    }
  }
});
async function api(path, { body, method, signal } = {}) {
  const response = await fetch(path, {
    credentials: "same-origin", method: method || (body ? "POST" : "GET"),
    headers: { ...(body ? { "content-type": "application/json" } : {}), "x-csrf-token": state.csrf },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: signal || AbortSignal.timeout(15000)
  });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      signedOut();
    }
    throw Object.assign(new Error(value.error || `HTTP ${response.status}`), { status: response.status });
  }
  return value;
}
const icons = {
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"/></svg>',
  directory: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>'
};
function fileRow(entry, selected = false) {
  const button = document.createElement("button");
  button.className = `file-row${selected ? " selected" : ""}`;
  button.innerHTML = icons[entry.type === "directory" ? "directory" : "file"];
  const div = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = entry.name || entry.path.slice(ROOT.length + 1);
  div.append(title);
  const meta = document.createElement("small");
  meta.textContent = entry.snippet || (entry.type === "directory" ? "文件夹" : [size(entry.size), date(entry.modifiedAt)].filter(Boolean).join(" · "));
  div.append(meta);
  button.append(div);
  button.addEventListener("click", () => entry.type === "directory" ? list(entry.path) : openFile(entry.path));
  return button;
}
function placeholder(text) {
  const div = document.createElement("div");
  div.className = "file-empty";
  div.textContent = text;
  $("files").replaceChildren(div);
}
function breadcrumbs() {
  const root = document.createElement("button");
  root.textContent = "全部记忆";
  root.addEventListener("click", () => list(ROOT));
  $("breadcrumbs").replaceChildren(root);
  const parts = state.directory.slice(ROOT.length).split("/").filter(Boolean);
  parts.forEach((name, index) => {
    const separator = document.createElement("span");
    separator.textContent = "/";
    const button = document.createElement("button");
    button.textContent = name;
    button.addEventListener("click", () => list(`${ROOT}/${parts.slice(0, index + 1).join("/")}`));
    $("breadcrumbs").append(separator, button);
  });
}
async function list(path = state.directory) {
  const loading = ++state.loading;
  state.directory = path;
  $("search").value = "";
  $("list-label").textContent = "文件";
  breadcrumbs();
  placeholder("正在读取文件…");
  try {
    const value = await api(`/console/api/entries?path=${encodeURIComponent(path)}`);
    if (loading !== state.loading) return;
    if (!value.entries.length) { placeholder("这里还没有记忆文件。点击「新建文件」开始。"); return; }
    value.entries.sort((a, b) => a.type !== b.type ? a.type === "directory" ? -1 : 1 : a.name.localeCompare(b.name));
    $("files").replaceChildren(...value.entries.map((entry) => fileRow(entry, entry.path === state.path)));
  } catch (error) {
    if (loading === state.loading) placeholder(error.status === 401 ? "请重新登录后读取文件。" : "文件加载失败。点击刷新重试。");
    notice("无法读取目录，请检查连接后重试。", true);
  }
}
function mayLeave() {
  return !dirty() || window.confirm("当前文件有未保存的编辑，确定离开吗？");
}
async function openFile(path, force = false) {
  if (state.saving) { notice("正在保存，请稍候。"); return; }
  if (!force && !mayLeave()) return;
  const revision = ++state.revision;
  const previousPath = state.path;
  const previousDraft = $("editor").value;
  try {
    const value = await api(`/console/api/file?path=${encodeURIComponent(path)}`);
    if (revision !== state.revision) return;
    if (state.path !== previousPath || $("editor").value !== previousDraft) {
      notice("读取期间产生了新的编辑，草稿已保留。请保存后再打开文件。", true);
      return;
    }
    state.path = path;
    state.content = value.content;
    state.hash = value.content_hash;
    $("editor-empty").hidden = true;
    $("editor-workspace").hidden = false;
    $("file-name").textContent = path.split("/").at(-1);
    $("file-path").textContent = path.slice(ROOT.length + 1);
    $("editor").value = value.content;
    $("editor").readOnly = !state.canWrite;
    $("file-info").textContent = `${value.content.split("\n").length} 行 · ${size(new TextEncoder().encode(value.content).byteLength)}`;
    $("conflict").hidden = true;
    document.querySelectorAll(".file-row").forEach((row) => row.classList.remove("selected"));
    lockedUi();
  } catch (error) {
    if (revision !== state.revision) return;
    notice(error.status === 404 ? "文件已不存在，请刷新目录。" : "无法打开文件，请稍后重试。", true);
  }
}
async function save() {
  if (!dirty() || state.saving || !state.canWrite) return;
  const revision = ++state.revision;
  state.saving = true;
  const content = $("editor").value;
  lockedUi();
  try {
    const value = await api(`/console/api/file?path=${encodeURIComponent(state.path)}`, {
      body: { content, expected_hash: state.hash }
    });
    if (revision !== state.revision) return;
    state.content = content;
    state.hash = value.content_hash;
    $("conflict").hidden = true;
    $("file-info").textContent = `${content.split("\n").length} 行 · ${size(new TextEncoder().encode(content).byteLength)}`;
    notice("已保存。");
  } catch (error) {
    if (revision !== state.revision) return;
    if (error.status === 409) {
      $("conflict").hidden = false;
      notice("其他地方修改了这个文件。你的编辑已保留。", true);
    } else {
      notice("保存结果尚未确认。请下载草稿并读取最新版本，再决定是否继续保存。", true);
    }
  } finally { state.saving = false; lockedUi(); }
}
function download() {
  const blob = new Blob([$("editor").value], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = state.path.split("/").at(-1) || "memory.md";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
function createDialog() {
  if (state.saving) { notice("正在保存，请稍候。"); return; }
  if (!mayLeave()) return;
  $("create-path").value = "";
  $("create-dialog").showModal();
  $("create-path").focus();
}
$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("create-path").value.trim();
  if (!name || name.startsWith("/") || name.split("/").some((part) => !part || part === "." || part === "..") || /[\\\x00-\x1f]/.test(name)) {
    notice("请输入相对路径，例如 profile.md 或 projects/notes.md。", true); return;
  }
  const button = event.submitter;
  button.disabled = true;
  try {
    const path = `${state.directory}/${name}`;
    await api(`/console/api/file?path=${encodeURIComponent(path)}`, { body: { content: "", expected_hash: null } });
    $("create-dialog").close();
    await list();
    await openFile(path);
    $("editor").focus();
  } catch (error) {
    notice(error.status === 409 ? "这个文件已存在，请使用其他名称。" : "创建结果尚未确认，请刷新目录检查。", true);
  } finally { button.disabled = false; }
});
$("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = $("search").value.trim();
  if (!query) { await list(); return; }
  const loading = ++state.loading;
  $("list-label").textContent = "搜索结果";
  placeholder("正在搜索…");
  try {
    const value = await api(`/console/api/search?q=${encodeURIComponent(query)}`);
    if (loading !== state.loading) return;
    if (!value.matches.length) { placeholder("没有找到匹配的记忆。"); return; }
    $("files").replaceChildren(...value.matches.map((entry) => fileRow({ ...entry, type: "file" })));
    $("list-label").textContent = `搜索结果 · ${value.matches.length}${value.matches.length === 50 ? "+" : ""}`;
  } catch (error) {
    if (loading === state.loading) placeholder("搜索失败，请稍后重试。");
  }
});
$("history-button").addEventListener("click", async () => {
  $("history-dialog").showModal();
  $("history-path").textContent = state.path.slice(ROOT.length + 1);
  $("history-list").textContent = "正在读取版本历史…";
  try {
    const value = await api(`/console/api/history?path=${encodeURIComponent(state.path)}`);
    const versions = value.data?.versions || value.versions || [];
    $("history-list").replaceChildren(...versions.map((entry) => {
      const row = document.createElement("div");
      row.className = "history-row";
      const label = document.createElement("span");
      label.textContent = `版本 ${entry.version} · ${entry.operation === "write" ? "写入" : entry.operation}`;
      const meta = document.createElement("small");
      meta.textContent = `${date(entry.createdAt)} · ${size(entry.size)}`;
      row.append(label, meta); return row;
    }));
    if (!versions.length) $("history-list").textContent = "还没有版本历史。";
  } catch (error) { $("history-list").textContent = "版本历史暂时不可用，请稍后重试。"; }
});
$("logout").addEventListener("click", async () => {
  if (!mayLeave()) return;
  $("logout").disabled = true;
  try { await api("/account/logout", { body: {} }); location.replace("/account/login"); }
  catch (error) { $("logout").disabled = false; notice("退出失败，请稍后重试。", true); }
});
$("editor").addEventListener("input", lockedUi);
$("save").addEventListener("click", save);
$("download").addEventListener("click", download);
$("new-file").addEventListener("click", createDialog);
$("empty-create").addEventListener("click", createDialog);
$("cancel-create").addEventListener("click", () => $("create-dialog").close());
$("close-history").addEventListener("click", () => $("history-dialog").close());
$("refresh").addEventListener("click", () => list());
$("reload-file").addEventListener("click", () => openFile(state.path));
window.addEventListener("beforeunload", (event) => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "s") { event.preventDefault(); save(); }
});
try {
  const me = await api("/console/api/me");
  state.subject = me.accountSubject;
  state.csrf = me.csrf; state.canWrite = me.canWrite;
  $("account-name").textContent = me.user.name;
  $("account-name").title = me.user.email;
  $("logout").hidden = false; $("workspace").hidden = false;
  $("new-file").hidden = !state.canWrite; $("empty-create").hidden = !state.canWrite;
  await list();
} catch (error) {
  $("account-name").textContent = error.status === 401 ? "未登录" : "暂时不可用";
  $("login-needed").hidden = false;
  if (error.status !== 401) notice("账号服务暂时不可用，请稍后重试。", true);
}
