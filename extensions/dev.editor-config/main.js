import { registerEditorTools } from "./editor-config-tools.js";
export async function activate(ctx) {
  // Keep registering commands & keybindings, but do not create per-feature status items.
  const cmds = [
    { id: "dev.editor.toggleLineNumbers", core: "zion.toggleLineNumbers", stateKey: "ui.lineNumbers" },
    { id: "dev.editor.toggleActiveLineHighlight", core: "zion.toggleActiveLineHighlight", stateKey: "ui.activeLineHighlight" },
    { id: "dev.editor.toggleSyntaxHighlight", core: "zion.toggleSyntaxHighlight", stateKey: "ui.syntaxHighlight" },
    { id: "dev.editor.toggleAutoIndent", core: "zion.toggleAutoIndent", stateKey: "ui.autoIndent" },
    { id: "dev.editor.toggleFolding", core: "zion.toggleFolding", stateKey: "ui.folding" },
    { id: "dev.editor.toggleLineWrap", core: "zion.toggleLineWrap", stateKey: "ui.lineWrap" },
    { id: "dev.editor.toggleMinimap", core: "zion.toggleMinimap", stateKey: "ui.minimapEnabled" }
  ];

  for (const c of cmds) {
    const d = window.zion.commands.registerCommand(c.id, () => {
      window.zion.commands.executeCommand(c.core);
    });
    ctx.subscriptions.push(d);

    // register keybinding (preserve previous mapping intent)
    const kb = window.zion.keybindings.register({
      command: c.id,
      key:
        c.id === "dev.editor.toggleLineNumbers"
          ? "Mod-Shift-L"
          : c.id === "dev.editor.toggleFolding"
          ? "Mod-Shift-F"
          : c.id === "dev.editor.toggleSyntaxHighlight"
          ? "Mod-Shift-S"
          : c.id === "dev.editor.toggleAutoIndent"
          ? "Mod-Shift-I"
          : "Mod-Shift-H",
      when: "editorFocus"
    });
    ctx.subscriptions.push(kb);
  }

  // Editor width mode: full / wide / standard (same as before)
  const STATE_KEY = "ui.editorWidthMode";
  const DEFAULT_MODE = "full";
  const getMode = () => window.zion.state.get(STATE_KEY) || DEFAULT_MODE;
  const setMode = (mode) => {
    const m = mode === "full" || mode === "wide" || mode === "standard" ? mode : DEFAULT_MODE;
    window.zion.state.set(STATE_KEY, m);
    try { localStorage.setItem("zion.editorWidthMode", m); } catch {}
  };
  try {
    const saved = localStorage.getItem("zion.editorWidthMode");
    if (saved && (saved === "full" || saved === "wide" || saved === "standard")) {
      window.zion.state.set(STATE_KEY, saved);
    } else {
      window.zion.state.set(STATE_KEY, DEFAULT_MODE);
    }
  } catch {
    window.zion.state.set(STATE_KEY, DEFAULT_MODE);
  }

  const applyWidthMode = (editor) => {
    const mode = getMode();
    const cm = editor?.getView?.()?.dom || null;
    if (!cm) return;
    const scroller = cm.querySelector(".cm-scroller") || cm;

    // reset common styles
    scroller.style.maxWidth = "";
    scroller.style.width = "";
    scroller.style.marginLeft = "";
    scroller.style.marginRight = "";
    scroller.style.paddingLeft = "";
    scroller.style.paddingRight = "";
    scroller.style.boxSizing = "";
    scroller.style.display = "";
    scroller.style.minWidth = "";
    cm.style.width = "";

    if (mode === "full") {
      // full: occupy available width
      cm.style.width = "100%";
      scroller.style.width = "100%";
    } else if (mode === "wide") {
      // wide mode: content centered with max-width, scrollbar on right edge
      cm.style.width = "100%";
      scroller.style.width = "100%";
      // Use padding on scroller to center content area
      const maxWidth = 960;
      scroller.style.boxSizing = "border-box";
      scroller.style.paddingLeft = "calc((100% - " + maxWidth + "px) / 2)";
      scroller.style.paddingRight = "calc((100% - " + maxWidth + "px) / 2)";
      scroller.style.minWidth = "0"; // Allow content to shrink
    } else {
      // standard mode: content centered with max-width, scrollbar on right edge
      cm.style.width = "100%";
      scroller.style.width = "100%";
      // Use padding on scroller to center content area
      const maxWidth = 720;
      scroller.style.boxSizing = "border-box";
      scroller.style.paddingLeft = "calc((100% - " + maxWidth + "px) / 2)";
      scroller.style.paddingRight = "calc((100% - " + maxWidth + "px) / 2)";
      scroller.style.minWidth = "0"; // Allow content to shrink
    }
  };

  // Decorator to apply width mode reactively
  const widthDecDisp = window.zion.editor.registerDecorator({
    id: "dev.editor.width-mode",
    apply(editor) {
      applyWidthMode(editor);
      const sub = window.zion.state.onDidChange(STATE_KEY, () => applyWidthMode(editor));
      return {
        dispose() {
          try {
            const cm = editor?.getView?.()?.dom || null;
            const scroller = cm?.querySelector(".cm-scroller") || cm;
            if (scroller) {
              scroller.style.maxWidth = "";
              scroller.style.width = "";
              scroller.style.marginLeft = "";
              scroller.style.marginRight = "";
              scroller.style.paddingLeft = "";
              scroller.style.paddingRight = "";
              scroller.style.boxSizing = "";
              scroller.style.display = "";
              scroller.style.minWidth = "";
            }
            if (cm) {
              cm.style.width = "";
            }
          } catch {}
          try { sub.dispose?.(); } catch {}
        }
      };
    }
  });
  ctx.subscriptions.push(widthDecDisp);

  // Commands to set/cycle width mode (keep existing)
  const cFull = window.zion.commands.registerCommand("dev.editor.setWidthFull", () => setMode("full"));
  const cWide = window.zion.commands.registerCommand("dev.editor.setWidthWide", () => setMode("wide"));
  const cStd = window.zion.commands.registerCommand("dev.editor.setWidthStandard", () => setMode("standard"));
  const cCycle = window.zion.commands.registerCommand("dev.editor.cycleWidthMode", () => {
    const m = getMode();
    const next = m === "standard" ? "wide" : m === "wide" ? "full" : "standard";
    setMode(next);
  });
  ctx.subscriptions.push(cFull, cWide, cStd, cCycle);

  // keybinding: cycle width mode
  const kbCycle = window.zion.keybindings.register({ command: "dev.editor.cycleWidthMode", key: "Mod-Shift-B", when: "editorFocus" });
  ctx.subscriptions.push(kbCycle);

  // Selection highlight init
  try {
    let selV = true;
    try {
      const v = localStorage.getItem("zion.selectionHighlight");
      if (v === "0" || v === "false") selV = false;
      if (v === "1" || v === "true") selV = true;
    } catch {}
    window.zion.state.set("ui.selectionHighlight", selV);
    try { window.zion.commands.executeCommand("zion.setSelectionHighlight", selV); } catch {}

    const toggleSel = window.zion.commands.registerCommand("dev.editor.toggleSelectionHighlight", () => {
      try { return window.zion.commands.executeCommand("zion.toggleSelectionHighlight"); } catch (e) { console.error(e); return false; }
    });
    ctx.subscriptions.push(toggleSel);

    try {
      const reg = window.zion?.__editorHeaderMenuRegistry;
      const disp = reg?.register?.({
        id: "dev.editor.selectionHighlight.headerMenu",
        title: "Selection Highlight",
        section: "Editor",
        order: 20,
        kind: "toggle",
        getChecked: () => !!window.zion.state.get("ui.selectionHighlight"),
        onClick: () => window.zion.commands.executeCommand("zion.toggleSelectionHighlight")
      });
      if (disp) ctx.subscriptions.push(disp);
    } catch {}
  } catch (e) {
    // ignore
  }

  try {
    const STATE_KEY = "ui.roleUserBlockBackground";
    const LS_KEY = "zion.roleUserBlockBackground";
    const apply = (enabled) => {
      try {
        document.documentElement.setAttribute("data-role-user-block-bg", enabled ? "1" : "0");
      } catch {}
    };
    const readStored = () => {
      try {
        const v = localStorage.getItem(LS_KEY);
        if (v === "0" || v === "false") return false;
        if (v === "1" || v === "true") return true;
      } catch {}
      return true;
    };

    const init = readStored();
    window.zion.state.set(STATE_KEY, init);
    apply(init);
    const sub = window.zion.state.onDidChange(STATE_KEY, (nv) => apply(!!nv));
    ctx.subscriptions.push({ dispose() { try { sub.dispose?.(); } catch {} } });

    const setEnabled = window.zion.commands.registerCommand("dev.editor.setUserRoleBlockBackground", (val) => {
      const b = !!val;
      try { localStorage.setItem(LS_KEY, b ? "1" : "0"); } catch {}
      window.zion.state.set(STATE_KEY, b);
      apply(b);
      return b;
    });
    const toggleEnabled = window.zion.commands.registerCommand("dev.editor.toggleUserRoleBlockBackground", () => {
      const cur = !!window.zion.state.get(STATE_KEY);
      return window.zion.commands.executeCommand("dev.editor.setUserRoleBlockBackground", !cur);
    });
    ctx.subscriptions.push(setEnabled, toggleEnabled);

    try {
      const reg = window.zion?.__editorHeaderMenuRegistry;
      const disp = reg?.register?.({
        id: "dev.editor.userRoleBlockBackground.headerMenu",
        title: "User Block Background",
        section: "Chat",
        order: 76,
        kind: "toggle",
        getChecked: () => !!window.zion.state.get(STATE_KEY),
        onClick: () => window.zion.commands.executeCommand("dev.editor.toggleUserRoleBlockBackground")
      });
      if (disp) ctx.subscriptions.push(disp);
    } catch {}
  } catch {}

  try {
    const reg = window.zion?.__editorHeaderMenuRegistry;
    if (reg?.register) {
      const register = (it) => {
        try {
          const disp = reg.register(it);
          if (disp) ctx.subscriptions.push(disp);
        } catch {}
      };

      register({ id: "dev.editor.menu.openConfigPanel", title: "Editor Config…", section: "Editor", kind: "action", order: 40, onClick: () => openConfigPanel() });

      register({ id: "dev.editor.menu.lineNumbers", title: "Line Numbers", section: "Editor", kind: "toggle", order: 41, getChecked: () => !!window.zion.state.get("ui.lineNumbers"), onClick: () => window.zion.commands.executeCommand("dev.editor.toggleLineNumbers") });
      register({ id: "dev.editor.menu.activeLineHighlight", title: "Active Line Highlight", section: "Editor", kind: "toggle", order: 42, getChecked: () => !!window.zion.state.get("ui.activeLineHighlight"), onClick: () => window.zion.commands.executeCommand("dev.editor.toggleActiveLineHighlight") });
      register({ id: "dev.editor.menu.syntaxHighlight", title: "Syntax Highlight", section: "Editor", kind: "toggle", order: 43, getChecked: () => !!window.zion.state.get("ui.syntaxHighlight"), onClick: () => window.zion.commands.executeCommand("dev.editor.toggleSyntaxHighlight") });
      register({ id: "dev.editor.menu.autoIndent", title: "Auto Indent", section: "Editor", kind: "toggle", order: 44, getChecked: () => !!window.zion.state.get("ui.autoIndent"), onClick: () => window.zion.commands.executeCommand("dev.editor.toggleAutoIndent") });
      register({ id: "dev.editor.menu.folding", title: "Folding", section: "Editor", kind: "toggle", order: 45, getChecked: () => !!window.zion.state.get("ui.folding"), onClick: () => window.zion.commands.executeCommand("dev.editor.toggleFolding") });
      register({ id: "dev.editor.menu.lineWrap", title: "Line Wrap", section: "Editor", kind: "toggle", order: 46, getChecked: () => !!window.zion.state.get("ui.lineWrap"), onClick: () => window.zion.commands.executeCommand("dev.editor.toggleLineWrap") });
      register({ id: "dev.editor.menu.minimap", title: "Minimap", section: "Editor", kind: "toggle", order: 47, getChecked: () => !!window.zion.state.get("ui.minimapEnabled"), onClick: () => window.zion.commands.executeCommand("dev.editor.toggleMinimap") });

      register({ id: "dev.editor.menu.width.standard", title: "Width: Standard", section: "Layout", kind: "toggle", order: 50, getChecked: () => String(window.zion.state.get("ui.editorWidthMode") || "full") === "standard", onClick: () => window.zion.commands.executeCommand("dev.editor.setWidthStandard") });
      register({ id: "dev.editor.menu.width.wide", title: "Width: Wide", section: "Layout", kind: "toggle", order: 51, getChecked: () => String(window.zion.state.get("ui.editorWidthMode") || "full") === "wide", onClick: () => window.zion.commands.executeCommand("dev.editor.setWidthWide") });
      register({ id: "dev.editor.menu.width.full", title: "Width: Full", section: "Layout", kind: "toggle", order: 52, getChecked: () => String(window.zion.state.get("ui.editorWidthMode") || "full") === "full", onClick: () => window.zion.commands.executeCommand("dev.editor.setWidthFull") });

      register({ id: "dev.editor.menu.heading.medium", title: "Heading: Medium", section: "Layout", kind: "toggle", order: 60, getChecked: () => String(window.zion.state.get("ui.headingSize") || "xsmall") === "medium", onClick: () => window.zion.commands.executeCommand("dev.editor.setHeadingSizeMedium") });
      register({ id: "dev.editor.menu.heading.small", title: "Heading: Small", section: "Layout", kind: "toggle", order: 61, getChecked: () => String(window.zion.state.get("ui.headingSize") || "xsmall") === "small", onClick: () => window.zion.commands.executeCommand("dev.editor.setHeadingSizeSmall") });
      register({ id: "dev.editor.menu.heading.xsmall", title: "Heading: XSmall", section: "Layout", kind: "toggle", order: 62, getChecked: () => String(window.zion.state.get("ui.headingSize") || "xsmall") === "xsmall", onClick: () => window.zion.commands.executeCommand("dev.editor.setHeadingSizeXSmall") });

      register({ id: "dev.editor.menu.includeToolHistory", title: "Include Tool History", section: "Chat", kind: "toggle", order: 70, getChecked: () => !!window.zion.state.get("chat.includeToolHistory"), onClick: () => window.zion.commands.executeCommand("dev.editor.toggleIncludeToolHistory") });
      register({ id: "dev.editor.menu.includeThinkingHistory", title: "Include Thinking History", section: "Chat", kind: "toggle", order: 71, getChecked: () => !!window.zion.state.get("chat.includeThinkingHistory"), onClick: () => window.zion.commands.executeCommand("dev.editor.toggleIncludeThinkingHistory") });
      const getRcMode = () => String(window.zion.state.get("chat.toolCallsReasoningContentMode") || "auto");
      register({ id: "dev.editor.menu.toolCallsRc.auto", title: "Tool Calls reasoning: Auto", section: "Chat", kind: "toggle", order: 73, getChecked: () => getRcMode() === "auto", onClick: () => window.zion.commands.executeCommand("dev.editor.setToolCallsReasoningContentMode", "auto") });
      register({ id: "dev.editor.menu.toolCallsRc.always", title: "Tool Calls reasoning: Always", section: "Chat", kind: "toggle", order: 74, getChecked: () => getRcMode() === "always", onClick: () => window.zion.commands.executeCommand("dev.editor.setToolCallsReasoningContentMode", "always") });
      register({ id: "dev.editor.menu.toolCallsRc.never", title: "Tool Calls reasoning: Never", section: "Chat", kind: "toggle", order: 75, getChecked: () => getRcMode() === "never", onClick: () => window.zion.commands.executeCommand("dev.editor.setToolCallsReasoningContentMode", "never") });
    }
  } catch {}

  // Include Tool History init (persist + commands)
  try {
    let incV = true;
    try {
      const v = localStorage.getItem("zion.includeToolHistory");
      if (v === "0" || v === "false") incV = false;
      if (v === "1" || v === "true") incV = true;
    } catch {}
    window.zion.state.set("chat.includeToolHistory", incV);

    const setInc = window.zion.commands.registerCommand("dev.editor.setIncludeToolHistory", (val) => {
      const b = !!val;
      try { localStorage.setItem("zion.includeToolHistory", b ? "1" : "0"); } catch {}
      window.zion.state.set("chat.includeToolHistory", b);
      return b;
    });
    const toggleInc = window.zion.commands.registerCommand("dev.editor.toggleIncludeToolHistory", () => {
      const cur = !!window.zion.state.get("chat.includeToolHistory");
      return window.zion.commands.executeCommand("dev.editor.setIncludeToolHistory", !cur);
    });
    ctx.subscriptions.push(setInc, toggleInc);
  } catch (e) {
    // ignore
  }

  // Include Thinking History init (persist + commands)
  try {
    let thV = true;
    try {
      const v = localStorage.getItem("zion.includeThinkingHistory");
      if (v === "0" || v === "false") thV = false;
      if (v === "1" || v === "true") thV = true;
    } catch {}
    window.zion.state.set("chat.includeThinkingHistory", thV);

    const setThinking = window.zion.commands.registerCommand("dev.editor.setIncludeThinkingHistory", (val) => {
      const b = !!val;
      try { localStorage.setItem("zion.includeThinkingHistory", b ? "1" : "0"); } catch {}
      window.zion.state.set("chat.includeThinkingHistory", b);
      return b;
    });
    const toggleThinking = window.zion.commands.registerCommand("dev.editor.toggleIncludeThinkingHistory", () => {
      const cur = !!window.zion.state.get("chat.includeThinkingHistory");
      return window.zion.commands.executeCommand("dev.editor.setIncludeThinkingHistory", !cur);
    });
    ctx.subscriptions.push(setThinking, toggleThinking);
  } catch (e) {
    // ignore
  }

  // Tool Calls reasoning_content mode init (persist + commands)
  try {
    const STATE_KEY = "chat.toolCallsReasoningContentMode";
    const LS_KEY = "zion.toolCallsReasoningContentMode";
    const normalize = (v) => {
      const s = String(v || "").trim().toLowerCase();
      if (s === "always" || s === "never" || s === "auto") return s;
      return "auto";
    };

    let mode = "auto";
    try {
      mode = normalize(localStorage.getItem(LS_KEY));
    } catch {}
    window.zion.state.set(STATE_KEY, mode);

    const setMode = window.zion.commands.registerCommand("dev.editor.setToolCallsReasoningContentMode", (val) => {
      const m = normalize(val);
      try { localStorage.setItem(LS_KEY, m); } catch {}
      window.zion.state.set(STATE_KEY, m);
      return m;
    });

    const cycleMode = window.zion.commands.registerCommand("dev.editor.cycleToolCallsReasoningContentMode", () => {
      const cur = normalize(window.zion.state.get(STATE_KEY));
      const next = cur === "auto" ? "always" : cur === "always" ? "never" : "auto";
      return window.zion.commands.executeCommand("dev.editor.setToolCallsReasoningContentMode", next);
    });
    ctx.subscriptions.push(setMode, cycleMode);
  } catch (e) {
    // ignore
  }

  // Minimap init: load persisted preference and delegate actual enabling to core via zion commands bridge.
  try {
    const MINIMAP_KEY_GLOBAL = "zion.minimap";
    const minimapKeyForSession = (sid) => sid ? `zion.minimap.session.${sid}` : MINIMAP_KEY_GLOBAL;
    const getStoredBool = (key) => {
      try {
        const v = localStorage.getItem(key);
        if (v == null) return undefined;
        if (v === "0" || v === "false") return false;
        if (v === "1" || v === "true") return true;
        return undefined;
      } catch {
        return undefined;
      }
    };
    const getCurrentSessionId = () => {
      try {
        const sid = window.zion.state.get("sessions.currentId");
        return sid ? String(sid) : "";
      } catch {
        return "";
      }
    };
    const readMinimapPref = (sid) => {
      const per = sid ? getStoredBool(minimapKeyForSession(sid)) : undefined;
      if (typeof per === "boolean") return per;
      const legacy = getStoredBool(MINIMAP_KEY_GLOBAL);
      if (typeof legacy === "boolean") return legacy;
      return false;
    };
    const persistMinimapPref = (sid, enabled) => {
      try { localStorage.setItem(minimapKeyForSession(sid), enabled ? "1" : "0"); } catch {}
    };
    const applyMinimap = (enabled) => {
      window.zion.state.set("ui.minimapEnabled", !!enabled);
      try { window.zion.commands.executeCommand("zion.setMinimap", !!enabled); } catch {}
    };
    const applyMinimapForSession = (sid) => {
      const v = readMinimapPref(sid);
      applyMinimap(v);
      return v;
    };

    const minV = applyMinimapForSession(getCurrentSessionId());

    // expose extension-level toggle that just calls the core bridge
    const dm = window.zion.commands.registerCommand("dev.editor.toggleMinimap", () => {
      try {
        const sid = getCurrentSessionId();
        const cur = !!window.zion.state.get("ui.minimapEnabled");
        const next = !cur;
        persistMinimapPref(sid, next);
        window.zion.commands.executeCommand("zion.setMinimap", next);
        return next;
      } catch (e) {
        console.error(e);
        return false;
      }
    });
    ctx.subscriptions.push(dm);

  } catch (e) {
    // ignore
  }

  /* ===== Heading Size (state + commands + init) ===== */
  const HEADING_STATE_KEY = "ui.headingSize";
  const HEADING_DEFAULT = "xsmall";
  const getHeading = () => window.zion.state.get(HEADING_STATE_KEY) || HEADING_DEFAULT;
  const applyHeadingSize = () => {
    const mode = getHeading();
    try { document.documentElement.setAttribute("data-heading-size", mode); } catch {}
  };
  const setHeading = (mode) => {
    const m = (mode === "medium" || mode === "small" || mode === "xsmall") ? mode : HEADING_DEFAULT;
    window.zion.state.set(HEADING_STATE_KEY, m);
    try { localStorage.setItem("zion.headingSize", m); } catch {}
    applyHeadingSize();
  };

  // init from localStorage (persisted)
  try {
    const saved = localStorage.getItem("zion.headingSize");
    if (saved && (saved === "medium" || saved === "small" || saved === "xsmall")) {
      window.zion.state.set(HEADING_STATE_KEY, saved);
    } else {
      window.zion.state.set(HEADING_STATE_KEY, HEADING_DEFAULT);
    }
  } catch {
    window.zion.state.set(HEADING_STATE_KEY, HEADING_DEFAULT);
  }
  applyHeadingSize();
  const headingStateSub = window.zion.state.onDidChange(HEADING_STATE_KEY, applyHeadingSize);
  ctx.subscriptions.push({ dispose() { try { headingStateSub.dispose?.(); } catch {} } });

  // commands
  const hMed = window.zion.commands.registerCommand("dev.editor.setHeadingSizeMedium", () => setHeading("medium"));
  const hSml = window.zion.commands.registerCommand("dev.editor.setHeadingSizeSmall", () => setHeading("small"));
  const hXSml = window.zion.commands.registerCommand("dev.editor.setHeadingSizeXSmall", () => setHeading("xsmall"));
  const hCycle = window.zion.commands.registerCommand("dev.editor.cycleHeadingSize", () => {
    const m = getHeading();
    const next = m === "medium" ? "small" : m === "small" ? "xsmall" : "medium";
    setHeading(next);
  });
  ctx.subscriptions.push(hMed, hSml, hXSml, hCycle);

  // Build and open the config panel
  function openConfigPanel() {
    try {
      const existing = document.getElementById("dev-editor-config-panel");
      if (existing) {
        existing.remove();
      }

      const overlay = document.createElement("div");
      overlay.id = "dev-editor-config-panel";
      overlay.style.position = "fixed";
      overlay.style.inset = "0";
      overlay.style.background = "rgba(0,0,0,0.35)";
      overlay.style.zIndex = "99998";
      overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

      const panel = document.createElement("div");
      panel.style.position = "fixed";
      panel.style.right = "20px";
      panel.style.top = "80px";
      panel.style.width = "320px";
      panel.style.maxHeight = "70vh";
      panel.style.overflow = "auto";
      panel.style.background = "var(--panel)";
      panel.style.border = "1px solid var(--border)";
      panel.style.borderRadius = "6px";
      panel.style.boxShadow = "0 8px 24px rgba(0,0,0,0.35)";
      panel.style.padding = "12px";
      panel.style.zIndex = "99999";
      panel.style.color = "var(--fg)";
      panel.onclick = (e) => e.stopPropagation();

      const title = document.createElement("div");
      title.textContent = "Editor Configuration";
      title.style.fontWeight = "600";
      title.style.marginBottom = "8px";
      panel.appendChild(title);

      // helper to create toggle rows
      const makeToggleRow = (stateKey, labelText, commandToExecute) => {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.justifyContent = "space-between";
        row.style.padding = "6px 0";

        const lbl = document.createElement("label");
        lbl.textContent = labelText;
        lbl.style.fontSize = "13px";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!window.zion.state.get(stateKey);
        cb.onchange = () => {
          // prefer calling core command to toggle
          try {
            window.zion.commands.executeCommand(commandToExecute);
          } catch (e) { console.error("toggle command failed", e); }
        };

        // listen for external state changes to keep UI in sync
        const sub = window.zion.state.onDidChange(stateKey, (nv) => {
          try { cb.checked = !!nv; } catch {}
        });

        // attach cleanup when panel closes
        panelCleanup.push(() => { try { sub.dispose?.(); } catch {} });

        row.appendChild(lbl);
        row.appendChild(cb);
        return row;
      };

      const makeSelectRow = (stateKey, labelText, options, commandToExecute) => {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.justifyContent = "space-between";
        row.style.padding = "6px 0";

        const lbl = document.createElement("label");
        lbl.textContent = labelText;
        lbl.style.fontSize = "13px";

        const sel = document.createElement("select");
        sel.style.fontSize = "12px";
        sel.style.padding = "4px 6px";
        sel.style.border = "1px solid var(--border)";
        sel.style.borderRadius = "4px";
        sel.style.background = "var(--panel)";
        sel.style.color = "var(--fg)";

        for (const opt of options) {
          const o = document.createElement("option");
          o.value = opt.value;
          o.textContent = opt.label;
          sel.appendChild(o);
        }

        sel.value = String(window.zion.state.get(stateKey) || "auto");
        sel.onchange = () => {
          try {
            window.zion.commands.executeCommand(commandToExecute, sel.value);
          } catch (e) { console.error("select command failed", e); }
        };

        const sub = window.zion.state.onDidChange(stateKey, (nv) => {
          try { sel.value = String(nv || "auto"); } catch {}
        });
        panelCleanup.push(() => { try { sub.dispose?.(); } catch {} });

        row.appendChild(lbl);
        row.appendChild(sel);
        return row;
      };

      // track panel-local disposables (listeners)
      const panelCleanup = [];

      // toggles
      const togglesContainer = document.createElement("div");
      togglesContainer.style.marginBottom = "8px";
      togglesContainer.appendChild(makeToggleRow("ui.lineNumbers", "Line Numbers", "zion.toggleLineNumbers"));
      togglesContainer.appendChild(makeToggleRow("ui.activeLineHighlight", "Active Line Highlight", "zion.toggleActiveLineHighlight"));
      togglesContainer.appendChild(makeToggleRow("ui.syntaxHighlight", "Syntax Highlight", "zion.toggleSyntaxHighlight"));
      togglesContainer.appendChild(makeToggleRow("ui.autoIndent", "Auto Indent", "zion.toggleAutoIndent"));
      togglesContainer.appendChild(makeToggleRow("ui.folding", "Folding", "zion.toggleFolding"));
      togglesContainer.appendChild(makeToggleRow("ui.lineWrap", "Line Wrap", "zion.toggleLineWrap"));
      togglesContainer.appendChild(makeToggleRow("ui.minimapEnabled", "Minimap", "dev.editor.toggleMinimap"));
      togglesContainer.appendChild(makeToggleRow("ui.selectionHighlight", "Selection Highlight", "zion.toggleSelectionHighlight"));
      togglesContainer.appendChild(makeToggleRow("chat.includeToolHistory", "Include Tool History in Chat", "dev.editor.toggleIncludeToolHistory"));
      togglesContainer.appendChild(makeToggleRow("chat.includeThinkingHistory", "Include Thinking in Chat", "dev.editor.toggleIncludeThinkingHistory"));
      togglesContainer.appendChild(makeSelectRow(
        "chat.toolCallsReasoningContentMode",
        "Tool Calls reasoning_content",
        [
          { value: "auto", label: "Auto" },
          { value: "always", label: "Always" },
          { value: "never", label: "Never" }
        ],
        "dev.editor.setToolCallsReasoningContentMode"
      ));
      panel.appendChild(togglesContainer);

      // width mode controls
      const widthTitle = document.createElement("div");
      widthTitle.textContent = "Editor Width";
      widthTitle.style.fontWeight = "600";
      widthTitle.style.marginTop = "6px";
      widthTitle.style.marginBottom = "6px";
      panel.appendChild(widthTitle);

      const widthGroup = document.createElement("div");
      widthGroup.style.display = "flex";
      widthGroup.style.justifyContent = "space-between";
      widthGroup.style.gap = "8px";

      const makeWidthBtn = (mode, text, cmd) => {
        const b = document.createElement("button");
        b.textContent = text;
        b.style.flex = "1";
        b.style.padding = "6px 8px";
        b.style.borderRadius = "4px";
        b.style.border = "1px solid var(--border)";
        b.style.background = "var(--panel)";
        b.style.color = "var(--fg)";
        b.onclick = () => {
          try { window.zion.commands.executeCommand(cmd); } catch (e) { console.error(e); }
        };
        return b;
      };

      const btnStd = makeWidthBtn("standard", "Standard", "dev.editor.setWidthStandard");
      const btnWide = makeWidthBtn("wide", "Wide", "dev.editor.setWidthWide");
      const btnFull = makeWidthBtn("full", "Full", "dev.editor.setWidthFull");
      widthGroup.appendChild(btnStd);
      widthGroup.appendChild(btnWide);
      widthGroup.appendChild(btnFull);
      panel.appendChild(widthGroup);

      // reflect current selection (highlight active width)
      const updateWidthButtons = () => {
        const m = window.zion.state.get(STATE_KEY) || DEFAULT_MODE;
        const resetStyle = (btn) => {
          btn.style.outline = "none";
          btn.style.boxShadow = "none";
        };
        [btnStd, btnWide, btnFull].forEach(resetStyle);
        if (m === "standard") { btnStd.style.boxShadow = "inset 0 0 0 2px var(--accent)"; }
        else if (m === "wide") { btnWide.style.boxShadow = "inset 0 0 0 2px var(--accent)"; }
        else if (m === "full") { btnFull.style.boxShadow = "inset 0 0 0 2px var(--accent)"; }
      };
      updateWidthButtons();
      const widthSub = window.zion.state.onDidChange(STATE_KEY, updateWidthButtons);
      panelCleanup.push(() => { try { widthSub.dispose?.(); } catch {} });

      /* ===== Heading Size controls ===== */
      const headingTitle = document.createElement("div");
      headingTitle.textContent = "Heading Size";
      headingTitle.style.fontWeight = "600";
      headingTitle.style.marginTop = "10px";
      headingTitle.style.marginBottom = "6px";
      panel.appendChild(headingTitle);

      const headingGroup = document.createElement("div");
      headingGroup.style.display = "flex";
      headingGroup.style.justifyContent = "space-between";
      headingGroup.style.gap = "8px";

      const makeHeadingBtn = (mode, text, cmd) => {
        const b = document.createElement("button");
        b.textContent = text;
        b.style.flex = "1";
        b.style.padding = "6px 8px";
        b.style.borderRadius = "4px";
        b.style.border = "1px solid var(--border)";
        b.style.background = "var(--panel)";
        b.style.color = "var(--fg)";
        b.title = `Set Heading Size: ${mode}`;
        b.onclick = () => {
          try { window.zion.commands.executeCommand(cmd); } catch (e) { console.error(e); }
        };
        return b;
      };

      const btnMedium = makeHeadingBtn("medium", "适中", "dev.editor.setHeadingSizeMedium");
      const btnSmall = makeHeadingBtn("small", "小", "dev.editor.setHeadingSizeSmall");
      const btnXSmall = makeHeadingBtn("xsmall", "再小", "dev.editor.setHeadingSizeXSmall");
      headingGroup.appendChild(btnMedium);
      headingGroup.appendChild(btnSmall);
      headingGroup.appendChild(btnXSmall);
      panel.appendChild(headingGroup);

      const updateHeadingButtons = () => {
        const m = window.zion.state.get("ui.headingSize") || HEADING_DEFAULT;
        const reset = (btn) => { btn.style.boxShadow = "none"; };
        [btnMedium, btnSmall, btnXSmall].forEach(reset);
        if (m === "medium") btnMedium.style.boxShadow = "inset 0 0 0 2px var(--accent)";
        else if (m === "small") btnSmall.style.boxShadow = "inset 0 0 0 2px var(--accent)";
        else if (m === "xsmall") btnXSmall.style.boxShadow = "inset 0 0 0 2px var(--accent)";
      };
      updateHeadingButtons();
      const headingSub = window.zion.state.onDidChange("ui.headingSize", updateHeadingButtons);
      panelCleanup.push(() => { try { headingSub.dispose?.(); } catch {} });

      // footer
      const footer = document.createElement("div");
      footer.style.marginTop = "12px";
      footer.style.display = "flex";
      footer.style.justifyContent = "flex-end";
      footer.style.gap = "8px";

      const closeBtn = document.createElement("button");
      closeBtn.textContent = "Close";
      closeBtn.style.background = "var(--border)";
      closeBtn.style.color = "var(--fg)";
      closeBtn.style.border = "1px solid var(--accent)";
      closeBtn.style.borderRadius = "4px";
      closeBtn.style.padding = "6px 10px";
      closeBtn.onclick = () => overlay.remove();

      footer.appendChild(closeBtn);
      panel.appendChild(footer);

      // cleanup when overlay removed
      overlay.addEventListener("remove", () => {
        try { panelCleanup.forEach(fn => { try { fn(); } catch {} }); } catch {}
      });

      // ensure cleanup runs when overlay is removed by click handler
      const originalRemove = overlay.remove.bind(overlay);
      overlay.remove = function () {
        try { panelCleanup.forEach(fn => { try { fn(); } catch {} }); } catch {}
        originalRemove();
      };

      overlay.appendChild(panel);
      document.body.appendChild(overlay);
    } catch (e) {
      console.error("openConfigPanel error:", e);
    }
  }

  const getBool = (key, fallback = false) => {
    const value = window.zion.state.get(key);
    return typeof value === "boolean" ? value : fallback;
  };
  const getString = (key, fallback = "") => {
    const value = window.zion.state.get(key);
    return typeof value === "string" && value ? value : fallback;
  };
  const setStoredState = (stateKey, storageKey, value) => {
    window.zion.state.set(stateKey, value);
    try {
      localStorage.setItem(storageKey, typeof value === "string" ? value : JSON.stringify(value));
    } catch {}
  };

  try {
    window.zion.settings.registerPage({
      id: "appearance.preferences",
      pluginId: "dev.editor-config",
      category: "general",
      title: "Appearance",
      description: "主题与页面呈现",
      order: 12,
      sections: [
        {
          id: "appearance.basics",
          title: "外观",
          settings: [
            {
              id: "appearance.theme",
              kind: "select",
              label: "主题",
              description: "切换整体明暗风格",
              enumOptions: [
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" }
              ],
              getValue: () => String(window.zion.state.get("ui.theme") || "dark"),
              setValue: async (value) => window.zion.commands.executeCommand("zion.setTheme", value === "light" ? "light" : "dark")
            },
            {
              id: "appearance.editorWidthMode",
              kind: "select",
              label: "编辑区域宽度",
              description: "控制正文区域的横向宽度",
              enumOptions: [
                { value: "standard", label: "标准" },
                { value: "wide", label: "宽" },
                { value: "full", label: "全宽" }
              ],
              getValue: () => getString(STATE_KEY, DEFAULT_MODE),
              setValue: async (value) => {
                if (value === "wide") return window.zion.commands.executeCommand("dev.editor.setWidthWide");
                if (value === "full") return window.zion.commands.executeCommand("dev.editor.setWidthFull");
                return window.zion.commands.executeCommand("dev.editor.setWidthStandard");
              }
            },
            {
              id: "appearance.headingSize",
              kind: "select",
              label: "标题尺寸",
              description: "调整页面里标题的视觉大小",
              enumOptions: [
                { value: "medium", label: "适中" },
                { value: "small", label: "较小" },
                { value: "xsmall", label: "更小" }
              ],
              getValue: () => getString(HEADING_STATE_KEY, HEADING_DEFAULT),
              setValue: async (value) => {
                if (value === "small") return window.zion.commands.executeCommand("dev.editor.setHeadingSizeSmall");
                if (value === "xsmall") return window.zion.commands.executeCommand("dev.editor.setHeadingSizeXSmall");
                return window.zion.commands.executeCommand("dev.editor.setHeadingSizeMedium");
              }
            },
            {
              id: "appearance.roleUserBlockBackground",
              kind: "boolean",
              label: "用户消息底色",
              description: "为用户消息块增加轻微背景区分",
              getValue: () => getBool("ui.roleUserBlockBackground", false),
              setValue: async (value) => window.zion.commands.executeCommand("dev.editor.setUserRoleBlockBackground", !!value)
            }
          ]
        }
      ]
    });

    window.zion.settings.registerPage({
      id: "editor.preferences",
      pluginId: "dev.editor-config",
      category: "editor",
      title: "Editor",
      description: "常用编辑器偏好",
      order: 14,
      sections: [
        {
          id: "editor.basics",
          title: "基础体验",
          settings: [
            {
              id: "editor.wysiwyg",
              kind: "boolean",
              label: "所见即所得",
              description: "在编辑时显示更接近最终排版的效果",
              getValue: () => getBool("ui.wysiwyg", false),
              setValue: async (value) => window.zion.commands.executeCommand("zion.setWysiwyg", !!value)
            },
            {
              id: "editor.lineWrap",
              kind: "boolean",
              label: "自动换行",
              description: "长行内容自动折到下一行",
              getValue: () => getBool("ui.lineWrap", false),
              setValue: async (value) => window.zion.commands.executeCommand("zion.setLineWrap", !!value)
            },
            {
              id: "editor.minimap",
              kind: "boolean",
              label: "迷你地图",
              description: "在右侧显示文档缩略预览",
              getValue: () => getBool("ui.minimapEnabled", true),
              setValue: async (value) => window.zion.commands.executeCommand("zion.setMinimap", !!value)
            },
            {
              id: "editor.lineNumbers",
              kind: "boolean",
              label: "行号",
              description: "显示每一行的序号",
              getValue: () => getBool("ui.lineNumbers", false),
              setValue: async (value) => window.zion.commands.executeCommand("zion.setLineNumbers", !!value)
            },
            {
              id: "editor.activeLineHighlight",
              kind: "boolean",
              label: "当前行高亮",
              description: "突出当前所在行",
              getValue: () => getBool("ui.activeLineHighlight", false),
              setValue: async (value) => window.zion.commands.executeCommand("zion.setActiveLineHighlight", !!value)
            },
            {
              id: "editor.syntaxHighlight",
              kind: "boolean",
              label: "语法高亮",
              description: "为代码与标记内容提供颜色区分",
              getValue: () => getBool("ui.syntaxHighlight", false),
              setValue: async (value) => window.zion.commands.executeCommand("zion.setSyntaxHighlight", !!value)
            },
            {
              id: "editor.autoIndent",
              kind: "boolean",
              label: "自动缩进",
              description: "换行时继承上一行缩进",
              getValue: () => getBool("ui.autoIndent", false),
              setValue: async (value) => window.zion.commands.executeCommand("zion.setAutoIndent", !!value)
            },
            {
              id: "editor.folding",
              kind: "boolean",
              label: "折叠",
              description: "允许折叠标题和代码块",
              getValue: () => getBool("ui.folding", false),
              setValue: async (value) => window.zion.commands.executeCommand("zion.setFolding", !!value)
            },
            {
              id: "editor.selectionHighlight",
              kind: "boolean",
              label: "选中高亮",
              description: "同步高亮当前选中的重复内容",
              getValue: () => getBool("ui.selectionHighlight", true),
              setValue: async (value) => window.zion.commands.executeCommand("zion.setSelectionHighlight", !!value)
            }
          ]
        },
        {
          id: "editor.chat",
          title: "聊天编辑偏好",
          settings: [
            {
              id: "editor.includeToolHistory",
              kind: "boolean",
              label: "带上工具历史",
              description: "在聊天上下文里包含工具调用历史",
              getValue: () => getBool("chat.includeToolHistory", true),
              setValue: async (value) => setStoredState("chat.includeToolHistory", "zion.includeToolHistory", !!value)
            },
            {
              id: "editor.includeThinkingHistory",
              kind: "boolean",
              label: "带上思考历史",
              description: "在聊天上下文里包含推理过程历史",
              getValue: () => getBool("chat.includeThinkingHistory", true),
              setValue: async (value) => setStoredState("chat.includeThinkingHistory", "zion.includeThinkingHistory", !!value)
            },
            {
              id: "editor.toolReasoningMode",
              kind: "select",
              label: "工具推理内容",
              description: "控制工具调用里的 reasoning_content 是否保留",
              enumOptions: [
                { value: "auto", label: "自动" },
                { value: "always", label: "总是保留" },
                { value: "never", label: "不保留" }
              ],
              getValue: () => getString("chat.toolCallsReasoningContentMode", "auto"),
              setValue: async (value) => {
                const next = value === "always" || value === "never" ? value : "auto";
                setStoredState("chat.toolCallsReasoningContentMode", "zion.toolCallsReasoningContentMode", next);
              }
            },
            {
              id: "editor.openAdvancedPanel",
              kind: "action",
              label: "高级编辑器设置",
              description: "打开完整编辑器配置面板",
              actionLabel: "打开高级配置",
              action: async () => openConfigPanel()
            }
          ]
        }
      ]
    });
  } catch (e) {
    console.error("[dev.editor-config] register settings pages failed", e);
  }

  // Register the aggregated editor-config tools for LLM usage
  try { registerEditorTools(); } catch {}

  // Register slash commands for editor features
  try {
    const slashCommands = [
      {
        id: "dev.editor.toggleLineNumbers",
        triggers: ["linenumbers", "ln", "line-numbers"],
        title: "切换行号",
        description: "显示/隐藏行号"
      },
      {
        id: "dev.editor.toggleSyntaxHighlight",
        triggers: ["syntax", "sh", "syntax-highlight"],
        title: "切换语法高亮",
        description: "显示/隐藏语法高亮"
      },
      {
        id: "dev.editor.toggleActiveLineHighlight",
        triggers: ["highlight", "ah", "active-highlight"],
        title: "切换行高亮",
        description: "显示/隐藏当前行高亮"
      },
      {
        id: "dev.editor.toggleLineWrap",
        triggers: ["wrap", "line-wrap", "autowrap"],
        title: "切换自动换行",
        description: "启用/禁用自动换行"
      },
      {
        id: "dev.editor.cycleWidthMode",
        triggers: ["width", "editor-width", "cycle-width"],
        title: "切换编辑器宽度",
        description: "循环切换编辑器宽度 (标准/宽/全屏)"
      },
      {
        id: "dev.editor.toggleSelectionHighlight",
        triggers: ["selection-highlight", "sel-highlight"],
        title: "切换选择高亮",
        description: "显示/隐藏选择内容高亮"
      }
    ];

    slashCommands.forEach(cmd => {
      const d = window.zion.slash?.registerCommand?.({
        id: cmd.id,
        trigger: cmd.triggers,
        title: cmd.title,
        description: cmd.description,
        category: "editor",
        icon: "⚙️",
        priority: 50,
        execute: () => {
          window.zion.commands.executeCommand(cmd.id);
        }
      });
      if (d) ctx.subscriptions.push(d);
    });
  } catch (e) {
    console.error("[dev.editor-config] Error registering slash commands:", e);
  }
}
