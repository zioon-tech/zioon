const REGIONS = new Set(["cn-beijing", "cn-shanghai", "cn-hangzhou", "cn-shenzhen", "cn-hongkong", "ap-southeast-1"]);

export function sandboxConfig(env = process.env) {
  if (env.E2B_SANDBOX_URL || env.E2B_ACCESS_TOKEN || (env.E2B_DEBUG && env.E2B_DEBUG !== "false")) {
    throw new Error("Remove legacy token, debug mode and sandbox URL overrides for the managed PoC");
  }
  const provider = env.ZION_SANDBOX_PROVIDER || "aliyun";
  if (!["aliyun", "e2b"].includes(provider)) throw new Error("Unsupported sandbox provider");
  const region = env.ZION_SANDBOX_REGION || "cn-shanghai";
  if (provider === "aliyun" && !REGIONS.has(region)) throw new Error("Unsupported sandbox region");
  const domain = provider === "aliyun" ? `${region}.sandbox.aliyuncs.com` : "e2b.app";
  const apiUrl = `https://api.${domain}`;
  if (env.E2B_DOMAIN && env.E2B_DOMAIN !== domain) throw new Error("Sandbox domain does not match provider/region");
  if (env.E2B_API_URL && env.E2B_API_URL !== apiUrl) throw new Error("Sandbox API URL does not match provider/region");
  const template = String(env.ZION_SANDBOX_TEMPLATE || "").trim();
  const apiKey = String(env.E2B_API_KEY || "").trim();
  const timeoutMs = Number(env.ZION_SANDBOX_TIMEOUT_MS || 300_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 600_000) {
    throw new Error("PoC sandbox timeout must be between 30000 and 600000 milliseconds");
  }
  return Object.freeze({
    provider, region: provider === "aliyun" ? region : null, domain, apiUrl, template, apiKey,
    timeoutMs, requestTimeoutMs: 20_000,
    allowInternetAccess: env.ZION_SANDBOX_ALLOW_INTERNET_ACCESS === "1",
    // These are verified deployment capabilities, not inferred from SDK methods.
    supportsPause: env.ZION_SANDBOX_PAUSE_VERIFIED === "1"
  });
}

export function configSummary(config) {
  return {
    provider: config.provider, region: config.region, domain: config.domain,
    apiUrl: config.apiUrl, template: config.template || null,
    credentialConfigured: Boolean(config.apiKey), timeoutMs: config.timeoutMs,
    supportsPause: config.supportsPause,
    allowInternetAccess: config.allowInternetAccess,
    missing: [
      ...(!config.apiKey ? ["E2B_API_KEY"] : []),
      ...(!config.template ? ["ZION_SANDBOX_TEMPLATE"] : [])
    ]
  };
}

export function requireReadyConfig(config) {
  if (configSummary(config).missing.length) throw new Error("Sandbox API Key and template must be configured");
}

export function sandboxScope(value) {
  const fields = ["accountId", "workspaceId", "attemptId", "epoch"];
  const result = {};
  for (const field of fields) {
    const item = value?.[field];
    if (field === "epoch") {
      if (!Number.isSafeInteger(item) || item < 1) throw new Error("Invalid sandbox scope epoch");
    } else if (typeof item !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(item)) {
      throw new Error(`Invalid sandbox scope ${field}`);
    }
    result[field] = item;
  }
  return Object.freeze(result);
}

export function scopeMetadata(value) {
  const scope = sandboxScope(value);
  return Object.fromEntries(Object.entries(scope).map(([key, item]) => [`zion.${key}`, String(item)]));
}
