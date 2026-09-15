import {
  buildBiographyDigest,
  buildIdentityContext,
  normalizeBiographyEvents,
  parseBiographyEventsJsonl,
  serializeBiographyEventsJsonl
} from "./identity-core.js";
import {
  addAutomationRequest,
  normalizeAutomationDocument,
  normalizeProjectPolicy,
  resolveAutomationRequest,
  updateProjectPolicy
} from "./project-automation-core.js";

export const IDENTITY_RUNTIME_PLUGIN_ID = "dev.identity";
export const IDENTITY_RUNTIME_STATE_NAMESPACE = "identity";
export const IDENTITY_RUNTIME_SNAPSHOT_KEY = "snapshot";
export const IDENTITY_RUNTIME_KV_KEY =
  `runtime.plugins.${IDENTITY_RUNTIME_PLUGIN_ID}.${IDENTITY_RUNTIME_STATE_NAMESPACE}.${IDENTITY_RUNTIME_SNAPSHOT_KEY}`;
export const DEFAULT_IDENTITY_ROOT = "~/.zion-next/data/plugins/dev.identity";
export const IDENTITY_MANAGE_TOOL_NAME = "identityManage";
export const IDENTITY_MANAGE_READONLY_ACTIONS = ["get"];
export const IDENTITY_MANAGE_WRITE_ACTIONS = [
  "update_snapshot",
  "patch_files",
  "append_biography_events",
  "load_files",
  "write_files",
  "clear"
];
export const IDENTITY_MANAGE_RUNTIME_ACTIONS = [
  ...IDENTITY_MANAGE_READONLY_ACTIONS,
  ...IDENTITY_MANAGE_WRITE_ACTIONS
];
export const IDENTITY_PROFILE_FILE_PATHS = Object.freeze({
  identity: "identity.md",
  user: "user.md",
  biography: "biography/digest.md",
  projects: "projects/index.md",
  projectsInbox: "projects/inbox.md",
  projectsAttention: "projects/attention.md"
});
export const IDENTITY_BIOGRAPHY_EVENTS_FILE_PATH = "biography/events.jsonl";
export const PROJECT_AUTOMATION_MANAGE_TOOL_NAME = "projectAutomationManage";
export const PROJECT_AUTOMATION_RUNTIME_STATE_KEY = "projectAutomation.v1";
export const PROJECT_AUTOMATION_RUNTIME_KV_KEY =
  `runtime.plugins.${IDENTITY_RUNTIME_PLUGIN_ID}.${IDENTITY_RUNTIME_STATE_NAMESPACE}.${PROJECT_AUTOMATION_RUNTIME_STATE_KEY}`;
export const PROJECT_AUTOMATION_READONLY_ACTIONS = ["get"];
export const PROJECT_AUTOMATION_EXECUTION_ACTIONS = ["run_now", "stop"];
export const PROJECT_AUTOMATION_WRITE_ACTIONS = [
  "request_update",
  "disable",
  ...PROJECT_AUTOMATION_EXECUTION_ACTIONS
];
export const PROJECT_AUTOMATION_RUNTIME_ACTIONS = [
  ...PROJECT_AUTOMATION_READONLY_ACTIONS,
  ...PROJECT_AUTOMATION_WRITE_ACTIONS
];

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function timestampMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeFiles(files = {}) {
  const source = objectValue(files);
  return {
    identity: String(source.identity || ""),
    user: String(source.user || ""),
    biography: String(source.biography || ""),
    projects: String(source.projects || ""),
    projectsInbox: String(source.projectsInbox || ""),
    projectsAttention: String(source.projectsAttention || "")
  };
}

export function normalizeIdentitySnapshot(value = {}) {
  const source = objectValue(value);
  const files = normalizeFiles(source.files);
  const rendered = String(source.content || "").trim()
    || buildIdentityContext(files, { sourceRoot: source.sourceRoot });
  const savedAt = timestampMs(source.savedAt)
    || timestampMs(source.createdAt)
    || Date.now();
  return {
    version: 1,
    savedAt,
    lastChangedAt: Math.max(
      timestampMs(source.lastChangedAt),
      savedAt
    ),
    sourceRoot: String(source.sourceRoot || DEFAULT_IDENTITY_ROOT),
    content: rendered,
    files
  };
}

