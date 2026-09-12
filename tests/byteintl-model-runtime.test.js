import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CancellationController,
  OpenAICompatibleEngine
} from "../packages/runtime/src/index.ts";
import {
  createFetchModelTransport
} from "../apps/runtime/src/fetch-model-transport.mjs";
import {
  runtimeProfileToDynamicEntry
} from "../extensions/dev.langchain-chat/runtime-user-model-store.js";
import {
  buildByteIntlRequestPayload,
  createByteIntlAdapter,
  normalizeByteIntlAdapterConfig
} from "../extensions/dev.byteintl-model/byteintl-adapter.js";
import {
  installByteIntlModelProfile
} from "../extensions/dev.byteintl-model/install-profile.mjs";
import {
  activateRuntimePlugin
} from "../extensions/dev.byteintl-model/runtime.js";

const resources = [];

function config(overrides = {}) {
  return {
    upstreamUrl: "https://aidp.byteintl.net/api/modelhub/online/v2/crawl",
    model: "gpt-6-astra",
    host: "127.0.0.1",
    port: 0,
    timeoutMs: 5_000,
    defaultMaxTokens: 500,
    ...overrides
  };
}

async function startAdapter(options = {}) {
  const adapter = createByteIntlAdapter({
    config: config(options.config),
    fetchImpl: options.fetchImpl
  });
  resources.push(() => adapter.stop());
  return {
    adapter,
    ...(await adapter.start())
  };
}

afterEach(async () => {
  for (const dispose of resources.splice(0).reverse()) {
    await dispose();
  }
});

describe("ByteIntl Runtime model adapter", () => {
  it("forces non-streaming requests and injects the AK only at the upstream boundary", async () => {
    let observed = null;
    const fetchImpl = vi.fn(async (url, init) => {
      observed = {
        url: new URL(url),
        init,
        payload: JSON.parse(init.body)
      };
      return new globalThis.Response(JSON.stringify({
        choices: [{
          message: { role: "assistant", content: "2" },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 10, completion_tokens: 1 }
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-tt-logid": "upstream-log-id"
        }
      });
    });
    const { url } = await startAdapter({ fetchImpl });

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer private-ak",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "client-model",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "What is 1+1?" }]
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{
        message: { content: "2" },
        finish_reason: "stop"
      }]
    });
    expect(response.headers.get("x-tt-logid")).toBe("upstream-log-id");
    expect(observed.url.origin + observed.url.pathname).toBe(
      "https://aidp.byteintl.net/api/modelhub/online/v2/crawl"
    );
    expect(observed.url.searchParams.get("ak")).toBe("private-ak");
    expect(observed.init.headers).not.toHaveProperty("authorization");
    expect(observed.init.headers["x-tt-logid"]).toMatch(/^[a-f0-9]{32}$/);
    expect(observed.payload).toMatchObject({
      model: "gpt-6-astra",
      stream: false,
      max_tokens: 500,
      messages: [{
        role: "user",
        content: [{ type: "text", text: "What is 1+1?" }]
      }]
    });
    expect(observed.payload).not.toHaveProperty("stream_options");
  });

  it("preserves tool messages and configured max tokens", () => {
    const payload = buildByteIntlRequestPayload({
      stream: true,
      max_tokens: 128,
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "call-1" }] },
        { role: "tool", tool_call_id: "call-1", content: "result" }
      ]
    }, normalizeByteIntlAdapterConfig(config()));

    expect(payload).toMatchObject({
      stream: false,
      max_tokens: 128,
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "call-1" }] },
        { role: "tool", tool_call_id: "call-1", content: "result" }
      ]
    });
  });

  it("serves a complete turn to the existing OpenAI-compatible Engine", async () => {
    const fetchImpl = vi.fn(async () => new globalThis.Response(JSON.stringify({
      choices: [{
        message: { role: "assistant", content: "2" },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 8, completion_tokens: 1 }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const { url } = await startAdapter({ fetchImpl });
    const engine = new OpenAICompatibleEngine({
      endpoint: `${url}/v1/chat/completions`,
      apiKey: "private-ak",
      model: "gpt-6-astra",
      transport: createFetchModelTransport()
    });
    const events = [];

    for await (const event of engine.streamTurn({
      runId: "run-byteintl",
      attemptId: "attempt-byteintl",
      turn: 1,
      messages: [{ role: "user", content: "What is 1+1?" }],
      tools: [],
      model: {
        providerId: "byteintl",
        modelId: "gpt-6-astra"
      },
      signal: new CancellationController().signal
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: "model.request",
        request: expect.objectContaining({
          providerId: "byteintl",
          modelId: "gpt-6-astra",
          stream: true
        })
      }),
      { type: "message.delta", delta: "2" },
      {
        type: "model.usage",
        usage: expect.objectContaining({
          inputTokens: 8,
          outputTokens: 1
        })
      }
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("redacts the AK from upstream error responses and health output", async () => {
    const fetchImpl = vi.fn(async () => new globalThis.Response(JSON.stringify({
      error: { message: "credential private-ak was rejected" }
    }), {
      status: 401,
      headers: { "content-type": "application/json" }
    }));
    const { url } = await startAdapter({ fetchImpl });

    const health = await (await fetch(`${url}/health`)).text();
    expect(health).not.toContain("private-ak");

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer private-ak",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }]
      })
    });
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).toContain("[REDACTED]");
    expect(body).not.toContain("private-ak");
  });

  it("rejects unauthenticated loopback model requests", async () => {
    const fetchImpl = vi.fn();
    const { url } = await startAdapter({ fetchImpl });

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }]
      })
    });

    expect(response.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects credentials in upstream URLs and non-loopback listeners", () => {
    expect(() => normalizeByteIntlAdapterConfig(config({
      upstreamUrl: "https://aidp.byteintl.net/crawl?ak=inline-secret"
    }))).toThrow("must not contain credentials");
    expect(() => normalizeByteIntlAdapterConfig(config({
      host: "0.0.0.0"
    }))).toThrow("must listen on a loopback host");
  });

  it("starts and disposes through the Runtime Plugin API", async () => {
    const logs = [];
    const contribution = await activateRuntimePlugin({
      config: {
        adapter: config(),
        fetchImpl: vi.fn()
      },
      log(level, message) {
        logs.push({ level, message });
      }
    });
    resources.push(() => contribution.dispose());

    expect(logs).toEqual([
      expect.objectContaining({
        level: "info",
        message: expect.stringContaining("ByteIntl model adapter listening")
      })
    ]);
    expect(JSON.stringify(logs)).not.toContain("private-ak");
  });
});

