#!/usr/bin/env node
import { readFile } from "node:fs/promises";

// No secrets are accepted by this helper. Resources must be provisioned by an operator.
const path = process.argv[2];
const label = process.argv[3] || "a";
if (!path || !["a", "b"].includes(label)) {
  throw new Error("Usage: agenticfs-poc-config.mjs <resources.json> [a|b]");
}
const resources = JSON.parse(await readFile(path, "utf8"));
const workspace = resources.workspaces?.find((item) => item.label === label);
if (!workspace || !resources.templateVerified || !resources.securityGroupId || !workspace.roleArn) {
  throw new Error("AgenticFS template, dedicated security group and scoped role must be verified first");
}
if (
  resources.region !== "cn-shanghai"
  || !workspace.roleName.startsWith("ZionSandboxPoc")
  || !workspace.accessPointArn.endsWith(`/${workspace.accessPointId}`)
  || !workspace.serverAddr.startsWith(`${workspace.accessPointId}.`)
) {
  throw new Error("Resource identity mismatch");
}
console.log(JSON.stringify({
  templateId: resources.templateId,
  region: resources.region,
  storageNetwork: { allowOut: ["10.88.1.0/24", "100.100.2.136/32", "100.100.2.138/32"] },
  storageMetadata: {
    "fc.sandbox.storage.agenticfs": JSON.stringify({
      userID: 0,
      groupID: 0,
      mountPoints: [{ serverAddr: workspace.serverAddr, mountDir: "/workspace" }]
    }),
    "fc.sandbox.network.vpc": JSON.stringify({
      vpcId: resources.vpcId,
      securityGroupId: resources.securityGroupId,
      vSwitchIds: [resources.vSwitchId]
    }),
    "fc.sandbox.auth.role": workspace.roleArn
  }
}, null, 2));
