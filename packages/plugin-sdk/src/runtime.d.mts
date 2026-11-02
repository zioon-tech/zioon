import type { PluginModelDescriptor, NormalizedPluginManifest, ToolExecutionPolicy } from "./manifest.js";

export type Disposable = { dispose(): void | Promise<void> };
export type JsonSchema = Record<string, unknown>;
export type Message = { role: "system" | "user" | "assistant" | "tool"; content: unknown; [key: string]: unknown };
export type Usage = Partial<Record<"inputTokens" | "outputTokens" | "reasoningTokens" | "cacheReadTokens" | "cacheWriteTokens", number>>;
export type CancellationSignal = {
  readonly cancelled: boolean;
  readonly reason?: string;
  throwIfCancelled(): void;
  onCancel(listener: (reason: string) => void): Disposable;
};
export type Data = {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
};
export type HandlerContext = {
  runId: string;
  attemptId: string;
  sessionId?: string;
  invocationId: string;
  idempotencyKey: string;
  workspaceRoot: string;
  signal: CancellationSignal;
  abortSignal: AbortSignal;
  data: Data;
  env: Readonly<Record<string, string>>;
  settings: Readonly<Record<string, unknown>>;
  recordUsage(usage: Usage): void;
  request?: { principal: { userId: string; spaceId?: string }; [key: string]: unknown };
  [key: string]: unknown;
};
export type Tool<Input extends Record<string, unknown> = Record<string, unknown>, Output = unknown> = {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  execution?: Partial<ToolExecutionPolicy>;
  invoke(input: Input, context: HandlerContext): Output | Promise<Output>;
};
export type ContextProvider = {
  id: string;
  required?: boolean;
  order?: number;
  stage?: "pre" | "post";
} & ({
  prepare(request: HandlerContext["request"], context: HandlerContext): Message[] | { messages: Message[] } | Promise<Message[] | { messages: Message[] }>;
  contribute?: never;
} | {
  contribute(messages: Message[], context: HandlerContext): Message[] | Promise<Message[]>;
  prepare?: never;
});
export type Controller = {
  id: string;
  required?: boolean;
  order?: number;
  beforeStart?(context: HandlerContext): unknown | Promise<unknown>;
  beforeTurn?(context: HandlerContext): string | void | Promise<string | void>;
  beforeModel?(context: HandlerContext): string | void | Promise<string | void>;
  beforeStop?(context: HandlerContext): string | null | void | Promise<string | null | void>;
  beforeTool?(invocation: unknown, context: HandlerContext): string | { ok: false; content: string } | void | Promise<string | { ok: false; content: string } | void>;
  afterTool?(invocation: unknown, result: unknown, context: HandlerContext): unknown | Promise<unknown>;
  afterRun?(context: HandlerContext): unknown | Promise<unknown>;
};
export type Processor = {
  id: string;
  order?: number;
  process(input: unknown, context: HandlerContext): unknown | Promise<unknown>;
};
export type Job = Processor & { inputSchema?: JsonSchema; execution?: Partial<ToolExecutionPolicy>; triggers?: string[] };
export type ModelRequest = {
  model: string;
  messages: unknown[];
  stream: boolean;
  stream_options?: { include_usage: boolean };
  tools?: unknown[];
  [key: string]: unknown;
};
export type ModelResponse = Response | {
  status: number;
  headers?: Record<string, string>;
  body: string | Uint8Array | AsyncIterable<string | Uint8Array>;
};
export type ModelProvider = {
  id: string;
  description?: string;
  models: PluginModelDescriptor[];
  request(input: ModelRequest, context: HandlerContext): ModelResponse | Promise<ModelResponse>;
};
export type RuntimePluginContext = {
  apiVersion: 2;
  plugin: Omit<NormalizedPluginManifest, "runtimeApiVersion" | "legacyEnvelope"> & { runtime: { apiVersion: 2 } };
  config: Readonly<Record<string, unknown>>;
  credentials: Readonly<{ endpoint?: string; env?: Record<string, string>; headers?: Record<string, string> }>;
  data: Data;
  locations: { data: { root: string } };
  log(level: string, message: string): void;
  state: { namespace(name?: string): { read(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> } };
  tools: { registerTool<Input extends Record<string, unknown>, Output>(tool: Tool<Input, Output>): Disposable };
  context: { registerProvider(provider: ContextProvider): Disposable };
  models: { registerProvider(provider: ModelProvider): Disposable };
  runs: {
    registerController(controller: Controller): Disposable;
    registerPostProcessor(processor: Processor): Disposable;
    registerCommands(handler: (input: Record<string, unknown>, context: HandlerContext) => unknown | Promise<unknown>, options?: { execution?: Partial<ToolExecutionPolicy>; inputSchema?: JsonSchema }): Disposable;
  };
  jobs: { registerHandler(job: Job): Disposable; enqueue(id: string, payload: unknown): void };
  events: { on(type: string, handler: (payload: unknown, context: HandlerContext) => unknown | Promise<unknown>): Disposable; emit(type: string, payload: unknown): void };
};
export type RuntimePluginContribution = {
  tools?: Tool[];
  contextProviders?: ContextProvider[];
  controllers?: Controller[];
  runPostProcessors?: Processor[];
  modelProviders?: ModelProvider[];
  jobs?: Job[];
  dispose?(): void | Promise<void>;
};
export function defineToolPlugin<Input extends Record<string, unknown>, Output>(tool: Tool<Input, Output>): (context: RuntimePluginContext) => RuntimePluginContribution;
export function defineModelPlugin(provider: ModelProvider): (context: RuntimePluginContext) => RuntimePluginContribution;
