import { extensionAccountId } from "./run-bindings.mjs";
import { DEFAULT_INTERACTION_PROFILE_ID, resolveInteractionRequest } from "../interaction-profile-store.mjs";

const fail = (code, statusCode = 422) => {
  throw Object.assign(new Error(code), { code, statusCode });
};

/** Account-owned defaults. Explicit Session/Run models are resolved separately. */
export class AccountModelSelection {
  constructor({ marketplace, listProfiles, interactionProfiles, resolveModel, fallbackModel, sharedSpaces = null }) {
    Object.assign(this, { marketplace, listProfiles, interactionProfiles, resolveModel, fallbackModel, sharedSpaces });
  }
  profile(id = DEFAULT_INTERACTION_PROFILE_ID) {
    const profile = this.interactionProfiles.get(id);
    if (!profile) fail("interaction_profile_not_found", 404);
    return profile;
  }
  async get(principal, id = DEFAULT_INTERACTION_PROFILE_ID) {
    const profile = this.profile(id);
    if (this.sharedSpaces) {
      await this.sharedSpaces.member(principal.userId || principal.user?.id, principal.spaceId || principal.space?.id);
      const space = await this.sharedSpaces.policy(principal.spaceId || principal.space?.id);
      const selectedProfileId = space.defaultBindingId ? `space.${space.defaultBindingId}` : null;
      return { interactionProfileId: id, selectedProfileId,
        modelProfileId: selectedProfileId || profile.modelProfileId || this.fallbackModel?.profileId,
        model: selectedProfileId ? { profileId: selectedProfileId } : profile.model || this.fallbackModel };
    }
    const accountId = extensionAccountId(principal);
    const state = accountId && this.marketplace ? await this.marketplace.account(accountId) : null;
    const selectedProfileId = state?.modelSelections?.[id]?.profileId || null;
    return { interactionProfileId: id, selectedProfileId,
      modelProfileId: selectedProfileId || profile.modelProfileId || profile.model?.profileId || null,
      model: selectedProfileId ? { profileId: selectedProfileId } : profile.model || null };
  }
  async set(principal, profileId, id = DEFAULT_INTERACTION_PROFILE_ID) {
    this.profile(id);
    if (profileId !== null && (typeof profileId !== "string" || !profileId.trim())) fail("model_selection_invalid");
    const selected = profileId === null ? null : profileId.trim();
    if (selected && !(await this.listProfiles(principal)).some((profile) => profile.id === selected)) {
      fail("model_profile_unavailable");
    }
    if (this.sharedSpaces) {
      if (selected && !selected.startsWith("space.")) fail("shared_default_requires_capability");
      const spaceId = principal.spaceId || principal.space?.id;
      const space = await this.sharedSpaces.policy(spaceId);
      await this.sharedSpaces.updatePolicy(principal.userId || principal.user?.id, spaceId, {
        expectedRevision: space.revision, defaultBindingId: selected ? selected.slice(6) : null
      });
      return this.get(principal, id);
    }
    if (this.marketplace) {
      const accountId = extensionAccountId(principal);
      if (!accountId) fail("authentication_required", 401);
      await this.marketplace.transaction(accountId, undefined, async (state) => {
        state.modelSelections ||= {};
        if (selected) state.modelSelections[id] = { profileId: selected, updatedAt: Date.now() };
        else delete state.modelSelections[id];
        return {};
      });
    } else {
      // The legacy loopback Runtime has a single owner and no account store.
      if (!selected) fail("model_selection_reset_unavailable");
      this.interactionProfiles.patch(id, { modelProfileId: selected });
    }
    return this.get(principal, id);
  }
  async resolve(requested, principal) {
    return this.resolveModel(requested, principal);
  }
  async defaultModel(principal, id = DEFAULT_INTERACTION_PROFILE_ID) {
    const active = await this.get(principal, id);
    return this.resolve(active.modelProfileId ? { profileId: active.modelProfileId } : active.model || this.fallbackModel, principal);
  }
  async resolveRequest(body, principal) {
    const resolved = resolveInteractionRequest({ body, interactionProfiles: this.interactionProfiles, fallbackModel: this.fallbackModel });
    return { ...resolved, model: body.model
      ? await this.resolve(body.model, principal)
      : await this.defaultModel(principal, body.interactionProfileId || DEFAULT_INTERACTION_PROFILE_ID) };
  }
}

export function createModelManagementPluginService({ listProfiles, importProfile, deleteProfile, selection }) {
  return Object.freeze({
    listProfiles: (context = {}) => listProfiles(context.principal),
    upsertProfile: (input) => {
      if (!importProfile) fail("model_profile_import_unavailable", 501);
      return importProfile(input);
    },
    deleteProfile: (id) => {
      if (!deleteProfile) fail("model_profile_delete_unavailable", 501);
      return deleteProfile(id);
    },
    getActiveModel: ({ interactionProfileId, principal } = {}) => selection.get(principal, interactionProfileId),
    setActiveProfile: (id, { interactionProfileId, principal } = {}) => selection.set(principal, id, interactionProfileId)
  });
}
