import { diffLines } from "diff";

export function normalizeToolName(name) {
  return String(name || "").trim().toLowerCase();
}

export function normalizeToolArgs(args) {
  if (args && typeof args === "object") return args;
  if (typeof args !== "string") return {};
  const text = args.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return { patch: args };
  }
}

export function getToolPath(tool) {
  const args = normalizeToolArgs(tool?.args);
  const name = normalizeToolName(tool?.name);
  if (name === "apply_patch") {
    const patchText = getPatchText(args);
    return parsePatchPaths(patchText)[0] || "";
  }
  return String(args?.path || args?.file_path || args?.target_file || "").trim();
}

export function isFileArtifactTool(tool) {
  const name = normalizeToolName(tool?.name);
  return name === "edit" || name === "fsedit" || name === "write" || name === "fswrite" || name === "apply_patch";
}

export function buildFileArtifacts(tools, annotations = {}, sessionId = "") {
  const list = Array.isArray(tools) ? tools : [];
  const toolActions = annotations && typeof annotations.toolActions === "object" ? annotations.toolActions : {};
  const artifacts = [];

  for (const tool of list) {
    if (!isFileArtifactTool(tool)) continue;
    const artifact = buildArtifactFromTool(tool, toolActions, sessionId);
    if (artifact) artifacts.push(artifact);
  }

  return artifacts.sort((a, b) => {
    const ta = typeof a.createdAt === "number" ? a.createdAt : 0;
    const tb = typeof b.createdAt === "number" ? b.createdAt : 0;
    if (ta !== tb) return ta - tb;
    return a.path.localeCompare(b.path);
  });
}

export function buildArtifactFromTool(tool, toolActions = {}, sessionId = "") {
  const name = normalizeToolName(tool?.name);
  const args = normalizeToolArgs(tool?.args);
  const id = String(tool?.id || "");
  if (!id) return null;

  const action = toolActions?.[id]?.action || tool?.action || null;
  const status = tool?.ok === false
    ? "failed"
    : action === "accept"
      ? "accepted"
      : action === "revert"
        ? "reverted"
        : (tool?.result == null ? "pending" : "unknown");

  if (name === "write" || name === "fswrite") {
    const path = String(args?.path || args?.file_path || "").trim();
    if (!path) return null;
    const after = String(args?.content ?? "");
    const stats = countTextLines(after);
    return {
      id: `${id}:write`,
      sessionId,
      toolCallId: id,
      toolName: tool?.name || "write",
      path,
      basename: pathBasename(path),
      kind: "created",
      after,
      status,
      addedLines: stats.nonEmpty ? stats.lines : 0,
      removedLines: 0,
      createdAt: numberOrNull(tool?.actionAt) || numberOrNull(tool?.createdAt) || null,
      rawTool: tool
    };
  }

  if (name === "edit" || name === "fsedit") {
    const path = String(args?.path || args?.file_path || "").trim();
    if (!path) return null;
    const before = String(args?.old_string ?? "");
    const after = String(args?.new_string ?? "");
    const stats = computeDiffStats(before, after);
    return {
      id: `${id}:edit`,
      sessionId,
      toolCallId: id,
      toolName: tool?.name || "edit",
      path,
      basename: pathBasename(path),
      kind: "modified",
      before,
      after,
      status,
      addedLines: stats.added,
      removedLines: stats.removed,
      createdAt: numberOrNull(tool?.actionAt) || numberOrNull(tool?.createdAt) || null,
      rawTool: tool
    };
  }

  if (name === "apply_patch") {
    const patch = getPatchText(args);
    const paths = parsePatchPaths(patch);
    const path = paths[0] || "patch";
    const stats = computePatchStats(patch);
    return {
      id: `${id}:patch`,
      sessionId,
      toolCallId: id,
      toolName: tool?.name || "apply_patch",
      path,
      basename: pathBasename(path),
      kind: "patch",
      patch,
      patchPaths: paths,
      status,
      addedLines: stats.added,
      removedLines: stats.removed,
      createdAt: numberOrNull(tool?.actionAt) || numberOrNull(tool?.createdAt) || null,
      rawTool: tool
    };
  }

  return null;
}

