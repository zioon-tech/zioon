import type {
  AgentEngine,
  CancellationSignal,
  CredentialProvider,
  EngineOutputEvent,
  EngineTurnRequest,
  ToolCall,
  ToolDefinition,
  TranscriptMessage,
  Usage
} from "./protocol.js";

export type ModelTransportRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
};

export type ModelTransportResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: AsyncIterable<string> | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

export type ModelTransport = (
  request: ModelTransportRequest,
  signal: CancellationSignal
) => Promise<ModelTransportResponse>;

export type OpenAICompatibleEngineOptions = {
  id?: string;
  endpoint: string;
  apiKey?: string;
  credentialProvider?: CredentialProvider;
  credentialRef?: string;
  credentialRequired?: boolean;
  model: string;
  transport: ModelTransport;
  headers?: Record<string, string>;
  temperature?: number;
  maxOutputTokens?: number;
  requestBody?: Readonly<Record<string, unknown>>;
};

type ToolCallBuffer = {
  id: string;
  name: string;
  argumentsText: string;
};

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function mapMessage(message: TranscriptMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content
    };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      ...(message.reasoningContent
        ? { reasoning_content: message.reasoningContent }
        : {}),
      tool_calls: message.toolCalls
    };
  }
  return {
    role: message.role,
    content: message.content,
    ...(message.role === "assistant" && message.reasoningContent
      ? { reasoning_content: message.reasoningContent }
      : {})
  };
}

function mapTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.inputSchema || {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  };
}

function observableEndpoint(value: string): string {
  const match = String(value || "").match(
    /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)/i
  );
  if (!match) return "";
  const authority = match[2].replace(/^.*@/, "");
  return `${match[1]}${authority}${match[3]}`;
}

function mapUsage(value: unknown): Partial<Usage> {
  const usage = asRecord(value);
  const promptDetails = asRecord(usage.prompt_tokens_details);
  const completionDetails = asRecord(usage.completion_tokens_details);
  return {
    inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    reasoningTokens: Number(completionDetails.reasoning_tokens || usage.reasoning_tokens || 0),
    cacheReadTokens: Number(promptDetails.cached_tokens || usage.cache_read_input_tokens || 0),
    cacheWriteTokens: Number(usage.cache_creation_input_tokens || 0)
  };
}

function propertyMatchesType(value: unknown, type: unknown): boolean {
  if (Array.isArray(type)) return type.some((item) => propertyMatchesType(value, item));
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return !!value && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  return true;
}

function validateArguments(
  value: Record<string, unknown>,
  definition: ToolDefinition | undefined
): string {
  const schema = asRecord(definition?.inputSchema);
  if (schema.type && schema.type !== "object") {
    return "tool input schema must describe an object";
  }
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return `${String(key)} is required`;
    }
  }
  const properties = asRecord(schema.properties);
  for (const [key, propertyValue] of Object.entries(value)) {
    const propertySchema = asRecord(properties[key]);
    if (propertySchema.type && !propertyMatchesType(propertyValue, propertySchema.type)) {
      return `${key} must be ${String(propertySchema.type)}`;
    }
  }
  return "";
}

