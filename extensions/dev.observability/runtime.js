export const runtimePluginApiVersion = 2;

export function activateRuntimePlugin(context) {
  context.log?.(
    "info",
    "activated with the run-diagnostics Skill; observability facts are exposed by Runtime"
  );
  return { dispose() {} };
}
