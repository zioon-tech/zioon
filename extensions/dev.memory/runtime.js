import {
  MEMORY_MANAGE_RUNTIME_ACTIONS,
  MEMORY_MANAGE_READONLY_ACTIONS,
  MEMORY_MANAGE_WRITE_ACTIONS,
  MEMORY_MANAGE_TOOL_NAME,
  MEMORY_RUNTIME_SNAPSHOT_KEY,
  MEMORY_RUNTIME_STATE_NAMESPACE,
  buildMemoryContextFromSnapshot,
  createMemoryItem,
  deleteMemoryItem,
  insertAfterLeadingSystem,
  listMemoryItems,
  memoryManageToolDefinition,
  memoryProvidersSnapshot,
  memoryTree,
  normalizeMemorySnapshot,
  readMemoryItem,
  scoreMemory,
  selectMemoryItem,
  updateMemoryItem,
  updateMemorySettings,
  searchMemoryItems
} from "./memory-runtime-shared.js";

export const runtimePluginApiVersion = 2;

function allowsWorkspaceWrite(policy = {}) {
  return ["workspace-write", "trusted-automation"].includes(String(policy?.preset || "read-only"));
}

function latestUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    const content = messages[index]?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => typeof part === "string" ? part : part?.text || "")
        .join("\n")
        .trim();
    }
    return "";
  }
  return "";
}

class RuntimeMemoryContextProvider {
  constructor({ state }) {
    this.id = "dev.memory.context";
    this.stage = "pre";
    this.order = 80;
    this.state = state;
  }

  async contribute(messages) {
    if ((Array.isArray(messages) ? messages : []).some((message) =>
      typeof message?.content === "string"
      && message.content.includes("<working_memory>")
    )) {
      return messages;
    }
    const snapshot = normalizeMemorySnapshot(
      this.state.get(MEMORY_RUNTIME_SNAPSHOT_KEY) || {}
    );
    if (snapshot.settings.autoInject === false) return messages;
    const context = buildMemoryContextFromSnapshot(
      snapshot,
      latestUserText(messages)
    );
    if (!context.items.length) return messages;
    return insertAfterLeadingSystem(messages, {
      role: "user",
      content: context.text
    });
  }
}

