/**
 * dev.session-manager: session tools for LLM (IDB-backed via main extension)
 * - Delegate storage to main session-manager commands and state
 */
import {
  sessionGetToolDefinition,
  sessionCreateToolDefinition,
  sessionUpdateToolDefinition,
  sessionDeleteToolDefinition,
  sessionListToolDefinition,
  listSessionsFromSnapshot
} from "./session-runtime-shared.js";

export function registerSessionTools() {
  try {
    /* ===== Utils ===== */
    function workbenchSessionSnapshot() {
      return {
        tree: window.zion?.state?.get("sessions.treeMem") || { id: "root", type: "folder", title: "Sessions", children: [] },
        index: window.zion?.state?.get("sessions.catalog") || []
      };
    }

    /* ===== Tools definitions ===== */
    const tools = [
      {
        type: "function",
        function: {
          name: sessionListToolDefinition().name,
          description: sessionListToolDefinition().description,
          parameters: sessionListToolDefinition().inputSchema
        }
      },
      {
        type: "function",
        function: {
          name: sessionGetToolDefinition().name,
          description: sessionGetToolDefinition().description,
          parameters: sessionGetToolDefinition().inputSchema
        }
      },
      {
        type: "function",
        function: {
          name: sessionCreateToolDefinition({ includeOpen: true }).name,
          description: sessionCreateToolDefinition({ includeOpen: true }).description,
          parameters: sessionCreateToolDefinition({ includeOpen: true }).inputSchema
        }
      },
      {
        type: "function",
        function: {
          name: sessionUpdateToolDefinition().name,
          description: sessionUpdateToolDefinition().description,
          parameters: sessionUpdateToolDefinition().inputSchema
        }
      },
      {
        type: "function",
        function: {
          name: sessionDeleteToolDefinition().name,
          description: sessionDeleteToolDefinition().description,
          parameters: sessionDeleteToolDefinition().inputSchema
        }
      }
    ];

    /* Merge tools into chat.tools (avoid duplicates) */
    const existing = window.zion?.state?.get("chat.tools") || [];
    const existNames = new Set(existing.map(t => t?.function?.name).filter(Boolean));
    const merged = existing.slice();
    for (const t of tools) {
      const nm = t?.function?.name;
      if (nm && !existNames.has(nm)) merged.push(t);
    }
    window.zion?.state?.set("chat.tools", merged);

    /* Handlers */
    const handlers = { ...(window.zion?.state?.get("chat.toolHandlers") || {}) };

    handlers.sessionList = async (args) => {
      try {
        const result = listSessionsFromSnapshot(workbenchSessionSnapshot(), {
          ...args,
          current_id: window.zion?.state?.get("sessions.currentId") || ""
        });
        if (!result.ok) return result.error || "Session list failed";
        return JSON.stringify(result.tree || result.sessions || [], null, 2);
      } catch (e) {
        return `sessionList error: ${e?.message || String(e)}`;
      }
    };

    handlers.sessionGet = async (args) => {
      try {
        const id = String(args?.id || "").trim();
        if (!id) return "Missing id";
        const includeDoc = args?.include_doc !== false;
        const includeMeta = args?.include_meta !== false;
        const meta = includeMeta ? window.zion?.commands?.executeCommand("zion.sessions.getMeta", id) : undefined;
        const doc = includeDoc ? window.zion?.commands?.executeCommand("zion.sessions.getDoc", id) : undefined;
        const idx = (window.zion?.state?.get("sessions.catalog") || []);
        const exists = !!idx.find((s) => s.id === id);
        if (!exists) return "Session not found";
        return JSON.stringify({ id, meta, doc }, null, 2);
      } catch (e) {
        return `sessionGet error: ${e?.message || String(e)}`;
      }
    };

    handlers.sessionCreate = async (args) => {
      try {
        const title = String(args?.title || "").trim();
        const content = String(args?.content ?? "");
        const parentId = String(args?.parent_id || "").trim() || undefined;
        window.zion?.commands?.executeCommand("zion.sessions.new", { title, content, parentId });
        return JSON.stringify({ ok: true }, null, 2);
      } catch (e) {
        return `sessionCreate error: ${e?.message || String(e)}`;
      }
    };

    handlers.sessionUpdate = async (args) => {
      try {
        const id = String(args?.id || "").trim();
        const updateType = String(args?.update_type || "").trim();
        if (!id) return "Missing id";
        if (updateType !== "content" && updateType !== "title") return "Missing or invalid update_type (use 'content' or 'title')";

        if (updateType === "title") {
          // Rename (merged from sessionRename)
          const title = String(args?.title || "").trim();
          if (!title) return "Missing title for rename";
          window.zion?.commands?.executeCommand("zion.sessions.rename", { id, title });
          return JSON.stringify({ ok: true, id }, null, 2);
        } else {
          // Edit content (merged from sessionEdit)
          const mode = String(args?.mode || "").trim();
          const content = String(args?.content ?? "");
          const newline = args?.newline !== false;
          if (mode !== "append" && mode !== "overwrite") return "Invalid mode (use 'append' or 'overwrite')";
          const cur = window.zion?.commands?.executeCommand("zion.sessions.getDoc", id) || "";
          const text = mode === "append" ? (cur + ((newline && cur && !cur.endsWith("\n")) ? "\n" : "") + content) : content;
          window.zion?.commands?.executeCommand("zion.sessions.setDoc", { id, text });
          // update meta.updatedAt similar to edit path
          window.zion?.commands?.executeCommand("zion.sessions.bumpUpdatedAt", id);
          return JSON.stringify({ ok: true, id }, null, 2);
        }
      } catch (e) {
        return `sessionUpdate error: ${e?.message || String(e)}`;
      }
    };

    handlers.sessionDelete = async (args) => {
      try {
        const id = String(args?.id || "").trim();
        if (!id) return "Missing id";
        window.zion?.commands?.executeCommand("zion.sessions.delete", id);
        return JSON.stringify({ ok: true, id }, null, 2);
      } catch (e) {
        return `sessionDelete error: ${e?.message || String(e)}`;
      }
    };

    window.zion?.state?.set("chat.toolHandlers", handlers);
    // Let dev.tools auto-sync enabled tool list if active
    try {
      const known = window.zion?.state?.get("chat.toolsKnownNames") || [];
      const names = (window.zion?.state?.get("chat.tools") || []).map(t => t?.function?.name).filter(Boolean);
      window.zion?.state?.set("chat.toolsKnownNames", names);
      // If enabledTools not set, default to all
      let enabled = window.zion?.state?.get("chat.enabledTools");
      if (!Array.isArray(enabled) || enabled.length === 0) {
        window.zion?.state?.set("chat.enabledTools", names);
      }
    } catch {}
  } catch (e) {
    console.warn("[session-tools] register failed", e);
  }
}
