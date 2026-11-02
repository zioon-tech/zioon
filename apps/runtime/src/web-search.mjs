import { normalizeToolExecution } from "../../../packages/plugin-sdk/src/tool-execution.mjs";

export const WEB_SEARCH_TOOL_DEFINITION = {
  name: "webSearch",
  description: "Search the public web and return titles, source URLs and snippets. Supports optional domain filters.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 2048 },
      top_k: { type: "integer", minimum: 1, maximum: 20, default: 5 },
      allowed_domains: { type: "array", maxItems: 32, items: { type: "string" } },
      blocked_domains: { type: "array", maxItems: 32, items: { type: "string" } }
    },
    required: ["query"],
    additionalProperties: false
  },
  hostKinds: ["runtime"],
  execution: normalizeToolExecution({ effect: "read" })
};

const PROXY_ORIGINS = ["https://r.jinaai.cn", "https://r.jina.ai"];
const MAX_RESPONSE_BYTES = 512 * 1024;

function searchError(code, message) {
  return Object.assign(new Error(message), { failureCode: code });
}

function domains(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw searchError("invalid_arguments", `${label} must contain at most 32 domains`);
  }
  return [...new Set(value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 253
      || /[\s/@:?#\\]/.test(item.trim())) {
      throw searchError("invalid_arguments", `${label} requires domain names without paths`);
    }
    let hostname;
    try { hostname = new URL(`https://${item.trim()}`).hostname.replace(/\.$/, ""); }
    catch { throw searchError("invalid_arguments", `Invalid domain in ${label}`); }
    if (!hostname.split(".").every((part) =>
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(part))) {
      throw searchError("invalid_arguments", `Invalid domain in ${label}`);
    }
    return hostname.toLowerCase();
  }))];
}

function normalizeInput(args = {}) {
  if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 2048) {
    throw searchError("invalid_arguments", "webSearch.query must contain 1 to 2048 characters");
  }
  const topK = args.top_k ?? 5;
  if (!Number.isInteger(topK) || topK < 1 || topK > 20) {
    throw searchError("invalid_arguments", "webSearch.top_k must be an integer from 1 to 20");
  }
  return {
    query: args.query.trim(), topK,
    allowed: domains(args.allowed_domains, "allowed_domains"),
    blocked: domains(args.blocked_domains, "blocked_domains")
  };
}

function decodeEntities(value) {
  return String(value).replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi, (entity) => {
    const named = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const number = entity.toLowerCase().startsWith("&#x")
      ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : "";
  });
}

