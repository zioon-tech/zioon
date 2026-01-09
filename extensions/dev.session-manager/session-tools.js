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
          name: "sessionList",
          description: "List sessions. Supports two view modes: 'index' (flat list) or 'tree' (folder hierarchy). Returns id, title, updatedAt, size, hash, createdAt for each session.",
          parameters: {
            type: "object",
            properties: {
              view_type: { type: "string", enum: ["index", "tree"], description: "View type: 'index' for flat list, 'tree' for folder hierarchy (default: index)" },
              sort_by: { type: "string", enum: ["updated", "title"], description: "Sort order for 'index' view (default: updated)" },
              limit: { type: "number", description: "Limit the number of items for 'index' view (optional)" },
              folder_id: { type: "string", description: "For 'tree' view, return only the subtree of this folder (optional)" }
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
          name: "sessionUpdate",
          description: "Update a session: either content (append or overwrite) or title (rename). Ensure that the provided id is an existing session id when calling this function.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, description: "Session id" },
              update_type: { type: "string", enum: ["content", "title"], description: "What to update: 'content' or 'title'" },
              mode: { type: "string", enum: ["append", "overwrite"], description: "For content update: 'append' or 'overwrite'" },
              content: { type: "string", description: "For content update: text to append or full content to overwrite with" },
              newline: { type: "boolean", description: "For content append: whether to add a newline before content (default true)" },
              title: { type: "string", description: "For title update: new title" }
            },
            required: ["id", "update_type"],
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

    handlers.sessionList = async (args) => {
      try {
        const viewType = String(args?.view_type || "index").trim();
        if (viewType === "tree") {
          // Tree view (merged from sessionsTree)
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
        } else {
          // Index view (merged from sessionsIndex)
          let idx = (window.zion?.state?.get("sessions.catalog") || []).slice();
          const sortBy = (args?.sort_by || "updated") === "title" ? "title" : "updated";
          if (sortBy === "updated") idx.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
          else idx.sort((a, b) => (String(a.title || a.id)).localeCompare(String(b.title || b.id)));
          const limit = typeof args?.limit === "number" && args.limit > 0 ? args.limit : null;
          if (limit) idx = idx.slice(0, limit);
          return JSON.stringify(idx, null, 2);
        }
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
