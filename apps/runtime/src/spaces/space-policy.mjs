import { accountError } from "../accounts/account-policy.mjs";

export const DOCUMENT_PROTECTIONS = Object.freeze(["restricted", "space", "external"]);
export const DOCUMENT_ROLES = Object.freeze(["viewer", "commenter", "editor", "manager"]);
export const BINDING_KINDS = Object.freeze(["model", "skill", "plugin", "device"]);
const roleRank = Object.freeze({ none: 0, viewer: 1, commenter: 2, editor: 3, manager: 4 });
const membershipRoles = new Set(["owner", "admin", "member", "viewer"]);
const actions = Object.freeze({ view: 1, comment: 2, edit: 3, manage: 4 });

export function documentProtection(value) {
  if (!DOCUMENT_PROTECTIONS.includes(value)) throw accountError(400, "invalid_protection");
  return value;
}

export function documentRole(value) {
  if (!DOCUMENT_ROLES.includes(value)) throw accountError(400, "invalid_document_role");
  return value;
}

export function spaceText(value, label, maximum = 160) {
  if (typeof value !== "string") throw accountError(400, "invalid_field", `${label} is required`);
  const text = value.trim();
  if (!text || text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw accountError(400, "invalid_field", `${label} must contain 1–${maximum} characters`);
  }
  return text;
}

export function activeMember(membership) {
  return membership?.status === "active" && membershipRoles.has(membership.role);
}

export function isSpaceManager(membership) {
  return activeMember(membership) && ["owner", "admin"].includes(membership.role);
}

export function inheritedDocumentRole(membership) {
  if (!activeMember(membership)) return "none";
  if (isSpaceManager(membership)) return "manager";
  return membership.role === "viewer" ? "viewer" : "editor";
}

function activeGrant(grant, now) {
  return grant && !grant.revokedAt && (grant.expiresAt == null || grant.expiresAt > now);
}

/**
 * Relationship union is evaluated before policy ceilings. A governance role
 * contributes only through the explicitly chosen dynamic Space audience.
 * `groupIds` and membership must come from the authoritative database.
 */
export function effectiveDocumentAccess({
  userId, space, document, membership, grants = [], groupIds = [], now = Date.now()
}) {
  if (!userId || !space?.id || !document?.id || document.spaceId !== space.id) {
    return { role: "none", sources: [], reason: "scope_mismatch" };
  }
  if (document.lifecycle !== "active" || !DOCUMENT_PROTECTIONS.includes(document.protection)) {
    return { role: "none", sources: [], reason: "document_unavailable" };
  }
  if (!["space", "specific"].includes(document.audienceMode)) {
    return { role: "none", sources: [], reason: "invalid_audience" };
  }
  const member = activeMember(membership);
  if (membership && !membershipRoles.has(membership.role)) {
    return { role: "none", sources: [], reason: "invalid_membership_role" };
  }
  if (!member && (document.protection !== "external" || !space.allowExternal)) {
    return { role: "none", sources: [], reason: "membership_required" };
  }
  const sources = [];
  for (const grant of grants) {
    if (!activeGrant(grant, now)) continue;
    const direct = grant.subjectType === "user" && grant.subjectId === userId;
    const group = member && document.protection !== "restricted" &&
      grant.subjectType === "group" && groupIds.includes(grant.subjectId);
    if (!direct && !group) continue;
    if (!DOCUMENT_ROLES.includes(grant.role)) {
      return { role: "none", sources: [], reason: "invalid_grant_role" };
    }
    // An invalid legacy guest editor grant must not turn into valid editor access.
    if (!member && !["viewer", "commenter"].includes(grant.role)) {
      return { role: "none", sources: [], reason: "external_role_disallowed" };
    }
    sources.push({ type: direct ? "direct" : "group", id: grant.subjectId, role: grant.role });
  }
  if (member && document.protection !== "restricted" && document.audienceMode === "space") {
    sources.push({ type: "space", id: space.id, role: inheritedDocumentRole(membership) });
  }
  const role = sources.reduce((best, source) =>
    roleRank[source.role] > roleRank[best] ? source.role : best, "none");
  return { role, sources, effectiveSources: sources.filter(source => source.role === role) };
}

