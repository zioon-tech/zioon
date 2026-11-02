import { describe, expect, it, vi } from "vitest";
import { CancellationController } from "../../../packages/runtime/src/index";
import { executeWebSearch, parseWebSearchResponse } from "../src/web-search.mjs";

const markdown = [
  "Title: Search at DuckDuckGo", "Markdown Content:",
  "1.[Python &amp; Docs](http://duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F)",
  "Official **Python** documentation.", "docs.python.org", "",
  "2. [Duplicate](https://docs.python.org/#intro)", "Duplicate snippet.", "",
  "3.[Other](https://python.org.evil.example/)", "Other snippet.", "",
  "4.[Tutorial](https://www.python.org/tutorial/)", "Learn Python.", "www.python.org/tutorial/"
].join("\n");

function search(args = {}, options = {}) {
  return executeWebSearch({ query: "Python documentation", ...args }, {
    signal: new CancellationController().signal,
    fetchImpl: vi.fn(async () => new Response(markdown)),
    ...options
  });
}

describe("Runtime web search", () => {
  it("parses numbered reader output and unwraps encoded source URLs", () => {
    expect(parseWebSearchResponse(markdown)[0]).toEqual({
      title: "Python & Docs", url: "https://docs.python.org/",
      snippet: "Official Python documentation."
    });
  });

  it("parses DDG Lite HTML and rejects non-web and credential-bearing URLs", () => {
    const html = `<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F" class="result-link">An &lt;example&gt;</a>
      <td class="result-snippet">A <b>useful</b> result.</td>`;
    expect(parseWebSearchResponse(html)).toEqual([
      { title: "An <example>", url: "https://example.com/", snippet: "A useful result." }
    ]);
    const unsafe = [
      "1.[Script](javascript:alert%281%29)", "2.[Credential](https://user:pass@example.com/)",
      "3.[Deceptive](https://duckduckgo.com.evil.example/l/?uddg=https%3A%2F%2Fexample.com)",
      "4.[Good](https://example.com/)"
    ].join("\n");
    const results = parseWebSearchResponse(unsafe);
    expect(results.map((result) => result.url)).toEqual([
      "https://duckduckgo.com.evil.example/l/?uddg=https%3A%2F%2Fexample.com", "https://example.com/"
    ]);
  });

  it("applies exact/subdomain filters, deduplicates sources and limits results", async () => {
    const fetchImpl = vi.fn(async () => new Response(markdown));
    const result = await search({
      allowed_domains: ["PYTHON.org"], blocked_domains: ["www.python.org"], top_k: 2
    }, { fetchImpl });
    expect(JSON.parse(result.content).results.map((item) => item.url)).toEqual(["https://docs.python.org/"]);
    const request = String(fetchImpl.mock.calls[0][0]);
    expect(request).toContain(encodeURIComponent("site:python.org"));
    expect(request).toContain(encodeURIComponent("-site:www.python.org"));
    expect(JSON.parse((await search({ top_k: 1 })).content).results).toHaveLength(1);
  });

  it.each([
    { query: "" }, { query: "x".repeat(2049) }, { top_k: 0 },
    { top_k: 21 }, { top_k: 2.5 }, { allowed_domains: "example.com" },
    { blocked_domains: ["example.com/path"] }, { allowed_domains: ["a@b.com"] }
  ])("rejects invalid search input before any network request: %j", async (args) => {
    const fetchImpl = vi.fn();
    await expect(search(args, { fetchImpl })).rejects.toMatchObject({ failureCode: "invalid_arguments" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses a second proxy when the first returns HTTP failure or a challenge", async () => {
    for (const response of [new Response("", { status: 503 }), new Response("Unfortunately, bots use DuckDuckGo. anomaly.js")]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(new Response(markdown));
      expect((await search({}, { fetchImpl })).ok).toBe(true);
      expect(String(fetchImpl.mock.calls[0][0])).toContain("r.jinaai.cn/");
      expect(String(fetchImpl.mock.calls[1][0])).toContain("r.jina.ai/");
      expect(fetchImpl.mock.calls[0][1].redirect).toBe("error");
    }
  });

  it("distinguishes genuine empty results and filtered results from malformed responses", async () => {
    expect(JSON.parse((await search({}, {
      fetchImpl: async () => new Response("No results found for this query")
    })).content).results).toEqual([]);
    expect(JSON.parse((await search({ allowed_domains: ["unrelated.example"] })).content).results).toEqual([]);
    expect(await search({}, {
      fetchImpl: async () => new Response("A changed provider layout")
    })).toMatchObject({ ok: false, failureCode: "search_provider_response" });
    expect(await search({}, {
      fetchImpl: async () => new Response("Please verify you are human")
    })).toMatchObject({ ok: false, failureCode: "search_provider_challenge" });
  });

  it("bounds streamed input and preserves valid JSON when limiting output", async () => {
    expect(await search({}, { maxResponseBytes: 16 })).toMatchObject({ ok: false, failureCode: "size_limit" });
    const result = await search({}, { maxResultChars: 200 });
    expect(result.ok).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(200);
    expect(JSON.parse(result.content)).toMatchObject({ query: "Python documentation", truncated: true });
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(17)); },
      cancel
    })));
    expect(await search({}, { fetchImpl, maxResponseBytes: 16 })).toMatchObject({ ok: false, failureCode: "size_limit" });
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("aborts a stalled body within the shared deadline and reports timeout", async () => {
    const fetchImpl = vi.fn(async (_url, options) => new Response(new ReadableStream({
      start(controller) {
        options.signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      }
    })));
    const start = Date.now();
    expect(await search({}, { fetchImpl, timeoutMs: 60 })).toMatchObject({ ok: false, failureCode: "timeout" });
    expect(Date.now() - start).toBeLessThan(500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending request without starting the fallback", async () => {
    const cancellation = new CancellationController();
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const fetchImpl = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      started();
    }));
    const pending = search({}, { fetchImpl, signal: cancellation.signal });
    await ready;
    cancellation.cancel("user-request");
    await expect(pending).rejects.toThrow(/cancel/i);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
