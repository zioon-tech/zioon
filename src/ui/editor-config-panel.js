export function openEditorConfigPanel(host, options = {}) {
  const { sessionId = "", openAccessPanel } = options;
  const STATE_KEY = "ui.editorWidthMode", DEFAULT_MODE = "standard", HEADING_DEFAULT = "xsmall";
    try {
      const existing = document.getElementById("dev-editor-config-panel");
      if (existing) {
        existing.remove();
      }

      const overlay = document.createElement("div");
      overlay.id = "dev-editor-config-panel";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-label", "Editor Configuration");
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
        cb.checked = !!host.state.get(stateKey);
        cb.onchange = () => {
          // prefer calling core command to toggle
          try {
            host.commands.executeCommand(commandToExecute);
          } catch (e) { console.error("toggle command failed", e); }
        };

        // listen for external state changes to keep UI in sync
        const sub = host.state.onDidChange(stateKey, (nv) => {
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

        sel.value = String(host.state.get(stateKey) || "auto");
        sel.onchange = () => {
          try {
            host.commands.executeCommand(commandToExecute, sel.value);
          } catch (e) { console.error("select command failed", e); }
        };

        const sub = host.state.onDidChange(stateKey, (nv) => {
          try { sel.value = String(nv || "auto"); } catch {}
        });
        panelCleanup.push(() => { try { sub.dispose?.(); } catch {} });

        row.appendChild(lbl);
        row.appendChild(sel);
        return row;
      };

      // track panel-local disposables (listeners)
      const panelCleanup = [];
      if (openAccessPanel && sessionId && !sessionId.startsWith("file:")) {
        const accessButton = document.createElement("button");
        accessButton.type = "button";
        accessButton.className = "editor-access-shortcut";
        accessButton.textContent = "访问权限与链接设置…";
        accessButton.onclick = () => openAccessPanel(sessionId);
        panel.appendChild(accessButton);
      }

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
      if (!options.readOnly) {
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
      }
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
          try { host.commands.executeCommand(cmd); } catch (e) { console.error(e); }
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
        const m = host.state.get(STATE_KEY) || DEFAULT_MODE;
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
      const widthSub = host.state.onDidChange(STATE_KEY, updateWidthButtons);
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
          try { host.commands.executeCommand(cmd); } catch (e) { console.error(e); }
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
        const m = host.state.get("ui.headingSize") || HEADING_DEFAULT;
        const reset = (btn) => { btn.style.boxShadow = "none"; };
        [btnMedium, btnSmall, btnXSmall].forEach(reset);
        if (m === "medium") btnMedium.style.boxShadow = "inset 0 0 0 2px var(--accent)";
        else if (m === "small") btnSmall.style.boxShadow = "inset 0 0 0 2px var(--accent)";
        else if (m === "xsmall") btnXSmall.style.boxShadow = "inset 0 0 0 2px var(--accent)";
      };
      updateHeadingButtons();
      const headingSub = host.state.onDidChange("ui.headingSize", updateHeadingButtons);
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

      const originalRemove = overlay.remove.bind(overlay);
      let disposed = false;
      overlay.remove = function () {
        if (disposed) return;
        disposed = true;
        panelCleanup.splice(0).forEach(fn => { try { fn(); } catch {} });
        originalRemove();
      };

      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      const escape = event => { if (event.key === "Escape") overlay.remove(); };
      document.addEventListener("keydown", escape);
      window.addEventListener("pagehide", overlay.remove);
      panelCleanup.push(() => document.removeEventListener("keydown", escape),
        () => window.removeEventListener("pagehide", overlay.remove));
      options.mountAppearance?.(panel, panelCleanup);
      return { dispose: () => overlay.remove() };
    } catch (e) {
      console.error("openConfigPanel error:", e);
    }
  }
