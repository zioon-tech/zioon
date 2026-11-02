import { createHash } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";
import { accountError } from "./account-policy.mjs";

function policyBinding(policy) {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

export function createAccountExecutionAuthority({ accessControl, profiles }) {
  const accounts = accessControl.accounts;
  const authorizeExecution = async (context) => await accessControl.authorizeRunExecution(context);
  return Object.freeze({
    authorizeExecution,
    async authorizePluginFile(context, { write, path }) {
      const request = context?.request && typeof context.request === "object"
        ? context.request
        : {};
      const policy = await authorizeExecution({
        principal: context?.principal || request.principal,
        policy: context?.policy || request.policy,
        interactionProfileId: context?.interactionProfileId || request.interactionProfileId,
        metadata: context?.metadata || request.metadata
      });
      if (write && policy.preset === "read-only") throw accountError(403, "file_write_denied");
      if (!isAbsolute(String(path || ""))) throw accountError(403, "absolute_file_path_required");
      if (policy.fileRoots.length && !policy.fileRoots.some((root) => {
        const difference = relative(resolve(root), resolve(path));
        return !difference || (difference !== ".." && !difference.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(difference));
      })) throw accountError(403, "file_outside_grant");
    },
    async authorizeDelegation({ projectKey, actor, policy, interactionProfileId }) {
      const sourceId = `project:${projectKey}`;
      const profile = profiles.get(interactionProfileId);
      const result = await accessControl.authorizeTask(
        actor,
        { capability: policy },
        profile,
        sourceId
      );
      await accounts.setDelegation(sourceId, result.executionPrincipal, policyBinding(policy));
      return { delegated: true, projectKey, principal: result.executionPrincipal };
    },
    async authorizeProject({ projectKey, policy, spaceId }) {
      const delegation = await accounts.getDelegation(`project:${projectKey}`, spaceId);
      if (!delegation || delegation.binding !== policyBinding(policy)) {
        throw accountError(403, "project_delegation_required", "Project policy requires a current account delegation");
      }
      return {
        principal: delegation.principal,
        policy: await authorizeExecution({ principal: delegation.principal, policy })
      };
    },
    async revokeDelegation({ projectKey, actor, spaceId: requestedSpaceId }) {
      let userId;
      let spaceId = requestedSpaceId;
      if (actor?.kind === "account") {
        await accessControl.reauthorize(actor, "runtime.manage");
        userId = actor.user.id;
        spaceId = actor.space.id;
      } else {
        const grant = await accounts.validateGrant(actor);
        if (!grant.scopes.includes("runtime.manage")) throw accountError(403, "task_management_denied");
        userId = grant.principal.userId;
        spaceId = grant.principal.spaceId;
      }
      await accounts.revokeDelegation(userId, `project:${projectKey}`, spaceId);
    }
  });
}
