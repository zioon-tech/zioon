export const runtimeAnnotationFields = new Set([
  "id", "kind", "runId", "segmentKey", "toolCallId", "assistantBlockId",
  "requiresDocumentAnchor", "name", "args", "result", "ok", "text",
  "status", "sequence", "artifactIds", "updatedAt", "executionContext", "from", "to",
  "detailRef", "detailSessionId", "detailHydratedRef",
  "bodyRef", "bodySessionId", "bodyKind", "bodyBytes", "bodyHydratedRef"
]);
export const annotationDefaultFields = new Set(["action", "actionAt", "userStartLine"]);
export const isRuntimeAnnotation = item => item?.requiresDocumentAnchor === true
  || (!!item?.runId && ["tool", "thinking"].includes(item.kind));

// Keep identities even for collapsed cards: omitting a card is a deletion,
// whereas omitting its default preferences only clears those preferences.
export function clientAnnotationSnapshot(annotations) {
  const value = annotations && typeof annotations === "object" ? annotations : {};
  const result = { ...value };
  for (const kind of ["tools", "thinking"]) {
    result[kind] = (Array.isArray(value[kind]) ? value[kind] : []).map(item => {
      if (!isRuntimeAnnotation(item)) return item;
      const local = Object.fromEntries(Object.entries(item).filter(([key, field]) =>
        !runtimeAnnotationFields.has(key)
        && !(key === "expanded" && field !== true)
        && !(annotationDefaultFields.has(key) && field == null)
      ));
      return {
        ...local, id: item.id,
        ...(item.kind ? { kind: item.kind } : {}),
        ...(item.runId ? { runId: item.runId } : {}),
        ...(item.requiresDocumentAnchor === true ? { requiresDocumentAnchor: true } : {})
      };
    });
  }
  return result;
}

// A copied session owns its historical cards locally. Its source Run cannot
// provide a projection for the new document, so preserve the copied body.
export function localSessionAnnotationCopy(annotations) {
  if (["tools", "thinking"].some(kind => annotations?.[kind]?.some(item => item.detailRef || item.bodyRef))) {
    throw new Error("Card details must be loaded before copying a session");
  }
  const result = { ...annotations };
  for (const kind of ["tools", "thinking"]) {
    if (!Array.isArray(annotations?.[kind])) continue;
    result[kind] = annotations[kind].map(item => {
      const { runId, requiresDocumentAnchor, detailRef, detailSessionId, detailHydratedRef,
        bodyRef, bodySessionId, bodyKind, bodyBytes, bodyHydratedRef, ...local } = item;
      return local;
    });
  }
  return result;
}
