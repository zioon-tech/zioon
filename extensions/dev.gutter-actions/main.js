export async function activate(ctx) {
  const STATE_KEY = "ui.gutterActionsEnabled";
  const CSS_DISABLED_CLASS = "zion-gutter-actions-disabled";

  const readPersisted = () => {
    try {
      const v = localStorage.getItem("zion.gutterActions");
      if (v === "0" || v === "false") return false;
      if (v === "1" || v === "true") return true;
      return true; // default ON
    } catch {
      return true;
    }
  };

  const applyEnabled = (enabled) => {
    try { localStorage.setItem("zion.gutterActions", enabled ? "1" : "0"); } catch {}
    window.zion.state.set(STATE_KEY, Boolean(enabled));
    if (enabled) {
      document.body.classList.remove(CSS_DISABLED_CLASS);
    } else {
      document.body.classList.add(CSS_DISABLED_CLASS);
    }
  };

  // init state
  const initialEnabled = readPersisted();
  window.zion.state.set(STATE_KEY, initialEnabled);
  applyEnabled(initialEnabled);

  // command: toggle
  const dispToggle = window.zion.commands.registerCommand("dev.gutter-actions.toggle", () => {
    const cur = !!window.zion.state.get(STATE_KEY);
    applyEnabled(!cur);
  });
  ctx.subscriptions.push(dispToggle);

  // reflect external state changes (if any)
  const sub = window.zion.state.onDidChange(STATE_KEY, (nv) => {
    const enabled = !!nv;
    try { localStorage.setItem("zion.gutterActions", enabled ? "1" : "0"); } catch {}
    if (enabled) document.body.classList.remove(CSS_DISABLED_CLASS);
    else document.body.classList.add(CSS_DISABLED_CLASS);
  });
  ctx.subscriptions.push({ dispose() { try { sub.dispose?.(); } catch {} } });

  try {
    const reg = window.zion?.__editorHeaderMenuRegistry;
    const disp = reg?.register?.({
      id: "dev.gutter-actions.headerMenu",
      title: "Gutter Actions",
      section: "Editor",
      order: 10,
      kind: "toggle",
      getChecked: () => !!window.zion.state.get(STATE_KEY),
      onClick: () => window.zion.commands.executeCommand("dev.gutter-actions.toggle")
    });
    if (disp) ctx.subscriptions.push(disp);
  } catch {}

  // inject visual extension (custom gutter)
  const { gutterActions } = await import('./gutter-actions.js');
  const d = window.zion.editor.registerDecorator({
    id: "dev.gutter-actions.decorator",
    apply(editor) {
      try {
        editor.addVisualExtension(gutterActions());
      } catch (e) {
        console.error("[dev.gutter-actions] failed to add visual extension", e);
      }
      return { dispose() {} };
    }
  });
  ctx.subscriptions.push(d);

  // --- batch accept/revert commands for context menu ---
  const isRoleHeader = (t) => /^\s*(system|user|assistant|tool)\s+/.test(String(t || ""));

  const findImplicitUserMarkerLine = (doc) => {
    try {
      let firstRoleLine = null;
      for (let i = 1; i <= doc.lines; i++) {
        const ln = doc.line(i);
        if (isRoleHeader(ln.text)) {
          firstRoleLine = i;
          break;
        }
      }
      const limit = firstRoleLine != null ? firstRoleLine : (doc.lines + 1);
      if (limit <= 1) return null;
      for (let i = 1; i < limit; i++) {
        const ln = doc.line(i);
        if (String(ln.text || "").trim()) return i;
      }
      return 1;
    } catch {
      return null;
    }
  };

  let lastContextMenuInfo = null;
  const onContextMenuCapture = (event) => {
    try {
      const editor = window.zion && window.zion.window && window.zion.window.activeEditor;
      const view = editor?.getView?.();
      if (!view?.dom) return;
      const target = event?.target;
      if (!(target instanceof Node) || !view.dom.contains(target)) return;
      const pos = view.posAtCoords?.({ x: event.clientX, y: event.clientY });
      if (typeof pos !== "number") return;
      lastContextMenuInfo = { view, pos, at: Date.now() };
    } catch {}
  };
  document.addEventListener("contextmenu", onContextMenuCapture, true);
  ctx.subscriptions.push({
    dispose() {
      try { document.removeEventListener("contextmenu", onContextMenuCapture, true); } catch {}
    }
  });

  const computeBatchInfoForCursor = () => {
    try {
      const editor = window.zion && window.zion.window && window.zion.window.activeEditor;
      if (!editor) return null;
      const view = editor.getView?.();
      if (!view) return null;
      const doc = view.state.doc;
      let head = view.state.selection.main.head;
      if (lastContextMenuInfo?.view === view && (Date.now() - (lastContextMenuInfo.at || 0)) < 3000) {
        if (typeof lastContextMenuInfo.pos === "number") head = lastContextMenuInfo.pos;
      }
      const curLineNo = doc.lineAt(head).number;
      const line = doc.line(curLineNo);
      const implicitMarkerLine = findImplicitUserMarkerLine(doc);
      const isImplicitUserLine = implicitMarkerLine != null && curLineNo === implicitMarkerLine && !isRoleHeader(line.text);
      const implicitUserStartLine = isImplicitUserLine ? 0 : null;
      const sid = window.zion?.state?.get?.("sessions.currentId");
      const ann = sid ? (window.zion?.commands?.executeCommand?.("zion.chatCards.getSessionAnnotations", sid) || {}) : {};
      const list = Array.isArray(ann.tools) ? ann.tools : [];
      const toolActions = ann && typeof ann.toolActions === "object" ? ann.toolActions : {};

      const idx = window.zion?.state?.get?.("roles.index");
      const blocks = Array.isArray(idx?.blocks) ? idx.blocks : [];
      let role = null;
      let curBlockIndex = -1;
      let range = null;
      let userStartLine = implicitUserStartLine;
      try {
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          if (!b) continue;
          if (typeof b.from !== "number" || typeof b.to !== "number") continue;
          if (head >= b.from && head <= b.to) {
            role = b.role || null;
            curBlockIndex = i;
            break;
          }
        }
      } catch {}
      if (!role) {
        const m = /^\s*(system|user|assistant|tool)\s+/.exec(String(line.text || ""));
        role = m ? m[1] : null;
      }
      if (role === "assistant") {
        const b = curBlockIndex >= 0 ? blocks[curBlockIndex] : null;
        if (b && typeof b.from === "number" && typeof b.to === "number") {
          range = { from: b.from, to: b.to };
        }
        if (curBlockIndex >= 0) {
          for (let i = curBlockIndex - 1; i >= 0; i--) {
            const prev = blocks[i];
            if (!prev) continue;
            if (prev.role === "user") {
              if (typeof prev.startLine === "number") userStartLine = prev.startLine;
              break;
            }
            if (prev.role === "assistant") break;
          }
        }
      } else if (role === "user") {
        if (curBlockIndex >= 0) {
          const cur = blocks[curBlockIndex];
          if (cur && typeof cur.startLine === "number") userStartLine = cur.startLine;
        }
        if (curBlockIndex >= 0) {
          for (let i = curBlockIndex + 1; i < blocks.length; i++) {
            const b = blocks[i];
            if (!b) continue;
            if (b.role === "assistant") {
              if (typeof b.from === "number" && typeof b.to === "number") range = { from: b.from, to: b.to };
              break;
            }
            if (b.role === "user") break;
          }
        } else if (implicitUserStartLine != null) {
          const userIndex = blocks.findIndex(b => b && b.role === "user" && b.startLine === implicitUserStartLine);
          if (userIndex >= 0) {
            for (let i = userIndex + 1; i < blocks.length; i++) {
              const b = blocks[i];
              if (!b) continue;
              if (b.role === "assistant") {
                if (typeof b.from === "number" && typeof b.to === "number") range = { from: b.from, to: b.to };
                break;
              }
              if (b.role === "user") break;
            }
          }
        }
      }

      const filesSet = new Set();
      let total = 0;
      let acceptCount = 0;
      let revertCount = 0;
      const matchesUser = (it) => userStartLine != null && it && it.userStartLine === userStartLine;
      const matchesRange = (it) => range && typeof it.from === "number" && it.from >= range.from && it.from <= range.to;
      const isTargetName = (name) => name === "edit" || name === "write" || name === "fsedit" || name === "fswrite";
      const pickAction = (id, fallback) => {
        const v = id != null ? toolActions[String(id)] : null;
        const a = v?.action || fallback;
        return a === "accept" || a === "revert" ? a : null;
      };
      const matchedByUser = userStartLine != null ? list.filter(it => matchesUser(it) && isTargetName(String(it?.name || ""))) : [];
      const candidates = matchedByUser.length
        ? matchedByUser
        : (range ? list.filter(it => matchesRange(it) && isTargetName(String(it?.name || ""))) : []);
      for (const it of candidates) {
        total += 1;
        const path = it.args?.path;
        if (typeof path === "string" && path.trim()) filesSet.add(path);
        const action = pickAction(it.id, it.action);
        if (action === "accept") acceptCount += 1;
        if (action === "revert") revertCount += 1;
      }
      const state = acceptCount === total ? "accepted" : (revertCount === total ? "reverted" : "mixed");
      return { total, acceptCount, revertCount, files: filesSet.size, role, range, state, userStartLine };
    } catch (e) {
      return null;
    }
  };

  const doBatchAccept = () => {
    const batch = computeBatchInfoForCursor();
    if (batch?.range) {
      const panelId = window.zion?.panels?.getActivePanelId?.() || null;
      const sessionId = panelId
        ? (window.zion?.panelManager?.getPanel?.(panelId)?.activeTabId
          || window.zion?.panels?.list?.().find((panel) => panel.id === panelId)?.activeTabId
          || null)
        : (window.zion?.state?.get?.("sessions.currentId") || null);
      return window.zion?.events?.emit("toolcards/batchAccept", { userStartLine: batch.userStartLine, from: batch.range.from, to: batch.range.to, panelId, sessionId });
    }
    window.zion?.notification?.show?.("未找到目标 assistant 范围", { type: "info", duration: 2200 });
  };

  const doBatchRevert = () => {
    const batch = computeBatchInfoForCursor();
    if (batch?.range) {
      const panelId = window.zion?.panels?.getActivePanelId?.() || null;
      const sessionId = panelId
        ? (window.zion?.panelManager?.getPanel?.(panelId)?.activeTabId
          || window.zion?.panels?.list?.().find((panel) => panel.id === panelId)?.activeTabId
          || null)
        : (window.zion?.state?.get?.("sessions.currentId") || null);
      return window.zion?.events?.emit("toolcards/batchRevert", { userStartLine: batch.userStartLine, from: batch.range.from, to: batch.range.to, panelId, sessionId });
    }
    window.zion?.notification?.show?.("未找到目标 assistant 范围", { type: "info", duration: 2200 });
  };

  ctx.subscriptions.push(window.zion.commands.registerCommand("dev.gutter-actions.batchAccept", doBatchAccept));
  ctx.subscriptions.push(window.zion.commands.registerCommand("dev.gutter-actions.batchRevert", doBatchRevert));

  // --- context menu registration with dynamic titles ---
  try {
    const makeAcceptTitle = () => {
      const b = computeBatchInfoForCursor();
      if (!b) return "批量 Accept";
      if (!b.total) return "批量 Accept";
      return `批量 Accept (${b.acceptCount}/${b.total})`;
    };
    const makeRevertTitle = () => {
      const b = computeBatchInfoForCursor();
      if (!b) return "批量 Revert";
      if (!b.total) return "批量 Revert";
      return `批量 Revert (${b.revertCount}/${b.total})`;
    };

    ctx.subscriptions.push(window.zion.menus.register("editor/context", {
      command: "dev.gutter-actions.batchAccept",
      when: "editorFocus",
      dynamicTitle: makeAcceptTitle
    }));
    ctx.subscriptions.push(window.zion.menus.register("editor/context", {
      command: "dev.gutter-actions.batchRevert",
      when: "editorFocus",
      dynamicTitle: makeRevertTitle
    }));
  } catch (e) {
    console.warn("[dev.gutter-actions] context menu registration failed", e);
  }

  // ensure body class matches current state on load
  if (!initialEnabled) {
    document.body.classList.add(CSS_DISABLED_CLASS);
  } else {
    document.body.classList.remove(CSS_DISABLED_CLASS);
  }
}
