import { createHmac, timingSafeEqual } from "node:crypto";

export function signRuntimeExtension(secret, { timestamp, id, body }) {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${id}.${body}`).digest("hex")}`;
}

export function verifyRuntimeExtension(secret, { timestamp, id, body, signature },
  { now = Date.now(), toleranceMs = 5 * 60_000 } = {}) {
  if (!Number.isSafeInteger(Number(timestamp)) || Math.abs(now - Number(timestamp)) > toleranceMs
    || typeof id !== "string" || !id || typeof signature !== "string"
    || !/^v1=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = Buffer.from(signRuntimeExtension(secret, { timestamp, id, body }));
  return timingSafeEqual(expected, Buffer.from(signature));
}

export function parseRuntimeHookRequest(secret, { body, headers }, options) {
  const timestamp = String(headers["x-zion-timestamp"] || "");
  const id = String(headers["x-zion-hook-id"] || "");
  if (Buffer.byteLength(body) > 512 * 1024 || !verifyRuntimeExtension(secret, {
    timestamp, id, body, signature: headers["x-zion-signature"]
  }, options)) throw new Error("Invalid or expired Hook request signature");
  const envelope = JSON.parse(body);
  if (envelope.schemaVersion !== 1 || envelope.context?.schemaVersion !== 1
    || envelope.context.idempotencyKey !== id) throw new Error("Invalid Hook request protocol");
  return { context: envelope.context, timestamp, id };
}

export function signedRuntimeHookResponse(secret, request, decision) {
  const response = { schemaVersion: 1, decision: decision || { action: "pass" } };
  return {
    response,
    signature: signRuntimeExtension(secret, { ...request, body: JSON.stringify(response) })
  };
}