export function buildDiffRows(artifact, maxRows = 420) {
  const rows = [];
  if (!artifact) return rows;

  if (artifact.patch) {
    const lines = String(artifact.patch).replace(/\r/g, "").split("\n");
    for (let i = 0; i < Math.min(lines.length, maxRows); i++) {
      rows.push(classifyPatchLine(lines[i], i + 1));
    }
    if (lines.length > maxRows) rows.push({ type: "meta", oldNo: null, newNo: null, text: `内容过长，已截断显示前 ${maxRows} 行` });
    return rows;
  }

  const before = String(artifact.before ?? "");
  const after = String(artifact.after ?? "");
  const parts = artifact.kind === "created" ? [{ added: true, value: after }] : diffLines(before, after);
  let oldNo = 1;
  let newNo = 1;

  for (const part of parts) {
    const type = part.added ? "add" : part.removed ? "remove" : "context";
    const lines = splitLines(part.value);
    for (const line of lines) {
      if (rows.length >= maxRows) {
        rows.push({ type: "meta", oldNo: null, newNo: null, text: `内容过长，已截断显示前 ${maxRows} 行` });
        return rows;
      }
      rows.push({
        type,
        oldNo: type === "add" ? null : oldNo,
        newNo: type === "remove" ? null : newNo,
        text: line
      });
      if (type !== "add") oldNo += 1;
      if (type !== "remove") newNo += 1;
    }
  }

  return rows;
}

export function statusLabel(status) {
  switch (status) {
    case "accepted": return "accepted";
    case "reverted": return "reverted";
    case "failed": return "failed";
    case "pending": return "pending";
    default: return "changed";
  }
}

export function kindLabel(kind) {
  switch (kind) {
    case "created": return "CREATED";
    case "modified": return "MODIFIED";
    case "deleted": return "DELETED";
    case "patch": return "PATCH";
    default: return "CHANGED";
  }
}

function getPatchText(args) {
  if (typeof args === "string") return args;
  return String(args?.patch || args?.content || args?.text || "");
}

function parsePatchPaths(patchText) {
  const paths = [];
  const seen = new Set();
  const lines = String(patchText || "").replace(/\r/g, "").split("\n");
  for (const line of lines) {
    const m = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/);
    if (!m) continue;
    const path = m[1].trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

function computeDiffStats(before, after) {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(String(before ?? ""), String(after ?? ""))) {
    const n = splitLines(part.value).length;
    if (part.added) added += n;
    if (part.removed) removed += n;
  }
  return { added, removed };
}

function computePatchStats(patch) {
  let added = 0;
  let removed = 0;
  for (const line of String(patch || "").replace(/\r/g, "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

function countTextLines(text) {
  const raw = String(text ?? "");
  return {
    lines: raw ? raw.replace(/\r/g, "").split("\n").length : 0,
    nonEmpty: raw.length > 0
  };
}

function splitLines(value) {
  const lines = String(value ?? "").replace(/\r/g, "").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length ? lines : [""];
}

function classifyPatchLine(line, lineNo) {
  const text = String(line ?? "");
  if (text.startsWith("+") && !text.startsWith("+++")) return { type: "add", oldNo: null, newNo: lineNo, text };
  if (text.startsWith("-") && !text.startsWith("---")) return { type: "remove", oldNo: lineNo, newNo: null, text };
  if (text.startsWith("@@")) return { type: "hunk", oldNo: null, newNo: null, text };
  if (text.startsWith("***")) return { type: "file", oldNo: null, newNo: null, text };
  return { type: "context", oldNo: null, newNo: null, text };
}

function pathBasename(path) {
  const parts = String(path || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || String(path || "");
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
