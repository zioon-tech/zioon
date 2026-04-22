/**
 * dev.fs-manager
 * - Manage user-granted FileSystemAccess handles (files/directories)
 * - Persist handles in IndexedDB (structured clone)
 * - Provide a simple manager panel to add/remove entries
 * - Expose entries via command 'fs.getEntries' and state key 'fs.allowed'
 */
import { registerFsTools } from "./fs-tools.js";

export async function activate(ctx) {
  // IndexedDB helpers
  const DB_NAME = "dev.fs-handles-db";
  const STORE = "handles";
  function openDB() {
    return new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: "id" });
          }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
      } catch (e) { reject(e); }
    });
  }
  async function dbGetAll() {
    const db = await openDB();
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readonly");
        const st = tx.objectStore(STORE);
        const req = st.getAll();
        req.onsuccess = () => { try { db.close(); } catch {} resolve(req.result || []); };
        req.onerror = () => { try { db.close(); } catch {} resolve([]); };
      } catch { try { db.close(); } catch {} resolve([]); }
    });
  }
  async function dbPut(entry) {
    const db = await openDB();
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        const st = tx.objectStore(STORE);
        const req = st.put(entry);
        req.onsuccess = () => { try { db.close(); } catch {} resolve(true); };
        req.onerror = () => { try { db.close(); } catch {} resolve(false); };
      } catch { try { db.close(); } catch {} resolve(false); }
    });
  }
  async function dbDelete(id) {
    const db = await openDB();
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        const st = tx.objectStore(STORE);
        const req = st.delete(id);
        req.onsuccess = () => { try { db.close(); } catch {} resolve(true); };
        req.onerror = () => { try { db.close(); } catch {} resolve(false); };
      } catch { try { db.close(); } catch {} resolve(false); }
    });
  }
  async function dbClear() {
    const db = await openDB();
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        const st = tx.objectStore(STORE);
        const req = st.clear();
        req.onsuccess = () => { try { db.close(); } catch {} resolve(true); };
        req.onerror = () => { try { db.close(); } catch {} resolve(false); };
      } catch { try { db.close(); } catch {} resolve(false); }
    });
  }

  // Runtime store
  const entries = []; // { id, kind:'file'|'directory', name, handle }
  const byId = new Map();

  function refreshState() {
    // Keep raw handles in state for same-page consumers (not persisted by zion itself).
    window.zion.state.set("fs.allowed", entries.slice());
  }

  // Load persisted entries
  try {
    const all = await dbGetAll();
    for (const it of all) {
      // structured clone restores handle
      entries.push(it);
      byId.set(it.id, it);
    }
    refreshState();
  } catch (e) {
    console.warn("[fs-manager] load error", e);
  }

  function uid() {
    return "fs_" + Math.random().toString(36).slice(2);
  }

  async function ensurePermission(handle, mode = "readwrite") {
    try {
      const q = await handle.queryPermission?.({ mode }) ?? "granted";
      if (q === "granted") return true;
      const r = await handle.requestPermission?.({ mode }) ?? "denied";
      return r === "granted";
    } catch {
      return true; // some browsers might not implement permission methods on cloned handles
    }
  }

  async function addFiles() {
    if (!window.showOpenFilePicker) {
      window.showToast?.("当前浏览器不支持 File System Access API");
      return;
    }
    try {
      const handles = await window.showOpenFilePicker({ multiple: true });
      for (const h of handles) {
        const fileHandle = h;
        const ok = await ensurePermission(fileHandle, "readwrite");
        const entry = { id: uid(), kind: "file", name: fileHandle.name, handle: fileHandle, path: "" };
        entries.push(entry);
        byId.set(entry.id, entry);
        if (ok) await dbPut(entry);
      }
      refreshState();
      window.showToast?.(`已添加 ${handles.length} 个文件`);
    } catch (e) {
      // user cancel
    }
  }

  async function addFolder() {
    if (!window.showDirectoryPicker) {
      window.showToast?.("当前浏览器不支持 Directory Picker");
      return;
    }
    try {
      const dir = await window.showDirectoryPicker({ mode: "readwrite" });
      const ok = await ensurePermission(dir, "readwrite");
      const entry = { id: uid(), kind: "directory", name: dir.name, handle: dir, path: "" };
      entries.push(entry);
      byId.set(entry.id, entry);
      if (ok) await dbPut(entry);
      refreshState();
      window.showToast?.("已添加文件夹访问");
    } catch (e) {
      // user cancel
    }
  }

  async function removeEntry(id) {
    const idx = entries.findIndex(e => e.id === id);
    if (idx >= 0) {
      entries.splice(idx, 1);
      byId.delete(id);
      await dbDelete(id);
      refreshState();
    }
  }

  async function updateEntryPath(id, path) {
    const it = byId.get(id);
    if (!it) return;
    it.path = String(path || "").trim();
    await dbPut(it);
    refreshState();
  }

  async function clearAll() {
    entries.splice(0, entries.length);
    byId.clear();
    await dbClear();
    refreshState();
  }

  function openPanel() {
    const existing = document.getElementById("zion-fs-panel");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "zion-fs-panel";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,0.35)";
    overlay.style.zIndex = "99998";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const panel = document.createElement("div");
    panel.style.position = "fixed";
    panel.style.right = "20px";
    panel.style.top = "60px";
    panel.style.width = "360px";
    panel.style.maxHeight = "65vh";
    panel.style.overflow = "auto";
    panel.style.background = "var(--panel)";
    panel.style.border = "1px solid var(--border)";
    panel.style.borderRadius = "6px";
    panel.style.boxShadow = "0 8px 24px rgba(0,0,0,0.35)";
    panel.style.padding = "10px";
    panel.style.zIndex = "99999";
    panel.style.color = "var(--fg)";
    panel.onclick = (e) => e.stopPropagation();

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    const title = document.createElement("div");
    title.textContent = "Files Access Manager";
    title.style.fontWeight = "600";
    const btns = document.createElement("div");
    const mkBtn = (label, onClick) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.background = "var(--border)";
      b.style.color = "var(--fg)";
      b.style.border = "1px solid var(--accent)";
      b.style.borderRadius = "4px";
      b.style.padding = "4px 8px";
      b.style.marginLeft = "6px";
      b.onclick = onClick;
      return b;
    };
    btns.appendChild(mkBtn("Add File", () => addFiles().then(renderList)));
    btns.appendChild(mkBtn("Add Folder", () => addFolder().then(renderList)));
    btns.appendChild(mkBtn("Clear", () => clearAll().then(renderList)));
    header.appendChild(title);
    header.appendChild(btns);
    panel.appendChild(header);

    const list = document.createElement("div");
    list.style.marginTop = "8px";
    panel.appendChild(list);

    const renderList = () => {
      list.innerHTML = "";
      if (entries.length === 0) {
        const empty = document.createElement("div");
        empty.textContent = "尚未添加任何文件或文件夹";
        empty.style.opacity = "0.8";
        empty.style.fontSize = "12px";
        list.appendChild(empty);
        return;
      }
      entries.forEach((it) => {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.justifyContent = "space-between";
        row.style.padding = "6px 2px";

        const leftWrap = document.createElement("div");
        leftWrap.style.display = "flex";
        leftWrap.style.alignItems = "center";
        leftWrap.style.gap = "8px";
        leftWrap.style.flex = "1";

        const label = document.createElement("span");
        label.textContent = `${it.kind === "directory" ? "📁" : "📄"} ${it.name}`;
        label.style.fontSize = "12px";

        // Full Path input
        const pathInput = document.createElement("input");
        pathInput.type = "text";
        pathInput.placeholder = it.kind === "directory" ? "/absolute/dir/path" : "/absolute/file/path";
        pathInput.value = String(it.path || "");
        Object.assign(pathInput.style, {
          flex: "1",
          minWidth: "120px",
          background: "var(--panel)",
          color: "var(--fg)",
          border: "1px solid var(--border)",
          borderRadius: "4px",
          padding: "2px 6px",
          fontSize: "11px"
        });
        pathInput.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            updateEntryPath(it.id, pathInput.value).then(() => {
              window.showToast?.("Saved Full Path");
            });
          }
        });
        pathInput.addEventListener("blur", () => {
          // Auto-save on blur
          const v = String(pathInput.value || "").trim();
          if (v !== String(it.path || "")) {
            updateEntryPath(it.id, v).then(() => {
              // silent save
            });
          }
        });

        leftWrap.appendChild(label);
        leftWrap.appendChild(pathInput);

        const actions = document.createElement("div");
        const saveBtn = document.createElement("button");
        saveBtn.textContent = "Save";
        saveBtn.style.background = "var(--border)";
        saveBtn.style.color = "var(--fg)";
        saveBtn.style.border = "1px solid var(--accent)";
        saveBtn.style.borderRadius = "4px";
        saveBtn.style.padding = "2px 6px";
        saveBtn.onclick = () => updateEntryPath(it.id, pathInput.value).then(() => {
          window.showToast?.("Saved Full Path");
        });

        const rm = document.createElement("button");
        rm.textContent = "Remove";
        rm.style.background = "var(--border)";
        rm.style.color = "var(--fg)";
        rm.style.border = "1px solid var(--accent)";
        rm.style.borderRadius = "4px";
        rm.style.padding = "2px 6px";
        rm.style.marginLeft = "6px";
        rm.onclick = () => removeEntry(it.id).then(renderList);

        actions.appendChild(saveBtn);
        actions.appendChild(rm);

        row.appendChild(leftWrap);
        row.appendChild(actions);
        list.appendChild(row);
      });
    };
    renderList();

    // footer
    const footer = document.createElement("div");
    footer.style.marginTop = "10px";
    footer.style.display = "flex";
    footer.style.justifyContent = "flex-end";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.style.background = "var(--border)";
    closeBtn.style.color = "var(--fg)";
    closeBtn.style.border = "1px solid var(--accent)";
    closeBtn.style.borderRadius = "4px";
    closeBtn.style.padding = "4px 8px";
    closeBtn.onclick = () => overlay.remove();
    footer.appendChild(closeBtn);
    panel.appendChild(footer);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  // Commands
  ctx.subscriptions.push(
    window.zion.commands.registerCommand("fs.showManager", () => openPanel())
  );
  ctx.subscriptions.push(
    window.zion.commands.registerCommand("fs.addFile", async () => { await addFiles(); })
  );
  ctx.subscriptions.push(
    window.zion.commands.registerCommand("fs.addFolder", async () => { await addFolder(); })
  );
  ctx.subscriptions.push(
    window.zion.commands.registerCommand("fs.clearAll", async () => { await clearAll(); })
  );
  ctx.subscriptions.push(
    window.zion.commands.registerCommand("fs.getEntries", () => entries.slice())
  );

  // Status bar entry
  const status = window.zion.statusBar.registerItem({
    id: "core.fsmanager",
    text: "FS",
    tooltip: "Manage file/folder access",
    onClick: () => window.zion.commands.executeCommand("fs.showManager")
  });
  ctx.subscriptions.push(status);

  // Register FS tools for LLM usage
  try { registerFsTools(); } catch {}

  // Register fs-manager settings into core Settings Panel
  try {
    if (window.zion?.settings?.registerItem) {
      window.zion.settings.registerItem({
        id: "fs-manager-config",
        category: "Workspace",
        section: "File System",
        title: "文件系统访问管理",
        description: "维护已授权的文件和目录句柄，并保存它们的本地路径映射。",
        keywords: ["filesystem", "handles", "workspace", "permissions", "paths"],
        order: 40,
        render(container) {
          container.innerHTML = "";

          const style = document.createElement("style");
          style.textContent = `
            .fs-cfg-info { font-size:11px;opacity:.7;margin-bottom:10px }
            .fs-cfg-actions { display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap }
            .fs-cfg-btn { padding:4px 12px;border:1px solid var(--border,#3c3c3c);border-radius:6px;background:transparent;color:var(--fg,#ccc);cursor:pointer;font-size:12px }
            .fs-cfg-btn:hover { background:rgba(255,255,255,.06) }
            .fs-cfg-btn.primary { border-color:var(--accent,#6272a4);color:var(--accent,#6272a4) }
            .fs-cfg-btn.danger { border-color:#ff6b6b;color:#ff6b6b }
            .fs-cfg-entry { display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border,#3c3c3c);border-radius:6px;margin-bottom:6px }
            .fs-cfg-entry-icon { font-size:14px }
            .fs-cfg-entry-name { font-size:12px;font-weight:500;min-width:80px }
            .fs-cfg-entry-path { flex:1;padding:3px 6px;border:1px solid var(--border,#3c3c3c);border-radius:4px;background:transparent;color:var(--fg,#ccc);font-size:11px;font-family:var(--font-mono,monospace) }
            .fs-cfg-entry-path:focus { outline:1px solid var(--accent,#6272a4) }
            .fs-cfg-entry-rm { padding:2px 8px;border:1px solid var(--border,#3c3c3c);border-radius:4px;background:transparent;color:var(--fg,#ccc);cursor:pointer;font-size:11px;opacity:.7 }
            .fs-cfg-entry-rm:hover { opacity:1;color:#ff6b6b }
            .fs-cfg-empty { font-size:12px;opacity:.6;padding:8px 0 }
          `;
          container.appendChild(style);

          const info = document.createElement("div");
          info.className = "fs-cfg-info";
          info.textContent = `已授权 ${entries.length} 个文件/文件夹`;
          container.appendChild(info);

          const actions = document.createElement("div");
          actions.className = "fs-cfg-actions";

          const addFileBtn = document.createElement("button");
          addFileBtn.className = "fs-cfg-btn primary";
          addFileBtn.textContent = "+ 文件";
          addFileBtn.onclick = async () => { await addFiles(); renderEntries(); };
          actions.appendChild(addFileBtn);

          const addFolderBtn = document.createElement("button");
          addFolderBtn.className = "fs-cfg-btn primary";
          addFolderBtn.textContent = "+ 文件夹";
          addFolderBtn.onclick = async () => { await addFolder(); renderEntries(); };
          actions.appendChild(addFolderBtn);

          const clearBtn = document.createElement("button");
          clearBtn.className = "fs-cfg-btn danger";
          clearBtn.textContent = "清除全部";
          clearBtn.onclick = async () => { await clearAll(); renderEntries(); };
          actions.appendChild(clearBtn);

          container.appendChild(actions);

          const list = document.createElement("div");
          container.appendChild(list);

          const renderEntries = () => {
            list.innerHTML = "";
            info.textContent = `已授权 ${entries.length} 个文件/文件夹`;
            if (entries.length === 0) {
              const empty = document.createElement("div");
              empty.className = "fs-cfg-empty";
              empty.textContent = "尚未添加任何文件或文件夹";
              list.appendChild(empty);
              return;
            }
            for (const it of entries) {
              const row = document.createElement("div");
              row.className = "fs-cfg-entry";

              const icon = document.createElement("span");
              icon.className = "fs-cfg-entry-icon";
              icon.textContent = it.kind === "directory" ? "📁" : "📄";
              row.appendChild(icon);

              const name = document.createElement("span");
              name.className = "fs-cfg-entry-name";
              name.textContent = it.name;
              row.appendChild(name);

              const pathInput = document.createElement("input");
              pathInput.className = "fs-cfg-entry-path";
              pathInput.type = "text";
              pathInput.placeholder = it.kind === "directory" ? "/absolute/dir/path" : "/absolute/file/path";
              pathInput.value = String(it.path || "");
              pathInput.addEventListener("blur", () => {
                const v = pathInput.value.trim();
                if (v !== String(it.path || "")) {
                  updateEntryPath(it.id, v);
                }
              });
              pathInput.addEventListener("keydown", (ev) => {
                if (ev.key === "Enter") updateEntryPath(it.id, pathInput.value);
              });
              row.appendChild(pathInput);

              const rm = document.createElement("button");
              rm.className = "fs-cfg-entry-rm";
              rm.textContent = "×";
              rm.onclick = async () => { await removeEntry(it.id); renderEntries(); };
              row.appendChild(rm);

              list.appendChild(row);
            }
          };
          renderEntries();
        }
      });
    }
  } catch (e) {
    console.warn("[dev.fs-manager] failed to register settings item", e);
  }
}
