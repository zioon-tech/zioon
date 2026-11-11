import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4]
]) blocked.addSubnet(ip, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [ip, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]
]) blockedV6.addSubnet(ip, prefix, "ipv6");

export function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
}

export function extensionEndpoint(value, { trustedOrigins = [] } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid extension endpoint"); }
  const trusted = trustedOrigins.includes(url.origin);
  if ((!trusted && url.protocol !== "https:")
    || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash
    || url.href.length > 2048) throw new Error("Extension endpoint requires HTTPS without embedded credentials");
  return url;
}

/** Resolve once and pin the socket address while preserving TLS hostname verification. */
export function createExtensionHttpTransport({ trustedOrigins = [], resolve = lookup } = {}) {
  return async ({ endpoint, body, headers = {}, timeoutMs = 10_000,
    maxResponseBytes = 64 * 1024, responseMode = "body", signal }) => {
    const url = extensionEndpoint(endpoint, { trustedOrigins });
    if (Buffer.byteLength(body) > 512 * 1024) throw new Error("Extension request exceeds 512 KiB");
    const abort = new AbortController();
    const linked = () => abort.abort(signal.reason);
    if (signal?.aborted) linked();
    else signal?.addEventListener("abort", linked, { once: true });
    const timer = setTimeout(() => abort.abort(new Error("Extension request timed out")), timeoutMs);
    let onAbort;
    try {
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = await Promise.race([
        isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }])
          : resolve(hostname, { all: true, verbatim: true }),
        new Promise((_, reject) => {
          onAbort = () => reject(new Error("Extension request cancelled or timed out"));
          if (abort.signal.aborted) onAbort();
          else abort.signal.addEventListener("abort", onAbort, { once: true });
        })
      ]);
      if (!addresses.length || (!trustedOrigins.includes(url.origin)
        && addresses.some(({ address }) => !publicAddress(address)))) {
        throw new Error("Extension endpoint resolves to a restricted address");
      }
      abort.signal.throwIfAborted();
      const selected = addresses[0];
      return await new Promise((accept, reject) => {
        const request = (url.protocol === "https:" ? https : http).request(url, {
          method: "POST", agent: false, signal: abort.signal,
          lookup(_name, options, callback) {
            if (options.all) callback(null, [selected]);
            else callback(null, selected.address, selected.family);
          },
          headers: {
            ...headers, "content-type": "application/json",
            "content-length": Buffer.byteLength(body)
          }
        }, (response) => {
          if (responseMode === "status") {
            accept({ status: response.statusCode, body: "" });
            response.destroy();
            return;
          }
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > maxResponseBytes) {
              response.destroy(new Error("Extension response exceeds limit"));
            } else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => accept({
            status: response.statusCode, body: Buffer.concat(chunks).toString("utf8")
          }));
        });
        request.on("error", reject);
        request.end(body);
      });
    } finally {
      clearTimeout(timer);
      if (onAbort) abort.signal.removeEventListener("abort", onAbort);
      signal?.removeEventListener("abort", linked);
    }
  };
}
