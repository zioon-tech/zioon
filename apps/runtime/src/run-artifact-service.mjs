const FILE_TOOL_NAMES = new Set([
  "write",
  "fswrite",
  "edit",
  "fsedit",
  "apply_patch"
]);
const MAX_CHANGE_TEXT_CHARS = 200_000;

function compact(value) {
  const text = String(value ?? "");
  return text.length <= MAX_CHANGE_TEXT_CHARS
    ? text
    : `${text.slice(0, MAX_CHANGE_TEXT_CHARS)}\n[truncated ${text.length - MAX_CHANGE_TEXT_CHARS} characters]`;
}

function lineCount(value) {
  const text = String(value ?? "");
  if (!text) return 0;
  return text.replace(/\r/g, "").split("\n").length;
}

function patchStats(value) {
  let addedLines = 0;
  let removedLines = 0;
  for (const line of String(value || "").replace(/\r/g, "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) addedLines += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removedLines += 1;
  }
  return { addedLines, removedLines };
}

function patchPaths(value) {
  const paths = [];
  const seen = new Set();
  for (const line of String(value || "").replace(/\r/g, "").split("\n")) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/);
    const path = String(match?.[1] || "").trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

function safeId(value) {
  return String(value || "artifact").replace(/[^a-zA-Z0-9_.:-]+/g, "-");
}

function artifactPair(invocation, {
  path,
  operation,
  before,
  after,
  patch,
  index = 0,
  createdAt
}) {
  const invocationId = String(invocation.invocationId || "");
  const artifactId = `${safeId(invocationId)}:artifact:${index}`;
  const changeId = `${safeId(invocationId)}:change:${index}`;
  const toolCallId = String(invocation.toolCall?.id || "");
  const toolName = String(invocation.toolCall?.name || "");
  const stats = patch
    ? patchStats(patch)
    : {
        addedLines: lineCount(after),
        removedLines: operation === "modified" ? lineCount(before) : 0
      };
  return {
    artifact: {
      schemaVersion: 1,
      id: artifactId,
      runId: String(invocation.runId || ""),
      invocationId,
      toolCallId,
      toolName,
      kind: "file",
      uri: String(path || ""),
      mediaType: "text/plain",
      createdAt,
      metadata: { operation }
    },
    change: {
      schemaVersion: 1,
      id: changeId,
      artifactId,
      runId: String(invocation.runId || ""),
      invocationId,
      toolCallId,
      toolName,
      operation,
      path: String(path || ""),
      ...(before !== undefined ? { before: compact(before) } : {}),
      ...(after !== undefined ? { after: compact(after) } : {}),
      ...(patch !== undefined ? { patch: compact(patch) } : {}),
      addedLines: stats.addedLines,
      removedLines: stats.removedLines,
      createdAt
    }
  };
}

export function deriveFileArtifacts(invocation, result, createdAt = Date.now()) {
  if (result?.ok !== true) return { artifacts: [], changes: [] };
  const name = String(invocation?.toolCall?.name || "").trim().toLowerCase();
  if (!FILE_TOOL_NAMES.has(name)) return { artifacts: [], changes: [] };
  const args = invocation?.toolCall?.arguments || {};

  if (name === "apply_patch") {
    const patch = String(args.patch || args.content || args.text || "");
    const paths = patchPaths(patch);
    const targets = paths.length ? paths : ["patch"];
    const pairs = targets.map((path, index) => artifactPair(invocation, {
      path,
      operation: "patch",
      patch,
      index,
      createdAt
    }));
    return {
      artifacts: pairs.map((pair) => pair.artifact),
      changes: pairs.map((pair) => pair.change)
    };
  }

  const path = String(args.path || args.file_path || args.target_file || "").trim();
  if (!path) return { artifacts: [], changes: [] };
  const pair = name === "write" || name === "fswrite"
    ? artifactPair(invocation, {
        path,
        operation: "created",
        after: args.content ?? "",
        createdAt
      })
    : artifactPair(invocation, {
        path,
        operation: "modified",
        before: args.old_string ?? "",
        after: args.new_string ?? "",
        createdAt
      });
  return {
    artifacts: [pair.artifact],
    changes: [pair.change]
  };
}

export function enrichToolResultWithArtifacts(invocation, result, createdAt = Date.now()) {
  const derived = deriveFileArtifacts(invocation, result, createdAt);
  if (!derived.artifacts.length && !derived.changes.length) return result;
  const existingIds = Array.isArray(result?.artifactIds) ? result.artifactIds : [];
  return {
    ...result,
    artifactIds: Array.from(new Set([
      ...existingIds.map(String).filter(Boolean),
      ...derived.artifacts.map((artifact) => artifact.id)
    ])),
    artifacts: derived.artifacts,
    changes: derived.changes
  };
}
