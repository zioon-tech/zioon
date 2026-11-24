import {
  annotationDefaultFields, isRuntimeAnnotation, runtimeAnnotationFields
} from "./session-annotations.mjs";

const object = value => value != null && typeof value === "object" && !Array.isArray(value);
const equal = (a, b) => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((value, index) => equal(value, b[index]));
  }
  if (!object(a) || !object(b)) return false;
  const keys = Object.keys(a).filter(key => a[key] !== undefined);
  return keys.length === Object.keys(b).filter(key => b[key] !== undefined).length
    && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
};
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const forbiddenKey = key => ["__proto__", "constructor", "prototype"].includes(key);
const annotationList = path => path.length === 2 && path[0] === "annotations"
  && ["tools", "thinking"].includes(path[1]);
const keyedList = value => Array.isArray(value)
  && value.every(item => object(item) && typeof item.id === "string" && item.id.length)
  && new Set(value.map(item => item.id)).size === value.length;

// Legacy clients send entire arrays. Apply their actual edits by stable card
// identity and field, preserving cards/content added by another client or Run.
function mergeAnnotation(current, before, after, path, conflicts) {
  if (annotationList(path) && [current, before, after].every(value =>
    value === undefined || keyedList(value))) {
    const base = new Map((before || []).map(item => [item.id, item]));
    const desired = new Map((after || []).map(item => [item.id, item]));
    const live = new Map((current || []).map(item => [item.id, item]));
    for (const id of new Set([...base.keys(), ...desired.keys()])) {
      const old = base.get(id), next = desired.get(id), existing = live.get(id);
      // The Run owns the lifetime and content of projected cards. A stale
      // preference snapshot cannot delete or resurrect one.
      if (isRuntimeAnnotation(existing) && next === undefined) continue;
      if (!existing && old && isRuntimeAnnotation(old)) continue;
      const merged = mergeAnnotation(existing, old, next, [...path, id], conflicts);
      if (merged === undefined) live.delete(id);
      else live.set(id, merged);
    }
    return [...live.values()];
  }
  if (object(current) && object(after) && (object(before) || before === undefined)) {
    const result = copy(current);
    const projected = path.length === 3 && annotationList(path.slice(0, 2))
      && [current, before, after].some(isRuntimeAnnotation);
    for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after)])) {
      if (forbiddenKey(key)) {
        throw Object.assign(new Error("Invalid annotation field"), { statusCode: 400 });
      }
      if (projected && runtimeAnnotationFields.has(key)) continue;
      const normalize = value => projected
        && ((key === "expanded" && value !== true)
          || (annotationDefaultFields.has(key) && value == null)) ? undefined : value;
      const previous = normalize(before?.[key]), desired = normalize(after[key]);
      if (equal(previous, desired)) continue;
      const merged = mergeAnnotation(normalize(current[key]), previous, desired, [...path, key], conflicts);
      if (merged === undefined) delete result[key];
      else result[key] = merged;
    }
    return result;
  }
  if (equal(before, after) || equal(current, after)) return copy(current);
  if (equal(current, before)) return copy(after);
  conflicts.push(path.join("."));
  return copy(current);
}

// Include both ends of each edit. Unchanged fields never become write intent.
export function sessionMetadataChanges(base = {}, desired = {}, path = []) {
  const changes = [];
  for (const key of new Set([...Object.keys(base), ...Object.keys(desired)])) {
    const beforePresent = Object.hasOwn(base, key) && base[key] !== undefined;
    const afterPresent = Object.hasOwn(desired, key) && desired[key] !== undefined;
    if (beforePresent === afterPresent && equal(base[key], desired[key])) continue;
    if (beforePresent && afterPresent && object(base[key]) && object(desired[key])) {
      changes.push(...sessionMetadataChanges(base[key], desired[key], [...path, key]));
    } else {
      changes.push({
        path: [...path, key], beforePresent, afterPresent,
        ...(beforePresent ? { before: copy(base[key]) } : {}),
        ...(afterPresent ? { after: copy(desired[key]) } : {})
      });
    }
  }
  return changes;
}

export function applySessionMetadataChanges(current, changes) {
  if (!Array.isArray(changes) || changes.length > 10000) {
    throw Object.assign(new Error("Invalid metadata changes"), { statusCode: 400 });
  }
  const result = copy(current || {});
  const conflicts = [];
  for (const change of changes) {
    if (!Array.isArray(change?.path) || !change.path.length || change.path.length > 32
      || change.path.some(key => typeof key !== "string"
        || forbiddenKey(key))) {
      throw Object.assign(new Error("Invalid metadata change path"), { statusCode: 400 });
    }
    let parent = result;
    for (const key of change.path.slice(0, -1)) {
      if (!object(parent[key])) {
        conflicts.push(change.path.join("."));
        parent = null;
        break;
      }
      parent = parent[key];
    }
    if (!parent) continue;
    const key = change.path.at(-1);
    if (change.path[0] === "annotations") {
      const merged = mergeAnnotation(parent[key], change.beforePresent ? change.before : undefined,
        change.afterPresent ? change.after : undefined, change.path, conflicts);
      if (merged === undefined) delete parent[key];
      else parent[key] = merged;
      continue;
    }
    const present = Object.hasOwn(parent, key);
    const matches = (has, value) => present === has && (!has || equal(parent[key], value));
    if (matches(change.afterPresent, change.after)) continue;
    if (!matches(change.beforePresent, change.before)) {
      conflicts.push(change.path.join("."));
      continue;
    }
    if (change.afterPresent) parent[key] = copy(change.after);
    else delete parent[key];
  }
  return { meta: result, conflicts };
}
