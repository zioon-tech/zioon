import {
  DEFAULT_INTERACTIVE_PROFILE_ID,
  DYNAMIC_PROVIDER_ID,
  MODELS_MANAGE_ACTIONS,
  MODELS_MANAGE_TOOL_NAME,
  dynamicConfigPatchFromArgs,
  dynamicConfigToRuntimeImport,
  modelsManageToolDefinition,
  runtimeProfileToDynamicEntry,
  runtimeProfileIdForDynamicModel,
  summarizeRuntimeProfile
} from "./models-runtime-shared.js";

export const runtimePluginApiVersion = 2;

function requireModelService(context) {
  const service = context.config?.modelService;
  if (!service || typeof service !== "object") {
    throw new Error("Runtime model management service is unavailable");
  }
  return service;
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function parseImportData(data) {
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      const error = new Error("Invalid data: not JSON");
      error.statusCode = 400;
      throw error;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    const error = new Error("Invalid data: expect object map { id: config }");
    error.statusCode = 400;
    throw error;
  }
  return data;
}

function profileMatches(profile, {
  providerId = "",
  modelId = "",
  profileId = ""
} = {}) {
  const pid = String(providerId || "").trim();
  const mid = String(modelId || "").trim();
  const rid = String(profileId || "").trim();
  if (rid && profile.id !== rid) return false;
  if (pid && profile.providerId !== pid) return false;
  if (!mid) return true;
  return profile.id === mid
    || profile.model === mid
    || profile.sourceModelId === mid;
}

function findProfile(profiles, args = {}) {
  const providerId = String(args.provider_id || "").trim();
  const modelId = String(args.model_id || "").trim();
  if (!modelId && !providerId) return null;
  const dynamicProfileId = providerId === DYNAMIC_PROVIDER_ID && modelId
    ? runtimeProfileIdForDynamicModel(modelId)
    : "";
  return (dynamicProfileId ? profiles.find((profile) =>
    profileMatches(profile, { profileId: dynamicProfileId })
  ) : null) || profiles.find((profile) =>
    profileMatches(profile, { providerId, modelId })
  ) || null;
}

function dynamicStoreFromProfiles(profiles) {
  const dict = {};
  for (const profile of profiles) {
    const entry = runtimeProfileToDynamicEntry(profile);
    if (entry) dict[entry.id] = entry.config;
  }
  return dict;
}

function filterSummaries(profiles, args = {}) {
  const providerId = String(args.provider_id || "").trim();
  const modelId = String(args.model_id || "").trim();
  const availability = String(args.availability || "").trim();
  return profiles
    .map(summarizeRuntimeProfile)
    .filter((model) => {
      if (providerId && model.providerId !== providerId) return false;
      if (modelId && model.id !== modelId && model.model !== modelId && model.profileId !== modelId) return false;
      if (availability && model.availability?.status !== availability) return false;
      return true;
    });
}

function requireDynamicProvider(args = {}) {
  const providerId = String(args.provider_id || DYNAMIC_PROVIDER_ID).trim() || DYNAMIC_PROVIDER_ID;
  if (providerId !== DYNAMIC_PROVIDER_ID) {
    const error = new Error("Runtime modelsManage writes are limited to user.dynamic");
    error.statusCode = 400;
    throw error;
  }
  return providerId;
}

async function upsertDynamicModel(service, modelId, config, {
  mergeWithExisting = true,
  principal
} = {}) {
  const profiles = await service.listProfiles({ principal });
  const existingProfile = profiles.find((profile) =>
    profile.id === runtimeProfileIdForDynamicModel(modelId)
  );
  const existingEntry = existingProfile ? runtimeProfileToDynamicEntry(existingProfile) : null;
  const nextConfig = mergeWithExisting
    ? { ...(existingEntry?.config || {}), ...(config || {}) }
    : { ...(config || {}) };
  const importable = dynamicConfigToRuntimeImport(modelId, nextConfig);
  if (!importable) {
    const error = new Error("Runtime model profile requires model_id, url, model, and provider_type=openai");
    error.statusCode = 400;
    throw error;
  }
  const result = await service.upsertProfile({
    profile: importable.profile,
    ...(importable.credential ? { credential: importable.credential } : {})
  });
  return {
    modelId,
    config: nextConfig,
    profile: result.profile
  };
}

