import { describe, expect, it, vi } from "vitest";
import { AliyunAccountStorage } from "../src/sandbox/aliyun-account-storage.mjs";

const config = {
  region: "cn-shanghai", zone: "cn-shanghai-f", cloudAccountId: "123",
  fileSystemId: "fs-test", vpcId: "vpc-test", vSwitchId: "vsw-test",
  securityGroupId: "sg-test", instanceRoleName: "ZionRuntimeSandboxProvisioner",
  storageNetwork: { allowOut: ["10.88.1.0/24"] }
};
function harness({ points = [], intent = false, rejected = false, extraPolicy = false } = {}) {
  const adapter = new AliyunAccountStorage(config);
  const key = "a".repeat(32), resources = { agenticSpaceId: "agentic-test", ...(intent ? { accessPointIntent: 1 } : {}) };
  const point = {
    accessPointId: "ap-test", enabledRam: true, status: "active", domainName: "ap-test.nas.aliyuncs.com",
    fileSystemId: "fs-test", agenticSpaceId: "agentic-test", vpcId: "vpc-test", vSwitchId: "vsw-test",
    ARN: "acs:nas:cn-shanghai:123:accesspoint/ap-test"
  };
  let role, policy;
  adapter.nas = vi.fn(async (method) => {
    if (method === "getAgenticSpace") return { agenticSpace: {
      fileSystemId: "fs-test", fileSystemPath: `/zion_account_${key}/`, status: "Running"
    } };
    if (method === "listAccessPoints") return { accessPoints: points };
    if (method === "createAccessPoint") {
      if (rejected) throw Object.assign(new Error("rejected"), { code: "sandbox_storage_api_failed", rejected: true });
      return { accessPoint: { accessPointId: "ap-test" } };
    }
    if (method === "describeAccessPoint") return { accessPoint: point };
    throw new Error(`Unexpected method ${method}`);
  });
  adapter.ram = vi.fn(async (action, parameters) => {
    if (action === "GetRole") {
      if (!role) throw Object.assign(new Error("missing"), { providerCode: "EntityNotExist.Role" });
      return { Role: role };
    }
    if (action === "CreateRole") {
      role = { Arn: `acs:ram::123:role/${parameters.RoleName.toLowerCase()}`,
        AssumeRolePolicyDocument: parameters.AssumeRolePolicyDocument };
      return { Role: role };
    }
    if (action === "GetPolicy") {
      if (!policy) throw Object.assign(new Error("missing"), { providerCode: "EntityNotExist.Policy" });
      return { Policy: { DefaultVersion: "v1" } };
    }
    if (action === "CreatePolicy") {
      policy = parameters.PolicyDocument;
      return { Policy: { DefaultVersion: "v1" } };
    }
    if (action === "GetPolicyVersion") return { PolicyVersion: { PolicyDocument: policy } };
    if (action === "AttachPolicyToRole") return {};
    if (action === "ListPoliciesForRole") return { Policies: { Policy: [
      { PolicyType: "Custom", PolicyName: `ZionManaged${key}` },
      ...(extraPolicy ? [{ PolicyType: "System", PolicyName: "AliyunNASFullAccess" }] : [])
    ] } };
    throw new Error(`Unexpected action ${action}`);
  });
  const input = {
    accountId: "user:fresh", workspaceId: `workspace:account-${key}`, key, resources,
    save: async (patch) => Object.assign(resources, patch), assertOwned: async () => {}
  };
  return { adapter, input, point, policy: () => JSON.parse(policy) };
}

describe("account storage cloud authority", () => {
  it("creates an access point and grants only that account's mount", async () => {
    const h = harness();
    const binding = await h.adapter.provision(h.input);
    expect(binding.accountId).toBe("user:fresh");
    expect(JSON.parse(binding.storageMetadata["fc.sandbox.storage.agenticfs"]).mountPoints)
      .toEqual([{ serverAddr: "ap-test.nas.aliyuncs.com:/", mountDir: "/workspace" }]);
    expect(h.policy().Statement[0]).toMatchObject({
      Resource: "acs:nas:cn-shanghai:123:filesystem/fs-test",
      Condition: { StringEquals: { "nas:AccessPointArn": h.point.ARN } }
    });
  });

  it("reconciles an interrupted access-point create without creating a second point", async () => {
    const h = harness({ intent: true, points: [{ accessPointId: "ap-test" }] });
    await h.adapter.provision(h.input);
    expect(h.adapter.nas.mock.calls.some(([method]) => method === "createAccessPoint")).toBe(false);
  });

  it("keeps an uncertain create fenced when no access point is visible", async () => {
    const h = harness({ intent: true });
    await expect(h.adapter.provision(h.input)).rejects.toMatchObject({ code: "sandbox_provisioning_outcome_unknown" });
    expect(h.adapter.nas.mock.calls.some(([method]) => method === "createAccessPoint")).toBe(false);
    expect(h.adapter.ram).not.toHaveBeenCalled();
  });

  it("allows a retry after an explicit provider rejection", async () => {
    const h = harness({ rejected: true });
    await expect(h.adapter.provision(h.input)).rejects.toMatchObject({ code: "sandbox_storage_api_failed" });
    expect(h.input.resources.accessPointIntent).toBeNull();
  });

  it("refuses a role that also carries broader NAS authority", async () => {
    const h = harness({ extraPolicy: true });
    await expect(h.adapter.provision(h.input)).rejects.toMatchObject({ code: "sandbox_storage_binding_conflict" });
  });
});
