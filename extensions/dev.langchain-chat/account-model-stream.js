import {
  createHttpRuntimeClient,
  createRemoteRunHandle
} from "../../src/runtime/http-runtime-client.ts";
import {
  modelRequestOptions,
  readInteractiveRuntimeConfig,
  resolveInteractiveRuntimeModel
} from "./runtime-backend.js";

function catalogModel(active) {
  const catalog = globalThis.window?.zion?.state?.get?.("models.catalog");
  return (Array.isArray(catalog) ? catalog : []).find((item) =>
    item.providerId === active?.providerId && item.id === active?.modelId
    && (!active.profileId || item.runtimeProfileId === active.profileId)
  );
}

export function isAccountPluginModel(active) {
  return String(active?.profileId || "").startsWith("extension.")
    || String(active?.providerId || "").startsWith("extension.")
    || catalogModel(active)?.accountExtension === true;
}

export function isRuntimeManagedModel(active) {
  return isAccountPluginModel(active)
    || !!String(active?.profileId || catalogModel(active)?.runtimeProfileId || "");
}

/** Tool-free calls use the same pinned Runtime model route as interactive Runs. */
export async function runAccountModelStream({
  activeModel,
  messages,
  tools,
  onToken,
  onEnd,
  getController,
  sessionId,
  runId,
  requestSource
}) {
  if (tools?.length) {
    throw Object.assign(new Error("插件模型的工具调用需要通过 Runtime 对话执行"), {
      code: "extension_model_tools_require_runtime"
    });
  }
  const controller = new AbortController();
  let handle;
  const abort = () => {
    if (!handle) return;
    void handle.abort("user").catch(() => {});
    handle.detach();
  };
  controller.signal.addEventListener("abort", abort, { once: true });
  try {
    getController?.(controller);
    controller.signal.throwIfAborted();
    const client = createHttpRuntimeClient({
      baseUrl: readInteractiveRuntimeConfig().baseUrl
    });
    const descriptor = catalogModel(activeModel);
    const selected = {
      ...activeModel,
      profileId: activeModel.profileId || descriptor?.runtimeProfileId
    };
    const catalog = await client.getModels();
    const model = await resolveInteractiveRuntimeModel(client, selected, null, catalog);
    const profile = catalog.profiles?.find((item) => item.id === model.profileId);
    const accountModel = isAccountPluginModel(selected);
    if ((selected.profileId && model.profileId !== selected.profileId)
      || (accountModel && !String(model.profileId).startsWith("extension."))
      || (selected.providerId && model.providerId !== selected.providerId)
      || (selected.modelId && ![model.modelId, profile?.sourceModelId].includes(selected.modelId))) {
      throw Object.assign(new Error("所选模型已不可用"), {
        code: accountModel ? "extension_model_unavailable" : "runtime_model_unavailable"
      });
    }
    controller.signal.throwIfAborted();
    handle = await createRemoteRunHandle(client, {
      messages,
      model,
      modelOptions: modelRequestOptions(activeModel),
      policy: accountModel ? {
        // Compatibility Nodes bootstrap the model Host through these tools.
        // modelOnly keeps them out of the model request and rejects tool calls.
        preset: "trusted-automation",
        allowedTools: ["write", "Bash"],
        fileRoots: [],
        allowedCommandPrefixes: []
      } : {
        preset: "read-only",
        allowedTools: [],
        fileRoots: [],
        allowedCommandPrefixes: []
      },
      // A sessionId would append this auxiliary prompt/result to the chat and
      // trigger its post-processors again. Keep the source only for diagnostics.
      metadata: {
        source: requestSource || "runtime-model-generation",
        modelOnly: true,
        sourceRunId: runId || "",
        sourceSessionId: sessionId || ""
      }
    }, {
      stopAtTerminal: true,
      subscription: { mode: "projection", reasoningMode: "none" }
    });
    if (controller.signal.aborted) {
      abort();
      controller.signal.throwIfAborted();
    }
    let output = "";
    for await (const event of handle.events) {
      controller.signal.throwIfAborted();
      if (event.type === "message.delta") {
        const delta = String(event.data?.delta || "");
        output += delta;
        if (delta) onToken?.(delta);
      }
    }
    controller.signal.throwIfAborted();
    const result = await handle.completion;
    if (result.status === "aborted") return { aborted: true, reasoning_content: "" };
    if (result.status !== "completed") {
      throw Object.assign(new Error(result.error || result.reason || "模型调用失败"), {
        code: result.status === "waiting" ? "runtime_model_unexpected_waiting" : "runtime_model_request_failed"
      });
    }
    // Terminal polling may recover a completed Run after a lost final event.
    if (result.output && result.output !== output) {
      if (!result.output.startsWith(output)) {
        throw Object.assign(new Error("模型输出不完整"), { code: "incomplete_stream" });
      }
      onToken?.(result.output.slice(output.length));
    }
    onEnd?.();
    const usage = result.usage;
    return { reasoning_content: "", usage: usage && {
      ...usage,
      input_tokens: usage.inputTokens ?? usage.input_tokens ?? 0,
      output_tokens: usage.outputTokens ?? usage.output_tokens ?? 0,
      reasoning_tokens: usage.reasoningTokens ?? usage.reasoning_tokens ?? 0,
      cache_read_input_tokens: usage.cacheReadTokens ?? usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cacheWriteTokens ?? usage.cache_creation_input_tokens ?? 0
    } };
  } catch (error) {
    if (controller.signal.aborted) return { aborted: true, reasoning_content: "" };
    throw error;
  } finally {
    controller.signal.removeEventListener("abort", abort);
    handle?.detach();
  }
}