export function requireDocumentAccess(input, action = "view") {
  if (!Object.hasOwn(actions, action)) throw accountError(400, "invalid_document_action");
  const access = effectiveDocumentAccess(input);
  if (roleRank[access.role] < actions[action]) {
    // No private title, filename, role, or object-existence explanation in a denial.
    throw accountError(404, "document_not_found", "Document not found or unavailable");
  }
  return access;
}

export function requireSpaceExecution(membership) {
  if (!activeMember(membership) || membership.role === "viewer") {
    throw accountError(403, "space_run_required", "Space execution permission is required");
  }
}

export function validateDocumentAudience({
  protection, audienceMode, grants, memberIds, groupIds, allowExternal
}) {
  documentProtection(protection);
  if (!["space", "specific"].includes(audienceMode) || !Array.isArray(grants)) {
    throw accountError(400, "invalid_audience");
  }
  if (protection === "restricted" && (audienceMode !== "specific" ||
      grants.some(grant => grant.subjectType !== "user"))) {
    throw accountError(400, "restricted_requires_named_people");
  }
  const people = new Set(memberIds || []), groups = new Set(groupIds || []), unique = new Set();
  const normalized = grants.map(grant => {
    const role = documentRole(grant.role);
    const subjectType = grant.subjectType;
    const subjectId = spaceText(grant.subjectId, "Subject", 256);
    if (!["user", "group"].includes(subjectType)) throw accountError(400, "invalid_subject_type");
    const key = JSON.stringify([subjectType, subjectId]);
    if (unique.has(key)) throw accountError(400, "duplicate_grant");
    unique.add(key);
    if (subjectType === "group" && !groups.has(subjectId)) throw accountError(400, "unknown_group");
    if (subjectType === "user" && !people.has(subjectId) &&
        (protection !== "external" || !allowExternal || !["viewer", "commenter"].includes(role))) {
      throw accountError(403, "external_grant_disallowed");
    }
    return { subjectType, subjectId, role };
  });
  return { protection, audienceMode, grants: normalized };
}

/**
 * A source is not safe merely because the requester can read it. Dynamic
 * all-Space output requires an explicitly all-Space source; restricted
 * sources can feed only restricted audiences contained by their source.
 */
export function sourceAllowsAudience({ source, destination, sourceUsers, destinationUsers }) {
  if (source.spaceId !== destination.spaceId) return false;
  if (destination.audienceMode === "space" &&
      (source.protection === "restricted" || source.audienceMode !== "space")) return false;
  if (source.protection === "restricted" && destination.protection !== "restricted") return false;
  const readers = new Set(sourceUsers);
  return destinationUsers.every(userId => readers.has(userId));
}

export function audienceExpanded(previous, next) {
  const before = new Set(previous);
  return next.some(id => !before.has(id));
}

/**
 * Consumers receive a whitelist projection. Private source settings never
 * travel in the capability DTO, even when the source accidentally carries
 * credentials or personal installation metadata.
 */
export function bindingProjection(binding, provider) {
  const projection = {
    id: binding.id, spaceId: binding.spaceId, kind: binding.kind,
    name: binding.name, description: binding.description || "",
    status: binding.status, revision: binding.revision,
    provider: { id: provider.id, name: provider.name },
    audienceMode: binding.audienceMode, limits: { monthlyCalls: binding.limits?.monthlyCalls ?? null },
    allowedTools: binding.allowedTools || [], expiresAt: binding.expiresAt ?? null,
    sourceVersion: binding.sourceVersion || null
  };
  return structuredClone(projection);
}

export function publicProjection({ title, markdown, revision, reviewed }) {
  if (reviewed !== true) throw accountError(400, "publication_review_required");
  const safeTitle = spaceText(title, "Title");
  if (typeof markdown !== "string" || Buffer.byteLength(markdown, "utf8") > 4 * 1024 * 1024) {
    throw accountError(400, "publication_body_invalid");
  }
  if (!Number.isSafeInteger(revision) || revision < 1) throw accountError(400, "invalid_revision");
  return { title: safeTitle, markdown, revision, indexRequested: false };
}

export function integerLimit(value, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw accountError(400, "invalid_integer_limit");
  }
  return value;
}

export function invitationRecipient({ userId, email }) {
  if (userId) return { userId: spaceText(userId, "Recipient", 256), email: null };
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalized || normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw accountError(400, "recipient_required");
  }
  return { userId: null, email: normalized };
}
