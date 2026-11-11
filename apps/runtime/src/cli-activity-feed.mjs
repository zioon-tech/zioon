import { safeText, truncate } from "./cli-text.mjs";

const labels = {
  Bash: "Run command", bash: "Run command", terminalExec: "Run command",
  skillsList: "List skills", skillsRead: "Read skill", readSkill: "Read skill",
  terminalInventory: "Inspect terminals", todoWrite: "Update tasks",
  Read: "Read file", readFile: "Read file", fileRead: "Read file",
  Write: "Write file", writeFile: "Write file", fileWrite: "Write file",
  Edit: "Edit file", editFile: "Edit file", fileEdit: "Edit file",
  Glob: "Find files", Grep: "Search files", webSearch: "Search web",
  WebSearch: "Search web", webFetch: "Read webpage", WebFetch: "Read webpage",
  mcpCall: "Call integration"
};
const oneLine = (value, width = 96) => truncate(safeText(value).slice(0, 512).replace(/\s+/g, " ").trim(), width);
const nameOf = (data) => oneLine(data?.toolName || data?.name || data?.tool?.name || "tool");
const idOf = (data) => data?.toolCallId || data?.callId;
const seconds = (ms) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

export function toolLabel(tool) {
  return labels[tool.name] || oneLine(tool.name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " "));
}

export function toolTarget(tool) {
  let args = tool.request?.arguments ?? tool.request?.args;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { return ""; }
  }
  return oneLine(args?.description || args?.path || args?.file_path || args?.query || args?.command || args?.toolName || "");
}