function plainText(value) {
  return decodeEntities(String(value).replace(/<[^>]*>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\\([\\[\]()*_])/g, "$1").replace(/[*_`]/g, ""))
    .replace(/\s+/g, " ").trim();
}

function resultUrl(value) {
  try {
    let url = new URL(decodeEntities(value), "https://duckduckgo.com");
    for (let attempt = 0; attempt < 3; attempt++) {
      const hostname = url.hostname.toLowerCase();
      if (hostname !== "duckduckgo.com" && !hostname.endsWith(".duckduckgo.com")) break;
      const destination = url.searchParams.get("uddg");
      if (!destination) return null;
      url = new URL(destination);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    if (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) return null;
    url.hash = "";
    return url.href.length <= 4096 ? url.href : null;
  } catch { return null; }
}

export function parseWebSearchResponse(content) {
  const source = String(content);
  const results = [];
  const numbered = [...source.matchAll(/^\s*\d+\s*[.)]\s*\[(.+)\]\((\S+)\)[ \t]*$/gm)];
  for (let index = 0; index < numbered.length; index++) {
    const match = numbered[index];
    const url = resultUrl(match[2]);
    if (!url) continue;
    const lines = source.slice(match.index + match[0].length,
      numbered[index + 1]?.index ?? source.length).trim().split(/\r?\n/);
    // DDG Lite includes a displayed domain after each snippet.
    if (/^(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?\s*$/i.test(lines.at(-1) || "")) lines.pop();
    results.push({
      title: plainText(match[1]).slice(0, 500), url,
      snippet: plainText(lines.join(" ")).slice(0, 1500)
    });
  }
  if (!numbered.length) {
    const links = [...source.matchAll(/<a\b([^>]*\bclass\s*=\s*["'][^"']*\bresult-link\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)];
    for (let index = 0; index < links.length; index++) {
      const match = links[index];
      const href = match[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
      const url = href && resultUrl(href);
      if (!url) continue;
      const after = source.slice(match.index + match[0].length, links[index + 1]?.index ?? source.length);
      const snippet = after.match(/<td\b[^>]*\bclass\s*=\s*["'][^"']*\bresult-snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i)?.[1] || "";
      results.push({ title: plainText(match[2]).slice(0, 500), url, snippet: plainText(snippet).slice(0, 1500) });
    }
  }
  if (results.length) return results;
  if (/no results (?:found|for)|no more results|we couldn't find any results/i.test(plainText(source))) return [];
  if (/captcha|anomaly\.js|bots use DuckDuckGo|verify (?:that )?you are (?:a )?human/i.test(source)) {
    throw searchError("search_provider_challenge", "Search provider requires human verification");
  }
  throw searchError("search_provider_response", "Search provider returned no recognizable results");
}

function matchesDomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function formatResults(input, parsed, maxChars) {
  const seen = new Set();
  const results = parsed.filter((result) => {
    const hostname = new URL(result.url).hostname.toLowerCase().replace(/\.$/, "");
    if (seen.has(result.url)
      || (input.allowed.length && !input.allowed.some((domain) => matchesDomain(hostname, domain)))
      || input.blocked.some((domain) => matchesDomain(hostname, domain))) return false;
    seen.add(result.url);
    return true;
  }).slice(0, input.topK);
  const payload = { query: input.query, results };
  if (JSON.stringify(payload).length <= maxChars) return JSON.stringify(payload);
  payload.truncated = true;
  while (payload.results.length && JSON.stringify(payload).length > maxChars) payload.results.pop();
  if (JSON.stringify(payload).length > maxChars) {
    throw searchError("size_limit", "Search result limit is too small for the query");
  }
  return JSON.stringify(payload);
}

async function boundedBody(response, signal, maxBytes) {
  const declared = Number(response.headers?.get("content-length") || 0);
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw searchError("size_limit", "Search provider response exceeded the size limit");
  }
  if (!response.body?.getReader) {
    const content = await response.text();
    if (Buffer.byteLength(content) > maxBytes) throw searchError("size_limit", "Search provider response exceeded the size limit");
    return content;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfCancelled();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw searchError("size_limit", "Search provider response exceeded the size limit");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function executeWebSearch(args, {
  fetchImpl = globalThis.fetch, signal, invocationId = "",
  timeoutMs = 30_000, maxResultChars = 30_000,
  maxResponseBytes = MAX_RESPONSE_BYTES
} = {}) {
  signal.throwIfCancelled();
  const input = normalizeInput(args);
  const searchQuery = [
    input.query,
    ...(input.allowed.length ? [`(${input.allowed.map((domain) => `site:${domain}`).join(" OR ")})`] : []),
    ...input.blocked.map((domain) => `-site:${domain}`)
  ].join(" ");
  const source = `http://lite.duckduckgo.com/lite/?q=${encodeURIComponent(searchQuery)}`;
  const deadline = Date.now() + timeoutMs;
  const failures = [];
  for (let index = 0; index < PROXY_ORIGINS.length; index++) {
    signal.throwIfCancelled();
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const controller = new AbortController();
    const subscription = signal.onCancel(() => controller.abort());
    // Reserve part of the single overall deadline for the fallback.
    const timer = setTimeout(() => controller.abort(),
      Math.max(1, Math.floor(remaining / (PROXY_ORIGINS.length - index))));
    const proxy = new URL(`${PROXY_ORIGINS[index]}/${source}`);
    try {
      const response = await fetchImpl(proxy, {
        method: "GET", redirect: "error",
        headers: { accept: "text/markdown, text/plain;q=0.9", "x-zion-invocation-id": invocationId },
        signal: controller.signal
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const code = response.status === 429 ? "rate_limit"
          : response.status >= 500 ? "http_5xx" : "http_4xx";
        throw searchError(code, `HTTP ${response.status}`);
      }
      const content = await boundedBody(response, signal, maxResponseBytes);
      const results = parseWebSearchResponse(content);
      return { ok: true, content: formatResults(input, results, maxResultChars) };
    } catch (error) {
      signal.throwIfCancelled();
      const code = error.failureCode || (controller.signal.aborted ? "timeout" : "network_error");
      failures.push({ code, message: `${proxy.hostname}: ${error.failureCode ? error.message : code}` });
    } finally {
      clearTimeout(timer);
      subscription.dispose();
    }
  }
  const failureCode = failures.find((failure) => failure.code === "rate_limit")?.code
    || failures.at(-1)?.code || "timeout";
  const message = `webSearch provider attempts failed: ${failures.map((failure) => failure.message).join("; ") || "timeout"}`;
  return { ok: false, failureCode, error: message, content: message };
}
