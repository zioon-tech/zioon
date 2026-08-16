// Tag tree panel — the left column of the Sessions sidebar split layout.
// Owns all DOM interaction (search, selection, create/rename/delete, drag
// reorder, keyboard). Pure data comes in via update(); mutations go out
// through injected callbacks. The host owns catalog persistence.
//
// Visual language follows flowix's tag tree: one hash glyph per row (also
// the collapse toggle, with a corner triangle when it has children), a bare
// tabular count, plain rows, context menu on right-click. All styling lives
// in styles.css under .zion-sessions-tagtree-*; JS only toggles state
// classes. Per-row dynamic values (indent depth) stay inline.

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
  const onReparent = deps.onReparent || (async () => true);
  const onPin = deps.onPin || (() => {});
  const isCollapsed = deps.isCollapsed || (() => false);
  const setCollapsed = deps.setCollapsed || (() => {});

  const el = document.createElement("div");
  el.className = "zion-sessions-tagtree";

  let state = { rows: [], nodeCount: 0, selection: "" };
  let searchText = "";
  let editMode = null; // { kind: "create"|"rename"|"delete", path, parentPath }
  let renderedKey = "";
  let dragPath = "";

  const searchWrap = document.createElement("div");
  searchWrap.className = "zion-sessions-tagtree-searchwrap";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = t("tags.searchTags", "Search tags…");
  search.className = "zion-sessions-tagtree-search";
  search.setAttribute("aria-label", t("tags.searchTags", "Search tags…"));
  search.oninput = () => {
    searchText = String(search.value || "").trim().toLowerCase();
    render();
  };
  const searchIcon = document.createElement("span");
  searchIcon.className = "zion-sessions-tagtree-searchicon";
  searchIcon.innerHTML = iconHtml("search", 12);
  searchWrap.appendChild(searchIcon);
  searchWrap.appendChild(search);

  const body = document.createElement("div");
  body.className = "zion-sessions-tagtree-body";
  body.tabIndex = 0;

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
      rows.map((row) => [
        row.path,
        row.sessionCount,
        state.selection === row.path ? 1 : 0,
        row.automatic ? 1 : 0,
        row.readOnly ? 1 : 0,
        (row.sourceLabels || []).join(",")
      ].join(":")).join("\u0001"),
      searchText,
      editMode ? `${editMode.kind}:${editMode.path}` : ""
    ].join("\u0003");
    if (key === renderedKey && body.childElementCount) {
      return;
    }
    renderedKey = key;
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

  function dropZoneFor(event, element) {
    const rect = element.getBoundingClientRect();
    const relative = event.clientY - rect.top;
    if (relative < rect.height / 3) return "before";
    if (relative > (rect.height * 2) / 3) return "after";
    return "inside";
  }

  const DROP_ZONE_CLASS = {
    before: "is-drop-before",
    after: "is-drop-after",
    inside: "is-drop-inside"
  };

  function applyDropVisual(item, zone) {
    clearDropVisual(item);
    if (DROP_ZONE_CLASS[zone]) item.classList.add(DROP_ZONE_CLASS[zone]);
    item.dataset.dropZone = zone;
  }

  function clearDropVisual(item) {
    item.classList.remove("is-drop-before", "is-drop-after", "is-drop-inside");
    item.dataset.dropZone = "";
  }

  function renderRow(row) {
    const item = document.createElement("div");
    item.className = "zion-sessions-tagtree-row";
    item.dataset.path = row.path;
    item.dataset.depth = String(row.depth);
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-selected", state.selection === row.path ? "true" : "false");
    item.setAttribute("aria-level", String(row.depth + 1));
    item.setAttribute("aria-expanded", row.children?.length ? String(!isCollapsed(row.path)) : undefined);
    item.tabIndex = -1;
    item.title = `#${row.path}`;
    // Indent stays inline: it is per-row dynamic data.
    item.style.paddingLeft = `${4 + row.depth * 13}px`;
    if (state.selection === row.path) item.classList.add("is-selected");
    if (row.automatic) item.classList.add("is-automatic");

    // hash glyph — identity + collapse toggle in one control (flowix style)
    const hasChildren = !!(row.children && row.children.length);
    const toggle = document.createElement("span");
    toggle.className = `zion-sessions-tagtree-toggle${hasChildren ? " has-children" : ""}`;
    toggle.innerHTML = iconHtml("hash", 13);
    toggle.onmousedown = (event) => event.stopPropagation();
    toggle.onclick = (event) => {
      event.stopPropagation();
      if (!hasChildren) return;
      setCollapsed(row.path, !isCollapsed(row.path));
      render();
    };
    item.appendChild(toggle);

    const label = document.createElement("span");
    label.className = "zion-sessions-tagtree-label";
    label.textContent = row.label;
    item.appendChild(label);

    if (row.automatic) {
      const source = document.createElement("span");
      const sourceLabels = (row.sourceLabels || []).join(", ") || t("tags.automatic", "Automatic");
      source.className = "zion-sessions-tagtree-source";
      source.innerHTML = iconHtml("sparkle", 11);
      source.title = t("tags.automaticSource", "Automatic tag · {source}", { source: sourceLabels });
      source.setAttribute("aria-label", source.title);
      item.appendChild(source);
      item.title = `${item.title} · ${source.title}`;
    }

    const count = document.createElement("span");
    count.className = "zion-sessions-tagtree-count";
    count.textContent = String(row.sessionCount || 0);
    item.appendChild(count);

    item.onclick = () => {
      const isSelected = item.getAttribute("aria-selected") === "true";
      const next = isSelected ? "" : row.path;
      onSelect(next);
      applySelection(next);
    };
    item.ondblclick = () => {
      if (!row.readOnly) startRename(row);
    };
    item.oncontextmenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openRowMenu(event, row);
    };
    item.draggable = !row.readOnly;
    item.ondragstart = (event) => {
      if (row.readOnly) {
        event.preventDefault();
        return;
      }
      dragPath = row.path;
      try {
        event.dataTransfer?.setData("text/plain", row.path);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      } catch {}
    };
    item.ondragend = () => {
      dragPath = "";
      clearDropVisual(item);
    };
    item.ondragover = (event) => {
      if (row.readOnly || !dragPath || dragPath === row.path) return;
      const zone = dropZoneFor(event, item);
      const sameParent = parentOf(row) === parentOfPath(dragPath);
      const targetInsideDraggedSubtree = row.path.startsWith(`${dragPath}/`);
      const allowed = zone === "inside" ? !targetInsideDraggedSubtree : sameParent;
      if (!allowed) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      applyDropVisual(item, zone);
    };
    item.ondragleave = () => { clearDropVisual(item); };
    item.ondrop = (event) => {
      event.preventDefault();
      const zone = dropZoneFor(event, item);
      clearDropVisual(item);
      const dragged = dragPath;
      dragPath = "";
      if (!dragged || dragged === row.path) return;
      if (zone === "inside") {
        if (row.path.startsWith(`${dragged}/`)) return;
        if (row.children?.length && isCollapsed(row.path)) setCollapsed(row.path, false);
        onReparent(dragged, row.path);
      } else {
        if (parentOf(row) !== parentOfPath(dragged)) return;
        onReorder(dragged, row.path, zone === "after");
      }
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
        if (!row.readOnly) startRename(row);
        break;
      }
      default:
        break;
    }
  }

  function openRowMenu(event, row) {
    document.querySelector(".zion-sessions-tagtree-context")?.remove();
    const menu = document.createElement("div");
    menu.className = "zion-sessions-tagtree-context";
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    const mk = (label, onClick, options = {}) => {
      const item = document.createElement("div");
      item.className = [
        "zion-sessions-tagtree-context-item",
        options.danger ? "is-danger" : "",
        options.disabled ? "is-disabled" : ""
      ].filter(Boolean).join(" ");
      item.textContent = label;
      item.onclick = () => {
        if (options.disabled) return;
        menu.remove();
        onClick();
      };
      menu.appendChild(item);
      return item;
    };
    if (row.readOnly) {
      const sourceLabels = (row.sourceLabels || []).join(", ") || t("tags.automatic", "Automatic");
      mk(t("tags.automaticSource", "Automatic tag · {source}", { source: sourceLabels }), () => {}, {
        disabled: true
      });
    } else {
      mk(t("tags.addChild", "Add child tag"), () => startCreate(row.path));
      mk(t("tags.rename", "Rename"), () => startRename(row));
      mk(row.pinned ? t("tags.unpin", "Unpin") : t("tags.pin", "Pin"), () => onPin(row.path));
      mk(t("tags.delete", "Delete"), () => {
        editMode = { kind: "delete", path: row.path };
        render();
      }, { danger: true });
    }
    const close = (clickEvent) => {
      if (menu.contains(clickEvent.target)) return;
      menu.remove();
      document.removeEventListener("mousedown", close);
    };
    document.addEventListener("mousedown", close);
    document.body.appendChild(menu);
  }

  function createInputRow(parentPath, initial = "") {
    const wrap = document.createElement("div");
    wrap.className = "zion-sessions-tagtree-edit";
    // Indent stays inline: derived from parent depth.
    wrap.style.marginLeft = `${parentPath ? (parentPath.split("/").length + 1) * 13 + 4 : 0}px`;
    if (parentPath) {
      const prefix = document.createElement("span");
      prefix.className = "zion-sessions-tagtree-edit-prefix";
      prefix.textContent = `#${parentPath}/`;
      wrap.appendChild(prefix);
    }
    const input = document.createElement("input");
    input.type = "text";
    input.value = initial;
    input.placeholder = t("tags.tagName", "tag name");
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
    // Indent stays inline: derived from row depth.
    wrap.style.marginLeft = `${4 + (row.depth + 1) * 13}px`;
    const text = document.createElement("span");
    text.className = "zion-sessions-tagtree-confirm-text";
    const childCount = (state.rows || []).filter((r) => r.path.startsWith(`${row.path}/`)).length;
    text.textContent = childCount === 0
      ? t("tags.deleteConfirmLeaf", "Remove tag refs from {count} sessions?", { count: row.sessionCount || 0 })
      : t("tags.deleteConfirmSubtree", "Delete {children} sub-tags and refs from {count} sessions?", { children: childCount, count: row.sessionCount || 0 });
    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "zion-sessions-tagtree-confirm-yes";
    yes.textContent = t("tags.deleteYes", "Delete");
    yes.onclick = async () => {
      await onDelete(row.path, { sessions: row.sessionCount || 0 });
      editMode = null;
      render();
    };
    const no = document.createElement("button");
    no.type = "button";
    no.className = "zion-sessions-tagtree-confirm-no";
    no.textContent = t("common.cancel", "Cancel");
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
    if (row?.readOnly) return;
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
    startCreateRoot() {
      startCreate("");
    },
    focus() {
      search.focus();
    },
    dispose() {
      document.querySelector(".zion-sessions-tagtree-context")?.remove();
      el.remove();
    }
  };
}
