import {
  activateRuntimePlugin as activateOfficialAdcPlugin,
  runtimePluginApiVersion
} from "./runtime/vendor.mjs";

export { runtimePluginApiVersion };

// The official package defaults to a web OAuth client. A local Workbench needs
// the provider's native-client loopback redirect support.
export function activateRuntimePlugin(context) {
  const serviceOrigin = new URL(String(context.config.serviceUrl || "https://adc.zioon.tech")).origin;
  const fetcher = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.origin === serviceOrigin && url.pathname === "/api/auth/oauth2/register"
      && options.method === "POST" && typeof options.body === "string") {
      const body = JSON.parse(options.body);
      const redirects = body.redirect_uris;
      if (Array.isArray(redirects) && redirects.length > 0 && redirects.every((value) => {
        const redirect = new URL(value);
        return redirect.protocol === "http:"
          && ["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname)
          && !redirect.username && !redirect.password;
      })) {
        return fetch(input, {
          ...options,
          body: JSON.stringify({ ...body, application_type: "native" })
        });
      }
    }
    return fetch(input, options);
  };
  // Connection commands belong to the authenticated account. They do not need
  // an already-created model Run Session.
  let commands;
  const adapter = {
    ...context,
    runs: {
      ...context.runs,
      registerCommands: (handler) => {
        commands = handler;
        return context.runs.registerCommands(handler, { requiresSession: false });
      }
    },
    tools: {
      ...context.tools,
      registerTool: (tool) => context.tools.registerTool(tool.name === "adc_status" ? {
        ...tool,
        async invoke(args, request) {
          return { ok: true, content: JSON.stringify(await commands({ action: "status" }, request)) };
        }
      } : tool)
    }
  };
  return activateOfficialAdcPlugin(adapter, { fetcher });
}
