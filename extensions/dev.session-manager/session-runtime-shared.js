export const SESSION_LIST_TOOL_NAME = "sessionList";
export const SESSION_GET_TOOL_NAME = "sessionGet";
export const SESSION_CREATE_TOOL_NAME = "sessionCreate";
export const SESSION_UPDATE_TOOL_NAME = "sessionUpdate";
export const SESSION_DELETE_TOOL_NAME = "sessionDelete";

export function sessionListToolDefinition() {
  return {
    name: SESSION_LIST_TOOL_NAME,
    description: "List Runtime-backed Workbench sessions. Supports 'index' flat list and 'tree' folder hierarchy views.",
    inputSchema: {
      type: "object",
      properties: {
        view_type: {
          type: "string",
          enum: ["index", "tree"],
          description: "View type: 'index' for flat list, 'tree' for folder hierarchy. Defaults to index."
        },
        sort_by: {
          type: "string",
          enum: ["updated", "title"],
          description: "Sort order for index view. Defaults to updated."
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 200,
          description: "Maximum sessions to return for index view."
        },
        folder_id: {
          type: "string",
          description: "For tree view, return only the subtree of this folder."
        }
      },
      additionalProperties: false
    }
  };
}

export function sessionGetToolDefinition() {
  return {
    name: SESSION_GET_TOOL_NAME,
    description: "Get one Runtime-backed Workbench session document and metadata by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, description: "Session id" },
        include_doc: { type: "boolean", description: "Include document content. Defaults to true." },
        include_meta: { type: "boolean", description: "Include metadata. Defaults to true." }
      },
      required: ["id"],
      additionalProperties: false
    }
  };
}

export function sessionCreateToolDefinition({
  includeOpen = false
} = {}) {
  return {
    name: SESSION_CREATE_TOOL_NAME,
    description: "Create a Runtime-backed Workbench session document.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Optional stable session id. Runtime generates one when omitted." },
        title: { type: "string", description: "Session title" },
        content: { type: "string", description: "Initial document content. Kept for Workbench compatibility." },
        doc: { type: "string", description: "Initial document content. Alias of content." },
        parent_id: { type: "string", description: "Optional folder id to place the session under. Defaults to root." },
        meta: { type: "object", description: "Optional metadata patch" },
        operation_id: { type: "string", description: "Optional idempotency key" },
        ...(includeOpen
          ? { open: { type: "boolean", description: "Workbench only: open the new session after creation" } }
          : {})
      },
      additionalProperties: false
    }
  };
}

export function sessionUpdateToolDefinition() {
  return {
    name: SESSION_UPDATE_TOOL_NAME,
    description: "Update a Runtime-backed Workbench session document, title, or metadata.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, description: "Session id" },
        update_type: {
          type: "string",
          enum: ["content", "title"],
          description: "Workbench-compatible update mode. Use content for doc/content writes and title for rename."
        },
        mode: {
          type: "string",
          enum: ["append", "overwrite"],
          description: "For content update: append or overwrite. Defaults to overwrite in Runtime."
        },
        content: { type: "string", description: "Text to append or replacement content" },
        newline: { type: "boolean", description: "When appending, add a newline before content. Defaults to true." },
        title: { type: "string", description: "New session title" },
        doc: { type: "string", description: "Replacement document content" },
        meta: { type: "object", description: "Optional metadata patch" },
        parent_id: { type: "string", description: "Optional folder id when the session must be reinserted into the tree" },
        expected_session_revision: {
          type: "number",
          description: "Optional optimistic concurrency guard from sessionGet.session_revision"
        },
        operation_id: { type: "string", description: "Optional idempotency key" }
      },
      required: ["id"],
      additionalProperties: false
    }
  };
}

