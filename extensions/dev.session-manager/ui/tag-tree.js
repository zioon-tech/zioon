// Tag tree panel — the left column of the Sessions sidebar split layout.
// Owns all DOM interaction (search, selection, create/rename/delete, drag
// reorder, keyboard). Pure data comes in via update(); mutations go out
// through injected callbacks. The host owns catalog persistence.

function parentOfPath(path) {
  const segments = String(path || "").split("/");
  segments.pop();
  return segments.join("/");
}

function parentOf(row) {
  const segments = String(row?.path || "").split("/");
  segments.pop();
  return segments.join("/");
}

export function createTagTreePanel(deps) {
  const t = deps.t || ((key, fallback) => fallback);
  const iconHtml = deps.iconHtml || (() => "");
  const onSelect = deps.onSelect || (() => {});
  const onCreate = deps.onCreate || (async () => true);
  const onRename = deps.onRename || (async () => true);
  const onDelete = deps.onDelete || (async () => true);
  const onReorder = deps.onReorder || (() => {});
  const isCollapsed = deps.isCollapsed || (() => false);
  const setCollapsed = deps.setCollapsed || (() => {});
  const dotColor = deps.dotColor || (() => "");

  const el = document.createElement("div");
  el.className = "zion-sessions-tagtree";
  el.style.display = "flex";
  el.style.flexDirection = "column";
  el.style.height = "100%";
  el.style.minHeight = "0";
  el.style.overflow = "hidden";

  let state = { rows: [], nodeCount: 0, selection: "" };
  let searchText = "";
  let editMode = null; // { kind: "create"|"rename"|"delete", path, parentPath }
  let renderedKey = "";
  let dragPath = "";

  // --- header + search ---
  const header = document.createElement("div");
  header.className = "zion-sessions-tagtree-header";
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.gap = "6px";
  header.style.padding = "6px 8px 4px 8px";
  const title = document.createElement("span");
  title.className = "zion-sessions-section-title";
  title.textContent = t("tags.title", "Tags");
  title.style.fontSize = "11px";
  title.style.fontWeight = "500";
  title.style.flex = "1 1 auto";
  title.style.overflow = "hidden";
  title.style.textOverflow = "ellipsis";
  title.style.whiteSpace = "nowrap";
  const countBadge = document.createElement("span");
  countBadge.className = "zion-sessions-tagtree-count";
  countBadge.style.fontSize = "10px";
  countBadge.style.opacity = "0.7";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "zion-sessions-tagtree-add";
  addBtn.title = t("tags.addTag", "New tag");
  addBtn.setAttribute("aria-label", t("tags.addTag", "New tag"));
  addBtn.innerHTML = iconHtml("add", 14);
  addBtn.style.display = "inline-flex";
  addBtn.style.alignItems = "center";
  addBtn.style.justifyContent = "center";
  addBtn.style.width = "20px";
  addBtn.style.height = "20px";
  addBtn.style.border = "0";
  addBtn.style.background = "transparent";
  addBtn.style.color = "inherit";
  addBtn.style.cursor = "pointer";
  addBtn.style.borderRadius = "4px";
  addBtn.onclick = (event) => {
    event.stopPropagation();
    startCreate("");
  };
  header.appendChild(title);
  header.appendChild(countBadge);
  header.appendChild(addBtn);

  const searchWrap = document.createElement("div");
  searchWrap.style.padding = "0 8px 6px 8px";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = t("tags.searchTags", "Search tags…");
  search.className = "zion-sessions-tagtree-search";
  search.setAttribute("aria-label", t("tags.searchTags", "Search tags…"));
  search.style.width = "100%";
  search.style.boxSizing = "border-box";
  search.style.fontSize = "11px";
  search.style.padding = "3px 8px";
  search.style.borderRadius = "4px";
  search.style.border = "1px solid color-mix(in srgb, var(--border) 80%, transparent)";
  search.style.background = "transparent";
  search.style.color = "var(--fg)";
  search.oninput = () => {
    searchText = String(search.value || "").trim().toLowerCase();
    render();
  };
  searchWrap.appendChild(search);

  const body = document.createElement("div");
  body.className = "zion-sessions-tagtree-body";
  body.style.flex = "1 1 auto";
  body.style.minHeight = "0";
  body.style.overflow = "auto";
  body.style.overflowAnchor = "none";
  body.style.padding = "0 4px 8px 2px";
  body.tabIndex = 0;

  el.appendChild(header);
  el.appendChild(searchWrap);
  el.appendChild(body);

  // --- filtering ---
  function visibleRows() {
    const rows = state.rows || [];
    if (!searchText) return rows;
    const matchSet = new Set();
    for (const row of rows) {
      if (row.path.toLowerCase().includes(searchText)) {
        const segments = row.path.split("/");
        for (let i = 1; i <= segments.length; i += 1) matchSet.add(segments.slice(0, i).join("/"));
      }
    }
    return rows.filter((row) => matchSet.has(row.path));
  }

  function expandedRows() {
    if (searchText) return visibleRows();
    const rows = visibleRows();
    const out = [];
    for (const row of rows) {
      const hiddenByCollapse = row.path
        .split("/")
        .slice(0, -1)
        .some((_, index, segments) => isCollapsed(segments.slice(0, index + 1).join("/")));
      if (!hiddenByCollapse) out.push(row);
    }
    return out;
  }

  // --- rendering ---
  function render() {
    const rows = expandedRows();
    const key = [
      rows.map((row) => `${row.path}:${row.sessionCount}:${row.manual ? 1 : 0}:${state.selection === row.path ? 1 : 0}`).join("\u0001"),
      searchText,
      editMode ? `${editMode.kind}:${editMode.path}` : ""
    ].join("\u0003");
    if (key === renderedKey && body.childElementCount) {
      countBadge.textContent = String(state.nodeCount || 0);
      return;
    }
    renderedKey = key;
    countBadge.textContent = String(state.nodeCount || 0);
    body.innerHTML = "";
    if (editMode && editMode.kind === "create") {
      body.appendChild(createInputRow(editMode.parentPath));
    }
    if (!rows.length && !(editMode && editMode.kind === "create")) {
      const empty = document.createElement("div");
      empty.className = "zion-sessions-tagtree-empty";
      empty.textContent = searchText
        ? t("tags.noMatches", "No matching tags")
        : t("tags.empty", "No tags yet");
      empty.style.padding = "10px 8px";
      empty.style.fontSize = "11px";
      empty.style.opacity = "0.65";
      body.appendChild(empty);
    }
    for (const row of rows) {
      body.appendChild(renderRow(row));
      if (editMode && editMode.path === row.path) {
        if (editMode.kind === "rename") body.appendChild(createInputRow(parentOf(row), row.label));
        if (editMode.kind === "delete") body.appendChild(createDeleteRow(row));
      }
    }
  }

  function renderRow(row) {
    const item = document.createElement("div");
    item.className = "zion-sessions-tagtree-row";
    item.dataset.path = row.path;
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-selected", state.selection === row.path ? "true" : "false");
    item.setAttribute("aria-level", String(row.depth + 1));
    item.setAttribute("aria-expanded", row.children?.length ? String(!isCollapsed(row.path)) : undefined);
    item.tabIndex = -1;
    item.title = `#${row.path}`;
    item.style.display = "flex";
    item.style.alignItems = "center";
    item.style.gap = "5px";
    item.style.height = "24px";
    item.style.paddingRight = "4px";
    item.style.borderRadius = "4px";
    item.style.cursor = "pointer";
    item.style.userSelect = "none";
    item.style.marginLeft = `${row.depth * 12}px`;
    if (state.selection === row.path) {
      item.style.background = "color-mix(in srgb, var(--accent, var(--border)) 26%, transparent)";
    } else {
      item.onmouseenter = () => { item.style.background = "color-mix(in srgb, var(--border) 55%, transparent)"; };
      item.onmouseleave = () => { item.style.background = "transparent"; };
    }

    const hasChildren = !!(row.children && row.children.length);
    const chevron = document.createElement("span");
    chevron.className = "zion-sessions-tagtree-chevron";
    chevron.innerHTML = iconHtml(isCollapsed(row.path) ? "chevron-right" : "chevron-down", 12);
    chevron.style.display = "inline-flex";
    chevron.style.width = "14px";
    chevron.style.flex = "0 0 auto";
    chevron.style.justifyContent = "center";
    chevron.style.opacity = hasChildren ? "0.85" : "0";
    chevron.onmousedown = (event) => event.stopPropagation();
    chevron.onclick = (event) => {
      event.stopPropagation();
      if (!hasChildren) return;
      setCollapsed(row.path, !isCollapsed(row.path));
      render();
    };
    item.appendChild(chevron);

    if (row.depth === 0) {
      const hash = document.createElement("span");
      hash.textContent = "#";
      hash.style.opacity = "0.55";
      hash.style.flex = "0 0 auto";
      item.appendChild(hash);
    } else {
      const dot = document.createElement("span");
      const color = dotColor(row.path);
      dot.style.flex = "0 0 auto";
      dot.style.width = "6px";
      dot.style.height = "6px";
      dot.style.borderRadius = "50%";
      dot.style.background = color || "color-mix(in srgb, var(--fg) 45%, transparent)";
      item.appendChild(dot);
    }

    const label = document.createElement("span");
    label.className = "zion-sessions-tagtree-label";
    label.textContent = row.label;
    label.style.flex = "1 1 auto";
    label.style.minWidth = "0";
    label.style.overflow = "hidden";
    label.style.textOverflow = "ellipsis";
    label.style.whiteSpace = "nowrap";
    label.style.fontSize = "12px";
    item.appendChild(label);

    if (!row.manual && !row.implicit) {
      const ephemeral = document.createElement("span");
      ephemeral.title = t("tags.scannedOnly", "Scanned from documents");
      ephemeral.textContent = "·";
      ephemeral.style.opacity = "0.45";
      ephemeral.style.flex = "0 0 auto";
      item.appendChild(ephemeral);
    }

    const count = document.createElement("span");
    count.className = "zion-sessions-tagtree-count";
    count.textContent = String(row.sessionCount || 0);
    count.style.flex = "0 0 auto";
    count.style.fontSize = "10px";
    count.style.opacity = "0.62";
    item.appendChild(count);

    const menu = document.createElement("button");
    menu.type = "button";
    menu.className = "zion-sessions-tagtree-menu";
    menu.innerHTML = iconHtml("ellipsis", 13);
    menu.title = t("tags.tagActions", "Tag actions");
    menu.setAttribute("aria-label", t("tags.tagActions", "Tag actions"));
    Object.assign(menu.style, {
      display: "none", alignItems: "center", justifyContent: "center",
      width: "18px", height: "18px", flex: "0 0 auto",
      border: "0", background: "transparent", color: "inherit",
      cursor: "pointer", borderRadius: "4px"
    });
    item.onmouseenter = () => { menu.style.display = "inline-flex"; };
    item.onmouseleave = () => { menu.style.display = "none"; };
    menu.onclick = (event) => {
      event.stopPropagation();
      openRowMenu(event, row, menu);
    };
    item.appendChild(menu);

    item.onclick = () => {
      const isSelected = item.getAttribute("aria-selected") === "true";
      const next = isSelected ? "" : row.path;
      onSelect(next);
      applySelection(next);
    };
    item.ondblclick = () => startRename(row);
    item.draggable = true;
    item.ondragstart = (event) => {
      dragPath = row.path;
      event.dataTransfer?.setData("text/plain", row.path);
      event.dataTransfer && (event.dataTransfer.effectAllowed = "move");
    };
    item.ondragend = () => { dragPath = ""; };
    item.ondragover = (event) => {
      if (!dragPath || dragPath === row.path) return;
      if (parentOfPath(dragPath) !== parentOfPath(row.path)) return;
      event.preventDefault();
      item.style.outline = "1px dashed var(--border)";
    };
    item.ondragleave = () => { item.style.outline = ""; };
    item.ondrop = (event) => {
      event.preventDefault();
      item.style.outline = "";
      if (!dragPath || dragPath === row.path) return;
      const rect = item.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      onReorder(dragPath, row.path, after);
      dragPath = "";
    };

    item.onkeydown = (event) => rowKeydown(event, row);
    return item;
  }

  function rowKeydown(event, row) {
    const rows = Array.from(body.querySelectorAll(".zion-sessions-tagtree-row"));
    const index = rows.indexOf(event.currentTarget);
    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        rows[index + 1]?.focus();
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        rows[index - 1]?.focus();
        break;
      }
      case "ArrowRight": {
        event.preventDefault();
        if (row.children?.length && isCollapsed(row.path)) {
          setCollapsed(row.path, false);
          render();
        }
        break;
      }
      case "ArrowLeft": {
        event.preventDefault();
        if (row.children?.length && !isCollapsed(row.path)) {
          setCollapsed(row.path, true);
          render();
        } else {
          const parent = parentOf(row);
          const escaped = parent.replace(/(["\\])/g, "\\$1");
          body.querySelector(`[data-path="${escaped}"]`)?.focus();
        }
        break;
      }
      case "Enter": {
        event.preventDefault();
        const isSelected = event.currentTarget.getAttribute("aria-selected") === "true";
        const next = isSelected ? "" : row.path;
        onSelect(next);
        applySelection(next);
        break;
      }
      case "F2": {
        event.preventDefault();
        startRename(row);
        break;
      }
      default:
        break;
    }
  }

  function openRowMenu(event, row, anchor) {
    document.querySelector(".zion-sessions-tagtree-context")?.remove();
    const menu = document.createElement("div");
    menu.className = "zion-sessions-tagtree-context";
    Object.assign(menu.style, {
      position: "fixed",
      left: `${event.clientX}px`,
      top: `${event.clientY}px`,
      background: "var(--panel)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      padding: "4px 0",
      zIndex: "100001",
      minWidth: "130px"
    });
    const mk = (label, onClick) => {
      const item = document.createElement("div");
      item.textContent = label;
      item.style.padding = "5px 14px";
      item.style.fontSize = "12px";
      item.style.cursor = "pointer";
      item.style.color = "var(--fg)";
      item.onmouseenter = () => { item.style.background = "var(--border)"; };
      item.onmouseleave = () => { item.style.background = "transparent"; };
      item.onclick = () => {
        menu.remove();
        onClick();
      };
      menu.appendChild(item);
      return item;
    };
    mk(t("tags.addChild", "Add child tag"), () => startCreate(row.path));
    mk(t("tags.rename", "Rename"), () => startRename(row));
    mk(t("tags.delete", "Delete"), () => {
      editMode = { kind: "delete", path: row.path };
      render();
    });
    const close = (clickEvent) => {
      if (menu.contains(clickEvent.target) || anchor.contains(clickEvent.target)) return;
      menu.remove();
      document.removeEventListener("mousedown", close);
    };
    document.addEventListener("mousedown", close);
    document.body.appendChild(menu);
  }

  function createInputRow(parentPath, initial = "") {
    const wrap = document.createElement("div");
    wrap.className = "zion-sessions-tagtree-edit";
    Object.assign(wrap.style, {
      display: "flex", alignItems: "center", gap: "4px",
      marginLeft: `${parentPath ? (parentPath.split("/").length + 1) * 12 : 0}px`,
      padding: "2px 4px"
    });
    if (parentPath) {
      const prefix = document.createElement("span");
      prefix.textContent = `#${parentPath}/`;
      prefix.style.opacity = "0.6";
      prefix.style.fontSize = "11px";
      prefix.style.whiteSpace = "nowrap";
      wrap.appendChild(prefix);
    }
    const input = document.createElement("input");
    input.type = "text";
    input.value = initial;
    input.placeholder = t("tags.tagName", "tag name");
    Object.assign(input.style, {
      flex: "1 1 auto", minWidth: "0", fontSize: "12px",
      padding: "2px 6px", borderRadius: "4px",
      border: "1px solid var(--border)", background: "transparent", color: "var(--fg)"
    });
    const submit = async () => {
      const value = String(input.value || "").trim();
      if (!value) {
        editMode = null;
        render();
        return;
      }
      const path = parentPath ? `${parentPath}/${value.replace(/^#/, "")}` : value.replace(/^#/, "");
      const ok = editMode?.kind === "rename"
        ? await onRename(editMode.path, path)
        : await onCreate(path);
      if (ok !== false) {
        editMode = null;
      }
      render();
    };
    input.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        editMode = null;
        render();
      }
    };
    input.onblur = () => {
      // Commit on blur only when there is a value; otherwise cancel.
      if (String(input.value || "").trim()) submit();
      else {
        editMode = null;
        render();
      }
    };
    wrap.appendChild(input);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
    return wrap;
  }

  function createDeleteRow(row) {
    const wrap = document.createElement("div");
    wrap.className = "zion-sessions-tagtree-confirm";
    Object.assign(wrap.style, {
      display: "flex", alignItems: "center", gap: "6px",
      marginLeft: `${(row.depth + 1) * 12}px`, padding: "3px 4px", fontSize: "11px"
    });
    const text = document.createElement("span");
    text.style.flex = "1 1 auto";
    text.style.opacity = "0.8";
    text.textContent = t("tags.deleteConfirm", "Delete {count} session refs?", { count: row.sessionCount || 0 });
    const yes = document.createElement("button");
    yes.type = "button";
    yes.textContent = t("tags.deleteYes", "Delete");
    Object.assign(yes.style, { border: "0", borderRadius: "4px", padding: "2px 8px", cursor: "pointer", background: "var(--border)", color: "var(--fg)" });
    yes.onclick = async () => {
      await onDelete(row.path, { sessions: row.sessionCount || 0 });
      editMode = null;
      render();
    };
    const no = document.createElement("button");
    no.type = "button";
    no.textContent = t("common.cancel", "Cancel");
    Object.assign(no.style, { border: "0", borderRadius: "4px", padding: "2px 8px", cursor: "pointer", background: "transparent", color: "var(--fg)" });
    no.onclick = () => {
      editMode = null;
      render();
    };
    wrap.appendChild(text);
    wrap.appendChild(yes);
    wrap.appendChild(no);
    return wrap;
  }

  function startCreate(parentPath) {
    editMode = { kind: "create", parentPath };
    render();
  }

  function startRename(row) {
    editMode = { kind: "rename", path: row.path };
    render();
  }

  body.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && editMode) {
      editMode = null;
      render();
    }
  });

  function applySelection(path) {
    state.selection = String(path || "");
    render();
  }

  return {
    el,
    update(next) {
      state = {
        rows: next.rows || [],
        nodeCount: next.nodeCount || 0,
        selection: String(next.selection || "")
      };
      render();
    },
    setSelection: applySelection,
    focus() {
      search.focus();
    },
    dispose() {
      document.querySelector(".zion-sessions-tagtree-context")?.remove();
      el.remove();
    }
  };
}
