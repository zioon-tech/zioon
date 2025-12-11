/**
 * dev.task-panel: tools for LLM
 * - Registers todoWrite tool to manage structured todos in the current session.
 * - Writes to zion.state('todo.list') and 'todo.updatedAt' for Task Panel consumption.
 */
export function registerTaskTools() {
  try {
    // Tool schema
    const tools = [
      {
        type: "function",
        function: {
          name: "todoWrite",
          description: "Create or update a structured todo list for the current session",
          parameters: {
            type: "object",
            properties: {
              todos: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    content: { type: "string", minLength: 1 },
                    status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                    activeForm: { type: "string", minLength: 1 }
                  },
                  required: ["content", "status", "activeForm"],
                  additionalProperties: false
                },
                description: "The updated todo list"
              }
            },
            required: ["todos"],
            additionalProperties: false
          }
        }
      }
    ];

    // Merge into chat.tools (avoid duplicates)
    const existing = window.zion?.state?.get("chat.tools") || [];
    const existNames = new Set(existing.map(t => t?.function?.name).filter(Boolean));
    const merged = existing.slice();
    for (const t of tools) {
      const nm = t?.function?.name;
      if (nm && !existNames.has(nm)) merged.push(t);
    }
    window.zion?.state?.set("chat.tools", merged);

    // Register handler
    const handlers = { ...(window.zion?.state?.get("chat.toolHandlers") || {}) };
    handlers.todoWrite = async (args) => {
      const okStatuses = new Set(["pending", "in_progress", "completed"]);
      const arr = Array.isArray(args?.todos) ? args.todos : [];
      const sanitized = arr
        .filter(t => t && typeof t.content === "string" && typeof t.activeForm === "string" && okStatuses.has(String(t.status)))
        .map(t => ({ content: String(t.content), status: String(t.status), activeForm: String(t.activeForm) }));
      window.zion.state.set("todo.list", sanitized);
      window.zion.state.set("todo.updatedAt", Date.now());
      return JSON.stringify(sanitized, null, 2);
    };
    window.zion?.state?.set("chat.toolHandlers", handlers);

    // Enable list sync: include this tool by default
    try {
      const names = (window.zion?.state?.get("chat.tools") || []).map(t => t?.function?.name).filter(Boolean);
      window.zion?.state?.set("chat.toolsKnownNames", names);
      let enabled = window.zion?.state?.get("chat.enabledTools");
      if (!Array.isArray(enabled) || enabled.length === 0) {
        window.zion?.state?.set("chat.enabledTools", names);
      } else if (!enabled.includes("todoWrite")) {
        window.zion?.state?.set("chat.enabledTools", [...enabled, "todoWrite"]);
      }
    } catch {}
  } catch (e) {
    console.warn("[task-tools] register failed", e);
  }
}