import {
  normalizeCapabilityPolicy,
  type CapabilityPolicy,
  type RunEvent,
  type ToolDefinition
} from "../../packages/runtime/src/index.js";

const LEGACY_TOOL_ALIASES = new Map([
  ["fsWrite", "write"],
  ["fsEdit", "edit"],
  ["terminalExecute", "Bash"]
]);

export type ZionNextFunctionTool = {
  type?: "function";
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ZionNextRunEvent = Omit<RunEvent, "timestamp"> & {
  ts: number;
  timestamp?: number;
};

export function fromZionNextCapabilityPolicy(
  input: Partial<CapabilityPolicy> = {}
): CapabilityPolicy {
  return normalizeCapabilityPolicy({
    ...input,
    allowedTools: Array.isArray(input.allowedTools)
      ? input.allowedTools.map((name) =>
        LEGACY_TOOL_ALIASES.get(String(name)) || String(name)
      )
      : []
  });
}

function finiteTokenCount(value: unknown): number {
  const count = Number(value || 0);
  return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
}

function toZionNextUsage(value: unknown): Record<string, unknown> {
  const usage = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const input = finiteTokenCount(
    usage.input
    ?? usage.inputTokens
    ?? usage.input_tokens
    ?? usage.prompt_tokens
  );
  const output = finiteTokenCount(
    usage.output
    ?? usage.outputTokens
    ?? usage.output_tokens
    ?? usage.completion_tokens
  );
  return {
    ...usage,
    input,
    output,
    total: finiteTokenCount(usage.total ?? usage.total_tokens) || input + output,
    cacheRead: finiteTokenCount(
      usage.cacheRead
      ?? usage.cacheReadTokens
      ?? usage.cache_read_input_tokens
    ),
    cacheWrite: finiteTokenCount(
      usage.cacheWrite
      ?? usage.cacheWriteTokens
      ?? usage.cache_creation_input_tokens
    ),
    reasoning: finiteTokenCount(
      usage.reasoning
      ?? usage.reasoningTokens
      ?? usage.reasoning_tokens
    )
  };
}

export function fromZionNextFunctionTool(
  tool: ZionNextFunctionTool
): ToolDefinition {
  const fn = tool?.function || {};
  const name = String(fn.name || "").trim();
  if (!name) throw new Error("Zioon tool definition has no function name");
  return {
    name,
    description: String(fn.description || ""),
    inputSchema: fn.parameters && typeof fn.parameters === "object"
      ? fn.parameters
      : {
          type: "object",
          properties: {},
          additionalProperties: false
        }
  };
}

export function toZionNextRunEvent(event: RunEvent): ZionNextRunEvent {
  const data = { ...(event.data || {}) };
  if (
    event.type === "model.usage"
    || event.type === "turn.completed"
    || event.type === "run.completed"
    || event.type === "run.waiting"
  ) {
    data.usage = toZionNextUsage(data.usage);
  }
  if (
    event.type === "reasoning.started"
    || event.type === "reasoning.delta"
    || event.type === "reasoning.completed"
  ) {
    const turn = finiteTokenCount(data.turn);
    data.stepIndex = turn;
    data.reasoningSegmentId = String(
      data.reasoningSegmentId
      || (turn ? `${event.runId}:step:${turn}` : event.runId)
    );
  }
  if (event.type === "tool.requested") {
    const args = data.arguments ?? {};
    data.args = args;
    data.arguments = args;
    data.presentation = {
      version: 1,
      renderer: "generic",
      title: String(data.name || "tool"),
      status: "running"
    };
  }
  if (event.type === "tool.completed") {
    data.result = String(
      data.result
      ?? data.content
      ?? data.resultPreview
      ?? data.error
      ?? ""
    );
    data.presentation = {
      version: 1,
      renderer: "generic",
      title: String(data.name || "tool"),
      status: data.error ? "failed" : "completed",
      artifactIds: Array.isArray(data.artifactIds)
        ? data.artifactIds.map(String).filter(Boolean)
        : []
    };
  }
  if (event.type === "tool.denied") {
    data.presentation = {
      version: 1,
      renderer: "generic",
      title: String(data.name || "tool"),
      status: "denied"
    };
  }
  return {
    ...event,
    ts: event.timestamp,
    data
  };
}
