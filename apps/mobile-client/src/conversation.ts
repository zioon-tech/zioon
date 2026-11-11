import type {
  AssistantToolCall,
  RunStatus,
  RunWait,
  SessionMessage,
  TranscriptContent,
} from "./types";

export type ConversationBlock = (
  | { kind: "text"; content: string }
  | { kind: "reasoning"; content: string; running?: boolean }
  | { kind: "tool"; call: AssistantToolCall; result?: SessionMessage; status: "running" | "completed" | "failed" | "interrupted" }
) & { id: string; turn: number };

export type ConversationProjection = {
  runId: string;
  blocks: ConversationBlock[];
  status: RunStatus | "connecting";
  error: string;
  finalBlockId?: string;
  waiting?: RunWait;
};

export type ConversationItem = {
  key: string;
  message: SessionMessage;
  toolResults: Record<string, SessionMessage>;
  blocks: ConversationBlock[];
  status?: ConversationProjection["status"];
  error?: string;
  finalBlockId?: string;
};

export function conversationBlockId(runId: string, turn: number, kind: string): string {
  return `${runId}:turn:${turn}:${kind}`;
}

export function finalAnswerBlockId(blocks: ConversationBlock[]): string | undefined {
  const last = blocks.at(-1);
  return last?.kind === "text" && last.content.trim()
    && !blocks.some((block) => block.kind === "tool" && block.turn === last.turn)
    ? last.id : undefined;
}

function contentText(content: TranscriptContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => part.type === "text" ? String(part.text || "") : "")
    .filter(Boolean)
    .join("\n");
}

function withBlocks(item: ConversationItem, blocks: ConversationBlock[]): ConversationItem {
  const text = blocks.flatMap((block) => block.kind === "text" ? [block.content] : []);
  const reasoning = blocks.flatMap((block) => block.kind === "reasoning" ? [block.content] : []);
  const tools = blocks.flatMap((block) => block.kind === "tool" ? [block] : []);
  return {
    ...item,
    blocks,
    message: {
      ...item.message,
      content: text.join("\n\n"),
      reasoningContent: reasoning.join("\n\n"),
      toolCalls: tools.map((block) => block.call),
    },
    toolResults: Object.fromEntries(tools.flatMap((block) =>
      block.result ? [[block.call.id, block.result]] : []
    )),
  };
}

export function buildConversationItems(
  messages: SessionMessage[],
  projections: ConversationProjection[] = [],
): ConversationItem[] {
  // Canonical messages are complete records, not cumulative text snapshots.
  // Only repeated message identities may be replaced; identical text is valid.
  const canonical = [...new Map(messages.map((message) => [message.id, message])).values()];
  const toolResults = new Map<string, SessionMessage>();
  for (const message of canonical) {
    if (message.role === "tool" && message.toolCallId) {
      toolResults.set(`${message.runId || ""}:${message.toolCallId}`, message);
    }
  }
  const items: ConversationItem[] = [];
  const runs = new Map<string, ConversationItem>();
  const turns = new Map<string, number>();
  for (const message of canonical) {
    if (message.role === "user") {
      items.push({ key: message.id, message, toolResults: {}, blocks: [] });
      continue;
    }
    if (message.role !== "assistant") continue;
    const scope = message.runId || message.id;
    const turn = message.turn ?? (turns.get(scope) || 0) + 1;
    turns.set(scope, turn);
    const blocks: ConversationBlock[] = [];
    if (message.reasoningContent?.trim()) {
      blocks.push({ id: conversationBlockId(scope, turn, "reasoning"), turn, kind: "reasoning", content: message.reasoningContent });
    }
    if (contentText(message.content).trim()) {
      blocks.push({ id: conversationBlockId(scope, turn, "text"), turn, kind: "text", content: contentText(message.content) });
    }
    for (const call of message.toolCalls || []) {
      const result = toolResults.get(`${message.runId || ""}:${call.id}`);
      blocks.push({
        id: conversationBlockId(scope, turn, `tool:${call.id}`), turn, kind: "tool", call, result,
        status: result ? toolResultOk(result) === false ? "failed" : "completed" : "interrupted",
      });
    }
    let item = runs.get(scope);
    if (!item) {
      item = { key: `run:${scope}`, message, blocks: [], toolResults: {} };
      runs.set(scope, item);
      items.push(item);
    }
    item.blocks.push(...blocks);
  }
  for (const item of runs.values()) {
    item.finalBlockId = finalAnswerBlockId(item.blocks);
  }
  for (const projection of projections) {
    if (!projection.runId) continue;
    let item = runs.get(projection.runId);
    if (!item) {
      const userIndex = items.findIndex(({ message }) => message.role === "user" && message.runId === projection.runId);
      item = {
        key: `run:${projection.runId}`,
        message: { id: `run:${projection.runId}`, role: "assistant", sequence: 0, content: "", runId: projection.runId, createdAt: items[userIndex]?.message.createdAt },
        blocks: [], toolResults: {},
      };
      items.splice(userIndex < 0 ? items.length : userIndex + 1, 0, item);
    }
    // Keep the live block order; canonical records enrich matching results.
    const persisted = new Map(item.blocks.map((block) => [block.id, block]));
    const liveIds = new Set(projection.blocks.map((block) => block.id));
    item.blocks = [
      ...projection.blocks.map((block) => {
        const saved = persisted.get(block.id);
        return saved && (saved.kind !== "tool" || saved.result) ? saved : block;
      }),
      ...item.blocks.filter((block) => !liveIds.has(block.id)),
    ];
    item.status = projection.status;
    item.error = projection.error;
    item.finalBlockId = projection.finalBlockId
      || (projection.status === "completed" ? finalAnswerBlockId(item.blocks) : undefined);
  }
  return items.filter((item) => item.message.role === "user" || item.blocks.length || item.status)
    .map((item) => item.message.role === "user" ? item : withBlocks(item, item.blocks));
}

