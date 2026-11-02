import { EXTENSIONS_CALL_TOOL } from "./execution-service.mjs";
import { hashExtension } from "../../../../packages/runtime-client/src/extension-package.mjs";

// Deterministic CLI operations still traverse ordinary Run admission and tools.
export class ExtensionInvocationEngine {
  constructor({ engine, runs, resolvePluginTool = () => null }) {
    this.engine = engine;
    this.runs = runs;
    this.resolvePluginTool = resolvePluginTool;
    this.id = engine.id;
  }
  async *streamTurn(request) {
    const run = await this.runs.get(request.runId);
    const native = run?.metadata?.pluginToolInvocation;
    if (native) {
      const tool = this.resolvePluginTool(native.pluginId, native.tool);
      if (!tool || !native.arguments || typeof native.arguments !== "object" || Array.isArray(native.arguments)) {
        throw new Error("Installed Runtime plugin tool unavailable or invalid arguments");
      }
      const callId = `plugin-${hashExtension([request.runId, native]).slice(0, 24)}`;
      const result = request.messages.findLast((message) => message.role === "tool" && message.toolCallId === callId);
      if (result) {
        if (result.toolResultStatus?.ok !== true) throw new Error(String(result.content));
        yield { type: "message.delta", delta: String(result.content) };
        return;
      }
      if (!request.tools.some((definition) => definition.name === native.tool)) throw new Error("Plugin tool is not allowed by this Run's capability policy");
      yield { type: "tool.call", call: { id: callId, name: native.tool, arguments: native.arguments } };
      return;
    }
    const operation = run?.metadata?.extensionInvocation;
    if (!operation) { yield* this.engine.streamTurn(request); return; }
    const callId = `extension-${hashExtension([request.runId, operation]).slice(0, 24)}`;
    const result = request.messages.findLast((message) => message.role === "tool" && message.toolCallId === callId);
    if (result) {
      // Transcript carries actual tool output, including policy-denied failures.
      if (result.toolResultStatus?.ok !== true) throw new Error(String(result.content));
      yield { type: "message.delta", delta: String(result.content) };
      return;
    }
    if (!request.tools.some((tool) => tool.name === EXTENSIONS_CALL_TOOL.name)) throw new Error("extensionsCall is not allowed by this Run's capability policy");
    yield { type: "tool.call", call: { id: callId, name: EXTENSIONS_CALL_TOOL.name, arguments: operation } };
  }
}