// Detail previews are bounded. Explicit /tools <number> retains the received
// payload, including the server's detailAvailable/resultTruncated metadata.
export function printToolDetail(output, theme, tool) {
  const width = Math.max(12, (output.columns || 80) - 5);
  output.write(`  ${theme.bold(toolLabel(tool))}${toolTarget(tool) ? ` · ${toolTarget(tool)}` : ""}\n`);
  output.write(`  ${tool.status}${tool.elapsedMs !== undefined ? ` · ${seconds(tool.elapsedMs)}` : ""}\n`);
  const data = tool.result || {};
  const value = data.error || data.reason || data.resultPreview || data.result || data.content;
  if (value !== undefined) {
    const text = safeText(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    const lines = text.slice(0, 2048).split("\n");
    for (const line of lines.slice(0, 5)) output.write(`    ${theme.dim(truncate(line, width))}\n`);
    if (lines.length > 5 || text.length > 2048 || data.resultTruncated) output.write("    … /tools <number> for received details\n");
  }
}

// One transient status row; successful tool bursts commit once before prose.
// Correlation uses call IDs, never tool names alone for concurrent calls.
export function createActivityFeed(output, theme, {
  activity, expanded = false, onTool = () => {}, boundary = () => {},
  inspectHint = "/tools", now = Date.now
} = {}) {
  const calls = new Map(), tools = [], active = new Set();
  let pending = [], thinking = null, thinkingMs = 0, pendingThinkingMs = 0, completed = 0, count = 0, finished = false, answering = false, lastSourceTime;
  const eventTime = (event) => Number.isFinite(event?.timestamp) && event.timestamp >= 0 ? event.timestamp : now();
  const line = (text, danger = false) => output.write(`  ${(danger ? theme.danger : theme.dim)(text)}\n`);
  const closeThinking = (time = lastSourceTime ?? now()) => {
    if (!thinking) return;
    const elapsed = Math.max(0, time - thinking.started);
    thinkingMs += elapsed; pendingThinkingMs += elapsed;
    // A phase is confirmed by reasoning events; never invent reasoning text.
    thinking = null;
  };
  const printThinking = () => {
    if (theme.interactive && pendingThinkingMs >= 100) line(`Thought for ${seconds(pendingThinkingMs)}`);
    pendingThinkingMs = 0;
  };
  const flush = () => {
    if (!pending.length) return;
    const group = new Map();
    for (const tool of pending) {
      const label = toolLabel(tool), current = group.get(label);
      if (current) current.count++;
      else group.set(label, { count: 1, tool });
    }
    const entries = [...group.entries()];
    const summary = entries.slice(0, 3).map(([label, value]) =>
      value.count > 1 ? `${label} ×${value.count}` : `${label}${pending.length === 1 && toolTarget(value.tool) ? ` · ${toolTarget(value.tool)}` : ""}`);
    if (entries.length > 3) summary.push(`+${entries.length - 3} kinds`);
    const width = Math.max(12, (output.columns || 80) - 3);
    const hint = width >= 35 ? ` · ${inspectHint}` : "";
    output.write(`  ${theme.accent("✓")} ${theme.bold(truncate(summary.join(" · "), Math.max(1, width - hint.length - 2)))}${theme.dim(hint)}\n`);
    pending = [];
  };
  const status = () => {
    if (active.size) {
      const tool = active.values().next().value, target = toolTarget(tool);
      const label = `Running · ${toolLabel(tool)}${target ? ` · ${target}` : ""}${active.size > 1 ? ` · +${active.size - 1} active` : ""}`;
      activity.startIfStopped?.(label);
      activity.update(label);
    } else {
      const label = `Thinking${completed ? ` · ${completed} tool${completed === 1 ? "" : "s"} complete` : ""}`;
      activity.startIfStopped?.(label);
      activity.update(label);
    }
  };
  const remember = (data, event) => {
    const id = idOf(data);
    const key = id ? String(id) : `anonymous:${++count}`;
    const tool = { id, name: nameOf(data), status: "running", started: eventTime(event), request: data, sequence: event?.sequence };
    calls.set(key, tool); tools.push(tool); active.add(tool);
    if (id) count++;
    onTool(tool);
    return tool;
  };
  return {
    tools,
    get count() { return count; },
    get thinkingMs() { return thinkingMs; },
    setExpanded(value) { expanded = Boolean(value); if (!answering) status(); },
    beforeAnswer(event) { activity.stop(); closeThinking(eventTime(event)); flush(); printThinking(); answering = true; },
    event(event) {
      const data = event.data || {};
      if (Number.isFinite(event.timestamp) && event.timestamp >= 0) lastSourceTime = event.timestamp;
      if (event.type === "reasoning.progress" || event.type === "reasoning.delta"
          || event.type === "projection.cursor" && data.sourceType === "reasoning.delta") {
        if (!thinking) { boundary(); thinking = { started: eventTime(event) }; }
        answering = false;
        status();
        return;
      }
      if (event.type === "model.started") { boundary(); answering = false; status(); return; }
      if (event.type === "tool.requested") {
        const id = idOf(data);
        if (id && calls.has(String(id))) return;
        boundary(); closeThinking(eventTime(event)); answering = false; remember(data, event); status();
        return;
      }
      if (!["tool.completed", "tool.failed", "tool.denied"].includes(event.type)) return;
      const id = idOf(data);
      let tool = id ? calls.get(String(id)) : tools.find((item) =>
        item.status === "running" && (!data.name && !data.toolName || item.name === nameOf(data)));
      if (tool && tool.status !== "running") return;
      if (!tool) tool = remember(data, event);
      tool.status = event.type === "tool.denied" ? "denied"
        : event.type === "tool.failed" || data.ok === false ? "failed" : "completed";
      active.delete(tool);
      tool.result = data;
      tool.elapsedMs = Number.isFinite(data.elapsedMs) && data.elapsedMs >= 0 ? data.elapsedMs : Math.max(0, eventTime(event) - tool.started);
      completed++;
      if (tool.status !== "completed" || expanded) {
        boundary(); activity.stop(); closeThinking(); flush();
        if (tool.status !== "completed") {
          line(truncate(`✗ ${toolLabel(tool)} · ${tool.status} · ${oneLine(data.error || data.reason || data.failureCode || "See tool details")}`, Math.max(12, (output.columns || 80) - 3)), true);
        }
        if (expanded) printToolDetail(output, theme, tool);
      } else pending.push(tool);
      status();
    },
    finish(statusValue) {
      if (finished) return;
      finished = true;
      activity.stop(); closeThinking(); flush(); printThinking();
      if (active.size) line(`${active.size} tool outcome${active.size === 1 ? "" : "s"} unconfirmed · ${inspectHint}`, true);
      if (statusValue === "completed" && tools.some((tool) => tool.status !== "completed"))
        line("Run completed with tool failures or unconfirmed outcomes", true);
    }
  };
}