describe("ByteIntl Runtime model profile installer", () => {
  it("upserts a credential-free profile without removing existing profiles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zion-byteintl-profile-"));
    resources.push(() => rm(directory, { recursive: true, force: true }));
    const profilePath = join(directory, "model-profiles.json");
    await writeFile(profilePath, JSON.stringify({
      version: 1,
      profiles: [{
        id: "existing",
        providerType: "openai",
        endpoint: "https://models.example/chat",
        model: "existing-model"
      }]
    }));
    await installByteIntlModelProfile({
      profilePath,
      adapterUrl: "http://127.0.0.1:8771/v1/chat/completions"
    });
    await installByteIntlModelProfile({
      profilePath,
      label: "Updated Astra",
      maxOutputTokens: 1024
    });

    const raw = await readFile(profilePath, "utf8");
    const store = JSON.parse(raw);
    expect(store.profiles).toEqual([
      expect.objectContaining({ id: "existing", model: "existing-model" }),
      expect.objectContaining({
        id: "workbench.user.dynamic.gpt-6-astra",
        label: "Updated Astra",
        providerId: "user.dynamic",
        providerType: "openai",
        endpoint: "http://127.0.0.1:8771/v1/chat/completions",
        model: "gpt-6-astra",
        credentialRequired: true,
        maxOutputTokens: 1024
      })
    ]);
    expect(raw).not.toContain("private-ak");
    expect(raw).not.toContain('"ak"');
    expect(runtimeProfileToDynamicEntry(store.profiles[1])).toMatchObject({
      id: "gpt-6-astra",
      config: {
        label: "Updated Astra",
        url: "http://127.0.0.1:8771/v1/chat/completions",
        modelName: "gpt-6-astra",
        _runtimeBacked: true,
        _credentialConfigured: false
      }
    });
  });
});
