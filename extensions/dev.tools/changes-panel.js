import {
  buildDiffRows,
  normalizeToolArgs,
  normalizeToolName,
  statusLabel
} from "./artifact-model.js";
import { getCurrentSessionChangeState, subscribeSessionChangeState } from "./session-change-state.js";
import { highlightLine, inferLanguageFromPath } from "./syntax-highlight.js";

export const CHANGES_VIEW_ID = "dev.tools.changes";

const I18N_NS = "dev.tools";
let pendingSelection = null;

function t(key, fallback, values) {
  const fullKey = `${I18N_NS}.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

export function registerChangesPanel(ctx) {
  const disposables = [];

  const openCommand = window.zion.commands.registerCommand("tools.openChanges", (payload = {}) => {
    pendingSelection = payload && typeof payload === "object" ? payload : {};
    try { window.zion.auxiliaryBar?.setWidth?.(Math.max(420, window.zion.state?.get?.("ui.auxiliaryBar.width") || 0)); } catch {}
    try { window.zion.auxiliaryBar?.activateView?.(CHANGES_VIEW_ID); } catch {}
    try { window.zion.events?.emit?.("tools/changesPanelSelect", pendingSelection); } catch {}
  });
  disposables.push(openCommand);

  const viewDisposable = window.zion.auxiliaryBar?.registerView?.({
    id: CHANGES_VIEW_ID,
    pluginId: "dev.tools",
    title: "Changes",
    titleKey: "dev.tools.changes.title",
    icon: "Δ",
    order: 20,
    keepWhenActive: true,
    component: {
      render: (container) => createChangesPanel(container, () => pendingSelection)
    }
  });
  if (viewDisposable) disposables.push(viewDisposable);

  const disposable = {
    dispose() {
      for (const d of disposables.splice(0)) {
        try { d?.dispose?.(); } catch {}
      }
    }
  };
  try { ctx?.subscriptions?.push?.(disposable); } catch {}
  return disposable;
}

function createChangesPanel(container, getPendingSelection) {
  const root = document.createElement("div");
  root.className = "zion-changes-panel";
  container.appendChild(root);

  let selectedId = null;
  let wrapLines = loadChangesPreference("wrapLines", false);
  const expandedIds = new Set();
  let disposed = false;
  let renderTimer = 0;
  let syncTimer = 0;
  let currentArtifacts = [];
  let shouldScrollSelected = false;
  const disposables = [];

  const scheduleRender = () => {
    if (disposed) return;
    if (renderTimer) window.cancelAnimationFrame(renderTimer);
    renderTimer = requestAnimationFrame(() => {
      renderTimer = 0;
      render();
    });
  };
  const scheduleSync = (payload) => {
    if (disposed) return;
    const eventSessionId = String(payload?.sessionId || "").trim();
    if (eventSessionId && eventSessionId !== String(getCurrentSessionId() || "")) return;
    if (syncTimer) window.cancelAnimationFrame(syncTimer);
    syncTimer = requestAnimationFrame(() => {
      syncTimer = 0;
      syncArtifacts();
    });
  };

  const selectPayload = (payload) => {
    const toolCallId = String(payload?.toolCallId || payload?.id || "").trim();
    if (toolCallId) {
      selectedId = toolCallId;
      expandedIds.add(toolCallId);
      shouldScrollSelected = true;
    }
    scheduleRender();
  };

  try { disposables.push(window.zion.events.on("tools/changesPanelSelect", selectPayload)); } catch {}
  try { disposables.push(window.zion.events.on("i18n/changed", scheduleRender)); } catch {}
  disposables.push(subscribeSessionChangeState((payload) => {
    if (!payload?.sessionId) {
      selectedId = null;
      currentArtifacts = [];
    }
    scheduleSync(payload);
  }));

  const pending = getPendingSelection?.();
  if (pending) selectPayload(pending);
  render();

  return {
    dispose() {
      disposed = true;
      if (renderTimer) window.cancelAnimationFrame(renderTimer);
      if (syncTimer) window.cancelAnimationFrame(syncTimer);
      for (const d of disposables.splice(0)) {
        try { d?.dispose?.(); } catch {}
      }
      try { root.remove(); } catch {}
    }
  };

  function render() {
    const previousScroll = root.querySelector(".zion-changes-scroll");
    const previousScrollTop = previousScroll ? previousScroll.scrollTop : 0;
    const scrollToSelected = shouldScrollSelected;
    shouldScrollSelected = false;
    const changeState = getCurrentSessionChangeState();
    const allArtifacts = changeState.artifacts;
    const artifacts = allArtifacts;
    const totals = { added: changeState.summary.addedLines, removed: changeState.summary.removedLines };

    if (selectedId && !artifacts.some(item => item.toolCallId === selectedId || item.id === selectedId)) {
      selectedId = artifacts[0]?.toolCallId || null;
    }
    if (!selectedId && artifacts.length) selectedId = artifacts[0].toolCallId;
    currentArtifacts = artifacts;

    root.innerHTML = "";
    root.appendChild(renderHeader(artifacts.length, totals, artifacts));

    const scroll = document.createElement("div");
    scroll.className = "zion-changes-scroll";
    root.appendChild(scroll);

    if (!allArtifacts.length) {
      scroll.appendChild(emptyState(t("changes.empty", "No file changes in the current session yet. Diffs from edit, write, or apply_patch tools will appear here.")));
      return;
    }

    for (const artifact of artifacts) {
      scroll.appendChild(renderArtifactSection(artifact, artifact.toolCallId === selectedId));
    }
    if (scrollToSelected) {
      scrollSelectedIntoView();
    } else {
      scroll.scrollTop = previousScrollTop;
    }
  }

  function syncArtifacts() {
    if (!root.isConnected || !root.querySelector(".zion-changes-scroll")) {
      render();
      return;
    }
    const nextArtifacts = getCurrentSessionChangeState().artifacts;
    const scroll = root.querySelector(".zion-changes-scroll");
    const previousScrollTop = scroll ? scroll.scrollTop : 0;
    const hadArtifacts = currentArtifacts.length > 0;
    const hasArtifacts = nextArtifacts.length > 0;
    if (!hadArtifacts || !hasArtifacts) {
      currentArtifacts = nextArtifacts;
      render();
      return;
    }

    if (selectedId && !nextArtifacts.some(item => item.toolCallId === selectedId || item.id === selectedId)) {
      selectedId = nextArtifacts[0]?.toolCallId || null;
    }
    if (!selectedId && nextArtifacts.length) selectedId = nextArtifacts[0].toolCallId;

    replaceHeader(nextArtifacts);
    const existing = new Map();
    for (const section of scroll.querySelectorAll(".zion-changes-section")) {
      const id = section.dataset.toolCallId;
      if (id) existing.set(id, section);
    }
    const nextIds = new Set(nextArtifacts.map(item => item.toolCallId));
    for (const [id, section] of existing.entries()) {
      if (!nextIds.has(id)) section.remove();
    }

    let cursor = null;
    for (const artifact of nextArtifacts) {
      const active = artifact.toolCallId === selectedId;
      const prev = currentArtifacts.find(item => item.toolCallId === artifact.toolCallId);
      let section = existing.get(artifact.toolCallId) || null;
      const changed = !section || artifactFingerprint(prev) !== artifactFingerprint(artifact);
      if (changed) {
        const nextSection = renderArtifactSection(artifact, active);
        if (section) section.replaceWith(nextSection);
        else if (cursor?.nextSibling) scroll.insertBefore(nextSection, cursor.nextSibling);
        else scroll.appendChild(nextSection);
        section = nextSection;
      } else {
        section.classList.toggle("is-active", active);
        section.classList.toggle("is-expanded", expandedIds.has(artifact.toolCallId));
      }
      if (cursor && section.previousSibling !== cursor) scroll.insertBefore(section, cursor.nextSibling);
      else if (!cursor && section !== scroll.firstElementChild) scroll.insertBefore(section, scroll.firstElementChild);
      cursor = section;
    }
    currentArtifacts = nextArtifacts;
    if (shouldScrollSelected) {
      shouldScrollSelected = false;
      scrollSelectedIntoView();
    } else {
      scroll.scrollTop = previousScrollTop;
    }
  }

  function replaceHeader(artifacts) {
    const totals = artifacts.reduce((acc, item) => {
      acc.added += Number(item.addedLines || 0);
      acc.removed += Number(item.removedLines || 0);
      return acc;
    }, { added: 0, removed: 0 });
    const nextHeader = renderHeader(artifacts.length, totals, artifacts);
    const prevHeader = root.querySelector(".zion-changes-header");
    if (prevHeader) prevHeader.replaceWith(nextHeader);
    else root.prepend(nextHeader);
  }

  function renderHeader(count, totals, artifacts) {
    const header = document.createElement("div");
    header.className = "zion-changes-header";

    const stats = document.createElement("div");
    stats.className = "zion-changes-stats";
    stats.innerHTML = `<span>${t("changes.files", "{count} files", { count })}</span><span class="is-add">+${totals.added}</span><span class="is-remove">-${totals.removed}</span>`;

    header.appendChild(stats);
    const controls = document.createElement("div");
    controls.className = "zion-changes-header-controls";

    const wrap = document.createElement("button");
    wrap.className = `zion-changes-icon-button${wrapLines ? " is-active" : ""}`;
    wrap.type = "button";
    wrap.title = wrapLines ? t("changes.scrollLongLines", "Scroll long lines") : t("changes.wrapLongLines", "Wrap long lines");
    wrap.textContent = t("changes.wrap", "Wrap");
    wrap.addEventListener("click", () => {
      wrapLines = !wrapLines;
      saveChangesPreference("wrapLines", wrapLines);
      render();
    });

    const allExpanded = artifacts.length > 0 && artifacts.every(item => expandedIds.has(item.toolCallId));
    const expand = document.createElement("button");
    expand.className = "zion-changes-icon-button";
    expand.type = "button";
    expand.title = allExpanded ? t("changes.collapseAll", "Collapse all files") : t("changes.expandAll", "Expand all files");
    expand.textContent = allExpanded ? t("changes.collapse", "Collapse") : t("changes.expand", "Expand");
    expand.addEventListener("click", () => {
      if (allExpanded) {
        expandedIds.clear();
      } else {
        for (const artifact of artifacts) expandedIds.add(artifact.toolCallId);
      }
      render();
    });

    const refresh = document.createElement("button");
    refresh.className = "zion-changes-icon-button";
    refresh.type = "button";
    refresh.textContent = t("changes.refresh", "Refresh");
    refresh.addEventListener("click", scheduleRender);

    if (artifacts.length) {
      controls.appendChild(wrap);
      controls.appendChild(expand);
    }
    controls.appendChild(refresh);
    header.appendChild(controls);
    return header;
  }

  function renderArtifactSection(artifact, active) {
    const expanded = expandedIds.has(artifact.toolCallId);
    const section = document.createElement("section");
    section.className = `zion-changes-section${active ? " is-active" : ""}${expanded ? " is-expanded" : ""}`;
    section.dataset.toolCallId = artifact.toolCallId;

    const row = document.createElement("div");
    row.className = "zion-changes-section-header";
    const toggle = document.createElement("button");
    toggle.className = "zion-changes-section-toggle";
    toggle.type = "button";
    toggle.title = artifact.path;
    toggle.addEventListener("click", () => {
      selectedId = artifact.toolCallId;
      if (expandedIds.has(artifact.toolCallId)) {
        expandedIds.delete(artifact.toolCallId);
      } else {
        expandedIds.add(artifact.toolCallId);
      }
      render();
    });

    const left = document.createElement("div");
    left.className = "zion-changes-section-left";
    const chevron = document.createElement("span");
    chevron.className = "zion-changes-chevron";
    chevron.textContent = expanded ? "⌄" : "›";
    const name = document.createElement("span");
    name.className = "zion-changes-section-name";
    name.textContent = artifact.basename || artifact.path;
    const dir = document.createElement("span");
    dir.className = "zion-changes-section-dir";
    dir.textContent = compactDirname(artifact.path);
    dir.title = pathDirname(artifact.path);
    const fileText = document.createElement("span");
    fileText.className = "zion-changes-section-filetext";
    fileText.appendChild(name);
    if (dir.textContent) fileText.appendChild(dir);
    left.appendChild(chevron);
    left.appendChild(fileText);

    const right = document.createElement("div");
    right.className = "zion-changes-section-right";
    if (artifact.kind === "created" || artifact.kind === "deleted") {
      const badge = document.createElement("span");
      badge.className = `zion-changes-kind is-${artifact.kind}`;
      badge.textContent = artifact.kind === "created" ? t("changes.new", "New") : t("changes.deleted", "Deleted");
      right.appendChild(badge);
    }

    const status = document.createElement("span");
    status.className = `zion-changes-status is-${artifact.status}`;
    status.textContent = statusLabel(artifact.status);
    const stats = document.createElement("span");
    stats.className = "zion-changes-file-meta";
    stats.innerHTML = `<span class="is-add">+${formatDiffCount(artifact.addedLines || 0)}</span><span class="is-remove">-${formatDiffCount(artifact.removedLines || 0)}</span>`;
    right.appendChild(status);
    right.appendChild(stats);

    toggle.appendChild(left);
    toggle.appendChild(right);
    row.appendChild(toggle);

    row.appendChild(renderActionsMenu(artifact));
    section.appendChild(row);

    if (expanded) {
      const body = document.createElement("div");
      body.className = "zion-changes-section-body";
      body.appendChild(renderArtifactBody(artifact));
      section.appendChild(body);
    }
    return section;
  }

  function renderArtifactBody(artifact) {
    const wrap = document.createElement("div");
    wrap.className = "zion-changes-detail-inner";

    const code = document.createElement("div");
    code.className = `zion-changes-diff${wrapLines ? " is-wrapped" : ""}`;
    const rows = buildDiffRows(artifact);
    const gutter = computeGutterWidths(rows);
    const rowWidth = computeDiffRowWidth(rows, gutter);
    code.style.setProperty("--changes-old-gutter", `${gutter.old}px`);
    code.style.setProperty("--changes-new-gutter", `${gutter.new}px`);
    code.style.setProperty("--changes-row-width", `${rowWidth}px`);
    const language = inferLanguageFromPath(artifact.path);
    const lines = document.createElement("div");
    lines.className = "zion-changes-diff-lines";
    for (const row of rows) {
      lines.appendChild(renderDiffRow(row, language));
    }
    code.appendChild(lines);
    wrap.appendChild(code);
    return wrap;
  }

  function renderDiffRow(row, language) {
    const el = document.createElement("div");
    el.className = `zion-changes-diff-row is-${row.type}`;
    const oldNo = document.createElement("span");
    oldNo.className = "zion-changes-diff-no";
    oldNo.textContent = row.oldNo == null ? "" : String(row.oldNo);
    const newNo = document.createElement("span");
    newNo.className = "zion-changes-diff-no";
    newNo.textContent = row.newNo == null ? "" : String(row.newNo);
    const mark = document.createElement("span");
    mark.className = "zion-changes-diff-mark";
    mark.textContent = row.type === "add" ? "+" : row.type === "remove" ? "-" : " ";
    const text = document.createElement("span");
    text.className = "zion-changes-diff-text";
    renderHighlightedText(text, row.text || " ", shouldHighlightRow(row) ? language : "");
    el.appendChild(oldNo);
    el.appendChild(newNo);
    el.appendChild(mark);
    el.appendChild(text);
    return el;
  }

  function renderHighlightedText(container, text, language) {
    container.textContent = "";
    const tokens = language ? highlightLine(text, language) : [{ text, className: "" }];
    for (const token of tokens) {
      const span = document.createElement("span");
      if (token.className) span.className = `zion-syntax-token ${token.className}`;
      span.textContent = token.text;
      container.appendChild(span);
    }
  }

  function renderActionsMenu(artifact) {
    const details = document.createElement("details");
    details.className = "zion-changes-actions-menu";
    details.addEventListener("click", (event) => event.stopPropagation());
    details.addEventListener("toggle", () => {
      const section = details.closest(".zion-changes-section");
      if (section) section.classList.toggle("is-menu-open", details.open);
      closeSiblingMenus(details);
    });

    const summary = document.createElement("summary");
    summary.className = "zion-changes-actions-trigger";
    summary.title = t("changes.fileActions", "File actions");
    summary.textContent = "⋯";
    details.appendChild(summary);

    const menu = document.createElement("div");
    menu.className = "zion-changes-actions-popover";
    menu.appendChild(menuButton(t("changes.copyPath", "Copy Path"), () => copyText(artifact.path, t("changes.pathCopied", "Path copied"))));
    menu.appendChild(menuButton(t("changes.copyDiff", "Copy Diff"), () => copyText(artifactToText(artifact), t("changes.diffCopied", "Diff copied"))));
    if (canAcceptOrRevert(artifact)) {
      menu.appendChild(menuButton(t("changes.accept", "Accept"), () => emitToolAction(artifact, "accept"), "primary"));
      menu.appendChild(menuButton(t("changes.revert", "Revert"), () => emitToolAction(artifact, "revert"), "danger"));
    }
    details.appendChild(menu);
    return details;
  }

  function scrollSelectedIntoView() {
    if (!selectedId) return;
    window.setTimeout(() => {
      if (disposed) return;
      for (const el of root.querySelectorAll(".zion-changes-section")) {
        if (el.dataset.toolCallId === selectedId) {
          try { el.scrollIntoView({ block: "nearest" }); } catch {}
          break;
        }
      }
    }, 0);
  }
}

function closeSiblingMenus(current) {
  if (!current.open) return;
  const root = current.closest(".zion-changes-panel");
  if (!root) return;
  for (const menu of root.querySelectorAll(".zion-changes-actions-menu[open]")) {
    if (menu !== current) menu.removeAttribute("open");
  }
}

function computeGutterWidths(rows) {
  let oldMax = 0;
  let newMax = 0;
  for (const row of rows) {
    if (typeof row.oldNo === "number") oldMax = Math.max(oldMax, row.oldNo);
    if (typeof row.newNo === "number") newMax = Math.max(newMax, row.newNo);
  }
  return {
    old: gutterWidthForNumber(oldMax),
    new: gutterWidthForNumber(newMax)
  };
}

function computeDiffRowWidth(rows, gutter) {
  let maxChars = 0;
  for (const row of rows) {
    maxChars = Math.max(maxChars, String(row?.text || "").length);
  }
  const gutterWidth = Number(gutter?.old || 0) + Number(gutter?.new || 0) + 16;
  return Math.min(2400, Math.max(260, gutterWidth + maxChars * 7 + 28));
}

function gutterWidthForNumber(value) {
  if (!value) return 20;
  const digits = String(value).length;
  return Math.min(44, Math.max(24, digits * 7 + 14));
}

function shouldHighlightRow(row) {
  return row?.type === "add" || row?.type === "remove" || row?.type === "context";
}

function artifactFingerprint(artifact) {
  if (!artifact) return "";
  return [
    artifact.toolCallId,
    artifact.path,
    artifact.kind,
    artifact.status,
    artifact.addedLines || 0,
    artifact.removedLines || 0,
    String(artifact.before ?? ""),
    String(artifact.after ?? ""),
    String(artifact.patch ?? "")
  ].join("\u001f");
}

function getCurrentSessionId() {
  try { return window.zion.state?.get?.("sessions.currentId") || null; } catch { return null; }
}

function emptyState(text) {
  const el = document.createElement("div");
  el.className = "zion-changes-empty";
  el.textContent = text;
  return el;
}

function pathDirname(path) {
  const normalized = String(path || "").replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

function compactDirname(path) {
  const dir = pathDirname(path);
  if (!dir) return "";
  const parts = dir.split("/").filter(Boolean);
  if (parts.length <= 2) return dir;
  return `.../${parts.slice(-2).join("/")}`;
}

function formatDiffCount(value) {
  try {
    return new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1
    }).format(Number(value || 0)).toLowerCase();
  } catch {
    return String(value || 0);
  }
}

function loadChangesPreference(key, fallback) {
  try {
    const raw = window.localStorage?.getItem?.(`zion:changes:${key}`);
    if (raw == null) return fallback;
    return raw === "true";
  } catch {
    return fallback;
  }
}

function saveChangesPreference(key, value) {
  try { window.localStorage?.setItem?.(`zion:changes:${key}`, value ? "true" : "false"); } catch {}
}

function menuButton(label, onClick, tone = "") {
  const btn = document.createElement("button");
  btn.className = `zion-changes-menu-item${tone ? ` is-${tone}` : ""}`;
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const menu = btn.closest(".zion-changes-actions-menu");
    if (menu) menu.removeAttribute("open");
    onClick?.();
  });
  return btn;
}

function canAcceptOrRevert(artifact) {
  const name = normalizeToolName(artifact?.toolName);
  return name === "edit" || name === "fsedit" || name === "write" || name === "fswrite";
}

function emitToolAction(artifact, action) {
  const raw = artifact?.rawTool || {};
  const args = normalizeToolArgs(raw.args);
  const name = normalizeToolName(raw.name);
  const topic = action === "accept"
    ? (name === "write" || name === "fswrite" ? "toolcards/writeAccept" : "toolcards/editAccept")
    : (name === "write" || name === "fswrite" ? "toolcards/writeRevert" : "toolcards/editRevert");
  const payload = {
    id: artifact.toolCallId,
    path: args.path || args.file_path || artifact.path,
    old_string: args.old_string,
    new_string: args.new_string,
    replace_all: args.replace_all,
    content: args.content,
    sessionId: artifact.sessionId || getCurrentSessionId(),
    panelId: window.zion.panels?.getActivePanelId?.() || null
  };
  try { window.zion.events?.emit?.(topic, payload); } catch {}
}

function artifactToText(artifact) {
  if (!artifact) return "";
  if (artifact.patch) return artifact.patch;
  return buildDiffRows(artifact, 2000)
    .map(row => {
      if (row.type === "meta") return row.text;
      const mark = row.type === "add" ? "+" : row.type === "remove" ? "-" : " ";
      return `${mark}${row.text || ""}`;
    })
    .join("\n");
}

async function copyText(text, message) {
  try {
    await navigator.clipboard?.writeText?.(String(text || ""));
    notify(message || t("changes.copied", "Copied"), { type: "success", duration: 2000 });
  } catch {
    notify(t("changes.copyFailed", "Copy failed"), { type: "error", duration: 3000 });
  }
}

function notify(message, options) {
  try {
    const fn = window.zion?.notification?.show;
    if (typeof fn === "function") return fn(String(message ?? ""), options || {});
  } catch {}
  try { console.info("[changes-panel]", message); } catch {}
  return null;
}