export function projectionIsPersisted(messages: SessionMessage[], projection: ConversationProjection): boolean {
  const item = buildConversationItems(messages).find((candidate) => candidate.message.runId === projection.runId && candidate.message.role === "assistant");
  if (!item) return false;
  const persisted = new Map(item.blocks.map((block) => [block.id, block]));
  return projection.blocks.every((block) => {
    const saved = persisted.get(block.id);
    if (!saved || saved.kind !== block.kind) return false;
    if (block.kind === "tool") return saved.kind === "tool" && !!saved.result;
    return saved.kind !== "tool" && (!block.content || saved.content.trim() === block.content.trim());
  });
}

export function parseToolArguments(call: AssistantToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function parseToolResult(message?: SessionMessage): unknown {
  if (!message) return null;
  const value = contentText(message.content).trim();
  if (!value) return "";
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function toolResultOk(message?: SessionMessage): boolean | null {
  if (!message) return null;
  const result = parseToolResult(message);
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (typeof record.ok === "boolean") return record.ok;
    if (typeof record.success === "boolean") return record.success;
    if (typeof record.exit_code === "number") return record.exit_code === 0;
    if (record.error) return false;
  }
  if (typeof result === "string") {
    const value = result.trim().toLowerCase();
    if (
      value.startsWith("error:")
      || value.startsWith("failed:")
      || value.includes("permission denied")
    ) {
      return false;
    }
  }
  return true;
}

function compactLine(value: unknown, max = 96): string {
  const line = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function summarizeToolCall(
  call: AssistantToolCall,
  resultMessage?: SessionMessage,
): string {
  if (!resultMessage) return "等待 Runtime 返回结果";
  const args = parseToolArguments(call);
  const result = parseToolResult(resultMessage);
  const ok = toolResultOk(resultMessage);
  const record = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  const error = compactLine(record.error || record.detail);
  if (ok === false) return error || "执行失败";

  const name = call.function.name.toLowerCase();
  const path = compactLine(args.path || record.path);
  if (name === "bash") {
    const stdout = compactLine(record.stdout);
    return stdout || `命令执行完成${record.exit_code != null ? ` · exit ${record.exit_code}` : ""}`;
  }
  if (name === "read") return path ? `已读取 ${path}` : "文件读取完成";
  if (name === "write") return path ? `已写入 ${path}` : "文件写入完成";
  if (name === "edit") return path ? `已修改 ${path}` : "文件修改完成";
  if (name === "tree") return path ? `已读取目录 ${path}` : "目录读取完成";
  if (name === "glob" || name === "grep") {
    return path ? `已在 ${path} 中完成搜索` : "搜索完成";
  }
  if (name === "websearch") {
    return compactLine(args.query) || "网络搜索完成";
  }
  if (name === "webfetch") {
    return compactLine(args.url) || "网页读取完成";
  }
  return compactLine(
    record.summary
    || record.message
    || record.content
    || (typeof result === "string" ? result : ""),
  ) || "执行完成";
}

function generatedSessionTitle(value: string): boolean {
  return /^session[_-][0-9a-f]{6,}(?:[_-][0-9a-f]{4,})*$/i.test(value)
    || /^session\s+\d+$/i.test(value)
    || /^session\s+session[_-][0-9a-f]{6,}(?:[_-][0-9a-f]{4,})*$/i.test(value);
}

export function meaningfulSessionTitle(
  value?: string,
  sessionId = "",
  metadata: Record<string, unknown> = {},
): string {
  const title = String(value || "").replace(/\s+/g, " ").trim();
  const normalizedSessionId = String(sessionId).replace(/\s+/g, " ").trim();
  if (["", "新会话", "未命名会话", "untitled", "new session"]
    .includes(title.toLowerCase())) {
    return "";
  }
  if (normalizedSessionId && title.toLowerCase() === normalizedSessionId.toLowerCase()) {
    return "";
  }
  if (metadata.titleAuto === false) return title;
  if (generatedSessionTitle(title)) return "";
  if (metadata.titleAuto === true && /^session\b/i.test(title)) return "";
  return title;
}