export function activateRuntimePlugin(context) {
  const service = requireModelService(context);
  const definition = modelsManageToolDefinition();
  const registration = context.tools.registerTool({
    name: MODELS_MANAGE_TOOL_NAME,
    description: definition.description,
    inputSchema: definition.inputSchema,
    execution: { effect: "write" },
    policy: { minimumPreset: "trusted-automation" },
    async invoke(args = {}, invocationContext = {}) {
      try {
        const action = String(args.action || "").trim();
        if (!MODELS_MANAGE_ACTIONS.includes(action)) {
          return { ok: false, content: `Unknown action: ${action}`, error: `Unknown action: ${action}` };
        }

        if (action === "list" || action === "check") {
          const profiles = await service.listProfiles(invocationContext);
          const models = filterSummaries(profiles, args);
          const summary = {};
          for (const model of filterSummaries(profiles)) {
            const status = model.availability?.status || "unknown";
            summary[status] = (summary[status] || 0) + 1;
          }
          return {
            ok: true,
            content: json({
              models,
              active: await service.getActiveModel({ principal: invocationContext.principal }),
              summary,
              note: action === "check"
                ? "Runtime check reports stored profile and credential state; browser provider health probes are Workbench-only."
                : undefined
            })
          };
        }

        if (action === "get") {
          const profile = findProfile(await service.listProfiles(invocationContext), args);
          if (!profile) return { ok: false, content: "Model not found", error: "Model not found" };
          return {
            ok: true,
            content: json({
              ...summarizeRuntimeProfile(profile),
              profile
            })
          };
        }

        if (action === "export") {
          const providerId = String(args.provider_id || DYNAMIC_PROVIDER_ID).trim();
          if (providerId === DYNAMIC_PROVIDER_ID) {
            return {
              ok: true,
              content: json(dynamicStoreFromProfiles(await service.listProfiles(invocationContext)))
            };
          }
          return {
            ok: true,
            content: json((await service.listProfiles(invocationContext)).filter((profile) =>
              !providerId || profile.providerId === providerId
            ))
          };
        }

        if (action === "set_active") {
          const profile = findProfile(await service.listProfiles(invocationContext), args);
          if (!profile) return { ok: false, content: "Model not found", error: "Model not found" };
          if (
            args.force !== true
            && profile.credentialRequired !== false
            && profile.credentialConfigured !== true
          ) {
            return {
              ok: false,
              content: json({
                error: "Model credential is not configured",
                profileId: profile.id
              }),
              error: "Model credential is not configured"
            };
          }
          const active = await service.setActiveProfile(profile.id, {
            interactionProfileId: args.interaction_profile_id || DEFAULT_INTERACTIVE_PROFILE_ID,
            principal: invocationContext.principal
          });
          return {
            ok: true,
            content: json({
              set_active: profile.id,
              active,
              profile: summarizeRuntimeProfile(profile)
            })
          };
        }

        requireDynamicProvider(args);
        const modelId = String(args.model_id || "").trim();
        if ((action === "add" || action === "update") && !modelId) {
          return { ok: false, content: "Missing model_id", error: "Missing model_id" };
        }

        if (action === "add" || action === "update") {
          const saved = await upsertDynamicModel(
            service,
            modelId,
            dynamicConfigPatchFromArgs(args),
            { mergeWithExisting: action === "update", principal: invocationContext.principal }
          );
          return {
            ok: true,
            content: json({ saved })
          };
        }

        if (action === "delete") {
          if (!modelId) return { ok: false, content: "Missing model_id", error: "Missing model_id" };
          const profileId = runtimeProfileIdForDynamicModel(modelId);
          const deleted = await service.deleteProfile(profileId);
          if (!deleted?.profile) {
            return { ok: false, content: "Model not found", error: "Model not found" };
          }
          return {
            ok: true,
            content: json({
              deleted: `${DYNAMIC_PROVIDER_ID}:${modelId}`,
              profile: deleted.profile
            })
          };
        }

        if (action === "import") {
          const data = parseImportData(args.data);
          const results = [];
          for (const [id, config] of Object.entries(data)) {
            results.push(await upsertDynamicModel(service, id, config, {
              mergeWithExisting: args.merge !== false, principal: invocationContext.principal
            }));
          }
          return {
            ok: true,
            content: json({
              imported: Object.keys(data).length,
              total: results.length,
              runtime: results.length,
              profiles: results.map((item) => item.profile)
            })
          };
        }

        return { ok: false, content: `Unknown action: ${action}`, error: `Unknown action: ${action}` };
      } catch (error) {
        context.log?.("error", `${MODELS_MANAGE_TOOL_NAME} failed: ${error?.message || error}`);
        return {
          ok: false,
          content: `modelsManage error: ${error?.message || String(error)}`,
          error: error?.message || String(error)
        };
      }
    }
  });

  return {
    dispose() {
      registration.dispose();
    }
  };
}
