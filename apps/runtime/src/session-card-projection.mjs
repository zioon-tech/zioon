import { createHash } from "node:crypto";
import { isRuntimeAnnotation } from "../../../packages/runtime-client/src/session-annotations.mjs";

const kinds = ["tools", "thinking"];
const detailBody = (kind, item) => kind === "tools" ? { result: item.result } : { text: item.text };
const refFor = (kind, item) => createHash("sha256")
  .update(JSON.stringify([kind, item.id, item.runId, detailBody(kind, item)])).digest("hex");

// Transport-only projection. The full record remains the durable source of truth.
export function sessionRenderProjection(record) {
  if (!record?.meta?.annotations) return record;
  const annotations = { ...record.meta.annotations };
  for (const kind of kinds) {
    if (!Array.isArray(annotations[kind])) continue;
    annotations[kind] = annotations[kind].map(item => {
      if (!isRuntimeAnnotation(item) || item.expanded === true
        || (kind === "tools" && (typeof item.ok !== "boolean" || item.result == null))
        || Buffer.byteLength(JSON.stringify(detailBody(kind, item))) < 2048) return item;
      return { ...item, ... (kind === "tools" ? { result: null } : { text: "" }),
        detailRef: refFor(kind, item), detailSessionId: record.id };
    });
  }
  return { ...record, meta: { ...record.meta, annotations }, annotationView: "render-v1" };
}

export function sessionCardDetails(record, requests) {
  if (!Array.isArray(requests) || !requests.length || requests.length > 100
    || requests.some(r => !kinds.includes(r?.kind) || typeof r.id !== "string"
      || !/^[a-f0-9]{64}$/.test(r.ref || ""))) {
    throw Object.assign(new Error("Invalid card detail request"), { statusCode: 400 });
  }
  const maps = Object.fromEntries(kinds.map(kind => [kind,
    new Map((record?.meta?.annotations?.[kind] || []).map(item => [String(item.id), item]))]));
  const details = requests.map(request => {
    const item = maps[request.kind].get(request.id);
    // Compare immutable detail content, not a throttled document revision snapshot.
    if (!item || refFor(request.kind, item) !== request.ref) {
      throw Object.assign(new Error("卡片内容已变化，请重新打开会话后重试。"),
        { statusCode: 409, code: "CARD_DETAIL_CHANGED" });
    }
    return { ...request, body: detailBody(request.kind, item) };
  });
  return { session_revision: record.session_revision, details };
}
