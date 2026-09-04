import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearHealthCache,
  proxyLLMRequest
} from "../extensions/dev.langchain-chat/llm-proxy";

describe("LLM Runtime gateway", () => {
  afterEach(() => {
    clearHealthCache();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("routes browser compatibility requests through Runtime", async () => {
    localStorage.setItem("zion.runtime.baseUrl", "http://127.0.0.1:9876/");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        service: "zion-runtime"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response("data: ok\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyLLMRequest({
      url: "https://api.deepseek.com/chat/completions",
      method: "POST",
      headers: {
        authorization: "Bearer legacy-browser-key",
        "content-type": "application/json"
      },
      body: { model: "deepseek-chat", stream: true }
    });

    expect(await response.text()).toBe("data: ok\n\n");
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:9876/health");
    expect(fetchMock.mock.calls[1][0]).toBe(
      "http://127.0.0.1:9876/v1/model-gateway/proxy"
      + "?target=https%3A%2F%2Fapi.deepseek.com%2Fchat%2Fcompletions"
    );
  });
});