export function createIdentitySnapshot({
  content = "",
  files = {},
  sourceRoot = DEFAULT_IDENTITY_ROOT,
  savedAt = Date.now(),
  lastChangedAt = savedAt
} = {}) {
  return normalizeIdentitySnapshot({
    savedAt,
    lastChangedAt,
    sourceRoot,
    content,
    files
  });
}

export function identityManageToolDefinition({
  actions = IDENTITY_MANAGE_READONLY_ACTIONS
} = {}) {
  return {
    name: IDENTITY_MANAGE_TOOL_NAME,
    description: "Inspect or update the Runtime-backed Identity snapshot. File actions use the Runtime Host file service and are scoped to the requested Identity file_root.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: actions,
          description: "Identity snapshot management action."
        },
        include_content: {
          type: "boolean",
          description: "When true, include rendered identity_context in get output."
        },
        content: {
          type: "string",
          description: "Rendered identity_context content for update_snapshot."
        },
        sourceRoot: {
          type: "string",
          description: "Source root label for the Runtime snapshot."
        },
        file_root: {
          type: "string",
          description: "Absolute Identity memory root for load_files/write_files, e.g. /Users/me/.zion-next/memory."
        },
        session_id: {
          type: "string",
          description: "Optional local-tools terminal session id used for file access."
        },
        files: {
          type: "object",
          properties: {
            identity: { type: "string" },
            user: { type: "string" },
            biography: { type: "string" },
            projects: { type: "string" },
            projectsInbox: { type: "string" },
            projectsAttention: { type: "string" }
          },
          additionalProperties: false
        },
        events: {
          type: "array",
          maxItems: 16,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["decision", "milestone", "outcome", "lesson"] },
              summary: { type: "string" },
              project: { type: "string" },
              topics: { type: "array", items: { type: "string" }, maxItems: 4 },
              confirmed: { type: "boolean" },
              sessionId: { type: "string" },
              runId: { type: "string" },
              at: { type: "string" },
              index: { type: "integer" }
            },
            required: ["kind", "summary"],
            additionalProperties: false
          }
        },
        source_session_id: {
          type: "string",
          description: "Source chat session id for appended biography events."
        },
        source_run_id: {
          type: "string",
          description: "Source Runtime/Workbench run id for appended biography events."
        },
        source_at: {
          type: "string",
          description: "Optional ISO timestamp for appended biography events."
        }
      },
      required: ["action"],
      additionalProperties: false
    }
  };
}

export function projectAutomationManageToolDefinition({
  actions = PROJECT_AUTOMATION_READONLY_ACTIONS
} = {}) {
  return {
    name: PROJECT_AUTOMATION_MANAGE_TOOL_NAME,
    description: [
      "Inspect or update Runtime-backed project automation policy state.",
      "Use request_update to create a policy change that remains pending until the user resolves it in Workbench, and disable to revoke a project.",
      "Use run_now or stop to control Runtime Host project execution for an already enabled project."
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: actions
        },
        project_key: { type: "string" },
        request_id: { type: "string" },
        enabled: { type: "boolean" },
        mode: { type: "string", enum: ["explore", "execute"] },
        cadence_minutes: { type: "integer", minimum: 15, maximum: 10080 },
        file_roots: { type: "array", items: { type: "string" }, maxItems: 16 },
        allowed_command_prefixes: {
          type: "array",
          items: { type: "string" },
          maxItems: 16
        },
        reason: { type: "string", maxLength: 500 }
      },
      required: ["action"]
    }
  };
}

function projectAutomationPatchFromArgs(args = {}) {
  const patch = {};
  if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
  if (args.mode === "explore" || args.mode === "execute") patch.mode = args.mode;
  if (args.cadence_minutes !== undefined) patch.cadenceMinutes = Number(args.cadence_minutes);
  if (Array.isArray(args.file_roots)) patch.fileRoots = args.file_roots;
  if (Array.isArray(args.allowed_command_prefixes)) {
    patch.allowedCommandPrefixes = args.allowed_command_prefixes;
  }
  return patch;
}

