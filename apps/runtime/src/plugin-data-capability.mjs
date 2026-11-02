export function requirePluginDataCapability(broker, runContext = {}) {
  const nodeId = runContext.target?.nodeId;
  const targets = broker.registeredTargets(runContext.projectId || "", "zion.internal.deviceService")
    .filter(({ node }) => node.registration.nodeId === nodeId);
  if (!nodeId || !targets.length) {
    throw Object.assign(new Error("Plugin data requires its configured Node"), { statusCode: 503 });
  }
  if (!targets.every(({ node }) => node.registration.capabilities.some(
    (item) => item.name === "zion.internal.deviceService" && Number(item.version) >= 2
  ))) {
    throw Object.assign(new Error("Update the data Node Connector before using plugin data files"), { statusCode: 426 });
  }
}
