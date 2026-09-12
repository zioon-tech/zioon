import type {
  AssistantToolCall,
  SessionMessage,
  TranscriptContent,
} from "./types";

export type ConversationItem = {
  message: SessionMessage;
  toolResults: Record<string, SessionMessage>;
};

export function transcriptOutsideActiveRun(
  messages: SessionMessage[],
  activeRunId: string,
): SessionMessage[] {
  if (!activeRunId) return messages;
  return messages.filter((message) => (
    message.role === "user" || message.runId !== activeRunId
  ));
}

function contentText(content: TranscriptContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => part.type === "text" ? String(part.text || "") : "")
    .filter(Boolean)
    .join("\n");
}

export function buildConversationItems(
  messages: SessionMessage[],
): ConversationItem[] {
  const toolResults = new Map<string, SessionMessage>();
  const assistantsByRun = new Map<string, SessionMessage[]>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      toolResults.set(message.toolCallId, message);
    }
    if (message.role === "assistant" && message.runId) {
      const group = assistantsByRun.get(message.runId) || [];
      group.push(message);
      assistantsByRun.set(message.runId, group);
    }
  }

  const emittedRuns = new Set<string>();
  return messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    let visibleMessage = message;
    if (message.role === "assistant" && message.runId) {
      if (emittedRuns.has(message.runId)) return [];
      emittedRuns.add(message.runId);
      const runMessages = assistantsByRun.get(message.runId) || [message];
      const finalMessage = [...runMessages].reverse().find((candidate) =>
        contentText(candidate.content).trim() && !candidate.toolCalls?.length
      ) || [...runMessages].reverse().find((candidate) =>
        contentText(candidate.content).trim()
      ) || runMessages[runMessages.length - 1];
      const reasoningContent = runMessages
        .map((candidate) => String(candidate.reasoningContent || "").trim())
        .filter(Boolean)
        .join("\n\n");
      const toolCalls = runMessages.flatMap((candidate) =>
        candidate.toolCalls || []
      );
      visibleMessage = {
        ...finalMessage,
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
      };
    }
    const hasVisibleAssistantContent = Boolean(
      contentText(visibleMessage.content).trim()
      || visibleMessage.reasoningContent?.trim()
      || visibleMessage.toolCalls?.length,
    );
    if (visibleMessage.role === "assistant" && !hasVisibleAssistantContent) return [];
    return [{
      message: visibleMessage,
      toolResults: Object.fromEntries(
        (visibleMessage.toolCalls || []).flatMap((call) => {
          const result = toolResults.get(call.id);
          return result ? [[call.id, result]] : [];
        }),
      ),
    }];
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

export function meaningfulSessionTitle(value?: string): string {
  const title = String(value || "").trim();
  return ["", "新会话", "未命名会话", "untitled", "new session"]
    .includes(title.toLowerCase())
    ? ""
    : title;
}
