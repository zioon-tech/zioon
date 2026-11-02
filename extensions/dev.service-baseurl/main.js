import {
  SERVICE_DEFS,
  loadServiceBaseUrlConfig,
  normalizeBaseUrl,
  saveServiceBaseUrlConfig
} from "../../src/settings/serviceBaseUrl";

function errorText(code) {
  if (!code) return "";
  if (code === "empty") return "请输入服务地址";
  if (code === "invalid_protocol") return "仅支持 http / https";
  if (code === "missing_host") return "缺少 hostname";
  return "URL 格式不正确";
}

export function activate(ctx) {
  try {
    const disp = window.zion?.settings?.registerPage?.({
      id: "services.base-url",
      title: "Service Base URLs",
      description: "统一管理 Plugin Service、Local Tools、Local Search 和 Mail Service 的基础地址。",
      category: "services",
      order: 10,
      pluginId: "dev.service-baseurl",
      keywords: ["base url", "service", "plugin service", "local tools", "mail"],
      sections: [
        {
          id: "services.base-url.core",
          title: "Core Services",
          description: "这些地址会直接影响本地工具、检索和 Mail 相关能力。",
          settings: SERVICE_DEFS.map((def, index) => ({
            id: `services.baseUrl.${def.id}`,
            label: def.name,
            description: "保存后立即写回运行时与本地存储。",
            kind: "string",
            controlLayout: "wide",
            order: index + 1,
            scope: "application",
            defaultValue: def.defaultBaseUrl,
            placeholder: def.defaultBaseUrl,
            inputMode: "url",
            tags: ["service", "base url", def.id],
            getValue: () => loadServiceBaseUrlConfig().services[def.id]?.baseUrl || def.defaultBaseUrl,
            validate: (value) => {
              const normalized = normalizeBaseUrl(String(value || ""));
              return normalized.ok ? null : errorText(normalized.error);
            },
            setValue: (value) => {
              const ret = saveServiceBaseUrlConfig({ [def.id]: String(value || "") });
              if (!ret.ok) throw new Error(errorText(ret.error));
            },
            reset: () => {
              const ret = saveServiceBaseUrlConfig({ [def.id]: def.defaultBaseUrl });
              if (!ret.ok) throw new Error(errorText(ret.error));
            }
          }))
        }
      ]
    });
    if (disp) ctx.subscriptions.push(disp);
  } catch (e) {
    console.warn("[dev.service-baseurl] failed to register settings page", e);
  }
}
