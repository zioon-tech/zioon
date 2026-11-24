// Runtime owns card content in its durable Run/Yjs projection. The client
// persists card preferences and actions, and all content of legacy local cards.
import {
  runtimeAnnotationFields as projectedFields,
  annotationDefaultFields as defaultSnapshotFields,
  isRuntimeAnnotation
} from "../../../packages/runtime-client/src/session-annotations.mjs";
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;

export function annotationPersistenceKey(annotations) {
  const value = annotations && typeof annotations === "object" ? annotations : {};
  const result = { ...value };
  for (const kind of ["tools", "thinking"]) {
    result[kind] = (Array.isArray(value[kind]) ? value[kind] : []).flatMap(item => {
      const projected = isRuntimeAnnotation(item);
      if (!projected) return [item];
      const local = Object.fromEntries(Object.entries(item).filter(([key, field]) =>
        !projectedFields.has(key)
        && !(key === "expanded" && field !== true)
        && !(defaultSnapshotFields.has(key) && field == null)
      ));
      return Object.keys(local).length ? [{ ...local, id: item.id }] : [];
    });
  }
  if (!Object.keys(result.toolActions || {}).length) delete result.toolActions;
  return JSON.stringify(canonical(result));
}
