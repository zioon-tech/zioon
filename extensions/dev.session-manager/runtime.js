import {
  SESSION_CREATE_TOOL_NAME,
  SESSION_DELETE_TOOL_NAME,
  SESSION_GET_TOOL_NAME,
  SESSION_LIST_TOOL_NAME,
  SESSION_UPDATE_TOOL_NAME,
  listSessionsFromSnapshot,
  sessionCreateToolDefinition,
  sessionDeleteToolDefinition,
  sessionGetToolDefinition,
  sessionListToolDefinition,
  sessionPayloadFromRuntimeRecord,
  sessionUpdateToolDefinition
} from "./session-runtime-shared.js";
import {
  createSessionDocumentProjector
} from "./session-document-projector.js";

export const runtimePluginApiVersion = 2;

function requireSessionService(context) {
  const service = context.config?.sessionService;
  if (!service || typeof service !== "object") {
    throw new Error("Runtime Session Manager service is unavailable");
  }
  return service;
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

async function mutationResultPayload(service, result) {
  const payload = { ...result };
  if (result?.id) {
    const record = sessionPayloadFromRuntimeRecord(await service.readSession(result.id), {
      includeDoc: true,
      includeMeta: true
    });
    if (record) payload.session = record;
  }
  return payload;
}

function normalizeExpectedSessionRevision(value) {
  if (value == null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

async function resolveUpdatePatch(service, args = {}) {
  const id = String(args.id || "").trim();
  const updateType = String(args.update_type || "").trim();
  const patch = {
    expected_session_revision: normalizeExpectedSessionRevision(args.expected_session_revision),
    operation_id: args.operation_id,
    parent_id: args.parent_id
  };
  if (args.meta && typeof args.meta === "object") patch.meta = args.meta;
  if (updateType === "title" || (!updateType && args.title != null)) {
    patch.title = String(args.title || "");
    return patch;
  }
  if (updateType === "content" || args.doc != null || args.content != null) {
    const mode = String(args.mode || "overwrite").trim();
    const content = args.doc != null
      ? String(args.doc)
      : String(args.content ?? "");
    if (mode === "append") {
      const current = await service.readSession(id);
      const currentText = String(current?.text || "");
      const separator = args.newline !== false && currentText && !currentText.endsWith("\n")
        ? "\n"
        : "";
      patch.text = `${currentText}${separator}${content}`;
    } else {
      patch.text = content;
    }
    return patch;
  }
  return patch;
}

export function activateRuntimePlugin(context) {
  const service = requireSessionService(context);
  const documentProjectorRegistration = context.documents.registerProjector(
    createSessionDocumentProjector()
  );
  const listDefinition = sessionListToolDefinition();
  const getDefinition = sessionGetToolDefinition();
  const createDefinition = sessionCreateToolDefinition();
  const updateDefinition = sessionUpdateToolDefinition();
  const deleteDefinition = sessionDeleteToolDefinition();

  const listRegistration = context.tools.registerTool({
    name: SESSION_LIST_TOOL_NAME,
    description: listDefinition.description,
    inputSchema: listDefinition.inputSchema,
    policy: { minimumPreset: "read-only" },
    async invoke(args = {}) {
      const result = listSessionsFromSnapshot(await service.readSnapshot(), args);
      if (!result.ok) {
        return {
          ok: false,
          content: json(result),
          error: result.error || "sessionList failed"
        };
      }
      return {
        ok: true,
        content: json(result.tree || result.sessions || [])
      };
    }
  });

  const getRegistration = context.tools.registerTool({
    name: SESSION_GET_TOOL_NAME,
    description: getDefinition.description,
    inputSchema: getDefinition.inputSchema,
    policy: { minimumPreset: "read-only" },
    async invoke(args = {}) {
      const id = String(args.id || "").trim();
      if (!id) {
        return { ok: false, content: "Missing id", error: "Missing id" };
      }
      const payload = sessionPayloadFromRuntimeRecord(await service.readSession(id), {
        includeDoc: args.include_doc !== false,
        includeMeta: args.include_meta !== false
      });
      if (!payload) {
        return { ok: false, content: "Session not found", error: "Session not found" };
      }
      return {
        ok: true,
        content: json(payload)
      };
    }
  });

  const createRegistration = context.tools.registerTool({
    name: SESSION_CREATE_TOOL_NAME,
    description: createDefinition.description,
    inputSchema: createDefinition.inputSchema,
    policy: { minimumPreset: "workspace-write" },
    async invoke(args = {}) {
      const result = await service.createSession({
        id: args.id,
        title: args.title,
        text: args.doc != null ? String(args.doc) : String(args.content ?? ""),
        parent_id: args.parent_id,
        meta: args.meta,
        operation_id: args.operation_id
      });
      const ok = result?.ok === true;
      return {
        ok,
        content: json(await mutationResultPayload(service, result)),
        ...(ok ? {} : { error: result?.reason || "sessionCreate failed" })
      };
    }
  });

  const updateRegistration = context.tools.registerTool({
    name: SESSION_UPDATE_TOOL_NAME,
    description: updateDefinition.description,
    inputSchema: updateDefinition.inputSchema,
    policy: { minimumPreset: "workspace-write" },
    async invoke(args = {}) {
      const id = String(args.id || "").trim();
      if (!id) return { ok: false, content: "Missing id", error: "Missing id" };
      const result = await service.updateSession(
        id,
        await resolveUpdatePatch(service, args)
      );
      const ok = result?.ok === true;
      return {
        ok,
        content: json(await mutationResultPayload(service, { ...result, id })),
        ...(ok ? {} : { error: result?.reason || "sessionUpdate failed" })
      };
    }
  });

  const deleteRegistration = context.tools.registerTool({
    name: SESSION_DELETE_TOOL_NAME,
    description: deleteDefinition.description,
    inputSchema: deleteDefinition.inputSchema,
    policy: { minimumPreset: "workspace-write" },
    async invoke(args = {}) {
      const id = String(args.id || "").trim();
      if (!id) return { ok: false, content: "Missing id", error: "Missing id" };
      if (args.confirm !== true) {
        return { ok: false, content: "confirm=true is required", error: "confirm=true is required" };
      }
      const result = await service.deleteSession(id, {
        expected_session_revision: normalizeExpectedSessionRevision(args.expected_session_revision),
        operation_id: args.operation_id
      });
      const ok = result?.ok === true;
      return {
        ok,
        content: json({ ...result, id }),
        ...(ok ? {} : { error: result?.reason || "sessionDelete failed" })
      };
    }
  });

  return {
    dispose() {
      documentProjectorRegistration.dispose();
      deleteRegistration.dispose();
      updateRegistration.dispose();
      createRegistration.dispose();
      getRegistration.dispose();
      listRegistration.dispose();
    }
  };
}
