/**
 * dev.session-manager: session tools for LLM (IDB-backed via main extension)
 * - Delegate storage to main session-manager commands and state
 */
export function registerSessionTools() {
  try {
    /* ===== Utils ===== */
    function safeJSONParse(text, fallback) { try { return JSON.parse(text); } catch { return fallback; } }
    function deepCloneNode(node) { try { return JSON.parse(JSON.stringify(node)); } catch { return node; } }
    function markCurrentInTree(node, currentId) {
      try {
        if (!node || !currentId) return;
        if (node.type === "session") { if (node.id === currentId) node.current = true; return; }
        if (node.type === "folder" && Array.isArray(node.children)) {
          let has = false;
          node.children.forEach(ch => {
            markCurrentInTree(ch, currentId);
            if (ch && (ch.current || ch.hasCurrent)) has = true;
          });
          if (has) node.hasCurrent = true;
        }
      } catch {}
    }

    /* ===== Tools definitions ===== */
    const tools = [
      {
        type: "function",
        function: {
          name: "sessionsIndex",
          description: "List all sessions (flat index). Returns id, title, updatedAt, size, hash, createdAt.",
          parameters: {
            type: "object",
            properties: {
              sort_by: { type: "string", enum: ["updated", "title"], description: "Sort order (default: updated)" },
              limit: { type: "number", description: "Limit the number of items (optional)" }
            },
            additionalProperties: false
          }
        }
      },
      {
        type: "function",
        function: {
          name: "sessionsTree",
          description: "Get sessions tree (folders + sessions). Optionally return a subtree by folder_id.",
          parameters: {
            type: "object",
            properties: {
              folder_id: { type: "string", description: "Folder id to return only its subtree (optional)" }
            },
            additionalProperties: false
          }
        }
      },
      {
        type: "function",
        function: {
          name: "sessionGet",
          description: "Get a session's doc and meta by id. Ensure that the provided id is an existing session id when calling this function.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, description: "Session id" },
              include_doc: { type: "boolean", description: "Include doc content (default true)" },
              include_meta: { type: "boolean", description: "Include meta info (default true)" }
            },
            required: ["id"],
            additionalProperties: false
          }
        }
      },
      {
        type: "function",
        function: {
          name: "sessionCreate",
          description: "Create a new session with optional title/content and parent folder.",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", description: "Session title (optional, derived from content if missing)" },
              content: { type: "string", description: "Initial content (optional)" },
              parent_id: { type: "string", description: "Folder id to insert into (optional, default root)" }
            },
            additionalProperties: false
          }
        }
      },
      {
        type: "function",
        function: {
          name: "sessionEdit",
          description: "Edit a session's content (append or overwrite). Ensure that the provided id is an existing session id when calling this function.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, description: "Session id" },
              mode: { type: "string", enum: ["append", "overwrite"], description: "Edit mode: append or overwrite" },
              content: { type: "string", description: "Text to append or full content to overwrite with" },
              newline: { type: "boolean", description: "If appending, whether to append a newline before content (default true)" }
            },
            required: ["id", "mode", "content"],
            additionalProperties: false
          }
        }
      },
      {
        type: "function",
        function: {
          name: "sessionRename",
          description: "Rename a session's title. Ensure that the provided id is an existing session id when calling this function.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, description: "Session id" },
              title: { type: "string", minLength: 1, description: "New title" }
            },
            required: ["id", "title"],
            additionalProperties: false
          }
        }
      },
      {
        type: "function",
        function: {
          name: "sessionDelete",
          description: "Delete a session by id. Ensure that the provided id is an existing session id when calling this function.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, description: "Session id" }
            },
            required: ["id"],
            additionalProperties: false
          }
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

    handlers.sessionsIndex = async (args) => {
      try {
        let idx = (window.zion?.state?.get("sessions.catalog") || []).slice();
        const sortBy = (args?.sort_by || "updated") === "title" ? "title" : "updated";
        if (sortBy === "updated") idx.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        else idx.sort((a, b) => (String(a.title || a.id)).localeCompare(String(b.title || b.id)));
        const limit = typeof args?.limit === "number" && args.limit > 0 ? args.limit : null;
        if (limit) idx = idx.slice(0, limit);
        return JSON.stringify(idx, null, 2);
      } catch (e) {
        return `sessionsIndex error: ${e?.message || String(e)}`;
      }
    };

    handlers.sessionsTree = async (args) => {
      try {
        const tree = window.zion?.state?.get("sessions.treeMem") || { id: "root", type: "folder", title: "Sessions", children: [] };
        const fid = String(args?.folder_id || "").trim();
        const currentId = window.zion?.state?.get("sessions.currentId") || null;

        const ret = deepCloneNode(tree);
        if (fid) {
          // naive subtree pick
          const stack = [ret];
          let found = null;
          while (stack.length) {
            const n = stack.pop();
            if (n.id === fid) { found = n; break; }
            if (n.type === "folder" && Array.isArray(n.children)) stack.push(...n.children);
          }
          if (!found) return "Folder not found";
          markCurrentInTree(found, currentId);
          return JSON.stringify(found, null, 2);
        }
        markCurrentInTree(ret, currentId);
        return JSON.stringify(ret, null, 2);
      } catch (e) {
        return `sessionsTree error: ${e?.message || String(e)}`;
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

    handlers.sessionEdit = async (args) => {
      try {
        const id = String(args?.id || "").trim();
        const mode = String(args?.mode || "").trim();
        const content = String(args?.content ?? "");
        const newline = args?.newline !== false;
        if (!id) return "Missing id";
        if (mode !== "append" && mode !== "overwrite") return "Invalid mode (use 'append' or 'overwrite')";
        const cur = window.zion?.commands?.executeCommand("zion.sessions.getDoc", id) || "";
        const text = mode === "append" ? (cur + ((newline && cur && !cur.endsWith("\n")) ? "\n" : "") + content) : content;
        window.zion?.commands?.executeCommand("zion.sessions.setDoc", { id, text });
        // update meta.updatedAt similar to edit path
        window.zion?.commands?.executeCommand("zion.sessions.bumpUpdatedAt", id);
        return JSON.stringify({ ok: true, id }, null, 2);
      } catch (e) {
        return `sessionEdit error: ${e?.message || String(e)}`;
      }
    };

    handlers.sessionRename = async (args) => {
      try {
        const id = String(args?.id || "").trim();
        const title = String(args?.title || "").trim();
        if (!id) return "Missing id";
        if (!title) return "Missing title";
        window.zion?.commands?.executeCommand("zion.sessions.rename", { id, title });
        return JSON.stringify({ ok: true, id }, null, 2);
      } catch (e) {
        return `sessionRename error: ${e?.message || String(e)}`;
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