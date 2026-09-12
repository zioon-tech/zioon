import { normalizeModelDescription } from "./model-config-fields.js";
import { normalizeModelLimits, resolveModelLimits } from "./model-limits.js";
import {
  applyModelAvailability,
  classifyModelAvailabilityError,
  isModelAvailabilityFresh,
  setModelAvailabilities
} from "./model-health.js";
import {
  findRuntimeModelProfile,
  loadRuntimeModelProfiles,
  mergeRuntimeModelProfileConfig
} from "./runtime-user-model-store.js";

function currentCatalog() {
  try {
    const value = window.zion?.state?.get?.("models.catalog");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function providerIds() {
  try {
    return window.zion?.models?.listProviders?.() || [];
  } catch {
    return [];
  }
}

export async function rebuildModelCatalog({ forceRuntime = false } = {}) {
  const previous = currentCatalog();
  const models = [];
  const runtimeProfiles = await loadRuntimeModelProfiles({
    force: forceRuntime
  }).catch(() => null);

  for (const providerId of providerIds()) {
    const provider = window.zion?.models?.getProvider?.(providerId);
    if (!provider?.list) continue;
    let descriptors;
    try {
      descriptors = await provider.list();
    } catch (error) {
      console.warn(`[models] failed to list provider ${providerId}`, error);
      descriptors = previous
        .filter((item) => item?.providerId === providerId)
        .map((item) => ({
          id: item.id,
          label: item.label,
          description: item.description,
          limits: item.detectedLimits || item.limits
        }));
    }

    const resolvedModels = await Promise.all(
      (Array.isArray(descriptors) ? descriptors : []).map(async (descriptor) => {
        const modelId = String(descriptor?.id || "").trim();
        if (!modelId) return null;
        let config = null;
        let configError = null;
        try {
          config = await provider.resolve?.(modelId);
        } catch (error) {
          configError = error;
        }
        const runtimeProfile = findRuntimeModelProfile(runtimeProfiles, {
          providerId,
          modelId
        });
        const effectiveConfig = mergeRuntimeModelProfileConfig(
          config,
          runtimeProfile
        );
        const credentialConfigured = effectiveConfig?._credentialConfigured === true
          || runtimeProfile?.credentialConfigured === true;
        const hasCredential = credentialConfigured
          || !!String(effectiveConfig?.key || effectiveConfig?.apiKey || "").trim();
        const explicitlyRequiresConfig = !!(
          effectiveConfig?._requiresConfig
          && !hasCredential
        );
        const dynamicConfigIncomplete = providerId === "user.dynamic" && (
          !String(effectiveConfig?.url || "").trim()
          || !hasCredential
        );
        const requiresConfig = explicitlyRequiresConfig || dynamicConfigIncomplete;
        const detectedLimits = normalizeModelLimits(descriptor);
        const resolvedLimits = normalizeModelLimits(effectiveConfig || {});
        const item = {
          providerId,
          id: modelId,
          label: descriptor.label || modelId,
          description: normalizeModelDescription(effectiveConfig?.description || descriptor.description),
          requiresConfig,
          credentialConfigured,
          runtimeProfileId: runtimeProfile?.id || effectiveConfig?._runtimeProfileId || "",
          supportsImage: !!effectiveConfig?.supportsImage,
          supportsThinking: !!effectiveConfig?.supportsThinking,
          supportsThinkingEffort: !!effectiveConfig?.supportsThinkingEffort,
          thinkingMode: effectiveConfig?.thinkingMode,
          thinkingEffort: effectiveConfig?.thinkingEffort,
          preservedThinking: !!effectiveConfig?.preservedThinking,
          interleavedThinking: !!effectiveConfig?.interleavedThinking,
          configReason: requiresConfig && dynamicConfigIncomplete && !String(effectiveConfig?.url || "").trim()
            ? "missing_url"
            : requiresConfig
              ? "missing_key"
              : "",
          configHint: requiresConfig
            ? effectiveConfig?._configHint || (
                dynamicConfigIncomplete && !String(effectiveConfig?.url || "").trim()
                  ? "需要配置接口地址"
                  : "需要配置 API key"
              )
            : "",
          detectedLimits,
          limits: Object.keys(resolvedLimits).length
            ? resolvedLimits
            : resolveModelLimits({ providerId, modelId, descriptor })
        };
        if (configError) {
          const failure = classifyModelAvailabilityError(configError);
          if (failure) {
            item.availability = {
              ...failure,
              source: "config",
              checkedAt: Date.now()
            };
          }
        }
        return applyModelAvailability(item);
      })
    );
    models.push(...resolvedModels.filter(Boolean));
  }

  window.zion?.state?.set?.("models.catalog", models);
  return models;
}

function availabilityFor(result, modelId) {
  const modelResults = result?.models;
  if (modelResults instanceof Map) return modelResults.get(modelId) || null;
  if (modelResults && typeof modelResults === "object") return modelResults[modelId] || null;
  if (!result?.status) return null;
  return {
    status: result.status,
    reason: result.reason,
    source: result.source || "provider-list",
    checkedAt: result.checkedAt,
    expiresAt: result.expiresAt,
    latencyMs: result.latencyMs,
    httpStatus: result.httpStatus
  };
}

export async function checkModelAvailability({
  providerId,
  modelId,
  force = false,
  catalog
} = {}) {
  const sourceCatalog = Array.isArray(catalog) ? catalog : await rebuildModelCatalog();
  const selected = sourceCatalog.filter((item) => {
    if (providerId && item.providerId !== providerId) return false;
    if (modelId && item.id !== modelId) return false;
    return true;
  });
  const groups = new Map();
  for (const item of selected) {
    const list = groups.get(item.providerId) || [];
    list.push(item);
    groups.set(item.providerId, list);
  }

  for (const [pid, rows] of groups) {
    const pending = force
      ? rows
      : rows.filter((item) => !isModelAvailabilityFresh(item.availability));
    if (pending.length === 0) continue;

    const provider = window.zion?.models?.getProvider?.(pid);
    if (!provider) continue;
    const entries = [];
    for (const item of pending) {
      if (item.requiresConfig) {
        entries.push({
          providerId: pid,
          modelId: item.id,
          status: "misconfigured",
          reason: item.configReason || "missing_key",
          source: "config",
          expiresAt: null
        });
      }
    }
    const checkable = pending.filter((item) => !item.requiresConfig);
    if (checkable.length > 0 && typeof provider.checkAvailability === "function") {
      try {
        const result = await provider.checkAvailability({
          modelIds: checkable.map((item) => item.id),
          force
        });
        for (const item of checkable) {
          const availability = availabilityFor(result, item.id) || {
            status: "unknown",
            reason: "not_reported",
            source: "provider-list"
          };
          entries.push({
            providerId: pid,
            modelId: item.id,
            ...availability
          });
        }
      } catch (error) {
        const failure = classifyModelAvailabilityError(error) || {
          status: "degraded",
          reason: "provider_error",
          scope: "provider"
        };
        for (const item of checkable) {
          entries.push({
            providerId: pid,
            modelId: item.id,
            ...failure,
            source: "provider-list"
          });
        }
      }
    } else {
      for (const item of checkable) {
        entries.push({
          providerId: pid,
          modelId: item.id,
          status: "unknown",
          reason: "probe_unsupported",
          source: "provider-list"
        });
      }
    }
    setModelAvailabilities(entries);
  }

  return currentCatalog();
}

export async function refreshModelCatalog({
  checkHealth = false,
  force = false,
  providerId,
  modelId
} = {}) {
  const catalog = await rebuildModelCatalog({ forceRuntime: force });
  if (!checkHealth) return catalog;
  return checkModelAvailability({ providerId, modelId, force, catalog });
}

export function startModelHealthMonitor({ intervalMs = 15 * 60_000 } = {}) {
  let disposed = false;
  let running = false;
  let pendingOptions = null;
  const refresh = async (options = {}) => {
    if (disposed) return;
    if (running) {
      if (!pendingOptions) {
        pendingOptions = { ...options };
      } else {
        const sameProvider = pendingOptions.providerId === options.providerId;
        const sameModel = sameProvider && pendingOptions.modelId === options.modelId;
        pendingOptions = {
          force: !!(pendingOptions.force || options.force),
          providerId: sameProvider ? options.providerId : undefined,
          modelId: sameModel ? options.modelId : undefined
        };
      }
      return;
    }
    if (!options.force) {
      try {
        if (document?.hidden || navigator?.onLine === false) return;
      } catch {}
    }
    running = true;
    try {
      await refreshModelCatalog({ checkHealth: true, ...options });
    } catch (error) {
      console.warn("[models] health refresh failed", error);
    } finally {
      running = false;
      if (pendingOptions && !disposed) {
        const nextOptions = pendingOptions;
        pendingOptions = null;
        void refresh(nextOptions);
      }
    }
  };

  const startupTimer = window.setTimeout(() => {
    void refresh();
  }, 0);
  const interval = window.setInterval(() => {
    void refresh();
  }, Math.max(60_000, intervalMs));

  let configSubscription = null;
  try {
    configSubscription = window.zion?.events?.on?.("models/configChanged", (event = {}) => {
      void refresh({
        force: true,
        providerId: event.providerId,
        modelId: event.modelId
      });
    });
  } catch {}

  return {
    dispose() {
      disposed = true;
      window.clearTimeout(startupTimer);
      window.clearInterval(interval);
      try {
        configSubscription?.dispose?.();
      } catch {}
    },
    refresh
  };
}