function completeToolCall(
  buffer: ToolCallBuffer,
  definition: ToolDefinition | undefined,
  fallbackId: string
): ToolCall {
  let args: Record<string, unknown> = {};
  let validationError = "";
  try {
    const parsed = buffer.argumentsText.trim()
      ? JSON.parse(buffer.argumentsText)
      : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      validationError = "tool arguments must be a JSON object";
    } else {
      args = parsed;
    }
  } catch (error) {
    validationError = `invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!validationError) validationError = validateArguments(args, definition);
  return {
    id: buffer.id || fallbackId,
    name: buffer.name,
    arguments: args,
    ...(validationError ? { validationError } : {})
  };
}

async function* parseSse(body: AsyncIterable<string>): AsyncIterable<Record<string, any>> {
  let pending = "";
  const consume = function* (complete: boolean) {
    pending = pending.replaceAll("\r\n", "\n");
    while (true) {
      const boundary = pending.indexOf("\n\n");
      if (boundary < 0) break;
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
    if (complete) {
      const data = pending
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      pending = "";
      if (data) yield data;
    }
  };

  for await (const chunk of body) {
    pending += chunk;
    for (const data of consume(false)) {
      if (data === "[DONE]") {
        yield { __zionSseDone: true };
        continue;
      }
      yield asRecord(JSON.parse(data));
    }
  }
  for (const data of consume(true)) {
    if (data === "[DONE]") {
      yield { __zionSseDone: true };
      continue;
    }
    yield asRecord(JSON.parse(data));
  }
}

function incompleteStreamError(message: string): Error & {
  code: string;
  retryable: boolean;
} {
  const error = new Error(message) as Error & {
    code: string;
    retryable: boolean;
  };
  error.code = "incomplete_stream";
  error.retryable = false;
  return error;
}

function assertCompleteFinishReason(finishReason: string): void {
  if (["length", "max_tokens"].includes(finishReason.toLowerCase())) {
    throw incompleteStreamError(
      `Model output was truncated (${finishReason})`
    );
  }
}

function ingestToolCallDeltas(
  buffers: Map<number, ToolCallBuffer>,
  deltas: unknown
): void {
  for (const item of Array.isArray(deltas) ? deltas : []) {
    const delta = asRecord(item);
    const index = Number.isInteger(delta.index) ? Number(delta.index) : 0;
    const current = buffers.get(index) || { id: "", name: "", argumentsText: "" };
    const fn = asRecord(delta.function);
    if (delta.id) current.id = String(delta.id);
    if (fn.name) current.name = String(fn.name);
    if (typeof fn.arguments === "string") current.argumentsText += fn.arguments;
    buffers.set(index, current);
  }
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    const item = asRecord(part);
    return item.type === "text" ? String(item.text || "") : "";
  }).join("");
}

function applyModelRequestOptions(
  payload: Record<string, unknown>,
  request: EngineTurnRequest,
  endpoint: string
): void {
  const options = request.modelOptions;
  if (!options) return;
  const thinkingMode = options.thinkingMode;
  const thinkingEffort = options.thinkingEffort;
  const providerId = String(request.model?.providerId || "").toLowerCase();
  const modelId = String(request.model?.modelId || "").toLowerCase();
  const isDeepSeek = providerId.includes("deepseek")
    || modelId.includes("deepseek")
    || endpoint.toLowerCase().includes("api.deepseek.com");

  if (thinkingMode === "off") {
    delete payload.reasoning_effort;
    if (isDeepSeek) payload.thinking = { type: "disabled" };
    return;
  }

  if (isDeepSeek && (thinkingMode === "on" || thinkingEffort !== "auto")) {
    payload.thinking = { type: "enabled" };
    delete payload.temperature;
  }
  if (thinkingEffort && thinkingEffort !== "auto") {
    payload.reasoning_effort = isDeepSeek
      ? (thinkingEffort === "max" || thinkingEffort === "xhigh" ? "max" : "high")
      : thinkingEffort;
  }
}

export class OpenAICompatibleEngine implements AgentEngine {
  readonly id: string;

  constructor(private readonly options: OpenAICompatibleEngineOptions) {
    if (!options.endpoint.trim()) throw new Error("OpenAI-compatible endpoint is required");
    if (!options.model.trim()) throw new Error("OpenAI-compatible model is required");
    this.id = options.id || "openai-compatible";
  }

  async *streamTurn(request: EngineTurnRequest): AsyncIterable<EngineOutputEvent> {
    request.signal.throwIfCancelled();
    const model = request.model?.modelId || this.options.model;
    const payload: Record<string, unknown> = {
      ...(this.options.requestBody || {}),
      model,
      messages: request.messages.map(mapMessage),
      stream: true,
      stream_options: { include_usage: true }
    };
    if (request.tools.length) payload.tools = request.tools.map(mapTool);
    else delete payload.tools;
    if (Number.isFinite(this.options.temperature)) {
      payload.temperature = this.options.temperature;
    }
    if (Number.isFinite(this.options.maxOutputTokens)) {
      payload.max_tokens = this.options.maxOutputTokens;
    }
    applyModelRequestOptions(payload, request, this.options.endpoint);

    yield {
      type: "model.request",
      request: {
        url: observableEndpoint(this.options.endpoint),
        providerId: request.model?.providerId,
        providerType: "openai",
        modelId: model,
        modelLabel: request.model?.label,
        stream: true,
        payload
      }
    };

    const credential = this.options.credentialProvider && this.options.credentialRef
      ? await this.options.credentialProvider.acquire({
          ref: this.options.credentialRef,
          providerId: request.model?.providerId,
          modelId: model
        })
      : null;
    if (this.options.credentialRequired && !credential && !this.options.apiKey) {
      throw new Error(`Credential is required: ${this.options.credentialRef || "model"}`);
    }

    try {
      const response = await this.options.transport({
        url: this.options.endpoint,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "text/event-stream, application/json",
          ...(this.options.headers || {}),
          ...(this.options.apiKey
            ? { authorization: `Bearer ${this.options.apiKey}` }
            : {}),
          ...(credential?.headers || {})
        },
        body: JSON.stringify(payload)
      }, request.signal);
      request.signal.throwIfCancelled();

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 2000);
        throw new Error(
          `Model HTTP ${response.status}${detail ? `: ${detail}` : response.statusText ? `: ${response.statusText}` : ""}`
        );
      }

      const contentType = Object.entries(response.headers || {})
        .find(([name]) => name.toLowerCase() === "content-type")?.[1] || "";
      if (!response.body || !contentType.toLowerCase().includes("text/event-stream")) {
        yield* this.consumeResponse(asRecord(await response.json()), request);
        return;
      }

      const toolBuffers = new Map<number, ToolCallBuffer>();
      let sawCompletionSignal = false;
      let finishReason = "";
      for await (const chunk of parseSse(response.body)) {
        request.signal.throwIfCancelled();
        if (chunk.__zionSseDone === true) {
          sawCompletionSignal = true;
          continue;
        }
        if (chunk.usage) {
          yield { type: "model.usage", usage: mapUsage(chunk.usage) };
        }
        const choice = asRecord(Array.isArray(chunk.choices) ? chunk.choices[0] : null);
        const nextFinishReason = String(
          choice.finish_reason ?? choice.finishReason ?? ""
        ).trim();
        if (nextFinishReason) {
          sawCompletionSignal = true;
          finishReason = nextFinishReason;
        }
        const delta = asRecord(choice.delta);
        const reasoning = contentText(delta.reasoning_content ?? delta.reasoning);
        const content = contentText(delta.content);
        if (reasoning) yield { type: "reasoning.delta", delta: reasoning };
        if (content) yield { type: "message.delta", delta: content };
        ingestToolCallDeltas(toolBuffers, delta.tool_calls);
      }

      if (!sawCompletionSignal) {
        throw incompleteStreamError(
          "Model response stream ended before a completion signal"
        );
      }
      assertCompleteFinishReason(finishReason);
      for (const [index, buffer] of Array.from(toolBuffers.entries()).sort(([a], [b]) => a - b)) {
        const definition = request.tools.find((tool) => tool.name === buffer.name);
        yield {
          type: "tool.call",
          call: completeToolCall(
            buffer,
            definition,
            `${request.attemptId}:turn:${request.turn}:tool:${index}`
          )
        };
      }
    } finally {
      await credential?.release?.();
    }
  }

  private async *consumeResponse(
    payload: Record<string, any>,
    request: EngineTurnRequest
  ): AsyncIterable<EngineOutputEvent> {
    const choice = asRecord(Array.isArray(payload.choices) ? payload.choices[0] : null);
    assertCompleteFinishReason(String(
      choice.finish_reason ?? choice.finishReason ?? ""
    ).trim());
    const message = asRecord(choice.message);
    const reasoning = contentText(message.reasoning_content ?? message.reasoning);
    const content = contentText(message.content);
    if (reasoning) yield { type: "reasoning.delta", delta: reasoning };
    if (content) yield { type: "message.delta", delta: content };
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (let index = 0; index < calls.length; index += 1) {
      const item = asRecord(calls[index]);
      const fn = asRecord(item.function);
      const buffer = {
        id: String(item.id || ""),
        name: String(fn.name || ""),
        argumentsText: String(fn.arguments || "")
      };
      yield {
        type: "tool.call",
        call: completeToolCall(
          buffer,
          request.tools.find((tool) => tool.name === buffer.name),
          `${request.attemptId}:turn:${request.turn}:tool:${index}`
        )
      };
    }
    if (payload.usage) {
      yield { type: "model.usage", usage: mapUsage(payload.usage) };
    }
  }
}
