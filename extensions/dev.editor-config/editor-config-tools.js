/**
 * dev.editor-config: tools for LLM
 * - Registers a single aggregated tool "editorConfigSet" to adjust editor settings via parameters.
 * - Parameters are optional; pass only those you want to change.
 */
export function registerEditorTools() {
  try {
    // Define tool schema
    const tool = [
      {
        type: "function",
        function: {
          name: "editorConfigSet",
          description: "设置编辑器配置（传入需要修改的参数即可；未传入的保持不变）。",
          parameters: {
            type: "object",
            properties: {
              line_numbers: { type: "boolean", description: "是否显示行号" },
              active_line_highlight: { type: "boolean", description: "是否高亮当前行" },
              syntax_highlight: { type: "boolean", description: "是否启用语法高亮" },
              auto_indent: { type: "boolean", description: "是否启用自动缩进" },
              folding: { type: "boolean", description: "是否启用折叠功能" },
              line_wrap: { type: "boolean", description: "是否启用自动换行" },
              minimap: { type: "boolean", description: "是否启用迷你地图" },
              selection_highlight: { type: "boolean", description: "是否高亮选择匹配（查找匹配高亮）" },
              width_mode: { type: "string", enum: ["full", "wide", "standard"], description: "编辑器宽度模式" },
              heading_size: { type: "string", enum: ["medium", "small", "xsmall"], description: "标题字号模式" },
              include_tool_history: { type: "boolean", description: "聊天时是否携带历史工具调用信息（assistant.tool_calls 与 role:tool 消息）" },
              include_thinking_history: { type: "boolean", description: "聊天时是否携带历史思考内容（基于思考卡片的文本）" }
            },
            additionalProperties: false
          }
        }
      }
    ];

    // Merge tool into chat.tools (avoid duplicates)
    const existing = window.zion?.state?.get("chat.tools") || [];
    const existNames = new Set(existing.map(t => t?.function?.name).filter(Boolean));
    const merged = existing.slice();
    for (const t of tool) {
      const nm = t?.function?.name;
      if (nm && !existNames.has(nm)) merged.push(t);
    }
    window.zion?.state?.set("chat.tools", merged);

    // Register handler
    const handlers = { ...(window.zion?.state?.get("chat.toolHandlers") || {}) };

    handlers.editorConfigSet = async (args) => {
      try {
        const changes = [];

        const applyBool = async (prop, cmd) => {
          const v = args?.[prop];
          if (typeof v === "boolean") {
            try {
              window.zion?.commands?.executeCommand(cmd, v);
              changes.push(`${prop}=${v ? "on" : "off"}`);
            } catch (e) {
              changes.push(`${prop}=error:${e?.message || String(e)}`);
            }
          }
        };

        await applyBool("line_numbers", "zion.setLineNumbers");
        await applyBool("active_line_highlight", "zion.setActiveLineHighlight");
        await applyBool("syntax_highlight", "zion.setSyntaxHighlight");
        await applyBool("auto_indent", "zion.setAutoIndent");
        await applyBool("folding", "zion.setFolding");
        await applyBool("line_wrap", "zion.setLineWrap");
        await applyBool("minimap", "zion.setMinimap");
        await applyBool("selection_highlight", "zion.setSelectionHighlight");
        await applyBool("include_tool_history", "dev.editor.setIncludeToolHistory");
        await applyBool("include_thinking_history", "dev.editor.setIncludeThinkingHistory");

        const width = String(args?.width_mode || "").trim();
        if (width === "full" || width === "wide" || width === "standard") {
          const cmd =
            width === "full" ? "dev.editor.setWidthFull" :
            width === "wide" ? "dev.editor.setWidthWide" :
            "dev.editor.setWidthStandard";
          try {
            window.zion?.commands?.executeCommand(cmd);
            changes.push(`width_mode=${width}`);
          } catch (e) {
            changes.push(`width_mode=error:${e?.message || String(e)}`);
          }
        }

        const heading = String(args?.heading_size || "").trim();
        if (heading === "medium" || heading === "small" || heading === "xsmall") {
          const map = {
            medium: "dev.editor.setHeadingSizeMedium",
            small: "dev.editor.setHeadingSizeSmall",
            xsmall: "dev.editor.setHeadingSizeXSmall"
          };
          try {
            window.zion?.commands?.executeCommand(map[heading]);
            changes.push(`heading_size=${heading}`);
          } catch (e) {
            changes.push(`heading_size=error:${e?.message || String(e)}`);
          }
        }

        // Snapshot current config
        const snapshot = {
          line_numbers: !!window.zion?.state?.get("ui.lineNumbers"),
          active_line_highlight: !!window.zion?.state?.get("ui.activeLineHighlight"),
          syntax_highlight: !!window.zion?.state?.get("ui.syntaxHighlight"),
          auto_indent: !!window.zion?.state?.get("ui.autoIndent"),
          folding: !!window.zion?.state?.get("ui.folding"),
          line_wrap: !!window.zion?.state?.get("ui.lineWrap"),
          minimap: !!window.zion?.state?.get("ui.minimapEnabled"),
          selection_highlight: !!window.zion?.state?.get("ui.selectionHighlight"),
          width_mode: String(window.zion?.state?.get("ui.editorWidthMode") || "full"),
          heading_size: String(window.zion?.state?.get("ui.headingSize") || "xsmall"),
          include_tool_history: !!window.zion?.state?.get("chat.includeToolHistory"),
          include_thinking_history: !!window.zion?.state?.get("chat.includeThinkingHistory")
        };

        return JSON.stringify({ applied: changes, current: snapshot }, null, 2);
      } catch (e) {
        return `editorConfigSet error: ${e?.message || String(e)}`;
      }
    };

    window.zion?.state?.set("chat.toolHandlers", handlers);

    // Enable list sync: include this tool by default
    try {
      const known = window.zion?.state?.get("chat.toolsKnownNames") || [];
      const names = (window.zion?.state?.get("chat.tools") || [])
        .map(t => t?.function?.name)
        .filter(Boolean);
      window.zion?.state?.set("chat.toolsKnownNames", names);

      let enabled = window.zion?.state?.get("chat.enabledTools");
      if (!Array.isArray(enabled) || enabled.length === 0) {
        window.zion?.state?.set("chat.enabledTools", names);
      } else if (!enabled.includes("editorConfigSet")) {
        window.zion?.state?.set("chat.enabledTools", [...enabled, "editorConfigSet"]);
      }
    } catch {}
  } catch (e) {
    console.warn("[editor-config/tools] register failed", e);
  }
}
