// Authentication proves identity. These application roles bound what that
// identity may do inside the explicitly selected Runtime Space.
export const ACCOUNT_ROLES = Object.freeze(["owner", "admin", "member", "viewer"]);
const READ = ["runtime.read", "observability.read"];
const WRITE = [...READ, "runtime.write", "collaboration.write", "run.execute"];
const ADMIN = [...WRITE, "runtime.manage", "pairing.manage", "device.manage", "resource.execute"];
const SCOPES = Object.freeze({
  owner: [...ADMIN, "members.manage", "owner.manage"],
  admin: [...ADMIN, "members.manage"],
  member: WRITE,
  viewer: READ
});

export function accountError(statusCode, code, message = code) {
  return Object.assign(new Error(message), { statusCode, code });
}

export function accountRole(value) {
  if (!ACCOUNT_ROLES.includes(value)) {
    throw accountError(400, "invalid_role", "Unknown Space role");
  }
  return value;
}

export function roleScopes(role) {
  return [...(SCOPES[role] || [])];
}

export function requireAccountScope(member, scope) {
  if (!member || member.status !== "active") {
    throw accountError(403, "membership_required", "Space membership is required");
  }
  if (!roleScopes(member.role).includes(scope)) {
    throw accountError(403, "permission_denied", `Permission required: ${scope}`);
  }
  return member;
}

const PRIVILEGED_TOOLS = new Set([
  "modelsManage", "toolsManage", "pluginsManage", "terminalManage", "mailManage",
  "projectAutomationManage", "schedulerManage", "sendMail", "mcpCall"
]);
const RANK = new Map([["read-only", 1], ["workspace-write", 2], ["trusted-automation", 3]]);

// Empty roots/prefixes historically mean unrestricted, so intersection must
// never turn a disjoint restriction into an empty (unrestricted) list.
function boundedList(requested, ceiling, label, within = (a, b) => a === b) {
  const upper = [...new Set(Array.isArray(ceiling) ? ceiling.map(String) : [])];
  const lower = [...new Set(Array.isArray(requested) ? requested.map(String) : [])];
  if (!upper.length) return lower;
  if (!lower.length) return upper;
  const result = lower.filter((item) => upper.some((limit) => within(item, limit)));
  if (!result.length) throw accountError(403, "policy_outside_grant", `${label} exceeds the task grant`);
  return result;
}

function withinRoot(path, root) {
  // Runtime/Device path normalization performs the final OS-specific check.
  const clean = (value) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  const candidate = clean(path);
  const parent = clean(root);
  if (candidate.split("/").includes("..") || parent.split("/").includes("..")) return false;
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

export function intersectAccountPolicy(requested = {}, ceiling = {}, role = "viewer") {
  if (!roleScopes(role).includes("run.execute")) {
    throw accountError(403, "permission_denied", "This member cannot execute Runs");
  }
  const rank = Math.min(RANK.get(requested.preset) || 1, RANK.get(ceiling.preset) || 1);
  const upper = new Set(ceiling.allowedTools || []);
  const admin = role === "owner" || role === "admin";
  return {
    preset: [...RANK].find(([, value]) => value === rank)[0],
    allowedTools: [...new Set(requested.allowedTools || [])].filter((name) =>
      upper.has(name) && (admin || !PRIVILEGED_TOOLS.has(name))),
    fileRoots: boundedList(requested.fileRoots, ceiling.fileRoots, "File roots", withinRoot),
    allowedCommandPrefixes: boundedList(
      requested.allowedCommandPrefixes, ceiling.allowedCommandPrefixes, "Commands"),
    allowedTerminalSessionIds: boundedList(
      requested.allowedTerminalSessionIds, ceiling.allowedTerminalSessionIds, "Terminals"),
    allowedRecipients: Array.isArray(requested.allowedRecipients)
      && requested.allowedRecipients.length
      ? boundedList(
          requested.allowedRecipients, ceiling.allowedRecipients, "Recipients",
          (candidate, limit) =>
            limit === "*"
            || candidate.toLowerCase() === limit.toLowerCase()
        )
      : [],
    maxToolCalls: Math.min(
      Math.max(1, Number(requested.maxToolCalls) || 50),
      Math.max(1, Number(ceiling.maxToolCalls) || 50)),
    maxMailPerRun: Math.min(
      Math.max(0, Number(requested.maxMailPerRun) || 0),
      Math.max(0, Number(ceiling.maxMailPerRun) || 0))
  };
}
