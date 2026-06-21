import {
  buildDiffRows,
  normalizeToolArgs,
  normalizeToolName,
  statusLabel
} from "./artifact-model.js";
import { getCurrentSessionChangeState, normalizeChangePath, subscribeSessionChangeState } from "./session-change-state.js";
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
  return interpolate(fallback || key, values);
}

function interpolate(text, values) {
  if (!values || typeof values !== "object") return String(text || "");
  return String(text || "").replace(/\{([^}]+)\}/g, (_, key) => String(values[key] ?? ""));
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
  let summaryMode = loadChangesPreference("summaryMode", false);
  const expandedIds = new Set();
  let disposed = false;
  let renderTimer = 0;
  let syncTimer = 0;
  let currentItems = [];
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
      currentItems = [];
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
    const fileGroups = buildFileGroups(changeState);
    const displayItems = summaryMode ? fileGroups : allArtifacts;
    const totals = { added: changeState.summary.addedLines, removed: changeState.summary.removedLines };
    const selectedDisplayId = summaryMode ? resolveSelectedGroupId(fileGroups) : resolveSelectedArtifactId(allArtifacts);

    currentItems = displayItems;

    root.replaceChildren(renderHeader(displayItems.length, totals, displayItems));

    const scroll = document.createElement("div");
    scroll.className = "zion-changes-scroll";
    root.appendChild(scroll);

    if (!allArtifacts.length) {
      scroll.appendChild(emptyState(t("changes.empty", "No file changes in the current session yet. Diffs from edit, write, or apply_patch tools will appear here.")));
      return;
    }

    for (const item of displayItems) {
      scroll.appendChild(summaryMode
        ? renderFileGroupSection(item, item.id === selectedDisplayId)
        : renderArtifactSection(item, item.toolCallId === selectedDisplayId));
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
    const nextState = getCurrentSessionChangeState();
    const nextArtifacts = nextState.artifacts;
    const nextGroups = buildFileGroups(nextState);
    const nextItems = summaryMode ? nextGroups : nextArtifacts;
    const scroll = root.querySelector(".zion-changes-scroll");
    const previousScrollTop = scroll ? scroll.scrollTop : 0;
    const hadItems = currentItems.length > 0;
    const hasItems = nextItems.length > 0;
    if (!hadItems || !hasItems) {
      currentItems = nextItems;
      render();
      return;
    }

    const selectedDisplayId = summaryMode ? resolveSelectedGroupId(nextGroups) : resolveSelectedArtifactId(nextArtifacts);

    updateHeader(nextItems.length, { added: nextState.summary.addedLines, removed: nextState.summary.removedLines }, nextItems);
    const existing = new Map();
    for (const section of scroll.querySelectorAll(".zion-changes-section")) {
      const id = summaryMode ? section.dataset.fileId : section.dataset.toolCallId;
      if (id) existing.set(id, section);
    }
    const nextIds = new Set(nextItems.map(item => summaryMode ? item.id : item.toolCallId));
    for (const [id, section] of existing.entries()) {
      if (!nextIds.has(id)) section.remove();
    }

    let cursor = null;
    for (const item of nextItems) {
      const itemId = summaryMode ? item.id : item.toolCallId;
      const active = itemId === selectedDisplayId;
      const prev = currentItems.find(prevItem => (summaryMode ? prevItem.id : prevItem.toolCallId) === itemId);
      let section = existing.get(itemId) || null;
      const changed = !section || (summaryMode ? groupFingerprint(prev) !== groupFingerprint(item) : artifactFingerprint(prev) !== artifactFingerprint(item));
      if (changed) {
        const nextSection = summaryMode ? renderFileGroupSection(item, active) : renderArtifactSection(item, active);
        if (section) section.replaceWith(nextSection);
        else if (cursor?.nextSibling) scroll.insertBefore(nextSection, cursor.nextSibling);
        else scroll.appendChild(nextSection);
        section = nextSection;
      } else {
        section.classList.toggle("is-active", active);
        section.classList.toggle("is-expanded", summaryMode ? isGroupExpanded(item) : expandedIds.has(item.toolCallId));
      }
      if (cursor && section.previousSibling !== cursor) scroll.insertBefore(section, cursor.nextSibling);
      else if (!cursor && section !== scroll.firstElementChild) scroll.insertBefore(section, scroll.firstElementChild);
      cursor = section;
    }
    currentItems = nextItems;
    if (shouldScrollSelected) {
      shouldScrollSelected = false;
      scrollSelectedIntoView();
    } else {
      scroll.scrollTop = previousScrollTop;
    }
  }

  function updateHeader(count, totals, items) {
    const prevHeader = root.querySelector(".zion-changes-header");
    if (!prevHeader) {
      root.prepend(renderHeader(count, totals, items));
      return;
    }
    const stats = prevHeader.querySelector(".zion-changes-stats");
    if (stats) fillHeaderStats(stats, count, totals);
    const summary = prevHeader.querySelector("[data-changes-action='summary']");
    if (summary) {
      summary.classList.toggle("is-active", summaryMode);
      summary.title = summaryMode ? t("changes.showIndividual", "Show individual changes") : t("changes.showSummary", "Show file summary");
    }
    const expand = prevHeader.querySelector("[data-changes-action='expand']");
    if (expand) {
      const allExpanded = allItemsExpanded(items);
      expand.title = allExpanded ? t("changes.collapseAll", "Collapse all files") : t("changes.expandAll", "Expand all files");
      expand.textContent = allExpanded ? t("changes.collapse", "Collapse") : t("changes.expand", "Expand");
    }
  }

  function renderHeader(count, totals, items) {
    const header = document.createElement("div");
    header.className = "zion-changes-header";

    const stats = document.createElement("div");
    stats.className = "zion-changes-stats";
    fillHeaderStats(stats, count, totals);

    header.appendChild(stats);
    const controls = document.createElement("div");
    controls.className = "zion-changes-header-controls";

    const summary = document.createElement("button");
    summary.className = `zion-changes-icon-button${summaryMode ? " is-active" : ""}`;
    summary.dataset.changesAction = "summary";
    summary.type = "button";
    summary.title = summaryMode ? t("changes.showIndividual", "Show individual changes") : t("changes.showSummary", "Show file summary");
    summary.textContent = t("changes.summary", "Summary");
    summary.addEventListener("click", () => {
      summaryMode = !summaryMode;
      saveChangesPreference("summaryMode", summaryMode);
      render();
    });

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

    const allExpanded = allItemsExpanded(items);
    const expand = document.createElement("button");
    expand.className = "zion-changes-icon-button";
    expand.dataset.changesAction = "expand";
    expand.type = "button";
    expand.title = allExpanded ? t("changes.collapseAll", "Collapse all files") : t("changes.expandAll", "Expand all files");
    expand.textContent = allExpanded ? t("changes.collapse", "Collapse") : t("changes.expand", "Expand");
    expand.addEventListener("click", () => {
      if (allExpanded) {
        expandedIds.clear();
      } else {
        for (const item of items) expandedIds.add(summaryMode ? item.id : item.toolCallId);
      }
      render();
    });

    const refresh = document.createElement("button");
    refresh.className = "zion-changes-icon-button";
    refresh.type = "button";
    refresh.textContent = t("changes.refresh", "Refresh");
    refresh.addEventListener("click", scheduleRender);

    if (items.length) {
      controls.appendChild(summary);
      controls.appendChild(wrap);
      controls.appendChild(expand);
    }
    controls.appendChild(refresh);
    header.appendChild(controls);
    return header;
  }

  function fillHeaderStats(stats, count, totals) {
    stats.replaceChildren();
    const countText = document.createElement("span");
    countText.textContent = summaryMode
      ? t("changes.files", "{count} files", { count })
      : t("changes.items", "{count} changes", { count });
    const add = document.createElement("span");
    add.className = "is-add";
    add.textContent = `+${totals.added}`;
    const remove = document.createElement("span");
    remove.className = "is-remove";
    remove.textContent = `-${totals.removed}`;
    stats.appendChild(countText);
    stats.appendChild(add);
    stats.appendChild(remove);
  }

  function allItemsExpanded(items) {
    return items.length > 0 && items.every(item => expandedIds.has(summaryMode ? item.id : item.toolCallId));
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

  function renderFileGroupSection(group, active) {
    const expanded = isGroupExpanded(group);
    const section = document.createElement("section");
    section.className = `zion-changes-section${active ? " is-active" : ""}${expanded ? " is-expanded" : ""}`;
    section.dataset.fileId = group.id;

    const row = document.createElement("div");
    row.className = "zion-changes-section-header";
    const toggle = document.createElement("button");
    toggle.className = "zion-changes-section-toggle";
    toggle.type = "button";
    toggle.title = group.path;
    toggle.addEventListener("click", () => {
      selectedId = group.id;
      if (expandedIds.has(group.id)) {
        expandedIds.delete(group.id);
      } else {
        expandedIds.add(group.id);
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
    name.textContent = group.basename || group.path;
    const dir = document.createElement("span");
    dir.className = "zion-changes-section-dir";
    dir.textContent = compactDirname(group.path);
    dir.title = pathDirname(group.path);
    const fileText = document.createElement("span");
    fileText.className = "zion-changes-section-filetext";
    fileText.appendChild(name);
    if (dir.textContent) fileText.appendChild(dir);
    left.appendChild(chevron);
    left.appendChild(fileText);

    const right = document.createElement("div");
    right.className = "zion-changes-section-right";
    if (group.changeCount > 1) {
      const badge = document.createElement("span");
      badge.className = "zion-changes-kind is-modified";
      badge.textContent = t("changes.changeCount", "{count} changes", { count: group.changeCount });
      right.appendChild(badge);
    } else if (group.kind === "created" || group.kind === "deleted") {
      const badge = document.createElement("span");
      badge.className = `zion-changes-kind is-${group.kind}`;
      badge.textContent = group.kind === "created" ? t("changes.new", "New") : t("changes.deleted", "Deleted");
      right.appendChild(badge);
    }

    const status = document.createElement("span");
    status.className = `zion-changes-status is-${group.status}`;
    status.textContent = statusLabel(group.status);
    const stats = document.createElement("span");
    stats.className = "zion-changes-file-meta";
    stats.innerHTML = `<span class="is-add">+${formatDiffCount(group.addedLines || 0)}</span><span class="is-remove">-${formatDiffCount(group.removedLines || 0)}</span>`;
    right.appendChild(status);
    right.appendChild(stats);

    toggle.appendChild(left);
    toggle.appendChild(right);
    row.appendChild(toggle);

    row.appendChild(renderGroupActionsMenu(group));
    section.appendChild(row);

    if (expanded) {
      const body = document.createElement("div");
      body.className = "zion-changes-section-body";
      body.appendChild(renderFileGroupBody(group));
      section.appendChild(body);
    }
    return section;
  }

  function renderFileGroupBody(group) {
    const wrap = document.createElement("div");
    wrap.className = "zion-changes-file-group-body";
    const artifacts = group.artifacts || [];
    for (const artifact of artifacts) {
      if (artifacts.length > 1) wrap.appendChild(renderArtifactSubhead(artifact));
      wrap.appendChild(renderArtifactBody(artifact));
    }
    return wrap;
  }

  function renderArtifactSubhead(artifact) {
    const row = document.createElement("div");
    row.className = "zion-changes-artifact-subhead";
    const label = document.createElement("span");
    label.className = "zion-changes-artifact-label";
    label.textContent = `${normalizeToolName(artifact.toolName) || "tool"} · ${statusLabel(artifact.status)}`;
    const stats = document.createElement("span");
    stats.className = "zion-changes-file-meta";
    stats.innerHTML = `<span class="is-add">+${formatDiffCount(artifact.addedLines || 0)}</span><span class="is-remove">-${formatDiffCount(artifact.removedLines || 0)}</span>`;
    row.appendChild(label);
    row.appendChild(stats);
    row.appendChild(renderActionsMenu(artifact));
    return row;
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

  function renderGroupActionsMenu(group) {
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
    menu.appendChild(menuButton(t("changes.copyPath", "Copy Path"), () => copyText(group.path, t("changes.pathCopied", "Path copied"))));
    menu.appendChild(menuButton(t("changes.copyDiff", "Copy Diff"), () => copyText(groupToText(group), t("changes.diffCopied", "Diff copied"))));
    if (group.artifacts.length === 1 && canAcceptOrRevert(group.artifacts[0])) {
      menu.appendChild(menuButton(t("changes.accept", "Accept"), () => emitToolAction(group.artifacts[0], "accept"), "primary"));
      menu.appendChild(menuButton(t("changes.revert", "Revert"), () => emitToolAction(group.artifacts[0], "revert"), "danger"));
    }
    details.appendChild(menu);
    return details;
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
        const id = summaryMode ? el.dataset.fileId : el.dataset.toolCallId;
        if (id === selectedId) {
          try { el.scrollIntoView({ block: "nearest" }); } catch {}
          break;
        }
      }
    }, 0);
  }

  function resolveSelectedGroupId(groups) {
    if (!groups.length) {
      selectedId = null;
      return null;
    }
    const selected = String(selectedId || "");
    let group = selected ? groups.find(item =>
      item.id === selected ||
      item.path === selected ||
      item.artifacts.some(artifact => artifact.toolCallId === selected || artifact.id === selected)
    ) : null;
    if (!group) group = groups[0];
    if (selected && group.artifacts.some(artifact => artifact.toolCallId === selected || artifact.id === selected)) {
      expandedIds.add(group.id);
    }
    selectedId = group.id;
    return group.id;
  }

  function resolveSelectedArtifactId(artifacts) {
    if (!artifacts.length) {
      selectedId = null;
      return null;
    }
    const selected = String(selectedId || "");
    let artifact = selected ? artifacts.find(item => item.toolCallId === selected || item.id === selected || normalizeChangePath(item.path) === selected) : null;
    if (!artifact) artifact = artifacts[0];
    selectedId = artifact.toolCallId;
    return artifact.toolCallId;
  }

  function isGroupExpanded(group) {
    return !!group && (expandedIds.has(group.id) || group.artifacts.some(artifact => expandedIds.has(artifact.toolCallId) || expandedIds.has(artifact.id)));
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

function buildFileGroups(changeState) {
  const sourceGroups = changeState?.byPath instanceof Map
    ? Array.from(changeState.byPath.values())
    : [];
  return sourceGroups.map((entry) => {
    const artifacts = Array.isArray(entry.artifacts) ? entry.artifacts : [];
    const latest = artifacts[artifacts.length - 1] || {};
    const path = normalizeChangePath(entry.path || latest.path || "");
    return {
      id: path,
      path,
      basename: pathBasename(path),
      artifacts,
      latestArtifact: latest,
      kind: artifacts.length === 1 ? latest.kind : "modified",
      status: summarizeGroupStatus(artifacts),
      addedLines: Number(entry.addedLines || 0),
      removedLines: Number(entry.removedLines || 0),
      changeCount: artifacts.length
    };
  }).filter(group => group.id);
}

function summarizeGroupStatus(artifacts) {
  const statuses = (Array.isArray(artifacts) ? artifacts : []).map(item => item?.status || "unknown");
  if (!statuses.length) return "unknown";
  if (statuses.includes("failed")) return "failed";
  if (statuses.every(status => status === "accepted")) return "accepted";
  if (statuses.every(status => status === "reverted")) return "reverted";
  if (statuses.includes("pending")) return "pending";
  return "unknown";
}

function groupFingerprint(group) {
  if (!group) return "";
  return [
    group.id,
    group.path,
    group.status,
    group.addedLines || 0,
    group.removedLines || 0,
    ...(group.artifacts || []).map(artifactFingerprint)
  ].join("\u001e");
}

function groupToText(group) {
  const parts = [];
  for (const artifact of group?.artifacts || []) {
    parts.push(`# ${artifact.toolName || "tool"} ${artifact.path || group.path}`);
    parts.push(artifactToText(artifact));
  }
  return parts.filter(Boolean).join("\n\n");
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

function pathBasename(path) {
  const parts = String(path || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || String(path || "");
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
