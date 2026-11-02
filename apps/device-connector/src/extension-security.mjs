import { createHmac, Hmac, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

// Capture signing primitives before loading user code. Inspector, child
// processes and native addons are denied by the plugin's Node permissions.
const apply = Reflect.apply;
const hmacUpdate = Hmac.prototype.update;
const hmacDigest = Hmac.prototype.digest;
const stringify = JSON.stringify;
const newHmac = createHmac;
export function signFrame(key, sequence, value) {
  const payload = stringify(value);
  const hmac = newHmac("sha256", key);
  apply(hmacUpdate, hmac, [`${sequence}\n${payload}`, "utf8"]);
  return stringify({ sequence, payload, signature: apply(hmacDigest, hmac, ["hex"]) });
}
export function readFrame(key, sequence, frame) {
  if (frame.sequence !== sequence || typeof frame.payload !== "string"
    || !/^[a-f0-9]{64}$/.test(frame.signature || "")) throw new Error("extension_frame_invalid");
  const expected = JSON.parse(signFrame(key, sequence, JSON.parse(frame.payload))).signature;
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(frame.signature, "hex"))) throw new Error("extension_frame_invalid");
  return JSON.parse(frame.payload);
}
export async function canonicalExtensionConfig(config) {
  return { ...config, workspaceRoot: await realpath(resolve(config.workspaceRoot)),
    ...(config.credentialsFile ? { credentialsFile: await realpath(resolve(config.credentialsFile)) } : {}) };
}
export function credentialSecrets(credentials) {
  return [...new Set([...Object.values(credentials.env || {}), ...Object.values(credentials.headers || {})]
    .filter((v) => typeof v === "string" && v).flatMap((v) =>
      (/^Bearer /i.test(v) ? [v, v.slice(7)] : [v]).flatMap((s) => [s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1)]))
  )].sort((a, b) => b.length - a.length);
}
export function redactValue(value, secrets) {
  let text = JSON.stringify(value);
  if (text === undefined) return undefined;
  for (const secret of secrets) text = text.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]");
  return JSON.parse(text);
}
export function streamRedactor(secrets) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  return (bytes, final = false) => {
    pending += final ? decoder.decode() : decoder.decode(bytes, { stream: true });
    let boundary = pending.length;
    if (!final) for (const secret of secrets) {
      for (let n = Math.min(secret.length - 1, pending.length); n > 0; n--) {
        if (pending.endsWith(secret.slice(0, n))) { boundary = Math.min(boundary, pending.length - n); break; }
      }
    }
    for (const secret of secrets) {
      let at = pending.indexOf(secret);
      while (at >= 0 && at < boundary) {
        if (at + secret.length > boundary) boundary = at;
        at = pending.indexOf(secret, at + secret.length);
      }
    }
    let safe = pending.slice(0, boundary);
    pending = pending.slice(boundary);
    for (const secret of secrets) safe = safe.split(secret).join("[redacted]");
    return Buffer.from(safe);
  };
}