export function activateRuntimePlugin(context) {
  const state = context.state.namespace(MEMORY_RUNTIME_STATE_NAMESPACE);
  const provider = new RuntimeMemoryContextProvider({ state });
  const providerRegistration = context.context.registerProvider(provider);
  const snapshot = () => normalizeMemorySnapshot(
    state.get(MEMORY_RUNTIME_SNAPSHOT_KEY) || {}
  );
  const saveSnapshot = (value) => state.set(
    MEMORY_RUNTIME_SNAPSHOT_KEY,
    normalizeMemorySnapshot(value)
  );
  const toolRegistration = context.tools.registerTool({
    name: "memoryList",
    description: "List Runtime-backed Zion memory items and optionally search them.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        layer: { type: "string", enum: ["working", "long-term"] },
        enabled_only: { type: "boolean" },
        max_items: { type: "number" }
      },
      additionalProperties: false
    },
    policy: {
      minimumPreset: "read-only"
    },
    async invoke(args = {}) {
      const current = snapshot();
      const query = String(args.query || "").trim();
      const loweredQuery = query.toLowerCase();
      const maxItems = Math.max(1, Number(args.max_items || 50));
      const items = current.items
        .filter((item) => !args.layer || item.layer === args.layer)
        .filter((item) => !args.enabled_only || item.enabled !== false)
        .filter((item) => {
          if (!loweredQuery) return true;
          return [
            item.title,
            item.path,
            item.content,
            ...(item.tags || [])
          ].join("\n").toLowerCase().includes(loweredQuery);
        })
        .map((item) => ({ item, score: scoreMemory(item, query) }))
        .sort((left, right) =>
          right.score - left.score
          || String(left.item.path || "").localeCompare(String(right.item.path || ""))
        )
        .slice(0, maxItems)
        .map(({ item }) => item)
        .map((item) => ({
          id: item.id,
          title: item.title,
          path: item.path,
          layer: item.layer,
          type: item.type,
          scope: item.scope,
          enabled: item.enabled,
          pinned: item.pinned,
          tags: item.tags,
          updatedAt: item.updatedAt
        }));
      return {
        ok: true,
        content: JSON.stringify({
          total: current.items.length,
          returned: items.length,
          items
        }, null, 2)
      };
    }
  });
  const manageDefinition = memoryManageToolDefinition({
    actions: MEMORY_MANAGE_RUNTIME_ACTIONS
  });
  const manageRegistration = context.tools.registerTool({
    name: MEMORY_MANAGE_TOOL_NAME,
    description: manageDefinition.description,
    inputSchema: manageDefinition.inputSchema,
    policy: {
      minimumPreset: "read-only"
    },
    async invoke(args = {}, meta = {}) {
      const action = String(args.action || "").trim();
      const current = snapshot();
      if (!MEMORY_MANAGE_RUNTIME_ACTIONS.includes(action)) {
        return {
          ok: false,
          content: `Unsupported Runtime memoryManage action: ${action}`,
          error: `Unsupported Runtime memoryManage action: ${action}`
        };
      }
      if (
        MEMORY_MANAGE_WRITE_ACTIONS.includes(action)
        && !allowsWorkspaceWrite(meta?.policy)
      ) {
        return {
          ok: false,
          content: `memoryManage action ${action} requires workspace-write capability`,
          error: `memoryManage action ${action} requires workspace-write capability`
        };
      }
      if (action === "list") {
        return {
          ok: true,
          content: JSON.stringify(listMemoryItems(current, args), null, 2)
        };
      }
      if (action === "tree") {
        return {
          ok: true,
          content: JSON.stringify(memoryTree(current), null, 2)
        };
      }
      if (action === "read") {
        return {
          ok: true,
          content: JSON.stringify(readMemoryItem(current, args), null, 2)
        };
      }
      if (action === "search") {
        return {
          ok: true,
          content: JSON.stringify(searchMemoryItems(current, args), null, 2)
        };
      }
      if (action === "build_context") {
        return {
          ok: true,
          content: JSON.stringify(
            buildMemoryContextFromSnapshot(current, args.query || "", {
              maxItems: args.max_items || 8
            }),
            null,
            2
          )
        };
      }
      if (action === "providers") {
        return {
          ok: true,
          content: JSON.stringify(memoryProvidersSnapshot(current), null, 2)
        };
      }
      if (action === "create") {
        const result = createMemoryItem(current, args);
        saveSnapshot(result.snapshot);
        return {
          ok: true,
          content: JSON.stringify({
            created: result.item,
            snapshot: result.snapshot
          }, null, 2)
        };
      }
      if (action === "update") {
        const result = updateMemoryItem(current, args.id, args);
        saveSnapshot(result.snapshot);
        return {
          ok: true,
          content: JSON.stringify({
            updated: result.item,
            snapshot: result.snapshot
          }, null, 2)
        };
      }
      if (action === "delete") {
        const result = deleteMemoryItem(current, args.id);
        saveSnapshot(result.snapshot);
        return {
          ok: true,
          content: JSON.stringify(result, null, 2)
        };
      }
      if (action === "select") {
        const result = selectMemoryItem(current, args.id);
        saveSnapshot(result.snapshot);
        return {
          ok: true,
          content: JSON.stringify(result, null, 2)
        };
      }
      if (action === "settings") {
        const keys = Object.keys(args).filter((key) => key !== "action");
        if (!keys.length) {
          return {
            ok: true,
            content: JSON.stringify(current.settings, null, 2)
          };
        }
        const result = updateMemorySettings(current, args);
        saveSnapshot(result.snapshot);
        return {
          ok: true,
          content: JSON.stringify(result, null, 2)
        };
      }
      return {
        ok: false,
        content: `Unknown action: ${action}`,
        error: `Unknown action: ${action}`
      };
    }
  });
  return {
    dispose() {
      manageRegistration.dispose();
      providerRegistration.dispose();
      toolRegistration.dispose();
    }
  };
}
