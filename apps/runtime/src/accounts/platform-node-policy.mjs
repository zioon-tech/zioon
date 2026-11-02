import { accountError } from "./account-policy.mjs";

// Platform hosts are never an execution target for user sessions or Runs.
// Existing operator jobs may keep their exact, revocable service grants.
export function createPlatformNodePolicy({
  nodeIds = [],
  serviceGrantIds = [],
  accounts
} = {}) {
  const platformNodes = new Set(nodeIds.map(String).filter(Boolean));
  const serviceGrants = new Set(serviceGrantIds.map(String).filter(Boolean));
  return async (context, target) => {
    if (!platformNodes.has(target.node.registration.nodeId)) return;
    const principal = context?.principal;
    if (
      principal?.version === 1
      && serviceGrants.has(String(principal.grantId || ""))
      && accounts?.validateGrant
    ) {
      const grant = await accounts.validateGrant(principal);
      if (
        grant.principal.kind === "service"
        && serviceGrants.has(grant.principal.grantId)
      ) {
        return;
      }
    }
    throw accountError(
      403,
      "platform_node_execution_denied",
      "This Node hosts platform services and is unavailable for user execution; use your managed workspace or an authorized Device"
    );
  };
}
