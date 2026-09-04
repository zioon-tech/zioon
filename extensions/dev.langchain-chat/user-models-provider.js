/**
 * user.dynamic provider (Runtime Host first, localStorage fallback)
 *
 * Purpose:
 * - 不再在代码中写死 models.json；模型由用户通过 UI/对话（modelsManage 工具）配置。
 * - Runtime 可用时以 Runtime Model Profile 为权威；离线/浏览器模式才使用 localStorage fallback。
 */

import { withResolvedModelLimits } from "./model-limits.js";
import { normalizeModelDescription } from "./model-config-fields.js";
import {
  buildDiscoveryAvailability,
  createProviderModelDiscovery
} from "./provider-model-discovery.js";
import {
  loadDynamicModelStore
} from "./runtime-user-model-store.js";

const discoveryLoaders = new Map();

export function deriveOpenAIModelsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const nextPath = url.pathname.replace(
      /\/(?:chat\/completions|completions|responses|models)\/?$/,
      "/models"
    );
    if (nextPath === url.pathname && !/\/models\/?$/.test(url.pathname)) return "";
    url.pathname = nextPath;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function getDiscoveryLoader(modelsUrl) {
  let loader = discoveryLoaders.get(modelsUrl);
  if (loader) return loader;
  loader = createProviderModelDiscovery({
    buildRequest(apiKey) {
      return {
        url: modelsUrl,
        headers: {
          "Authorization": `Bearer ${apiKey}`
        }
      };
    },
    parseModels(payload) {
      const models = new Map();
      for (const item of payload?.data || payload?.models || []) {
        const modelId = String(item?.id || item?.name || "").replace(/^models\//, "");
        if (modelId) models.set(modelId, item);
      }
      return models;
    }
  });
  discoveryLoaders.set(modelsUrl, loader);
  return loader;
}

export const userModelsProvider = {
  id: "user.dynamic",
  async list() {
    const dict = await loadDynamicModelStore();
    return Object.keys(dict).map(id => {
      const cfg = dict[id] || {};
      const resolved = withResolvedModelLimits(cfg, {
        providerId: "user.dynamic",
        modelId: id
      });
      return {
        id,
        label: cfg.label || id,
        description: normalizeModelDescription(cfg.description),
        limits: resolved.limits
      };
    });
  },
  async checkAvailability({ modelIds = [], force = false } = {}) {
    const dict = await loadDynamicModelStore();
    const models = {};
    const groups = new Map();

    for (const modelId of modelIds) {
      const cfg = dict[modelId] || {};
      if (cfg._runtimeBacked && cfg._credentialConfigured) {
        models[modelId] = {
          status: "available",
          reason: "runtime_credential_configured",
          source: "runtime-profile",
          checkedAt: Date.now(),
          expiresAt: null
        };
        continue;
      }
      const apiKey = String(cfg.key || cfg.apiKey || "").trim();
      const providerType = String(cfg.providerType || "openai").toLowerCase();
      const modelsUrl = providerType === "openai" ? deriveOpenAIModelsUrl(cfg.url) : "";
      if (!apiKey || !cfg.url) {
        models[modelId] = {
          status: "misconfigured",
          reason: !apiKey ? "missing_key" : "missing_url",
          source: "config",
          checkedAt: Date.now(),
          expiresAt: null
        };
        continue;
      }
      if (!modelsUrl) {
        models[modelId] = {
          status: "unknown",
          reason: "probe_unsupported",
          source: "provider-list",
          checkedAt: Date.now()
        };
        continue;
      }
      const groupKey = `${modelsUrl}\n${apiKey}`;
      const group = groups.get(groupKey) || { modelsUrl, apiKey, items: [] };
      group.items.push({
        modelId,
        remoteId: String(cfg.modelName || cfg.model || modelId)
      });
      groups.set(groupKey, group);
    }

    await Promise.all(Array.from(groups.values()).map(async (group) => {
      const discovered = await getDiscoveryLoader(group.modelsUrl)({
        credential: group.apiKey,
        force
      });
      const result = discovered.httpStatus === 404 || discovered.httpStatus === 405
        ? {
            ...discovered,
            status: "unknown",
            reason: "probe_unsupported"
          }
        : discovered;
      for (const item of group.items) {
        models[item.modelId] = buildDiscoveryAvailability(
          result,
          [item.modelId],
          () => item.remoteId
        )[item.modelId];
      }
    }));

    return {
      status: "unknown",
      source: "provider-list",
      checkedAt: Date.now(),
      models
    };
  },
  async resolve(modelId) {
    const dict = await loadDynamicModelStore();
    const cfg = dict[modelId];
    if (!cfg) return null;
    // 确保 modelName 字段存在，如果没有则使用 modelId 或 cfg.model 作为默认值
    const resolved = withResolvedModelLimits({
      id: modelId,
      ...cfg,
      description: normalizeModelDescription(cfg.description),
      // 优先使用 cfg.modelName，其次是 cfg.model，最后使用 modelId
      modelName: cfg.modelName || cfg.model || modelId
    }, {
      providerId: "user.dynamic",
      modelId
    });
    return resolved;
  }
};
