function modelRef(profile) {
  return {
    profileId: profile.id,
    providerId: profile.providerId,
    modelId: profile.model,
    label: profile.label
  };
}

function conflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

export class ProfileRoutingEngine {
  constructor({
    registry,
    activeProfileId,
    createEngine
  } = {}) {
    if (!registry?.get || !registry?.resolveModelRef) {
      throw new Error("ProfileRoutingEngine requires a ModelRegistry");
    }
    if (typeof createEngine !== "function") {
      throw new Error("ProfileRoutingEngine requires an engine factory");
    }
    this.registry = registry;
    this.activeProfileId = String(activeProfileId || registry.defaultProfileId || "");
    this.createEngine = createEngine;
    this.engines = new Map();
    this.id = "zion.model-profile-router";
  }

  activeProfile() {
    return this.registry.get(this.activeProfileId);
  }

  resolveModel(requested = null) {
    let profile;
    try {
      profile = requested
        ? this.registry.resolveModelRef(requested)
        : this.activeProfile();
    } catch (error) {
      throw conflict(error.message);
    }
    return modelRef(profile);
  }

  engineFor(profileId) {
    const profile = this.registry.get(profileId);
    const signature = JSON.stringify(profile);
    const cached = this.engines.get(profileId);
    if (cached?.signature === signature) return cached.engine;
    const engine = this.createEngine(profile);
    if (!engine?.streamTurn) {
      throw new Error(`Invalid Agent engine for model profile: ${profileId}`);
    }
    this.engines.set(profileId, { signature, engine });
    return engine;
  }

  async *streamTurn(request) {
    const resolved = this.resolveModel(request.model);
    const engine = this.engineFor(resolved.profileId);
    yield* engine.streamTurn({
      ...request,
      model: resolved
    });
  }
}

export function modelRefForProfile(profile) {
  return modelRef(profile);
}