export function summarizeProjectAutomation(document = {}, {
  projectKey = ""
} = {}) {
  const normalized = normalizeAutomationDocument(document);
  const key = String(projectKey || "").trim();
  if (key) {
    return {
      projectKey: key,
      policy: normalized.projects[key] || normalizeProjectPolicy(),
      pending: normalized.requests.filter((request) => (
        request.projectKey === key && request.status === "pending"
      ))
    };
  }
  return {
    version: normalized.version,
    projects: Object.fromEntries(
      Object.entries(normalized.projects).map(([entryKey, policy]) => [
        entryKey,
        normalizeProjectPolicy(policy)
      ])
    ),
    pending: normalized.requests.filter((request) => request.status === "pending"),
    requests: normalized.requests
  };
}

export function projectAutomationRevision(document = {}) {
  const normalized = normalizeAutomationDocument(document);
  return Math.max(
    0,
    ...Object.values(normalized.projects).flatMap((policy) => [
      Number(policy.updatedAt || 0),
      Number(policy.lastRunAt || 0),
      Number(policy.lastCompletedAt || 0),
      Number(policy.nextEligibleAt || 0)
    ]),
    ...normalized.requests.flatMap((request) => [
      Number(request.requestedAt || 0),
      Number(request.resolvedAt || 0)
    ])
  );
}

export function updateProjectAutomationDocument(document = {}, args = {}, now = Date.now()) {
  const action = String(args.action || "").trim();
  const current = normalizeAutomationDocument(document);
  const projectKey = String(args.project_key || "").trim();
  if (action === "request_update") {
    if (!projectKey) throw new Error("project_key is required");
    const patch = projectAutomationPatchFromArgs(args);
    if (!Object.keys(patch).length) throw new Error("No automation changes requested");
    if (patch.enabled === false) {
      return {
        document: updateProjectAutomationDocument(current, {
          action: "disable",
          project_key: projectKey
        }, now).document,
        result: {
          status: "disabled",
          projectKey
        }
      };
    }
    const safeProjectKey = projectKey.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80);
    const request = {
      id: String(
        args.request_id
        || `automation-request-${now.toString(36)}-${safeProjectKey}`
      ).trim(),
      projectKey,
      patch,
      reason: args.reason,
      status: "pending",
      requestedAt: now
    };
    const next = addAutomationRequest(current, request);
    return {
      document: next,
      result: {
        status: "pending_user_approval",
        requestId: request.id,
        projectKey,
        patch
      }
    };
  }
  if (action === "approve_request" || action === "reject_request") {
    const requestId = String(args.request_id || "").trim();
    if (!requestId) throw new Error("request_id is required");
    const pending = current.requests.find((request) => (
      request.id === requestId && request.status === "pending"
    ));
    if (!pending) throw new Error(`Pending automation request not found: ${requestId}`);
    const next = resolveAutomationRequest(
      current,
      requestId,
      action === "approve_request",
      now
    );
    return {
      document: next,
      result: {
        status: action === "approve_request" ? "approved" : "rejected",
        requestId
      }
    };
  }
  if (action === "disable") {
    if (!projectKey) throw new Error("project_key is required");
    const next = updateProjectPolicy(current, projectKey, {
      enabled: false,
      activeTaskId: "",
      lastStatus: "idle",
      lastError: "Disabled from Runtime projectAutomationManage"
    }, now);
    return {
      document: next,
      result: {
        status: "disabled",
        projectKey
      }
    };
  }
  throw new Error(`Unsupported Runtime projectAutomationManage action: ${action}`);
}

export function summarizeIdentitySnapshot(snapshot = {}, {
  includeContent = false
} = {}) {
  const normalized = normalizeIdentitySnapshot(snapshot);
  return {
    sourceRoot: normalized.sourceRoot,
    savedAt: normalized.savedAt,
    lastChangedAt: normalized.lastChangedAt,
    hasContext: !!normalized.content.trim(),
    fileKeys: Object.entries(normalized.files)
      .filter(([, value]) => String(value || "").trim())
      .map(([key]) => key),
    ...(includeContent ? { content: normalized.content } : {})
  };
}