export function sessionDeleteToolDefinition() {
  return {
    name: SESSION_DELETE_TOOL_NAME,
    description: "Delete a Runtime-backed Workbench session. Requires confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, description: "Session id" },
        confirm: { type: "boolean", description: "Must be true to delete in Runtime" },
        expected_session_revision: {
          type: "number",
          description: "Optional optimistic concurrency guard from sessionGet.session_revision"
        },
        operation_id: { type: "string", description: "Optional idempotency key" }
      },
      required: ["id"],
      additionalProperties: false
    }
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeSessionIndexItem(item = {}) {
  const id = String(item.id || "").trim();
  if (!id) return null;
  return {
    id,
    title: String(item.title || id),
    updatedAt: Number(item.updatedAt || item.updated_at || 0),
    createdAt: Number(item.createdAt || item.created_at || 0),
    size: Number(item.size || 0),
    hash: String(item.hash || ""),
    ...(item.documentPreview ? { documentPreview: String(item.documentPreview) } : {}),
    ...(Array.isArray(item.tags) ? { tags: item.tags.map(String).filter(Boolean) } : {})
  };
}

export function normalizeSessionSnapshot(value = {}) {
  const snapshot = value?.snapshot && typeof value.snapshot === "object"
    ? value.snapshot
    : value;
  const index = (Array.isArray(snapshot?.index) ? snapshot.index : [])
    .map(normalizeSessionIndexItem)
    .filter(Boolean);
  return {
    version: Number(snapshot?.version || 1),
    updatedAt: Number(snapshot?.updatedAt || snapshot?.updated_at || 0),
    tree: snapshot?.tree && typeof snapshot.tree === "object"
      ? clone(snapshot.tree)
      : { id: "root", type: "folder", title: "Sessions", children: [] },
    index,
    docs: Array.isArray(snapshot?.docs) ? snapshot.docs : [],
    metas: Array.isArray(snapshot?.metas) ? snapshot.metas : []
  };
}

function markCurrentInTree(node, currentId) {
  if (!node || typeof node !== "object" || !currentId) return;
  if (node.type === "session") {
    if (node.id === currentId) node.current = true;
    return;
  }
  if (node.type !== "folder" || !Array.isArray(node.children)) return;
  let hasCurrent = false;
  for (const child of node.children) {
    markCurrentInTree(child, currentId);
    if (child?.current || child?.hasCurrent) hasCurrent = true;
  }
  if (hasCurrent) node.hasCurrent = true;
}

function findSubtree(root, folderId) {
  if (!folderId) return root;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node?.id === folderId) return node;
    if (node?.type === "folder" && Array.isArray(node.children)) {
      stack.push(...node.children);
    }
  }
  return null;
}

export function listSessionsFromSnapshot(snapshotValue, args = {}) {
  const snapshot = normalizeSessionSnapshot(snapshotValue);
  const viewType = String(args.view_type || "index").trim();
  const currentId = String(args.current_id || "").trim();
  if (viewType === "tree") {
    const tree = clone(snapshot.tree);
    markCurrentInTree(tree, currentId);
    const folderId = String(args.folder_id || "").trim();
    const selected = findSubtree(tree, folderId);
    if (!selected) {
      return { ok: false, error: "Folder not found" };
    }
    return { ok: true, tree: selected };
  }

  const sortBy = String(args.sort_by || "updated") === "title" ? "title" : "updated";
  const limit = Math.max(0, Math.min(200, Number(args.limit) || 0));
  const index = [...snapshot.index];
  if (sortBy === "title") {
    index.sort((left, right) =>
      String(left.title || left.id).localeCompare(String(right.title || right.id))
    );
  } else {
    index.sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
  }
  return {
    ok: true,
    sessions: limit ? index.slice(0, limit) : index
  };
}

export function sessionPayloadFromRuntimeRecord(record, {
  includeDoc = true,
  includeMeta = true
} = {}) {
  if (!record || record.deleted) return null;
  return {
    id: record.id,
    ...(includeMeta ? { meta: record.meta || {} } : {}),
    ...(includeDoc ? { doc: String(record.text || "") } : {}),
    session_revision: Number(record.session_revision || 0),
    content_hash: String(record.content_hash || "")
  };
}