export function updateIdentitySnapshot(snapshot = {}, args = {}, timestamp = Date.now()) {
  const current = normalizeIdentitySnapshot(snapshot);
  const content = String(args.content || "").trim();
  const files = normalizeFiles(args.files);
  const hasFiles = Object.values(files).some((value) => String(value || "").trim());
  if (!content && !hasFiles) {
    throw new Error("identity content or files are required");
  }
  const nextFiles = hasFiles ? files : current.files;
  return normalizeIdentitySnapshot({
    ...current,
    savedAt: timestamp,
    lastChangedAt: timestamp,
    sourceRoot: String(args.sourceRoot || current.sourceRoot || DEFAULT_IDENTITY_ROOT),
    content: content || buildIdentityContext(nextFiles, { sourceRoot: current.sourceRoot }),
    files: nextFiles
  });
}

export function patchIdentityFiles(snapshot = {}, patch = {}, timestamp = Date.now()) {
  const current = normalizeIdentitySnapshot(snapshot);
  const nextFiles = normalizeFiles({
    ...current.files,
    ...objectValue(patch.files)
  });
  return normalizeIdentitySnapshot({
    ...current,
    savedAt: timestamp,
    lastChangedAt: timestamp,
    sourceRoot: String(patch.sourceRoot || current.sourceRoot || DEFAULT_IDENTITY_ROOT),
    content: String(patch.content || "").trim() || buildIdentityContext(nextFiles, { sourceRoot: current.sourceRoot }),
    files: nextFiles
  });
}

export function clearIdentitySnapshot(snapshot = {}, timestamp = Date.now()) {
  const current = normalizeIdentitySnapshot(snapshot);
  return normalizeIdentitySnapshot({
    ...current,
    savedAt: timestamp,
    lastChangedAt: timestamp,
    content: "",
    files: {}
  });
}

function timestampIso(value, fallback = Date.now()) {
  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed) && parsed > 0) return new Date(parsed).toISOString();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
  return new Date(fallback).toISOString();
}

export function buildBiographyEventsUpdate({
  existingJsonl = "",
  events = [],
  sourceSessionId = "",
  sourceRunId = "",
  sourceAt = "",
  now = Date.now()
} = {}) {
  const at = timestampIso(sourceAt, now);
  const candidates = (Array.isArray(events) ? events : []).map((event, index) => ({
    ...objectValue(event),
    sessionId: event?.sessionId || event?.session_id || sourceSessionId,
    runId: event?.runId || event?.run_id || sourceRunId,
    at: event?.at || at,
    index: event?.index ?? index
  }));
  const normalizedInput = normalizeBiographyEvents(candidates);
  const timedIds = new Set(normalizeBiographyEvents(
    candidates.filter((_candidate, index) => events[index]?.at)
  ).map((event) => event.id));
  if (!normalizedInput.length) {
    throw new Error("valid biography events are required");
  }
  const existing = parseBiographyEventsJsonl(existingJsonl);
  const byId = new Map(existing.map((event) => [event.id, event]));
  for (const event of normalizedInput) {
    const previous = byId.get(event.id);
    if (!previous) continue;
    // An omitted occurrence time on a retry keeps the original event time.
    const suppliedTime = sourceAt || timedIds.has(event.id);
    const comparable = suppliedTime ? event : { ...event, at: previous.at };
    if (JSON.stringify(comparable) !== JSON.stringify(previous)) {
      throw new Error(`Conflicting biography event id: ${event.id}`);
    }
  }
  const existingIds = new Set(existing.map((event) => event.id));
  const appended = normalizedInput.filter((event) => !existingIds.has(event.id));
  const skipped = normalizedInput.filter((event) => existingIds.has(event.id)).map((event) => event.id);
  const allEvents = normalizeBiographyEvents([...existing, ...appended]);
  return {
    events: allEvents,
    appended,
    skipped,
    eventsJsonl: serializeBiographyEventsJsonl(allEvents),
    digest: buildBiographyDigest(allEvents)
  };
}

export function buildIdentityContextFromSnapshot(snapshot) {
  return normalizeIdentitySnapshot(snapshot).content;
}

export function insertAfterLeadingSystem(messages, injectedMessage) {
  const list = Array.isArray(messages) ? messages : [];
  let insertAt = 0;
  while (insertAt < list.length && list[insertAt]?.role === "system") insertAt += 1;
  return [
    ...list.slice(0, insertAt),
    injectedMessage,
    ...list.slice(insertAt)
  ];
}

export function hasIdentityContext(messages = []) {
  return (Array.isArray(messages) ? messages : []).some((message) =>
    typeof message?.content === "string"
    && message.content.includes("<identity_context>")
  );
}
